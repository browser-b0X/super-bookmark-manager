"""
SQLite storage for saved posts.
Schema: one row per saved message, with JSON fields for flexible metadata.
"""

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

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


def _validate_library_delta(data):
    if not isinstance(data, dict) or not isinstance(data.get("posts"), list) or not isinstance(data.get("deletedUrls"), list):
        raise LibraryValidationError("Expected an object with posts and deletedUrls arrays.")
    required_strings = ("id", "url", "source", "platform", "domain", "status", "createdAt", "updatedAt", "metadataStatus")
    optional_strings = ("canonicalUrl", "sourceMessageId", "title", "description", "excerpt", "thumbnailUrl", "mediaType", "userNotes", "aiSummary", "lastOpenedAt", "metadataError", "categoryMode")
    enums = {
        "source": ("telegram", "manual", "browser", "import", "api"),
        "platform": ("instagram", "x", "youtube", "github", "reddit", "tiktok", "web", "pdf", "other"),
        "status": ("inbox", "to-review", "in-progress", "reference", "archived"),
        "metadataStatus": ("pending", "enriched", "partial", "failed"),
        "mediaType": ("video", "image", "thread", "article", "repository", "document", "post", "other"),
        "categoryMode": ("manual", "automatic"),
    }
    documents = []
    for index, post in enumerate(data["posts"]):
        label = f"posts[{index}]"
        if not isinstance(post, dict):
            raise LibraryValidationError(f"{label} must be a SavedPost object.")
        for field in required_strings:
            if not isinstance(post.get(field), str):
                raise LibraryValidationError(f"{label}.{field} must be a string.")
        if not post["id"].strip() or not _library_http_url(post["url"]):
            raise LibraryValidationError(f"{label} requires a nonempty id and a valid HTTP(S) url.")
        for field in optional_strings:
            if field in post and not isinstance(post[field], str):
                raise LibraryValidationError(f"{label}.{field} must be a string when supplied.")
        for field, choices in enums.items():
            if field in post and post[field] not in choices:
                raise LibraryValidationError(f"{label}.{field} is not a supported value.")
        for field in ("categories", "tags", "projectIds"):
            if not isinstance(post.get(field), list) or any(not isinstance(value, str) for value in post[field]):
                raise LibraryValidationError(f"{label}.{field} must be an array of strings.")
        for field in ("favorite", "pinned", "categoryReview"):
            if field in post and not isinstance(post[field], bool):
                raise LibraryValidationError(f"{label}.{field} must be a boolean when supplied.")
        if "telegramMessage" in post:
            message = post["telegramMessage"]
            if not isinstance(message, dict) or not isinstance(message.get("text"), str):
                raise LibraryValidationError(f"{label}.telegramMessage requires a text string.")
            for field in ("id", "date"):
                if field in message and not isinstance(message[field], str):
                    raise LibraryValidationError(f"{label}.telegramMessage.{field} must be a string.")
        try:
            documents.append(json.dumps(post, ensure_ascii=True, allow_nan=False))
        except (TypeError, ValueError) as exc:
            raise LibraryValidationError(f"{label} must contain valid JSON values.") from exc
    for url in data["deletedUrls"]:
        if not _library_http_url(url):
            raise LibraryValidationError("deletedUrls must contain only valid HTTP(S) URL strings.")
    return documents


def _library_snapshot(conn) -> dict:
    posts, deleted_urls = [], []
    for row in conn.execute("SELECT document, url, deleted FROM library_items ORDER BY rowid"):
        if row["deleted"]:
            deleted_urls.append(row["url"])
        else:
            posts.append(json.loads(row["document"]))
    # Exact URL comparison, including query and fragment; no implicit adoption.
    legacy_rows = [
        dict(row) for row in conn.execute("""
            SELECT saved_posts.* FROM saved_posts
             WHERE NOT EXISTS (SELECT 1 FROM library_items WHERE library_items.url = saved_posts.url)
             ORDER BY saved_posts.id
        """) if _library_http_url(row["url"])
    ]
    return {"posts": posts, "deletedUrls": deleted_urls, "legacyRows": legacy_rows}


def get_library() -> dict:
    """Read the complete library and unadopted legacy rows in one snapshot."""
    conn = _connect()
    try:
        with conn:
            conn.execute("BEGIN")
            result = _library_snapshot(conn)
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
            conn.executemany("INSERT INTO library_items (url, id, document) VALUES (?, ?, ?)",
                             [(p["url"], p["id"], json.dumps(p, ensure_ascii=True, allow_nan=False)) for p in data["posts"]])
            conn.executemany("INSERT INTO library_items (url, id, deleted) VALUES (:url, :id, 1)", data["tombstones"])
        # Close a complete standalone file, not a DB depending on a missing WAL.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=DELETE")
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise sqlite3.DatabaseError("Restored database failed integrity validation")
    finally:
        conn.close()


def save_library(data) -> dict:
    """Validate, atomically apply a delta, and return canonical committed state."""
    documents = _validate_library_delta(data)
    conn = _connect()
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            known = _known_shelves(conn)
            incoming_shelves = {name for post in data["posts"] for name in post["categories"]}
            _check_shelf_growth(known, incoming_shelves)
            for post in data["posts"]:
                if post.get("categoryMode") == "automatic" and not set(post["categories"]).issubset(known):
                    raise LibraryValidationError("Automatic categorization may only assign existing shelves.")
            # Check both existing and batch identities, including retained tombstone IDs.
            incoming_ids = {}
            for post in data["posts"]:
                owner = conn.execute("SELECT url FROM library_items WHERE id = ?", (post["id"],)).fetchone()
                if (owner and owner["url"] != post["url"]) or (post["id"] in incoming_ids and incoming_ids[post["id"]] != post["url"]):
                    raise LibraryConflictError("A library ID already belongs to a different URL; no changes were saved.")
                incoming_ids[post["id"]] = post["url"]
            # Deletions take precedence over every upsert, including unseen URLs.
            for url in data["deletedUrls"]:
                conn.execute("""
                    INSERT INTO library_items (url, deleted) VALUES (?, 1)
                    ON CONFLICT(url) DO UPDATE SET document = NULL, deleted = 1
                """, (url,))
            for post, document in zip(data["posts"], documents):
                existing = conn.execute("SELECT id, deleted FROM library_items WHERE url = ?", (post["url"],)).fetchone()
                if existing:
                    # Different-ID reimports cannot replace the existing user's curation.
                    if existing["deleted"] or existing["id"] != post["id"]:
                        continue
                    conn.execute("UPDATE library_items SET document = ? WHERE url = ?", (document, post["url"]))
                else:
                    conn.execute("INSERT INTO library_items (url, id, document) VALUES (?, ?, ?)", (post["url"], post["id"], document))
            result = _library_snapshot(conn)
        # The transaction context commits before callers can acknowledge this result.
        return result
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
           SET category = ?, summary = ?, tags = ?, processed = 1
         WHERE tg_msg_id = ?
        """,
        (category, summary, json.dumps(tags), tg_msg_id),
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
           SET title = ?, summary = ?, category = ?, tags = ?, processed = 1
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
    where = ("category IN ('uncategorized', 'other')" if untagged_only
             else "processed = 0")
    rows = conn.execute(
        f"""
        SELECT tg_msg_id, title, text, url, source
          FROM saved_posts
         WHERE {where}
         ORDER BY date_utc DESC
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
        "UPDATE saved_posts SET category = ? WHERE tg_msg_id = ?",
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
