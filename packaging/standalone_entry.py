"""Windowless public runtime. Never adopts source/legacy user state."""
import contextlib
import ctypes
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import threading
import time
import urllib.request
import webbrowser


_ANOTHER_USER_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SuperBookmarks</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.25rem}
h1{font-size:1.25rem;line-height:1.4}</style></head>
<body><h1>This SuperBookmarks answers only the Windows user who started it.</h1>
<p>Windows couldn't confirm that's you. Each Windows user has their own copy, with their own library and settings. To use
yours, open SuperBookmarks from your Start Menu. If it isn't there, install it while you are signed in to your own account.</p>
<p>If this copy is yours, close any browser you started as administrator and open it the usual way.</p></body></html>""".encode()
_TURNED_AWAY = (b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n"
                b"Content-Length: " + str(len(_ANOTHER_USER_PAGE)).encode() + b"\r\n\r\n" + _ANOTHER_USER_PAGE)
_turning_away = threading.BoundedSemaphore(8)


def _turn_away(conn):
    """Give a connection from anyone else the fixed page and hang up, off the server's own thread. Nothing it sends is
    kept, and with many at once the rest are just hung up on, so they can't use up the app's connections or disk."""
    if not _turning_away.acquire(blocking=False):
        conn.close()
        return

    def answer():
        try:
            conn.settimeout(2)
            until = time.monotonic() + 2
            with contextlib.suppress(OSError):
                conn.recv(65536)                # a browser shows the page only once it has asked
                conn.sendall(_TURNED_AWAY)
                conn.shutdown(socket.SHUT_WR)
                while time.monotonic() < until and conn.recv(65536):
                    pass                        # closing with its bytes unread could lose the page on the way
        finally:
            conn.close()
            _turning_away.release()

    threading.Thread(target=answer, daemon=True).start()


def _bundle_dir():
    return Path(sys._MEIPASS) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]


def _data_dir():
    explicit = os.environ.get("SUPER_BOOKMARK_MANAGER_DATA_DIR")
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    path = Path(explicit) if explicit else Path(base) / "SuperBookmarkManager"
    if not path.is_absolute():
        raise ValueError("Data directory must be absolute")
    # Never follow a redirected public directory into legacy/personal state.
    from telegram_config import _checked_path
    _checked_path(path / "runtime.json")
    if path.name.lower() == "savedpostsdashboard":
        raise ValueError("Legacy data directory is not a public profile")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _quiet_streams():
    # PyInstaller --windowed sets these to None; libraries may still print.
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
    # No request/exception text (which might contain submitted credentials).
    logging.disable(logging.CRITICAL)


def _notify(message):
    ctypes.windll.user32.MessageBoxW(None, message, "SuperBookmarks", 0x10)


def _taken_address(port, origin):
    return (f"Another Windows user's program is using the address SuperBookmarks normally uses (http://127.0.0.1:{port}), so "
            f"it opened at {origin} instead. While that program is there, don't use old bookmarks or tabs for the usual "
            "address: they reach it, not SuperBookmarks.")


def _browser_secret(path, protect_file):
    """(A key only this user's copy of the app has, whether it was made now.) Its pages seal the browser's copy of the
    library with it, and tell the app from anything else at its address. Kept across runs; lost, it costs only that
    copy, which the library refills."""
    try:
        secret = bytes.fromhex(path.read_text(encoding="ascii"))
        if len(secret) == 32:
            return secret, False
    except (OSError, ValueError):
        pass
    secret = secrets.token_bytes(32)
    with open(path, "w", encoding="ascii") as record:
        protect_file(path)
        record.write(secret.hex())
    return secret, True


def _open_browser(origin):
    route = "/library/settings" if "--configure-telegram" in sys.argv[1:] else "/"
    if not webbrowser.open(origin + route):
        _notify("The browser could not be opened. Open " + origin + " in your browser. Quit is in the app's menu (behind the logo) and in Settings.")


def _build_id():
    """Identifies this exact build, so a newer install never hands off to an older copy."""
    try:
        stat = os.stat(sys.executable if getattr(sys, "frozen", False) else __file__)
        return f"{int(stat.st_mtime)}-{stat.st_size}"
    except OSError:
        return "unknown"


BUILD = _build_id()
REPLACED = "replaced"


def _built_at(build):
    """When a build was made: the first part of its id (the program file's time; installs keep it).
    None for copies from before build ids, or an id that isn't one."""
    head = build.split("-", 1)[0] if isinstance(build, str) else ""
    return int(head) if head.isdigit() else None


def _replace_running(opener, origin, token):
    """Ask an older copy of the app to quit so this build can take over.

    Uses the same confirmed /api/runtime/quit the app's own Quit button calls; the
    old copy's data is already in SQLite (browser-only pending edits stay in the
    browser and sync to the new copy)."""
    body = json.dumps({"confirm": True}).encode()
    req = urllib.request.Request(origin + "/api/runtime/quit", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-SBM-Instance": token})
    try:
        with opener.open(req, timeout=3):
            return True
    except (OSError, ValueError):
        return False


def _reopen(data):
    # Startup races get a bounded wait. Never open or stop an unidentified service.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(80):
        try:
            info = json.loads((data / "runtime.json").read_text())
            port, token = info["port"], info["token"]
            if type(port) is not int or not 0 < port < 65536 or not isinstance(token, str) or len(token) != 64:
                raise ValueError()
            origin = f"http://127.0.0.1:{port}"
            req = urllib.request.Request(origin + "/api/runtime", headers={"X-SBM-Instance": token})
            with opener.open(req, timeout=0.25) as response:
                status = json.load(response)
            if status.get("app") == "SuperBookmarkManager" and status.get("instance") == token:
                if status.get("build") == BUILD:
                    _open_browser(origin)
                    return 0
                running, mine = _built_at(status.get("build")), _built_at(BUILD)
                if running is not None and mine is not None and running > mine:
                    # This copy is older (a leftover install elsewhere): never replace the newer one.
                    _open_browser(origin)
                    _notify("A newer copy of SuperBookmarks is already running, so it was opened instead of this older one.")
                    return 0
                # An older build is still running: replace it instead of reopening it,
                # or the update never shows.
                if _replace_running(opener, origin, token):
                    return REPLACED
                _notify("An older copy of SuperBookmarks is still running and did not stop. "
                        "Quit it (Quit app in its menu, or its power button in the sidebar), then open the app again.")
                return 1
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.1)
    _notify("SuperBookmarks is already starting or stopping. Please try opening it again shortly.")
    return 1


def main():
    _quiet_streams()
    # Check website certificates with Windows itself, like the browser does.
    from tls_trust import use_system_trust
    use_system_trust()
    lock = None
    server = None
    sockets = {}
    try:
        data = _data_dir()
        import msvcrt
        lock = open(data / "runtime.lock", "a+b")
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            result = _reopen(data)
            if result != REPLACED:
                return result
            # The old copy is shutting down; take the lock once it lets go.
            for _ in range(150):
                time.sleep(0.1)
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    continue
            else:
                _notify("The previous copy of SuperBookmarks is taking a while to stop. Please open the app again in a moment.")
                return 1

        # Packaged profiles deliberately ignore legacy overrides and inherited
        # developer/provider secrets. Source launches retain their old contract.
        os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(data)
        os.environ["SAVED_POSTS_DB_PATH"] = str(data / "saved_posts.db")
        for key in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "LLM_API_KEY", "LLM_BASE_URL",
                    "LLM_MODEL", "LITELLM_PROXY_KEY", "LITELLM_PROXY_URL", "OPENAI_API_KEY",
                    "GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
                    "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "FREELLMAPI_KEY"):
            os.environ.pop(key, None)
        import config
        import storage
        import metadata_fetcher
        import archive
        import app as app_module
        import local_peer
        from flask import abort, jsonify, request
        from telegram_config import _checked_path, protect_file
        from waitress import create_server, wasyncore

        config.TELEGRAM_SESSION_FILE = str(data / "session.session")
        metadata_fetcher.THUMB_CACHE_DIR = str(data / "thumb_cache")
        # Saved copies of pages live beside the library, never in the program folder.
        archive.ARCHIVE_DIR = str(data / "archive")
        archive.discard_partials()   # a large download cut off when the app last quit
        # The optional TikTok video helper (downloaded only on request) too.
        import video_helper
        video_helper.HELPER_DIR = str(data / "helpers")
        app_module.SPA_DIR = str(_bundle_dir() / "frontend" / "dist")
        for name in ("saved_posts.db", "session.session", "browser-id.txt", "browser-key.txt", "runtime.json"):
            _checked_path(data / name)
        identity_path = data / "browser-id.txt"
        if not identity_path.exists():
            identity_path.write_text(secrets.token_hex(16), encoding="ascii")
        identity = identity_path.read_text(encoding="ascii")
        if len(identity) != 32 or any(c not in "0123456789abcdef" for c in identity):
            raise ValueError("Invalid browser profile identity")
        token = secrets.token_hex(32)
        secret, new_secret = _browser_secret(data / "browser-key.txt", protect_file)
        cache_key = hmac.new(secret, b"browser cache", hashlib.sha256).hexdigest()
        proof_key = hmac.new(secret, b"proof of this app", hashlib.sha256).hexdigest()
        app_module.app.config["PUBLIC_RUNTIME_META"] = (identity, token, cache_key, proof_key, "1" if new_secret else "0")
        stopping = threading.Event()
        origin = ""

        def refused(reason):
            if request.path.startswith("/api/"):
                return jsonify(ok=False, error=reason), 403     # a reason the caller can show
            abort(403)

        @app_module.app.before_request
        def public_boundary():
            if request.host_url.rstrip("/") != origin:
                return refused(f"SuperBookmarks answers at {origin}. Use that address.")
            # The two extensions aren't pages of this app: they prove themselves on their own routes.
            if request.method in ("GET", "HEAD", "OPTIONS") or request.endpoint in app_module.OUTSIDE_ROUTES:
                return None
            # A v0.1.0 tab at the same origin must not upload its cached library.
            if request.headers.get("X-SBM-Instance") != token:
                return refused("This page is from an earlier run of SuperBookmarks: reload it, then try again.")
            if request.headers.get("Origin", origin) != origin or request.headers.get("Sec-Fetch-Site") == "cross-site":
                return refused("Cross-origin requests are not allowed.")
            return None

        @app_module.app.after_request
        def not_kept_by_the_browser(response):
            # What the browser keeps of an answer, whatever answers at this address next can read back.
            if request.path.startswith("/api/"):
                response.headers.setdefault("Cache-Control", "no-store")
            return response

        @app_module.app.get("/api/runtime/hello")
        def runtime_hello():
            """Before a page sends anything, this app proves it is the one that served the page: see lib/publicRuntime."""
            nonce = request.args.get("nonce", "")
            if not re.fullmatch("[0-9a-f]{32}", nonce):
                abort(400)
            signed = lambda text: hmac.new(proof_key.encode("ascii"), text.encode("ascii"), hashlib.sha256).hexdigest()
            # `run` tells a page from an earlier run that it can no longer write, without any token being sent.
            return jsonify(proof=signed(f"{nonce}|{origin}"), run=signed(f"{nonce}|{origin}|{token}"))

        @app_module.app.get("/api/runtime")
        def runtime_status():
            if request.headers.get("X-SBM-Instance") != token:
                abort(403)
            response = jsonify(app="SuperBookmarkManager", instance=token, build=BUILD)
            response.headers["Cache-Control"] = "no-store"
            return response

        @app_module.app.post("/api/runtime/quit")
        def quit_runtime():
            if not request.is_json or request.get_json(silent=True) != {"confirm": True}:
                abort(400)
            # Let the acknowledgement reach the browser before draining workers.
            threading.Timer(0.5, stopping.set).start()
            return jsonify(ok=True)

        storage.init_db()
        desired = int(os.environ.get("SUPER_BOOKMARK_MANAGER_PORT", "5001"))
        previous = data / "runtime.json"
        if "SUPER_BOOKMARK_MANAGER_PORT" not in os.environ and previous.exists():
            try:
                desired = int(json.loads(previous.read_text())["port"])
            except (ValueError, KeyError):
                pass
        if not 0 <= desired < 65536:
            raise ValueError("Invalid port")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        taken = 0
        try:
            listener.bind(("127.0.0.1", desired))
        except OSError:
            taken = desired
            listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        # A Telegram refresh with photos and videos, a zip export or restore can hold a
        # thread for minutes while the browser fetches previews three at a time.
        # A backup zip with large videos and audio can be bigger than waitress's 1 GB default.
        server = create_server(app_module.app, sockets=[listener], map=sockets, threads=12,
                               expose_tracebacks=False, log_socket_errors=False,
                               max_request_body_size=archive.IMPORT_LIMIT)
        # 127.0.0.1 is shared by every Windows user on this PC: only the user who started the app is answered. Decided
        # once, when a program connects, so anyone else never reaches the app or holds one of its connections.
        channel = server.channel_class

        def this_user_only(server_, conn, addr, adj, map=None):
            if local_peer.same_user(addr[0], addr[1], server_.effective_port):
                return channel(server_, conn, addr, adj, map=map)
            _turn_away(conn)

        server.channel_class = this_user_only
        origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        # Protect the discovery record BEFORE writing the instance capability.
        with open(previous, "w", encoding="utf-8") as record:
            protect_file(previous)
            json.dump({"port": listener.getsockname()[1], "token": token}, record)
        threading.Thread(target=_open_browser, args=(origin,), daemon=True).start()
        if taken and local_peer.someone_else_listens(taken):
            threading.Thread(target=_notify, args=(_taken_address(taken, origin),), daemon=True).start()
        while not stopping.is_set():
            wasyncore.loop(timeout=0.1, count=1, map=sockets)
        return 0
    except Exception:
        _notify("SuperBookmarks could not start. Check that its data folder is writable and the installation is complete. Existing data has not been reset.")
        return 1
    finally:
        if server is not None:
            server.task_dispatcher.shutdown(timeout=15)
            from waitress import wasyncore
            wasyncore.close_all(map=sockets)
        if lock is not None:
            lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
