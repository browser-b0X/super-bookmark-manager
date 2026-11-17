"""Saved copies of TikTok posts and the optional video helper: synthetic data only.

Run: python -B frontend/tests/tiktok_backend.py
TikTok's oEmbed address, its picture hosts and yt-dlp's release address are
pointed at the owned loopback fixture. The "helper" is a small Python script
that behaves like yt-dlp; nothing is downloaded from GitHub and nothing
reaches tiktok.com.
"""
import hashlib
import html
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from archive_backend import BASE_URL, CDN, JPEG, PNG, ROOT, ArchiveCase, archive, dashboard, storage
from fake_program import program_bytes
import tiktok_post
import video_helper

MP4 = b"\x00\x00\x00\x18ftypisom" + b"synthetic-tiktok-mp4" * 300
VIDEO_URL = "https://www.tiktok.com/@kitchen.notes/video/7551234567890123456"
PHOTO_URL = "https://www.tiktok.com/@kitchen.notes/photo/7551234567890123457"
FAKE_HELPER = r'''#!{python}
import json, os, sys, time
args = sys.argv[1:]
log = os.environ.get("FAKE_HELPER_LOG")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps(args) + "\n")
if args == ["--version"]:
    print("2026.08.19")
    sys.exit(0)
info = os.environ.get("FAKE_HELPER_INFO")
if info and "--write-info-json" in args:   # as yt-dlp: the post's details first, before any video
    with open(args[args.index("-o") + 1].replace("%(ext)s", "info.json"), "w", encoding="utf-8") as handle:
        handle.write(info)
mode = os.environ.get("FAKE_HELPER_MODE", "ok")
if mode == "fail":
    sys.exit(1)
if mode == "slow":
    time.sleep(30)
if mode == "slow_child":             # a one-file program: the real work runs in a child process
    import subprocess
    marker = os.environ["FAKE_HELPER_MARKER"]
    subprocess.Popen([sys.executable, "-c", "import sys, time; time.sleep(7); open(sys.argv[1], 'w').write('still running')", marker])
    time.sleep(30)
if mode == "too_big":
    sys.exit(0)                      # what yt-dlp does when --max-filesize stops it
target = args[args.index("-o") + 1].replace("%(ext)s", "mp4")
with open(target, "wb") as handle:
    handle.write({mp4!r} if mode == "ok" else b"<html>not a video</html>")
'''.replace("{python}", sys.executable).replace("{mp4!r}", repr(MP4))
# The stand-in as a program this system runs (on Windows, inside pip's launcher: see fake_program.py).
HELPER_PROGRAM = program_bytes(FAKE_HELPER)


def oembed(**changes):
    data = {"version": "1.0", "type": "video", "title": "Overnight focaccia, the lazy way <script>x()</script> #bread",
            "author_name": "Kitchen <b>Notes</b>", "author_url": "https://www.tiktok.com/@kitchen.notes",
            "thumbnail_url": f"{CDN}/obj/cover.jpeg", "thumbnail_width": 720, "thumbnail_height": 1280,
            "html": "<blockquote><script src=\"https://www.tiktok.com/embed.js\"></script></blockquote>",
            "provider_name": "TikTok", "provider_url": "https://www.tiktok.com"}
    data.update(changes)
    return data


def player_only(identifier="7551234567890123456"):
    """The fields of TikTok's oEmbed answer for a public post on 2026-11-03 (the values made up): its player alone."""
    return {"version": "1.0", "type": "video", "width": "100%", "height": "100%",
            "html": f'<iframe src="https://www.tiktok.com/player/v1/{identifier}" allow="fullscreen"></iframe>',
            "provider_url": "https://www.tiktok.com", "provider_name": "TikTok", "embed_product_id": identifier,
            "embed_type": "video"}


PAGE_PATH = "/@kitchen.notes/video/7551234567890123456"
CAPTION = "Overnight focaccia, the lazy way <script>x()</script> #bread"


def post_page(cover=f"{CDN}/obj/cover.jpeg", address="https://www.tiktok.com" + PAGE_PATH, caption=CAPTION):
    return ('<!doctype html><html><head><title>TikTok</title><meta property="og:title" content="TikTok · Kitchen Notes">'
            + (f'<meta property="og:description" content="{html.escape(caption)}">' if caption else "")
            + (f'<meta property="og:image" content="{cover}">' if cover else "")
            + f'<meta property="og:url" content="{address}"></head><body><div id="app"></div></body></html>')


