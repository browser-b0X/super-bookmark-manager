"""
Telegram Saved Messages fetcher using Telethon.
Pulls messages, extracts URLs, detects source platform, stores in SQLite.
"""

import json
import re
from datetime import timezone
from typing import Optional

from telethon.tl.types import MessageMediaWebPage

import config
import storage

# ── URL source detection ───────────────────────────────────────────────────────

SOURCE_PATTERNS = {
    "instagram":  re.compile(r"instagram\.com|instagr\.am", re.I),
    "x.com":      re.compile(r"(twitter\.com|x\.com)", re.I),
    "youtube":    re.compile(r"(youtube\.com|youtu\.be)", re.I),
    "reddit":     re.compile(r"reddit\.com", re.I),
    "tiktok":     re.compile(r"tiktok\.com", re.I),
    "facebook":   re.compile(r"(facebook\.com|fb\.com)", re.I),
    "linkedin":   re.compile(r"linkedin\.com", re.I),
    "pinterest":  re.compile(r"pinterest\.com", re.I),
}

URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)
_SOURCE_DOMAINS = {
    "instagram": ("instagram.com", "instagr.am"), "x.com": ("twitter.com", "x.com"),
    "youtube": ("youtube.com", "youtu.be"), "reddit": ("reddit.com", "redd.it"), "tiktok": ("tiktok.com",),
    "facebook": ("facebook.com", "fb.com"), "linkedin": ("linkedin.com",), "pinterest": ("pinterest.com",),
}


def detect_source(url: Optional[str]) -> str:
    """Match on the hostname itself: netflix.com is not x.com."""
    if not url:
        return "text"
    from urllib.parse import urlsplit
    try:
        host = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return "other"
    for source, domains in _SOURCE_DOMAINS.items():
        if any(host == d or host.endswith("." + d) for d in domains):
            return source
    return "other"


def _trim_url(url: str) -> str:
    """Drop punctuation that ends a sentence or wraps a link: `(see https://a.b/c).`"""
    while url and url[-1] in ".,;:!?'\"":
        url = url[:-1]
    while url.endswith(")") and url.count(")") > url.count("("):
        url = url[:-1]
    while url.endswith("]") and url.count("]") > url.count("["):
        url = url[:-1]
    return url


def extract_first_url(text: Optional[str], entities=None) -> Optional[str]:
    """Prefer Telegram's own link entities; fall back to scanning plain text."""
    for entity in entities or []:
        url = getattr(entity, "url", None)
        if isinstance(url, str) and url.lower().startswith(("http://", "https://")):
            return url
    for entity in entities or []:
        if type(entity).__name__ == "MessageEntityUrl" and text:
            offset, length = getattr(entity, "offset", None), getattr(entity, "length", None)
            if isinstance(offset, int) and isinstance(length, int):
                candidate = text[offset:offset + length]
                if candidate.lower().startswith(("http://", "https://")):
                    return _trim_url(candidate)
    if not text:
        return None
    urls = URL_RE.findall(text)
    return _trim_url(urls[0]) if urls else None


# ── Main fetch ─────────────────────────────────────────────────────────────────

async def fetch_saved_messages():
    """
    Connect to Telegram, read Saved Messages, store new ones in SQLite.
    Returns (new_count, total_fetched).
    """
    from telethon import TelegramClient

    if not config.TELEGRAM_API_ID or not config.TELEGRAM_API_HASH:
        raise RuntimeError(
            "Telegram API credentials not set. "
            "Get them at https://my.telegram.org and set TELEGRAM_API_ID / TELEGRAM_API_HASH "
            "in config.py or as environment variables."
        )

    client = TelegramClient(
        config.TELEGRAM_SESSION_FILE,
        config.TELEGRAM_API_ID,
        config.TELEGRAM_API_HASH,
    )

    await client.start()
    print("[fetcher] Connected to Telegram")

    # "Saved Messages" is a special chat with yourself
    me = await client.get_me()
    saved_msgs = await client.get_messages("me", limit=config.MAX_MESSAGES_PER_RUN or None)

    new_count = 0
    total = len(saved_msgs)

    for msg in saved_msgs:
        if storage.post_exists(msg.id):
            continue

        # msg.message is the plain text the entity offsets refer to; msg.text is
        # Telethon's markdown rendering (`[label](url)`), which corrupts URLs.
        text = msg.message or ""
        url = extract_first_url(text, getattr(msg, "entities", None))
        source = detect_source(url)
        date_utc = msg.date.astimezone(timezone.utc).isoformat() if msg.date else ""

        raw = json.dumps({
            "id": msg.id,
            "text": text[:2000],
            "date": date_utc,
            "has_media": bool(msg.media),
            "media_type": type(msg.media).__name__ if msg.media else None,
        })

        storage.insert_post(
            tg_msg_id=msg.id,
            date_utc=date_utc,
            text=text,
            url=url,
            source=source,
            raw_json=raw,
        )
        new_count += 1

    await client.disconnect()
    print(f"[fetcher] Done: {new_count} new / {total} fetched")
    return new_count, total
