"""Explicit, bounded Saved Messages read. No authentication prompt or library writes.

Return the same message shape as Telegram Desktop so the supported importer owns
URL identity, curation reconciliation, categorization and SQLite pending writes.
"""
import asyncio
import contextlib
from datetime import datetime, timezone
import errno
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import time

import config
import metadata_fetcher
import storage

_refresh_lock = threading.Lock()
_SCHEME = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)
MAX_PREVIEW_DOWNLOADS = 10
PREVIEW_SIZE_LIMIT = 512 * 1024
READ_BUDGET = 60.0                   # seconds to connect and read the messages
PREVIEW_BUDGET = 20.0
MEDIA_BUDGET = 180.0                 # seconds for every photo, video and audio file of one refresh
MEDIA_PER_LINK = 10
MEDIA_TOTAL_LIMIT = 400 * 1024 * 1024
VIDEO_LIMIT = 50 * 1024 * 1024       # one video or audio file the refresh itself downloads (into memory)
# With "Keep large videos and audio" on, bigger ones (up to archive.LARGE_VIDEO_LIMIT) are downloaded after the
# refresh, streamed to disk (download_later).
LARGE_STALL = 120.0                  # seconds without a byte before such a download stops
LARGE_RATE = 512 * 1024              # bytes a second: a file gets size / rate seconds, and at least archive.LARGE_VIDEO_SECONDS
PHOTO_SECONDS = 60.0                 # one photo downloaded with them
_AUDIO_TYPES = frozenset(("audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/ogg",
                          "audio/opus", "audio/flac", "audio/x-flac", "audio/wav", "audio/x-wav", "audio/wave",
                          "audio/vnd.wave"))
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


