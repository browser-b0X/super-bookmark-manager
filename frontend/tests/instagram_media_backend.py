"""Instagram pictures and video handed over from the owner's tab (v0.4.0 phase 4): the Save window uploads
the files the extension fetched there, and the copy is made from them, the video beside it, so the app
doesn't fetch them from Instagram. Synthetic data only; Instagram's picture hosts point at the loopback
fixture, and nothing reaches instagram.com.

Run: python -B frontend/tests/instagram_media_backend.py
"""
import hashlib
import os
import time
import unittest
from unittest.mock import patch

from archive_backend import CDN, JPEG, PNG, dashboard, storage
from instagram_backend import POST_URL, InstagramCase, data
import archive
import instagram_post

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 4000
BIG_JPEG = JPEG + b"\x00" * 3000
ONE = f"{CDN}/v/t51/one.jpg?stp=dst-jpg"
TWO = f"{CDN}/v/t51/two.jpg"


def sha(content):
    return hashlib.sha256(content).hexdigest()


@unittest.skipIf(dashboard is None, "Flask is not installed")
class UploadRoute(InstagramCase):
    def setUp(self):
        super().setUp()
        storage.init_db()
        self.client = dashboard.app.test_client()

    def upload(self, body, kind="application/octet-stream", **headers):
        return self.client.post("/api/archive/media", data=body, headers={"Content-Type": kind, **headers})

    def test_the_save_window_uploads_a_picture_or_a_video(self):
        picture = self.upload(BIG_JPEG, "image/jpeg")
        self.assertEqual(picture.status_code, 200, picture.json)
        self.assertEqual(picture.json, {"ok": True, "id": sha(BIG_JPEG), "kind": "picture", "bytes": len(BIG_JPEG)})
        video = self.upload(MP4, "video/mp4")
        self.assertEqual((video.json["kind"], video.json["id"]), ("video", sha(MP4)))
        self.assertTrue(os.path.isfile(os.path.join(archive.ARCHIVE_DIR, "incoming", sha(MP4))))
        self.assertEqual(self.upload(MP4, "video/mp4").json["id"], sha(MP4), "the same file twice is one upload")

    def test_only_the_apps_own_pages_and_only_pictures_or_videos(self):
        for headers in ({"Origin": "https://www.instagram.com"}, {"Origin": "http://evil.invalid"}, {"Sec-Fetch-Site": "cross-site"},
                        {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.upload(BIG_JPEG, "image/jpeg", **headers).status_code, 403)
        self.assertEqual(self.upload(b"<html><script>x()</script></html>", "image/jpeg").status_code, 415, "not a picture or a video")
        self.assertEqual(self.upload(b"", "image/jpeg").status_code, 400)
        self.assertEqual(self.upload(BIG_JPEG, "text/plain").status_code, 415)
        with patch.object(archive, "VIDEO_LIMIT", 2000):
            self.assertEqual(self.upload(MP4, "video/mp4").status_code, 413)
        with patch.object(archive, "IMAGE_LIMIT", 1000):
            self.assertEqual(self.upload(BIG_JPEG, "image/jpeg").status_code, 413)
        with patch.object(archive, "ENABLED", False):
            self.assertEqual(self.upload(BIG_JPEG, "image/jpeg").status_code, 503)
        self.assertEqual(os.listdir(os.path.join(archive.ARCHIVE_DIR, "incoming")) if os.path.isdir(os.path.join(archive.ARCHIVE_DIR, "incoming")) else [], [])

    def test_uploads_wait_two_hours_at_most_and_have_a_ceiling(self):
        first = self.upload(BIG_JPEG, "image/jpeg").json["id"]
        path = os.path.join(archive.ARCHIVE_DIR, "incoming", first)
        old = time.time() - archive.UPLOAD_LIFETIME - 60
        os.utime(path, (old, old))
        self.upload(MP4, "video/mp4")
        self.assertFalse(os.path.exists(path), "an upload no copy asked for in two hours is removed")
        with patch.object(archive, "UPLOADS_LIMIT", len(MP4) + 10):
            self.assertEqual(self.upload(BIG_JPEG, "image/jpeg").status_code, 507, "past the ceiling: refused until some are used or expire")


class CopyFromUploads(InstagramCase):
    def put(self, content):
        return archive.store_upload(content)["id"]

    def test_pictures_and_the_video_come_from_the_uploads_not_from_instagram(self):
        one, film = self.put(BIG_JPEG), self.put(MP4)
        record = archive.save_copy(POST_URL, post=data(pictures=[ONE], video=True, files={"pictures": {ONE: one}, "video": film}))
        self.assertEqual((record["kind"], record["images"], record["video"]), ("instagram-post", 1, True))
        self.assertEqual(self.paths(), [], "nothing fetched from the picture host")
        self.assertEqual((self.store / f"{self.key}.mp4").read_bytes(), MP4, "the video beside the copy")
        document = (self.store / f"{self.key}.html").read_text()
        self.assertIn(f'src="{self.key}.mp4"', document)
        self.assertNotIn("The video needs", document)
        self.assertEqual(record["thumbnail"], "/thumb/CfixTure123", "the preview made from the uploaded picture")
        self.assertEqual(os.listdir(self.store / "incoming"), [], "uploads used by the copy are removed")

    def test_a_picture_the_tab_couldnt_hand_over_is_fetched_as_before(self):
        one = self.put(BIG_JPEG)
        record = archive.save_copy(POST_URL, post=data(pictures=[ONE, TWO], files={"pictures": {ONE: one}, "video": ""}))
        self.assertEqual(record["images"], 2)
        self.assertEqual(self.paths(), ["/v/t51/two.jpg"], "only the picture without an upload")
        gone = data(pictures=[ONE], files={"pictures": {ONE: sha(b"never uploaded")}, "video": ""})
        self.assertEqual(archive.save_copy(POST_URL, post=gone)["images"], 1, "an upload that expired: fetched as before")

    def test_what_the_copy_says_about_a_video_it_hasnt_got(self):
        cases = {
            "too_large": "The video is bigger than 50 MB, so only its cover picture was kept.",
            "unavailable": "The video didn't come through from your tab, so only its cover picture was kept.",
            "not_on_page": "The page didn't hold the video's file, so only its cover picture was kept.",
            "": "This is a video post: its cover picture is saved. To keep the video too, save it with the SuperBookmarks extension from the open post.",
        }
        for marker, note in cases.items():
            with self.subTest(marker=marker):
                record = archive.save_copy(POST_URL, post=data(pictures=[ONE], video=True, files={"pictures": {}, "video": marker}))
                self.assertFalse(record.get("video"), "a record says video only when there is one")
                document = (self.store / f"{self.key}.html").read_text()
                self.assertIn(note, document)
                self.assertNotIn("<video", document)
                self.assertFalse((self.store / f"{self.key}.mp4").exists())
        # The extension read a video post whose page held no file of it, and no picture either (2026-11-08).
        archive.save_copy(POST_URL, post=data(pictures=[], video=True, files={"pictures": {}, "video": "not_on_page"}))
        self.assertIn("The page didn't hold the video's file, so the video isn't kept.", (self.store / f"{self.key}.html").read_text())
        # A file that isn't a video is not kept as one.
        fake = self.put(BIG_JPEG)
        record = archive.save_copy(POST_URL, post=data(pictures=[ONE], video=True, files={"pictures": {}, "video": fake}))
        self.assertFalse(record.get("video"), "a record says video only when there is one")

    def test_uploads_no_copy_used_dont_stay(self):
        # Reading uploads clears out ones older than two hours (not only the next upload does).
        old = self.put(BIG_JPEG)
        path = self.store / "incoming" / old
        stamp = time.time() - archive.UPLOAD_LIFETIME - 60
        os.utime(path, (stamp, stamp))
        self.assertIsNone(archive.uploaded(sha(b"something else")))
        self.assertFalse(path.exists())
        # A copy that fails takes the uploads it named with it.
        one, film = self.put(BIG_JPEG), self.put(MP4)
        with patch.object(archive, "FILE_LIMIT", 1000), self.assertRaises(archive.ArchiveError) as caught:
            archive.save_copy(POST_URL, post=data(pictures=[ONE], video=True, files={"pictures": {ONE: one}, "video": film}))
        self.assertEqual(caught.exception.code, "copy_too_large")
        self.assertEqual(os.listdir(self.store / "incoming"), [])

    def test_waiting_uploads_count_in_the_copies_disk_use(self):
        before = archive.summary()["bytes"]
        self.put(MP4)
        self.assertEqual(archive.summary()["bytes"], before + len(MP4))

    def test_the_files_field_is_checked(self):
        good = {"pictures": {ONE: "a" * 64}, "video": "b" * 64}
        instagram_post.parse(POST_URL, data(pictures=[ONE], files=good))
        for bad in ({"pictures": {ONE: "not-a-hash"}, "video": ""}, {"pictures": {"https://evil.invalid/x.jpg": "a" * 64}, "video": ""},
                    {"pictures": {TWO: "a" * 64}, "video": ""}, {"pictures": [], "video": ""}, {"pictures": {}, "video": "x" * 64},
                    {"pictures": {}, "video": "", "extra": 1}, "files"):
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(instagram_post.PostDataError):
                instagram_post.parse(POST_URL, data(pictures=[ONE], files=bad))


if __name__ == "__main__":
    unittest.main(verbosity=1)
