"""Server for backup-e2e.mjs: the app on one synthetic SQLite file, no network, no personal paths.

usage: backup_fixture.py <db path under .verify> <port>   (port 0 picks one)
Commands arrive as JSON lines on stdin; answers go to stdout as JSON lines.
"""
import hashlib
import json
import os
import random
import struct
import zlib
from pathlib import Path
import sqlite3
import sys
import threading

ROOT = Path(__file__).resolve().parents[2]
DB = Path(sys.argv[1]).resolve()
assert (ROOT / ".verify").resolve() in DB.parents
DB.parent.mkdir(parents=True, exist_ok=True)
os.environ["SAVED_POSTS_DB_PATH"] = str(DB)
os.environ["SBM_AI_CONFIG_FILE"] = str(DB.parent / "ai.json")
os.environ["SBM_ARCHIVE_DIR"] = str(DB.parent / "archive")
# Each install keeps its own pictures, as two installs on two PCs do.
os.environ["SBM_THUMB_CACHE_DIR"] = str(DB.parent / "thumbs")
os.environ["SBM_SAVED_COPIES"] = "off"
sys.path.insert(0, str(ROOT))
BLOCKED = []


def normalized(path):
    return os.path.normcase(os.path.abspath(os.fsdecode(path)))


def guard(event, args):
    """Second fence: only this fixture's database and folder, only loopback, no processes."""
    reason = None
    if event == "sqlite3.connect" and normalized(args[0]) != normalized(DB):
        reason = "non-fixture SQLite"
    elif event == "open" and not isinstance(args[0], int):
        path = normalized(args[0]).replace("\\", "/").lower()
        name = path.rsplit("/", 1)[-1]
        if (name.startswith(".env") or ".session" in name or "/thumb_cache" in path or "/user data/" in path
                or any(ext in name for ext in (".db", ".sqlite"))):
            if not path.startswith(normalized(DB.parent).replace("\\", "/").lower() + "/"):
                reason = "personal path"
    elif event == "socket.connect" and args[1][0] != "127.0.0.1":
        reason = "external network"
    elif event in ("socket.sendto", "subprocess.Popen", "os.kill"):
        reason = "outbound network/process"
    elif event == "socket.getaddrinfo" and args[0] != "127.0.0.1":
        reason = "external resolution"
    elif event == "import" and args[0].split(".")[0] == "fetcher":
        reason = "Telegram session import"
    if reason:
        BLOCKED.append(reason)
        raise RuntimeError("backup fixture guard: " + reason)


sys.addaudithook(guard)
import storage  # noqa: E402
import app as dashboard  # noqa: E402
from flask import request, jsonify  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

storage.init_db()
PREVIEWS = {"on": False}


def picture_code(url):
    """The picture address a link gets from the stand-in site (the real app derives it from the image's URL)."""
    return "pic_" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def synthetic_png(seed):
    """A real 200x120 picture (noise), big enough to show as a preview."""
    width, height = 200, 120
    rng = random.Random(seed)
    raw = b"".join(b"\x00" + rng.randbytes(width * 3) for _ in range(height))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def stand_in_site(url, *args, **kwargs):
    """Previews without the network: every page gives its picture, stored in this install's cache."""
    code = picture_code(url)
    thumbnail = dashboard.metadata_fetcher.install_thumb(code, synthetic_png(code), "image/png")
    return {"title": "", "summary": "", "thumbnail": thumbnail, "status": "ok" if thumbnail else "empty", "error": ""}


dashboard.metadata_fetcher.fetch_metadata = stand_in_site


@dashboard.app.before_request
def isolate_routes():
    # Previews, Telegram and AI are off here: the Settings page asks about them, so answer "nothing".
    if request.path == "/api/enrich" and request.method == "POST" and not PREVIEWS["on"]:
        return jsonify(ok=False, error="Synthetic metadata unavailable"), 503
    if request.path == "/api/telegram/config":
        return jsonify(ok=True, api_id_configured=False, api_hash_configured=False, config_readable=True)
    if request.path == "/api/telegram/auth":
        idle = dict(ok=True, credentials_configured=False, session_exists=False, authorized=False, login_step=None, expires_in=None)
        return jsonify(idle if request.method == "GET" else {**idle, "result": "idle", "code": ""})
    if request.path.startswith("/api/telegram/") or (request.path.startswith("/api/ai/") and request.method != "GET"):
        BLOCKED.append("unexpected API " + request.path)
        return jsonify(error="Disabled fixture API"), 503


ORIGINAL_REPLACE = storage.replace_library


def failing_replace(data):
    """The real replacement, whose final check then finds a mismatch (the transaction rolls back)."""
    real = storage._backup_rows
    storage._backup_rows = lambda conn: {"posts": [], "tombstones": [], "categories": []}
    try:
        return ORIGINAL_REPLACE(data)
    finally:
        storage._backup_rows = real


server = make_server("127.0.0.1", int(sys.argv[2]), dashboard.app, threaded=True)


def controls():
    for line in sys.stdin:
        command = json.loads(line)["command"]
        if command == "stop":
            server.shutdown()
            return
        if command.startswith("install-pictures:"):
            installed = [dashboard.metadata_fetcher.install_thumb(code, synthetic_png(code), "image/png")
                         for code in command.split(":", 1)[1].split(",")]
            answer = {"installed": installed}
            print(json.dumps({"command": command, **answer}), flush=True)
            continue
        if command in ("previews-on", "previews-off"):
            PREVIEWS["on"] = command == "previews-on"
            answer = {"ok": True}
        elif command in ("restore-fail-on", "restore-fail-off"):
            storage.replace_library = failing_replace if command == "restore-fail-on" else ORIGINAL_REPLACE
            answer = {"ok": True}
        elif command == "backup-snapshot":
            backups = DB.parent / "backups"
            answer = {"result": storage.get_backup_library(), "epoch": storage.get_library()["epoch"],
                      "backups": sorted(p.name for p in backups.glob("*")) if backups.exists() else [],
                      "folders": sorted(p.name for p in DB.parent.iterdir() if p.is_dir())}
        elif command == "snapshot":
            with sqlite3.connect(DB) as conn:
                rows = conn.execute("SELECT url, document, deleted FROM library_items ORDER BY url").fetchall()
            answer = {"posts": [json.loads(row[1]) for row in rows if not row[2]], "deletedUrls": [row[0] for row in rows if row[2]],
                      "blocked": BLOCKED}
        else:
            raise RuntimeError("Unknown control " + command)
        print(json.dumps({"command": command, **answer}), flush=True)
    server.shutdown()


threading.Thread(target=controls, daemon=True).start()
print(json.dumps({"ready": True, "pid": os.getpid(), "port": server.server_port, "db": str(DB)}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    print(json.dumps({"stopped": True, "blocked": BLOCKED}), flush=True)
