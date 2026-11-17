"""Claude Desktop extension (v0.4.0): the token its SuperBookmarks extension uses to reach the app, the library
reads and writes it asks for, and what each write changed, so the owner can undo it here. A new shelf it suggests
is made only when the owner says so, and a write never lands on a link an open tab hasn't saved yet.

The token is shown once in Settings and pasted into Claude Desktop, which keeps it in the system's keychain; only
its SHA-256 is kept here (<data>/claude_desktop.json). Before sending the token, the extension's server checks
`proof`: an HMAC of its nonce and the address this app really listens on, keyed by that hash.
"""
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import tempfile
import threading
import time
import unicodedata
from datetime import datetime, timezone

import storage
import telegram_config

TOKEN_PREFIX = "sbm_cd_"
MAX_CHANGES = 50             # listed changes; as many waiting for the owner (not kept or undone) stop further writes
MAX_SUGGESTIONS = 20
SEARCH_LIMIT = 50
PAGE = 50
MAX_LINKS = 100
COPY_TEXT_LIMIT = 20000
PRESENCE_FOR = 90.0          # a tab's report of its unsaved links counts this long (hidden tabs run timers about once a minute)
_FIELDS = ("categories", "categoryMode", "categoryReview", "tags")   # what a change from Claude Desktop touches
_lock = threading.Lock()
_presence = {}               # tab -> (time.monotonic() of its report, url identities it hasn't saved)
_PLAN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taxonomy_plan.json")


class Refused(Exception):
    """A request the app turns down, with a sentence Claude can pass on (and the HTTP status that goes with it)."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _path():
    return telegram_config.config_path().parent / "claude_desktop.json"


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _load():
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {"hash": data.get("hash") if isinstance(data.get("hash"), str) else "",
            "createdAt": str(data.get("createdAt") or ""), "lastUsedAt": str(data.get("lastUsedAt") or ""),
            "version": data.get("version") if type(data.get("version")) is int else 0,
            "changes": _trim([c for c in data.get("changes", []) if isinstance(c, dict)]),
            "suggestions": [s for s in data.get("suggestions", []) if isinstance(s, dict)][-MAX_SUGGESTIONS:]}


def _waiting(change):
    return not change.get("undone") and not change.get("kept")


def _trim(changes):
    """At most MAX_CHANGES, dropping the oldest the owner kept or undid: one still waiting for the owner is never
    dropped (writes stop while MAX_CHANGES wait, see _file)."""
    changes = list(changes)
    while len(changes) > MAX_CHANGES:
        settled = next((i for i, c in enumerate(changes) if not _waiting(c)), None)
        if settled is None:
            break
        del changes[settled]
    return changes


def _hidden(text):
    """Control, formatting (bidi, zero-width) and unassigned characters: a name could show as something else."""
    return any(unicodedata.category(ch).startswith("C") for ch in text)


def _visible(text):
    """Text with those characters taken out (control characters become spaces), spaces collapsed."""
    kept = "".join(" " if unicodedata.category(ch) == "Cc" else "" if unicodedata.category(ch).startswith("C") else ch for ch in text)
    return re.sub(r"\s+", " ", kept).strip()


def _store(data):
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix="claude_desktop.", suffix=".tmp", delete=False) as handle:
        json.dump(data, handle, ensure_ascii=True, indent=1)
        temporary = handle.name
    os.replace(temporary, path)


def _digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ── The token ───────────────────────────────────────────────────────────────

def new_token():
    """A new token (shown once); any earlier one stops working. What Claude Desktop changed stays listed."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    with _lock:
        data = _load()
        data.update(hash=_digest(token), createdAt=_now(), lastUsedAt="")
        _store(data)
    return token


def forget():
    """Disconnect: the token stops working."""
    with _lock:
        data = _load()
        data.update(hash="", createdAt="", lastUsedAt="")
        _store(data)


def check(token):
    """Is this the token? Notes when it was last used (at most every 30 seconds)."""
    if not isinstance(token, str) or not token.startswith(TOKEN_PREFIX) or len(token) > 100:
        return False
    with _lock:
        data = _load()
        if not data["hash"] or not hmac.compare_digest(data["hash"], _digest(token)):
            return False
        last = data["lastUsedAt"]
        try:
            stale = not last or (datetime.now(timezone.utc) - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds() > 30
        except ValueError:
            stale = True
        if stale:
            data["lastUsedAt"] = _now()
            _store(data)
    return True


def fingerprint(digest):
    """A short fingerprint of the token's hash, which the extension's server sends with its nonce: an old token is
    told apart from an impostor (nothing about the token can be learnt from it)."""
    return hashlib.sha256(digest.encode("ascii")).hexdigest()[:16]


def proof(nonce, origin, kid):
    """HMAC-SHA256 of the server's nonce and this app's real address, keyed by the token's hash; None without a
    token, for another token's fingerprint or with a malformed nonce."""
    if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32,64}", nonce):
        return None
    key = _load()["hash"]
    if not key or not isinstance(kid, str) or not hmac.compare_digest(fingerprint(key), kid):
        return None
    return hmac.new(key.encode("ascii"), f"{nonce}|{origin}".encode("ascii"), hashlib.sha256).hexdigest()


