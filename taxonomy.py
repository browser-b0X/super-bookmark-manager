"""
Corpus-level category taxonomy for the saved-posts library.

The per-post categorizer (categorizer.py) only ever *reuses* categories. The
taxonomy itself is derived here, once, by looking at the whole collection at
the same time — which is the only way to see that "folklore" and
"folkloremythology" are the same shelf.

Public surface:
  plan_consolidation(limit)  -> dry-run proposal: canon + old->new mapping
  apply_consolidation(plan)  -> execute an approved proposal
  suggest_categories(limit)  -> propose additions from still-unfiled posts

Nothing in this module writes to the database except apply_consolidation.
"""

import json
import os
import sqlite3
import urllib.error
import urllib.request
from typing import Any, Optional

import ai_providers
import categorizer
import config
import storage

# Ceiling on auto-derived categories. The user may add more by hand; this only
# bounds what the machine is allowed to invent for them.
CANON_LIMIT = 12

# A shelf holding fewer links than this is not a shelf, it is the sprawl we are
# removing. Enforced after the model answers, because models reliably honour the
# category ceiling and then quietly emit single-link categories anyway.
MIN_SHELF = 4

# Categories that are structural, not topical — never merged away, never counted
# against the ceiling.
RESERVED = {"uncategorized", "other"}

SAMPLES_PER_CATEGORY = 4


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ── Corpus digest ─────────────────────────────────────────────────────────────

def _digest() -> list[dict]:
    """
    Compress the whole library into something a model can reason over in one
    pass: per category, its size plus a few real titles as content evidence.
    """
    conn = _connect()
    rows = conn.execute(
        "SELECT category, COUNT(*) n FROM saved_posts GROUP BY category ORDER BY n DESC"
    ).fetchall()

    out = []
    for r in rows:
        cat = r["category"] or "uncategorized"
        samples = conn.execute(
            """SELECT title, url, text FROM saved_posts
               WHERE category = ? ORDER BY LENGTH(COALESCE(title,'')) DESC LIMIT ?""",
            (r["category"], SAMPLES_PER_CATEGORY),
        ).fetchall()
        labels = []
        for s in samples:
            label = (s["title"] or "").strip() or (s["text"] or "").strip()[:70] or (s["url"] or "")
            if label:
                labels.append(label[:90])
        out.append({"category": cat, "count": r["n"], "samples": labels})
    conn.close()
    return out


def _digest_prompt(digest: list[dict], limit: int) -> str:
    lines = [
        f"The library holds {sum(d['count'] for d in digest)} saved links, "
        f"currently split across {len(digest)} categories. "
        f"Collapse them into AT MOST {limit} categories.\n",
        "Current categories, their size, and example links:\n",
    ]
    for d in digest:
        lines.append(f"- {d['category']} ({d['count']} links)")
        for s in d["samples"]:
            lines.append(f"    · {s}")
    return "\n".join(lines)


# ── LLM derivation ────────────────────────────────────────────────────────────

DERIVE_SYSTEM = (
    "You are designing the permanent category taxonomy for one person's saved-links "
    "library. The current taxonomy is broken: it was grown one link at a time, so it "
    "is full of near-duplicates and one-off categories that hold a single link.\n\n"
    "Design a taxonomy that makes links easy to FIND by browsing:\n"
    "1. Produce AT MOST {limit} categories. Fewer is better than more.\n"
    "2. HARD RULE: every category you propose must end up holding at least "
    "{min_shelf} of the links shown. Add up the link counts before you commit to a "
    "category. If a topic cannot reach {min_shelf}, it is not a category — merge it "
    "into a broader one.\n"
    "3. Merge near-duplicates and narrow specifics into their broader parent "
    "(hair care, cosmetics and fashion are all one shelf; folklore and mythology are "
    "one shelf).\n"
    "4. Do not split a large existing category just because it is large.\n"
    "5. Keep meanings honest: a link's new shelf must actually describe it. Do not "
    "use one broad shelf as a dumping ground for unrelated leftovers.\n"
    "6. Names: 1-2 words, lowercase, hyphen between words. No emoji.\n"
    "7. Assign EVERY current category to exactly one new category. Use 'other' only "
    "for links that genuinely have no topic.\n"
    "8. 'uncategorized' and 'other' always map to themselves."
)

