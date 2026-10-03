"""Reject personal/runtime artifacts by path BEFORE reading or hashing bytes."""
from pathlib import Path
import zipfile

FORBIDDEN_DIRS = {"backups", "backup", "exports", "export", "thumb_cache", "profiles",
                  "profile", "user data", "browser_data", "browser-data", ".git", ".verify"}


def forbidden(name):
    parts = name.replace("\\", "/").lower().split("/")
    leaf = parts[-1]
    return (bool(set(parts[:-1]) & FORBIDDEN_DIRS)
            or leaf in {"config.json", "credentials.json", "cookies", "history", "login data",
                        "local state", "preferences", "bookmarks", "runtime.json", "browser-id.txt"}
            or leaf.startswith((".env", "secrets."))
            or leaf.endswith(".db") or ".db-" in leaf
            or ".sqlite" in leaf or ".session" in leaf)


def scan(root):
    root = Path(root)
    files = [root] if root.is_file() else sorted(root.rglob("*"))
    # First inspect the WHOLE tree; never hash or open forbidden entries.
    for path in files:
        relative = path.name if path == root else path.relative_to(root).as_posix()
        if path.is_symlink() or path.is_junction() or forbidden(relative + ("/" if path.is_dir() else "")):
            raise ValueError("Forbidden runtime artifact in release input: " + relative)
    for path in files:
        if path.is_file() and path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                if any(forbidden(name) for name in archive.namelist()):
                    raise ValueError("Forbidden runtime artifact in release archive: " + path.name)
    return sum(path.is_file() for path in files)
