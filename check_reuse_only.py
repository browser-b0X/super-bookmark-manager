"""Prove the per-post categorizer can no longer grow the taxonomy."""

import categorizer
import storage

LIVE = storage.get_categories()
LIVE_SET = {categorizer._norm_category(c) for c in LIVE}
SHELVES = LIVE_SET - categorizer.RESERVED_CATEGORIES
print("live shelves:", sorted(SHELVES), "\n")

fails = 0


def check(label, got, ok):
    global fails
    if not ok:
        fails += 1
    print("{:4} {:<44} -> {}".format("ok" if ok else "FAIL", label, got))


# 1. Schema no longer offers an invention path.
check("schema has no category_action",
      sorted(categorizer._JSON_SCHEMA_PAYLOAD["schema"]["properties"]),
      "category_action" not in categorizer._JSON_SCHEMA_PAYLOAD["schema"]["properties"])

# 2. A brand-new name from the model must not survive validation.
for invented in ["folkloremythology", "haircare", "biohacking", "modelas", "legal"]:
    r = categorizer._validate_result(
        {"category_name": invented, "suggested_tags": ["x"], "reasoning": "r"}, LIVE)
    check(f"invented '{invented}' clamped", r["category_name"],
          r["category_name"] in SHELVES | {"other"})

# 3. Near-spellings of a real shelf snap onto it instead of forking.
for typo, want in [("technologies", "technology"), ("Social Media", "social-media"),
                   ("food-drinks", "food-drink")]:
    r = categorizer._validate_result(
        {"category_name": typo, "suggested_tags": [], "reasoning": ""}, LIVE)
    check(f"'{typo}' snaps to {want}", r["category_name"], r["category_name"] == want)

# 4. Keyword tier: old topic names must resolve onto live shelves.
cases = [
    ("chicken pasta recipe with garlic sauce, bake in the oven", "food-drink"),
    ("gym workout hypertrophy squat deadlift protein", "health-fitness"),
    ("stoicism marcus aurelius on virtue and meaning", "arts-culture"),
    ("quantum physics research paper on genetics and dna", "technology"),
    ("investing in index funds, dividend portfolio, etf", "business-money"),
    ("hilarious meme, standup comedy skit", "entertainment"),
]
for text, want in cases:
    got, tags = categorizer._keyword_classify(text, LIVE_SET)
    check(f"keyword '{text[:34]}...' -> {want}", got, got == want)

# 5. The keyword tier must never emit a non-live name, whatever the input.
import random
random.seed(0)
words = ("recipe workout stoic quantum etf meme travel guitar fashion haircare "
         "gardening legal news model coffee").split()
leaked = set()
for _ in range(400):
    text = " ".join(random.choice(words) for _ in range(6))
    got, _t = categorizer._keyword_classify(text, LIVE_SET)
    if got not in LIVE_SET:
        leaked.add(got)
check("400 random inputs leak no new name", leaked or "none", not leaked)

# 6. The prompt actually carries the shelf descriptions.
prompt = categorizer._user_prompt("Title: A pasta recipe", LIVE)
check("prompt lists shelves with descriptions",
      prompt.splitlines()[1],
      "food-drink:" in prompt and "uncategorized" not in prompt)

# 7. Live proxy call: does the real model stay inside the shelf list?
if categorizer.proxy_available():
    probes = [
        "Title: 17th-century Baltic folklore about lake spirits",
        "Title: Best creatine dosage for lean bulking",
        "Title: A guide to espresso extraction ratios",
        "Title: New Rust async runtime benchmark",
    ]
    for p in probes:
        r = categorizer.auto_categorize_post(p, LIVE)
        got = r["category_name"] if r else "(no answer)"
        check(f"proxy: {p[7:44]}", got, bool(r) and got in SHELVES | {"other"})
else:
    print("\n  proxy offline — skipped the live model probe")

print("\n{} check(s) failed".format(fails) if fails else "\nall checks passed")
raise SystemExit(1 if fails else 0)
