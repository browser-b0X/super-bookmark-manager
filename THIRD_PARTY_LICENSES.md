# Third-party dependency and license inventory

Inventory from installed Python distribution metadata, upstream notice files and
the committed npm lockfile. These are practical release-review records, not legal
advice. The project MIT license does not relicense third-party software. Keep the
unmodified texts in `third_party_notices/` with redistributed binaries; the supported
standalone builder includes this directory. Upstream notices are not edited.

| Component | Version | Confirmed license | Redistribution action / evidence |
|---|---|---|---|
| Python | 3.12.10 | PSF license agreement and bundled component notices | Full runtime LICENSE.txt in python-runtime.txt, including OpenSSL and other incorporated notices |
| Inno Setup | 6.7.3 | Inno Setup License (custom permissive) | Retain existing binary copyright/website notices; unmodified upstream license included |
| SQLite | Bundled with Python 3.12.10 | [Public domain, upstream statement](https://www.sqlite.org/copyright.html) | Preserve supplied runtime notices |
| Microsoft VC runtime DLLs | Bundled by Python/PyInstaller | Microsoft redistributable terms; not project MIT | REVIEW upstream Python Windows distribution redistribution terms; do not extract/relicense as standalone product |

## Python runtime and build dependencies

PyInstaller is GPLv2-or-later with its distribution/bootloader exception; preserve
that exception and upstream notices. It does not turn the generated application
into a GPL-licensed project. Hooks/build tools are listed even when not shipped as
runtime code. OpenAI/cryptg are optional source workflows and excluded from the
supported standalone recipe; install them only after reviewing their own metadata.

| Dependency | Version | License metadata | Notice / redistribution action |
|---|---|---|---|
| Flask | 3.1.3 | BSD-3-Clause | Preserve upstream license/notices; included |
| Werkzeug | 3.1.8 | BSD-3-Clause | Preserve upstream license/notices; included |
| Jinja2 | 3.1.6 | BSD License | Preserve upstream license/notices; included |
| MarkupSafe | 3.0.3 | BSD-3-Clause | Preserve upstream license/notices; included |
| itsdangerous | 2.2.0 | BSD License | Preserve upstream license/notices; included |
| click | 8.5.0 | BSD-3-Clause | Preserve upstream license/notices; included |
| blinker | 1.9.0 | MIT License | Preserve upstream license/notices; included |
| Telethon | 1.45.0 | MIT | Preserve upstream license/notices; included |
| pyaes | 1.6.1 | License :: OSI Approved :: MIT License | Preserve upstream license/notices; included |
| rsa | 4.9.1 | Apache-2.0 | Preserve upstream license/notices; included |
| pyasn1 | 0.6.4 | BSD-2-Clause | Preserve upstream license/notices; included |
| PyInstaller | 6.22.3 | GPLv2-or-later with a special exception which allows to use PyInstaller to build and distribute non-free programs (including commercial ones) | Preserve upstream license/notices; included |
| pyinstaller-hooks-contrib | 2026.7 | Apache Software License; GNU General Public License v2 (GPLv2) | Preserve upstream license/notices; included |
| altgraph | 0.17.5 | MIT | Preserve upstream license/notices; included |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | Preserve upstream license/notices; included |
| pefile | 2024.8.26 | MIT | Preserve upstream license/notices; included |
| pywin32-ctypes | 0.2.3 | BSD-3-Clause | Preserve upstream license/notices; included |
| setuptools | 84.0.0 | MIT | Preserve upstream license/notices; included |

## Frontend and build graph

Includes React, React DOM, React Router, Zustand, dnd-kit, Lucide, Vite,
TypeScript, Tailwind and transitive build/platform packages. Versions/licenses below
come from package-lock.json; full notices available in this build environment are
collected in frontend-packages.txt. Platform-specific packages not installed on
Windows are not bundled in the Windows application. Entries marked REVIEW remain
explicit inventory limits, not invented license assertions.

| Dependency | Version | Lockfile license | Notice / redistribution action |
|---|---|---|---|
| @babel/code-frame | 7.29.7 | MIT | notice included |
| @babel/compat-data | 7.29.7 | MIT | notice included |
| @babel/core | 7.29.7 | MIT | notice included |
| @babel/generator | 7.29.8 | MIT | notice included |
| @babel/helper-compilation-targets | 7.29.7 | MIT | notice included |
| @babel/helper-globals | 7.29.7 | MIT | notice included |
| @babel/helper-module-imports | 7.29.7 | MIT | notice included |
| @babel/helper-module-transforms | 7.29.7 | MIT | notice included |
| @babel/helper-plugin-utils | 7.29.7 | MIT | notice included |
| @babel/helper-string-parser | 7.29.7 | MIT | notice included |
| @babel/helper-validator-identifier | 7.29.7 | MIT | notice included |
| @babel/helper-validator-option | 7.29.7 | MIT | notice included |
| @babel/helpers | 7.29.7 | MIT | notice included |
| @babel/parser | 7.29.8 | MIT | notice included |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | MIT | notice included |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | MIT | notice included |
| @babel/template | 7.29.7 | MIT | notice included |
| @babel/traverse | 7.29.8 | MIT | notice included |
| @babel/types | 7.29.8 | MIT | notice included |
| @dnd-kit/accessibility | 3.1.1 | MIT | notice included |
| @dnd-kit/core | 6.3.1 | MIT | notice included |
| @dnd-kit/sortable | 8.0.0 | MIT | notice included |
| @dnd-kit/utilities | 3.2.2 | MIT | notice included |
| @esbuild/aix-ppc64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/android-arm | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/android-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/android-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/darwin-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/darwin-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/freebsd-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/freebsd-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-arm | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-ia32 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-loong64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-mips64el | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-ppc64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-riscv64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-s390x | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/linux-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/netbsd-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/netbsd-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/openbsd-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/openbsd-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/openharmony-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/sunos-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/win32-arm64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/win32-ia32 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @esbuild/win32-x64 | 0.25.12 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @jridgewell/gen-mapping | 0.3.13 | MIT | notice included |
| @jridgewell/remapping | 2.3.5 | MIT | notice included |
| @jridgewell/resolve-uri | 3.1.2 | MIT | notice included |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | notice included |
| @jridgewell/trace-mapping | 0.3.31 | MIT | notice included |
| @napi-rs/lzma-linux-x64-gnu | 1.5.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @remix-run/router | 1.23.4 | MIT | notice included |
| @rolldown/pluginutils | 1.0.0-beta.27 | MIT | notice included |
| @rollup/rollup-android-arm-eabi | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-android-arm64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-darwin-arm64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-darwin-x64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-freebsd-arm64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-freebsd-x64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-arm-gnueabihf | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-arm-musleabihf | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-arm64-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-arm64-musl | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-loong64-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-loong64-musl | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-ppc64-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-ppc64-musl | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-riscv64-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-riscv64-musl | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-s390x-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-x64-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-linux-x64-musl | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-openbsd-x64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-openharmony-arm64 | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-win32-arm64-msvc | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-win32-ia32-msvc | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-win32-x64-gnu | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @rollup/rollup-win32-x64-msvc | 4.63.1 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/node | 4.3.3 | MIT | notice included |
| @tailwindcss/oxide | 4.3.3 | MIT | notice included |
| @tailwindcss/oxide-android-arm64 | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-darwin-arm64 | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-darwin-x64 | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-freebsd-x64 | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-linux-arm-gnueabihf | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-linux-arm64-gnu | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-linux-arm64-musl | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-linux-x64-gnu | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-linux-x64-musl | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-wasm32-wasi | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-win32-arm64-msvc | 4.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| @tailwindcss/oxide-win32-x64-msvc | 4.3.3 | MIT | notice included |
| @tailwindcss/vite | 4.3.3 | MIT | notice included |
| @types/babel__core | 7.20.5 | MIT | notice included |
| @types/babel__generator | 7.27.0 | MIT | notice included |
| @types/babel__template | 7.4.4 | MIT | notice included |
| @types/babel__traverse | 7.28.0 | MIT | notice included |
| @types/estree | 1.0.9 | MIT | notice included |
| @types/prop-types | 15.7.15 | MIT | notice included |
| @types/react | 18.3.31 | MIT | notice included |
| @types/react-dom | 18.3.7 | MIT | notice included |
| @vitejs/plugin-react | 4.7.0 | MIT | notice included |
| baseline-browser-mapping | 2.11.20 | Apache-2.0 | notice included |
| browserslist | 4.28.8 | MIT | notice included |
| caniuse-lite | 1.0.30001810 | CC-BY-4.0 | notice included |
| convert-source-map | 2.0.0 | MIT | notice included |
| csstype | 3.2.3 | MIT | notice included |
| debug | 4.4.3 | MIT | notice included |
| detect-libc | 2.1.2 | Apache-2.0 | notice included |
| electron-to-chromium | 1.5.416 | ISC | notice included |
| enhanced-resolve | 5.24.5 | MIT | notice included |
| esbuild | 0.25.12 | MIT | notice included |
| escalade | 3.2.0 | MIT | notice included |
| fdir | 6.5.0 | MIT | notice included |
| fsevents | 2.3.3 | MIT | build-only/platform-specific or review upstream notice before redistributing this dependency |
| gensync | 1.0.0-beta.2 | MIT | notice included |
| graceful-fs | 4.2.11 | ISC | notice included |
| jiti | 2.7.0 | MIT | notice included |
| js-tokens | 4.0.0 | MIT | notice included |
| jsesc | 3.1.0 | MIT | notice included |
| json5 | 2.2.3 | MIT | notice included |
| lightningcss | 1.32.0 | MPL-2.0 | notice included |
| lightningcss-android-arm64 | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-darwin-arm64 | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-darwin-x64 | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-freebsd-x64 | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-linux-arm-gnueabihf | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-linux-arm64-gnu | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-linux-arm64-musl | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-linux-x64-gnu | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-linux-x64-musl | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-win32-arm64-msvc | 1.32.0 | MPL-2.0 | build-only/platform-specific or review upstream notice before redistributing this dependency |
| lightningcss-win32-x64-msvc | 1.32.0 | MPL-2.0 | notice included |
| loose-envify | 1.4.0 | MIT | notice included |
| lru-cache | 5.1.1 | ISC | notice included |
| lucide-react | 0.468.0 | ISC | notice included |
| magic-string | 0.30.21 | MIT | notice included |
| ms | 2.1.3 | MIT | notice included |
| nanoid | 3.3.18 | MIT | notice included |
| node-releases | 2.0.54 | MIT | notice included |
| picocolors | 1.1.1 | ISC | notice included |
| picomatch | 4.0.7 | MIT | notice included |
| postcss | 8.5.26 | MIT | notice included |
| react | 18.3.1 | MIT | notice included |
| react-dom | 18.3.1 | MIT | notice included |
| react-refresh | 0.17.0 | MIT | notice included |
| react-router | 6.30.6 | MIT | notice included |
| react-router-dom | 6.30.6 | MIT | notice included |
| rollup | 4.63.1 | MIT | notice included |
| scheduler | 0.23.2 | MIT | notice included |
| semver | 6.3.1 | ISC | notice included |
| source-map-js | 1.2.1 | BSD-3-Clause | notice included |
| tailwindcss | 4.3.3 | MIT | notice included |
| tapable | 2.3.3 | MIT | notice included |
| tinyglobby | 0.2.17 | MIT | notice included |
| tslib | 2.8.1 | 0BSD | notice included |
| typescript | 5.6.3 | Apache-2.0 | notice included |
| update-browserslist-db | 1.3.2 | MIT | notice included |
| vite | 6.4.3 | MIT | notice included |
| yallist | 3.1.1 | ISC | notice included |
| zustand | 5.0.15 | MIT | notice included |

Sources: [Python license](https://docs.python.org/3.12/license.html),
[PyInstaller license](https://pyinstaller.org/en/stable/license.html),
[Inno Setup license](https://jrsoftware.org/files/is/license.txt).
Regenerate/review notices when dependency versions change. MIT/BSD/Apache notices
and any accompanying attribution must travel with redistributed code/binaries.

- Waitress 3.0.2: Zope Public License 2.1; see `third_party_notices/Waitress-LICENSE.txt`. Production WSGI serving for the packaged application.
