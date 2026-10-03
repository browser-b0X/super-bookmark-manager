"""Telegram account login/session service. Backend-only Telethon interaction.

One bounded in-memory login transaction at a time (phone -> code -> optional 2FA
password). Transaction state is short-lived, thread-locked and TTL-expired; an
app restart aborts any login in progress and never resumes credential prompts.
Phone, verification code and 2FA password are used once, held only in transient
memory, and never logged, persisted, returned or echoed. The authorized session
is a normal Telethon file-backed session at config.TELEGRAM_SESSION_FILE
(resolved at call time), protected with the same user-local ACL as the
developer-key config file: Telegram session protected by Windows user-local
filesystem permissions; not an encrypted credential vault.
"""
import asyncio
import builtins
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import threading
import time

import config
import telegram_config


def _client_factory(session_file, api_id, api_hash):
    """Test seam: unit tests replace this factory with a scripted fake client.

    request_retries must stay positive. Telethon recovers from a DC migration or a
    transient server fault by retrying; with no attempt left it discards the real RPC
    error and raises a bare ValueError that this module can only report as "unknown".
    flood_sleep_threshold is 0 so a wait raises at once instead of outlasting the
    caller's connect deadline and being misreported as unreachable.
    """
    from telethon import TelegramClient
    return TelegramClient(str(session_file), api_id, api_hash,
                          connection_retries=0, request_retries=5, timeout=15,
                          raise_last_call_error=True, flood_sleep_threshold=0)


LOGIN_TTL_SECONDS = 300
_AUTH_CACHE_TTL_SECONDS = 120
_CONNECT_TIMEOUT_SECONDS = 30
_PROBE_TIMEOUT_SECONDS = 20

_LOCK = threading.RLock()
_transaction = None  # {"step", "phone", "phone_code_hash", "expires_at", "created_session"}
_auth_cache = None   # {"at", "authorized"}

_ERROR_CODES = {
    "PhoneNumberInvalidError": "invalid_phone",
    "PhoneNumberBannedError": "invalid_credentials",
    "PhoneCodeInvalidError": "code_invalid",
    "PhoneCodeEmptyError": "code_invalid",
    "PhoneCodeExpiredError": "code_expired",
    "PhoneCodeHashEmptyError": "code_expired",
    "PasswordHashInvalidError": "password_invalid",
    "FloodWaitError": "flood",
    "SlowModeWaitError": "flood",
    "ApiIdInvalidError": "invalid_credentials",
    "AuthKeyError": "invalid_credentials",
    "AuthKeyUnregisteredError": "revoked",
    "AuthKeyDuplicatedError": "revoked",
    "SessionRevokedError": "revoked",
    "UserDeactivatedError": "revoked",
    "UserDeactivatedBanError": "revoked",
}

_MESSAGES = {
    "invalid_phone": "Telegram rejected this phone number format. Enter the full number in international form, like +15551234567.",
    "invalid_credentials": "Telegram rejected the developer API credentials. Check the API ID and API hash, then start again.",
    "code_invalid": "That verification code is incorrect. Check the code Telegram sent and try again.",
    "code_expired": "The verification code expired. Start the connection again to receive a new code.",
    "password_required": "This account uses two-step verification. Enter your Telegram password.",
    "password_invalid": "That two-step verification password is incorrect. Try again.",
    "flood": "Telegram is rate-limiting login attempts. Wait, then try again.",
    "network": "Could not reach Telegram. Check the network connection, then try again.",
    "session_locked": "The local Telegram session file is locked or unreadable. Close other copies of the app, then try again.",
    "session_acl": "Windows refused to protect the local session file. The login was aborted and no session material was stored.",
    "dependency": "Live Telegram login needs Telethon in the server Python. Use the packaged runtime or install telethon.",
    "revoked": "Telegram reports this session authorization is revoked or invalid. Connect again to create a new session.",
    "cancelled": "The login attempt was cancelled.",
    "login_active": "A Telegram login is already in progress. Cancel or restart it before trying again.",
    "login_step": "That step does not match the current login state. Check the login status and try again.",
    "configuration": "Configure the Telegram API ID and API hash first, then connect the account.",
    "unknown": "Telegram login failed. No session was authorized by this attempt. Try again.",
}


