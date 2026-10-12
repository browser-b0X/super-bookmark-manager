"""B6 guarded launcher checks. Never uses the owner's database or browser."""
import hashlib
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('LAUNCHER_OUT', str(ROOT / '.verify/b6-launcher-20260923'))).resolve()
assert (ROOT / '.verify').resolve() in OUT.parents


def child(mode, work, port, flags):
    db = work / 'fixture.sqlite'
    os.environ.update(SAVED_POSTS_DB_PATH=str(db), TELEGRAM_API_ID='0', TELEGRAM_API_HASH='',
                      LLM_API_KEY='synthetic', LITELLM_PROXY_KEY='synthetic')
    sys.path.insert(0, str(ROOT))
    attempted = []

    class MissingTelegram(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname.split('.')[0] == 'telethon':
                attempted.append(fullname)
                raise ModuleNotFoundError("No module named 'telethon'", name='telethon')
            if mode == 'unrelated' and fullname == 'fetcher':
                raise ModuleNotFoundError("No module named 'unexpected_internal'", name='unexpected_internal')
            if mode in ('serve', 'serve-default', 'occupied', 'missing-build') and fullname in ('fetcher', 'categorizer', 'telegram_refresh'):
                raise AssertionError('Unused live feature imported: ' + fullname)

    if mode != 'normal':
        sys.meta_path.insert(0, MissingTelegram())

    def guard(event, args):
        if event == 'sqlite3.connect':
            assert Path(args[0]).resolve() == db, 'Nonfixture database'
        if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)):
            p = Path(os.fsdecode(args[0])).resolve()
            name = p.name.lower()
            normalized = str(p).replace('\\', '/').lower()
            if name.startswith('.env') or '.session' in name or any(x in normalized for x in ('/thumb_cache/', '/user data/', '/mozilla/firefox/')) or '.db' in name or '.sqlite' in name:
                assert work in p.parents, 'Forbidden personal path'
        if event in ('socket.connect', 'socket.sendto', 'subprocess.Popen', 'os.kill'):
            raise AssertionError('Forbidden network/process action: ' + event)
    sys.addaudithook(guard)
    import config
    assert Path(config.DB_PATH).resolve() == db
    assert config.DASHBOARD_HOST == '127.0.0.1' and config.DASHBOARD_PORT == 5001
    config.DASHBOARD_PORT = port
    import webbrowser
    webbrowser.open = lambda *a, **k: False

    if mode == 'workflow':
        events = []
        import asyncio
        # The fake fetch completes synchronously. Avoid Windows asyncio's
        # internal socketpair so this sequence-only test keeps all sockets banned.
        def run_fake(coroutine):
            try:
                coroutine.send(None)
            except StopIteration as done:
                return done.value
            raise AssertionError('Unexpected asynchronous work in fake fetch')
        asyncio.run = run_fake
        def module(name, **functions):
            m = types.ModuleType(name)
            m.__dict__.update(functions)
            sys.modules[name] = m
        async def fetch():
            events.append('fetch')
            return 0, 0
        module('storage', init_db=lambda: events.append('init'))
        module('fetcher', fetch_saved_messages=fetch)
        module('metadata_fetcher', fetch_missing_metadata=lambda: events.append('metadata'))
        module('categorizer', categorize_unprocessed=lambda: events.append('categorize'))
        module('app', run_dashboard=lambda: events.append('serve'))
        sys.argv = [str(ROOT / 'run.py'), *flags]
        runpy.run_path(str(ROOT / 'run.py'), run_name='__main__')
        print('EVENTS ' + json.dumps(events))
        return

    if mode in ('serve', 'serve-default', 'normal', 'occupied'):
        import storage
        storage.init_db()
        storage.insert_post(99001, '2026-09-23T00:00:00+00:00', 'Synthetic launcher record',
                            'https://example.invalid/launcher', 'other', '{}')
        def dump():
            import sqlite3
            with sqlite3.connect(db) as conn:
                return list(conn.iterdump())
        before = dump()
        import app
        def forbidden(*args, **kwargs):
            raise AssertionError('Provider invoked')
        app.metadata_fetcher.fetch_metadata = forbidden
        app.metadata_fetcher.fetch_missing_metadata = forbidden
        if mode != 'occupied':
            # Same app/host/port; test-owned transport permits graceful shutdown.
            from werkzeug.serving import make_server
            def controlled_run(host, port, debug, request_handler):
                server = make_server(host, port, app.app, threaded=True, request_handler=request_handler)
                def stop():
                    sys.stdin.readline()
                    server.shutdown()
                threading.Thread(target=stop, daemon=True).start()
                print('READY', flush=True)
                try:
                    server.serve_forever()
                finally:
                    server.server_close()
            app.app.run = controlled_run
        sys.argv = [str(ROOT / 'run.py'), *([] if mode == 'serve-default' else ['--serve-only'])]
        runpy.run_path(str(ROOT / 'run.py'), run_name='__main__')
        assert dump() == before, 'Startup/routes changed fixture data'
        assert 'fetcher' not in sys.modules and 'categorizer' not in sys.modules
        print('UNCHANGED fixture; no live imports; graceful shutdown', flush=True)
        return

    if mode == 'missing-build':
        namespace = runpy.run_path(str(ROOT / 'run.py'))
        namespace['main'].__globals__['__file__'] = str(work / 'missing-project/run.py')
        sys.argv = ['run.py', '--serve-only']
        namespace['main']()
        return
    sys.argv = [str(ROOT / 'run.py'), *flags]
    runpy.run_path(str(ROOT / 'run.py'), run_name='__main__')


