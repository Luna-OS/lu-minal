; lu-minal's Windows installer (Inno Setup 6): lu-minal-windows-<arch>-setup.exe.
;
; It installs for the current user only, without administrator rights, into the folder install.ps1
; uses (%LOCALAPPDATA%\Programs\lu-minal), so either way of installing updates the other. Tasks:
; put lu-minal on the user PATH, add the Windows Terminal profile (Moon Dark colours) and a desktop
; shortcut. The Start menu entry opens lu-minal in Windows Terminal when it is installed. Updating
; while lu-minal runs works like install.ps1: the running exe is moved aside, the new one takes its
; place. The uninstaller (Settings > Apps) takes all of that away again (the PATH entry only when
; this setup added it, or for the default folder) and leaves lu-minal's settings, keys and
; sessions (%APPDATA%\lu-minal, %LOCALAPPDATA%\lu-minal) where they are.
;
; Built by the release workflow on Windows, after build-binaries.ts:
;   iscc /DAppVersion=0.2.0 /DArch=x64 windows\lu-minal.iss
; Arch is x64 or arm64; the exe comes from dist-bin\lu-minal-windows-<arch>.exe and the icon from
; dist-bin\lu-minal.ico (scripts/windows-icon.ts). The installer is written to dist-bin.
;
; Silent install (as CI tests it): lu-minal-windows-x64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES
;   /NORESTART /TASKS="path,terminal" [/DIR="..."]

#ifndef AppVersion
  #error Pass the version: iscc /DAppVersion=0.2.0 /DArch=x64 windows\lu-minal.iss
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#if Arch == "x64"
  #define AllowedArch "x64compatible"
#elif Arch == "arm64"
  #define AllowedArch "arm64"
#else
  #error Arch must be x64 or arm64
#endif
#ifndef DistDir
  #define DistDir "..\dist-bin"
#endif

; Four numbers for the file version (a pre-release part like -rc.1 and build metadata like +5 are
; left out).
#define VersionCore Copy(AppVersion, 1, Pos("-", AppVersion + "-") - 1)
#define NumericVersion Copy(VersionCore, 1, Pos("+", VersionCore + "+") - 1) + ".0"