class AuthError(RuntimeError):
    """Fixed safe message per code; never constructed with user-supplied values."""

    def __init__(self, code, status=400, diagnostic=None):
        super().__init__(_MESSAGES.get(code, _MESSAGES["unknown"]))
        self.code, self.status = code, status
        self.diagnostic = diagnostic if isinstance(diagnostic, str) and re.fullmatch(
            r"TG1-(?:(?:CLIENT|CONNECT|REQUEST)-(?:[0-9A-F]{12}|OTHER)|RESULT-EMPTY)", diagnostic) else None


def session_path() -> Path:
    return Path(config.TELEGRAM_SESSION_FILE)


def normalize_phone(value):
    """Conservative E.164-style normalization; returns '' when not plausible."""
    if not isinstance(value, str) or len(value) > 32:
        return ""
    cleaned = re.sub(r"[\s\-.()]+", "", value)
    if not cleaned.startswith("+"):
        cleaned = "+" + cleaned
    digits = cleaned[1:]
    if not re.fullmatch(r"[0-9]{7,15}", digits):
        return ""
    return "+" + digits


def _map_exception(exc):
    name = type(exc).__name__
    if name == "SessionPasswordNeededError":
        return "password_required"
    if name in _ERROR_CODES:
        return _ERROR_CODES[name]
    if isinstance(exc, sqlite3.Error):
        return "session_locked"
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError, OSError)):
        return "network"
    return "unknown"


def _make_client(session_file, api_id, api_hash):
    if os.environ.get("SAVED_POSTS_TELEGRAM_AUTH_FAKE") == "1":
        return _FakeClient(Path(session_file))
    try:
        return _client_factory(session_file, api_id, api_hash)
    except ImportError:
        raise AuthError("dependency", 503) from None


def _require_credentials():
    api_id, api_hash = telegram_config.resolve_credentials()
    if not api_id or not api_hash:
        raise AuthError("configuration", 409)
    return api_id, api_hash


def _unlink_session_quietly():
    try:
        session_path().unlink(missing_ok=True)
    except OSError:
        pass


def _expire_locked():
    if _transaction is not None and time.monotonic() >= _transaction["expires_at"]:
        _abort_locked()


def _abort_locked():
    """Drop the transaction; remove a session file this transaction created."""
    global _transaction
    transaction, _transaction = _transaction, None
    if transaction is not None and transaction.get("created_session"):
        _unlink_session_quietly()


def _protect_session(path):
    try:
        telegram_config.protect_file(path)
    except Exception:
        raise AuthError("session_acl", 500) from None


def _prepare_session_file():
    """Create (if missing) and protect the session file before secret bytes."""
    path = session_path()
    created = False
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(path, "xb") as stream:
                stream.flush()
                os.fsync(stream.fileno())
            created = True
        except FileExistsError:
            pass
        except OSError:
            raise AuthError("session_locked", 503) from None
    try:
        _protect_session(path)
    except AuthError:
        if created:
            _unlink_session_quietly()
        raise
    return created


def _failure_identifier(stage, exc):
    """Fingerprint only a trusted exception class, never its text or arguments."""
    from telethon import errors
    cls = type(exc)
    trusted = any(cls is value for namespace in (vars(builtins), vars(errors))
                  for value in namespace.values() if isinstance(value, type))
    category = (hashlib.sha256((cls.__module__ + "." + cls.__qualname__).encode("ascii"))
                .hexdigest()[:12].upper()) if trusted else "OTHER"
    return "TG1-" + stage + "-" + category


