"""Instagram copies made from what the bookmark button read: synthetic data only.

Run: python -B frontend/tests/instagram_backend.py
Instagram's picture hosts are pointed at the owned loopback fixture; nothing
reaches instagram.com.
"""
import json
import unittest
from unittest.mock import patch

from archive_backend import CDN, JPEG, PNG, ROOT, ArchiveCase, archive, dashboard, storage
import instagram_post
import metadata_fetcher

POST_URL = "https://www.instagram.com/p/CfixTure123/"


def data(**changes):
    value = {"caption": "Hedgerow walk <script>x()</script> #birds", "author": "Ana <b>Field</b> Notes", "handle": "fieldnotes_ana",
             "takenAt": "2026-10-04T07:52:00.000Z",
             "pictures": [f"{CDN}/v/t51/one.jpg?stp=dst-jpg", f"{CDN}/v/t51/two.jpg", "https://evil.invalid/x.jpg",
                          "javascript:alert(1)", f"{CDN}/v/t51/one.jpg?stp=dst-jpg"],
             "video": False}
    value.update(changes)
    return value


class InstagramCase(ArchiveCase):
    def setUp(self):
        super().setUp()
        for target, name, value in ((instagram_post, "_PICTURE_SUFFIXES", (".fixture.test",)),
                                    (instagram_post, "_PICTURE_SCHEMES", ("http", "https")),
                                    (metadata_fetcher, "THUMB_CACHE_DIR", str(ROOT / (self._testMethodName + "-thumbs")))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        big_jpeg = JPEG + b"\x00" * 2000      # the thumbnail cache wants more than 1000 bytes
        self.image("/v/t51/one.jpg?stp=dst-jpg", big_jpeg, "image/jpeg")
        self.image("/v/t51/two.jpg", PNG, "image/png")
        self.key = archive.copy_key(POST_URL)


class ParseTests(unittest.TestCase):
    def test_links(self):
        for url in ("https://www.instagram.com/p/CfixTure123/", "https://instagram.com/reel/Abc_-12345?igsh=x",
                    "https://www.instagram.com/fieldnotes_ana/p/CfixTure123/", "https://www.instagram.com/tv/Abcde"):
            self.assertTrue(instagram_post.post_code(url), url)
        for url in ("https://www.instagram.com/fieldnotes_ana/", "https://www.instagram.com/p/", "https://evil.com/p/CfixTure123/",
                    "https://www.instagram.com.evil.com/p/CfixTure123/", "https://www.instagram.com/stories/x/123/",
                    "https://www.instagram.com/p/../../x"):
            self.assertIsNone(instagram_post.post_code(url), url)

    def test_values_are_checked(self):
        with patch.object(instagram_post, "_PICTURE_SUFFIXES", (".fixture.test",)), \
             patch.object(instagram_post, "_PICTURE_SCHEMES", ("http", "https")):
            post, pictures, video = instagram_post.parse(POST_URL, data())
        self.assertEqual(pictures, [f"{CDN}/v/t51/one.jpg?stp=dst-jpg", f"{CDN}/v/t51/two.jpg"], "foreign, script and repeated addresses dropped")
        self.assertEqual((post.handle, post.created, post.site, post.link), ("fieldnotes_ana", "2026-10-04T07:52:00Z", "Instagram", POST_URL))
        self.assertFalse(video)
        real, pictures, _ = instagram_post.parse(POST_URL, data(pictures=["https://scontent-lhr8-1.cdninstagram.com/v/a.jpg",
                                                                         "https://instagram.fxyz1-1.fna.fbcdn.net/v/b.jpg",
                                                                         "http://scontent.cdninstagram.com/v/c.jpg"]))
        self.assertEqual(len(pictures), 2, "https only, Instagram's hosts only")
        for bad in ({"caption": 5}, {"pictures": "x"}, {"video": "yes"}, {"extra": 1}, {"pictures": ["x"] * 41}):
            with self.subTest(bad=bad), self.assertRaises(instagram_post.PostDataError):
                instagram_post.parse(POST_URL, data(**bad))
        with self.assertRaises(instagram_post.PostDataError):
            instagram_post.parse("https://example.com/p/CfixTure123/", data())
        odd, _, _ = instagram_post.parse(POST_URL, data(handle="not a handle!", takenAt="yesterday"))
        self.assertEqual((odd.handle, odd.created), ("", ""))


class SaveTests(InstagramCase):
    def test_post_with_pictures(self):
        record = archive.save_copy(POST_URL, post=data())
        self.assertEqual((record["kind"], record["images"], record["imagesLeftOut"]), ("instagram-post", 2, 0))
        self.assertEqual(record["thumbnail"], "/thumb/CfixTure123")
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn('<div class="media n2"><img alt="Photo 1" src="data:image/jpeg;base64,', document)
        self.assertIn("Ana &lt;b&gt;Field&lt;/b&gt; Notes", document)
        self.assertNotIn("<script", document)
        self.assertIn(">View on Instagram</a>", document)
        self.assertIn('href="https://www.instagram.com/p/CfixTure123/"', document)
        self.assertFalse(any("evil" in path for path in self.paths()))
        self.assertEqual(record["title"], "Ana <b>Field</b> Notes on Instagram: “Hedgerow walk <script>x()</script> #birds”")

    def test_video_posts_and_missing_pictures(self):
        record = archive.save_copy(POST_URL, post=data(video=True, pictures=[f"{CDN}/v/t51/one.jpg?stp=dst-jpg"]))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("This is a video post: its cover picture is saved. The video needs the browser extension (planned for v0.4.0).", document)
        self.assertNotIn("<video", document)
        record = archive.save_copy(POST_URL, post=data(pictures=[f"{CDN}/v/t51/gone.jpg"]))
        self.assertEqual((record["images"], record["imagesLeftOut"]), (0, 1))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("1 picture could not be fetched.", document)
        self.assertIn("No pictures came with this post.", document)
        with patch.object(archive, "FILE_LIMIT", 70 * 1024):
            record = archive.save_copy(POST_URL, post=data())
        self.assertEqual(record["images"] + record["imagesLeftOut"], 2)

    def test_without_the_button_there_is_nothing_to_save_from(self):
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(POST_URL)
        self.assertEqual(caught.exception.code, "needs_browser")
        self.assertEqual(self.paths(), [], "Instagram itself is never fetched")
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(POST_URL, post={"caption": 5})
        self.assertEqual(caught.exception.code, "invalid_post")

    def test_queue_carries_the_button_data(self):
        state = archive.request_copy(POST_URL)
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual(archive.state(self.key)["error"], "needs_browser")
        archive.request_copy(POST_URL, post=data())
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual(archive.state(self.key)["status"], "saved")
        first = (self.store / f"{self.key}.html").stat().st_mtime_ns
        # Data from the button always makes a fresh copy; a plain request does not.
        archive.request_copy(POST_URL)
        self.assertTrue(archive.wait_idle(10))
        self.assertEqual((self.store / f"{self.key}.html").stat().st_mtime_ns, first)
        archive.request_copy(POST_URL, post=data(caption="Second visit"))
        self.assertTrue(archive.wait_idle(10))
        self.assertIn("Second visit", (self.store / f"{self.key}.html").read_text())


@unittest.skipIf(dashboard is None, "Flask is not installed")
class RouteTests(InstagramCase):
    def test_route(self):
        storage.init_db()
        client = dashboard.app.test_client()
        bad = client.post("/api/archive", json={"url": POST_URL, "post": {"caption": ["x"]}})
        self.assertEqual((bad.status_code, bad.json["error"]), (400, "invalid_post"))
        foreign = client.post("/api/archive", json={"url": "https://example.com/a", "post": data()})
        self.assertEqual(foreign.status_code, 400)
        self.assertEqual(client.post("/api/archive", json={"url": POST_URL, "post": data()},
                                     headers={"Origin": "https://www.instagram.com"}).status_code, 403,
                         "Instagram's own pages cannot send it; only the app's Add window can")
        ok = client.post("/api/archive", json={"url": POST_URL, "post": data()})
        self.assertEqual(ok.status_code, 202)
        self.assertTrue(archive.wait_idle(10))
        state = client.get(f"/api/archive?keys={self.key}").json["copies"][self.key]
        self.assertEqual((state["status"], state["kind"], state["thumbnail"]), ("saved", "instagram-post", "/thumb/CfixTure123"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
