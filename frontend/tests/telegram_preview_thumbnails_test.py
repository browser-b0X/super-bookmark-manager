"""Owner-triggered refresh link-preview thumbnails. Synthetic Telethon shapes only.

No live Telegram request: the client is a scripted stand-in, sockets are blocked,
and the cache directory is a throwaway temp dir. Run with Python -B from
frontend/tests.
"""
import hashlib
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

SOCKET_CONNECT = socket.socket.connect


def forbid_network(sock, address):
    host = address[0] if isinstance(address, tuple) and address else address
    if host in ("127.0.0.1", "::1", "localhost"):
        return SOCKET_CONNECT(sock, address)
    raise AssertionError("network forbidden")


def jpeg(payload=b""):
    return b"\xff\xd8\xff\xe0" + payload.ljust(1200, b"\x00") + b"\xff\xd9"


class PhotoSize:
    def __init__(self, size=None, raw=None):
        self.size, self.bytes = size, raw


class Photo:
    def __init__(self, sizes):
        self.sizes = sizes


class WebPage:
    def __init__(self, url, photo):
        self.url, self.photo = url, photo


class MessageMediaWebPage:
    def __init__(self, url, photo):
        self.web_page = WebPage(url, photo)


class Message:
    def __init__(self, identifier, text, url="https://example.invalid/a", media=None):
        self.id, self.message, self.entities = identifier, text, []
        from datetime import datetime, timezone
        self.date = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
        self.media = media


class ScriptedClient:
    """Stands in for TelegramClient: serves scripted messages and synthetic bytes."""

    def __init__(self, session, api_id, api_hash, messages, photo_bytes=None, **kwargs):
        self.messages, self.photo_bytes = messages, photo_bytes
        self.downloads, self.forbidden = [], []

    async def connect(self):
        return None

    async def disconnect(self):
        return None

    async def is_user_authorized(self):
        return True

    async def get_messages(self, entity, limit=None):
        return list(self.messages)[:limit]

    async def download_media(self, media, **kwargs):
        self.downloads.append(media)
        if self.photo_bytes is None:
            raise AssertionError("download_media not expected")
        return self.photo_bytes

    async def start(self):
        self.forbidden.append("start")
        return self

    async def log_out(self):
        self.forbidden.append("log_out")
        return True


class PreviewThumbnailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="b1-preview-")
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name)
        self.session = self.profile / "telegram.session"
        self.session.write_bytes(b"synthetic-fixture " + secrets.token_hex(8).encode("ascii"))
        self.cache = self.profile / "thumb_cache"
        self.cache.mkdir()

        env = patch.dict(os.environ, {
            "LOCALAPPDATA": str(self.profile),
            "SAVED_POSTS_DB_PATH": str(self.profile / "library.db"),
            # Telethon resolves libssl through PATH at import time, which now
            # happens inside refresh_saved_messages after the env is replaced.
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", ""),
            "WINDIR": os.environ.get("WINDIR", ""),
            "TEMP": os.environ.get("TEMP", ""),
            "TMP": os.environ.get("TMP", ""),
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)
        connect = patch.object(socket.socket, "connect", new=forbid_network)
        connect.start()
        self.addCleanup(connect.stop)
        create = patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden"))
        create.start()
        self.addCleanup(create.stop)

        import config
        config.TELEGRAM_API_ID = str(24000000 + secrets.randbelow(9000000))
        config.TELEGRAM_API_HASH = secrets.token_hex(16)
        config.TELEGRAM_SESSION_FILE = str(self.session)
        config.MAX_MESSAGES_PER_RUN = 200
        import metadata_fetcher
        import telegram_refresh
        self.metadata, self.refresh = metadata_fetcher, telegram_refresh
        thumbdir = patch.object(metadata_fetcher, "THUMB_CACHE_DIR", str(self.cache))
        thumbdir.start()
        self.addCleanup(thumbdir.stop)

        self.clients = []

        def factory(messages, photo_bytes=None):
            def construct(session, api_id, api_hash, **kwargs):
                client = ScriptedClient(session, api_id, api_hash, messages, photo_bytes, **kwargs)
                self.clients.append(client)
                return client
            return construct

        self.factory = factory

    def run_refresh(self, messages, photo_bytes=None):
        with patch("telethon.TelegramClient", self.factory(messages, photo_bytes)):
            return self.refresh.refresh_saved_messages()

    def preview_of(self, result, url):
        for message in result["export"]["messages"]:
            preview = message.get("preview")
            if preview and preview.get("url") == url:
                return preview
        return None

    def test_cached_size_photo_is_installed_without_a_download(self):
        url = "https://www.instagram.com/p/PreviewA/"
        messages = [Message(1, "caption " + url, media=MessageMediaWebPage(url, Photo([PhotoSize(raw=jpeg(b"A"))])))]
        result = self.run_refresh(messages)
        self.assertEqual(self.clients[0].downloads, [], "a cached-size photo needs no Telegram request")
        self.assertEqual(self.clients[0].forbidden, [])
        preview = self.preview_of(result, url)
        self.assertTrue(preview and preview["thumbnail"].startswith("/thumb/tg_"), preview)
        code = preview["thumbnail"].rsplit("/", 1)[1]
        self.assertEqual((self.cache / code).read_bytes(), jpeg(b"A"))
        self.assertEqual(result["previews"], {"present": 1, "installed": 1, "cached": 0, "failed": 0, "skipped": 0, "requests": 0})

    def test_declared_size_photo_is_downloaded_once_and_reused_from_cache(self):
        url = "https://example.invalid/declared"
        messages = [Message(2, "see " + url, media=MessageMediaWebPage(url, Photo([PhotoSize(size=1204)])))]
        result = self.run_refresh(messages, photo_bytes=jpeg(b"B"))
        self.assertEqual(len(self.clients[0].downloads), 1)
        preview = self.preview_of(result, url)
        code = preview["thumbnail"].rsplit("/", 1)[1]
        self.assertEqual(code, "tg_" + hashlib.sha256(url.encode()).hexdigest()[:24])
        self.assertEqual((self.cache / code).read_bytes(), jpeg(b"B"))
        self.assertEqual(result["previews"], {"present": 1, "installed": 1, "cached": 0, "failed": 0, "skipped": 0, "requests": 1})

        again = self.run_refresh(messages, photo_bytes=jpeg(b"B"))
        self.assertEqual(self.clients[1].downloads, [], "an installed preview must not be fetched again")
        self.assertEqual(again["previews"], {"present": 1, "installed": 0, "cached": 1, "failed": 0, "skipped": 0, "requests": 0})
        self.assertEqual(self.preview_of(again, url)["thumbnail"], preview["thumbnail"])

    def test_download_count_is_bounded_below_the_message_count(self):
        messages = [Message(i, "link " + str(i), media=MessageMediaWebPage(f"https://example.invalid/{i}", Photo([PhotoSize(size=1204)])))
                    for i in range(12)]
        result = self.run_refresh(messages, photo_bytes=jpeg(b"C"))
        self.assertEqual(result["previews"]["present"], 12)
        self.assertEqual(result["previews"]["requests"], self.refresh.MAX_PREVIEW_DOWNLOADS)
        self.assertEqual(result["previews"]["installed"], self.refresh.MAX_PREVIEW_DOWNLOADS)
        self.assertEqual(result["previews"]["skipped"], 2)
        self.assertLess(self.refresh.MAX_PREVIEW_DOWNLOADS, 12)
        self.assertEqual(len(self.clients[0].downloads), self.refresh.MAX_PREVIEW_DOWNLOADS)
        self.assertEqual(len(result["export"]["messages"]), 12)

    def test_oversize_and_invalid_previews_are_counted_not_installed(self):
        big = "https://example.invalid/big"
        bad = "https://example.invalid/bad"
        big_photo = Photo([PhotoSize(size=self.refresh.PREVIEW_SIZE_LIMIT + 1)])
        bad_photo = Photo([PhotoSize(size=1204)])
        messages = [
            Message(3, "big " + big, media=MessageMediaWebPage(big, big_photo)),
            Message(4, "bad " + bad, media=MessageMediaWebPage(bad, bad_photo)),
        ]
        result = self.run_refresh(messages, photo_bytes=b"not an image at all".ljust(1200, b" "))
        self.assertNotIn(big_photo, self.clients[0].downloads, "an oversize declared size must not be fetched")
        self.assertEqual(len(self.clients[0].downloads), 1, "only the in-budget photo may be fetched")
        # Oversize is known before any fetch, so it is skipped; the in-budget
        # photo costs one request and is only rejected by the image check.
        self.assertEqual(result["previews"], {"present": 2, "installed": 0, "cached": 0, "failed": 1, "skipped": 1, "requests": 1})
        self.assertIsNone(self.preview_of(result, big))
        self.assertIsNone(self.preview_of(result, bad))
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), [])

    def test_messages_without_a_preview_photo_are_untouched(self):
        url = "https://example.invalid/plain"
        result = self.run_refresh([Message(5, "plain " + url)])
        self.assertEqual(result["previews"], {"present": 0, "installed": 0, "cached": 0, "failed": 0, "skipped": 0, "requests": 0})
        message = result["export"]["messages"][0]
        self.assertNotIn("preview", message)
        self.assertEqual(message["text"], "plain " + url)


class PhotoStrippedSize:
    """Telegram's inline blur placeholder: header-less bytes, never an image file."""
    def __init__(self):
        self.type, self.bytes = "i", b"\x01\x28\x1e" + b"\x00" * 300


class PhotoSizeSelectionTests(unittest.TestCase):
    def test_stripped_placeholder_is_skipped_and_largest_fitting_size_downloaded(self):
        import telegram_refresh
        photo = Photo([PhotoStrippedSize(), PhotoSize(size=30000), PhotoSize(size=90000), PhotoSize(size=9_000_000)])
        self.assertIsNone(telegram_refresh.embedded_photo_bytes(photo))
        self.assertEqual(telegram_refresh.best_photo_size(photo).size, 90000)
        self.assertEqual(telegram_refresh.declared_photo_size(photo), 90000)
        cached = Photo([PhotoStrippedSize(), PhotoSize(raw=jpeg(b"cached"))])
        self.assertEqual(telegram_refresh.embedded_photo_bytes(cached), jpeg(b"cached"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