async def _run_connect_step(action, api_id, api_hash, diagnose=False):
    """One bounded client lifecycle per HTTP step: connect, act, disconnect."""
    client = None
    stage = "CLIENT"
    try:
        client = _make_client(session_path(), api_id, api_hash)
        async with asyncio.timeout(_CONNECT_TIMEOUT_SECONDS):
            stage = "CONNECT"
            await client.connect()
            stage = "REQUEST"
            return await action(client)
    except Exception as exc:
        if diagnose and not isinstance(exc, AuthError) and _map_exception(exc) == "unknown":
            raise AuthError("unknown", 400, _failure_identifier(stage, exc)) from None
        raise
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.disconnect(), timeout=5)
            except Exception:
                pass


def status():
    """Booleans/enums only: never session bytes, path, phone, code or hash.

    Never waits behind a network step (login, check, refresh can hold the
    session for tens of seconds): if the lock is busy, answer from the last
    known state and say so.
    """
    global _auth_cache
    if not _LOCK.acquire(timeout=0.5):
        api_id, api_hash = telegram_config.resolve_credentials()
        cache, transaction = _auth_cache, _transaction
        return {
            "credentials_configured": bool(api_id and api_hash),
            "session_exists": session_path().is_file(),
            "authorized": cache["authorized"] if cache else None,
            "login_step": transaction["step"] if transaction else None,
            "expires_in": (max(0, int(transaction["expires_at"] - time.monotonic())) if transaction else None),
            "busy": True,
        }
    try:
        return _status_locked()
    finally:
        _LOCK.release()


def _status_locked():
    global _auth_cache
    _expire_locked()
    session_exists = session_path().is_file()
    if not session_exists:
        authorized = False
        _auth_cache = None
    elif (_auth_cache is not None
          and time.monotonic() - _auth_cache["at"] < _AUTH_CACHE_TTL_SECONDS):
        authorized = _auth_cache["authorized"]
    else:
        authorized = None
    api_id, api_hash = telegram_config.resolve_credentials()
    return {
        "credentials_configured": bool(api_id and api_hash),
        "session_exists": session_exists,
        "authorized": authorized,
        "login_step": _transaction["step"] if _transaction else None,
        "expires_in": (max(0, int(_transaction["expires_at"] - time.monotonic()))
                       if _transaction else None),
    }


def check_authorization():
    """Bounded authorization probe; never sends codes or creates a session file."""
    global _auth_cache
    if not session_path().is_file():
        return {**status(), "result": "not_connected", "code": ""}
    api_id, api_hash = _require_credentials()

    async def probe(client):
        async with asyncio.timeout(_PROBE_TIMEOUT_SECONDS):
            return bool(await client.is_user_authorized())

    with _LOCK:
        try:
            authorized = asyncio.run(_run_connect_step(probe, api_id, api_hash))
        except AuthError:
            raise
        except Exception as exc:
            _auth_cache = None
            return {**status(), "result": "unknown", "code": _map_exception(exc)}
        _auth_cache = {"at": time.monotonic(), "authorized": authorized}
        return {**status(), "result": "connected" if authorized else "not_authorized",
                "code": "" if authorized else "unauthorized"}


def start_login(phone_raw, restart=False):
    global _transaction
    with _LOCK:
        _expire_locked()
        if _transaction is not None:
            if restart is not True:
                raise AuthError("login_active", 409)
            _abort_locked()
        api_id, api_hash = _require_credentials()
        phone = normalize_phone(phone_raw)
        if not phone:
            raise AuthError("invalid_phone")
        created = _prepare_session_file()

        async def send_code(client):
            return await client.send_code_request(phone)

        try:
            sent = asyncio.run(_run_connect_step(send_code, api_id, api_hash, diagnose=True))
            phone_code_hash = getattr(sent, "phone_code_hash", None)
            if not isinstance(phone_code_hash, str) or not phone_code_hash:
                raise AuthError("unknown", 503, "TG1-RESULT-EMPTY")
        except AuthError:
            if created:
                _unlink_session_quietly()
            raise
        except Exception as exc:
            if created:
                _unlink_session_quietly()
            code = _map_exception(exc)
            raise AuthError(code, 503 if code in ("network", "flood", "session_locked",
                                                  "dependency") else 400) from None
        _transaction = {
            "step": "awaiting_code",
            "phone": phone,
            "phone_code_hash": phone_code_hash,
            "expires_at": time.monotonic() + LOGIN_TTL_SECONDS,
            "created_session": created,
        }
        return status()


