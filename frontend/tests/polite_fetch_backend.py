"""Polite fetching tests: a site that says 429/503 is left alone for its Retry-After.

Synthetic bytes and the guarded owned HTTP server only; nothing reaches a real site.
Run: python -B frontend/tests/polite_fetch_backend.py
"""
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE))
sys.dont_write_bytecode = True
from metadata_fixture import BASE_URL, PUBLIC_IP, ControlledHTTP, install_guard, GUARD_FAILURES

(WORKSPACE / ".verify" / "polite-fetch-20261025").mkdir(parents=True, exist_ok=True)
FIXTURE = tempfile.TemporaryDirectory(prefix="backend-fixture-", dir=WORKSPACE / ".verify" / "polite-fetch-20261025")
ROOT = Path(FIXTURE.name)
install_guard(ROOT)
# Every data path points into the fixture before app is imported.
(ROOT / "data").mkdir()
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(ROOT / "data")
os.environ["SAVED_POSTS_DB_PATH"] = str(ROOT / "synthetic.sqlite")
os.environ["SBM_THUMB_CACHE_DIR"] = str(ROOT / "thumbs")
os.environ["SBM_TELEGRAM_SESSION_FILE"] = str(ROOT / "synthetic.session")
import metadata_fetcher as metadata
import safe_http as safe
import app as dashboard

OTHER_URL = "http://other.fixture.test"
REAL_MONOTONIC = time.monotonic


def page_requests(http):
    """Requests other than the once-per-site icon lookup."""
    return [r for r in http.requests if r[0] != "/favicon.ico"]


class PoliteFetchCase(unittest.TestCase):
    def setUp(self):
        self.http = ControlledHTTP().__enter__()
        self.addCleanup(self.http.__exit__, None, None, None)
        self.http.dns["other.fixture.test"] = [PUBLIC_IP]
        cache = ROOT / self._testMethodName
        cache.mkdir()
        patcher = patch.object(metadata, "THUMB_CACHE_DIR", str(cache))
        patcher.start()
        self.addCleanup(patcher.stop)
        # Time only moves when a test says so: a constant offset keeps every deadline consistent.
        self.offset = 0.0
        clock = patch("time.monotonic", lambda: REAL_MONOTONIC() + self.offset)
        clock.start()
        self.addCleanup(clock.stop)
        self.forget()
        self.guard_count = len(GUARD_FAILURES)

    def tearDown(self):
        self.forget()
        if hasattr(self, "guard_count"):
            self.assertEqual(GUARD_FAILURES[self.guard_count:], [], "Production crossed synthetic isolation boundary")

    def forget(self):
        with metadata._flight_lock:
            metadata._recent.clear()
        with metadata._rest_lock:
            metadata._host_rests.clear()
        with metadata._favicon_lock:
            metadata._favicons.clear()

    def fetch(self, path="/", base=BASE_URL):
        return metadata.fetch_metadata(base + path)

    def serve(self, path, status, retry_after=None):
        headers = {} if retry_after is None else {"Retry-After": retry_after}
        self.http.routes[path] = (status, headers, b"synthetic")

    def rest_of(self, status, retry_after=None):
        """The rest a fresh host gets from one answer (and nothing remembered afterwards)."""
        self.forget()
        self.serve("/limited", status, retry_after)
        result = self.fetch("/limited")
        self.assertEqual((result["status"], result["error"]), ("failed", "busy"))
        self.forget()
        return result["retryAfter"]


