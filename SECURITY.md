# Security and privacy

## Reporting

Prefer GitHub private vulnerability reporting when it is available on this repository.
Otherwise contact the repository owner through a private channel you already know.
Do not post sensitive details in a public issue. No security-report email address or
response-time guarantee is currently established.

## Sensitive files

Do not publicly attach:

- `config.json`, `.env` or other API credential files;
- Telegram `.session` files or their database sidecars;
- personal SQLite databases or backup exports;
- screenshots containing private saved content;
- API credentials, verification codes or 2FA passwords.

Reproduce bugs with synthetic links and redacted details. Library backups can contain
private URLs, notes and saved content even though they exclude credentials/session data.

## Security model

Super Bookmark Manager is a local-first, single-user application served on loopback.
It has no central project account. The Windows package retains
`%LOCALAPPDATA%\SavedPostsDashboard\` for compatibility, including local SQLite,
configuration and Telegram session storage. No data migration is performed.

Telegram API ID/Hash and sessions stay local and use Windows user-local filesystem
permissions. This is not an encrypted credential vault or a defense against a
compromised Windows account. Verification codes and 2FA passwords are used for the
active login flow and are not persisted. Sessions are excluded from library backups,
installer payloads and repository source. No shared project Telegram credentials exist.

Telegram network operations are explicit: connect, test authorization, logout and
refresh. Metadata enrichment for newly imported links contacts saved-link hosts and
permitted preview resources as part of normal behavior. Configured providers may
also receive link content; local keyword fallback does not require one. Browser
imports read selected file copies, not live profile discovery. Do not expose the local
server to an untrusted network or treat it as a multi-user hosted service.

The Windows release candidate is unsigned. No production signing identity has been
configured. Current-machine synthetic tests are not a cross-machine security audit.
