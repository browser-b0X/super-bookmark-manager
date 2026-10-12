# SuperBookmarks

(Called Super Bookmark Manager up to v0.2.0.)

## What it is

A private, local-first feed for links the owner saves: browser bookmarks, Telegram
Saved Messages and links sent to themselves on WhatsApp. One person, one library, one
machine. Links arrive, get enriched with previews, get filed onto a shelf (by local
keyword rules, or by optional AI suggestions the owner reviews), and wait in the feed
to be caught up on.

## Register

`product` — design serves the task. The user is here to get through a backlog, not
to admire the interface.

## The one job

**Catch up on saved links.** Everything else is in service of that: filing exists so
you can find a link later; enrichment exists so you can recognise a link without
opening it; the library exists so you can browse what you've kept.

Features that don't serve catching up are dilution. This has already been a real
failure mode here — the app grew a widget dashboard with tasks, notes, capture,
system stats and an activity feed, none of which are why the tool exists.

## Who uses it, where

One person, on a laptop, in the evening, in a dim room, working through what they
saved during the day. Dark theme is not a style choice — it's the ambient light of
the actual usage. Sessions are short and repeated, so density beats spaciousness and
speed beats choreography. Dark is the default; a light theme exists for daytime use.

## Non-negotiables

- **Local-first.** Works with the backend down; SQLite is the source of truth when it's up.
- **A browsable number of shelves.** Hard cap of 12. A category per link is the same
  as no categories at all — this is why classification is reuse-only.
- **Nothing is ever silently lost.** Import is idempotent; deletes are confirmed;
  organisation is never overwritten by a re-sync.
- **Motion conveys state.** 150–250ms for interactions; the owner is mid-task. The only
  ambient motion (the drifting shelf rows and the slow background) pauses on hover
  or stops entirely under reduced motion.

## Surfaces

| Surface | Purpose |
|---|---|
| `/` Home | New links one at a time for keep / later / archive (arrow keys), with Up next, follow-ups due and an old favourite beside them; every shelf is a row below. |
| `/library/*` | Lists (New, All saved, Later, Kept, Favorites, Unfiled, Archived), shelves, platforms, tags and saved views. |
| `/library/item/:id` | One link in full, with notes and filing controls. |
| `/library/settings` | Sources and imports, AI & previews, library & sync, backup. |

## Stack

Flask + SQLite backend, React 18 + TypeScript + Vite frontend, Zustand (persisted)
store, Tailwind v4 with CSS custom-property tokens in `src/styles.css`. Automatic import
classification uses local keywords without provider credentials. Optional AI review
(shelf, tags, clean title, summary) calls OpenAI-compatible endpoints directly with the
standard library, in order FreeLLMAPI (a router the owner runs, when set up) → Gemini → Groq →
OpenRouter → NVIDIA NIM → local, using keys the owner adds in Settings (`ai.json` in the data
directory). No provider SDK is bundled.