class RestTests(PoliteFetchCase):
    def test_retry_after_seconds_rest_the_host_without_a_request(self):
        self.serve("/limited", 429, "120")
        result = self.fetch("/limited")
        self.assertEqual((result["status"], result["error"]), ("failed", "busy"))
        self.assertEqual((result["retryAfter"], result["httpStatus"]), (120, 429))
        self.assertEqual(len(self.http.requests), 1)
        dns_calls = len(self.http.dns_calls)
        # Another page of the same site: answered busy at once, nothing sent.
        self.http.html("/other", "<title>Never fetched</title>")
        second = self.fetch("/other")
        self.assertEqual((second["status"], second["error"]), ("failed", "busy"))
        self.assertIn(second["retryAfter"], (119, 120))
        self.assertNotIn("httpStatus", second)
        self.assertEqual(len(self.http.requests), 1)
        self.assertEqual(len(self.http.dns_calls), dns_calls)

    def test_the_seconds_left_are_fresh_each_time_and_at_least_one(self):
        self.serve("/limited", 429, "100")
        self.fetch("/limited")
        self.offset += 10
        self.assertIn(self.fetch("/limited")["retryAfter"], (89, 90))   # the same link: not a 30 s old copy
        self.offset += 89.5
        self.assertEqual(self.fetch("/limited")["retryAfter"], 1)       # rounded up, never 0
        self.assertEqual(len(self.http.requests), 1)

    def test_the_host_is_fetched_again_after_the_rest(self):
        self.serve("/limited", 429, "30")
        self.assertEqual(self.fetch("/limited")["retryAfter"], 30)
        self.http.html("/ok", "<title>Back again</title>")
        self.offset += 29
        self.assertEqual(self.fetch("/ok")["error"], "busy")
        self.assertEqual(len(page_requests(self.http)), 1)
        self.offset += 2
        result = self.fetch("/ok")
        self.assertEqual((result["status"], result["title"]), ("ok", "Back again"))
        self.assertEqual([r[0] for r in page_requests(self.http)], ["/limited", "/ok"])

    def test_without_retry_after_the_rest_doubles_up_to_an_hour(self):
        self.serve("/down", 429)
        for expected in (60, 120, 240, 480, 960, 1920, 3600, 3600):
            result = self.fetch("/down")
            self.assertEqual((result["error"], result["httpStatus"], result["retryAfter"]), ("busy", 429, expected))
            self.offset += expected + 1
        self.assertEqual(len(self.http.requests), 8)

    def test_a_retry_after_that_cannot_be_used_falls_back_to_the_doubling(self):
        for header in ("soon", "", "-5", "1.5", "Mon, 99 Foo 2026 25:61:61 GMT"):
            with self.subTest(header=header):
                self.assertEqual(self.rest_of(429, header), 60)

    def test_retry_after_is_clamped_to_one_second_and_an_hour(self):
        self.assertEqual(self.rest_of(429, "0"), 1)
        self.assertEqual(self.rest_of(429, "99999"), 3600)
        self.assertEqual(self.rest_of(429, "9" * 5000), 3600)
        past = formatdate(time.time() - 600, usegmt=True)
        self.assertEqual(self.rest_of(429, past), 1)

    def test_an_http_date_is_the_wait_from_now(self):
        self.assertIn(self.rest_of(429, formatdate(time.time() + 90, usegmt=True)), range(88, 92))
        self.assertEqual(self.rest_of(503, formatdate(time.time() + 86400, usegmt=True)), 3600)

    def test_a_success_clears_the_doubling(self):
        self.serve("/down", 429)
        self.assertEqual(self.fetch("/down")["retryAfter"], 60)
        self.offset += 61
        self.assertEqual(self.fetch("/down")["retryAfter"], 120)
        self.offset += 121
        self.http.html("/ok", "<title>Fine</title>")
        self.assertEqual(self.fetch("/ok")["status"], "ok")
        self.assertEqual(self.fetch("/down")["retryAfter"], 60)   # not 240

    def test_a_failure_that_is_not_a_slow_down_neither_rests_nor_clears(self):
        self.serve("/down", 429)
        self.assertEqual(self.fetch("/down")["retryAfter"], 60)
        self.offset += 61
        self.serve("/gone", 404)
        gone = self.fetch("/gone")
        self.assertEqual((gone["error"], gone["httpStatus"], gone["linkStatus"]), ("http_error", 404, "gone"))
        self.assertNotIn("retryAfter", gone)
        self.serve("/broken", 500, "30")
        broken = self.fetch("/broken")
        self.assertEqual((broken["error"], broken["httpStatus"]), ("http_error", 500))
        self.assertNotIn("retryAfter", broken)
        self.assertEqual(len(self.http.requests), 3)               # neither answer rested the host
        self.assertEqual(self.fetch("/down")["retryAfter"], 120)   # and the doubling went on

    def test_a_503_without_a_usable_retry_after_is_a_failure_of_that_link_only(self):
        for header in (None, "soon"):
            with self.subTest(header=header):
                self.forget()
                self.serve("/broken-page", 503, header)
                result = self.fetch("/broken-page")
                self.assertEqual((result["status"], result["error"], result["httpStatus"]), ("failed", "http_error", 503))
                self.assertNotIn("retryAfter", result)
                self.http.html("/ok", "<title>Fine</title>")
                self.assertEqual(self.fetch("/ok")["status"], "ok", "the site is not rested")

    def test_a_slow_down_from_a_redirect_target_does_not_rest_the_links_own_site(self):
        self.http.routes["/hop"] = (302, {"Location": OTHER_URL + "/limited"}, b"")
        self.serve("/limited", 429, "3600")
        result = self.fetch("/hop")
        self.assertEqual((result["error"], result["httpStatus"], result["retryAfter"]), ("busy", 429, 3600))
        self.assertNotIn("_host", result)
        self.http.html("/ok", "<title>Fine</title>")
        self.assertEqual(self.fetch("/ok")["status"], "ok", "the link's own site is fetched as usual")

    def test_another_host_is_not_affected(self):
        self.serve("/limited", 429, "120")
        self.fetch("/limited")
        self.http.html("/ok", "<title>Elsewhere</title>")
        result = self.fetch("/ok", OTHER_URL)
        self.assertEqual((result["status"], result["title"]), ("ok", "Elsewhere"))
        self.assertEqual(page_requests(self.http)[-1][1]["Host"], "other.fixture.test")
        self.assertEqual(self.fetch("/ok")["error"], "busy")       # the resting host still rests
        self.assertEqual(len(page_requests(self.http)), 2)

    def test_the_rest_follows_the_host_key_the_gate_uses(self):
        self.serve("/limited", 429, "120")
        self.fetch("/limited")
        before = len(self.http.requests)
        self.assertEqual(self.fetch("/x", "http://METADATA.fixture.test")["error"], "busy")
        self.assertEqual(self.fetch("/x", "http://metadata.fixture.test:80")["error"], "busy")
        self.assertEqual(len(self.http.requests), before)

    def test_a_cached_answer_is_still_served_while_the_host_rests(self):
        self.http.html("/ok", "<title>Cached</title>")
        self.assertEqual(self.fetch("/ok")["status"], "ok")
        self.serve("/limited", 429, "120")
        self.fetch("/limited")
        before = len(self.http.requests)
        self.assertEqual(self.fetch("/ok")["title"], "Cached")
        self.assertEqual(len(self.http.requests), before)

    def test_a_fetch_waiting_for_its_turn_does_not_go_ahead_once_the_host_rests(self):
        gate = metadata._host_gate(BASE_URL)
        gate.acquire()
        gate.acquire()
        self.http.html("/queued", "<title>Should not be fetched</title>")
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(self.fetch, "/queued")
            time.sleep(0.3)
            metadata._rest_start(BASE_URL, 45)
            gate.release()
            gate.release()
            result = future.result(timeout=10)
        self.assertEqual(result["error"], "busy")
        self.assertIn(result["retryAfter"], (44, 45))
        self.assertEqual(self.http.requests, [])

    def test_the_table_of_resting_hosts_stays_bounded(self):
        for number in range(400):
            metadata._rest_start(f"http://host{number}.fixture.test/", 60)
        with metadata._rest_lock:
            self.assertLessEqual(len(metadata._host_rests), 257)