# ── Open tabs: their unsaved links, and what they hear back ─────────────────

def report_pending(tab, urls):
    """A tab says which links it has changed but not saved yet (an empty list when it has none)."""
    if not isinstance(tab, str) or not 0 < len(tab) <= 64 or not isinstance(urls, list) or len(urls) > 20000:
        raise Refused("A tab's report must name the tab and list addresses.")
    idents = {storage.url_identity(url) for url in urls if isinstance(url, str) and len(url) <= 4096}
    cutoff = time.monotonic() - PRESENCE_FOR
    with _lock:
        for gone in [other for other, (when, _) in _presence.items() if when < cutoff]:
            del _presence[gone]
        if idents:
            _presence[tab] = (time.monotonic(), idents)
        else:
            _presence.pop(tab, None)


def _pending():
    cutoff = time.monotonic() - PRESENCE_FOR
    with _lock:
        for tab in [tab for tab, (when, _) in _presence.items() if when < cutoff]:
            del _presence[tab]
        return set().union(*(idents for _, idents in _presence.values())) if _presence else set()


def watch():
    """What a tab hears back: whether Claude Desktop is connected, its newest change the owner hasn't kept or undone
    (for the note), how many suggestions wait, and a version that moves whenever it changes the library."""
    data = _load()
    waiting = [c for c in data["changes"] if _waiting(c)]
    newest = waiting[-1] if waiting else None
    return {"connected": bool(data["hash"]), "version": str(data["version"]), "suggestions": len(data["suggestions"]),
            "change": {"id": newest.get("id"), "at": newest.get("at"), "summary": newest.get("summary"),
                       "count": len(newest.get("links", [])), "more": len(waiting) - 1} if newest else None}


# ── Reads ───────────────────────────────────────────────────────────────────

def _posts():
    return storage.get_library(0)


def _shelves_of(post):
    return [name for name in post.get("categories") or [] if isinstance(name, str) and name not in storage.RESERVED_SHELVES]


def _brief(post):
    excerpt = post.get("aiSummary") or post.get("description") or post.get("userNotes") or ""
    return {"id": post.get("id", ""), "title": post.get("title") or post.get("url", ""), "url": post.get("url", ""),
            "site": post.get("domain", ""), "shelves": _shelves_of(post), "tags": post.get("tags") or [],
            "saved": str(post.get("createdAt") or "")[:10], "excerpt": str(excerpt)[:300]}


def _newest(posts):
    return sorted(posts, key=lambda p: str(p.get("createdAt") or ""), reverse=True)


def search(query, limit=SEARCH_LIMIT):
    words = [word for word in str(query or "").lower().split() if word][:12]
    if not words:
        raise Refused("Give some words to search for.")
    limit = max(1, min(SEARCH_LIMIT, int(limit) if str(limit).isdigit() else SEARCH_LIMIT))
    found = []
    for post in _posts()["posts"]:
        text = " ".join(str(part) for part in (post.get("title"), post.get("url"), post.get("domain"), " ".join(post.get("tags") or []),
                                               " ".join(post.get("categories") or []), post.get("description"), post.get("aiSummary"),
                                               post.get("userNotes")) if part).lower()
        if all(word in text for word in words):
            found.append(post)
    found = _newest(found)
    return {"ok": True, "total": len(found), "links": [_brief(post) for post in found[:limit]]}


def _descriptions():
    try:
        with open(_PLAN, encoding="utf-8") as handle:
            plan = json.load(handle)
        return {entry["name"]: entry.get("description", "") for entry in plan.get("categories", []) if isinstance(entry, dict) and "name" in entry}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def shelves():
    library = _posts()
    counts = {}
    for post in library["posts"]:
        for name in _shelves_of(post):
            counts[name] = counts.get(name, 0) + 1
    described = _descriptions()
    names = [name for name in library.get("categories", []) if name not in storage.RESERVED_SHELVES]
    names += sorted(name for name in counts if name not in names)
    return {"ok": True, "shelves": [{"name": name, "links": counts.get(name, 0), "description": described.get(name, "")} for name in names]}


