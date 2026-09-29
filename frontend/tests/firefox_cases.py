"""Synthetic Places copies only. No Firefox installation/profile needed."""
import sqlite3
from pathlib import Path

OVERLAP = "https://example.invalid/programming#typescript"
NEW = "http://metadata.fixture.test/firefox?lesson=1&lesson=2#code"
UNTITLED = "http://metadata.fixture.test/classify-failure"


def fixture(mode="valid"):
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript("""
        CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT);
        CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,type INTEGER,fk INTEGER,parent INTEGER,position INTEGER,title TEXT,guid TEXT);
        INSERT INTO moz_bookmarks VALUES(10,2,NULL,0,0,'Root','root________'),(20,2,NULL,10,0,'Toolbar','toolbar_____'),(30,2,NULL,20,0,'Nested',NULL),(40,3,NULL,30,0,NULL,NULL);
        CREATE INDEX bookmark_fk ON moz_bookmarks(fk);
        """)
        urls = [OVERLAP, NEW, UNTITLED, "javascript:alert(1)"]
        for index, url in enumerate(urls, 1):
            conn.execute("INSERT INTO moz_places VALUES(?,?,?)", (index, url, "History title must never win"))
        for row in [(101, 1, "Supplied overlap"), (102, 2, "Cooking recipe supplied"), (103, 3, None), (104, 2, "Duplicate title"), (105, 4, "Unsupported")]:
            conn.execute("INSERT INTO moz_bookmarks VALUES(?,1,?,30,0,?,NULL)", row)
        for i in range(10, 13):
            conn.execute("INSERT INTO moz_places VALUES(?,?,?)", (i, f"https://history-only.invalid/{i}", "Excluded history"))
        if mode == "missing-bookmarks": conn.execute("DROP TABLE moz_bookmarks")
        if mode == "missing-places": conn.execute("DROP TABLE moz_places")
        if mode == "schema": conn.execute("ALTER TABLE moz_bookmarks RENAME COLUMN fk TO wrong")
        if mode == "bad-fk": conn.execute("UPDATE moz_bookmarks SET fk=999 WHERE id=102")
        if mode == "malformed": conn.execute("UPDATE moz_places SET url='not a URL' WHERE id=2")
        if mode == "unsupported": conn.execute("UPDATE moz_places SET url='about:blank'")
        if mode == "duplicates": conn.execute("UPDATE moz_bookmarks SET fk=1 WHERE type=1")
        if mode == "failure":
            conn.execute("DELETE FROM moz_bookmarks WHERE type=1 AND id<>101")
            conn.execute("UPDATE moz_places SET url='http://metadata.fixture.test/failure' WHERE id=1")
        if mode == "view":
            conn.executescript("DROP TABLE moz_bookmarks; CREATE VIEW moz_bookmarks AS SELECT 1 AS id,1 AS type,1 AS fk,1 AS parent,'bad' AS title;")
        conn.commit()
        return conn.serialize()
    finally:
        conn.close()


def write_cases(destination):
    directory = Path(destination)
    directory.mkdir(parents=True, exist_ok=True)
    for mode in ("valid", "missing-bookmarks", "missing-places", "schema", "bad-fk", "malformed", "unsupported", "duplicates", "failure", "view"):
        (directory / mode).write_bytes(fixture(mode))
    (directory / "empty").write_bytes(b"")
    (directory / "not-sqlite").write_bytes(b"not a database")
    (directory / "truncated").write_bytes(fixture()[:300])


if __name__ == "__main__":
    import sys
    write_cases(sys.argv[1])
