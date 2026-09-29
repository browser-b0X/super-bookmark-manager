"""C2 isolated HTTP fixture for bookmarks.mjs; controls only its synthetic DB and owned server.

Test-only infrastructure. Serves the built SPA, local persistence/health routes and
exact synthetic categorization responses for the accepted Settings import flow, and the
/__c2_harness.html same-origin page (with the X-C2-Fixture: bookmarks marker the suite
asserts) into which bookmarks.mjs injects its esbuild bundle. No production source is
modified; no personal profile, live bookmark store, or exported HTML is ever read.
"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading

ROOT = Path(__file__).resolve().parents[2]
DB = Path(sys.argv[1]).resolve()
assert (ROOT / ".verify").resolve() in DB.parents, "C2 fixture DB must live under .verify"
os.environ["SAVED_POSTS_DB_PATH"] = str(DB)
sys.path.insert(0, str(ROOT))
BLOCKED = []
REQUESTS = []
# Exact C2 title + URL inputs and the accepted C5 keyword outcomes. This is a
# five-record response table, not a copy of the production classifier.
CATEGORIES = {
    "Cooking & Kitchen — supplied title\nhttps://example.invalid/cooking?course=main&serves=2": "food-drink",
    "Programming: TypeScript notes\nhttps://example.invalid/programming#typescript": "technology",
    "Exercise routine\nhttp://example.invalid/exercise": "health-fitness",
    "Art & drawing ideas\nhttps://example.invalid/art": "arts-culture",
    "Budget planning café\nhttps://example.invalid/budgeting": "business-money",
}


def normalized(path):
    return os.path.normcase(os.path.abspath(os.fsdecode(path)))


def guard(event, args):
    reason = None
    if event == "sqlite3.connect" and normalized(args[0]) != normalized(DB):
        reason = "nonfixture SQLite"
    elif event == "open" and not isinstance(args[0], int):
        path = normalized(args[0]).replace("\\", "/").lower()
        name = path.rsplit("/", 1)[-1]
        if (name.startswith(".env") or ".session" in name or "/thumb_cache" in path
                or "/mozilla/firefox/" in path or "/user data/" in path
                or any(ext in name for ext in (".db", ".sqlite"))):
            if not path.startswith(normalized(DB.parent).replace("\\", "/").lower() + "/"):
                reason = "personal path"
    elif event in ("socket.connect", "socket.sendto", "subprocess.Popen", "os.kill"):
        reason = "outbound network/process"
    elif event == "socket.getaddrinfo" and args[0] != "127.0.0.1":
        reason = "external resolution"
    elif event == "import" and args[0].split(".")[0] in ("categorizer", "fetcher", "telethon"):
        reason = "provider/session import"
    if reason:
        BLOCKED.append(reason)
        raise RuntimeError("C2 fixture guard: " + reason)


sys.addaudithook(guard)
import storage
import app as dashboard
from flask import request, jsonify, Response
from werkzeug.serving import make_server

storage.init_db()


def no_provider(*args, **kwargs):
    BLOCKED.append("metadata provider")
    raise RuntimeError("C2 provider disabled")


dashboard.metadata_fetcher.fetch_metadata = no_provider


@dashboard.app.route("/__c2_harness.html")
def c2_harness():
    # Minimal same-origin document; bookmarks.mjs injects its bundle and uses localStorage.
    return Response(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>C2 harness</title></head><body></body></html>",
        mimetype="text/html",
        headers={"X-C2-Fixture": "bookmarks"},
    )


@dashboard.app.before_request
def isolate_routes():
    # The Settings surface mounts TelegramConfig/TelegramAccount; serve idle synthetic
    # shapes so no provider or outbound HTTP occurs. Block every other unexpected API.
    if request.path.startswith("/api/"):
        REQUESTS.append({"path": request.path, "method": request.method,
                         "body": request.get_json(silent=True)})
    if request.path == "/__c2_harness.html":
        return None
    if request.path == "/api/categorize" and request.method == "POST":
        data = request.get_json(silent=True)
        if (not isinstance(data, dict) or set(data) != {"content", "keywords_only"}
                or data.get("keywords_only") is not True
                or not isinstance(data.get("content"), str) or data["content"] not in CATEGORIES):
            BLOCKED.append("unexpected synthetic categorization input")
            return jsonify(ok=False, error="Unknown C2 categorization input"), 400
        return jsonify(ok=True, category_name=CATEGORIES[data["content"]])
    if request.path == "/api/enrich" and request.method == "POST":
        return jsonify(ok=True, title="", summary="", thumbnail="", status="empty", error="")
    if request.path == "/api/telegram/config" and request.method == "GET":
        return jsonify(api_id_configured=False, api_hash_configured=False, config_readable=True)
    if request.path == "/api/telegram/auth" and request.method == "GET":
        idle = dict(ok=True, credentials_configured=False, session_exists=False,
                    authorized=False, login_step=None, expires_in=None)
        return jsonify(idle)
    if request.path.startswith("/api/") and (request.method, request.path) not in (
            ("GET", "/api/library"), ("POST", "/api/library"), ("GET", "/api/stats")):
        BLOCKED.append("unexpected API " + request.method + " " + request.path)
        return jsonify(error="Disabled fixture API"), 503
    if request.path.startswith("/thumb/"):
        BLOCKED.append("thumbnail request")
        return "Disabled", 503


@dashboard.app.after_request
def isolate_assets(response):
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:"
    return response


server = make_server("127.0.0.1", int(sys.argv[2]), dashboard.app, threaded=True)


def controls():
    for line in sys.stdin:
        command = json.loads(line)["command"]
        if command == "stop":
            server.shutdown()
            return
        if command == "snapshot":
            with sqlite3.connect(DB) as conn:
                rows = conn.execute("SELECT url, document, deleted FROM library_items ORDER BY url").fetchall()
                result = {"posts": [json.loads(row[1]) for row in rows if not row[2]],
                          "deletedUrls": [row[0] for row in rows if row[2]],
                          "legacyCount": conn.execute("SELECT COUNT(*) FROM saved_posts").fetchone()[0],
                          "blocked": BLOCKED, "requests": REQUESTS}
            print(json.dumps({"command": command, "result": result}), flush=True)
            continue
        raise RuntimeError("Unknown control")
    server.shutdown()


threading.Thread(target=controls, daemon=True).start()
print(json.dumps({"ready": True, "pid": os.getpid(), "port": server.server_port, "db": str(DB)}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    print(json.dumps({"stopped": True, "blocked": BLOCKED}), flush=True)
