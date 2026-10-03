"""Owned browser -> production Flask/SQLite -> controlled metadata HTTP fixture.

Only categories and the Telegram refresh payload are mocked. The production
/api/enrich, /api/library, static build and Instagram thumbnail routes stay real.
Run only from metadata-e2e.mjs; stdin controls never target an existing service.
"""
import base64
import json
import os
from pathlib import Path
import socketserver
import sqlite3
import struct
import sys
import threading
import time
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[2]
FIREFOX = os.environ.get("FIREFOX_TEST") == "1"
EVIDENCE = ROOT / ".verify" / ("b2-firefox-places-20260925" if FIREFOX else "metadata-enrichment-20260924")
DB = Path(sys.argv[1]).resolve()
assert DB.parent.parent == EVIDENCE.resolve() and DB.parent.name.startswith("e2e-")
assert not DB.exists(), "Refuse an existing database"
assert Path.cwd().resolve() == ROOT
os.environ["SAVED_POSTS_DB_PATH"] = str(DB)
sys.path.insert(0, str(ROOT))

from metadata_fixture import BASE_URL, ControlledHTTP, GUARD_FAILURES, _ALLOWED_SOCKETS, install_guard

install_guard(DB.parent)
import app as dashboard
import metadata_fetcher
import storage
from flask import g, jsonify, request
from werkzeug import serving

# Set this before any metadata call; never inspect the owner's cache.
metadata_fetcher.THUMB_CACHE_DIR = str(DB.parent / "thumb_cache")
storage.init_db()
EVENTS = []
LOCK = threading.Lock()


def emit(data):
    with LOCK:
        print(json.dumps(data), flush=True)


def record(kind, **data):
    event = {"sequence": len(EVENTS), "kind": kind, **data}
    EVENTS.append(event)
    return event


def snapshot():
    with sqlite3.connect(DB) as conn:
        rows = conn.execute("SELECT url, document, deleted FROM library_items ORDER BY url").fetchall()
        return {"posts": [json.loads(row[1]) for row in rows if not row[2]],
                "deletedUrls": [row[0] for row in rows if row[2]],
                "legacyCount": conn.execute("SELECT COUNT(*) FROM saved_posts").fetchone()[0],
                "blocked": list(GUARD_FAILURES)}


original_fetch_metadata = metadata_fetcher.fetch_metadata


def observed_fetch_metadata(url):
    durable = next((post for post in snapshot()["posts"] if post["url"] == url), None)
    g.enrich_url = url
    record("enrich-start", url=url, durable=durable)
    return original_fetch_metadata(url)


metadata_fetcher.fetch_metadata = observed_fetch_metadata


def png_bytes():
    """A real 320x180 RGB PNG, >1000 bytes and browser-decodable (stdlib only)."""
    width, height = 320, 180
    raw = b"".join(b"\0" + bytes(component for x in range(width)
                     for component in ((x * 13 + y * 7) % 256, (x + y * 3) % 256, (x * 5 + y) % 256))
                   for y in range(height))

    def chunk(name, body):
        return struct.pack("!I", len(body)) + name + body + struct.pack("!I", zlib.crc32(name + body) & 0xffffffff)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG = png_bytes()
assert len(PNG) > 1000
PREVIEW = "http://cdn.fixture.test/preview.png"
IG_URL = "http://www.instagram.com/p/SyntheticIG123/"


def page_html(name):
    return (f'<!doctype html><html><head><title>Fallback {name}</title>'
            f'<meta property="og:title" content="Fetched {name} title">'
            f'<meta property="og:description" content="Synthetic {name} description &amp; detail.">'
            f'<meta property="og:image" content="{PREVIEW}"></head><body>Local fixture only</body></html>')


@dashboard.app.before_request
def isolate_routes():
    if request.path == "/api/telegram/config" and request.method == "GET":
        return jsonify(api_id_configured=False, api_hash_configured=False, config_readable=True)
    if request.path == "/api/telegram/auth":
        idle = dict(ok=True, credentials_configured=False, session_exists=False,
                    authorized=False, login_step=None, expires_in=None)
        return jsonify(idle if request.method == "GET" else {**idle, "result": "idle", "code": ""})
    if request.path == "/api/categories" and request.method == "GET":
        return jsonify([{"name": name, "count": 0, "description": "Synthetic shelf"}
                        for name in storage.get_categories()])
    if request.path == "/api/categorize" and request.method == "POST":
        data = request.get_json()
        content = data.get("content", "")
        rows = snapshot()["posts"]
        durable = [post["url"] for post in rows if post["url"] in content]
        record("categorize", content=content, durableUrls=durable, keywordsOnly=data.get("keywords_only"))
        assert durable, "Classification happened before durable import"
        if "/classify-failure" in content:
            return jsonify(ok=False, error="Synthetic classifier unavailable"), 503
        return jsonify(ok=True, category_name="technology")
    if request.path == "/api/telegram/refresh" and request.method == "POST":
        assert request.get_json() == {"confirm": True}
        record("mock-refresh")
        return jsonify(ok=True, checked=1, limit=200, malformed=0, export={"messages": [
            {"id": 81004, "type": "message", "date": "2026-09-24T12:00:00",
             "text": "Synthetic refresh caption " + BASE_URL + "/refresh"}]})
    if request.path == "/api/ai/providers" and request.method == "GET":
        return jsonify(ok=True, providers=[], ready=[], available=False)
    allowed = {"/api/library", "/api/enrich", "/api/stats", "/api/backup/export", "/api/backup/preview"}
    if FIREFOX:
        allowed.add("/api/import/firefox")
    if request.path.startswith("/api/") and request.path not in allowed:
        GUARD_FAILURES.append("unexpected API " + request.path)
        return jsonify(error="Disabled fixture API"), 503


