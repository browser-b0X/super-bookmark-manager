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
The packaged application instead uses the compatibility directory
`%LOCALAPPDATA%\SavedPostsDashboard\`. Settings provides Telegram configuration and
login; no credentials are needed to build. Optional provider dependencies in root
`requirements.txt` are not required for the supported keyword-fallback bundle.

## Standalone and installer

```powershell
.\.venv\Scripts\python.exe packaging/build_standalone.py
.\.venv\Scripts\python.exe packaging/build_installer.py
```

The standalone output is `dist-standalone/SuperBookmarkManager/SuperBookmarkManager.exe`
plus its `_internal/` folder. Keep them together. Python and Telethon are bundled;
end users need no system Python. The build includes project/third-party notices and
generates `dist-standalone/build-receipt.json` with hashes of every payload file.

Brand artwork lives in `frontend/public/brand-logo.svg`; the simplified
`frontend/public/favicon.svg` supplies the small icon design. The checked-in
`frontend/public/favicon.ico` and `packaging/app.ico` are identical multi-resolution
icons (16, 20, 24, 32, 48, 64, 128 and 256 pixels). PyInstaller embeds `app.ico`
in the executable; Inno Setup uses it for the installer. Windows shortcuts and
the uninstall entry use the executable's icon.

The installer wrapper verifies the receipt and current source frontend/assets before
calling Inno Setup. It refuses changed or missing files. A receipt proves build-input
integrity, not behavioral acceptance: run synthetic runtime tests before release.
The compiler is discovered in the standard per-user/system location or on PATH.
Output: `dist-installer/SuperBookmarkManager-Setup.exe` and its `.sha256` file.

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

## Advanced provider configuration (optional)

**Optional — not required for normal application use.** The existing developer
configuration recognizes `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
`LITELLM_PROXY_URL` and `LITELLM_PROXY_KEY`. A separately operated proxy may use
`GROQ_API_KEY`, `GEMINI_API_KEY` and `MISTRAL_API_KEY`. These names do not imply
that their SDKs are bundled. Root `requirements.txt` includes OpenAI for the optional
source/developer direct-compatible-client path; release build requirements omit it.

Manual classification can use the configured provider and falls back to keywords on
provider unavailability. Normal imports bypass providers. No provider credential UI
is included in v0.1.0. Keep advanced configuration out of source, shared logs and release
artifacts. The legacy `--fetch-only` command still requires its separate Telegram and
metadata workflow; its categorization stage can run without an AI provider.

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
