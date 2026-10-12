"""Reddit posts: recognise the links and read Reddit's public RSS feed for one post.

Reddit no longer answers its old `.json` addresses without an API login, and
its post pages are an empty shell until a script runs, so neither a link
preview nor a page copy finds anything there. Every post still has a public
Atom feed (`/comments/<id>/.rss`) with the title, author, subreddit, date, the
post's text, its picture and its link. That is all a preview or a saved copy
needs, without a login or cookies.

Reddit limits how often one address may read its feeds, so requests are spaced
out (wait_turn) and a refusal (HTTP 429) is reported as "try again later".

Nothing here trusts the feed: XML with a DOCTYPE or entities is refused, values
are capped, pictures must be https on Reddit's own picture hosts, and all text
is escaped by the layout (x_post.layout).
"""

import html as _html
import re
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit

import x_post

DATA_LIMIT = 512 * 1024
FEED_BASE = "https://www.reddit.com"            # tests point it at their own loopback host
SPACING = 3.0                                    # seconds between two Reddit requests from this app
_POST_HOSTS = frozenset({"www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com", "m.reddit.com",
                         "np.reddit.com", "sh.reddit.com"})
_SHORT_HOSTS = frozenset({"redd.it"})
_POST_PATH = re.compile(r"(?:/r/([A-Za-z0-9_]{2,21})|/u(?:ser)?/[A-Za-z0-9_-]{2,30})?/comments/([a-z0-9]{3,12})(?:/[^/]*)?/?")
_SHARE_PATH = re.compile(r"/r/([A-Za-z0-9_]{2,21})/s/([A-Za-z0-9]{5,20})/?")
_SHORT_PATH = re.compile(r"/([a-z0-9]{3,12})/?")
_PICTURE_HOSTS = frozenset({"i.redd.it", "preview.redd.it", "external-preview.redd.it",
                            "a.thumbs.redditmedia.com", "b.thumbs.redditmedia.com"})
_PICTURE_SCHEMES = ("https",)                     # tests point both at their own loopback host
_PICTURE_SUFFIXES = (".jpg", ".jpeg", ".png", ".gif", ".webp")
_ATOM = "{http://www.w3.org/2005/Atom}"
_MEDIA = "{http://search.yahoo.com/mrss/}"
_MAX_TEXT = 30000

_turn = threading.Lock()
_last = [0.0]


def wait_turn():
    """Space Reddit requests out, across previews and saved copies."""
    with _turn:
        wait = _last[0] + SPACING - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()


def parse_link(url):
    """("post", subreddit or "", id), ("share", subreddit, code) for a /s/ share link, or None."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    if host in _SHORT_HOSTS:
        match = _SHORT_PATH.fullmatch(parts.path)
        return ("post", "", match.group(1)) if match else None
    if host not in _POST_HOSTS:
        return None
    match = _POST_PATH.fullmatch(parts.path)
    if match:
        return ("post", match.group(1) or "", match.group(2))
    match = _SHARE_PATH.fullmatch(parts.path)
    return ("share", match.group(1), match.group(2)) if match else None


def canonical(subreddit, identifier):
    return f"https://www.reddit.com/r/{subreddit}/comments/{identifier}/" if subreddit \
        else f"https://www.reddit.com/comments/{identifier}/"


def data_url(subreddit, identifier):
    path = f"/r/{subreddit}/comments/{identifier}/" if subreddit else f"/comments/{identifier}/"
    return FEED_BASE + path + ".rss?limit=1"


def picture_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return ""
    value = _html.unescape(value)
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower()
    except ValueError:
        return ""
    if parts.scheme not in _PICTURE_SCHEMES or host not in _PICTURE_HOSTS or parts.port not in (None, 443, 80):
        return ""
    return value


class _Content(HTMLParser):
    """Pull the post's own text (the "md" block), its picture and its [link] out of the feed's HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0          # inside <div class="md">
        self.text = []
        self.links = []         # every href, in order
        self.images = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.depth:
            self.depth += tag == "div"
            if tag in ("p", "br", "li", "blockquote", "pre", "h1", "h2", "h3", "tr"):
                self.text.append("\n")
            if tag == "li":
                self.text.append("• ")
        elif tag == "div" and "md" in (attrs.get("class") or "").split():
            self.depth = 1
        if tag == "a" and isinstance(attrs.get("href"), str):
            self.links.append(attrs["href"])
        if tag == "img" and isinstance(attrs.get("src"), str):
            self.images.append(attrs["src"])

    def handle_endtag(self, tag):
        if self.depth and tag == "div":
            self.depth -= 1
        elif self.depth and tag == "p":
            self.text.append("\n")

    def handle_data(self, data):
        if self.depth:
            self.text.append(data)


def _clean(text, limit=_MAX_TEXT):
    text = re.sub(r"[ \t\r\f\v]+", " ", text or "")
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:limit]


