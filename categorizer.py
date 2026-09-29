"""
Hybrid categorizer with free-tier provider failover.

Strategy per post (in order):
  1. LiteLLM proxy ("dashboard-categorizer"): Groq -> Gemini -> Mistral
     -> local llama-server, with automatic 429 cooldowns (port 4000).
  2. Direct local LLM (config.LLM_BASE_URL) if the proxy is down.
  3. Keyword scoring for bare URLs or when every LLM path fails.

Classification is REUSE-ONLY. Every tier may only pick a category that already
exists, or fall back to 'other'. Growing the taxonomy is a separate, deliberate
act (see taxonomy.py) — letting the per-post path invent categories is exactly
what produced 32 shelves for 204 links, 23 of them holding one or two.

The LLM path enforces a strict JSON schema:
  category_name:  verbatim copy of one existing category, or 'other'
  suggested_tags: 3-5 lowercase micro-tags — where the lost detail now lives
  reasoning:      one short sentence (stored as the post summary)
"""

import difflib
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Optional

import config
import storage

# Regex to strip reasoning/thinking blocks from model output
_THINK_RE = re.compile(r'<' + 'think' + '>.*?<' + '/think' + '>', re.DOTALL)

PROXY_URL = getattr(config, "LITELLM_PROXY_URL", "http://127.0.0.1:4000") + "/v1/chat/completions"
PROXY_API_KEY = getattr(config, "LITELLM_PROXY_KEY", "sk-local-dashboard-proxy")
PROXY_MODEL = "dashboard-categorizer"


# Structural, not topical: never offered to the model as a shelf, never a
# fuzzy-match target. 'other' is chosen explicitly or not at all.
RESERVED_CATEGORIES = {"other", "uncategorized"}


def _norm_category(name: str) -> str:
    """Same normalization storage.add_category applies."""
    return name.strip().lower().replace(" ", "-")


def _stem(name: str) -> str:
    """Crude singular stem, enough to see that 'technologies' is 'technology'."""
    s = name.replace("-", "").replace("_", "")
    if len(s) > 5 and s.endswith("ies"):
        return s[:-3] + "y"
    for suffix in ("es", "s"):
        if len(s) > 4 and s.endswith(suffix):
            return s[: -len(suffix)]
    return s


def _snap_category(name: str, live: set[str]) -> str:
    """
    Resolve a model-supplied name to a shelf that exists, else 'other'.

    Three passes, narrowest first: exact, then singular/plural and punctuation
    differences, then a tight fuzzy match for near-spellings. Deliberately
    conservative — a wrong snap files a link where nobody will look for it, which
    is only marginally better than the sprawl this replaces.
    """
    if name in live:
        return name
    stems = {_stem(c): c for c in sorted(live)}
    hit = stems.get(_stem(name))
    if hit:
        return hit
    close = difflib.get_close_matches(name, sorted(live), n=1, cutoff=0.8)
    return close[0] if close else "other"


# ── Dynamic JSON schema ───────────────────────────────────────────────────────

_JSON_SCHEMA_PAYLOAD = {
    "name": "category_choice",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "category_name": {
                "type": "string",
                "description": "One shelf name copied verbatim from the list, or 'other'. Never a new name.",
            },
            "suggested_tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "3 to 5 lowercase micro-tags carrying the specifics the shelf name cannot.",
            },
            "reasoning": {
                "type": "string",
                "description": "One short sentence explaining why this shelf fits.",
            },
        },
        "required": ["category_name", "suggested_tags", "reasoning"],
        "additionalProperties": False,
    },
}

SYSTEM_PROMPT = (
    "You are the filing engine for one person's saved-links library.\n"
    "The shelves are fixed. Your only job is to put this link on the shelf where its "
    "owner will look for it later.\n\n"
    "Rules:\n"
    "1. Pick EXACTLY ONE shelf from the list you are given and copy its name verbatim.\n"
    "2. You may not invent a shelf. Adding one is the owner's decision, not yours — a "
    "library that grows a new shelf per link is a library nobody can browse.\n"
    "3. A broad shelf that plausibly covers the link beats 'other' every time. A link "
    "in 'other' is a link nobody finds again.\n"
    "4. Use 'other' only when the link has no honest relationship to any shelf.\n"
    "5. Put the specifics in the tags, not in the shelf name."
)


# ── Prompt assembly ───────────────────────────────────────────────────────────

