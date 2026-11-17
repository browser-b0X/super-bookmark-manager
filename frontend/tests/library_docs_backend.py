"""Library documents (v0.4.0 phase 6): tags with the tags they sit under and their other names, kept in SQLite
beside the links, merged per document between browsers (the later change wins; a deletion reaches everyone unless
the tag changed after), checked on the way in, and carried by backups and restore. Synthetic data only.

Run: python -B frontend/tests/library_docs_backend.py
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
FIXTURE = Path(tempfile.mkdtemp(prefix="library-docs-"))
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(FIXTURE / "data")
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "library.sqlite")
import storage  # noqa: E402
import library_backup  # noqa: E402

# The dates here are fixed and their order matters: none may be forgotten as the calendar moves on.
# No more days than this: the cutoff must stay after 1970, which is as far back as Windows' clock goes.
storage.FORGET_VIEW_DELETIONS_DAYS = 20000
AT = "2026-10-20T10:00:00.000Z"


def tag(name, parents=(), aliases=(), at=AT):
    return {"id": name, "name": name, "parents": list(parents), "aliases": list(aliases), "updatedAt": at}


def save(**delta):
    """A save from a page that holds the library as it is now (a restore moves the epoch on)."""
    return storage.save_library({"posts": [], "deletedUrls": [], "epoch": storage.get_library(0)["epoch"], **delta})


class LibraryDocs(unittest.TestCase):
    def setUp(self):
        storage.config.DB_PATH = str(FIXTURE / f"{self._testMethodName}.sqlite")
        storage.init_db()

    def tags(self):
        return {d["id"]: d for d in storage.get_library(0)["docs"]["tags"]}

    def test_tags_are_kept_and_merged_per_tag(self):
        result = save(docs={"tags": [tag("colour-bars", ["pattern", "broadcast"], ["bars"]), tag("pattern")]})
        self.assertEqual(sorted(d["id"] for d in result["docs"]["tags"]), ["colour-bars", "pattern"], "the answer holds them")
        # Another browser's older copy doesn't win; a newer one does.
        save(docs={"tags": [tag("colour-bars", ["pattern"], [], at="2026-10-19T00:00:00.000Z")]})
        self.assertEqual(self.tags()["colour-bars"]["parents"], ["pattern", "broadcast"])
        save(docs={"tags": [tag("colour-bars", ["broadcast"], ["bars", "colorbars"], at="2026-10-21T00:00:00.000Z")]})
        self.assertEqual(self.tags()["colour-bars"]["aliases"], ["bars", "colorbars"])
        # A deletion reaches everyone, unless the tag changed after it.
        save(deletedDocs={"tags": {"pattern": "2026-10-22T00:00:00.000Z", "colour-bars": "2026-10-20T12:00:00.000Z"}})
        self.assertEqual(sorted(self.tags()), ["colour-bars"], "colour-bars changed after that deletion")
        self.assertEqual(storage.get_library(0)["deletedDocs"]["tags"], {"pattern": "2026-10-22T00:00:00.000Z"})
        save(docs={"tags": [tag("pattern", at="2026-10-21T00:00:00.000Z")]})
        self.assertNotIn("pattern", self.tags(), "an older copy doesn't bring a deleted tag back")
        self.assertEqual(save(docs={"tags": []})["docs"]["tags"][0]["id"], "colour-bars", "pages that send no tags change nothing")

    def test_a_tag_is_checked_on_the_way_in(self):
        # A tag that fails its check is left out and listed; the tags beside it still go in.
        for bad in (tag("Pattern"), {**tag("pattern"), "id": "other"}, tag("pattern", ["pattern"]), tag("pattern", ["x"] * 21),
                    tag("pat\u200btern"), tag("pattern", [], ["ba\u202ers"]), {**tag("pattern"), "colour": "red"}, tag(" "), "pattern"):
            with self.subTest(bad=json.dumps(bad)[:80]):
                result = save(docs={"tags": [bad, tag("fine")]})
                self.assertEqual([(r["kind"], r["reason"]) for r in result["rejectedDocs"]], [("tags", "invalid")])
                self.assertEqual(sorted(self.tags()), ["fine"])
        with self.assertRaises(storage.LibraryValidationError):
            save(docs={"people": []})
        with self.assertRaises(storage.LibraryValidationError):
            save(docs={"tags": {"pattern": tag("pattern")}})

    def test_change_times_and_deletion_keys_are_checked(self):
        for bad in ({**tag("pattern"), "updatedAt": "\ud800"}, {**tag("pattern"), "updatedAt": "yesterday"}):
            with self.subTest(bad=repr(bad["updatedAt"])):
                self.assertEqual(len(save(docs={"tags": [bad]})["rejectedDocs"]), 1)
                self.assertNotIn("pattern", self.tags())
        for marks in ({"pat\u200btern": AT}, {"pattern": "\ud800"}, {"": AT}):
            with self.subTest(marks=repr(marks)):
                save(docs={"tags": [tag("kept", at="2026-10-23T00:00:00.000Z")]})
                self.assertEqual(len(save(deletedDocs={"tags": {**marks, "kept": "2026-10-24T00:00:00.000Z"}})["rejectedDocs"]), 1)
                self.assertNotIn("kept", self.tags(), "the good mark beside it still applies")
        self.assertEqual(list(storage.get_library(0)["deletedDocs"]["tags"]), ["kept"], "no bad mark was kept")
        with self.assertRaises(storage.LibraryValidationError):
            save(views=[{"id": "v1", "name": "A view", "filter": {}, "updatedAt": "\ud800"}])
        # A backup carrying such a time is refused at preview, before anything is touched.
        document = library_backup.export_backup()
        document["library"]["docs"] = {"tags": [{**tag("pattern"), "updatedAt": "\ud800"}]}
        document["sha256"] = library_backup._checksum(document)
        with self.assertRaises(library_backup.BackupError):
            library_backup.validate_backup(json.dumps(document))

    def test_sqlite_never_holds_more_tags_than_a_backup_can_carry(self):
        limit = storage.DOC_LIMIT
        storage.DOC_LIMIT = 3
        try:
            save(docs={"tags": [tag("a"), tag("b")]})
            save(docs={"tags": [tag("c"), tag("d")]})
            self.assertEqual(sorted(self.tags()), ["a", "b", "c"], "full: no new ones")
            save(docs={"tags": [tag("a", ["b"], at="2026-10-21T00:00:00.000Z")]})
            self.assertEqual(self.tags()["a"]["parents"], ["b"], "changes to tags it has still go in")
            self.assertEqual(len(library_backup.export_backup()["library"]["docs"]["tags"]), 3, "and the backup can still be made")
        finally:
            storage.DOC_LIMIT = limit

    def test_creators_are_kept_checked_and_links_point_at_them(self):
        creator = {"id": "c-bakehouse1", "name": "Bakehouse Kit", "aliases": ["Kit Bakes"], "handles": [{"platform": "x", "handle": "bakehouse_kit"}],
                   "urls": ["https://x.com/bakehouse_kit"], "notes": "bakery", "picture": "/thumb/abc123", "about": "", "reviewed": False,
                   "seenAt": AT, "kept": {"name": "Bakehouse Kit 🍞"}, "updatedAt": AT}
        save(docs={"creators": [creator]})
        self.assertEqual(storage.get_library(0)["docs"]["creators"][0]["handles"], creator["handles"])
        for change in ({"id": "Bakehouse"}, {"name": "Kit‮"}, {"handles": [{"platform": "myspace", "handle": "kit"}]},
                       {"handles": [{"platform": "x", "handle": "Kit"}]}, {"urls": ["javascript:alert(1)"]}, {"picture": "https://tracker.example/p.png"},
                       {"kept": {f"k{i}": "v" for i in range(11)}}, {"seenAt": "soon"}, {"colour": "red"},
                       {"handles": [{"platform": ["x"], "handle": "kit"}]}, {"handles": [{"platform": {}, "handle": "kit"}]}, {"kept": []}):
            with self.subTest(change=repr(change)[:70]):
                result = save(docs={"creators": [{**creator, **change, "updatedAt": "2026-10-21T00:00:00.000Z"}]})
                self.assertEqual(len(result["rejectedDocs"]), 1)
                self.assertEqual(storage.get_library(0)["docs"]["creators"], [creator], "the creator SQLite has is untouched")
        link = {"id": "p1", "url": "https://x.com/bakehouse_kit/status/1", "source": "browser", "platform": "x", "domain": "x.com", "status": "inbox",
                "createdAt": AT, "updatedAt": AT, "metadataStatus": "partial", "categories": [], "tags": [], "projectIds": [], "creatorId": "c-bakehouse1"}
        self.assertEqual(save(posts=[link])["rejected"], [])
        self.assertEqual(save(posts=[{**link, "creatorId": "../x", "updatedAt": "2026-10-21T00:00:00.000Z"}])["rejected"][0]["reason"], "invalid")

    def test_one_bad_record_refuses_only_itself(self):
        """A creator SQLite refuses (a hidden character in its name) is left out; the links and other records of the
        same save go in, so a page can't lose every save to one record."""
        link = {"id": "p1", "url": "https://x.com/ana/status/1", "source": "browser", "platform": "x", "domain": "x.com", "status": "inbox",
                "createdAt": AT, "updatedAt": AT, "metadataStatus": "partial", "categories": [], "tags": [], "projectIds": []}
        result = save(posts=[link], docs={"creators": [{"id": "c-ok", "name": "Ana Field", "updatedAt": AT},
                                                       {"id": "c-bad", "name": "Bake\u200dhouse", "updatedAt": AT}],
                                          "tags": [tag("bread")]})
        self.assertEqual(result["rejected"], [])
        self.assertEqual([(r["kind"], r["id"]) for r in result["rejectedDocs"]], [("creators", "c-bad")])
        library = storage.get_library(0)
        self.assertEqual([p["id"] for p in library["posts"]], ["p1"])
        self.assertEqual([d["id"] for d in library["docs"]["creators"]], ["c-ok"])
        self.assertEqual(sorted(self.tags()), ["bread"])
        # A backup holding such a record is still refused whole, at preview.
        document = library_backup.export_backup()
        document["library"]["docs"]["creators"].append({"id": "c-bad", "name": "x", "handles": [{"platform": ["x"], "handle": "kit"}], "updatedAt": AT})
        document["sha256"] = library_backup._checksum(document)
        with self.assertRaises(library_backup.BackupError):
            library_backup.validate_backup(json.dumps(document))

    def test_removed_links_are_checked_and_sent_back_only_when_they_change(self):
        link = {"id": "p1", "url": "https://x.com/bakehouse_kit/status/1001", "source": "browser", "platform": "x", "domain": "x.com", "status": "inbox",
                "createdAt": AT, "updatedAt": AT, "metadataStatus": "partial", "categories": ["food-drink"], "tags": ["bread"], "projectIds": [],
                "userNotes": "try at 75%"}
        removed = {"id": "r-0123456789abcdef", "url": link["url"], "key": "x:1001", "how": "removed", "post": link, "removedAt": AT, "updatedAt": AT}
        first = save(docs={"removed": [removed]})
        self.assertEqual(first["docs"]["removed"], [removed])
        later = "2026-10-21T00:00:00.000Z"
        for change in ({"id": "r-xyz"}, {"post": {**link, "url": "https://example.org/other"}}, {"post": {**link, "tags": "bread"}},
                       {"key": "x 1001"}, {"how": "lost"}, {"into": "javascript:alert(1)"}, {"post": {**link, "userNotes": "x" * 30000}}, {"colour": "red"}):
            with self.subTest(change=repr(change)[:60]):
                self.assertEqual(len(save(docs={"removed": [{**removed, **change, "updatedAt": later}]})["rejectedDocs"]), 1)
        self.assertEqual(storage.get_library(0)["docs"]["removed"], [removed], "what SQLite has is untouched")
        # Removed links can be many: a change-only answer leaves them out unless they changed after it.
        rev = storage.get_library(0)["rev"]
        delta = storage.get_library(rev)
        self.assertNotIn("removed", delta["docs"])
        self.assertIn("tags", delta["docs"])
        save(deletedDocs={"removed": {removed["id"]: later}})
        self.assertEqual(storage.get_library(rev)["deletedDocs"]["removed"], {removed["id"]: later})
        self.assertEqual(storage.get_library(0)["docs"]["removed"], [], "a full read always has them")
        save(docs={"removed": [{**removed, "id": "r-00000000000000aa", "updatedAt": later}]})
        self.assertEqual(len(library_backup.export_backup()["library"]["docs"]["removed"]), 1, "and backups carry them")

    def test_too_many_deletion_marks_never_refuse_the_save(self):
        link = {"id": "p1", "url": "https://example.org/a", "source": "browser", "platform": "web", "domain": "example.org", "status": "inbox",
                "createdAt": AT, "updatedAt": AT, "metadataStatus": "partial", "categories": [], "tags": [], "projectIds": []}
        marks = {f"r-{i:016x}": f"2026-10-{1 + i % 28:02d}T00:00:00.000Z" for i in range(storage.DOC_LIMIT + 1)}
        result = save(posts=[link], deletedDocs={"removed": marks})
        self.assertEqual(result["rejected"], [])
        self.assertEqual([(r["kind"], r["reason"]) for r in result["rejectedDocs"]], [("removed", "too_many")])
        self.assertEqual([p["id"] for p in storage.get_library(0)["posts"]], ["p1"], "the link is saved")
        self.assertEqual(len(storage.get_library(0)["deletedDocs"]["removed"]), storage.DOC_LIMIT, "the newest marks are kept")

    def test_backups_carry_tags_and_restore_puts_them_back(self):
        save(posts=[{"id": "p1", "url": "https://bread.example.invalid/", "source": "browser", "platform": "web", "domain": "bread.example.invalid",
                     "status": "inbox", "createdAt": AT, "updatedAt": AT, "metadataStatus": "partial", "categories": [], "tags": ["colour-bars"],
                     "projectIds": []}],
             docs={"tags": [tag("colour-bars", ["pattern"], ["bars"])]})
        document = library_backup.export_backup()
        self.assertEqual(document["library"]["docs"]["tags"][0]["aliases"], ["bars"])
        raw = json.dumps(document)
        save(docs={"tags": [tag("colour-bars", ["broadcast"], [], at="2026-10-23T00:00:00.000Z"), tag("walks")]})
        storage.replace_library(library_backup.validate_backup(raw)["library"])
        self.assertEqual({k: v["parents"] for k, v in self.tags().items()}, {"colour-bars": ["pattern"]}, "exactly the backup's tags")
        # A backup from before tags existed keeps today's.
        old = json.loads(raw)
        old["library"].pop("docs")
        old["sha256"] = library_backup._checksum(old)
        save(docs={"tags": [tag("walks", at="2026-10-24T00:00:00.000Z")]})
        storage.replace_library(library_backup.validate_backup(json.dumps(old))["library"])
        self.assertIn("walks", self.tags())
        # A backup with the same tag twice is refused.
        twice = json.loads(raw)
        twice["library"]["docs"]["tags"] *= 2
        twice["sha256"] = library_backup._checksum(twice)
        with self.assertRaises(library_backup.BackupError):
            library_backup.validate_backup(json.dumps(twice))


if __name__ == "__main__":
    unittest.main(verbosity=1)
