"""Restore without hard links (FAT32/exFAT, some network/cloud folders). Synthetic DB only."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[2]
VERIFY = WORKSPACE / ".verify"
VERIFY.mkdir(exist_ok=True)
FIXTURE = Path(tempfile.mkdtemp(prefix="backup-restore-", dir=VERIFY))
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "fixture.sqlite")
sys.dont_write_bytecode = True
sys.path.insert(0, str(WORKSPACE))
import storage  # noqa: E402
import library_backup  # noqa: E402

POST = {"id": "fixture-1", "url": "https://example.invalid/a", "source": "manual", "platform": "web",
        "domain": "example.invalid", "status": "inbox", "createdAt": "2026-09-17T12:00:00Z",
        "updatedAt": "2026-09-17T12:00:00Z", "metadataStatus": "partial", "categories": ["other"],
        "tags": [], "projectIds": []}


class RestoreFallbackTests(unittest.TestCase):
    def test_restore_copies_when_hard_links_are_unsupported(self):
        storage.config.DB_PATH = os.environ["SAVED_POSTS_DB_PATH"]
        storage.init_db()
        storage.save_library({"posts": [POST], "deletedUrls": []})
        document = library_backup.export_backup()
        raw = json.dumps(document)
        with patch.object(library_backup.os, "link", side_effect=OSError(1, "Operation not permitted")):
            result = library_backup.restore_backup(raw, document["sha256"])
        self.assertTrue(Path(result["path"]).is_file())
        self.assertEqual(storage.get_backup_library(result["path"])["posts"], [POST])
        # Never overwrites: a second restore gets its own new file.
        with patch.object(library_backup.os, "link", side_effect=OSError(1, "Operation not permitted")):
            again = library_backup.restore_backup(raw, document["sha256"])
        self.assertNotEqual(again["path"], result["path"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
