"""Telegram login/session checks; no real Telegram contact, no personal data.

Synthetic phone/code/password/api canaries stay in disposable local state.
Run with Python -B. Output contains check names and booleans only, not tracebacks.
"""
import asyncio
import contextlib
import ctypes
from ctypes import wintypes
import http.client
import importlib
import io
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
ACTIVE_PROFILE = None
REPORT = sys.stdout
SOCKET_CONNECT = socket.socket.connect
CREATE_CONNECTION = socket.create_connection

# Telethon is an optional runtime dependency, so the real-library check below is
# guarded; importing it never opens a socket, session file or credential.
try:
    from telethon import errors as telethon_errors
    from telethon import functions as telethon_functions
    from telethon import password as telethon_password
    from telethon import types as telethon_types
    from telethon.client.auth import AuthMethods
    TELETHON_PRESENT = True
except ImportError:
    TELETHON_PRESENT = False


def protect_personal_files(event, args):
    if event != "open" or not isinstance(args[0], (str, bytes, os.PathLike)):
        return
    path = Path(os.fsdecode(args[0])).absolute()
    inside = ACTIVE_PROFILE is not None and path.is_relative_to(ACTIVE_PROFILE)
    if path.name.startswith(".env"):
        raise PermissionError("environment file access forbidden")
    if path.suffix in (".session", ".db", ".sqlite") and not inside:
        raise PermissionError("personal storage access forbidden")
    if path.name == "config.json" and not inside:
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


# Synthetic exception classes whose names match Telethon's, so class-name error
# mapping is exercised without importing or contacting anything real.
class PhoneNumberInvalidError(Exception):
    pass


class PhoneCodeInvalidError(Exception):
    pass


class PhoneCodeExpiredError(Exception):
    pass


class PasswordHashInvalidError(Exception):
    pass


class SessionPasswordNeededError(Exception):
    pass


class SessionRevokedError(Exception):
    pass


class FloodWaitError(Exception):
    pass


class ApiIdInvalidError(Exception):
    pass


class _FakeSentCode:
    def __init__(self, phone_code_hash):
        self.phone_code_hash = phone_code_hash


class ScriptedClient:
    """Scripted offline stand-in for the Telethon client used by telegram_auth."""

    def __init__(self, path, authorized=False, on_connect=None, on_send_code=None,
                 on_code=None, on_password=None, log_out=None, on_probe=None,
                 log_out_result=True):
        self.path = Path(path)
        self.authorized = authorized
        self.calls = {"connect": 0, "send": 0, "code": 0, "password": 0, "logout": 0}
        self.sent_phone = None
        self.passwords = []
        self._on_connect = on_connect
        self._on_send_code = on_send_code
        self._on_code = on_code
        self._on_password = on_password
        self._log_out = log_out
        self._on_probe = on_probe
        self._log_out_result = log_out_result

    async def connect(self):
        self.calls["connect"] += 1
        if self._on_connect is not None:
            self._on_connect()

    async def disconnect(self):
        return None

    async def send_code_request(self, phone):
        self.calls["send"] += 1
        self.sent_phone = phone
        if self._on_send_code is not None:
            self._on_send_code()
        return _FakeSentCode("hash-" + secrets.token_hex(4))

    async def sign_in(self, phone=None, code=None, phone_code_hash=None, password=None):
        if password is not None:
            self.calls["password"] += 1
            # Mirrors bundled Telethon 1.45.0: sign_in -> compute_check ->
            # compute_hash calls password.encode('utf-8'), so a bytes password
            # raises AttributeError here exactly as it does against the library.
            self.passwords.append(password.encode("utf-8"))
            if self._on_password is not None:
                self._on_password()
            self.authorized = True
            return None
        self.calls["code"] += 1
        if self._on_code is not None:
            self._on_code()
        self.authorized = True
        return None

    async def is_user_authorized(self):
        if self._on_probe is not None:
            self._on_probe()
        return self.authorized

    async def log_out(self):
        self.calls["logout"] += 1
        if self._log_out is not None:
            self._log_out()
        self.authorized = False
        if self._log_out_result is not True:
            # Telethon returns False when the log-out RPC failed: the remote
            # authorization is still in place and the session file is untouched.
            return False
        self.path.unlink(missing_ok=True)
        return True


def forbid_network(sock, address):
    """Block every connect except the asyncio proactor self-pipe on loopback."""
    host = address[0] if isinstance(address, tuple) and address else address
    if host in ("127.0.0.1", "::1", "localhost"):
        return SOCKET_CONNECT(sock, address)
    raise AssertionError("network forbidden")


