# Super Bookmark Manager v0.2.0 — the feed release (draft)

A local-first feed for the links you save — browser bookmarks, Telegram Saved
Messages and WhatsApp chats — on Windows.

## What's new

- **One feed.** Catch Up and the library are now a single page. New, unsorted links
  drift across the top in a loop that pauses on hover; keep, save for later or
  archive each one in place. Everything you keep sits below as picture-first tiles
  whose details slide up on hover. Drag tiles into your own order ("My order").
  When nothing new is waiting, Rediscover brings back a few older favourites.
- **WhatsApp imports.** Import a chat exported from your phone (`.txt` or `.zip`,
  "Without media") — handy with *Message yourself*.
- **One-drop imports.** Drop any supported file in Settings → Sources; the format is
  detected, you see a preview (choose folders, file a folder onto a shelf) and can
  undo the import.
- **Cards for posts without pictures.** X, TikTok, Instagram, Facebook, Threads,
  Reddit, LinkedIn, Bluesky and YouTube links are drawn in the spirit of their
  platform; other pages get a link-preview card (site, title, description; owner /
  repo for GitHub). Instagram previews fall back to the public embed.
- **Optional AI with your own free keys.** Settings → AI & previews takes keys for
  Google Gemini, Groq, OpenRouter and NVIDIA NIM, or a local Ollama-style server,
  with a Test button. Providers fail over in order, and a model the provider has
  retired is replaced automatically (NVIDIA now defaults to Gemma 4 31B). The
  tidy-up runs two batches at a time across your providers, waits out busy free
  tiers instead of settling for keyword guesses, and says which links still need you. A review-first tidy-up suggests
  shelves, tags, clean titles and one-line summaries; nothing is saved until you
  accept it and your own edits are never overwritten.
- **Search and organizing.** Operators such as `site:github.com`, `#tag`,
  `is:later`, `shelf:` and `in:`; lists for New, All saved, Later, In progress,
  Kept, Favorites, Unfiled and Archived; platform filters in the sidebar.
- **Save status as a toast.** A small toast at the bottom of the page appears only
  while links are saving or previews are loading (or when something needs you),
  then fades. The sidebar no longer changes size.
- **Updates take over cleanly.** Starting a newer build replaces an older copy
  still running in the background, and the installer stops a running copy first.
  Settings → Application shows which build is running.
- **Quit from the sidebar.** A power button next to Settings stops the app after a
  confirmation, saves pending changes first, and leaves a clear "stopped" page.
- **Look and feel.** New light and dark themes with a slow geometric background
  (still under reduced motion), a steady save indicator, Settings grouped into
  sections, and a GitHub button in the header for bug reports and ideas.
- **Reliability.** Faster delta sync with SQLite, one identity per URL with safe
  duplicate repair, recoverable sync errors, preview images cached locally, and
  safer restores.

## Upgrading from v0.1.0

v0.2.0 stores data in `%LOCALAPPDATA%\SuperBookmarkManager\`. The v0.1.0 data in
`%LOCALAPPDATA%\SavedPostsDashboard\` is left untouched and not imported
automatically: export a backup from v0.1.0's Settings first, then restore it in
v0.2.0 under Settings → Backup. Quit the app before installing the upgrade.

The program now installs into `%LOCALAPPDATA%\Programs\SuperBookmarkManager\`. Upgrading
from an older install removes the old `...\Programs\SavedPostsDashboard\` program folder
(program files only) and keeps your Start Menu and Desktop shortcuts working.

## Installation

Release assets: `SuperBookmarkManager-Setup.exe` and
`SuperBookmarkManager-Setup.exe.sha256`. Per-user install, no admin rights, no
Python or Node needed. Launch from the Start Menu; the app opens in your browser.

## Known limitations

- The installer is unsigned and may trigger SmartScreen/antivirus warnings.
- Windows is the verified packaged-release platform.
- Saved views and display preferences are browser-local and not part of backups.
- AI suggestions depend on each provider's free-tier limits and model availability.

## Proposed GitHub metadata

Description: `A local-first feed for links saved from browsers, Telegram and WhatsApp — previews, shelves, search and optional AI tidying. Windows.`  
Topics: `bookmark-manager`, `bookmarks`, `local-first`, `telegram`, `whatsapp`, `read-it-later`, `sqlite`, `windows`  
Version: `v0.2.0`  
License: MIT; copyright 2026 browser-b0X.

See [RELEASE_READINESS.md](RELEASE_READINESS.md) for the release checklist.
