"""New-link enrichment tests: synthetic bytes, guarded owned HTTP server only."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE))
sys.dont_write_bytecode = True
from metadata_fixture import BASE_URL, PUBLIC_IP, JPEG, ControlledHTTP, install_guard, GUARD_FAILURES

FIXTURE = tempfile.TemporaryDirectory(prefix="backend-fixture-", dir=WORKSPACE / ".verify" / "metadata-enrichment-20260924")
ROOT = Path(FIXTURE.name)
install_guard(ROOT)
os.environ["SAVED_POSTS_DB_PATH"] = str(ROOT / "synthetic.sqlite")
import metadata_fetcher as metadata
import app as dashboard
import storage

safe = None
if importlib.util.find_spec("safe_http"):
    import safe_http as safe


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.client = dashboard.app.test_client()

    def test_no_metadata_is_success(self):
        with patch.object(metadata, "fetch_metadata", return_value={"title": "", "thumbnail": "", "summary": "", "status": "empty", "error": ""}):
            response = self.client.post("/api/enrich", json={"url": BASE_URL})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["ok"], True)
        self.assertEqual([response.json[k] for k in ("title", "summary", "thumbnail")], ["", "", ""])

    def test_valid_nested_unused_json_does_not_affect_url(self):
        body = '{"url":"' + BASE_URL + '","extra":' + '[' * 2000 + '0' + ']' * 2000 + '}'
        with patch.object(metadata, "fetch_metadata", return_value={"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}) as call:
            response = self.client.post("/api/enrich", data=body, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["status"], "empty")
        call.assert_called_once_with(BASE_URL)

    def test_description_and_fixed_error(self):
        with patch.object(metadata, "fetch_metadata", return_value={"title": "T", "summary": "D", "thumbnail": "", "status": "ok", "error": ""}):
            response = self.client.post("/api/enrich", json={"url": BASE_URL})
        self.assertEqual(response.json["summary"], "D")
        with patch.object(metadata, "fetch_metadata", side_effect=RuntimeError("SECRET URL https://private.invalid")):
            response = self.client.post("/api/enrich", json={"url": BASE_URL})
        self.assertEqual(response.json["error"], "internal_error")
        self.assertNotIn("SECRET", response.get_data(as_text=True))

    def test_origin_and_bad_bodies(self):
        for origin in ("http://evil.invalid", "null", "http://localhost.evil.invalid", "http://localhost\\@evil.invalid"):
            with self.subTest(origin=origin), patch.object(metadata, "fetch_metadata") as call:
                self.assertEqual(self.client.post("/api/enrich", json={"url": BASE_URL}, headers={"Origin": origin}).status_code, 403)
                call.assert_not_called()
        for body in ("null", "[]", "1", '"str"', "{}", '{"url": 1}', '{"url": []}', '{"url": ""}', "{"):
            with self.subTest(body=body), patch.object(metadata, "fetch_metadata") as call:
                response = self.client.post("/api/enrich", data=body, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                call.assert_not_called()
        self.assertEqual(self.client.post("/api/enrich", data="url=x").status_code, 415)
        self.assertEqual(self.client.post("/api/enrich", data=" " * 17000, content_type="application/json").status_code, 413)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(safe, "Missing validated IP-pinned safe_http boundary")
        self.http = ControlledHTTP().__enter__()
        self.addCleanup(self.http.__exit__, None, None, None)
        self.cache = ROOT / self._testMethodName
        self.cache.mkdir()
        self.patch = patch.object(metadata, "THUMB_CACHE_DIR", str(self.cache))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        with metadata._flight_lock:
            metadata._recent.clear()
        self.guard_count = len(GUARD_FAILURES)

    def tearDown(self):
        if hasattr(self, "guard_count"):
            self.assertEqual(GUARD_FAILURES[self.guard_count:], [], "Production crossed synthetic isolation boundary")

    def fetch(self, path="/"):
        return metadata.fetch_metadata(BASE_URL + path)

    def test_og_order_entities_relative_and_no_generic_download(self):
        self.http.html("/article", '<TITLE>Document</TITLE><meta content="OG &amp; title" PROPERTY="og:title"><meta content="OG &quot;description&quot;" name="og:description"><meta name="description" content="fallback"><meta content="/preview.jpg?a=1&amp;b=2" property="og:image"><meta name="twitter:image" content="/wrong.jpg">')
        result = self.fetch("/article")
        self.assertEqual(result["title"], "OG & title")
        self.assertEqual(result["summary"], 'OG "description"')
        self.assertEqual(result["thumbnail"], BASE_URL + "/preview.jpg?a=1&b=2")
        self.assertEqual(len(self.http.requests), 1)
        self.assertEqual(result["status"], "ok")

    def test_connection_close_complete_bodies(self):
        bodies = [b"<title>Complete</title>", b"", b"<title>Complete</title>" + b" " * 70000]
        for index, body in enumerate(bodies):
            path = "/closed" + str(index)
            self.http.routes[path] = (200, {"Content-Type": "text/html", "Connection": "close"}, body)
            with self.subTest(index=index):
                result = self.fetch(path)
                self.assertEqual(result["error"], "")
                self.assertEqual(result["title"], "Complete" if body else "")

    def test_document_meta_twitter_and_malformed_html(self):
        self.http.html("/", '<title>Doc &amp; one</title><meta content="Description" name="description"><meta content="//cdn.fixture.test/a.png" name="twitter:image"><bad <markup>')
        result = self.fetch()
        self.assertEqual((result["title"], result["summary"], result["thumbnail"]), ("Doc & one", "Description", "http://cdn.fixture.test/a.png"))

    def test_no_metadata_and_direct_image(self):
        self.http.html("/", "<p>Only content</p>")
        self.http.routes["/image"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        for path in ("/", "/image"):
            with self.subTest(path=path):
                result = self.fetch(path)
                self.assertEqual(result["status"], "empty")
                self.assertEqual([result[k] for k in ("title", "summary", "thumbnail")], ["", "", ""])

    def test_invalid_and_ssrf_matrix(self):
        urls = ["http://localhost", "http://a.localhost/", "http://thing.local/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://10.1.2.3", "http://172.16.0.1", "http://192.168.1.1", "http://169.254.169.254", "http://169.254.1.2", "http://0.0.0.0", "http://224.0.0.1", "http://100.64.0.1", "http://[::1]", "http://[::]", "http://[fc00::1]", "http://[fe80::1]", "http://[::ffff:127.0.0.1]", "http://[::ffff:10.0.0.1]", "http://[ff02::1]", "http://[fe80::1%25eth0]", "file:///etc/passwd", "ftp://metadata.fixture.test", "/local/file", "C:/local/file", "http://user:pass@metadata.fixture.test", "http://metadata.fixture.test\\@127.0.0.1", "http://%31%32%37.0.0.1", "http://metadata.fixture.test\r\nX: x", "http://metadata.fixture.test:bad", "http://metadata.fixture.test:0", "http://metadata.fixture.test:65536", "http://[broken", "http:///missing", "http://metadata.fixture.test/%zz"]
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(metadata.fetch_metadata(url)["status"], "failed")
        self.assertEqual(self.http.connections, [])

    def test_mixed_dns_and_rebinding_pins_one_resolution(self):
        self.http.dns["metadata.fixture.test"] = [PUBLIC_IP, "127.0.0.1"]
        self.assertEqual(self.fetch()["error"], "blocked_url")
        self.assertEqual(self.http.connections, [])
        answers = iter([[PUBLIC_IP], ["127.0.0.1"]])
        self.http.dns["rebind.fixture.test"] = lambda: next(answers)
        result = metadata.fetch_metadata("http://rebind.fixture.test/a")
        self.assertEqual(result["status"], "empty")
        self.assertEqual([c[0] for c in self.http.connections], [PUBLIC_IP])
        self.assertEqual(len([c for c in self.http.dns_calls if c[0] == "rebind.fixture.test"]), 1)
        self.assertEqual(metadata.fetch_metadata("http://rebind.fixture.test/b")["error"], "blocked_url")

    def test_redirects_revalidated_and_limited(self):
        self.http.routes["/allowed"] = (302, {"Location": "/done"}, b"")
        self.http.html("/done", '<title>Redirected</title><meta property="og:image" content="image.png">')
        self.assertEqual(self.fetch("/allowed")["title"], "Redirected")
        self.http.routes["/blocked"] = (302, {"Location": "http://169.254.169.254/latest"}, b"")
        self.assertEqual(self.fetch("/blocked")["error"], "blocked_url")
        self.http.routes["/loop"] = (302, {"Location": "/loop"}, b"")
        before = len(self.http.requests)
        self.assertEqual(self.fetch("/loop")["error"], "redirect_limit")
        self.assertEqual(len(self.http.requests) - before, 4)

    def test_image_target_blocked_without_losing_title(self):
        self.http.html("/", '<title>Keep me</title><meta property="og:image" content="http://127.0.0.1/private">')
        result = self.fetch()
        self.assertEqual(result["title"], "Keep me")
        self.assertEqual(result["thumbnail"], "")
        self.assertEqual(len(self.http.connections), 1)

    def test_oversize_declared_streamed_chunked_and_encoding(self):
        self.http.routes["/length"] = (200, {"Content-Type": "text/html", "Content-Length": str(512 * 1024 + 1)}, b"")
        self.http.routes["/chunked"] = (200, {"Content-Type": "text/html", "Transfer-Encoding": "chunked"}, b"80001\r\n" + b"x" * (512 * 1024 + 1) + b"\r\n0\r\n\r\n")
        def stream(handler):
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(b"x" * (512 * 1024 + 1))
            handler.close_connection = True
        self.http.routes["/stream"] = stream
        self.http.routes["/gzip"] = (200, {"Content-Encoding": "gzip"}, b"fake compressed")
        for path in ("/length", "/chunked", "/stream"):
            with self.subTest(path=path):
                self.assertEqual(self.fetch(path)["error"], "too_large")
        self.assertEqual(self.fetch("/gzip")["error"], "network_error")

    def test_http_error_sanitized_and_cookie_proxy_auth_absent(self):
        self.http.routes["/secret"] = (403, {}, b"PRIVATE SECRET")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = self.fetch("/secret")
        self.assertEqual(result["error"], "http_error")
        self.assertEqual(output.getvalue(), "")
        self.http.routes["/cookie"] = (302, {"Location": "/clean", "Set-Cookie": "secret=value"}, b"")
        with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1", "NETRC": "C:/forbidden"}):
            self.fetch("/cookie")
        for _, headers in self.http.requests:
            self.assertEqual(headers["User-Agent"], "SavedPostsMetadata/1.0")
            self.assertEqual(headers["Host"], "metadata.fixture.test")
            self.assertFalse({h.lower() for h in headers} & {"cookie", "authorization", "proxy-authorization"})
            self.assertEqual(headers["Accept-Encoding"], "identity")

    def test_wall_deadline_stops_header_drip(self):
        def drip(handler):
            for byte in b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n":
                handler.wfile.write(bytes([byte]))
                handler.wfile.flush()
                if self.http.stop.wait(0.06):
                    return
        self.http.routes["/drip"] = drip
        start = time.monotonic()
        with self.assertRaises(safe.SafeHTTPError) as caught:
            safe.get(BASE_URL + "/drip", deadline=time.monotonic() + 0.3)
        self.assertEqual(caught.exception.code, "timeout")
        self.assertLess(time.monotonic() - start, 1.0)

    def test_dns_deadline_and_fixed_worker_bound(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.http.dns["metadata.fixture.test"] = lambda: (release.wait(2), [PUBLIC_IP])[1]
        start = time.monotonic()
        with self.assertRaises(safe.SafeHTTPError) as caught:
            safe.get(BASE_URL, deadline=time.monotonic() + 0.1)
        self.assertEqual(caught.exception.code, "timeout")
        self.assertLess(time.monotonic() - start, 0.8)
        self.assertLessEqual(len([t for t in threading.enumerate() if t.name.startswith("metadata-dns-")]), 3)
        release.set()

    def test_tls_uses_original_hostname_and_default_verification(self):
        real_context = safe.ssl.create_default_context
        seen = []
        class TLSContext:
            def wrap_socket(self, sock, server_hostname, do_handshake_on_connect):
                from metadata_fixture import PlainTLSSocket
                self_outer.assertFalse(do_handshake_on_connect)
                seen.append(server_hostname)
                return PlainTLSSocket(sock)
        self_outer = self
        with patch.object(safe.ssl, "create_default_context", return_value=TLSContext()) as context:
            result = safe.get("https://metadata.fixture.test/tls")
        self.assertEqual(result.status, 200)
        self.assertEqual(seen, ["metadata.fixture.test"])
        context.assert_called_once_with()
        self.assertEqual(real_context().verify_mode, safe.ssl.CERT_REQUIRED)
        self.assertEqual(self.http.connections[0][0:2], (PUBLIC_IP, 443))

    def test_instagram_cache_magic_size_and_no_remote_fallback(self):
        self.http.html("/p/TestCode/", '<title>Instagram</title><meta property="og:image" content="http://cdn.fixture.test/good.jpg">')
        self.http.routes["/good.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        result = metadata.fetch_metadata("http://www.instagram.com/p/TestCode/")
        self.assertEqual(result["thumbnail"], "/thumb/TestCode")
        self.assertEqual((self.cache / "TestCode").read_bytes(), JPEG)
        self.assertFalse(list(self.cache.glob("*.tmp")))
        self.assertEqual(self.http.requests[0][1]["User-Agent"], "facebookexternalhit/1.1")
        count = len(self.http.requests)
        self.assertEqual(metadata._cache_instagram_thumb("http://cdn.fixture.test/good.jpg", "http://www.instagram.com/p/TestCode/"), "/thumb/TestCode")
        self.assertEqual(len(self.http.requests), count)
        cases = [("mime", "text/html", JPEG), ("magic", "image/jpeg", b"<html>" * 300), ("tiny", "image/jpeg", b"\xff\xd8\xff"), ("large", "image/jpeg", JPEG)]
        for name, mime, body in cases:
            headers = {"Content-Type": mime}
            if name == "large":
                headers["Content-Length"] = str(4 * 1024 * 1024 + 1)
            self.http.routes["/" + name] = (200, headers, body)
            self.http.html("/p/BadCode" + name + "/", '<meta property="og:image" content="http://cdn.fixture.test/' + name + '">')
            result = metadata.fetch_metadata("http://www.instagram.com/p/BadCode" + name + "/")
            self.assertEqual(result["thumbnail"], "")
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), ["TestCode"])

    def test_instagram_deterministic_key_and_host_matching(self):
        url = "http://www.instagram.com/no-post?x=1"
        import hashlib
        self.assertEqual(metadata._ig_post_code(url), "ig_" + hashlib.sha256(url.encode()).hexdigest()[:24])
        self.assertFalse(metadata._is_instagram("http://metadata.fixture.test/?instagram.com/p/BadCode"))
        self.assertFalse(metadata._is_youtube("http://notyoutube.com/watch?v=abcdefghijk"))

    def test_instagram_repair_existing_and_new_cache_synthetic_sqlite(self):
        db = self.cache / "repair.sqlite"
        with patch.object(storage.config, "DB_PATH", str(db)):
            storage.init_db()
            with sqlite3.connect(db) as conn:
                for number, code in enumerate(("CachedCode", "FreshCode"), 1):
                    conn.execute("INSERT INTO saved_posts(tg_msg_id,date_utc,url,title,thumbnail,created_at) VALUES(?,?,?,?,?,?)", (number, "2026-09-24", "http://www.instagram.com/p/" + code + "/", "Curated " + code, "https://cdninstagram.com/expired", "2026-09-24T00:00:00Z"))
            (self.cache / "CachedCode").write_bytes(JPEG)
            self.http.html("/p/FreshCode/", '<title>Remote title</title><meta property="og:image" content="http://cdn.fixture.test/good.jpg">')
            self.http.routes["/good.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
            self.assertEqual(metadata.refresh_instagram_thumbnails(), 2)
            with sqlite3.connect(db) as conn:
                self.assertEqual(conn.execute("SELECT title,thumbnail FROM saved_posts ORDER BY tg_msg_id").fetchall(), [("Curated CachedCode", "/thumb/CachedCode"), ("Curated FreshCode", "/thumb/FreshCode")])
        self.assertEqual(len(self.http.requests), 2)

    def test_youtube_oembed_and_thumbnail(self):
        endpoint = "/oembed?url=https://www.youtube.com/watch?v=abcdefghijk&format=json"
        self.http.routes[endpoint] = (200, {"Content-Type": "application/json"}, b'{"title":"Synthetic video"}')
        # TLS arguments are separately checked; cryptography is not exercised here.
        class TLSContext:
            def wrap_socket(self, sock, server_hostname, do_handshake_on_connect):
                from metadata_fixture import PlainTLSSocket
                return PlainTLSSocket(sock)
        with patch.object(safe.ssl, "create_default_context", return_value=TLSContext()):
            result = metadata.fetch_metadata("http://www.youtube.com/watch?feature=x&v=abcdefghijk")
        self.assertEqual(result["title"], "Synthetic video")
        self.assertEqual(result["thumbnail"], "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg")
        self.assertEqual([r[0] for r in self.http.requests], [endpoint])

    def test_same_url_coalescing_cooldown_and_three_request_cap(self):
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        def held(handler):
            entered.set()
            release.wait(2)
            body = b"<title>Shared</title>"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        self.http.routes["/same"] = held
        with ThreadPoolExecutor(max_workers=6) as pool:
            first = pool.submit(self.fetch, "/same")
            self.assertTrue(entered.wait(1))
            rest = [pool.submit(self.fetch, "/same") for _ in range(5)]
            release.set()
            results = [first.result()] + [f.result() for f in rest]
        self.assertTrue(all(r["title"] == "Shared" for r in results))
        self.assertEqual(self.fetch("/same")["title"], "Shared")
        self.assertEqual(len(self.http.requests), 1)
        release.clear()
        entered.clear()
        for n in range(4):
            self.http.routes[f"/cap{n}"] = held
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.fetch, f"/cap{n}") for n in range(3)]
            limit = time.monotonic() + 1
            while len(self.http.requests) < 4 and time.monotonic() < limit:
                threading.Event().wait(0.01)
            self.assertEqual(self.fetch("/cap3")["error"], "busy")
            release.set()
            self.assertTrue(all(f.result()["title"] == "Shared" for f in futures))
        self.assertLessEqual(len(metadata._recent), 128)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        FIXTURE.cleanup()
