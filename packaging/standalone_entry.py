"""Standalone Windows runtime entry point.

Thin bootstrap only: it resolves bundled (immutable) versus per-user (writable)
paths, then delegates to the existing Flask application startup. No application
logic is duplicated here — routes, storage and enrichment remain owned by
app.py / storage.py / metadata_fetcher.py exactly as in the source tree.

Writable runtime state (SQLite DB, thumbnail cache, restored libraries, an
optional owner-supplied Telegram session) is redirected into a per-user data
directory so nothing is ever written into PyInstaller's immutable bundle folder.
SAVED_POSTS_DB_PATH continues to override the default database location.
"""
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path


def _bundle_dir() -> Path:
    """Immutable bundled-asset root (PyInstaller _internal, or the source tree)."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def _data_dir() -> Path:
    """Per-user writable application-data directory."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    data = Path(base) / "SavedPostsDashboard"
    data.mkdir(parents=True, exist_ok=True)
    return data


def main() -> int:
    bundle = _bundle_dir()
    data = _data_dir()

    # Default writable DB lives in the per-user data dir; an explicit user override
    # wins because setdefault never replaces an already-present value.
    os.environ.setdefault("SAVED_POSTS_DB_PATH", str(data / "saved_posts.db"))
    # Retain the meaning of a relative override regardless of launch directory.
    os.environ["SAVED_POSTS_DB_PATH"] = str(Path(os.environ["SAVED_POSTS_DB_PATH"]).resolve())

    # Import application modules only AFTER the database env is set, so config picks it up.
    import config
    import storage
    import metadata_fetcher
    import app as app_module

    # Redirect writable runtime state out of the immutable bundle directory.
    config.TELEGRAM_SESSION_FILE = str(data / "session.session")
    metadata_fetcher.THUMB_CACHE_DIR = str(data / "thumb_cache")
    # Point the SPA route at the bundled (read-only) frontend build.
    app_module.SPA_DIR = str(bundle / "frontend" / "dist")

    # Packaging-only launch override; the application default (5001) is unchanged
    # when SAVED_POSTS_PORT is absent. Lets a portable bundle avoid a port conflict
    # without ever stopping another running service.
    port_override = os.environ.get("SAVED_POSTS_PORT")
    if port_override:
        config.DASHBOARD_PORT = int(port_override)

    # Create-or-open (never truncate) the selected database.
    storage.init_db()

    host, port = config.DASHBOARD_HOST, config.DASHBOARD_PORT
    print("Super Bookmark Manager - standalone Windows runtime", flush=True)
    print(f"Dashboard: http://{host}:{port}", flush=True)
    print(f"Data directory: {data}", flush=True)
    print("Close this server with Ctrl+C. No automatic Telegram refresh or provider work.", flush=True)

    def _open_browser():
        time.sleep(1.5)
        try:
            route = "/library/settings" if "--configure-telegram" in sys.argv[1:] else "/"
            webbrowser.open(f"http://{host}:{port}{route}")
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()

    try:
        app_module.run_dashboard()
    except KeyboardInterrupt:
        print("Server stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