class AuthTests(unittest.TestCase):
    STATUS_KEYS = {"ok", "credentials_configured", "session_exists", "authorized",
                   "login_step", "expires_in"}
    ALLOWED_KEYS = STATUS_KEYS | {"result", "code", "error", "diagnostic"}

    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        temp = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="b7-telegram-auth-"))
        self.profile = Path(temp)
        global ACTIVE_PROFILE
        ACTIVE_PROFILE = self.profile
        self.assertTrue(".verify" not in self.profile.parts)
        self.stack.enter_context(patch.dict(os.environ, {
            "LOCALAPPDATA": str(self.profile), "MAX_MESSAGES": "200",
            "SAVED_POSTS_DB_PATH": str(self.profile / "SavedPostsDashboard" / "library.db"),
        }, clear=True))
        self.stack.enter_context(patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")))
        self.stack.enter_context(patch.object(socket.socket, "connect", new=forbid_network))
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        handler = logging.StreamHandler(self.output)
        logging.getLogger().addHandler(handler)
        self.stack.callback(logging.getLogger().removeHandler, handler)
        import config
        self.data = self.profile / "SavedPostsDashboard"
        self.session = self.data / "telegram.session"
        config.TELEGRAM_SESSION_FILE = str(self.session)
        import telegram_auth
        self.auth = telegram_auth
        telegram_auth._transaction = None
        telegram_auth._auth_cache = None
        self.addCleanup(self.reset_auth)
        # Guard: no test may construct a real Telethon client. The genuine factory
        # is retained for the single test that exercises the real client's retry
        # loop; that client is never connected and the socket guards above still
        # forbid any non-loopback transport.
        self.real_client_factory = telegram_auth._client_factory
        self.stack.enter_context(patch.object(telegram_auth, "_client_factory",
                                              side_effect=AssertionError("real client forbidden")))
        self.api_id = str(10000000 + secrets.randbelow(90000000))
        self.api_hash = secrets.token_hex(16)
        self.phone = "+1555" + str(1000000 + secrets.randbelow(9000000))
        self.code = str(secrets.randbelow(900000) + 100000)
        self.password = "pw-" + secrets.token_hex(8)
        self.canaries = [self.api_id, self.api_hash, self.phone, self.phone.lstrip("+"),
                         self.code, self.password, self.session.name]
        self.addCleanup(self.assert_no_logged_canaries)

    def reset_auth(self):
        self.auth._transaction = None
        self.auth._auth_cache = None

    def assert_no_logged_canaries(self):
        output = self.output.getvalue()
        self.assertTrue(all(value not in output for value in self.canaries))

    def configure(self):
        helper = importlib.import_module("telegram_config")
        helper.save_credentials(self.api_id, self.api_hash)

    def install(self, **kwargs):
        client = ScriptedClient(self.session, **kwargs)
        self.stack.enter_context(patch.object(self.auth, "_client_factory",
                                              return_value=client))
        return client

    def make_session_file(self, authorized=True, name=None, marker=None):
        path = self.session if name is None else self.data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        marker = marker or secrets.token_hex(16)
        path.write_bytes(b"synthetic-fixture " + marker.encode("ascii"))
        os.utime(path, (1000000000, 1000000000))
        return path, marker

    def assert_status_shape(self, data, allowed_steps=(None, "awaiting_code", "awaiting_password")):
        self.assertTrue(set(data) <= self.ALLOWED_KEYS)
        self.assertTrue(type(data["credentials_configured"]) is bool)
        self.assertTrue(type(data["session_exists"]) is bool)
        self.assertTrue(data["authorized"] in (True, False, None))
        self.assertTrue(data["login_step"] in allowed_steps)
        self.assertTrue(data["expires_in"] is None or type(data["expires_in"]) is int)

    def client(self):
        import config
        import app
        config.DB_PATH = str(self.profile / "never-open.db")
        app.app.config.update(TESTING=True)
        return app.app.test_client()

    def send(self, client, body, expected, headers=None, method="POST", path="/api/telegram/auth"):
        response = client.open(path, method=method,
                               json=body if body is not None else None,
                               headers=headers or {})
        self.assertTrue(response.status_code == expected, response.status_code)
        self.assertTrue(response.headers.get("Cache-Control") == "no-store")
        text = response.get_data(as_text=True)
        self.assertTrue(all(value not in text for value in self.canaries))
        data = response.get_json()
        if data is not None:
            self.assertTrue(set(data) <= self.ALLOWED_KEYS)
        return data

    def expect_error(self, call, code, status):
        with self.assertRaises(self.auth.AuthError) as caught:
            call()
        self.assertTrue(caught.exception.code == code, caught.exception.code)
        self.assertTrue(caught.exception.status == status)
        message = str(caught.exception)
        self.assertTrue(all(value not in message for value in self.canaries))

    # --- mandated state-machine matrix -------------------------------------

    def test_start_diagnostics_are_stage_and_class_only(self):
        self.configure()
        client = self.client()
        identifiers = {}
        for stage in ("CLIENT", "CONNECT", "REQUEST"):
            def fail():
                raise ValueError("synthetic " + self.phone + self.api_hash)
            self.install(on_connect=fail if stage == "CONNECT" else None,
                         on_send_code=fail if stage == "REQUEST" else None)
            boundary = patch.object(self.auth, "_make_client", side_effect=ValueError(self.phone)) if stage == "CLIENT" else contextlib.nullcontext()
            with boundary:
                data = self.send(client, {"action": "start", "phone": self.phone}, 400)
            self.assertEqual(data["code"], "unknown")
            self.assertRegex(data["diagnostic"], "^TG1-" + stage + "-[0-9A-F]{12}$")
            identifiers[stage] = data["diagnostic"].split("-")[-1]
            self.assertFalse(self.session.exists())
        self.assertEqual(len(set(identifiers.values())), 1)
        hostile = type("Secret" + self.api_hash, (Exception,), {})
        self.assertEqual(self.auth._failure_identifier("REQUEST", hostile(self.phone)), "TG1-REQUEST-OTHER")
        self.assertIsNone(self.auth.AuthError("unknown", diagnostic=self.api_hash).diagnostic)

    def test_missing_credentials_block_connect(self):
        self.expect_error(lambda: self.auth.start_login(self.phone), "configuration", 409)
        self.assertTrue(self.auth.status() == {
            "credentials_configured": False, "session_exists": False, "authorized": False,
            "login_step": None, "expires_in": None})
        self.assertTrue(not self.session.exists())
        # No session file: reported as not_connected without touching credentials.
        data = self.auth.check_authorization()
        self.assertTrue(data["result"] == "not_connected" and data["session_exists"] is False)
        client = self.client()
        data = self.send(client, {"action": "start", "phone": self.phone}, 409)
        self.assertTrue(data == {"ok": False, "code": "configuration",
                                 "error": self.auth._MESSAGES["configuration"]})

    def test_credentials_configured_allow_start(self):
        self.configure()
        sent = self.install()
        data = self.auth.start_login(self.phone)
        self.assertTrue(data["login_step"] == "awaiting_code" and data["session_exists"])
        self.assertTrue(0 < data["expires_in"] <= self.auth.LOGIN_TTL_SECONDS)
        self.assertTrue(sent.sent_phone == self.auth.normalize_phone(self.phone))
        self.assertTrue(sent.calls == {"connect": 1, "send": 1, "code": 0, "password": 0, "logout": 0})
        self.assertTrue(self.session.is_file())
        self.assertTrue(windows_acl_is_private(self.session))
        self.assertTrue(self.auth._transaction["phone_code_hash"].startswith("hash-"))

    def test_valid_code_connects_and_protects_session(self):
        self.configure()
        self.install()
        self.auth.start_login(self.phone)
        data = self.auth.submit_code(self.code)
        self.assertTrue(data["result"] == "connected" and data["authorized"] is True)
        self.assertTrue(data["login_step"] is None and data["session_exists"])
        self.assertTrue(self.auth._transaction is None)
        self.assertTrue(self.session.is_file() and windows_acl_is_private(self.session))
        blob = self.session.read_bytes()
        self.assertTrue(all(value.encode("ascii") not in blob for value in self.canaries))
        self.assertTrue(self.auth.check_authorization()["result"] == "connected")
        self.assertTrue(self.auth.status()["authorized"] is True)

    def test_code_client_validation_before_any_state(self):
        self.configure()
        for value in ("", "123", "123456789", "abcdef", "12 345", None, 123456, True):
            self.expect_error(lambda: self.auth.submit_code(value), "code_invalid", 400)
        self.assertTrue(self.auth._transaction is None)

    def test_wrong_code_keeps_step(self):
        self.configure()
        self.install(on_code=lambda: (_ for _ in ()).throw(PhoneCodeInvalidError("synthetic")))
        self.auth.start_login(self.phone)
        self.expect_error(lambda: self.auth.submit_code(self.code), "code_invalid", 400)
        self.assertTrue(self.auth.status()["login_step"] == "awaiting_code")
        self.assertTrue(self.session.is_file())

    def test_expired_code_aborts_and_removes_created_session(self):
        self.configure()
        self.install(on_code=lambda: (_ for _ in ()).throw(PhoneCodeExpiredError("synthetic")))
        self.auth.start_login(self.phone)
        self.expect_error(lambda: self.auth.submit_code(self.code), "code_expired", 400)
        self.assertTrue(self.auth.status()["login_step"] is None)
        self.assertTrue(not self.session.exists())

    def test_two_factor_path(self):
        self.configure()
        client = self.install(on_code=lambda: (_ for _ in ()).throw(SessionPasswordNeededError("synthetic")))
        self.auth.start_login(self.phone)
        data = self.auth.submit_code(self.code)
        self.assertTrue(data["result"] == "password_required")
        self.assertTrue(data["login_step"] == "awaiting_password")
        self.expect_error(lambda: self.auth.submit_code(self.code), "login_step", 409)
        for value in ("", "a" * 257, None, 123):
            self.expect_error(lambda: self.auth.submit_password(value), "password_invalid", 400)
        client._on_password = lambda: (_ for _ in ()).throw(PasswordHashInvalidError("synthetic"))
        self.expect_error(lambda: self.auth.submit_password(self.password), "password_invalid", 400)
        self.assertTrue(self.auth.status()["login_step"] == "awaiting_password")
        client._on_password = None
        data = self.auth.submit_password(self.password)
        self.assertTrue(data["result"] == "connected" and data["authorized"] is True)
        self.assertTrue(client.calls["password"] == 2 and self.auth._transaction is None)
        self.assertTrue(client.passwords == [self.password.encode("utf-8")] * 2)
        self.assertTrue(windows_acl_is_private(self.session))

    def test_two_factor_password_keeps_spaces_verbatim(self):
        """F4: a real 2FA password may contain spaces anywhere; never trim or reject."""
        self.configure()
        for spaced in ("two words apart", "  padded  ", "   ", "\tmiddle\tword\t"):
            client = self.install(
                on_code=lambda: (_ for _ in ()).throw(SessionPasswordNeededError("synthetic")))
            self.auth.start_login(self.phone)
            data = self.auth.submit_code(self.code)
            self.assertTrue(data["result"] == "password_required")
            data = self.auth.submit_password(spaced)
            self.assertTrue(data["result"] == "connected", repr(spaced))
            self.assertTrue(client.passwords == [spaced.encode("utf-8")], repr(spaced))
            self.assertTrue(self.auth.disconnect("remove_local")["result"] == "removed_local")

    @unittest.skipUnless(TELETHON_PRESENT, "telethon is not installed")
    def test_real_telethon_password_path_receives_text(self):
        """F1: the bundled Telethon sign_in hashes a str; bytes raise AttributeError."""
        algo = telethon_types.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow(
            salt1=b"synthetic-salt-1", salt2=b"synthetic-salt-2", g=3, p=b"synthetic-prime")
        password_info = telethon_types.account.Password(
            new_algo=algo,
            new_secure_algo=telethon_types.SecurePasswordKdfAlgoSHA512(salt=b"synthetic-secure"),
            secure_random=b"\x00" * 256,
            has_password=True, current_algo=algo, srp_B=b"\x02" * 256, srp_id=1)
        seen = []
        real_compute_hash = telethon_password.compute_hash

        def observing(supplied_algo, supplied_password):
            # Delegate to the real hasher so the library's own password.encode
            # step is genuinely exercised, not stubbed away.
            seen.append(supplied_password)
            return real_compute_hash(supplied_algo, supplied_password)

        class RealSignIn:
            sign_in = AuthMethods.sign_in

            async def get_me(self):
                return None

            async def __call__(self, request):
                if isinstance(request, telethon_functions.account.GetPasswordRequest):
                    return password_info
                raise AssertionError("no other request may be issued")

        error = ""
        with patch.object(telethon_password, "compute_hash", observing):
            try:
                asyncio.run(self.auth._sign_in_password(RealSignIn(), {}, self.password))
            except Exception as exc:
                error = type(exc).__name__ + ": " + str(exc)
        self.assertTrue(seen == [self.password])
        self.assertTrue("has no attribute 'encode'" not in error)
        # Hashing succeeded, so execution reached Telethon's SRP prime validation,
        # which rejects the synthetic prime. That stage is the library's own math.
        self.assertTrue(error == "ValueError: bad p/g in password", error)

    @unittest.skipUnless(TELETHON_PRESENT, "telethon is not installed")
    def test_retryable_rpc_errors_are_not_collapsed_into_value_error(self):
        """F5: with no request retries, Telethon's _call replaces every retryable
        RPC error with a bare ValueError, which the mapper can only call unknown."""
        client = self.real_client_factory(self.profile / "synthetic-retry.session",
                                          24681357, "0" * 32)
        self.addCleanup(client.session.close)
        client.session.set_dc(2, "127.0.0.1", 443)

        class StubSender:
            """Transport stand-in: no socket is opened, nothing leaves the host.
            The final scripted outcome repeats, so a script of one error keeps
            failing for every retry instead of silently succeeding."""

            def __init__(self, script):
                self.script, self.attempts = list(script), 0

            def send(self, request, ordered=False):
                self.attempts += 1
                item = self.script.pop(0) if len(self.script) > 1 else self.script[0]

                async def outcome():
                    if isinstance(item, Exception):
                        raise item
                    return telethon_types.auth.SentCode(
                        type=telethon_types.auth.SentCodeTypeApp(length=5),
                        phone_code_hash="synthetic-hash")
                return outcome()

        async def not_authorized():
            return False

        async def no_switch(new_dc):
            return None

        async def instant(_seconds):
            return None

        client.is_user_authorized = not_authorized
        client._switch_dc = no_switch
        request = telethon_functions.auth.SendCodeRequest(
            "+447700900000", 24681357, "0" * 32, telethon_types.CodeSettings())

        # A DC migration is recoverable: Telethon must switch and retry.
        migrate = StubSender([telethon_errors.NetworkMigrateError(None, 2), "ok"])
        client._sender = migrate
        sent = asyncio.run(client._call(migrate, request))
        self.assertTrue(migrate.attempts == 2, migrate.attempts)
        self.assertTrue(sent.phone_code_hash == "synthetic-hash")

        # Once retries are exhausted the real RPC error must survive, so the
        # diagnostic names the server fault instead of an opaque ValueError.
        broken = StubSender([telethon_errors.ServerError(None, "RPC_INTERNAL")])
        client._sender = broken
        with patch("asyncio.sleep", instant):
            with self.assertRaises(telethon_errors.ServerError):
                asyncio.run(client._call(broken, request))
        self.assertTrue(broken.attempts > 1, broken.attempts)
        self.assertTrue(self.auth._failure_identifier(
            "REQUEST", telethon_errors.ServerError(None, "RPC_INTERNAL"))
            != self.auth._failure_identifier("REQUEST", ValueError("synthetic")))

        # A flood wait must surface as flood, not sleep past the connect deadline.
        flooded = StubSender([telethon_errors.FloodWaitError(None, 5)])
        client._sender = flooded
        with self.assertRaises(telethon_errors.FloodWaitError):
            asyncio.run(client._call(flooded, request))
        self.assertTrue(flooded.attempts == 1, flooded.attempts)
        self.assertTrue(self.auth._map_exception(
            telethon_errors.FloodWaitError(None, 5)) == "flood")

    def test_logout_requires_confirmed_remote_revocation(self):
        """F2: never report success or delete the session without confirmed log-out."""
        self.configure()
        path, marker = self.make_session_file()
        # Telethon returns False when the log-out RPC failed.
        sent = self.install(authorized=True, log_out_result=False)
        self.expect_error(lambda: self.auth.disconnect(), "network", 503)
        self.assertTrue(sent.calls["logout"] == 1 and path.is_file())
        self.assertTrue(self.auth.status()["session_exists"] is True)
        self.assertTrue(self.auth.status()["authorized"] is None)
        # An authorization-probe failure must propagate, not read as "unauthorized".
        self.install(authorized=True, on_probe=lambda: (_ for _ in ()).throw(
            ConnectionError("synthetic")))
        self.expect_error(lambda: self.auth.disconnect(), "network", 503)
        self.assertTrue(path.is_file())
        self.assertTrue(self.auth.disconnect("remove_local")["result"] == "removed_local")
        self.assertTrue(not path.exists() and marker not in self.output.getvalue())

    def test_confirmed_logout_is_not_reported_as_session_locked(self):
        """F3: Telethon deletes its own session file, so that outcome is success."""
        self.configure()
        path, marker = self.make_session_file()
        sent = self.install(authorized=True)
        data = self.auth.disconnect()
        self.assertTrue(data["result"] == "logged_out")
        self.assertTrue(sent.calls["logout"] == 1 and not path.exists())
        self.assertTrue(self.auth.status()["session_exists"] is False)
        self.assertTrue(self.auth.status()["authorized"] is False)
        self.assertTrue(marker not in self.output.getvalue())

    def test_flood_and_network_and_locked_and_dependency(self):
        self.configure()
        self.install(on_send_code=lambda: (_ for _ in ()).throw(FloodWaitError("synthetic")))
        self.expect_error(lambda: self.auth.start_login(self.phone), "flood", 503)
        self.assertTrue(not self.session.exists() and self.auth._transaction is None)
        self.install(on_connect=lambda: (_ for _ in ()).throw(ConnectionError("synthetic")))
        self.expect_error(lambda: self.auth.start_login(self.phone), "network", 503)
        self.assertTrue(not self.session.exists())
        self.install(on_connect=lambda: (_ for _ in ()).throw(sqlite3.OperationalError("synthetic")))
        self.expect_error(lambda: self.auth.start_login(self.phone), "session_locked", 503)
        self.assertTrue(not self.session.exists())
        self.install(on_connect=lambda: (_ for _ in ()).throw(ApiIdInvalidError("synthetic")))
        self.expect_error(lambda: self.auth.start_login(self.phone), "invalid_credentials", 400)
        self.stack.enter_context(patch.object(self.auth, "_make_client",
                                              side_effect=self.auth.AuthError("dependency", 503)))
        self.expect_error(lambda: self.auth.start_login(self.phone), "dependency", 503)
        self.assertTrue(not self.session.exists())

    def test_cancel_login(self):
        self.configure()
        self.install()
        self.auth.start_login(self.phone)
        data = self.auth.cancel_login()
        self.assertTrue(data["result"] == "cancelled" and data["login_step"] is None)
        self.assertTrue(not self.session.exists())
        self.assertTrue(self.auth.cancel_login()["result"] == "idle")
        self.expect_error(lambda: self.auth.submit_code(self.code), "login_step", 409)

    def test_overlapping_login_blocked_and_restart(self):
        self.configure()
        sent = self.install()
        self.auth.start_login(self.phone)
        other = self.phone[:-1] + ("9" if self.phone[-1] != "9" else "8")
        self.expect_error(lambda: self.auth.start_login(other), "login_active", 409)
        self.assertTrue(sent.sent_phone == self.phone)
        data = self.auth.start_login(other, restart=True)
        self.assertTrue(data["login_step"] == "awaiting_code")
        self.assertTrue(sent.sent_phone == self.auth.normalize_phone(other))
        self.assertTrue(sent.calls["send"] == 2)

    def test_transaction_expiry_resets_state(self):
        self.configure()
        self.install()
        self.auth.start_login(self.phone)
        with self.auth._LOCK:
            self.auth._transaction["expires_at"] = time.monotonic() - 1
        status = self.auth.status()
        self.assertTrue(status["login_step"] is None and status["expires_in"] is None)
        self.assertTrue(not self.session.exists())
        self.expect_error(lambda: self.auth.submit_code(self.code), "login_step", 409)

    def test_existing_authorized_session_detected_and_untouched(self):
        self.configure()
        path, marker = self.make_session_file()
        stamp = path.stat().st_mtime_ns
        self.install(authorized=True,
                     on_send_code=lambda: self.fail("existing session must not send codes"))
        status = self.auth.status()
        self.assertTrue(status["session_exists"] and status["authorized"] is None
                        and status["login_step"] is None)
        data = self.auth.check_authorization()
        self.assertTrue(data["result"] == "connected" and data["authorized"] is True)
        self.assertTrue(path.read_bytes().endswith(marker.encode("ascii")))
        self.assertTrue(path.stat().st_mtime_ns == stamp)
        self.assertTrue(self.auth.status()["authorized"] is True)

    def test_unauthorized_and_revoked_existing_session_reported_safely(self):
        self.configure()
        path, marker = self.make_session_file(authorized=False)
        self.install(authorized=False)
        data = self.auth.check_authorization()
        self.assertTrue(data["result"] == "not_authorized" and data["code"] == "unauthorized")
        self.assertTrue(data["authorized"] is False and path.is_file())
        self.install(on_connect=lambda: (_ for _ in ()).throw(SessionRevokedError("synthetic")))
        data = self.auth.check_authorization()
        self.assertTrue(data["result"] == "unknown" and data["code"] == "revoked")
        self.assertTrue(self.auth.status()["authorized"] is None and path.is_file())
        self.assertTrue(self.auth.disconnect()["result"] == "logged_out")
        self.assertTrue(not path.exists())
        self.assertTrue(marker not in self.output.getvalue())

    def test_disconnect_semantics(self):
        self.configure()
        self.assertTrue(self.auth.disconnect()["result"] == "already_disconnected")
        self.expect_error(lambda: self.auth.disconnect("wipe"), "unknown", 400)
        self.install()
        self.auth.start_login(self.phone)
        self.auth.submit_code(self.code)
        self.assertTrue(self.session.is_file())
        sent = self.install(authorized=False,
                            log_out=lambda: self.fail("log_out on unauthorized session"))
        self.assertTrue(self.auth.disconnect()["result"] == "logged_out")
        self.assertTrue(not self.session.exists() and sent.calls["logout"] == 0)
        path, _ = self.make_session_file()
        self.install(authorized=True, on_connect=lambda: (_ for _ in ()).throw(ConnectionError("synthetic")))
        self.expect_error(lambda: self.auth.disconnect(), "network", 503)
        self.assertTrue(path.is_file())
        self.stack.enter_context(patch.object(self.auth, "_make_client",
                                              side_effect=AssertionError("remove_local must stay offline")))
        self.assertTrue(self.auth.disconnect("remove_local")["result"] == "removed_local")
        self.assertTrue(not path.exists())
        self.assertTrue(self.auth.status()["authorized"] is False)

    def test_session_acl_failures_fail_closed(self):
        self.configure()
        self.install()
        helper = importlib.import_module("telegram_config")
        with patch.object(helper, "protect_file", side_effect=OSError("synthetic")):
            self.expect_error(lambda: self.auth.start_login(self.phone), "session_acl", 500)
        self.assertTrue(not self.session.exists() and self.auth._transaction is None)
        self.auth.start_login(self.phone)
        with patch.object(helper, "protect_file", side_effect=OSError("synthetic")):
            self.expect_error(lambda: self.auth.submit_code(self.code), "session_acl", 500)
        self.assertTrue(not self.session.exists())
        self.assertTrue(self.auth.status()["authorized"] is False)

    def test_phone_normalization(self):
        normalize = self.auth.normalize_phone
        self.assertTrue(normalize("+1 (555) 123-4567") == "+15551234567")
        self.assertTrue(normalize("15551234567") == "+15551234567")
        for value in ("", "+12345", "1234567890123456", "+1555abc4567", "x" * 33,
                      None, 15551234567, True, "+", "++15551234567"):
            self.assertTrue(normalize(value) == "", repr(value))
        self.configure()
        self.install()
        for value in (None, 123, "", "abc"):
            self.expect_error(lambda: self.auth.start_login(value), "invalid_phone", 400)
        self.expect_error(lambda: self.auth.start_login("+" + self.api_hash), "invalid_phone", 400)
        self.assertTrue(not self.session.exists())

    # --- API exposure and HTTP protections ----------------------------------

    def test_http_status_response_never_contains_session_internals(self):
        self.configure()
        self.install()
        client = self.client()
        data = self.send(client, None, 200, method="GET")
        self.assertTrue(data["ok"] is True and data["credentials_configured"])
        self.assert_status_shape(data)
        text = json.dumps(data)
        self.assertTrue(str(self.session) not in text and self.session.name not in text)
        self.auth.start_login(self.phone)
        data = self.send(client, {"action": "status"}, 200)
        self.assertTrue(data["login_step"] == "awaiting_code" and data["expires_in"] > 0)
        raw = json.dumps(data).encode("ascii")
        self.assertTrue(len(raw) < 1024)
        for method in ("HEAD",):
            response = client.open("/api/telegram/auth", method=method)
            self.assertTrue(response.status_code == 200)
            self.assertTrue(response.headers.get("Cache-Control") == "no-store")

    def test_http_route_protections(self):
        self.configure()
        client = self.client()
        canary = "Q" + secrets.token_hex(8)
        response = client.get("/api/telegram/auth?code=" + canary)
        self.assertTrue(response.status_code == 400)
        self.assertTrue(canary not in response.get_data(as_text=True))
        self.assertTrue(response.headers.get("Cache-Control") == "no-store")
        self.send(client, {"action": "status"}, 403, headers={"Origin": "http://evil.example"})
        self.send(client, {"action": "status"}, 403, headers={"Sec-Fetch-Site": "cross-site"})
        response = client.post("/api/telegram/auth", data="{}", content_type="text/plain")
        self.assertTrue(response.status_code == 415 and response.get_json()["code"] == "content_type")
        response = client.post("/api/telegram/auth", json={"action": "start", "phone": "x" * 5000})
        self.assertTrue(response.status_code == 413 and response.get_json()["code"] == "too_large")
        response = client.post("/api/telegram/auth", data=b'{"action": "status", "action": "check"}',
                               content_type="application/json")
        self.assertTrue(response.status_code == 400)
        for body in ({"action": "unknown"}, {"action": "start"}, {"action": "code"},
                     {"action": "disconnect"}, {"action": "status", "extra": 1},
                     {"action": "check", "phone": self.phone}, [], "x", 5):
            self.send(client, body, 400)
        self.send(client, {"action": "check", "phone": self.phone, "code": self.code}, 400)

    def test_http_full_login_flow_and_generic_503_never_leaks(self):
        self.configure()
        self.install()
        client = self.client()
        data = self.send(client, {"action": "start", "phone": self.phone}, 200)
        self.assertTrue(data["ok"] is True and data["login_step"] == "awaiting_code")
        data = self.send(client, {"action": "code", "code": self.code}, 200)
        self.assertTrue(data["result"] == "connected" and data["authorized"] is True)
        data = self.send(client, {"action": "check"}, 200)
        self.assertTrue(data["result"] == "connected")
        data = self.send(client, {"action": "disconnect", "mode": "logout"}, 200)
        self.assertTrue(data["result"] == "logged_out")
        self.assertTrue(not self.session.exists())
        canary = "E" + secrets.token_hex(8)
        self.canaries.append(canary)
        with patch.object(self.auth, "status",
                          side_effect=RuntimeError("synthetic failure " + canary)):
            data = self.send(client, {"action": "status"}, 503)
        self.assertTrue(data == {"ok": False, "code": "unavailable",
                                 "error": "Telegram account service is unavailable. Nothing was confirmed."})
        self.assertTrue(canary not in self.output.getvalue())

    def test_http_access_logs_redact_queries(self):
        self.configure()
        self.install()
        import app
        from werkzeug.serving import make_server

        query_canary = "B7_SYNTHETIC_QUERY_" + secrets.token_hex(16)
        body_canary = "B7_SYNTHETIC_BODY_" + secrets.token_hex(16)
        self.canaries += [query_canary, body_canary]
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
            host = address[0] if isinstance(address, tuple) and address else address
            # Loopback only: the asyncio proactor self-pipe and the owned HTTP
            # fixture both bind 127.0.0.1; every external destination is refused.
            if host in ("127.0.0.1", "::1"):
                return SOCKET_CONNECT(sock, address)
            raise AssertionError("only loopback fixture traffic is allowed")

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
                text = response.read().decode("utf-8")
                responses.append(text)
                self.assertTrue(response.status == expected)
                self.assertTrue(response.getheader("Cache-Control") == "no-store")
                self.assertTrue(all(value not in text for value in self.canaries))
            finally:
                connection.close()

        try:
            with patch("werkzeug.serving.run_simple", side_effect=start_http):
                app.run_dashboard()
            self.assertTrue(server is not None and worker.is_alive())
            target = "/api/telegram/auth?phone=" + self.phone + "&code=" + query_canary
            for method, code in (("GET", 400), ("POST", 400), ("HEAD", 400),
                                 ("OPTIONS", 200), ("PUT", 405), ("DELETE", 405)):
                send(method, target, code)
            send("GET", "/api/telegram/auth", 200)
            send("POST", "/api/telegram/auth", 200, {"action": "start", "phone": self.phone})
            send("POST", "/api/telegram/auth", 200, {"action": "code", "code": self.code})
            send("POST", "/api/telegram/auth", 200, {"action": "disconnect", "mode": "logout"})
            # A rejected request still carries the body canary; it must never be
            # logged or echoed, and the generic 503 path must swallow the value.
            send("POST", "/api/telegram/auth", 400, {"action": "code", "code": body_canary})
            import telegram_auth as auth_module
            with patch.object(auth_module, "status",
                              side_effect=RuntimeError("synthetic failure " + body_canary)):
                send("POST", "/api/telegram/auth", 503, {"action": "status"})
            self.assertTrue(all(body_canary not in text for text in responses))
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
        logs = self.output.getvalue()
        self.assertTrue(all(token in logs for token in (
            "GET /api/telegram/auth", "POST /api/telegram/auth", "HEAD /api/telegram/auth",
            "OPTIONS /api/telegram/auth", "PUT /api/telegram/auth", "DELETE /api/telegram/auth",
            "400", "405", "200", "503")))
        self.assertTrue(query_canary not in logs and body_canary not in logs)
        self.assertTrue(self.phone not in logs and self.phone.lstrip("+") not in logs)
        self.assertTrue(all(value not in logs for value in self.canaries))

    def test_backup_export_never_contains_session_material(self):
        self.configure()
        self.install()
        import config
        import storage
        import library_backup
        config.DB_PATH = str(self.profile / "SavedPostsDashboard" / "library.db")
        storage.init_db()
        self.auth.start_login(self.phone)
        data = self.auth.submit_code(self.code)
        self.assertTrue(data["result"] == "connected")
        marker = secrets.token_hex(16)
        with open(self.session, "ab") as stream:
            stream.write(marker.encode("ascii"))
        document = library_backup.export_backup()
        text = json.dumps(document)
        self.assertTrue(set(document) == {"format", "version", "exportedAt",
                                          "recordCount", "library", "sha256"})
        for value in self.canaries + [marker, "telegram.session"]:
            self.assertTrue(value not in text)


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
    suite = (unittest.defaultTestLoader.loadTestsFromName("test_http_access_logs_redact_queries", AuthTests)
             if "--http-only" in sys.argv else unittest.defaultTestLoader.loadTestsFromTestCase(AuthTests))
    suite.run(result)
    print("all_checks_passed: " + str(result.wasSuccessful()).lower())
    sys.exit(0 if result.wasSuccessful() else 1)
