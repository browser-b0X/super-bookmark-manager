"""Refresh a creator from their profile page (v0.4.0 phase 6b): one page, read when the owner clicks, through the
safe fetcher (public addresses only); the name without the site's decorations, the about line, and the picture kept
in the thumbnail cache under a name made from its bytes. Only the app's own pages may ask. Stand-in pages served by
the synthetic HTTP fixture; nothing leaves the machine.

Run: python -B frontend/tests/creator_profile_backend.py
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "frontend" / "tests"))
FIXTURE = Path(tempfile.mkdtemp(prefix="creator-profile-"))
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(FIXTURE / "data")
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "library.sqlite")
os.environ["SBM_THUMB_CACHE_DIR"] = str(FIXTURE / "thumbs")
from metadata_fixture import JPEG, PUBLIC_IP, ControlledHTTP  # noqa: E402
import app as dashboard  # noqa: E402
import creator_profile  # noqa: E402
import metadata_fetcher  # noqa: E402
import storage  # noqa: E402

APP = {"Sec-Fetch-Site": "same-origin"}
PAGE = """<html><head><title>x</title>
<meta property="og:title" content="Bakehouse Kit \u202e(@bakehouse_kit) / X">
<meta property="og:description" content="Sourdough classes in Leeds.">
<meta property="og:image" content="http://profile.fixture.test/pic.jpg"></head><body></body></html>"""


class CreatorProfile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        storage.init_db()
        cls.site = ControlledHTTP().__enter__()
        cls.site.dns["profile.fixture.test"] = [PUBLIC_IP]
        cls.site.html("/bakehouse_kit", PAGE)
        cls.site.routes["/pic.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        cls.site.html("/no-picture", PAGE.replace("http://profile.fixture.test/pic.jpg", "http://profile.fixture.test/not-a-picture"))
        cls.site.routes["/not-a-picture"] = (200, {"Content-Type": "image/jpeg"}, b"<html>" * 400)
        cls.client = dashboard.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls.site.__exit__(None, None, None)

    def setUp(self):
        metadata_fetcher._recent.clear()

    def test_the_name_without_the_sites_decorations(self):
        for title, name in (("Bakehouse Kit (@bakehouse_kit) / X", "Bakehouse Kit"), ("Ana Field (@ana.field) | TikTok", "Ana Field"),
                            ("Ana (@ana) • Instagram photos and videos", "Ana"), ("Kit on Instagram: “hello”", "Kit"), ("Plain name", "Plain name")):
            self.assertEqual(creator_profile.profile_name(title), name)

    def test_one_page_read_and_the_picture_kept_here(self):
        answer = self.client.post("/api/creators/profile", json={"url": "http://profile.fixture.test/bakehouse_kit"}, headers=APP).json
        self.assertEqual((answer["ok"], answer["name"], answer["about"]), (True, "Bakehouse Kit", "Sourdough classes in Leeds."), "hidden characters gone")
        self.assertRegex(answer["picture"], r"^/thumb/[A-Za-z0-9_-]+$", "a picture the app keeps itself")
        self.assertEqual((FIXTURE / "thumbs" / answer["picture"][7:]).read_bytes(), JPEG)
        self.assertEqual(self.client.get(answer["picture"]).status_code, 200, "shown by the app itself")
        # Something that isn't a picture is left out.
        other = self.client.post("/api/creators/profile", json={"url": "http://profile.fixture.test/no-picture"}, headers=APP).json
        self.assertEqual((other["ok"], other["picture"]), (True, ""))

    def test_only_public_pages_and_only_the_apps_own_pages_may_ask(self):
        self.assertEqual(self.client.post("/api/creators/profile", json={"url": "http://profile.fixture.test/bakehouse_kit"}).status_code, 403)
        self.assertEqual(self.client.post("/api/creators/profile", json={"url": "http://profile.fixture.test/bakehouse_kit"},
                                          headers={"Origin": "http://evil.invalid"}).status_code, 403)
        for url in ("javascript:alert(1)", "file:///C:/Windows/win.ini", "http://127.0.0.1:5001/api/library", "x" * 600):
            with self.subTest(url=url[:40]):
                answer = self.client.post("/api/creators/profile", json={"url": url}, headers=APP).json
                self.assertFalse(answer["ok"])
        self.assertFalse(self.client.post("/api/creators/profile", json={"url": "http://profile.fixture.test/missing-page"}, headers=APP).json["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
