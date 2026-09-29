"""Parse only uploaded bookmark snapshots; never accepts a filesystem path."""
import sqlite3
import tempfile
import time
from pathlib import Path

MAX_BYTES = 64 * 1024 * 1024
MAX_BOOKMARKS = 50000
COPY_GUIDANCE = "Firefox may still be using this database. Close Firefox or make a copy of places.sqlite, then select the copy."


class FirefoxImportError(ValueError):
    pass


def parse_copy(raw):
    if not raw:
        raise FirefoxImportError("The selected file is empty. Select a copied Firefox places.sqlite file.")
    if len(raw) > MAX_BYTES:
        raise FirefoxImportError("Firefox copy exceeds the 64 MiB limit. Export bookmarks as HTML instead.")
    if len(raw) < 100 or raw[:16] != b"SQLite format 3\x00":
        raise FirefoxImportError("Not a complete SQLite database. Select a copied Firefox places.sqlite file.")
    conn = None
    try:
        # Only request bytes enter this private temporary snapshot. No supplied
        # filename/path is used and no browser profile/sidecar is ever opened.
        with tempfile.TemporaryDirectory(prefix="saved-posts-firefox-") as directory:
            path = Path(directory) / "selected-copy.sqlite"
            path.write_bytes(raw)
            try:
                conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)
                conn.execute("PRAGMA query_only=ON")
                conn.execute("PRAGMA trusted_schema=OFF")
                conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1024 * 1024)
                deadline = time.monotonic() + 5
                conn.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                required = {"moz_bookmarks": {"id", "type", "fk", "parent", "title"},
                            "moz_places": {"id", "url"}}
                for table, columns in required.items():
                    row = conn.execute("SELECT type, sql FROM sqlite_master WHERE name=?", (table,)).fetchone()
                    if not row or row[0] != "table" or "VIRTUAL" in (row[1] or "").upper():
                        raise FirefoxImportError("Incompatible Firefox schema: required bookmark tables are missing.")
                    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
                    if not columns.issubset({c[1] for c in info}) or not any(c[1] == "id" and c[5] == 1 for c in info):
                        raise FirefoxImportError("Incompatible Firefox bookmark schema. Export bookmarks as HTML instead.")
                count = conn.execute("SELECT COUNT(*) FROM moz_bookmarks WHERE type=1").fetchone()[0]
                if count > MAX_BOOKMARKS:
                    raise FirefoxImportError("Firefox copy exceeds the 50000 bookmark limit. Export a smaller HTML selection instead.")
                # Count only; never select unbookmarked history URLs or titles.
                ignored = conn.execute("SELECT COUNT(*) FROM moz_places p WHERE NOT EXISTS "
                                       "(SELECT 1 FROM moz_bookmarks b WHERE b.type=1 AND b.fk=p.id)").fetchone()[0]
                bookmarks = []
                for place_id, url, title in conn.execute(
                        "SELECT p.id, p.url, b.title FROM moz_bookmarks b "
                        "LEFT JOIN moz_places p ON p.id=b.fk WHERE b.type=1 ORDER BY b.id"):
                    if place_id is None or not isinstance(url, str) or not url.strip() or (title is not None and not isinstance(title, str)):
                        raise FirefoxImportError("Malformed bookmark entry or invalid URL reference. No bookmarks were imported.")
                    bookmarks.append({"type": "url", "url": url, "name": title or ""})
                return {"roots": {"bookmarks": {"type": "folder", "children": bookmarks}},
                        "historyIgnored": ignored, "bookmarkRows": count}
            finally:
                if conn is not None:
                    conn.close()
    except FirefoxImportError:
        raise
    except (OSError, sqlite3.Error):
        # Never echo SQL, paths, arbitrary database text or history URLs.
        raise FirefoxImportError("Could not safely read this SQLite copy (incomplete, incompatible or unavailable). " + COPY_GUIDANCE) from None
