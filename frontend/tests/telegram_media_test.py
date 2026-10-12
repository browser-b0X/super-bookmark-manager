"""Photos and videos sent with a link to Saved Messages. Synthetic data only.

Run: python -B frontend/tests/telegram_media_test.py
The Telegram client is a scripted stand-in (no network), the library is a
throwaway SQLite file and the files go to a temporary folder under .verify.
"""
import io
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
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


# ── Telethon-shaped stand-ins ─────────────────────────────────────────────────

class MessageMediaPhoto:
    def __init__(self, data):
        self.photo, self.data = object(), data


class DocumentAttributeVideo:
    def __init__(self, duration, round_message=False):
        self.duration, self.round_message = duration, round_message


class DocumentAttributeSticker:
    pass


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
    def __init__(self, messages, fail_on=None):
        self.messages, self.fail_on, self.downloads = messages, fail_on or set(), []

    async def connect(self):
        return None

    async def disconnect(self):
        return None

    async def is_user_authorized(self):
        return True

    async def get_messages(self, entity, limit=None):
        return list(self.messages)[:limit]

    async def download_media(self, item, **kwargs):
        assert kwargs.get("file") is bytes, "files must be downloaded into memory, never into the working folder"
        self.downloads.append(getattr(item, "id", None))
        if getattr(item, "id", None) in self.fail_on:
            raise ConnectionError("synthetic drop")
        return item.media.data


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

    def refresh(self, messages, keep_media=True, fail_on=None, client_class=None):
        def construct(*args, **kwargs):
            client = (client_class or ScriptedClient)(messages, fail_on)
            self.clients.append(client)
            return client
        with patch("telethon.TelegramClient", construct):
            return telegram_refresh.refresh_saved_messages(keep_media=keep_media)

    def files(self):
        return sorted(p.name for p in self.archive_dir.iterdir()) if self.archive_dir.exists() else []

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
        self.assertEqual(saved, {"photos": 2, "videos": 1})
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
        self.assertEqual(entry["media"], {"url": url, "photos": 2, "videos": 1})
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
        self.assertEqual(archive.telegram_counts(archive.telegram_media_for_url(kept)), {"photos": 1, "videos": 0})
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
        self.assertEqual(archive.telegram_counts(archive.telegram_media_for_url(href)), {"photos": 1, "videos": 0})
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
        self.assertEqual(sorted(self.clients[1].downloads), [30, 31, 32], "Refresh tries again, as the message says")
        record = archive.telegram_media_for_url(url)
        self.assertEqual((len(record["items"]), record.get("missing")), (3, None))
        third = self.refresh(messages)
        self.assertEqual((self.clients[2].downloads, third["media"]["kept"]), ([], 1), "a complete set is not fetched again")

    def test_slow_previews_never_cost_the_links(self):
        import asyncio

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

        def failing(keep_media=False):
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
                     {"confirm": True, "startup": 1}):
            self.assertEqual(client.post("/api/telegram/refresh", data=json.dumps(body), headers=headers).status_code, 400, body)


if __name__ == "__main__":
    unittest.main()