def _submit_secret(step, value, prepare, invalid_code, sign):
    """Shared code/2FA step: the secret is transient and never stored."""
    global _transaction, _auth_cache
    secret = prepare(value) if isinstance(value, str) else None
    if secret is None:
        raise AuthError(invalid_code)
    with _LOCK:
        _expire_locked()
        if _transaction is None or _transaction["step"] != step:
            raise AuthError("login_step", 409)
        api_id, api_hash = _require_credentials()
        transaction = _transaction

        async def attempt(client):
            return await sign(client, transaction, secret)

        try:
            outcome = asyncio.run(_run_connect_step(attempt, api_id, api_hash))
        except AuthError:
            raise
        except Exception as exc:
            code = _map_exception(exc)
            if code == "password_required":
                _transaction = {**transaction, "step": "awaiting_password",
                                "expires_at": time.monotonic() + LOGIN_TTL_SECONDS}
                return {**status(), "result": "password_required"}
            if code in ("code_expired", "revoked"):
                _abort_locked()
            raise AuthError(code, 503 if code in ("network", "flood", "session_locked",
                                                  "dependency") else 400) from None
        if outcome is not True:
            raise AuthError("unknown", 503)
        _transaction = None
        _auth_cache = {"at": time.monotonic(), "authorized": True}
    try:
        _protect_session(session_path())
    except AuthError:
        # Fail closed: never leave an authorized session without the ACL.
        with _LOCK:
            _auth_cache = None
            _unlink_session_quietly()
        raise
    return {**status(), "result": "connected"}


async def _sign_in_code(client, transaction, code):
    await client.sign_in(phone=transaction["phone"], code=code,
                         phone_code_hash=transaction["phone_code_hash"])
    return True


async def _sign_in_password(client, transaction, password):
    # Telethon hashes the password itself (compute_check -> password.encode),
    # so a bytes value raises AttributeError before verification is attempted.
    await client.sign_in(password=password)
    return True


def _prepare_code(value):
    code = value.strip()
    return code if re.fullmatch(r"[0-9]{4,8}", code) else None


def _prepare_password(value):
    # Bounded nonempty text, forwarded verbatim: a real 2FA password may
    # contain spaces anywhere, including at either edge.
    return value if 0 < len(value) <= 256 else None


def submit_code(code):
    return _submit_secret("awaiting_code", code, _prepare_code, "code_invalid", _sign_in_code)


def submit_password(password):
    return _submit_secret("awaiting_password", password, _prepare_password,
                          "password_invalid", _sign_in_password)


def cancel_login():
    with _LOCK:
        _expire_locked()
        if _transaction is not None:
            _abort_locked()
            return {**status(), "result": "cancelled"}
        return {**status(), "result": "idle"}


def disconnect(mode="logout"):
    """logout: remote log-out then local removal. remove_local: local file only."""
    global _auth_cache
    if mode not in ("logout", "remove_local"):
        raise AuthError("unknown")
    with _LOCK:
        _expire_locked()
        if _transaction is not None:
            _abort_locked()
        _auth_cache = None
        path = session_path()
        if not path.is_file():
            return {**status(), "result": "already_disconnected"}
        if mode == "logout":
            api_id, api_hash = _require_credentials()

            async def log_out(client):
                # A probe failure must propagate: without it, revocation is unknown.
                if not await client.is_user_authorized():
                    return False
                if not await client.log_out():
                    # Telethon returns False when the log-out RPC failed, leaving the
                    # remote authorization in place. Never report that as logged out.
                    raise AuthError("network", 503)
                return True

            try:
                asyncio.run(_run_connect_step(log_out, api_id, api_hash))
            except AuthError:
                raise
            except Exception as exc:
                code = _map_exception(exc)
                if code != "revoked":
                    # Remote invalidation unconfirmed: keep the local file and be explicit.
                    raise AuthError("network" if code in ("network", "flood", "unknown") else code,
                                    503) from None
        try:
            # A confirmed Telethon log-out already deleted this file.
            path.unlink(missing_ok=True)
        except OSError:
            raise AuthError("session_locked", 503) from None
        return {**status(), "result": "logged_out" if mode == "logout" else "removed_local"}


