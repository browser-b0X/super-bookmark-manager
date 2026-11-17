"""The Claude Desktop extension's side of the app (v0.4.0 phase 5): a token shown once in Settings, the routes its
server reads and writes through (only with the token, never from a web page), every write recorded so the owner can
undo it, shelves made only when the owner says so, and no write on links an open tab hasn't saved yet.
Synthetic database and data folder only.

Run: python -B frontend/tests/claude_desktop_backend.py
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
FIXTURE = Path(tempfile.mkdtemp(prefix="claude-desktop-backend-"))
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(FIXTURE / "data")
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "library.sqlite")
os.environ["SBM_ARCHIVE_DIR"] = str(FIXTURE / "archive")
import storage  # noqa: E402
import app as dashboard  # noqa: E402
import archive  # noqa: E402
import claude_desktop  # noqa: E402

APP = {"Sec-Fetch-Site": "same-origin"}
AT = "2026-10-20T10:00:00.000Z"


def post(name, title, shelf=None, tags=(), created=AT):
    return {"id": f"id-{name}", "url": f"https://{name}.example.invalid/page", "source": "browser", "platform": "web",
            "domain": f"{name}.example.invalid", "status": "inbox", "createdAt": created, "updatedAt": created,
            "metadataStatus": "partial", "categories": [shelf] if shelf else [], "categoryMode": "manual", "tags": list(tags),
            "projectIds": [], "title": title}


class ClaudeDesktop(unittest.TestCase):
    def setUp(self):
        storage.config.DB_PATH = str(FIXTURE / f"{self._testMethodName}.sqlite")
        storage.init_db()
        claude_desktop._path().unlink(missing_ok=True)
        claude_desktop._presence.clear()
        self.client = dashboard.app.test_client()
        storage.save_library({"posts": [post("bread", "Slow bread: a sourdough schedule", "food-drink", ["baking"], "2026-10-21T10:00:00.000Z"),
                                        post("rye", "Rye crackers from leftover starter", created="2026-10-22T10:00:00.000Z"),
                                        post("walks", "Ten walks near the city", created="2026-10-23T10:00:00.000Z")],
                              "deletedUrls": [], "categoryOps": [{"op": "add", "name": "food-drink"}, {"op": "add", "name": "travel"}]})
        self.token = self.client.post("/api/claude-desktop/token", json={}, headers=APP).json["token"]
        self.mcp = {"X-SBM-Claude": self.token}

    def library(self):
        return {p["id"]: p for p in storage.get_library(0)["posts"]}

    def test_the_token_is_shown_once_and_only_its_fingerprint_is_kept(self):
        self.assertTrue(self.token.startswith("sbm_cd_"))
        stored = claude_desktop._path().read_text(encoding="utf-8")
        self.assertNotIn(self.token, stored)
        self.assertIn(hashlib.sha256(self.token.encode()).hexdigest(), stored)
        status = self.client.get("/api/claude-desktop", headers=APP).json
        self.assertEqual((status["connected"], status["lastUsedAt"]), (True, ""))
        self.assertNotIn("token", status)
        self.assertEqual(self.client.get("/api/mcp/shelves", headers=self.mcp).status_code, 200)
        self.assertTrue(self.client.get("/api/claude-desktop", headers=APP).json["lastUsedAt"], "noted when used")
        # A new token stops the old one; disconnecting stops any.
        newer = self.client.post("/api/claude-desktop/token", json={}, headers=APP).json["token"]
        self.assertEqual(self.client.get("/api/mcp/shelves", headers=self.mcp).status_code, 401)
        self.assertEqual(self.client.get("/api/mcp/shelves", headers={"X-SBM-Claude": newer}).status_code, 200)
        self.assertEqual(self.client.delete("/api/claude-desktop/token", headers=APP).status_code, 200)
        self.assertEqual(self.client.get("/api/mcp/shelves", headers={"X-SBM-Claude": newer}).status_code, 401)
        self.assertFalse(self.client.get("/api/claude-desktop", headers=APP).json["connected"])

    def test_web_pages_get_nothing_and_settings_is_for_the_apps_own_pages(self):
        for headers in ({"Origin": "http://evil.invalid"}, {"Origin": "http://127.0.0.1:5001"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-origin"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.get("/api/mcp/search?q=bread", headers={**self.mcp, **headers}).status_code, 403,
                                 "the extension's server is no browser: anything a browser adds is refused")
        self.assertEqual(self.client.get("/api/mcp/search?q=bread").status_code, 401)
        self.assertEqual(self.client.get("/api/mcp/search?q=bread", headers={"X-SBM-Claude": "sbm_cd_wrong"}).status_code, 401)
        for call in (lambda h: self.client.get("/api/claude-desktop", headers=h), lambda h: self.client.post("/api/claude-desktop/token", json={}, headers=h)):
            self.assertEqual(call({}).status_code, 403)
            self.assertEqual(call({"Origin": "http://evil.invalid"}).status_code, 403)
            self.assertEqual(call(self.mcp).status_code, 403, "the extension's server can't make tokens")

    def test_the_app_proves_itself_with_its_real_address(self):
        nonce = "cd" * 16
        key = hashlib.sha256(self.token.encode()).hexdigest()
        kid = hashlib.sha256(key.encode()).hexdigest()[:16]
        answer = self.client.get(f"/api/mcp/hello?nonce={nonce}&kid={kid}", headers={"Host": "127.0.0.1:5001"})
        self.assertEqual(answer.json["proof"], hmac.new(key.encode(), f"{nonce}|http://127.0.0.1:80".encode(), hashlib.sha256).hexdigest(),
                         "the socket's port (80 in the test client), not the Host header")
        self.assertEqual(self.client.get(f"/api/mcp/hello?nonce=xyz&kid={kid}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/mcp/hello?nonce={nonce}&kid={'0' * 16}").status_code, 404, "another token: told so")
        self.assertEqual(self.client.get(f"/api/mcp/hello?nonce={nonce}&kid={kid}", headers={"Sec-Fetch-Site": "cross-site"}).status_code, 403)
        self.client.delete("/api/claude-desktop/token", headers=APP)
        self.assertEqual(self.client.get(f"/api/mcp/hello?nonce={nonce}&kid={kid}").status_code, 404, "no token, nothing to prove")

    def test_reads(self):
        found = self.client.get("/api/mcp/search?q=sourdough", headers=self.mcp).json
        self.assertEqual([link["id"] for link in found["links"]], ["id-bread"])
        self.assertEqual(found["links"][0]["shelves"], ["food-drink"])
        self.assertEqual(self.client.get("/api/mcp/search?q=crackers%20rye", headers=self.mcp).json["total"], 1, "every word must match")
        self.assertEqual(self.client.get("/api/mcp/search?q=", headers=self.mcp).status_code, 400)
        shelves = {s["name"]: s for s in self.client.get("/api/mcp/shelves", headers=self.mcp).json["shelves"]}
        self.assertEqual(list(shelves), [c for c in storage.get_library(0)["categories"] if c not in storage.RESERVED_SHELVES],
                         "every shelf in the library's order; \"other\" and \"uncategorized\" aren't shelves to file on")
        self.assertEqual((shelves["food-drink"]["links"], shelves["travel"]["links"]), (1, 0))
        self.assertEqual(shelves["food-drink"]["description"], "Recipes, cooking, ingredients and coffee.", "default shelves keep their descriptions")
        unfiled = self.client.get("/api/mcp/unfiled", headers=self.mcp).json
        self.assertEqual([link["id"] for link in unfiled["links"]], ["id-walks", "id-rye"], "newest first")
        self.assertEqual(self.client.get("/api/mcp/link?id=nope", headers=self.mcp).status_code, 404)
        # A saved copy's text comes with the link.
        key = archive.copy_key("https://bread.example.invalid/page")
        os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
        Path(archive.ARCHIVE_DIR, key + ".html").write_text("<html><head><title>x</title><style>p{}</style></head><body><p>Feed the starter <b>twice</b> &amp; wait.</p><script>bad()</script></body></html>", encoding="utf-8")
        Path(archive.ARCHIVE_DIR, key + ".json").write_text(json.dumps({"url": "https://bread.example.invalid/page"}), encoding="utf-8")
        library = storage.get_library(0)
        bread = next(p for p in library["posts"] if p["id"] == "id-bread")
        storage.save_library({"posts": [{**bread, "archiveKey": key, "archiveStatus": "saved", "updatedAt": "2026-10-24T00:00:00.000Z"}],
                              "deletedUrls": [], "epoch": library["epoch"]})
        text = self.client.get("/api/mcp/link?id=id-bread", headers=self.mcp).json["link"]["copyText"]
        self.assertEqual(text, "Feed the starter twice & wait.")

    def test_filing_links_is_recorded_and_can_be_undone(self):
        before_rev = storage.get_library(0)["rev"]
        answer = self.client.post("/api/mcp/file", json={"ids": ["id-rye", "id-walks"], "shelf": "Food Drink", "tags": ["#Sourdough"]}, headers=self.mcp)
        self.assertEqual(answer.status_code, 200, answer.json)
        self.assertEqual((answer.json["filed"], answer.json["shelf"]), (2, "food-drink"))
        library = self.library()
        self.assertEqual((library["id-rye"]["categories"], library["id-rye"]["tags"]), (["food-drink"], ["sourdough"]))
        self.assertGreater(storage.get_library(0)["rev"], before_rev, "open tabs see it as a change, like any other")
        changes = self.client.get("/api/claude-desktop", headers=APP).json["changes"]
        self.assertEqual([(c["summary"], c["count"], c["undone"]) for c in changes], [("Filed 2 links on food-drink", 2, False)])
        # The owner edits one of them since: Undo leaves that one alone.
        library = storage.get_library(0)
        walks = next(p for p in library["posts"] if p["id"] == "id-walks")
        storage.save_library({"posts": [{**walks, "title": "Ten walks (mine)", "updatedAt": "2099-01-01T00:00:00.000Z"}], "deletedUrls": [], "epoch": library["epoch"]})
        undone = self.client.post("/api/claude-desktop/undo", json={"id": changes[0]["id"]}, headers=APP).json
        self.assertEqual((undone["restored"], undone["skipped"]), (1, 1))
        library = self.library()
        self.assertEqual((library["id-rye"]["categories"], library["id-rye"]["tags"]), ([], []))
        self.assertEqual(library["id-walks"]["categories"], ["food-drink"], "edited since: left as it is")
        self.assertTrue(self.client.get("/api/claude-desktop", headers=APP).json["changes"][0]["undone"])
        self.assertEqual(self.client.post("/api/claude-desktop/undo", json={"id": changes[0]["id"]}, headers=APP).status_code, 400, "once")

    def test_tabs_hear_of_changes_and_the_note_undoes_them_all(self):
        pending = lambda: self.client.post("/api/library/pending", json={"tab": "tab-1", "urls": []}, headers=APP).json
        first = pending()
        self.assertEqual((first["connected"], first["change"], first["suggestions"]), (True, None, 0))
        # rye waits in "other" (not filed yet); bread is on food-drink already.
        library = storage.get_library(0)
        rye = next(p for p in library["posts"] if p["id"] == "id-rye")
        storage.save_library({"posts": [{**rye, "categories": ["other"], "updatedAt": "2026-10-24T00:00:00.000Z"}], "deletedUrls": [], "epoch": library["epoch"]})
        self.client.post("/api/mcp/file", json={"ids": ["id-rye", "id-bread"], "shelf": "travel"}, headers=self.mcp)
        self.assertEqual(self.library()["id-rye"]["categories"], ["travel"], "out of other, as the app's own Add to shelf")
        self.assertEqual(self.library()["id-bread"]["categories"], ["food-drink", "travel"], "a link keeps its other shelves")
        self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "food-drink", "tags": ["rye"]}, headers=self.mcp)
        again = self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "food-drink", "tags": ["rye"]}, headers=self.mcp).json
        self.assertEqual((again["filed"], again["alreadyThere"]), (0, 1), "nothing to change, so no change to undo")
        heard = pending()
        self.assertNotEqual(heard["version"], first["version"], "open tabs read the library again")
        self.assertEqual((heard["change"]["summary"], heard["change"]["more"]), ("Filed 1 link on food-drink", 1))
        # The note's Undo: both changes, newest first, back to how the links were (rye was in both).
        undone = self.client.post("/api/claude-desktop/undo", json={"waiting": True, "version": heard["version"]}, headers=APP).json
        self.assertEqual((undone["restored"], undone["skipped"]), (2, 0))
        library = self.library()
        self.assertEqual((library["id-rye"]["categories"], library["id-rye"]["tags"]), (["other"], []))
        self.assertEqual(library["id-bread"]["categories"], ["food-drink"])
        self.assertIsNone(pending()["change"])
        # Keep: the note goes, and Settings can still undo the change.
        self.client.post("/api/mcp/file", json={"ids": ["id-walks"], "shelf": "travel"}, headers=self.mcp)
        self.assertEqual(self.client.post("/api/claude-desktop/keep", json={"version": pending()["version"]}, headers=APP).status_code, 200)
        self.assertIsNone(pending()["change"])
        kept = self.client.get("/api/claude-desktop", headers=APP).json["changes"][0]
        self.assertEqual((kept["summary"], kept["kept"], kept["undone"]), ("Filed 1 link on travel", True, False))
        self.assertEqual(self.client.post("/api/claude-desktop/undo", json={"id": kept["id"]}, headers=APP).json["restored"], 1)
        self.assertEqual(self.library()["id-walks"]["categories"], [])

    def test_changes_the_owner_hasnt_seen_are_never_dropped(self):
        claude_desktop.MAX_CHANGES = 3
        try:
            for i in range(3):
                answer = self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "travel" if i % 2 == 0 else "food-drink", "tags": [f"t{i}"]},
                                          headers=self.mcp)
                self.assertEqual(answer.status_code, 200, answer.json)
            full = self.client.post("/api/mcp/file", json={"ids": ["id-walks"], "shelf": "travel"}, headers=self.mcp)
            self.assertEqual(full.status_code, 409, "the owner has as many changes to look at as are kept: no more until then")
            self.assertIn("look at", full.json["error"])
            self.assertEqual(self.library()["id-walks"]["categories"], [], "nothing changed")
            # Kept changes make room; the oldest kept goes first, and a waiting one never does.
            self.client.post("/api/claude-desktop/keep", json={"version": self.watch()["version"]}, headers=APP)
            for i in range(3):
                self.assertEqual(self.client.post("/api/mcp/file", json={"ids": ["id-walks"], "shelf": "travel", "tags": [f"w{i}"]},
                                                  headers=self.mcp).status_code, 200)
            changes = self.client.get("/api/claude-desktop", headers=APP).json["changes"]
            self.assertEqual([(c["kept"], c["undone"]) for c in changes], [(False, False)] * 3, "the three waiting ones stay")
        finally:
            claude_desktop.MAX_CHANGES = 50

    def watch(self):
        return self.client.post("/api/library/pending", json={"tab": "tab-w", "urls": []}, headers=APP).json

    def test_keep_and_undo_all_cover_only_what_the_note_showed(self):
        self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "travel"}, headers=self.mcp)
        shown = self.watch()
        self.client.post("/api/mcp/file", json={"ids": ["id-walks"], "shelf": "travel"}, headers=self.mcp)   # after the note was drawn
        self.assertEqual(self.client.post("/api/claude-desktop/keep", json={"version": shown["version"]}, headers=APP).status_code, 200)
        later = self.watch()["change"]
        self.assertEqual((later["summary"], later["more"]), ("Filed 1 link on travel", 0), "the newer change still waits for the owner")
        undone = self.client.post("/api/claude-desktop/undo", json={"waiting": True, "version": shown["version"]}, headers=APP)
        self.assertEqual(undone.status_code, 400, "nothing the note showed is left to undo")
        self.client.post("/api/claude-desktop/undo", json={"waiting": True, "version": self.watch()["version"]}, headers=APP)
        library = self.library()
        self.assertEqual((library["id-rye"]["categories"], library["id-walks"]["categories"]), (["travel"], []), "kept, and undone")
        self.assertEqual(self.client.post("/api/claude-desktop/keep", json={}, headers=APP).status_code, 400, "which ones: say so")

    def test_a_save_landing_in_between_is_not_overwritten(self):
        real = claude_desktop._pending

        def tab_saves_meanwhile():
            library = storage.get_library(0)
            rye = next(p for p in library["posts"] if p["id"] == "id-rye")
            storage.save_library({"posts": [{**rye, "userNotes": "my note", "updatedAt": claude_desktop._now()}], "deletedUrls": [], "epoch": library["epoch"]})
            return real()
        claude_desktop._pending = tab_saves_meanwhile
        try:
            answer = self.client.post("/api/mcp/file", json={"ids": ["id-rye", "id-walks"], "shelf": "travel"}, headers=self.mcp)
        finally:
            claude_desktop._pending = real
        self.assertEqual((answer.json["filed"], answer.json["notFiled"]), (1, 1), answer.json)
        library = self.library()
        self.assertEqual((library["id-rye"]["userNotes"], library["id-rye"]["categories"]), ("my note", []), "the tab's save stands")
        self.assertEqual(library["id-walks"]["categories"], ["travel"])
        # Undo does the same: a link saved again meanwhile is left as it is.
        self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "travel"}, headers=self.mcp)
        change = self.client.get("/api/claude-desktop", headers=APP).json["changes"][0]
        real_posts = claude_desktop._posts

        def read_then_tab_saves():
            library = real_posts()
            rye = next(p for p in library["posts"] if p["id"] == "id-rye")
            storage.save_library({"posts": [{**rye, "userNotes": "edited again", "updatedAt": claude_desktop._now()}], "deletedUrls": [], "epoch": library["epoch"]})
            return library
        claude_desktop._posts = read_then_tab_saves
        try:
            undone = self.client.post("/api/claude-desktop/undo", json={"id": change["id"]}, headers=APP).json
        finally:
            claude_desktop._posts = real_posts
        self.assertEqual((undone["restored"], undone["skipped"]), (0, 1))
        self.assertEqual(self.library()["id-rye"]["userNotes"], "edited again")

    def test_names_and_tags_with_hidden_characters_are_refused(self):
        for bad in ("so​ur", "sour‮dough", "a\x07b"):
            with self.subTest(bad=repr(bad)):
                self.assertEqual(self.client.post("/api/mcp/suggest", json={"name": bad}, headers=self.mcp).status_code, 400)
                self.assertEqual(self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "travel", "tags": [bad]}, headers=self.mcp).status_code, 400)
        self.client.post("/api/mcp/suggest", json={"name": "Loaves", "description": "Bread‮ and \x07rolls"}, headers=self.mcp)
        self.assertEqual(self.client.get("/api/claude-desktop", headers=APP).json["suggestions"][0]["description"], "Bread and rolls")

    def test_a_hidden_tabs_report_lasts_past_a_throttled_minute(self):
        self.assertGreaterEqual(claude_desktop.PRESENCE_FOR, 90, "background tabs run their timers about once a minute")

    def test_links_the_owner_reviewed_are_left_alone(self):
        library = storage.get_library(0)
        rye = next(p for p in library["posts"] if p["id"] == "id-rye")
        storage.save_library({"posts": [{**rye, "reviewed": True, "updatedAt": "2026-10-24T00:00:00.000Z"}], "deletedUrls": [], "epoch": library["epoch"]})
        answer = self.client.post("/api/mcp/file", json={"ids": ["id-rye", "id-walks"], "shelf": "travel"}, headers=self.mcp).json
        self.assertEqual((answer["filed"], answer["reviewed"]), (1, 1))
        self.assertIn("marked Reviewed", answer["reviewedNote"])
        self.assertEqual(self.library()["id-rye"]["categories"], [], "left as it is")
        self.assertEqual(self.library()["id-walks"]["categories"], ["travel"])
        # Only a real yes or no is kept for the mark.
        library = storage.get_library(0)
        bad = storage.save_library({"posts": [{**rye, "reviewed": "yes", "updatedAt": "2026-10-25T00:00:00.000Z"}], "deletedUrls": [], "epoch": library["epoch"]})
        self.assertEqual(bad["rejected"][0]["reason"], "invalid")

    def test_no_shelf_is_invented_and_no_link_an_open_tab_hasnt_saved_is_touched(self):
        missing = self.client.post("/api/mcp/file", json={"ids": ["id-rye"], "shelf": "sourdough"}, headers=self.mcp)
        self.assertEqual(missing.status_code, 400)
        self.assertIn("no shelf called", missing.json["error"])
        self.assertEqual(self.client.post("/api/mcp/file", json={"ids": ["id-nope"], "shelf": "travel"}, headers=self.mcp).status_code, 400)
        # A tab says it hasn't saved its change to one of them yet: nothing changes.
        self.assertEqual(self.client.post("/api/library/pending", json={"tab": "tab-1", "urls": ["https://walks.example.invalid/page"]}, headers=APP).status_code, 200)
        busy = self.client.post("/api/mcp/file", json={"ids": ["id-rye", "id-walks"], "shelf": "travel"}, headers=self.mcp)
        self.assertEqual(busy.status_code, 409)
        self.assertIn("hasn't saved its changes to 1 of these links", busy.json["error"])
        self.assertEqual(self.library()["id-rye"]["categories"], [], "nothing at all was changed")
        self.client.post("/api/library/pending", json={"tab": "tab-1", "urls": []}, headers=APP)
        self.assertEqual(self.client.post("/api/mcp/file", json={"ids": ["id-rye", "id-walks"], "shelf": "travel"}, headers=self.mcp).status_code, 200)
        # A report is the app's own pages' business only.
        self.assertEqual(self.client.post("/api/library/pending", json={"tab": "t", "urls": []}, headers={"Origin": "http://evil.invalid"}).status_code, 403)

    def test_a_suggested_shelf_is_made_only_when_the_owner_says_so(self):
        answer = self.client.post("/api/mcp/suggest", json={"name": "Sourdough", "description": "Starters and loaves", "ids": ["id-rye", "id-bogus"]}, headers=self.mcp)
        self.assertEqual(answer.json["links"], 1)
        self.assertNotIn("sourdough", storage.get_library(0)["categories"], "nothing made yet")
        suggestions = self.client.get("/api/claude-desktop", headers=APP).json["suggestions"]
        self.assertEqual([(s["name"], s["count"]) for s in suggestions], [("sourdough", 1)])
        self.assertEqual(self.client.post("/api/mcp/suggest", json={"name": "travel"}, headers=self.mcp).status_code, 400, "there is one")
        made = self.client.post("/api/claude-desktop/suggestion", json={"id": suggestions[0]["id"], "create": True}, headers=APP).json
        self.assertTrue(made["made"])
        self.assertIn("sourdough", storage.get_library(0)["categories"])
        self.assertEqual(self.library()["id-rye"]["categories"], ["sourdough"])
        self.assertEqual(self.client.get("/api/claude-desktop", headers=APP).json["changes"][0]["summary"], "Made the shelf sourdough and filed 1 link on it")
        self.client.post("/api/mcp/suggest", json={"name": "Later"}, headers=self.mcp)
        later = self.client.get("/api/claude-desktop", headers=APP).json["suggestions"][0]
        self.assertFalse(self.client.post("/api/claude-desktop/suggestion", json={"id": later["id"], "create": False}, headers=APP).json["made"])
        self.assertNotIn("later", storage.get_library(0)["categories"])
        self.assertEqual(self.client.get("/api/claude-desktop", headers=APP).json["suggestions"], [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
