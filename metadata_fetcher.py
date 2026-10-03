"""Lightweight, anonymous metadata using the shared validated HTTP boundary.

Instagram keeps its local thumbnail cache; generic previews remain remote URLs.
No database work or background scans occur on import or fetch_metadata().
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import html as _html
from html.parser import HTMLParser
import json
import os
import re
import tempfile
import threading
import time
from urllib.parse import parse_qs, urljoin, urlsplit

import safe_http
import storage

# A recognisable, honest agent: some sites only serve preview tags to clients
# that identify as link-preview fetchers.
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; SuperBookmarkManager/0.1; +link preview)",
            "Accept": "text/html,application/xhtml+xml"}
_INSTAGRAM_HEADERS = {"User-Agent": "facebookexternalhit/1.1",
                      "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9"}
# Packaged builds point this at the user data folder; source launches may too.
THUMB_CACHE_DIR = os.environ.get("SBM_THUMB_CACHE_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumb_cache")
# Link-preview crawlers (WhatsApp and Meta's) are let through by many sites that
# wall off ordinary browsers: social networks serve them the og: tags their
# chat previews need. Tried once, only when the first answer had no picture.
_WHATSAPP_HEADERS = {"User-Agent": "WhatsApp/2.24.20.79 A", "Accept": "text/html,application/xhtml+xml",
                     "Accept-Language": "en-US,en;q=0.9"}
_CRAWLER_FRIENDLY = ("facebook.com", "fb.watch", "threads.net", "threads.com", "tiktok.com", "linkedin.com",
                     "pinterest.com", "pin.it", "instagram.com", "x.com", "twitter.com", "bsky.app")
_BLOCKED_STATUS = (401, 403, 429, 999)
_IG_CODE_RE = re.compile(r"^/(?:p|reel|tv)/([A-Za-z0-9_-]{5,128})(?:/|$)")
_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _host_matches(url, domain):
    try:
        host = urlsplit(url).hostname or ""
        host = host.lower().rstrip(".")
        return host == domain or host.endswith("." + domain)
    except ValueError:
        return False


def _is_instagram(url):
    return _host_matches(url, "instagram.com")


def _is_youtube(url):
    return _host_matches(url, "youtube.com") or _host_matches(url, "youtu.be")


def _ig_post_code(url):
    match = _IG_CODE_RE.match(urlsplit(url).path) if _is_instagram(url) else None
    return match.group(1) if match else "ig_" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]


def _cached_instagram_path(post_url):
    code = _ig_post_code(post_url)
    local = os.path.join(THUMB_CACHE_DIR, code)
    # Preserve the existing repair contract for already-cached >1000-byte files.
    if not os.path.islink(local) and os.path.isfile(local) and os.path.getsize(local) > 1000:
        return f"/thumb/{code}"
    return ""


def _valid_image(data, mime):
    if len(data) < 1000 or len(data) > safe_http.IMAGE_LIMIT:
        return False
    mime = mime.split(";", 1)[0].lower().strip()
    signatures = {
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    }
    return signatures.get(mime, False)


def _cache_instagram_thumb(image_url, post_url, deadline=None, *, strict=False):
    """Use authoritative old cache or atomically install bounded verified bytes.

    The two-argument API still returns '' on failure for existing callers.
    Enrichment uses strict=True to retain a fixed, sanitized failure code.
    """
    temporary = None
    try:
        cached = _cached_instagram_path(post_url)
        if cached:
            return cached
        deadline = deadline if deadline is not None else time.monotonic() + safe_http.TOTAL_TIMEOUT
        response = safe_http.get(image_url, deadline=deadline, limit=safe_http.IMAGE_LIMIT, headers=_INSTAGRAM_HEADERS)
        if not _valid_image(response.body, response.headers.get("content-type", "")):
            raise safe_http.SafeHTTPError("invalid_image")
        safe_http.remaining(deadline)
        code = _ig_post_code(post_url)
        os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
        if os.path.islink(THUMB_CACHE_DIR):
            raise safe_http.SafeHTTPError("invalid_image")
        local = os.path.join(THUMB_CACHE_DIR, code)
        # Unique same-directory files avoid colliding parallel post aliases.
        with tempfile.NamedTemporaryFile(dir=THUMB_CACHE_DIR, prefix=code + ".", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(response.body)
        safe_http.remaining(deadline)
        os.replace(temporary, local)
        temporary = None
        return f"/thumb/{code}"
    except safe_http.SafeHTTPError:
        if strict:
            raise
        return ""
    except Exception:
        if strict:
            raise safe_http.SafeHTTPError("internal_error") from None
        return ""
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def cached_thumb(code):
    """Serve path for an already-installed cache entry, or '' when absent/empty."""
    local = os.path.join(THUMB_CACHE_DIR, code)
    if not os.path.islink(local) and os.path.isfile(local) and os.path.getsize(local) > 1000:
        return f"/thumb/{code}"
    return ""


def install_thumb(code, data, mime="image/jpeg"):
    """Atomically install verified image bytes under an explicit cache code."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,64}", code) or not _valid_image(data, mime):
        return ""
    os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
    if os.path.islink(THUMB_CACHE_DIR):
        return ""
    local = os.path.join(THUMB_CACHE_DIR, code)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=THUMB_CACHE_DIR, prefix=code + ".", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(data)
        os.replace(temporary, local)
        temporary = None
        return f"/thumb/{code}"
    except OSError:
        return ""
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def _extract_yt_video_id(url):
    if not _is_youtube(url):
        return ""
    parts = urlsplit(url)
    path = parts.path.strip("/").split("/")
    candidate = ""
    if _host_matches(url, "youtu.be"):
        candidate = path[0]
    elif parts.path.rstrip("/") == "/watch":
        candidate = parse_qs(parts.query).get("v", [""])[0]
    elif len(path) >= 2 and path[0] in ("embed", "v", "shorts"):
        candidate = path[1]
    return candidate if _YT_ID_RE.fullmatch(candidate) else ""


