"""TikTok posts: recognise the links and read TikTok's public embed (oEmbed) data.

TikTok publishes an oEmbed endpoint for websites that embed its videos. It
answers, without a login, with the caption, the author and a cover picture.
That is what every saved TikTok post gets. The video itself needs the
optional helper (video_helper.py); photo slideshows keep caption and cover.

Nothing here trusts the answer: values are type-checked, the cover must come
from TikTok's picture hosts over https, and all text is escaped by the layout.
"""

import json
import re
from urllib.parse import quote, urlsplit

import x_post

OEMBED = "https://www.tiktok.com/oembed?url="
DATA_LIMIT = 256 * 1024

_POST_HOSTS = frozenset({"www.tiktok.com", "tiktok.com", "m.tiktok.com"})
_SHORT_HOSTS = frozenset({"vm.tiktok.com", "vt.tiktok.com"})
_POST_PATH = re.compile(r"/@([A-Za-z0-9._]{1,40})/(video|photo)/([0-9]{6,25})/?")
_SHORT_PATH = re.compile(r"/(?:t/)?([A-Za-z0-9]{5,20})/?")
_PICTURE_SUFFIXES = (".tiktokcdn.com", ".tiktokcdn-us.com", ".tiktokcdn-eu.com")
_PICTURE_SCHEMES = ("https",)                     # tests point both at their own loopback host


def parse_link(url):
    """("video" | "photo", handle, id) for a full post link, ("short", "", code) for a share link, else None."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    if host in _POST_HOSTS:
        match = _POST_PATH.fullmatch(parts.path)
        if match:
            return match.group(2), match.group(1), match.group(3)
        short = re.fullmatch(r"/t/([A-Za-z0-9]{5,20})/?", parts.path)
        return ("short", "", short.group(1)) if short else None
    if host in _SHORT_HOSTS:
        match = _SHORT_PATH.fullmatch(parts.path)
        return ("short", "", match.group(1)) if match else None
    return None


def canonical(handle, kind, identifier):
    return f"https://www.tiktok.com/@{handle}/{kind}/{identifier}"


def data_url(link):
    return OEMBED + quote(link, safe="")


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


def parse(data, link, identifier):
    """A post card (x_post.Post) from the oEmbed answer, plus the cover address; (None, "") when there is no post."""
    if isinstance(data, (bytes, bytearray)):
        try:
            data = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            return None, ""
    if not isinstance(data, dict) or not any(isinstance(data.get(name), str) and data.get(name)
                                             for name in ("title", "author_name", "thumbnail_url")):
        return None, ""
    text = data.get("title") if isinstance(data.get("title"), str) else ""
    name = data.get("author_name") if isinstance(data.get("author_name"), str) else ""
    handle = ""
    author_url = data.get("author_url") if isinstance(data.get("author_url"), str) else ""
    match = re.fullmatch(r"https://www\.tiktok\.com/@([A-Za-z0-9._]{1,40})/?", author_url[:200])
    if match:
        handle = match.group(1)
    post = x_post.Post(id=identifier, text=text[:5000], name=name[:200], handle=handle, site="TikTok", link=link)
    return post, picture_url(data.get("thumbnail_url"))