[Setup]
; The same id for x64 and arm64 and for every version: one entry in Settings > Apps, updated in place.
AppId={{6F1C2B9E-8A4D-4E57-9B1F-3C2D7A5E9F10}
AppName=lu-minal
AppVersion={#AppVersion}
AppVerName=lu-minal {#AppVersion}
AppPublisher=Luna-OS
AppPublisherURL=https://github.com/Luna-OS/lu-minal
AppSupportURL=https://github.com/Luna-OS/lu-minal/issues
AppUpdatesURL=https://github.com/Luna-OS/lu-minal/releases
AppComments=A team of coding agents under the night sky
VersionInfoVersion={#NumericVersion}
VersionInfoDescription=lu-minal setup
VersionInfoCopyright=MIT License, Luna-OS
DefaultDirName={localappdata}\Programs\lu-minal
DisableDirPage=auto
; install.ps1's folder is expected to exist: NextButtonClick asks only about a folder without lu-minal.
DirExistsWarning=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed={#AllowedArch}
ArchitecturesInstallIn64BitMode={#AllowedArch}
MinVersion=10.0.17763
OutputDir={#DistDir}
OutputBaseFilename=lu-minal-windows-{#Arch}-setup
SetupIconFile={#DistDir}\lu-minal.ico
UninstallDisplayIcon={app}\lu-minal.exe
UninstallDisplayName=lu-minal
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; The user PATH changes: running programs (Explorer) are told to read it again.
ChangesEnvironment=yes
; A running lu-minal.exe is not stopped (that would end it without saving its session): it is
; moved aside instead (MoveRunningExeAside) and the new one takes its place.
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "path"; Description: "Add lu-minal to my PATH, so ""lu-minal"" works in any terminal"
Name: "terminal"; Description: "Add a lu-minal profile (Moon Dark colours) to Windows Terminal"
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Dirs]
; Removed when empty, also if install.ps1 created it (a shared folder with other files stays).
Name: "{app}"; Flags: uninsalwaysuninstall

[InstallDelete]
; Copies moved aside by an earlier update (or install.ps1) that are no longer running.
Type: files; Name: "{app}\lu-minal.old*.exe"

[Files]
Source: "{#DistDir}\lu-minal-windows-{#Arch}.exe"; DestDir: "{app}"; DestName: "lu-minal.exe"; Flags: ignoreversion; BeforeInstall: MoveRunningExeAside
; The Windows Terminal profile's icon (lu-minal setup windows-terminal looks next to the exe).
Source: "{#DistDir}\lu-minal.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; In Windows Terminal with lu-minal's profile when it is there, else straight (the default console).
; The command line goes along: a Windows Terminal that was already open hasn't loaded the new
; profile yet and would otherwise open its default shell.
Name: "{autoprograms}\lu-minal"; Filename: "{code:TerminalExe}"; Parameters: "{code:TerminalArgs}"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\lu-minal.exe"; Comment: "A team of coding agents under the night sky"; Check: UseTerminal
Name: "{autoprograms}\lu-minal"; Filename: "{app}\lu-minal.exe"; WorkingDir: "{%USERPROFILE}"; Comment: "A team of coding agents under the night sky"; Check: not UseTerminal
Name: "{autodesktop}\lu-minal"; Filename: "{code:TerminalExe}"; Parameters: "{code:TerminalArgs}"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\lu-minal.exe"; Tasks: desktopicon; Check: UseTerminal
Name: "{autodesktop}\lu-minal"; Filename: "{app}\lu-minal.exe"; WorkingDir: "{%USERPROFILE}"; Tasks: desktopicon; Check: not UseTerminal

[Run]
Filename: "{app}\lu-minal.exe"; Parameters: "setup windows-terminal"; Flags: runhidden waituntilterminated; Tasks: terminal; StatusMsg: "Adding the Windows Terminal profile..."
Filename: "{code:TerminalExe}"; Parameters: "{code:TerminalArgs}"; Description: "Start lu-minal"; Flags: postinstall nowait skipifsilent; Check: UseTerminal
Filename: "{app}\lu-minal.exe"; WorkingDir: "{%USERPROFILE}"; Description: "Start lu-minal"; Flags: postinstall nowait skipifsilent; Check: not UseTerminal

[UninstallRun]
; Always, not only after the terminal task: install.ps1 or `lu-minal setup windows-terminal` may
; have added it, and it would point at the removed exe.
Filename: "{app}\lu-minal.exe"; Parameters: "setup windows-terminal --remove"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "RemoveTerminalProfile"

[UninstallDelete]
; Old copies install.ps1 leaves behind when it updates a running lu-minal.
Type: files; Name: "{app}\lu-minal.old*.exe"

[Code]
const
  EnvironmentKey = 'Environment';
  { Where this setup notes that it put the install folder on the PATH (so uninstall leaves other
    entries alone). }
  StateKey = 'Software\Luna-OS\lu-minal';

{ Windows Terminal's app alias (installed from the Store or with winget), or '' without it. }
function TerminalExe(Param: String): String;
begin
  Result := ExpandConstant('{localappdata}\Microsoft\WindowsApps\wt.exe');
  if not FileExists(Result) then Result := '';
end;

{ wt.exe's arguments: lu-minal's profile, and its command line in case the profile isn't loaded. }
function TerminalArgs(Param: String): String;
begin
  Result := '-p "lu-minal" -d "' + ExpandConstant('{%USERPROFILE}') + '" -- "' + ExpandConstant('{app}\lu-minal.exe') + '"';
end;

{ Open lu-minal in Windows Terminal: it is installed and gets lu-minal's profile. }
function UseTerminal: Boolean;
begin
  Result := (TerminalExe('') <> '') and WizardIsTaskSelected('terminal');
end;

{ The entries of a PATH value, empty ones left out. }
function PathEntries(Value: String): TArrayOfString;
var
  P, N: Integer;
  Entry: String;
begin
  SetArrayLength(Result, 0);
  while Value <> '' do
  begin
    P := Pos(';', Value);
    if P = 0 then P := Length(Value) + 1;
    Entry := Copy(Value, 1, P - 1);
    Delete(Value, 1, P);
    if Trim(Entry) <> '' then
    begin
      N := GetArrayLength(Result);
      SetArrayLength(Result, N + 1);
      Result[N] := Entry;
    end;
  end;
end;

{ Whether a PATH entry names Dir (case, quotes and a trailing backslash don't matter). }
function SameDir(Entry, Dir: String): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(RemoveQuotes(Trim(Entry))), RemoveBackslashUnlessRoot(Dir)) = 0;
end;

procedure AddToPath(Dir: String);
var
  Value: String;
  Entries: TArrayOfString;
  I: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Value) then Value := '';
  Entries := PathEntries(Value);
  for I := 0 to GetArrayLength(Entries) - 1 do
    if SameDir(Entries[I], Dir) then Exit;
  if (Value <> '') and (Value[Length(Value)] <> ';') then Value := Value + ';';
  { Expandable, so the user's other %VARIABLE% entries keep working. }
  if RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Value + Dir) then
    RegWriteStringValue(HKCU, StateKey, 'AddedToPath', Dir)
  else
    Log('Could not add ' + Dir + ' to the user PATH.');
end;

procedure RemoveFromPath(Dir: String);
var
  Value, Kept: String;
  Entries: TArrayOfString;
  I: Integer;
  Found: Boolean;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Value) then Exit;
  Entries := PathEntries(Value);
  Kept := '';
  Found := False;
  for I := 0 to GetArrayLength(Entries) - 1 do
    if SameDir(Entries[I], Dir) then
      Found := True
    else
    begin
      if Kept <> '' then Kept := Kept + ';';
      Kept := Kept + Entries[I];
    end;
  if Found then RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Kept);
end;

{ Replacing a running lu-minal.exe fails, but renaming it works: it goes on running as
  lu-minal.old-<time>.exe (removed by the next update or the uninstaller) and the new one takes
  its place, as install.ps1 does it. }
procedure MoveRunningExeAside;
var
  Exe: String;
begin
  Exe := ExpandConstant('{app}\lu-minal.exe');
  if FileExists(Exe) and not DeleteFile(Exe) then
    if not RenameFile(Exe, ExpandConstant('{app}\lu-minal.old-') + GetDateTimeString('yyyymmddhhnnsszzz', #0, #0) + '.exe') then
      Log('Could not move the running lu-minal.exe aside.');
end;

{ Whether uninstall should take Dir off the PATH: this setup put it there, or it is the default
  folder (install.ps1's entry, emptied by the uninstall anyway). A shared folder such as C:\tools
  that was on the PATH before stays. }
function OwnsPathEntry(Dir: String): Boolean;
var
  Added: String;
begin
  Result := SameDir(Dir, ExpandConstant('{localappdata}\Programs\lu-minal')) or
    (RegQueryStringValue(HKCU, StateKey, 'AddedToPath', Added) and SameDir(Added, Dir));
end;

#if Arch == "x64"
{ The x64 build runs emulated on Windows on Arm: point to the native one first. }
function InitializeSetup: Boolean;
begin
  Result := True;
  if IsArm64 then
    Result := SuppressibleMsgBox('This PC runs Windows on Arm: lu-minal-windows-arm64-setup.exe installs the native build.' + #13#10#13#10 +
      'Install the x64 build (it runs emulated) anyway?', mbConfirmation, MB_YESNO, IDYES) = IDYES;
end;
#endif

{ The folder page: ask only about a folder that exists without lu-minal in it (DirExistsWarning
  would also ask about install.ps1's folder, which this setup simply updates). }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Dir := WizardForm.DirEdit.Text;
    if DirExists(Dir) and not FileExists(AddBackslash(Dir) + 'lu-minal.exe') then
      Result := SuppressibleMsgBox(FmtMessage(SetupMessage(msgDirExists), [Dir]), mbConfirmation, MB_YESNO, IDYES) = IDYES;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('path') then AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { Before the files go and before the uninstaller tells Explorer the environment changed. }
  if CurUninstallStep = usUninstall then
  begin
    if OwnsPathEntry(ExpandConstant('{app}')) then RemoveFromPath(ExpandConstant('{app}'));
    RegDeleteKeyIncludingSubkeys(HKCU, StateKey);
    RegDeleteKeyIfEmpty(HKCU, 'Software\Luna-OS');
  end;
end;
