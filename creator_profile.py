"""A creator's profile page, read once when the owner clicks "Refresh from the profile page" (v0.4.0 phase 6b):
the name, about line and picture it shows to anyone, for a field-by-field review. One page per click through the
same safe fetcher as link previews (public addresses only, size and time limits, no cookies, no login). The
picture is kept in the app's thumbnail cache, so showing the creator later never contacts the site again.
"""
import hashlib
import os
import re
import tempfile
import time
import unicodedata

import metadata_fetcher
import safe_http


def _visible(text, limit):
    """Text without control or invisible characters (they could make a name show as another), spaces collapsed."""
    kept = "".join(" " if unicodedata.category(ch) == "Cc" else "" if unicodedata.category(ch).startswith("C") else ch for ch in text or "")
    return re.sub(r"\s+", " ", kept).strip()[:limit]


def profile_name(title):
    """"Bakehouse Kit (@bakehouse_kit) / X", "Ana Field (@ana.field) | TikTok", "Ana (@ana) • Instagram photos and
    videos" → the name alone."""
    # Hidden characters go first, so one between the name and "(@" can't keep the decorations on.
    name = re.split(r"\s+\(@|\s+[|•]\s+|\s+/\s+(?:X|Twitter)\b|\s+on\s+(?:X|Twitter|Instagram|TikTok)\b", _visible(title, 500), maxsplit=1)[0]
    return name.strip()[:200]


def _keep_picture(image_url):
    """The picture's bytes in the thumbnail cache (checked to be an image), as /thumb/<code>; '' when it can't be.
    The code comes from the bytes: a new picture gets a new name, so one the owner chose to keep never changes."""
    if image_url.startswith("/thumb/"):
        return image_url
    temporary = None
    try:
        response = safe_http.get(image_url, deadline=time.monotonic() + safe_http.TOTAL_TIMEOUT, limit=safe_http.IMAGE_LIMIT)
        if not metadata_fetcher._valid_image(response.body, response.headers.get("content-type", "")):
            return ""
        code = "cp" + hashlib.sha256(response.body).hexdigest()[:30]
        os.makedirs(metadata_fetcher.THUMB_CACHE_DIR, exist_ok=True)
        if os.path.islink(metadata_fetcher.THUMB_CACHE_DIR):
            return ""
        with tempfile.NamedTemporaryFile(dir=metadata_fetcher.THUMB_CACHE_DIR, prefix=code + ".", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(response.body)
        os.replace(temporary, os.path.join(metadata_fetcher.THUMB_CACHE_DIR, code))
        temporary = None
        return f"/thumb/{code}"
    except (safe_http.SafeHTTPError, OSError):
        return ""
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def read(url):
    """What the profile page shows: {"ok": True, "name", "about", "picture"}, or {"ok": False, "error"}."""
    if not isinstance(url, str) or len(url) > 500 or not re.match(r"https?://", url):
        return {"ok": False, "error": "invalid_url"}
    meta = metadata_fetcher.fetch_metadata(url)
    if meta.get("status") in ("failed", "empty"):
        return {"ok": False, "error": meta.get("error") or "empty"}
    thumbnail = meta.get("thumbnail") or ""
    return {"ok": True, "name": profile_name(meta.get("title", "")), "about": _visible(meta.get("summary", ""), 1000),
            "picture": _keep_picture(thumbnail) if thumbnail else ""}
