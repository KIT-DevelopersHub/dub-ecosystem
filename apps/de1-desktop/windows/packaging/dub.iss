; Inno Setup script for the Dub desktop client (Windows installer).
; Consumed by the "Build desktop installers" GitHub Actions workflow, which
; runs on windows-latest, builds the Flutter Windows release bundle, then
; compiles this script with ISCC to produce a single Setup .exe.
;
; The app version is injected on the command line:
;   ISCC /DMyAppVersion=1.0.0 dub.iss
; and the built bundle directory via /DBundleDir=... (absolute path to
; build\windows\x64\runner\Release).

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#ifndef BundleDir
  #define BundleDir "..\..\build\windows\x64\runner\Release"
#endif

#define MyAppName "Dub"
#define MyAppPublisher "DevelopersHub"
#define MyAppExeName "dub_desktop.exe"

[Setup]
AppId={{6F2B1E5A-3C7D-4E9A-8B21-DUB0DESKTOP01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; Per-user install by default (no forced UAC prompt) so DefaultDirName
; ({autopf}\Dub) resolves to %LocalAppData%\Programs\Dub — a folder the app's
; own (non-elevated) process can always write into. The user can still opt
; into an all-users/Program Files install via the dialog if they choose.
; Belt-and-suspenders alongside the explicit WebView2 userDataFolder set in
; lib/main.dart: that fix alone already makes WebView2 itself installation-
; path-independent, but a writable install dir avoids the same class of
; access-denied surprise for any other local state the app may need later.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputBaseFilename=Dub-Windows-{#MyAppVersion}-Setup-unsigned
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