DERIVE_SCHEMA = {
    "name": "taxonomy_proposal",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "categories": {
                "type": "array",
                "description": "The proposed taxonomy, largest shelf first.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "lowercase, 1-2 words, hyphenated"},
                        "description": {"type": "string", "description": "One short sentence: what belongs on this shelf."},
                    },
                    "required": ["name", "description"],
                    "additionalProperties": False,
                },
            },
            "mapping": {
                "type": "array",
                "description": "Every current category assigned to exactly one proposed category.",
                "items": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "An existing category name, verbatim."},
                        "to": {"type": "string", "description": "One of the proposed category names."},
                    },
                    "required": ["from", "to"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["categories", "mapping"],
        "additionalProperties": False,
    },
}


def _proxy_json(system: str, user: str, schema: dict, max_tokens: int = 2600,
                rounds: int = 2) -> Optional[dict]:
    """
    Structured call through the built-in AI provider chain. A whole taxonomy
    rides on this one answer, so a failed or unreadable reply gets another round;
    the chain benches a failing provider, so the next round goes elsewhere.
    """
    hint = json.dumps(schema.get("schema", schema), separators=(",", ":"))
    messages = [
        {"role": "system", "content": system + "\nReturn ONLY a JSON object matching this schema: " + hint},
        {"role": "user", "content": user},
    ]
    last_error = ""
    for _ in range(max(1, rounds)):
        try:
            text, _provider = ai_providers.chat(messages, max_tokens=max_tokens, timeout=90)
        except ai_providers.NoProvider as exc:
            last_error = exc.code
            continue
        parsed = categorizer._extract_json(text)
        if parsed:
            return parsed
        last_error = "unparseable response"
    _LAST_ERROR["proxy"] = last_error
    return None


# Why the last LLM attempt failed, so callers can say so out loud instead of
# quietly shipping a worse deterministic plan.
_LAST_ERROR: dict[str, str] = {"proxy": ""}


# ── Deterministic fallback ────────────────────────────────────────────────────

def _fallback_mapping(digest: list[dict], limit: int) -> tuple[list[dict], dict[str, str]]:
    """
    No-LLM plan: keep the biggest shelves, fold every small one into the best
    keyword match among them, else 'other'. Used when every provider is down so
    a consolidation is always possible.
    """
    topical = [d for d in digest if d["category"] not in RESERVED]
    keep = [d["category"] for d in topical[:limit]]
    mapping: dict[str, str] = {c: c for c in RESERVED}

    for d in digest:
        cat = d["category"]
        if cat in mapping:
            continue
        if cat in keep:
            mapping[cat] = cat
            continue
        # Score the small category's own name + samples against the keepers'
        # keyword rules, and take the strongest.
        blob = " ".join([cat.replace("-", " ")] + d["samples"]).lower()
        best, best_score = "other", 0.0
        for k in keep:
            score = 0.0
            for pattern, weight in categorizer.CATEGORY_RULES.get(k, []):
                import re as _re
                if _re.search(pattern, blob):
                    score += weight
            if score > best_score:
                best, best_score = k, score
        mapping[cat] = best if best_score >= 1.0 else "other"

    cats = [{"name": c, "description": ""} for c in keep]
    return cats, mapping


# ── Planning ──────────────────────────────────────────────────────────────────

def _validate_plan(proposal: dict, digest: list[dict], limit: int) -> Optional[dict]:
    """Force a model proposal to be total, closed and within the ceiling."""
    raw_cats = proposal.get("categories") or []
    raw_map = proposal.get("mapping") or []
    if not isinstance(raw_cats, list) or not isinstance(raw_map, list):
        return None

    canon: list[dict] = []
    seen: set[str] = set()
    for c in raw_cats:
        if not isinstance(c, dict):
            continue
        name = categorizer._norm_category(str(c.get("name", "")))
        if not name or name in seen or name in RESERVED:
            continue
        seen.add(name)
        canon.append({"name": name, "description": str(c.get("description", "")).strip()})
    canon = canon[:limit]
    if not canon:
        return None
    # A model will happily park real topics in 'uncategorized', which reads as
    # "never processed" in the UI. Only 'uncategorized' may map to itself;
    # everything else that has no shelf goes to 'other' and gets re-homed.
    valid = {c["name"] for c in canon} | {"other"}

    # Index the model's assignments, normalised.
    assigned: dict[str, str] = {}
    for m in raw_map:
        if not isinstance(m, dict):
            continue
        src = categorizer._norm_category(str(m.get("from", "")))
        dst = categorizer._norm_category(str(m.get("to", "")))
        if src and dst in valid:
            assigned[src] = dst

    # Totality: every real category must be covered, including ones the model
    # forgot. A forgotten category keeps itself if it survived, else 'other'.
    mapping: dict[str, str] = {}
    for d in digest:
        cat = categorizer._norm_category(d["category"])
        if cat == "uncategorized":
            mapping[d["category"]] = "uncategorized"
            continue
        if cat == "other":
            mapping[d["category"]] = "other"
            continue
        mapping[d["category"]] = assigned.get(cat) or (cat if cat in valid else "other")

    return {"categories": canon, "mapping": mapping}


