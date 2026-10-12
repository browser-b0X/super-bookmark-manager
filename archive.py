"""Save a copy: one self-contained, script-free HTML file per saved link.

The page is fetched through the safe_http boundary (public addresses only, no
cookies), then rebuilt from an allowlist of tags and attributes with its
stylesheets and images inlined. A stored copy cannot run code or load anything:
scripts, frames, forms and event handlers are never written out, the file
carries its own restrictive Content-Security-Policy, and the viewer route adds
a sandbox on top.

Nothing here touches SQLite. Copies live as files in ARCHIVE_DIR, named by a
hash of the link's library identity, each with a small JSON record beside it.
"""
import base64
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import html as _html
from html.parser import HTMLParser
import json
import os
import queue
import re
import tempfile
import threading
import time
from urllib.parse import urljoin, urlsplit

import safe_http
import instagram_post
import reddit_post
import tiktok_post
import video_helper
import x_post
from storage import url_identity

# Packaged builds point this at <data folder>/archive; source launches keep
# copies beside the code, like the thumbnail cache.
ARCHIVE_DIR = os.environ.get("SBM_ARCHIVE_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "archive_store")

# SBM_SAVED_COPIES=off turns the feature off for this run: nothing is fetched
# and the app hides its controls. Meant for test runs and offline demos; the
# owner's everyday switch is the auto-save setting.
ENABLED = os.environ.get("SBM_SAVED_COPIES", "on").strip().lower() not in ("off", "0", "false", "no")

PAGE_LIMIT = 3 * 1024 * 1024          # HTML of the page itself (this path only)
CSS_LIMIT = 1024 * 1024               # one stylesheet
CSS_TOTAL_LIMIT = 5 * 1024 * 1024     # all stylesheets and <style> blocks together (GitHub needs ~2.6 MB)
MAX_STYLESHEETS = 40                  # GitHub links 27
MAX_IMAGES = 40
IMAGE_LIMIT = safe_http.IMAGE_LIMIT   # 4 MB per picture
SVG_LIMIT = 512 * 1024
FILE_LIMIT = 15 * 1024 * 1024         # the finished copy
TOTAL_BUDGET = 45.0                   # seconds for one copy, everything included
PAGE_TIMEOUT = 12.0
PARSE_TIMEOUT = 10.0
PARSE_CHUNK = 512 * 1024
MAX_PARTS = 400000                    # tags and text runs; far beyond any real document
RESOURCE_TIMEOUT = 6.0
FORMAT_VERSION = 1
X_BUDGET = 120.0                      # an X post with a video
VIDEO_LIMIT = 50 * 1024 * 1024        # one post's video; bigger ones keep their cover picture
X_SPACING = 2.0                       # seconds between two posts fetched from X (and from TikTok)
HELPER_TIMEOUT = 150.0                # the video helper fetching one TikTok video

# What a copy may do when opened as a file. The viewer route adds `sandbox`.
FILE_CSP = ("default-src 'none'; img-src data:; media-src 'self'; style-src 'unsafe-inline'; form-action 'none'; "
            "base-uri 'none'")

ERROR_CODES = safe_http.ERROR_CODES | {"not_html", "not_zip", "disabled", "post_unavailable", "needs_browser",
                                       "invalid_post", "video_unavailable"}
_KEY_RE = re.compile(r"[0-9a-f]{32}")

_PAGE_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; SuperBookmarkManager/0.3; +saved copy)",
                 "Accept": "text/html,application/xhtml+xml"}
_CSS_HEADERS = {"User-Agent": _PAGE_HEADERS["User-Agent"], "Accept": "text/css,*/*;q=0.1"}
_JSON_HEADERS = {"User-Agent": _PAGE_HEADERS["User-Agent"], "Accept": "application/json"}
_VIDEO_HEADERS = {"User-Agent": _PAGE_HEADERS["User-Agent"], "Accept": "video/mp4,video/*;q=0.8"}
_IMAGE_HEADERS = {"User-Agent": _PAGE_HEADERS["User-Agent"],
                  "Accept": "image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8,image/*;q=0.5"}


class ArchiveError(Exception):
    """A copy could not be made. `code` is a fixed word, never site text."""

    def __init__(self, code):
        self.code = code if code in ERROR_CODES else "internal_error"
        super().__init__(self.code)


def copy_key(url: str) -> str:
    """File name of a link's copy: the same identity every library match uses."""
    return hashlib.sha256(url_identity(url).encode("utf-8", "surrogatepass")).hexdigest()[:32]


def valid_key(key) -> bool:
    return isinstance(key, str) and _KEY_RE.fullmatch(key) is not None


# ── Cleaning ──────────────────────────────────────────────────────────────────

# Written out with their allowed attributes. Anything not listed here (custom
# elements, <form>, <noscript>, <picture>...) is unwrapped: its text and
# children stay, the tag itself goes.
_KEEP = frozenset("""
a abbr address article aside b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl
dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark nav ol p pre q rp rt
ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr
""".split())
_VOID = frozenset({"br", "hr", "img", "wbr", "col"})
# Removed together with everything inside them.
_DROP = frozenset({"script", "style", "iframe", "frameset", "noframes", "noembed", "object", "applet", "template",
                   "svg", "math", "canvas", "audio", "video", "select", "textarea", "button", "datalist", "dialog",
                   "title", "map"})
# A <button> or <select> may only hold phrasing content. If one of these opens
# while such a tag is being dropped it was never closed: stop dropping, so an
# unclosed button cannot swallow the rest of the page.
_BLOCK = frozenset({"address", "article", "aside", "blockquote", "div", "dl", "figure", "footer", "h1", "h2", "h3", "h4",
                    "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"})
_PHRASING_ONLY = frozenset({"button", "select", "title", "textarea", "datalist", "map"})

_GLOBAL_ATTRS = frozenset({"class", "id", "title", "lang", "dir", "hidden", "role", "align"})
_TAG_ATTRS = {
    "a": {"name"}, "img": {"alt", "width", "height"},
    "td": {"colspan", "rowspan", "headers", "valign", "width", "height"},
    "th": {"colspan", "rowspan", "headers", "scope", "valign", "width", "height"},
    "table": {"border", "cellpadding", "cellspacing", "width", "summary"},
    "col": {"span", "width"}, "colgroup": {"span", "width"},
    "ol": {"start", "type", "reversed"}, "li": {"value"}, "time": {"datetime"}, "details": {"open"},
    "font": {"color", "size", "face"},
}
_LAZY_SRC = ("data-src", "data-original", "data-lazy-src", "data-lazy", "data-url")
_MAX_DEPTH = 256
# End tags HTML lets a page leave out (</li>, </p>, </tr>, </td>...): a new item
# closes the open one, as browsers do, or every item would nest one level deeper
# until _MAX_DEPTH and the rest of a long list or table lost its structure.
# tag -> (open tags it closes, tags that fence the search)
_IMPLIED_END = {
    "li": ({"li"}, {"ul", "ol"}),
    "dt": ({"dt", "dd"}, {"dl"}), "dd": ({"dt", "dd"}, {"dl"}),
    "tr": ({"tr"}, {"table", "tbody", "thead", "tfoot"}),
    "td": ({"td", "th"}, {"tr", "table"}), "th": ({"td", "th"}, {"tr", "table"}),
    "tbody": ({"tbody", "thead", "tfoot"}, {"table"}), "thead": ({"tbody", "thead", "tfoot"}, {"table"}),
    "tfoot": ({"tbody", "thead", "tfoot"}, {"table"}),
}
# Block starts that close an open <p> (not across a table cell).
_CLOSES_P = frozenset("""address article aside blockquote details div dl dd dt figcaption figure footer h1 h2 h3 h4 h5 h6
header hgroup hr li main nav ol p pre section table ul""".split())
_P_FENCE = frozenset({"table", "td", "th", "caption"})
_WORD = re.compile(r"[^\W_]+", re.UNICODE)

_CSS_DATA_IMAGE = re.compile(r"data:image/(?:png|gif|jpe?g|webp|avif|svg\+xml|x-icon)[;,]", re.I)
# Old IE/Firefox script hooks. The match must be the whole word ("scroll-behavior"
# is ordinary CSS) and the replacement must not add a bracket: an unbalanced "("
# makes the browser drop every rule after it.
_CSS_LEGACY = re.compile(r"(?<![\w-])(?:expression(?=\s*\()|javascript(?=\s*:)|vbscript(?=\s*:)|-moz-binding|behavior(?=\s*:))", re.I)
_CSS_SPACE = " \t\r\n\f"
# A mask whose picture is dropped must hide its element, not show it as a solid
# box (icons drawn as a coloured square through a mask): use a 1x1 clear GIF.
_CLEAR_MASK = 'url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")'


