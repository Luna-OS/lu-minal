; lu-minal's Windows installer (Inno Setup 6): lu-minal-windows-<arch>-setup.exe.
;
; It installs for the current user only, without administrator rights, into the folder install.ps1
; uses (%LOCALAPPDATA%\Programs\lu-minal), so either way of installing updates the other. Tasks:
; put lu-minal on the user PATH, add the Windows Terminal profile (Moon Dark colours) and a desktop
; shortcut. The Start menu entry opens lu-minal in Windows Terminal when it is installed. The
; uninstaller (Settings > Apps) takes all of that away again and leaves lu-minal's settings,
; keys and sessions (%APPDATA%\lu-minal, %LOCALAPPDATA%\lu-minal) where they are.
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

; Four numbers for the file version (a pre-release part like -rc.1 is left out).
#define NumericVersion Copy(AppVersion, 1, Pos("-", AppVersion + "-") - 1) + ".0"

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
; A running lu-minal.exe is closed (after asking) so it can be replaced.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "path"; Description: "Add lu-minal to my PATH, so ""lu-minal"" works in any terminal"
Name: "terminal"; Description: "Add a lu-minal profile (Moon Dark colours) to Windows Terminal"
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#DistDir}\lu-minal-windows-{#Arch}.exe"; DestDir: "{app}"; DestName: "lu-minal.exe"; Flags: ignoreversion

[Icons]
; In Windows Terminal with lu-minal's profile when it is there, else straight (the default console).
Name: "{autoprograms}\lu-minal"; Filename: "{code:TerminalExe}"; Parameters: "-p ""lu-minal"""; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\lu-minal.exe"; Comment: "A team of coding agents under the night sky"; Check: UseTerminal
Name: "{autoprograms}\lu-minal"; Filename: "{app}\lu-minal.exe"; WorkingDir: "{%USERPROFILE}"; Comment: "A team of coding agents under the night sky"; Check: not UseTerminal
Name: "{autodesktop}\lu-minal"; Filename: "{code:TerminalExe}"; Parameters: "-p ""lu-minal"""; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\lu-minal.exe"; Tasks: desktopicon; Check: UseTerminal
Name: "{autodesktop}\lu-minal"; Filename: "{app}\lu-minal.exe"; WorkingDir: "{%USERPROFILE}"; Tasks: desktopicon; Check: not UseTerminal

[Run]
Filename: "{app}\lu-minal.exe"; Parameters: "setup windows-terminal"; Flags: runhidden waituntilterminated; Tasks: terminal; StatusMsg: "Adding the Windows Terminal profile..."
Filename: "{code:TerminalExe}"; Parameters: "-p ""lu-minal"""; Description: "Start lu-minal"; Flags: postinstall nowait skipifsilent; Check: UseTerminal
Filename: "{app}\lu-minal.exe"; WorkingDir: "{%USERPROFILE}"; Description: "Start lu-minal"; Flags: postinstall nowait skipifsilent; Check: not UseTerminal

[UninstallRun]
Filename: "{app}\lu-minal.exe"; Parameters: "setup windows-terminal --remove"; Flags: runhidden waituntilterminated; Tasks: terminal; RunOnceId: "RemoveTerminalProfile"

[UninstallDelete]
; Old copies install.ps1 leaves behind when it updates a running lu-minal.
Type: files; Name: "{app}\lu-minal.old*.exe"

[Code]
const
  EnvironmentKey = 'Environment';

{ Windows Terminal's app alias (installed from the Store or with winget), or '' without it. }
function TerminalExe(Param: String): String;
begin
  Result := ExpandConstant('{localappdata}\Microsoft\WindowsApps\wt.exe');
  if not FileExists(Result) then Result := '';
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
  if not RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Value + Dir) then
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

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('path') then AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveFromPath(ExpandConstant('{app}'));
end;
