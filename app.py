"""
Flask web dashboard for browsing saved posts.
"""

import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import sqlite3
import subprocess
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit
from flask import Flask, abort, render_template, request, jsonify, send_from_directory
from werkzeug.exceptions import BadRequest
from werkzeug.serving import WSGIRequestHandler

import config
import metadata_fetcher
import storage

# On Windows, mimetypes reads file types from the registry, and some PCs map .js
# (or .css) to text/plain there. Browsers refuse a module script served as
# text/plain, so the app would open as a blank page. Pin the types the app serves.
for _type, _extension in (("text/javascript", ".js"), ("text/javascript", ".mjs"), ("text/css", ".css"),
                          ("text/html", ".html"), ("application/json", ".json"), ("image/svg+xml", ".svg"),
                          ("image/x-icon", ".ico"), ("image/png", ".png"), ("image/webp", ".webp"),
                          ("font/woff2", ".woff2"), ("video/mp4", ".mp4")):
    mimetypes.add_type(_type, _extension)

app = Flask(__name__)

# Built React SPA (frontend/dist). When missing, we fall back to the legacy
# command center so the server always serves something useful.
SPA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "dist")


@app.route("/command")
def command_center():
    """The legacy personal command center (kept at /command)."""
    stats = storage.get_stats()
    return render_template("command.html", stats=stats, categories=storage.get_categories())


@app.route("/posts")
def index():
    query = request.args.get("q", "").strip()
    category = request.args.get("category", "").strip()
    source = request.args.get("source", "").strip()

    posts = storage.search_posts(query=query, category=category, source=source)
    categories = storage.get_categories()
    stats = storage.get_stats()

    # Parse tags JSON for each post
    for p in posts:
        try:
            p["tags_list"] = json.loads(p["tags"]) if p["tags"] else []
        except json.JSONDecodeError:
            p["tags_list"] = []

    return render_template(
        "index.html",
        posts=posts,
        categories=categories,
        stats=stats,
        query=query,
        active_category=category,
        active_source=source,
    )


@app.route("/api/stats")
def api_stats():
    return jsonify(storage.get_stats())


@app.route("/api/posts")
def api_posts():
    query = request.args.get("q", "").strip()
    category = request.args.get("category", "").strip()
    source = request.args.get("source", "").strip()
    try:
        limit = min(int(request.args.get("limit", 0)), 10000)
    except ValueError:
        limit = 0
    posts = storage.search_posts(query=query, category=category, source=source,
                                 limit=limit if limit > 0 else 200)
    for p in posts:
        try:
            p["tags_list"] = json.loads(p["tags"]) if p["tags"] else []
        except json.JSONDecodeError:
            p["tags_list"] = []
    return jsonify(posts)


def _library_same_origin(origin: str) -> bool:
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in origin) or "\\" in origin:
        return False
    try:
        supplied = urlsplit(origin)
        target = urlsplit(request.host_url)
        if supplied.scheme not in ("http", "https") or not supplied.hostname:
            return False
        if supplied.username is not None or supplied.password is not None or supplied.path or supplied.query or supplied.fragment:
            return False
        port = supplied.port if supplied.port is not None else (443 if supplied.scheme == "https" else 80)
        target_port = target.port if target.port is not None else (443 if target.scheme == "https" else 80)
        return (supplied.scheme, supplied.hostname, port) == (target.scheme, target.hostname, target_port)
    except ValueError:
        return False


# Hosts this local server answers to. Anything else is a DNS-rebinding attempt:
# a page on evil.example re-pointed at 127.0.0.1 sends `Host: evil.example`,
# and every Origin-vs-Host comparison would otherwise pass.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Routes that already apply their own Origin/content-type rules with
# route-specific responses; the generic guard below covers everything else.
_SELF_GUARDED = {"api_telegram_auth", "api_telegram_config", "api_library", "api_backup",
                 "api_import_firefox", "api_telegram_refresh", "api_enrich", "api_archive_import"}


def _allowed_hosts() -> set:
    extra = {h.strip().lower() for h in os.environ.get("SBM_ALLOWED_HOSTS", "").split(",") if h.strip()}
    return _LOOPBACK_HOSTS | extra


@app.before_request
def _local_boundary():
    try:
        hostname = (urlsplit("//" + request.host).hostname or "").lower()
    except ValueError:
        hostname = ""
    if hostname not in _allowed_hosts():
        return jsonify(ok=False, error="This server only answers on its local address."), 403
    if request.method in ("GET", "HEAD", "OPTIONS"):
        # The API is read by the app's own pages. Another website can still make the
        # browser send a GET (an <img>, a link), and some reads do work: shelf
        # suggestions call the owner's AI provider on their key.
        origin = request.headers.get("Origin")
        if request.path.startswith("/api/") and (
                request.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site")
                or (origin is not None and not _library_same_origin(origin))):
            return jsonify(ok=False, error="Cross-origin requests are not allowed."), 403
        return None
    if request.endpoint in _SELF_GUARDED:
        return None
    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return jsonify(ok=False, error="Cross-origin requests are not allowed."), 403
    if request.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
        return jsonify(ok=False, error="Cross-origin requests are not allowed."), 403
    # A cross-site <form> can only send text/plain or form encodings; requiring
    # JSON for any body closes that path for every mutating route.
    has_body = (request.content_length or 0) > 0 or request.headers.get("Transfer-Encoding")
    if request.path.startswith("/api/") and has_body and request.mimetype != "application/json":
        return jsonify(ok=False, error="Requests with a body require application/json."), 415
    return None


class _BadBody(Exception):
    pass


@app.errorhandler(_BadBody)
def _bad_body(exc):
    return jsonify(ok=False, error=str(exc) or "Expected a JSON object."), 400


@app.errorhandler(RecursionError)
@app.errorhandler(OverflowError)
def _odd_values(exc):
    """JSON nested thousands deep, or numbers too big for SQLite: a bad request, not a crash page."""
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="The request held values the app can't use."), 400
    return "Bad request", 400