def _css_string_end(css, index):
    """Index just past the string that opens at css[index], honouring backslash escapes; -1 if unterminated."""
    quote, i, n = css[index], index + 1, len(css)
    while i < n:
        c = css[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        if c in "\n\r\f":
            return -1                  # a CSS string ends at any line break (\r and \f count too)
        i += 1
    return -1


_CSS_ESCAPE = re.compile(r"\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))")


def _css_unescape_letters(css):
    """Spell escaped ASCII letters outside strings plainly (`\\75 rl(` is `url(`,
    `@\\69mport` is `@import`) so the scrubber sees what the browser sees. Other
    escapes stay: `.md\\:flex` or `.\\32xl` are real class names."""
    if "\\" not in css:
        return css
    out, pos, i, n = [], 0, 0, len(css)
    while i < n:
        c = css[i]
        if c in "\"'":
            end = _css_string_end(css, i)
            if end < 0:
                break
            i = end
            continue
        if c == "\\":
            match = _CSS_ESCAPE.match(css, i)
            if match:
                code = int(match.group(1), 16) if match.group(1) else ord(match.group(2))
                if code < 128 and chr(code).isalpha():
                    out.append(css[pos:i])
                    out.append(chr(code))
                    i = pos = match.end()
                    continue
                i = match.end()
                continue
        i += 1
    out.append(css[pos:])
    return "".join(out)


def _css_function_end(css, index):
    """Index just past the ")" closing the function whose "(" is at css[index]; -1 if unclosed."""
    depth, i, n = 0, index, len(css)
    while i < n:
        c = css[i]
        if c in "\"'":
            end = _css_string_end(css, i)
            if end < 0:
                return -1
            i = end
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _css_scrub(css):
    """Drop comments and every url(...) except small inline pictures, in one pass.

    Strings are skipped whole, escapes included, so a quote or "/*" inside a
    string (Wikipedia's inline SVG icons: url("data:...fill=\\"%23000\\"...")) can
    neither end a url early nor start a comment. Linear: hostile input cannot
    make it slow. An unterminated string or comment drops the rest.
    """
    out, pos, i, n = [], 0, 0, len(css)
    lowered = css.lower()
    declaration = 0                    # where the current property name starts
    while i < n:
        c = css[i]
        if c in ";{}":
            declaration = i + 1
        elif c in "\"'":
            end = _css_string_end(css, i)
            if end < 0:
                out.append(css[pos:i])
                return "".join(out)
            i = end
            continue
        if c == "/" and css.startswith("/*", i):
            out.append(css[pos:i])
            close = css.find("*/", i + 2)
            if close < 0:
                return "".join(out)
            # An empty comment in its place keeps tokens apart: removing it would
            # turn `u/**/rl(` (not a link to a browser) into `url(`.
            out.append("/**/")
            i = pos = close + 2
            continue
        if c == "@" and (lowered.startswith("@import", i) or lowered.startswith("@charset", i)):
            # Outside strings only: `content: "@import"` is text, not a rule.
            out.append(css[pos:i])
            j = i + 1
            while j < n and css[j] not in ";{}":
                if css[j] in "\"'":
                    j = _css_string_end(css, j)
                    if j < 0:
                        return "".join(out)
                    continue
                j += 1
            i = pos = j + 1 if j < n and css[j] == ";" else j
            continue
        if c in "iI-" and (lowered.startswith("image-set(", i) or lowered.startswith("-webkit-image-set(", i)) \
                and (i == 0 or not (css[i - 1].isalnum() or css[i - 1] in "-_")):
            # Its strings are addresses: image-set("https://..." 1x) loads like url().
            out.append(css[pos:i])
            end = _css_function_end(css, css.index("(", i))
            if end < 0:
                return "".join(out)
            out.append("none")
            i = pos = end
            continue
        if c in "uU" and lowered.startswith("url(", i) and (i == 0 or not (css[i - 1].isalnum() or css[i - 1] in "-_")):
            out.append(css[pos:i])
            j = i + 4
            while j < n and css[j] in _CSS_SPACE:
                j += 1
            if j < n and css[j] in "\"'":
                close = _css_string_end(css, j)
                if close < 0:
                    return "".join(out)
                value = css[j + 1:close - 1]
                end = css.find(")", close)
            else:
                end = css.find(")", j)
                value = css[j:end].strip() if end >= 0 else ""
            if end < 0:
                return "".join(out)
            keep = _CSS_DATA_IMAGE.match(value) and len(value) <= 262144
            if keep:
                out.append(css[i:end + 1])
            else:
                property_name = lowered[max(declaration, i - 200):i]
                out.append(_CLEAR_MASK if "mask" in property_name else "none")
            i = pos = end + 1
            continue
        i += 1
    out.append(css[pos:])
    return "".join(out)


def clean_css(css: str) -> str:
    """Stylesheet text that loads nothing and cannot close its <style> element.

    Tidying only: the copy's Content-Security-Policy is what actually stops a
    stylesheet from fetching anything.
    """
    css = _css_scrub(_css_unescape_letters(css.replace("\x00", "")))
    css = _CSS_LEGACY.sub("x-removed", css)
    return css.replace("<", "\\3c ")


def _attr(name, value):
    return f' {name}="{_html.escape(value, quote=True)}"'


def _http_url(value, base):
    """Absolute http(s) form of a link or resource reference, or ''."""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value or len(value) > 4096 or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        return ""
    try:
        joined = urljoin(base, value.replace(" ", "%20"))
        return joined if urlsplit(joined).scheme in ("http", "https") else ""
    except ValueError:
        return ""


class _Image:
    """Placeholder for a picture, resolved after the whole page is parsed."""

    def __init__(self, url, data_uri, attributes, alt):
        self.url, self.data_uri, self.attributes, self.alt = url, data_uri, attributes, alt


class _Sheet:
    def __init__(self, url="", css="", media=""):
        self.url, self.css, self.media = url, css, media


class _Cleaner(HTMLParser):
    """Rebuild a page from the allowlist; never pass source markup through."""

    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.base_seen = False
        self.out = []            # str | _Image
        self.sheets = []         # _Sheet, in document order
        self.open = []
        self.dropping = ""
        self.drop_depth = 0
        self.title = None
        self._title_parts = None
        self._style_parts = None
        self._style_media = ""
        self.html_attrs = ""
        self.body_attrs = ""
        self.words = 0
        self.last_image = ""

    # -- helpers --
    def _attributes(self, tag, attrs):
        allowed = _TAG_ATTRS.get(tag, ())
        parts, seen = [], set()
        for name, value in attrs:
            name = name.lower()
            if name in seen:
                continue
            value = "" if value is None else value
            if name in _GLOBAL_ATTRS or name in allowed or (name.startswith("aria-") and re.fullmatch(r"aria-[a-z]+", name)):
                seen.add(name)
                parts.append(_attr(name, value[:2000]))
            elif name == "style" and value.strip():
                seen.add(name)
                parts.append(_attr("style", clean_css(value[:8000])))
        return "".join(parts)

    def _image(self, attrs):
        values = {k.lower(): (v or "") for k, v in attrs}
        source = values.get("src", "").strip()
        data_uri = ""
        if source[:5].lower() == "data:":
            data_uri, source = source, ""
        # Lazy-loading pages keep the real address in another attribute.
        lazy = next((values[name].strip() for name in _LAZY_SRC if values.get(name, "").strip()), "")
        srcset = values.get("srcset") or values.get("data-srcset") or ""
        first = srcset.split(",")[0].strip().split(" ")[0] if srcset.strip() else ""
        url = _http_url(lazy, self.base) or _http_url(source, self.base) or _http_url(first, self.base)
        if url:
            data_uri = ""
        if not url and not data_uri:
            return
        # A lazy image followed by its <noscript> twin is one picture, not two.
        if url and url == self.last_image:
            return
        self.last_image = url
        self.out.append(_Image(url, data_uri, self._attributes("img", attrs), values.get("alt", "")))

    def _close_to(self, index):
        while len(self.open) > index:
            self.out.append(f"</{self.open.pop()}>")

    def _close_implied(self, tag):
        rule = _IMPLIED_END.get(tag)
        if rule:
            targets, fence = rule
            for index in range(len(self.open) - 1, -1, -1):
                if self.open[index] in targets:
                    self._close_to(index)
                    break
                if self.open[index] in fence:
                    break
        if tag in _CLOSES_P:
            for index in range(len(self.open) - 1, -1, -1):
                if self.open[index] == "p":
                    self._close_to(index)
                    break
                if self.open[index] in _P_FENCE:
                    break

    # -- parser events --
    def handle_starttag(self, tag, attrs):
        if self.dropping:
            if tag == self.dropping:
                self.drop_depth += 1
                return
            if not (self.dropping in _PHRASING_ONLY and tag in _BLOCK):
                return
            self._stop_dropping()
        if tag in _DROP:
            self.dropping, self.drop_depth = tag, 1
            if tag == "title" and self.title is None:
                self._title_parts = []
            elif tag == "style":
                self._style_parts = []
                media = next((v for k, v in attrs if k.lower() == "media" and v), "")
                self._style_media = media
            return
        if tag == "link":
            values = {k.lower(): (v or "") for k, v in attrs}
            rel = {token.lower() for token in values.get("rel", "").split()}
            media = values.get("media", "").strip()
            if "stylesheet" in rel and "alternate" not in rel and media.lower() != "print":
                url = _http_url(values.get("href", ""), self.base)
                if url:
                    self.sheets.append(_Sheet(url=url, media=media))
            return
        if tag == "base":
            if not self.base_seen:
                self.base_seen = True
                self.base = _http_url(next((v for k, v in attrs if k.lower() == "href"), "") or "", self.base) or self.base
            return
        if tag == "html":
            self.html_attrs = self.html_attrs or self._attributes(tag, attrs)
            return
        if tag == "body":
            self.body_attrs = self.body_attrs or self._attributes(tag, attrs)
            return
        if tag == "img":
            self._image(attrs)
            return
        if tag not in _KEEP:
            return
        self.last_image = ""                  # only a picture's immediate <noscript> twin is a duplicate
        self._close_implied(tag)
        rendered = self._attributes(tag, attrs)
        if tag == "a":
            href = next((v for k, v in attrs if k.lower() == "href"), None)
            if isinstance(href, str) and href.strip().startswith("#") and len(href) < 500:
                rendered += _attr("href", href.strip())
            else:
                link = _http_url(href, self.base)
                if link:
                    # A copy never navigates its own frame; links open the live site.
                    rendered += _attr("href", link) + ' target="_blank" rel="noopener noreferrer nofollow"'
        if tag in _VOID:
            self.out.append(f"<{tag}{rendered}>")
            return
        if len(self.open) >= _MAX_DEPTH:
            return
        self.open.append(tag)
        self.out.append(f"<{tag}{rendered}>")

    def _stop_dropping(self):
        if self.dropping == "title" and self._title_parts is not None:
            self.title = " ".join("".join(self._title_parts).split())[:300]
            self._title_parts = None
        if self.dropping == "style" and self._style_parts is not None:
            css = "".join(self._style_parts)
            if css.strip():
                self.sheets.append(_Sheet(css=css, media=self._style_media))
            self._style_parts = None
        self.dropping, self.drop_depth = "", 0

    def handle_endtag(self, tag):
        if self.dropping:
            if tag == self.dropping:
                self.drop_depth -= 1
                if self.drop_depth <= 0:
                    self._stop_dropping()
            return
        if tag in self.open:
            while self.open:
                top = self.open.pop()
                self.out.append(f"</{top}>")
                if top == tag:
                    break

    def handle_data(self, data):
        if self.dropping:
            if self._title_parts is not None and self.dropping == "title":
                self._title_parts.append(data)
            elif self._style_parts is not None and self.dropping == "style":
                self._style_parts.append(data)
            return
        self.words += len(_WORD.findall(data))
        if data.strip():
            self.last_image = ""              # the same picture again after some text is shown again
        self.out.append(_html.escape(data, quote=False))

    def finish(self):
        # Deliberately not HTMLParser.close(): on Python builds before the 2025
        # parser fixes it re-scans an unterminated tag or comment quadratically
        # (60 KB of "<a " took 43 s). A trailing newline flushes ordinary text;
        # an unfinished construct at the very end of a page is simply dropped.
        try:
            self.feed("\n")
        except (AssertionError, ValueError):
            pass
        if self.dropping:
            self._stop_dropping()
        while self.open:
            self.out.append(f"</{self.open.pop()}>")


# ── Resources ─────────────────────────────────────────────────────────────────

def _sniff(data, content_type=""):
    """Image type from the bytes themselves; SVG also needs the server's label."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "image/avif"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    if content_type.split(";", 1)[0].strip().lower() == "image/svg+xml" and len(data) <= SVG_LIMIT:
        head = data[:1024].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
        if head.startswith((b"<svg", b"<?xml", b"<!doctype svg", b"<!--")) and b"<svg" in data[:4096].lower():
            return "image/svg+xml"
    return ""


def _fetch(url, deadline, limit, headers, timeout):
    """One bounded request; a momentarily full DNS queue gets a single retry."""
    for attempt in (0, 1):
        try:
            return safe_http.get(url, deadline=min(deadline, time.monotonic() + timeout), limit=limit, headers=headers)
        except safe_http.SafeHTTPError as exc:
            if exc.code != "busy" or attempt or deadline - time.monotonic() < 1:
                raise
            time.sleep(0.3)
    raise safe_http.SafeHTTPError("internal_error")


def _decode(body, content_type):
    from metadata_fetcher import _decode_html
    return _decode_html(body, content_type)


def _data_uri(kind, data):
    return f"data:{kind};base64," + base64.b64encode(data).decode("ascii")


def _embedded_image(data_uri):
    """Keep a picture the page already carried inline, if it really is one."""
    match = re.match(r"data:(image/[a-z0-9.+-]+);base64,", data_uri[:64], re.I)
    if not match or len(data_uri) > IMAGE_LIMIT * 4 // 3 + 64:
        return ""
    try:
        data = base64.b64decode(data_uri[match.end():], validate=False)
    except (ValueError, TypeError):
        return ""
    kind = _sniff(data, match.group(1))
    return _data_uri(kind, data) if kind else ""


_BANNER_BOX = ("all:initial;display:block;box-sizing:border-box;width:100%;margin:0 0 12px;padding:10px 16px;"
               "background:#14161f;color:#e8e9f0;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;"
               "border-bottom:2px solid #7c6cff;")
_BANNER_LINE = "all:initial;display:block;color:#e8e9f0;font:inherit;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.5;"
_BANNER_LINK = "all:initial;color:#b3a9ff;font:inherit;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;text-decoration:underline;cursor:pointer;word-break:break-all;"


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _banner(url, title, saved_at, notes):
    day = f"{saved_at.day} {_MONTHS[saved_at.month - 1]} {saved_at.year}"
    lines = [
        f'<div style="{_BANNER_LINE}font-weight:600;">Saved copy of “{_html.escape(title or url, quote=False)}”</div>',
        f'<div style="{_BANNER_LINE}">Saved on {day} from '
        f'<a style="{_BANNER_LINK}" href="{_html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">'
        f'{_html.escape(url, quote=False)}</a></div>',
    ]
    for note in notes:
        lines.append(f'<div style="{_BANNER_LINE}color:#ffcf8a;">{_html.escape(note, quote=False)}</div>')
    return f'<div style="{_BANNER_BOX}" data-sbm-saved-copy="{FORMAT_VERSION}">' + "".join(lines) + "</div>"


def _plural(count, one, many):
    return f"{count} {one if count == 1 else many}"


def build_copy(url: str, *, deadline=None, now=None):
    """Fetch and rebuild one page. Returns (html_bytes, record); raises ArchiveError."""
    deadline = deadline if deadline is not None else time.monotonic() + TOTAL_BUDGET
    try:
        response = _fetch(url, deadline, PAGE_LIMIT, _PAGE_HEADERS, PAGE_TIMEOUT)
    except safe_http.SafeHTTPError as exc:
        raise ArchiveError(exc.code) from None
    content_type = response.headers.get("content-type", "").lower()
    if content_type.split(";", 1)[0].strip() not in ("text/html", "application/xhtml+xml"):
        raise ArchiveError("not_html")
    cleaner = _Cleaner(response.url)
    text = _decode(response.body, content_type)
    parse_until = min(deadline, time.monotonic() + PARSE_TIMEOUT)
    try:
        # In pieces, so markup built to stall the parser runs out of time instead.
        for offset in range(0, len(text), PARSE_CHUNK):
            if time.monotonic() >= parse_until:
                break
            cleaner.feed(text[offset:offset + PARSE_CHUNK])
            if len(cleaner.out) > MAX_PARTS:
                raise ArchiveError("too_large")
    except (AssertionError, ValueError):
        pass  # keep what was parsed before the malformed markup
    cleaner.finish()

    # Stylesheets, in document order.
    styles, css_total, sheets_skipped = [], 0, 0
    fetched_sheets = 0
    for sheet in cleaner.sheets:
        css = sheet.css
        if sheet.url:
            if fetched_sheets >= MAX_STYLESHEETS or deadline - time.monotonic() < 1:
                sheets_skipped += 1
                continue
            fetched_sheets += 1
            try:
                answer = _fetch(sheet.url, deadline, CSS_LIMIT, _CSS_HEADERS, RESOURCE_TIMEOUT)
            except safe_http.SafeHTTPError:
                sheets_skipped += 1
                continue
            kind = answer.headers.get("content-type", "").lower()
            if kind and "css" not in kind:
                sheets_skipped += 1
                continue
            css = _decode(answer.body, kind)
        css = clean_css(css)
        size = len(css.encode("utf-8"))
        if css_total + size > CSS_TOTAL_LIMIT:
            sheets_skipped += 1
            continue
        css_total += size
        media = _attr("media", sheet.media[:200]) if sheet.media else ""
        styles.append(f"<style{media}>{css}</style>")

    # Pictures, in document order, within the count, size and time budgets.
    text_size = (sum(len(part.encode("utf-8")) for part in cleaner.out if isinstance(part, str)) + css_total
                 + 8192 + 6 * len(url))
    budget = FILE_LIMIT - text_size
    cache, body = {}, []
    saved = over_count = over_size = unavailable = 0
    distinct = 0
    for part in cleaner.out:
        if isinstance(part, str):
            body.append(part)
            continue
        uri = ""
        if part.data_uri:
            uri = _embedded_image(part.data_uri)
            if not uri:
                unavailable += 1
        elif part.url in cache:
            uri = cache[part.url]
        elif distinct >= MAX_IMAGES:
            over_count += 1
        elif deadline - time.monotonic() < 1:
            unavailable += 1
        elif budget <= 0:
            over_size += 1   # the file is full: don't fetch (and hold) pictures that can't go in
        else:
            distinct += 1
            try:
                answer = _fetch(part.url, deadline, IMAGE_LIMIT, _IMAGE_HEADERS, RESOURCE_TIMEOUT)
                kind = _sniff(answer.body, answer.headers.get("content-type", ""))
                uri = _data_uri(kind, answer.body) if kind and answer.body else ""
                if not uri:
                    unavailable += 1
            except safe_http.SafeHTTPError as exc:
                if exc.code == "too_large":
                    over_size += 1
                else:
                    unavailable += 1
            # Only keep what can still fit, so one page can't pile up pictures in memory.
            cache[part.url] = uri if len(uri) <= budget else ""
        if uri and len(uri) > budget:
            uri = ""
            over_size += 1
        if uri:
            budget -= len(uri)
            saved += 1
            body.append(f'<img{part.attributes} src="{uri}">')
        elif part.alt.strip():
            body.append(f"<span>[{_html.escape(part.alt.strip()[:300], quote=False)}]</span>")

    limited = saved == 0 and cleaner.words < 80
    notes = []
    if limited:
        notes.append("This page builds itself with scripts, so the copy may be missing most of its content.")
    if over_count:
        notes.append(f"Only the first {MAX_IMAGES} pictures were saved; {_plural(over_count, 'more was', 'more were')} left out.")
    if over_size:
        notes.append(f"{_plural(over_size, 'picture was', 'pictures were')} too big to keep and left out.")
    if unavailable:
        notes.append(f"{_plural(unavailable, 'picture', 'pictures')} could not be fetched.")
    if sheets_skipped:
        notes.append(f"{_plural(sheets_skipped, 'stylesheet', 'stylesheets')} could not be included, so the layout may differ.")

    saved_at = now or datetime.now(timezone.utc)
    title = cleaner.title or ""
    document = "".join([
        "<!DOCTYPE html>\n<html", cleaner.html_attrs, ">\n<head>\n",
        '<meta charset="utf-8">\n',
        f'<meta http-equiv="Content-Security-Policy" content="{FILE_CSP}">\n',
        '<meta name="referrer" content="no-referrer">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        f'<meta name="generator" content="Super Bookmark Manager saved copy {FORMAT_VERSION}">\n',
        f"<title>{_html.escape(title or url, quote=False)}</title>\n",
        "\n".join(styles), "\n</head>\n<body", cleaner.body_attrs, ">\n",
        _banner(url, title, saved_at, notes), "\n",
        "".join(body), "\n</body>\n</html>\n",
    ]).encode("utf-8", "replace")
    if len(document) > FILE_LIMIT:
        raise ArchiveError("too_large")
    record = {
        "version": FORMAT_VERSION, "url": url, "title": title,
        "savedAt": saved_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bytes": len(document), "images": saved,
        "imagesLeftOut": over_count + over_size + unavailable,
        "stylesheets": len(styles), "limited": limited,
    }
    if response.url != safe_http.parse_url(url).url:
        record["finalUrl"] = response.url
    return document, record


# ── X posts ───────────────────────────────────────────────────────────────────

def _picture(url, deadline):
    """A data: URI for one picture, or "" (with the reason: "too_large" or "unavailable")."""
    if not url or deadline - time.monotonic() < 1:
        return "", "unavailable"
    try:
        answer = _fetch(url, deadline, IMAGE_LIMIT, _IMAGE_HEADERS, RESOURCE_TIMEOUT)
    except safe_http.SafeHTTPError as exc:
        return "", "too_large" if exc.code == "too_large" else "unavailable"
    kind = _sniff(answer.body, answer.headers.get("content-type", ""))
    if kind not in ("image/jpeg", "image/png", "image/gif", "image/webp") or not answer.body:
        return "", "unavailable"
    return _data_uri(kind, answer.body), ""


def _video_file(video, deadline):
    """(mp4 bytes or None, reason). Tries the sharpest rendition that fits VIDEO_LIMIT."""
    if not video or not video.variants:
        return None, "unavailable"
    reason = "unavailable"
    for bitrate, address in video.variants:
        if bitrate and video.duration_ms and bitrate * video.duration_ms / 8000 > VIDEO_LIMIT * 1.1:
            reason = "too_large"
            continue                       # clearly too big, don't start it
        if deadline - time.monotonic() < 3:
            return None, "unavailable"
        try:
            answer = _fetch(address, deadline, VIDEO_LIMIT, _VIDEO_HEADERS, deadline - time.monotonic())
        except safe_http.SafeHTTPError as exc:
            reason = "too_large" if exc.code == "too_large" else "unavailable"
            if exc.code == "too_large":
                continue
            return None, reason
        if answer.body[4:8] == b"ftyp":
            return answer.body, ""
        return None, "unavailable"
    return None, reason


def build_x_copy(url, identifier, *, deadline=None, now=None, key=None):
    """Save an X post from X's embed data. Returns (html_bytes, record, mp4 bytes or None)."""
    deadline = deadline if deadline is not None else time.monotonic() + X_BUDGET
    try:
        answer = _fetch(x_post.data_url(identifier), deadline, x_post.DATA_LIMIT, _JSON_HEADERS, PAGE_TIMEOUT)
    except safe_http.SafeHTTPError as exc:
        if exc.code == "http_error" and exc.status in (403, 404, 410):
            raise ArchiveError("post_unavailable") from None
        raise ArchiveError(exc.code) from None
    post = x_post.parse(answer.body)
    if post is None:
        raise ArchiveError("post_unavailable")
    key = key or copy_key(url)

    notes, saved, left_out = [], 0, 0
    reasons = []
    avatar, _ = _picture(post.avatar, deadline)
    photos = []
    for address in post.photos:
        uri, why = _picture(address, deadline)
        if uri:
            photos.append(uri)
            saved += 1
        else:
            left_out += 1
            reasons.append(why)
    video_bytes, poster, missing, video_failed = None, "", "", False
    if post.video:
        poster, _ = _picture(post.video.poster, deadline)
        video_bytes, why = _video_file(post.video, deadline)
        video_failed = video_bytes is None and why != "too_large"
        if video_bytes is None:
            word = "GIF" if post.video.gif else "video"
            if why == "too_large":
                notes.append(f"The {word} is bigger than {VIDEO_LIMIT // (1024 * 1024)} MB, so only its cover picture was kept.")
            else:
                notes.append(f"The {word} could not be fetched, so only its cover picture was kept.")
            if not poster:
                missing = f"The {word} wasn't saved."
    quoted_avatar, quoted_photos = "", []
    if post.quoted:
        quoted_avatar, _ = _picture(post.quoted.avatar, deadline)
        for address in post.quoted.photos:
            uri, why = _picture(address, deadline)
            if uri:
                quoted_photos.append(uri)
                saved += 1
            else:
                left_out += 1
                reasons.append(why)
        if post.quoted.video and post.quoted.video.poster:
            uri, _ = _picture(post.quoted.video.poster, deadline)
            if uri:
                quoted_photos.append(uri)
    if left_out:
        if all(why == "too_large" for why in reasons):
            notes.append(f"{_plural(left_out, 'picture was', 'pictures were')} too big to keep and left out.")
        else:
            notes.append(f"{_plural(left_out, 'picture', 'pictures')} could not be fetched.")

    saved_at = now or datetime.now(timezone.utc)
    title = x_post.title(post)
    body = x_post.layout(post, avatar=avatar, photos=photos, video_src=f"{key}.mp4" if video_bytes else "",
                         poster=poster, missing=missing, quoted_avatar=quoted_avatar, quoted_photos=quoted_photos)
    document = "".join([
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n',
        f'<meta http-equiv="Content-Security-Policy" content="{FILE_CSP}">\n',
        '<meta name="referrer" content="no-referrer">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        f'<meta name="generator" content="Super Bookmark Manager saved copy {FORMAT_VERSION}">\n',
        f"<title>{_html.escape(title, quote=False)}</title>\n",
        f"<style>{x_post.STYLE}</style>\n</head>\n<body>\n",
        _banner(url, title, saved_at, notes), "\n", body, "\n</body>\n</html>\n",
    ]).encode("utf-8", "replace")
    if len(document) > FILE_LIMIT:
        raise ArchiveError("too_large")
    record = {
        "version": FORMAT_VERSION, "url": url, "title": title, "kind": "x-post",
        "savedAt": saved_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bytes": len(document) + (len(video_bytes) if video_bytes else 0), "images": saved,
        "imagesLeftOut": left_out, "stylesheets": 1, "limited": False, "video": video_bytes is not None,
    }
    if video_failed:
        record["videoFailed"] = True
    return document, record, video_bytes


# ── TikTok posts ──────────────────────────────────────────────────────────────

def build_tiktok_copy(url, link, *, deadline=None, now=None, key=None):
    """Save a TikTok post: caption, author and cover from TikTok's oEmbed data, the
    video when the optional helper is installed. Returns (html, record, mp4 or None)."""
    deadline = deadline if deadline is not None else time.monotonic() + X_BUDGET + HELPER_TIMEOUT
    kind, handle, identifier = link
    if kind == "short":
        # A share link: the redirect names the post.
        try:
            answer = _fetch(url, deadline, PAGE_LIMIT, _PAGE_HEADERS, PAGE_TIMEOUT)
        except safe_http.SafeHTTPError as exc:
            raise ArchiveError("post_unavailable" if exc.code == "http_error" else exc.code) from None
        resolved = tiktok_post.parse_link(answer.url)
        if not resolved or resolved[0] == "short":
            raise ArchiveError("post_unavailable")
        kind, handle, identifier = resolved
    address = tiktok_post.canonical(handle, kind, identifier)
    try:
        answer = _fetch(tiktok_post.data_url(address), deadline, tiktok_post.DATA_LIMIT, _JSON_HEADERS, PAGE_TIMEOUT)
    except safe_http.SafeHTTPError as exc:
        if exc.code == "http_error" and exc.status in (400, 403, 404, 410):
            raise ArchiveError("post_unavailable") from None
        raise ArchiveError(exc.code) from None
    post, cover_url = tiktok_post.parse(answer.body, address, identifier)
    if post is None:
        raise ArchiveError("post_unavailable")
    key = key or copy_key(url)
    cover, _ = _picture(cover_url, deadline)
    notes, video_bytes, missing, video_failed = [], None, False, False
    if kind == "photo":
        notes.append("Photo slideshows are saved with their caption and cover picture only.")
    elif not video_helper.installed():
        missing = video_failed = True
        notes.append("Saved without the video. To keep the video too, get the video helper in Settings, then choose Update.")
    else:
        video_helper.update_if_due()
        try:
            video_bytes = video_helper.fetch_video(address, VIDEO_LIMIT, max(5.0, min(HELPER_TIMEOUT, deadline - time.monotonic())))
        except video_helper.HelperError as exc:
            missing = True
            video_failed = exc.code != "too_large"
            if exc.code == "too_large":
                notes.append(f"The video is bigger than {VIDEO_LIMIT // (1024 * 1024)} MB, so only its cover picture was kept.")
            else:
                notes.append("The video could not be fetched, so only its cover picture was kept. Update tries again.")
    saved_at = now or datetime.now(timezone.utc)
    title = x_post.title(post)
    body = x_post.layout(post, video_src=f"{key}.mp4" if video_bytes else "", poster=cover,
                         missing="" if cover or video_bytes else "The cover picture couldn't be fetched.")
    document = "".join([
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n',
        f'<meta http-equiv="Content-Security-Policy" content="{FILE_CSP}">\n',
        '<meta name="referrer" content="no-referrer">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        f'<meta name="generator" content="Super Bookmark Manager saved copy {FORMAT_VERSION}">\n',
        f"<title>{_html.escape(title, quote=False)}</title>\n",
        f"<style>{x_post.STYLE}</style>\n</head>\n<body>\n",
        _banner(url, title, saved_at, notes), "\n", body, "\n</body>\n</html>\n",
    ]).encode("utf-8", "replace")
    if len(document) > FILE_LIMIT:
        raise ArchiveError("too_large")
    record = {
        "version": FORMAT_VERSION, "url": url, "title": title, "kind": "tiktok-post",
        "savedAt": saved_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bytes": len(document) + (len(video_bytes) if video_bytes else 0), "images": 1 if cover else 0,
        "imagesLeftOut": 0 if cover else 1, "stylesheets": 1, "limited": False, "video": video_bytes is not None,
        "videoMissing": missing,
    }
    if video_failed:
        record["videoFailed"] = True
    return document, record, video_bytes


# ── Reddit posts ──────────────────────────────────────────────────────────────

def build_reddit_copy(url, link, *, deadline=None, now=None, key=None):
    """Save a Reddit post from its public RSS feed: title, text, author, subreddit,
    date, its picture and outside link; a video post's video with the optional helper.
    Returns (html, record, mp4 or None)."""
    deadline = deadline if deadline is not None else time.monotonic() + X_BUDGET + HELPER_TIMEOUT
    kind, subreddit, identifier = link
    try:
        if kind == "share":
            # A share link: the redirect names the post.
            reddit_post.wait_turn()
            resolved = reddit_post.parse_link(_fetch(url, deadline, PAGE_LIMIT, _PAGE_HEADERS, PAGE_TIMEOUT).url)
            if not resolved or resolved[0] != "post":
                raise ArchiveError("post_unavailable")
            _, subreddit, identifier = resolved
        reddit_post.wait_turn()
        failure, post = None, None
        try:
            answer = _fetch(reddit_post.data_url(subreddit, identifier), deadline, reddit_post.DATA_LIMIT,
                            {**_JSON_HEADERS, "Accept": "application/atom+xml"}, PAGE_TIMEOUT)
            post, details = reddit_post.parse(answer.body, identifier)
        except safe_http.SafeHTTPError as exc:
            if exc.code == "http_error" and exc.status == 429:
                raise
            failure = exc
        if post is None:
            # No feed (Reddit may close it): keep at least the title, author and subreddit from its embed data.
            try:
                reddit_post.wait_turn()
                answer = _fetch(reddit_post.oembed_url(subreddit, identifier), deadline, 64 * 1024, _JSON_HEADERS, PAGE_TIMEOUT)
                post, details = reddit_post.parse_oembed(answer.body, identifier, subreddit)
            except safe_http.SafeHTTPError:
                post = None
        if post is None and failure is not None:
            raise failure
    except safe_http.SafeHTTPError as exc:
        if exc.code == "http_error" and exc.status == 429:
            raise ArchiveError("busy") from None          # Reddit asks us to slow down: Update tries again
        if exc.code == "http_error" and exc.status in (403, 404, 410):
            raise ArchiveError("post_unavailable") from None
        raise ArchiveError(exc.code) from None
    if post is None:
        raise ArchiveError("post_unavailable")
    key = key or copy_key(url)
    address = reddit_post.canonical(details["subreddit"] or subreddit, identifier)
    notes, photos, video_bytes, missing = [], [], None, False
    picture, why = _picture(details["image"], deadline)
    if not picture and details["thumbnail"] and details["thumbnail"] != details["image"]:
        picture, why = _picture(details["thumbnail"], deadline)
    if picture and len(picture) < FILE_LIMIT - 64 * 1024 - 6 * len(post.text):
        photos.append(picture)
    elif details["image"]:
        notes.append("The picture was too big to keep." if why == "too_large" else "The picture could not be fetched.")
    if details.get("partial"):
        notes.append("Reddit didn't share this post's text or picture, so the copy keeps its title, author and subreddit.")
    if details["gallery"]:
        notes.append("This is a gallery: its first picture is saved.")
    video_failed = False
    if details["video"]:
        if not video_helper.installed():
            missing = video_failed = True
            notes.append("Saved without the video. To keep the video too, get the video helper in Settings, then choose Update.")
        else:
            video_helper.update_if_due()
            try:
                video_bytes = video_helper.fetch_video(address, VIDEO_LIMIT, max(5.0, min(HELPER_TIMEOUT, deadline - time.monotonic())))
            except video_helper.HelperError as exc:
                missing = True
                video_failed = exc.code != "too_large"
                notes.append(f"The video is bigger than {VIDEO_LIMIT // (1024 * 1024)} MB, so only its picture was kept."
                             if exc.code == "too_large" else "The video could not be fetched, so only its picture was kept. Update tries again.")
    saved_at = now or datetime.now(timezone.utc)
    if details["subreddit"]:
        post.name = f"{post.name} · r/{details['subreddit']}" if post.name else f"r/{details['subreddit']}"
    headline = details["title"] if len(details["title"]) <= 100 else details["title"][:99].rstrip() + "…"
    title = f"{post.name or 'Reddit post'} on Reddit: “{headline}”" if headline else x_post.title(post)
    body = x_post.layout(post, photos=photos if not video_bytes else (),
                         video_src=f"{key}.mp4" if video_bytes else "", poster=photos[0] if video_bytes and photos else "")
    document = "".join([
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n',
        f'<meta http-equiv="Content-Security-Policy" content="{FILE_CSP}">\n',
        '<meta name="referrer" content="no-referrer">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        f'<meta name="generator" content="Super Bookmark Manager saved copy {FORMAT_VERSION}">\n',
        f"<title>{_html.escape(title, quote=False)}</title>\n",
        f"<style>{x_post.STYLE}</style>\n</head>\n<body>\n",
        _banner(url, title, saved_at, notes), "\n", body, "\n</body>\n</html>\n",
    ]).encode("utf-8", "replace")
    if len(document) > FILE_LIMIT:
        raise ArchiveError("too_large")
    record = {
        "version": FORMAT_VERSION, "url": url, "title": title, "kind": "reddit-post",
        "savedAt": saved_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bytes": len(document) + (len(video_bytes) if video_bytes else 0), "images": len(photos),
        "imagesLeftOut": 0 if photos or not details["image"] else 1, "stylesheets": 1, "limited": False,
        "video": video_bytes is not None, "videoMissing": missing,
        **({"videoFailed": True} if video_failed else {}),
    }
    return document, record, video_bytes


# ── Instagram posts ───────────────────────────────────────────────────────────

def build_instagram_copy(url, data, *, deadline=None, now=None, key=None):
    """Save an Instagram post from what the bookmark button read in the owner's tab.

    Without that data there is nothing to save from: Instagram shows its posts
    only to signed-in visitors and the app never holds a login.
    """
    if data is None:
        raise ArchiveError("needs_browser")
    try:
        post, pictures, video = instagram_post.parse(url, data)
    except instagram_post.PostDataError:
        raise ArchiveError("invalid_post") from None
    deadline = deadline if deadline is not None else time.monotonic() + TOTAL_BUDGET
    key = key or copy_key(url)
    budget = FILE_LIMIT - 64 * 1024 - 6 * len(post.text)
    photos, notes, left_out, too_big = [], [], 0, 0
    for address in pictures:
        uri, why = _picture(address, deadline)
        if uri and len(uri) <= budget:
            photos.append(uri)
            budget -= len(uri)
        else:
            left_out += 1
            too_big += 1 if (why == "too_large" or uri) else 0
    if video:
        notes.append("This is a video post: its cover picture is saved. The video needs the browser extension (planned for v0.4.0).")
    if left_out:
        notes.append(f"{_plural(left_out, 'picture was', 'pictures were')} too big to keep and left out."
                     if too_big == left_out else f"{_plural(left_out, 'picture', 'pictures')} could not be fetched.")
    saved_at = now or datetime.now(timezone.utc)
    title = x_post.title(post)
    body = x_post.layout(post, photos=photos, missing="" if photos else "No pictures came with this post.")
    document = "".join([
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n',
        f'<meta http-equiv="Content-Security-Policy" content="{FILE_CSP}">\n',
        '<meta name="referrer" content="no-referrer">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        f'<meta name="generator" content="Super Bookmark Manager saved copy {FORMAT_VERSION}">\n',
        f"<title>{_html.escape(title, quote=False)}</title>\n",
        f"<style>{x_post.STYLE}</style>\n</head>\n<body>\n",
        _banner(url, title, saved_at, notes), "\n", body, "\n</body>\n</html>\n",
    ]).encode("utf-8", "replace")
    if len(document) > FILE_LIMIT:
        raise ArchiveError("too_large")
    record = {
        "version": FORMAT_VERSION, "url": url, "title": title, "kind": "instagram-post",
        "savedAt": saved_at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bytes": len(document), "images": len(photos), "imagesLeftOut": left_out, "stylesheets": 1, "limited": False,
    }
    if pictures:
        # The first picture also becomes the link's own preview, kept locally:
        # Instagram's picture addresses stop working after a while.
        import metadata_fetcher
        thumbnail = metadata_fetcher._cache_instagram_thumb(pictures[0], url, min(deadline, time.monotonic() + 8))
        if thumbnail:
            record["thumbnail"] = thumbnail
    return document, record, None


# ── Files ─────────────────────────────────────────────────────────────────────

def _paths(key):
    if not valid_key(key):
        raise ValueError("invalid copy key")
    return os.path.join(ARCHIVE_DIR, key + ".html"), os.path.join(ARCHIVE_DIR, key + ".json")


def video_path(key):
    if not valid_key(key):
        raise ValueError("invalid copy key")
    return os.path.join(ARCHIVE_DIR, key + ".mp4")


def _install(path, data):
    """Write beside the target, then swap it in, so a reader never sees half a file."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=ARCHIVE_DIR, prefix=os.path.basename(path) + ".", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(data)
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                temporary = None
                return
            except PermissionError:
                # Windows: the old copy is being read right now. Wait for the viewer.
                if attempt == 4:
                    raise
                time.sleep(0.2)
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def read_record(key):
    """The stored record of a saved copy, or None when there is no copy."""
    try:
        page, record = _paths(key)
    except ValueError:
        return None
    if os.path.islink(page) or not os.path.isfile(page):
        return None
    result = {"key": key, "status": "saved", "bytes": os.path.getsize(page)}
    try:
        with open(record, encoding="utf-8") as handle:
            stored = json.load(handle)
        if isinstance(stored, dict):
            for name, kind in (("url", str), ("title", str), ("savedAt", str), ("finalUrl", str),
                               ("images", int), ("imagesLeftOut", int), ("limited", bool), ("kind", str),
                               ("videoMissing", bool), ("thumbnail", str)):
                if type(stored.get(name)) is kind:
                    result[name] = stored[name]
    except (OSError, ValueError):
        pass
    video = video_path(key)
    if not os.path.islink(video) and os.path.isfile(video):
        result["video"] = True
        result["bytes"] += os.path.getsize(video)
    if "savedAt" not in result:
        stamp = datetime.fromtimestamp(os.path.getmtime(page), timezone.utc)
        result["savedAt"] = stamp.isoformat(timespec="seconds").replace("+00:00", "Z")
    return result


def save_copy(url: str, *, deadline=None, post=None):
    """Make (or replace) the copy of one link and return its record.

    `post` is what the bookmark button read from an Instagram post (see instagram_post.py).
    """
    key = copy_key(url)
    identifier = x_post.post_id(url)
    tiktok = tiktok_post.parse_link(url)
    if identifier:
        document, record, video = build_x_copy(url, identifier, deadline=deadline, key=key)
    elif tiktok:
        document, record, video = build_tiktok_copy(url, tiktok, deadline=deadline, key=key)
    elif instagram_post.post_code(url):
        document, record, video = build_instagram_copy(url, post, deadline=deadline, key=key)
    elif reddit_post.parse_link(url):
        document, record, video = build_reddit_copy(url, reddit_post.parse_link(url), deadline=deadline, key=key)
    else:
        (document, record), video = build_copy(url, deadline=deadline), None
    page, sidecar = _paths(key)
    movie = video_path(key)
    if video is None and record.pop("videoFailed", False) and os.path.isfile(movie) and not os.path.islink(movie):
        # An update that couldn't fetch the video this time (a timeout, the helper
        # gone) must not delete the one already saved: it fails and keeps the copy.
        raise ArchiveError("video_unavailable")
    record.pop("videoFailed", None)
    try:
        os.makedirs(ARCHIVE_DIR, exist_ok=True)
        if os.path.islink(ARCHIVE_DIR) or any(os.path.islink(path) for path in (page, sidecar, movie)):
            raise ArchiveError("internal_error")
        if video:
            _install(movie, video)         # before the page that plays it
        elif os.path.exists(movie):
            os.unlink(movie)               # an update without the video
        _install(page, document)
        _install(sidecar, json.dumps(record, ensure_ascii=True, indent=1).encode("ascii"))
    except OSError:
        raise ArchiveError("internal_error") from None
    return read_record(key)


def delete_copy(key) -> bool:
    """Remove a copy and its record. True when a copy was there."""
    try:
        page, sidecar = _paths(key)
    except ValueError:
        return False
    removed = False
    for path in (page, sidecar, video_path(key)):
        try:
            os.unlink(path)
            removed = removed or path == page
        except OSError:
            pass
    return removed


def delete_for_url(url: str) -> bool:
    return delete_copy(copy_key(url))


def summary() -> dict:
    """How many copies there are and the disk space they use."""
    count = size = 0
    try:
        with os.scandir(ARCHIVE_DIR) as entries:
            for entry in entries:
                if entry.is_file(follow_symlinks=False) and _KEY_RE.fullmatch(entry.name[:-5] if entry.name.endswith(".html") else ""):
                    count += 1
                    size += entry.stat(follow_symlinks=False).st_size
                elif entry.is_file(follow_symlinks=False) and _KEY_RE.fullmatch(entry.name[:-4] if entry.name.endswith(".mp4") else ""):
                    size += entry.stat(follow_symlinks=False).st_size
                elif (entry.is_file(follow_symlinks=False) and _KEY_RE.fullmatch(entry.name[:32]) and entry.name[32:33] == "."
                      and (entry.name[33:] == "tg.json" or _TG_NAME.fullmatch(entry.name[33:]))):
                    size += entry.stat(follow_symlinks=False).st_size
    except OSError:
        pass
    return {"count": count, "bytes": size}


def stored_keys() -> list:
    try:
        with os.scandir(ARCHIVE_DIR) as entries:
            return sorted(entry.name[:-5] for entry in entries
                          if entry.name.endswith(".html") and _KEY_RE.fullmatch(entry.name[:-5])
                          and entry.is_file(follow_symlinks=False))
    except OSError:
        return []


class _ZipSink:
    """Write-only target for zipfile: no seek(), so the archive is produced as a stream."""

    def __init__(self):
        self.chunks, self.position = [], 0

    def write(self, data):
        self.chunks.append(bytes(data))
        self.position += len(data)
        return len(data)

    def tell(self):
        return self.position

    def flush(self):
        pass

    def take(self):
        data, self.chunks = b"".join(self.chunks), []
        return data


def _zip_index(records, exported_at):
    rows = []
    for record in sorted(records, key=lambda item: item.get("savedAt", ""), reverse=True):
        title = record.get("title") or record.get("url") or record["key"]
        rows.append(
            f'<tr><td><a href="copies/{record["key"]}.html">{_html.escape(title[:200], quote=False)}</a></td>'
            f'<td>{_html.escape(record.get("url", "")[:300], quote=False)}</td>'
            f'<td>{_html.escape(record.get("savedAt", "")[:10], quote=False)}</td>'
            f'<td>{max(1, round(record.get("bytes", 0) / 1024)):,} KB</td></tr>')
    return ("<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>Saved copies</title><style>body{font:15px/1.5 system-ui,'Segoe UI',sans-serif;max-width:70rem;"
            "margin:2rem auto;padding:0 1rem;color:#1c1d24}table{border-collapse:collapse;width:100%}"
            "td,th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd;vertical-align:top;"
            "word-break:break-word}td:nth-child(3),td:nth-child(4){white-space:nowrap}</style></head><body>"
            f"<h1>Saved copies</h1><p>{len(rows)} saved {'copy' if len(rows) == 1 else 'copies'} exported from "
            f"SuperBookmarks on {_html.escape(exported_at[:10], quote=False)}. Each one opens offline. "
            "<code>library.json</code> is the library backup: restore it from Settings &gt; Library &amp; sync.</p>"
            "<table><thead><tr><th>Page</th><th>Original address</th><th>Saved</th><th>Size</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table></body></html>\n").encode("utf-8")


def export_zip(library_json: bytes, exported_at: str):
    """Yield a zip, piece by piece: library.json, a browsable index.html and every copy."""
    import zipfile
    sink = _ZipSink()
    keys = stored_keys()
    records = [record for record in (read_record(key) for key in keys) if record]
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as bundle:
        bundle.writestr("library.json", library_json)
        bundle.writestr("index.html", _zip_index(records, exported_at))
        yield sink.take()
        for record in records:
            page, sidecar = _paths(record["key"])
            files = [(page, f"copies/{record['key']}.html"), (sidecar, f"copies/{record['key']}.json")]
            if record.get("video"):
                files.insert(0, (video_path(record["key"]), f"copies/{record['key']}.mp4"))
            for path, name in files:
                try:
                    source = open(path, "rb")
                except OSError:
                    continue               # deleted while exporting, or no record file
                with source, bundle.open(name, "w", force_zip64=True) as target:
                    while True:
                        block = source.read(262144)
                        if not block:
                            break
                        target.write(block)
                        if sink.position and len(sink.chunks) > 8:
                            yield sink.take()
                yield sink.take()
        for key in telegram_keys():
            record = telegram_media(key)
            if not record:
                continue
            files = [(os.path.join(ARCHIVE_DIR, f"{key}.{item['name']}"), f"copies/{key}.{item['name']}")
                     for item in record["items"]] + [(_tg_record_path(key), f"copies/{key}.tg.json")]
            for path, name in files:          # the record last: a restore needs every file it lists
                try:
                    source = open(path, "rb")
                except OSError:
                    continue
                with source, bundle.open(name, "w", force_zip64=True) as target:
                    while True:
                        block = source.read(262144)
                        if not block:
                            break
                        target.write(block)
                        if sink.position and len(sink.chunks) > 8:
                            yield sink.take()
                yield sink.take()
    yield sink.take()


# ── Restore from the zip ─────────────────────────────────────────────────────

IMPORT_LIMIT = 1024 * 1024 * 1024     # the uploaded zip (waitress refuses bodies over 1 GB anyway)
RECORD_LIMIT = 64 * 1024
MAX_ENTRIES = 200000
_ZIP_COPY = re.compile(r"copies/([0-9a-f]{32})\.(html|json|mp4)")
_ZIP_TELEGRAM = re.compile(r"copies/([0-9a-f]{32})\.(tg\.json|tg[0-9]\.(?:jpg|png|gif|webp|mp4))")
_GENERATOR = b'<meta name="generator" content="Super Bookmark Manager saved copy '


class _RestoreCleaner(_Cleaner):
    """The page cleaner, plus the two things only this app's own copies carry: the
    "Saved copy of..." strip's marker and the post video stored beside the copy."""

    def __init__(self, base_url, key):
        super().__init__(base_url)
        self.key = key

    def _attributes(self, tag, attrs):
        rendered = super()._attributes(tag, attrs)
        if tag == "div":
            mark = next((v for k, v in attrs if k.lower() == "data-sbm-saved-copy"), None)
            if isinstance(mark, str) and re.fullmatch(r"[0-9]{1,3}", mark):
                rendered += _attr("data-sbm-saved-copy", mark)
        return rendered

    def handle_starttag(self, tag, attrs):
        if tag == "video" and not self.dropping:
            values = {k.lower(): (v or "") for k, v in attrs}
            if values.get("src") == f"{self.key}.mp4":
                poster = _embedded_image(values.get("poster", ""))
                gif = all(name in values for name in ("loop", "muted", "autoplay"))
                flags = " loop muted autoplay playsinline" if gif else ' controls preload="metadata"'
                self.out.append(f'<video{flags}{_attr("poster", poster) if poster else ""} src="{self.key}.mp4"></video>')
        super().handle_starttag(tag, attrs)


def reclean_copy(page: bytes, url: str, key: str) -> bytes:
    """Rebuild a copy read from a zip through the same allowlist as a new copy.

    A zip may have been edited by anyone: nothing in it is passed through. Only
    inline pictures (re-checked by their bytes), inline styles (re-scrubbed) and
    this copy's own video file survive; nothing is fetched.
    """
    cleaner = _RestoreCleaner(url, key)
    text = page.decode("utf-8", "replace")
    deadline = time.monotonic() + PARSE_TIMEOUT
    try:
        for offset in range(0, len(text), PARSE_CHUNK):
            if time.monotonic() >= deadline:
                break
            cleaner.feed(text[offset:offset + PARSE_CHUNK])
            if len(cleaner.out) > MAX_PARTS:
                raise ArchiveError("too_large")
    except (AssertionError, ValueError):
        pass
    cleaner.finish()
    styles = []
    for sheet in cleaner.sheets:
        if sheet.css:
            media = _attr("media", sheet.media[:200]) if sheet.media else ""
            styles.append(f"<style{media}>{clean_css(sheet.css)}</style>")
    body = []
    for part in cleaner.out:
        if isinstance(part, str):
            body.append(part)
        elif part.data_uri and _embedded_image(part.data_uri):
            body.append(f'<img{part.attributes} src="{_embedded_image(part.data_uri)}">')
        elif part.alt.strip():
            body.append(f"<span>[{_html.escape(part.alt.strip()[:300], quote=False)}]</span>")
    document = "".join([
        "<!DOCTYPE html>\n<html", cleaner.html_attrs, ">\n<head>\n",
        '<meta charset="utf-8">\n',
        f'<meta http-equiv="Content-Security-Policy" content="{FILE_CSP}">\n',
        '<meta name="referrer" content="no-referrer">\n',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
        f'<meta name="generator" content="Super Bookmark Manager saved copy {FORMAT_VERSION}">\n',
        f"<title>{_html.escape(cleaner.title or url, quote=False)}</title>\n",
        "\n".join(styles), "\n</head>\n<body", cleaner.body_attrs, ">\n",
        "".join(body).strip(), "\n</body>\n</html>\n",   # strip: the old head's line breaks
    ]).encode("utf-8", "replace")
    if len(document) > FILE_LIMIT:
        raise ArchiveError("too_large")
    return document


def _read_member(bundle, info, limit):
    """At most `limit` bytes of one entry, whatever its header claims; None when longer."""
    with bundle.open(info) as source:
        data = source.read(limit + 1)
    return None if len(data) > limit else data


def import_zip(path, library):
    """Add the copies in an exported zip to this data folder.

    Only copies of links that are in this library (`library`: identity -> url)
    are added, and an existing copy is never replaced. Each copy must carry its
    record, the record's address must give the copy's file name, and the page
    must be one this app wrote. Nothing is extracted by its own path: files are
    written under names built from the 32-character key.
    """
    import zipfile
    try:
        bundle = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise ArchiveError("not_zip") from None
    result = {"restored": [], "already": 0, "notInLibrary": 0, "invalid": 0}
    with bundle:
        infos = bundle.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ArchiveError("too_large")
        members, telegram = {}, {}
        for info in infos:
            match = _ZIP_COPY.fullmatch(info.filename)
            if match and not info.is_dir():
                members.setdefault(match.group(1), {})[match.group(2)] = info
            match = _ZIP_TELEGRAM.fullmatch(info.filename)
            if match and not info.is_dir():
                telegram.setdefault(match.group(1), {})[match.group(2)] = info
        if not members and not telegram and "library.json" not in bundle.namelist():
            raise ArchiveError("not_zip")
        os.makedirs(ARCHIVE_DIR, exist_ok=True)
        if os.path.islink(ARCHIVE_DIR):
            raise ArchiveError("internal_error")
        for key, parts in sorted(members.items()):
            try:
                if "html" not in parts or "json" not in parts:
                    raise ValueError("incomplete")
                raw = _read_member(bundle, parts["json"], RECORD_LIMIT)
                stored = json.loads(raw) if raw is not None else None
                url = stored.get("url") if isinstance(stored, dict) else None
                if not isinstance(url, str) or copy_key(url) != key:
                    raise ValueError("record")
                owner = library.get(url_identity(url))
                if owner is None:
                    result["notInLibrary"] += 1
                    continue
                if read_record(key):
                    result["already"] += 1
                    continue
                page = _read_member(bundle, parts["html"], FILE_LIMIT)
                if page is None or not page.startswith(b"<!DOCTYPE html>") or _GENERATOR not in page[:4096]:
                    raise ValueError("page")
                # Never trust a zip's markup: rebuild it as a new copy would be (owner, 2026-10-09).
                page = reclean_copy(page, url, key)
                record = {name: stored[name] for name, kind in (
                    ("version", int), ("url", str), ("title", str), ("savedAt", str), ("bytes", int), ("images", int),
                    ("imagesLeftOut", int), ("stylesheets", int), ("limited", bool), ("finalUrl", str),
                    ("kind", str), ("video", bool), ("videoMissing", bool))
                    if type(stored.get(name)) is kind}
                movie = None
                if "mp4" in parts:
                    movie = _read_member(bundle, parts["mp4"], VIDEO_LIMIT)
                    if movie is None or movie[4:8] != b"ftyp":
                        raise ValueError("video")
                record["video"] = movie is not None
                record["bytes"] = len(page) + (len(movie) if movie else 0)
            except Exception:  # noqa: BLE001 - a damaged entry (bad JSON, CRC or zlib error) is skipped, never fatal
                result["invalid"] += 1
                continue
            html_path, sidecar = _paths(key)
            try:
                if movie:
                    _install(video_path(key), movie)
                _install(html_path, page)
                _install(sidecar, json.dumps(record, ensure_ascii=True, indent=1).encode("ascii"))
            except OSError:
                delete_copy(key)
                raise ArchiveError("internal_error") from None
            restored = read_record(key) or {}
            result["restored"].append({"key": key, "url": owner, **{name: restored[name] for name in (
                "savedAt", "bytes", "limited", "kind", "video", "videoMissing") if name in restored}})
        result["telegram"] = _import_telegram(bundle, telegram, library, result)
    return result


def _import_telegram(bundle, telegram, library, result):
    """Restore kept Telegram photos and videos: links in this library only, never over existing ones.

    Counted apart from the copies (telegram*), so a link with both is not counted twice.
    """
    result.update(telegramAlready=0, telegramNotInLibrary=0, telegramInvalid=0)
    restored = 0
    for key, parts in sorted(telegram.items()):
        try:
            raw = _read_member(bundle, parts["tg.json"], RECORD_LIMIT) if "tg.json" in parts else None
            record = _tg_clean_record(json.loads(raw), key) if raw is not None else None
            if not record:
                raise ValueError("record")
            if library.get(url_identity(record["url"])) is None:
                result["telegramNotInLibrary"] += 1
                continue
            if telegram_media(key):
                result["telegramAlready"] += 1
                continue
            items = []
            for item in record["items"]:
                info = parts.get(item["name"])
                if info is None:
                    raise ValueError("missing")
                data = _read_member(bundle, info, VIDEO_LIMIT if item["kind"] == "video" else TG_PHOTO_LIMIT)
                found = _tg_item(item["kind"], data, item.get("duration"))
                if not found or not item["name"].endswith("." + found[0]):
                    raise ValueError("file")
                items.append({"kind": item["kind"], "data": data, "duration": item.get("duration")})
        except Exception:  # noqa: BLE001 - a damaged entry is skipped, never fatal
            result["telegramInvalid"] += 1
            continue
        try:
            stamp = datetime.fromisoformat(record["savedAt"].replace("Z", "+00:00")) if record["savedAt"] else None
        except (ValueError, OverflowError):
            stamp = None
        try:
            save_telegram_media(record["url"], record["message"], items, now=stamp, missing=record.get("missing", 0))
        except ArchiveError:
            delete_telegram_media(key)
            raise
        restored += 1
    return restored


# ── Background queue ──────────────────────────────────────────────────────────
# Copies take many seconds; the web server has four threads. Requests only
# enqueue, three workers do the fetching, and the browser asks how it went.

WORKERS = 3
QUEUE_LIMIT = 64
HOST_SPACING = 1.0
_JOB_MEMORY = 500

_lock = threading.Lock()
_jobs = OrderedDict()             # key -> {"status", "error", "url"}
_pending = queue.Queue()
_started = False
_host_locks = {}
_host_last = {}


def _host_gate(url):
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        host = ""
    with _lock:
        if len(_host_locks) > 512:
            _host_locks.clear()
            _host_last.clear()
        return host, _host_locks.setdefault(host, threading.Lock())


def _run(key, url, post=None):
    social = ("https://x.com/" if x_post.post_id(url) else
              "https://www.tiktok.com/" if tiktok_post.parse_link(url) else
              "https://www.reddit.com/" if reddit_post.parse_link(url) else None)
    host, gate = _host_gate(social or url)
    with gate:
        # One page per site at a time, at least a second apart (X and TikTok posts: two).
        wait = _host_last.get(host, 0) + (X_SPACING if social else HOST_SPACING) - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            save_copy(url, post=post)
            outcome = None
            with _lock:
                unwanted = _jobs.get(key, {}).get("cancelled")
            if unwanted:
                delete_copy(key)   # the link was deleted while its copy was being made
        except ArchiveError as exc:
            outcome = ("too_large" if exc.code == "too_large" else "failed", exc.code)
        except Exception:
            outcome = ("failed", "internal_error")
        finally:
            _host_last[host] = time.monotonic()
    with _lock:
        if outcome is None or _jobs.get(key, {}).get("cancelled"):
            _jobs.pop(key, None)   # the file is the record of success
        else:
            _jobs[key] = {"status": outcome[0], "error": outcome[1], "url": url}
            _jobs.move_to_end(key)
            finished = [k for k, job in _jobs.items() if job["status"] not in ("queued", "saving")]
            for old in finished[:max(0, len(finished) - _JOB_MEMORY)]:
                del _jobs[old]


def _worker():
    while True:
        key, url = _pending.get()
        try:
            with _lock:
                post = None
                if key in _jobs and _jobs[key].get("cancelled"):
                    del _jobs[key]         # deleted while still waiting: nothing to fetch
                    continue
                if key in _jobs:
                    _jobs[key]["status"] = "saving"
                    post = _jobs[key].pop("post", None)
            _run(key, url, post)
        finally:
            _pending.task_done()


def _state(key):
    """Call with _lock held."""
    job = _jobs.get(key)
    record = read_record(key)
    if job is None:
        return record or {"key": key, "status": "none"}
    result = {"key": key, "status": job["status"]}
    if job.get("error"):
        result["error"] = job["error"]
    if record:
        # An update that failed leaves the earlier copy in place.
        result["previous"] = {name: record[name] for name in ("savedAt", "bytes") if name in record}
    return result


def state(key) -> dict:
    with _lock:
        return _state(key)


def request_copy(url: str, *, refresh: bool = False, post=None) -> dict:
    """Queue a copy of `url` (or report the one that exists). Never blocks on the network.

    `post` (Instagram only) is what the bookmark button read in the owner's tab;
    it always makes a fresh copy, since the owner just asked for it.
    """
    global _started
    if not ENABLED:
        return {"key": "", "status": "failed", "error": "disabled"}
    try:
        safe_http.parse_url(url)
    except safe_http.SafeHTTPError as exc:
        return {"key": "", "status": "failed", "error": exc.code}
    key = copy_key(url)
    with _lock:
        job = _jobs.get(key)
        if job and job["status"] == "queued" and post is not None:
            job["post"] = post             # not started yet: it will use what the button sent
        if job and job["status"] in ("queued", "saving"):
            job.pop("cancelled", None)     # asked for again after a delete: the copy is wanted after all
            return _state(key)
        if not refresh and post is None and read_record(key):
            _jobs.pop(key, None)
            return _state(key)
        waiting = sum(1 for other in _jobs.values() if other["status"] == "queued")
        if waiting >= QUEUE_LIMIT:
            return {"key": key, "status": "failed", "error": "busy"}
        _jobs[key] = {"status": "queued", "error": "", "url": url}
        if post is not None:
            _jobs[key]["post"] = post
        _jobs.move_to_end(key)
        if not _started:
            _started = True
            for index in range(WORKERS):
                threading.Thread(target=_worker, name=f"archive-{index}", daemon=True).start()
        _pending.put((key, url))
        return _state(key)


def remove(key) -> bool:
    """Delete a link's copy, including one that is still being made."""
    if not valid_key(key):
        return False
    with _lock:
        job = _jobs.get(key)
        if job and job["status"] in ("queued", "saving"):
            job["cancelled"] = True
        elif job:
            del _jobs[key]
    return delete_copy(key)


def remove_for_url(url: str) -> bool:
    """A deleted link: its copy and any Telegram photos and videos kept with it."""
    key = copy_key(url)
    delete_telegram_media(key)
    return remove(key)


# ── Telegram photos and videos ───────────────────────────────────────────────
# Photos and videos the owner sent to Saved Messages together with a link,
# downloaded from their own account by a Telegram refresh. They sit beside the
# link's copy as <key>.tg<i>.<ext> with a <key>.tg.json record, and exist with
# or without an HTML copy. Every file is checked by its bytes before it is kept.

TG_MAX_ITEMS = 10
TG_PHOTO_LIMIT = 10 * 1024 * 1024
TG_TEXT_LIMIT = 4000
_TG_NAME = re.compile(r"tg([0-9])\.(jpg|png|gif|webp|mp4)")
_TG_PHOTO_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
_TG_TYPES = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "mp4": "video/mp4"}


