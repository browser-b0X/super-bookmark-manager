"""The packaged app's checks (packaging/standalone_entry.py), run for real.

Only programs of the Windows user who started it get an answer: 127.0.0.1 is shared by every user on a PC. Its own
pages carry this run's instance token. The two extensions aren't pages of the app, so they hold no such token and prove
themselves on their own routes. The suites that drive the extensions run the source app, where these checks don't
exist, so writes only the installed app refused went unseen (v0.4.0: every file_links got a bare 403, and the browser
extension couldn't pair).

Run: python -B frontend/tests/packaged_boundary_test.py
With SBM_PACKAGED_EXE set to a built SuperBookmarkManager.exe, the same checks run against that program.
Synthetic data only: the real entry runs with a throwaway profile folder on a free port, beside any running copy.
"""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
AT = "2026-10-20T10:00:00.000Z"
EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True


def post(ident, url, title):
    return {"id": ident, "url": url, "source": "manual", "platform": "web", "domain": "example.test", "title": title,
            "status": "inbox", "createdAt": AT, "updatedAt": AT, "metadataStatus": "partial", "categories": [],
            "categoryMode": "manual", "tags": [], "projectIds": []}


@unittest.skipUnless(sys.platform == "win32", "the packaged entry runs on Windows")
class Running(unittest.TestCase):
    """The entry running in a throwaway profile; `ask` talks to it."""
    another_user = False
    wanted_port = 0

    @classmethod
    def setUpClass(cls):
        (ROOT / ".verify" / "packaged-boundary").mkdir(parents=True, exist_ok=True)
        cls.folder = tempfile.TemporaryDirectory(prefix="run-", dir=ROOT / ".verify" / "packaged-boundary",
                                                 ignore_cleanup_errors=True)
        cls.profile = Path(cls.folder.name)
        env = {name: os.environ[name] for name in ("SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT") if name in os.environ}
        env.update({name: str(cls.profile) for name in ("LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP")})
        env.update(SBM_TEST_ROOT=str(ROOT), SUPER_BOOKMARK_MANAGER_PORT=str(cls.wanted_port), PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
        if cls.another_user:
            env["SBM_TEST_ANOTHER_USER"] = "1"
        if cls.wanted_port:
            env["SBM_TEST_SOMEONE_ELSE"] = "1"
        built = os.environ.get("SBM_PACKAGED_EXE")
        if built:                                   # its browser launch does nothing, and leaves no window
            env["BROWSER"] = '"' + str(Path(sys.executable).with_name("pythonw.exe")) + '" -c pass %s'
        command = [built] if built else [sys.executable, "-B", str(ROOT / "packaging" / "tests" / "runtime_wrapper.py")]
        cls.child = subprocess.Popen(command, env=env, cwd=cls.profile, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop)
        record = cls.profile / "SuperBookmarkManager" / "runtime.json"
        end = time.monotonic() + 90
        while True:
            try:
                running = json.loads(record.read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                if time.monotonic() > end or cls.child.poll() is not None:
                    problem = cls.profile / "startup-error.txt"
                    raise RuntimeError("the packaged entry did not start: " + (problem.read_text() if problem.exists() else "no message"))
                time.sleep(0.1)
        cls.port, cls.token = running["port"], running["token"]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.page = {"X-SBM-Instance": cls.token, "Origin": cls.base, "Sec-Fetch-Site": "same-origin"}

    @classmethod
    def stop(cls):
        try:
            cls.ask("/api/runtime/quit", {"confirm": True}, cls.page)
            cls.child.wait(2 if cls.another_user else 20)      # refused then, so it is stopped below
        except (AttributeError, OSError, subprocess.TimeoutExpired):
            cls.child.kill()
            cls.child.wait(20)
        cls.folder.cleanup()

    @classmethod
    def ask(cls, path, body=None, headers=None, data=None):
        """(status, the answer as JSON, or {"text": ...} for a page). A body or `data` makes it a POST."""
        headers = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(cls.base + path, data=data, headers=headers)
        try:
            with OPENER.open(request, timeout=20) as response:
                status, text = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, text = error.code, error.read()
        try:
            return status, json.loads(text)
        except ValueError:
            return status, {"text": text.decode("utf-8", "replace")}


class PackagedBoundary(Running):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        status, answer = cls.ask("/api/library", {"posts": [post("id-rye", "https://example.test/rye", "Rye loaf"),
                                                            post("id-oat", "https://example.test/oat", "Oat loaf")],
                                                  "deletedUrls": []}, cls.page)
        assert status == 200 and not answer.get("rejected"), (status, answer)

    def claude_token(self):
        status, answer = self.ask("/api/claude-desktop/token", {}, self.page)
        self.assertEqual(status, 200, answer)
        return {"X-SBM-Claude": answer["token"]}

    def paired(self):
        status, answer = self.ask("/api/extension/code", {}, self.page)
        self.assertEqual(status, 200, answer)
        code, nonce = answer["code"]["code"].replace("-", ""), "cd" * 16
        status, asked = self.ask("/api/extension/pair", {"nonce": nonce}, {"Origin": EXTENSION})
        self.assertEqual(status, 200, asked)
        proof = hmac.new(code.encode(), f"browser|{nonce}|{asked['challenge']}|{self.base}".encode(), hashlib.sha256).hexdigest()
        status, answer = self.ask("/api/extension/pair", {"nonce": nonce, "proof": proof, "browser": "Edge"}, {"Origin": EXTENSION})
        self.assertEqual(status, 200, answer)
        return {"Origin": EXTENSION, "X-SBM-Pair": answer["token"]}

    def test_claude_desktop_can_file_links_and_suggest_a_shelf(self):
        claude = self.claude_token()
        status, answer = self.ask("/api/mcp/shelves", headers=claude)
        self.assertEqual(status, 200, answer)
        self.assertIn("food-drink", [shelf["name"] for shelf in answer["shelves"]])
        status, answer = self.ask("/api/mcp/file", {"ids": ["id-rye"], "shelf": "food-drink", "tags": ["recipe"]}, claude)
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer["ok"], answer)
        status, answer = self.ask("/api/mcp/link?id=id-rye", headers=claude)
        self.assertEqual((status, answer["link"]["shelves"]), (200, ["food-drink"]), answer)
        status, answer = self.ask("/api/mcp/suggest", {"name": "Long walks", "description": "Routes to try"}, claude)
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer["ok"], answer)

    def test_the_browser_extension_can_pair_and_ask_what_is_saved(self):
        extension = self.paired()
        status, answer = self.ask("/api/extension/saved", {"urls": ["https://example.test/oat", "https://example.test/none"]}, extension)
        self.assertEqual(status, 200, answer)
        self.assertEqual([item["saved"] for item in answer["items"]], [True, False])

    def test_the_apps_own_pages_upload_with_this_runs_token(self):
        picture = b"\x89PNG\r\n\x1a\n" + b"synthetic" * 40
        status, answer = self.ask("/api/archive/media", data=picture, headers={**self.page, "Content-Type": "image/png"})
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer["ok"], answer)

    def test_everything_else_still_needs_this_runs_token_and_says_why(self):
        library = {"posts": [], "deletedUrls": []}
        for name, headers in (("none", {"Origin": self.base}), ("another run's", {**self.page, "X-SBM-Instance": "0" * 64})):
            with self.subTest(token=name):
                status, answer = self.ask("/api/library", library, headers)
                self.assertEqual(status, 403)
                self.assertIn("reload", answer.get("error", "").lower(), "a reason the caller can act on, not a bare 403")
        status, answer = self.ask("/api/archive/media", data=b"x" * 32, headers={"Content-Type": "image/png"})
        self.assertEqual(status, 403)
        status, answer = self.ask("/api/runtime/quit", {"confirm": True}, {"Origin": self.base})
        self.assertEqual(status, 403, "only this run's pages can quit the app")

    def test_a_request_to_another_address_says_which_one_answers(self):
        status, answer = self.ask("/api/mcp/file", {"ids": ["id-oat"], "shelf": "food-drink"},
                                  {**self.claude_token(), "Host": f"localhost:{self.port}"})
        self.assertEqual(status, 403)
        self.assertIn(self.base, answer.get("error", ""), "it names the address that does answer")

    def test_the_extensions_routes_keep_their_own_checks(self):
        claude = self.claude_token()
        website = "https://website.example"
        changes = (("a website's Origin", {**claude, "Origin": website}, 403), ("a website's fetch", {**claude, "Sec-Fetch-Site": "cross-site"}, 403),
                   ("a wrong token", {"X-SBM-Claude": "f" * 64}, 401), ("no token", {}, 401))
        for name, headers, code in changes:
            with self.subTest(refused=name):
                status, answer = self.ask("/api/mcp/file", {"ids": ["id-oat"], "shelf": "food-drink"}, headers)
                self.assertEqual(status, code, answer)
        status, answer = self.ask("/api/mcp/link?id=id-oat", headers=claude)
        self.assertEqual(answer["link"]["shelves"], [], "nothing above changed the link")
        self.assertEqual(self.ask("/api/extension/pair", {"code": "000000"}, {"Origin": website})[0], 403)
        self.assertEqual(self.ask("/api/extension/pair", {"code": "000000"})[0], 403, "no Origin is no extension")
        self.assertEqual(self.ask("/api/extension/saved", {"urls": []}, {"Origin": EXTENSION})[0], 401, "not paired")


    def test_a_real_program_of_another_account_gets_nothing(self):
        # Windows's download service runs as SYSTEM, so its requests come from a program of another account. No second
        # account and no test hook are needed, so this one holds for a built program too.
        saved = self.profile / "asked-by-another-account"
        job = (f"Import-Module BitsTransfer; try {{ Start-BitsTransfer -DisplayName sbm-boundary-test -Source '{self.base}/' "
               f"-Destination '{saved}' -ErrorAction Stop; 'finished' }} catch {{ $_.Exception.Message }} "
               "Get-BitsTransfer -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'sbm-boundary-test' } | Remove-BitsTransfer")
        answer = subprocess.run(["powershell.exe", "-NoProfile", "-Command", job], capture_output=True, text=True, timeout=60,
                                stdin=subprocess.DEVNULL).stdout
        if "HTTP status" not in answer and "finished" not in answer:
            self.skipTest("the download service can't be used here: " + answer[:120])
        self.assertIn("HTTP status 403", answer)
        self.assertFalse(saved.exists(), "the home page holds this run's token")


    def test_the_app_proves_itself_to_its_own_pages(self):
        status, page = self.ask("/", headers={"Accept": "text/html"})
        self.assertEqual(status, 200)
        keys = dict(re.findall(r'<meta name="(sbm-[a-z-]+)" content="([0-9a-f]+)">', page["text"]))
        self.assertEqual(sorted(keys), ["sbm-cache-key", "sbm-cache-new", "sbm-instance", "sbm-profile", "sbm-proof-key"])
        self.assertEqual(keys["sbm-cache-new"], "1", "this run made the key")
        self.assertEqual({len(keys["sbm-cache-key"]), len(keys["sbm-proof-key"])}, {64})
        self.assertNotEqual(keys["sbm-cache-key"], keys["sbm-proof-key"])
        nonce = "ab" * 16
        status, answer = self.ask(f"/api/runtime/hello?nonce={nonce}")
        self.assertEqual(status, 200, answer)
        message = f"{nonce}|{self.base}".encode()
        self.assertEqual(answer["proof"], hmac.new(keys["sbm-proof-key"].encode(), message, hashlib.sha256).hexdigest())
        self.assertEqual(self.ask("/api/runtime/hello?nonce=not-one")[0], 400)

    def test_no_popup_can_reach_the_pages_that_hold_the_keys(self):
        def header(path):
            with OPENER.open(urllib.request.Request(self.base + path, headers=self.page), timeout=30) as response:
                return response.headers.get("Cross-Origin-Opener-Policy")
        for path in ("/", "/library", "/library/settings", "/shelves", "/add?url=https%3A%2F%2Fexample.test%2Fa", "/add",
                     "/add?url=https%3A%2F%2Finstagram.com.example.test%2Fp%2Fa"):
            with self.subTest(page=path):
                self.assertEqual(header(path), "same-origin")
        for address in ("https%3A%2F%2Fwww.instagram.com%2Fp%2Fabc%2F", "https%3A%2F%2Finstagram.com%2Freel%2Fabc%2F"):
            with self.subTest(address=address):
                self.assertIsNone(header(f"/add?url={address}"), "this Save window answers the tab that opened it")

    def test_the_page_is_never_served_without_its_keys(self):
        status, page = self.ask("/index.html", headers={"Accept": "text/html"})
        self.assertEqual(status, 200)
        self.assertIn('name="sbm-cache-key"', page["text"])

    def test_the_proof_says_whether_a_page_is_of_this_run_without_a_token_being_sent(self):
        status, page = self.ask("/", headers={"Accept": "text/html"})
        key = re.search(r'name="sbm-proof-key" content="([0-9a-f]+)"', page["text"]).group(1)
        nonce = "ab" * 16
        status, answer = self.ask(f"/api/runtime/hello?nonce={nonce}")
        message = f"{nonce}|{self.base}|{self.token}".encode()
        self.assertEqual(answer["run"], hmac.new(key.encode(), message, hashlib.sha256).hexdigest())

    def test_answers_the_browser_could_keep_are_marked_not_to_be(self):
        request = urllib.request.Request(self.base + "/api/stats", headers=self.page)
        with OPENER.open(request, timeout=30) as response:
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")


