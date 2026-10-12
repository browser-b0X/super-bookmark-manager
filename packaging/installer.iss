; SuperBookmarks (formerly Super Bookmark Manager) - per-user Windows installer (B6 Windows Installer slice)
;
; Packages the ALREADY-VERIFIED PyInstaller --onedir standalone runtime in
; dist-standalone/SuperBookmarkManager/. It does NOT rebuild application source.
;
; Model:
;   - per-user install (PrivilegesRequired=lowest) -> no admin / no UAC elevation
;   - default target {autopf}\SuperBookmarkManager == %LOCALAPPDATA%\Programs\SuperBookmarkManager
;   - Start Menu shortcut (user); optional Desktop shortcut (opt-in, default off)
;   - no PATH mutation, no service, no scheduled task, no machine-wide install
;   - registry touched only for the standard per-user uninstall entry + shortcuts
;   - UNSIGNED (no configured code-signing identity)
;
; Writable data boundary:
;   The app writes user data to %LOCALAPPDATA%\SuperBookmarkManager\ (a DIFFERENT path
;   from the install dir under ...\Programs\...). The uninstaller removes only files it
;   installed under {app}; it never touches the user-data directory, so the SQLite DB,
;   thumbnail cache, backups and any owner-supplied Telegram session survive uninstall.
;
; Release candidate. Compilation does not publish or tag a release.

#ifndef StandaloneDir
  #define StandaloneDir "..\dist-standalone-v0.3.0\SuperBookmarkManager"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist-installer-v0.3.0"
#endif
#ifndef AppVersion
  #define AppVersion "0.3.0"
#endif

; Shown name since v0.3.0. Folders, AppId and the exe name keep the old spelling so upgrades find everything.
#define MyAppName "SuperBookmarks"
#define MyAppExeName "SuperBookmarkManager.exe"
; Stable per-app identity used only for reinstall/upgrade detection and the uninstall entry.
#define MyAppId "7D4F1A22-9C8B-4E63-A5D0-3F2B1C9E8A77"

[Setup]
AppId={{{#MyAppId}}}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
; Project-neutral local metadata. No legitimate publisher/signing identity is claimed.
AppPublisher=SuperBookmarks (local build)
DefaultDirName={autopf}\SuperBookmarkManager
; Builds up to v0.1.x installed into ...\Programs\SavedPostsDashboard. Do not reuse that
; folder on upgrade: install into the new one and remove the old program files below.
UsePreviousAppDir=no
DefaultGroupName=SuperBookmarks
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

[InstallDelete]
; Old program folder from v0.1.x installs only (program files, never user data: the
; v0.1.x data folder is %LOCALAPPDATA%\SavedPostsDashboard, outside Programs). Guarded
; by IsLegacyProgramDir so nothing else with that name is touched.
Type: filesandordirs; Name: "{autopf}\SavedPostsDashboard"; Check: IsLegacyProgramDir
; Shortcuts under the name used up to v0.2.0; the new ones are made below (the Desktop one
; again when there was one, see HadOldDesktopIcon).
Type: files; Name: "{autoprograms}\Super Bookmark Manager.lnk"
Type: files; Name: "{autodesktop}\Super Bookmark Manager.lnk"

[Files]
; Copy the verified standalone runtime tree verbatim. ignoreversion so a same-version
; reinstall refreshes application files; user data lives outside {app} and is unaffected.
Source: "{#StandaloneDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\SuperBookmarks"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "Launch SuperBookmarks (local server)"
Name: "{autodesktop}\SuperBookmarks"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
; An upgrade (also a silent one) keeps a Desktop shortcut the owner already had, under the new name.
Name: "{autodesktop}\SuperBookmarks"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Check: HadOldDesktopIcon

[Run]
; Offer to launch after an INTERACTIVE install only; skipped for silent/very-silent.
Filename: "{app}\{#MyAppExeName}"; Parameters: "{code:LaunchParameters}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
function LegacyProgramDir(): String;
begin
  Result := ExpandConstant('{autopf}\SavedPostsDashboard');
end;

// True only for a folder our own earlier installer created: it holds our executable
// and an Inno uninstaller, and none of the files the app keeps user data in.
function HasLegacyProgram(): Boolean;
var
  Dir: String;
begin
  Dir := LegacyProgramDir();
  Result := FileExists(Dir + '\{#MyAppExeName}') and FileExists(Dir + '\unins000.exe')
    and not FileExists(Dir + '\saved_posts.db') and not FileExists(Dir + '\config.json')
    and not FileExists(Dir + '\session.session') and not DirExists(Dir + '\thumb_cache');
end;

function IsLegacyProgramDir(): Boolean;
begin
  Result := HasLegacyProgram() and (CompareText(LegacyProgramDir(), ExpandConstant('{app}')) <> 0);
end;

// A copy that is still running (possibly from the old folder) would keep serving
// the old version and lock its files. Stop it before installing; its library is
// already in SQLite, and edits not yet saved stay in the browser and sync on the
// next start.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#MyAppExeName}', '', SW_HIDE,
          ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
    Sleep(1500);
end;

var
  OldDesktopIcon: Integer;   // 0 unknown, 1 yes, 2 no

// Whether a Desktop shortcut under the pre-v0.3.0 name existed when setup started
// (checked once, before [InstallDelete] removes it).
function HadOldDesktopIcon(): Boolean;
begin
  if OldDesktopIcon = 0 then
    if FileExists(ExpandConstant('{autodesktop}\Super Bookmark Manager.lnk')) then OldDesktopIcon := 1 else OldDesktopIcon := 2;
  Result := OldDesktopIcon = 1;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  // Remember it now, also in silent upgrades: [InstallDelete] runs before [Icons].
  if CurStep = ssInstall then
    HadOldDesktopIcon();
end;

// An existing Desktop shortcut would point at the removed folder; keep it by
// re-creating it in the new location.
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and HadOldDesktopIcon() then
    WizardSelectTasks('desktopicon');
end;

function LaunchParameters(Param: String): String;
begin
  if WizardIsTaskSelected('telegramsetup') then
    Result := '--configure-telegram'
  else
    Result := '';
end;

// NOTE: No [UninstallDelete] section. The uninstaller removes only what it installed under
// {app} (the install dir) plus the per-user uninstall entry and shortcuts. It deliberately
// does NOT delete %LOCALAPPDATA%\SuperBookmarkManager\ (user DB, cache, backups, session).
