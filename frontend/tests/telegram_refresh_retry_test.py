"""Saved Messages refresh client configuration. No network, no personal data.

Pins the kwargs telegram_refresh passes to the real TelegramClient, then proves
against real Telethon that those kwargs keep the library's retry recovery.
Run with Python -B from frontend/tests.
"""
import asyncio
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True

try:
    from telethon import errors as telethon_errors
    from telethon import functions as telethon_functions
    from telethon import types as telethon_types
    TELETHON_PRESENT = True
except ImportError:
    TELETHON_PRESENT = False

SOCKET_CONNECT = socket.socket.connect


def forbid_network(sock, address):
    """Block every connect except the asyncio proactor self-pipe on loopback."""
    host = address[0] if isinstance(address, tuple) and address else address
    if host in ("127.0.0.1", "::1", "localhost"):
        return SOCKET_CONNECT(sock, address)
    raise AssertionError("network forbidden")


class CapturingClient:
    """Stands in for TelegramClient to record construction kwargs. Never connects."""

    kwargs = None

    def __init__(self, session, api_id, api_hash, **kwargs):
        CapturingClient.kwargs = kwargs
        self.session, self.api_id, self.api_hash = session, api_id, api_hash

    async def connect(self):
        return None

    async def disconnect(self):
        return None

    async def is_user_authorized(self):
        return True

    async def get_messages(self, entity, limit=None):
        return []


class StubSender:
    """Transport stand-in. The final scripted outcome repeats for every retry."""

    def __init__(self, script):
        self.script, self.attempts = list(script), 0

    def send(self, request, ordered=False):
        self.attempts += 1
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]

        async def outcome():
            if isinstance(item, Exception):
                raise item
            return telethon_types.messages.Messages(
                messages=[], topics=[], chats=[], users=[])
        return outcome()


class RefreshRetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="b7-telegram-refresh-")
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name)
        self.session = self.profile / "SavedPostsDashboard" / "telegram.session"
        self.session.parent.mkdir(parents=True, exist_ok=True)
        self.session.write_bytes(b"synthetic-fixture " + secrets.token_hex(8).encode("ascii"))
        self.api_id = str(24000000 + secrets.randbelow(9000000))
        self.api_hash = secrets.token_hex(16)

        env = patch.dict(os.environ, {
            "LOCALAPPDATA": str(self.profile),
            "SAVED_POSTS_DB_PATH": str(self.profile / "library.db"),
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)
        create = patch.object(socket, "create_connection",
                              side_effect=AssertionError("network forbidden"))
        create.start()
        self.addCleanup(create.stop)
        connect = patch.object(socket.socket, "connect", new=forbid_network)
        connect.start()
        self.addCleanup(connect.stop)

        import config
        self.config = config
        config.TELEGRAM_API_ID = self.api_id
        config.TELEGRAM_API_HASH = self.api_hash
        config.TELEGRAM_SESSION_FILE = str(self.session)
        config.MAX_MESSAGES_PER_RUN = 200
        import telegram_refresh
        self.refresh = telegram_refresh

    def capture_kwargs(self):
        CapturingClient.kwargs = None
        with patch("telethon.TelegramClient", CapturingClient):
            result = self.refresh.refresh_saved_messages()
        self.assertTrue(result["ok"] is True, result)
        self.assertTrue(CapturingClient.kwargs is not None)
        return CapturingClient.kwargs

    def test_refresh_client_allows_telethon_retry_recovery(self):
        """F6: request_retries=0 lets Telethon replace a retryable RPC error with a
        bare ValueError, which the generic handler reports as a connection failure."""
        kwargs = self.capture_kwargs()
        self.assertTrue(kwargs.get("request_retries", 0) > 0, kwargs)
        self.assertTrue(kwargs.get("raise_last_call_error") is True, kwargs)
        # A flood sleep longer than the 60s asyncio.timeout would be reported as a
        # timeout, so the wait must raise immediately instead.
        self.assertTrue(kwargs.get("flood_sleep_threshold", 60) == 0, kwargs)

    @unittest.skipUnless(TELETHON_PRESENT, "telethon is not installed")
    def test_captured_configuration_recovers_from_migration(self):
        """The kwargs the call site actually passes must recover a DC migration."""
        from telethon import TelegramClient
        kwargs = self.capture_kwargs()
        client = TelegramClient(str(self.profile / "synthetic-retry.session"),
                                24681357, "0" * 32, **kwargs)
        self.addCleanup(client.session.close)
        client.session.set_dc(2, "127.0.0.1", 443)

        async def not_authorized():
            return False

        async def no_switch(new_dc):
            return None

        async def instant(_seconds):
            return None

        client.is_user_authorized = not_authorized
        client._switch_dc = no_switch
        request = telethon_functions.messages.GetHistoryRequest(
            peer=telethon_types.InputPeerSelf(), offset_id=0, offset_date=0,
            add_offset=0, limit=10, max_id=0, min_id=0, hash=0)

        migrate = StubSender([telethon_errors.NetworkMigrateError(None, 2), "ok"])
        client._sender = migrate
        with patch("asyncio.sleep", instant):
            asyncio.run(client._call(migrate, request))
        self.assertTrue(migrate.attempts == 2, migrate.attempts)

        broken = StubSender([telethon_errors.ServerError(None, "RPC_INTERNAL")])
        client._sender = broken
        with patch("asyncio.sleep", instant):
            with self.assertRaises(telethon_errors.ServerError):
                asyncio.run(client._call(broken, request))
        self.assertTrue(broken.attempts > 1, broken.attempts)


if __name__ == "__main__":
    unittest.main(verbosity=2)