def unfiled(page=1):
    page = max(1, int(page) if str(page).isdigit() else 1)
    loose = _newest([post for post in _posts()["posts"] if not _shelves_of(post)])
    return {"ok": True, "total": len(loose), "page": page, "pages": max(1, -(-len(loose) // PAGE)),
            "links": [_brief(post) for post in loose[(page - 1) * PAGE:page * PAGE]]}


def _copy_text(post):
    key = post.get("archiveKey")
    if not isinstance(key, str):
        return ""
    import archive
    try:
        if not archive.read_record(key):
            return ""
        page, _ = archive._paths(key)
        with open(page, "rb") as handle:
            document = handle.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except (OSError, ValueError):
        return ""
    document = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", document)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", " ", document))
    return re.sub(r"\s+", " ", text).strip()[:COPY_TEXT_LIMIT]


def _find(posts, ident):
    for post in posts:
        if post.get("id") == ident or post.get("url") == ident:
            return post
    return None


def link(ident):
    post = _find(_posts()["posts"], ident) if isinstance(ident, str) and ident else None
    if post is None:
        raise Refused("There's no link with that id in the library.", 404)
    return {"ok": True, "link": {**_brief(post), "status": post.get("status", ""), "notes": str(post.get("userNotes") or "")[:2000],
                                 "copyText": _copy_text(post)}}


# ── Writes (each recorded, so the owner can undo it in Settings) ────────────

def _tags(values):
    if values is None:
        return []
    if not isinstance(values, list) or len(values) > 10 or not all(isinstance(v, str) for v in values):
        raise Refused("Tags must be a short list of words.")
    if any(_hidden(v) for v in values):
        raise Refused("Tags can't hold control or invisible characters.")
    return list(dict.fromkeys(t for t in (v.strip().lstrip("#").lower()[:40] for v in values) if t))


def _shelf_named(name, library):
    wanted = storage._norm_shelf(str(name or ""))
    for shelf in library.get("categories", []):
        if shelf not in storage.RESERVED_SHELVES and storage._norm_shelf(shelf) == wanted:
            return shelf
    return None


def _apply(changed, epoch, seen):
    """Write changed links as the library's own save does (validation, revisions, stale writes refused); the
    addresses it wrote. A link saved since it was read (`seen`: its updatedAt then) is refused and left out."""
    try:
        result = storage.save_library({"posts": changed, "deletedUrls": [], "epoch": epoch,
                                       "ifUpdatedAt": {post["url"]: seen.get(post["url"], "") for post in changed}})
    except storage.LibraryConflictError:      # a restore replaced the library meanwhile
        raise Refused("SuperBookmarks couldn't make that change just now. Try again in a moment.", 409)
    refused = {item.get("url") for item in result.get("rejected", [])}
    return [post["url"] for post in changed if post["url"] not in refused]


def _record(change):
    with _lock:
        data = _load()
        data["version"] += 1
        change["version"] = data["version"]
        data["changes"] = _trim(data["changes"] + [change])
        _store(data)


