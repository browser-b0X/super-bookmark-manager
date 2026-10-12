"""B6 source-production checks; synthetic secrets stay in disposable local state.

Run with Python -B. Output contains check names and booleans only, not tracebacks.
"""
import contextlib
import ctypes
from ctypes import wintypes
import http.client
import importlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
ACTIVE_PROFILE = None
REPORT = sys.stdout
SOCKET_CONNECT = socket.socket.connect
CREATE_CONNECTION = socket.create_connection


def protect_personal_files(event, args):
    if event != "open" or not isinstance(args[0], (str, bytes, os.PathLike)):
        return
    path = Path(os.fsdecode(args[0])).absolute()
    if path.name.startswith(".env") or path.suffix in (".session", ".db", ".sqlite"):
        raise PermissionError("personal storage access forbidden")
    if path.name == "config.json" and (ACTIVE_PROFILE is None or not path.is_relative_to(ACTIVE_PROFILE)):
        raise PermissionError("non-fixture configuration access forbidden")


def windows_acl_is_private(path):
    """Independently inspect protected DACL, sole allow ACE and token-user SID."""
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ptr = ctypes.c_void_p
    adv.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
                                         ptr, ptr, ctypes.POINTER(ptr), ptr, ctypes.POINTER(ptr)]
    adv.GetNamedSecurityInfoW.restype = wintypes.DWORD
    adv.GetSecurityDescriptorControl.argtypes = [ptr, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
    adv.GetSecurityDescriptorControl.restype = wintypes.BOOL
    adv.GetAclInformation.argtypes = [ptr, ptr, wintypes.DWORD, wintypes.DWORD]
    adv.GetAclInformation.restype = wintypes.BOOL
    adv.GetAce.argtypes = [ptr, wintypes.DWORD, ctypes.POINTER(ptr)]
    adv.GetAce.restype = wintypes.BOOL
    adv.EqualSid.argtypes = [ptr, ptr]
    adv.EqualSid.restype = wintypes.BOOL
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.OpenProcessToken.restype = wintypes.BOOL
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, ptr, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    adv.GetTokenInformation.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ptr]
    kernel.LocalFree.restype = ptr
    sd, dacl, token = ptr(), ptr(), wintypes.HANDLE()
    try:
        if adv.GetNamedSecurityInfoW(str(path), 1, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(sd)):
            return False
        control, revision = wintypes.WORD(), wintypes.DWORD()
        if not adv.GetSecurityDescriptorControl(sd, ctypes.byref(control), ctypes.byref(revision)) or not control.value & 0x1000:
            return False
        info = (wintypes.DWORD * 3)()
        if not adv.GetAclInformation(dacl, info, ctypes.sizeof(info), 2) or info[0] != 1:
            return False
        ace = ptr()
        if not adv.GetAce(dacl, 0, ctypes.byref(ace)):
            return False
        header = (ctypes.c_ubyte * 2).from_address(ace.value)
        if header[0] != 0 or header[1] != 0:
            return False
        mask = wintypes.DWORD.from_address(ace.value + 4).value
        if mask & 0x1F01FF != 0x1F01FF:
            return False
        if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            return False
        needed = wintypes.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        buf = ctypes.create_string_buffer(needed.value)
        if not adv.GetTokenInformation(token, 1, buf, needed, ctypes.byref(needed)):
            return False
        sid = ptr.from_buffer(buf)
        return bool(adv.EqualSid(sid, ptr(ace.value + 8)))
    finally:
        if sd:
            kernel.LocalFree(sd)
        if token:
            kernel.CloseHandle(token)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        temp = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="b6-telegram-config-"))
        self.profile = Path(temp)
        global ACTIVE_PROFILE
        ACTIVE_PROFILE = self.profile
        self.assertTrue(".verify" not in self.profile.parts)
        self.stack.enter_context(patch.dict(os.environ, {
            "LOCALAPPDATA": str(self.profile), "MAX_MESSAGES": "200",
            "SAVED_POSTS_DB_PATH": str(self.profile / "never-open.db"),
        }, clear=True))
        self.stack.enter_context(patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.stack.enter_context(patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")))
        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=AssertionError("database forbidden")))
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        handler = logging.StreamHandler(self.output)
        logging.getLogger().addHandler(handler)
        self.stack.callback(logging.getLogger().removeHandler, handler)
        self.api_id = str(10000000 + secrets.randbelow(90000000))
        self.api_hash = secrets.token_hex(16)
        self.other_id = str(int(self.api_id) + 1)
        self.other_hash = secrets.token_hex(16)
        self.canaries = [self.api_id, self.api_hash, self.other_id, self.other_hash]
        self.addCleanup(self.assert_no_logged_canaries)

    def assert_no_logged_canaries(self):
        output = self.output.getvalue()
        self.assertTrue(all(value not in output for value in self.canaries))

    def helper(self):
        self.assertTrue(importlib.util.find_spec("telegram_config") is not None,
                        "central credential helper is required")
        return importlib.import_module("telegram_config")

    def local_path(self):
        return self.profile / "SavedPostsDashboard" / "config.json"

    def write_fixture(self, raw):
        target = self.local_path()
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(raw)

    def client(self):
        import config
        import app
        config.DB_PATH = str(self.profile / "never-open.db")
        app.app.config.update(TESTING=True)
        return app.app.test_client()

    def check_response(self, response, expected):
        self.assertTrue(response.status_code == expected)
        self.assertTrue(response.headers.get("Cache-Control") == "no-store")
        text = response.get_data(as_text=True)
        self.assertTrue(all(value not in text for value in self.canaries))
        return response.get_json()

    def test_missing_defaults_and_path(self):
        helper = self.helper()
        self.assertTrue(helper.config_path() == self.local_path())
        self.assertTrue(helper.resolve_credentials() == (0, ""))
        self.assertTrue(helper.status() == {
            "api_id_configured": False, "api_hash_configured": False, "config_readable": True})
        self.assertTrue(not self.local_path().exists())

    def test_save_local_and_blank_preserve(self):
        helper = self.helper()
        helper.save_credentials(self.api_id, self.api_hash)
        self.assertTrue(helper.resolve_credentials() == (int(self.api_id), self.api_hash))
        helper.save_credentials("", "")
        self.assertTrue(helper.resolve_credentials() == (int(self.api_id), self.api_hash))
        helper.save_credentials(self.other_id, "")
        self.assertTrue(helper.resolve_credentials() == (int(self.other_id), self.api_hash))
        data = json.loads(self.local_path().read_bytes())
        self.assertTrue(set(data) == {"telegram"} and set(data["telegram"]) == {"api_id", "api_hash"})
        self.assertTrue(type(data["telegram"]["api_id"]) is int)
        self.assertTrue(all(type(value) is bool for value in helper.status().values()))

    def test_environment_presence_overrides_per_key(self):
        helper = self.helper()
        helper.save_credentials(self.api_id, self.api_hash)
        with patch.dict(os.environ, {"TELEGRAM_API_ID": self.other_id}):
            self.assertTrue(helper.resolve_credentials() == (int(self.other_id), self.api_hash))
        with patch.dict(os.environ, {"TELEGRAM_API_HASH": self.other_hash}):
            self.assertTrue(helper.resolve_credentials() == (int(self.api_id), self.other_hash))
        with patch.dict(os.environ, {"TELEGRAM_API_ID": "", "TELEGRAM_API_HASH": ""}):
            self.assertTrue(helper.resolve_credentials() == (0, ""))
        with patch.dict(os.environ, {"TELEGRAM_API_ID": self.api_hash}):
            self.assertTrue(helper.resolve_credentials() == (0, self.api_hash))
            import config
            importlib.reload(config)
            self.assertTrue(config.TELEGRAM_API_ID == 0)
        with patch.dict(os.environ, {"TELEGRAM_API_HASH": "bad-" + self.other_hash}):
            self.assertTrue(helper.resolve_credentials() == (int(self.api_id), ""))

    def test_environment_pair_and_partial_local_save(self):
        helper = self.helper()
        with patch.dict(os.environ, {"TELEGRAM_API_ID": self.api_id}):
            helper.save_credentials("", self.api_hash)
            self.assertTrue(helper.resolve_credentials() == (int(self.api_id), self.api_hash))
            data = json.loads(self.local_path().read_bytes())
            self.assertTrue("api_id" not in data["telegram"])
        self.assertTrue(helper.resolve_credentials() == (0, self.api_hash))
        with self.assertRaises(helper.ConfigError):
            helper.save_credentials("", "")

    def test_clear_only_local_never_environment(self):
        helper = self.helper()
        helper.save_credentials(self.api_id, self.api_hash)
        with patch.dict(os.environ, {"TELEGRAM_API_ID": self.other_id, "TELEGRAM_API_HASH": self.other_hash}):
            helper.clear_credentials()
            self.assertTrue(not self.local_path().exists())
            self.assertTrue(helper.resolve_credentials() == (int(self.other_id), self.other_hash))
            self.assertTrue(os.environ["TELEGRAM_API_ID"] == self.other_id)
            self.assertTrue(os.environ["TELEGRAM_API_HASH"] == self.other_hash)
            helper.clear_credentials()
        self.assertTrue(helper.resolve_credentials() == (0, ""))

    def test_invalid_values_and_missing_pair_do_not_write(self):
        helper = self.helper()
        for value in ("0", "-1", "+1", "1.5", "1e2", "2147483648", "9" * 4000, "１２", True, 12, None):
            with self.assertRaises(helper.ConfigError):
                helper.save_credentials(value, self.api_hash)
        for value in (self.api_hash[:-1], self.api_hash + "0", "g" + self.api_hash[1:], True, None):
            with self.assertRaises(helper.ConfigError):
                helper.save_credentials(self.api_id, value)
        for pair in (("", ""), (self.api_id, ""), ("", self.api_hash)):
            with self.assertRaises(helper.ConfigError):
                helper.save_credentials(*pair)
        self.assertTrue(not self.local_path().exists())
        helper.save_credentials("2147483647", self.api_hash.upper())
        self.assertTrue(helper.resolve_credentials() == (2147483647, self.api_hash.upper()))

    def test_malformed_bounded_shape_and_unreadable_file(self):
        helper = self.helper()
        invalid = [b"", b"{", b"null", b"[]", b"{}", b"x" * 4097,
                   json.dumps({"telegram": {"api_id": True, "api_hash": self.api_hash}}).encode(),
                   json.dumps({"telegram": {"api_id": self.api_id, "api_hash": self.api_hash}}).encode(),
                   json.dumps({"telegram": {"api_id": int(self.api_id), "api_hash": "bad"}}).encode(),
                   b'{"telegram":{},"session":"not-allowed"}',
                   b'{"telegram":{"api_id":1,"api_id":2}}',
                   b'{"telegram":{"extra":1}}', b"[" * 1500]
        for raw in invalid:
            self.write_fixture(raw)
            self.assertTrue(helper.status()["config_readable"] is False)
            self.assertTrue(helper.resolve_credentials() == (0, ""))
            with self.assertRaises(helper.ConfigError):
                helper.save_credentials(self.api_id, self.api_hash)
            self.assertTrue(self.local_path().read_bytes() == raw)
        helper.clear_credentials()
        self.local_path().mkdir()
        self.assertTrue(helper.status()["config_readable"] is False)
        with self.assertRaises(helper.ConfigError):
            helper.clear_credentials()
        self.local_path().rmdir()
        self.write_fixture(json.dumps({"telegram": {"api_id": int(self.api_id), "api_hash": self.api_hash}}).encode())
        with patch("builtins.open", side_effect=PermissionError(self.api_hash)):
            self.assertTrue(helper.status()["config_readable"] is False)

    def test_live_config_attributes_and_monkeypatch(self):
        helper = self.helper()
        import config
        self.assertTrue(config.TELEGRAM_API_ID == 0)
        helper.save_credentials(self.api_id, self.api_hash)
        self.assertTrue(config.TELEGRAM_API_ID == int(self.api_id))
        self.assertTrue(config.TELEGRAM_API_HASH == self.api_hash)
        with patch.object(config, "TELEGRAM_API_ID", int(self.other_id)):
            self.assertTrue(config.TELEGRAM_API_ID == int(self.other_id))
        self.assertTrue(config.TELEGRAM_API_ID == int(self.api_id))
        helper.clear_credentials()
        self.assertTrue(config.TELEGRAM_API_ID == 0 and config.TELEGRAM_API_HASH == "")

    def test_private_acl_before_bytes_and_atomic_replace(self):
        helper = self.helper()
        protect = helper._protect_file
        observations = []
        def inspect(path):
            observations.append(Path(path).stat().st_size == 0)
            protect(path)
            observations.append(windows_acl_is_private(path) if os.name == "nt" else stat.S_IMODE(Path(path).stat().st_mode) == 0o600)
        with patch.object(helper, "_protect_file", side_effect=inspect):
            helper.save_credentials(self.api_id, self.api_hash)
        self.assertTrue(observations == [True, True])
        self.assertTrue(windows_acl_is_private(self.local_path()) if os.name == "nt" else stat.S_IMODE(self.local_path().stat().st_mode) == 0o600)
        prior = self.local_path().read_bytes()
        with patch.object(helper, "_protect_file", side_effect=OSError(self.api_hash)):
            with self.assertRaises(helper.ConfigError):
                helper.save_credentials(self.other_id, self.other_hash)
        self.assertTrue(self.local_path().read_bytes() == prior)
        with patch.object(helper.os, "replace", side_effect=OSError(self.api_hash)):
            with self.assertRaises(helper.ConfigError):
                helper.save_credentials(self.other_id, self.other_hash)
        self.assertTrue(self.local_path().read_bytes() == prior)
        self.assertTrue(list(self.local_path().parent.iterdir()) == [self.local_path()])

    def test_concurrent_updates_preserve_pair(self):
        helper = self.helper()
        helper.save_credentials(self.api_id, self.api_hash)
        errors = []
        def save(identifier, digest):
            try:
                helper.save_credentials(identifier, digest)
            except Exception:
                errors.append(True)
        threads = [threading.Thread(target=save, args=(self.other_id, "")),
                   threading.Thread(target=save, args=("", self.other_hash))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertTrue(not errors)
        self.assertTrue(helper.resolve_credentials() == (int(self.other_id), self.other_hash))

    def test_reparse_target_and_parent_rejected(self):
        helper = self.helper()
        target = self.local_path()
        target.parent.mkdir()
        target.write_bytes(b"{}")
        real_lstat = helper.os.lstat
        def reparse(path, *args, **kwargs):
            info = real_lstat(path, *args, **kwargs)
            if Path(path) == target:
                class Reparse:
                    st_mode = stat.S_IFLNK
                    st_file_attributes = 0x400
                return Reparse()
            return info
        with patch.object(helper.os, "lstat", side_effect=reparse):
            self.assertTrue(helper.status()["config_readable"] is False)
            for operation in (lambda: helper.save_credentials(self.api_id, self.api_hash), helper.clear_credentials):
                with self.assertRaises(helper.ConfigError):
                    operation()
        self.assertTrue(target.read_bytes() == b"{}")

    def test_api_get_save_preserve_clear_and_no_secrets(self):
        client = self.client()
        data = self.check_response(client.get("/api/telegram/config"), 200)
        self.assertTrue(data == {"api_id_configured": False, "api_hash_configured": False, "config_readable": True})
        body = {"action": "save", "api_id": self.api_id, "api_hash": self.api_hash}
        for payload in (body, {"action": "save", "api_id": "", "api_hash": ""}):
            data = self.check_response(client.post("/api/telegram/config", json=payload,
                        headers={"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"}), 200)
            self.assertTrue(data == {"api_id_configured": True, "api_hash_configured": True, "config_readable": True})
        self.assertTrue(self.helper().resolve_credentials() == (int(self.api_id), self.api_hash))
        data = self.check_response(client.post("/api/telegram/config", json={"action": "clear", "confirm": True}), 200)
        self.assertTrue(data == {"api_id_configured": False, "api_hash_configured": False, "config_readable": True})
        self.assertTrue(not self.local_path().exists())

    def test_api_cross_site_query_content_and_strict_shape(self):
        client = self.client()
        body = {"action": "save", "api_id": self.api_id, "api_hash": self.api_hash}
        for headers in ({"Origin": "http://elsewhere.invalid"}, {"Origin": "null"},
                        {"Sec-Fetch-Site": "cross-site"},
                        {"Origin": "http://localhost", "Sec-Fetch-Site": "cross-site"}):
            self.check_response(client.get("/api/telegram/config", headers=headers), 403)
            self.check_response(client.post("/api/telegram/config", json=body, headers=headers), 403)
        self.check_response(client.get("/api/telegram/config?api_hash=" + self.api_hash), 400)
        self.check_response(client.post("/api/telegram/config?api_id=" + self.api_id, json=body), 400)
        self.check_response(client.post("/api/telegram/config", data=json.dumps(body), content_type="text/plain"), 415)
        for payload in ({}, [], None, {"action": "save"}, {**body, "extra": True},
                        {"action": "clear"}, {"action": "clear", "confirm": 1},
                        {"action": "clear", "confirm": True, "api_hash": self.api_hash},
                        {**body, "api_id": self.api_hash}, {**body, "api_hash": ""}):
            self.check_response(client.post("/api/telegram/config", data=json.dumps(payload), content_type="application/json"), 400)
        self.check_response(client.post("/api/telegram/config", data=b'{"action":"clear","action":"save"}', content_type="application/json"), 400)
        self.assertTrue(not self.local_path().exists())

    def test_api_size_bounded_stream_and_malformed_json(self):
        client = self.client()
        for raw, expected in ((b"{", 400), (b"[" * 1500, 400), (b"\xff", 400), (b" " * 4097, 413)):
            self.check_response(client.post("/api/telegram/config", data=raw, content_type="application/json"), expected)
        class Bounded(io.BytesIO):
            def read(self, size=-1):
                if size < 0 or size > 4097:
                    raise AssertionError("unbounded request read")
                return super().read(size)
        self.check_response(client.open("/api/telegram/config", method="POST", content_type="application/json",
            environ_overrides={"wsgi.input": Bounded(b" " * 9000), "wsgi.input_terminated": True,
                               "CONTENT_LENGTH": ""}), 413)

    def test_api_unreadable_and_unexpected_errors_are_generic(self):
        client = self.client()
        helper = self.helper()
        self.write_fixture(b"{")
        data = self.check_response(client.get("/api/telegram/config"), 200)
        self.assertTrue(data == {"api_id_configured": False, "api_hash_configured": False, "config_readable": False})
        body = {"action": "save", "api_id": self.api_id, "api_hash": self.api_hash}
        self.check_response(client.post("/api/telegram/config", json=body), 503)
        with patch.object(helper, "save_credentials", side_effect=RuntimeError(self.api_hash)):
            self.check_response(client.post("/api/telegram/config", json=body), 503)

    def test_http_access_logs_redact_queries(self):
        self.client()
        import app
        from werkzeug.serving import make_server

        canary = "B6_SYNTHETIC_QUERY_" + secrets.token_hex(16)
        self.canaries.append(canary)
        server = None
        worker = None
        responses = []
        allowed_address = None
        logger = logging.getLogger("werkzeug")
        self.stack.enter_context(patch.object(logger, "handlers", [logging.StreamHandler(self.output)]))
        self.stack.enter_context(patch.object(logger, "propagate", False))
        self.stack.enter_context(patch.object(logger, "level", logging.INFO))
        self.stack.enter_context(patch.dict(os.environ, {"FLASK_SKIP_DOTENV": "1"}))
        self.stack.enter_context(patch.object(app.config, "DASHBOARD_HOST", "127.0.0.1"))
        self.stack.enter_context(patch.object(app.config, "DASHBOARD_PORT", 0))

        def guarded_connect(sock, address):
            if allowed_address is None or address != allowed_address:
                raise AssertionError("only the owned HTTP fixture is allowed")
            return SOCKET_CONNECT(sock, address)

        def start_http(host, port, application, **options):
            nonlocal server, worker, allowed_address
            self.assertTrue(host == "127.0.0.1" and port == 0)
            server = make_server(host, port, application, request_handler=options.get("request_handler"))
            allowed_address = (host, server.server_port)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()

        self.stack.enter_context(patch.object(socket.socket, "connect", new=guarded_connect))
        self.stack.enter_context(patch.object(socket, "create_connection", new=CREATE_CONNECTION))

        def send(method, path, expected, body=None):
            connection = http.client.HTTPConnection(*allowed_address, timeout=5)
            try:
                headers = {"Content-Type": "application/json"} if body is not None else {}
                connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
                response = connection.getresponse()
                responses.append(response.read().decode("utf-8"))
                self.assertTrue(response.status == expected)
                if path.split("?", 1)[0] == "/api/telegram/config":
                    self.assertTrue(response.getheader("Cache-Control") == "no-store")
                return json.loads(responses[-1]) if responses[-1] and expected == 200 else None
            finally:
                connection.close()

        try:
            with patch("werkzeug.serving.run_simple", side_effect=start_http):
                app.run_dashboard()
            self.assertTrue(server is not None and worker.is_alive())
            target = "/api/telegram/config?api_id=" + self.api_id + "&api_hash=" + canary
            for method, code in (("GET", 400), ("POST", 400), ("HEAD", 400),
                                 ("OPTIONS", 200), ("PUT", 405), ("DELETE", 405)):
                send(method, target, code)
            print("http_query_and_framework_statuses_preserved: true", file=REPORT)
            with patch.object(app.storage, "search_posts", return_value=[]) as search:
                send("GET", "/api/posts?q=" + canary + "&limit=3", 200)
                search.assert_called_once_with(query=canary, category="", source="", limit=3)
            print("http_noncredential_query_processing_preserved: true", file=REPORT)
            data = send("POST", "/api/telegram/config", 200,
                        {"action": "save", "api_id": self.api_id, "api_hash": self.api_hash})
            self.assertTrue(data == {"api_id_configured": True, "api_hash_configured": True, "config_readable": True})
            self.assertTrue(send("GET", "/api/telegram/config", 200) == data)
            send("POST", "/api/telegram/config", 200, {"action": "clear", "confirm": True})
            self.assertTrue(not self.local_path().exists())
            self.assertTrue(all(value not in text for text in responses for value in self.canaries))
            print("http_save_status_clear_and_response_secrecy: true", file=REPORT)
            for suffix in ("HTTP/invalid", "HTTP/1.1 extra"):
                with socket.create_connection(allowed_address, timeout=5) as connection:
                    connection.sendall(("GET " + target + " " + suffix + "\r\nHost: localhost\r\n\r\n").encode("ascii"))
                    while connection.recv(8192):
                        pass
            print("http_malformed_request_checks_executed: true", file=REPORT)
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            if worker is not None:
                worker.join(timeout=5)
                self.assertTrue(not worker.is_alive())
            if allowed_address is not None:
                with self.assertRaises(OSError):
                    socket.create_connection(allowed_address, timeout=1)
            print("http_owned_server_closed: true", file=REPORT)
        logs = self.output.getvalue()
        self.assertTrue(all(token in logs for token in (
            "GET /api/telegram/config", "POST /api/telegram/config", "HEAD /api/telegram/config",
            "OPTIONS /api/telegram/config", "PUT /api/telegram/config", "DELETE /api/telegram/config",
            "GET /api/posts", "400", "405", "200")))
        print("http_access_diagnostics_preserved: true", file=REPORT)
        print("http_log_canaries_absent: " + str(all(value not in logs for value in self.canaries)).lower(), file=REPORT)


class BooleanResult(unittest.TestResult):
    """Never print exception objects, tracebacks, request bodies or config bytes."""
    def addSuccess(self, test):
        super().addSuccess(test)
        print(test._testMethodName + ": true", file=REPORT)

    def addFailure(self, test, err):
        self.failures.append((test, "sanitized failure"))
        print(test._testMethodName + ": false (assertion)", file=REPORT)

    def addError(self, test, err):
        self.errors.append((test, "sanitized error"))
        print(test._testMethodName + ": false (error)", file=REPORT)


if __name__ == "__main__":
    sys.addaudithook(protect_personal_files)
    result = BooleanResult()
    suite = (unittest.defaultTestLoader.loadTestsFromName("test_http_access_logs_redact_queries", ConfigTests)
             if "--http-only" in sys.argv else unittest.defaultTestLoader.loadTestsFromTestCase(ConfigTests))
    suite.run(result)
    print("all_checks_passed: " + str(result.wasSuccessful()).lower())
    sys.exit(0 if result.wasSuccessful() else 1)