def _result(error="", **fields):
    result = {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": error}
    result.update(fields)
    populated = any(result[key] for key in ("title", "summary", "thumbnail"))
    result["status"] = ("partial" if populated else "failed") if error else ("ok" if populated else "empty")
    return result


def _fetch_youtube_metadata(url, deadline=None):
    deadline = deadline if deadline is not None else time.monotonic() + safe_http.TOTAL_TIMEOUT
    video_id = _extract_yt_video_id(url)
    if not video_id:
        return _result()
    title, thumbnail, error, author = "", "", "", ""
    try:
        thumb = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        safe_http.validate_url(thumb, deadline)
        thumbnail = thumb
        endpoint = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        response = safe_http.get(endpoint, deadline=deadline, headers=_HEADERS)
        data = json.loads(response.body.decode("utf-8"))
        if isinstance(data, dict) and isinstance(data.get("title"), str):
            title = _clean_text(data["title"], 1000)
        if isinstance(data, dict) and isinstance(data.get("author_name"), str):
            author = _clean_text(data["author_name"], 200)
    except safe_http.SafeHTTPError as exc:
        error = exc.code
    except (ValueError, UnicodeError):
        error = "network_error"
    result = _result(error, title=title, thumbnail=thumbnail)
    if author:
        result["author"] = author
    result["siteName"] = "YouTube"
    return result


def _clean_text(value, limit):
    return " ".join(value.split())[:limit]


# ── HTML decoding ─────────────────────────────────────────────────────────────

_META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._:-]+)""", re.I)
# WHATWG maps these labels to windows-1252; decoding as strict latin-1 garbles
# curly quotes and dashes.
_ENCODING_ALIASES = {"latin1": "windows-1252", "latin-1": "windows-1252", "iso-8859-1": "windows-1252",
                     "us-ascii": "windows-1252", "ascii": "windows-1252", "utf8": "utf-8", "unicode": "utf-8"}


def _decode_html(body, content_type):
    """BOM, then the HTTP charset, then <meta charset>/http-equiv, then UTF-8."""
    if body.startswith(b"\xef\xbb\xbf"):
        return body[3:].decode("utf-8", errors="replace")
    if body.startswith((b"\xff\xfe", b"\xfe\xff")):
        return body.decode("utf-16", errors="replace")
    header = re.search(r"charset\s*=\s*[\"']?([a-zA-Z0-9._:-]+)", content_type or "", re.I)
    label = header.group(1) if header else ""
    if not label:
        sniffed = _META_CHARSET.search(body[:4096])
        label = sniffed.group(1).decode("ascii", "ignore") if sniffed else ""
    encoding = _ENCODING_ALIASES.get(label.lower(), label or "utf-8")
    try:
        return body.decode(encoding, errors="replace")
    except (LookupError, UnicodeError):
        return body.decode("utf-8", errors="replace")


# ── Page parsing ──────────────────────────────────────────────────────────────

_META_KEYS = {
    "og:title", "og:description", "description", "og:image", "og:image:secure_url", "og:image:url",
    "twitter:image", "twitter:image:src", "twitter:title", "twitter:description", "og:site_name",
    "og:url", "article:published_time", "og:published_time", "datepublished", "author", "article:author",
    "citation_title", "citation_abstract", "citation_publication_date", "citation_author",
}
# Text inside these never counts toward reading length.
_SKIP_TEXT = {"script", "style", "noscript", "svg", "template", "nav", "header", "footer", "aside",
              "form", "button", "select", "textarea", "iframe", "head", "title"}
_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
_WORD = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.UNICODE)


class _MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.title = []
        self.title_done = False
        self.in_title = False
        self.svg_depth = 0
        self.skip_depth = 0
        self.article_depth = 0
        self.links = {}
        self.icons = []
        self.lang = ""
        self.jsonld = []
        self.in_jsonld = False
        self.jsonld_buffer = []
        self.words = 0
        self.article_words = 0
        self.stack = []

    def handle_starttag(self, tag, attrs):
        attributes = {k.lower(): (v or "") for k, v in attrs}
        if tag == "html" and not self.lang:
            self.lang = attributes.get("lang", "").strip()[:35]
        if tag == "svg":
            self.svg_depth += 1
        if tag in _SKIP_TEXT:
            self.skip_depth += 1
        if tag == "article":
            self.article_depth += 1
        if tag not in _VOID:
            self.stack.append(tag)
        # Only the document's first <title>, never an inline SVG's <title>.
        if tag == "title" and not self.svg_depth and not self.title_done:
            self.in_title = True
        if tag == "script" and attributes.get("type", "").lower().strip() == "application/ld+json" and len(self.jsonld) < 4:
            self.in_jsonld = True
            self.jsonld_buffer = []
        if tag == "meta":
            key = (attributes.get("property") or attributes.get("name") or attributes.get("itemprop") or "").lower().strip()
            content = attributes.get("content")
            if key in _META_KEYS and content:
                self.meta.setdefault(key, content.strip())
            return
        if tag == "link":
            rel = {r.strip().lower() for r in attributes.get("rel", "").split()}
            href = attributes.get("href", "").strip()
            if not href:
                return
            if "canonical" in rel:
                self.links.setdefault("canonical", href)
            if "alternate" in rel and attributes.get("type", "").lower() == "application/json+oembed":
                self.links.setdefault("oembed", href)
            if rel & {"icon", "apple-touch-icon", "apple-touch-icon-precomposed"} and len(self.icons) < 12:
                sizes = re.findall(r"(\d+)x\d+", attributes.get("sizes", ""))
                size = max((int(n) for n in sizes), default=180 if "apple-touch-icon" in " ".join(rel) else 16)
                kind = attributes.get("type", "").lower()
                if "svg" not in kind and not href.lower().split("?")[0].endswith(".svg"):
                    self.icons.append((size, href))

    def handle_endtag(self, tag):
        if tag == "title" and self.in_title:
            self.in_title = False
            self.title_done = True
        if tag == "script" and self.in_jsonld:
            self.in_jsonld = False
            self.jsonld.append("".join(self.jsonld_buffer)[:200000])
        if tag in self.stack:
            # Pop to the matching open tag (tolerant of unclosed children).
            while self.stack:
                top = self.stack.pop()
                if top == "svg":
                    self.svg_depth = max(0, self.svg_depth - 1)
                if top in _SKIP_TEXT:
                    self.skip_depth = max(0, self.skip_depth - 1)
                if top == "article":
                    self.article_depth = max(0, self.article_depth - 1)
                if top == tag:
                    break

    def handle_data(self, value):
        if self.in_title:
            self.title.append(value)
            return
        if self.in_jsonld:
            self.jsonld_buffer.append(value)
            return
        if self.skip_depth:
            return
        count = len(_WORD.findall(value))
        self.words += count
        if self.article_depth:
            self.article_words += count


def _jsonld_fields(blocks):
    """First article/video/product-like node of the page's JSON-LD."""
    wanted = {"article", "newsarticle", "blogposting", "techarticle", "scholarlyarticle", "report",
              "videoobject", "product", "recipe", "book", "movie", "podcastepisode", "webpage", "socialmediaposting",
              "discussionforumposting", "event", "course", "softwareapplication"}
    nodes = []
    for raw in blocks:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        pending = [data]
        while pending and len(nodes) < 64:
            item = pending.pop(0)
            if isinstance(item, list):
                pending.extend(item[:32])
            elif isinstance(item, dict):
                nodes.append(item)
                if isinstance(item.get("@graph"), list):
                    pending.extend(item["@graph"][:32])

    def types(node):
        value = node.get("@type")
        values = value if isinstance(value, list) else [value]
        return {str(v).lower() for v in values if isinstance(v, str)}

    node = next((n for n in nodes if types(n) & wanted and not types(n) <= {"webpage"}), None) \
        or next((n for n in nodes if types(n) & wanted), None)
    if not node:
        return {}

    def text(value):
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return text(value.get("name") or value.get("url") or value.get("@id") or "")
        if isinstance(value, list) and value:
            return text(value[0])
        return ""

    image = node.get("image") or node.get("thumbnailUrl") or node.get("thumbnail")
    return {
        "title": text(node.get("headline") or node.get("name")),
        "summary": text(node.get("description")),
        "image": text(image),
        "published": text(node.get("datePublished") or node.get("uploadDate") or node.get("startDate")),
        "author": text(node.get("author") or node.get("creator")),
        "site": text(node.get("publisher")) if isinstance(node.get("publisher"), dict) else "",
    }


