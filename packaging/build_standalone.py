"""Reproducible PyInstaller one-folder build for the standalone Windows runtime.

Exact equivalent command (run from the repository root with the build interpreter):

    python packaging/build_standalone.py

This wraps PyInstaller so the argument list stays version-controlled and free of
shell-quoting problems (the repository path contains spaces). Output is written to
dist-standalone/SuperBookmarkManager/ and never touches the source tree or personal data.

Bundler model: PyInstaller --onedir (one-folder). Telegram refresh includes Telethon;
optional LLM providers, cryptg and the fetch-only module remain excluded.
"""
from pathlib import Path
import hashlib
import json

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parents[1]

LOCAL_MODULES = [
    "config", "storage", "app", "metadata_fetcher", "safe_http",
    "library_backup", "firefox_import", "telegram_refresh",
    "categorizer", "taxonomy", "telegram_config", "telegram_auth", "telethon",
]
FLASK_HIDDEN = [
    "flask", "werkzeug", "jinja2", "itsdangerous", "click", "blinker", "markupsafe",
]
EXCLUDES = ["openai", "cryptg", "fetcher", "run", "pyinstaller", "PyInstaller"]


def build_args():
    args = [
        str(ROOT / "packaging" / "standalone_entry.py"),
        "--onedir",
        "--name", "SuperBookmarkManager",
        "--console",
        "--icon", str(ROOT / "packaging" / "app.ico"),
        "--noconfirm",
        "--clean",
        "--distpath", str(ROOT / "dist-standalone"),
        "--workpath", str(ROOT / "packaging" / "build-standalone"),
        "--specpath", str(ROOT / "packaging"),
        "--paths", str(ROOT),
        # Immutable bundled assets (Windows uses ';' as the add-data separator).
        "--add-data", f"{ROOT / 'frontend' / 'dist'};frontend/dist",
        "--add-data", f"{ROOT / 'templates'};templates",
        "--add-data", f"{ROOT / 'taxonomy_plan.json'};.",
        "--add-data", f"{ROOT / 'LICENSE'};.",
        "--add-data", f"{ROOT / 'THIRD_PARTY_LICENSES.md'};.",
        "--add-data", f"{ROOT / 'third_party_notices'};third_party_notices",
    ]
    for module in LOCAL_MODULES + FLASK_HIDDEN:
        args += ["--hidden-import", module]
    for module in EXCLUDES:
        args += ["--exclude-module", module]
    return args


def main():
    args = build_args()
    print("PyInstaller args:")
    for arg in args:
        print("  " + arg)
    PyInstaller.__main__.run(args)
    # Record every output byte from this build, independent of machine-specific EXE hashes.
    # The installer verifies this complete receipt plus the current frontend/assets.
    bundle = ROOT / "dist-standalone" / "SuperBookmarkManager"
    receipt = {p.relative_to(bundle).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
               for p in sorted(bundle.rglob("*")) if p.is_file()}
    (bundle.parent / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