class _FakeSentCode:
    def __init__(self, phone_code_hash):
        self.phone_code_hash = phone_code_hash


class _FakeClient:
    """Deterministic synthetic auth provider for automated tests only.

    Enabled solely by SAVED_POSTS_TELEGRAM_AUTH_FAKE=1 (packaged-runtime and
    browser verification; never contacts Telegram). Documented rules:
      phone ending '9' -> send_code_request fails (simulated network error);
      code '111111' -> success, '000000' -> expired, anything else -> invalid;
      phone ending '2' -> success requires 2FA (SessionPasswordNeededError),
      password 'fake-2fa-password' succeeds, anything else is rejected.
    sign_in and log_out deliberately match real Telethon 1.45.0 semantics (text
    password, self-deleting session file, boolean log-out result) so this seam
    cannot hide a divergence from the bundled library again.
    Success writes a real (schema-valid) Telethon SQLiteSession auth key, so the
    file is a genuine session artifact that is NOT registered with Telegram;
    the real refresh path therefore still fails safe on authorization.
    """

    def __init__(self, path):
        self._path = Path(path)
        self._sess = None

    def _session(self):
        # Cache one session per client and close it on disconnect(), mirroring the
        # real TelegramClient lifecycle. SQLiteSession does not release its Windows
        # file handle on garbage collection, so an explicit close is required before
        # the service can unlink the session file during logout.
        if self._sess is None:
            from telethon.sessions import SQLiteSession
            session_id = str(self._path)
            suffix = ".session"
            if session_id.endswith(suffix):
                session_id = session_id[: -len(suffix)]
            self._sess = SQLiteSession(session_id)
        return self._sess

    async def connect(self):
        return None

    async def disconnect(self):
        if self._sess is not None:
            try:
                self._sess.close()
            except Exception:
                pass
            self._sess = None
        return None

    async def send_code_request(self, phone):
        if str(phone).endswith("9"):
            raise ConnectionError("synthetic network failure")
        return _FakeSentCode("fake-" + os.urandom(8).hex())

    async def sign_in(self, phone=None, code=None, phone_code_hash=None, password=None):
        if password is not None:
            # Mirrors real Telethon: compute_hash calls password.encode('utf-8'),
            # so a bytes password raises AttributeError here exactly as it does there.
            if password.encode("utf-8") != b"fake-2fa-password":
                raise PasswordHashInvalidError("synthetic")
            self._authorize()
            return None
        if code == "000000":
            raise PhoneCodeExpiredError("synthetic")
        if code != "111111":
            raise PhoneCodeInvalidError("synthetic")
        if str(phone).endswith("2"):
            raise SessionPasswordNeededError("synthetic")
        self._authorize()
        return None

    def _authorize(self):
        from telethon.crypto import AuthKey
        session = self._session()
        session.auth_key = AuthKey(os.urandom(256))
        session.save()

    async def is_user_authorized(self):
        return bool(self._session().auth_key)

    async def log_out(self):
        # Mirrors real Telethon log_out: release the session, delete its own file
        # and report success, so callers cannot mistake a stale file for log-out.
        await self.disconnect()
        self._path.unlink(missing_ok=True)
        return True


# Synthetic error classes whose names match Telethon's, so the class-name error
# mapping behaves identically under the fake provider without importing it.
class PhoneCodeInvalidError(Exception):
    pass


class PhoneCodeExpiredError(Exception):
    pass


class PasswordHashInvalidError(Exception):
    pass


class SessionPasswordNeededError(Exception):
    pass