def main(phase):
    work = Path(tempfile.mkdtemp(prefix=phase + '-', dir=OUT))
    report = {'phase': phase, 'python': sys.executable, 'version': sys.version, 'work': str(work), 'checks': []}
    def command(mode, port=0, flags=()):
        return [sys.executable, '-B', '-u', str(Path(__file__).resolve()), 'child', mode, str(work), str(port), *flags]
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8'}
    def run(name, mode, flags, expected, text):
        result = subprocess.run(command(mode, flags=flags), env=env, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=20)
        log = result.stdout + result.stderr
        (work / (name + '.txt')).write_text(log, encoding='utf-8')
        assert result.returncode == expected and text in log, log
        report['checks'].append({'name': name, 'exit': result.returncode, 'status': 'PASS'})
        return log
    try:
        if phase == 'red':
            run('serve-before', 'missing', ['--serve-only'], 1, "No module named 'telethon'")
            run('help-before', 'missing', ['--help'], 1, "No module named 'telethon'")
        else:
          if phase == 'green':
            run('help', 'missing', ['--help'], 0, '--serve-only')
            for name, flags in [('fetch-only', ['--fetch-only'])]:
                log = run(name + '-missing', 'missing', flags, 1, 'Telegram')
                assert 'telethon' in log and 'pip install' in log and 'Traceback' not in log
            run('unrelated-import-not-hidden', 'unrelated', ['--fetch-only'], 1, 'unexpected_internal')
            log = run('missing-build', 'missing-build', [], 1, 'npm run build')
            assert 'Traceback' not in log
          if phase in ('green', 'remaining'):
            for name, flags, expected in [('default', [], ['init', 'serve']), ('fetch-only', ['--fetch-only'], ['init', 'fetch', 'metadata', 'categorize']), ('no-fetch', ['--no-fetch'], ['init', 'metadata', 'categorize', 'serve'])]:
                run(name + '-sequence', 'workflow', flags, 0, 'EVENTS ' + json.dumps(expected))
            with socket.socket() as sentinel:
                sentinel.bind(('127.0.0.1', 0)); sentinel.listen()
                busy = sentinel.getsockname()[1]
                log = subprocess.run(command('occupied', busy), env=env, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=20)
                (work / 'occupied.txt').write_text(log.stdout + log.stderr, encoding='utf-8')
                assert log.returncode != 0 and 'Traceback' not in log.stderr, log.stderr
                with socket.create_connection(('127.0.0.1', busy), timeout=2):
                    pass
                report['checks'].append({'name': 'occupied listener survives', 'status': 'PASS'})
            for mode in ('serve', 'serve-default'):
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
                with (work / (mode + '.txt')).open('w', encoding='utf-8') as output:
                    proc = subprocess.Popen(command(mode, port), env=env, cwd=ROOT, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.STDOUT)
                    try:
                        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                        base = f'http://127.0.0.1:{port}'
                        deadline = time.monotonic() + 20
                        while True:
                            assert proc.poll() is None, (work / (mode + '.txt')).read_text(encoding='utf-8')
                            try:
                                with opener.open(base + '/api/library', timeout=1) as response:
                                    assert len(json.load(response)['legacyRows']) == 1
                                break
                            except OSError:
                                if time.monotonic() > deadline: raise
                                time.sleep(.1)
                        expected = (ROOT / 'frontend/dist/index.html').read_bytes()
                        report['buildHash'] = hashlib.sha256(expected).hexdigest()
                        for asset in (ROOT / 'frontend/dist/assets').iterdir():
                            with opener.open(base + '/assets/' + asset.name, timeout=3) as response:
                                assert response.status == 200 and response.read() == asset.read_bytes()
                        for route in ('/', '/library', '/library/settings', '/library/item/tg-99001'):
                            for action in ('direct', 'refresh'):
                                with opener.open(base + route, timeout=3) as response:
                                    assert response.status == 200 and response.read() == expected
                                report['checks'].append({'name': mode + ' ' + route + ' ' + action, 'status': 'PASS'})
                    finally:
                        proc.communicate(b'stop\n', timeout=15)
                        report.setdefault('processes', []).append({'pid': proc.pid, 'port': port, 'exit': proc.returncode, 'closed': proc.poll() is not None})
                    assert proc.returncode == 0
                assert 'UNCHANGED fixture' in (work / (mode + '.txt')).read_text(encoding='utf-8')
        report['status'] = 'PASS'
    except BaseException as error:
        report.update(status='FAIL', error=repr(error))
        raise
    finally:
        (work / 'runtime.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    if sys.argv[1] == 'child':
        child(sys.argv[2], Path(sys.argv[3]).resolve(), int(sys.argv[4]), sys.argv[5:])
    else:
        main(sys.argv[1])
