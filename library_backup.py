"""Explicit durable JSON backup and non-overwriting new-database restore."""
import hashlib
import hmac
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
import tempfile
from urllib.parse import urlsplit, quote
from uuid import uuid4

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
            "deletedCount": len(d["library"]["tombstones"]), "sha256": d["sha256"], "mode": "new-database"}


def restore_backup(raw, confirmed_sha256):
    d = validate_backup(raw)
    if confirmed_sha256 != d["sha256"]:
        raise BackupError("Confirm the validated preview before restoring.")
    # No user-supplied paths or overwrite mode. The current DB is never written.
    directory = Path(config.DB_PATH).resolve().parent / "restored-libraries"
    directory.mkdir(exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".restore-", suffix=".sqlite", dir=directory)
    os.close(fd)
    temporary = Path(temporary)
    destination = directory / f"library-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid4().hex}.sqlite"
    try:
        storage.write_backup_library(temporary, d["library"])
        if storage.get_backup_library(temporary) != d["library"]:
            raise BackupError("Restored database did not match the backup; nothing was published.")
        # Reading above can enable WAL. Last connection has closed/checkpointed.
        # Hard-link creation is atomic and fails if the destination already exists.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            raise
        except OSError:
            # FAT32/exFAT, some network and cloud-synced folders have no hard
            # links: fall back to an exclusive-create copy (never overwrites).
            with open(temporary, "rb") as source, open(destination, "xb") as target:
                try:
                    shutil.copyfileobj(source, target)
                    target.flush()
                    os.fsync(target.fileno())
                except BaseException:
                    # Never leave a half-written database where a restore is expected.
                    target.close()
                    destination.unlink(missing_ok=True)
                    raise
        return {"path": str(destination), "recordCount": d["recordCount"], "mode": "new-database"}
    finally:
        for path in [temporary, Path(str(temporary) + "-wal"), Path(str(temporary) + "-shm")]:
            path.unlink(missing_ok=True)
