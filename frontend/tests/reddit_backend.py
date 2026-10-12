"""Saved copies and link previews of Reddit posts: synthetic data only.

Run: python -B frontend/tests/reddit_backend.py
Reddit's feed address and picture hosts are pointed at the owned loopback
fixture; nothing reaches reddit.com.
"""
import html
import os
import stat
import sys
import time
import json
import unittest
from unittest.mock import patch

from archive_backend import BASE_URL, CDN, JPEG, ROOT, ArchiveCase, archive
import reddit_post
import video_helper
from tiktok_backend import FAKE_HELPER, MP4

TEXT_URL = "https://www.reddit.com/r/python/comments/abc123/my_thread/"
IMAGE_URL = "https://old.reddit.com/r/EarthPics/comments/def456/golden_hour/"
VIDEO_URL = "https://www.reddit.com/r/videos/comments/ghi789/clip/"


def feed(identifier, *, title="Thread title", author="op_user", subreddit="python", body="", links=(), thumb="", extra=""):
    content = (f'<div class="md">{body}</div>' if body else "") + f' submitted by <a href="https://www.reddit.com/user/{author}">/u/{author}</a>'
    for href in links:
        content += f' <span><a href="{href}">[link]</a></span>'
    content += f' <span><a href="https://www.reddit.com/r/{subreddit}/comments/{identifier}/x/">[comments]</a></span>'
    media = f'<media:thumbnail url="{html.escape(thumb)}" />' if thumb else ""
    return (f'<?xml version="1.0" encoding="UTF-8"?>{extra}<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">'
            f'<category term="{subreddit}" label="r/{subreddit}"/><entry><author><name>/u/{author}</name></author>'
            f'<category term="{subreddit}" label="r/{subreddit}"/><content type="html">{html.escape(content)}</content>'
            f'<id>t3_{identifier}</id>{media}<published>2026-10-03T02:15:04+00:00</published>'
            f'<title>{html.escape(title)}</title></entry></feed>').encode()


