"""Explicit, bounded Saved Messages read. No authentication prompt or library writes.

Return the same message shape as Telegram Desktop so the supported importer owns
URL identity, curation reconciliation, categorization and SQLite pending writes.
"""
import asyncio
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
import threading

import config
import metadata_fetcher

_refresh_lock = threading.Lock()
_SCHEME = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)
MAX_PREVIEW_DOWNLOADS = 10
PREVIEW_SIZE_LIMIT = 512 * 1024
PREVIEW_BUDGET = 20.0


class RefreshError(RuntimeError):
    def __init__(self, code, message, status=503):
        super().__init__(message)
        self.code, self.status = code, status


def preview_target(message):
    """The link-preview photo Telegram already resolved for a message, if any."""
    media = getattr(message, 'media', None)
    if type(media).__name__ != 'MessageMediaWebPage':
        return None
    page = getattr(media, 'web_page', None)
    url = getattr(page, 'url', None)
    photo = getattr(page, 'photo', None)
    if (not isinstance(url, str) or photo is None
            or not url.lower().startswith(('http://', 'https://'))):
        return None
    return url, photo


_IMAGE_SIGNATURES = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"RIFF")


def embedded_photo_bytes(photo):
    """Complete preview bytes Telegram inlined in the message: no request needed.

    Telegram also inlines a `PhotoStrippedSize`: a few hundred bytes of
    header-less JPEG data meant for a blurred placeholder. It is not an image
    file, so it is skipped rather than returned (returning it used to block
    the real download and every preview then failed validation).
    """
    for size in getattr(photo, 'sizes', None) or []:
        if type(size).__name__ in ('PhotoStrippedSize', 'PhotoPathSize'):
            continue
        raw = getattr(size, 'bytes', None)
        if (isinstance(raw, (bytes, bytearray)) and len(raw) <= PREVIEW_SIZE_LIMIT
                and bytes(raw[:8]).startswith(_IMAGE_SIGNATURES)):
            return bytes(raw)
    return None


def best_photo_size(photo):
    """Largest advertised size that still fits the preview budget, else None."""
    best, best_bytes = None, 0
    for size in getattr(photo, 'sizes', None) or []:
        declared = getattr(size, 'size', None)
        if type(size).__name__ == 'PhotoSizeProgressive':
            progressive = getattr(size, 'sizes', None) or []
            declared = max((s for s in progressive if isinstance(s, int) and s <= PREVIEW_SIZE_LIMIT), default=None)
        if isinstance(declared, int) and not isinstance(declared, bool) and best_bytes < declared <= PREVIEW_SIZE_LIMIT:
            best, best_bytes = size, declared
    return best


def declared_photo_size(photo):
    """Largest advertised size that still fits the preview budget, else 0."""
    size = best_photo_size(photo)
    if size is None:
        return 0
    declared = getattr(size, 'size', None)
    if isinstance(declared, int) and not isinstance(declared, bool):
        return declared
    return max((s for s in getattr(size, 'sizes', None) or [] if isinstance(s, int) and s <= PREVIEW_SIZE_LIMIT), default=0)


def refresh_limit():
    configured = config.MAX_MESSAGES_PER_RUN
    return min(configured, 200) if configured > 0 else 200


