"""Explicit durable JSON backup, and restore into the library in use (the library as it was saved first)."""
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, quote

import config
import storage

FORMAT = "saved-posts-library"
VERSION = 1


class BackupError(ValueError):
    pass


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")


def _checksum(document):
    return hashlib.sha256(_canonical({k: v for k, v in document.items() if k != "sha256"})).hexdigest()


def _identity(url):
    p = urlsplit(url)
    port = p.port
    if (p.scheme.lower(), port) in (("http", 80), ("https", 443)):
        port = None
    return (p.scheme.lower(), p.hostname.lower(), port, p.username, p.password,
            quote(p.path or "/", safe="/%:@!$&'()*+,;=-._~"), p.query, p.fragment)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BackupError("Duplicate JSON field; choose an intact backup.")
        result[key] = value
    return result


def validate_backup(raw):
    try:
        document = json.loads(raw, object_pairs_hook=_unique_object,
                              parse_constant=lambda _: (_ for _ in ()).throw(BackupError("Invalid JSON number.")))
    except (ValueError, TypeError, RecursionError) as exc:
        raise BackupError("The backup is empty, malformed or truncated JSON. Nothing was restored.") from exc
    if not isinstance(document, dict) or document.get("format") != FORMAT or type(document.get("version")) is not int or document["version"] != VERSION:
        raise BackupError("Unsupported backup format or version. Expected Saved Posts Library version 1.")
    if set(document) != {"format", "version", "exportedAt", "recordCount", "library", "sha256"}:
        raise BackupError("Backup sections are missing or unsupported.")
    try:
        if not isinstance(document["exportedAt"], str) or datetime.fromisoformat(document["exportedAt"]).tzinfo is None:
            raise ValueError()
    except ValueError as exc:
        raise BackupError("Invalid backup export timestamp.") from exc
    data = document["library"]
    if not isinstance(data, dict) or set(data) != {"posts", "tombstones", "categories"} or not all(isinstance(data[k], list) for k in data):
        raise BackupError("Backup requires records, deletion markers and categories.")
    if type(document["recordCount"]) is not int or document["recordCount"] != len(data["posts"]):
        raise BackupError("Backup record count does not match its contents.")
    tombstones = data["tombstones"]
    for t in tombstones:
        if not isinstance(t, dict) or set(t) != {"url", "id"} or not (t["id"] is None or isinstance(t["id"], str) and t["id"].strip()):
            raise BackupError("Invalid deletion marker.")
    try:
        storage._validate_library_delta({"posts": data["posts"], "deletedUrls": [t["url"] for t in tombstones]})
        ids, urls = set(), set()
        for item in [*data["posts"], *tombstones]:
            identity = _identity(item["url"])
            if identity in urls or item["id"] is not None and item["id"] in ids:
                raise BackupError("Duplicate record ID or URL, or a record conflicts with a deletion marker.")
            urls.add(identity)
            if item["id"] is not None:
                ids.add(item["id"])
    except storage.LibraryValidationError as exc:
        raise BackupError(str(exc)) from exc
    names = set()
    for c in data["categories"]:
        if (not isinstance(c, dict) or set(c) != {"name", "sort_order", "created_at"}
                or not isinstance(c["name"], str) or not c["name"].strip() or c["name"] in names
                or type(c["sort_order"]) is not int or not isinstance(c["created_at"], str)):
            raise BackupError("Invalid or duplicate category definition.")
        names.add(c["name"])
    if not names:
        raise BackupError("Backup has no category definitions.")
    supplied = document["sha256"]
    if (not isinstance(supplied, str) or len(supplied) != 64 or any(c not in "0123456789abcdef" for c in supplied)
            or not hmac.compare_digest(supplied, _checksum(document))):
        raise BackupError("Backup checksum mismatch. The file is corrupt or has changed.")
    return document


def export_backup():
    data = storage.get_backup_library()
    document = {"format": FORMAT, "version": VERSION, "exportedAt": datetime.now(timezone.utc).isoformat(),
                "recordCount": len(data["posts"]), "library": data}
    document["sha256"] = _checksum(document)
    validate_backup(json.dumps(document))
    return document


def preview_backup(raw):
    d = validate_backup(raw)
    return {"version": d["version"], "exportedAt": d["exportedAt"], "recordCount": d["recordCount"],
            "deletedCount": len(d["library"]["tombstones"]), "sha256": d["sha256"], "mode": "replace",
            # Links in the library now, which the restore replaces (saved first; see restore_backup).
            "currentCount": storage.live_count()}


def _safety_copy(library):
    """The library as it was, as an ordinary backup file in a backups folder beside it.

    "Restore backup" with this file puts it back. A new name each time: never overwrites one."""
    document = {"format": FORMAT, "version": VERSION, "exportedAt": datetime.now(timezone.utc).isoformat(),
                "recordCount": len(library["posts"]), "library": library}
    document["sha256"] = _checksum(document)
    text = json.dumps(document, ensure_ascii=True, indent=2)
    validate_backup(text)
    directory = Path(config.DB_PATH).resolve().parent / "backups"
    directory.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for attempt in range(100):
        path = directory / f"before-restore-{stamp}{'' if attempt == 0 else f'-{attempt + 1}'}.json"
        try:
            with open(path, "x", encoding="utf-8") as target:
                target.write(text)
                target.flush()
                os.fsync(target.fileno())
            return path
        except FileExistsError:
            continue
    raise BackupError("Could not save the current library before restoring; nothing was changed.")


def restore_backup(raw, confirmed_sha256):
    """Put a backup's links, deletion markers and shelves into the library in use.

    A library that has links is saved first (see _safety_copy), so restoring is never a loss."""
    d = validate_backup(raw)
    if confirmed_sha256 != d["sha256"]:
        raise BackupError("Confirm the validated preview before restoring.")
    try:
        current = storage.get_backup_library()
    except storage.LibraryValidationError as exc:
        # Telegram links that Library has not saved yet would be in neither library.
        raise BackupError("Library is still saving links from Telegram. Restore once it shows them saved; nothing was changed.") from exc
    safety = _safety_copy(current) if current["posts"] or current["tombstones"] else None
    try:
        epoch = storage.replace_library(d["library"])
    except Exception as exc:
        # Nothing changed, so the copy of the unchanged library is not needed.
        if safety:
            safety.unlink(missing_ok=True)
        if isinstance(exc, storage.LibraryValidationError):
            raise BackupError(str(exc)) from exc
        raise
    return {"recordCount": d["recordCount"], "mode": "replaced", "epoch": epoch,
            "safetyCopy": str(safety) if safety else ""}