def _json_object() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise _BadBody("Expected a JSON object.")
    return data


def _text(data: dict, key: str, default: str = "") -> str:
    value = data.get(key, default)
    if value is None:
        return default
    if not isinstance(value, str):
        raise _BadBody(f"{key} must be a string.")
    return value


def _msg_id(data: dict) -> int:
    value = data.get("tg_msg_id")
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise _BadBody("missing tg_msg_id")
    try:
        return int(value)
    except ValueError:
        raise _BadBody("tg_msg_id must be an integer.") from None


@app.after_request
def _not_for_other_sites(response):
    """No other website may frame the app (clickjacking) or embed its files (probing what is saved)."""
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    policy = response.headers.get("Content-Security-Policy")
    if not policy:
        response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    elif "frame-ancestors" not in policy:
        response.headers["Content-Security-Policy"] = policy + "; frame-ancestors 'self'"
    response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    return response


@app.after_request
def _telegram_config_no_store(response):
    # Includes automatic HEAD/OPTIONS and framework-generated method errors.
    if request.path in ("/api/telegram/config", "/api/telegram/auth"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/telegram/auth", methods=["GET", "POST"])
def api_telegram_auth():
    """Login/session status and steps; responses carry status only, never secrets."""
    import telegram_auth

    def invalid():
        return jsonify(ok=False, code="invalid", error="Invalid Telegram account request."), 400

    if request.query_string:
        return invalid()
    origin = request.headers.get("Origin")
    site = request.headers.get("Sec-Fetch-Site")
    if ((origin is not None and not _library_same_origin(origin))
            or (site is not None and site not in ("same-origin", "none"))):
        return jsonify(ok=False, code="cross_origin",
                       error="Cross-origin Telegram account requests are not allowed."), 403
    try:
        if request.method in ("GET", "HEAD"):
            return jsonify(ok=True, **telegram_auth.status())
        if request.mimetype != "application/json":
            return jsonify(ok=False, code="content_type",
                           error="Telegram account actions require application/json."), 415
        if request.content_length is not None and request.content_length > 4096:
            return jsonify(ok=False, code="too_large", error="Telegram account request is too large."), 413
        raw = request.stream.read(4097)
        if len(raw) > 4096:
            return jsonify(ok=False, code="too_large", error="Telegram account request is too large."), 413

        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result

        data = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(data, dict):
            return invalid()
        action = data.get("action")
        if action == "status" and set(data) == {"action"}:
            return jsonify(ok=True, **telegram_auth.status())
        if action == "check" and set(data) == {"action"}:
            return jsonify(ok=True, **telegram_auth.check_authorization())
        if action == "start" and set(data) in ({"action", "phone"}, {"action", "phone", "restart"}):
            return jsonify(ok=True, **telegram_auth.start_login(data["phone"], data.get("restart", False)))
        if action == "code" and set(data) == {"action", "code"}:
            return jsonify(ok=True, **telegram_auth.submit_code(data["code"]))
        if action == "password" and set(data) == {"action", "password"}:
            return jsonify(ok=True, **telegram_auth.submit_password(data["password"]))
        if action == "cancel" and set(data) == {"action"}:
            return jsonify(ok=True, **telegram_auth.cancel_login())
        if action == "disconnect" and set(data) == {"action", "mode"}:
            return jsonify(ok=True, **telegram_auth.disconnect(data["mode"]))
        return invalid()
    except telegram_auth.AuthError as exc:
        # Fixed safe message and bounded class/stage identifier; no secret values.
        return jsonify(ok=False, code=exc.code, error=str(exc),
                       **({"diagnostic": exc.diagnostic} if exc.diagnostic else {})), exc.status
    except (BadRequest, ValueError, RecursionError):
        return invalid()
    except Exception:
        # No exception text or logging: it may contain submitted secrets.
        return jsonify(ok=False, code="unavailable",
                       error="Telegram account service is unavailable. Nothing was confirmed."), 503


@app.route("/api/telegram/config", methods=["GET", "POST"])
def api_telegram_config():
    """Write-only developer keys; responses contain status booleans, never values."""
    import telegram_config

    def invalid():
        return jsonify(error="Invalid Telegram configuration request or incomplete developer keys."), 400

    if request.query_string:
        return invalid()
    origin = request.headers.get("Origin")
    site = request.headers.get("Sec-Fetch-Site")
    if ((origin is not None and not _library_same_origin(origin))
            or (site is not None and site not in ("same-origin", "none"))):
        return jsonify(error="Cross-origin configuration requests are not allowed."), 403
    try:
        if request.method in ("GET", "HEAD"):
            return jsonify(telegram_config.status())
        if request.mimetype != "application/json":
            return jsonify(error="Configuration changes require application/json."), 415
        if request.content_length is not None and request.content_length > 4096:
            return jsonify(error="Configuration request is too large."), 413
        raw = request.stream.read(4097)
        if len(raw) > 4096:
            return jsonify(error="Configuration request is too large."), 413

        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result

        data = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(data, dict):
            return invalid()
        if data.get("action") == "save" and set(data) == {"action", "api_id", "api_hash"}:
            return jsonify(telegram_config.save_credentials(data["api_id"], data["api_hash"]))
        if data.get("action") == "clear" and set(data) == {"action", "confirm"} and data["confirm"] is True:
            return jsonify(telegram_config.clear_credentials())
        return invalid()
    except (BadRequest, ValueError, RecursionError, telegram_config.ConfigValidationError):
        return invalid()
    except Exception:
        # No exception text or logging: it may contain submitted credential values.
        return jsonify(error="Telegram configuration is unavailable. Nothing was confirmed saved."), 503


def _drop_copies(payload, result=None):
    """A deleted link takes its saved copy with it. Never fails the save itself."""
    urls = [*payload.get("deletedUrls", []), *payload.get("purgeUrls", []), *((result or {}).get("removedUrls") or [])]
    if not urls:
        return
    try:
        import archive
        for url in urls:
            archive.remove_for_url(url)
    except (OSError, ValueError):
        pass  # the library change is already committed; a leftover file is harmless


@app.route("/api/library", methods=["GET", "POST"])
def api_library():
    """Local, provider-free durable library. Never acknowledge an uncommitted write."""
    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return jsonify({"ok": False, "error": "Cross-origin library requests are not allowed."}), 403
    if request.method == "POST" and request.mimetype != "application/json":
        return jsonify({"ok": False, "error": "Library writes require application/json."}), 415
    try:
        if request.method == "GET":
            since = request.args.get("since", "0")
            return jsonify(storage.get_library(int(since) if since.isdigit() else 0))

        def strict_number(token):
            raise BadRequest("Non-standard JSON number.")
        payload = json.loads(request.get_data(), parse_constant=strict_number)
        result = storage.save_library(payload)
        _drop_copies(payload, result)
        return jsonify({"ok": True, **result})
    except storage.LibraryValidationError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except (BadRequest, ValueError, RecursionError):
        return jsonify({"ok": False, "error": "Malformed JSON library request."}), 400
    except storage.LibraryReplacedError as exc:
        # A restore replaced the library: the browser drops its copy and reloads it.
        return jsonify({"ok": False, "error": str(exc), "code": "library_replaced"}), 409
    except storage.LibraryConflictError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 409
    except sqlite3.Error:
        return jsonify({"ok": False, "error": "SQLite library unavailable. Changes were not saved; retry when storage is available."}), 503


@app.route("/api/backup/<action>", methods=["POST"])
def api_backup(action):
    """Explicit export, preview, and restore into the library in use (saved first when it has links)."""
    from library_backup import BackupError, export_backup, preview_backup, restore_backup
    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return jsonify(ok=False, error="Cross-origin backup requests are not allowed."), 403
    if request.mimetype != "application/json":
        return jsonify(ok=False, error="Backup actions require application/json."), 415
    try:
        data = request.get_json()
        if not isinstance(data, dict):
            raise BackupError("Invalid backup request.")
        if action == "export":
            if data.get("confirm") is not True:
                raise BackupError("Choose Export backup explicitly.")
            backup = export_backup()
            filename = "saved-posts-" + backup["exportedAt"].replace(":", "-") + ".json"
            return jsonify(ok=True, content=json.dumps(backup, ensure_ascii=True, indent=2),
                           filename=filename, recordCount=backup["recordCount"])
        raw = data.get("content")
        if not isinstance(raw, str):
            raise BackupError("Select a backup JSON file first.")
        if action == "preview":
            return jsonify(ok=True, **preview_backup(raw))
        if action == "restore":
            if data.get("confirm") is not True:
                raise BackupError("Confirm the preview to restore.")
            return jsonify(ok=True, **restore_backup(raw, data.get("sha256")))
        return jsonify(ok=False, error="Unknown backup action."), 404
    except (BadRequest, BackupError, storage.LibraryValidationError) as exc:
        message = "Malformed JSON request." if isinstance(exc, BadRequest) else str(exc)
        return jsonify(ok=False, error=message), 400
    except (OSError, sqlite3.Error):
        return jsonify(ok=False, error="Backup storage unavailable. The current library was not replaced. Check disk space and folder access, then retry."), 503


@app.route("/api/import/firefox", methods=["POST"])
def api_import_firefox():
    """Parse the explicitly selected snapshot; existing Library API owns saves."""
    from firefox_import import MAX_BYTES, FirefoxImportError, parse_copy
    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return jsonify(ok=False, error="Cross-origin imports are not allowed."), 403
    if request.mimetype != "application/octet-stream":
        return jsonify(ok=False, error="Select a copied Firefox database file."), 415
    if request.content_length is not None and request.content_length > MAX_BYTES:
        return jsonify(ok=False, error="A Firefox copy of at most 64 MiB is required."), 413
    try:
        return jsonify(ok=True, **parse_copy(request.stream.read(MAX_BYTES + 1)))
    except FirefoxImportError as exc:
        return jsonify(ok=False, error=str(exc), malformed=1), 400


@app.route("/api/telegram/refresh", methods=["POST"])
def api_telegram_refresh():
    """Explicit read only; the existing frontend import/persistence owns writes."""
    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return jsonify(ok=False, error="Cross-origin refresh requests are not allowed."), 403
    if request.mimetype != "application/json":
        return jsonify(ok=False, error="Refresh requires an explicit JSON request."), 415
    try:
        body = request.get_json()
        if (not isinstance(body, dict) or body.get("confirm") is not True
                or not set(body) <= {"confirm", "media", "startup"}
                or any(not isinstance(body.get(name, False), bool) for name in ("media", "startup"))):
            return jsonify(ok=False, error="Explicit refresh confirmation is required."), 400
    except BadRequest:
        return jsonify(ok=False, error="Malformed refresh request."), 400
    from telegram_refresh import RefreshError, refresh_saved_messages, claim_startup_check, release_startup_check
    import archive
    if body.get("startup") and not claim_startup_check():
        # "Check when the app starts": once per app run, however many tabs open.
        return jsonify(ok=True, skipped="already_checked")
    try:
        # Photos and videos are kept beside saved copies, so not when copies are off for this run.
        return jsonify(refresh_saved_messages(keep_media=body.get("media", False) and archive.ENABLED))
    except RefreshError as exc:
        if body.get("startup") and exc.code in ("network", "busy"):
            release_startup_check()   # e.g. the app started before the network was up: a later load retries
        return jsonify(ok=False, code=exc.code, error=str(exc)), exc.status


@app.route("/api/reclassify", methods=["POST"])
def api_reclassify():
    """Allow manual re-categorization from the UI (used by drag-and-drop)."""
    data = _json_object()
    tg_msg_id = _msg_id(data)
    new_category = _text(data, "category", "uncategorized") or "uncategorized"
    # Only update category, preserve existing summary/tags
    storage.set_post_category(tg_msg_id, new_category)
    return jsonify({"ok": True})


@app.route("/api/categories", methods=["GET"])
def api_categories_list():
    """Return all categories with post counts and what each shelf is for."""
    import categorizer
    categories = storage.get_categories()
    stats = storage.get_stats()
    by_cat = stats.get("by_category", {})
    desc = categorizer.shelf_descriptions()
    result = []
    for cat in categories:
        result.append({
            "name": cat,
            "count": by_cat.get(cat, 0),
            "description": desc.get(categorizer._norm_category(cat), ""),
        })
    return jsonify(result)


@app.route("/api/categories/suggestions", methods=["GET"])
def api_categories_suggestions():
    """
    Shelves worth adding, inferred from links that could not be filed.

    Strictly opt-in and read-only: the caller decides whether any of these
    become real categories. Nothing here creates one.
    """
    import taxonomy
    try:
        limit = min(int(request.args.get("limit", 3)), 6)
    except (TypeError, ValueError):
        limit = 3
    try:
        suggestions = taxonomy.suggest_categories(max_suggestions=limit)
    except Exception as e:  # a suggestion failing must never break the page
        return jsonify({"ok": False, "error": type(e).__name__, "suggestions": []}), 200
    return jsonify({"ok": True, "suggestions": suggestions})


@app.route("/api/categories", methods=["POST"])
def api_categories_add():
    """Add a new category."""
    data = _json_object()
    name = _text(data, "name").strip()
    if not name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    try:
        created = storage.add_category(name)
    except storage.LibraryValidationError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 409
    if created:
        return jsonify({"ok": True, "name": name})
    return jsonify({"ok": False, "error": "category already exists"}), 409


@app.route("/api/categories/<name>", methods=["DELETE"])
def api_categories_delete(name):
    """Delete a category. Posts are moved to 'uncategorized'."""
    moved = storage.delete_category(name)
    return jsonify({"ok": True, "moved_posts": moved})


@app.route("/api/categories/<name>/rename", methods=["POST"])
def api_categories_rename(name):
    """Rename a category."""
    data = _json_object()
    new_name = _text(data, "name").strip()
    if not new_name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    renamed = storage.rename_category(name, new_name)
    if renamed:
        return jsonify({"ok": True, "new_name": new_name})
    return jsonify({"ok": False, "error": "rename failed"}), 409


@app.route("/api/edit", methods=["POST"])
def api_edit():
    """Edit a post's title, summary, category, and tags."""
    data = _json_object()
    tg_msg_id = _msg_id(data)
    title = _text(data, "title")
    summary = _text(data, "summary")
    category = _text(data, "category", "other") or "other"
    tags = data.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        raise _BadBody("tags must be a list of strings.")
    storage.update_post(tg_msg_id, title, summary, category, tags)
    return jsonify({"ok": True})


@app.route("/api/delete", methods=["POST"])
def api_delete():
    """Delete a post from the dashboard."""
    tg_msg_id = _msg_id(_json_object())
    deleted = storage.delete_post(tg_msg_id)
    return jsonify({"ok": deleted})


# ── Tasks ──────────────────────────────────────────────────────────────────────

@app.route("/api/tasks", methods=["GET", "POST"])
def api_tasks():
    if request.method == "POST":
        data = _json_object()
        title = _text(data, "title").strip()
        if not title:
            return jsonify({"ok": False, "error": "missing title"}), 400
        tid = storage.add_task(title, _text(data, "priority", "normal") or "normal",
                               _text(data, "due"), _text(data, "category"))
        return jsonify({"ok": True, "id": tid})
    return jsonify(storage.list_tasks())


@app.route("/api/tasks/<int:task_id>", methods=["PATCH", "DELETE"])
def api_task(task_id):
    if request.method == "DELETE":
        storage.delete_task(task_id)
        return jsonify({"ok": True})
    data = _json_object()
    fields = {}
    for key in ("title", "priority", "due", "category"):
        if key in data:
            fields[key] = _text(data, key)
    if "title" in fields and not fields["title"].strip():
        raise _BadBody("title must not be empty.")
    if "done" in data:
        if not isinstance(data["done"], bool):
            raise _BadBody("done must be a boolean.")
        fields["done"] = int(data["done"])
    storage.update_task(task_id, **fields)
    return jsonify({"ok": True})


# ── Notes ──────────────────────────────────────────────────────────────────────

@app.route("/api/notes", methods=["GET", "POST"])
def api_notes():
    if request.method == "POST":
        data = _json_object()
        pinned = data.get("pinned")
        if pinned is not None and not isinstance(pinned, (bool, int)):
            raise _BadBody("pinned must be a boolean.")
        storage.save_note(_text(data, "content"), None if pinned is None else int(pinned))
        return jsonify({"ok": True})
    return jsonify(storage.get_note())


# ── Captures ───────────────────────────────────────────────────────────────────

@app.route("/api/captures", methods=["GET", "POST"])
def api_captures():
    if request.method == "POST":
        data = _json_object()
        content = _text(data, "content").strip()
        if not content:
            return jsonify({"ok": False, "error": "missing content"}), 400
        cid = storage.add_capture(_text(data, "type", "note") or "note", content)
        # If it's a task capture, also create an actual task
        if data.get("type") == "task":
            storage.add_task(content)
        return jsonify({"ok": True, "id": cid})
    return jsonify(storage.list_captures())


@app.route("/api/captures/<int:capture_id>", methods=["DELETE"])
def api_capture_delete(capture_id):
    storage.delete_capture(capture_id)
    return jsonify({"ok": True})


# ── Layout persistence ─────────────────────────────────────────────────────────

@app.route("/api/layout", methods=["GET", "POST"])
def api_layout():
    if request.method == "POST":
        data = _json_object()
        storage.save_layout(_text(data, "key", "main") or "main", json.dumps(data.get("layout", {})))
        return jsonify({"ok": True})
    key = request.args.get("key", "main")
    raw = storage.get_layout(key)
    return jsonify({"layout": json.loads(raw) if raw else {}})


# ── Activity timeline ─────────────────────────────────────────────────────────

@app.route("/api/activity")
def api_activity():
    return jsonify(storage.get_activity())


# ── Metadata enrichment (MetadataProvider backend) ────────────────────────────

_ENRICH_TEXT_FIELDS = ("siteName", "author", "publishedAt", "lang", "canonicalUrl", "finalUrl", "faviconUrl", "linkStatus")


@app.route("/api/enrich", methods=["POST"])
def api_enrich():
    """Anonymous metadata only; no storage writes or raw network errors."""
    from safe_http import ERROR_CODES

    def failure(code, status, extra=None):
        response = jsonify(ok=False, title="", summary="", thumbnail="", status="failed", error=code, **(extra or {}))
        if code == "busy":
            # Tell the client when to come back instead of letting it guess.
            response.headers["Retry-After"] = "5"
        return response, status

    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return failure("cross_origin", 403)
    if request.mimetype != "application/json":
        return failure("json_required", 415)
    if request.content_length is not None and request.content_length > 16384:
        return failure("invalid_body", 413)
    try:
        raw = request.stream.read(16385)
        if len(raw) > 16384:
            return failure("invalid_body", 413)
        data = json.loads(raw)
    except (BadRequest, ValueError, UnicodeError):
        return failure("invalid_body", 400)
    if (not isinstance(data, dict) or not isinstance(data.get("url"), str)
            or not data["url"] or len(data["url"]) > 4096):
        return failure("invalid_url", 400)
    try:
        meta = metadata_fetcher.fetch_metadata(data["url"])
        fields = {key: meta.get(key, "") for key in ("title", "summary", "thumbnail")}
        if not all(isinstance(value, str) for value in fields.values()):
            return failure("internal_error", 502)
        error = meta.get("error", "")
        if error and error not in ERROR_CODES:
            error = "internal_error"
        status = meta.get("status", "ok" if any(fields.values()) else "empty")
        if status not in ("ok", "empty", "partial", "failed"):
            return failure("internal_error", 502)
        if status == "failed":
            code = error or "internal_error"
            http_status = {"invalid_url": 400, "blocked_url": 400, "busy": 429, "timeout": 504}.get(code, 502)
            detail = {k: meta[k] for k in ("httpStatus",) if isinstance(meta.get(k), int)}
            if meta.get("linkStatus") == "gone":
                detail["linkStatus"] = "gone"
            return failure(code, http_status, detail)
        extra = {}
        for key in _ENRICH_TEXT_FIELDS:
            value = meta.get(key)
            if isinstance(value, str) and value:
                extra[key] = value[:4096]
        for key in ("wordCount", "readingMinutes", "httpStatus"):
            value = meta.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                extra[key] = value
        return jsonify(ok=True, **fields, status=status, error=error, **extra)
    except Exception:
        return failure("internal_error", 502)


@app.route("/api/refresh-instagram-thumbs", methods=["POST"])
def api_refresh_ig_thumbs():
    """Re-cache expired Instagram CDN thumbnails stored in the DB."""
    repaired = metadata_fetcher.refresh_instagram_thumbnails()
    return jsonify({"ok": True, "repaired": repaired})


# ── Auto-categorization (AI provider chain -> keywords) ───────────────────────

@app.route("/api/categorizer/status")
def api_categorizer_status():
    """Whether AI categorizing is available, for older callers."""
    import ai_providers
    state = ai_providers.status()
    return jsonify({
        "proxy_online": state["available"],
        "providers": state["ready"],
        "categories": storage.get_categories(),
    })


# ── AI providers (keys live in the user profile, never in responses) ─────────

@app.route("/api/ai/providers")
def api_ai_providers():
    import ai_providers
    return jsonify(ok=True, **ai_providers.status())


@app.route("/api/ai/providers/<name>", methods=["POST"])
def api_ai_provider_update(name):
    import ai_providers
    data = _json_object()
    allowed = {"key", "clearKey", "model", "enabled", "baseUrl"}
    if not set(data) <= allowed:
        return jsonify(ok=False, error="Unknown setting."), 400
    try:
        state = ai_providers.update(name, data)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except Exception:
        return jsonify(ok=False, error="Couldn't save AI settings to your profile folder."), 500
    return jsonify(ok=True, **state)


@app.route("/api/ai/providers/<name>/test", methods=["POST"])
def api_ai_provider_test(name):
    import ai_providers
    try:
        result = ai_providers.test(name)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(**result, status=ai_providers.status())


@app.route("/api/ai/suggest", methods=["POST"])
def api_ai_suggest():
    """Shelf/tag/title suggestions for a batch of library links. Read-only."""
    import ai_library
    data = _json_object()
    try:
        items, shelves, jobs = ai_library.validate_request(data)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, **ai_library.suggest(items, shelves, jobs, ai_library.validate_spread(data)))