def parse(data, identifier):
    """(Post, details) from the feed, or (None, {}) when Reddit returned no such post.

    details: {"subreddit", "thumbnail", "image", "link", "video", "gallery", "summary"}.
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) > DATA_LIMIT:
        return None, {}
    head = bytes(data[:4096]).lower()
    if b"<!doctype" in head or b"<!entity" in bytes(data).lower():
        return None, {}
    try:
        root = ET.fromstring(bytes(data))
    except ET.ParseError:
        return None, {}
    entry = None
    for candidate in root.findall(f"{_ATOM}entry"):
        if (candidate.findtext(f"{_ATOM}id") or "").strip() == f"t3_{identifier}":
            entry = candidate
            break
    if entry is None:
        return None, {}
    title = _clean(entry.findtext(f"{_ATOM}title") or "", 1000)
    author = (entry.findtext(f"{_ATOM}author/{_ATOM}name") or "").strip()
    author = author[3:] if author.startswith("/u/") else author
    author = author if re.fullmatch(r"[A-Za-z0-9_-]{2,30}", author) else ""
    category = entry.find(f"{_ATOM}category")
    subreddit = (category.get("term") if category is not None else "") or ""
    subreddit = subreddit if re.fullmatch(r"[A-Za-z0-9_]{2,21}", subreddit) else ""
    created = ""
    try:
        stamp = (entry.findtext(f"{_ATOM}published") or "").strip()
        created = datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(
            timespec="seconds").replace("+00:00", "Z") if stamp else ""
    except (ValueError, OverflowError):        # a date at the edge of the calendar
        created = ""
    thumb = entry.find(f"{_MEDIA}thumbnail")
    thumbnail = picture_url(thumb.get("url")) if thumb is not None else ""
    content = _Content()
    try:
        content.feed(entry.findtext(f"{_ATOM}content") or "")
        # close() is deliberately not called (quadratic on some Python builds; see archive.py).
    except (ValueError, AssertionError):
        pass
    text = _clean("".join(content.text))
    image = link = ""
    video = gallery = False
    for href in content.links:
        href = _html.unescape(href)
        try:
            parts = urlsplit(href)
        except ValueError:
            continue
        host = (parts.hostname or "").lower()
        if parts.scheme not in ("http", "https") or host.endswith("reddit.com") and "/user/" in parts.path:
            continue
        if host.endswith("reddit.com") and f"/comments/{identifier}" in parts.path:
            continue
        if host == "i.redd.it" and parts.path.lower().endswith(_PICTURE_SUFFIXES):
            image = picture_url(href)
        elif host == "v.redd.it":
            video = True
        elif host.endswith("reddit.com") and parts.path.startswith("/gallery/"):
            gallery = True
        elif not link and not host.endswith(("reddit.com", "redd.it")):
            link = href[:2048]
    if not thumbnail:
        thumbnail = next((picture_url(src) for src in content.images if picture_url(src)), "")
    post = x_post.Post(id=identifier, site="Reddit", name=f"u/{author}" if author else "",
                       handle="", created=created,
                       link=canonical(subreddit, identifier))
    post.text = title + ("\n\n" + text if text else "") + ("\n\n" + link if link else "")
    if link:
        post.links.append((link, link, link))
    details = {"subreddit": subreddit, "thumbnail": thumbnail, "image": image or thumbnail, "link": link,
               "video": video, "gallery": gallery, "summary": text[:4000], "title": title, "author": author,
               "published": created}
    return post, details


# ── Fallback: Reddit's embed data ─────────────────────────────────────────────
# Reddit has said RSS is "another common surface for scraping" (May 2026). If it
# closes the feeds too, its oEmbed answer (what websites use to embed a post) still
# gives the title, the author and the subreddit: no text, no picture.

def oembed_url(subreddit, identifier):
    from urllib.parse import quote
    return f"{FEED_BASE}/oembed?url=" + quote(canonical(subreddit, identifier), safe="")


def parse_oembed(data, identifier, subreddit=""):
    """(Post, details) from Reddit's oEmbed JSON, or (None, {})."""
    import json
    try:
        value = json.loads(bytes(data).decode("utf-8")) if isinstance(data, (bytes, bytearray)) else data
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None, {}
    if not isinstance(value, dict) or not isinstance(value.get("title"), str) or not value["title"].strip():
        return None, {}
    title = _clean(value["title"], 1000)
    author = value.get("author_name") if isinstance(value.get("author_name"), str) else ""
    author = author if re.fullmatch(r"[A-Za-z0-9_-]{2,30}", author or "") else ""
    found = re.search(r'href="https://www\.reddit\.com/r/([A-Za-z0-9_]{2,21})/', value.get("html") or "") \
        if isinstance(value.get("html"), str) else None
    subreddit = found.group(1) if found else subreddit
    post = x_post.Post(id=identifier, site="Reddit", name=f"u/{author}" if author else "", handle="",
                       link=canonical(subreddit, identifier))
    post.text = title
    details = {"subreddit": subreddit, "thumbnail": "", "image": "", "link": "", "video": False, "gallery": False,
               "summary": "", "title": title, "author": author, "published": "", "partial": True}
    return post, details