def _enforce_min_shelf(plan: dict, counts: dict[str, int], min_shelf: int) -> list[str]:
    """
    Dissolve any proposed shelf that would hold fewer than `min_shelf` links,
    sending its links to 'other'. Mutates `plan`; returns the names dissolved.

    This is the backstop for the one failure the model keeps making: honouring
    the ceiling of 12 while still emitting a category that holds a single link.
    """
    held: dict[str, int] = {}
    for old, new in plan["mapping"].items():
        held[new] = held.get(new, 0) + counts.get(old, 0)

    weak = {c["name"] for c in plan["categories"] if held.get(c["name"], 0) < min_shelf}
    if not weak:
        return []

    for old, new in list(plan["mapping"].items()):
        if new in weak:
            plan["mapping"][old] = "other"
    plan["categories"] = [c for c in plan["categories"] if c["name"] not in weak]
    return sorted(weak, key=lambda n: -held.get(n, 0))


REASSIGN_SYSTEM = (
    "You are finishing a library reorganisation. Some proposed shelves were too small "
    "to keep and were removed, so their links need a home among the shelves that "
    "survived.\n\n"
    "For each leftover topic, choose the surviving shelf that genuinely describes it. "
    "Prefer a real home over a perfect one: a broad shelf that plausibly covers the "
    "topic beats leaving it unfindable. Answer 'other' ONLY when the topic has no "
    "honest relationship to any surviving shelf."
)

REASSIGN_SCHEMA = {
    "name": "orphan_reassignment",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "mapping": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "The leftover topic, verbatim."},
                        "to": {"type": "string", "description": "A surviving shelf name, or 'other'."},
                    },
                    "required": ["from", "to"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["mapping"],
        "additionalProperties": False,
    },
}


def _reassign_orphans(plan: dict, digest: list[dict], orphans: list[str]) -> int:
    """
    Re-home the sources of dissolved shelves onto surviving shelves.

    Without this, enforcing a minimum shelf size just relocates the sprawl into
    'other' — the links stay exactly as unfindable as before. Returns how many
    topics found a real shelf.
    """
    survivors = plan["categories"]
    if not survivors or not orphans:
        return 0

    samples = {d["category"]: d["samples"] for d in digest}
    counts = {d["category"]: d["count"] for d in digest}

    lines = ["Surviving shelves:"]
    for c in survivors:
        lines.append(f"- {c['name']}: {c['description']}")
    lines += ["", "Leftover topics needing a home:"]
    for o in orphans:
        lines.append(f"- {o} ({counts.get(o, 0)} links)")
        for s in samples.get(o, [])[:3]:
            lines.append(f"    · {s}")

    raw = _proxy_json(REASSIGN_SYSTEM, "\n".join(lines), REASSIGN_SCHEMA, max_tokens=1200)
    if not raw:
        return 0

    valid = {c["name"] for c in survivors}
    placed = 0
    for m in (raw.get("mapping") or []):
        if not isinstance(m, dict):
            continue
        src = str(m.get("from", "")).strip()
        dst = categorizer._norm_category(str(m.get("to", "")))
        if src in plan["mapping"] and dst in valid:
            plan["mapping"][src] = dst
            placed += 1
    return placed