@app.route("/api/categorize", methods=["POST"])
def api_categorize():
    """
    Classify one piece of content against the live category list.
    Reuse-only: the answer is always an existing category or 'other'.
    If tg_msg_id is supplied the result is applied to that DB row.
    """
    import categorizer
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("content"), str):
        return jsonify({"ok": False, "error": "content must be a string"}), 400
    if "keywords_only" in data and not isinstance(data["keywords_only"], bool):
        return jsonify({"ok": False, "error": "keywords_only must be a boolean"}), 400
    content = data["content"].strip()
    if not content:
        return jsonify({"ok": False, "error": "missing content"}), 400
    result = categorizer.categorize_content(content[:4000], keywords_only=data.get("keywords_only", False))
    if data.get("tg_msg_id"):
        categorizer.apply_classification(_msg_id(data), result)
    return jsonify({"ok": True, **result})


@app.route("/api/categorize/unprocessed", methods=["POST"])
def api_categorize_unprocessed():
    """Batch-classify posts: fresh never-seen ones, or (untagged=true)
    everything still parked in 'uncategorized'/'other' — the Bulk sweep."""
    import categorizer
    data = _json_object() if request.content_length else {}
    try:
        batch = max(1, min(int(data.get("batch_size", 500)), 2000))   # SQLite reads a negative LIMIT as "no limit", and 0 returns nothing
    except (TypeError, ValueError, OverflowError):
        batch = 500
    processed = categorizer.categorize_unprocessed(
        batch_size=batch, untagged_only=bool(data.get("untagged")))
    return jsonify({"ok": True, "processed": processed})


