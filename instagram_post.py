"""Instagram posts, saved from the owner's own browser tab.

Instagram shows almost nothing to visitors who aren't signed in, and the app
never holds an Instagram login. So an Instagram copy is made only from what
the bookmark button read on the post the owner had open: caption, author,
date and the post's picture addresses. The browser hands those to the app's
own Add window, which sends them here with the save.

None of it is trusted: every field is type-checked and capped, and only
https picture addresses on Instagram's own picture hosts are ever fetched.
"""

import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

import x_post

MAX_PICTURES = 10
_POST_HOSTS = frozenset({"www.instagram.com", "instagram.com", "m.instagram.com"})
_POST_PATH = re.compile(r"/(?:[A-Za-z0-9._]{1,30}/)?(p|reel|reels|tv)/([A-Za-z0-9_-]{5,64})/?")
_PICTURE_SUFFIXES = (".cdninstagram.com", ".fbcdn.net")
_PICTURE_SCHEMES = ("https",)                     # tests point both at their own loopback host
_FIELDS = {"caption", "author", "handle", "takenAt", "pictures", "video"}


class PostDataError(ValueError):
    pass


def post_code(url):
    """The post's code for an Instagram post or reel link, else None."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or host not in _POST_HOSTS:
        return None
    match = _POST_PATH.fullmatch(parts.path)
    return match.group(2) if match else None


def canonical(code):
    return f"https://www.instagram.com/p/{code}/"


def picture_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return ""
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower()
    except ValueError:
        return ""
    if parts.scheme not in _PICTURE_SCHEMES or not host.endswith(_PICTURE_SUFFIXES) or parts.port not in (None, 443, 80):
        return ""
    return value


def parse(url, data):
    """(Post card, picture addresses, is_video) from what the bookmark button sent. Raises PostDataError."""
    code = post_code(url)
    if not code:
        raise PostDataError("not an Instagram post")
    if not isinstance(data, dict) or not set(data) <= _FIELDS:
        raise PostDataError("unexpected fields")
    text = {name: data.get(name, "") for name in ("caption", "author", "handle", "takenAt")}
    if any(not isinstance(value, str) for value in text.values()):
        raise PostDataError("text fields must be text")
    pictures = data.get("pictures", [])
    video = data.get("video", False)
    if not isinstance(pictures, list) or len(pictures) > 40 or not isinstance(video, bool):
        raise PostDataError("pictures must be a short list")
    kept = []
    for value in pictures:
        address = picture_url(value)
        if address and address not in kept:
            kept.append(address)
    handle = text["handle"].lstrip("@")
    handle = handle if re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle) else ""
    created = ""
    try:
        moment = datetime.fromisoformat(text["takenAt"].strip()[:40].replace("Z", "+00:00"))
        if moment.tzinfo is not None:
            created = moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (ValueError, OverflowError):        # a date at the edge of the calendar
        pass
    post = x_post.Post(id=code, text=text["caption"][:5000].strip(), name=text["author"][:200].strip(), handle=handle,
                       created=created, site="Instagram", link=canonical(code))
    return post, kept[:MAX_PICTURES], video
