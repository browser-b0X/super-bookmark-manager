"""
SQLite storage for saved posts.
Schema: one row per saved message, with JSON fields for flexible metadata.
"""

import ipaddress
import json
import re
import sqlite3
import unicodedata
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote, unquote, urlsplit

import config

RESERVED_SHELVES = {"other", "uncategorized"}
TOPICAL_SHELF_LIMIT = 12


def _connect(path=None) -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH if path is None else path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(path=None):
    """Create tables if they don't exist."""
    conn = _connect(path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS saved_posts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_msg_id   INTEGER UNIQUE NOT NULL,
            date_utc    TEXT    NOT NULL,
            text        TEXT,
            url         TEXT,
            source      TEXT,          -- 'instagram', 'x.com', 'youtube', 'other'
            category    TEXT    DEFAULT 'uncategorized',
            summary     TEXT,
            tags        TEXT    DEFAULT '[]',   -- JSON array
            title       TEXT,
            thumbnail   TEXT,
            raw_json    TEXT,          -- full message payload for debugging
            processed   INTEGER DEFAULT 0,
            created_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS library_items (
            url         TEXT PRIMARY KEY,
            id          TEXT UNIQUE,
            document    TEXT,
            deleted     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS legacy_adopted (
            url         TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS library_meta (
            key         TEXT PRIMARY KEY,
            value       INTEGER NOT NULL
        );

        -- Saved views (named filters), merged per view like links; a deleted view keeps
        -- its row with deleted_at for a while so the deletion reaches every browser.
        CREATE TABLE IF NOT EXISTS library_views (
            id          TEXT PRIMARY KEY,
            document    TEXT,
            updated_at  TEXT NOT NULL DEFAULT '',
            deleted_at  TEXT
        );

        -- Library documents (v0.4.0): tags (parents, other names) and creators, one row per document,
        -- merged per document like saved views; a deleted one keeps its row for a while.
        CREATE TABLE IF NOT EXISTS library_docs (
            kind        TEXT NOT NULL,
            id          TEXT NOT NULL,
            document    TEXT,
            updated_at  TEXT NOT NULL DEFAULT '',
            deleted_at  TEXT,
            PRIMARY KEY (kind, id)
        );

        CREATE TABLE IF NOT EXISTS library_purged (
            url         TEXT PRIMARY KEY,
            rev         INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS categories (
            name        TEXT    PRIMARY KEY,
            sort_order  INTEGER DEFAULT 0,
            created_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT    NOT NULL,
            done        INTEGER DEFAULT 0,
            priority    TEXT    DEFAULT 'normal',
            due         TEXT,
            category    TEXT    DEFAULT '',
            created_at  TEXT    NOT NULL,
            done_at     TEXT
        );

        CREATE TABLE IF NOT EXISTS notes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            content     TEXT    DEFAULT '',
            pinned      INTEGER DEFAULT 0,
            updated_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS captures (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT    DEFAULT 'note',
            content     TEXT    NOT NULL,
            created_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS layouts (
            key         TEXT    PRIMARY KEY,
            json        TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_category ON saved_posts(category);
        CREATE INDEX IF NOT EXISTS idx_source   ON saved_posts(source);
        CREATE INDEX IF NOT EXISTS idx_date     ON saved_posts(date_utc);
    """)
    # Migration: add title/thumbnail columns if upgrading from older schema
    try:
        conn.execute("ALTER TABLE saved_posts ADD COLUMN title TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass  # column already exists
    try:
        conn.execute("ALTER TABLE saved_posts ADD COLUMN thumbnail TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass  # column already exists
    for column in ("manual INTEGER DEFAULT 0", "swept_at TEXT"):
        try:
            conn.execute(f"ALTER TABLE saved_posts ADD COLUMN {column}")
        except sqlite3.OperationalError:
            pass  # column already exists
    _migrate_library_identity(conn)
    # Seed default categories if table is empty
    existing = conn.execute("SELECT COUNT(*) as c FROM categories").fetchone()["c"]
    if existing == 0:
        defaults = [
            "food-drink", "technology", "social-media", "health-fitness",
            "arts-culture", "entertainment", "business-money", "style-beauty",
            "travel", "other", "uncategorized",
        ]
        for i, name in enumerate(defaults):
            conn.execute(
                "INSERT OR IGNORE INTO categories (name, sort_order, created_at) VALUES (?, ?, ?)",
                (name, i, datetime.now(timezone.utc).isoformat()),
            )
    conn.commit()
    conn.close()


# ── The browser's spelling of a link ─────────────────────────────────────────
# The app stores each link as the browser writes it (`new URL(link).href`), and a
# link's saved files are named after that spelling. Telegram gives the text as
# typed (Unicode domains, spaces in a query, `..` in a path), so the photos and
# videos of a message are filed under the same spelling the importer will store,
# or the link panel would never find them. WHATWG URL rules, http(s) only.

_C0_OR_SPACE = "".join(chr(code) for code in range(0x21))
_PATH_KEEP = frozenset(chr(code) for code in range(0x21, 0x7f)) - set('"#<>?`{}')
_QUERY_KEEP = frozenset(chr(code) for code in range(0x21, 0x7f)) - set('"#<>\'')
_FRAGMENT_KEEP = frozenset(chr(code) for code in range(0x21, 0x7f)) - set('"<>`')
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|%\x7f") | frozenset(chr(code) for code in range(0x20))


def _encode(text, keep):
    return "".join(char if char in keep else "".join(f"%{byte:02X}" for byte in char.encode("utf-8")) for char in text)


def _ipv4(host):
    """The dotted address of a host that ends in a number, None when it doesn't, False when invalid."""
    parts = host.split(".")
    if parts and parts[-1] == "" and len(parts) > 1:
        parts = parts[:-1]
    last = parts[-1] if parts else ""
    if not (re.fullmatch(r"[0-9]+", last) or re.fullmatch(r"0[xX][0-9a-fA-F]*", last)):
        return None
    if len(parts) > 4:
        return False
    numbers = []
    for part in parts:
        if re.fullmatch(r"0[xX][0-9a-fA-F]*", part):
            numbers.append(int(part[2:] or "0", 16))
        elif re.fullmatch(r"0[0-7]+", part):
            numbers.append(int(part, 8))
        elif re.fullmatch(r"[0-9]+", part) and not (len(part) > 1 and part[0] == "0"):
            numbers.append(int(part))
        else:
            return False
    if any(number > 255 for number in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
        return False
    value = numbers[-1] + sum(number << (8 * (3 - index)) for index, number in enumerate(numbers[:-1]))
    return str(ipaddress.IPv4Address(value))


def _host(raw):
    if raw.startswith("["):
        if not raw.endswith("]") or "%" in raw:
            return None
        try:
            packed = ipaddress.IPv6Address(raw[1:-1]).packed
        except ValueError:
            return None
        # WHATWG spelling: hex pieces, the first longest run of two or more zeros as "::".
        pieces = [int.from_bytes(packed[index:index + 2], "big") for index in range(0, 16, 2)]
        start, length, index = -1, 1, 0
        while index < 8:
            stop = index
            while stop < 8 and pieces[stop] == 0:
                stop += 1
            if stop - index > length:
                start, length = index, stop - index
            index = max(stop, index + 1)
        hexes = [f"{piece:x}" for piece in pieces]
        text = ":".join(hexes) if start < 0 else ":".join(hexes[:start]) + "::" + ":".join(hexes[start + length:])
        return "[" + text + "]"
    try:
        decoded = unquote(raw, encoding="utf-8", errors="strict")
    except UnicodeError:
        return None
    decoded = unicodedata.normalize("NFKC", decoded.replace("\u3002", ".").replace("\uff0e", ".").replace("\uff61", ".")).lower()
    if not decoded or any(char in _FORBIDDEN_HOST for char in decoded):
        return None
    labels = []
    for label in decoded.split("."):
        if label.isascii():
            labels.append(label)
            continue
        try:
            labels.append("xn--" + label.encode("punycode").decode("ascii"))
        except UnicodeError:
            return None
    host = ".".join(labels)
    address = _ipv4(host)
    if address is False:
        return None
    return address or host


def browser_href(raw):
    """`new URL(raw).href` for an http(s) link, or None when a browser would refuse it."""
    if not isinstance(raw, str):
        return None
    url = re.sub(r"[\t\n\r]", "", raw.strip(_C0_OR_SPACE))
    match = re.match(r"([A-Za-z][A-Za-z0-9+.-]*):", url)
    if not match or match.group(1).lower() not in ("http", "https"):
        return None
    scheme = match.group(1).lower()
    rest = url[match.end():].lstrip("/\\")
    end = len(rest)
    for stop in "/\\?#":
        index = rest.find(stop)
        if index != -1:
            end = min(end, index)
    authority, rest = rest[:end], rest[end:]
    if "@" in authority:
        return None                       # a link with a user name: never a Saved Messages link worth guessing
    if authority.startswith("[") and "]" in authority:
        close = authority.index("]") + 1
        host_text, port_text = authority[:close], authority[close:]
        if port_text and not port_text.startswith(":"):
            return None
        port_text = port_text[1:]
    else:
        host_text, _, port_text = authority.partition(":")
    if port_text and not port_text.isdigit():
        return None
    host = _host(host_text)
    if not host:
        return None
    port = ""
    if port_text:
        number = int(port_text)
        if number > 65535:
            return None
        if number != (443 if scheme == "https" else 80):
            port = f":{number}"
    fragment = None
    if "#" in rest:
        rest, fragment = rest.split("#", 1)
    query = None
    if "?" in rest:
        rest, query = rest.split("?", 1)
    segments = []
    pieces = re.split(r"[/\\]", rest)[1:] if rest else []
    for index, piece in enumerate(pieces):
        last = index == len(pieces) - 1
        lowered = piece.lower()
        if lowered in ("..", ".%2e", "%2e.", "%2e%2e"):
            if segments:
                segments.pop()
            if last:
                segments.append("")
        elif lowered in (".", "%2e"):
            if last:
                segments.append("")
        else:
            segments.append(piece)
    try:
        path = "/" + "/".join(_encode(segment, _PATH_KEEP) for segment in segments) if segments else "/"
        href = f"{scheme}://{host}{port}{path}"
        if query is not None:
            href += "?" + _encode(query, _QUERY_KEEP)
        if fragment is not None:
            href += "#" + _encode(fragment, _FRAGMENT_KEEP)
    except UnicodeEncodeError:
        return None                       # a lone surrogate: not a link a browser can spell
    return href


def url_identity(url: str) -> str:
    """One link, however it was spelled: the key every library match uses.

    The browser stores `new URL(u).href` while older rows kept the raw string
    (no trailing slash, upper-case host, explicit default port). Matching on
    the raw string let a delete miss its row and a re-add create a twin.
    """
    try:
        p = urlsplit(url)
        port = p.port
        scheme = p.scheme.lower()
        if (scheme, port) in (("http", 80), ("https", 443)):
            port = None
        host = (p.hostname or "").lower()
        path = quote(p.path or "/", safe="/%:@!$&'()*+,;=-._~")
        userinfo = ""
        if p.username is not None:
            userinfo = p.username + (":" + p.password if p.password is not None else "") + "@"
        return f"{scheme}://{userinfo}{host}{':' + str(port) if port else ''}{path}" + \
            (f"?{p.query}" if p.query else "") + (f"#{p.fragment}" if p.fragment else "")
    except ValueError:
        return url


def _migrate_library_identity(conn):
    """Backfill identities and repair rows written before identity matching.

    * Tombstones no longer reserve an ID (a later import of a URL variant
      produced the same client ID and wedged every save with a 409).
    * A tombstone and a live row for the same link: the live row survived only
      because the delete was sent under another spelling. Honour the delete.
    * Two live rows for the same link: keep the most recently updated one.
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(library_items)")}
    if "ident" not in columns:
        conn.execute("ALTER TABLE library_items ADD COLUMN ident TEXT")
    if "rev" not in columns:
        # Change counter for delta sync: every write stamps the next number.
        conn.execute("ALTER TABLE library_items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0")
    conn.execute("INSERT OR IGNORE INTO library_meta (key, value) VALUES ('rev', 0)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_ident ON library_items(ident)")
    for row in conn.execute("SELECT url FROM library_items WHERE ident IS NULL").fetchall():
        conn.execute("UPDATE library_items SET ident = ? WHERE url = ?", (url_identity(row[0]), row[0]))
    conn.execute("UPDATE library_items SET id = NULL WHERE deleted = 1 AND id IS NOT NULL")
    groups = conn.execute("""
        SELECT ident FROM library_items GROUP BY ident HAVING COUNT(*) > 1
    """).fetchall()
    for (ident,) in groups:
        rows = conn.execute("SELECT rowid, url, deleted, document FROM library_items WHERE ident = ? ORDER BY rowid", (ident,)).fetchall()
        if any(r[2] for r in rows):
            keep = next(r for r in rows if r[2])
            conn.execute("UPDATE library_items SET document = NULL, deleted = 1, id = NULL WHERE rowid = ?", (keep[0],))
        else:
            def updated(r):
                try:
                    return json.loads(r[3]).get("updatedAt", "")
                except (TypeError, ValueError):
                    return ""
            keep = max(rows, key=updated)
            # Never lose curation from the twin being removed: fold its tags,
            # notes, favourite and pin into the copy that stays.
            try:
                kept = json.loads(keep[3])
                for r in rows:
                    if r[0] == keep[0]:
                        continue
                    other = json.loads(r[3])
                    kept["tags"] = list(dict.fromkeys([*kept.get("tags", []), *other.get("tags", [])]))
                    notes = [n for n in (kept.get("userNotes"), other.get("userNotes")) if isinstance(n, str) and n.strip()]
                    if len(set(notes)) > 1 or (notes and not kept.get("userNotes")):
                        kept["userNotes"] = "\n\n".join(dict.fromkeys(notes))
                    for flag in ("favorite", "pinned"):
                        if other.get(flag):
                            kept[flag] = True
                conn.execute("UPDATE library_items SET document = ? WHERE rowid = ?",
                             (json.dumps(kept, ensure_ascii=True, allow_nan=False), keep[0]))
            except (TypeError, ValueError):
                pass
        for r in rows:
            if r[0] != keep[0]:
                conn.execute("DELETE FROM library_items WHERE rowid = ?", (r[0],))


class LibraryValidationError(ValueError):
    """The complete library delta must be valid before any write."""


class LibraryConflictError(Exception):
    """One stable ID cannot identify two different full URLs."""


class LibraryReplacedError(LibraryConflictError):
    """A restore replaced the library after this client last read it: its copy is out of date."""


def _library_http_url(value) -> bool:
    if not isinstance(value, str) or not value:
        return False
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value) or "\\" in value:
        return False
    try:
        parsed = urlsplit(value)
        # Accessing port also validates malformed/non-numeric/out-of-range ports.
        return parsed.scheme in ("http", "https") and bool(parsed.hostname) and (parsed.port is None or parsed.port >= 0)
    except ValueError:
        return False


_REQUIRED_STRINGS = ("id", "url", "source", "platform", "domain", "status", "createdAt", "updatedAt", "metadataStatus")
_OPTIONAL_STRINGS = ("canonicalUrl", "sourceMessageId", "title", "description", "excerpt", "thumbnailUrl", "mediaType",
                     "userNotes", "aiSummary", "lastOpenedAt", "metadataError", "categoryMode", "importBatchId",
                     "siteName", "author", "publishedAt", "lang", "faviconUrl", "finalUrl", "linkStatus", "enrichedAt",
                     "metadataRetryAt", "originalTitle", "archivedAt", "archiveKey", "archiveError", "followUpAt",
                     "aiCheckedAt", "metadataTriedAt", "creatorId")
_ENUMS = {
    "source": ("telegram", "whatsapp", "manual", "browser", "import", "api"),
    "platform": ("instagram", "x", "youtube", "github", "reddit", "tiktok", "facebook", "threads", "linkedin",
                 "pinterest", "bluesky", "web", "pdf", "other"),
    "status": ("inbox", "to-review", "in-progress", "reference", "archived"),
    "metadataStatus": ("pending", "enriched", "partial", "failed", "none"),
    "mediaType": ("video", "image", "thread", "article", "repository", "document", "post", "other"),
    "categoryMode": ("manual", "automatic"),
    "linkStatus": ("ok", "redirected", "gone", "error"),
    # Saved copy of the page (archive.py): the file itself lives outside SQLite.
    "archiveStatus": ("pending", "saved", "failed", "too_large"),
}
_FIELD_SOURCES = ("file", "fetched", "user", "derived", "ai")
_ARCHIVE_KEY = re.compile(r"[0-9a-f]{32}")
# "Follow up by" is a calendar day on the owner's computer, not an instant.
_FOLLOW_UP_DAY = re.compile(r"\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])")


def _validate_post(post, label: str) -> str:
    """Validate one SavedPost and return its canonical JSON document."""
    if not isinstance(post, dict):
        raise LibraryValidationError(f"{label} must be a SavedPost object.")
    for field in _REQUIRED_STRINGS:
        if not isinstance(post.get(field), str):
            raise LibraryValidationError(f"{label}.{field} must be a string.")
    if not post["id"].strip() or not _library_http_url(post["url"]):
        raise LibraryValidationError(f"{label} requires a nonempty id and a valid HTTP(S) url.")
    for field in _OPTIONAL_STRINGS:
        if field in post and not isinstance(post[field], str):
            raise LibraryValidationError(f"{label}.{field} must be a string when supplied.")
    for field, choices in _ENUMS.items():
        if field in post and post[field] not in choices:
            raise LibraryValidationError(f"{label}.{field} is not a supported value.")
    for field in ("categories", "tags", "projectIds"):
        if not isinstance(post.get(field), list) or any(not isinstance(value, str) for value in post[field]):
            raise LibraryValidationError(f"{label}.{field} must be an array of strings.")
    if "folderPath" in post and (not isinstance(post["folderPath"], list) or any(not isinstance(v, str) for v in post["folderPath"])):
        raise LibraryValidationError(f"{label}.folderPath must be an array of strings when supplied.")
    for field in ("favorite", "pinned", "categoryReview", "archiveLimited", "archiveNoVideo", "useOften", "reviewed"):
        if field in post and not isinstance(post[field], bool):
            raise LibraryValidationError(f"{label}.{field} must be a boolean when supplied.")
    for field in ("wordCount", "readingMinutes", "httpStatus", "metadataAttempts", "position", "archiveBytes", "openCount"):
        if field in post and (type(post[field]) is not int or post[field] < 0):
            raise LibraryValidationError(f"{label}.{field} must be a non-negative integer when supplied.")
    if "creatorId" in post and not re.fullmatch(r"[a-z0-9-]{1,64}", post["creatorId"]):
        raise LibraryValidationError(f"{label}.creatorId is not a creator's id.")
    if "archiveKey" in post and not _ARCHIVE_KEY.fullmatch(post["archiveKey"]):
        raise LibraryValidationError(f"{label}.archiveKey is not a saved-copy key.")
    if "followUpAt" in post and not _FOLLOW_UP_DAY.fullmatch(post["followUpAt"]):
        raise LibraryValidationError(f"{label}.followUpAt must be a day as YYYY-MM-DD.")
    if "fieldSources" in post:
        sources = post["fieldSources"]
        if not isinstance(sources, dict) or any(not isinstance(k, str) or v not in _FIELD_SOURCES for k, v in sources.items()):
            raise LibraryValidationError(f"{label}.fieldSources must map field names to file, fetched, user, derived or ai.")
    if "telegramMessage" in post:
        message = post["telegramMessage"]
        if not isinstance(message, dict) or not isinstance(message.get("text"), str):
            raise LibraryValidationError(f"{label}.telegramMessage requires a text string.")
        for field in ("id", "date"):
            if field in message and not isinstance(message[field], str):
                raise LibraryValidationError(f"{label}.telegramMessage.{field} must be a string.")
    try:
        return json.dumps(post, ensure_ascii=True, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise LibraryValidationError(f"{label} must contain valid JSON values.") from exc


def _validate_url_list(data, key: str):
    values = data.get(key, [])
    if not isinstance(values, list) or any(not _library_http_url(url) for url in values):
        raise LibraryValidationError(f"{key} must contain only valid HTTP(S) URL strings.")
    return values


def _validate_category_ops(data):
    ops = data.get("categoryOps", [])
    if not isinstance(ops, list):
        raise LibraryValidationError("categoryOps must be an array.")
    for op in ops:
        kind = op.get("op") if isinstance(op, dict) else None
        names = {"add": ("name",), "delete": ("name",), "rename": ("from", "to")}.get(kind) if isinstance(kind, str) else None
        if names is None or set(op) != {"op", *names} or any(not isinstance(op[n], str) or not op[n].strip() for n in names):
            raise LibraryValidationError("categoryOps entries must be add/delete {name} or rename {from, to}.")
    return ops


_VIEW_KEYS = {"id", "name", "filter", "updatedAt"}
VIEW_LIMIT = 200
FORGET_VIEW_DELETIONS_DAYS = 30


_STAMP = re.compile(r"[0-9T:.+\-Z]{0,40}")


def _stamp(value) -> bool:
    """A change time as the browser writes it (or none): digits, T, colons, dots, signs and Z."""
    return isinstance(value, str) and _STAMP.fullmatch(value) is not None


def validate_view(view, where="view"):
    """A saved view as the browser keeps it: id, name, its filter and when it last changed."""
    if (not isinstance(view, dict) or not {"id", "name", "filter"} <= set(view) <= _VIEW_KEYS
            or not isinstance(view["id"], str) or not 0 < len(view["id"]) <= 64
            or not isinstance(view["name"], str) or not view["name"].strip() or len(view["name"]) > 200
            or not isinstance(view["filter"], dict) or len(json.dumps(view["filter"])) > 4000
            or not _stamp(view.get("updatedAt", ""))):
        raise LibraryValidationError(f"{where} must be a saved view (id, name, filter).")
    return view


def _plain_text(value, limit):
    """A short single-line name: no control or invisible characters (they could make a name show as another)."""
    return (isinstance(value, str) and 0 < len(value.strip()) and len(value) <= limit
            and not any(unicodedata.category(ch).startswith("C") for ch in value))


def validate_tag_doc(doc, where="tag"):
    """A tag's own document: its name (also its id), the tags it sits under and its other names."""
    names = lambda key: isinstance(doc.get(key), list) and len(doc[key]) <= 20 and all(_plain_text(v, 100) for v in doc[key])
    if (not isinstance(doc, dict) or set(doc) - {"id", "name", "parents", "aliases", "updatedAt"} or not {"id", "name"} <= set(doc)
            or not _plain_text(doc["name"], 100) or doc["id"] != doc["name"] or doc["name"] != doc["name"].strip().lower()
            or not names("parents") or not names("aliases") or doc["name"] in doc["parents"]
            or not _stamp(doc.get("updatedAt", ""))):
        raise LibraryValidationError(f"{where} must be a tag (name, parents, aliases).")
    return doc


_CREATOR_KEYS = {"id", "name", "aliases", "handles", "urls", "notes", "picture", "about", "reviewed", "seenAt", "kept", "updatedAt"}
_CREATOR_PLATFORMS = {"x", "instagram", "tiktok", "reddit", "youtube"}


def validate_creator_doc(doc, where="creator"):
    """A creator's document (v0.4.0): a name, other names, handles per site, profile pages, a note, an about line,
    a picture the app keeps itself (/thumb/…), the reviewed mark, when the owner last looked, refresh choices."""
    def short_list(key, limit, test):
        value = doc.get(key, [])
        return isinstance(value, list) and len(value) <= limit and all(test(v) for v in value)
    kept = doc.get("kept", {}) if isinstance(doc, dict) else None
    ok = (isinstance(doc, dict) and not set(doc) - _CREATOR_KEYS and {"id", "name"} <= set(doc)
          and isinstance(doc["id"], str) and re.fullmatch(r"[a-z0-9-]{1,64}", doc["id"]) is not None
          and _plain_text(doc["name"], 200)
          and short_list("aliases", 50, lambda v: _plain_text(v, 200))
          and short_list("handles", 20, lambda h: isinstance(h, dict) and set(h) == {"platform", "handle"}
                         and isinstance(h["platform"], str) and h["platform"] in _CREATOR_PLATFORMS
                         and isinstance(h["handle"], str) and re.fullmatch(r"[a-z0-9._-]{1,60}", h["handle"]) is not None)
          and short_list("urls", 20, lambda u: isinstance(u, str) and len(u) <= 500 and _library_http_url(u))
          and isinstance(doc.get("notes", ""), str) and len(doc.get("notes", "")) <= 2000
          and isinstance(doc.get("about", ""), str) and len(doc.get("about", "")) <= 1000
          and (doc.get("picture", "") == "" or (isinstance(doc.get("picture"), str) and re.fullmatch(r"/thumb/[A-Za-z0-9_-]{1,200}", doc["picture"]) is not None))
          and isinstance(doc.get("reviewed", False), bool) and _stamp(doc.get("seenAt", "")) and _stamp(doc.get("updatedAt", ""))
          and isinstance(kept, dict) and len(kept) <= 10
          and all(isinstance(k, str) and len(k) <= 40 and isinstance(v, str) and len(v) <= 2000 for k, v in kept.items()))
    if not ok:
        raise LibraryValidationError(f"{where} must be a creator (id, name, other names, handles, profile pages).")
    return doc


_REMOVED_KEYS = {"id", "url", "key", "how", "into", "post", "removedAt", "updatedAt"}


def validate_removed_doc(doc, where="removed link"):
    """A removed link's record (v0.4.0): its address, the post it is at any address (`key`), removed or merged
    into another link (`into`), and the link as it was, checked as a link is."""
    ok = (isinstance(doc, dict) and not set(doc) - _REMOVED_KEYS and {"id", "url", "how", "post", "removedAt"} <= set(doc)
          and isinstance(doc["id"], str) and re.fullmatch(r"r-[0-9a-f]{16}", doc["id"]) is not None
          and isinstance(doc["url"], str) and len(doc["url"]) <= 4096 and _library_http_url(doc["url"])
          and ("key" not in doc or isinstance(doc["key"], str) and re.fullmatch(r"[a-z]{1,10}:[A-Za-z0-9_-]{1,64}", doc["key"]) is not None)
          and doc["how"] in ("removed", "merged")
          and ("into" not in doc or isinstance(doc["into"], str) and len(doc["into"]) <= 4096 and _library_http_url(doc["into"]))
          and isinstance(doc["post"], dict) and doc["post"].get("url") == doc["url"]
          and _stamp(doc["removedAt"]) and _stamp(doc.get("updatedAt", "")))
    if not ok:
        raise LibraryValidationError(f"{where} must be a removed link (id, url, how, the link as it was).")
    if len(_validate_post(doc["post"], f"{where}.post")) > 20000:
        raise LibraryValidationError(f"{where}.post is too large.")
    return doc


DOC_KINDS = {"tags": validate_tag_doc, "creators": validate_creator_doc, "removed": validate_removed_doc}
# Kinds sent in a change-only answer only when they changed after it (removed links can be many and large):
# their last change's revision is kept in library_meta as "docs:<kind>".
LAZY_DOC_KINDS = {"removed"}
DOC_LIMIT = 5000


def _check_doc(kind, item, where):
    try:
        return DOC_KINDS[kind](item, where)
    except (TypeError, AttributeError) as exc:        # a field of a shape the checks didn't expect
        raise LibraryValidationError(f"{where} is malformed.") from exc


def _validate_docs(data, refused=None):
    """Tags and creators from a page or a backup. A malformed envelope is refused whole. A document or deletion mark
    that fails its check is refused whole too when `refused` is None (backups); a save passes a list instead, and only
    that document is left out and listed, so one bad record never stops the links and the other records."""
    docs = data.get("docs", {})
    deleted = data.get("deletedDocs", {})
    if not isinstance(docs, dict) or set(docs) - set(DOC_KINDS) or not isinstance(deleted, dict) or set(deleted) - set(DOC_KINDS):
        raise LibraryValidationError(f"docs must map kinds ({', '.join(DOC_KINDS)}) to lists of documents.")
    kept_docs, kept_marks = {}, {}
    for kind, items in docs.items():
        if not isinstance(items, list) or len(items) > DOC_LIMIT:
            raise LibraryValidationError(f"docs.{kind} must be a list of at most {DOC_LIMIT}.")
        kept_docs[kind] = []
        for index, item in enumerate(items):
            try:
                kept_docs[kind].append(_check_doc(kind, item, f"docs.{kind}[{index}]"))
            except LibraryValidationError as exc:
                if refused is None:
                    raise
                ident = item.get("id") if isinstance(item, dict) and isinstance(item.get("id"), str) else None
                refused.append({"kind": kind, "id": ident[:200] if ident else None, "reason": "invalid", "error": str(exc)})
    for kind, marks in deleted.items():
        if not isinstance(marks, dict) or (refused is None and len(marks) > DOC_LIMIT):
            raise LibraryValidationError(f"deletedDocs.{kind} must map ids to when each was deleted.")
        if len(marks) > DOC_LIMIT:
            # A page with more marks than SQLite keeps: the newest go in, the rest are listed (not the whole save refused).
            newest = sorted(marks.items(), key=lambda item: item[1] if isinstance(item[1], str) else "", reverse=True)
            refused.append({"kind": kind, "id": None, "reason": "too_many", "error": f"deletedDocs.{kind}: only the newest {DOC_LIMIT} are kept."})
            marks = dict(newest[:DOC_LIMIT])
        kept_marks[kind] = {}
        for key, value in marks.items():
            if _plain_text(key, 200) and _stamp(value):
                kept_marks[kind][key] = value
            elif refused is None:
                raise LibraryValidationError(f"deletedDocs.{kind} must map ids to when each was deleted.")
            else:
                refused.append({"kind": kind, "id": None, "reason": "invalid", "error": f"deletedDocs.{kind} must map ids to when each was deleted."})
    return kept_docs, kept_marks


def _apply_docs(conn, docs, deleted) -> set:
    """Merge documents and deletions from one browser, per document: the later change wins, and a deletion
    removes a document unless it changed after (as saved views do). The kinds that changed."""
    changed = set()
    for kind in set(docs) | set(deleted):
        rows = {row["id"]: row for row in conn.execute("SELECT id, document, updated_at, deleted_at FROM library_docs WHERE kind = ?", (kind,))}
        live = sum(1 for row in rows.values() if row["document"] is not None)
        for doc in docs.get(kind, []):
            at = doc.get("updatedAt", "")
            row = rows.get(doc["id"])
            if (row is None or row["document"] is None) and live >= DOC_LIMIT:
                continue                                # full: no new ones (backups and requests allow as many)
            if row is not None and row["deleted_at"] and row["deleted_at"] >= at:
                continue                                # deleted after this copy last changed
            if row is not None and row["document"] is not None and row["updated_at"] and row["updated_at"] >= at:
                continue                                # SQLite's copy is as new or newer
            conn.execute("INSERT INTO library_docs (kind, id, document, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL) "
                         "ON CONFLICT(kind, id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, deleted_at = NULL",
                         (kind, doc["id"], json.dumps(doc, ensure_ascii=True), at))
            if row is None or row["document"] is None:
                live += 1
            rows[doc["id"]] = {"id": doc["id"], "document": "x", "updated_at": at, "deleted_at": None}
            changed.add(kind)
        for doc_id, at in deleted.get(kind, {}).items():
            row = rows.get(doc_id)
            if row is not None and ((row["deleted_at"] or "") >= at or (row["document"] is not None and row["updated_at"] > at)):
                continue                                # already deleted, or changed after the deletion
            conn.execute("INSERT INTO library_docs (kind, id, document, updated_at, deleted_at) VALUES (?, ?, NULL, '', ?) "
                         "ON CONFLICT(kind, id) DO UPDATE SET document = NULL, deleted_at = excluded.deleted_at", (kind, doc_id, at))
            changed.add(kind)
    cutoff = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - FORGET_VIEW_DELETIONS_DAYS * 86400, timezone.utc)
    conn.execute("DELETE FROM library_docs WHERE document IS NULL AND deleted_at < ?", (cutoff.isoformat().replace("+00:00", "Z"),))
    return changed


def _docs(conn, since: int = 0) -> dict:
    left = set()
    for kind in LAZY_DOC_KINDS if since else ():
        row = conn.execute("SELECT value FROM library_meta WHERE key = ?", (f"docs:{kind}",)).fetchone()
        if not row or int(row[0]) <= since:
            left.add(kind)
    docs = {kind: [] for kind in DOC_KINDS if kind not in left}
    deleted = {kind: {} for kind in DOC_KINDS if kind not in left}
    for row in conn.execute("SELECT kind, id, document, deleted_at FROM library_docs ORDER BY rowid"):
        if row["kind"] not in docs:
            continue
        if row["document"] is not None:
            docs[row["kind"]].append(json.loads(row["document"]))
        elif row["deleted_at"]:
            deleted[row["kind"]][row["id"]] = row["deleted_at"]
    return {"docs": docs, "deletedDocs": deleted}


def _validate_views(data):
    views = data.get("views", [])
    deleted = data.get("deletedViews", {})
    if not isinstance(views, list) or len(views) > VIEW_LIMIT:
        raise LibraryValidationError(f"views must be a list of at most {VIEW_LIMIT} saved views.")
    for index, view in enumerate(views):
        validate_view(view, f"views[{index}]")
    if (not isinstance(deleted, dict) or len(deleted) > 1000
            or any(not isinstance(k, str) or not 0 < len(k) <= 64 or not _stamp(v) for k, v in deleted.items())):
        raise LibraryValidationError("deletedViews must map view ids to when each was deleted.")
    return views, deleted


def _apply_views(conn, views, deleted) -> bool:
    """Merge views and deletions from one browser: per view the later change wins, and a deletion
    removes a view unless it changed after. True when anything was written."""
    changed = False
    rows = {row["id"]: row for row in conn.execute("SELECT id, document, updated_at, deleted_at FROM library_views")}
    for view in views:
        at = view.get("updatedAt", "")
        row = rows.get(view["id"])
        if row is not None and (row["deleted_at"] or "") >= at and row["deleted_at"]:
            continue                                    # deleted after this copy last changed
        if row is not None and row["document"] is not None and row["updated_at"] >= at and row["updated_at"]:
            continue                                    # SQLite's copy is as new or newer
        if row is not None and row["document"] is not None and json.loads(row["document"]) == view:
            continue
        conn.execute("INSERT INTO library_views (id, document, updated_at, deleted_at) VALUES (?, ?, ?, NULL) "
                     "ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, deleted_at = NULL",
                     (view["id"], json.dumps(view, ensure_ascii=True), at))
        rows[view["id"]] = {"id": view["id"], "document": "x", "updated_at": at, "deleted_at": None}
        changed = True
    for view_id, at in deleted.items():
        row = rows.get(view_id)
        if row is not None and ((row["deleted_at"] or "") >= at or (row["document"] is not None and row["updated_at"] > at)):
            continue                                    # already deleted, or changed after the deletion
        conn.execute("INSERT INTO library_views (id, document, updated_at, deleted_at) VALUES (?, NULL, '', ?) "
                     "ON CONFLICT(id) DO UPDATE SET document = NULL, deleted_at = excluded.deleted_at", (view_id, at))
        changed = True
    cutoff = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - FORGET_VIEW_DELETIONS_DAYS * 86400, timezone.utc)
    conn.execute("DELETE FROM library_views WHERE document IS NULL AND deleted_at < ?", (cutoff.isoformat().replace("+00:00", "Z"),))
    return changed


def _views(conn) -> dict:
    views, deleted = [], {}
    for row in conn.execute("SELECT id, document, deleted_at FROM library_views ORDER BY rowid"):
        if row["document"] is not None:
            views.append(json.loads(row["document"]))
        elif row["deleted_at"]:
            deleted[row["id"]] = row["deleted_at"]
    return {"views": views, "deletedViews": deleted}


def _validate_library_delta(data):
    """Strict whole-delta validation, used by backup restore."""
    if not isinstance(data, dict) or not isinstance(data.get("posts"), list) or not isinstance(data.get("deletedUrls"), list):
        raise LibraryValidationError("Expected an object with posts and deletedUrls arrays.")
    documents = [_validate_post(post, f"posts[{index}]") for index, post in enumerate(data["posts"])]
    _validate_url_list(data, "deletedUrls")
    return documents


def _current_rev(conn) -> int:
    row = conn.execute("SELECT value FROM library_meta WHERE key = 'rev'").fetchone()
    return int(row[0]) if row else 0


def _current_epoch(conn) -> int:
    """Which library this is: 0 until a restore replaces it, then the revision of that restore."""
    row = conn.execute("SELECT value FROM library_meta WHERE key = 'epoch'").fetchone()
    return int(row[0]) if row else 0


def _next_rev(conn) -> int:
    """A counter that only ever grows (a MAX() over rows would shrink when an
    undelete or purge removes the newest row, and clients would miss writes)."""
    rev = _current_rev(conn) + 1
    conn.execute("INSERT INTO library_meta (key, value) VALUES ('rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (rev,))
    return rev


def _library_snapshot(conn, since: int = 0) -> dict:
    """Full library (since=0) or only what changed after revision `since`.

    A delta lists changed posts, tombstones written since then and links
    purged by an import undo; the client merges it into its own copy.
    """
    posts, deleted_urls, idents, live = [], [], set(), set()
    for row in conn.execute("SELECT document, url, deleted, ident, rev FROM library_items ORDER BY rowid"):
        idents.add(row["ident"])
        if not row["deleted"]:
            live.add(row["ident"])
        if since and row["rev"] <= since:
            continue
        if row["deleted"]:
            deleted_urls.append(row["url"])
        else:
            posts.append(json.loads(row["document"]))
    adopted = {row[0] for row in conn.execute("SELECT url FROM legacy_adopted")}
    # A legacy row is done once its link (in any spelling) is in the library,
    # deleted, or explicitly folded into an existing post by the client.
    legacy_rows = [
        dict(row) for row in conn.execute("SELECT * FROM saved_posts ORDER BY id")
        if _library_http_url(row["url"]) and row["url"] not in adopted and url_identity(row["url"]) not in idents
    ]
    categories = [row[0] for row in conn.execute("SELECT name FROM categories ORDER BY sort_order, name")]
    result = {"posts": posts, "deletedUrls": deleted_urls, "legacyRows": legacy_rows, "categories": categories,
              "rev": _current_rev(conn), "epoch": _current_epoch(conn), **_views(conn), **_docs(conn, since)}
    if since:
        result["since"] = since
        # A link removed by an import undo and imported again since is live: not purged.
        result["purgedUrls"] = [row[0] for row in conn.execute("SELECT url FROM library_purged WHERE rev > ?", (since,))
                                if url_identity(row[0]) not in live]
    return result


def get_library(since: int = 0) -> dict:
    """Read the library (or its changes after `since`) and unadopted legacy rows."""
    conn = _connect()
    try:
        with conn:
            conn.execute("BEGIN")
            result = _library_snapshot(conn, since if since and since <= _current_rev(conn) else 0)
        return result
    finally:
        conn.close()


def live_count() -> int:
    """How many links the library holds (deleted ones not counted)."""
    conn = _connect()
    try:
        return conn.execute("SELECT COUNT(*) FROM library_items WHERE deleted = 0").fetchone()[0]
    finally:
        conn.close()


def library_urls() -> dict:
    """{url_identity: stored url} for every live link (saved-copy restore checks against it)."""
    conn = _connect()
    try:
        return {row[0]: row[1] for row in conn.execute("SELECT ident, url FROM library_items WHERE deleted = 0")}
    finally:
        conn.close()


def deleted_identities() -> set:
    """url_identity of every link the owner deleted (a Telegram refresh keeps no photos for them)."""
    conn = _connect()
    try:
        return {row[0] for row in conn.execute("SELECT ident FROM library_items WHERE deleted = 1")}
    finally:
        conn.close()


def _backup_rows(conn) -> dict:
    """The library as a backup holds it: links, deletion markers and shelves."""
    return {
        "posts": [json.loads(row[0]) for row in conn.execute("SELECT document FROM library_items WHERE deleted = 0 ORDER BY rowid")],
        "tombstones": [dict(row) for row in conn.execute("SELECT url, id FROM library_items WHERE deleted = 1 ORDER BY rowid")],
        "categories": [dict(row) for row in conn.execute("SELECT name, sort_order, created_at FROM categories ORDER BY rowid")],
        "views": _views(conn)["views"],
        "docs": _docs(conn)["docs"],
    }


def get_backup_library(path=None) -> dict:
    """One consistent durable-library snapshot; never silently omit legacy links."""
    conn = _connect(path)
    try:
        with conn:
            conn.execute("BEGIN")
            if _library_snapshot(conn)["legacyRows"]:
                raise LibraryValidationError("Legacy links still need to finish loading and saving in Library. Retry export after SQLite confirms the save.")
            return _backup_rows(conn)
    finally:
        conn.close()


def replace_library(data) -> int:
    """Make the library in use exactly a validated backup's links, deletion markers and shelves.

    One transaction, checked before it commits: if anything is off, nothing changes. Returns the
    new epoch; a client still holding the replaced library is refused (LibraryReplacedError) when
    it tries to save, and reloads instead of writing old links back."""
    init_db()
    conn = _connect()
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            epoch = _next_rev(conn)
            conn.execute("DELETE FROM library_items")
            conn.execute("DELETE FROM library_purged")
            conn.execute("DELETE FROM categories")
            conn.executemany("INSERT INTO categories (name, sort_order, created_at) VALUES (:name, :sort_order, :created_at)", data["categories"])
            if "views" in data:                       # backups from before v0.4.0 have none: keep today's
                conn.execute("DELETE FROM library_views")
                conn.executemany("INSERT INTO library_views (id, document, updated_at) VALUES (?, ?, ?)",
                                 [(v["id"], json.dumps(v, ensure_ascii=True), v.get("updatedAt", "")) for v in data["views"]])
            if "docs" in data:                        # tags and creators (v0.4.0 phase 6): the same
                conn.execute("DELETE FROM library_docs")
                conn.executemany("INSERT INTO library_docs (kind, id, document, updated_at) VALUES (?, ?, ?, ?)",
                                 [(kind, d["id"], json.dumps(d, ensure_ascii=True), d.get("updatedAt", ""))
                                  for kind, items in data["docs"].items() for d in items])
            conn.executemany("INSERT INTO library_items (url, id, document, ident, rev) VALUES (?, ?, ?, ?, ?)",
                             [(p["url"], p["id"], json.dumps(p, ensure_ascii=True, allow_nan=False), url_identity(p["url"]), epoch)
                              for p in data["posts"]])
            conn.executemany("INSERT INTO library_items (url, id, deleted, ident, rev) VALUES (?, ?, 1, ?, ?)",
                             [(t["url"], t["id"], url_identity(t["url"]), epoch) for t in data["tombstones"]])
            conn.execute("INSERT INTO library_meta (key, value) VALUES ('epoch', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (epoch,))
            restored = _backup_rows(conn)
            if "views" not in data:
                restored.pop("views")
            if "docs" not in data:
                restored.pop("docs", None)
            elif "docs" in restored:                  # kinds a backup doesn't name come back empty
                restored["docs"] = {kind: items for kind, items in restored["docs"].items() if kind in data["docs"] or items}
            if restored != data:
                raise LibraryValidationError("The restored library did not match the backup, so nothing was changed.")
        return epoch
    finally:
        conn.close()


def _norm_shelf(name: str) -> str:
    return name.strip().lower().replace(" ", "-")


def _apply_category_op(conn, op) -> Optional[str]:
    """Apply one shelf change from the browser; return a rejection reason or None."""
    now = datetime.now(timezone.utc).isoformat()
    if op["op"] == "add":
        name = _norm_shelf(op["name"])
        if conn.execute("SELECT 1 FROM categories WHERE name = ?", (name,)).fetchone():
            return None
        try:
            _check_shelf_growth(_known_shelves(conn), {name})
        except LibraryValidationError:
            return "shelf_limit"
        order = (conn.execute("SELECT MAX(sort_order) FROM categories").fetchone()[0] or 0) + 1
        conn.execute("INSERT INTO categories (name, sort_order, created_at) VALUES (?, ?, ?)", (name, order, now))
        return None
    if op["op"] == "delete":
        name = op["name"]
        if name in RESERVED_SHELVES:
            return "reserved"
        conn.execute("UPDATE saved_posts SET category = 'uncategorized' WHERE category = ?", (name,))
        conn.execute("DELETE FROM categories WHERE name = ?", (name,))
        return None
    old, new = op["from"], _norm_shelf(op["to"])
    if old in RESERVED_SHELVES or new in RESERVED_SHELVES:
        return "reserved"
    if old == new:
        return None
    if conn.execute("SELECT 1 FROM categories WHERE name = ?", (new,)).fetchone():
        conn.execute("DELETE FROM categories WHERE name = ?", (old,))
    elif conn.execute("SELECT 1 FROM categories WHERE name = ?", (old,)).fetchone():
        conn.execute("UPDATE categories SET name = ? WHERE name = ?", (new, old))
    else:
        order = (conn.execute("SELECT MAX(sort_order) FROM categories").fetchone()[0] or 0) + 1
        conn.execute("INSERT INTO categories (name, sort_order, created_at) VALUES (?, ?, ?)", (new, order, now))
    conn.execute("UPDATE saved_posts SET category = ? WHERE category = ?", (new, old))
    return None


def save_library(data) -> dict:
    """Validate and atomically apply a delta; return committed state plus rejections.

    One bad item never blocks the rest: invalid posts, stale writes, ID
    collisions and shelf-limit breaches come back in `rejected` with a reason
    while everything else commits. Only a malformed envelope is refused whole.
    """
    if not isinstance(data, dict) or not isinstance(data.get("posts"), list) or not isinstance(data.get("deletedUrls"), list):
        raise LibraryValidationError("Expected an object with posts and deletedUrls arrays.")
    deleted_urls = _validate_url_list(data, "deletedUrls")
    undelete_urls = _validate_url_list(data, "undeleteUrls")
    adopted_urls = _validate_url_list(data, "adoptedUrls")
    # Undoing an import removes its untouched links outright (no tombstone), so
    # the same file can be imported again later.
    purge_urls = _validate_url_list(data, "purgeUrls")
    # When the client last saw each link it purges: a link changed since stays (and is sent back).
    purge_seen = data.get("purgeSeen", {})
    if not isinstance(purge_seen, dict) or any(not isinstance(url, str) or not isinstance(seen, str) or len(seen) > 64
                                               for url, seen in purge_seen.items()):
        raise LibraryValidationError("purgeSeen must map URLs to the time each was last seen.")
    category_ops = _validate_category_ops(data)
    # Writers that read a link and change a few fields (the Claude Desktop extension) say which version they read:
    # a link saved since is refused as stale rather than overwritten with the older fields.
    if_updated = data.get("ifUpdatedAt", {})
    if not isinstance(if_updated, dict) or any(not isinstance(url, str) or not isinstance(seen, str) or len(seen) > 64
                                               for url, seen in if_updated.items()):
        raise LibraryValidationError("ifUpdatedAt must map URLs to the updatedAt each was read with.")
    # Saved views (named filters), merged per view (see _apply_views); pages before v0.4.0 send none.
    views, deleted_views = _validate_views(data)
    # Tags and creators, merged per document (see _apply_docs); pages before phase 6 send none.
    refused_docs = []
    docs, deleted_docs = _validate_docs(data, refused_docs)
    since = data.get("since", 0)
    if type(since) is not int or since < 0:
        raise LibraryValidationError("since must be a non-negative integer.")
    # Which library the client's copy is of (see replace_library); absent from pages that predate restores.
    epoch = data.get("epoch")
    if epoch is not None and (type(epoch) is not int or epoch < 0):
        raise LibraryValidationError("epoch must be a non-negative integer.")
    rejected, accepted = [], []
    for index, post in enumerate(data["posts"]):
        try:
            accepted.append((post, _validate_post(post, f"posts[{index}]")))
        except LibraryValidationError as exc:
            url = post.get("url") if isinstance(post, dict) and isinstance(post.get("url"), str) else ""
            pid = post.get("id") if isinstance(post, dict) and isinstance(post.get("id"), str) else ""
            rejected.append({"url": url, "id": pid, "reason": "invalid", "error": str(exc)})
    conn = _connect()
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            # A copy read before a restore would bring the replaced library's links and edits
            # back. A page too old to send an epoch has never seen one: it counts as 0.
            if (epoch or 0) != _current_epoch(conn):
                raise LibraryReplacedError("This library was replaced by a restore. Reload the page to see it; nothing was saved.")
            stamp = []

            def rev():
                # Allocate a revision only when something is actually written,
                # so a fully rejected delta leaves the library (and its rev) unchanged.
                if not stamp:
                    stamp.append(_next_rev(conn))
                return stamp[0]
            rejected_ops = []
            for op in category_ops:
                reason = _apply_category_op(conn, op)
                if reason:
                    rejected_ops.append({**op, "reason": reason})
            for url in undelete_urls:
                conn.execute("DELETE FROM library_items WHERE ident = ? AND deleted = 1", (url_identity(url),))
            spellings = []

            def stored_ident(url):
                """The row a link names. Rows saved by older builds may hold the link as typed
                (Unicode domain, unencoded query) while the app now sends the browser's spelling."""
                ident = url_identity(url)
                if conn.execute("SELECT 1 FROM library_items WHERE ident = ?", (ident,)).fetchone():
                    return ident
                if not spellings:
                    index = {}
                    for row in conn.execute("SELECT url, ident FROM library_items"):
                        href = browser_href(row["url"])
                        if href and href != row["url"]:
                            index.setdefault(url_identity(href), row["ident"])
                    spellings.append(index)
                return spellings[0].get(ident, ident)
            removed_urls, kept_idents, kept_urls = [], set(), []
            for url in purge_urls:
                ident = stored_ident(url)
                stored = conn.execute("SELECT url, document FROM library_items WHERE ident = ? AND deleted = 0", (ident,)).fetchone()
                seen = purge_seen.get(url)
                if stored and seen is not None:
                    changed = json.loads(stored["document"]).get("updatedAt")
                    if isinstance(changed, str) and changed > seen:
                        kept_idents.add(ident)     # edited after the undo's view of it: keep it
                        kept_urls.append(url)
                        continue
                removed = conn.execute("DELETE FROM library_items WHERE ident = ? AND deleted = 0", (ident,)).rowcount
                if removed:
                    removed_urls.append(stored["url"])
                    conn.execute("INSERT INTO library_purged (url, rev) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET rev = excluded.rev", (url, rev()))
            # Deletions take precedence over every upsert, including unseen URLs.
            for url in deleted_urls:
                ident = stored_ident(url)
                stored = conn.execute("SELECT url FROM library_items WHERE ident = ? AND deleted = 0", (ident,)).fetchone()
                if stored and stored["url"] != url:
                    removed_urls.append(stored["url"])
                if conn.execute("SELECT 1 FROM library_items WHERE ident = ?", (ident,)).fetchone():
                    conn.execute("UPDATE library_items SET document = NULL, deleted = 1, id = NULL, rev = ? WHERE ident = ?", (rev(), ident))
                else:
                    conn.execute("INSERT INTO library_items (url, deleted, ident, rev) VALUES (?, 1, ?, ?)", (url, ident, rev()))
            # Shelves already in use by documents this delta does not replace.
            replacing = {url_identity(post["url"]) for post, _ in accepted}
            known = {row[0] for row in conn.execute("SELECT name FROM categories")}
            for row in conn.execute("SELECT document, ident FROM library_items WHERE deleted = 0"):
                if row["ident"] not in replacing:
                    known.update(json.loads(row["document"]).get("categories", []))
            in_use = set(known)
            batch_ids = {}
            for post, document in accepted:
                ident = url_identity(post["url"])

                def reject(reason, error=""):
                    rejected.append({"url": post["url"], "id": post["id"], "reason": reason, **({"error": error} if error else {})})

                owner = conn.execute("SELECT ident FROM library_items WHERE id = ?", (post["id"],)).fetchone()
                if (owner and owner["ident"] != ident) or batch_ids.get(post["id"], ident) != ident:
                    reject("id_conflict", "This ID already belongs to a different link.")
                    continue
                existing = conn.execute("SELECT id, deleted, document FROM library_items WHERE ident = ?", (ident,)).fetchone()
                if existing and existing["deleted"]:
                    reject("deleted", "This link was deleted.")
                    continue
                if post["url"] in if_updated and (not existing or json.loads(existing["document"]).get("updatedAt") != if_updated[post["url"]]):
                    reject("stale", "This link changed since it was read.")
                    continue
                if existing and existing["id"] != post["id"]:
                    # A re-import under another ID never replaces existing curation.
                    reject("duplicate_url", "This link is already saved under another ID.")
                    continue
                if existing:
                    stored = json.loads(existing["document"])
                    if isinstance(stored.get("updatedAt"), str) and stored["updatedAt"] > post["updatedAt"]:
                        reject("stale", "A newer version of this link is already saved.")
                        continue
                if post.get("categoryMode") == "automatic" and not set(post["categories"]).issubset(known | RESERVED_SHELVES):
                    reject("unknown_shelf", "Automatic categorization may only assign existing shelves.")
                    continue
                try:
                    _check_shelf_growth(in_use, set(post["categories"]))
                except LibraryValidationError as exc:
                    reject("shelf_limit", str(exc))
                    continue
                in_use.update(post["categories"])
                batch_ids[post["id"]] = ident
                if existing:
                    conn.execute("UPDATE library_items SET document = ?, rev = ? WHERE ident = ?", (document, rev(), ident))
                else:
                    conn.execute("INSERT INTO library_items (url, id, document, ident, rev) VALUES (?, ?, ?, ?, ?)",
                                 (post["url"], post["id"], document, ident, rev()))
            for url in adopted_urls:
                conn.execute("INSERT OR IGNORE INTO legacy_adopted (url) VALUES (?)", (url,))
            _apply_views(conn, views, deleted_views)
            for kind in _apply_docs(conn, docs, deleted_docs) & LAZY_DOC_KINDS:
                conn.execute("INSERT INTO library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                             (f"docs:{kind}", rev()))
            result = _library_snapshot(conn, since if since and since <= _current_rev(conn) else 0)
            # A refused write leaves the client showing its own version. A change-only
            # answer would not include the link (SQLite didn't write it), so send what
            # SQLite holds for every refused link: the client then shows that instead.
            # The same for a purge refused because the link changed since the undo saw it.
            if result.get("since"):
                listed = {url_identity(post["url"]) for post in result["posts"]} | {url_identity(url) for url in result["deletedUrls"]}
                refused = [url_identity(item["url"]) for item in rejected
                           if item["reason"] in ("stale", "duplicate_url", "deleted") and item["url"]]
                for ident in [*refused, *sorted(kept_idents)]:
                    row = conn.execute("SELECT document, url, deleted FROM library_items WHERE ident = ?", (ident,)).fetchone()
                    if row is None or ident in listed:
                        continue
                    listed.add(ident)
                    if row["deleted"]:
                        result["deletedUrls"].append(row["url"])
                    else:
                        result["posts"].append(json.loads(row["document"]))
        # The transaction context commits before callers can acknowledge this result.
        # removedUrls: the stored spelling of links removed under another spelling, so
        # their saved copies (named after the stored spelling) go too.
        return {**result, "rejected": rejected, **({"rejectedOps": rejected_ops} if rejected_ops else {}),
                **({"rejectedDocs": refused_docs} if refused_docs else {}),
                **({"removedUrls": removed_urls} if removed_urls else {}),
                **({"keptUrls": kept_urls} if kept_urls else {})}
    finally:
        conn.close()


def saved_link(url):
    """The saved (not deleted) link with this address in any spelling the library treats as the same,
    or None: {"title", "categories"} only, for the extension's "already saved" check."""
    if not _library_http_url(url):
        return None
    conn = _connect()
    try:
        row = conn.execute("SELECT document FROM library_items WHERE ident = ? AND deleted = 0", (url_identity(url),)).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    document = json.loads(row[0])
    return {"title": document.get("title") or "", "categories": document.get("categories") or []}


def post_exists(tg_msg_id: int) -> bool:
    conn = _connect()
    row = conn.execute(
        "SELECT 1 FROM saved_posts WHERE tg_msg_id = ?", (tg_msg_id,)
    ).fetchone()
    conn.close()
    return row is not None


def insert_post(
    tg_msg_id: int,
    date_utc: str,
    text: Optional[str],
    url: Optional[str],
    source: str,
    raw_json: str,
) -> int:
    """Insert a new post. Returns the row id."""
    conn = _connect()
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO saved_posts
            (tg_msg_id, date_utc, text, url, source, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (tg_msg_id, date_utc, text, url, source, raw_json, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def update_classification(tg_msg_id: int, category: str, summary: str, tags: list[str]):
    conn = _connect()
    conn.execute(
        """
        UPDATE saved_posts
           SET category = ?, summary = ?, tags = ?, processed = 1, swept_at = ?
         WHERE tg_msg_id = ?
        """,
        (category, summary, json.dumps(tags), datetime.now(timezone.utc).isoformat(), tg_msg_id),
    )
    conn.commit()
    conn.close()


def update_metadata(tg_msg_id: int, title: str, thumbnail: str):
    conn = _connect()
    conn.execute(
        "UPDATE saved_posts SET title = ?, thumbnail = ? WHERE tg_msg_id = ?",
        (title, thumbnail, tg_msg_id),
    )
    conn.commit()
    conn.close()


def update_post(tg_msg_id: int, title: str, summary: str, category: str, tags: list[str]):
    """Update editable fields of a post."""
    conn = _connect()
    conn.execute(
        """
        UPDATE saved_posts
           SET title = ?, summary = ?, category = ?, tags = ?, processed = 1, manual = 1
         WHERE tg_msg_id = ?
        """,
        (title, summary, category, json.dumps(tags), tg_msg_id),
    )
    conn.commit()
    conn.close()


def delete_post(tg_msg_id: int) -> bool:
    """Delete a post by Telegram message ID. Returns True if a row was deleted."""
    conn = _connect()
    cur = conn.execute("DELETE FROM saved_posts WHERE tg_msg_id = ?", (tg_msg_id,))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    return deleted


def get_posts_missing_metadata(limit: int = 50) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        """
        SELECT tg_msg_id, url, title
          FROM saved_posts
         WHERE url IS NOT NULL AND url != '' AND (title IS NULL OR title = '')
         ORDER BY date_utc DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_unprocessed_posts(limit: int = 50, untagged_only: bool = False) -> list[dict]:
    conn = _connect()
    # untagged_only: re-classify posts still parked in the catch-all
    # categories instead of never-seen posts (used by Bulk categorize).
    # A post the owner filed by hand is never swept, and posts the sweep has
    # already visited go to the back so older ones are eventually reached.
    where = ("category IN ('uncategorized', 'other') AND COALESCE(manual, 0) = 0" if untagged_only
             else "processed = 0")
    order = "swept_at IS NOT NULL, swept_at, date_utc DESC" if untagged_only else "date_utc DESC"
    rows = conn.execute(
        f"""
        SELECT tg_msg_id, title, text, url, source
          FROM saved_posts
         WHERE {where}
         ORDER BY {order}
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_posts(
    query: str = "",
    category: str = "",
    source: str = "",
    limit: int = 200,
) -> list[dict]:
    conn = _connect()
    conditions = []
    params = []

    if query:
        conditions.append("(text LIKE ? OR summary LIKE ? OR url LIKE ?)")
        like = f"%{query}%"
        params.extend([like, like, like])
    if category:
        conditions.append("category = ?")
        params.append(category)
    if source:
        conditions.append("source = ?")
        params.append(source)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    params.append(limit)

    rows = conn.execute(
        f"""
        SELECT *
          FROM saved_posts
          {where}
         ORDER BY date_utc DESC
         LIMIT ?
        """,
        params,
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_categories() -> list[str]:
    """Return all categories from the categories table, sorted by order then name."""
    conn = _connect()
    rows = conn.execute(
        "SELECT name FROM categories ORDER BY sort_order, name"
    ).fetchall()
    conn.close()
    return [r["name"] for r in rows]


def _known_shelves(conn) -> set[str]:
    names = {row[0] for row in conn.execute("SELECT name FROM categories")}
    # C4 documents may retain pre-existing browser-only category choices.
    for row in conn.execute("SELECT document FROM library_items WHERE deleted = 0"):
        names.update(json.loads(row[0]).get("categories", []))
    return names


def _check_shelf_growth(existing: set[str], incoming: set[str]):
    before = existing - RESERVED_SHELVES
    after = (existing | incoming) - RESERVED_SHELVES
    # Existing owner taxonomies are never consolidated as a side effect.
    if len(after) > TOPICAL_SHELF_LIMIT and after - before:
        raise LibraryValidationError("At most 12 topical shelves are allowed, plus other and uncategorized.")


def add_category(name: str) -> bool:
    """Add a new category. Returns True if created, False if already exists."""
    name = name.strip().lower().replace(" ", "-")
    if not name:
        return False
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _check_shelf_growth(_known_shelves(conn), {name})
        max_order = conn.execute("SELECT MAX(sort_order) as m FROM categories").fetchone()["m"] or 0
        conn.execute(
            "INSERT INTO categories (name, sort_order, created_at) VALUES (?, ?, ?)",
            (name, max_order + 1, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def delete_category(name: str) -> int:
    """Delete a category and move its posts to 'uncategorized'. Returns count of moved posts."""
    if name in RESERVED_SHELVES:
        return 0  # can't delete the default category
    conn = _connect()
    # Move posts to uncategorized
    cur = conn.execute(
        "UPDATE saved_posts SET category = 'uncategorized' WHERE category = ?",
        (name,),
    )
    moved = cur.rowcount
    conn.execute("DELETE FROM categories WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    return moved


def rename_category(old_name: str, new_name: str) -> bool:
    """Rename a category. Returns True on success."""
    new_name = new_name.strip().lower().replace(" ", "-")
    if not new_name or old_name == new_name or old_name in RESERVED_SHELVES or new_name in RESERVED_SHELVES:
        return False
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        # A rename may leave the old name in durable library documents. Count
        # those retained names too instead of permitting growth through renames.
        known = _known_shelves(conn)
        retained = any(old_name in json.loads(row[0]).get("categories", []) for row in conn.execute("SELECT document FROM library_items WHERE deleted = 0"))
        _check_shelf_growth(known if retained else known - {old_name}, {new_name})
        conn.execute("UPDATE categories SET name = ? WHERE name = ?", (new_name, old_name))
        conn.execute("UPDATE saved_posts SET category = ? WHERE category = ?", (new_name, old_name))
        conn.commit()
        return True
    except (sqlite3.IntegrityError, LibraryValidationError):
        return False
    finally:
        conn.close()


def set_post_category(tg_msg_id: int, category: str):
    """Update only the category of a post, preserving other fields."""
    conn = _connect()
    conn.execute(
        "UPDATE saved_posts SET category = ?, manual = 1 WHERE tg_msg_id = ?",
        (category, tg_msg_id),
    )
    conn.commit()
    conn.close()


def get_stats() -> dict:
    conn = _connect()
    total = conn.execute("SELECT COUNT(*) as c FROM saved_posts").fetchone()["c"]
    by_cat = conn.execute(
        "SELECT category, COUNT(*) as c FROM saved_posts GROUP BY category ORDER BY c DESC"
    ).fetchall()
    by_src = conn.execute(
        "SELECT source, COUNT(*) as c FROM saved_posts GROUP BY source ORDER BY c DESC"
    ).fetchall()
    conn.close()
    return {
        "total": total,
        "by_category": {r["category"]: r["c"] for r in by_cat},
        "by_source": {r["source"]: r["c"] for r in by_src},
    }


# ── Tasks ──────────────────────────────────────────────────────────────────────

def list_tasks(include_done: bool = True) -> list[dict]:
    conn = _connect()
    q = "SELECT * FROM tasks"
    if not include_done:
        q += " WHERE done = 0"
    q += " ORDER BY done ASC, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id DESC"
    rows = conn.execute(q).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_task(title: str, priority: str = "normal", due: str = "", category: str = "") -> int:
    conn = _connect()
    cur = conn.execute(
        "INSERT INTO tasks (title, priority, due, category, created_at) VALUES (?, ?, ?, ?, ?)",
        (title, priority, due, category, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def update_task(task_id: int, **fields):
    allowed = {"title", "done", "priority", "due", "category"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        sets.append(f"{k} = ?")
        params.append(v)
        if k == "done":
            sets.append("done_at = ?")
            params.append(datetime.now(timezone.utc).isoformat() if v else None)
    if not sets:
        return
    params.append(task_id)
    conn = _connect()
    conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    conn.close()


def delete_task(task_id: int):
    conn = _connect()
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()


# ── Notes ──────────────────────────────────────────────────────────────────────

def get_note() -> dict:
    conn = _connect()
    row = conn.execute("SELECT * FROM notes ORDER BY id LIMIT 1").fetchone()
    conn.close()
    return dict(row) if row else {"id": None, "content": "", "pinned": 0, "updated_at": ""}


def save_note(content: str, pinned: int = None):
    conn = _connect()
    existing = conn.execute("SELECT id FROM notes ORDER BY id LIMIT 1").fetchone()
    now = datetime.now(timezone.utc).isoformat()
    if existing:
        if pinned is None:
            conn.execute("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?",
                         (content, now, existing["id"]))
        else:
            conn.execute("UPDATE notes SET content = ?, pinned = ?, updated_at = ? WHERE id = ?",
                         (content, pinned, now, existing["id"]))
    else:
        conn.execute("INSERT INTO notes (content, pinned, updated_at) VALUES (?, ?, ?)",
                     (content, pinned or 0, now))
    conn.commit()
    conn.close()


# ── Captures ───────────────────────────────────────────────────────────────────

def list_captures(limit: int = 20) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM captures ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_capture(type_: str, content: str) -> int:
    conn = _connect()
    cur = conn.execute(
        "INSERT INTO captures (type, content, created_at) VALUES (?, ?, ?)",
        (type_, content, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def delete_capture(capture_id: int):
    conn = _connect()
    conn.execute("DELETE FROM captures WHERE id = ?", (capture_id,))
    conn.commit()
    conn.close()


# ── Layout persistence ─────────────────────────────────────────────────────────

def get_layout(key: str) -> Optional[str]:
    conn = _connect()
    row = conn.execute("SELECT json FROM layouts WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["json"] if row else None


def save_layout(key: str, json_str: str):
    conn = _connect()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO layouts (key, json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at""",
        (key, json_str, now),
    )
    conn.commit()
    conn.close()


# ── Timeline (aggregated activity) ─────────────────────────────────────────────

def get_activity(limit: int = 12) -> list[dict]:
    conn = _connect()
    events = []
    for r in conn.execute("SELECT * FROM captures ORDER BY id DESC LIMIT ?", (limit,)).fetchall():
        events.append({"kind": "capture", "icon": "zap", "text": f"Captured {r['type']}",
                       "detail": r["content"][:80], "time": r["created_at"]})
    for r in conn.execute("SELECT * FROM tasks WHERE done = 1 ORDER BY done_at DESC LIMIT ?", (limit,)).fetchall():
        if r["done_at"]:
            events.append({"kind": "task", "icon": "check", "text": "Completed task",
                           "detail": r["title"][:80], "time": r["done_at"]})
    for r in conn.execute("SELECT * FROM saved_posts ORDER BY id DESC LIMIT ?", (limit,)).fetchall():
        events.append({"kind": "post", "icon": "inbox", "text": f"Saved from {r['source']}",
                       "detail": (r["title"] or r["text"] or r["url"] or "")[:80], "time": r["created_at"]})
    conn.close()
    events.sort(key=lambda e: e["time"], reverse=True)
    return events[:limit]