def _iso_date(value):
    """ISO-8601 date/datetime → normalized UTC string, or ''."""
    if not isinstance(value, str) or not value.strip():
        return ""
    raw = value.strip().replace("Z", "+00:00")
    try:
        from datetime import datetime, timezone
        parsed = datetime.fromisoformat(raw[:32])
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if not 1990 <= parsed.year <= 2100:
            return ""
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        match = re.match(r"^(\d{4})[-/](\d{2})[-/](\d{2})", raw)
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}T00:00:00Z" if match else ""


def _remote_image(value, page_url, deadline):
    if ("\\" in value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)):
        raise safe_http.SafeHTTPError("invalid_url")
    target, _ = safe_http.validate_url(urljoin(page_url, value), deadline)
    return target.url


def _http_link(value, base):
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        url = urljoin(base, value.strip())
        return safe_http.parse_url(url).url if url.lower().startswith(("http://", "https://")) else ""
    except (safe_http.SafeHTTPError, ValueError):
        return ""


# ── Local image cache ─────────────────────────────────────────────────────────

_IMAGE_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; SuperBookmarkManager/0.1; +link preview)",
                  "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8"}


def sniff_image(data):
    """Image type from the bytes themselves (never trust a server's label)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    return ""


def _cache_remote_image(image_url, prefix, *, minimum=1000, budget=5.0):
    """Download a preview once and serve it locally from /thumb/.

    Remote previews expire (signed CDN URLs), break when sites change, and leak
    every viewed domain to third parties on each render. A local copy fixes all
    three. Returns '' when the image is unavailable or not a real image.
    """
    code = prefix + hashlib.sha256(image_url.encode("utf-8")).hexdigest()[:24]
    existing = cached_thumb(code) if minimum >= 1000 else _cached_small(code)
    if existing:
        return existing
    try:
        deadline = time.monotonic() + budget
        response = safe_http.get(image_url, deadline=deadline, limit=safe_http.IMAGE_LIMIT, headers=_IMAGE_HEADERS)
    except safe_http.SafeHTTPError:
        return ""
    data = response.body
    kind = sniff_image(data)
    if not kind or len(data) < minimum or len(data) > safe_http.IMAGE_LIMIT:
        return ""
    return _install_bytes(code, data)


def _cached_small(code):
    local = os.path.join(THUMB_CACHE_DIR, code)
    if not os.path.islink(local) and os.path.isfile(local) and os.path.getsize(local) > 0:
        return f"/thumb/{code}"
    return ""


def _install_bytes(code, data):
    try:
        os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
        if os.path.islink(THUMB_CACHE_DIR):
            return ""
        local = os.path.join(THUMB_CACHE_DIR, code)
        with tempfile.NamedTemporaryFile(dir=THUMB_CACHE_DIR, prefix=code + ".", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(data)
        try:
            os.replace(temporary, local)
        except OSError:
            os.unlink(temporary)
            return ""
        return f"/thumb/{code}"
    except OSError:
        return ""


_favicon_lock = threading.Lock()
_favicons = OrderedDict()


def _favicon_for(page_url, icons, deadline):
    """Site icon, fetched at most once per host per process and cached locally."""
    try:
        parts = urlsplit(page_url)
        origin = f"{parts.scheme}://{parts.netloc}"
    except ValueError:
        return ""
    with _favicon_lock:
        if origin in _favicons:
            return _favicons[origin]
    candidates = [href for _, href in sorted(icons, key=lambda item: -item[0])] + ["/favicon.ico"]
    result = ""
    for href in candidates[:3]:
        if time.monotonic() >= deadline:
            break
        url = _http_link(href, page_url)
        if url:
            result = _cache_remote_image(url, "ico_", minimum=64, budget=min(3.0, max(0.5, deadline - time.monotonic())))
            if result:
                break
    with _favicon_lock:
        _favicons[origin] = result
        while len(_favicons) > 512:
            _favicons.popitem(last=False)
    return result


# ── Site-specific sources ─────────────────────────────────────────────────────

def _json(url, deadline, limit=256 * 1024):
    response = safe_http.get(url, deadline=deadline, limit=limit, headers={**_HEADERS, "Accept": "application/json"})
    return json.loads(_decode_html(response.body, response.headers.get("content-type", "")))


def _oembed_endpoint(url):
    """Providers whose oEmbed is the most reliable source of a preview image."""
    from urllib.parse import quote as _q
    target = _q(url, safe="")
    if _host_matches(url, "tiktok.com"):
        return f"https://www.tiktok.com/oembed?url={target}"
    if _host_matches(url, "vimeo.com"):
        return f"https://vimeo.com/api/oembed.json?url={target}"
    if _host_matches(url, "open.spotify.com"):
        return f"https://open.spotify.com/oembed?url={target}"
    if _host_matches(url, "x.com") or _host_matches(url, "twitter.com"):
        return f"https://publish.twitter.com/oembed?url={target}&omit_script=1&dnt=true"
    if _host_matches(url, "soundcloud.com"):
        return f"https://soundcloud.com/oembed?format=json&url={target}"
    return ""


def _strip_tags(html):
    return _clean_text(re.sub(r"<[^>]+>", " ", re.sub(r"<a [^>]*>(pic\.twitter\.com|https?://t\.co)[^<]*</a>", "", html)), 4000)


def _from_oembed(data):
    if not isinstance(data, dict):
        return {}
    text = lambda key: data.get(key) if isinstance(data.get(key), str) else ""
    summary = _strip_tags(text("html")) if text("type") == "rich" and "twitter" in text("provider_url") else ""
    return {"title": _clean_text(text("title"), 1000), "summary": summary, "image": text("thumbnail_url"),
            "author": _clean_text(text("author_name"), 200), "site": _clean_text(text("provider_name"), 200)}


def _reddit(url, deadline):
    parts = urlsplit(url)
    if not re.match(r"^/r/[^/]+/comments/", parts.path):
        return {}
    data = _json(f"https://www.reddit.com{parts.path.rstrip('/')}.json?raw_json=1&limit=1", deadline, limit=1024 * 1024)
    post = data[0]["data"]["children"][0]["data"] if isinstance(data, list) and data else {}
    if not isinstance(post, dict):
        return {}
    image = ""
    preview = post.get("preview") or {}
    if isinstance(preview, dict) and preview.get("images"):
        image = ((preview["images"][0] or {}).get("source") or {}).get("url", "")
    if not image and isinstance(post.get("thumbnail"), str) and post["thumbnail"].startswith("http"):
        image = post["thumbnail"]
    created = post.get("created_utc")
    published = ""
    if isinstance(created, (int, float)):
        from datetime import datetime, timezone
        published = datetime.fromtimestamp(created, timezone.utc).isoformat().replace("+00:00", "Z")
    return {"title": _clean_text(str(post.get("title") or ""), 1000),
            "summary": _clean_text(str(post.get("selftext") or ""), 4000),
            "image": image, "author": f"u/{post['author']}" if isinstance(post.get("author"), str) else "",
            "site": f"r/{post['subreddit']}" if isinstance(post.get("subreddit"), str) else "Reddit",
            "published": published}


def _arxiv_abstract_url(url):
    """arXiv PDF links have no preview; their abstract page does."""
    if not _host_matches(url, "arxiv.org"):
        return url
    parts = urlsplit(url)
    match = re.match(r"^/pdf/([^/?#]+?)(?:\.pdf)?/?$", parts.path)
    return f"https://arxiv.org/abs/{match.group(1)}" if match else url


# ── Fetch orchestration ───────────────────────────────────────────────────────

def _assemble(error="", *, title="", summary="", image_url="", thumbnail="", extra=None):
    result = _result(error, title=title, summary=summary, thumbnail=thumbnail)
    for key, value in (extra or {}).items():
        if value not in ("", None, 0):
            result[key] = value
    if image_url and not thumbnail:
        result["thumbnail"] = image_url
        result["status"] = "partial" if error else "ok"
    return result


_IG_EMBED_IMG_RE = re.compile(r'<img[^>]+class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>', re.I)
_IG_EMBED_CAPTION_RE = re.compile(r'<div[^>]+class="[^"]*\bCaption\b[^"]*"[^>]*>(.*?)</div>', re.I | re.S)
_IG_EMBED_USER_RE = re.compile(r'<a[^>]+class="[^"]*\bUsername\b[^"]*"[^>]*>(?:<span[^>]*>)?([^<]{1,60})<', re.I)


def _instagram_embed(url, deadline):
    """Best effort since Meta dropped oEmbed thumbnails (Nov 2025): the public
    embed page of a post often still carries its image and caption when the post
    page itself is behind the login wall. Returns {} when it does not."""
    match = _IG_CODE_RE.match(urlsplit(url).path)
    if not match:
        return {}
    embed = f"https://www.instagram.com/p/{match.group(1)}/embed/captioned/"
    try:
        response = safe_http.get(embed, deadline=deadline, headers=_HEADERS)
    except safe_http.SafeHTTPError:
        return {}
    page = _decode_html(response.body, response.headers.get("content-type", ""))
    found = {}
    tag = _IG_EMBED_IMG_RE.search(page)
    if tag:
        src = re.search(r'\ssrc="([^"]+)"', tag.group(0))
        if src:
            found["image"] = _html.unescape(src.group(1))
    caption = _IG_EMBED_CAPTION_RE.search(page)
    if caption:
        text = re.sub(r"<br\s*/?>", "\n", caption.group(1))
        text = _html.unescape(re.sub(r"<[^>]+>", " ", text))
        found["summary"] = re.sub(r"[ \t]+", " ", text).strip()
    user = _IG_EMBED_USER_RE.search(page)
    if user:
        found["author"] = _html.unescape(user.group(1)).strip()
    return found


def _crawler_friendly(url):
    return any(_host_matches(url, host) for host in _CRAWLER_FRIENDLY)


def _crawler_page(page_url, deadline):
    """Fetch the page as WhatsApp's link-preview crawler; None when that fails too."""
    try:
        response = safe_http.get(page_url, deadline=deadline, headers=_WHATSAPP_HEADERS)
    except safe_http.SafeHTTPError:
        return None
    content_type = response.headers.get("content-type", "").lower()
    if content_type.split(";", 1)[0].strip() not in ("text/html", "application/xhtml+xml"):
        return None
    parser = _MetadataParser()
    try:
        parser.feed(_decode_html(response.body, content_type))
        parser.close()
    except (AssertionError, ValueError):
        pass
    meta = parser.meta
    return {
        "title": meta.get("og:title") or meta.get("twitter:title") or "".join(parser.title),
        "summary": meta.get("og:description") or meta.get("twitter:description") or meta.get("description") or "",
        "image": meta.get("og:image:secure_url") or meta.get("og:image") or meta.get("twitter:image") or "",
        "site": meta.get("og:site_name") or "",
        "final": response.url,
    }


