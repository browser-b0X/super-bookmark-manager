"""Restore a JSON backup into the library the app is using. Synthetic databases only.

Found after a fresh install: "Restore backup" said "Restored 476 items into a new database"
and the library stayed empty. Restore wrote a separate file in restored-libraries and
asked for PowerShell and a fresh browser profile to use it, which an installed app can't do.
"""
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
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "unused.sqlite")
sys.dont_write_bytecode = True
sys.path.insert(0, str(WORKSPACE))
import app  # noqa: E402
import library_backup  # noqa: E402
import storage  # noqa: E402

H = {"Host": "127.0.0.1:5001"}
AT = "2026-09-17T12:00:00Z"


def post(name, shelf="other"):
    return {"id": f"fixture-{name}", "url": f"https://{name}.example.invalid/", "source": "manual", "platform": "web",
            "domain": f"{name}.example.invalid", "status": "inbox", "createdAt": AT, "updatedAt": AT,
            "metadataStatus": "partial", "categories": [shelf], "tags": [], "projectIds": []}


class RestoreIntoTheLibrary(unittest.TestCase):
    def use(self, name):
        """Point the app at one synthetic database (a different install, say)."""
        path = FIXTURE / self._testMethodName / f"{name}.sqlite"
        path.parent.mkdir(parents=True, exist_ok=True)
        storage.config.DB_PATH = str(path)
        storage.init_db()
        return path

    def backup_of(self, *posts, deleted=()):
        self.use("old-install")
        storage.save_library({"posts": list(posts), "deletedUrls": list(deleted)})
        return json.dumps(library_backup.export_backup())

    def restore(self, raw):
        client = app.app.test_client()
        preview = client.post("/api/backup/preview", json={"content": raw}, headers=H)
        self.assertEqual(preview.status_code, 200, preview.json)
        answer = client.post("/api/backup/restore", json={"content": raw, "sha256": preview.json["sha256"], "confirm": True}, headers=H)
        self.assertEqual(answer.status_code, 200, answer.json)
        return preview.json, answer.json

    def test_a_fresh_install_gets_the_backup_s_links(self):
        raw = self.backup_of(post("a", "technology"), post("b"), deleted=["https://gone.example.invalid/"])
        fresh = self.use("new-install")
        preview, answer = self.restore(raw)
        self.assertEqual((preview["recordCount"], preview["currentCount"]), (2, 0))
        self.assertEqual((answer["recordCount"], answer["safetyCopy"]), (2, ""), "nothing to keep from an empty library")
        library = app.app.test_client().get("/api/library", headers=H).json
        self.assertEqual(sorted(p["url"] for p in library["posts"]), ["https://a.example.invalid/", "https://b.example.invalid/"])
        self.assertEqual(library["deletedUrls"], ["https://gone.example.invalid/"])
        self.assertGreater(library["epoch"], 0)
        self.assertEqual(storage.get_backup_library(), json.loads(raw)["library"])
        self.assertFalse((fresh.parent / "restored-libraries").exists(), "no separate database any more")

    def test_a_library_with_links_is_saved_first_and_can_be_put_back(self):
        raw = self.backup_of(post("a"), post("b"))
        self.use("current")
        storage.save_library({"posts": [post("mine")], "deletedUrls": []})
        preview, answer = self.restore(raw)
        self.assertEqual(preview["currentCount"], 1)
        self.assertEqual(sorted(p["id"] for p in storage.get_library()["posts"]), ["fixture-a", "fixture-b"])
        safety = Path(answer["safetyCopy"])
        self.assertEqual(safety.parent, Path(storage.config.DB_PATH).parent / "backups")
        kept = safety.read_text(encoding="utf-8")
        self.assertEqual([p["id"] for p in library_backup.validate_backup(kept)["library"]["posts"]], ["fixture-mine"])
        # The safety copy is an ordinary backup: restoring it puts the library back as it was.
        _, back = self.restore(kept)
        self.assertEqual([p["id"] for p in storage.get_library()["posts"]], ["fixture-mine"])
        self.assertNotEqual(back["safetyCopy"], answer["safetyCopy"], "a second restore never overwrites the first safety copy")

    def test_a_tab_still_holding_the_replaced_library_is_told_to_reload(self):
        raw = self.backup_of(post("a"))
        self.use("current")
        storage.save_library({"posts": [post("mine")], "deletedUrls": []})
        before = storage.get_library()["epoch"]
        self.restore(raw)
        after = storage.get_library()["epoch"]
        self.assertNotEqual(after, before)
        # Its unsaved edit to a link of the old library must not come back into the restored one.
        stale = {"posts": [post("mine")], "deletedUrls": [], "epoch": before}
        response = app.app.test_client().post("/api/library", json=stale, headers=H)
        self.assertEqual((response.status_code, response.json.get("code")), (409, "library_replaced"))
        self.assertEqual([p["id"] for p in storage.get_library()["posts"]], ["fixture-a"])
        # So is a page from before restores existed, which sends no epoch at all.
        old_page = app.app.test_client().post("/api/library", json={"posts": [post("mine")], "deletedUrls": []}, headers=H)
        self.assertEqual((old_page.status_code, old_page.json.get("code")), (409, "library_replaced"))
        self.assertIn("Reload the page", old_page.json["error"])
        self.assertEqual([p["id"] for p in storage.get_library()["posts"]], ["fixture-a"])
        # A tab that has the restored library saves as usual.
        fresh = {"posts": [post("new")], "deletedUrls": [], "epoch": after}
        self.assertEqual(app.app.test_client().post("/api/library", json=fresh, headers=H).status_code, 200)

    def test_a_restore_that_fails_after_saving_the_library_leaves_no_copy_behind(self):
        raw = self.backup_of(post("a"))
        self.use("current")
        storage.save_library({"posts": [post("mine")], "deletedUrls": []})
        before = storage.get_library()
        failing = storage.LibraryValidationError("The restored library did not match the backup, so nothing was changed.")
        with patch.object(storage, "replace_library", side_effect=failing):
            client = app.app.test_client()
            preview = client.post("/api/backup/preview", json={"content": raw}, headers=H).json
            answer = client.post("/api/backup/restore", json={"content": raw, "sha256": preview["sha256"], "confirm": True}, headers=H)
        self.assertEqual(answer.status_code, 400)
        self.assertEqual(storage.get_library(), before)
        self.assertEqual(list((Path(storage.config.DB_PATH).parent / "backups").glob("*")), [])

    def test_before_any_restore_a_page_without_an_epoch_saves_as_before(self):
        self.use("current")
        response = app.app.test_client().post("/api/library", json={"posts": [post("mine")], "deletedUrls": []}, headers=H)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json["epoch"], 0)

    def test_telegram_links_still_being_saved_hold_the_restore_back(self):
        raw = self.backup_of(post("a"))
        self.use("current")
        storage.save_library({"posts": [post("mine")], "deletedUrls": []})
        before = storage.get_library()
        with patch.object(storage, "get_backup_library", side_effect=storage.LibraryValidationError("legacy rows pending")):
            client = app.app.test_client()
            preview = client.post("/api/backup/preview", json={"content": raw}, headers=H).json
            answer = client.post("/api/backup/restore", json={"content": raw, "sha256": preview["sha256"], "confirm": True}, headers=H)
        self.assertEqual(answer.status_code, 400)
        self.assertIn("still saving links from Telegram", answer.json["error"])
        self.assertEqual(storage.get_library(), before)
        self.assertFalse((Path(storage.config.DB_PATH).parent / "backups").exists())

    def test_a_restore_that_fails_changes_nothing(self):
        raw = self.backup_of(post("a"))
        self.use("current")
        storage.save_library({"posts": [post("mine")], "deletedUrls": []})
        before = storage.get_library()
        with patch.object(storage, "_backup_rows", side_effect=lambda conn: {"posts": [], "tombstones": [], "categories": []}):
            client = app.app.test_client()
            preview = client.post("/api/backup/preview", json={"content": raw}, headers=H).json
            answer = client.post("/api/backup/restore", json={"content": raw, "sha256": preview["sha256"], "confirm": True}, headers=H)
        self.assertEqual(answer.status_code, 400)
        self.assertIn("nothing was changed", answer.json["error"])
        self.assertEqual(storage.get_library(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
