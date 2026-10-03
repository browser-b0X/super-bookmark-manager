"""
SQLite storage for saved posts.
Schema: one row per saved message, with JSON fields for flexible metadata.
"""

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote, urlsplit

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
                     "metadataRetryAt", "originalTitle")
_ENUMS = {
    "source": ("telegram", "whatsapp", "manual", "browser", "import", "api"),
    "platform": ("instagram", "x", "youtube", "github", "reddit", "tiktok", "facebook", "threads", "linkedin",
                 "pinterest", "bluesky", "web", "pdf", "other"),
    "status": ("inbox", "to-review", "in-progress", "reference", "archived"),
    "metadataStatus": ("pending", "enriched", "partial", "failed", "none"),
    "mediaType": ("video", "image", "thread", "article", "repository", "document", "post", "other"),
    "categoryMode": ("manual", "automatic"),
    "linkStatus": ("ok", "redirected", "gone", "error"),
}
_FIELD_SOURCES = ("file", "fetched", "user", "derived", "ai")


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
    for field in ("favorite", "pinned", "categoryReview"):
        if field in post and not isinstance(post[field], bool):
            raise LibraryValidationError(f"{label}.{field} must be a boolean when supplied.")
    for field in ("wordCount", "readingMinutes", "httpStatus", "metadataAttempts", "position"):
        if field in post and (type(post[field]) is not int or post[field] < 0):
            raise LibraryValidationError(f"{label}.{field} must be a non-negative integer when supplied.")
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
        names = {"add": ("name",), "delete": ("name",), "rename": ("from", "to")}.get(kind)
        if names is None or set(op) != {"op", *names} or any(not isinstance(op[n], str) or not op[n].strip() for n in names):
            raise LibraryValidationError("categoryOps entries must be add/delete {name} or rename {from, to}.")
    return ops


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
    posts, deleted_urls, idents = [], [], set()
    for row in conn.execute("SELECT document, url, deleted, ident, rev FROM library_items ORDER BY rowid"):
        idents.add(row["ident"])
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
              "rev": _current_rev(conn)}
    if since:
        result["since"] = since
        result["purgedUrls"] = [row[0] for row in conn.execute("SELECT url FROM library_purged WHERE rev > ?", (since,))]
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


def get_backup_library(path=None) -> dict:
    """One consistent durable-library snapshot; never silently omit legacy links."""
    conn = _connect(path)
    try:
        with conn:
            conn.execute("BEGIN")
            snapshot = _library_snapshot(conn)
            if snapshot["legacyRows"]:
                raise LibraryValidationError("Legacy links still need to finish loading and saving in Library. Retry export after SQLite confirms the save.")
            return {
                "posts": snapshot["posts"],
                "tombstones": [dict(row) for row in conn.execute("SELECT url, id FROM library_items WHERE deleted = 1 ORDER BY rowid")],
                "categories": [dict(row) for row in conn.execute("SELECT name, sort_order, created_at FROM categories ORDER BY rowid")],
            }
    finally:
        conn.close()


def write_backup_library(path, data):
    """Populate an exclusively owned, unpublished new DB, never the active DB."""
    init_db(path)
    conn = _connect(path)
    try:
        with conn:
            conn.execute("DELETE FROM categories")
            conn.executemany("INSERT INTO categories (name, sort_order, created_at) VALUES (:name, :sort_order, :created_at)", data["categories"])
            conn.executemany("INSERT INTO library_items (url, id, document, ident) VALUES (?, ?, ?, ?)",
                             [(p["url"], p["id"], json.dumps(p, ensure_ascii=True, allow_nan=False), url_identity(p["url"])) for p in data["posts"]])
            conn.executemany("INSERT INTO library_items (url, id, deleted, ident) VALUES (?, ?, 1, ?)",
                             [(t["url"], t["id"], url_identity(t["url"])) for t in data["tombstones"]])
        # Close a complete standalone file, not a DB depending on a missing WAL.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=DELETE")
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise sqlite3.DatabaseError("Restored database failed integrity validation")
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
    category_ops = _validate_category_ops(data)
    since = data.get("since", 0)
    if type(since) is not int or since < 0:
        raise LibraryValidationError("since must be a non-negative integer.")
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
            for url in purge_urls:
                removed = conn.execute("DELETE FROM library_items WHERE ident = ? AND deleted = 0", (url_identity(url),)).rowcount
                if removed:
                    conn.execute("INSERT INTO library_purged (url, rev) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET rev = excluded.rev", (url, rev()))
            # Deletions take precedence over every upsert, including unseen URLs.
            for url in deleted_urls:
                ident = url_identity(url)
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
            result = _library_snapshot(conn, since if since and since <= _current_rev(conn) else 0)
        # The transaction context commits before callers can acknowledge this result.
        return {**result, "rejected": rejected, **({"rejectedOps": rejected_ops} if rejected_ops else {})}
    finally:
        conn.close()


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