@app.route("/thumb/<code>")
def serve_thumb(code):
    """Locally cached thumbnails (Instagram CDN URLs expire, so we keep bytes)."""
    import re as _re
    # Windows device names (CON, AUX, COM1...) open the device, not a file: never read them.
    if not _re.fullmatch(r"[A-Za-z0-9_-]{2,64}", code) or _re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])", code):
        abort(404)
    path = os.path.join(metadata_fetcher.THUMB_CACHE_DIR, code)
    try:
        with open(path, "rb") as handle:
            head = handle.read(16)
    except OSError:
        abort(404)
    # The bytes decide the type: cached previews may be PNG, WebP, GIF or ICO.
    kind = metadata_fetcher.sniff_image(head) or "application/octet-stream"
    response = send_from_directory(metadata_fetcher.THUMB_CACHE_DIR, code, mimetype=kind, max_age=86400)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return response


@app.route("/api/thumbs/missing", methods=["POST"])
def api_thumbs_missing():
    """Which pictures the links point at (/thumb/<code>) are not on this computer.

    A JSON backup keeps the addresses, not the picture files: after restoring one on a new
    install, "Fetch missing previews" counts these and fetching stores them again."""
    import re as _re
    origin = request.headers.get("Origin")
    if origin is not None and not _library_same_origin(origin):
        return jsonify(ok=False, error="Cross-origin requests are not allowed."), 403
    if request.mimetype != "application/json":
        return jsonify(ok=False, error="Send the picture codes as JSON."), 415
    data = request.get_json(silent=True)
    codes = data.get("codes") if isinstance(data, dict) else None
    if (not isinstance(codes, list) or len(codes) > 200000
            or not all(isinstance(code, str) and _re.fullmatch(r"[A-Za-z0-9_-]{2,64}", code) for code in codes)):
        return jsonify(ok=False, error="Expected a list of picture codes."), 400
    return jsonify(ok=True, missing=metadata_fetcher.missing_thumbs(codes))