def _fetch_metadata(url, deadline):
    # Validate even specialized URLs before deriving a different endpoint.
    if _is_youtube(url):
        safe_http.validate_url(url, deadline)
        return _fetch_youtube_metadata(url, deadline)
    instagram = _is_instagram(url)
    page_url = _arxiv_abstract_url(url)

    special = {}
    endpoint = _oembed_endpoint(url)
    try:
        if endpoint:
            safe_http.validate_url(url, deadline)
            special = _from_oembed(_json(endpoint, deadline))
        elif _host_matches(url, "reddit.com"):
            safe_http.validate_url(url, deadline)
            special = _reddit(url, deadline)
    except (safe_http.SafeHTTPError, ValueError, KeyError, IndexError, TypeError):
        special = {}
    if special.get("title") and special.get("image") or (endpoint and special.get("title")):
        # oEmbed answered: no need to download the (often script-only) page.
        return _finish(url, url, special, "", [], None, deadline, instagram=False)

    try:
        response = safe_http.get(page_url, deadline=deadline, headers=_INSTAGRAM_HEADERS if instagram else _HEADERS)
    except safe_http.SafeHTTPError as exc:
        if special.get("title"):
            return _finish(url, url, special, "", [], None, deadline, instagram=False)
        crawler = (_crawler_page(page_url, deadline)
                   if exc.status in _BLOCKED_STATUS and _crawler_friendly(url) else None)
        if crawler and (crawler["image"] or crawler["title"]):
            return _finish(url, crawler["final"], crawler, "", [], None, deadline, instagram=instagram)
        embed = _instagram_embed(url, deadline) if instagram and exc.status not in (404, 410) else {}
        if embed.get("image"):
            return _finish(url, url, embed, "", [], None, deadline, instagram=True)
        result = _result(exc.code)
        if exc.status:
            result["httpStatus"] = exc.status
            if exc.status in (404, 410):
                result["linkStatus"] = "gone"
        return result
    content_type = response.headers.get("content-type", "").lower()
    if content_type.split(";", 1)[0].strip() not in ("text/html", "application/xhtml+xml"):
        result = _result()
        result["finalUrl"] = response.url
        return result
    parser = _MetadataParser()
    try:
        parser.feed(_decode_html(response.body, content_type))
        parser.close()
    except (AssertionError, ValueError):
        pass  # keep whatever was parsed before malformed markup
    safe_http.remaining(deadline)
    meta = parser.meta
    ld = _jsonld_fields(parser.jsonld)
    oembed = {}
    if not (meta.get("og:image") or meta.get("twitter:image") or ld.get("image")) and parser.links.get("oembed"):
        oembed_url = _http_link(parser.links["oembed"], response.url)
        if oembed_url:
            try:
                oembed = _from_oembed(_json(oembed_url, deadline))
            except (safe_http.SafeHTTPError, ValueError):
                oembed = {}
    fields = {
        "title": special.get("title") or meta.get("og:title") or meta.get("twitter:title") or meta.get("citation_title")
            or ld.get("title") or oembed.get("title") or "".join(parser.title),
        "summary": special.get("summary") or meta.get("og:description") or meta.get("twitter:description")
            or meta.get("description") or meta.get("citation_abstract") or ld.get("summary") or "",
        "image": special.get("image") or meta.get("og:image:secure_url") or meta.get("og:image") or meta.get("og:image:url")
            or meta.get("twitter:image") or meta.get("twitter:image:src") or ld.get("image") or oembed.get("image") or "",
        "site": special.get("site") or meta.get("og:site_name") or ld.get("site") or oembed.get("site") or "",
        "author": special.get("author") or (meta.get("author") if not meta.get("author", "").startswith("http") else "")
            or (meta.get("article:author") if not meta.get("article:author", "").startswith("http") else "")
            or meta.get("citation_author") or ld.get("author") or oembed.get("author") or "",
        "published": special.get("published") or meta.get("article:published_time") or meta.get("og:published_time")
            or meta.get("datepublished") or meta.get("citation_publication_date") or ld.get("published") or "",
        "canonical": parser.links.get("canonical") or meta.get("og:url") or "",
    }
    if not fields["image"] and _crawler_friendly(url) and not (instagram and _cached_instagram_path(url)):
        crawler = _crawler_page(page_url, deadline)
        if crawler:
            fields["image"] = crawler["image"]
            fields["summary"] = fields["summary"] or crawler["summary"]
            if not fields["title"] or fields["title"].strip().lower() in ("instagram", "facebook", "threads", "tiktok", "linkedin", "log in", "login"):
                fields["title"] = crawler["title"] or fields["title"]
    if instagram and not fields["image"] and not _cached_instagram_path(url):
        embed = _instagram_embed(url, deadline)
        fields["image"] = embed.get("image", "")
        fields["summary"] = fields["summary"] or embed.get("summary", "")
        fields["author"] = fields["author"] or embed.get("author", "")
    words = parser.article_words if parser.article_words >= 150 else parser.words
    return _finish(url, response.url, fields, parser.lang, parser.icons, words, deadline, instagram=instagram)