# What TikTok may show a visitor it won't show the post to: its home page's tags.
HOME_PAGE = ('<!doctype html><html><head><title>TikTok - Make Your Day</title>'
             '<meta property="og:description" content="TikTok - trends start here.">'
             f'<meta property="og:image" content="{CDN}/obj/logo.png"><meta property="og:url" content="https://www.tiktok.com/">'
             '</head></html>')


class TikTokCase(ArchiveCase):
    def setUp(self):
        super().setUp()
        # A short name: Windows can't start a program whose full path is 260 characters or more, and a test's name in it
        # took the stand-in helper past that when the checkout sat in a long folder.
        self.helpers = Path(tempfile.mkdtemp(prefix="h-", dir=ROOT))
        for target, name, value in ((tiktok_post, "OEMBED", BASE_URL + "/oembed?url="),
                                    (tiktok_post, "_PICTURE_SUFFIXES", (".fixture.test",)),
                                    (tiktok_post, "_PICTURE_SCHEMES", ("http", "https")),
                                    (video_helper, "HELPER_DIR", str(self.helpers)),
                                    (video_helper, "RELEASE", BASE_URL + "/rel/"),
                                    (archive, "X_SPACING", 0.0)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.log = self.helpers / "calls.log"
        env = patch.dict(os.environ, {"FAKE_HELPER_LOG": str(self.log), "FAKE_HELPER_MODE": "ok"})
        env.start()
        self.addCleanup(env.stop)
        self.image("/obj/cover.jpeg", JPEG, "image/jpeg")
        self.key = archive.copy_key(VIDEO_URL)

    def serve(self, link=VIDEO_URL, data=None, status=200):
        body = json.dumps(oembed() if data is None else data).encode()
        self.http.routes[tiktok_post.data_url(link)[len(BASE_URL):]] = (status, {"Content-Type": "application/json"}, body)

    def plant_helper(self, checked_at=None):
        path = self.helpers / video_helper.ASSET
        path.write_bytes(HELPER_PROGRAM)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        now = checked_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (self.helpers / "helper.json").write_text(json.dumps({"version": "2026.08.19", "sha256": "x", "checkedAt": now}))
        return path

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []


class LinkTests(unittest.TestCase):
    def test_the_isolation_guard_still_refuses_real_programs(self):
        import subprocess
        from archive_backend import GUARD_FAILURES
        before = len(GUARD_FAILURES)
        with self.assertRaises(RuntimeError):
            subprocess.run([sys.executable, "--version"], capture_output=True)
        del GUARD_FAILURES[before:]          # expected here; not a leak

    def test_links(self):
        self.assertEqual(tiktok_post.parse_link(VIDEO_URL), ("video", "kitchen.notes", "7551234567890123456"))
        self.assertEqual(tiktok_post.parse_link(PHOTO_URL + "?lang=en"), ("photo", "kitchen.notes", "7551234567890123457"))
        self.assertEqual(tiktok_post.parse_link("https://m.tiktok.com/@a_b.c/video/123456/"), ("video", "a_b.c", "123456"))
        for short in ("https://vm.tiktok.com/ZMabc123/", "https://vt.tiktok.com/ZSxyz789", "https://www.tiktok.com/t/ZTabcde/"):
            self.assertEqual(tiktok_post.parse_link(short)[0], "short", short)
        for url in ("https://www.tiktok.com/@kitchen.notes", "https://www.tiktok.com/@a/video/abc", "https://tiktok.com.evil.com/@a/video/123456",
                    "https://evil.com/@a/video/123456", "ftp://www.tiktok.com/@a/video/123456", "https://www.tiktok.com/@a/live/123456",
                    "https://vm.tiktok.com/../../x", "https://www.tiktok.com/@a/video/123456/../../x"):
            self.assertIsNone(tiktok_post.parse_link(url), url)

    def test_oembed_values_are_checked(self):
        post, cover = tiktok_post.parse(json.dumps(oembed(thumbnail_url="https://evil.invalid/c.jpg", author_url="javascript:alert(1)",
                                                          title=["x"])).encode(), VIDEO_URL, "1")
        self.assertEqual((post.text, post.handle, cover), ("", "", ""))
        self.assertEqual(post.name, "Kitchen <b>Notes</b>")
        self.assertEqual(tiktok_post.parse(b"not json", VIDEO_URL, "1"), (None, ""))
        self.assertEqual(tiktok_post.parse({"status_msg": "Something went wrong"}, VIDEO_URL, "1"), (None, ""))
        real, cover = tiktok_post.parse(oembed(thumbnail_url="https://p16-sign-va.tiktokcdn.com/obj/x.jpeg"), VIDEO_URL, "1")
        self.assertEqual(cover, "https://p16-sign-va.tiktokcdn.com/obj/x.jpeg")
        self.assertEqual((real.site, real.link, real.handle), ("TikTok", VIDEO_URL, "kitchen.notes"))


    def test_the_page_for_link_previews_names_the_post_in_base_36(self):
        # What TikTok's page for link previews said about its documented example post on 2026-11-04: og:url names the
        # post by its number in base 36, after an "e", and the cover is on TikTok's picture host.
        tags = {"final": "https://www.tiktok.com/@scout2015/video/6718335390845095173", "summary": "A caption",
                "address": "https://www.tiktok.com/@scout2015/video/e1f1jf4uutrchx",
                "image": "https://p19-common-sign.tiktokcdn-us.com/obj/cover.jpeg"}
        self.assertEqual(tiktok_post.page_details(tags, "6718335390845095173"), ("A caption", tags["image"]))
        for other in ("https://www.tiktok.com/@scout2015/video/e1f1jf4uutrchy", "https://www.tiktok.com/@scout2015/video/e1f1jf4uutrchxx",
                      "https://www.tiktok.com/"):
            self.assertEqual(tiktok_post.page_details({**tags, "address": other}, "6718335390845095173"), ("", ""), other)


class SaveTests(TikTokCase):
    def test_without_the_helper_caption_and_cover_are_saved(self):
        self.serve()
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["kind"], record["videoMissing"], record.get("video"), record["images"]), ("tiktok-post", True, None, 1))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("Saved without the video. To keep the video too, get the video helper in Settings, then choose Update.", document)
        self.assertIn('<img alt="Video cover" src="data:image/jpeg;base64,', document)
        self.assertIn("Kitchen &lt;b&gt;Notes&lt;/b&gt;", document)
        self.assertIn(f'href="{VIDEO_URL}"', document)
        self.assertIn(">View on TikTok</a>", document)
        self.assertNotIn("<script", document)
        self.assertNotIn("embed.js", document, "the embed markup from TikTok is never used")
        self.assertEqual(record["title"], "Kitchen <b>Notes</b> on TikTok: “Overnight focaccia, the lazy way <script>x()</script> #bread”")
        self.assertFalse((self.store / f"{self.key}.mp4").exists())
        self.assertEqual(self.calls(), [])

    def test_with_the_helper_the_video_is_kept(self):
        self.serve()
        self.plant_helper()
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["video"], record["videoMissing"]), (True, False))
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4)
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn(f'src="{self.key}.mp4"></video>', document)
        self.assertIn('poster="data:image/jpeg;base64,', document)
        [args] = self.calls()
        for flag in ("--ignore-config", "--no-cookies", "--no-cache-dir", "--no-playlist", "--max-filesize"):
            self.assertIn(flag, args)
        self.assertEqual(args[-2:], ["--", VIDEO_URL], "the address comes last, after --, so it can't be an option")
        self.assertEqual(args[args.index("--max-filesize") + 1], "50M")
        self.assertEqual(args[args.index("--use-extractors") + 1], "default,-generic", "never the generic extractor")
        self.assertNotIn("--cookies-from-browser", args)

    def test_helper_problems_keep_caption_and_cover(self):
        self.serve()
        self.plant_helper()
        for mode, note in (("too_big", "The video is bigger than 50 MB, so only its cover picture was kept."),
                           ("fail", "The video could not be fetched, so only its cover picture was kept. Update tries again."),
                           ("junk", "The video could not be fetched")):
            with self.subTest(mode=mode), patch.dict(os.environ, {"FAKE_HELPER_MODE": mode}):
                record = archive.save_copy(VIDEO_URL)
                self.assertTrue(record["videoMissing"])
                self.assertIn(note, (self.store / f"{self.key}.html").read_text())
                self.assertFalse((self.store / f"{self.key}.mp4").exists())
        with patch.dict(os.environ, {"FAKE_HELPER_MODE": "slow"}), patch.object(archive, "HELPER_TIMEOUT", 1.0):
            started = time.monotonic()
            record = archive.save_copy(VIDEO_URL)
            self.assertLess(time.monotonic() - started, 10)
            self.assertTrue(record["videoMissing"])

    # Linux stops the helper's process group; Windows runs `taskkill /T` (the stand-in is a real program there too).
    def test_a_helper_that_runs_too_long_is_stopped_with_everything_it_started(self):
        self.serve()
        self.plant_helper()
        marker = self.helpers / "child-was-still-running"
        with patch.dict(os.environ, {"FAKE_HELPER_MODE": "slow_child", "FAKE_HELPER_MARKER": str(marker)}), \
                patch.object(archive, "HELPER_TIMEOUT", 1.0):
            record = archive.save_copy(VIDEO_URL)
        self.assertTrue(record["videoMissing"])
        time.sleep(4)                           # past the child's 7 s (the helper gets at least 5 s)
        self.assertFalse(marker.exists(), "the helper's child process was stopped too")

    def test_photo_slideshow_keeps_caption_and_cover_only(self):
        self.serve(PHOTO_URL)
        self.plant_helper()
        record = archive.save_copy(PHOTO_URL)
        self.assertEqual((record["videoMissing"], record.get("video")), (False, None))
        self.assertIn("Photo slideshows are saved with their caption and cover picture only.",
                      (self.store / f"{archive.copy_key(PHOTO_URL)}.html").read_text())
        self.assertEqual(self.calls(), [], "the helper is not run for photos")

    def test_share_link_is_followed_to_the_post(self):
        self.http.dns["vm.tiktok.com"] = self.http.dns["metadata.fixture.test"]
        self.http.dns["www.tiktok.com"] = self.http.dns["metadata.fixture.test"]
        short = "http://vm.tiktok.com/ZMabc123/"
        self.http.routes["/ZMabc123/"] = (302, {"Location": "http://www.tiktok.com/@kitchen.notes/video/7551234567890123456?_r=1"}, b"")
        self.http.html("/@kitchen.notes/video/7551234567890123456?_r=1", "<title>TikTok</title>")
        self.serve()
        record = archive.save_copy(short)
        self.assertEqual((record["url"], record["kind"]), (short, "tiktok-post"))
        self.http.routes["/ZMabc123/"] = (302, {"Location": "http://www.tiktok.com/foryou"}, b"")
        self.http.html("/foryou", "<title>For you</title>")
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(short)
        self.assertEqual(caught.exception.code, "post_unavailable")

    def test_gone_or_private_posts(self):
        for status in (400, 404):
            with self.subTest(status=status):
                self.serve(status=status)
                with self.assertRaises(archive.ArchiveError) as caught:
                    archive.save_copy(VIDEO_URL)
                self.assertEqual(caught.exception.code, "post_unavailable")
        self.serve(data={"status_msg": "Something went wrong", "code": 400})
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(VIDEO_URL)
        self.assertEqual(caught.exception.code, "post_unavailable")
        self.assertIsNone(archive.read_record(self.key))

    def test_weekly_update_check(self):
        # Owner, 2026-10-09: the weekly look only reports a newer helper; installing waits for Update.
        self.serve()
        self.plant_helper(checked_at="2026-01-01T00:00:00Z")
        with patch.object(video_helper, "start") as start:
            archive.save_copy(VIDEO_URL)
        start.assert_called_once_with("check")
        self.plant_helper()
        with patch.object(video_helper, "start") as start:
            archive.save_copy(VIDEO_URL)
        start.assert_not_called()


