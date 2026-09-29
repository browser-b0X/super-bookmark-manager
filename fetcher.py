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


def detect_source(url: Optional[str]) -> str:
    if not url:
        return "text"
    for source, pattern in SOURCE_PATTERNS.items():
        if pattern.search(url):
            return source
    return "other"


def extract_first_url(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    urls = URL_RE.findall(text)
    return urls[0] if urls else None


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

        text = msg.text or msg.message or ""
        url = extract_first_url(text)
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