def _file(ids, shelf, tags, summary, kind, capped=True):
    if not isinstance(ids, list) or not ids or len(ids) > MAX_LINKS or not all(isinstance(i, str) and i for i in ids):
        raise Refused(f"Name between 1 and {MAX_LINKS} links by their ids.")
    with _lock:
        waiting = sum(1 for c in _load()["changes"] if _waiting(c))
    if capped and waiting >= MAX_CHANGES:
        raise Refused(f"The owner has {waiting} changes from Claude Desktop to look at in SuperBookmarks (Undo or Keep) before more can be made.", 409)
    library = _posts()
    target = _shelf_named(shelf, library)
    if target is None:
        raise Refused(f"There's no shelf called “{str(shelf)[:80]}”. Use list_shelves, or suggest_shelf to propose a new one.")
    posts = []
    for ident in dict.fromkeys(ids):
        post = _find(library["posts"], ident)
        if post is None:
            raise Refused("Some of those ids aren't links in the library. Search again for their ids.")
        posts.append(post)
    # Links the owner marked Reviewed are left as they are (automation stays away; the owner can still edit them).
    reviewed = [post for post in posts if post.get("reviewed") is True]
    posts = [post for post in posts if post.get("reviewed") is not True]
    busy = _pending()
    waiting = [post for post in posts if storage.url_identity(post["url"]) in busy]
    if waiting:
        raise Refused(f"An open SuperBookmarks tab hasn't saved its changes to {len(waiting)} of these links yet, so nothing was changed. "
                      "Try again in a moment.", 409)
    stamp, added = _now(), _tags(tags)
    changed, record = [], []
    for post in posts:
        # As the app's own "Add to shelf": the shelf joins the link's others and takes it out of "not filed yet".
        shelves_now = list(post.get("categories") or [])
        if target in shelves_now and not set(shelves_now) & storage.RESERVED_SHELVES:
            shelves_next = shelves_now
        else:
            shelves_next = [c for c in shelves_now if c not in storage.RESERVED_SHELVES and c != target] + [target]
        tags_next = list(dict.fromkeys([*(post.get("tags") or []), *added]))
        if shelves_next == shelves_now and tags_next == (post.get("tags") or []):
            continue                          # already there with those tags: nothing to change or undo
        after = {**post, "categories": shelves_next, "tags": tags_next, "updatedAt": stamp}
        if shelves_next != shelves_now:
            after.update(categoryMode="manual", categoryReview=False)
        changed.append(after)
        record.append({"url": post["url"], "before": {field: post[field] for field in _FIELDS if field in post},
                       "beforeAt": str(post.get("updatedAt") or ""), "after": stamp})
    seen = {post["url"]: str(post.get("updatedAt") or "") for post in posts}
    written = set(_apply(changed, library.get("epoch", 0), seen)) if changed else set()
    record = [entry for entry in record if entry["url"] in written]
    already = len(posts) - len(changed)
    if changed and not record:
        raise Refused("SuperBookmarks couldn't make that change just now (the links changed in the same moment). Try again.", 409)
    change = None
    if record:
        # A shelf the owner made from a suggestion was the owner's click: no note about it (Settings can still undo it).
        change = {"id": secrets.token_hex(8), "at": stamp, "kind": kind, "summary": summary(target, len(record)), "links": record,
                  "undone": False, "kept": kind == "suggestion"}
        _record(change)
    return {"ok": True, "filed": len(record), "shelf": target, **({"alreadyThere": already} if already else {}),
            **({"reviewed": len(reviewed), "reviewedNote": "Links the owner marked Reviewed in SuperBookmarks were left as they are."} if reviewed else {}),
            **({"notFiled": len(changed) - len(record)} if len(record) < len(changed) else {}),
            **({"change": change["id"], "note": "SuperBookmarks made the change; the owner can undo it in its Settings."} if change else {})}


def file_links(ids, shelf, tags=None):
    return _file(ids, shelf, tags, lambda name, n: f"Filed {n} link{'' if n == 1 else 's'} on {name}", "file")


def suggest(name, description="", ids=None):
    library = _posts()
    clean = storage._norm_shelf(str(name or ""))
    if not clean or len(clean) > 40:
        raise Refused("A shelf's name must be 1 to 40 characters.")
    if _hidden(str(name or "")):
        raise Refused("A shelf's name can't hold control or invisible characters.")
    if clean in storage.RESERVED_SHELVES or _shelf_named(clean, library):
        raise Refused(f"There's already a shelf called “{clean}”: file the links on it.")
    if ids is not None and (not isinstance(ids, list) or len(ids) > MAX_LINKS):
        raise Refused(f"Name at most {MAX_LINKS} links by their ids.")
    known = [i for i in dict.fromkeys(ids or []) if isinstance(i, str) and _find(library["posts"], i)]
    suggestion = {"id": secrets.token_hex(8), "at": _now(), "name": clean, "description": _visible(str(description or ""))[:400], "ids": known}
    with _lock:
        data = _load()
        data["suggestions"] = [s for s in data["suggestions"] if s.get("name") != clean][-(MAX_SUGGESTIONS - 1):] + [suggestion]
        _store(data)
    return {"ok": True, "suggested": clean, "links": len(known),
            "note": "SuperBookmarks shows this to the owner, who decides whether to make the shelf."}


def status():
    """Settings: connected or not, and what Claude Desktop changed and suggested (newest first)."""
    data = _load()
    return {"connected": bool(data["hash"]), "createdAt": data["createdAt"], "lastUsedAt": data["lastUsedAt"],
            "changes": [{"id": c.get("id"), "at": c.get("at"), "summary": c.get("summary"), "count": len(c.get("links", [])),
                         "undone": bool(c.get("undone")), "kept": bool(c.get("kept"))} for c in reversed(data["changes"])],
            "suggestions": [{"id": s.get("id"), "at": s.get("at"), "name": s.get("name"), "description": s.get("description", ""),
                             "count": len(s.get("ids", []))} for s in reversed(data["suggestions"])]}