def plan_consolidation(limit: int = CANON_LIMIT, use_llm: bool = True,
                       min_shelf: int = MIN_SHELF) -> dict:
    """
    Build a consolidation proposal. Pure read — writes nothing.

    Returns:
      {
        "limit": int,
        "engine": "proxy" | "fallback",
        "categories": [{"name", "description", "count"}],   # after the merge
        "mapping":    {old: new},
        "before": {"categories": int, "posts": int},
        "after":  {"categories": int},
        "merges": [{"to", "from": [...], "count"}],          # human review view
      }
    """
    digest = _digest()
    total_posts = sum(d["count"] for d in digest)

    plan = None
    engine = "fallback"
    note = ""
    if use_llm:
        raw = _proxy_json(
            DERIVE_SYSTEM.format(limit=limit, min_shelf=min_shelf),
            _digest_prompt(digest, limit),
            DERIVE_SCHEMA,
        )
        if raw:
            plan = _validate_plan(raw, digest, limit)
            if plan:
                engine = "proxy"
            else:
                note = "Model answered but the proposal failed validation."
        else:
            note = f"Every provider failed ({_LAST_ERROR['proxy'] or 'unknown'})."
    if plan is None:
        cats, mapping = _fallback_mapping(digest, limit)
        plan = {"categories": cats, "mapping": mapping}
        note = (note + " Falling back to keyword grouping, which is markedly "
                       "worse — review carefully or retry.").strip()

    counts = {d["category"]: d["count"] for d in digest}

    dissolved = _enforce_min_shelf(plan, counts, min_shelf)
    if dissolved:
        note = (note + f" Dissolved {', '.join(dissolved)} — under {min_shelf} links.").strip()

    # Anything sitting in 'other' with real content is still unfindable, whether
    # it got there from a dissolved shelf or because the model shrugged. Give it
    # one honest attempt at a real home.
    orphans = [o for o, n in plan["mapping"].items()
               if n == "other" and o not in RESERVED and counts.get(o, 0) > 0]
    if orphans and use_llm and engine == "proxy":
        placed = _reassign_orphans(plan, digest, orphans)
        if placed:
            note = (note + f" Re-homed {placed} of {len(orphans)} leftover topics.").strip()

    # Post count each shelf ends up holding.
    after: dict[str, int] = {}
    for old, new in plan["mapping"].items():
        after[new] = after.get(new, 0) + counts.get(old, 0)

    categories = sorted(
        [{**c, "count": after.get(c["name"], 0)} for c in plan["categories"]],
        key=lambda c: -c["count"],
    )

    # Group the mapping by destination so the change is reviewable at a glance.
    merges = []
    for dest in [c["name"] for c in categories] + sorted(RESERVED):
        sources = sorted(
            [o for o, n in plan["mapping"].items() if n == dest],
            key=lambda o: -counts.get(o, 0),
        )
        if sources:
            merges.append({
                "to": dest,
                "from": sources,
                "count": sum(counts.get(s, 0) for s in sources),
            })

    return {
        "limit": limit,
        "min_shelf": min_shelf,
        "engine": engine,
        "note": note,
        "categories": categories,
        "mapping": plan["mapping"],
        "before": {"categories": len([d for d in digest if d["category"] not in RESERVED]),
                   "posts": total_posts},
        "after": {"categories": len(categories)},
        "merges": merges,
    }


# ── Plan persistence ──────────────────────────────────────────────────────────

PLAN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taxonomy_plan.json")


def save_plan(plan: dict, path: str = PLAN_PATH) -> str:
    """Freeze a proposal to disk so the plan that gets reviewed is the plan that
    gets applied — derivation is not deterministic, so re-deriving at apply time
    would silently execute something the user never saw."""
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=2)
    return path


def load_plan(path: str = PLAN_PATH) -> Optional[dict]:
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    return plan if plan.get("mapping") and plan.get("categories") else None


def verify_plan(plan: dict) -> list[str]:
    """Problems that would make applying this plan lossy. Empty list means safe."""
    problems: list[str] = []
    digest = _digest()
    counts = {d["category"]: d["count"] for d in digest}
    mapping = plan.get("mapping") or {}
    canon = {c["name"] for c in (plan.get("categories") or [])}

    for cat in counts:
        if cat not in mapping:
            problems.append(f"'{cat}' ({counts[cat]} posts) has no destination")
    for src, dst in mapping.items():
        if dst not in canon | RESERVED:
            problems.append(f"'{src}' maps to '{dst}', which is not in the taxonomy")

    mapped_posts = sum(counts.get(s, 0) for s in mapping)
    total = sum(counts.values())
    if mapped_posts != total:
        problems.append(f"mapping covers {mapped_posts} posts but the library holds {total}")
    return problems


