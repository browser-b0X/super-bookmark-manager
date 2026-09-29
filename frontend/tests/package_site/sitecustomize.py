"""Test-only guards loaded outside the package. Never shipped."""
import os
import sys
from pathlib import Path

if Path(sys.argv[0]).name == "package_start.py" and os.environ.get("PACKAGE_FIXTURE_ROOT"):
    import importlib.abc
    import importlib.util
    import json
    import sqlite3
    import threading
    import webbrowser
    import socket
    from types import ModuleType

    def internal_socketpair(event, args, frame):
        if event != 'socket.connect' or frame.f_code is not socket._fallback_socketpair.__code__:
            return False
        proactor = sys.modules.get('asyncio.proactor_events')
        if proactor is None or frame.f_back.f_code is not proactor.BaseProactorEventLoop._make_self_pipe.__code__:
            return False
        if not has_request_context() or request.method != 'POST' or request.path != '/api/telegram/refresh':
            return False
        lsock, csock = frame.f_locals.get('lsock'), frame.f_locals.get('csock')
        if not isinstance(lsock, socket.socket) or csock is not args[0]:
            return False
        address = lsock.getsockname()
        if (lsock.family != socket.AF_INET or csock.family != socket.AF_INET
                or lsock.type != socket.SOCK_STREAM or csock.type != socket.SOCK_STREAM
                or lsock.proto != 0 or csock.proto != 0
                or address[0] != '127.0.0.1' or address[1] <= 0
                or args[1] != address or lsock.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1
                or getattr(g, 'package_socketpair_permitted', False)):
            return False
        g.package_socketpair_permitted = True
        return True

    def network_evidence(event, args, decision):
        frame = sys._getframe(2)
        stack = []
        listener = None
        while frame:
            stack.append({'file': frame.f_code.co_filename, 'function': frame.f_code.co_name, 'line': frame.f_lineno})
            if frame.f_code is socket._fallback_socketpair.__code__:
                lsock = frame.f_locals.get('lsock')
                listener = {'address': lsock.getsockname(), 'fd': lsock.fileno(),
                            'listening': lsock.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN),
                            'sameConnectingSocket': frame.f_locals.get('csock') is args[0]}
            frame = frame.f_back
        source = None
        if event == 'socket.connect':
            try:
                source = args[0].getsockname()
            except OSError as exc:
                source = {'unbound': True, 'winerror': exc.winerror}
        detail = {'event': event, 'pid': os.getpid(), 'executable': sys.executable,
                  'destination': args[1] if event == 'socket.connect' else str(args),
                  'source': source,
                  'listener': listener, 'stack': stack,
                  'telethonLoaded': any(name.split('.')[0] == 'telethon' for name in sys.modules)}
        print('FIXTURE '+json.dumps({'network': detail, 'decision': decision}), flush=True)

    # Load third-party bytecode before installing the startup audit callback.
    # No application module or database is touched by these framework imports.
    if not os.environ.get("PACKAGE_MISSING_FLASK"):
        from flask import Flask, request, jsonify, has_request_context, g
        from werkzeug.serving import make_server

    WORK = Path(os.environ["PACKAGE_FIXTURE_ROOT"]).resolve()
    PACKAGE = Path(sys.argv[0]).resolve().parent
    assert WORK in PACKAGE.parents
    EXPECTED_DB = Path(os.environ.get("SAVED_POSTS_DB_PATH", str(PACKAGE / "saved_posts.db"))).resolve()
    assert WORK in EXPECTED_DB.parents
    BLOCKED = []

    def guard(event, args):
        reason = None
        if event == "sqlite3.connect":
            path = Path(args[0]).resolve()
            if path != EXPECTED_DB and not (EXPECTED_DB.parent / "restored-libraries") in path.parents:
                reason = "nonfixture SQLite"
        elif event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
            path = Path(os.fsdecode(args[0])).resolve()
            name, value = path.name.lower(), str(path).replace("\\", "/").lower()
            if name.startswith('.env') or '.session' in name or '/thumb_cache/' in value or '/user data/' in value or '/mozilla/firefox/' in value:
                reason = "private path"
            if ('.db' in name or '.sqlite' in name) and WORK not in path.parents:
                reason = "nonfixture database file"
        elif event in ("socket.connect", "socket.sendto", "subprocess.Popen", "os.kill"):
            allowed = internal_socketpair(event, args, sys._getframe(1))
            if event.startswith('socket.'):
                network_evidence(event, args, 'allow-internal-socketpair' if allowed else 'deny')
            if not allowed:
                reason = "external/process action"
        elif event == "socket.getaddrinfo" and args[0] != "127.0.0.1":
            reason = "external resolution"
        if reason:
            BLOCKED.append(reason)
            raise AssertionError(reason)

    sys.addaudithook(guard)

    class MissingTelegram(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname.split('.')[0] == 'telethon':
                raise ModuleNotFoundError("No module named 'telethon'", name='telethon')
    sys.meta_path.insert(0, MissingTelegram())
    webbrowser.open = lambda *args, **kwargs: True  # Never open the owner's browser.

    if os.environ.get("PACKAGE_MISSING_FLASK"):
        original_find = importlib.util.find_spec
        importlib.util.find_spec = lambda name, *args, **kwargs: None if name == "flask" else original_find(name, *args, **kwargs)
    else:
        def serve(app, **kwargs):
            import storage
            import config
            import metadata_fetcher
            assert Path(config.DB_PATH).resolve() == EXPECTED_DB
            for module in (storage, config, metadata_fetcher, sys.modules['app']):
                assert Path(module.__file__).resolve().parent == PACKAGE
            assert 'telegram_refresh' not in sys.modules and 'categorizer' not in sys.modules

            def provider(*args, **kwargs):
                BLOCKED.append('provider invoked')
                raise AssertionError('No providers in package tests')
            metadata_fetcher.fetch_metadata = provider

            @app.before_request
            def allowed():
                if request.path.startswith('/api/') and request.path not in ('/api/library','/api/categories','/api/stats','/api/categorize','/api/telegram/refresh','/api/backup/export','/api/backup/preview','/api/backup/restore'):
                    BLOCKED.append('unexpected API '+request.path)
                    return jsonify(error='Forbidden fixture API'),503
                if request.path.startswith('/thumb/'):
                    BLOCKED.append('thumbnail request')
                    return 'Forbidden',503
                if request.path == '/api/categorize':
                    assert request.get_json().get('keywords_only') is True

            server = make_server('127.0.0.1', int(os.environ.get('PACKAGE_TEST_PORT','0')), app, threaded=True)
            original_telegram = (config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, config.TELEGRAM_SESSION_FILE)
            missing_session = WORK / 'nonexistent-synthetic.session'
            assert not missing_session.exists()

            def forbidden_client(*args, **kwargs):
                BLOCKED.append('Telegram client constructed')
                raise AssertionError('No Telegram client in package tests')

            def controls():
                for line in sys.stdin:
                    command = json.loads(line)['command']
                    if command == 'stop':
                        server.shutdown()
                        return
                    if command == 'snapshot':
                        print('FIXTURE '+json.dumps({'command':command,'result':storage.get_backup_library(),'blocked':BLOCKED}),flush=True)
                    elif command == 'restored':
                        paths=list((EXPECTED_DB.parent/'restored-libraries').glob('*.sqlite'))
                        print('FIXTURE '+json.dumps({'command':command,'results':[storage.get_backup_library(p) for p in paths]}),flush=True)
                    elif command == 'integrity':
                        connection = sqlite3.connect(EXPECTED_DB)
                        try:
                            connection.execute('PRAGMA query_only = ON')
                            result = connection.execute('PRAGMA integrity_check').fetchall()
                        finally:
                            connection.close()
                        print('FIXTURE '+json.dumps({'command':command,'result':result}),flush=True)
                    elif command == 'session-boundary':
                        mock = ModuleType('telethon')
                        mock.TelegramClient = forbidden_client
                        sys.modules['telethon'] = mock
                        config.TELEGRAM_API_ID = 1
                        config.TELEGRAM_API_HASH = 'synthetic-not-a-credential'
                        config.TELEGRAM_SESSION_FILE = str(missing_session)
                        print('FIXTURE '+json.dumps({'command':command,'mock':True,'session':str(missing_session),'exists':missing_session.exists()}),flush=True)
                    elif command == 'dependency-boundary':
                        sys.modules.pop('telethon', None)
                        config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, config.TELEGRAM_SESSION_FILE = original_telegram
                        print('FIXTURE '+json.dumps({'command':command,'telethonLoaded':'telethon' in sys.modules}),flush=True)
                server.shutdown()
            threading.Thread(target=controls,daemon=True).start()
            print('FIXTURE '+json.dumps({'ready':True,'pid':os.getpid(),'port':server.server_port,'db':str(EXPECTED_DB),'package':str(PACKAGE)}),flush=True)
            try:
                server.serve_forever()
            finally:
                server.server_close()
                print('FIXTURE '+json.dumps({'stopped':True,'blocked':BLOCKED}),flush=True)
        Flask.run = serve
