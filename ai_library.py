"""
AI suggestions for library links: shelf, tags, a clean title and a one-line
summary. Read-only — the browser shows the suggestions for review and only the
ones the owner accepts are saved, through the normal library sync.

Links are sent in small batches (one request per batch) to stay well inside
free-tier request limits. Without a provider, shelves and tags come from the
local keyword rules and no titles or summaries are suggested.
"""
from __future__ import annotations

import json
import re
import time
from typing import Optional

import ai_providers
import categorizer

MAX_BATCH = 10
MAX_ID = 20000
# One /api/ai/suggest call must answer well inside the browser's patience (150 s),
# whatever mix of slow providers, retired models and retries it meets.
BUDGET_SECONDS = 100
# One provider's answer for a batch: a provider that hasn't answered by then is benched
# and the next one is asked (45 s held a whole batch up behind a stuck provider).
# FreeLLMAPI gets longer (ai_providers "patience"): it fails over between its own providers.
CALL_SECONDS = 30
JOBS = ("shelf", "tags", "title")

SYSTEM = (
    "You tidy one person's saved-links library so it reads like a personal feed.\n"
    "For every link you are given, return an object in an `items` array with the link's number as `id` and:\n"
    "{fields}\n"
    "Rules:\n"
    "- Shelves are fixed: copy one name verbatim from the list. A broad shelf that plausibly fits beats 'other'. "
    "Use 'other' only when nothing fits.\n"
    "- Tags: 2 to 4 short lowercase tags (one or two words, hyphenated) carrying specifics the shelf can't.\n"
    "- Title: what the link IS, in at most 70 characters, sentence case, no emoji, no hashtags, no quotes, "
    "no 'on Instagram'. Keep the creator's name only if it matters. Keep the original language.\n"
    "- Summary: one plain sentence (max 160 characters) saying why it's worth opening.\n"
    "- Never invent facts that aren't in the text. If there is too little to go on, keep the title close to the original.\n"
    "Answer straight away: no explanations and no thinking out loud. Return ONLY JSON: {{\"items\": [...]}}"
)
FIELD_TEXT = {
    "shelf": "  \"shelf\": one shelf name from the list",
    "tags": "  \"tags\": array of 2-4 tags",
    "title": "  \"title\": a clean title, and \"summary\": one sentence",
}

_TAG_RE = re.compile(r"[^a-z0-9\- ]+")


def _clean_tag(value) -> str:
    tag = _TAG_RE.sub("", str(value).strip().lower().lstrip("#")).strip().replace(" ", "-")
    return re.sub(r"-{2,}", "-", tag)[:30].strip("-")


def _clean_line(value, limit: int) -> str:
    text = re.sub(r"\s+", " ", value if isinstance(value, str) else "").strip().strip('"“”\'')   # text only, never a dict's repr
    if len(text) > limit:
        text = text[:limit - 1].rsplit(" ", 1)[0].rstrip(",;:-") + "…"
    return text


def _item_text(item: dict, key: str) -> str:
    lines = [f'"id": "{key}"']
    for key, label in (("title", "Title"), ("text", "Text"), ("url", "URL"), ("platform", "Platform"), ("folder", "Folder")):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            lines.append(f"{label}: {value.strip()[:700 if key == 'text' else 300]}")
    if item.get("tags"):
        lines.append("Existing tags: " + ", ".join(item["tags"][:8]))
    return "\n".join(lines)


def _prompt(items: list[dict], shelves: list[str], jobs: tuple[str, ...]) -> list[dict]:
    desc = categorizer.shelf_descriptions()
    shelf_lines = [f"- {s}: {desc[s]}" if s in desc else f"- {s}" for s in shelves]
    fields = "\n".join(FIELD_TEXT[j] for j in jobs)
    user = []
    if "shelf" in jobs:
        user += ["Shelves:", *shelf_lines, "- other: last resort", ""]
    user.append("Links:")
    # Each link is numbered within the request: a bookmark's own id is its URL in base64,
    # often hundreds of characters, which costs tokens and comes back garbled.
    for number, item in enumerate(items, 1):
        user += ["---", _item_text(item, str(number))]
    return [{"role": "system", "content": SYSTEM.format(fields=fields)}, {"role": "user", "content": "\n".join(user)}]


