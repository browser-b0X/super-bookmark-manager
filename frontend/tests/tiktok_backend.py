"""Saved copies of TikTok posts and the optional video helper: synthetic data only.

Run: python -B frontend/tests/tiktok_backend.py
TikTok's oEmbed address, its picture hosts and yt-dlp's release address are
pointed at the owned loopback fixture. The "helper" is a small Python script
that behaves like yt-dlp; nothing is downloaded from GitHub and nothing
reaches tiktok.com.
"""
import hashlib
import json
import os
import stat
import sys
import time
import unittest
from unittest.mock import patch

from archive_backend import BASE_URL, CDN, JPEG, PNG, ROOT, ArchiveCase, archive, dashboard, storage
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


def oembed(**changes):
    data = {"version": "1.0", "type": "video", "title": "Overnight focaccia, the lazy way <script>x()</script> #bread",
            "author_name": "Kitchen <b>Notes</b>", "author_url": "https://www.tiktok.com/@kitchen.notes",
            "thumbnail_url": f"{CDN}/obj/cover.jpeg", "thumbnail_width": 720, "thumbnail_height": 1280,
            "html": "<blockquote><script src=\"https://www.tiktok.com/embed.js\"></script></blockquote>",
            "provider_name": "TikTok", "provider_url": "https://www.tiktok.com"}
    data.update(changes)
    return data


class TikTokCase(ArchiveCase):
    def setUp(self):
        super().setUp()
        self.helpers = ROOT / (self._testMethodName + "-helpers")
        self.helpers.mkdir()
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
        path.write_text(FAKE_HELPER)
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

    @unittest.skipIf(sys.platform == "win32", "process groups: the Windows path uses taskkill /T")
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


class HelperInstallTests(TikTokCase):
    def release(self, program=None, sums=None):
        program = FAKE_HELPER.encode() if program is None else program
        listed = hashlib.sha256(program).hexdigest()
        lines = sums if sums is not None else f"{'0' * 64}  yt-dlp_x86.exe\n{listed}  {video_helper.ASSET}\n{'1' * 64}  yt-dlp.tar.gz\n"
        self.http.routes["/rel/SHA2-256SUMS"] = (200, {"Content-Type": "text/plain"}, lines.encode())
        self.http.routes[f"/rel/{video_helper.ASSET}"] = (200, {"Content-Type": "application/octet-stream"}, program)

    def test_install_checks_the_checksum_and_runs_the_program(self):
        self.release()
        status = video_helper.install()
        self.assertEqual((status["installed"], status["version"], status["checksum"]), (True, "2026.08.19", True))
        self.assertEqual((self.helpers / video_helper.ASSET).read_bytes(), FAKE_HELPER.encode())
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
        newer = FAKE_HELPER.encode() + b"\n# newer release\n"
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
