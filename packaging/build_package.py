"""Reproducible allowlisted launcher folder. Never traverses personal data."""
import ast
import hashlib
import json
from pathlib import Path
import shutil
from datetime import datetime, timezone
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ["run.py", "app.py", "config.py", "storage.py", "metadata_fetcher.py",
           "categorizer.py", "fetcher.py", "telegram_refresh.py", "taxonomy.py", "library_backup.py", "telegram_config.py"]
EXCLUDED = ["*.db", "*.sqlite", "*-wal", "*-shm", "*.bak", "restored-libraries/", "backups/",
            "*.session*", ".env*", "credentials", "API key values", "browser profiles", "thumb_cache/",
            "caches/", "personal exports", ".verify/", ".git/", "docs/recovery/", "node_modules/", "__pycache__/", "*.pyc"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    accepted = json.loads((ROOT / "packaging/frontend-build.json").read_text(encoding="utf-8"))
    # Copy configuration code, never its resolved environment or an edited secret.
    assignments = {node.targets[0].id: ast.unparse(node.value) for node in ast.parse((ROOT / "config.py").read_text(encoding="utf-8")).body
                   if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    safe = {"TELEGRAM_API_ID": "int(os.environ.get('TELEGRAM_API_ID', '0'))",
            "TELEGRAM_API_HASH": "os.environ.get('TELEGRAM_API_HASH', '')",
            "LLM_API_KEY": "os.environ.get('LLM_API_KEY', 'not-needed')",
            "LITELLM_PROXY_KEY": "os.environ.get('LITELLM_PROXY_KEY', 'sk-local-dashboard-proxy')",
            "DASHBOARD_HOST": "'127.0.0.1'"}
    for name, expression in safe.items():
        if assignments.get(name) != expression:
            raise ValueError(f"Refusing to package modified credential/local-host configuration: {name}")
    files = {path: path for path in BACKEND + ["requirements.txt", "templates/index.html", "templates/command.html"]}
    for name in ["package_start.py", "Start Super Bookmark Manager.bat", "requirements-serve.txt", "BUILD_AND_RUN.md"]:
        files[name] = "packaging/" + name
    for path, expected in accepted.items():
        if not path.startswith("frontend/dist/") or ".." in Path(path).parts or digest(ROOT / path) != expected:
            raise ValueError("Frontend build differs from the accepted asset manifest; build and review it before packaging.")
        files[path] = path
    for path in files.values():
        if (ROOT / path).is_symlink() or not (ROOT / path).is_file():
            raise ValueError("Required plain source/build file is missing: " + path)
    directory = ROOT / "dist-package"
    directory.mkdir(exist_ok=True)
    destination = directory / ("SuperBookmarkManager-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:8])
    destination.mkdir()  # Exclusive: never overwrite an older package or its DB.
    try:
        manifest = {"model": "Windows launcher folder; installed Python3.12/Flask required", "files": {},
                    "excluded": EXCLUDED, "pythonBundled": False, "defaultDatabase": "app-local saved_posts.db",
                    "optionalDependenciesBundled": []}
        for target, source in files.items():
            output = destination / target
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / source, output)
            manifest["files"][target] = digest(output)
        (destination / "PACKAGE_CONTENTS.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        actual = {p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()}
        if actual != set(files) | {"PACKAGE_CONTENTS.json"}:
            raise ValueError("Unexpected package contents; refusing success.")
        print(json.dumps({"output": str(destination), "files": len(actual), "frontend": accepted}))
    except Exception:
        # Preserve an incomplete output for inspection; never recursively delete data.
        print("Package incomplete; inspect this newly created folder: " + str(destination))
        raise


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
