# Super Bookmark Manager — public source manifest

Exact curated source set: **158 files**, extended from the reviewed142-file
hygiene baseline with license, public documentation, pinned build requirements and
upstream notices. The legacy BAT is renamed. Only these files may enter the future
fresh public initial history; this is not permission to commit or publish.

Exclude `.git`, `.verify`, internal agent/master records, recovery history, personal
config/credentials, databases/sessions, backups/exports/profiles, caches/logs,
node_modules, virtual environments and generated dist/spec/build files. No local
excluded data is deleted. The ignored Groq secret must not be opened/copied/hashed.

Frontend/standalone/installer outputs are regenerated from source and audited
separately. The current internal Git history is not suitable for publication unchanged.
Legacy maintenance helpers are source history, not safe test commands; never run them
on personal data for verification. Tests require isolated synthetic state and their
documented Python/Playwright overrides. See BUILDING.md.

## Exact files

- `.gitignore`
- `BUILDING.md`
- `LICENSE`
- `PRODUCT.md`
- `PUBLIC_SOURCE_MANIFEST.md`
- `README.md`
- `RELEASE_NOTES_DRAFT.md`
- `RELEASE_READINESS.md`
- `SECURITY.md`
- `THIRD_PARTY_LICENSES.md`
- `_rerun.py`
- `app.py`
- `categorizer.py`
- `check_reuse_only.py`
- `config.py`
- `consolidate_categories.py`
- `fetcher.py`
- `firefox_import.py`
- `frontend/index.html`
- `frontend/public/brand-logo.svg`
- `frontend/public/favicon.svg`
- `frontend/public/favicon.ico`
- `packaging/app.ico`
- `frontend/package-lock.json`
- `frontend/package.json`
- `frontend/src/App.tsx`
- `frontend/src/components/CommandPalette.tsx`
- `frontend/src/components/Shell.tsx`
- `frontend/src/components/Sidebar.tsx`
- `frontend/src/components/Topbar.tsx`
- `frontend/src/components/library/AddLinkDialog.tsx`
- `frontend/src/components/library/BackupRestore.tsx`
- `frontend/src/components/library/BulkBar.tsx`
- `frontend/src/components/library/CategoryManager.tsx`
- `frontend/src/components/library/PostDrawer.tsx`
- `frontend/src/components/library/PostViews.tsx`
- `frontend/src/components/library/SavedViews.tsx`
- `frontend/src/components/library/TelegramAccount.tsx`
- `frontend/src/components/library/TelegramConfig.tsx`
- `frontend/src/lib/bookmarks.ts`
- `frontend/src/lib/chromiumBookmarks.ts`
- `frontend/src/lib/displayText.ts`
- `frontend/src/lib/firefoxBookmarks.ts`
- `frontend/src/lib/importCategorization.ts`
- `frontend/src/lib/libraryPersistence.ts`
- `frontend/src/lib/metadataEnrichment.ts`
- `frontend/src/lib/migrate.ts`
- `frontend/src/lib/platform.ts`
- `frontend/src/lib/providers.ts`
- `frontend/src/lib/relatedItems.ts`
- `frontend/src/lib/savedViews.ts`
- `frontend/src/lib/shelves.ts`
- `frontend/src/lib/telegram.ts`
- `frontend/src/lib/ui.ts`
- `frontend/src/main.tsx`
- `frontend/src/pages/CatchUpPage.tsx`
- `frontend/src/pages/LibraryPage.tsx`
- `frontend/src/pages/LibrarySettingsPage.tsx`
- `frontend/src/pages/NotFound.tsx`
- `frontend/src/store/library.ts`
- `frontend/src/store/migrations.ts`
- `frontend/src/store/prefs.ts`
- `frontend/src/styles.css`
- `frontend/src/types.ts`
- `frontend/tests/b1-refresh-e2e.mjs`
- `frontend/tests/b1_fixture.py`
- `frontend/tests/backup-e2e.mjs`
- `frontend/tests/backup_fixture.py`
- `frontend/tests/bookmarks.mjs`
- `frontend/tests/c2_bookmarks_fixture.py`
- `frontend/tests/categorization-e2e.mjs`
- `frontend/tests/categorization-state.mjs`
- `frontend/tests/categorization_api.py`
- `frontend/tests/provider_resilience.py`
- `frontend/tests/categorization_fixture.py`
- `frontend/tests/chromium-cases.mjs`
- `frontend/tests/chromium-e2e.mjs`
- `frontend/tests/chromium-unit.mjs`
- `frontend/tests/core-acceptance.mjs`
- `frontend/tests/core-presentation.mjs`
- `frontend/tests/display-text.mjs`
- `frontend/tests/expand-card-e2e.mjs`
- `frontend/tests/expand-card-phase3.mjs`
- `frontend/tests/firefox-e2e.mjs`
- `frontend/tests/firefox_backend.py`
- `frontend/tests/firefox_cases.py`
- `frontend/tests/fixtures/backup-library.json`
- `frontend/tests/fixtures/bookmarks-chromium.html`
- `frontend/tests/fixtures/bookmarks-firefox.html`
- `frontend/tests/fixtures/categorization-cases.json`
- `frontend/tests/fixtures/chromium-bookmarks.json`
- `frontend/tests/fixtures/landing-preview.svg`
- `frontend/tests/fixtures/retrieval-library.json`
- `frontend/tests/fixtures/telegram-saved-messages.json`
- `frontend/tests/fixtures/text-readability-library.json`
- `frontend/tests/landing-e2e.mjs`
- `frontend/tests/launcher.py`
- `frontend/tests/library-e2e.mjs`
- `frontend/tests/library-passb-e2e.mjs`
- `frontend/tests/library-state.mjs`
- `frontend/tests/library-sync.mjs`
- `frontend/tests/library_api.py`
- `frontend/tests/library_fixture.py`
- `frontend/tests/metadata-e2e.mjs`
- `frontend/tests/metadata-state.mjs`
- `frontend/tests/metadata_backend.py`
- `frontend/tests/metadata_e2e_fixture.py`
- `frontend/tests/metadata_fixture.py`
- `frontend/tests/metadata_gzip.py`
- `frontend/tests/package_site/sitecustomize.py`
- `frontend/tests/packaging.mjs`
- `frontend/tests/related-items.mjs`
- `frontend/tests/retrieval-e2e.mjs`
- `frontend/tests/saved-views-e2e.mjs`
- `frontend/tests/telegram-account-ui.mjs`
- `frontend/tests/telegram-config-ui.mjs`
- `frontend/tests/telegram.mjs`
- `frontend/tests/telegram_auth_test.py`
- `frontend/tests/telegram_config_test.py`
- `frontend/tests/telegram_mock.py`
- `frontend/tests/text-readability-e2e.mjs`
- `frontend/tsconfig.app.json`
- `frontend/tsconfig.json`
- `frontend/tsconfig.node.json`
- `frontend/vite.config.ts`
- `library_backup.py`
- `litellm/.env.example`
- `litellm/config.yaml`
- `litellm/start_proxy.sh`
- `metadata_fetcher.py`
- `packaging/BUILD_AND_RUN.md`
- `packaging/BUILD_INSTALLER.md`
- `packaging/Start Super Bookmark Manager.bat`
- `packaging/build_installer.py`
- `packaging/build_package.py`
- `packaging/build_standalone.py`
- `packaging/frontend-build.json`
- `packaging/installer.iss`
- `packaging/package_start.py`
- `packaging/requirements-build.txt`
- `packaging/requirements-serve.txt`
- `packaging/standalone_entry.py`
- `requirements.txt`
- `run.py`
- `safe_http.py`
- `storage.py`
- `taxonomy.py`
- `taxonomy_plan.json`
- `telegram_auth.py`
- `telegram_config.py`
- `telegram_refresh.py`
- `templates/command.html`
- `templates/index.html`
- `test_cat.py`
- `third_party_notices/frontend-packages.txt`
- `third_party_notices/inno-setup.txt`
- `third_party_notices/python-packages.txt`
- `third_party_notices/python-runtime.txt`