def _tg_record_path(key):
    if not valid_key(key):
        raise ValueError("invalid copy key")
    return os.path.join(ARCHIVE_DIR, key + ".tg.json")


def telegram_file_path(key, name):
    """Path of one kept Telegram file, or None when `name` is not one of this link's files."""
    record = telegram_media(key)
    if not record or not any(item["name"] == name for item in record["items"]):
        return None
    path = os.path.join(ARCHIVE_DIR, f"{key}.{name}")
    return None if os.path.islink(path) or not os.path.isfile(path) else path


def telegram_type(name):
    match = _TG_NAME.fullmatch(name or "")
    return _TG_TYPES[match.group(2)] if match else ""


def _tg_item(kind, data, duration=None):
    """(extension, checked item) for one photo or video, or None when the bytes are not one."""
    if not isinstance(data, (bytes, bytearray)):
        return None
    data = bytes(data)
    if kind == "photo":
        ext = _TG_PHOTO_EXT.get(_sniff(data))
        if not ext or len(data) > TG_PHOTO_LIMIT:
            return None
        return ext, {"kind": "photo", "bytes": len(data)}
    if kind == "video":
        if len(data) > VIDEO_LIMIT or len(data) < 16 or data[4:8] != b"ftyp":
            return None
        item = {"kind": "video", "bytes": len(data)}
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 <= duration < 86400:
            item["duration"] = int(round(duration))
        return "mp4", item
    return None