class PlayerOnlyTests(TikTokCase):
    """Owner, 2026-11-03: every TikTok post's copy said it was deleted, private or for signed-in people only. TikTok's
    oEmbed answer had become its player alone; the caption and cover now come from the post's page."""

    def setUp(self):
        super().setUp()
        # create: these tests also run against the code before the fix, and fail there.
        patcher = patch.object(tiktok_post, "PAGES", BASE_URL, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.image("/obj/logo.png", PNG, "image/png")

    def page(self, under_the_apps_name, under_whatsapps=None):
        def answer(handler):
            crawler = handler.headers.get("User-Agent", "").startswith("WhatsApp/")
            body = (under_whatsapps if crawler and under_whatsapps is not None else under_the_apps_name).encode()
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html; charset=utf-8")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        self.http.routes[PAGE_PATH] = answer

    def page_requests(self):
        return [headers.get("User-Agent", "") for path, headers in self.http.requests if path == PAGE_PATH]

    def test_caption_and_cover_come_from_the_post_page(self):
        self.serve(data=player_only())
        self.page(post_page())
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["kind"], record["images"], record["videoMissing"]), ("tiktok-post", 1, True))
        self.assertEqual(record["title"], f"@kitchen.notes on TikTok: “{CAPTION}”")
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn('<img alt="Video cover" src="data:image/jpeg;base64,', document)
        self.assertIn("Overnight focaccia, the lazy way &lt;script&gt;x()&lt;/script&gt; #bread", document)
        self.assertNotIn("<script", document)
        self.assertNotIn("iframe", document, "TikTok's player is never used")
        self.assertIn("Saved without the video. To keep the video too, get the video helper in Settings, then choose Update.", document)
        [asked] = self.page_requests()
        self.assertTrue(asked.startswith("Mozilla/5.0 (compatible; SuperBookmarkManager"), "under the app's own name first")

    def test_with_the_helper_the_video_is_kept_too(self):
        self.serve(data=player_only())
        self.page(post_page())
        self.plant_helper()
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["video"], record["videoMissing"], record["images"]), (True, False, 1))
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4)

    def test_without_a_picture_it_asks_once_more_as_previews_do(self):
        # Previews ask under WhatsApp's link-preview crawler's name when a page gives no picture; so does the copy.
        self.serve(data=player_only())
        self.page(post_page(cover=""), under_whatsapps=post_page())
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual(record["images"], 1)
        self.assertEqual(record["title"], f"@kitchen.notes on TikTok: “{CAPTION}”")
        first, second = self.page_requests()
        self.assertTrue(first.startswith("Mozilla/5.0 (compatible; SuperBookmarkManager"))
        self.assertTrue(second.startswith("WhatsApp/"))

    def test_the_pages_as_tiktok_answered_them_on_2026_11_04(self):
        # Under the app's name TikTok's page had no preview tags at all; under WhatsApp's, its og:url named the post in
        # base 36 (see LinkTests). The first live check of the fix stopped there with post_unread.
        self.serve(data=player_only())
        self.page('<!doctype html><html><head><title>TikTok - Make Your Day</title></head><body><div id="app"></div></body></html>',
                  under_whatsapps=post_page(address="https://www.tiktok.com/@kitchen.notes/video/e1ldch92jiw43k"))
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["images"], record["title"]), (1, f"@kitchen.notes on TikTok: “{CAPTION}”"))
        self.assertEqual([agent.split("/")[0] for agent in self.page_requests()], ["Mozilla", "WhatsApp"])

    def test_with_the_helper_the_caption_and_name_come_from_its_details(self):
        # Owner, 2026-11-04: TikTok's pages give the cover but no caption; the helper's run writes the post's details
        # beside the video (yt-dlp's info JSON, no other request), so the caption and the author's name come from there.
        self.serve(data=player_only())
        self.page(post_page(caption=""))
        self.plant_helper()
        details = json.dumps({"description": "Sourdough, day three <b>#bread</b>", "channel": "Kitchen Notes", "uploader": "kitchen.notes"})
        with patch.dict(os.environ, {"FAKE_HELPER_INFO": details}):
            record = archive.save_copy(VIDEO_URL)
        self.assertEqual(record["title"], "Kitchen Notes on TikTok: “Sourdough, day three <b>#bread</b>”")
        self.assertEqual((record["video"], record["images"]), (True, 1))
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn("Sourdough, day three &lt;b&gt;#bread&lt;/b&gt;", document)
        self.assertNotIn("didn't share", document)
        self.assertIn("--write-info-json", self.calls()[0])
        # yt-dlp writes the details before the video: a video too large still leaves its caption.
        with patch.dict(os.environ, {"FAKE_HELPER_INFO": details, "FAKE_HELPER_MODE": "too_big"}):
            record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["title"], record["videoMissing"]), ("Kitchen Notes on TikTok: “Sourdough, day three <b>#bread</b>”", True))

    def test_without_a_caption_the_copy_says_why(self):
        self.serve(data=player_only())
        self.page(post_page(caption=""))
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual(record["title"], "@kitchen.notes on TikTok")
        self.assertIn("Saved without the video or its caption. To keep both, get the video helper in Settings, then choose Update.",
                      (self.store / f"{self.key}.html").read_text())
        self.plant_helper()
        for info in (None, json.dumps({"description": ["not text"], "channel": 7}), "not json"):
            with self.subTest(info=info), patch.dict(os.environ, {"FAKE_HELPER_INFO": info} if info else {}):
                record = archive.save_copy(VIDEO_URL)
                self.assertEqual((record["title"], record["video"]), ("@kitchen.notes on TikTok", True))
                self.assertIn("TikTok didn't share this post's caption.", (self.store / f"{self.key}.html").read_text())

    def test_a_page_that_isnt_the_post_is_not_used(self):
        self.serve(data=player_only())
        self.page(HOME_PAGE)
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(VIDEO_URL)
        self.assertEqual(caught.exception.code, "post_unread", "TikTok shows the post: not called deleted or private")
        self.assertEqual(len(self.page_requests()), 2)
        self.assertIsNone(archive.read_record(self.key))
        # With the helper, the video alone is kept; TikTok's logo is never taken for the cover.
        self.plant_helper()
        record = archive.save_copy(VIDEO_URL)
        self.assertEqual((record["video"], record["images"], record["title"]), (True, 0, "@kitchen.notes on TikTok"))
        self.assertNotIn("data:image/png", (self.store / f"{self.key}.html").read_text())

    def test_a_page_naming_another_post_is_not_used(self):
        self.serve(data=player_only())
        self.page(post_page(address="https://www.tiktok.com/@someone.else/video/7559999999999999999"))
        with self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(VIDEO_URL)
        self.assertEqual(caught.exception.code, "post_unread")

    def test_an_answer_for_another_post_or_an_error_still_means_unavailable(self):
        self.page(post_page())
        for data in (player_only("7559999999999999999"), {"status_msg": "Something went wrong", "code": 400},
                     {"version": "1.0", "type": "video", "html": ""}):
            with self.subTest(data=data):
                self.serve(data=data)
                with self.assertRaises(archive.ArchiveError) as caught:
                    archive.save_copy(VIDEO_URL)
                self.assertEqual(caught.exception.code, "post_unavailable")
        self.assertEqual(self.page_requests(), [], "the page is read only when TikTok names the post")


