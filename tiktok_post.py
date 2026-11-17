"""TikTok posts: recognise the links and read TikTok's public embed (oEmbed) data.

TikTok publishes an oEmbed endpoint for websites that embed its videos. It
answered, without a login, with the caption, the author and a cover picture.
In November 2026 it answered with its player alone: then the cover, and the
caption when the page has it, come from the post's page, read as link previews
read it (archive.py). On 2026-11-04 that page had the cover but no caption: the
caption then comes with the video, from the details the optional helper writes
(video_helper.py). Photo slideshows keep caption and cover.

Nothing here trusts the answer: values are type-checked, the cover must come
from TikTok's picture hosts over https, and all text is escaped by the layout.
"""

import json
import re
from urllib.parse import quote, urlsplit

import x_post

OEMBED = "https://www.tiktok.com/oembed?url="
PAGES = "https://www.tiktok.com"                  # tests point it at their own loopback host
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


def page_url(link):
    """The post's own page, for its preview tags."""
    return PAGES + urlsplit(link).path


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


def _answer(data):
    if isinstance(data, (bytes, bytearray)):
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            return None
    return data


def confirms(data, identifier):
    """Whether an oEmbed answer without caption, author or cover is still TikTok's player for this post, as TikTok
    answered for a public post in November 2026."""
    data = _answer(data)
    if not isinstance(data, dict):
        return False
    product = data.get("embed_product_id")
    if product is not None:
        return str(product) == identifier
    return data.get("type") == "video" and isinstance(data.get("html"), str) and bool(data["html"].strip())


def _base36(number):
    digits, text = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while number:
        number, rest = divmod(number, 36)
        text = digits[rest] + text
    return text or "0"


def _names(address, identifier):
    """Whether an address is this post's: its number, or the number in base 36 after a letter, as TikTok's page for
    link previews names it (".../video/e1f1jf4uutrchx" for 6718335390845095173, November 2026)."""
    try:
        path = urlsplit(address).path if isinstance(address, str) else ""
    except ValueError:
        return False
    return re.search(rf"/(?:{re.escape(identifier)}|[a-z]?{_base36(int(identifier))})(?:/|$)", path, re.IGNORECASE) is not None


def page_details(tags, identifier):
    """Caption and cover address from the post page's preview tags (metadata_fetcher._crawler_page), or ("", "")
    unless the page is this post's: TikTok can answer with its home page's tags instead."""
    if not tags or not _names(tags.get("final"), identifier) or (tags.get("address") and not _names(tags["address"], identifier)):
        return "", ""
    text = tags.get("summary") if isinstance(tags.get("summary"), str) else ""
    return text.strip()[:5000], picture_url(tags.get("image"))


def parse(data, link, identifier):
    """A post card (x_post.Post) from the oEmbed answer, plus the cover address; (None, "") when there is no post."""
    data = _answer(data)
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
