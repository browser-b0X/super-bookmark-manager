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

(WORKSPACE / ".verify" / "metadata-enrichment-20260924").mkdir(parents=True, exist_ok=True)
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


def page_requests(http):
    """Requests other than the once-per-site icon lookup."""
    return [r for r in http.requests if r[0] != "/favicon.ico"]


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
        with metadata._favicon_lock:
            metadata._favicons.clear()
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
        # The preview image is fetched once to cache it locally; when that fails
        # (here: not an image) the remote URL is kept. The site icon is tried too.
        self.assertEqual(result["thumbnail"], BASE_URL + "/preview.jpg?a=1&b=2")
        paths = [r[0] for r in self.http.requests]
        self.assertEqual(paths[:2], ["/article", "/preview.jpg?a=1&b=2"])
        self.assertTrue(set(paths[2:]) <= {"/favicon.ico"}, paths)
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
        # Only the page (and the once-per-site icon) were ever connected to.
        self.assertEqual(len(self.http.connections), len(self.http.requests))
        self.assertTrue({r[0] for r in self.http.requests} <= {"/", "/favicon.ico"})

    def test_measured_social_shell_is_not_rejected_as_too_large(self):
        head = b'<meta property="og:title" content="Real caption">'
        body = head + b" " * (636_955 - len(head))
        self.assertEqual(len(body), 636_955)
        self.http.routes["/shell"] = (200, {"Content-Type": "text/html", "Content-Length": str(len(body))}, body)
        result = self.fetch("/shell")
        self.assertEqual(result["error"], "")
        self.assertEqual(result["title"], "Real caption")

    def test_oversize_declared_streamed_chunked_and_encoding(self):
        self.http.routes["/length"] = (200, {"Content-Type": "text/html", "Content-Length": str(safe.HTML_LIMIT + 1)}, b"")
        self.http.routes["/chunked"] = (200, {"Content-Type": "text/html", "Transfer-Encoding": "chunked"}, format(safe.HTML_LIMIT + 1, "x").encode() + b"\r\n" + b"x" * (safe.HTML_LIMIT + 1) + b"\r\n0\r\n\r\n")
        def stream(handler):
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(b"x" * (safe.HTML_LIMIT + 1))
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
            self.assertEqual(headers["User-Agent"], "Mozilla/5.0 (compatible; SuperBookmarkManager/0.1; +link preview)")
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

    def test_instagram_login_wall_falls_back_to_public_embed(self):
        self.http.html("/reel/WallCode1/", '<title>Instagram</title><meta property="og:title" content="Instagram">')
        self.http.html("/p/WallCode1/embed/captioned/", '<div class="Embed"><a class="Username" href="#"><span>chef.ana</span></a>'
                       '<img class="EmbeddedMediaImage" alt="" src="http://cdn.fixture.test/embed.jpg?a=1&amp;b=2">'
                       '<div class="Caption"><a class="CaptionUsername">chef.ana</a> Lemon cake<br>6 ingredients &amp; honey</div></div>')
        self.http.routes["/embed.jpg?a=1&b=2"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        with EnrichmentDepthTests._plain_tls(self):
            result = metadata.fetch_metadata("http://www.instagram.com/reel/WallCode1/")
        self.assertEqual(result["thumbnail"], "/thumb/WallCode1")
        self.assertIn("6 ingredients & honey", result["summary"])
        self.assertEqual(result.get("author"), "chef.ana")
        # An image the embed does not have leaves the card to its styled fallback.
        self.http.html("/reel/WallCode2/", '<title>Instagram</title>')
        self.http.html("/p/WallCode2/embed/captioned/", '<div>Sorry, this content is unavailable</div>')
        with EnrichmentDepthTests._plain_tls(self):
            self.assertEqual(metadata.fetch_metadata("http://www.instagram.com/reel/WallCode2/")["thumbnail"], "")

    def test_social_pages_retry_once_as_the_whatsapp_preview_crawler(self):
        self.http.dns["www.facebook.com"] = [PUBLIC_IP]
        seen = []
        self.http.routes["/lisbonwalks/posts/1"] = (200, {"Content-Type": "text/html"}, b"<title>Log in</title>")
        real_get = metadata.safe_http.get
        def by_agent(url, deadline=None, headers=None, **kw):
            seen.append(headers["User-Agent"])
            if headers["User-Agent"].startswith("WhatsApp/"):
                self.http.routes["/lisbonwalks/posts/1"] = (200, {"Content-Type": "text/html"},
                    b'<meta property="og:title" content="Lisbon Walks"><meta property="og:description" content="Pastel de nata walk this weekend">'
                    b'<meta property="og:image" content="http://cdn.fixture.test/fb.jpg">')
            return real_get(url, deadline=deadline, headers=headers, **kw)
        self.http.routes["/fb.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        with patch.object(metadata.safe_http, "get", side_effect=by_agent), EnrichmentDepthTests._plain_tls(self):
            result = metadata.fetch_metadata("http://www.facebook.com/lisbonwalks/posts/1")
        self.assertTrue(result["thumbnail"].startswith("/thumb/img_"))
        self.assertEqual((result["title"], result["summary"]), ("Lisbon Walks", "Pastel de nata walk this weekend"))
        self.assertTrue(seen[0].startswith("Mozilla/") and any(a.startswith("WhatsApp/") for a in seen))
        # Ordinary sites never get the crawler retry.
        seen.clear()
        self.http.html("/plain", "<title>Plain page</title>")
        with patch.object(metadata.safe_http, "get", side_effect=by_agent):
            self.fetch("/plain")
        self.assertFalse(any(a.startswith("WhatsApp/") for a in seen))

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
        self.assertEqual(len(page_requests(self.http)), 1)
        release.clear()
        entered.clear()
        for n in range(4):
            self.http.routes[f"/cap{n}"] = held
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.fetch, f"/cap{n}") for n in range(3)]
            limit = time.monotonic() + 1
            while len(page_requests(self.http)) < 4 and time.monotonic() < limit:
                threading.Event().wait(0.01)
            self.assertEqual(self.fetch("/cap3")["error"], "busy")
            release.set()
            self.assertTrue(all(f.result()["title"] == "Shared" for f in futures))
        self.assertLessEqual(len(metadata._recent), 128)


