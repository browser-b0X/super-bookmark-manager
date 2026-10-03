# Super Bookmark Manager — per-user installer

Use the commands and pinned prerequisites in [BUILDING.md](../BUILDING.md).
Inno Setup 6.7.3 compiles `installer.iss`; the wrapper verifies every standalone
payload file against its generated receipt and compares current frontend/license
assets before packaging. A build receipt is not a substitute for runtime testing.

From the repository root:

```powershell
py -3.12 packaging/build_standalone.py
py -3.12 packaging/build_installer.py
```

Outputs: `dist-standalone-v0.2.0/SuperBookmarkManager/`,
`dist-installer-v0.2.0/SuperBookmarkManager-Setup.exe` and `.exe.sha256`.

Version: 0.2.0 (set in `packaging/release_paths.py`). Display name, Start Menu shortcut, optional Desktop shortcut and
uninstall entry: **Super Bookmark Manager**. Executable: `SuperBookmarkManager.exe`.
Program files go to `%LOCALAPPDATA%\Programs\SuperBookmarkManager\`. The stable AppId
upgrades earlier installs in place; an old v0.1.x program folder
(`...\Programs\SavedPostsDashboard\`) is removed only when it holds our executable and
uninstaller and no user-data files, and an existing Desktop shortcut is re-created. `PrivilegesRequired=lowest`: per-user,
no admin; no PATH modification, service or scheduled task. Desktop is opt-in.
The optional Telegram setup task opens Settings; the installer never collects keys.

Public writable state belongs to `%LOCALAPPDATA%\SuperBookmarkManager\`.
Legacy `%LOCALAPPDATA%\SavedPostsDashboard\` remains untouched and is never
silently adopted or migrated. Both directories survive uninstall. Browser storage
has a per-public-profile namespace; source/developer overrides and inherited
credentials are ignored by the packaged entry. Quit is in Library settings.
The executable is windowless and uses loopback-only Waitress. Duplicate launch
reopens the running instance; occupied ports use a free loopback port.

Both builders scan forbidden payload paths before hashing/bundling and refuse
existing candidate output directories. Keep prior candidates and v0.1.0 intact.

Interactive: double-click the setup file. Silent synthetic verification can use
`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=` only inside a truly separate Windows account/VM.
A `/DIR` override alone does not isolate the uninstall registry or shortcuts.
Do not test against an existing personal installation. Close only the test-owned
server before reinstall/uninstall. Signing is not performed; no signing identity
is configured. Current-machine checks do not prove cross-machine compatibility.

For a subsequent candidate without replacing an earlier one, set
`$env:SBM_BUILD_CANDIDATE="v0.2.0-r2"` before both build commands. Only
`v0.2.0` or `v0.2.0-rN` (positive integer) is accepted; outputs and compiler
scratch paths use that suffix. Clear the variable to use the initial candidate paths.
