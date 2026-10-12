"""Public X (Twitter) posts: read X's embed data and lay a post out as a saved copy.

X builds its pages with scripts, so the ordinary page copy of an x.com link is
empty. The embedded-post widget X offers to other websites reads one public
JSON document per post (cdn.syndication.twimg.com/tweet-result) with the text,
author, date, photos and video links. No login and no cookies: deleted,
protected and age-restricted posts simply come back empty.

This module only parses and lays out; archive.py does the fetching through
safe_http, within its limits and timers. Nothing here trusts the JSON: every
value is type-checked, every address must be https on X's own picture/video
hosts, and every piece of text is escaped.
"""

import html as _html
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit

SYNDICATION = "https://cdn.syndication.twimg.com/tweet-result"
DATA_LIMIT = 512 * 1024

_POST_HOSTS = frozenset({"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com",
                         "mobile.twitter.com", "m.twitter.com"})
_POST_PATH = re.compile(r"/(?:[A-Za-z0-9_]{1,15}|i(?:/web)?)/status(?:es)?/([0-9]{1,20})(?:/.*)?")
_MEDIA_HOSTS = frozenset({"pbs.twimg.com", "video.twimg.com"})
_MEDIA_SCHEMES = ("https",)                     # tests point both at their own loopback hosts
_MAX_PHOTOS = 4
_MAX_TEXT = 30000


def post_id(url):
    """The numeric id of an X post link, or None for anything else."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in _POST_HOSTS:
        return None
    match = _POST_PATH.fullmatch(parts.path)
    if not match or int(match.group(1)) == 0:
        return None
    return str(int(match.group(1)))


def _token(identifier):
    """The widget's request token: (id / 1e15 * pi) in base 36, digits only.

    X does not appear to check it, but sending what the widget sends keeps the
    request ordinary. Python's float has no base-36 form, so this follows V8's
    Number.prototype.toString(36) digit by digit.
    """
    import math
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    value = int(identifier) / 1e15 * math.pi
    whole = math.floor(value)
    fraction = value - whole
    delta = max(0.5 * (math.nextafter(value, math.inf) - value), math.nextafter(0.0, 1.0))
    tail = []
    if fraction >= delta:
        while True:
            fraction *= 36
            delta *= 36
            digit = int(fraction)
            tail.append(digit)
            fraction -= digit
            if fraction > 0.5 or (fraction == 0.5 and digit & 1):
                if fraction + delta > 1:
                    # Round up, carrying through trailing 35s.
                    while True:
                        if not tail:
                            whole += 1
                            break
                        last = tail.pop() + 1
                        if last < 36:
                            tail.append(last)
                            break
                    break
            if fraction < delta:
                break
    head = ""
    whole = int(whole)
    while whole:
        whole, rest = divmod(whole, 36)
        head = digits[rest] + head
    text = (head or "0") + ("." + "".join(digits[d] for d in tail) if tail else "")
    return re.sub(r"0+|\.", "", text) or "1"


def data_url(identifier):
    return f"{SYNDICATION}?id={identifier}&lang=en&token={_token(identifier)}"


def media_url(value):
    """`value` if it is an https address on X's media hosts, else ""."""
    if not isinstance(value, str) or len(value) > 2048:
        return ""
    try:
        parts = urlsplit(value)
    except ValueError:
        return ""
    if (parts.scheme not in _MEDIA_SCHEMES or (parts.hostname or "").lower() not in _MEDIA_HOSTS
            or parts.port not in (None, 443, 80)):
        return ""
    return value


def _photo_url(value):
    """A large but not original-size rendition: originals can exceed the picture limit."""
    value = media_url(value)
    if not value or urlsplit(value).query:
        return value
    match = re.fullmatch(r"(.+)\.(jpg|jpeg|png|webp)", value)
    return f"{match.group(1)}?format={match.group(2).replace('jpeg', 'jpg')}&name=large" if match else value