# ── Applying ──────────────────────────────────────────────────────────────────

def apply_consolidation(plan: dict) -> dict:
    """
    Execute an approved proposal: repoint posts, then rebuild the categories
    table so it holds exactly the canon (plus the reserved shelves).
    """
    mapping: dict[str, str] = plan["mapping"]
    canon = [c["name"] for c in plan["categories"]]

    conn = _connect()
    moved = 0
    try:
        with conn:
            for old, new in mapping.items():
                if old == new:
                    continue
                cur = conn.execute(
                    "UPDATE saved_posts SET category = ? WHERE category = ?", (new, old)
                )
                moved += cur.rowcount

            # Canon rows, ordered as proposed, so the sidebar reads largest-first.
            conn.execute("DELETE FROM categories")
            for i, name in enumerate(canon):
                conn.execute(
                    """INSERT OR REPLACE INTO categories (name, sort_order, created_at)
                       VALUES (?, ?, datetime('now'))""",
                    (name, i),
                )
            for name in sorted(RESERVED):
                conn.execute(
                    """INSERT OR REPLACE INTO categories (name, sort_order, created_at)
                       VALUES (?, ?, datetime('now'))""",
                    (name, 900 if name == "other" else 999),
                )
    finally:
        conn.close()

    return {"moved": moved, "categories": len(canon) + len(RESERVED)}


# ── Suggesting additions ──────────────────────────────────────────────────────

SUGGEST_SYSTEM = (
    "You review the links a personal library could not file. Existing shelves are "
    "given. Propose only categories that would each hold SEVERAL of these links — "
    "a shelf for one link is worthless. Propose nothing if the leftovers are just "
    "miscellaneous. Never propose a name that duplicates or narrowly restates an "
    "existing shelf. Names: 1-2 words, lowercase, hyphenated."
)

SUGGEST_SCHEMA = {
    "name": "category_suggestions",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "reason": {"type": "string", "description": "Why this shelf earns its place."},
                        "example_count": {"type": "integer", "description": "How many of the shown links would file here."},
                    },
                    "required": ["name", "reason", "example_count"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["suggestions"],
        "additionalProperties": False,
    },
}


def suggest_categories(max_suggestions: int = 3, sample: int = 40) -> list[dict]:
    """
    Look at posts that ended up unfiled and propose shelves worth adding.
    Read-only: suggestions are returned for the user to accept, never created.
    """
    conn = _connect()
    rows = conn.execute(
        """SELECT title, url, text FROM saved_posts
           WHERE category IN ('other', 'uncategorized')
           ORDER BY date_utc DESC LIMIT ?""",
        (sample,),
    ).fetchall()
    conn.close()
    if len(rows) < 3:
        return []

    existing = [c for c in storage.get_categories() if c not in RESERVED]
    lines = [f"Existing shelves: {', '.join(existing)}", "", "Unfiled links:"]
    for r in rows:
        label = (r["title"] or "").strip() or (r["text"] or "").strip()[:80] or (r["url"] or "")
        if label:
            lines.append(f"- {label[:110]}")

    raw = _proxy_json(SUGGEST_SYSTEM, "\n".join(lines), SUGGEST_SCHEMA, max_tokens=900)
    if not raw:
        return []

    existing_norm = {categorizer._norm_category(c) for c in storage.get_categories()}
    out = []
    for s in (raw.get("suggestions") or []):
        if not isinstance(s, dict):
            continue
        name = categorizer._norm_category(str(s.get("name", "")))
        if not name or name in existing_norm:
            continue
        try:
            n = int(s.get("example_count") or 0)
        except (TypeError, ValueError):
            n = 0
        if n < 2:  # a shelf for one link is exactly the problem we just fixed
            continue
        existing_norm.add(name)
        out.append({"name": name, "reason": str(s.get("reason", "")).strip(), "example_count": n})
    return out[:max_suggestions]


if __name__ == "__main__":
    import sys
    plan = plan_consolidation(use_llm="--no-llm" not in sys.argv)
    print(json.dumps(plan, indent=2))