def _seconds(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def own_media(message, limit=VIDEO_LIMIT):
    """{"kind": "photo"|"video"|"audio", "size": declared bytes, "duration", "title", "voice"} for a photo, video or
    audio file the owner sent, else None. `limit`: the most a video or audio file may be.

    Audio is music or a recording sent as a file, or a voice message. Link
    previews (MessageMediaWebPage), stickers, round video messages and other
    files are not the owner's photos, videos or audio and are never kept.
    """
    media = getattr(message, 'media', None)
    name = type(media).__name__
    if name == 'MessageMediaPhoto' and getattr(media, 'photo', None) is not None:
        return {'kind': 'photo', 'size': 0, 'duration': None, 'title': '', 'voice': False}
    if name != 'MessageMediaDocument':
        return None
    document = getattr(media, 'document', None)
    mime = getattr(document, 'mime_type', None)
    size = getattr(document, 'size', None)
    if not isinstance(mime, str) or not isinstance(size, int) or isinstance(size, bool):
        return None
    kind = 'video' if mime.lower() == 'video/mp4' else 'audio' if mime.lower() in _AUDIO_TYPES else None
    if kind is None or size <= 0 or size > limit:
        return None
    found, names = {'kind': kind, 'size': size, 'duration': None, 'title': '', 'voice': False}, {}
    for attribute in getattr(document, 'attributes', None) or []:
        attribute_kind = type(attribute).__name__
        if attribute_kind in ('DocumentAttributeSticker', 'DocumentAttributeAnimated'):
            return None
        if attribute_kind == 'DocumentAttributeVideo' and kind == 'video':
            if getattr(attribute, 'round_message', False):
                return None
            found['duration'] = _seconds(getattr(attribute, 'duration', None))
        elif attribute_kind == 'DocumentAttributeAudio' and kind == 'audio':
            found['duration'] = _seconds(getattr(attribute, 'duration', None))
            found['voice'] = getattr(attribute, 'voice', False) is True
            names.update(performer=getattr(attribute, 'performer', None), title=getattr(attribute, 'title', None))
        elif attribute_kind == 'DocumentAttributeFilename':
            names['file'] = getattr(attribute, 'file_name', None)
    if kind == 'audio' and not found['voice']:
        # "Performer – Title" as Telegram shows it, else the file's name; archive.py cleans and shortens it.
        parts = [part.strip() for part in (names.get('performer'), names.get('title')) if isinstance(part, str) and part.strip()]
        found['title'] = ' – '.join(parts) or (names['file'] if isinstance(names.get('file'), str) else '')
    return found


def unkept_media(message, ceiling):
    """Why a video or audio file the owner sent with a link can't be kept, or None: 'not_mp4' for a video Telegram
    holds as another kind of file (a phone's .mov sent as a file, say), 'too_big' for one over `ceiling`. Stickers, GIFs,
    round video messages and other files are not the owner's videos or audio and are passed over, as in own_media."""
    media = getattr(message, 'media', None)
    if type(media).__name__ != 'MessageMediaDocument':
        return None
    document = getattr(media, 'document', None)
    mime, size = getattr(document, 'mime_type', None), getattr(document, 'size', None)
    if not isinstance(mime, str) or not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        return None
    attributes = getattr(document, 'attributes', None) or []
    for attribute in attributes:
        name = type(attribute).__name__
        if name in ('DocumentAttributeSticker', 'DocumentAttributeAnimated') or (
                name == 'DocumentAttributeVideo' and getattr(attribute, 'round_message', False)):
            return None
    mime = mime.lower()
    if mime == 'video/mp4' or mime in _AUDIO_TYPES:
        return 'too_big' if size > ceiling else None
    return 'not_mp4' if mime.startswith('video/') else None


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


async def read_saved_messages(keep_media=False, later=None):
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
        media = {'links': 0, 'photos': 0, 'videos': 0, 'audio': 0, 'kept': 0, 'skipped': 0, 'failed': 0, 'waiting': 0,
                 'over': 0, 'not_mp4': 0, 'too_big': 0, 'not_added': 0}
        result = {'ok': True, 'limit': limit, 'checked': checked, 'malformed': malformed,
                  'previews': previews, 'media': media,
                  'export': {'type': 'saved_messages', 'messages': converted}}
        # Photos, videos and audio have their own budget, after the read: like
        # previews, they must never cost the owner the links themselves.
        if keep_media:
            try:
                async with asyncio.timeout(MEDIA_BUDGET):
                    await collect_media(client, messages[:limit], by_id, media, later)
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


def _mid(message):
    identifier = getattr(message, 'id', None)
    return identifier if isinstance(identifier, int) and not isinstance(identifier, bool) else None


def _kept_by_message(kept):
    """A kept set's files by the message each came from. Sets kept before message ids were recorded have none:
    those are fetched again in full, and a smaller result never replaces them."""
    return {item['mid']: item for item in (kept or {}).get('items', []) if isinstance(item.get('mid'), int)}


async def collect_media(client, messages, by_id, counts, later=None):
    """Download the photos, videos and audio files sent with a link and keep them with that link.

    An album is several messages sharing a grouped_id; the link is usually in
    only one of them, so the whole album belongs to that link. Links the owner
    deleted are left alone. Files another message sent with the same link stay
    kept, and a new message's files join them (owner, 2026-11-04), up to
    MEDIA_PER_LINK in all; those past it are counted in 'not_added', once an app
    run. Each
    entry that has files gets entry['media'] = {'url', 'photos', 'videos', 'audio'}.
    A set that left files out (a dropped connection, the refresh's size budget,
    files over 50 MB with the switch off) fetches only those; what was kept
    stays as it is. A link with a video or audio file over VIDEO_LIMIT to
    fetch (only with "Keep large videos and audio" on) goes to `later`: its
    files are downloaded after the refresh, in the background (download_later).
    Files held in this app run (_held) are not tried again by themselves.
    """
    import archive
    import storage
    try:
        deleted = storage.deleted_identities()
    except Exception:  # noqa: BLE001 - without the list nothing is downloaded, rather than a deleted link's photos
        return
    limit = archive.video_limit()
    albums = {}
    for message in messages:
        group = getattr(message, 'grouped_id', None)
        if isinstance(group, int) and not isinstance(group, bool):
            albums.setdefault(group, []).append(message)
    total, queued = 0, set()
    for message in messages:
        entry = by_id.get(getattr(message, 'id', None))
        url = first_link(entry) if entry else None
        if not url:
            continue
        group = getattr(message, 'grouped_id', None)
        siblings = albums.get(group, [message]) if isinstance(group, int) and not isinstance(group, bool) else [message]
        siblings = sorted(siblings, key=lambda item: getattr(item, 'id', 0))
        wanted = [(item, found) for item in siblings
                  for found in [own_media(item, archive.LARGE_VIDEO_LIMIT)] if found][:MEDIA_PER_LINK]
        # A video or audio file that can't be kept is said once an app run, not passed over without a word.
        if storage.url_identity(url) not in deleted:
            for item in siblings:
                reason = unkept_media(item, archive.LARGE_VIDEO_LIMIT)
                if reason and _mid(item) not in _unkept_said:
                    _unkept_said.add(_mid(item))
                    counts[reason] += 1
        if not wanted:
            continue
        counts['links'] += 1
        if storage.url_identity(url) in deleted:
            counts['skipped'] += 1
            continue
        if archive.copy_key(url) in queued:
            counts['skipped'] += 1              # the same link in another message, already waiting for its download
            continue
        kept = archive.telegram_media_for_url(url)
        carried = _kept_by_message(kept)
        # Files of other messages with this link stay kept, and this message's new ones join them. A set kept before
        # message ids were recorded can't tell them apart and stays as it was.
        here = {_mid(item) for item, _ in wanted}
        others = [item for mid, item in carried.items() if mid not in here]
        fresh = [pair for pair in wanted if _mid(pair[0]) not in carried] if carried else []
        room = max(0, MEDIA_PER_LINK - len(others) - (len(wanted) - len(fresh)))
        for item, _ in fresh[room:]:
            if _mid(item) not in _unkept_said:
                _unkept_said.add(_mid(item))
                counts['not_added'] += 1
        wanted = [pair for pair in wanted if pair not in fresh[room:]]
        if kept and not kept.get('missing') and not (kept.get('over') and limit > VIDEO_LIMIT) and not fresh[:room]:
            entry['media'] = {'url': url, **archive.telegram_counts(kept)}
            counts['kept'] += 1
            continue
        # A set that began with another message keeps that message's text.
        message = kept['message'] if others else {'text': entry.get('text', ''), 'date': entry.get('date', '')}
        over = sum(found['size'] > limit for _, found in wanted)
        counts['over'] += over
        wanted = [(item, found) for item, found in wanted if found['size'] <= limit]
        held = [_mid(item) for item, _ in wanted if _mid(item) in _held and _mid(item) not in carried]
        if held:
            counts['skipped'] += 1              # stopped, or failed earlier in this app run
        todo = [(item, found) for item, found in wanted if _mid(item) not in carried and _mid(item) not in _held]
        large = [_mid(item) for item, found in todo if found['size'] > VIDEO_LIMIT]
        if large:
            if later is not None:
                later.append({'url': url, 'text': message['text'], 'date': message['date'],
                              'ids': [_mid(item) for item, _ in wanted], 'large': large})
                queued.add(archive.copy_key(url))
                counts['waiting'] += len(large)
            continue
        items, missing, fetched, full = [{'kept': item['name']} for item in others], len(held), 0, False
        for item, found in wanted:
            mid = _mid(item)
            if mid in carried:
                items.append({'kept': carried[mid]['name']})
                continue
            if mid in _held:
                continue                        # counted in `missing` already
            if full or total + found['size'] > MEDIA_TOTAL_LIMIT:
                counts['skipped'] += 0 if full else 1
                full, missing = True, missing + 1
                continue
            try:
                data = await client.download_media(item, file=bytes)
            except Exception:  # noqa: BLE001 - one file that cannot be downloaded never stops the others
                data = None
            if not isinstance(data, (bytes, bytearray)):
                counts['failed'] += 1
                missing += 1
                continue
            if not archive.telegram_file_ok(found['kind'], data):
                _held[mid] = 'rejected'         # not a picture, MP4 video or audio file it can keep
                counts['failed'] += 1
                continue
            total += len(data)
            fetched += 1
            items.append({'kind': found['kind'], 'data': bytes(data), 'duration': found['duration'],
                          'title': found['title'], 'voice': found['voice'], 'mid': mid})
        if not fetched or (kept and not carried and len(items) < len(kept['items'])):
            if kept:                            # nothing new, or a smaller set than one kept before ids were recorded
                entry['media'] = {'url': url, **archive.telegram_counts(kept)}
            continue
        try:
            if others:                          # what the set left out before still counts
                missing, over = max(missing, kept.get('missing', 0)), max(over, kept.get('over', 0))
            saved = archive.save_telegram_media(url, message, items, missing=missing, over=over)
        except (archive.ArchiveError, OSError, ValueError):
            counts['failed'] += fetched
            continue
        counts['photos'] += saved['photos']
        counts['videos'] += saved['videos']
        counts['audio'] += saved['audio']
        entry['media'] = {'url': url, **saved}


# ── Large videos and audio, after the refresh ────────────────────────────────
# With "Keep large videos and audio" on, a link whose video or audio file is
# over VIDEO_LIMIT is left out of the refresh, which holds files in memory and
# must hand back the links within minutes. Its files are downloaded right
# after, in the background: every video and audio file streamed into the
# archive folder with the free space checked first. The download holds the
# session like a refresh, so a refresh or a sign-in step answers "busy" until
# it ends; Settings shows how far it got and can stop it.

LARGE_BUSY = ('A large video or audio file is downloading from Telegram. Wait for it to finish, or stop it under '
              'Telegram Saved Messages in Settings, then retry.')
_large_lock = threading.Lock()
_large = {'running': False, 'total': 0, 'done': 0, 'kept': 0, 'failed': 0, 'received': 0, 'size': 0, 'reason': ''}
_large_stop = threading.Event()
# Message ids not tried again by themselves in this app run, with the reason: stopped by the owner, not a file the
# app keeps ('rejected'), or a large download that broke off. The Refresh button tries the broken-off ones again;
# turning "Keep large videos and audio" on again, or the next app run, tries them all.
_held = {}
_HELD = ('stopped', 'rejected', 'slow', 'unavailable', 'too_large')
# Message ids whose file can't be kept (unkept_media) or is past a link's MEDIA_PER_LINK, said once in this app run.
_unkept_said = set()
_RETRY = ('slow', 'unavailable', 'too_large')


def large_state():
    """The background download as Settings shows it: whether it runs, the large files done of all of them, the bytes
    of the current one, and why the last one that was not kept wasn't ('' when none failed)."""
    with _large_lock:
        return dict(_large)


def forget_held(reasons=None):
    """Let the next refresh try held files again: all of them, or those held for one of `reasons`. All of them: it says
    again which files can't be kept, too."""
    for message_id, reason in list(_held.items()):
        if reasons is None or reason in reasons:
            _held.pop(message_id, None)
    if reasons is None:
        _unkept_said.clear()


def stop_large():
    """Stop the background download: the file being downloaded is removed, and what was stopped waits for the next
    app run. True when one was running."""
    with _large_lock:
        if _large['running']:
            _large_stop.set()
            return True
    return False


def _large_update(**changes):
    with _large_lock:
        _large.update(changes)


def _start_large(later):
    with _large_lock:
        if _large['running']:
            return False
        _large.update(running=True, total=sum(len(link['large']) for link in later), done=0, kept=0, failed=0,
                      received=0, size=0, reason='')
        _large_stop.clear()
    threading.Thread(target=_large_job, args=(later,), name='telegram-large-files', daemon=True).start()
    return True


def _large_job(later):
    import telegram_auth
    try:
        # The refresh that queued these has just let go of the session. If a refresh or a
        # sign-in step took it first, these wait for the next refresh.
        if not _refresh_lock.acquire(timeout=5):
            _large_update(reason='busy')
            return
        try:
            if not telegram_auth._LOCK.acquire(timeout=5):
                _large_update(reason='busy')
                return
            try:
                asyncio.run(download_later(later))
            finally:
                telegram_auth._LOCK.release()
        finally:
            _refresh_lock.release()
    except Exception:  # noqa: BLE001 - a background download never takes the app down; nothing personal is logged
        _large_update(reason='unavailable')
    finally:
        _large_update(running=False, received=0, size=0)


async def download_later(later):
    """Download the sets collect_media put in `later`, each video and audio file streamed to disk."""
    from telethon import TelegramClient
    import archive
    if not config.TELEGRAM_API_ID or not config.TELEGRAM_API_HASH or not Path(config.TELEGRAM_SESSION_FILE).is_file():
        _large_update(reason='unavailable')
        return
    archive.discard_partials(idle=3600)
    # Unlike the refresh, a download of many minutes reconnects after a dropped connection and sits out
    # a short flood wait, rather than starting the file again at the next refresh.
    client = TelegramClient(config.TELEGRAM_SESSION_FILE, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH,
                            connection_retries=3, request_retries=5, timeout=15, raise_last_call_error=True,
                            flood_sleep_threshold=60)
    try:
        async with asyncio.timeout(READ_BUDGET):
            await client.connect()
            if not await client.is_user_authorized():
                _large_update(reason='unavailable')
                return
            # Asked for again by id: a message may have been deleted since the refresh.
            found = await client.get_messages('me', ids=[i for link in later for i in link['ids']])
        by_id = {getattr(message, 'id', None): message for message in found or [] if message is not None}
        for link in later:
            await _keep_later(client, link, by_id)
    finally:
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except Exception:
            pass


async def _keep_later(client, link, by_id):
    """Download one link's files and keep them with those kept before; Settings counts its large files."""
    import archive
    limit, key = archive.video_limit(), archive.copy_key(link['url'])
    carried = _kept_by_message(archive.telegram_media_for_url(link['url']))
    # Files of other messages with this link stay in the set.
    items = [{'kept': item['name']} for mid, item in carried.items() if mid not in link['ids']]
    missing, why, ended, saved = 0, {}, set(), False
    try:
        for message_id in link['ids']:
            if message_id in carried:
                items.append({'kept': carried[message_id]['name']})
                continue
            large = message_id in link['large']
            reason = await _fetch_later(client, by_id.get(message_id), message_id, key, limit, large, items)
            if reason:
                why[message_id] = reason
                if reason in ('stopped', 'rejected') or (large and reason in _HELD):
                    _held[message_id] = reason
                missing += reason != 'rejected'
            if large:
                ended.add(message_id)
                with _large_lock:
                    _large['done'] += 1
        if any('kept' not in item for item in items):
            if storage.url_identity(link['url']) in storage.deleted_identities():
                why.update({message_id: 'gone' for message_id in link['large']})   # deleted while it downloaded
            else:
                archive.save_telegram_media(link['url'], {'text': link['text'], 'date': link['date']}, items,
                                            missing=missing)
                saved = True
    except Exception:  # noqa: BLE001 - one link that fails never stops the others; its new files are not kept
        pass
    finally:
        if not saved:
            for item in items:
                archive.drop_part(item.get('path'))
        with _large_lock:
            for message_id in link['large']:
                _large['done'] += message_id not in ended
                reason = why.get(message_id, '' if saved else 'unavailable')
                _large['failed' if reason else 'kept'] += 1
                if reason:
                    _large['reason'] = reason


async def _fetch_later(client, message, message_id, key, limit, large, items):
    """Download one file of a set into `items`: '' when it arrived, else the reason it didn't."""
    import archive
    if _large_stop.is_set():
        return 'stopped'
    if message_id in _held:
        return _held[message_id]
    found = own_media(message, limit) if message is not None else None
    if found is None:           # deleted from Saved Messages since the refresh, or too big now the switch is off
        return 'gone'
    if found['kind'] == 'photo':
        data = None
        try:
            async with asyncio.timeout(PHOTO_SECONDS):
                data = await client.download_media(message, file=bytes)
        except Exception:  # noqa: BLE001 - one file that cannot be downloaded never stops the others
            pass
        if not isinstance(data, (bytes, bytearray)):
            return 'unavailable'
        if not archive.telegram_file_ok('photo', data):
            return 'rejected'
        items.append({'kind': 'photo', 'data': bytes(data), 'mid': message_id})
        return ''
    path, reason = await _stream_file(client, message, found, key, large)
    if path:
        items.append({'kind': found['kind'], 'path': path, 'duration': found['duration'], 'title': found['title'],
                      'voice': found['voice'], 'mid': message_id})
    return reason


class _TooLarge(Exception):
    pass


def _disk_reason(error):
    return 'no_space' if isinstance(error, OSError) and error.errno == errno.ENOSPC else 'unavailable'


async def _stream_file(client, message, found, key, large):
    """(path, '') for one video or audio file streamed into the archive folder, or (None, reason): 'no_space',
    'slow', 'stopped', 'too_large', 'rejected' (not a file the app keeps) or 'unavailable'. The free space (its
    size plus archive.DISK_MARGIN) is checked before the first byte; no partial file is left behind. `large`: its
    progress shows in Settings."""
    import archive
    declared = found['size']
    try:
        os.makedirs(archive.ARCHIVE_DIR, exist_ok=True)
        if shutil.disk_usage(archive.ARCHIVE_DIR).free < declared + archive.DISK_MARGIN:
            return None, 'no_space'
        handle = tempfile.NamedTemporaryFile(dir=archive.ARCHIVE_DIR, prefix=key + '.', suffix='.part', delete=False)
    except OSError as error:
        return None, _disk_reason(error)
    path, kept, last = handle.name, False, [time.monotonic()]
    if large:
        _large_update(received=0, size=declared)

    def progress(received, total):
        if received > declared:
            raise _TooLarge()             # more than Telegram said, and more than the free space was checked for
        last[0] = time.monotonic()
        if large:
            _large_update(received=received)

    reason, budget, started = 'unavailable', max(archive.LARGE_VIDEO_SECONDS, declared / LARGE_RATE), time.monotonic()
    try:
        with handle:
            task = asyncio.ensure_future(client.download_media(message, file=handle, progress_callback=progress))
            try:
                while not task.done():
                    await asyncio.wait({task}, timeout=0.5)
                    if task.done():
                        break
                    if _large_stop.is_set():
                        reason = 'stopped'
                        break
                    if time.monotonic() - last[0] > LARGE_STALL or time.monotonic() - started > budget:
                        reason = 'slow'
                        break
            finally:
                if not task.done():
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
            if task.cancelled():
                return None, reason
            error = task.exception()
            if error is not None:
                return None, 'too_large' if isinstance(error, _TooLarge) else _disk_reason(error)
            handle.flush()
            if handle.tell() != declared:
                return None, 'unavailable'        # cut short
            handle.seek(0)
            head = handle.read(64)
        if found['kind'] == 'video':
            kept = head[4:8] == b'ftyp'
        else:
            kept = bool(archive.audio_extension(head))
        return (path, '') if kept else (None, 'rejected')
    except OSError as error:                    # writing, flushing or reading back the file
        return None, _disk_reason(error)
    finally:
        if large:
            _large_update(received=0, size=0)
        if not kept:
            try:
                os.unlink(path)
            except OSError:
                pass


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


def refresh_saved_messages(keep_media=False, retry=False):
    """Read Saved Messages (and, with keep_media, the files sent with links). `retry`: the owner pressed Refresh,
    so large downloads that broke off earlier in this app run are tried again."""
    if not _refresh_lock.acquire(blocking=False):
        raise RefreshError('busy', LARGE_BUSY if large_state()['running']
                           else 'A Telegram refresh is already running. Wait for it to finish, then retry.', 409)
    later = []
    try:
        # Sign-in, check and disconnect use the same session file. Sharing their
        # lock means a refresh never races a logout (on Windows the open
        # session database would block its removal) or a login step.
        import telegram_auth
        if not telegram_auth._LOCK.acquire(blocking=False):
            raise RefreshError('busy', 'Telegram sign-in or disconnect is in progress. Wait for it to finish, then retry.', 409)
        try:
            if retry:
                forget_held(_RETRY)
            result = asyncio.run(read_saved_messages(keep_media, later))
        finally:
            telegram_auth._LOCK.release()
    finally:
        _refresh_lock.release()
    # Large videos and audio start once the session is free again; the links are already in the answer.
    if later and not _start_large(later):
        result['media']['waiting'] = 0
    return result