class SafeHTTPTests(PoliteFetchCase):
    def failure(self, status, retry_after):
        self.serve("/answer", status, retry_after)
        with self.assertRaises(safe.SafeHTTPError) as caught:
            safe.get(BASE_URL + "/answer")
        self.assertEqual((caught.exception.code, caught.exception.status), ("http_error", status))
        return caught.exception.retry_after

    def test_retry_after_is_kept_for_429_and_503_only(self):
        self.assertEqual(self.failure(429, "120"), 120)
        self.assertEqual(self.failure(503, "7"), 7)
        self.assertIsNone(self.failure(429, None))
        self.assertIsNone(self.failure(503, "never"))
        self.assertIsNone(self.failure(404, "120"))
        self.assertIsNone(self.failure(500, "120"))
        self.assertIsNone(safe.SafeHTTPError("timeout").retry_after)
        self.assertEqual(safe.SafeHTTPError("http_error", 429, 9).retry_after, 9)
        self.assertIsNone(safe.SafeHTTPError("http_error", 429, "9").retry_after)


class RouteTests(PoliteFetchCase):
    def setUp(self):
        super().setUp()
        self.client = dashboard.app.test_client()

    def test_enrich_answers_429_with_the_hosts_rest(self):
        self.serve("/limited", 429, "120")
        response = self.client.post("/api/enrich", json={"url": BASE_URL + "/limited"})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "120")
        self.assertEqual((response.json["error"], response.json["httpStatus"], response.json["retryAfter"]), ("busy", 429, 120))
        before = len(self.http.requests)
        # Another page of the site: refused at once, with the time that is left.
        response = self.client.post("/api/enrich", json={"url": BASE_URL + "/elsewhere"})
        self.assertEqual(response.status_code, 429)
        self.assertIn(response.headers["Retry-After"], ("119", "120"))
        self.assertEqual(response.json["error"], "busy")
        self.assertEqual(len(self.http.requests), before)

    def test_enrich_doubles_without_a_retry_after_and_keeps_other_hosts_working(self):
        self.serve("/down", 429)
        self.assertEqual(self.client.post("/api/enrich", json={"url": BASE_URL + "/down"}).headers["Retry-After"], "60")
        self.offset += 61
        self.assertEqual(self.client.post("/api/enrich", json={"url": BASE_URL + "/down"}).headers["Retry-After"], "120")
        self.http.html("/ok", "<title>Other site</title>")
        response = self.client.post("/api/enrich", json={"url": OTHER_URL + "/ok"})
        self.assertEqual((response.status_code, response.json["title"]), (200, "Other site"))
        self.assertNotIn("Retry-After", response.headers)

    def test_a_busy_without_a_rest_keeps_the_default_retry_after(self):
        for extra in ({}, {"retryAfter": 0}, {"retryAfter": 99999}, {"retryAfter": "30"}):
            with self.subTest(extra=extra), patch.object(metadata, "fetch_metadata", return_value=metadata._result("busy", **extra)):
                response = self.client.post("/api/enrich", json={"url": BASE_URL + "/x"})
                self.assertEqual(response.status_code, 429)
                self.assertEqual(response.headers["Retry-After"], "5")
        with patch.object(metadata, "fetch_metadata", return_value=metadata._result("http_error", httpStatus=502)):
            response = self.client.post("/api/enrich", json={"url": BASE_URL + "/x"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("Retry-After", response.headers)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        FIXTURE.cleanup()
