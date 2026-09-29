"""Lightweight, anonymous metadata using the shared validated HTTP boundary.

Instagram keeps its local thumbnail cache; generic previews remain remote URLs.
No database work or background scans occur on import or fetch_metadata().
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
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

_HEADERS = {"User-Agent": "SavedPostsMetadata/1.0", "Accept": "text/html,application/xhtml+xml"}
_INSTAGRAM_HEADERS = {"User-Agent": "facebookexternalhit/1.1",
                      "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9"}
THUMB_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumb_cache")
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
    title, thumbnail, error = "", "", ""
    try:
        thumb = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        safe_http.validate_url(thumb, deadline)
        thumbnail = thumb
        endpoint = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        response = safe_http.get(endpoint, deadline=deadline, headers=_HEADERS)
        data = json.loads(response.body.decode("utf-8"))
        if isinstance(data, dict) and isinstance(data.get("title"), str):
            title = _clean_text(data["title"], 1000)
    except safe_http.SafeHTTPError as exc:
        error = exc.code
    except (ValueError, UnicodeError):
        error = "network_error"
    return _result(error, title=title, thumbnail=thumbnail)


def _clean_text(value, limit):
    return " ".join(value.split())[:limit]


class _MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.title = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        if tag != "meta":
            return
        attributes = dict(attrs)
        key = (attributes.get("property") or attributes.get("name") or "").lower().strip()
        content = attributes.get("content")
        if key in ("og:title", "og:description", "description", "og:image", "twitter:image") and content:
            self.meta.setdefault(key, content.strip())

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, value):
        if self.in_title:
            self.title.append(value)


def _remote_image(value, page_url, deadline):
    if ("\\" in value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)):
        raise safe_http.SafeHTTPError("invalid_url")
    target, _ = safe_http.validate_url(urljoin(page_url, value), deadline)
    return target.url


def _fetch_metadata(url, deadline):
    # Validate even specialized URLs before deriving a different endpoint.
    if _is_youtube(url):
        safe_http.validate_url(url, deadline)
        return _fetch_youtube_metadata(url, deadline)
    instagram = _is_instagram(url)
    response = safe_http.get(url, deadline=deadline, headers=_INSTAGRAM_HEADERS if instagram else _HEADERS)
    content_type = response.headers.get("content-type", "").lower()
    if content_type.split(";", 1)[0].strip() not in ("text/html", "application/xhtml+xml"):
        return _result()
    charset = re.search(r"charset\s*=\s*[\"']?([a-zA-Z0-9._-]+)", content_type)
    encoding = charset.group(1) if charset else "utf-8"
    try:
        html = response.body.decode(encoding, errors="replace")
    except (LookupError, UnicodeError):
        html = response.body.decode("utf-8", errors="replace")
    parser = _MetadataParser()
    parser.feed(html)
    parser.close()
    safe_http.remaining(deadline)
    title = _clean_text(parser.meta.get("og:title") or "".join(parser.title), 1000)
    summary = _clean_text(parser.meta.get("og:description") or parser.meta.get("description", ""), 4000)
    thumbnail, error = "", ""
    image = parser.meta.get("og:image") or parser.meta.get("twitter:image", "")
    try:
        if instagram:
            thumbnail = _cached_instagram_path(url)
        if image and not thumbnail:
            image_url = _remote_image(image, response.url, deadline)
            thumbnail = (_cache_instagram_thumb(image_url, url, deadline, strict=True)
                         if instagram else image_url)
    except safe_http.SafeHTTPError as exc:
        error = exc.code
    return _result(error, title=title, summary=summary, thumbnail=thumbnail)


# Bounded process-local duplicate suppression. No persistence or startup work.
_flight_lock = threading.Lock()
_inflight = {}
_recent = OrderedDict()
_COOLDOWN = 30.0
_CACHE_LIMIT = 128
_CONCURRENCY = 3


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
    try:
        result = _fetch_metadata(key, deadline)
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