# ── Saved copies (archive.py) ─────────────────────────────────────────────────

def _archive_response(document):
    """A copy is shown with no script, no network and an origin of its own."""
    import archive
    from flask import make_response
    response = make_response(document)
    response.headers["Content-Type"] = "text/html; charset=utf-8"
    # allow-popups only lets a link the reader clicks open the live site in a
    # normal tab; without allow-scripts nothing in the copy can run.
    # Video only from the copies' own folder: 'self' alone would let a planted
    # copy point a <video> at the app's API.
    policy = archive.FILE_CSP.replace("media-src 'self'", f"media-src {request.host_url}archive/")
    response.headers["Content-Security-Policy"] = (
        "sandbox allow-popups allow-popups-to-escape-sandbox; " + policy + "; frame-ancestors 'self'")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


# A saved copy has an origin of its own (the sandbox), so the browser treats its
# request for its own video as cross-origin and a same-origin-only resource
# policy blocks it. The copy is served with a per-run token in its video address
# and only a tokened request is opened to "cross-origin": another website can't
# guess the token, so it still can't probe which posts are saved.
_VIDEO_SECRET = secrets.token_bytes(32)


def _video_token(key: str) -> str:
    return hmac.new(_VIDEO_SECRET, key.encode("ascii"), hashlib.sha256).hexdigest()[:32]


