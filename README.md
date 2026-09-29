# Super Bookmark Manager

<img src="frontend/public/brand-logo.svg" alt="Super Bookmark Manager logo" width="96" height="96" />

**A local-first bookmark manager for organizing browser bookmarks and Telegram Saved Messages on Windows.**


## Features

- Import browser bookmarks and Telegram Saved Messages into one library.
- Automatic categorization with a bounded set of shelves and keyword fallback.
- Search and filter; edit notes, reading status, tags and categories.
- Save reusable filters with Saved Views and find Related Items locally.
- Catch Up on unread links, with previews when available.
- Export and restore library backups; keep durable records in local SQLite storage.

## Installation

When the first public release is published, download `SuperBookmarkManager-Setup.exe`
and its checksum from this repository's Releases page. This source preparation does
not itself publish a release. Run the installer for your Windows user, then launch
**Super Bookmark Manager** from the Start Menu. Administrator elevation, Python,
Node and npm are not required for normal use. The application opens in your browser
at `http://127.0.0.1:5001`; keep its local server window open while using it.

The release candidate is **unsigned** and may trigger Windows SmartScreen or antivirus
warnings. Check the SHA-256 against the release checksum before running it.

## Browser imports

In Library Settings, select an exported bookmark HTML file, a copied Chromium
`Bookmarks` JSON file, or a copied Firefox `places.sqlite` file. Export HTML from
your browser's bookmark manager, or make a consistent database/file copy with the
browser closed. Imports read only files you explicitly select; the application does
not scan live browser profiles. Firefox history-only rows are excluded. Reimports
merge links without intentionally replacing your curation.

## Telegram setup

1. Obtain your personal API ID and API Hash through [Telegram's API development tools](https://my.telegram.org).
2. Open **Settings → Telegram Integration**.
3. Save your developer credentials.
4. Choose **Connect Telegram**.
5. Enter your phone number.
6. Enter the verification code Telegram sends you.
7. Enter your two-step verification password only if requested.
8. Use **Refresh Telegram Saved Messages** to import messages explicitly.

API ID/Hash identify your Telegram application; they do not log you in. The Connect
flow establishes your local account session. There are no shared project API
credentials. Refresh reads up to 200 recent messages (or a smaller configured limit).
Telegram Desktop Saved Messages JSON exports can also be imported through Settings.
Follow the export instructions there; manual Telethon scripts are not needed.

## Local data and privacy

There is no central Super Bookmark Manager account. The packaged application stores
its SQLite database, local configuration and Telegram session on your machine.

**Super Bookmark Manager retains the legacy `%LOCALAPPDATA%\SavedPostsDashboard\`
user-data directory for compatibility with existing installations.** No migration is
needed. `SAVED_POSTS_DB_PATH` can explicitly select another database.

API ID/Hash are stored locally in `config.json`; the Telegram session is stored in
`session.session`. Windows user-local filesystem permissions protect these files;
this is **not an encrypted credential vault**. Verification codes and 2FA passwords
are not persisted. Session and credential files are excluded from repository source,
installer payloads and library backups. Anyone with access to your Windows account
or its files may still obtain sensitive information.

User-created backups are local library exports. Restore creates a separate database
for an explicit switch; it does not silently replace your active library. Saved Views
and display preferences are browser-local, tied to the browser profile and site
address, and excluded from library backups.

## Network activity

Telegram connection, authorization testing, logout and refresh contact Telegram when
you explicitly invoke them. Newly imported links may trigger metadata enrichment,
which contacts saved-link hosts and permitted redirects/images to obtain previews.
Opening a saved link visits its site. Automatic categorization during browser and
Telegram imports uses local keywords and requires no AI-provider API key. The manual
Categorize, Bulk categorize and category-suggestion controls can contact a configured
provider/proxy, which can receive link content. Provider setup is not exposed in Settings.
This is local-first, **not offline-only** or zero-network.

## Optional AI-assisted categorization

Super Bookmark Manager does not require an AI-provider account, API key, LiteLLM or
a proxy. Normal browser and Telegram imports use built-in deterministic categorization.
Advanced/developer installations may configure the existing provider-compatible backend.
Manual Categorize and Bulk categorize fall back to the built-in classifier when optional
provider infrastructure is unavailable or returns an unusable response. The installer
does not bundle provider SDKs. Provider setup is intentionally absent from Settings in v0.1.0.

Bulk categorize operates on legacy backend records. Category suggestions are optional,
read-only proposals for new shelves from unfiled legacy records; without a provider,
they return no proposals. They do not change the deterministic import classifier.

## Uninstall

Uninstall **Super Bookmark Manager** in Windows Settings → Apps. Program files and
shortcuts are removed; user data is retained by default. For complete removal, stop
the application, keep any wanted backups, and manually remove
`%LOCALAPPDATA%\SavedPostsDashboard\`. Separately remove any database path you selected
with `SAVED_POSTS_DB_PATH`, exported backups and browser site data if desired.

## Building from source

See [BUILDING.md](BUILDING.md) for developer prerequisites, exact build commands,
outputs and the limits of same-machine clean-source verification. Windows is the
verified packaged-release platform.

## Security

See [SECURITY.md](SECURITY.md) before sharing logs, screenshots or bug reports.

## Feedback & Suggestions

Help make **browser-b0X** better.

-🐛 **Found a bug?** Submit a structured [Bug Report](https://github.com/browser-b0x/super-bookmark-manager/issues/new/choose)
-💡 **Have an idea or question?** Start a discussion in [GitHub Discussions](https://github.com/browser-b0x/super-bookmark-manager/discussions)
-🤝 **Want to contribute?** Pull requests and improvements are always welcome.


##  Support the project

<p align="center">
  <a href="https://ko-fi.com/browserb0x">
    <img src="https://img.shields.io/badge/☕_Support_on_Ko--fi-29C6E8?style=for-the-badge&logo=kofi&logoColor=white" alt="Support browser-b0X on Ko-fi">
  </a>
  &nbsp;
  <a href="https://buymeacoffee.com/browserbox">
    <img src="https://img.shields.io/badge/☕_Buy_Me_a_Coffee-875CFF?style=for-the-badge&logo=buymeacoffee&logoColor=white" alt="Support browser-b0X on Buy Me a Coffee">
  </a>
</p>

> Every contribution is appreciated, but never expected.  
> Using the project, reporting bugs, and sharing it with others helps too.

## License

[MIT](LICENSE), copyright 2026 browser-b0X. Dependency licenses are listed separately
in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