def _finish(url, final_url, fields, lang, icons, words, deadline, *, instagram):
    title = _clean_text(fields.get("title") or "", 1000)
    summary = _clean_text(fields.get("summary") or "", 4000)
    extra = {
        "siteName": _clean_text(fields.get("site") or "", 200),
        "author": _clean_text(fields.get("author") or "", 200),
        "publishedAt": _iso_date(fields.get("published")),
        "lang": lang if re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*", lang or "") else "",
        "canonicalUrl": _http_link(fields.get("canonical") or "", final_url),
        "finalUrl": final_url if final_url and final_url != safe_http.parse_url(url).url else "",
    }
    if words and words >= 150:
        extra["wordCount"] = int(words)
        extra["readingMinutes"] = max(1, round(words / 230))
    if extra["finalUrl"]:
        extra["linkStatus"] = "redirected"
    thumbnail, error, image_url = "", "", ""
    image = fields.get("image") or ""
    try:
        if instagram:
            thumbnail = _cached_instagram_path(url)
        if image and not thumbnail:
            image_url = _remote_image(image, final_url, deadline)
            if instagram:
                thumbnail = _cache_instagram_thumb(image_url, url, deadline, strict=True)
            else:
                # Prefer a local copy; fall back to the remote URL if it cannot be fetched.
                thumbnail = _cache_remote_image(image_url, "img_") or image_url
    except safe_http.SafeHTTPError as exc:
        error = exc.code
    # A site icon only for real pages (something to show next to it).
    if final_url and (title or thumbnail) and not instagram:
        extra["faviconUrl"] = _favicon_for(final_url, icons, min(deadline, time.monotonic() + 3))
    return _assemble(error, title=title, summary=summary, thumbnail=thumbnail, extra=extra)


