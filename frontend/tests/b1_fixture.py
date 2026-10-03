"""B1 mocked Telegram + isolated SQLite. No real session/account/provider access."""
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
    # Expected new-link enrichment failure, without entering the real provider.
    if request.path == "/api/enrich":
        return jsonify(error="Synthetic metadata unavailable"), 503
    if request.path == "/api/telegram/config" and request.method == "GET":
        return jsonify(api_id_configured=False, api_hash_configured=False, config_readable=True)
    if request.path == "/api/telegram/auth":
        # Telegram Account panel polls status on mount; report an idle, not-connected
        # state so the B1 refresh contract is exercised without login side effects.
        idle = dict(ok=True, credentials_configured=False, session_exists=False,
                    authorized=False, login_step=None, expires_in=None)
        return jsonify(idle if request.method == "GET" else {**idle, "result": "idle", "code": ""})
    if request.path == "/api/ai/providers" and request.method == "GET":
        return jsonify(ok=True, providers=[], ready=[], available=False)
    if request.path.startswith("/api/") and request.path not in ("/api/library", "/api/stats", "/api/categories", "/api/categorize", "/api/telegram/refresh"):
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


if sys.argv[2] == 'unit':
    results = []
    client = dashboard.app.test_client()
    before = storage.get_library()
    def check(name, expected, **kwargs):
        response = client.post('/api/telegram/refresh', **kwargs)
        assert response.status_code == expected, (name, response.get_json())
        assert storage.get_library() == before
        results.append({'name': name, 'status': 'PASS', 'response': response.get_json()})
        return response.get_json()
    check('cross origin rejected', 403, json={'confirm': True}, headers={'Origin': 'https://untrusted.invalid'})
    check('non JSON rejected', 415, data='confirm=true')
    check('no explicit confirmation', 400, json={})
    calls_before_get = list(telegram_mock.CALLS)
    assert client.get('/api/telegram/refresh').status_code in (404, 405)
    assert telegram_mock.CALLS == calls_before_get  # Existing API catch-all may return404.
    for mode, code in [('missing','dependency'),('unauthorized','session'),('network','network'),('malformed','response'),('unexpected','response')]:
        telegram_mock.set_mode(mode)
        result = check(mode, 503, json={'confirm': True})
        assert result['code'] == code and 'PRIVATE' not in result['error']
    telegram_mock.set_mode('normal')
    session = config.TELEGRAM_SESSION_FILE
    config.TELEGRAM_SESSION_FILE = str(DB.parent / 'absent.session')
    count = len(telegram_mock.CALLS)
    check('missing session never constructed', 503, json={'confirm': True})
    assert len(telegram_mock.CALLS) == count and not Path(config.TELEGRAM_SESSION_FILE).exists()
    config.TELEGRAM_SESSION_FILE = session
    for configured, expected in [(0,200),(-1,200),(1000,200),(3,3),(200,200)]:
        config.MAX_MESSAGES_PER_RUN = configured
        data = check('window ' + str(configured), 200, json={'confirm': True})
        assert data['limit'] == expected and data['checked'] == expected
        assert not any('outside-window' in msg['text'] for msg in data['export']['messages'])
    assert data['malformed'] == 1
    assert all(c['target'] == 'me' and c['limit'] <= 200 for c in telegram_mock.CALLS if c['action'] == 'get_messages')
    assert sum(c['action']=='construct' for c in telegram_mock.CALLS) == sum(c['action']=='disconnect' for c in telegram_mock.CALLS)
    assert BLOCKED == []
    (DB.parent / 'unit.json').write_text(json.dumps({'results': results, 'calls': telegram_mock.CALLS, 'blocked': BLOCKED}, indent=2))
    print(json.dumps({'status': 'PASS', 'checks': len(results)}))
    sys.exit(0)

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