class HelperInstallTests(TikTokCase):
    def release(self, program=None, sums=None):
        program = HELPER_PROGRAM if program is None else program
        listed = hashlib.sha256(program).hexdigest()
        lines = sums if sums is not None else f"{'0' * 64}  yt-dlp_x86.exe\n{listed}  {video_helper.ASSET}\n{'1' * 64}  yt-dlp.tar.gz\n"
        self.http.routes["/rel/SHA2-256SUMS"] = (200, {"Content-Type": "text/plain"}, lines.encode())
        self.http.routes[f"/rel/{video_helper.ASSET}"] = (200, {"Content-Type": "application/octet-stream"}, program)

    def test_install_checks_the_checksum_and_runs_the_program(self):
        self.release()
        status = video_helper.install()
        self.assertEqual((status["installed"], status["version"], status["checksum"]), (True, "2026.08.19", True))
        self.assertEqual((self.helpers / video_helper.ASSET).read_bytes(), HELPER_PROGRAM)
        self.assertEqual(self.calls(), [["--version"]])
        self.assertEqual(sorted(p.name for p in self.helpers.iterdir()), sorted([video_helper.ASSET, "helper.json", "calls.log"]))
        self.assertTrue(video_helper.remove())
        self.assertFalse(video_helper.status()["installed"])

    def test_bad_downloads_are_refused_and_leave_nothing(self):
        cases = {"checksum_mismatch": dict(sums=f"{'2' * 64}  {video_helper.ASSET}\n"),
                 "not_listed": dict(sums=f"{'2' * 64}  something-else.exe\n"),
                 "not_runnable": dict(program=b"MZ not really a program", sums=None)}
        for code, release in cases.items():
            with self.subTest(code=code):
                if code == "not_runnable":
                    self.release(program=b"MZ not really a program")
                else:
                    self.release(**release)
                with self.assertRaises(video_helper.HelperError) as caught:
                    video_helper.install()
                self.assertEqual(caught.exception.code, code)
                self.assertFalse(video_helper.installed())
                self.assertEqual([p.name for p in self.helpers.iterdir() if p.name != "calls.log"], [])
        with patch.object(video_helper, "DOWNLOAD_LIMIT", 10):
            self.release()
            with self.assertRaises(video_helper.HelperError) as caught:
                video_helper.install()
            self.assertEqual(caught.exception.code, "too_large")

    def test_background_job_reports_through_status(self):
        self.release()
        video_helper.start("install")
        self.assertTrue(video_helper.wait_idle(20))
        status = video_helper.status()
        self.assertEqual((status["installed"], status["busy"], status["error"], status["action"]), (True, False, "", "install"))
        self.release(sums=f"{'2' * 64}  {video_helper.ASSET}\n")
        video_helper.start("update")
        self.assertTrue(video_helper.wait_idle(20))
        status = video_helper.status()
        self.assertEqual((status["installed"], status["error"]), (True, "checksum_mismatch"), "a failed update keeps the old helper")


    def test_check_reports_a_newer_release_and_changes_nothing(self):
        self.release()
        video_helper.install()
        installed = (self.helpers / video_helper.ASSET).read_bytes()
        self.assertFalse(video_helper.status()["updateAvailable"])
        calls_before = len(self.calls())
        # Same release: nothing to offer.
        self.assertFalse(video_helper.check()["updateAvailable"])
        # A new release: reported, but the program is neither downloaded nor run.
        newer = program_bytes(FAKE_HELPER + "\n# newer release\n")
        self.http.routes["/rel/SHA2-256SUMS"] = (200, {"Content-Type": "text/plain"}, f"{hashlib.sha256(newer).hexdigest()}  {video_helper.ASSET}\n".encode())
        self.http.routes[f"/rel/{video_helper.ASSET}"] = (200, {"Content-Type": "application/octet-stream"}, newer)
        fetched = self.paths().count(f"/rel/{video_helper.ASSET}")
        status = video_helper.check()
        self.assertTrue(status["updateAvailable"])
        self.assertEqual(self.paths().count(f"/rel/{video_helper.ASSET}"), fetched, "the program is not downloaded by a check")
        self.assertEqual((self.helpers / video_helper.ASSET).read_bytes(), installed)
        self.assertEqual(len(self.calls()), calls_before, "nothing new is run by a check")
        # The owner chooses Update: downloaded, checked, and the offer goes away.
        video_helper.start("update")
        self.assertTrue(video_helper.wait_idle(20))
        self.assertEqual((self.helpers / video_helper.ASSET).read_bytes(), newer)
        self.assertFalse(video_helper.status()["updateAvailable"])