# Bounded process-local duplicate suppression. No persistence or startup work.
_flight_lock = threading.Lock()
_inflight = {}
_recent = OrderedDict()
_COOLDOWN = 30.0
_CACHE_LIMIT = 128
_CONCURRENCY = 3


_host_gates = {}


def _host_gate(url):
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        host = ""
    with _flight_lock:
        gate = _host_gates.get(host)
        if gate is None:
            if len(_host_gates) > 256:
                _host_gates.clear()
            gate = _host_gates[host] = threading.BoundedSemaphore(2)
        return gate


def fetch_metadata(url):
    """Return compatible title/thumbnail plus summary and fixed status/error.

    Empty successful pages are valid. Every failure is sanitized and nonfatal.
    At most three unique URLs fetch concurrently; identical callers coalesce.
    """
    deadline = time.monotonic() + safe_http.TOTAL_TIMEOUT
    try:
        key = safe_http.parse_url(url).url
    except safe_http.SafeHTTPError as exc:
        return _result(exc.code)
    with _flight_lock:
        now = time.monotonic()
        expired = [key for key, (until, _) in _recent.items() if until <= now]
        for old in expired:
            del _recent[old]
        cached = _recent.get(key)
        if cached:
            _recent.move_to_end(key)
            return dict(cached[1])
        flight = _inflight.get(key)
        owner = flight is None
        if owner:
            if len(_inflight) >= _CONCURRENCY:
                return _result("busy")
            flight = {"event": threading.Event()}
            _inflight[key] = flight
    if not owner:
        if not flight["event"].wait(max(0, deadline - time.monotonic())):
            return _result("timeout")
        return dict(flight["result"])
    result = _result("internal_error")
    gate = _host_gate(key)
    try:
        # Politeness: at most two fetches per site at once, so a bulk import of
        # one domain never hammers it (and never trips its rate limiter).
        if not gate.acquire(timeout=max(0.0, min(3.0, deadline - time.monotonic()))):
            raise safe_http.SafeHTTPError("busy")
        try:
            result = _fetch_metadata(key, deadline)
        finally:
            gate.release()
    except safe_http.SafeHTTPError as exc:
        result = _result(exc.code)
    except Exception:
        result = _result("internal_error")
    finally:
        with _flight_lock:
            flight["result"] = dict(result)
            _recent[key] = (time.monotonic() + _COOLDOWN, dict(result))
            while len(_recent) > _CACHE_LIMIT:
                _recent.popitem(last=False)
            _inflight.pop(key, None)
            flight["event"].set()
    return result


