"""B1 mocked Telegram + isolated SQLite. No real session/account/provider access."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import hashlib

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
    if event == "sqlite3.connect" and normalized(args[0]) != normalized(DB) and not normalized(args[0]).startswith(normalized(DB.parent / "restored-libraries") + os.sep):
        reason = "nonfixture SQLite"
    elif event == "open" and not isinstance(args[0], int):
        path = normalized(args[0]).replace("\\", "/").lower()
        name = path.rsplit("/", 1)[-1]
        if (name.startswith(".env") or ".session" in name or "/thumb_cache" in path
                or "/mozilla/firefox/" in path or "/user data/" in path
                or any(ext in name for ext in (".db", ".sqlite"))):
            if not path.startswith(normalized(DB.parent).replace("\\", "/").lower() + "/"):
                reason = "personal path"
    elif event == 'socket.connect':
        # Windows asyncio creates an internal loopback socketpair. FakeClient
        # never creates a Telegram socket; every external address is blocked.
        if args[1][0] != '127.0.0.1': reason = 'external network'
    elif event in ("socket.sendto", "subprocess.Popen", "os.kill"):
        reason = "outbound network/process"
    elif event == "socket.getaddrinfo" and args[0] != "127.0.0.1":
        reason = "external resolution"
    elif event == "import" and args[0].split(".")[0] == "fetcher":
        reason = "provider/session import"
    if reason:
        BLOCKED.append(reason)
        raise RuntimeError("C4 fixture guard: " + reason)


sys.addaudithook(guard)
import storage
import app as dashboard
import config
import telegram_mock
import telegram_refresh
from flask import request, jsonify
from werkzeug.serving import make_server

storage.init_db()
config.TELEGRAM_API_ID = 1
config.TELEGRAM_API_HASH = 'synthetic'
config.TELEGRAM_SESSION_FILE = str(DB.parent / 'synthetic.session')
Path(config.TELEGRAM_SESSION_FILE).write_text('synthetic placeholder, never opened by FakeClient')
import categorizer
# Provider/model entry points are deterministic stubs. The import path must
# request keywords_only, so even health probes are forbidden during this test.
def model_forbidden(*args, **kwargs):
    BLOCKED.append("model invoked")
    raise AssertionError("C5 model unavailable")
categorizer.proxy_available = model_forbidden
categorizer._get_client = model_forbidden
categorizer.auto_categorize_post = model_forbidden



def no_provider(*args, **kwargs):
    BLOCKED.append("metadata provider")
    raise RuntimeError("C4 provider disabled")


dashboard.metadata_fetcher.fetch_metadata = no_provider


@dashboard.app.before_request
def isolate_routes():
    if request.path == '/api/enrich' and request.method == 'POST':
        return jsonify(ok=False, error='Synthetic metadata unavailable'), 503
    if request.path == "/api/telegram/config":
        return jsonify(ok=True, api_id_configured=False, api_hash_configured=False, config_readable=True)
    if request.path == "/api/telegram/auth":
        # Telegram panels poll status on mount; report idle/not-connected so the
        # backup round-trip is exercised without login or credential side effects.
        idle = dict(ok=True, credentials_configured=False, session_exists=False,
                    authorized=False, login_step=None, expires_in=None)
        return jsonify(idle if request.method == "GET" else {**idle, "result": "idle", "code": ""})
    if request.path.startswith("/api/") and request.path not in ("/api/library", "/api/stats", "/api/categories", "/api/categorize", "/api/telegram/refresh", "/api/backup/export", "/api/backup/preview", "/api/backup/restore"):
        BLOCKED.append("unexpected API " + request.path)
        return jsonify(error="Disabled fixture API"), 503
    if request.path.startswith("/thumb/"):
        BLOCKED.append("thumbnail request")
        return "Disabled", 503
    if request.path == '/api/categorize' and telegram_mock.MODE == 'extra':
        return jsonify(error='Synthetic classifier unavailable'), 503


@dashboard.app.after_request
def isolate_assets(response):
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:"
    return response


import library_backup
ORIGINAL_WRITE = storage.write_backup_library
ORIGINAL_LINK = library_backup.os.link

def failed_write(path, data):
    partial = dict(data, posts=data["posts"][:1])
    ORIGINAL_WRITE(path, partial)
    raise OSError("Synthetic interrupted restore")

def failed_link(*args):
    raise OSError("Synthetic publication failure")

server = make_server("127.0.0.1", int(sys.argv[2]), dashboard.app, threaded=True)


def controls():
    for line in sys.stdin:
        command = json.loads(line)["command"]
        if command == "stop":
            server.shutdown()
            return
        if command.startswith('mode:'):
            telegram_mock.set_mode(command.split(':', 1)[1])
            print(json.dumps({'command': command, 'ok': True}), flush=True)
            continue
        if command == 'calls':
            print(json.dumps({'command': command, 'calls': telegram_mock.CALLS}), flush=True)
            continue
        if command in ("restore-fail-on", "restore-fail-off", "publish-fail-on", "publish-fail-off"):
            storage.write_backup_library = failed_write if command == "restore-fail-on" else ORIGINAL_WRITE
            library_backup.os.link = failed_link if command == "publish-fail-on" else ORIGINAL_LINK
            print(json.dumps({"command": command, "ok": True}), flush=True)
            continue
        if command == "backup-snapshot":
            result = storage.get_backup_library()
            files = [p.name for p in (DB.parent / "restored-libraries").glob("*")]
            print(json.dumps({"command": command, "result": result, "files": files, "sourceHash": hashlib.sha256(DB.read_bytes()).hexdigest()}), flush=True)
            continue
        with sqlite3.connect(DB) as conn:
            if command == "fail-on":
                for event in ("INSERT", "UPDATE"):
                    conn.execute(f"CREATE TRIGGER fixture_fail_{event} BEFORE {event} ON library_items BEGIN SELECT RAISE(ABORT, 'C4 synthetic unavailable'); END")
            elif command == "fail-off":
                for event in ("INSERT", "UPDATE"):
                    conn.execute(f"DROP TRIGGER fixture_fail_{event}")
            elif command == "snapshot":
                rows = conn.execute("SELECT url, id, document, deleted FROM library_items ORDER BY url").fetchall()
                result = {"posts": [json.loads(row[2]) for row in rows if not row[3]], "deletedUrls": [row[0] for row in rows if row[3]], "legacyCount": conn.execute("SELECT COUNT(*) FROM saved_posts").fetchone()[0], "blocked": BLOCKED, "shelves": [row[0] for row in conn.execute("SELECT name FROM categories")]}
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
