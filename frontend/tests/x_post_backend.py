"""Saved copies of X posts: synthetic embed data on the owned loopback server only.

Run: python -B frontend/tests/x_post_backend.py
X's embed address and media hosts are pointed at the fixture hosts; nothing
reaches x.com or twimg.com. Reuses archive_backend's isolation and helpers.
"""
import io
import json
import re
import unittest
import zipfile
from unittest.mock import patch

from archive_backend import (BASE_URL, CDN, GIF, JPEG, PNG, ROOT, ArchiveCase, archive, dashboard, saved_post,
                             storage)
import x_post

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"synthetic-mp4" * 200
POST_URL = "https://x.com/fixture_user/status/1800000000000000001"
POST_ID = "1800000000000000001"


def embed(**changes):
    """X's embed JSON for a post with two photos, a video and a quoted post."""
    data = {
        "__typename": "Tweet", "id_str": POST_ID, "lang": "en", "created_at": "2026-10-01T14:05:09.000Z",
        "text": "@someone_else Two photos <script>alert(1)</script> & a clip. Read https://t.co/AbCd123 https://t.co/MeDiA99",
        "entities": {
            "urls": [{"url": "https://t.co/AbCd123", "expanded_url": "https://example.org/article?a=1&b=2",
                      "display_url": "example.org/article…", "indices": [66, 86]}],
            "media": [{"url": "https://t.co/MeDiA99", "display_url": "pic.x.com/xyz", "indices": [87, 107]}],
        },
        "user": {"id_str": "1", "name": "Fixture <b>User</b>", "screen_name": "fixture_user",
                 "profile_image_url_https": f"{CDN}/profile_images/1/avatar_normal.png"},
        "mediaDetails": [
            {"type": "photo", "media_url_https": f"{CDN}/media/one.jpg"},
            {"type": "photo", "media_url_https": f"{CDN}/media/two.png"},
            {"type": "photo", "media_url_https": "https://evil.invalid/media/three.jpg"},
            {"type": "video", "media_url_https": f"{CDN}/ext_tw_video_thumb/9/poster.jpg",
             "video_info": {"duration_millis": 4000, "variants": [
                 {"content_type": "application/x-mpegURL", "url": f"{CDN}/vid/pl.m3u8"},
                 {"content_type": "video/mp4", "bitrate": 832000, "url": f"{CDN}/vid/640.mp4"},
                 {"content_type": "video/mp4", "bitrate": 2176000, "url": f"{CDN}/vid/1280.mp4"},
                 {"content_type": "video/mp4", "bitrate": 256000, "url": "javascript:alert(1)"}]}},
        ],
        "quoted_tweet": {
            "__typename": "Tweet", "id_str": "1700000000000000002", "text": "The quoted post https://t.co/QqQq",
            "created_at": "2026-09-01T09:00:00.000Z",
            "user": {"name": "Quoted Person", "screen_name": "quoted_person",
                     "profile_image_url_https": f"{CDN}/profile_images/2/q_normal.png"},
            "mediaDetails": [{"type": "photo", "media_url_https": f"{CDN}/media/q.jpg"}],
            "quoted_tweet": {"__typename": "Tweet", "id_str": "3", "text": "never shown"},
        },
    }
    text = data["text"]
    data["display_text_range"] = [len("@someone_else "), text.index(" https://t.co/MeDiA99")]
    data.update(changes)
    return data


