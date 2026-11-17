# Security and privacy

## Reporting

Report security problems privately through GitHub:
[Report a vulnerability](https://github.com/browser-b0X/super-bookmark-manager/security/advisories/new)
(the **Security** tab → **Report a vulnerability**). Do not post sensitive details in a
public issue. No security-report email address or response-time guarantee is currently
established.

## Official sources

Get SuperBookmarks only from
[github.com/browser-b0X/super-bookmark-manager](https://github.com/browser-b0X/super-bookmark-manager)
(Releases) or its website,
[browser-b0x.github.io/super-bookmark-manager](https://browser-b0x.github.io/super-bookmark-manager/).
Check the installer's SHA-256 against the checksum published with the release. Treat a
download from anywhere else as untrusted, and never give an unofficial copy your Telegram
or AI keys. If you find one, please report it.

## Sensitive files

Do not publicly attach:

- `config.json`, `ai.json`, `.env` or other API credential files;
- Telegram `.session` files or their database sidecars;
- personal SQLite databases or backup exports;
- screenshots containing private saved content;
- API credentials, verification codes or 2FA passwords.

Reproduce bugs with synthetic links and redacted details. Library backups can contain
private URLs, notes and saved content even though they exclude credentials/session data.

## Security model

SuperBookmarks is a local-first, single-user application served on loopback.
It has no central project account. The Windows package keeps local SQLite, the
thumbnail cache, saved copies (`archive\`, including Telegram photos and videos kept
with a link), the optional video helper (`helpers\`), configuration, AI keys and the
Telegram session in `%LOCALAPPDATA%\SuperBookmarkManager\`. Data from v0.1.0 in
`%LOCALAPPDATA%\SavedPostsDashboard\` is never read or migrated automatically.

Every Windows user on a PC shares `127.0.0.1`, so the installed app answers only programs
of the user who started it. When a program connects, the app asks Windows who holds the
other end; anyone else, or anyone Windows can't name, gets one fixed page and reaches
nothing. Programs of the same user are trusted, because they can read the data folder
anyway, and a source run has no such check.

While the app is off its port is free, and any program on the PC can listen there, so
nothing trusts that address without a proof. The app's pages and both extensions have it
sign a random value with a key only it and they hold before they send anything or believe
an answer, and pairing never sends the code. The library the browser keeps, and the
settings that start things by themselves, are encrypted with a key only the app's own
pages get. Keys and link text go to an AI server on this PC only if another signed-in
person's program isn't the one listening.

This can't stop everything, because a browser gives an address to whoever answers there.
A page of another program, opened at that address while the app is off, reads nothing,
but it can show a look-alike, or leave code in that browser that waits for the app to
return to the address. The bookmark button can't check what it opens. Each of these needs
a malicious account on the same PC.

Telegram API ID/Hash, AI provider keys and sessions stay local and use Windows user-local filesystem
permissions. This is not an encrypted credential vault or a defense against a
compromised Windows account. Verification codes and 2FA passwords are used for the
active login flow and are not persisted. Sessions are excluded from library backups,
installer payloads and repository source. No shared project Telegram credentials exist.

Telegram is contacted on connect, test authorization, logout and refresh, and when Settings
needs to check a saved login. Two switches, both off by default, add refreshes: "Check when
the app starts" (once) and "Check again while the app is open" (on a timer). Previews of some social sites
identify as Meta's or WhatsApp's link-preview crawler, and so can saved copies of TikTok posts; the README's Network
activity section lists them. Metadata
enrichment for newly imported links contacts saved-link hosts and permitted preview
resources as part of normal behavior; saved copies (on by default, can be turned off)
fetch each saved page with its pictures, styles and fonts, and a public X or TikTok
post's video. The optional video helper is downloaded from yt-dlp's GitHub releases
only when the owner asks; once installed, saving a video post checks at most once a
week whether a newer release exists (only its checksum list is fetched), and nothing
new is downloaded or run until the owner chooses Update. AI providers are contacted
only after the owner adds a key, when the owner runs Test, a tidy-up or "Suggest from
unfiled links" (or, with "Keep sorting new links" on, when unsorted links arrive or
are waiting); they receive the title, URL and text of the links involved. Settings shows
only the last four characters of a saved key, and keys
are scrubbed from provider error messages. Local keyword categorization needs no provider. Browser
imports read selected file copies, not live profile discovery. Do not expose the local
server to an untrusted network or treat it as a multi-user hosted service.

The Windows release candidate is unsigned. No production signing identity has been
configured. Current-machine synthetic tests are not a cross-machine security audit.
