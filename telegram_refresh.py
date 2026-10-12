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
import storage

_refresh_lock = threading.Lock()
_SCHEME = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)
MAX_PREVIEW_DOWNLOADS = 10
PREVIEW_SIZE_LIMIT = 512 * 1024
READ_BUDGET = 60.0                   # seconds to connect and read the messages
PREVIEW_BUDGET = 20.0
MEDIA_BUDGET = 180.0                 # seconds for every photo and video of one refresh
MEDIA_PER_LINK = 10
MEDIA_TOTAL_LIMIT = 400 * 1024 * 1024
VIDEO_LIMIT = 50 * 1024 * 1024
# A link written in plain text, as lib/textLinks.ts finds it (keep the two identical):
# it stops at white space, ASCII quotes and angle brackets, and at the quote marks,
# CJK brackets and invisible direction marks that messages put around links.
_PLAIN_LINK = re.compile("https?://[^\t\n\x0b\x0c\r \x85\xa0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2064"
                         "\u3000\ufeff\"'<>«»“”„‟‘’‹›「」『』【】〈〉《》]+", re.I)
_TRAILING = re.compile("[.,;:!?…。、，！？：；]+$")
_BRACKETS = (("(", ")"), ("[", "]"), ("{", "}"), ("（", "）"))


def links_in_text(text):
    """Web links written in plain text, sentence punctuation and unmatched closing brackets dropped."""
    found = []
    for match in _PLAIN_LINK.finditer(text or ''):
        url = _TRAILING.sub("", match.group(0))
        for opening, closing in _BRACKETS:
            while url.endswith(closing) and url.count(closing) > url.count(opening):
                url = url[:-1]
        found.append(url)
    return found


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


def own_media(message):
    """("photo"|"video", declared bytes, seconds) for a photo or video the owner sent, else None.

    Link previews (MessageMediaWebPage), stickers, voice notes and other files
    are not the owner's photos or videos and are never kept.
    """
    media = getattr(message, 'media', None)
    name = type(media).__name__
    if name == 'MessageMediaPhoto' and getattr(media, 'photo', None) is not None:
        return 'photo', 0, None
    if name != 'MessageMediaDocument':
        return None
    document = getattr(media, 'document', None)
    mime = getattr(document, 'mime_type', None)
    size = getattr(document, 'size', None)
    if not isinstance(mime, str) or mime.lower() != 'video/mp4' or not isinstance(size, int) or isinstance(size, bool):
        return None
    if size <= 0 or size > VIDEO_LIMIT:
        return None
    duration = None
    for attribute in getattr(document, 'attributes', None) or []:
        kind = type(attribute).__name__
        if kind in ('DocumentAttributeSticker', 'DocumentAttributeAnimated'):
            return None
        if kind == 'DocumentAttributeVideo':
            if getattr(attribute, 'round_message', False):
                return None
            value = getattr(attribute, 'duration', None)
            duration = value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    return 'video', size, duration


def entity_target(part):
    """The link of a 'link' or 'text_link' part, as lib/telegram.ts reads it.

    Telegram also links text typed without http(s):// ("youtube.com/watch?v=…");
    like Telegram, such a link opens on the web, here as https://.
    """
    target = (part.get('href') if isinstance(part.get('href'), str) else part.get('text') or '').strip()
    if part.get('type') == 'link' and target and not re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", target):
        target = "https://" + target
    return target


def first_link(entry):
    """The link a message's photos and videos belong to: the first web link the importer finds.

    Mirrors the frontend importer (lib/telegram.ts): the message's parts in order,
    links Telegram detected or labeled as they are, plain text scanned for links.
    Returned in the spelling the importer stores (browser_href), or None.
    """
    for part in entry.get('text_entities', []):
        kind = part.get('type')
        candidates = [entity_target(part)] if kind in ('link', 'text_link') else links_in_text(part.get('text'))
        for candidate in candidates:
            href = storage.browser_href(candidate)
            if href:
                return href
    return None