def _tg_message(message):
    message = message if isinstance(message, dict) else {}
    text = message.get("text") if isinstance(message.get("text"), str) else ""
    date = message.get("date") if isinstance(message.get("date"), str) and len(message["date"]) <= 40 else ""
    return {"text": text[:TG_TEXT_LIMIT], "date": date}


def save_telegram_media(url, message, items, *, now=None, missing=0):
    """Keep a link's Telegram photos and videos; replaces what was kept before.

    items: [{"kind": "photo"|"video", "data": bytes, "duration": seconds}].
    `missing`: files of this message that could not be downloaded this time;
    a later refresh fetches the set again. Returns {"photos": n, "videos": m};
    files that are not real pictures or MP4 videos are left out.
    """
    key = copy_key(url)
    record_path = _tg_record_path(key)
    checked = []
    for entry in (items or [])[:TG_MAX_ITEMS]:
        if not isinstance(entry, dict):
            continue
        found = _tg_item(entry.get("kind"), entry.get("data"), entry.get("duration"))
        if found:
            checked.append((found[0], found[1], bytes(entry["data"])))
    if not checked:
        return {"photos": 0, "videos": 0}
    stamp = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z")
    record = {"version": 1, "url": url, "message": _tg_message(message), "savedAt": stamp, "items": []}
    if isinstance(missing, int) and not isinstance(missing, bool) and 0 < missing <= TG_MAX_ITEMS:
        record["missing"] = missing
    try:
        os.makedirs(ARCHIVE_DIR, exist_ok=True)
        if os.path.islink(ARCHIVE_DIR) or os.path.islink(record_path):
            raise ArchiveError("internal_error")
        old = telegram_media(key)
        for index, (ext, item, data) in enumerate(checked):
            name = f"tg{index}.{ext}"
            path = os.path.join(ARCHIVE_DIR, f"{key}.{name}")
            if os.path.islink(path):
                raise ArchiveError("internal_error")
            _install(path, data)
            record["items"].append({"name": name, **item})
        _install(record_path, json.dumps(record, ensure_ascii=True, indent=1).encode("ascii"))
        kept = {item["name"] for item in record["items"]}
        for item in (old or {}).get("items", []):
            if item["name"] not in kept:
                try:
                    os.unlink(os.path.join(ARCHIVE_DIR, f"{key}.{item['name']}"))
                except OSError:
                    pass
    except OSError:
        raise ArchiveError("internal_error") from None
    return telegram_counts(record)