class EnrichmentDepthTests(unittest.TestCase):
    """Audit phase 3: charset, title, rich fields, local preview cache."""
    setUp = BoundaryTests.setUp
    tearDown = BoundaryTests.tearDown
    fetch = BoundaryTests.fetch

    def test_meta_charset_is_honoured_without_a_header_charset(self):
        body = '<meta charset="windows-1251"><title>Привет мир</title>'.encode("cp1251")
        self.http.routes["/cyr"] = (200, {"Content-Type": "text/html"}, body)
        self.assertEqual(self.fetch("/cyr")["title"], "Привет мир")
        body = '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>日本語のページ</title>'.encode("shift_jis")
        self.http.routes["/sjis"] = (200, {"Content-Type": "text/html"}, body)
        self.assertEqual(self.fetch("/sjis")["title"], "日本語のページ")

    def test_only_the_document_title_counts(self):
        self.http.html("/svg", '<title>My Article</title><body><svg><title>Close</title></svg><svg><title>Menu</title></svg>')
        self.assertEqual(self.fetch("/svg")["title"], "My Article")
        self.http.html("/svgfirst", '<svg><title>Icon</title></svg><title>Real title</title>')
        self.assertEqual(self.fetch("/svgfirst")["title"], "Real title")

    def test_json_ld_canonical_site_author_date_lang_and_reading_time(self):
        article = " ".join(["word"] * 460)
        self.http.html("/rich", f"""<html lang="en-GB"><head><title>Doc</title>
            <link rel="canonical" href="/canonical-article">
            <script type="application/ld+json">{{"@context":"https://schema.org","@graph":[{{"@type":"WebSite","name":"Site"}},
              {{"@type":"NewsArticle","headline":"LD headline","description":"LD description","image":{{"url":"/ld.jpg"}},
                "datePublished":"2026-03-04T10:00:00+02:00","author":[{{"@type":"Person","name":"Ada Writer"}}],
                "publisher":{{"@type":"Organization","name":"Fixture Times"}}}}]}}</script></head>
            <body><nav>{"menu " * 50}</nav><article><p>{article}</p></article></body></html>""")
        result = self.fetch("/rich")
        self.assertEqual(result["title"], "LD headline")  # cleaner than a "Title | Site" <title>
        self.assertEqual(result["summary"], "LD description")
        self.assertEqual(result["thumbnail"], BASE_URL + "/ld.jpg")
        self.assertEqual(result["author"], "Ada Writer")
        self.assertEqual(result["siteName"], "Fixture Times")
        self.assertEqual(result["publishedAt"], "2026-03-04T08:00:00Z")
        self.assertEqual(result["lang"], "en-GB")
        self.assertEqual(result["canonicalUrl"], BASE_URL + "/canonical-article")
        self.assertEqual(result["wordCount"], 460)
        self.assertEqual(result["readingMinutes"], 2)

    def test_preview_image_and_site_icon_are_cached_locally(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 1500
        ico = b"\x00\x00\x01\x00" + b"\x01" * 200
        self.http.routes["/img.png"] = (200, {"Content-Type": "application/octet-stream"}, png)
        self.http.routes["/icon.ico"] = (200, {"Content-Type": "image/x-icon"}, ico)
        self.http.html("/cached", '<title>Cached</title><meta property="og:image" content="/img.png"><link rel="icon" href="/icon.ico">')
        result = self.fetch("/cached")
        self.assertTrue(result["thumbnail"].startswith("/thumb/img_"), result)
        self.assertTrue(result["faviconUrl"].startswith("/thumb/ico_"), result)
        stored = self.cache / result["thumbnail"].split("/")[-1]
        self.assertEqual(stored.read_bytes(), png)
        response = dashboard.app.test_client().get(result["thumbnail"])
        self.assertEqual(response.mimetype, "image/png")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        response.close()

    def test_gone_pages_and_redirects_are_reported(self):
        self.http.routes["/gone"] = (404, {}, b"")
        result = self.fetch("/gone")
        self.assertEqual((result["error"], result.get("httpStatus"), result.get("linkStatus")), ("http_error", 404, "gone"))
        self.http.routes["/moved"] = (301, {"Location": "/landing"}, b"")
        self.http.html("/landing", "<title>Landing</title>")
        result = self.fetch("/moved")
        self.assertEqual((result["finalUrl"], result["linkStatus"]), (BASE_URL + "/landing", "redirected"))

    def _plain_tls(self):
        class TLSContext:
            def wrap_socket(self, sock, server_hostname, do_handshake_on_connect):
                from metadata_fixture import PlainTLSSocket
                return PlainTLSSocket(sock)
        return patch.object(safe.ssl, "create_default_context", return_value=TLSContext())

    def test_oembed_providers_give_previews_without_the_page(self):
        for host in ("www.tiktok.com", "publish.twitter.com", "x.com"):
            self.http.dns[host] = [PUBLIC_IP]
        tiktok = "/oembed?url=https%3A%2F%2Fwww.tiktok.com%2F%40someone%2Fvideo%2F123"
        self.http.routes[tiktok] = (200, {"Content-Type": "application/json"},
            b'{"title":"Dance","author_name":"someone","provider_name":"TikTok","thumbnail_url":"http://cdn.fixture.test/tt.jpg"}')
        self.http.routes["/tt.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        with self._plain_tls():
            result = metadata.fetch_metadata("https://www.tiktok.com/@someone/video/123")
        self.assertEqual((result["title"], result["author"], result["siteName"]), ("Dance", "someone", "TikTok"))
        self.assertTrue(result["thumbnail"].startswith("/thumb/img_"))
        tweet = "/oembed?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1&omit_script=1&dnt=true"
        self.http.routes[tweet] = (200, {"Content-Type": "application/json"},
            b'{"type":"rich","author_name":"A","provider_url":"https://twitter.com","html":"<blockquote><p>Hello <a href=\\"https://t.co/x\\">world</a></p></blockquote>"}')
        with self._plain_tls():
            result = metadata.fetch_metadata("https://x.com/a/status/1")
        self.assertEqual(result["summary"], "Hello world")
        self.assertEqual(result["author"], "A")

    def test_reddit_json_and_arxiv_abstract(self):
        self.http.dns["www.reddit.com"] = [PUBLIC_IP]
        listing = [{"data": {"children": [{"data": {"title": "Thread", "selftext": "Body text", "author": "op",
                    "subreddit": "python", "created_utc": 1700000000,
                    "preview": {"images": [{"source": {"url": "http://cdn.fixture.test/r.jpg"}}]}}}]}}]
        self.http.routes["/r/python/comments/abc/thread.json?raw_json=1&limit=1"] = (200, {"Content-Type": "application/json"}, json.dumps(listing).encode())
        self.http.routes["/r.jpg"] = (200, {"Content-Type": "image/jpeg"}, JPEG)
        with self._plain_tls():
            result = metadata.fetch_metadata("https://www.reddit.com/r/python/comments/abc/thread/")
        self.assertEqual((result["title"], result["summary"], result["siteName"], result["author"]), ("Thread", "Body text", "r/python", "u/op"))
        self.assertEqual(result["publishedAt"], "2023-11-14T22:13:20Z")
        self.assertTrue(result["thumbnail"].startswith("/thumb/img_"))
        self.assertEqual(metadata._arxiv_abstract_url("https://arxiv.org/pdf/2401.01234v2"), "https://arxiv.org/abs/2401.01234v2")
        self.assertEqual(metadata._arxiv_abstract_url("https://arxiv.org/pdf/2401.01234.pdf"), "https://arxiv.org/abs/2401.01234")

    def test_slow_first_byte_within_budget_succeeds(self):
        def slow(handler):
            time.sleep(2.6)
            body = b"<title>Slow but fine</title>"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        self.http.routes["/slow"] = slow
        self.assertEqual(self.fetch("/slow")["title"], "Slow but fine")


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        FIXTURE.cleanup()
