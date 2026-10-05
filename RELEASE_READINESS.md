# Super Bookmark Manager — release readiness

## v0.2.0 — status 2026-10-02

**Source ready; Windows build, install check and publication remain.**

The `public-release` branch is built on top of the published `main` (no private
history) and contains exactly the files listed in PUBLIC_SOURCE_MANIFEST.md. It
replaces the splash page (now `docs/index.html`), removes the retired LiteLLM proxy files
and the v0.1.0 Catch Up page, and updates README/PRODUCT/SECURITY/BUILDING for the
feed, WhatsApp import, optional AI providers and the new data directory.

Checks run on the public tree (Linux, synthetic data only):

- Secret/cache scan: no API keys (only a labelled synthetic test key), no
  `thumb_cache`, databases, sessions, `ai.json`/`config.json`, logs, `.verify`,
  internal records or machine-specific paths.
- TypeScript clean; frontend builds.
- Python: library API, categorization, Firefox, metadata (backend, gzip),
  provider resilience, AI library, Telegram config, preview thumbnails, refresh
  retry, backup/restore, release safety (with PyInstaller stubbed).
- Browser: core presentation and acceptance, feed, polish, import workflow,
  WhatsApp, Chromium/Firefox imports, library, retrieval, categorization, metadata,
  backup, Telegram refresh, audit sync, enrichment provenance and the unit suites.
  Some browser tests are timing-sensitive here (Firefox, library, backup); they pass
  on rerun.

Not verifiable here, or known before this release:

- `telegram_auth_test.py` session checks need Windows ACLs; run on Windows.
- `telegram-account-ui`/`telegram-config-ui` need a Vite dev server, and
  `bookmarks.mjs`/`telegram-setup-handoff.mjs` need their own fixture server.
- `telegram.mjs` (stale API mocks) and `saved-views-e2e.mjs` (request count)
  already failed on v0.1.0; they are not release blockers.

### Release checklist (owner)

1. On Windows: `npm.cmd --prefix frontend ci`, `npm.cmd --prefix frontend run build`,
   then `packaging/build_standalone.py` and `packaging/build_installer.py`
   (outputs `dist-installer-v0.2.0/`).
2. Install on a clean Windows user (or VM); check first launch, Settings → AI & previews
   (Test with a real key), an import, Quit, reinstall and uninstall.
3. Push `public-release` and merge it into `main` (GitHub Pages serves the `docs/` folder).
4. Create release `v0.2.0` with `SuperBookmarkManager-Setup.exe` and its `.sha256`,
   using RELEASE_NOTES_DRAFT.md.
5. Optional: fill the WinGet hash and submit (packaging/winget/README.md).

**SIGNING NOT PERFORMED — NO CONFIGURED CODE-SIGNING IDENTITY.**

---

## Earlier history (v0.1.x)

**SUPER BOOKMARK MANAGER GITHUB READINESS PASS — PUBLICATION ONLY REMAINS**

Owner decisions: public name **Super Bookmark Manager**, repository slug
`super-bookmark-manager`, first public release `v0.1.0`, MIT license with owner-confirmed
copyright holder `browser-b0X`. Root LICENSE resolves the project-license-selection
blocker; third-party inventory/notices remain separately applicable.

Future publication must initialize **fresh public history from the curated current
public-source tree** in PUBLIC_SOURCE_MANIFEST.md. Do not publish old internal history
unchanged. No history rewrite, commit, repository creation, push, tag, release or upload
is authorized or performed in this pass.

The prior hygiene acceptance is retained: local ignored Groq configuration was absent
from the five locally available Git ref/reflog trees, and 159 cache/log/recovery files
were removed from the index only. Local files were preserved. Ignored secrets are not
read, copied, hashed or included in source/build simulation. Pattern scans are bounded
checks, not proof against every possible secret encoding.

