"""Preflight only; all application behavior remains owned by run.py."""
import importlib.util
import os
from pathlib import Path
import runpy
import sys


def main():
    if sys.version_info[:2] != (3, 12):
        print("Super Bookmark Manager needs Python 3.12. Install it or set SAVED_POSTS_PYTHON to its python.exe.")
        return 1
    root = Path(__file__).resolve().parent
    if importlib.util.find_spec("flask") is None:
        print('Flask is missing for this Python. Run this once, then start again:')
        print(f'"{sys.executable}" -m pip install -r "{root / "requirements-serve.txt"}"')
        print("Nothing was installed automatically; your library was not opened.")
        return 1
    if not (root / "frontend" / "dist" / "index.html").is_file():
        print("Packaged frontend is missing. Recreate the package from the accepted build; startup does not build or download assets.")
        return 1
    # Retain the meaning of relative overrides even when launched from elsewhere.
    if os.environ.get("SAVED_POSTS_DB_PATH"):
        os.environ["SAVED_POSTS_DB_PATH"] = str(Path(os.environ["SAVED_POSTS_DB_PATH"]).resolve())
    os.chdir(root)
    sys.path.insert(0, str(root))
    print("Super Bookmark Manager — local Windows launcher", flush=True)
    print("Close this server with Ctrl+C. No automatic Telegram refresh or provider work.", flush=True)
    try:
        runpy.run_path(str(root / "run.py"), run_name="__main__")
    except ModuleNotFoundError as exc:
        print(f"A requested component needs the missing Python module: {exc.name}.")
        print("See BUILD_AND_RUN.md for this interpreter's optional dependencies. No alternate workflow was started.")
        return 1
    except (OSError, ValueError) as exc:
        print(f"Could not start the dashboard: {exc}")
        print("Check the database folder and local port. Existing services were not stopped.")
        return 1
    except KeyboardInterrupt:
        print("Server stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
