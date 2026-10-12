# SuperBookmarks v0.3.0 — saved copies and a new look

A local-first home for the links you save — browser bookmarks, Telegram Saved
Messages and WhatsApp chats — on Windows.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://browser-b0x.github.io/super-bookmark-manager/assets/release-v0.3.0-dark.webp">
    <img src="https://browser-b0x.github.io/super-bookmark-manager/assets/release-v0.3.0-light.webp" width="840" alt="SuperBookmarks v0.3.0: saved copies and a new look. An offline copy of every page you save; a new Home, one link at a time; Telegram photos and videos, social posts with their media; AI tidying in the background, with Undo. Beside it, a saved copy of a recipe page in the app's reader.">
  </picture>
</p>

## What's new

- **A new name: SuperBookmarks.** Same app, shorter name, and a new logo (a jar that
  keeps the web's best bits on your own shelf). Your data, the install folder and the
  GitHub address stay the same, so upgrading changes nothing else; the Start Menu
  shortcut gets the new name.

- **Saved copies.** The app keeps its own offline copy of each page you save, so a
  link still opens after the site changes or disappears. Copies are cleaned and made
  inert (no scripts), open in a reader inside the app, can be updated or deleted, and
  can be exported as a zip and restored. Turn automatic copies off in Settings.
- **Social posts.** Public X posts are saved as a post card with their photos and
  video (up to 50 MB); TikTok posts keep caption, author and cover. TikTok and Reddit
  posts keep their video too with an optional helper (yt-dlp), downloaded only on
  request. No login is used or stored.
- **Telegram photos and videos.** When a Saved Message has a link plus photos or a
  video, the refresh keeps them with that link's saved copy (videos up to 50 MB),
  downloaded from your own account; the link panel shows them (turn this off in
  Settings). New and off until you turn it on: one refresh each time the app starts.
- **Bookmark button.** Drag a button to your browser's toolbar to send the page you
  are on to the app, with a note, status and tags. On an Instagram post it also saves
  the caption and pictures from the tab you have open.
- **Share a shelf.** Download a shelf, saved view or selection as one page that works
  offline, with search and sort, to send or put online. Notes, status, favourites and
  Telegram text stay out unless you tick them; saved copies never go in.
- **A new look.** No sidebar: a top bar with Home, New, Later, Favourites and All
  shelves. Home sorts new links one at a time (← Archive, ↓ Later, → Keep), shows
  what comes next and an old favourite, and lists every shelf as a row, in Portrait or
  Wide. Four themes — Classic dark and light, Lime and Coral — each with the moving
  background in its own colours. Pages slide in when you switch sections.
- **Follow up and use often.** Give a link a day to come back to: it shows as a badge,
  on Home when due, and in a Follow up list. Mark the links you open every day for a
  quick row on Home.
- **Search.** New operators `is:due`, `is:followup` and `is:often`.
- **Reddit fixed.** Reddit posts get their title, text, picture and author again, and
  saved copies work: Reddit stopped answering the old address without a login, so the
  app now reads each post's public feed. When Reddit asks the app to slow down, the
  copy is tried again by itself a minute later.
- **Support link.** The menu behind the logo links to the author's page.
- **One import field.** Every bookmark export goes through Settings → Sources →
  Import links, with a preview; Telegram's automatic refresh comes before the manual
  export.
- **AI tidying, faster and in the background.** FreeLLMAPI (one key in front of many
  free AI services, run on your PC) is the main provider, with a local model beside it;
  Gemini, Groq, OpenRouter and NVIDIA keys still work, folded under Other providers.
  Tidy up asks for fast models and a short think, waits out busy free tiers, and no
  longer stops on links with very long addresses or when the model FreeLLMAPI picks
  thinks until its answer is cut off (it asks about fewer links at a time instead).
  **Sort them in the background** applies shelves, tags and clean titles as it goes
  (Undo puts everything back), and **Keep sorting new links** does it by itself when
  unsorted links arrive.
- **Sort a mess fast.** Any shelf, and the links not on one yet, can be grouped by
  website, and a whole site moved to another shelf at once, with Undo. Social and messaging links without a
  picture get artwork in their site's colours (no logos).
- **Previews you can trust.** Fetch missing previews says what it found, lists the links
  a site refused (and why), and stops counting links that already look right; links
  whose pages are gone are listed with their picture and site before you archive them.
  Big pages (a GitHub repository, say) now get a preview too.
- **Keyboard.** Every dialog closes with Escape and keeps the keyboard inside it, and
  focus goes back to where you were.
- **Restore puts your links back.** Restore backup now puts the backup's links into the
  library you use, at once, also after a fresh install. If that library has links, they
  are saved first as a backup file in a `backups` folder beside it, so you can restore
  that file to go back. (Before, it made a separate database that the installed app
  could not switch to.) Pictures are not in the JSON backup: after a restore, Fetch
  missing previews counts the links whose pictures stayed behind and gets them again.

## Upgrading from v0.2.0

Install over v0.2.0; your library, settings and keys stay where they are. Quit the
app before installing. Saved copies are stored in a new `archive\` folder beside
the library and are not part of the JSON backup (use the zip export for them).

## Installation

Release assets: `SuperBookmarkManager-Setup.exe` and
`SuperBookmarkManager-Setup.exe.sha256`. Per-user install, no admin rights, no
Python or Node needed. Launch from the Start Menu; the app opens in your browser.

## Known limitations

- The installer is unsigned and may trigger SmartScreen/antivirus warnings.
- Windows is the verified packaged-release platform.
- Saved views and display preferences are browser-local and not part of backups.
- Saved copies of pages that need scripts to show their content may be incomplete;
  a text-only view is offered. Instagram saving reads the page you have open and may
  break when Instagram changes its pages.
- AI suggestions depend on each provider's free-tier limits and model availability.
