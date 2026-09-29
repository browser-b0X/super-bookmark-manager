"""
Flask web dashboard for browsing saved posts.
"""

import json
import os
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
        # Fixed safe message per code; contains no user-supplied values.
        return jsonify(ok=False, code=exc.code, error=str(exc)), exc.status
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
            return jsonify(storage.get_library())
        result = storage.save_library(request.get_json())
        return jsonify({"ok": True, **result})
    except BadRequest:
        return jsonify({"ok": False, "error": "Malformed JSON library request."}), 400
    except storage.LibraryValidationError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except storage.LibraryConflictError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 409
    except sqlite3.Error:
        return jsonify({"ok": False, "error": "SQLite library unavailable. Changes were not saved; retry when storage is available."}), 503


@app.route("/api/backup/<action>", methods=["POST"])
def api_backup(action):
    """Explicit export/preview/new-file restore; never replace the active library."""
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
                raise BackupError("Confirm the preview to create a restored database.")
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
        if request.get_json() != {"confirm": True}:
            return jsonify(ok=False, error="Explicit refresh confirmation is required."), 400
    except BadRequest:
        return jsonify(ok=False, error="Malformed refresh request."), 400
    from telegram_refresh import RefreshError, refresh_saved_messages
    try:
        return jsonify(refresh_saved_messages())
    except RefreshError as exc:
        return jsonify(ok=False, code=exc.code, error=str(exc)), exc.status


@app.route("/api/reclassify", methods=["POST"])
def api_reclassify():
    """Allow manual re-categorization from the UI (used by drag-and-drop)."""
    data = request.get_json()
    tg_msg_id = data.get("tg_msg_id")
    new_category = data.get("category", "uncategorized")
    if tg_msg_id:
        # Only update category, preserve existing summary/tags
        storage.set_post_category(tg_msg_id, new_category)
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "missing tg_msg_id"}), 400


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
    data = request.get_json()
    name = data.get("name", "").strip()
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
    data = request.get_json()
    new_name = data.get("name", "").strip()
    if not new_name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    renamed = storage.rename_category(name, new_name)
    if renamed:
        return jsonify({"ok": True, "new_name": new_name})
    return jsonify({"ok": False, "error": "rename failed"}), 409


@app.route("/api/edit", methods=["POST"])
def api_edit():
    """Edit a post's title, summary, category, and tags."""
    data = request.get_json()
    tg_msg_id = data.get("tg_msg_id")
    if not tg_msg_id:
        return jsonify({"ok": False, "error": "missing tg_msg_id"}), 400
    title = data.get("title", "")
    summary = data.get("summary", "")
    category = data.get("category", "other")
    tags = data.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    storage.update_post(tg_msg_id, title, summary, category, tags)
    return jsonify({"ok": True})


@app.route("/api/delete", methods=["POST"])
def api_delete():
    """Delete a post from the dashboard."""
    data = request.get_json()
    tg_msg_id = data.get("tg_msg_id")
    if not tg_msg_id:
        return jsonify({"ok": False, "error": "missing tg_msg_id"}), 400
    deleted = storage.delete_post(tg_msg_id)
    return jsonify({"ok": deleted})


# ── Tasks ──────────────────────────────────────────────────────────────────────

@app.route("/api/tasks", methods=["GET", "POST"])
def api_tasks():
    if request.method == "POST":
        data = request.get_json()
        title = (data.get("title") or "").strip()
        if not title:
            return jsonify({"ok": False, "error": "missing title"}), 400
        tid = storage.add_task(title, data.get("priority", "normal"),
                               data.get("due", ""), data.get("category", ""))
        return jsonify({"ok": True, "id": tid})
    return jsonify(storage.list_tasks())


@app.route("/api/tasks/<int:task_id>", methods=["PATCH", "DELETE"])
def api_task(task_id):
    if request.method == "DELETE":
        storage.delete_task(task_id)
        return jsonify({"ok": True})
    data = request.get_json()
    storage.update_task(task_id, **data)
    return jsonify({"ok": True})


# ── Notes ──────────────────────────────────────────────────────────────────────

@app.route("/api/notes", methods=["GET", "POST"])
def api_notes():
    if request.method == "POST":
        data = request.get_json()
        storage.save_note(data.get("content", ""), data.get("pinned"))
        return jsonify({"ok": True})
    return jsonify(storage.get_note())


# ── Captures ───────────────────────────────────────────────────────────────────