class BrowserSecret(unittest.TestCase):
    """The key the browser's copy is sealed with: it must outlive a run, or the copy is lost at every start."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("entry", ROOT / "packaging" / "standalone_entry.py")
        self.entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.entry)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "browser-key.txt"
        self.protected = []

    def secret(self):
        return self.entry._browser_secret(self.path, lambda path: self.protected.append(path.stat().st_size))

    def test_it_is_protected_before_it_is_written_and_kept_across_runs(self):
        first, made = self.secret()
        self.assertEqual((len(first), made), (32, True))
        self.assertEqual(self.protected, [0], "no moment with the key in an unprotected file")
        self.assertEqual(self.secret(), (first, False), "only the first run may read an old plain cache")
        self.assertEqual(self.protected, [0], "written once")

    def test_an_unreadable_one_costs_only_the_browsers_copy(self):
        for content in ("", "not hex", "ab" * 16):
            with self.subTest(content=content):
                self.path.write_text(content, encoding="ascii")
                self.assertEqual(len(self.secret()[0]), 32, "the app still starts")


@unittest.skipIf(os.environ.get("SBM_PACKAGED_EXE"), "a built program can't be told who holds a port")
class PortTakenBySomeoneElse(Running):
    @classmethod
    def setUpClass(cls):
        cls.holder = socket.create_server(("127.0.0.1", 0))
        cls.addClassCleanup(cls.holder.close)
        cls.wanted_port = cls.holder.getsockname()[1]
        super().setUpClass()

    def test_the_owner_is_told_and_the_app_moves(self):
        self.assertNotEqual(self.port, self.wanted_port)
        notice = self.profile / "startup-error.txt"
        end = time.monotonic() + 15
        while not notice.exists() and time.monotonic() < end:
            time.sleep(0.05)
        text = notice.read_text()
        self.assertIn(f"Another Windows user's program is using the address SuperBookmarks normally uses (http://127.0.0.1:{self.wanted_port})", text)
        self.assertIn(f"it opened at {self.base} instead", text)


@unittest.skipIf(os.environ.get("SBM_PACKAGED_EXE"), "a built program can't be told it belongs to someone else")
class AnotherWindowsUser(Running):
    """The entry believes it belongs to someone else, so to it this test is a program of another Windows user."""
    another_user = True

    def refused(self, status, answer):
        self.assertEqual(status, 403, answer)
        self.assertEqual(set(answer), {"text"}, "only the fixed page")
        self.assertIn("only the Windows user who started it", answer["text"])
        self.assertNotIn(self.token, answer["text"])
        self.assertNotIn("sbm-instance", answer["text"])
        self.assertNotIn("<script", answer["text"].lower())

    def test_nothing_is_answered_even_with_this_runs_token(self):
        for path in ("/api/library", "/api/stats", "/api/categories", "/api/ai/providers", "/api/telegram/auth", "/api/archive",
                     "/api/extension", "/api/claude-desktop", "/api/runtime", "/api/mcp/shelves", "/api/extension/ping"):
            with self.subTest(read=path):
                self.refused(*self.ask(path, headers={**self.page, "X-SBM-Claude": "f" * 64, "X-SBM-Pair": "f" * 40}))
        for path, body in (("/api/library", {"posts": [], "deletedUrls": []}), ("/api/runtime/quit", {"confirm": True}),
                           ("/api/mcp/file", {"ids": ["x"], "shelf": "food-drink"}), ("/api/extension/pair", {"code": "x"})):
            with self.subTest(write=path):
                self.refused(*self.ask(path, body, {**self.page, "X-SBM-Claude": "f" * 64}))
        self.assertIsNone(self.child.poll(), "it was not made to quit")

    def test_pages_and_files_get_only_the_fixed_page(self):
        for path in ("/", "/library", "/library/settings", "/add?url=https%3A%2F%2Fexample.test%2Fa", "/assets/index.js", "/favicon.ico",
                     "/archive/" + "0" * 32, "/no-such-page"):
            with self.subTest(page=path):
                self.refused(*self.ask(path, headers={"Accept": "text/html"}))
        self.refused(*self.ask("/", headers={"Host": "website.example"}))

    def test_refused_connections_hold_no_place_in_the_app(self):
        # More than the app's limit of 100 connections, all left open, and nothing sent on them.
        crowd = [socket.create_connection(("127.0.0.1", self.port), timeout=10) for _ in range(120)]
        self.addCleanup(lambda: [connection.close() for connection in crowd])
        end = time.monotonic() + 15
        for connection in crowd:
            connection.settimeout(max(0.1, end - time.monotonic()))
            try:
                while connection.recv(65536):
                    pass
            except ConnectionError:
                pass                                # hung up on, which is as good
        self.refused(*self.ask("/"))

    def test_a_refused_upload_is_not_kept(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as connection:
            connection.sendall(b"POST /api/archive/import HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/zip\r\n"
                               b"Content-Length: 8000000000\r\n\r\n" + bytes(1024 * 1024))
            answer = connection.recv(4096)
        self.assertTrue(answer.startswith(b"HTTP/1.1 403"), answer[:40])
        left = [path.name for path in self.profile.rglob("*") if path.is_file() and path.stat().st_size >= 1024 * 1024]
        self.assertEqual(left, [], "nothing it sent was spooled to disk")


@unittest.skipUnless(sys.platform == "win32", "Windows names the program and its user")
class PeerLookup(unittest.TestCase):
    """The lookup itself, on real connections and real processes."""

    def setUp(self):
        import local_peer
        self.peer = local_peer
        self.server = socket.create_server(("127.0.0.1", 0))
        self.addCleanup(self.server.close)
        self.port = self.server.getsockname()[1]

    def connected_program(self):
        """A connection held by a separate program of this user: (its process id, its address, its port)."""
        code = (f"import os, socket, time; s = socket.create_connection(('127.0.0.1', {self.port})); "
                "print(os.getpid(), flush=True); time.sleep(60)")
        child = subprocess.Popen([sys.executable, "-B", "-c", code], stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.wait, 20)
        self.addCleanup(child.kill)
        connection, (address, port) = self.server.accept()
        self.addCleanup(connection.close)
        return int(child.stdout.readline()), address, port

    def test_it_names_the_program_at_the_other_end_and_its_user(self):
        pid, address, port = self.connected_program()
        self.assertNotEqual(pid, os.getpid())
        self.assertEqual(self.peer.peer_pid(address, port, self.port), pid)
        self.assertEqual(self.peer.user_of(pid), self.peer.own_user())
        self.assertTrue(self.peer.same_user(address, port, self.port))
        self.assertTrue(self.peer.same_user(address, str(port), str(self.port)), "the server's values are text")

    def test_a_process_of_another_account_is_not_this_user(self):
        # A real one: Windows's own System process, which this account can't look into.
        self.assertIsNone(self.peer.user_of(4))
        pid, address, port = self.connected_program()
        with patch.object(self.peer, "peer_pid", lambda *args: 4):
            self.assertFalse(self.peer.same_user(address, port, self.port))

    def test_a_program_of_another_user_is_refused(self):
        pid, address, port = self.connected_program()
        with patch.object(self.peer, "own_user", lambda: b"another user"):
            self.assertFalse(self.peer.same_user(address, port, self.port))

    def test_it_finds_who_listens_on_a_port_over_both_kinds_of_address(self):
        self.assertEqual(self.peer.listeners(self.port), {os.getpid()})
        self.assertFalse(self.peer.someone_else_listens(self.port), "this user's own")
        with socket.create_server(("::1", 0), family=socket.AF_INET6) as server:
            port = server.getsockname()[1]
            self.assertEqual(self.peer.listeners(port), {os.getpid()})
        self.assertEqual(self.peer.listeners(port), set())
        self.assertFalse(self.peer.someone_else_listens(port), "nothing listens there")
        with socket.create_server(("0.0.0.0", 0)) as server:
            self.assertEqual(self.peer.listeners(server.getsockname()[1]), {os.getpid()}, "every address holds loopback too")

    def test_only_another_persons_program_counts_as_someone_elses(self):
        self.peer.own_user()                        # kept once known, so it must not be asked under the patches below
        me = self.peer._sessions()[os.getpid()]
        self.assertGreater(me, 0, "services are in session 0, and a signed-in person is not")
        self.assertEqual(self.peer._sessions()[4], 0, "Windows's own System process")
        for session, expected in ((0, False), (me, False), (me + 1, True)):
            with self.subTest(session=session), patch.object(self.peer, "user_of", lambda pid: None), \
                    patch.object(self.peer, "_sessions", lambda: {os.getpid(): me, 4321: session}), \
                    patch.object(self.peer, "listeners", lambda port: {4321}):
                self.assertEqual(self.peer.someone_else_listens(self.port), expected)

    def test_a_listener_windows_cant_place_counts_as_someone_elses(self):
        self.peer.own_user()
        with patch.object(self.peer, "user_of", lambda pid: None), patch.object(self.peer, "listeners", lambda port: {4321}):
            with patch.object(self.peer, "_sessions", lambda: {os.getpid(): 1}):
                self.assertTrue(self.peer.someone_else_listens(self.port), "it isn't in the list")
            with patch.object(self.peer, "_sessions", lambda: {}):
                self.assertTrue(self.peer.someone_else_listens(self.port), "no list at all")

    def test_no_list_from_windows_counts_as_someone_elses(self):
        with patch.object(self.peer._iphlpapi, "GetExtendedTcpTable", lambda *args: 5):
            self.assertTrue(self.peer.someone_else_listens(self.port))
            self.assertFalse(self.peer.same_user("127.0.0.1", 1, self.port))

    def test_whatever_windows_cant_name_is_refused(self):
        pid, address, port = self.connected_program()
        self.assertIsNone(self.peer.peer_pid(address, port, self.port + 1 if self.port < 65535 else 1), "a connection that isn't there")
        for values in ((address, port + 1 if port < 65535 else 1, self.port), ("127.0.0.2", port, self.port), (None, port, self.port),
                       (address, None, self.port), (address, "x", self.port), (address, port, None), (address, 70000, self.port),
                       ("::1", port, self.port), ("not an address", port, self.port), (address, -1, self.port)):
            with self.subTest(values=values):
                self.assertFalse(self.peer.same_user(*values))
        with patch.object(self.peer, "own_user", lambda: None):
            self.assertFalse(self.peer.same_user(address, port, self.port), "when it can't name its own user either")


if __name__ == "__main__":
    unittest.main()
