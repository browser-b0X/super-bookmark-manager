"""Explicit, bounded Saved Messages read. No authentication prompt or library writes.

Return the same message shape as Telegram Desktop so the supported importer owns
URL identity, curation reconciliation, categorization and SQLite pending writes.
"""
import asyncio
from datetime import datetime, timezone
from pathlib import Path
import re
import threading

import config

_refresh_lock = threading.Lock()
_SCHEME = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)


class RefreshError(RuntimeError):
    def __init__(self, code, message, status=503):
        super().__init__(message)
        self.code, self.status = code, status


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
        client = TelegramClient(config.TELEGRAM_SESSION_FILE, config.TELEGRAM_API_ID,
                                config.TELEGRAM_API_HASH, connection_retries=0, request_retries=0, timeout=15)
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
            return {'ok': True, 'limit': limit, 'checked': checked, 'malformed': malformed,
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
        return asyncio.run(read_saved_messages())
    finally:
        _refresh_lock.release()