def _keywords(items: list[dict], shelves: list[str], jobs: tuple[str, ...]) -> list[dict]:
    live = {categorizer._norm_category(s) for s in shelves}
    out = []
    for item in items:
        combined = " ".join(filter(None, [item.get("title", ""), item.get("text", ""), item.get("url", "")]))
        shelf, tags = categorizer._keyword_classify(combined, live)
        entry: dict = {"id": item["id"]}
        if "shelf" in jobs:
            entry["shelf"] = shelf
        if "tags" in jobs:
            entry["tags"] = [t for t in (_clean_tag(t) for t in tags) if t][:4]
        out.append(entry)
    return out


def _parse(text: str, items: list[dict], shelves: list[str], jobs: tuple[str, ...]) -> Optional[list[dict]]:
    parsed = categorizer._extract_json(text)
    rows = parsed.get("items") if isinstance(parsed, dict) else None
    if not isinstance(rows, list):
        return None
    by_number = {str(number): item["id"] for number, item in enumerate(items, 1)}
    live = {categorizer._norm_category(s) for s in shelves} - categorizer.RESERVED_CATEGORIES
    out: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        # The link's number, as text or as a number ("3", 3); anything else (a list, an
        # object, a number we didn't send) is not one of ours.
        number = row.get("id")
        number = str(number) if type(number) is int else number.strip() if isinstance(number, str) else None
        link_id = by_number.get(number) if number else None
        if link_id is None or link_id in out:
            continue
        entry: dict = {"id": link_id}
        if "shelf" in jobs and isinstance(row.get("shelf"), str):
            entry["shelf"] = categorizer._snap_category(categorizer._norm_category(row["shelf"]), live)
        if "tags" in jobs and isinstance(row.get("tags"), list):
            entry["tags"] = list(dict.fromkeys(t for t in (_clean_tag(t) for t in row["tags"]) if t))[:4]
        if "title" in jobs:
            title = _clean_line(row.get("title"), 90)
            summary = _clean_line(row.get("summary"), 200)
            if title:
                entry["title"] = title
            if summary:
                entry["summary"] = summary
        out[link_id] = entry
    return list(out.values()) if out else None