def fetch_missing_metadata(max_posts: int = 200) -> int:
    """Existing explicit legacy batch; never invoked automatically here."""
    posts = storage.get_posts_missing_metadata(limit=max_posts)
    if not posts:
        print("[metadata] No posts missing metadata")
        return 0
    print(f"[metadata] Fetching metadata for {len(posts)} posts...")
    updated = 0

    def _fetch_one(post):
        meta = fetch_metadata(post["url"])
        return post["tg_msg_id"], meta

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(_fetch_one, p): p for p in posts}
        for future in as_completed(futures):
            try:
                tg_msg_id, meta = future.result()
                if meta["title"] or meta["thumbnail"]:
                    storage.update_metadata(tg_msg_id, meta["title"], meta["thumbnail"])
                    updated += 1
            except Exception:
                print("  [metadata] internal_error")
    print(f"[metadata] Done: {updated}/{len(posts)} posts updated with title/thumbnail")
    return updated


def refresh_instagram_thumbnails(max_posts: int = 500) -> int:
    """Existing explicit repair: preserve titles and prefer existing local files."""
    import sqlite3
    import config

    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT tg_msg_id, url, title, thumbnail FROM saved_posts "
        "WHERE url LIKE '%instagram.com%' AND thumbnail LIKE '%cdninstagram.com%' "
        "LIMIT ?",
        (max_posts,),
    ).fetchall()
    conn.close()
    if not rows:
        print("[metadata] No expired Instagram thumbnails to repair")
        return 0
    print(f"[metadata] Repairing {len(rows)} expired Instagram thumbnails...")
    updated = 0
    for row in rows:
        web_path = _cached_instagram_path(row["url"])
        if not web_path:
            meta = fetch_metadata(row["url"])
            if not (meta.get("thumbnail") or "").startswith("/thumb/"):
                print("  [metadata] Skip: no fresh thumbnail")
                continue
            web_path = meta["thumbnail"]
        storage.update_metadata(row["tg_msg_id"], row["title"] or "", web_path)
        updated += 1
    print(f"[metadata] Repaired {updated}/{len(rows)} Instagram thumbnails")
    return updated