class RedditCase(ArchiveCase):
    def setUp(self):
        super().setUp()
        self.helpers = ROOT / (self._testMethodName + "-helpers")
        self.helpers.mkdir()
        for target, name, value in ((reddit_post, "FEED_BASE", BASE_URL), (reddit_post, "SPACING", 0.0),
                                    (reddit_post, "_PICTURE_HOSTS", frozenset({"cdn.fixture.test"})),
                                    (reddit_post, "_PICTURE_SCHEMES", ("http", "https")),
                                    (video_helper, "HELPER_DIR", str(self.helpers)), (archive, "X_SPACING", 0.0)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.log = self.helpers / "calls.log"
        env = patch.dict(os.environ, {"FAKE_HELPER_LOG": str(self.log), "FAKE_HELPER_MODE": "ok"})
        env.start()
        self.addCleanup(env.stop)

    def serve(self, subreddit, identifier, body, status=200):
        self.http.routes[f"/r/{subreddit}/comments/{identifier}/.rss?limit=1"] = (status, {"Content-Type": "application/atom+xml"}, body)

    def document(self, url):
        return (self.store / f"{archive.copy_key(url)}.html").read_text()


class LinkTests(unittest.TestCase):
    def test_links(self):
        self.assertEqual(reddit_post.parse_link(TEXT_URL), ("post", "python", "abc123"))
        self.assertEqual(reddit_post.parse_link("https://reddit.com/comments/abc123"), ("post", "", "abc123"))
        self.assertEqual(reddit_post.parse_link("https://redd.it/abc123"), ("post", "", "abc123"))
        self.assertEqual(reddit_post.parse_link("https://www.reddit.com/r/python/s/AbCdE12345"), ("share", "python", "AbCdE12345"))
        self.assertEqual(reddit_post.parse_link("https://www.reddit.com/user/someone/comments/abc123/x/"), ("post", "", "abc123"))
        for url in ("https://www.reddit.com/r/python/", "https://reddit.com.evil.com/r/a/comments/abc123/", "ftp://www.reddit.com/r/a/comments/abc123/",
                    "https://www.reddit.com/r/a/comments/ABC!/", "https://www.reddit.com/r/a/comments/abc123/x/../../y", "https://redd.it/"):
            self.assertIsNone(reddit_post.parse_link(url), url)
        self.assertEqual(reddit_post.data_url("python", "abc123"), "https://www.reddit.com/r/python/comments/abc123/.rss?limit=1")

    def test_feed_values_are_checked(self):
        evil = feed("abc123", author="bad name!", subreddit="x/../y", thumb="https://evil.invalid/p.jpg",
                    links=("javascript:alert(1)", "https://i.redd.it/../evil.jpg"))
        post, details = reddit_post.parse(evil, "abc123")
        self.assertEqual((post.name, details["subreddit"], details["thumbnail"], details["link"]), ("", "", "", ""))
        self.assertEqual(reddit_post.parse(feed("abc123"), "other1"), (None, {}))
        self.assertEqual(reddit_post.parse(b"not xml", "abc123"), (None, {}))
        bomb = b'<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY a "aaaa">]><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_abc123</id><title>&a;</title></entry></feed>'
        self.assertEqual(reddit_post.parse(bomb, "abc123"), (None, {}), "entities are refused")
        self.assertEqual(reddit_post.parse(b"x" * (reddit_post.DATA_LIMIT + 1), "abc123"), (None, {}))


class SaveTests(RedditCase):
    def test_a_text_post_with_an_outside_link(self):
        self.serve("python", "abc123", feed("abc123", title="Why <script>x()</script> tabs", body="<p>First para</p><p>Second <b>para</b></p>",
                                            links=("https://example.org/article?a=1&b=2",)))
        record = archive.save_copy(TEXT_URL)
        self.assertEqual((record["kind"], record["images"], record.get("video")), ("reddit-post", 0, None))
        page = self.document(TEXT_URL)
        self.assertIn("Why &lt;script&gt;x()&lt;/script&gt; tabs", page)
        self.assertIn("First para\n\nSecond para", page)
        self.assertEqual(record["title"], "u/op_user · r/python on Reddit: “Why <script>x()</script> tabs”")
        self.assertIn('<a href="https://example.org/article?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">', page)
        self.assertIn("u/op_user · r/python", page)
        self.assertIn('href="https://www.reddit.com/r/python/comments/abc123/"', page)
        self.assertIn(">View on Reddit</a>", page)
        self.assertNotIn("<script", page)

    def test_an_image_post_keeps_its_picture(self):
        self.image("/full.jpg", JPEG, "image/jpeg")
        self.serve("EarthPics", "def456", feed("def456", subreddit="EarthPics", thumb=f"{CDN}/thumb.jpg", links=(f"{CDN}/full.jpg",)))
        with patch.object(reddit_post, "_PICTURE_SUFFIXES", (".jpg",)):
            # i.redd.it is the full picture's host; the fixture stands in for it.
            original = reddit_post.parse
            def as_ireddit(data, identifier):
                post, details = original(data, identifier)
                details["image"] = f"{CDN}/full.jpg"
                return post, details
            with patch.object(reddit_post, "parse", as_ireddit):
                record = archive.save_copy(IMAGE_URL)
        self.assertEqual((record["images"], record["imagesLeftOut"]), (1, 0))
        self.assertIn("data:image/jpeg;base64,", self.document(IMAGE_URL))
        self.assertEqual(self.paths().count("/full.jpg"), 1)

    def test_rate_limit_is_busy_and_a_missing_post_is_unavailable(self):
        self.serve("python", "abc123", b"slow down", status=429)
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(TEXT_URL)
        self.assertEqual(caught.exception.code, "busy")
        self.serve("python", "abc123", b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>')
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(TEXT_URL)
        self.assertEqual(caught.exception.code, "post_unavailable")

    def test_without_the_feed_the_copy_keeps_title_author_and_subreddit(self):
        # Reddit may close its RSS feeds as it closed .json: its embed data still names the post.
        self.serve("python", "abc123", b"Blocked", status=403)
        oembed = {"title": "Why <b>tabs</b>", "author_name": "op_user", "type": "rich", "provider_name": "reddit",
                  "html": '<blockquote><a href="https://www.reddit.com/r/python/comments/abc123/x/">Why tabs</a></blockquote><script src="https://embed.reddit.com/widgets.js"></script>'}
        target = "/oembed?url=" + __import__("urllib.parse").parse.quote("https://www.reddit.com/r/python/comments/abc123/", safe="")
        self.http.routes[target] = (200, {"Content-Type": "application/json"}, json.dumps(oembed).encode())
        record = archive.save_copy(TEXT_URL)
        page = self.document(TEXT_URL)
        self.assertEqual(record["title"], "u/op_user · r/python on Reddit: “Why <b>tabs</b>”")
        self.assertIn("Reddit didn't share this post's text or picture, so the copy keeps its title, author and subreddit.", page)
        self.assertIn("Why &lt;b&gt;tabs&lt;/b&gt;", page)
        self.assertNotIn("<script", page, "the embed markup is never used")
        # no feed and no embed data: the post is unavailable
        del self.http.routes[target]
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(TEXT_URL)
        self.assertEqual(caught.exception.code, "post_unavailable")

    def test_a_video_post_without_and_with_the_helper(self):
        self.image("/v-thumb.jpg", JPEG, "image/jpeg")
        body = feed("ghi789", subreddit="videos", thumb=f"{CDN}/v-thumb.jpg", links=("https://v.redd.it/xyz987",))
        self.serve("videos", "ghi789", body)
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record.get("video"), record["videoMissing"], record["images"]), (None, True, 1))
        self.assertIn("Saved without the video. To keep the video too, get the video helper in Settings", self.document(VIDEO_URL))
        path = self.helpers / video_helper.ASSET
        path.write_text(FAKE_HELPER)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        (self.helpers / "helper.json").write_text(json.dumps({"version": "2026.08.19", "sha256": "x",
                                                              "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["video"], record["videoMissing"]), (True, False))
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(calls[-1][-1], "https://www.reddit.com/r/videos/comments/ghi789/", "the helper gets the post's own address")
        self.assertEqual((self.store / f"{archive.copy_key(VIDEO_URL)}.mp4").read_bytes(), MP4)


if __name__ == "__main__":
    unittest.main(verbosity=1)
