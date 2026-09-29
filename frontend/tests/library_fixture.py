"""C4 isolated HTTP fixture; controls only its synthetic DB and owned server."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading

ROOT = Path(__file__).resolve().parents[2]
DB = Path(sys.argv[1]).resolve()
assert (ROOT / ".verify").resolve() in DB.parents
os.environ["SAVED_POSTS_DB_PATH"] = str(DB)
sys.path.insert(0, str(ROOT))
BLOCKED = []


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
        raise RuntimeError("C4 fixture guard: " + reason)


sys.addaudithook(guard)
import storage
import app as dashboard
from flask import request, jsonify
from werkzeug.serving import make_server

storage.init_db()


def no_provider(*args, **kwargs):
    BLOCKED.append("metadata provider")
    raise RuntimeError("C4 provider disabled")


dashboard.metadata_fetcher.fetch_metadata = no_provider


@dashboard.app.before_request
def isolate_routes():
    # The accepted import flow calls POST /api/enrich (best-effort metadata).
    # Serve the deterministic empty-metadata shape so enrichment is a
    # value-preserving no-op (metadataStatus stays 'partial') with no provider
    # or outbound HTTP. Every other unexpected /api/* path stays blocked.
    if request.path == "/api/enrich":
        return jsonify(ok=True, title="", summary="", thumbnail="", status="empty", error="")
    if request.path == "/api/telegram/config" and request.method == "GET":
        return jsonify(api_id_configured=False, api_hash_configured=False, config_readable=True)
    if request.path == "/api/telegram/auth":
        idle = dict(ok=True, credentials_configured=False, session_exists=False,
                    authorized=False, login_step=None, expires_in=None)
        return jsonify(idle if request.method == "GET" else {**idle, "result": "idle", "code": ""})
    if request.path.startswith("/api/") and request.path not in ("/api/library", "/api/stats", "/api/categories"):
        BLOCKED.append("unexpected API " + request.path)
        return jsonify(error="Disabled fixture API"), 503
    if request.path.startswith("/thumb/"):
        BLOCKED.append("thumbnail request")
        return "Disabled", 503


@dashboard.app.after_request
def isolate_assets(response):
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:"
    return response


server = make_server("127.0.0.1", int(sys.argv[2]), dashboard.app, threaded=True)


def controls():
    for line in sys.stdin:
        command = json.loads(line)["command"]
        if command == "stop":
            server.shutdown()
            return
        with sqlite3.connect(DB) as conn:
            if command == "fail-on":
                for event in ("INSERT", "UPDATE"):
                    conn.execute(f"CREATE TRIGGER fixture_fail_{event} BEFORE {event} ON library_items BEGIN SELECT RAISE(ABORT, 'C4 synthetic unavailable'); END")
            elif command == "fail-off":
                for event in ("INSERT", "UPDATE"):
                    conn.execute(f"DROP TRIGGER fixture_fail_{event}")
            elif command == "snapshot":
                rows = conn.execute("SELECT url, id, document, deleted FROM library_items ORDER BY url").fetchall()
                result = {"posts": [json.loads(row[2]) for row in rows if not row[3]], "deletedUrls": [row[0] for row in rows if row[3]], "legacyCount": conn.execute("SELECT COUNT(*) FROM saved_posts").fetchone()[0], "blocked": BLOCKED}
                print(json.dumps({"command": command, "result": result}), flush=True)
                continue
            else:
                raise RuntimeError("Unknown control")
        print(json.dumps({"command": command, "ok": True}), flush=True)
    server.shutdown()


threading.Thread(target=controls, daemon=True).start()
print(json.dumps({"ready": True, "pid": os.getpid(), "port": server.server_port, "db": str(DB)}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    print(json.dumps({"stopped": True, "blocked": BLOCKED}), flush=True)