Super Bookmark Manager retains the legacy `%LOCALAPPDATA%\SavedPostsDashboard\`
user-data directory for compatibility with existing installations. No migration.
README, SECURITY, BUILDING, dependency license inventory and release draft are present.
Their runtime claims are subject to the final verification record below.

**SIGNING NOT PERFORMED — NO CONFIGURED CODE-SIGNING IDENTITY.**
The release candidate is unsigned; SmartScreen/antivirus behavior may vary. Windows
is the verified packaged platform. No separate-machine/VM test is claimed.

B3 historical blank-band cause unresolved; current controlled matrix clean. It is
not claimed fixed. All previously accepted core/bookmarks/Telegram/package PASS
states remain historical acceptance until current changed-build checks finish.

Sanitized local evidence: `.verify/github-readiness-20260927/final-naming-release-readiness/`.
This evidence directory and internal execution records are excluded from public source.

## Current provider-resilience candidate — 2026-09-29

Optional provider resilience and release policy PASS. Manual provider-mode actions
fall back to deterministic keywords when the optional provider layer is unavailable;
bulk categorization processes each selected post once. Normal imports remain provider-free.
No provider Settings UI or SDK was added. Frontend and branding are unchanged.

Fresh focused backend16/16, categorization API5/state7/end-to-end4, core28/28 and
bookmarks PASS. Actual rebuilt standalone UI6/6 and packaged keyword/no-SDK fallback
checks PASS; optional provider success uses a controlled loopback mock only.
121-file payload receipt and current compiled categorizer identity match;753 modules
contain zero provider SDKs. Prior branded candidate is preserved in local evidence.

Selected unsigned installer: `dist-installer/SuperBookmarkManager-Setup.exe`

SHA256 `6beb3bb5f81bdfacb8cfc5203c940081b3e7cce6c4fb431b26dc88f2cedfc979`; 15,387,880 bytes.

No new installation into the owner's profile, full installed lifecycle, separate-machine
test, signing or publication. Earlier lifecycle acceptance is retained separately.
GitHub readiness PASS; publication requires separate authorization.
Evidence: `.verify/github-readiness-20260927/provider-resilience-20260928/`.

## Previous branding candidate — 2026-09-29

The owner-selected branding pass is complete: concept-1 supplies the in-app/README
logo; iteration-2 supplies the SVG favicon and eight-size Windows/ICO icon.
Artwork geometry/colors are preserved and shipped accessible labels use the current name.
The app uses a48px logo, including its collapsed sidebar. No other UI restyling.

Fresh TypeScript/Vite, standalone and installer builds PASS. The rebuilt standalone
passes four route/reload checks, three exact served brand-asset checks, and desktop1365px,
mobile390px/320px dark/light navigation checks with no clipping, overlap or horizontal
overflow. Collapsed-logo48x48 bounds are explicitly verified. Agent visual review
of32/48px previews and actual screenshots is complete; no new owner review is claimed.
Both EXE and setup contain all eight exact ICO frames; the121-file bundle receipt,
frontend source/bundle identity and candidate checksum pass. Isolated empty SQLite
data remained unchanged; the owned process stopped and its port closed.

Selected rebuilt unsigned candidate: `dist-installer/SuperBookmarkManager-Setup.exe`

SHA256 `69169644b13537eadeda9cf65e9477fdde0930256cb2e29626a9b80c4469cc96`; 15,388,102 bytes.

The prior accepted candidate and its lifecycle evidence remain preserved at the path
below. A full install/reinstall/uninstall lifecycle, installed Start Menu icon-cache
appearance and separate-machine tests were not rerun for this branding-only build.
Start Menu/uninstall entries inherit the verified EXE icon via unchanged configuration.
Earlier accepted functional checks are retained, not represented as fresh executions.
The public manifest now includes157 files, adding only the four shipped brand assets.

Evidence: `.verify/branding-20260928/`. No signing, installation into the owner's
profile, personal-data access, existing-service termination or publication performed.

## Previous accepted lifecycle result — 2026-09-28

Installed ACL verification is closed. Independent Windows-native methods confirm
protected current-user-only access. The prior null/empty result was a PowerShell
module-loading failure whose stderr the old verifier discarded. One verification-only
correction now checks semantic permissions directly. No product/package changes.

Fresh installed lifecycle 75/75, desktop 9/9 and
mobile naming/controls at390px and320px PASS. Restart/reinstall/uninstall preserve
synthetic DB/config/session/backups/exports; uninstall removes app/shortcut/registration.
Cleanup removed both synthetic profiles and left no owned app process.

Prior core28/28,bookmarks,Telegram backend21/UI14,standalone55/55,clean-source builds,
frontend reproducibility and153-file public-source audit remain accepted. All81
integrity entries are unchanged,including baseline75 production/build source files.
No unnecessary rebuild or full regression rerun was performed.

Selected verified unsigned candidate:
`.verify/github-readiness-20260927/final-blocker-closure-20260928/final-candidate/SuperBookmarkManager-Setup.exe`

SHA256 `aa26f3a1159bade5033463b1cfc05b5eddf3b441f780df07559653f9245c3d47`;15,375,750 bytes.
Existing basename-only checksum verified; candidate byte-identical. The older root
dist-installer artifact is retained and is not this selected candidate.

SIGNING NOT PERFORMED — NO CONFIGURED CODE-SIGNING IDENTITY.
No required GitHub-readiness blockers remain. Publication alone remains and requires
separate explicit authorization; no repository/commit/push/tag/release/upload/signing
was performed. Optional AI helper is unstarted and outside this completed slice.

Evidence: `.verify/github-readiness-20260927/acl-verification-closure-20260928/`.
