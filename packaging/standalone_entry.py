"""Windowless public runtime. Never adopts source/legacy user state."""
import ctypes
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
import urllib.request
import webbrowser


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
    ctypes.windll.user32.MessageBoxW(None, message, "Super Bookmark Manager", 0x10)


def _open_browser(origin):
    route = "/library/settings" if "--configure-telegram" in sys.argv[1:] else "/"
    if not webbrowser.open(origin + route):
        _notify("The browser could not be opened. Open " + origin + " in your browser. Quit is available in Library settings.")


def _build_id():
    """Identifies this exact build, so a newer install never hands off to an older copy."""
    try:
        stat = os.stat(sys.executable if getattr(sys, "frozen", False) else __file__)
        return f"{int(stat.st_mtime)}-{stat.st_size}"
    except OSError:
        return "unknown"


BUILD = _build_id()
REPLACED = "replaced"


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
                # A different (usually older) build is still running: replace it
                # instead of reopening it, or the update never shows.
                if _replace_running(opener, origin, token):
                    return REPLACED
                _notify("An older copy of Super Bookmark Manager is still running and did not stop. "
                        "Quit it from its sidebar power button, then open the app again.")
                return 1
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.1)
    _notify("Super Bookmark Manager is already starting or stopping. Please try opening it again shortly.")
    return 1


def main():
    _quiet_streams()
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
                _notify("The previous copy of Super Bookmark Manager is taking a while to stop. Please open the app again in a moment.")
                return 1

        # Packaged profiles deliberately ignore legacy overrides and inherited
        # developer/provider secrets. Source launches retain their old contract.
        os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(data)
        os.environ["SAVED_POSTS_DB_PATH"] = str(data / "saved_posts.db")
        for key in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "LLM_API_KEY", "LLM_BASE_URL",
                    "LLM_MODEL", "LITELLM_PROXY_KEY", "LITELLM_PROXY_URL", "OPENAI_API_KEY",
                    "GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
                    "OPENROUTER_API_KEY", "NVIDIA_API_KEY"):
            os.environ.pop(key, None)
        import config
        import storage
        import metadata_fetcher
        import app as app_module
        from flask import abort, jsonify, request
        from telegram_config import _checked_path, protect_file
        from waitress import create_server, wasyncore

        config.TELEGRAM_SESSION_FILE = str(data / "session.session")
        metadata_fetcher.THUMB_CACHE_DIR = str(data / "thumb_cache")
        app_module.SPA_DIR = str(_bundle_dir() / "frontend" / "dist")
        for name in ("saved_posts.db", "session.session", "browser-id.txt", "runtime.json"):
            _checked_path(data / name)
        identity_path = data / "browser-id.txt"
        if not identity_path.exists():
            identity_path.write_text(secrets.token_hex(16), encoding="ascii")
        identity = identity_path.read_text(encoding="ascii")
        if len(identity) != 32 or any(c not in "0123456789abcdef" for c in identity):
            raise ValueError("Invalid browser profile identity")
        token = secrets.token_hex(32)
        app_module.app.config["PUBLIC_RUNTIME_META"] = (identity, token)
        stopping = threading.Event()
        origin = ""

        @app_module.app.before_request
        def public_boundary():
            if request.host_url.rstrip("/") != origin:
                abort(403)
            # A v0.1.0 tab at the same origin must not upload its cached library.
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                if request.headers.get("X-SBM-Instance") != token:
                    abort(403)
                if request.headers.get("Origin", origin) != origin or request.headers.get("Sec-Fetch-Site") == "cross-site":
                    abort(403)

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
        try:
            listener.bind(("127.0.0.1", desired))
        except OSError:
            listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        server = create_server(app_module.app, sockets=[listener], map=sockets, threads=4,
                               expose_tracebacks=False, log_socket_errors=False)
        origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        # Protect the discovery record BEFORE writing the instance capability.
        with open(previous, "w", encoding="utf-8") as record:
            protect_file(previous)
            json.dump({"port": listener.getsockname()[1], "token": token}, record)
        threading.Thread(target=_open_browser, args=(origin,), daemon=True).start()
        while not stopping.is_set():
            wasyncore.loop(timeout=0.1, count=1, map=sockets)
        return 0
    except Exception:
        _notify("Super Bookmark Manager could not start. Check that its data folder is writable and the installation is complete. Existing data has not been reset.")
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