def refresh_limit():
    configured = config.MAX_MESSAGES_PER_RUN
    return min(configured, 200) if configured > 0 else 200


def message_parts(text, entities):
    """Split a message's text at its link entities (offsets count UTF-16 units, as Telegram's do)."""
    data = text.encode('utf-16-le')
    units = len(data) // 2
    spans, labeled = [], []
    for entity in entities:
        kind = type(entity).__name__
        if kind not in ('MessageEntityUrl', 'MessageEntityTextUrl'):
            continue
        url = getattr(entity, 'url', None) if kind == 'MessageEntityTextUrl' else None
        if kind == 'MessageEntityTextUrl' and not isinstance(url, str):
            raise ValueError('Malformed labeled link')
        offset, length = getattr(entity, 'offset', None), getattr(entity, 'length', None)
        if (isinstance(offset, int) and isinstance(length, int) and not isinstance(offset, bool)
                and not isinstance(length, bool) and 0 <= offset and 0 < length and offset + length <= units):
            spans.append((offset, offset + length, kind, url))
        elif url is not None:
            labeled.append({'type': 'text_link', 'text': '', 'href': url})   # no usable position: keep the target
    parts, cursor = [], 0
    for start, end, kind, url in sorted(spans, key=lambda span: span[:2]):
        if start < cursor:
            continue                        # overlapping entities: the first one wins
        try:
            before, shown = data[2 * cursor:2 * start].decode('utf-16-le'), data[2 * start:2 * end].decode('utf-16-le')
        except UnicodeDecodeError:
            continue                        # an offset inside a surrogate pair: leave it to the text scan
        if before:
            parts.append({'type': 'plain', 'text': before})
        parts.append({'type': 'link', 'text': shown} if kind == 'MessageEntityUrl'
                     else {'type': 'text_link', 'text': shown, 'href': url})
        cursor = end
    rest = data[2 * cursor:].decode('utf-16-le', errors='replace')
    if rest or not parts:
        parts.append({'type': 'plain', 'text': rest})
    return parts + labeled


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
    # Like a Telegram Desktop export: the text in order, as plain runs and the
    # links Telegram itself detected ('link') or labeled ('text_link'). Using
    # Telegram's own detection keeps a link next to «quotes» or other non-ASCII
    # punctuation exact, and gives both import paths the same links.
    parts = message_parts(text, entities)
    # Non-web targets written in plain text are listed too, so the shared parser
    # counts them as unsupported rather than silently skipping them.
    for part in [part for part in parts if part['type'] == 'plain']:
        for url in _SCHEME.findall(part['text']):
            if not url.lower().startswith(('http://', 'https://')):
                parts.append({'type': 'link', 'text': url})
    return {'id': identifier, 'type': 'message', 'text': text,
            'date': date.replace(tzinfo=date.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat(),
            'text_entities': parts}


async def read_saved_messages(keep_media=False):
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
        async with asyncio.timeout(READ_BUDGET):
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

        # Previews are a bonus over a read that already succeeded: they run after
        # the read's 60 s, under their own budget, so a slow photo can never
        # cost the owner the links themselves.
        try:
            async with asyncio.timeout(PREVIEW_BUDGET):
                await collect_previews()
        except asyncio.TimeoutError:
            pass
        except Exception:  # noqa: BLE001 - the links still come back
            previews['failed'] += 1
        media = {'links': 0, 'photos': 0, 'videos': 0, 'kept': 0, 'skipped': 0, 'failed': 0}
        result = {'ok': True, 'limit': limit, 'checked': checked, 'malformed': malformed,
                  'previews': previews, 'media': media,
                  'export': {'type': 'saved_messages', 'messages': converted}}
        # Photos and videos have their own budget, after the read: like previews,
        # they must never cost the owner the links themselves.
        if keep_media:
            try:
                async with asyncio.timeout(MEDIA_BUDGET):
                    await collect_media(client, messages[:limit], by_id, media)
            except asyncio.TimeoutError:
                media['skipped'] += 1
            except Exception:  # noqa: BLE001 - a dropped connection mid-download still returns the links
                media['failed'] += 1
        return result
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


async def collect_media(client, messages, by_id, counts):
    """Download the photos and videos sent with a link and keep them with that link.

    An album is several messages sharing a grouped_id; the link is usually in
    only one of them, so the whole album belongs to that link. Links already
    holding kept files, and links the owner deleted, are left alone. Each
    entry that has files gets entry['media'] = {'url', 'photos', 'videos'}.
    """
    import archive
    import storage
    try:
        deleted = storage.deleted_identities()
    except Exception:  # noqa: BLE001 - without the list nothing is downloaded, rather than a deleted link's photos
        return
    albums = {}
    for message in messages:
        group = getattr(message, 'grouped_id', None)
        if isinstance(group, int) and not isinstance(group, bool):
            albums.setdefault(group, []).append(message)
    total = 0
    for message in messages:
        entry = by_id.get(getattr(message, 'id', None))
        url = first_link(entry) if entry else None
        if not url:
            continue
        group = getattr(message, 'grouped_id', None)
        siblings = albums.get(group, [message]) if isinstance(group, int) and not isinstance(group, bool) else [message]
        siblings = sorted(siblings, key=lambda item: getattr(item, 'id', 0))
        wanted = [(item, found) for item in siblings for found in [own_media(item)] if found][:MEDIA_PER_LINK]
        if not wanted:
            continue
        counts['links'] += 1
        if storage.url_identity(url) in deleted:
            counts['skipped'] += 1
            continue
        kept = archive.telegram_media_for_url(url)
        if kept and not kept.get('missing'):
            entry['media'] = {'url': url, **archive.telegram_counts(kept)}
            counts['kept'] += 1
            continue
        # A link whose last download left files out (a dropped connection, the
        # refresh's size budget) is fetched again in full: "Refresh tries again".
        items, missing = [], 0
        for position, (item, (kind, declared, duration)) in enumerate(wanted):
            if total + declared > MEDIA_TOTAL_LIMIT:
                counts['skipped'] += 1
                missing += len(wanted) - position
                break
            try:
                data = await client.download_media(item, file=bytes)
            except Exception:  # noqa: BLE001 - one file that cannot be downloaded never stops the others
                data = None
            if not isinstance(data, (bytes, bytearray)):
                counts['failed'] += 1
                missing += 1
                continue
            total += len(data)
            items.append({'kind': kind, 'data': bytes(data), 'duration': duration})
        if not items:
            continue
        try:
            saved = archive.save_telegram_media(url, {'text': entry.get('text', ''), 'date': entry.get('date', '')}, items,
                                                missing=missing)
        except (archive.ArchiveError, OSError, ValueError):
            counts['failed'] += len(items)
            continue
        counts['failed'] += len(items) - saved['photos'] - saved['videos']
        if saved['photos'] or saved['videos']:
            counts['photos'] += saved['photos']
            counts['videos'] += saved['videos']
            entry['media'] = {'url': url, **saved}


_startup = {'claimed': False}
_startup_lock = threading.Lock()


def claim_startup_check():
    """True the first time this app run asks for its start-up check, False after that."""
    with _startup_lock:
        if _startup['claimed']:
            return False
        _startup['claimed'] = True
        return True


def release_startup_check():
    """The start-up check could not run for a passing reason (no network yet, a
    refresh already running): the next page load of this run may try again."""
    with _startup_lock:
        _startup['claimed'] = False


def refresh_saved_messages(keep_media=False):
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
            return asyncio.run(read_saved_messages(keep_media))
        finally:
            telegram_auth._LOCK.release()
    finally:
        _refresh_lock.release()