@dataclass
class Video:
    poster: str = ""
    variants: list = field(default_factory=list)   # (bitrate, url), best first
    duration_ms: int = 0
    gif: bool = False


@dataclass
class Post:
    id: str
    text: str = ""
    links: list = field(default_factory=list)       # (t.co address, full address, shown text)
    hide: list = field(default_factory=list)        # t.co addresses of attached media
    name: str = ""
    handle: str = ""
    avatar: str = ""
    created: str = ""                               # ISO 8601, UTC
    photos: list = field(default_factory=list)
    video: Video = None
    quoted: "Post" = None
    site: str = "X"                                 # tiktok_post.py reuses the card for TikTok
    link: str = ""                                  # the post's own address, when not an X post


def _text(value, limit=_MAX_TEXT):
    return value[:limit] if isinstance(value, str) else ""


def _list(value):
    return value if isinstance(value, list) else []


def _unescape(text):
    """X sends post text (and names) HTML-escaped: &amp;, &lt; and &gt; only.
    The layout escapes everything itself, so these would show as "&amp;"."""
    return text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def _dict(value):
    return value if isinstance(value, dict) else {}


def _int(value):
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value if 0 <= value < 2 ** 53 else 0      # a huge "bitrate" must not overflow the size maths
    if isinstance(value, str) and value.isdigit() and len(value) < 16:
        return int(value)
    return 0


def _video(item):
    info = _dict(item.get("video_info"))
    variants = []
    for variant in _list(info.get("variants")):
        variant = _dict(variant)
        address = media_url(variant.get("url"))
        if address and variant.get("content_type") == "video/mp4":
            variants.append((_int(variant.get("bitrate")), address))
    variants.sort(key=lambda pair: pair[0], reverse=True)
    return Video(poster=media_url(item.get("media_url_https")), variants=variants[:6],
                 duration_ms=_int(info.get("duration_millis")), gif=item.get("type") == "animated_gif")


