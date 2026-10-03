# Building Super Bookmark Manager

## Verified prerequisites

Windows x64; Python **3.12.10**, Node **24.19.0**, npm **11.17.0**, PyInstaller
**6.22.3**, Inno Setup **6.7.3**. The frontend lockfile and
`packaging/requirements-build.txt` record the dependency versions. Install Python,
Node/npm and Inno Setup before building. Python's `py -3.12` launcher is used below;
if unavailable, invoke the installed Python 3.12 interpreter directly.

From the repository root in PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r packaging/requirements-build.txt
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
```

For a standalone typecheck run `Push-Location frontend` then
`npx.cmd tsc -b` and `Pop-Location`; `npm run build` already runs TypeScript followed
by Vite. The production frontend is written to `frontend/dist/`.

## Source launch

```powershell
.\.venv\Scripts\python.exe run.py --serve-only
```

Open `http://127.0.0.1:5001`. Stop with Ctrl+C. Source mode defaults to
`saved_posts.db` beside `run.py`; use `SAVED_POSTS_DB_PATH` before launch to select a
different database. Never run test/maintenance utilities against a personal library.
The v0.2.0 packaged application uses `%LOCALAPPDATA%\SuperBookmarkManager\`.
It never imports the legacy SavedPostsDashboard directory, source DB override,
inherited Telegram/provider keys, or old browser storage. Legacy files remain intact. Settings provides Telegram configuration and
login, and AI provider keys; no credentials are needed to build. The release version
is set once in `packaging/release_paths.py` (`VERSION`).

## Standalone and installer

```powershell
.\.venv\Scripts\python.exe packaging/build_standalone.py
.\.venv\Scripts\python.exe packaging/build_installer.py
```

The standalone output is `dist-standalone-v0.2.0/SuperBookmarkManager/SuperBookmarkManager.exe`
plus its `_internal/` folder. Keep them together. Python and Telethon are bundled;
end users need no system Python. The build includes project/third-party notices and
generates `dist-standalone-v0.2.0/build-receipt.json` with hashes of every payload file.

Brand artwork lives in `frontend/public/brand-logo.svg`; the simplified
`frontend/public/favicon.svg` supplies the small icon design. The checked-in
`frontend/public/favicon.ico` and `packaging/app.ico` are identical multi-resolution
icons (16, 20, 24, 32, 48, 64, 128 and 256 pixels). PyInstaller embeds `app.ico`
in the executable; Inno Setup uses it for the installer. Windows shortcuts and
the uninstall entry use the executable's icon.

Both builders refuse to replace existing candidate output directories. Existing
v0.1.0 artifacts stay in their original directories. Payload path scans reject
databases, sessions, credential files, .env files and personal caches/profiles before
reading/hashing them; installer inputs are rescanned before compilation.

The installer wrapper verifies the receipt and current source frontend/assets before
calling Inno Setup. It refuses changed or missing files. A receipt proves build-input
integrity, not behavioral acceptance: run synthetic runtime tests before release.
The compiler is discovered in the standard per-user/system location or on PATH.
Output: `dist-installer-v0.2.0/SuperBookmarkManager-Setup.exe` and its `.sha256` file.

The per-user installer needs no elevation, offers an optional Desktop shortcut and
Telegram Settings launch, and preserves user data on uninstall. Its stable AppId and
legacy install directory are retained for compatibility. See
[packaging/BUILD_INSTALLER.md](packaging/BUILD_INSTALLER.md).

## Synthetic verification

Use a fresh loopback origin, disposable browser profile and synthetic database.
Install Playwright separately for tests (`npm install --no-save playwright` in a
disposable test-tools directory); set suite-specific `*_PLAYWRIGHT_MODULE` variables
to that installed package. Existing Edge can be selected by the browser-channel
variables. The core suite requires `G5_PYTHON` and optionally `G5_PLAYWRIGHT_MODULE`:

```powershell
$env:G5_PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
node frontend/tests/core-acceptance.mjs
.\.venv\Scripts\python.exe -B frontend/tests/telegram_auth_test.py
```

Do not use `_rerun.py`, `test_cat.py`, `check_reuse_only.py` or
`consolidate_categories.py` as test commands; these are legacy maintenance tools.
The older installed-Python folder builder is retained historical tooling, not the
release build path above.

## Public runtime lifecycle and isolated verification

The public executable uses PyInstaller windowed mode and Waitress 3.0.2, bound
only to 127.0.0.1. It opens the browser automatically. Reopening its shortcut
opens the same running instance. If its preferred port (initially 5001) is occupied,
it selects a free loopback port and remembers it. No existing process is stopped.
Closing the browser leaves the server running; Library settings → Quit Super
Bookmark Manager saves this tab first and refuses to quit if SQLite writes fail.
Finish imports and save other tabs before quitting.

SQLite, Telegram config/session, thumbnail cache and a browser-storage identity
belong to the public data directory. Browser preferences remain browser-local and
are namespaced by that identity. A different port/browser profile has separate
preferences; SQLite links survive. Reinstall/uninstall preserves the public and
legacy data directories. No migration is performed or offered in this release.

For an explicitly isolated test profile set `LOCALAPPDATA` to a new disposable
directory; the app creates its SuperBookmarkManager child. Advanced explicit
overrides are `SUPER_BOOKMARK_MANAGER_DATA_DIR` (absolute, never a legacy directory)
and `SUPER_BOOKMARK_MANAGER_PORT` (0 requests any free port). Legacy
`SAVED_POSTS_DB_PATH`/`SAVED_POSTS_PORT` are deliberately ignored by the public entry.
Source launch behavior is unchanged. Do not point these tests at personal state.

```powershell
py -3.12 -B packaging/tests/test_release_safety.py
$env:SBM_TEST_PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
$env:SBM_TEST_PLAYWRIGHT='C:/path/to/disposable/node_modules/playwright'
node packaging/tests/runtime_acceptance.mjs
node packaging/tests/runtime_acceptance.mjs (Resolve-Path dist-standalone-v0.2.0/SuperBookmarkManager/SuperBookmarkManager.exe).Path
```

Use an absolute executable argument. The runtime test creates synthetic profiles,
starts only owned servers, intercepts external browser requests, and uses a synthetic
browser dispatch handler plus fresh Edge contexts. It tests occupied ports,
duplicate launch, populated legacy browser cache, failed-save Quit, restart and
native console/listener state. Test Python is for instrumentation only; the public
executable carries its own Python. Actual default-browser shell association and
a separate Windows user/VM install require an additional clean-machine check.

## AI providers (optional)

Shelf, tag and title suggestions use free API keys the owner adds in
**Settings > AI & previews** (Google Gemini, Groq, OpenRouter, NVIDIA NIM, or a local
OpenAI-compatible server such as Ollama). Keys are stored in `ai.json` next to the
Telegram configuration in the user profile (`%LOCALAPPDATA%\SavedPostsDashboard`,
or the packaged data folder), never in the project folder, and are never returned
to the browser. Source mode also honours `GROQ_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `NVIDIA_API_KEY` and `LLM_BASE_URL`; the packaged entry ignores inherited
provider variables. No SDK or proxy is required: providers are called through
their OpenAI-compatible HTTP endpoints. Without a key, local keyword rules are used.