@app.route("/archive/<key>")
def archive_view(key):
    """The saved copy of a link.

    ?view=plain drops the site's own styling; ?banner=0 hides the copy's own
    "Saved copy of..." strip when the app shows those details itself.
    """
    import archive
    document = archive.read_copy(key) if archive.valid_key(key) else None
    if document is None:
        abort(404)
    if request.args.get("view") == "plain":
        document = archive.plain_view(document)
    if request.args.get("banner") == "0":
        document = archive.without_banner(document)
    document = document.replace(f'src="{key}.mp4"'.encode("ascii"), f'src="{key}.mp4?t={_video_token(key)}"'.encode("ascii"))
    return _archive_response(document)


@app.route("/archive/<key>.mp4")
def archive_video(key):
    """The video of a saved X post, played by that copy's <video> tag.

    Byte ranges are honoured so the player can seek. Served as video/mp4 only,
    with the same sandbox as the copy, so a file renamed to .mp4 can't run.
    """
    import archive
    from flask import send_file
    if not archive.valid_key(key) or archive.read_record(key) is None:
        abort(404)
    path = archive.video_path(key)
    if os.path.islink(path) or not os.path.isfile(path):
        abort(404)
    response = send_file(path, mimetype="video/mp4", conditional=True, etag=False, max_age=0)
    response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    if hmac.compare_digest(request.args.get("t", ""), _video_token(key)):
        response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    return response


@app.route("/archive/telegram/<key>/<name>")
def archive_telegram_file(key, name):
    """One photo or video kept from a Telegram message: served as a file, never run."""
    import archive
    from flask import send_file
    kind = archive.telegram_type(name)
    path = archive.telegram_file_path(key, name) if kind and archive.valid_key(key) else None
    if not path:
        abort(404)
    response = send_file(path, mimetype=kind, conditional=True, etag=False, max_age=0)
    response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/archive/telegram", methods=["POST"])
