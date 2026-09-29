# Super Bookmark Manager v0.1.0 — first public release (draft)

A local-first bookmark manager for organizing browser bookmarks and Telegram Saved
Messages on Windows.

- Browser bookmark HTML, copied Chromium JSON and copied Firefox Places imports.
- Telegram Saved Messages, including a built-in developer-credential and login/session workflow.
- Automatic categorization, search/filtering, notes, tags, categories and reading-state editing.
- Saved Views, local Related Items and Catch Up.
- Local SQLite storage and library backup/restore.
- Self-contained per-user Windows installer; end users need no Python or Node.

## Optional AI-assisted categorization

No AI-provider account, API key or proxy is required. Browser and Telegram imports
use built-in deterministic categorization. Manual Categorize and legacy bulk
categorization fall back to keywords when an optional provider is unavailable;
bulk processes each post once. Advanced environment/proxy configuration remains
optional. No provider setup fields or provider SDKs are included in the release.
Category suggestions return no proposals when a provider is unavailable.

## Installation and compatibility

The intended release asset is `SuperBookmarkManager-Setup.exe`, accompanied by
`SuperBookmarkManager-Setup.exe.sha256`. Launch Super Bookmark Manager from the Start
Menu after installation. Existing `%LOCALAPPDATA%\SavedPostsDashboard\` data is retained;
there is no data migration. Uninstall preserves this user-data directory by default.

## Known limitations

- The installer is unsigned and may trigger SmartScreen/antivirus warnings.
- **SIGNING NOT PERFORMED — NO CONFIGURED CODE-SIGNING IDENTITY.**
- B3: historical mobile blank-band cause unresolved; current controlled matrix clean.
  The historical issue was not reproduced and is not claimed fixed.
- Windows is the verified packaged-release platform. Same-machine clean-source and
  isolated synthetic checks do not establish separate-machine/VM compatibility.
- Saved Views/preferences are browser-local and excluded from library backups.

## Proposed GitHub metadata

Repository: `super-bookmark-manager`  
Description: `A local-first bookmark manager for organizing browser bookmarks and Telegram Saved Messages on Windows.`  
Topics: `bookmark-manager`, `bookmarks`, `local-first`, `telegram`, `read-it-later`, `sqlite`, `windows`  
Version: `v0.1.0`  
License: MIT; copyright 2026 browser-b0X.

Future publication must initialize **fresh public history from the curated current
public-source tree**. Do not publish the existing internal development history unchanged.
This draft does not authorize or perform repository creation, commits, tags, uploads
or publication. See [RELEASE_READINESS.md](RELEASE_READINESS.md) for verification status.