def parse(data, depth=0):
    """A Post from the embed JSON (bytes or dict); None when X returned no post."""
    if isinstance(data, (bytes, bytearray)):
        try:
            data = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            return None
    data = _dict(data)
    identifier = data.get("id_str")
    if data.get("__typename", "Tweet") != "Tweet" or not isinstance(identifier, str) or not identifier.isdigit():
        return None
    post = Post(id=identifier)
    note = _dict(_dict(_dict(data.get("note_tweet")).get("note_tweet_results")).get("result"))
    raw = _text(note.get("text")) or _text(data.get("text"))
    text = _unescape(raw)
    entities = _dict(data.get("entities"))
    span = _list(data.get("display_text_range"))
    if not note.get("text") and len(span) == 2 and all(isinstance(n, int) and not isinstance(n, bool) for n in span) \
            and 0 <= span[0] <= span[1]:
        # Leading "@name" replies and the trailing media address sit outside this range.
        # Its positions count the unescaped text; a link entity tells when they don't.
        basis = text
        for link in _list(entities.get("urls")):
            link = _dict(link)
            where, short = _list(link.get("indices")), _text(link.get("url"), 100)
            if short and len(where) == 2 and all(isinstance(n, int) and not isinstance(n, bool) for n in where):
                if raw[where[0]:where[1]] == short and text[where[0]:where[1]] != short:
                    basis = raw
                break
        text = _unescape(basis[span[0]:span[1]]) if basis is raw else basis[span[0]:span[1]]
    post.text = text
    for link in _list(entities.get("urls")):
        link = _dict(link)
        short, full = _text(link.get("url"), 100), _text(link.get("expanded_url"), 2048)
        if short.startswith("https://t.co/") and full.startswith(("https://", "http://")):
            post.links.append((short, full, _text(link.get("display_url"), 200) or full))
    for media in _list(entities.get("media")):
        short = _text(_dict(media).get("url"), 100)
        if short.startswith("https://t.co/"):
            post.hide.append(short)
    user = _dict(data.get("user"))
    post.name = _unescape(_text(user.get("name"), 200))
    handle = _text(user.get("screen_name"), 50)
    post.handle = handle if re.fullmatch(r"[A-Za-z0-9_]{1,50}", handle) else ""
    post.avatar = media_url(user.get("profile_image_url_https")).replace("_normal.", "_bigger.")
    created = _text(data.get("created_at"), 40)
    try:
        post.created = datetime.fromisoformat(created.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(
            timespec="seconds").replace("+00:00", "Z")
    except (ValueError, OverflowError):        # a date at the edge of the calendar
        post.created = ""
    for item in _list(data.get("mediaDetails")):
        item = _dict(item)
        kind = item.get("type")
        if kind == "photo" and len(post.photos) < _MAX_PHOTOS:
            address = _photo_url(item.get("media_url_https"))
            if address:
                post.photos.append(address)
        elif kind in ("video", "animated_gif") and post.video is None:
            post.video = _video(item)
    if depth == 0 and isinstance(data.get("quoted_tweet"), dict):
        post.quoted = parse(data["quoted_tweet"], depth=1)
    return post


# ── Layout ────────────────────────────────────────────────────────────────────

STYLE = (
    ":root{color-scheme:light dark;--fg:#0f1419;--dim:#536471;--line:#cfd9de;--card:#fff;--page:#f7f9f9;--link:#1d6fb8}"
    "@media (prefers-color-scheme:dark){:root{--fg:#e7e9ea;--dim:#8b98a5;--line:#2f3336;--card:#16181c;"
    "--page:#000;--link:#6cb2ef}}"
    "html{background:var(--page)}body{margin:0;padding:0 0 3rem;color:var(--fg);"
    "font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}"
    ".post{box-sizing:border-box;max-width:36rem;margin:1.5rem auto;padding:1rem 1.1rem;background:var(--card);"
    "border:1px solid var(--line);border-radius:16px}"
    ".post .who{display:flex;align-items:center;gap:.7rem}.post .avatar{width:48px;height:48px;border-radius:50%;"
    "flex:none;background:var(--line);object-fit:cover}.post .name{font-weight:700;line-height:1.25}"
    ".post .handle{color:var(--dim)}.post .text{margin:.75rem 0;white-space:pre-wrap;overflow-wrap:anywhere;"
    "font-size:1.0625rem}.post a{color:var(--link);text-decoration:none}.post a:hover{text-decoration:underline}"
    ".post .media{display:grid;gap:2px;border-radius:14px;overflow:hidden;border:1px solid var(--line);margin:.75rem 0}"
    ".post .media.n2,.post .media.n3,.post .media.n4{grid-template-columns:1fr 1fr}"
    ".post .media.n3 img:first-child{grid-row:span 2}"
    ".post .media img{display:block;width:100%;height:100%;max-height:34rem;object-fit:cover}"
    ".post .media.n1 img{object-fit:contain;height:auto;background:#000}"
    ".post video{display:block;width:100%;max-height:34rem;background:#000}"
    ".post .missing{padding:1.2rem;color:var(--dim);text-align:center}"
    ".post .when{color:var(--dim);font-size:.9rem;margin-top:.5rem}"
    ".post .quoted{margin:.75rem 0 0;padding:.75rem .85rem;border:1px solid var(--line);border-radius:14px}"
    ".post .quoted .avatar{width:24px;height:24px}.post .quoted .text{font-size:.95rem;margin:.4rem 0}"
)

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _when(created):
    try:
        moment = datetime.fromisoformat(created.replace("Z", "+00:00"))
    except (ValueError, OverflowError):
        return ""
    return f"{moment.hour:02d}:{moment.minute:02d} UTC · {moment.day} {_MONTHS[moment.month - 1]} {moment.year}"


def _escape(value):
    return _html.escape(value, quote=True)


def text_html(post):
    """The post's text, escaped, with its short links shown as their real addresses."""
    pieces = {short: (full, shown) for short, full, shown in post.links}
    out, last = [], 0
    # Reddit posts (reddit_post.py) list their outside link as itself.
    others = "".join("|" + re.escape(short) for short in pieces if not short.startswith("https://t.co/"))
    for match in re.finditer(r"https://t\.co/[A-Za-z0-9]{1,40}" + others, post.text):
        out.append(_html.escape(post.text[last:match.start()], quote=False))
        short = match.group(0)
        if short in pieces:
            full, shown = pieces[short]
            out.append(f'<a href="{_escape(full)}" target="_blank" rel="noopener noreferrer">{_escape(shown)}</a>')
        elif short not in post.hide:
            out.append(_html.escape(short, quote=False))
        last = match.end()
    out.append(_html.escape(post.text[last:], quote=False))
    return "".join(out).strip()


def post_link(post):
    return post.link or f"https://x.com/{post.handle or 'i'}/status/{post.id}"


def _who(post, avatar_uri):
    avatar = (f'<img class="avatar" alt="" src="{avatar_uri}">' if avatar_uri
              else '<span class="avatar" aria-hidden="true"></span>')
    handle = f'<div class="handle">@{_escape(post.handle)}</div>' if post.handle else ""
    return (f'<div class="who">{avatar}<div><div class="name">{_escape(post.name or post.handle or post.site + " user")}</div>'
            f"{handle}</div></div>")


def layout(post, *, avatar="", photos=(), video_src="", poster="", missing="", quoted_avatar="", quoted_photos=()):
    """The body of the copy: one post card. Every picture is a data: URI handed in by archive.py."""
    parts = ['<article class="post">', _who(post, avatar)]
    body = text_html(post)
    if body:
        parts.append(f'<div class="text" lang="und">{body}</div>')
    if photos:
        parts.append(f'<div class="media n{len(photos) if len(photos) <= 4 else 4}">'
                     + "".join(f'<img alt="Photo {index + 1}" src="{uri}">' for index, uri in enumerate(photos))
                     + "</div>")
    if video_src:
        attributes = ' loop muted autoplay playsinline' if post.video and post.video.gif else ' controls preload="metadata"'
        poster_attr = f' poster="{poster}"' if poster else ""
        parts.append(f'<div class="media n1"><video{attributes}{poster_attr} src="{_escape(video_src)}"></video></div>')
    elif poster:
        parts.append(f'<div class="media n1"><img alt="Video cover" src="{poster}"></div>')
    if missing:
        parts.append(f'<div class="media n1"><div class="missing">{_escape(missing)}</div></div>')
    if post.quoted:
        quoted = post.quoted
        inner = ['<div class="quoted">', _who(quoted, quoted_avatar)]
        quoted_text = text_html(quoted)
        if quoted_text:
            inner.append(f'<div class="text" lang="und">{quoted_text}</div>')
        if quoted_photos:
            inner.append(f'<div class="media n{len(quoted_photos)}">'
                         + "".join(f'<img alt="" src="{uri}">' for uri in quoted_photos) + "</div>")
        inner.append(f'<div class="when"><a href="{_escape(post_link(quoted))}" target="_blank" '
                     'rel="noopener noreferrer">Quoted post on X</a></div></div>')
        parts.append("".join(inner))
    when = _when(post.created)
    parts.append(f'<div class="when">{when + " · " if when else ""}'
                 f'<a href="{_escape(post_link(post))}" target="_blank" rel="noopener noreferrer">View on {_escape(post.site)}</a></div>')
    parts.append("</article>")
    return "".join(parts)


def title(post):
    first = re.sub(r"\s+", " ", re.sub(r"https://t\.co/\S+", "", post.text)).strip()
    who = post.name or (f"@{post.handle}" if post.handle else f"{post.site} user")
    if len(first) > 80:
        first = first[:79].rstrip() + "…"
    return f"{who} on {post.site}: “{first}”" if first else f"{who} on {post.site}"