def api_archive_telegram():
    """The photos and videos kept from a link's Telegram message (by the link's address)."""
    import archive
    data = _json_object()
    url = data.get("url")
    if not isinstance(url, str) or not url or len(url) > 4096 or set(data) != {"url"}:
        return jsonify(ok=False, error="invalid_url"), 400
    record = archive.telegram_media_for_url(url)
    if not record:
        return jsonify(ok=True, media=None)
    items = [{**item, "src": f"/archive/telegram/{record['key']}/{item['name']}"} for item in record["items"]]
    return jsonify(ok=True, media={"key": record["key"], "message": record["message"], "savedAt": record["savedAt"],
                                   "items": items, **archive.telegram_counts(record)})


@app.route("/api/archive", methods=["GET", "POST"])
def api_archive():
    """Ask for a copy of a link (POST) or how copies are doing (GET).

    Saving happens on archive.py's background queue; a POST only enqueues and
    answers at once, and the browser polls GET ?keys=... until it is done.
    """
    import archive
    if request.method == "GET":
        raw = request.args.get("keys")
        if raw is None:
            return jsonify(ok=True, enabled=archive.ENABLED, **archive.summary())
        keys = [key for key in raw.split(",") if key]
        if len(keys) > 200 or any(not archive.valid_key(key) for key in keys):
            return jsonify(ok=False, error="invalid_keys"), 400
        return jsonify(ok=True, copies={key: archive.state(key) for key in keys})
    data = _json_object()
    url = data.get("url")
    refresh = data.get("refresh", False)
    if not isinstance(url, str) or not url or len(url) > 4096 or not isinstance(refresh, bool) or not set(data) <= {"url", "refresh", "post"}:
        return jsonify(ok=False, status="failed", error="invalid_url"), 400
    post = data.get("post")
    if "post" in data:
        # Only what the bookmark button read on an Instagram post; checked again when the copy is made.
        import instagram_post
        try:
            instagram_post.parse(url, post)
        except instagram_post.PostDataError:
            return jsonify(ok=False, status="failed", error="invalid_post"), 400
    state = archive.request_copy(url, refresh=refresh, post=post)
    if state["status"] == "failed":
        code = state.get("error", "internal_error")
        response = jsonify(ok=False, **state)
        if code == "busy":
            response.headers["Retry-After"] = "5"
        return response, {"invalid_url": 400, "blocked_url": 400, "busy": 429, "disabled": 503}.get(code, 502)
    return jsonify(ok=True, **state), 200 if state["status"] == "saved" else 202


@app.route("/api/archive/export", methods=["POST"])
def api_archive_export():
    """The opt-in backup that includes saved copies: one zip, streamed.

    The ordinary JSON backup never contains copies. This adds them next to the
    same library.json, with an index page, so the zip is useful on its own.
    """
    import archive
    from flask import Response
    from library_backup import BackupError, export_backup
    if _json_object() != {"confirm": True}:
        return jsonify(ok=False, error="Choose the export explicitly."), 400
    try:
        backup = export_backup()
    except (BackupError, storage.LibraryValidationError) as exc:
        return jsonify(ok=False, error=str(exc)), 400
    except (OSError, sqlite3.Error):
        return jsonify(ok=False, error="Backup storage unavailable. Nothing was exported."), 503
    content = json.dumps(backup, ensure_ascii=True, indent=2).encode("ascii")
    filename = "saved-posts-with-copies-" + backup["exportedAt"][:19].replace(":", "-") + ".zip"
    response = Response(archive.export_zip(content, backup["exportedAt"]), mimetype="application/zip")
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/api/archive/import", methods=["POST"])
def api_archive_import():
    """Restore saved copies from a zip made by Export backup with saved copies.

    Adds copies for links in this library only and never replaces an existing
    copy. The body is the zip itself, written to a temporary file first.
    """
    import archive
    import tempfile
    origin = request.headers.get("Origin")
    if ((origin is not None and not _library_same_origin(origin))
            or request.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site")):
        return jsonify(ok=False, error="Cross-origin requests are not allowed."), 403
    if request.mimetype not in ("application/zip", "application/x-zip-compressed", "application/octet-stream"):
        return jsonify(ok=False, error="Choose the .zip file that Export backup with saved copies made."), 415
    if not archive.ENABLED:
        return jsonify(ok=False, error="Saved copies are switched off for this run of the app."), 503
    if request.content_length is not None and request.content_length > archive.IMPORT_LIMIT:
        return jsonify(ok=False, error="That zip is bigger than 1 GB."), 413
    temporary = None
    try:
        os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=archive.ARCHIVE_DIR, prefix="import.", suffix=".zip.tmp", delete=False) as target:
            temporary = target.name
            size = 0
            while True:
                chunk = request.stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > archive.IMPORT_LIMIT:
                    return jsonify(ok=False, error="That zip is bigger than 1 GB."), 413
                target.write(chunk)
        result = archive.import_zip(temporary, storage.library_urls())
        return jsonify(ok=True, **result)
    except archive.ArchiveError as exc:
        if exc.code == "not_zip":
            return jsonify(ok=False, error="That file is not a zip made by Export backup with saved copies."), 400
        if exc.code == "too_large":
            return jsonify(ok=False, error="That zip has too many files to be a backup from this app."), 400
        return jsonify(ok=False, error="The copies could not be written. Check disk space, then try again."), 503
    except (OSError, sqlite3.Error):
        return jsonify(ok=False, error="The copies could not be written. Check disk space, then try again."), 503
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


@app.route("/api/archive/<key>", methods=["DELETE"])
def api_archive_delete(key):
    import archive
    if not archive.valid_key(key):
        return jsonify(ok=False, error="invalid_keys"), 400
    return jsonify(ok=True, deleted=archive.remove(key))