_PLAN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taxonomy_plan.json")
_DESCRIPTIONS: Optional[dict[str, str]] = None


def shelf_descriptions() -> dict[str, str]:
    """
    What each shelf is for, from the frozen taxonomy plan.

    A bare name like 'arts-culture' is a weak instruction; "Art, music, film,
    design, folklore and philosophy" is a precise one, and precision is the whole
    game now that the model can only choose. Read as plain JSON rather than
    imported from taxonomy, which imports this module.
    """
    global _DESCRIPTIONS
    if _DESCRIPTIONS is None:
        found: dict[str, str] = {}
        try:
            with open(_PLAN_PATH, encoding="utf-8") as fh:
                for c in (json.load(fh).get("categories") or []):
                    name = _norm_category(str(c.get("name", "")))
                    desc = str(c.get("description", "")).strip()
                    if name and desc:
                        found[name] = desc
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            pass
        _DESCRIPTIONS = found
    return _DESCRIPTIONS


def _user_prompt(payload: str, existing: list[str]) -> str:
    """The single place the classification prompt is assembled."""
    desc = shelf_descriptions()
    lines = ["The library's shelves:"]
    for c in existing:
        name = _norm_category(c)
        if not name or name in RESERVED_CATEGORIES:
            continue
        lines.append(f"- {name}: {desc[name]}" if name in desc else f"- {name}")
    lines += [
        "- other: last resort, only if the link fits none of the shelves above.",
        "",
        "Saved link:",
        payload,
    ]
    return "\n".join(lines)


# ── Content detection ─────────────────────────────────────────────────────────

def _has_content(post: dict) -> bool:
    """Does this post have meaningful text beyond just a URL?"""
    title = (post.get("title") or "").strip()
    text = (post.get("text") or "").strip()
    url = (post.get("url") or "").strip()

    if title and title != url:
        return True
    if text and text != url and len(text) > len(url) + 5:
        return True
    return False


def _post_payload(post: dict) -> str:
    parts = []
    if post.get("title"):
        parts.append(f"Title: {post['title']}")
    if post.get("url"):
        parts.append(f"URL: {post['url']}")
    if post.get("text"):
        parts.append(f"Text: {post['text'][:1500]}")
    return "\n".join(parts) if parts else "(no content)"


# ── Proxy availability ────────────────────────────────────────────────────────