@unittest.skipIf(dashboard is None, "Flask is not installed")
class HelperRouteTests(TikTokCase):
    def setUp(self):
        super().setUp()
        storage.init_db()
        self.client = dashboard.app.test_client()

    def test_routes(self):
        status = self.client.get("/api/helpers/video").json
        self.assertEqual((status["ok"], status["installed"], status["enabled"]), (True, False, True))
        for body in ({}, {"action": "run"}, {"action": "install", "url": "x"}, ["install"]):
            self.assertEqual(self.client.post("/api/helpers/video", json=body).status_code, 400)
        self.assertEqual(self.client.post("/api/helpers/video", json={"action": "install"},
                                          headers={"Origin": "http://evil.invalid"}).status_code, 403)
        self.assertEqual(self.client.post("/api/helpers/video", data="action=install",
                                          content_type="application/x-www-form-urlencoded").status_code, 415)
        HelperInstallTests.release(self)
        answer = self.client.post("/api/helpers/video", json={"action": "install"})
        self.assertEqual(answer.status_code, 202)
        self.assertTrue(video_helper.wait_idle(20))
        self.assertTrue(self.client.get("/api/helpers/video").json["installed"])
        removed = self.client.post("/api/helpers/video", json={"action": "remove"})
        self.assertEqual((removed.status_code, removed.json["installed"]), (200, False))
        with patch.object(archive, "ENABLED", False):
            self.assertEqual(self.client.post("/api/helpers/video", json={"action": "install"}).status_code, 503)


if __name__ == "__main__":
    unittest.main(verbosity=1)
