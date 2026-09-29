"""C5 fixture-only classifier/shelf contract; no provider or personal access."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(tempfile.mkdtemp(prefix="api-", dir=ROOT / ".verify/g3-c5-categorization-20260917"))
DB = FIXTURE / "fixture.sqlite"
os.environ.update(SAVED_POSTS_DB_PATH=str(DB), TELEGRAM_API_ID="0", TELEGRAM_API_HASH="", LLM_API_KEY="fixture", LITELLM_PROXY_KEY="fixture")
sys.path.insert(0, str(ROOT))
BLOCKED = []

def audit(event, args):
    if event == "sqlite3.connect" and Path(args[0]).resolve() != DB:
        BLOCKED.append("nonfixture DB"); raise AssertionError(BLOCKED[-1])
    if event == "open" and not isinstance(args[0], int):
        p = Path(os.fsdecode(args[0])).resolve()
        lower = str(p).lower().replace("\\", "/")
        if (p.name.startswith(".env") or ".session" in p.name or any(s in lower for s in ("thumb_cache", "/user data/", "/mozilla/firefox/"))
            or p.suffix in (".db", ".sqlite")) and FIXTURE not in p.parents:
            BLOCKED.append("personal path"); raise AssertionError(BLOCKED[-1])
    if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto", "subprocess.Popen"):
        BLOCKED.append("network/process"); raise AssertionError(BLOCKED[-1])
    if event == "import" and args[0].split('.')[0] in ("fetcher", "telethon"):
        raise AssertionError("live Telegram forbidden")

sys.addaudithook(audit)
import storage
import app
import categorizer
CASES = json.loads((Path(__file__).parent / "fixtures/categorization-cases.json").read_text(encoding="utf-8"))

def document(categories, **patches):
    return {"id": "fixture", "url": "https://example.invalid/fixture", "source": "browser", "platform": "web", "domain": "example.invalid",
            "status": "inbox", "createdAt": "2026-09-17", "updatedAt": "2026-09-17", "metadataStatus": "partial",
            "categories": categories, "tags": ["MixedCase"], "projectIds": [], "userNotes": "Keep this", **patches}

class C5(unittest.TestCase):
    def setUp(self):
        global DB
        DB = FIXTURE / (self._testMethodName + ".sqlite")
        storage.config.DB_PATH = str(DB)
        storage.init_db()
        self.client = app.app.test_client()

    def tearDown(self):
        self.assertEqual(BLOCKED, [])

    def test_keywords_only_all_eight_never_calls_providers(self):
        with patch.object(categorizer, "proxy_available", side_effect=AssertionError("model probe")), patch.object(categorizer, "_get_client", side_effect=AssertionError("model client")), patch.object(app.metadata_fetcher, "fetch_metadata", side_effect=AssertionError("metadata")):
            before = storage.get_categories()
            for case in CASES:
                with self.subTest(item=case["item"]):
                    result = self.client.post('/api/categorize', json={"content": case["content"], "keywords_only": True})
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.json["category_name"], case["expected"])
                    self.assertEqual(result.json["engine"], "keywords")
            self.assertEqual(storage.get_categories(), before)

    def test_existing_model_chain_unavailable_and_unknown_result(self):
        with patch.object(categorizer, "proxy_available", return_value=True), patch.object(categorizer, "auto_categorize_post", return_value=None), patch.object(categorizer, "_get_client", return_value=None):
            self.assertEqual(categorizer.categorize_content("Cooking recipes")["category_name"], "food-drink")
        result = categorizer._validate_result({"category_name": "invented-zzzz-shelf", "suggested_tags": [], "reasoning": "fixture"}, storage.get_categories())
        self.assertIn(result["category_name"], storage.get_categories())

    def test_fresh_and_category_write_bounds(self):
        self.assertEqual(len(set(storage.get_categories()) - storage.RESERVED_SHELVES), 9)
        for i in range(3): self.assertTrue(storage.add_category(f"fixture-{i}"))
        before = storage.get_categories()
        response = self.client.post('/api/categories', json={"name": "thirteenth"})
        self.assertEqual(response.status_code, 409)
        self.assertIn("12", response.json["error"])
        self.assertFalse(storage.rename_category("other", "thirteenth"))
        storage.delete_category("other")
        self.assertEqual(storage.get_categories(), before)

    def test_library_category_growth_is_atomic_and_automatic_reuse_only(self):
        self.assertEqual(self.client.post('/api/library', json={"posts": [document(["other"], categoryMode="manual")], "deletedUrls": []}).status_code, 200)
        before = storage.get_library()
        too_many = document(["new-1", "new-2", "new-3", "new-4"], categoryMode="manual")
        self.assertEqual(self.client.post('/api/library', json={"posts": [too_many], "deletedUrls": []}).status_code, 400)
        self.assertEqual(storage.get_library(), before)
        invented = document(["model-invention"], categoryMode="automatic")
        self.assertEqual(self.client.post('/api/library', json={"posts": [invented], "deletedUrls": []}).status_code, 400)
        self.assertEqual(storage.get_library(), before)
        valid = document(["technology"], categoryMode="automatic", categoryReview=False)
        self.assertEqual(self.client.post('/api/library', json={"posts": [valid], "deletedUrls": []}).status_code, 200)
        storage.init_db()
        self.assertEqual(storage.get_library()["posts"], [valid])

    def test_existing_oversize_fixture_taxonomy_untouched(self):
        conn = storage._connect()
        with conn:
            for i in range(5): conn.execute("INSERT INTO categories VALUES (?, ?, ?)", (f"existing-{i}", 100+i, "fixture"))
        conn.close()
        before = storage.get_categories()
        storage.init_db()
        self.assertEqual(storage.get_categories(), before)
        with self.assertRaises(storage.LibraryValidationError): storage.add_category("another")
        self.assertEqual(storage.get_categories(), before)

if __name__ == '__main__':
    print("Synthetic C5 fixture:", FIXTURE, flush=True)
    unittest.main(verbosity=2)