def telegram_counts(record):
    items = (record or {}).get("items", [])
    return {"photos": sum(item["kind"] == "photo" for item in items),
            "videos": sum(item["kind"] == "video" for item in items)}


def _tg_clean_record(stored, key):
    """The record's checked fields, or None. Item names must be tg<i>.<ext> and unique."""
    if not isinstance(stored, dict) or not isinstance(stored.get("url"), str) or copy_key(stored["url"]) != key:
        return None
    items, names = [], set()
    for item in stored.get("items") if isinstance(stored.get("items"), list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        match = _TG_NAME.fullmatch(item["name"])
        kind = "video" if match and match.group(2) == "mp4" else "photo"
        if not match or item["name"] in names or item.get("kind") != kind or len(items) >= TG_MAX_ITEMS:
            continue
        names.add(item["name"])
        clean = {"name": item["name"], "kind": kind}
        if type(item.get("bytes")) is int and item["bytes"] >= 0:
            clean["bytes"] = item["bytes"]
        if kind == "video" and type(item.get("duration")) is int and 0 <= item["duration"] < 86400:
            clean["duration"] = item["duration"]
        items.append(clean)
    if not items:
        return None
    saved = stored.get("savedAt") if isinstance(stored.get("savedAt"), str) and len(stored["savedAt"]) <= 40 else ""
    record = {"version": 1, "url": stored["url"], "message": _tg_message(stored.get("message")), "savedAt": saved,
              "items": items}
    if type(stored.get("missing")) is int and 0 < stored["missing"] <= TG_MAX_ITEMS:
        record["missing"] = stored["missing"]
    return record


def telegram_media(key):
    """{"key", "url", "message", "savedAt", "items"} for a link's kept files, or None."""
    try:
        path = _tg_record_path(key)
    except ValueError:
        return None
    if os.path.islink(path) or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            record = _tg_clean_record(json.load(handle), key)
    except (OSError, ValueError):
        return None
    if not record:
        return None
    record["items"] = [item for item in record["items"]
                       if not os.path.islink(os.path.join(ARCHIVE_DIR, f"{key}.{item['name']}"))
                       and os.path.isfile(os.path.join(ARCHIVE_DIR, f"{key}.{item['name']}"))]
    return {"key": key, **record} if record["items"] else None


def telegram_media_for_url(url):
    return telegram_media(copy_key(url)) if isinstance(url, str) and url else None


def delete_telegram_media(key) -> bool:
    """Remove a link's kept Telegram files. True when there were some.

    Called for every deleted link, so it never lists the folder (thousands of
    copies): a link without a record costs one check, one with a record has at
    most TG_MAX_ITEMS × 5 possible file names.
    """
    try:
        record_path = _tg_record_path(key)
    except ValueError:
        return False
    if not os.path.lexists(record_path):
        return False
    for index in range(TG_MAX_ITEMS):
        for extension in _TG_TYPES:
            try:
                os.unlink(os.path.join(ARCHIVE_DIR, f"{key}.tg{index}.{extension}"))
            except OSError:
                pass
    try:
        os.unlink(record_path)
    except OSError:
        return False
    return True


def telegram_keys() -> list:
    try:
        with os.scandir(ARCHIVE_DIR) as entries:
            return sorted(entry.name[:32] for entry in entries
                          if entry.name.endswith(".tg.json") and len(entry.name) == 40 and _KEY_RE.fullmatch(entry.name[:32])
                          and entry.is_file(follow_symlinks=False))
    except OSError:
        return []


_PLAIN_STYLE = (
    "<style>*{all:revert!important}html{color-scheme:light dark}"
    "body{max-width:44rem!important;margin:0 auto!important;padding:1.5rem 1rem 4rem!important;"
    "font:1.0625rem/1.65 Georgia,'Times New Roman',serif!important}"
    "img{max-width:100%!important;height:auto!important}pre{overflow:auto!important}"
    "nav a{margin-right:.75em!important}"
    "table{border-collapse:collapse!important}td,th{border:1px solid #8886!important;padding:.3rem .5rem!important}"
    "[data-sbm-saved-copy]{font:.85rem/1.5 system-ui,sans-serif!important;margin:0 0 1.5rem!important;"
    "padding:.6rem .8rem!important;border-left:3px solid #7c6cff!important;background:#7c6cff1f!important}"
    "</style>"
).encode("ascii")
_STYLE_BLOCK = re.compile(rb"<style[^>]*>[^<]*</style>\n?")


def plain_view(document: bytes) -> bytes:
    """The same copy without the site's own styling: text and pictures only.

    For pages whose stylesheet hides the content until a script runs, or covers
    it with a banner nobody can close. Stored stylesheets never contain "<", so
    removing the <style> blocks this module wrote is exact.
    """
    head, mark, rest = document.partition(b"</head>")
    if not mark:
        return document
    return _STYLE_BLOCK.sub(b"", head) + _PLAIN_STYLE + mark + rest


_NO_BANNER_STYLE = b"<style>[data-sbm-saved-copy]{display:none!important}</style>"


def without_banner(document: bytes) -> bytes:
    """Hide the copy's own "Saved copy of..." strip, for the app's reading pane,
    which shows the same details in its toolbar."""
    head, mark, rest = document.partition(b"</head>")
    return head + _NO_BANNER_STYLE + mark + rest if mark else document


def read_copy(key):
    """Bytes of a stored copy, or None."""
    if read_record(key) is None:
        return None
    try:
        with open(_paths(key)[0], "rb") as handle:
            return handle.read(FILE_LIMIT + 1)
    except OSError:
        return None


def wait_idle(timeout: float = 60.0) -> bool:
    """Block until queued copies are finished (tests and orderly shutdown)."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with _lock:
            if not any(job["status"] in ("queued", "saving") for job in _jobs.values()):
                return True
        time.sleep(0.02)
    return False
