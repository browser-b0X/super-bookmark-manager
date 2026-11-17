# SuperBookmarks v0.4.0 — the browser extension, Claude Desktop and creators

A local-first home for the links you save — browser bookmarks, Telegram Saved
Messages and WhatsApp chats — on Windows.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://browser-b0x.github.io/super-bookmark-manager/assets/release-v0.4.0-dark.webp">
    <img src="https://browser-b0x.github.io/super-bookmark-manager/assets/release-v0.4.0-light.webp" width="840" alt="SuperBookmarks v0.4.0: the browser extension, Claude Desktop and creators. Save the posts you see on X, Instagram and TikTok from your own tab; tidy your library from a Claude chat with no API key; who made what you saved; search, smart shelves and Undo for anything.">
  </picture>
</p>

## What's new

- **A browser extension (Chrome, Edge, Brave and Firefox).** A toolbar button and a
  right-click "Save link to SuperBookmarks" open the Save window for the page you are
  on, with tracking removed from the address. On X, Instagram and TikTok it lists the
  posts already loaded in your tab and saves the ones you tick: it never scrolls,
  opens posts, runs in the background or keeps a login. Instagram pictures and video
  come from the tab you have open. An optional Download button on each post. While
  SuperBookmarks isn't running, the extension keeps what you save (up to 200 MB) and
  hands it over next time. It pairs with the app through a code from Settings and
  talks only to the app on this computer; until it is paired it sends nothing. Chrome, Edge and Brave: load the unpacked
  folder; Firefox: the signed `.xpi`. When saving from a site stops working, its options
  can add "Copy page structure" to the right-click menu, for a bug report: what the page
  is built of, with no text, links, pictures or names.
- **Claude Desktop, with no API key.** The SuperBookmarks extension for Claude
  Desktop (`SuperBookmarks.mcpb`) lets you search and tidy your library from a Claude
  chat under your own Claude plan. It reaches the app on this computer only, with a
  token made in Settings → AI & previews → AI providers → Claude Desktop. Every change it makes is
  listed with Undo, it suggests new shelves instead of making them, and it leaves
  links you marked Reviewed alone.
- **Creators.** All shelves → Creators: who made the posts you saved, worked out from
  the posts themselves (nothing is checked online). Names, other names, handles and
  profile links; merge two that are the same person, field by field; move posts to
  another creator; "new since you looked"; refresh a creator from their profile page
  when you ask. `creator:` in the search.
- **Get started.** A new library's Home has three steps that tick themselves: bring your
  links in, save from your browser and sort your first link, with Telegram as one optional
  line. It stays after your first import until the steps are done or you dismiss it.
- **Search that says what it read.** `or`, `-word` (a whole word), "phrases",
  ( groups ), `no:` and `has:` for empty fields, `saved:` and `opened:` for dates; the
  chips under the box say how the search was read.
- **Smart shelves.** Saved searches built with a rules editor (any, all or none of a
  group of conditions), listed with your shelves and counted; saving never drops a
  rule.
- **Reviewed.** Mark a link Reviewed and Tidy up with AI, automatic shelves, preview
  refreshes and Claude Desktop leave it as it is. You can still edit it.
- **Bulk edit.** Add, remove or replace tags and shelves and set the status on many
  links at once; it says how many change before anything does, with Undo.
- **Nested tags.** A tag can sit under others and have other names; searching a tag
  finds the ones under it. Merge or rename tags, with Undo.
- **Clean up and undo.** Settings → Clean up & undo: the same post saved twice (x.com
  and twitter.com, a share link) merged into one; links you remove are remembered with
  their notes and tags, so you can bring one back, an import doesn't bring it back,
  and saving the same post again offers what it had; and History, where any change to
  many links at once can be undone, not only the last.
- **Politer previews.** When a site asks the app to slow down, its previews wait for
  the time it asks instead of failing, and nothing more is asked of it meanwhile.
- **Imports.** Pocket and Instapaper exports; Raindrop tags and notes; Undo import
  keeps the links you changed since.
- **AI tidying.** Tidy up suggests titles and summaries unticked, for you to choose;
  background sorting files and tags only. Test finds FreeLLMAPI's Windows app on its
  own port, and Tidy up tells a provider that isn't answering from one not set up.
- **Telegram.** An optional check for new Saved Messages every so often while the app
  runs. Audio sent with a link (music, voice messages) is kept with it, like photos and
  videos. Connecting says where Telegram sent the login code, and can ask for it again.
  A refresh says when a video sent with a link isn't kept: it isn't an MP4 file, it is
  over 2 GB, or its link already keeps another message's files.
