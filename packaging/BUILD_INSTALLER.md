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

Outputs: `dist-standalone/SuperBookmarkManager/`,
`dist-installer/SuperBookmarkManager-Setup.exe` and `.exe.sha256`.

Version: 0.1.0. Display name, Start Menu shortcut, optional Desktop shortcut and
uninstall entry: **Super Bookmark Manager**. Executable: `SuperBookmarkManager.exe`.
The stable AppId and `%LOCALAPPDATA%\Programs\SavedPostsDashboard\` program directory
remain compatible with earlier local builds. `PrivilegesRequired=lowest`: per-user,
no admin; no PATH modification, service or scheduled task. Desktop is opt-in.
The optional Telegram setup task opens Settings; the installer never collects keys.

Super Bookmark Manager retains the legacy `%LOCALAPPDATA%\SavedPostsDashboard\`
user-data directory for compatibility with existing installations. This is separate
from program files. There is no migration. Same-version reinstall and uninstall
preserve database/config/session/backups. No `[UninstallDelete]` action is present.

Interactive: double-click the setup file. Silent synthetic verification can use
`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=` with an isolated destination/profile.
Do not test against an existing personal installation. Close only the test-owned
server before reinstall/uninstall. Signing is not performed; no signing identity
is configured. Current-machine checks do not prove cross-machine compatibility.
