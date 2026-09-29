"""C4 backend contract tests. Synthetic SQLite only; no server or providers.

Run with the existing Flask PYTHONPATH and bundled Python, using -B.
Each run retains its new fixture directory under workspace/.verify for evidence.
"""

import importlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[2]
VERIFY = WORKSPACE / ".verify"
if not VERIFY.is_dir():
    raise RuntimeError("Create the authorized workspace .verify directory first")
FIXTURE = Path(tempfile.mkdtemp(prefix="c4-library-api-", dir=VERIFY))
DB = FIXTURE / "fixture.sqlite"
os.environ["SAVED_POSTS_DB_PATH"] = str(DB)
sys.dont_write_bytecode = True
sys.path.insert(0, str(WORKSPACE))
BLOCKED = []


def normalized(path):
    return os.path.normcase(os.path.abspath(os.fsdecode(path)))


def audit(event, args):
    reason = None
    if event == "sqlite3.connect" and normalized(args[0]) != normalized(DB):
        reason = "nonfixture SQLite connection"
    elif event == "open" and not isinstance(args[0], int):
        path = normalized(args[0]).replace("\\", "/").lower()
        name = path.rsplit("/", 1)[-1]
        fixture_path = normalized(FIXTURE).replace("\\", "/").lower() + "/"
        sensitive = (
            name.startswith(".env") or ".session" in name
            or "/thumb_cache/" in path or "/thumb_cache" == path[-12:]
            or "/mozilla/firefox/" in path or "/user data/" in path
            or any(suffix in name for suffix in (".db", ".sqlite"))
        )
        if sensitive and not path.startswith(fixture_path):
            reason = "personal database/session/env/browser/thumbnail open"
    elif event in ("socket.connect", "socket.getaddrinfo", "socket.sendto", "subprocess.Popen"):
        reason = "network/provider/process access"
    elif event == "import" and args[0].split(".")[0] in ("categorizer", "fetcher", "telethon"):
        reason = "provider/session import"
    if reason:
        BLOCKED.append(reason)
        raise RuntimeError("C4 isolation guard: " + reason)


sys.addaudithook(audit)
import storage  # noqa: E402 -- isolation must precede imports
import app as dashboard  # noqa: E402


def post(number=1, **changes):
    result = {
        "id": f"fixture-{number}",
        "url": f"https://example.invalid/item/{number}?q=1&q=2#part",
        "canonicalUrl": f"https://example.invalid/item/{number}?q=1&q=2#part",
        "source": "browser", "sourceMessageId": "97001",
        "telegramMessage": {"id": "97001", "date": "2026-09-17T12:00:00", "text": "Full synthetic message\nSecond line"},
        "platform": "web", "title": "Curated title", "description": "Description",
        "excerpt": "Original text", "thumbnailUrl": "/thumb/fixture",
        "domain": "example.invalid", "mediaType": "article",
        "categories": ["other"], "tags": ["MixedCase"], "projectIds": ["project-fixture"],
        "status": "archived", "favorite": True, "pinned": True,
        "userNotes": "Distinct note\nUnicode: caf\u00e9", "aiSummary": "Retained summary",
        "createdAt": "2026-09-16T12:00:00Z", "updatedAt": "2026-09-17T12:00:00Z",
        "lastOpenedAt": "2026-09-17T12:01:00Z", "metadataStatus": "partial", "metadataError": "offline",
    }
    result.update(changes)
    return result


