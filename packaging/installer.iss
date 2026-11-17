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
  #define StandaloneDir "..\dist-standalone-v0.4.0\SuperBookmarkManager"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist-installer-v0.4.0"
#endif
#ifndef AppVersion
  #define AppVersion "0.4.0"
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
; An upgrade installs where the previous install is, also a folder the owner chose (else a second
; copy appeared under Programs); see InstallDir. Builds up to v0.1.x installed into
; ...\Programs\SavedPostsDashboard: that folder is never reused, the old program files are removed below.
DefaultDirName={code:InstallDir}
UsePreviousAppDir=no
; Tasks are chosen afresh: a Desktop shortcut the owner deleted must not come back with an upgrade.
; One that exists is kept (HadDesktopIcon).
UsePreviousTasks=no
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
; The runtime folder is replaced whole, so files a newer PyInstaller no longer ships don't linger.
; Only in a folder holding our program; user data never lives under {app}.
Type: filesandordirs; Name: "{app}\_internal"; Check: IsOurProgramDir

[UninstallDelete]
; The runtime folder, including files the running app wrote into it (Python caches), so
; uninstalling leaves no half-empty program folder behind. Never the user-data folder.
Type: filesandordirs; Name: "{app}\_internal"
Type: dirifempty; Name: "{app}"

[Files]
; Copy the verified standalone runtime tree verbatim. ignoreversion so a same-version
; reinstall refreshes application files; user data lives outside {app} and is unaffected.
Source: "{#StandaloneDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\SuperBookmarks"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "Launch SuperBookmarks (local server)"
Name: "{autodesktop}\SuperBookmarks"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
; An upgrade (also a silent one) keeps a Desktop shortcut the owner has now, under the new name.
Name: "{autodesktop}\SuperBookmarks"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Check: HadDesktopIcon

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

function IsOurProgramDir(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\{#MyAppExeName}'));
end;

// Where the previous install is, from its uninstall entry: a folder the owner chose stays the
// folder. Not the v0.1.x SavedPostsDashboard folder, and only when our program is still there.
function PreviousAppDir(): String;
var
  Key, Dir: String;
begin
  Result := '';
  // AppId={{{#MyAppId}} registers "{<id>}}" (both closing braces): every release so far used that key.
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{' + '{#MyAppId}' + '}}_is1';
  if not RegQueryStringValue(HKCU, Key, 'Inno Setup: App Path', Dir) then
    if not RegQueryStringValue(HKLM, Key, 'Inno Setup: App Path', Dir) then
      Exit;
  Dir := RemoveBackslashUnlessRoot(Dir);
  if (Dir <> '') and FileExists(Dir + '\{#MyAppExeName}')
      and (CompareText(ExtractFileName(Dir), 'SavedPostsDashboard') <> 0) then
    Result := Dir;
end;

function InstallDir(Param: String): String;
begin
  Result := PreviousAppDir();
  if Result = '' then
    Result := ExpandConstant('{autopf}\SuperBookmarkManager');
end;

// The running copy's address and key, from the discovery record it writes in its data folder.
function ReadRuntime(var Port, Token: String): Boolean;
var
  Raw: AnsiString;
  Text: String;
  P, I: Integer;
begin
  Result := False;
  Port := '';
  Token := '';
  if not LoadStringFromFile(ExpandConstant('{localappdata}\SuperBookmarkManager\runtime.json'), Raw) then
    Exit;
  Text := String(Raw);
  P := Pos('"port"', Text);
  if P = 0 then Exit;
  I := P + 6;
  while (I <= Length(Text)) and ((Text[I] = ':') or (Text[I] = ' ')) do I := I + 1;
  while (I <= Length(Text)) and (Text[I] >= '0') and (Text[I] <= '9') and (Length(Port) < 5) do
  begin
    Port := Port + Text[I];
    I := I + 1;
  end;
  P := Pos('"token"', Text);
  if P = 0 then Exit;
  I := P + 7;
  while (I <= Length(Text)) and (Text[I] <> '"') do I := I + 1;
  I := I + 1;
  while (I <= Length(Text)) and (Text[I] <> '"') and (Length(Token) < 64) do
  begin
    Token := Token + Text[I];
    I := I + 1;
  end;
  Result := (Port <> '') and (Length(Token) = 64);
end;

// One request to the running copy; True when it answered 200.
function AskRunningApp(Method, Path, Port, Token: String): Boolean;
var
  Http: Variant;
begin
  Result := False;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.SetTimeouts(1000, 1000, 2000, 2000);
    Http.Open(Method, 'http://127.0.0.1:' + Port + Path, False);
    Http.SetRequestHeader('X-SBM-Instance', Token);
    if Method = 'POST' then
    begin
      Http.SetRequestHeader('Content-Type', 'application/json');
      Http.Send('{"confirm": true}');
    end else
      Http.Send('');
    Result := Http.Status = 200;
  except
    Result := False;
  end;
end;

function AppProcessRunning(): Boolean;
var
  ResultCode: Integer;
begin
  // find exits 0 when tasklist lists the program.
  Result := Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "IMAGENAME eq {#MyAppExeName}" /NH | find /I "{#MyAppExeName}"',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

// A running copy keeps serving the old version and holds its files (uninstalling left the
// files and the server running). Ask it to quit the way its own Quit button does, so it
// finishes what it is saving; wait for it to end; stop it only if it doesn't. This works
// with any installed version: it needs only the quit route every copy has.
procedure StopRunningApp();
var
  Port, Token: String;
  Tries, ResultCode: Integer;
begin
  if ReadRuntime(Port, Token) and AskRunningApp('GET', '/api/runtime', Port, Token) then
    if AskRunningApp('POST', '/api/runtime/quit', Port, Token) then
    begin
      Tries := 0;
      while AppProcessRunning() and (Tries < 40) do
      begin
        Sleep(500);
        Tries := Tries + 1;
      end;
    end;
  if Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#MyAppExeName}', '', SW_HIDE,
          ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
    Sleep(1500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopRunningApp();
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  StopRunningApp();
end;

var
  DesktopIcon: Integer;   // 0 unknown, 1 yes, 2 no

// Whether a Desktop shortcut (either name) existed when setup started (checked once,
// before [InstallDelete] removes the old-name one).
function HadDesktopIcon(): Boolean;
begin
  if DesktopIcon = 0 then
    if FileExists(ExpandConstant('{autodesktop}\Super Bookmark Manager.lnk'))
        or FileExists(ExpandConstant('{autodesktop}\SuperBookmarks.lnk')) then
      DesktopIcon := 1
    else
      DesktopIcon := 2;
  Result := DesktopIcon = 1;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  // Remember it now, also in silent upgrades: [InstallDelete] runs before [Icons].
  if CurStep = ssInstall then
    HadDesktopIcon();
end;

// Keep an existing Desktop shortcut ticked on the wizard's tasks page.
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and HadDesktopIcon() then
    WizardSelectTasks('desktopicon');
end;

function LaunchParameters(Param: String): String;
begin
  if WizardIsTaskSelected('telegramsetup') then
    Result := '--configure-telegram'
  else
    Result := '';
end;

// NOTE: [UninstallDelete] removes only {app}\_internal and an empty {app}. The uninstaller
// deliberately does NOT delete %LOCALAPPDATA%\SuperBookmarkManager\ (user DB, cache, backups, session).
