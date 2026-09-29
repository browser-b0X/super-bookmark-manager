; Super Bookmark Manager - per-user Windows installer (B6 Windows Installer slice)
;
; Packages the ALREADY-VERIFIED PyInstaller --onedir standalone runtime in
; dist-standalone/SuperBookmarkManager/. It does NOT rebuild application source.
;
; Model:
;   - per-user install (PrivilegesRequired=lowest) -> no admin / no UAC elevation
;   - default target {autopf}\SavedPostsDashboard == %LOCALAPPDATA%\Programs\SavedPostsDashboard
;   - Start Menu shortcut (user); optional Desktop shortcut (opt-in, default off)
;   - no PATH mutation, no service, no scheduled task, no machine-wide install
;   - registry touched only for the standard per-user uninstall entry + shortcuts
;   - UNSIGNED (no configured code-signing identity)
;
; Writable data boundary:
;   The app writes user data to %LOCALAPPDATA%\SavedPostsDashboard\ (a DIFFERENT path
;   from the install dir under ...\Programs\...). The uninstaller removes only files it
;   installed under {app}; it never touches the user-data directory, so the SQLite DB,
;   thumbnail cache, backups and any owner-supplied Telegram session survive uninstall.
;
; First public release candidate. Compilation does not publish or tag a release.

#ifndef StandaloneDir
  #define StandaloneDir "..\dist-standalone\SuperBookmarkManager"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist-installer"
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define MyAppName "Super Bookmark Manager"
#define MyAppExeName "SuperBookmarkManager.exe"
; Stable per-app identity used only for reinstall/upgrade detection and the uninstall entry.
#define MyAppId "7D4F1A22-9C8B-4E63-A5D0-3F2B1C9E8A77"

[Setup]
AppId={{{#MyAppId}}}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
; Project-neutral local metadata. No legitimate publisher/signing identity is claimed.
AppPublisher=Super Bookmark Manager (local build)
DefaultDirName={autopf}\SavedPostsDashboard
DefaultGroupName=Super Bookmark Manager
; Per-user, no elevation. Command-line override is allowed; no interactive UAC prompt.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
DisableProgramGroupPage=auto
DisableDirPage=auto
OutputDir={#OutputDir}
OutputBaseFilename=SuperBookmarkManager-Setup
SetupIconFile=app.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
AllowNoIcons=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; Desktop shortcut is opt-in and NOT selected by default (unchecked).
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "telegramsetup"; Description: "Configure Telegram developer keys in Settings on launch (optional; not login)"; GroupDescription: "Optional first-run setup:"; Flags: unchecked

[Files]
; Copy the verified standalone runtime tree verbatim. ignoreversion so a same-version
; reinstall refreshes application files; user data lives outside {app} and is unaffected.
Source: "{#StandaloneDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Super Bookmark Manager"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "Launch Super Bookmark Manager (local server)"
Name: "{autodesktop}\Super Bookmark Manager"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Offer to launch after an INTERACTIVE install only; skipped for silent/very-silent.
Filename: "{app}\{#MyAppExeName}"; Parameters: "{code:LaunchParameters}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
function LaunchParameters(Param: String): String;
begin
  if WizardIsTaskSelected('telegramsetup') then
    Result := '--configure-telegram'
  else
    Result := '';
end;

// NOTE: No [UninstallDelete] section. The uninstaller removes only what it installed under
// {app} (the install dir) plus the per-user uninstall entry and shortcuts. It deliberately
// does NOT delete %LOCALAPPDATA%\SavedPostsDashboard\ (user DB, cache, backups, session).