def _ask(items: list[dict], shelves: list[str], jobs: tuple[str, ...], deadline: float,
         depth: int = 0, spread: int = 0) -> tuple[list[dict], str, str]:
    """AI rows for as many items as possible: (rows, provider, failure reason).

    A reply that is cut off, unreadable or skips some links is not thrown away:
    the links it missed are asked again in smaller groups while time allows."""
    try:
        text, provider = ai_providers.chat(_prompt(items, shelves, jobs), max_tokens=300 * len(items) + 800,
                                           timeout=CALL_SECONDS, deadline=deadline, spread=spread)
    except ai_providers.NoProvider as exc:
        # The model thought until its answer was cut off (FreeLLMAPI says so): the answer about half
        # as many links is shorter and fits. Any other failure is waited out by the browser.
        if not exc.cut_off or len(items) < 2:
            return [], "", exc.code
        rows, provider, missing, reason = [], "", items, exc.code
        size = (len(items) + 1) // 2
    else:
        rows = _parse(text, items, shelves, jobs) or []
        got = {row["id"] for row in rows}
        missing = [item for item in items if item["id"] not in got]
        reason = "bad_response" if missing else ""
        size = max(1, (len(missing) + 1) // 2) if len(missing) > 3 else len(missing)
    if missing and depth < 2 and deadline - time.monotonic() > 15:
        for start in range(0, len(missing), size):
            more, more_provider, more_reason = _ask(missing[start:start + size], shelves, jobs, deadline, depth + 1, spread)
            rows += more
            provider = provider or more_provider
            if more_reason and more_reason != "bad_response":
                reason = more_reason
                break
        got = {row["id"] for row in rows}
        reason = reason if any(item["id"] not in got for item in items) else ""
    return rows, provider, reason


def suggest(items: list[dict], shelves: list[str], jobs: tuple[str, ...], spread: int = 0) -> dict:
    """Suggestions for up to MAX_BATCH links. Never writes anything.

    `engine` is the provider that answered (or "keywords"); `missing` lists links
    with no AI answer, `fallbackReason` says why and `retryIn` how many seconds until a
    provider is free again, so the browser can wait and ask again instead of
    settling for keyword guesses."""
    jobs = tuple(j for j in JOBS if j in jobs)
    if not items or not jobs:
        return {"engine": "none", "items": []}
    keyword_jobs = tuple(j for j in jobs if j != "title")
    if not ai_providers.available():
        return {"engine": "keywords", "fallbackReason": "no_provider" if not ai_providers.retry_in() else "rate_limited",
                "retryIn": ai_providers.retry_in(), "missing": [i["id"] for i in items],
                "items": _keywords(items, shelves, keyword_jobs) if keyword_jobs else []}
    rows, provider, reason = _ask(items, shelves, jobs, time.monotonic() + BUDGET_SECONDS, spread=spread)
    got = {row["id"] for row in rows}
    missing = [item for item in items if item["id"] not in got]
    if not missing:
        return {"engine": provider, "items": rows}
    # Keyword guesses only for what the AI didn't answer; they are marked so the
    # browser can retry those links later.
    extra = _keywords(missing, shelves, keyword_jobs) if keyword_jobs else []
    return {"engine": provider if rows else "keywords", "fallbackReason": reason or "bad_response",
            "retryIn": ai_providers.retry_in(), "missing": [i["id"] for i in missing], "items": rows + extra}


def validate_spread(data: dict) -> int:
    """Optional batch number from the browser, used to share work across providers."""
    value = data.get("spread", 0)
    return value if type(value) is int and 0 <= value < 100000 else 0


def validate_request(data: dict) -> tuple[list[dict], list[str], tuple[str, ...]]:
    """Shape-check the browser's request; raises ValueError with a readable message."""
    raw_items, shelves, jobs = data.get("items"), data.get("shelves"), data.get("jobs")
    if not isinstance(raw_items, list) or not 0 < len(raw_items) <= MAX_BATCH:
        raise ValueError(f"Send 1 to {MAX_BATCH} links at a time.")
    if not isinstance(shelves, list) or not all(isinstance(s, str) and 0 < len(s) <= 60 for s in shelves) or len(shelves) > 40:
        raise ValueError("shelves must be a list of shelf names.")
    if not isinstance(jobs, list) or not jobs or not set(jobs) <= set(JOBS):
        raise ValueError("jobs must list shelf, tags and/or title.")
    items = []
    for raw in raw_items:
        # A bookmark's id is its URL in base64, so a long URL makes a long id (200 used to be the limit).
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not 0 < len(raw["id"]) <= MAX_ID:
            raise ValueError("Each link needs an id.")
        item = {"id": raw["id"]}
        for key in ("title", "text", "url", "platform", "folder"):
            if isinstance(raw.get(key), str):
                item[key] = raw[key][:2000]
        if isinstance(raw.get("tags"), list):
            item["tags"] = [t for t in raw["tags"] if isinstance(t, str)][:20]
        items.append(item)
    return items, [categorizer._norm_category(s) for s in shelves], tuple(jobs)


def _selfcheck() -> None:  # pragma: no cover - manual aid
    print(json.dumps(suggest([{"id": "a", "title": "Lemon cake", "text": "6 ingredient cake"}], ["food-drink"], JOBS), indent=2))