class XCase(ArchiveCase):
    def setUp(self):
        super().setUp()
        for target, name, value in ((x_post, "SYNDICATION", BASE_URL + "/tweet-result"),
                                    (x_post, "_MEDIA_HOSTS", frozenset({"cdn.fixture.test"})),
                                    (x_post, "_MEDIA_SCHEMES", ("http", "https")),
                                    (archive, "X_SPACING", 0.0)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.key = archive.copy_key(POST_URL)

    def serve(self, data=None, status=200, identifier=POST_ID):
        body = json.dumps(embed() if data is None else data).encode()
        self.http.routes[x_post.data_url(identifier)[len(BASE_URL):]] = (status, {"Content-Type": "application/json"}, body)

    def media(self, video=MP4):
        for path, data, kind in (("/profile_images/1/avatar_bigger.png", PNG, "image/png"),
                                 ("/profile_images/2/q_bigger.png", PNG, "image/png"),
                                 ("/media/one?format=jpg&name=large", JPEG, "image/jpeg"),
                                 ("/media/two?format=png&name=large", PNG, "image/png"),
                                 ("/media/q?format=jpg&name=large", JPEG, "image/jpeg"),
                                 ("/ext_tw_video_thumb/9/poster?format=jpg&name=large", JPEG, "image/jpeg"),
                                 ("/ext_tw_video_thumb/9/poster.jpg", JPEG, "image/jpeg")):
            self.image(path, data, kind)
        if video is not None:
            self.http.routes["/vid/1280.mp4"] = (200, {"Content-Type": "video/mp4"}, video)
            self.http.routes["/vid/640.mp4"] = (200, {"Content-Type": "video/mp4"}, video[: len(video) // 2])


class RecognitionTests(unittest.TestCase):
    def test_odd_numbers_dates_and_nesting_never_crash_a_parser(self):
        import instagram_post
        import reddit_post
        import tiktok_post
        deep = b"[" * 50000 + b"]" * 50000
        self.assertIsNone(x_post.parse(deep))
        self.assertEqual(tiktok_post.parse(deep, "https://www.tiktok.com/@a/video/1", "1"), (None, ""))
        self.assertEqual(reddit_post.parse_oembed(deep, "abc"), (None, {}))
        edge = {"id_str": "20", "text": "hi", "created_at": "0001-01-01T00:00:00+05:00", "user": {"name": "n", "screen_name": "jack"}}
        self.assertEqual(x_post.parse(edge).created, "")
        self.assertEqual(x_post._int(10 ** 400), 0, "a huge bitrate must not overflow the size check")
        post, _, _ = instagram_post.parse("https://www.instagram.com/p/AbC123/", {"caption": "c", "takenAt": "0001-01-01T00:00:00+01:00"})
        self.assertEqual(post.created, "")

    def test_post_links(self):
        for url in ("https://x.com/a_b/status/123", "https://twitter.com/a/status/123?s=20", "http://mobile.twitter.com/a/statuses/123",
                    "https://x.com/i/web/status/123", "https://x.com/i/status/123", "https://x.com/a/status/123/photo/2",
                    "https://X.COM/a/status/0123"):
            with self.subTest(url=url):
                self.assertEqual(x_post.post_id(url), "123")
        for url in ("https://x.com/a", "https://x.com/a/status/", "https://x.com/a/status/abc", "https://evil.com/a/status/1",
                    "https://x.com.evil.com/a/status/1", "ftp://x.com/a/status/1", "https://x.com/a/status/0",
                    "https://x.com/name_that_is_too_long/status/1", "https://x.com/a/likes/1"):
            with self.subTest(url=url):
                self.assertIsNone(x_post.post_id(url))

    def test_token_matches_the_embed_widget(self):
        # Values from JavaScript: ((id / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "")
        for identifier, token in (("20", "6dq1a2xwd93"), ("1585341984679469056", "3uchycv2wqc"),
                                  ("1234567890123456789", "2zqic77uqyk"), ("999", "8uqo9xs4uzm"),
                                  ("1800000000000000000", "4d2v7cbm2xj")):
            self.assertEqual(x_post._token(identifier), token)

    def test_parse_checks_every_field(self):
        self.assertIsNone(x_post.parse(b"not json"))
        self.assertIsNone(x_post.parse({"__typename": "TweetTombstone", "tombstone": {}}))
        self.assertIsNone(x_post.parse({"id_str": "../1"}))
        post = x_post.parse(json.dumps({**embed(), "user": {"name": 5, "screen_name": "bad name!",
                                                            "profile_image_url_https": "https://pbs.twimg.com.evil/x_normal.jpg"}}).encode())
        self.assertEqual((post.name, post.handle, post.avatar), ("", "", ""))
        self.assertEqual(post.photos, [], "fixture media hosts are not X's")
        real = x_post.parse(embed(mediaDetails=[{"type": "photo", "media_url_https": "https://pbs.twimg.com/media/Abc.jpg"},
                                                {"type": "photo", "media_url_https": "http://pbs.twimg.com/media/Plain.jpg"},
                                                {"type": "photo", "media_url_https": "https://pbs.twimg.com:8443/media/P.jpg"}]))
        self.assertEqual(real.photos, ["https://pbs.twimg.com/media/Abc?format=jpg&name=large"])
        self.assertTrue(real.text.startswith("Two photos"), "the reply mention is outside the display range")
        self.assertIsNone(real.quoted.quoted, "only one level of quoting")
        long = x_post.parse(embed(note_tweet={"note_tweet_results": {"result": {"text": "A long post " * 40}}}))
        self.assertTrue(long.text.startswith("A long post"))


class SaveTests(XCase):
    def test_post_with_photos_video_and_quote(self):
        self.serve()
        self.media()
        record = archive.save_copy(POST_URL)
        self.assertEqual((record["status"], record["kind"], record["video"], record["images"]), ("saved", "x-post", True, 3))
        self.assertEqual(record["title"], "Fixture <b>User</b> on X: “Two photos <script>alert(1)</script> & a clip. Read”")
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4, "the sharpest rendition that fits")
        self.assertEqual(record["bytes"], (self.store / f"{self.key}.html").stat().st_size + len(MP4))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertTrue(document.startswith("<!DOCTYPE html>"))
        self.assertIn("Fixture &lt;b&gt;User&lt;/b&gt;", document)
        self.assertNotIn("<script", document)
        self.assertNotIn("<b>User", document)
        self.assertNotIn("javascript:", document)
        self.assertNotIn("@someone_else", document)
        self.assertNotIn("t.co/MeDiA99", document, "the media address is not shown as text")
        self.assertIn('<a href="https://example.org/article?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">example.org/article…</a>', document)
        self.assertIn(f'<video controls preload="metadata" poster="data:image/jpeg;base64,', document)
        self.assertIn(f'src="{self.key}.mp4"></video>', document)
        self.assertEqual(len(re.findall(r'<img alt="Photo \d" src="data:image/', document)), 2)
        self.assertIn("Quoted Person", document)
        self.assertNotIn("never shown", document)
        self.assertIn('href="https://x.com/fixture_user/status/1800000000000000001"', document)
        self.assertIn("14:05 UTC · 1 Oct 2026", document)
        for tag, value in re.findall(r'<(img|video)[^>]*? src="([^"]*)"', document):
            self.assertTrue(value.startswith("data:image/") or value == f"{self.key}.mp4", value[:60])
        self.assertFalse(any("evil.invalid" in path or "m3u8" in path for path in self.paths()))
        self.assertNotIn("/vid/640.mp4", self.paths())
        # Restored from a zip, the copy is rebuilt through the cleaner and keeps its photos, its card and its own video.
        again = archive.reclean_copy(document.encode(), "https://x.com/fixture_user/status/1800000000000000001", self.key).decode()
        self.assertIn(f'<video controls preload="metadata" poster="data:image/jpeg;base64,', again)
        self.assertIn(f'src="{self.key}.mp4"></video>', again)
        self.assertEqual(len(re.findall(r'<img alt="Photo \d" src="data:image/', again)), 2)
        self.assertIn("Quoted Person", again)
        self.assertIn('class="post"', again)

    def test_video_too_big_falls_back_to_a_smaller_one_then_the_cover(self):
        no_length = embed()
        del no_length["mediaDetails"][3]["video_info"]["duration_millis"]     # sizes are found out by fetching
        self.serve(no_length)
        self.media()
        with patch.object(archive, "VIDEO_LIMIT", len(MP4) - 1):
            record = archive.save_copy(POST_URL)
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4[: len(MP4) // 2])
        self.assertTrue(record["video"])
        with patch.object(archive, "VIDEO_LIMIT", 100):
            record = archive.save_copy(POST_URL)
        self.assertNotIn("video", record)
        self.assertFalse((self.store / f"{self.key}.mp4").exists(), "an update without the video removes the old one")
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("The video is bigger than 0 MB, so only its cover picture was kept.", document)
        self.assertIn('<img alt="Video cover" src="data:image/jpeg;base64,', document)
        self.assertNotIn("<video", document)
        # A rendition whose size is clearly over the limit is never started.
        self.serve()
        self.http.requests.clear()
        with patch.object(archive, "VIDEO_LIMIT", 600000):   # 2176 kbit/s * 4 s = 1.09 MB, 832 kbit/s * 4 s = 416 KB
            archive.save_copy(POST_URL)
        self.assertNotIn("/vid/1280.mp4", self.paths())
        self.assertIn("/vid/640.mp4", self.paths())

    def test_an_update_that_cannot_fetch_the_video_keeps_the_saved_one(self):
        self.serve()
        self.media()
        archive.save_copy(POST_URL)
        before = (self.store / f"{self.key}.html").read_bytes()
        for path in ("/vid/1280.mp4", "/vid/640.mp4"):
            self.http.routes[path] = (503, {"Content-Type": "text/plain"}, b"busy")     # the video host is down this time
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(POST_URL)
        self.assertEqual(caught.exception.code, "video_unavailable")
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4, "the saved video is still there")
        self.assertEqual((self.store / f"{self.key}.html").read_bytes(), before, "and so is the page that plays it")

    def test_escaped_text_shows_once_and_the_range_keeps_the_whole_sentence(self):
        # X sends text HTML-escaped; its display range counts the unescaped characters.
        data = embed()
        data["text"] = "Fish &amp; chips &lt;3 https://t.co/media1"
        data["display_text_range"] = [0, 15]                 # "Fish & chips <3"
        data["entities"] = {"urls": [], "media": [{"url": "https://t.co/media1"}]}
        data["user"]["name"] = "Jane &amp; Co"
        data.pop("note_tweet", None)
        post = x_post.parse(data)
        self.assertEqual((post.text, post.name), ("Fish & chips <3", "Jane & Co"))
        self.serve(data)
        self.media()
        archive.save_copy(POST_URL)
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("Fish &amp; chips &lt;3", document)
        self.assertNotIn("&amp;amp;", document)
        self.assertNotIn("&amp;lt;", document)
        # When a link's positions only fit the escaped text, the range is read that way too.
        data["text"] = "A &amp; B https://t.co/l1 https://t.co/media1"
        data["display_text_range"] = [0, 25]
        data["entities"] = {"urls": [{"url": "https://t.co/l1", "expanded_url": "https://example.test/", "indices": [14, 29],
                                      "display_url": "example.test"}], "media": [{"url": "https://t.co/media1"}]}
        data["entities"]["urls"][0]["indices"] = [10, 25]
        self.assertEqual(x_post.parse(data).text, "A & B https://t.co/l1")

    def test_media_that_fails_is_noted_and_the_post_still_saves(self):
        self.serve()
        self.media(video=None)
        self.http.routes["/vid/1280.mp4"] = (200, {"Content-Type": "video/mp4"}, b"<html>not a video</html>")
        del self.http.routes["/media/two?format=png&name=large"]
        record = archive.save_copy(POST_URL)
        self.assertEqual((record["images"], record["imagesLeftOut"]), (2, 1))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("1 picture could not be fetched.", document)
        self.assertIn("The video could not be fetched, so only its cover picture was kept.", document)
        self.assertFalse((self.store / f"{self.key}.mp4").exists())

    def test_gone_protected_or_odd_answers(self):
        for status in (404, 403):
            with self.subTest(status=status):
                self.serve(status=status)
                with self.assertRaises(archive.ArchiveError) as caught:
                    archive.save_copy(POST_URL)
                self.assertEqual(caught.exception.code, "post_unavailable")
        for data in ({"__typename": "TweetTombstone"}, {}, ["x"]):
            with self.subTest(data=data):
                self.serve(data)
                with self.assertRaises(archive.ArchiveError) as caught:
                    archive.save_copy(POST_URL)
                self.assertEqual(caught.exception.code, "post_unavailable")
        self.serve(status=500)
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(POST_URL)
        self.assertEqual(caught.exception.code, "http_error")
        self.assertIsNone(archive.read_record(self.key))

    def test_text_only_post(self):
        self.serve(embed(mediaDetails=[], quoted_tweet=None, entities={}, display_text_range=None,
                         text="Plain words, nothing else. https://t.co/Unknown1"))
        self.image("/profile_images/1/avatar_bigger.png", PNG, "image/png")
        record = archive.save_copy(POST_URL)
        self.assertEqual((record["images"], record["imagesLeftOut"]), (0, 0))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn('<div class="text" lang="und">Plain words, nothing else. https://t.co/Unknown1</div>', document)
        self.assertNotIn('class="media', document)

    def test_files_count_delete_and_queue(self):
        self.serve()
        self.media()
        archive.request_copy(POST_URL)
        self.assertTrue(archive.wait_idle(10))
        state = archive.state(self.key)
        self.assertEqual((state["status"], state["video"]), ("saved", True))
        html_size = (self.store / f"{self.key}.html").stat().st_size
        self.assertEqual(archive.summary(), {"count": 1, "bytes": html_size + len(MP4)})
        self.assertTrue(archive.remove(self.key))
        self.assertEqual(sorted(p.name for p in self.store.iterdir()), [])
        self.assertEqual(archive.summary(), {"count": 0, "bytes": 0})


@unittest.skipIf(dashboard is None, "Flask is not installed")
class XRouteTests(XCase):
    def setUp(self):
        super().setUp()
        storage.init_db()
        self.client = dashboard.app.test_client()
        self.serve()
        self.media()

    def test_video_is_served_with_ranges_inside_the_sandbox(self):
        archive.save_copy(POST_URL)
        page = self.client.get(f"/archive/{self.key}")
        self.assertEqual(page.status_code, 200)
        self.assertIn("media-src http://localhost/archive/;", page.headers["Content-Security-Policy"])
        whole = self.client.get(f"/archive/{self.key}.mp4")
        self.assertEqual((whole.status_code, whole.mimetype, whole.data), (200, "video/mp4", MP4))
        self.assertEqual(whole.headers["X-Content-Type-Options"], "nosniff")
        self.assertTrue(whole.headers["Content-Security-Policy"].startswith("sandbox"))
        part = self.client.get(f"/archive/{self.key}.mp4", headers={"Range": "bytes=4-11"})
        self.assertEqual((part.status_code, part.data), (206, b"ftypmp42"))
        whole.close()
        part.close()
        self.assertEqual(self.client.get(f"/archive/{'f' * 32}.mp4").status_code, 404)
        self.assertEqual(self.client.get("/archive/../app.py.mp4").status_code, 404)
        self.assertEqual(self.client.get("/archive/ABC.mp4").status_code, 404)

    def test_video_travels_in_the_zip_and_is_checked_on_restore(self):
        post = saved_post(51, url=POST_URL, domain="x.com", platform="x")
        self.assertEqual(self.client.post("/api/library", json={"posts": [post], "deletedUrls": []}).json["rejected"], [])
        archive.save_copy(POST_URL)
        data = self.client.post("/api/archive/export", json={"confirm": True}).data
        bundle = zipfile.ZipFile(io.BytesIO(data))
        self.assertEqual(bundle.read(f"copies/{self.key}.mp4"), MP4)
        archive.remove(self.key)
        result = self.client.post("/api/archive/import", data=data, content_type="application/zip").json
        self.assertEqual([item["key"] for item in result["restored"]], [self.key])
        self.assertTrue(result["restored"][0]["video"])
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4)
        self.assertEqual(archive.read_record(self.key)["kind"], "x-post")
        # A "video" that isn't one, or is too big, makes the entry invalid.
        page = bundle.read(f"copies/{self.key}.html")
        record = bundle.read(f"copies/{self.key}.json")
        for movie, limit in ((b"<script>x()</script>", archive.VIDEO_LIMIT), (MP4, 100)):
            archive.remove(self.key)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as z:
                for name, value in ((f"copies/{self.key}.html", page), (f"copies/{self.key}.json", record),
                                    (f"copies/{self.key}.mp4", movie)):
                    z.writestr(name, value)
            with self.subTest(limit=limit), patch.object(archive, "VIDEO_LIMIT", limit):
                answer = self.client.post("/api/archive/import", data=buffer.getvalue(), content_type="application/zip").json
                self.assertEqual((answer["restored"], answer["invalid"]), ([], 1))
                self.assertEqual(sorted(p.name for p in self.store.iterdir() if not p.name.startswith("import.")), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