def export_message(message):
    """Reject malformed entries individually; keep valid multi/link-entity text."""
    identifier = getattr(message, 'id', None)
    text = getattr(message, 'message', None)
    date = getattr(message, 'date', None)
    entities = getattr(message, 'entities', None) or []
    if (not isinstance(identifier, int) or isinstance(identifier, bool)
            or not isinstance(text, str) or not isinstance(date, datetime)
            or not isinstance(entities, (list, tuple))):
        raise ValueError('Malformed Telegram message')
    # Keep plain text once. Explicit entities also carry non-HTTP targets so
    # the shared parser can count unsupported schemes rather than import them.
    parts = [{'type': 'plain', 'text': text}]
    for entity in entities:
        if type(entity).__name__ == 'MessageEntityTextUrl':
            url = getattr(entity, 'url', None)
            if not isinstance(url, str):
                raise ValueError('Malformed labeled link')
            parts.append({'type': 'text_link', 'text': '', 'href': url})
    for url in _SCHEME.findall(text):
        if not url.lower().startswith(('http://', 'https://')):
            parts.append({'type': 'link', 'text': url})
    return {'id': identifier, 'type': 'message', 'text': text,
            'date': date.replace(tzinfo=date.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat(),
            'text_entities': parts}


async def read_saved_messages():
    try:
        from telethon import TelegramClient
    except ImportError:
        raise RefreshError('dependency', 'Live refresh needs Telethon. Install telethon for the server Python, or use the Telegram JSON import.') from None
    if not config.TELEGRAM_API_ID or not config.TELEGRAM_API_HASH:
        raise RefreshError('configuration', 'Set TELEGRAM_API_ID and TELEGRAM_API_HASH for the server, then retry. JSON import needs no credentials.')
    # Check before constructing TelegramClient: SQLiteSession otherwise creates
    # an empty session. Never start/login/reset or replace the existing session.
    if not Path(config.TELEGRAM_SESSION_FILE).is_file():
        raise RefreshError('session', 'Existing Telegram session is unavailable. Restore your authorized session.session, or use the Telegram JSON import.')
    client = None
    try:
        # request_retries must stay positive: Telethon recovers from a DC migration
        # or transient server fault by retrying, and with no attempt left it discards
        # the real RPC error and raises a bare ValueError that the handler below can
        # only report as a connection failure. flood_sleep_threshold is 0 so a wait
        # raises at once instead of outlasting the timeout and looking like one.
        client = TelegramClient(config.TELEGRAM_SESSION_FILE, config.TELEGRAM_API_ID,
                                config.TELEGRAM_API_HASH, connection_retries=0,
                                request_retries=5, timeout=15,
                                raise_last_call_error=True, flood_sleep_threshold=0)
        async with asyncio.timeout(60):
            await client.connect()
            if not await client.is_user_authorized():
                raise RefreshError('session', 'Telegram session is not authorized. Authorize it separately or use the Telegram JSON import. The session was not reset.')
            limit = refresh_limit()
            messages = await client.get_messages('me', limit=limit)
            if not isinstance(messages, (list, tuple)):
                raise RefreshError('response', 'Telegram returned an unexpected response. No links were imported; retry later.')
            converted, malformed = [], 0
            # Enforce the boundary even if an upstream/mock implementation overreturns.
            for message in messages[:limit]:
                try:
                    converted.append(export_message(message))
                except (ValueError, TypeError, AttributeError, OverflowError):
                    malformed += 1
            checked = min(len(messages), limit)
            if checked and malformed == checked:
                raise RefreshError('response', 'Telegram returned only malformed messages. No links were imported; retry later.')
            previews = {'present': 0, 'installed': 0, 'cached': 0, 'failed': 0, 'skipped': 0, 'requests': 0}
            by_id = {entry['id']: entry for entry in converted}

            async def collect_previews():
                deadline = asyncio.get_running_loop().time() + PREVIEW_BUDGET
                for message in messages[:limit]:
                    target = preview_target(message)
                    if target is None:
                        continue
                    previews['present'] += 1
                    entry = by_id.get(getattr(message, 'id', None))
                    if entry is None:
                        continue
                    url, photo = target
                    code = 'tg_' + hashlib.sha256(url.encode('utf-8')).hexdigest()[:24]
                    path = metadata_fetcher.cached_thumb(code)
                    if path:
                        previews['cached'] += 1
                    else:
                        data = embedded_photo_bytes(photo)
                        if data is None:
                            if (previews['requests'] >= MAX_PREVIEW_DOWNLOADS
                                    or declared_photo_size(photo) == 0
                                    or asyncio.get_running_loop().time() > deadline):
                                previews['skipped'] += 1
                                continue
                            try:
                                # file=bytes returns the image in memory (without it Telethon
                                # writes a file into the working directory and returns a path).
                                size = best_photo_size(photo)
                                data = await (client.download_media(photo, file=bytes, thumb=size) if size is not None
                                              else client.download_media(photo, file=bytes))
                            except Exception:
                                data = None
                            else:
                                previews['requests'] += 1
                        if not isinstance(data, (bytes, bytearray)):
                            previews['failed'] += 1
                            continue
                        path = metadata_fetcher.install_thumb(code, bytes(data))
                        if not path:
                            previews['failed'] += 1
                            continue
                        previews['installed'] += 1
                    entry['preview'] = {'url': url, 'thumbnail': path}

            # Previews are a bonus over a read that already succeeded: a slow
            # photo budget must never cost the owner the links themselves.
            try:
                async with asyncio.timeout(PREVIEW_BUDGET):
                    await collect_previews()
            except asyncio.TimeoutError:
                pass
            return {'ok': True, 'limit': limit, 'checked': checked, 'malformed': malformed,
                    'previews': previews,
                    'export': {'type': 'saved_messages', 'messages': converted}}
    except RefreshError:
        raise
    except Exception:
        # Never expose provider exceptions: they may contain personal content.
        raise RefreshError('network', 'Telegram refresh failed or timed out. Check the connection and session, then retry. No links from this attempt were imported.') from None
    finally:
        if client is not None:
            try:
                await asyncio.wait_for(client.disconnect(), timeout=5)
            except Exception:
                pass


def refresh_saved_messages():
    if not _refresh_lock.acquire(blocking=False):
        raise RefreshError('busy', 'A Telegram refresh is already running. Wait for it to finish, then retry.', 409)
    try:
        # Sign-in, check and disconnect use the same session file. Sharing their
        # lock means a refresh never races a logout (on Windows the open
        # session database would block its removal) or a login step.
        import telegram_auth
        if not telegram_auth._LOCK.acquire(blocking=False):
            raise RefreshError('busy', 'Telegram sign-in or disconnect is in progress. Wait for it to finish, then retry.', 409)
        try:
            return asyncio.run(read_saved_messages())
        finally:
            telegram_auth._LOCK.release()
    finally:
        _refresh_lock.release()
