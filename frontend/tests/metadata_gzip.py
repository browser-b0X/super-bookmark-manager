"""Bounded gzip continuation; owned synthetic transport, no live providers."""
import gzip
import json
import sqlite3
import time
import unittest
from unittest.mock import patch

import metadata_backend as base

safe, metadata = base.safe, base.metadata


class GzipTests(base.BoundaryTests):
    def route(self, path, body, encoding="gzip", mime="text/html; charset=utf-8"):
        self.http.routes[path] = (200, {"Content-Encoding": encoding, "Content-Type": mime}, body)

    def test_gzip_parity_matrix(self):
        cases = [
            (b"<title>Small</title>", "utf-8"),
            ('<title>Document</title><meta property="og:title" content="Caf\u00e9"><meta name="description" content="fallback"><meta property="og:description" content="OG description"><meta property="og:image" content="/preview.png">'.encode(), "utf-8"),
            (b'<title>Caf\xe9</title><meta name="description" content="Cr\xe8me">', "iso-8859-1"),
            (b"", "utf-8"),
            (b'<title>Recovered</title><bad <markup><meta name="description" content="Text">', "utf-8"),
        ]
        for index, (raw, charset) in enumerate(cases):
            with self.subTest(index=index):
                mime = "text/html; charset=" + charset
                self.route(f"/plain{index}", raw, "identity", mime)
                self.route(f"/gzip{index}", gzip.compress(raw, mtime=0), "GZip", mime)
                expected = self.fetch(f"/plain{index}")
                self.assertEqual(self.fetch(f"/gzip{index}"), expected)
                self.assertNotEqual(expected["status"], "failed")
                if index == 1:
                    self.assertEqual((expected["title"], expected["summary"], expected["thumbnail"]),
                                     ("Caf\u00e9", "OG description", base.BASE_URL + "/preview.png"))
                if index == 2:
                    self.assertEqual((expected["title"], expected["summary"]), ("Caf\u00e9", "Cr\u00e8me"))
                if index == 3:
                    self.assertEqual(expected["status"], "empty")

    def test_invalid_gzip_no_partial_write_or_retry_storm(self):
        raw = b'<title>Must not escape</title>'
        valid = gzip.compress(raw, mtime=0)
        corrupt = bytearray(valid)
        corrupt[-8] ^= 255
        bomb = gzip.compress(b"x" * (safe.HTML_LIMIT + 1), mtime=0)
        cases = [valid[:-4], bytes(corrupt), b"bad gzip", b"", valid + b"garbage", valid + valid, bomb]
        base.storage.init_db()
        db = base.os.environ["SAVED_POSTS_DB_PATH"]
        # Persist through the actual Library API before attempting rejected enrichment.
        client = base.dashboard.app.test_client()
        post = {"id": "gzip-curated", "url": base.BASE_URL + "/rejected", "title": "Owner title",
                "userNotes": "Keep note", "tags": ["MixedCase"], "favorite": True, "status": "archived",
                "categories": ["other"], "categoryMode": "manual", "platform": "web", "mediaType": "article",
                "domain": "metadata.fixture.test", "projectIds": [], "metadataStatus": "partial",
                "source": "browser", "createdAt": "2026-09-25T00:00:00Z",
                "updatedAt": "2026-09-25T00:00:00Z"}
        posts = [dict(post, id=f"gzip-{i}", url=post["url"] + str(i)) for i in range(len(cases))]
        response = client.post("/api/library", json={"posts": posts, "deletedUrls": []})
        self.assertEqual(response.status_code, 200, response.json)
        before = client.get("/api/library").json
        for index, payload in enumerate(cases):
            path = f"/rejected{index}"
            self.route(path, payload)
            with self.subTest(index=index):
                count = len(self.http.requests)
                first = client.post("/api/enrich", json={"url": base.BASE_URL + path})
                self.assertEqual(first.status_code, 502)
                self.assertEqual(first.json["error"], "too_large" if index == 6 else "network_error")
                self.assertEqual([first.json[k] for k in ("title", "summary", "thumbnail")], ["", "", ""])
                second = client.post("/api/enrich", json={"url": base.BASE_URL + path})
                self.assertEqual(second.json, first.json)
                self.assertEqual(len(self.http.requests) - count, 1)
                self.assertEqual(client.get("/api/library").json, before)
        with sqlite3.connect(db) as conn:
            for item in posts:
                stored = json.loads(conn.execute("SELECT document FROM library_items WHERE url=?", (item["url"],)).fetchone()[0])
                for key in item:
                    self.assertEqual(stored[key], item[key])

    def test_bomb_output_allocation_and_stop_bound(self):
        raw = b"x" * (safe.HTML_LIMIT + 1)
        packed = gzip.compress(raw, mtime=0)
        self.assertLess(len(packed), safe.HTML_LIMIT)
        self.route("/bomb-proof", packed)
        calls = []
        original = safe.zlib.decompressobj
        class Observed:
            def __init__(self, *args):
                self.inner = original(*args)
            def decompress(self, data, max_length):
                result = self.inner.decompress(data, max_length)
                calls.append({"input": len(data), "max_output": max_length, "output": len(result)})
                return result
            def __getattr__(self, name):
                return getattr(self.inner, name)
        with patch.object(safe.zlib, "decompressobj", Observed):
            self.assertEqual(self.fetch("/bomb-proof")["error"], "too_large")
        self.assertEqual(sum(c["output"] for c in calls), safe.HTML_LIMIT + 1)
        self.assertTrue(all(c["output"] <= c["max_output"] <= safe.HTML_LIMIT + 1 for c in calls))
        self.assertEqual(len(calls), 1)
        print("BOMB_PROOF " + json.dumps({"compressed": len(packed), "decompressed": len(raw), "limit": safe.HTML_LIMIT, "calls": calls,
              "allocation_bound": "body <= limit+1, output <= remaining+1, wire chunk <=65536; no unbounded flush"}))

    def test_streamed_gzip_boundary_and_wire_limit(self):
        def stream(body):
            def handler(h):
                h.send_response(200)
                h.send_header("Content-Encoding", "gzip")
                h.send_header("Connection", "close")
                h.end_headers()
                for offset in range(0, len(body), 17):
                    h.wfile.write(body[offset:offset + 17])
                h.close_connection = True
            return handler
        raw = base.os.urandom(90000)
        self.http.routes["/stream-gzip"] = stream(gzip.compress(raw, mtime=0))
        self.assertEqual(safe.get(base.BASE_URL + "/stream-gzip").body, raw)
        self.http.routes["/stream-bomb"] = stream(gzip.compress(b"x" * (safe.HTML_LIMIT + 1), mtime=0))
        self.assertEqual(self.fetch("/stream-bomb")["error"], "too_large")
        self.route("/exact", gzip.compress(b"x" * safe.HTML_LIMIT, mtime=0))
        self.assertEqual(len(safe.get(base.BASE_URL + "/exact").body), safe.HTML_LIMIT)
        self.route("/wire", b"x" * (safe.HTML_LIMIT + 1))
        self.assertEqual(self.fetch("/wire")["error"], "too_large")

    def test_unsupported_encoding_and_binary_content(self):
        for index, encoding in enumerate(["br", "gzip, br", "gzip,gzip", "gzip;foo", "g zip", "unknown"]):
            path = f"/encoding{index}"
            self.route(path, gzip.compress(b"<title>Never</title>"), encoding)
            self.assertEqual(self.fetch(path)["error"], "unsupported_encoding")
        self.route("/binary", gzip.compress(b"<title>Not HTML</title>"), mime="application/octet-stream")
        self.assertEqual(self.fetch("/binary")["status"], "empty")


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        base.FIXTURE.cleanup()
