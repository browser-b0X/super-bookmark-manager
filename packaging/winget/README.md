# WinGet distribution

Status: local manifest preparation only. This package is not yet available in the
WinGet community repository. The intended v0.2.0 download URL must not be advertised
as live until the exact installer is published and the manifest is accepted.

The manifest uses the existing per-user Inno installer and stable uninstall ID.
No Python or Node dependency is needed. WinGet does not sign the executable or
remove SmartScreen/antivirus checks. Signing remains deferred.

## Prepared package

- Identifier: `browser-b0X.SuperBookmarkManager`
- Version: `0.2.0` (matches Windows registration; `-rN` is only a local candidate suffix)
- Candidate: `dist-installer-v0.2.0/SuperBookmarkManager-Setup.exe` (or the `-rN` you release)
- Manifest directory: `packaging/winget/manifests/b/browser-b0X/SuperBookmarkManager/0.2.0`
- Intended download: `https://github.com/browser-b0X/super-bookmark-manager/releases/download/v0.2.0/SuperBookmarkManager-Setup.exe`

`InstallerSha256` is a placeholder until the final installer is built, so validation
fails on purpose until it is filled in. The hash must equal the exact released
installer. Do not replace an asset under an accepted version. The publisher text
deliberately matches the current Windows uninstall entry; it is not a claim of a
verified signing identity.

## Local validation

From the repository root, after building the installer:

```powershell
(Get-FileHash dist-installer-v0.2.0/SuperBookmarkManager-Setup.exe -Algorithm SHA256).Hash
# paste that value into InstallerSha256 in the .installer.yaml, then:
winget validate --manifest packaging/winget/manifests/b/browser-b0X/SuperBookmarkManager/0.2.0
```

Schema validation does not prove hosted download availability or installation.
No local-manifest settings need to be enabled for validation. Do not enable settings
or install over personal state as a validation shortcut.

## Publication-dependent availability

After the release is published, verify the downloaded bytes against the hash, then
submit these three YAML files to the matching
`manifests/b/browser-b0X/SuperBookmarkManager/0.2.0` path in `microsoft/winget-pkgs`.
Run repository validation and resolve only findings tied to this package.

After acceptance, users can install or upgrade with:

```powershell
winget install --id browser-b0X.SuperBookmarkManager --exact --source winget --scope user
winget upgrade --id browser-b0X.SuperBookmarkManager --exact --source winget
```

Quit the app (sidebar power button, or Settings -> Quit) before upgrading. The manifest requests
per-user installation, no reboot, no automatic application closure/restart, and no
optional Desktop/Telegram-setup tasks. Data remains outside the program directory.
