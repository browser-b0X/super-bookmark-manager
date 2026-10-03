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
        snapshot = self.get()
        self.assertEqual({k: snapshot[k] for k in ("posts", "deletedUrls", "legacyRows")}, {"posts": [], "deletedUrls": [], "legacyRows": []})
        self.assertIn("other", snapshot["categories"])
        saved = self.save()
        self.assertEqual({k: saved[k] for k in ("ok", "posts", "deletedUrls", "legacyRows", "rejected")},
                         {"ok": True, "posts": [], "deletedUrls": [], "legacyRows": [], "rejected": []})

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
        result = self.save([candidate])
        self.assertEqual(result["posts"], [original])
        self.assertEqual([r["reason"] for r in result["rejected"]], ["duplicate_url"])
        self.assertEqual(self.get()["posts"], [original])

    def test_id_collision_rejects_only_that_item(self):
        original = post()
        self.save([original])
        result = self.save([post(2), post(3, id=original["id"])], ["https://example.invalid/never-seen"])
        # One colliding item never blocks the rest of the delta.
        self.assertEqual([p["id"] for p in result["posts"]], [original["id"], "fixture-2"])
        self.assertEqual(result["rejected"], [{"url": post(3)["url"], "id": original["id"], "reason": "id_conflict",
                                               "error": "This ID already belongs to a different link."}])
        self.assertIn("https://example.invalid/never-seen", result["deletedUrls"])
        before = self.get()
        result = self.save([post(2, id=original["id"])])
        self.assertEqual(result["rejected"][0]["reason"], "id_conflict")
        self.assertEqual(self.get(), before)

    def test_batch_id_collision_is_not_silent_loss(self):
        result = self.save([post(), post(2, id=post()["id"])])
        self.assertEqual(result["posts"], [post()])
        self.assertEqual([(r["url"], r["reason"]) for r in result["rejected"]], [(post(2)["url"], "id_conflict")])

    def test_tombstones_win_and_reserve_existing_identity(self):
        original = post()
        never = "https://example.invalid/never-seen#full"
        self.save([original])
        result = self.save([post(userNotes="must not revive"), post(2, url=never)], [original["url"], never])
        self.assertEqual(result["posts"], [])
        self.assertEqual(set(result["deletedUrls"]), {original["url"], never})
        tombstones = {row["url"]: row for row in self.rows("SELECT * FROM library_items")}
        # A tombstone keeps the URL but releases the ID, so a variant spelling
        # that maps to the same client ID can still be saved later.
        self.assertIsNone(tombstones[original["url"]]["id"])
        self.assertIsNone(tombstones[original["url"]]["document"])
        self.assertIsNone(tombstones[never]["id"])
        self.assertEqual(tombstones[never]["deleted"], 1)
        result = self.save([post(id="different-reimport-id"), post(2, url=never)])
        self.assertEqual({r["reason"] for r in result["rejected"]}, {"deleted"})
        storage.init_db()
        self.assertEqual(self.get()["posts"], [])
        self.assertEqual(self.save([post(3, id=original["id"])])["posts"], [post(3, id=original["id"])])

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
        invalid_items = []
        for key, values in bad_fields.items():
            for value in values:
                invalid_items.append(post(3, **{key: value}))
        for key in required:
            item = post(3)
            del item[key]
            invalid_items.append(item)
        invalid = [body for body in invalid if not (isinstance(body, dict) and len(body.get("posts", [])) == 2)]
        invalid.extend({"posts": [post(2)], "deletedUrls": [value]} for value in [1, "ftp://example.invalid/x", "http://", "https://[broken"])
        invalid.extend({"posts": [], "deletedUrls": [], "categoryOps": value} for value in [{}, [{"op": "explode"}], [{"op": "rename", "from": "a"}]])
        for item in invalid_items:
            with self.subTest(item=item):
                # A malformed item is rejected alone; the rest of the delta commits.
                result = self.save([item])
                self.assertEqual([r["reason"] for r in result["rejected"]], ["invalid"])
                self.assertTrue(result["rejected"][0]["error"])
                self.assertEqual(self.get(), before)
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
        schema = self.rows("SELECT name, sql FROM sqlite_master WHERE name NOT IN ('library_items', 'idx_library_ident') ORDER BY name")
        self.assertEqual(self.get()["legacyRows"], before[:2])
        self.save([post()])
        self.assertEqual(self.get()["legacyRows"], before[1:2])
        self.save(deleted=[urls[1]])
        self.assertEqual(self.get()["legacyRows"], [])
        storage.init_db()
        self.assertEqual(self.rows("SELECT * FROM saved_posts ORDER BY id"), before)
        self.assertEqual(self.rows("SELECT name, sql FROM sqlite_master WHERE name NOT IN ('library_items', 'idx_library_ident') ORDER BY name"), schema)
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

    # ── Audit fixes: one URL identity, recoverable sync, shelf ops, host guard ──

    def test_delete_matches_any_spelling_and_backup_export_still_works(self):
        raw = post(url="https://Example.invalid", canonicalUrl="https://example.invalid")
        self.save([raw])
        # The browser sends new URL(u).href, which differs from the stored string.
        result = self.save(deleted=["https://example.invalid/"])
        self.assertEqual(result["posts"], [])
        self.assertEqual(len(self.rows("SELECT * FROM library_items")), 1)
        response = self.client.post("/api/backup/export", json={"confirm": True})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

    def test_readd_variant_after_delete_is_not_wedged(self):
        first = post(url="https://www.example.invalid/page/", id="same-client-id")
        self.save([first])
        self.save(deleted=[first["url"]])
        variant = post(url="https://www.example.invalid/page", id="same-client-id")
        unrelated = post(9)
        result = self.save([variant, unrelated])
        # The tombstone owns the URL spelling, not the ID: both items save.
        self.assertEqual(sorted(p["id"] for p in result["posts"]), ["fixture-9", "same-client-id"])
        self.assertEqual(result["rejected"], [])

    def test_undelete_clears_tombstone_for_explicit_readd(self):
        original = post()
        self.save([original])
        self.save(deleted=[original["url"]])
        self.assertEqual(self.save([original])["rejected"][0]["reason"], "deleted")
        response = self.client.post("/api/library", json={"posts": [original], "deletedUrls": [], "undeleteUrls": [original["url"]]})
        self.assertEqual(response.get_json()["posts"], [original])
        self.assertEqual(response.get_json()["deletedUrls"], [])

    def test_purge_removes_without_tombstone_so_reimport_works(self):
        original = post()
        self.save([original])
        response = self.client.post("/api/library", json={"posts": [], "deletedUrls": [], "purgeUrls": [original["url"]]})
        self.assertEqual(response.get_json()["posts"], [])
        self.assertEqual(response.get_json()["deletedUrls"], [])
        self.assertEqual(self.save([original])["posts"], [original])

    def test_delta_sync_returns_only_changes_after_a_revision(self):
        first, second = post(), post(2)
        rev = self.save([first, second])["rev"]
        self.assertGreater(rev, 0)
        edited = post(2, userNotes="changed", updatedAt="2026-09-18T00:00:00Z")
        response = self.client.post("/api/library", json={"posts": [edited], "deletedUrls": [first["url"]], "since": rev}).get_json()
        self.assertEqual(response["posts"], [edited])
        self.assertEqual(response["deletedUrls"], [first["url"]])
        self.assertEqual(response["since"], rev)
        later = response["rev"]
        self.assertEqual(self.client.get(f"/api/library?since={later}").get_json()["posts"], [])
        purge = self.client.post("/api/library", json={"posts": [], "deletedUrls": [], "purgeUrls": [edited["url"]], "since": later}).get_json()
        self.assertEqual(purge["purgedUrls"], [edited["url"]])
        # Counter never goes backwards even when the newest row disappears.
        self.assertGreater(purge["rev"], later)
        # A revision from another database (larger than ours) yields a full snapshot.
        full = self.client.get("/api/library?since=999999").get_json()
        self.assertNotIn("since", full)

    def test_stale_write_is_rejected_not_applied(self):
        newer = post(userNotes="Tab A note", updatedAt="2026-09-18T12:00:00Z")
        self.save([newer])
        stale = post(favorite=False, userNotes="", updatedAt="2026-09-17T12:00:00Z")
        result = self.save([stale])
        self.assertEqual(result["rejected"][0]["reason"], "stale")
        self.assertEqual(self.get()["posts"], [newer])

    def test_category_ops_rename_and_delete_keep_server_in_step(self):
        self.save([post(categories=["travel"], categoryMode="manual")])
        response = self.client.post("/api/library", json={
            "posts": [post(categories=["trips"], categoryMode="manual", updatedAt="2026-09-18T00:00:00Z")],
            "deletedUrls": [], "categoryOps": [{"op": "rename", "from": "travel", "to": "trips"}]})
        body = response.get_json()
        self.assertEqual(body["rejected"], [])
        self.assertIn("trips", body["categories"])
        self.assertNotIn("travel", body["categories"])
        # Renaming then adding up to the cap never wedges later saves.
        names = [f"shelf-{i}" for i in range(3)]
        ops = [{"op": "add", "name": n} for n in names]
        body = self.client.post("/api/library", json={"posts": [], "deletedUrls": [], "categoryOps": ops}).get_json()
        self.assertEqual(len([c for c in body["categories"] if c not in ("other", "uncategorized")]), 12)
        filed = post(2, categories=["shelf-2"], categoryMode="manual")
        self.assertEqual(self.save([filed])["rejected"], [])
        body = self.client.post("/api/library", json={"posts": [], "deletedUrls": [], "categoryOps": [{"op": "delete", "name": "shelf-0"}]}).get_json()
        self.assertNotIn("shelf-0", body["categories"])
        over = post(3, categories=["thirteenth", "fourteenth"], categoryMode="manual")
        self.assertEqual(self.save([over])["rejected"][0]["reason"], "shelf_limit")

    def test_adopted_legacy_rows_stop_blocking_export(self):
        storage.insert_post(99001, "2026-09-17T12:00:00Z", "dup", "https://www.example.invalid/watch?v=1&si=a", "other", "{}")
        self.assertEqual(len(self.get()["legacyRows"]), 1)
        self.assertEqual(self.client.post("/api/backup/export", json={"confirm": True}).status_code, 400)
        response = self.client.post("/api/library", json={"posts": [], "deletedUrls": [],
                                                          "adoptedUrls": ["https://www.example.invalid/watch?v=1&si=a"]})
        self.assertEqual(response.get_json()["legacyRows"], [])
        self.assertEqual(self.client.post("/api/backup/export", json={"confirm": True}).status_code, 200)

    def test_init_repairs_rows_written_before_identity_matching(self):
        conn = sqlite3.connect(DB)
        try:
            with conn:
                conn.execute("INSERT INTO library_items (url, id, document) VALUES (?, ?, ?)",
                             ("https://example.invalid", "live", json.dumps(post(url="https://example.invalid", id="live"))))
                conn.execute("INSERT INTO library_items (url, id, deleted) VALUES (?, ?, 1)", ("https://example.invalid/", "kept-id"))
                conn.execute("INSERT INTO library_items (url, id, document) VALUES (?, ?, ?)",
                             ("https://Twin.invalid/a", "old", json.dumps(post(url="https://Twin.invalid/a", id="old", updatedAt="2026-01-01T00:00:00Z", tags=["older"], userNotes="old note", favorite=True))))
                conn.execute("INSERT INTO library_items (url, id, document) VALUES (?, ?, ?)",
                             ("https://twin.invalid/a", "new", json.dumps(post(url="https://twin.invalid/a", id="new", updatedAt="2026-02-01T00:00:00Z", tags=["newer"], userNotes="", favorite=False))))
                conn.execute("UPDATE library_items SET ident = NULL")
        finally:
            conn.close()
        storage.init_db()
        snapshot = self.get()
        self.assertEqual([p["id"] for p in snapshot["posts"]], ["new"])
        # The removed twin's curation is folded into the survivor, never dropped.
        survivor = snapshot["posts"][0]
        self.assertEqual((survivor["tags"], survivor["userNotes"], survivor["favorite"]), (["newer", "older"], "old note", True))
        self.assertEqual(len(snapshot["deletedUrls"]), 1)
        self.assertEqual(self.rows("SELECT id FROM library_items WHERE deleted = 1"), [{"id": None}])
        self.assertEqual(self.client.post("/api/backup/export", json={"confirm": True}).status_code, 200)

    def test_dns_rebinding_host_is_refused(self):
        rebound = {"Host": "evil.invalid:5001", "Origin": "http://evil.invalid:5001", "Sec-Fetch-Site": "same-origin"}
        for method, path in (("get", "/api/library"), ("post", "/api/telegram/refresh"), ("post", "/api/backup/export"), ("get", "/api/telegram/auth")):
            with self.subTest(path=path):
                response = getattr(self.client, method)(path, headers=rebound, json={"confirm": True})
                self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get("/api/library", headers={"Host": "127.0.0.1:5001"}).status_code, 200)

    def test_cross_site_form_post_cannot_trigger_mutations(self):
        for path in ("/api/categorize/unprocessed", "/api/refresh-instagram-thumbs", "/api/edit", "/api/tasks"):
            with self.subTest(path=path):
                response = self.client.post(path, data='{"untagged": true}', content_type="text/plain")
                self.assertEqual(response.status_code, 415)
                response = self.client.post(path, json={}, headers={"Origin": "https://evil.invalid"})
                self.assertEqual(response.status_code, 403)
                response = self.client.post(path, json={}, headers={"Sec-Fetch-Site": "cross-site"})
                self.assertEqual(response.status_code, 403)

    def test_legacy_routes_reject_non_object_bodies_with_400(self):
        for path, body in (("/api/reclassify", []), ("/api/reclassify", {"tg_msg_id": "abc"}), ("/api/edit", None),
                           ("/api/delete", {"tg_msg_id": {}}), ("/api/tasks", ["x"]), ("/api/categories", {"name": 5})):
            with self.subTest(path=path, body=body):
                response = self.client.post(path, data=json.dumps(body), content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.get_json()["ok"])
        tid = self.client.post("/api/tasks", json={"title": "t"}).get_json()["id"]
        self.assertEqual(self.client.patch(f"/api/tasks/{tid}", json={"done": "no"}).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/tasks/{tid}", json={"title": None}).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/tasks/{tid}", json={"done": True}).status_code, 200)


if __name__ == "__main__":
    print("Synthetic fixture directory:", FIXTURE, flush=True)
    print("Audit guards installed before app/storage imports; no HTTP server.", flush=True)
    unittest.main(verbosity=2)
