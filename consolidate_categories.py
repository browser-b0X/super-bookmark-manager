"""One-off: author the reviewed consolidation plan and freeze it to disk.

Run with --apply to execute it. Without --apply it only prints and saves the
proposal, so the plan can be reviewed before anything touches the database.
"""

import sys

import taxonomy

# Destination -> (description, source categories it absorbs).
# Derived from a corpus-level LLM pass over all 204 links; the tail assignments
# the model got wrong (science -> culture, a "travel + coffee + humour + news"
# grab-bag shelf) are corrected here.
CANON = [
    ("food-drink",     "Recipes, cooking, ingredients and coffee.",
     ["food-recipes", "coffee"]),
    ("technology",     "AI, software, engineering, science and cars.",
     ["technology", "science", "automotive"]),
    ("social-media",   "Platform tactics, growth, creators and content strategy.",
     ["socialmedia"]),
    ("health-fitness", "Training, medical, wellness, biohacking, self-improvement.",
     ["fitness", "health", "biohacking", "self-improvement"]),
    ("arts-culture",   "Art, music, film, design, folklore and philosophy.",
     ["art", "music", "filmproduction", "designtips", "folklore",
      "folkloremythology", "philosophy"]),
    ("entertainment",  "Humour, news, models and adult content.",
     ["humor", "news", "modelas", "adultcontent"]),
    ("business-money", "Finance, business, legal and local commerce.",
     ["finance", "business", "legal", "localbusiness", "communityresources"]),
    ("style-beauty",   "Fashion, hair and natural cosmetics.",
     ["fashion", "haircare", "naturalcosmetics"]),
    ("travel",         "Destinations, trips and places to go.",
     ["travel"]),
]

# Genuinely miscellaneous: one gardening link with no shelf to join.
TO_OTHER = ["gardening"]


def build() -> dict:
    mapping = {"other": "other", "uncategorized": "uncategorized"}
    for name in TO_OTHER:
        mapping[name] = "other"
    categories = []
    for name, desc, sources in CANON:
        categories.append({"name": name, "description": desc})
        for s in sources:
            mapping[s] = name

    plan = {
        "limit": taxonomy.CANON_LIMIT,
        "min_shelf": taxonomy.MIN_SHELF,
        "engine": "proxy+curated",
        "note": "Corpus-level LLM derivation with hand-corrected tail assignments.",
        "categories": categories,
        "mapping": mapping,
    }

    digest = taxonomy._digest()
    counts = {d["category"]: d["count"] for d in digest}
    after: dict[str, int] = {}
    for old, new in mapping.items():
        after[new] = after.get(new, 0) + counts.get(old, 0)
    for c in categories:
        c["count"] = after.get(c["name"], 0)

    plan["categories"] = sorted(categories, key=lambda c: -c["count"])
    plan["before"] = {
        "categories": len([d for d in digest if d["category"] not in taxonomy.RESERVED]),
        "posts": sum(counts.values()),
    }
    plan["after"] = {"categories": len(categories)}
    plan["merges"] = [
        {
            "to": c["name"],
            "count": c["count"],
            "from": sorted([o for o, n in mapping.items() if n == c["name"]],
                           key=lambda o: -counts.get(o, 0)),
        }
        for c in plan["categories"]
    ] + [
        {
            "to": "other",
            "count": after.get("other", 0),
            "from": sorted([o for o, n in mapping.items() if n == "other"],
                           key=lambda o: -counts.get(o, 0)),
        }
    ]
    return plan, counts


def main() -> int:
    plan, counts = build()

    problems = taxonomy.verify_plan(plan)
    if problems:
        print("PLAN IS LOSSY:")
        for p in problems:
            print("  -", p)
        return 1
    print("verified: every category has a destination, nothing is dropped\n")

    for m in plan["merges"]:
        srcs = ", ".join(f"{s} ({counts.get(s, 0)})" for s in m["from"] if s != m["to"])
        line = "{:>4}  {:<16}".format(m["count"], m["to"])
        print(line + ("  <- " + srcs if srcs else ""))

    total = sum(m["count"] for m in plan["merges"])
    print("\ntotal {} / {} posts".format(total, plan["before"]["posts"]))
    print("{} categories -> {} shelves + other".format(
        plan["before"]["categories"], plan["after"]["categories"]))
    thin = [c["name"] for c in plan["categories"] if c["count"] < plan["min_shelf"]]
    print("shelves under the {}-link minimum: {}".format(
        plan["min_shelf"], thin or "none"))
    print("frozen to", taxonomy.save_plan(plan))

    if "--apply" in sys.argv:
        stats = taxonomy.apply_consolidation(plan)
        print("\nAPPLIED:", stats)
    else:
        print("\nDry run. Re-run with --apply to execute.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