def undo(change_ids):
    """Put back what these changes from Claude Desktop changed, newest first, for links nobody has changed since.
    A link a later change also touched comes back only when that later change is undone too (in the same go)."""
    with _lock:
        stored = _load()["changes"]
    wanted = set(change_ids)
    chosen = [c for c in stored if c.get("id") in wanted and not c.get("undone")]
    if not chosen or len(chosen) != len(wanted):
        raise Refused("That change isn't there to undo.")
    library = _posts()
    current = {post["url"]: dict(post) for post in library["posts"] if isinstance(post.get("url"), str)}
    seen = {url: str(post.get("updatedAt") or "") for url, post in current.items()}
    touched, skipped = set(), 0
    for change in reversed(chosen):           # newest first: each restores the state the one before it left
        for entry in change.get("links", []):
            post = current.get(entry.get("url"))
            if post is None or post.get("updatedAt") != entry.get("after"):
                skipped += 1                  # changed again since (by the owner or a tab): left as it is
                continue
            back = {key: value for key, value in post.items() if key not in _FIELDS}
            back.update(entry.get("before", {}))
            back.setdefault("categories", [])
            back.setdefault("tags", [])
            back["updatedAt"] = entry.get("beforeAt") or ""
            current[entry["url"]] = back
            touched.add(entry["url"])
    stamp = _now()
    restored = [{**current[url], "updatedAt": stamp} for url in touched]
    written = set(_apply(restored, library.get("epoch", 0), seen)) if restored else set()
    with _lock:
        data = _load()
        for c in data["changes"]:
            if c.get("id") in wanted:
                c["undone"] = True
        data["version"] += 1
        _store(data)
    return {"ok": True, "restored": len(written), "skipped": skipped + len(touched) - len(written)}


def _shown(version):
    """The version a tab's note was drawn from (watch()): the changes it covered are those recorded up to it."""
    if type(version) is int and version >= 0:
        return version
    if isinstance(version, str) and version.isdigit() and len(version) < 12:
        return int(version)
    raise Refused("Say which changes: the version the note showed.")


def undo_waiting(version):
    """The note's Undo: every change it covered that the owner hasn't kept or undone (not one made since)."""
    upto = _shown(version)
    with _lock:
        ids = [c.get("id") for c in _load()["changes"] if _waiting(c) and c.get("version", 0) <= upto]
    if not ids:
        raise Refused("There's nothing from Claude Desktop to undo.")
    return undo(ids)


def keep(version):
    """The note's Keep: the changes it covered stay (each can still be undone in Settings) and the note goes; one
    made since it was drawn still waits."""
    upto = _shown(version)
    with _lock:
        data = _load()
        for c in data["changes"]:
            if _waiting(c) and c.get("version", 0) <= upto:
                c["kept"] = True
        _store(data)
    return {"ok": True}


def resolve(suggestion_id, create):
    """The owner made the suggested shelf (and its links go on it, a change with Undo like any other) or dismissed it."""
    with _lock:
        data = _load()
        suggestion = next((s for s in data["suggestions"] if s.get("id") == suggestion_id), None)
        if suggestion is None:
            raise Refused("That suggestion isn't there any more.", 404)
        data["suggestions"] = [s for s in data["suggestions"] if s.get("id") != suggestion_id]
        _store(data)
    if not create:
        return {"ok": True, "made": False}
    library = _posts()
    try:
        result = storage.save_library({"posts": [], "deletedUrls": [], "epoch": library.get("epoch", 0),
                                       "categoryOps": [{"op": "add", "name": suggestion["name"]}]})
    except storage.LibraryConflictError:
        raise Refused("SuperBookmarks couldn't make that shelf just now. Try again in a moment.", 409)
    if result.get("rejectedOps"):
        raise Refused("SuperBookmarks already has as many shelves as it can hold; remove one first.")
    with _lock:
        data = _load()
        data["version"] += 1                  # tabs read the new shelf
        _store(data)
    ids = [i for i in suggestion.get("ids", []) if isinstance(i, str) and _find(library["posts"], i)]   # still in the library
    if not ids:
        return {"ok": True, "made": True, "filed": 0}
    try:
        filed = _file(ids, suggestion["name"], None,
                      lambda name, n: f"Made the shelf {name} and filed {n} link{'' if n == 1 else 's'} on it", "suggestion", capped=False)
    except Refused as exc:                    # the shelf is made; its links can be filed by hand or asked again
        return {"ok": True, "made": True, "filed": 0, "problem": str(exc)}
    return {"ok": True, "made": True, "filed": filed["filed"]}