class LibraryApiTests(unittest.TestCase):
    def setUp(self):
        # Every test gets a newly initialized synthetic DB; never clear a personal DB.
        global DB
        DB = FIXTURE / (self._testMethodName + ".sqlite")
        os.environ["SAVED_POSTS_DB_PATH"] = str(DB)
        storage.config.DB_PATH = str(DB)
        storage.init_db()
        self.client = dashboard.app.test_client()
        self.guard_start = len(BLOCKED)
        self.provider = patch.object(dashboard.metadata_fetcher, "fetch_metadata", side_effect=AssertionError("provider called"))
        self.provider.start()
        self.addCleanup(self.provider.stop)

    def tearDown(self):
        self.assertEqual(BLOCKED[self.guard_start:], [], "Application attempted guarded access")

    def get(self):
        response = self.client.get("/api/library")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/json")
        return response.get_json()

    def save(self, posts=None, deleted=None, expected=200):
        response = self.client.post("/api/library", json={"posts": posts or [], "deletedUrls": deleted or []})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "application/json")
        result = response.get_json()
        self.assertEqual(result["ok"], expected == 200)
        if expected != 200:
            self.assertTrue(result["error"])
        return result

    def rows(self, sql, params=()):
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in conn.execute(sql, params)]
        finally:
            conn.close()

    def test_00_empty_api_contract(self):
        self.assertEqual(self.get(), {"posts": [], "deletedUrls": [], "legacyRows": []})
        self.assertEqual(self.save(), {"ok": True, "posts": [], "deletedUrls": [], "legacyRows": []})

    def test_full_payload_survives_update_reinit_and_module_reload(self):
        first, second = post(), post(2, source="telegram", userNotes="Second note", status="reference")
        self.assertEqual(self.save([first, second])["posts"], [first, second])
        updated = {**first, "userNotes": "Edited note", "categories": ["technology"], "favorite": False}
        self.save([updated])
        storage.init_db()
        importlib.reload(storage)
        self.assertEqual(self.get()["posts"], [updated, second])
        stored = self.rows("SELECT document FROM library_items WHERE url = ?", (first["url"],))
        self.assertEqual(json.loads(stored[0]["document"]), updated)

    def test_no_silent_limit_and_exact_query_fragment_identity(self):
        posts = [post(i) for i in range(205)]
        posts.extend([post(205, url=posts[0]["url"] + "-different"), post(206, url=posts[0]["url"].replace("q=1", "q=3"))])
        self.assertEqual(len(self.save(posts)["posts"]), 207)
        self.assertEqual({p["url"] for p in self.get()["posts"]}, {p["url"] for p in posts})

    def test_same_url_different_id_keeps_entire_curation(self):
        original = post()
        self.save([original])
        candidate = post(id="reimport-id", categories=["uncategorized"], userNotes="", favorite=False, title="Reimport title")
        self.assertEqual(self.save([candidate])["posts"], [original])
        self.assertEqual(self.get()["posts"], [original])

    def test_id_collision_rolls_back_whole_transaction(self):
        original = post()
        self.save([original])
        before = self.get()
        self.save([post(2), post(3, id=original["id"])], ["https://example.invalid/never-seen"], expected=409)
        self.assertEqual(self.get(), before)
        # Conflict also applies when the incoming URL already exists with another ID.
        self.save([post(2)])
        before = self.get()
        self.save([post(2, id=original["id"])], expected=409)
        self.assertEqual(self.get(), before)

    def test_batch_id_collision_is_not_silent_loss(self):
        self.save([post(), post(2, id=post()["id"])], expected=409)
        self.assertEqual(self.get()["posts"], [])

    def test_tombstones_win_and_reserve_existing_identity(self):
        original = post()
        never = "https://example.invalid/never-seen#full"
        self.save([original])
        result = self.save([post(userNotes="must not revive"), post(2, url=never)], [original["url"], never])
        self.assertEqual(result["posts"], [])
        self.assertEqual(set(result["deletedUrls"]), {original["url"], never})
        tombstones = {row["url"]: row for row in self.rows("SELECT * FROM library_items")}
        self.assertEqual(tombstones[original["url"]]["id"], original["id"])
        self.assertIsNone(tombstones[original["url"]]["document"])
        self.assertIsNone(tombstones[never]["id"])
        self.assertEqual(tombstones[never]["deleted"], 1)
        self.save([post(id="different-reimport-id"), post(2, url=never)])
        storage.init_db()
        self.assertEqual(self.get()["posts"], [])
        self.save([post(3, id=original["id"])], expected=409)

    def test_invalid_entire_batch_has_no_mutation(self):
        self.save([post()])
        before = self.get()
        invalid = [None, [], {}, {"posts": []}, {"posts": {}, "deletedUrls": []}, {"posts": [], "deletedUrls": [None]}]
        required = ["id", "url", "source", "platform", "domain", "categories", "tags", "projectIds", "status", "createdAt", "updatedAt", "metadataStatus"]
        for key in required:
            item = post(3)
            del item[key]
            invalid.append({"posts": [post(2), item], "deletedUrls": [post()["url"]]})
        bad_fields = {
            "id": [None, 9, ""], "url": [None, "file:///x", "javascript:alert(1)", "https://", "https://[broken", "https://example.invalid:bad", "https://example.invalid/\npath"],
            "source": ["unknown", []], "platform": ["unknown", {}], "domain": [False],
            "categories": ["other", [None]], "tags": [[1]], "projectIds": [None],
            "status": ["unknown"], "metadataStatus": ["unknown"], "mediaType": ["unknown", None],
            "favorite": [1, "true", None], "pinned": [0], "createdAt": [0], "updatedAt": [None],
            "telegramMessage": [None, [], {}, {"text": 1}, {"text": "ok", "id": 1}, {"text": "ok", "date": None}],
        }
        for key in ["canonicalUrl", "sourceMessageId", "title", "description", "excerpt", "thumbnailUrl", "userNotes", "aiSummary", "lastOpenedAt", "metadataError"]:
            bad_fields[key] = [None, 1]
        for key, values in bad_fields.items():
            for value in values:
                invalid.append({"posts": [post(2), post(3, **{key: value})], "deletedUrls": [post()["url"]]})
        invalid.extend({"posts": [post(2)], "deletedUrls": [value]} for value in [1, "ftp://example.invalid/x", "http://", "https://[broken"])
        for body in invalid:
            with self.subTest(body=body):
                response = self.client.post("/api/library", data=json.dumps(body), content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.get_json()["ok"])
                self.assertTrue(response.get_json()["error"])
                self.assertEqual(self.get(), before)
        for raw in ("", "{", "null", '{"posts":[NaN],"deletedUrls":[]}'):
            with self.subTest(raw=raw):
                response = self.client.post("/api/library", data=raw, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.get(), before)

    def test_optional_fields_may_be_absent(self):
        item = post()
        for key in ["canonicalUrl", "sourceMessageId", "telegramMessage", "title", "description", "excerpt", "thumbnailUrl", "mediaType", "favorite", "pinned", "userNotes", "aiSummary", "lastOpenedAt", "metadataError"]:
            del item[key]
        self.assertEqual(self.save([item])["posts"], [item])

    def test_legacy_rows_untouched_and_only_unadopted_exposed(self):
        urls = [post()["url"], "https://example.invalid/legacy#keep", None, "javascript:alert(1)", "https://[broken"]
        for index, url in enumerate(urls):
            storage.insert_post(98000 + index, "2026-09-17T12:00:00Z", "Legacy text", url, "other", '{"fixture":true}')
        before = self.rows("SELECT * FROM saved_posts ORDER BY id")
        schema = self.rows("SELECT name, sql FROM sqlite_master WHERE name != 'library_items' ORDER BY name")
        self.assertEqual(self.get()["legacyRows"], before[:2])
        self.save([post()])
        self.assertEqual(self.get()["legacyRows"], before[1:2])
        self.save(deleted=[urls[1]])
        self.assertEqual(self.get()["legacyRows"], [])
        storage.init_db()
        self.assertEqual(self.rows("SELECT * FROM saved_posts ORDER BY id"), before)
        self.assertEqual(self.rows("SELECT name, sql FROM sqlite_master WHERE name != 'library_items' ORDER BY name"), schema)
        self.assertTrue(storage.post_exists(98000))
        self.assertEqual(len(storage.search_posts()), 5)

    def test_real_sqlite_abort_returns_503_and_rolls_back(self):
        original = post()
        self.save([original])
        before = self.get()
        conn = sqlite3.connect(DB)
        try:
            # A trigger in this disposable DB fires on the API's own connection.
            conn.execute("CREATE TRIGGER fixture_write_failure BEFORE INSERT ON library_items WHEN NEW.id = 'fixture-3' BEGIN SELECT RAISE(ABORT, 'synthetic write unavailable'); END")
            conn.commit()
        finally:
            conn.close()
        self.save([post(2), post(3)], [original["url"]], expected=503)
        self.assertEqual(self.get(), before)

    def test_connection_failure_returns_readable_json(self):
        with patch.object(storage, "_connect", side_effect=sqlite3.OperationalError("synthetic unavailable")):
            self.save([post()], expected=503)
            response = self.client.get("/api/library")
            self.assertEqual(response.status_code, 503)
            self.assertTrue(response.get_json()["error"])
        self.assertEqual(self.get()["posts"], [])

    def test_json_only_same_origin_no_cors(self):
        for method in ("get", "post"):
            for origin in ("https://external.invalid", "null", "http://localhost:9999", "http://localhost.evil.invalid"):
                response = getattr(self.client, method)("/api/library", headers={"Origin": origin}, json={"posts": [post()], "deletedUrls": []})
                self.assertEqual(response.status_code, 403)
                self.assertFalse(response.get_json()["ok"])
                self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "application/vnd.fixture+json"):
            response = self.client.post("/api/library", data=json.dumps({"posts": [post()], "deletedUrls": []}), content_type=content_type)
            self.assertEqual(response.status_code, 415)
            self.assertTrue(response.get_json()["error"])
        response = self.client.post("/api/library", json={"posts": [post()], "deletedUrls": []}, headers={"Origin": "http://localhost"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        self.assertEqual(self.get()["posts"], [post()])

    def test_origin_default_port_is_not_explicit_zero(self):
        self.assertEqual(self.client.get("/api/library", headers={"Origin": "http://localhost:80"}).status_code, 200)
        for origin in ("http://localhost:0", " http://localhost", "http://[broken"):
            with self.subTest(origin=origin):
                response = self.client.get("/api/library", headers={"Origin": origin})
                self.assertEqual(response.status_code, 403)
                self.assertTrue(response.get_json()["error"])


if __name__ == "__main__":
    print("Synthetic fixture directory:", FIXTURE, flush=True)
    print("Audit guards installed before app/storage imports; no HTTP server.", flush=True)
    unittest.main(verbosity=2)