@dashboard.app.after_request
def record_response(response):
    if request.path == "/api/enrich":
        record("enrich-end", url=getattr(g, "enrich_url", None), status=response.status_code,
               response=response.get_json(silent=True))
    elif request.path == "/api/library" and request.method == "POST":
        record("library-write", status=response.status_code, durable=snapshot())
    return response


class OwnedWSGIServer(serving.ThreadedWSGIServer):
    def server_bind(self):
        assert self.server_address == ("127.0.0.1", 0)
        _ALLOWED_SOCKETS.add(self.socket)
        try:
            socketserver.TCPServer.server_bind(self)
        finally:
            _ALLOWED_SOCKETS.discard(self.socket)
        # HTTPServer.server_bind would perform getfqdn/reverse DNS.
        self.server_name = "synthetic-flask"
        self.server_port = self.server_address[1]


def owned_address(host, port, family):
    assert host == "127.0.0.1" and port == 0
    return (host, port)


def main():
    with ControlledHTTP() as http:
        if FIREFOX:
            import gzip
            http.routes["/firefox?lesson=1&lesson=2"] = (200, {"Content-Type": "text/html", "Content-Encoding": "gzip"}, gzip.compress(page_html("Firefox gzip").encode()))
        for path, name in (("/html", "HTML"), ("/chromium", "Chromium"), ("/telegram", "Telegram"),
                           ("/refresh", "Refresh"), ("/classify-failure", "Classifier failure"),
                           ("/delete", "Disposable"), ("/p/SyntheticIG123/", "Instagram")):
            http.html(path, page_html(name))
        http.routes["/failure"] = (503, {"Content-Type": "text/plain"}, b"Synthetic unavailable")
        http.html("/empty", "<!doctype html><html><body>No metadata is supplied.</body></html>")
        http.routes["/preview.png"] = (200, {"Content-Type": "image/png"}, PNG)
        # Narrow address construction override only while creating our one listener.
        # Metadata DNS resolution still accepts only the fixture's public addresses.
        with patch.object(serving, "get_sockaddr", owned_address):
            server = OwnedWSGIServer("127.0.0.1", 0, dashboard.app)

        def controls():
            try:
                for line in sys.stdin:
                    message = json.loads(line)
                    command = message["command"]
                    response = {"command": command, "id": message["id"], "ok": True}
                    if command == "stop":
                        emit(response)
                        break
                    if command == "snapshot":
                        response["result"] = snapshot()
                    elif command == "events":
                        response.update(events=list(EVENTS), httpRequests=list(http.requests),
                                        connections=list(http.connections), dnsCalls=list(http.dns_calls))
                    elif command in ("fail-on", "fail-off"):
                        with sqlite3.connect(DB) as conn:
                            for operation in ("INSERT", "UPDATE"):
                                if command == "fail-on":
                                    conn.execute(f"CREATE TRIGGER e2e_fail_{operation} BEFORE {operation} ON library_items BEGIN SELECT RAISE(ABORT, 'Synthetic unavailable'); END")
                                else:
                                    conn.execute(f"DROP TRIGGER e2e_fail_{operation}")
                    elif command == "recover":
                        http.html("/failure", page_html("Recovered"))
                        # Do not bypass production duplicate suppression. Tell the
                        # browser when the actual cooldown permits a fresh retry.
                        with metadata_fetcher._flight_lock:
                            cached = metadata_fetcher._recent.get(BASE_URL + "/failure")
                            response["retryAfterMs"] = max(0, int((cached[0] - time.monotonic()) * 1000) + 50) if cached else 0
                    else:
                        raise AssertionError("Unknown control")
                    emit(response)
            except BaseException as exc:
                emit({"controlError": type(exc).__name__ + ": " + str(exc)})
            finally:
                server.shutdown()

        threading.Thread(target=controls, daemon=True).start()
        emit({"ready": True, "pid": os.getpid(), "port": server.server_port, "db": str(DB),
              "preview": PREVIEW, "png": base64.b64encode(PNG).decode("ascii"), "instagram": IG_URL})
        try:
            server.serve_forever(poll_interval=0.05)
        finally:
            server.server_close()
            emit({"stopped": True, "snapshot": snapshot(), "events": EVENTS,
                  "httpRequests": http.requests, "connections": http.connections,
                  "dnsCalls": http.dns_calls, "blocked": GUARD_FAILURES})
    assert not GUARD_FAILURES, GUARD_FAILURES


if __name__ == "__main__":
    main()
