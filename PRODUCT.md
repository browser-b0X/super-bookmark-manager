# Super Bookmark Manager

## What it is

A private, local-first reading queue for links the owner sends to their own Telegram
Saved Messages. One person, one library, one machine. Links arrive from Telegram,
get enriched with metadata, get filed onto a shelf by local keyword categorization, and wait to be
caught up on.

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
speed beats choreography.

## Non-negotiables

- **Local-first.** Works with the backend down; SQLite is the source of truth when it's up.
- **A browsable number of shelves.** Hard cap of 12. A category per link is the same
  as no categories at all — this is why classification is reuse-only.
- **Nothing is ever silently lost.** Import is idempotent; deletes are confirmed;
  organisation is never overwritten by a re-sync.
- **Motion conveys state, never decorates.** 150–250ms. The owner is mid-task.

## Surfaces

| Surface | Purpose |
|---|---|
| `/` Catch Up | The landing page. What's new, what's unfiled, what to read next. |
| `/library` | Browse and search everything kept, by shelf, tag, platform, status. |
| `/library/item/:id` | One link in full, with notes and filing controls. |
| `/library/settings` | Import, re-sync, enrichment, bulk categorize. |

## Stack

Flask + SQLite backend, React 18 + TypeScript + Vite frontend, Zustand (persisted)
store, Tailwind v4 with CSS custom-property tokens in `src/styles.css`. Automatic import
classification uses local keywords without provider credentials. Manual classification
can use an optional LiteLLM proxy (Groq → Gemini → Mistral → local); its direct-server
fallback requires the OpenAI SDK, which the standalone package excludes.