def proxy_available(timeout: float = 1.5) -> bool:
    """Cheap health probe of the LiteLLM proxy."""
    try:
        req = urllib.request.Request(
            PROXY_URL.rsplit("/v1/", 1)[0] + "/health/liveliness",
            headers={"Authorization": f"Bearer {PROXY_API_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


# ── JSON extraction helper (messy-output rescue) ─────────────────────────────

def _extract_json(raw: str) -> Optional[dict]:
    """Extract and parse JSON from messy LLM output."""
    if not isinstance(raw, str):
        return None
    raw = _THINK_RE.sub('', raw).strip()

    fence = re.search(r'```(?:json)?\s*\n?(.*?)```', raw, re.DOTALL)
    if fence:
        raw = fence.group(1).strip()

    brace_start = raw.find('{')
    brace_end = raw.rfind('}')
    if brace_start != -1 and brace_end > brace_start:
        raw = raw[brace_start:brace_end + 1]

    raw = re.sub(r',\s*([}\]])', r'\1', raw)
    try:
        result = json.loads(raw)
        return result if isinstance(result, dict) else None
    except (json.JSONDecodeError, ValueError):
        return None


def _validate_result(result: dict, existing: list[str]) -> Optional[dict]:
    """
    Clamp a parsed LLM result onto the real category list.

    Reuse-only. A name that is not a live shelf gets snapped to the closest one,
    and only falls through to 'other' when nothing is close. The behaviour this
    replaces — promoting an unmatched name to CREATE_NEW — is precisely how
    'folkloremythology' appeared alongside 'folklore'.
    """
    if not isinstance(result.get("category_name"), str):
        return None
    name = _norm_category(result["category_name"])
    tags = result.get("suggested_tags", [])
    if not isinstance(tags, list):
        tags = []
    tags = [str(t).strip().lower() for t in tags if str(t).strip()][:5]
    reasoning = str(result.get("reasoning", "")).strip()

    if not name:
        return None

    live = {_norm_category(c) for c in existing} - RESERVED_CATEGORIES
    name = _snap_category(name, live)

    return {
        "category_name": name,
        "suggested_tags": tags,
        "reasoning": reasoning,
    }


# ── Tier 1: LiteLLM proxy ─────────────────────────────────────────────────────

def auto_categorize_post(post_content: str, existing_categories: list[str]) -> Optional[dict]:
    """
    Send one post to the auto-switching proxy and return a structured
    classification. Returns None when the whole proxy stack fails so the
    caller can fall back to the direct local LLM or keywords.

    `post_content` is the raw post payload; the prompt around it is built here so
    there is exactly one copy of the shelf list in the request.
    """
    user_prompt = _user_prompt(post_content, existing_categories)
    headers = {
        "Authorization": f"Bearer {PROXY_API_KEY}",
        "Content-Type": "application/json",
    }
    base_payload = {
        "model": PROXY_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,  # low temp kills creative category hallucination
        "max_tokens": 1024,
    }

    # Attempt 1: strict json_schema. Attempt 2: plain json_object (some
    # routed providers don't support strict schemas).
    attempts = [
        {**base_payload, "response_format": {"type": "json_schema", "json_schema": _JSON_SCHEMA_PAYLOAD}},
        {**base_payload, "response_format": {"type": "json_object"}},
    ]

    for payload in attempts:
        try:
            req = urllib.request.Request(
                PROXY_URL, headers=headers,
                data=json.dumps(payload).encode("utf-8"), method="POST",
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw_result = json.loads(resp.read().decode("utf-8"))
            structured_content = raw_result["choices"][0]["message"]["content"]
            parsed = _extract_json(structured_content) or None
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError, TypeError):
            continue
        if parsed:
            validated = _validate_result(parsed, existing_categories)
            if validated:
                return validated
    return None


# ── Tier 2: direct local LLM (kept for proxy-less operation) ─────────────────

def _provider_errors() -> tuple:
    """Optional SDK errors, loaded only on the direct-provider path."""
    try:
        from openai import OpenAIError
    except ImportError:
        return (OSError,)
    return (OpenAIError, OSError)


def _get_client():
    """Create OpenAI client for the local server, verify with retries."""
    try:
        from openai import OpenAI
    except ImportError:
        return None
    try:
        client = OpenAI(base_url=config.LLM_BASE_URL, api_key=config.LLM_API_KEY,
                        timeout=10, max_retries=0)
    except (*_provider_errors(), ValueError):
        return None
    for attempt in range(3):
        try:
            client.models.list()
            return client
        except _provider_errors():
            if attempt < 2:
                wait = 2 ** (attempt + 1)
                print(f"  [categorizer] Optional LLM unavailable; retrying in {wait}s...")
                time.sleep(wait)
            else:
                return None


def _detect_model(client) -> str:
    """Auto-detect model name from the server."""
    try:
        for m in client.models.list():
            return m.id
    except (*_provider_errors(), AttributeError, TypeError):
        pass
    return config.LLM_MODEL


def _local_classify(client, model_name: str, post_content: str, existing: list[str]) -> Optional[dict]:
    """Direct local LLM call with the same reuse-only contract (json_object mode)."""
    schema_hint = json.dumps(_JSON_SCHEMA_PAYLOAD["schema"], separators=(",", ":"))
    system = (
        SYSTEM_PROMPT
        + "\nReturn ONLY a JSON object matching this schema: " + schema_hint
    )
    user_prompt = _user_prompt(post_content, existing)
    try:
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.1,
            max_tokens=1024,
            response_format={"type": "json_object"},
            extra_body={"reasoning_format": "none"},
        )
    except _provider_errors():
        return None
    try:
        raw = resp.choices[0].message.content
    except (AttributeError, IndexError, TypeError):
        return None
    parsed = _extract_json(raw)
    if parsed:
        return _validate_result(parsed, existing)
    return None


# ── Ingestion pipeline ────────────────────────────────────────────────────────

def apply_classification(tg_msg_id: int, result: dict, fallback_summary: str = "") -> str:
    """
    File one classified post:
      category -> an existing shelf, or 'other'
      tags     -> the post's searchable JSON tag array
      reasoning -> stored as the post summary

    Creates nothing. _validate_result has already clamped the name to a live
    shelf, so there is no path from ingesting a link to growing the taxonomy.
    Returns the final category name.
    """
    name = _norm_category(result["category_name"])
    summary = result.get("reasoning") or fallback_summary
    storage.update_classification(
        tg_msg_id=tg_msg_id,
        category=name,
        summary=summary,
        tags=result.get("suggested_tags", []),
    )
    return name


# ── Tier 3: keyword fallback ──────────────────────────────────────────────────

# Keyed by TOPIC, not by shelf. These regexes encode keyword knowledge that
# outlives any particular taxonomy, so a topic is resolved to a live shelf at
# classify time via TOPIC_ALIASES instead of being hard-wired to one name.
CATEGORY_RULES: dict[str, list[tuple[str, float]]] = {
    "fitness": [
        (r"\b(workout|gym|exercise|training|lift|weight|strength|muscle|bench|squat|deadlift|curl)\b", 3.0),
        (r"\b(fitness|fit|gains|bulk|cut|shred|hypertrophy|reps|sets)\b", 2.5),
        (r"\b(protein|creatine|supplement|pre.?workout|whey|bcaa)\b", 2.0),
        (r"\b(running|cardio|hiit|endurance|marathon|sprint)\b", 2.0),
        (r"\b(yoga|stretch|mobility|flexibility)\b", 1.5),
        (r"\b(bodybuilding|physique|aesthetic|lean)\b", 2.0),
        (r"\b(calories?|macros?|diet|nutrition|meal\s*plan)\b", 1.5),
    ],
    "philosophy": [
        (r"\b(philosophy|philosopher|philosophical)\b", 3.0),
        (r"\b(stoic|stoicism|epictetus|marcus\s*aurelius|seneca)\b", 3.0),
        (r"\b(nietzsche|aristotle|plato|socrates|kant|hegel|descartes)\b", 3.0),
        (r"\b(existential|absurd|nihilism|metaphysics|epistemology|ethics)\b", 2.5),
        (r"\b(meaning\s*of\s*life|consciousness|free\s*will|determinism)\b", 2.0),
        (r"\b(virtue|wisdom|contemplat|meditat|mindful)\b", 1.5),
        (r"\b(logic|reason|argument|dialectic|rational)\b", 1.0),
    ],
    "food-recipes": [
        (r"\b(recipe|recipes|cooking|cook\b|bake|baking)\b", 3.0),
        (r"\b(ingredient|ingredients|season|flavor|taste|delicious)\b", 2.0),
        (r"\b(pasta|rice|chicken|beef|fish|salmon|steak|egg|cheese|bread|soup|salad)\b", 1.5),
        (r"\b(oven|stove|pan|pot|skillet|grill|fry|boil|simmer|roast)\b", 1.5),
        (r"\b(sauce|dressing|marinade|spice|herb|garlic|onion|pepper)\b", 1.5),
        (r"\b(vegan|vegetarian|gluten.?free|keto|paleo|whole30)\b", 1.5),
        (r"\b(dessert|cake|cookie|pie|chocolate|ice\s*cream)\b", 1.5),
        (r"\b(kitchen|chef|culinary|gourmet|homemade)\b", 1.0),
    ],
    "technology": [
        (r"\b(python|javascript|rust|golang|typescript|java|cpp|code|programming)\b", 2.5),
        (r"\b(api|server|database|docker|kubernetes|cloud|deploy)\b", 2.0),
        (r"\b(ai|artificial\s*intelligence|machine\s*learning|llm|gpt|neural|model)\b", 2.5),
        (r"\b(computer|laptop|phone|gpu|cpu|ram|ssd|hardware)\b", 1.5),
        (r"\b(linux|windows|macos|android|ios|app|software)\b", 1.5),
        (r"\b(blockchain|crypto|bitcoin|web3|defi)\b", 2.0),
        (r"\b(github|git|open\s*source|repo|framework|library)\b", 1.5),
        (r"\b(cybersecurity|hack|exploit|vulnerability|encryption)\b", 1.5),
        (r"\b(startup|tech|silicon\s*valley)\b", 1.0),
    ],
    "finance": [
        (r"\b(invest|investing|stock|stocks|portfolio|dividend)\b", 2.5),
        (r"\b(trading|trader|market|bull|bear|etf|index\s*fund)\b", 2.5),
        (r"\b(money|budget|saving|savings|expense|income|salary)\b", 2.0),
        (r"\b(bank|banking|interest\s*rate|inflation|fed|federal\s*reserve)\b", 2.0),
        (r"\b(real\s*estate|mortgage|rent|property)\b", 2.0),
        (r"\b(tax|taxes|deduction|irs|401k|ira|roth)\b", 1.5),
        (r"\b(economy|economic|gdp|recession|fiscal|monetary)\b", 1.5),
        (r"\b(wealth|rich|financial|retire|passive\s*income)\b", 1.5),
    ],
    "travel": [
        (r"\b(travel|traveling|trip|vacation|holiday|tourism|tourist)\b", 3.0),
        (r"\b(flight|hotel|airbnb|hostel|booking|destination)\b", 2.5),
        (r"\b(country|city|beach|mountain|island|jungle|desert)\b", 1.5),
        (r"\b(passport|visa|border|customs|immigration)\b", 2.0),
        (r"\b(backpack|packing|itinerary|sightseeing|adventure)\b", 2.0),
        (r"\b(europe|asia|africa|america|japan|thailand|italy|spain|france)\b", 1.0),
    ],
    "music": [
        (r"\b(music|song|album|track|playlist|beat|melody|rhythm)\b", 3.0),
        (r"\b(guitar|piano|drums|bass|violin|synth|vocal|singer|band)\b", 2.5),
        (r"\b(spotify|apple\s*music|soundcloud)\b", 2.0),
        (r"\b(hip.?hop|rap|rock|jazz|classical|electronic|edm|pop|metal|punk)\b", 2.0),
        (r"\b(producer|mixing|mastering|recording|studio)\b", 1.5),
        (r"\b(concert|festival|gig|live\s*performance|tour)\b", 1.5),
    ],
    "art": [
        (r"\b(art|artwork|painting|drawing|sketch|illustration|design)\b", 3.0),
        (r"\b(artist|gallery|museum|exhibit|sculpture|canvas)\b", 2.5),
        (r"\b(photography|photo|camera|lens|portrait|landscape\s*photo)\b", 2.0),
        (r"\b(digital\s*art|3d|render|blender|photoshop|procreate)\b", 2.0),
        (r"\b(creative|creativity|aesthetic|visual|color\s*palette)\b", 1.5),
        (r"\b(animation|motion\s*graphics|film\s*making|cinematography)\b", 1.5),
    ],
    "science": [
        (r"\b(science|scientific|research|study|experiment|hypothesis)\b", 3.0),
        (r"\b(physics|chemistry|biology|mathematics|astronomy|geology)\b", 2.5),
        (r"\b(quantum|relativity|evolution|genetics|dna|cell|atom|molecule)\b", 2.5),
        (r"\b(nasa|space|planet|star|galaxy|universe|cosmos|telescope)\b", 2.0),
        (r"\b(climate|environment|ecology|species|ecosystem|biodiversity)\b", 1.5),
        (r"\b(neuroscience|brain|cognitive|psychology|behavioral)\b", 1.5),
        (r"\b(journal|paper|peer.?review|findings|data|analysis)\b", 1.0),
    ],
    "self-improvement": [
        (r"\b(self.?improv|personal\s*development|growth|better\b|improve)\b", 3.0),
        (r"\b(habit|habits|routine|discipline|motivation|productivity)\b", 2.5),
        (r"\b(meditation|mindfulness|journal|gratitude|affirm)\b", 2.0),
        (r"\b(book|reading|learn|education|course|skill)\b", 1.5),
        (r"\b(goal|goals|focus|priorit|time\s*manage|procrastin)\b", 1.5),
        (r"\b(confidence|mental\s*health|anxiety|stress|wellbeing|well.?being)\b", 1.5),
        (r"\b(morning\s*routine|daily\s*routine|wake\s*up|5\s*am)\b", 1.5),
    ],
    "business": [
        (r"\b(business|company|startup|entrepreneur|founder|ceo)\b", 3.0),
        (r"\b(marketing|sales|brand|customer|client|revenue|profit)\b", 2.5),
        (r"\b(product|launch|scale|growth\s*hack|funnel|conversion)\b", 2.0),
        (r"\b(management|leadership|team|hire|hiring|employee)\b", 2.0),
        (r"\b(strategy|competitive|market\s*share|pivot|monetize)\b", 1.5),
        (r"\b(saas|b2b|b2c|ecommerce|shopify)\b", 1.5),
        (r"\b(networking|pitch|investor|funding|venture\s*capital)\b", 1.5),
    ],
    "humor": [
        (r"\b(funny|hilarious|lol|lmao|lmfao|rofl|joke|meme)\b", 3.0),
        (r"\b(humor|comedy|comedian|standup|skit|parody|satire)\b", 2.5),
        (r"\b(prank|troll|viral|dank|shitpost)\b", 1.5),
    ],
    "news": [
        (r"\b(breaking|alert|report|announced|revealed|confirmed)\b", 2.0),
        (r"\b(president|government|congress|senate|election|vote|policy)\b", 2.5),
        (r"\b(war|conflict|crisis|disaster|emergency|protest)\b", 2.0),
        (r"\b(journalist|reporter|bbc|cnn|reuters|ap\s*news)\b", 2.5),
        (r"\b(law|legal|court|judge|trial|legislation|regulation)\b", 1.5),
        (r"\b(today|yesterday|just\s*in|update|developing)\b", 1.0),
    ],
}

_compiled_rules: dict[str, list[tuple[re.Pattern, float]]] = {}
for _cat, _patterns in CATEGORY_RULES.items():
    _compiled_rules[_cat] = [(re.compile(p, re.I), s) for p, s in _patterns]


# Where each keyword topic belongs when its own name is not a live shelf, in
# preference order. Without this the keyword tier would happily re-file links
# under 'food-recipes' and 'fitness' the moment a bare URL arrived, quietly
# rebuilding the sprawl the consolidation just removed.
TOPIC_ALIASES: dict[str, tuple[str, ...]] = {
    "fitness":          ("health-fitness", "health"),
    "self-improvement": ("health-fitness", "health"),
    "food-recipes":     ("food-drink", "food"),
    "philosophy":       ("arts-culture", "culture"),
    "music":            ("arts-culture", "culture"),
    "art":              ("arts-culture", "culture", "design"),
    "science":          ("technology",),
    "finance":          ("business-money", "business"),
    "business":         ("business-money", "finance"),
    "humor":            ("entertainment",),
    "news":             ("entertainment",),
    "travel":           ("travel-leisure",),
    "technology":       ("tech",),
}


def _resolve_topic(topic: str, live: Optional[set[str]]) -> str:
    """Map a keyword topic onto a shelf that actually exists, else 'other'."""
    if live is None:
        return topic
    for candidate in (topic,) + TOPIC_ALIASES.get(topic, ()):
        if candidate in live:
            return candidate
    return "other"


def _keyword_classify(text: str, live: Optional[set[str]] = None) -> tuple[str, list[str]]:
    """
    Score text against the keyword rules. Returns (category, tags).

    `live` is the set of shelves that exist; topics are resolved against it so
    this tier can never introduce a category. Passing None keeps the raw topic
    name, which is only useful for inspecting the rules directly.
    """
    if not text:
        return "other", []

    scores: dict[str, float] = {}
    matched: dict[str, list[str]] = {}

    for cat, patterns in _compiled_rules.items():
        cat_score = 0.0
        cat_tags = []
        for pattern, weight in patterns:
            m = pattern.search(text)
            if m:
                cat_score += weight
                cat_tags.append(m.group(1).strip().lower())
        scores[cat] = cat_score
        matched[cat] = cat_tags

    # Walk the topics strongest-first: the best-scoring topic may have no live
    # shelf, and the runner-up is a better answer than dumping it in 'other'.
    for topic in sorted(scores, key=lambda t: -scores[t]):
        if scores[topic] < 1.5:
            break
        shelf = _resolve_topic(topic, live)
        if shelf != "other":
            return shelf, list(dict.fromkeys(matched[topic]))[:5]

    return "other", []


def _build_summary(post: dict) -> str:
    """Build a short summary from available metadata."""
    parts = []
    if post.get("title"):
        parts.append(post["title"])
    elif post.get("url"):
        parts.append(post["url"])
    if post.get("text") and not post.get("title"):
        text = post["text"].strip().split("\n")[0][:120]
        if text:
            parts.append(text)
    return " - ".join(parts) if parts else ""


# ── Main orchestrator ─────────────────────────────────────────────────────────

def categorize_unprocessed(batch_size: int = 500, untagged_only: bool = False) -> int:
    """
    Hybrid categorizer with provider failover:
      content posts -> proxy -> local LLM -> keywords
      bare URL posts -> keywords only (no point spending tokens)
    untagged_only=True targets posts still parked in 'uncategorized'/'other'
    (the Bulk categorize sweep) instead of never-seen posts.
    Returns number of posts processed.
    """
    posts = storage.get_unprocessed_posts(limit=batch_size, untagged_only=untagged_only)
    if not posts:
        print("[categorizer] No unprocessed posts")
        return 0

    content_posts = [p for p in posts if _has_content(p)]
    bare_posts = [p for p in posts if not _has_content(p)]

    print(f"[categorizer] {len(posts)} posts: {len(content_posts)} with content, {len(bare_posts)} bare URLs")

    use_proxy = False
    client = None
    model_name = None

    if content_posts:
        if proxy_available():
            use_proxy = True
            print("[categorizer] Optional proxy online — provider failover active")
        else:
            print("[categorizer] Proxy offline — trying optional direct LLM...")
            client = _get_client()
            if client:
                model_name = _detect_model(client)
                print("[categorizer] Optional direct LLM connected")
            else:
                print("[categorizer] No LLM available — keyword fallback for all posts")

    existing = storage.get_categories()
    live = {_norm_category(c) for c in existing}
    processed = 0
    proxy_hits = local_hits = kw_hits = 0

    for post in content_posts:
        payload = _post_payload(post)
        result: Optional[dict] = None

        if use_proxy:
            result = auto_categorize_post(payload, existing)
            if result:
                proxy_hits += 1
        if result is None and client:
            result = _local_classify(client, model_name, payload, existing)
            if result:
                local_hits += 1

        if result:
            apply_classification(post["tg_msg_id"], result, _build_summary(post))
        else:
            combined = " ".join(filter(None, [post.get("title", ""), post.get("text", ""), post.get("url", "")]))
            category, tags = _keyword_classify(combined, live)
            storage.update_classification(post["tg_msg_id"], category, _build_summary(post), tags)
            kw_hits += 1

        processed += 1
        if processed % 10 == 0:
            print(f"  [{processed}/{len(posts)}] done")

    # Content posts already received either provider or keyword classification.
    for post in bare_posts:
        combined = " ".join(filter(None, [post.get("title", ""), post.get("text", ""), post.get("url", "")]))
        category, tags = _keyword_classify(combined, live)
        storage.update_classification(post["tg_msg_id"], category, _build_summary(post), tags)
        processed += 1

    print(f"[categorizer] Done: {processed} posts — proxy {proxy_hits}, local LLM {local_hits}, keywords {kw_hits + len(bare_posts)}")
    return processed


# ── On-demand classification (used by /api/categorize) ───────────────────────

def categorize_content(content: str, keywords_only: bool = False) -> dict:
    """
    Classify arbitrary content against the live category list without
    touching the database. Used by the SPA for library posts that live
    only in the local store. Falls back through the same tiers, and like
    every tier it can only return an existing shelf or 'other'.
    """
    existing = storage.get_categories()

    if not keywords_only and proxy_available():
        result = auto_categorize_post(content, existing)
        if result:
            return {**result, "engine": "proxy"}

    client = None if keywords_only else _get_client()
    if client:
        result = _local_classify(client, _detect_model(client), content, existing)
        if result:
            return {**result, "engine": "local-llm"}

    category, tags = _keyword_classify(content, {_norm_category(c) for c in existing})
    return {
        "category_name": category,
        "suggested_tags": tags,
        "reasoning": "Local keyword classification; unmatched content stays in other for review.",
        "engine": "keywords",
    }


# =====================================================================
# Production test simulation
# =====================================================================
if __name__ == "__main__":
    storage.init_db()
    my_dashboard_categories = storage.get_categories() or [
        "Software Development", "Cooking Recipes", "Fitness & Health",
    ]

    test_post_1 = "I found an amazing tutorial on building multi-tenant microservices using FastAPI and Docker containers."
    print("Processing Post 1...")
    if proxy_available():
        result_1 = auto_categorize_post(test_post_1, my_dashboard_categories)
    else:
        result_1 = None
    print(json.dumps(result_1 or {"error": "proxy offline"}, indent=2))

    test_post_2 = "Yield curves are flattening and the Federal Reserve might cut interest rates by 25 basis points next quarter."
    print("\nProcessing Post 2...")
    if proxy_available():
        result_2 = auto_categorize_post(test_post_2, my_dashboard_categories)
    else:
        result_2 = None
    print(json.dumps(result_2 or {"error": "proxy offline"}, indent=2))
