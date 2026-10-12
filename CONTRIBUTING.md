# Contributing to SuperBookmarks

Thanks for wanting to help. Bug reports, ideas, fixes and tests are all welcome.

A note on how this project is run: the maintainer is not a professional programmer, and
much of the app was written with the help of AI tools. Every change is reviewed
carefully, often with an AI reviewer explaining it line by line, and the test suites
below decide what is safe to merge. So the most helpful pull request is a **small one,
explained in plain words, with a test that proves it works**.

## Before you start

- **Small fixes** (a typo, a clear bug with an obvious fix): open a pull request.
- **Anything bigger** (a new feature, a new dependency, a change to how data is stored
  or what the app sends over the network): open an issue first and describe the idea,
  so nobody spends a weekend on something that can't be merged.
- **Security problems:** report them privately (see [SECURITY.md](SECURITY.md)), never
  in a public issue or pull request.

## Ground rules

These keep the people who use the app safe. A pull request that breaks one will be
closed, however good the rest of it is.

1. **No real personal data, anywhere.** Not in code, tests, screenshots or logs: no real
   bookmarks, chats, Telegram sessions, API keys, `ai.json`, `config.json`, databases or
   backup exports. Tests use made-up links (`example.invalid`, `*.example`) and throwaway
   databases.
2. **The library stays on the user's PC.** No accounts, telemetry, analytics or new
   network requests without an agreed issue first. Anything that contacts the internet
   must be listed under *Network activity* in the [README](README.md).
3. **No new dependencies without an agreed issue.** Say why it's needed, check its
   licence works with MIT, and add it to [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
4. **One change per pull request.** No drive-by reformatting or renaming of code you
   didn't need to touch; it hides the real change.
5. **Show what you changed.** Anything you can see in the app needs before and after
   screenshots (dark and light theme, and phone width if layout changed), made with
   made-up links.
6. **Don't commit generated files**: `frontend/dist/`, installers, `node_modules/`,
   databases or logs.
7. **AI-assisted pull requests are fine**, but you must have read, understood and run
   everything you submit, and say in the pull request which tools you used.

## Setting up

[BUILDING.md](BUILDING.md) has the full details (the Windows installer, exact
versions). For day-to-day work you need Python 3.12 and Node 24:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip
npm --prefix frontend ci
npm --prefix frontend run build
mkdir -p /tmp/sbm-dev
export SAVED_POSTS_DB_PATH=/tmp/sbm-dev/library.sqlite SUPER_BOOKMARK_MANAGER_DATA_DIR=/tmp/sbm-dev
.venv/bin/python run.py --serve-only
```

Then open `http://127.0.0.1:5001`. The two variables keep the library, settings and
keys in a throwaway folder, so you never work on a real library (in PowerShell, set
them with `$env:NAME = "value"`). For live frontend changes, keep that running and
start `npm --prefix frontend run dev`: it serves the app with hot reload at
`http://localhost:5173`.

## Running the tests

One command runs the same suites as the check on every pull request:

```bash
node frontend/tests/run.mjs                 # everything
node frontend/tests/run.mjs unit python     # quick: logic and backend (about a minute)
node frontend/tests/run.mjs browser         # the app in a headless browser (several minutes)
```

The browser tests need the built app and a test browser, once:

```bash
npm --prefix frontend run build
cd frontend && npm install --no-save playwright && npx playwright install chromium
```

Set `PYTHON` if your Python isn't on the path as `python3` (`python` on Windows). Logs
go to `.verify/test-logs/`. Every suite makes up its own links and uses its own
temporary database and folders, so running them never touches a real library.

## Writing tests

- **Every fix comes with a test that fails without it.** Every feature comes with tests
  for what a user does with it.
- Logic tests are Node scripts (`frontend/tests/*-test.mjs`); backend tests are Python
  scripts (`frontend/tests/*_backend.py`, `*_test.py`); browser tests drive the real app
  with Playwright (`frontend/tests/*-e2e.mjs`). Copy the closest existing one: they show
  how to start the app on a random port with a temporary database and made-up links.
- No test may reach the real internet. Serve fake pages from a local server, or replace
  the fetch, as the existing suites do.
- Add a new suite to the lists at the top of `frontend/tests/run.mjs` so the pull
  request check runs it.

## Your pull request

The template asks for this, but in short:

- **What changes for someone using the app**, in plain words.
- **Why**, with a link to the issue (`Closes #123`).
- **How you tested it**, and screenshots for anything visible.
- **New files** are added to [PUBLIC_SOURCE_MANIFEST.md](PUBLIC_SOURCE_MANIFEST.md)
  (keep the list sorted and update the file count).

The **Tests** check must be green before anything is merged. If it fails, open the
check's *Details*: the summary lists which suite failed and the log shows why. A suite
marked "passed on retry" passed the second time; mention it in the pull request.

It's normal for a pull request to be declined or to sit for a while: this is a small
project run in spare time. Being declined isn't personal, and you're always free to
keep your change in your own fork.

## Licence

SuperBookmarks is [MIT licensed](LICENSE). By contributing you agree that your
contribution is released under the same licence.

Be kind and patient with each other. Thank you for helping.
