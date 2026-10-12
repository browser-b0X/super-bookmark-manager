"""Share a shelf: the picture route the export uses. Synthetic data only.

Run: python -B frontend/tests/share_backend.py
"""
import unittest

from archive_backend import BASE_URL, CDN, JPEG, PNG, ArchiveCase, dashboard, storage


@unittest.skipIf(dashboard is None, "Flask is not installed")
class SharePictureTests(ArchiveCase):
    def setUp(self):
        super().setUp()
        storage.init_db()
        self.client = dashboard.app.test_client()
        self.image("/pic.png", PNG, "image/png")
        self.image("/photo.jpg", JPEG, "application/octet-stream")
        self.http.html("/page", "<title>not a picture</title>")

    def post(self, body, **kw):
        return self.client.post("/api/share/picture", json=body, **kw)

    def test_pictures_come_back_checked_by_their_bytes(self):
        answer = self.post({"url": CDN + "/pic.png"})
        self.assertEqual((answer.status_code, answer.mimetype, answer.data), (200, "image/png", PNG))
        self.assertEqual(answer.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(answer.headers["Cache-Control"], "no-store")
        jpeg = self.post({"url": CDN + "/photo.jpg"})
        self.assertEqual((jpeg.status_code, jpeg.mimetype), (200, "image/jpeg"), "the bytes decide, not the label")
        self.assertEqual(self.post({"url": BASE_URL + "/page"}).status_code, 415)

    def test_refusals(self):
        for body in ({}, {"url": ""}, {"url": 5}, {"url": CDN + "/pic.png", "extra": 1}):
            self.assertEqual(self.post(body).status_code, 400, body)
        for url in ("http://127.0.0.1:5001/api/stats", "file:///etc/passwd", "javascript:alert(1)", "http://10.0.0.1/x.png"):
            self.assertEqual(self.post({"url": url}).status_code, 400, url)
        self.assertEqual(self.post({"url": CDN + "/pic.png"}, headers={"Origin": "http://evil.invalid"}).status_code, 403)
        self.assertEqual(self.client.post("/api/share/picture", data="url=x", content_type="application/x-www-form-urlencoded").status_code, 415)
        self.assertIn(self.client.get("/api/share/picture?url=" + CDN + "/pic.png").status_code, (404, 405), "never a plain link")


if __name__ == "__main__":
    unittest.main(verbosity=1)