- **Large videos and audio.** Settings → Saved copies → Keep large videos and audio (off
  by default) keeps X videos, and Telegram videos and audio, up to 2 GB each instead of
  50 MB. Each is written to disk as it arrives, with the free space checked first;
  large Telegram files download in the background after a refresh, with progress and
  Stop. Backups that hold them restore (zips up to 16 GB).
- **Two tabs at once.** Saved views, shelves, imports and queued changes from two open
  tabs merge item by item; saved views are kept in the library and in backups.
- **One account's app.** On a PC with several Windows accounts, the installed app answers
  only the account that started it. Another account gets a page saying so, and nothing
  of your library or settings. While the app is closed, nothing else can pass for it:
  the copy of your library in your browser is encrypted, open tabs and both extensions
  check the app before they send anything, and AI keys don't go to another person's
  program on this PC.
- **Smaller fixes.** Saved copies of TikTok posts work again: TikTok's embed data stopped
  carrying the caption and cover, and every post was called deleted or private. The cover
  now comes from the post's page, and with the video helper the caption and the author's
  name too. X previews have their picture; a filtered view keeps "My order";
  Save copies for links whose copies a JSON restore left behind; pages with inline
  pictures keep them in the copy; a copy over 15 MB says so; addresses in other
  scripts are spelled as browsers do. Home shows a shelf's row as soon as the shelf has
  links, the ones still waiting in New to sort too: after a background sort those shelves
  were missing.

## Upgrading from v0.3.0

Install over v0.3.0 with the app closed; your library, settings and keys stay where
they are, and the new records (tags, creators, removed links) are added beside them
the first time it starts. The installer now stops a running copy before it updates or
uninstalls, keeps a Desktop shortcut you deleted deleted, and upgrades an install in a
folder you chose in place. The first time it opens, your browser's copy of the library
is encrypted; a second browser you open later reads its links again, but its History
and display settings start fresh. The browser extension and the Claude Desktop extension are
separate downloads on this page; both are optional. A backup made by v0.4.0 can't be
restored by v0.3.0.

## Installation

Release assets:

- `SuperBookmarkManager-Setup.exe` and `SuperBookmarkManager-Setup.exe.sha256`: the
  app. Per-user install, no admin rights, no Python or Node needed. Launch from the
  Start Menu; the app opens in your browser.
- `SuperBookmarks-extension-chrome.zip`: the browser extension for Chrome, Edge and
  Brave (unzip it, open the extensions page, turn on Developer mode, Load unpacked).
- `SuperBookmarks.xpi`: the same for Firefox, signed by Mozilla (open the file).
- `SuperBookmarks.mcpb`: the extension for Claude Desktop (open the file; Claude
  Desktop asks for the token from Settings → AI & previews → AI providers → Claude Desktop).
  If Windows doesn't open it in Claude Desktop, install it from Claude Desktop's Settings →
  Extensions → Advanced settings → Install extension, or use Open with → Claude.

## Known limitations

- The installer is unsigned and may trigger SmartScreen/antivirus warnings.
- Windows is the verified packaged-release platform.
- The extension reads X, Instagram and TikTok pages as they are today; when a site
  changes its pages, reading posts there may break until an update.
- TikTok's For You and Following feeds don't show each video's own address, so their
  videos can't be saved from there: the creator's profile or the video's own page can.
- An Instagram reel opened over a profile or the feed is saved with its caption and
  cover; its video comes along only when the page itself holds the video's file.
- Display preferences and History are kept per browser and are not part of backups.
- Saved copies of pages that need scripts to show their content may be incomplete;
  a text-only view is offered.
- AI suggestions depend on each provider's free-tier limits and model availability.
- The installed app can turn away a browser started as administrator, or a security tool
  that passes local traffic through its own service, because Windows can't confirm
  they're yours. Open the browser the usual way.
- The bookmark button can't check what it opens: while the app is closed, a program of
  another account at its address gets the page you pressed it on. The extension checks
  first.
- For AI calls, a local AI server run as a Windows service counts as yours, because
  Windows doesn't say whose a service is; so can a program started over SSH or in a
  container.
- The guards against another account's program were tried with stand-ins: a program
  that took the app's address ran under the same account, and the service case was
  tried with Windows's answer simulated, not on a PC shared with a second person.