@app.route("/api/captures", methods=["GET", "POST"])
def api_captures():
    if request.method == "POST":
        data = request.get_json()
        content = (data.get("content") or "").strip()
        if not content:
            return jsonify({"ok": False, "error": "missing content"}), 400
        cid = storage.add_capture(data.get("type", "note"), content)
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
    key = request.args.get("key", "main") if request.method == "GET" else (request.get_json() or {}).get("key", "main")
    if request.method == "POST":
        data = request.get_json()
        storage.save_layout(data.get("key", "main"), json.dumps(data.get("layout", {})))
        return jsonify({"ok": True})
    raw = storage.get_layout(key)
    return jsonify({"layout": json.loads(raw) if raw else {}})


# ── Activity timeline ─────────────────────────────────────────────────────────

@app.route("/api/activity")
def api_activity():
    return jsonify(storage.get_activity())


# ── Metadata enrichment (MetadataProvider backend) ────────────────────────────

@app.route("/api/enrich", methods=["POST"])
def api_enrich():
    """Anonymous metadata only; no storage writes or raw network errors."""
    from safe_http import ERROR_CODES

    def failure(code, status):
        return jsonify(ok=False, title="", summary="", thumbnail="", status="failed", error=code), status

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
            return failure(code, http_status)
        return jsonify(ok=True, **fields, status=status, error=error)
    except Exception:
        return failure("internal_error", 502)


@app.route("/api/refresh-instagram-thumbs", methods=["POST"])
def api_refresh_ig_thumbs():
    """Re-cache expired Instagram CDN thumbnails stored in the DB."""
    repaired = metadata_fetcher.refresh_instagram_thumbnails()
    return jsonify({"ok": True, "repaired": repaired})


# ── Auto-categorization (LiteLLM proxy -> local LLM -> keywords) ─────────────

@app.route("/api/categorizer/status")
def api_categorizer_status():
    """Proxy health so the UI can enable/disable auto-categorize actions."""
    import categorizer
    return jsonify({
        "proxy_online": categorizer.proxy_available(),
        "proxy_url": config.LITELLM_PROXY_URL,
        "categories": storage.get_categories(),
    })


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
    tg_msg_id = data.get("tg_msg_id")
    if tg_msg_id:
        categorizer.apply_classification(int(tg_msg_id), result)
    return jsonify({"ok": True, **result})


@app.route("/api/categorize/unprocessed", methods=["POST"])
def api_categorize_unprocessed():
    """Batch-classify posts: fresh never-seen ones, or (untagged=true)
    everything still parked in 'uncategorized'/'other' — the Bulk sweep."""
    import categorizer
    data = request.get_json(silent=True) or {}
    try:
        batch = min(int(data.get("batch_size", 500)), 2000)
    except (TypeError, ValueError):
        batch = 500
    processed = categorizer.categorize_unprocessed(
        batch_size=batch, untagged_only=bool(data.get("untagged")))
    return jsonify({"ok": True, "processed": processed})


@app.route("/thumb/<code>")
def serve_thumb(code):
    """Locally cached thumbnails (Instagram CDN URLs expire, so we keep bytes)."""
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9_-]{2,64}", code):
        abort(404)
    return send_from_directory(metadata_fetcher.THUMB_CACHE_DIR, code, mimetype="image/jpeg")


# ── SPA serving (React app from frontend/dist) ────────────────────────────────

@app.route("/assets/<path:filename>")
def spa_assets(filename):
    return send_from_directory(os.path.join(SPA_DIR, "assets"), filename)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def spa(path):
    # Anything under /api/*, /posts or /command is handled by its own route;
    # if we land here with such a path it genuinely doesn't exist.
    if path.startswith(("api/", "posts", "command")):
        abort(404)
    if path:
        static_file = os.path.join(SPA_DIR, path)
        if os.path.isfile(static_file):
            return send_from_directory(SPA_DIR, path)
    index = os.path.join(SPA_DIR, "index.html")
    if not os.path.isfile(index):
        return command_center()  # SPA not built yet — graceful fallback
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
    base = config.LLM_BASE_URL.replace("/v1", "")
    try:
        req = urllib.request.Request(f"{base}/health", headers={"User-Agent": "dashboard"})
        with urllib.request.urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode())
            return {"online": data.get("status") == "ok", "endpoint": base}
    except Exception:
        return {"online": False, "endpoint": base}


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