@app.route("/api/share/picture", methods=["POST"])
def api_share_picture():
    """One link-preview picture for a shared-page export, fetched by the app.

    The browser can't read pictures from other sites, so Share asks here.
    POST {"url"} only (the generic guard refuses other origins and non-JSON),
    through safe_http (public addresses only, 4 MB), and only real pictures
    (JPEG, PNG, GIF, WebP) come back.
    """
    import archive
    import safe_http
    data = _json_object()
    url = data.get("url")
    if set(data) != {"url"} or not isinstance(url, str) or not url or len(url) > 4096:
        return jsonify(ok=False, error="invalid_url"), 400
    try:
        answer = safe_http.get(url, deadline=time.monotonic() + 8, limit=safe_http.IMAGE_LIMIT, headers=archive._IMAGE_HEADERS)
    except safe_http.SafeHTTPError as exc:
        return jsonify(ok=False, error=exc.code), 400 if exc.code in ("invalid_url", "blocked_url") else 502
    kind = archive._sniff(answer.body, "")
    if kind not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        return jsonify(ok=False, error="invalid_image"), 415
    response = app.response_class(answer.body, mimetype=kind)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    return response


@app.route("/api/helpers/video", methods=["GET", "POST"])
def api_video_helper():
    """The optional video helper for TikTok (video_helper.py).

    GET reports it; POST {"action": "install" | "check" | "update" | "remove"} changes it.
    Install, check and update run in the background; Settings polls GET. "check" only
    looks whether a newer release exists; "update" (the owner's click) installs it.
    """
    import archive
    import video_helper
    if request.method == "GET":
        return jsonify(ok=True, enabled=archive.ENABLED, **video_helper.status())
    if not archive.ENABLED:
        return jsonify(ok=False, error="disabled"), 503
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or set(body) != {"action"} or body["action"] not in ("install", "check", "update", "remove"):
        return jsonify(ok=False, error="invalid_request"), 400
    if body["action"] == "remove":
        if video_helper.status()["busy"]:
            return jsonify(ok=False, error="busy"), 409
        video_helper.remove()
        return jsonify(ok=True, **video_helper.status())
    return jsonify(ok=True, **video_helper.start(body["action"])), 202


# ── SPA serving (React app from frontend/dist) ────────────────────────────────

@app.route("/assets/<path:filename>")
def spa_assets(filename):
    return send_from_directory(os.path.join(SPA_DIR, "assets"), filename)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def spa(path):
    # Anything under /api/*, /archive/*, /posts or /command is handled by its own
    # route; if we land here with such a path it genuinely doesn't exist.
    if path.startswith(("api/", "archive/", "posts", "command")):
        abort(404)
    if path:
        static_file = os.path.join(SPA_DIR, path)
        if os.path.isfile(static_file):
            return send_from_directory(SPA_DIR, path)
    index = os.path.join(SPA_DIR, "index.html")
    if not os.path.isfile(index):
        return command_center()  # SPA not built yet — graceful fallback
    public = app.config.get("PUBLIC_RUNTIME_META")
    if public:
        from flask import make_response
        with open(index, encoding="utf-8") as source:
            html = source.read()
        identity, token = public  # generated hexadecimal values, never user input
        html = html.replace("<head>", f'<head><meta name="sbm-profile" content="{identity}"><meta name="sbm-instance" content="{token}">', 1)
        response = make_response(html)
        response.headers["Cache-Control"] = "no-store"
        return response
    return send_from_directory(SPA_DIR, "index.html")


# ── System status (real metrics) ──────────────────────────────────────────────

def _cpu_percent():
    try:
        def sample():
            with open("/proc/stat") as f:
                parts = f.readline().split()[1:]
            vals = list(map(int, parts))
            return vals[3] + vals[4], sum(vals)  # idle, total
        i1, t1 = sample()
        time.sleep(0.25)
        i2, t2 = sample()
        dt = (t2 - t1) or 1
        return round(100 * (1 - (i2 - i1) / dt), 1)
    except Exception:
        return None


def _mem():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.strip().split()[0])
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", 0)
        return {
            "total_gb": round(total / 1048576, 1),
            "used_gb": round((total - avail) / 1048576, 1),
            "pct": round(100 * (total - avail) / total, 1) if total else 0,
        }
    except Exception:
        return None


def _gpu():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),   # no console window flashing on Windows
        )
        if out.returncode != 0:
            return None
        util, mused, mtotal, temp = [x.strip() for x in out.stdout.strip().split(",")]
        return {
            "util": int(util), "mem_used": int(mused), "mem_total": int(mtotal),
            "temp": int(temp),
        }
    except Exception:
        return None


def _llm_state():
    import ai_providers
    state = ai_providers.status()
    return {"online": state["available"], "providers": state["ready"]}


@app.route("/api/system")
def api_system():
    try:
        disk = shutil.disk_usage("/")
        disk_info = {
            "total_gb": round(disk.total / 1024**3, 1),
            "used_gb": round(disk.used / 1024**3, 1),
            "pct": round(100 * disk.used / disk.total, 1),
        }
    except Exception:
        disk_info = None
    return jsonify({
        "cpu": _cpu_percent(),
        "mem": _mem(),
        "disk": disk_info,
        "gpu": _gpu(),
        "llm": _llm_state(),
    })


class _QuerySafeRequestHandler(WSGIRequestHandler):
    def log_request(self, code="-", size="-"):
        if hasattr(self, "path"):
            path = self.path.partition("?")[0]
            message = f"{self.command} {path} {self.request_version}"
        else:
            message = "Invalid HTTP request"
        self.log("info", '"%s" %s %s', message.translate(self._control_char_table), code, size)

    def log_error(self, format, *args):
        # Parser errors can include the entire unparsed credential-bearing request.
        self.log("error", "HTTP request rejected or interrupted.")


def run_dashboard():
    print(f"[dashboard] Starting at http://{config.DASHBOARD_HOST}:{config.DASHBOARD_PORT}")
    app.run(host=config.DASHBOARD_HOST, port=config.DASHBOARD_PORT, debug=False,
            request_handler=_QuerySafeRequestHandler)