## Release boundary

Only paths listed in [PUBLIC_SOURCE_MANIFEST.md](PUBLIC_SOURCE_MANIFEST.md) belong in
the future public source snapshot. Do not export `.git`, `.verify`, local config,
databases, sessions, dependency directories or generated artifacts. Build outputs are
audited separately. Initialize fresh public history only when publication is authorized.

The clean-source simulation uses this Windows machine and installed build tools;
export the manifest into a fresh temporary directory outside any ignored ancestor
(for example, directly under `$env:TEMP`), retaining the manifest's `.gitignore`.
Do not build a source export nested under the development tree's ignored `.verify/`:
Tailwind's automatic scanner can then include installed dependency/generated files,
changing the CSS despite identical source and lockfile. Use `npm ci` and remove only
the export's generated `frontend/dist` before each comparison build.
The simulation does not claim a separate-machine/VM test or byte-for-byte identical executable
builds across machines. No signing identity is configured; release candidates are unsigned.

For a subsequent candidate without replacing an earlier one, set
`$env:SBM_BUILD_CANDIDATE="v0.2.0-r2"` before both build commands. Only
`v0.2.0` or `v0.2.0-rN` (positive integer) is accepted; outputs and compiler
scratch paths use that suffix. Clear the variable to use the initial candidate paths.
