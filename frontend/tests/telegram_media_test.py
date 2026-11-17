"""Photos, videos and audio sent with a link to Saved Messages. Synthetic data only.

Run: python -B frontend/tests/telegram_media_test.py
The Telegram client is a scripted stand-in (no network), the library is a
throwaway SQLite file and the files go to a temporary folder under .verify.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sys
import tempfile
import time
import types
import unittest
import zipfile
from datetime import datetime, timezone
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE))
sys.dont_write_bytecode = True

(WORKSPACE / ".verify" / "telegram-media").mkdir(parents=True, exist_ok=True)
FIXTURE = tempfile.TemporaryDirectory(prefix="tg-media-", dir=WORKSPACE / ".verify" / "telegram-media")
ROOT = Path(FIXTURE.name)
os.environ["SAVED_POSTS_DB_PATH"] = str(ROOT / "synthetic.sqlite")
os.environ["SBM_ARCHIVE_DIR"] = str(ROOT / "archive")
import config  # noqa: E402
config.DB_PATH = str(ROOT / "synthetic.sqlite")
import archive  # noqa: E402
import storage  # noqa: E402
import telegram_refresh  # noqa: E402
try:
    import app as dashboard  # noqa: E402
except ModuleNotFoundError:
    dashboard = None

try:
    import telethon  # noqa: F401
except ImportError:              # the client is scripted anyway; only its import name is needed
    import types
    sys.modules["telethon"] = types.SimpleNamespace(TelegramClient=None)

SOCKET_CONNECT = socket.socket.connect


def forbid_network(sock, address):
    host = address[0] if isinstance(address, tuple) and address else address
    if host in ("127.0.0.1", "::1", "localhost"):
        return SOCKET_CONNECT(sock, address)
    raise AssertionError("network forbidden")


def jpeg(tag=b""):
    return b"\xff\xd8\xff\xe0" + tag.ljust(1500, b"\x00") + b"\xff\xd9"


def mp4(tag=b""):
    return b"\x00\x00\x00\x18ftypisom" + tag.ljust(4000, b"\x00")


PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic" * 50
MB = 1024 * 1024
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 3000
OGG = b"OggS\x00\x02" + b"\x00" * 3000
M4A = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 3000
FLAC = b"fLaC\x00\x00\x00\x22" + b"\x00" * 3000
WAV = b"RIFF\x24\x10\x00\x00WAVEfmt " + b"\x00" * 3000
AAC = b"\xff\xf1\x50\x80\x02\x1f\xfc" + b"\x00" * 3000          # an ADTS frame, as Telegram sends audio/aac
BIG = b"\x00\x00\x00\x18ftypisom" + bytes(52 * MB - 12)      # over the 50 MB a refresh keeps by itself


# ── Telethon-shaped stand-ins ─────────────────────────────────────────────────

class MessageMediaPhoto:
    def __init__(self, data):
        self.photo, self.data = object(), data


class DocumentAttributeVideo:
    def __init__(self, duration, round_message=False):
        self.duration, self.round_message = duration, round_message


class DocumentAttributeSticker:
    pass


class DocumentAttributeAudio:
    def __init__(self, duration, voice=False, title=None, performer=None):
        self.duration, self.voice, self.title, self.performer = duration, voice, title, performer


class DocumentAttributeFilename:
    def __init__(self, file_name):
        self.file_name = file_name


class Document:
    def __init__(self, mime, size, attributes):
        self.mime_type, self.size, self.attributes = mime, size, attributes


class MessageMediaDocument:
    def __init__(self, data, mime="video/mp4", size=None, attributes=None):
        self.data = data
        self.document = Document(mime, len(data) if size is None else size,
                                 [DocumentAttributeVideo(42)] if attributes is None else attributes)


class MessageMediaWebPage:
    def __init__(self, web_page=None):
        self.web_page = web_page


class WebPage:
    def __init__(self, url, photo):
        self.url, self.photo = url, photo


class PreviewPhoto:
    def __init__(self, declared):
        self.sizes = [PhotoSize(declared)]


class PhotoSize:
    def __init__(self, size):
        self.size, self.bytes = size, None


class MessageEntityTextUrl:
    def __init__(self, url, offset=None, length=None):
        self.url, self.offset, self.length = url, offset, length


class MessageEntityUrl:
    def __init__(self, offset, length):
        self.offset, self.length = offset, length


def units(text):
    """Length in UTF-16 code units, as Telegram counts entity offsets."""
    return len(text.encode("utf-16-le")) // 2


class Message:
    def __init__(self, identifier, text, media=None, grouped_id=None, entities=None):
        self.id, self.message, self.media, self.grouped_id = identifier, text, media, grouped_id
        self.entities = entities or []
        self.date = datetime(2026, 10, 7, 18, 22, tzinfo=timezone.utc)


class ScriptedClient:
    delay = 0.0           # seconds between two pieces of a file written to disk

    def __init__(self, messages, fail_on=None):
        self.messages, self.fail_on, self.downloads = messages, fail_on or set(), []
        self.in_memory, self.streamed = [], []

    async def connect(self):
        return None

    async def disconnect(self):
        return None

    async def is_user_authorized(self):
        return True

    async def get_messages(self, entity, limit=None, ids=None):
        if ids is not None:
            found = {message.id: message for message in self.messages}
            return [found.get(identifier) for identifier in ids]
        return list(self.messages)[:limit]

    async def download_media(self, item, file=None, progress_callback=None, **kwargs):
        assert file is bytes or hasattr(file, "write"), "into memory or an open file, never a path in the working folder"
        self.downloads.append(getattr(item, "id", None))
        if getattr(item, "id", None) in self.fail_on:
            raise ConnectionError("synthetic drop")
        data = item.media.data
        if file is bytes:
            self.in_memory.append(len(data))
            return data
        self.streamed.append(item.id)
        for start in range(0, len(data), MB):
            self.piece(item.id, start, len(data), file)
            file.write(data[start:start + MB])
            if progress_callback:
                progress_callback(file.tell(), len(data))
            await asyncio.sleep(self.delay)
        return file

    def piece(self, identifier, start, size, file):
        return None


class SlowClient(ScriptedClient):
    delay = 0.05


class CuttingClient(ScriptedClient):
    cut = None            # the message ids whose download drops half way; None: every one

    def piece(self, identifier, start, size, file):
        if start >= size // 2 and (self.cut is None or identifier in self.cut):
            raise ConnectionError("synthetic drop half way")


class FullDiskClient(ScriptedClient):
    """Writes message 82 completely, then the disk is full when it is flushed."""
    def piece(self, identifier, start, size, file):
        if identifier == 82:
            def full():
                raise OSError(28, "No space left on device")
            file.flush = full


class TelegramMediaCase(unittest.TestCase):
    def setUp(self):
        self.archive_dir = ROOT / ("archive-" + secrets.token_hex(4))
        patcher = patch.object(archive, "ARCHIVE_DIR", str(self.archive_dir))
        patcher.start()
        self.addCleanup(patcher.stop)
        db = ROOT / ("db-" + secrets.token_hex(4) + ".sqlite")
        dbp = patch.object(config, "DB_PATH", str(db))
        dbp.start()
        self.addCleanup(dbp.stop)
        storage.init_db()
        session = ROOT / "synthetic.session"
        session.write_bytes(b"synthetic")
        for name, value in (("TELEGRAM_API_ID", "24000001"), ("TELEGRAM_API_HASH", secrets.token_hex(16)),
                            ("TELEGRAM_SESSION_FILE", str(session)), ("MAX_MESSAGES_PER_RUN", 200)):
            p = patch.object(config, name, value)
            p.start()
            self.addCleanup(p.stop)
        for target in ((socket.socket, "connect", forbid_network),):
            p = patch.object(*target[:2], new=target[2])
            p.start()
            self.addCleanup(p.stop)
        self.clients = []
        # The scripted client stays in place for the whole test: a large file is
        # downloaded after the refresh returns, by a client made in the background.
        self.script = {"messages": [], "fail_on": set(), "client_class": ScriptedClient}

        def construct(*args, **kwargs):
            client = self.script["client_class"](self.script["messages"], self.script["fail_on"])
            self.clients.append(client)
            return client
        p = patch("telethon.TelegramClient", construct)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.finish_large)          # before the client goes
        telegram_refresh.forget_held()

    def refresh(self, messages, keep_media=True, fail_on=None, client_class=None, wait=True, retry=False):
        self.script.update(messages=messages, fail_on=fail_on or set(), client_class=client_class or ScriptedClient)
        result = telegram_refresh.refresh_saved_messages(keep_media=keep_media, retry=retry)
        if wait:
            self.finish_large(stop=False)
        return result

    def finish_large(self, stop=True):
        if stop:
            telegram_refresh.stop_large()
        self.wait_for(lambda: not telegram_refresh.large_state()["running"], "the background download did not end")

    def wait_for(self, done, message="timed out", timeout=60):
        end = time.monotonic() + timeout
        while not done():
            if time.monotonic() > end:
                raise AssertionError(message)
            time.sleep(0.02)

    def files(self):
        return sorted(p.name for p in self.archive_dir.iterdir()) if self.archive_dir.exists() else []

    def parts(self):
        return [name for name in self.files() if name.endswith(".part")]

    def large_link(self, url, first=60):
        """A link sent with a photo and a video over 50 MB, as one album."""
        return [Message(first, f"The whole talk {url}", MessageMediaPhoto(jpeg(b"cover")), grouped_id=first),
                Message(first + 1, "", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(3600)]), grouped_id=first)]

    # ── Storing ──────────────────────────────────────────────────────────────

    def test_photos_and_videos_are_kept_and_checked_by_their_bytes(self):
        url = "https://example.test/focaccia"
        saved = archive.save_telegram_media(url, {"text": "Try this one", "date": "2026-10-07T18:22:00+00:00"}, [
            {"kind": "photo", "data": jpeg(b"a")}, {"kind": "photo", "data": PNG},
            {"kind": "video", "data": mp4(b"v"), "duration": 41.6},
            {"kind": "photo", "data": b"<script>alert(1)</script>" * 20},       # not a picture
            {"kind": "video", "data": b"not a video at all" * 20},              # no ftyp box
            {"kind": "photo", "data": b"<svg xmlns='http://www.w3.org/2000/svg'/>"},
        ])
        self.assertEqual(saved, {"photos": 2, "videos": 1, "audio": 0})
        record = archive.telegram_media_for_url(url)
        key = archive.copy_key(url)
        self.assertEqual([i["name"] for i in record["items"]], ["tg0.jpg", "tg1.png", "tg2.mp4"])
        self.assertEqual(record["items"][2]["duration"], 42)
        self.assertEqual(record["message"]["text"], "Try this one")
        self.assertEqual(self.files(), sorted([f"{key}.tg.json", f"{key}.tg0.jpg", f"{key}.tg1.png", f"{key}.tg2.mp4"]))
        self.assertIsNone(archive.telegram_file_path(key, "tg3.jpg"))
        self.assertIsNone(archive.telegram_file_path(key, "../" + key + ".tg.json"))
        self.assertEqual(archive.summary()["count"], 0, "Telegram files are not a saved copy")
        self.assertGreater(archive.summary()["bytes"], 5000)

    def test_a_new_set_replaces_the_old_one_and_deleting_the_link_removes_them(self):
        url = "https://example.test/replace"
        archive.save_telegram_media(url, {}, [{"kind": "photo", "data": jpeg()}, {"kind": "photo", "data": jpeg(b"2")}])
        archive.save_telegram_media(url, {}, [{"kind": "video", "data": mp4()}])
        key = archive.copy_key(url)
        self.assertEqual(self.files(), sorted([f"{key}.tg.json", f"{key}.tg0.mp4"]))
        archive.remove_for_url(url)
        self.assertEqual(self.files(), [])

    def test_a_tampered_record_cannot_point_outside_its_own_files(self):
        url = "https://example.test/tamper"
        archive.save_telegram_media(url, {}, [{"kind": "photo", "data": jpeg()}])
        key = archive.copy_key(url)
        path = self.archive_dir / f"{key}.tg.json"
        record = json.loads(path.read_text())
        record["items"] += [{"name": "../../secret.txt", "kind": "photo"}, {"name": "tg0.mp4", "kind": "photo"}]
        path.write_text(json.dumps(record))
        self.assertEqual([i["name"] for i in archive.telegram_media(key)["items"]], ["tg0.jpg"])
        record["url"] = "https://example.test/other"
        path.write_text(json.dumps(record))
        self.assertIsNone(archive.telegram_media(key), "a record must belong to its own file name")

    # ── Refresh ──────────────────────────────────────────────────────────────

    def test_refresh_keeps_a_links_album_and_ignores_linkless_and_preview_media(self):
        url = "https://example.test/recipe"
        messages = [
            Message(10, f"Try this one {url}.", MessageMediaPhoto(jpeg(b"1")), grouped_id=7),
            Message(11, "", MessageMediaPhoto(jpeg(b"2")), grouped_id=7),
            Message(12, "", MessageMediaDocument(mp4(b"3")), grouped_id=7),
            Message(13, "just a photo, no link", MessageMediaPhoto(jpeg(b"4"))),
            Message(14, "https://example.test/preview only", MessageMediaWebPage()),
            Message(15, "sticker https://example.test/sticker", MessageMediaDocument(
                mp4(), attributes=[DocumentAttributeSticker()])),
            Message(16, "round https://example.test/round", MessageMediaDocument(
                mp4(), attributes=[DocumentAttributeVideo(5, round_message=True)])),
            Message(17, "big https://example.test/big", MessageMediaDocument(mp4(), size=60 * 1024 * 1024)),
        ]
        result = self.refresh(messages)
        self.assertEqual(sorted(self.clients[0].downloads), [10, 11, 12])
        self.assertEqual(result["media"]["photos"], 2)
        self.assertEqual(result["media"]["videos"], 1)
        entry = next(m for m in result["export"]["messages"] if m["id"] == 10)
        self.assertEqual(entry["media"], {"url": url, "photos": 2, "videos": 1, "audio": 0})
        record = archive.telegram_media_for_url(url)
        self.assertEqual([i["kind"] for i in record["items"]], ["photo", "photo", "video"])
        self.assertIn("Try this one", record["message"]["text"])
        self.assertTrue(all("media" not in m for m in result["export"]["messages"] if m["id"] != 10))

        again = self.refresh(messages)
        self.assertEqual(self.clients[1].downloads, [], "kept files are not downloaded again")
        self.assertEqual(again["media"]["kept"], 1)
        self.assertEqual(next(m for m in again["export"]["messages"] if m["id"] == 10)["media"]["photos"], 2)

    def test_switched_off_downloads_nothing(self):
        messages = [Message(1, "https://example.test/off", MessageMediaPhoto(jpeg()))]
        result = self.refresh(messages, keep_media=False)
        self.assertEqual(self.clients[0].downloads, [])
        self.assertEqual(result["media"]["photos"], 0)
        self.assertEqual(self.files(), [])

    def test_a_deleted_link_gets_no_photos_and_a_failed_download_keeps_the_rest(self):
        gone, kept = "https://example.test/deleted", "https://example.test/kept"
        conn = storage._connect()
        with conn:
            conn.execute("INSERT INTO library_items (url, id, document, deleted, ident) VALUES (?, ?, NULL, 1, ?)",
                         (gone, "x1", storage.url_identity(gone)))
        conn.close()
        messages = [Message(1, gone, MessageMediaPhoto(jpeg())),
                    Message(2, "labeled", MessageMediaPhoto(jpeg(b"k")), grouped_id=3,
                            entities=[MessageEntityTextUrl(kept)]),
                    Message(4, "", MessageMediaPhoto(jpeg(b"j")), grouped_id=3)]
        result = self.refresh(messages, fail_on={4})
        self.assertNotIn(1, self.clients[0].downloads)
        self.assertIsNone(archive.telegram_media_for_url(gone))
        self.assertEqual(archive.telegram_counts(archive.telegram_media_for_url(kept)), {"photos": 1, "videos": 0, "audio": 0})
        self.assertEqual(result["media"]["failed"], 1)
        self.assertEqual(result["media"]["skipped"], 1)
        self.assertEqual(len(result["export"]["messages"]), 3, "the links are imported whatever happens to the files")

    def test_first_link_matches_the_importer(self):
        entry = telegram_refresh.export_message(Message(1, "see (https://example.test/a_(b)) and https://x.test/c"))
        self.assertEqual(telegram_refresh.first_link(entry), "https://example.test/a_(b)")
        entry = telegram_refresh.export_message(Message(2, "label", entities=[MessageEntityTextUrl("https://e.test/z")]))
        self.assertEqual(telegram_refresh.first_link(entry), "https://e.test/z")
        entry = telegram_refresh.export_message(Message(3, "tg://resolve only"))
        self.assertIsNone(telegram_refresh.first_link(entry))

    def test_files_are_kept_under_the_link_the_importer_stores(self):
        # The importer stores `new URL(link).href`: Unicode queries are percent-encoded,
        # Unicode domains become xn--. The files must be found under that spelling.
        raw = "https://www.google.com/search?q=кошка"
        href = "https://www.google.com/search?q=%D0%BA%D0%BE%D1%88%D0%BA%D0%B0"
        domain_raw, domain_href = "https://президент.рф/a/../b", "https://xn--d1abbgf6aiiy.xn--p1ai/b"
        result = self.refresh([Message(1, "look " + raw, MessageMediaPhoto(jpeg(b"q"))),
                               Message(2, domain_raw, MessageMediaPhoto(jpeg(b"d")))])
        entries = {m["id"]: m for m in result["export"]["messages"]}
        self.assertEqual(entries[1]["media"]["url"], href)
        self.assertEqual(entries[2]["media"]["url"], domain_href)
        self.assertEqual(archive.telegram_counts(archive.telegram_media_for_url(href)), {"photos": 1, "videos": 0, "audio": 0})
        self.assertIsNotNone(archive.telegram_media_for_url(domain_href))
        archive.remove_for_url(href)
        self.assertIsNone(archive.telegram_media_for_url(href), "deleting the stored link removes its files")

    def test_links_telegram_detected_keep_their_exact_target(self):
        quoted = "Статья «https://habr.com/ru/articles/123/» 👍"
        start = units("Статья «")
        entry = telegram_refresh.export_message(Message(1, quoted, entities=[MessageEntityUrl(start, units("https://habr.com/ru/articles/123/"))]))
        self.assertEqual([p["type"] for p in entry["text_entities"]], ["plain", "link", "plain"])
        self.assertEqual(telegram_refresh.first_link(entry), "https://habr.com/ru/articles/123/")
        emoji = "👍👍 https://a.test/x then text"
        entry = telegram_refresh.export_message(Message(2, emoji, entities=[MessageEntityUrl(units("👍👍 "), units("https://a.test/x"))]))
        self.assertEqual(entry["text_entities"][1], {"type": "link", "text": "https://a.test/x"}, "offsets count UTF-16 units")
        bare = "see youtube.com/watch?v=1 now"
        entry = telegram_refresh.export_message(Message(3, bare, entities=[MessageEntityUrl(4, units("youtube.com/watch?v=1"))]))
        self.assertEqual(telegram_refresh.first_link(entry), "https://youtube.com/watch?v=1", "typed without a scheme, opened on the web")
        label = "read this"
        entry = telegram_refresh.export_message(Message(4, label, entities=[MessageEntityTextUrl("https://e.test/a b", 0, units(label))]))
        self.assertEqual(entry["text_entities"], [{"type": "text_link", "text": "read this", "href": "https://e.test/a b"}])
        self.assertEqual(telegram_refresh.first_link(entry), "https://e.test/a%20b")

    def test_a_partly_downloaded_album_is_fetched_again(self):
        url = "https://example.test/album"
        messages = [Message(30, url, MessageMediaPhoto(jpeg(b"1")), grouped_id=9),
                    Message(31, "", MessageMediaPhoto(jpeg(b"2")), grouped_id=9),
                    Message(32, "", MessageMediaPhoto(jpeg(b"3")), grouped_id=9)]
        first = self.refresh(messages, fail_on={31})
        self.assertEqual((first["media"]["photos"], first["media"]["failed"]), (2, 1))
        self.assertEqual(archive.telegram_media_for_url(url)["missing"], 1)
        second = self.refresh(messages)
        self.assertEqual(self.clients[1].downloads, [31], "Refresh tries again, as the message says, fetching only what is missing")
        record = archive.telegram_media_for_url(url)
        self.assertEqual((len(record["items"]), record.get("missing")), (3, None))
        third = self.refresh(messages)
        self.assertEqual((self.clients[2].downloads, third["media"]["kept"]), ([], 1), "a complete set is not fetched again")

    def test_slow_previews_never_cost_the_links(self):
        class SlowClient(ScriptedClient):
            async def get_messages(self, entity, limit=None):
                await asyncio.sleep(0.3)
                return list(self.messages)[:limit]

            async def download_media(self, item, **kwargs):
                await asyncio.sleep(0.6)          # a preview picture that takes its time
                return jpeg(b"preview")
        page = MessageMediaWebPage(WebPage("https://slow.test/page", PreviewPhoto(1204)))
        thumbs = ROOT / ("thumbs-" + secrets.token_hex(4))
        thumbs.mkdir()
        import metadata_fetcher
        with patch.object(telegram_refresh, "READ_BUDGET", 0.5), patch.object(telegram_refresh, "PREVIEW_BUDGET", 2.0), \
                patch.object(metadata_fetcher, "THUMB_CACHE_DIR", str(thumbs)):
            result = self.refresh([Message(40, "https://slow.test/page", page)], keep_media=False, client_class=SlowClient)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["export"]["messages"]), 1, "the read finished in time, so its links come back")
        self.assertEqual(result["previews"]["requests"], 1)

    def test_sign_in_steps_answer_busy_while_a_refresh_holds_the_session(self):
        import threading
        import telegram_auth
        held, release = threading.Event(), threading.Event()

        def refresh_holding_the_session():
            with telegram_auth._LOCK:
                held.set()
                release.wait(5)
        holder = threading.Thread(target=refresh_holding_the_session)
        holder.start()
        held.wait(5)
        try:
            with patch.object(telegram_auth, "_LOCK_WAIT_SECONDS", 0.1):
                with self.assertRaises(telegram_auth.AuthError) as raised:
                    telegram_auth.cancel_login()
            self.assertEqual((raised.exception.code, raised.exception.status), ("busy", 409))
            self.assertTrue(telegram_auth.status()["busy"], "status answers at once, marked busy")
        finally:
            release.set()
            holder.join(5)

    # ── Audio ────────────────────────────────────────────────────────────────

    def test_audio_sent_with_a_link_is_kept_and_checked_by_its_bytes(self):
        url = "https://example.test/levain-talk"
        saved = archive.save_telegram_media(url, {"text": "the talk"}, [
            {"kind": "audio", "data": MP3, "duration": 2891.6, "title": "Bread Club\u200b \u2013\tLevain basics\n"},
            {"kind": "audio", "data": OGG, "duration": 48, "voice": True, "title": "not shown for a voice message"},
            {"kind": "audio", "data": M4A}, {"kind": "audio", "data": FLAC}, {"kind": "audio", "data": WAV},
            {"kind": "audio", "data": b"<html><script>alert(1)</script></html>" * 20},     # not audio
            {"kind": "audio", "data": jpeg()},                                             # a picture is not audio
        ])
        self.assertEqual(saved, {"photos": 0, "videos": 0, "audio": 5})
        key = archive.copy_key(url)
        record = archive.telegram_media(key)
        self.assertEqual([i["name"] for i in record["items"]], ["tg0.mp3", "tg1.ogg", "tg2.m4a", "tg3.flac", "tg4.wav"])
        self.assertEqual(record["items"][0], {"name": "tg0.mp3", "kind": "audio", "bytes": len(MP3), "duration": 2892,
                                              "title": "Bread Club \u2013 Levain basics"})
        self.assertEqual(record["items"][1], {"name": "tg1.ogg", "kind": "audio", "bytes": len(OGG), "duration": 48, "voice": True})
        if dashboard is not None:
            client = dashboard.app.test_client()
            response = client.get(f"/archive/telegram/{key}/tg0.mp3")
            self.assertEqual((response.status_code, response.mimetype), (200, "audio/mpeg"))
            self.assertIn("sandbox", response.headers["Content-Security-Policy"])
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            response.close()                       # Windows: a file still being served can't be removed
            answer = client.post("/api/archive/telegram", data=json.dumps({"url": url}),
                                 headers={"Content-Type": "application/json"}).get_json()["media"]
            self.assertEqual((answer["audio"], answer["items"][0]["title"], answer["items"][1]["voice"]),
                             (5, "Bread Club \u2013 Levain basics", True))
        archive.remove_for_url(url)
        self.assertEqual(self.files(), [])

    def test_refresh_keeps_audio_and_voice_messages_sent_with_a_link(self):
        url = "https://example.test/podcast"
        messages = [
            Message(50, f"Saturday's talk {url}", MessageMediaDocument(MP3, mime="audio/mpeg", attributes=[
                DocumentAttributeAudio(2891, title="Levain basics", performer="Bread Club"),
                DocumentAttributeFilename("levain.mp3")]), grouped_id=12),
            Message(51, "", MessageMediaDocument(M4A, mime="audio/x-m4a", attributes=[DocumentAttributeFilename("q-and-a.m4a")]),
                    grouped_id=12),
            Message(52, "note to self https://example.test/voice",
                    MessageMediaDocument(OGG, mime="audio/ogg", attributes=[DocumentAttributeAudio(48, voice=True)])),
            Message(53, "a file https://example.test/zip",
                    MessageMediaDocument(b"PK\x03\x04" + b"\x00" * 100, mime="application/zip", attributes=[])),
        ]
        result = self.refresh(messages)
        self.assertEqual(sorted(self.clients[0].downloads), [50, 51, 52], "other files are never downloaded")
        self.assertEqual(result["media"]["audio"], 3)
        podcast = archive.telegram_media_for_url(url)
        self.assertEqual([(i["kind"], i.get("title"), i.get("duration")) for i in podcast["items"]],
                         [("audio", "Bread Club \u2013 Levain basics", 2891), ("audio", "q-and-a.m4a", None)])
        self.assertEqual(archive.telegram_media_for_url("https://example.test/voice")["items"][0]["voice"], True)
        entry = next(m for m in result["export"]["messages"] if m["id"] == 50)
        self.assertEqual(entry["media"], {"url": url, "photos": 0, "videos": 0, "audio": 2})

    # ── Large videos and audio ───────────────────────────────────────────────

    def test_large_files_wait_for_the_switch_then_download_after_the_refresh_streamed_to_disk(self):
        url = "https://example.test/big-talk"
        messages = self.large_link(url)
        off = self.refresh(messages)
        self.assertEqual((off["media"]["photos"], off["media"]["over"], off["media"]["waiting"]), (1, 1, 0))
        self.assertEqual(self.clients[0].downloads, [60], "with the switch off a file over 50 MB is not downloaded")
        self.assertEqual(archive.telegram_media_for_url(url)["over"], 1)

        archive.set_large_videos(True)
        on = self.refresh(messages)
        self.assertEqual((on["media"]["waiting"], on["media"]["photos"]), (1, 0), "the set waits for the download after the refresh")
        self.assertEqual(len(on["export"]["messages"]), 2, "the links come back at once")
        self.assertEqual(self.clients[1].downloads, [], "the refresh itself downloads nothing of that set")
        background = self.clients[2]
        self.assertEqual(background.streamed, [61], "the large video is written to disk as it arrives")
        self.assertEqual(background.in_memory, [], "the photo kept before is not downloaded again")
        record = archive.telegram_media_for_url(url)
        self.assertEqual([(i["kind"], i["bytes"]) for i in record["items"]], [("photo", len(jpeg(b"cover"))), ("video", len(BIG))])
        self.assertEqual((record.get("over"), record.get("missing")), (None, None))
        self.assertEqual(os.path.getsize(archive.telegram_file_path(archive.copy_key(url), "tg1.mp4")), len(BIG))
        self.assertEqual(self.parts(), [])
        state = telegram_refresh.large_state()
        self.assertEqual({name: state[name] for name in ("running", "total", "done", "kept", "failed", "reason")},
                         {"running": False, "total": 1, "done": 1, "kept": 1, "failed": 0, "reason": ""})
        again = self.refresh(messages)
        self.assertEqual((self.clients[3].downloads, again["media"]["kept"], again["media"]["waiting"]), ([], 1, 0))

    def test_a_video_that_cant_be_kept_is_said_once_not_passed_over(self):
        # The owner's report: a link with a video over 50 MB attached, the switch on, and the refresh said nothing.
        # An MP4 starts downloading; a video Telegram holds as another kind of file, or one over 2 GB, said nothing.
        archive.set_large_videos(True)
        GB = 1024 * MB
        messages = [Message(91, "Watch https://example.test/mov", MessageMediaDocument(BIG, mime="video/quicktime",
                                                                                   attributes=[DocumentAttributeVideo(600)])),
                    Message(92, "Watch https://example.test/mkv", MessageMediaDocument(BIG, mime="video/x-matroska",
                                                                                   attributes=[DocumentAttributeFilename("talk.mkv")])),
                    Message(93, "Watch https://example.test/huge", MessageMediaDocument(BIG, size=3 * GB,
                                                                                    attributes=[DocumentAttributeVideo(9000)])),
                    Message(94, "Watch https://example.test/mp4", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(600)])),
                    Message(95, "A sticker https://example.test/sticker", MessageMediaDocument(BIG, mime="video/webm",
                                                                                         attributes=[DocumentAttributeSticker()])),
                    Message(96, "A round one https://example.test/round", MessageMediaDocument(BIG,
                                                                                       attributes=[DocumentAttributeVideo(5, round_message=True)]))]
        first = self.refresh(messages)
        self.assertEqual({name: first["media"][name] for name in ("not_mp4", "too_big", "waiting")}, {"not_mp4": 2, "too_big": 1, "waiting": 1})
        again = self.refresh(messages)
        self.assertEqual((again["media"]["not_mp4"], again["media"]["too_big"]), (0, 0), "said once in an app run, not at every refresh")

    def test_a_file_sent_again_with_a_kept_link_joins_its_files(self):
        # Owner, 2026-11-04: his test's link already kept a file from an earlier message, so the new MP4 was passed over.
        # A new message's files now join that link's files, a large one in the background as usual.
        archive.set_large_videos(True)
        url = "https://example.test/again"
        first = [Message(97, f"A photo first {url}", MessageMediaPhoto(jpeg(b"p")))]
        self.assertEqual(self.refresh(first)["media"]["photos"], 1)
        clip = Message(98, f"And a clip {url}", MessageMediaDocument(mp4(b"clip")))
        self.assertEqual(self.refresh([clip, *first])["media"]["videos"], 1)
        kept = archive.telegram_media_for_url(url)
        self.assertEqual(sorted((item["mid"], item["kind"]) for item in kept["items"]), [(97, "photo"), (98, "video")])
        self.assertEqual(kept["message"]["text"], f"A photo first {url}", "the set keeps the message it began with")
        talk = Message(99, f"Now the talk {url}", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(600)]))
        again = self.refresh([talk, clip, *first])
        self.assertEqual((again["media"]["waiting"], again["media"]["not_added"]), (1, 0))
        self.assertEqual(sorted(item["mid"] for item in archive.telegram_media_for_url(url)["items"]), [97, 98, 99],
                         "the background download kept the files from before too")
        self.assertEqual(self.refresh([talk, clip, *first])["media"]["kept"], 3, "nothing more to fetch")

    def test_a_link_keeps_ten_files_at_most_and_says_so_once(self):
        url = "https://example.test/full"
        album = [Message(200 + i, f"Ten photos {url}" if i == 0 else "", MessageMediaPhoto(jpeg(bytes([65 + i]))), grouped_id=200)
                 for i in range(10)]
        self.assertEqual(self.refresh(album)["media"]["photos"], 10)
        more = Message(300, f"One more {url}", MessageMediaPhoto(jpeg(b"more")))
        result = self.refresh([more, *album])
        self.assertEqual((result["media"]["not_added"], result["media"]["photos"]), (1, 0))
        self.assertEqual(len(archive.telegram_media_for_url(url)["items"]), 10)
        self.assertEqual(self.refresh([more, *album])["media"]["not_added"], 0, "said once in an app run")

    def test_no_free_space_keeps_the_rest_and_a_later_refresh_tries_again(self):
        archive.set_large_videos(True)
        url = "https://example.test/no-room"
        messages = self.large_link(url)
        with patch.object(shutil, "disk_usage", lambda path: types.SimpleNamespace(total=1, used=1, free=200 * MB)):
            self.refresh(messages)
        self.assertEqual(self.clients[1].streamed, [], "nothing starts without room for the file and the margin")
        record = archive.telegram_media_for_url(url)
        self.assertEqual(([i["kind"] for i in record["items"]], record["missing"]), (["photo"], 1))
        state = telegram_refresh.large_state()
        self.assertEqual((state["kept"], state["failed"], state["reason"]), (0, 1, "no_space"))
        self.assertEqual(self.parts(), [])
        self.refresh(messages)
        self.assertEqual([i["kind"] for i in archive.telegram_media_for_url(url)["items"]], ["photo", "video"], "Refresh tries again")

    def test_a_cut_download_leaves_no_partial_file(self):
        archive.set_large_videos(True)
        url = "https://example.test/cut"
        self.refresh(self.large_link(url), client_class=CuttingClient)
        state = telegram_refresh.large_state()
        self.assertEqual((state["kept"], state["failed"], state["reason"]), (0, 1, "unavailable"))
        self.assertEqual(self.parts(), [])
        self.assertEqual(archive.telegram_media_for_url(url)["missing"], 1)

    def test_progress_and_busy_answers_while_a_large_file_downloads_and_switching_off_stops_it(self):
        import telegram_auth
        archive.set_large_videos(True)
        self.refresh(self.large_link("https://example.test/progress"), client_class=SlowClient, wait=False)
        self.wait_for(lambda: telegram_refresh.large_state()["received"] > 0)
        state = telegram_refresh.large_state()
        self.assertEqual((state["running"], state["size"], state["total"], state["done"]), (True, len(BIG), 1, 0))
        self.assertEqual(len(self.parts()), 1, "written to a partial file while it downloads")
        with self.assertRaises(telegram_refresh.RefreshError) as raised:
            telegram_refresh.refresh_saved_messages(keep_media=True)
        self.assertEqual((raised.exception.code, raised.exception.status, str(raised.exception)),
                         ("busy", 409, telegram_refresh.LARGE_BUSY))
        with patch.object(telegram_auth, "_LOCK_WAIT_SECONDS", 0.1):
            with self.assertRaises(telegram_auth.AuthError) as auth:
                telegram_auth.cancel_login()
        self.assertEqual(auth.exception.code, "busy", "a sign-in step waits for the download too")
        if dashboard is not None:
            client = dashboard.app.test_client()
            answer = client.get("/api/archive/large-videos").get_json()
            self.assertEqual((answer["telegram"]["running"], answer["telegram"]["size"]), (True, len(BIG)))
            same = {"Sec-Fetch-Site": "same-origin"}
            for bad in ({"stop": False}, {"stop": True, "on": True}, {"stop": 1}):
                self.assertEqual(client.post("/api/archive/large-videos", json=bad, headers=same).status_code, 400, bad)
            self.assertFalse(client.post("/api/archive/large-videos", json={"on": False}, headers=same).get_json()["on"])
        else:
            archive.set_large_videos(False)
            telegram_refresh.stop_large()
        self.finish_large(stop=False)
        self.assertEqual(telegram_refresh.large_state()["reason"], "stopped", "switching the setting off stops the download")
        self.assertEqual(self.parts(), [])

    def test_stop_removes_the_partial_file_and_waits_until_the_app_starts_again(self):
        archive.set_large_videos(True)
        url = "https://example.test/stop-me"
        messages = self.large_link(url)
        self.refresh(messages, client_class=SlowClient, wait=False)
        self.wait_for(lambda: telegram_refresh.large_state()["received"] > 0)
        if dashboard is not None:
            stopped = dashboard.app.test_client().post("/api/archive/large-videos", json={"stop": True},
                                                       headers={"Sec-Fetch-Site": "same-origin"})
            self.assertEqual(stopped.status_code, 200)
        else:
            telegram_refresh.stop_large()
        self.finish_large(stop=False)
        state = telegram_refresh.large_state()
        self.assertEqual((state["kept"], state["failed"], state["reason"]), (0, 1, "stopped"))
        self.assertEqual(self.parts(), [])
        self.assertEqual([i["kind"] for i in archive.telegram_media_for_url(url)["items"]], ["photo"])
        later = self.refresh(messages)
        self.assertEqual((later["media"]["waiting"], later["media"]["skipped"]), (0, 1), "not started again in this app run")
        telegram_refresh.forget_held()             # the next app run, or the switch turned on again
        self.refresh(messages)
        self.assertEqual([i["kind"] for i in archive.telegram_media_for_url(url)["items"]], ["photo", "video"])

    def test_a_retry_keeps_what_was_kept_and_fetches_only_what_is_missing(self):
        archive.set_large_videos(True)
        url = "https://example.test/two-talks"
        messages = [Message(70, f"Both talks {url}", MessageMediaPhoto(jpeg(b"poster")), grouped_id=70),
                    Message(71, "", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(3600)]), grouped_id=70),
                    Message(72, "", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(3000)]), grouped_id=70)]

        class CutSecond(CuttingClient):
            cut = {72}
        self.refresh(messages, client_class=CutSecond)
        key = archive.copy_key(url)
        record = archive.telegram_media_for_url(url)
        self.assertEqual(([i["kind"] for i in record["items"]], record["missing"]), (["photo", "video"], 1))
        first = Path(archive.telegram_file_path(key, record["items"][1]["name"]))
        stamp = first.stat().st_mtime_ns

        automatic = self.refresh(messages)
        self.assertEqual((automatic["media"]["waiting"], automatic["media"]["skipped"]), (0, 1),
                         "a large download that broke off is not started again by an automatic check")
        self.assertEqual(self.clients[-1].downloads, [])

        pressed = self.refresh(messages, retry=True)
        self.assertEqual(pressed["media"]["waiting"], 1, "the Refresh button tries it again")
        background = self.clients[-1]
        self.assertEqual((background.streamed, background.in_memory), ([72], []), "only the missing video is downloaded")
        record = archive.telegram_media_for_url(url)
        self.assertEqual(([i["kind"] for i in record["items"]], record.get("missing")), (["photo", "video", "video"], None))
        self.assertEqual(first.stat().st_mtime_ns, stamp, "the video kept before stays as it was")
        self.assertEqual(self.parts(), [])

    def test_a_file_the_app_cannot_keep_is_not_downloaded_again_in_this_app_run(self):
        moov = b"\x00\x00\x00\x18moovisom" + b"\x00" * 4000      # labelled video/mp4, but not an MP4 file
        messages = [Message(90, "https://example.test/odd", MessageMediaDocument(moov)),
                    Message(91, "https://example.test/aac",
                            MessageMediaDocument(AAC, mime="audio/aac", attributes=[DocumentAttributeAudio(30, title="Jingle")]))]
        first = self.refresh(messages)
        self.assertEqual((sorted(self.clients[0].downloads), first["media"]["failed"], first["media"]["audio"]), ([90, 91], 1, 1))
        self.assertEqual([i["name"] for i in archive.telegram_media_for_url("https://example.test/aac")["items"]], ["tg0.aac"],
                         "AAC sent as audio/aac is kept")
        self.refresh(messages)
        self.assertEqual(self.clients[1].downloads, [], "the file it couldn't keep is not downloaded again")

    def test_a_link_deleted_while_its_files_download_stays_deleted(self):
        archive.set_large_videos(True)
        url = "https://example.test/deleted-meanwhile"
        self.refresh(self.large_link(url), client_class=SlowClient, wait=False)
        self.wait_for(lambda: telegram_refresh.large_state()["received"] > 0)
        conn = storage._connect()
        with conn:
            conn.execute("INSERT INTO library_items (url, id, document, deleted, ident) VALUES (?, ?, NULL, 1, ?)",
                         (url, "gone-1", storage.url_identity(url)))
        conn.close()
        archive.remove_for_url(url)
        self.finish_large(stop=False)
        self.assertIsNone(archive.telegram_media_for_url(url))
        self.assertEqual([name for name in self.files() if name.startswith(archive.copy_key(url))], [])
        self.assertEqual(telegram_refresh.large_state()["reason"], "gone")

    def test_the_same_link_in_two_messages_downloads_once(self):
        archive.set_large_videos(True)
        url = "https://example.test/twice"
        messages = self.large_link(url, first=100) + self.large_link(url, first=110)
        result = self.refresh(messages)
        self.assertEqual((result["media"]["waiting"], result["media"]["skipped"]), (1, 1))
        state = telegram_refresh.large_state()
        self.assertEqual((state["total"], state["kept"]), (1, 1))
        self.assertEqual([i["kind"] for i in archive.telegram_media_for_url(url)["items"]], ["photo", "video"])

    def test_a_disk_error_after_the_download_keeps_the_rest_and_no_partial_file(self):
        archive.set_large_videos(True)
        url = "https://example.test/full-disk"
        messages = [Message(80, f"Two parts {url}", MessageMediaPhoto(jpeg(b"p")), grouped_id=80),
                    Message(81, "", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(60)]), grouped_id=80),
                    Message(82, "", MessageMediaDocument(BIG, attributes=[DocumentAttributeVideo(60)]), grouped_id=80)]
        self.refresh(messages, client_class=FullDiskClient)
        record = archive.telegram_media_for_url(url)
        self.assertEqual(([i["kind"] for i in record["items"]], record["missing"]), (["photo", "video"], 1))
        state = telegram_refresh.large_state()
        self.assertEqual((state["done"], state["kept"], state["failed"], state["reason"]), (2, 1, 1, "no_space"))
        self.assertEqual(self.parts(), [])

    def test_a_path_entry_must_be_a_file_being_streamed(self):
        archive.save_telegram_media("https://example.test/owner", {}, [{"kind": "video", "data": mp4(b"o")}])
        kept = Path(archive.telegram_file_path(archive.copy_key("https://example.test/owner"), "tg0.mp4"))
        moved = archive.save_telegram_media("https://example.test/thief", {}, [{"kind": "video", "path": str(kept)}])
        self.assertEqual(moved, {"photos": 0, "videos": 0, "audio": 0})
        self.assertTrue(kept.exists(), "another link's kept file is neither taken nor removed")

    @unittest.skipIf(dashboard is None, "Flask not installed")
    def test_a_backup_bigger_than_1_gb_can_be_restored_when_there_is_room(self):
        self.assertGreaterEqual(archive.IMPORT_LIMIT, 16 * 1024 ** 3, "a backup with large videos and audio restores")
        client = dashboard.app.test_client()
        with patch.object(archive, "ENABLED", True), \
                patch.object(shutil, "disk_usage", lambda path: types.SimpleNamespace(total=1, used=1, free=MB)):
            answer = client.post("/api/archive/import", data=b"PK" + b"\x00" * 2000, content_type="application/zip")
        self.assertEqual(answer.status_code, 507)
        self.assertIn("twice its size", answer.get_json()["error"])
        self.assertEqual(self.parts(), [])

    def test_partial_files_left_when_the_app_quit_are_removed(self):
        os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
        old = Path(archive.ARCHIVE_DIR, "0" * 32 + ".abc123.part")
        old.write_bytes(b"cut off")
        os.utime(old, (time.time() - 7200, time.time() - 7200))
        fresh = Path(archive.ARCHIVE_DIR, "1" * 32 + ".def456.part")
        fresh.write_bytes(b"still arriving")
        ahead = time.time() + 1                    # Windows: a new file's time can be a moment ahead of time.time()
        os.utime(fresh, (ahead, ahead))
        kept = Path(archive.ARCHIVE_DIR, "2" * 32 + ".tg0.mp4")
        kept.write_bytes(mp4())
        self.assertEqual(archive.discard_partials(idle=3600), 1, "before a large download: only what nothing wrote to for an hour")
        self.assertEqual(self.files(), sorted([fresh.name, kept.name]))
        self.assertEqual(archive.discard_partials(), 1, "at start: every unfinished download")
        self.assertEqual(self.files(), [kept.name])

    # ── Backup zip ───────────────────────────────────────────────────────────

    def test_backup_zip_carries_the_files_and_restore_checks_them(self):
        url = "https://example.test/zip"
        archive.save_telegram_media(url, {"text": "zip me"}, [{"kind": "photo", "data": jpeg()},
                                                              {"kind": "video", "data": mp4(), "duration": 3}])
        key = archive.copy_key(url)
        blob = b"".join(archive.export_zip(b"{}", "2026-10-09T00:00:00Z"))
        names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
        self.assertIn(f"copies/{key}.tg.json", names)
        self.assertIn(f"copies/{key}.tg1.mp4", names)
        archive.delete_telegram_media(key)
        path = ROOT / "backup.zip"
        path.write_bytes(blob)
        result = archive.import_zip(str(path), {})
        self.assertEqual((result["telegram"], result["telegramNotInLibrary"]), (0, 1), "only links in this library")
        result = archive.import_zip(str(path), {storage.url_identity(url): url})
        self.assertEqual(result["telegram"], 1)
        self.assertEqual(archive.telegram_media(key)["message"]["text"], "zip me")
        result = archive.import_zip(str(path), {storage.url_identity(url): url})
        self.assertEqual((result["telegram"], result["telegramAlready"]), (0, 1), "never over existing files")

        archive.delete_telegram_media(key)
        bad = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(blob)) as source, zipfile.ZipFile(bad, "w") as target:
            for info in source.infolist():
                data = source.read(info)
                target.writestr(info.filename, b"<html><script>x</script>" if info.filename.endswith(".tg0.jpg") else data)
        path.write_bytes(bad.getvalue())
        result = archive.import_zip(str(path), {storage.url_identity(url): url})
        self.assertEqual((result["telegram"], result["telegramInvalid"]), (0, 1))
        self.assertIsNone(archive.telegram_media(key))

    def test_a_backup_restores_large_videos_and_audio(self):
        url = "https://example.test/big-backup"
        os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
        part = Path(archive.ARCHIVE_DIR, "streamed.part")
        part.write_bytes(BIG)
        archive.save_telegram_media(url, {"text": "big"}, [{"kind": "video", "path": str(part), "duration": 3600},
                                                           {"kind": "audio", "data": MP3, "title": "Levain basics"}])
        self.assertFalse(part.exists(), "the streamed file is moved into place")
        outside = ROOT / ("outside-" + secrets.token_hex(4) + ".mp4")
        outside.write_bytes(mp4())
        refused = archive.save_telegram_media("https://example.test/outside", {}, [{"kind": "video", "path": str(outside)}])
        self.assertEqual(refused, {"photos": 0, "videos": 0, "audio": 0})
        self.assertTrue(outside.exists(), "a file outside the archive folder is neither kept nor removed")
        key = archive.copy_key(url)
        path = ROOT / ("big-" + secrets.token_hex(4) + ".zip")
        with open(path, "wb") as handle:
            for piece in archive.export_zip(b"{}", "2026-10-28T00:00:00Z"):
                handle.write(piece)
        archive.delete_telegram_media(key)
        result = archive.import_zip(str(path), {storage.url_identity(url): url})
        self.assertEqual((result["telegram"], result["telegramInvalid"]), (1, 0))
        record = archive.telegram_media(key)
        self.assertEqual([(i["kind"], i["bytes"]) for i in record["items"]], [("video", len(BIG)), ("audio", len(MP3))])
        self.assertEqual(record["items"][1]["title"], "Levain basics")
        self.assertEqual(self.parts(), [])

    def test_restore_counts_copies_and_telegram_files_apart(self):
        url = "https://example.test/both"
        key = archive.copy_key(url)
        os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
        page = (b'<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="generator" content="Super Bookmark Manager saved copy 1">'
                b'<title>Both</title></head><body><p>Saved words</p></body></html>\n')
        Path(archive.ARCHIVE_DIR, key + ".html").write_bytes(page)
        Path(archive.ARCHIVE_DIR, key + ".json").write_text(json.dumps({"url": url, "title": "Both", "savedAt": "2026-10-09T00:00:00Z"}))
        archive.save_telegram_media(url, {}, [{"kind": "photo", "data": jpeg()}])
        path = ROOT / "both.zip"
        path.write_bytes(b"".join(archive.export_zip(b"{}", "2026-10-09T00:00:00Z")))
        library = {storage.url_identity(url): url}
        again = archive.import_zip(str(path), library)
        self.assertEqual((again["already"], again["telegramAlready"], again["invalid"]), (1, 1, 0))
        elsewhere = archive.import_zip(str(path), {})
        self.assertEqual((elsewhere["notInLibrary"], elsewhere["telegramNotInLibrary"]), (1, 1))

    # ── Routes ───────────────────────────────────────────────────────────────

    @unittest.skipIf(dashboard is None, "Flask not installed")
    def test_a_startup_check_that_could_not_run_is_tried_again(self):
        client = dashboard.app.test_client()
        headers = {"Content-Type": "application/json"}
        body = json.dumps({"confirm": True, "startup": True})
        outcomes = iter([telegram_refresh.RefreshError("network", "offline"), telegram_refresh.RefreshError("configuration", "no keys")])
        calls = []

        def failing(keep_media=False, retry=False):
            calls.append(keep_media)
            raise next(outcomes)
        with patch.dict(telegram_refresh._startup, {"claimed": False}), patch.object(telegram_refresh, "refresh_saved_messages", failing):
            self.assertEqual(client.post("/api/telegram/refresh", data=body, headers=headers).status_code, 503)
            second = client.post("/api/telegram/refresh", data=body, headers=headers)
            self.assertEqual(second.get_json()["code"], "configuration", "a passing network failure lets the next load try again")
            third = client.post("/api/telegram/refresh", data=body, headers=headers)
            self.assertEqual(third.get_json(), {"ok": True, "skipped": "already_checked"}, "a setup problem does not retry on every load")
        self.assertEqual(len(calls), 2)

    @unittest.skipIf(dashboard is None, "Flask not installed")
    def test_routes_serve_only_kept_files_as_inert_files(self):
        url = "https://example.test/route"
        archive.save_telegram_media(url, {"text": "hi", "date": "2026-10-07T18:22:00+00:00"},
                                    [{"kind": "photo", "data": jpeg()}, {"kind": "video", "data": mp4(), "duration": 9}])
        client = dashboard.app.test_client()
        headers = {"Content-Type": "application/json"}
        answer = client.post("/api/archive/telegram", data=json.dumps({"url": url}), headers=headers).get_json()
        self.assertEqual((answer["media"]["photos"], answer["media"]["videos"]), (1, 1))
        src = answer["media"]["items"][1]["src"]
        response = client.get(src)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "video/mp4")
        self.assertIn("sandbox", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        response.close()                           # Windows: an open file keeps the test folder from being removed
        key = archive.copy_key(url)
        for bad in (f"/archive/telegram/{key}/tg.json", f"/archive/telegram/{key}/tg5.jpg",
                    f"/archive/telegram/{'0' * 32}/tg0.jpg", f"/archive/telegram/{key}/tg0.html"):
            self.assertEqual(client.get(bad).status_code, 404, bad)
        none = client.post("/api/archive/telegram", data=json.dumps({"url": "https://example.test/none"}), headers=headers)
        self.assertIsNone(none.get_json()["media"])
        self.assertEqual(client.post("/api/archive/telegram", data=json.dumps({"url": url, "x": 1}), headers=headers).status_code, 400)
        with patch.dict(telegram_refresh._startup, {"claimed": True}):
            skipped = client.post("/api/telegram/refresh", data=json.dumps({"confirm": True, "startup": True}), headers=headers)
            self.assertEqual(skipped.get_json(), {"ok": True, "skipped": "already_checked"})
        with patch.dict(telegram_refresh._startup, {"claimed": False}):
            self.assertTrue(telegram_refresh.claim_startup_check())
            self.assertFalse(telegram_refresh.claim_startup_check(), "once per app run")
        for body in ({"confirm": True, "media": "yes"}, {"confirm": True, "other": 1}, {"media": True},
                     {"confirm": True, "startup": 1}, {"confirm": True, "retry": "yes"}):
            self.assertEqual(client.post("/api/telegram/refresh", data=json.dumps(body), headers=headers).status_code, 400, body)
        asked = []
        with patch.object(telegram_refresh, "refresh_saved_messages", lambda keep_media=False, retry=False: asked.append(retry) or {"ok": True}):
            client.post("/api/telegram/refresh", data=json.dumps({"confirm": True, "retry": True}), headers=headers)
            client.post("/api/telegram/refresh", data=json.dumps({"confirm": True}), headers=headers)
        self.assertEqual(asked, [True, False], "the Refresh button asks for broken-off downloads to be tried again")


if __name__ == "__main__":
    unittest.main()
