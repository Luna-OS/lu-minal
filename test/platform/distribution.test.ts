// The distribution files agree with each other and with the code: the macOS app's palette and the
// Windows Terminal scheme, install.sh's embedded desktop entry and icon and linux/, the macOS
// bundle metadata, the installers' asset names and the release workflow's targets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_TARGETS, resolveTargets } from "../../src/platform/install-info.js";
import { MOON_ANSI, moonAnsiPalette } from "../../src/platform/windows-terminal.js";
import { builtinTheme, MOON_PALETTE } from "../../src/themes/builtin.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Reads a repository file with LF line endings (a Windows checkout may have CRLF). */
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

function heredoc(script: string, tag: string): string {
  const m = new RegExp(`cat <<'${tag}'\\n([\\s\\S]*?)\\n${tag}\\n`).exec(script);
  if (!m) throw new Error(`no ${tag} here-document`);
  return `${m[1]}\n`;
}

describe("the macOS app's Moon palette", () => {
  const swift = read("macos", "Sources", "LuMinal", "MoonPalette.swift");
  const single = (name: string) => new RegExp(`static let ${name} = "(#[0-9a-f]{6})"`).exec(swift)?.[1];

  it("matches MOON_ANSI (background, text, cursor, selection)", () => {
    expect(single("background")).toBe(MOON_ANSI.background);
    expect(single("foreground")).toBe(MOON_ANSI.foreground);
    expect(single("cursor")).toBe(MOON_ANSI.cursor);
    expect(single("cursorText")).toBe(MOON_ANSI.cursorText);
    expect(single("selection")).toBe(MOON_ANSI.selection);
  });

  it("has the same 16 ANSI colours in the same order", () => {
    const block = /static let ansi: \[String\] = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? "";
    expect([...block.matchAll(/"(#[0-9a-f]{6})"/g)].map((m) => m[1])).toEqual(moonAnsiPalette());
  });
});

describe("the Swift package and the app bundle", () => {
  const pkg = read("macos", "Package.swift");
  const plist = read("macos", "Resources", "Info.plist");
  const value = (key: string) => new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`).exec(plist);

  it("targets macOS 13 with Swift tools 5.9 and SwiftTerm", () => {
    expect(pkg.startsWith("// swift-tools-version:5.9\n")).toBe(true);
    expect(pkg).toContain(".macOS(.v13)");
    expect(pkg).toContain('.executableTarget(\n            name: "LuMinal"');
    expect(pkg).toMatch(/\.package\(url: "https:\/\/github\.com\/migueldeicaza\/SwiftTerm", \.upToNextMinor\(from: "1\.10\.1"\)\)/);
    expect(pkg).toContain('.product(name: "SwiftTerm", package: "SwiftTerm")');
  });

  it("has the bundle id, names and appearance settings", () => {
    expect(value("CFBundleIdentifier")?.[2]).toBe("os.luna.lu-minal");
    expect(value("CFBundleName")?.[2]).toBe("lu-minal");
    expect(value("CFBundleDisplayName")?.[2]).toBe("lu-minal");
    expect(value("CFBundleExecutable")?.[2]).toBe("LuMinal");
    expect(value("CFBundlePackageType")?.[2]).toBe("APPL");
    expect(value("LSMinimumSystemVersion")?.[2]).toBe("13.0");
    expect(value("NSHighResolutionCapable")?.[1]).toBe("true");
    expect(value("NSRequiresAquaSystemAppearance")?.[1]).toBe("false");
    expect(value("CFBundleIconFile")?.[2]).toBe("AppIcon");
  });

  it("leaves the version to bundle-app.sh, which fills it in", () => {
    expect(value("CFBundleShortVersionString")?.[2]).toBe("@VERSION@");
    expect(value("CFBundleVersion")?.[2]).toBe("@BUILD@");
    const script = read("macos", "scripts", "bundle-app.sh");
    expect(script).toContain('s/@VERSION@/$VERSION/g');
    expect(script).toContain('s/@BUILD@/$BUILD/g');
    expect(script).toContain('Contents/Resources/bin/lu-minal');
    expect(script).toContain("codesign --force --deep --sign - \"$APP\"");
    expect(script).toContain("ditto -c -k --sequesterRsrc --keepParent");
  });

  it("explains the privacy prompts the programs it runs can trigger", () => {
    // macOS attributes a child process's requests (osascript, ~/Documents, ...) to the app; without a
    // purpose string it may refuse them without asking.
    for (const key of [
      "NSAppleEventsUsageDescription",
      "NSDesktopFolderUsageDescription",
      "NSDocumentsFolderUsageDescription",
      "NSDownloadsFolderUsageDescription",
      "NSLocalNetworkUsageDescription",
      "NSNetworkVolumesUsageDescription",
      "NSRemovableVolumesUsageDescription",
    ]) {
      expect(value(key)?.[2], key).toMatch(/^Programs that lu-minal and its agents run/);
    }
  });

  it("is well-formed plist XML with balanced dict and array tags", () => {
    for (const tag of ["dict", "array", "plist"]) {
      const opens = plist.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0;
      expect(plist.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0, tag).toBe(opens);
    }
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).filter((k) => k.startsWith("CF") || k.startsWith("NS") || k.startsWith("LS"));
    const top = keys.filter((k) => !["CFBundleTypeName", "CFBundleTypeRole", "LSHandlerRank", "LSItemContentTypes"].includes(k));
    expect(new Set(top).size).toBe(top.length);
  });

  it("starts the bundled lu-minal from Contents/Resources/bin", () => {
    const launcher = read("macos", "Sources", "LuMinal", "Launcher.swift");
    expect(launcher).toContain('appendingPathComponent("bin").appendingPathComponent("lu-minal")');
    expect(launcher).toContain('env["TERM"] = "xterm-256color"');
    expect(launcher).toContain('env["COLORTERM"] = "truecolor"');
    expect(launcher).toContain('"/bin/zsh"');
  });
});

describe("the macOS app's cloud pane", () => {
  const swiftDir = path.join(ROOT, "macos", "Sources", "LuMinal");
  const sources = fs
    .readdirSync(swiftDir)
    .filter((n) => n.endsWith(".swift"))
    .map((n) => read("macos", "Sources", "LuMinal", n))
    .join("\n");

  it("is drawn in the Moon family's colours", () => {
    const swift = read("macos", "Sources", "LuMinal", "MoonPalette.swift");
    const single = (name: string) => new RegExp(`static let ${name} = "(#[0-9a-f]{6})"`).exec(swift)?.[1];
    const moon = builtinTheme("moon")!.colors;
    expect(single("glass")).toBe(MOON_PALETTE.night900);
    expect(single("raised")).toBe(MOON_PALETTE.night800);
    expect(single("hairline")).toBe(moon.border);
    expect(single("lavender")).toBe(MOON_PALETTE.lavender400);
    expect(single("cream")).toBe(MOON_PALETTE.cream100);
    expect(single("muted")).toBe(moon.muted);
    expect(single("faint")).toBe(moon.faint);
    expect(single("mint")).toBe(MOON_PALETTE.mint400);
    expect(single("warning")).toBe(MOON_PALETTE.warning400);
  });

  it("tells lu-minal it runs in the app, beside a web pane", () => {
    const launcher = read("macos", "Sources", "LuMinal", "Launcher.swift");
    expect(launcher).toContain('env["LU_MINAL_APP"] = "1"');
    expect(launcher).toContain('env["LU_MINAL_WEB_PANE"] = "1"');
    expect(launcher).toContain('env["TERM_PROGRAM"] = "lu-minal"');
  });

  it("listens for OSC 7701 and keeps to the shared limits and message", () => {
    const filter = read("macos", "Sources", "LuMinal", "PaneSequenceFilter.swift");
    expect(filter).toContain("static let introducer: [UInt8] = [0x1b, 0x5d, 0x37, 0x37, 0x30, 0x31]");
    expect(filter).toContain("static let maxSequenceLength = 4096");
    const policy = read("macos", "Sources", "LuMinal", "CloudPanePolicy.swift");
    expect(policy).toContain('static let homeURL = URL(string: "https://claude.ai/code")!');
    expect(policy).toContain(`"Google sign-in doesn't work inside lu-minal. Use 'Continue with email' (Claude sends you a code)."`);
    // The filter and the policy are checked by their own Swift tests, which CI runs on macOS.
    expect(read(".github", "workflows", "ci.yml")).toMatch(/\n {2}macos-app:\n[\s\S]*?run: bash macos\/scripts\/test-pane\.sh\n/);
  });

  it("only shows the website: no scripts in the page, nothing read from it, WebKit's own user agent", () => {
    for (const api of [
      "evaluateJavaScript",
      "callAsyncJavaScript",
      "WKUserScript",
      "userContentController",
      "WKScriptMessageHandler",
      "customUserAgent",
      "applicationNameForUserAgent",
      "httpCookieStore",
      "fetchDataRecords",
      "takeSnapshot",
      "createWebArchiveData",
    ]) {
      expect(sources, api).not.toContain(api);
    }
    expect(sources).toContain("WKWebsiteDataStore.default()");
  });

  it("has a popup blocker, so no script opens browser tabs or the pane's page unasked", () => {
    // WebKit on macOS lets scripts open windows without a click by default; every new window
    // goes to createWebViewWith, which loads it in the pane or opens it in the default browser.
    expect(read("macos", "Sources", "LuMinal", "CloudPaneView.swift")).toContain(
      "configuration.preferences.javaScriptCanOpenWindowsAutomatically = false",
    );
  });
});

describe("the Linux desktop entry and icon", () => {
  const entry = read("linux", "lu-minal.desktop");
  const fields = new Map(
    entry
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
  );

  it("is a valid Desktop Entry for a terminal program", () => {
    expect(entry.split("\n")[0]).toBe("[Desktop Entry]");
    for (const line of entry.split("\n").slice(1).filter(Boolean)) expect(line, line).toMatch(/^[A-Za-z][A-Za-z0-9-]*=.+$/);
    expect(fields.get("Type")).toBe("Application");
    expect(fields.get("Name")).toBe("lu-minal");
    expect(fields.get("Exec")).toBe("lu-minal");
    expect(fields.get("Terminal")).toBe("true");
    expect(fields.get("Icon")).toBe("lu-minal");
    expect(fields.get("Categories")).toMatch(/^Development;(.+;)?$/);
    expect(fields.get("Keywords")?.endsWith(";")).toBe(true);
    expect(entry.split("\n").filter((l) => l.startsWith("Exec=")).length).toBe(1);
  });

  it("is the same entry install.sh writes", () => {
    expect(heredoc(read("install.sh"), "DESKTOP")).toBe(entry);
  });

  it("has the same icon install.sh writes, in Moon colours", () => {
    const svg = read("linux", "lu-minal.svg");
    expect(heredoc(read("install.sh"), "ICON")).toBe(svg);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256"/);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    for (const colour of ["#0b0920", "#1d1742", "#3a2a80", "#b9aefb", "#f4f1ff", "#7fe3c6", "#e0c880"]) expect(svg).toContain(colour);
  });

  it("draws the same stars, sparkle and sky as the macOS icon", () => {
    const svg = read("linux", "lu-minal.svg");
    const swift = read("macos", "scripts", "make-icon.swift");
    const stars = [...svg.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)" fill="#([0-9a-f]{6})"\/>/g)];
    expect(stars.length).toBe(4);
    for (const [, x, y, r, hex] of stars) expect(swift).toContain(`(${x}, ${y}, ${r}, 0x${hex}),`);
    // The sparkle's quadratic curves: "Q cx cy x y" in the SVG, addQuadCurve(to:control:) in Swift.
    const sparkle = /<path d="M(\d+) (\d+)((?:Q\d+ \d+ \d+ \d+)+)Z" fill="url\(#sparkle\)"\/>/.exec(svg);
    expect(sparkle).not.toBeNull();
    const curves = [...sparkle![3].matchAll(/Q(\d+) (\d+) (\d+) (\d+)/g)];
    expect(curves.length).toBe(4);
    expect(swift).toContain(`sparkle.move(to: CGPoint(x: ${sparkle![1]}, y: ${sparkle![2]}))`);
    for (const [, cx, cy, x, y] of curves) expect(swift).toContain(`addQuadCurve(to: CGPoint(x: ${x}, y: ${y}), control: CGPoint(x: ${cx}, y: ${cy}))`);
    // The sky's gradient stops.
    const sky = /<linearGradient id="sky"[^>]*>([\s\S]*?)<\/linearGradient>/.exec(svg);
    const stops = [...sky![1].matchAll(/offset="([.\d]+)" stop-color="#([0-9a-f]{6})"/g)].map(([, at, hex]) => `(${Number(at)}, 0x${hex}, 1)`);
    expect(stops.length).toBe(3);
    expect(swift).toContain(`gradient([${stops.join(", ")}])`);
  });
});

describe("the installers", () => {
  it("install.sh asks for the release asset names", () => {
    const sh = read("install.sh");
    expect(sh).toContain('asset="lu-minal-$os-$arch$libc"');
    expect(sh).toContain('libc="-musl"');
    expect(sh).toContain("releases/latest/download");
    expect(sh).toContain("SHA256SUMS");
    const unixAssets = RELEASE_TARGETS.filter((t) => t.os !== "windows").map((t) => t.asset);
    for (const os of ["linux", "macos"]) for (const arch of ["x64", "arm64"]) expect(unixAssets).toContain(`lu-minal-${os}-${arch}`);
  });

  it("install.sh sticks to POSIX sh", () => {
    const sh = read("install.sh");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    // No [[ ]], function keyword, local, ${x//y/z}, here-strings or source (bash / zsh only).
    expect(sh).not.toMatch(/\[\[|^\s*function\s|^\s*local\s|\$\{[^}]*\/\/|<<<|^\s*source\s/m);
  });

  it("install.ps1 asks for the Windows asset names and installs per user", () => {
    const ps = read("install.ps1");
    expect(ps).toContain('$asset = "lu-minal-windows-$arch.exe"');
    for (const arch of ["x64", "arm64"]) expect(RELEASE_TARGETS.map((t) => t.asset)).toContain(`lu-minal-windows-${arch}.exe`);
    expect(ps).toContain("Programs\\lu-minal");
    expect(ps).toContain("Get-FileHash");
    expect(ps).toContain("setup windows-terminal");
  });

  it("install.ps1 is safe for `irm | iex` and Windows PowerShell 5.1", () => {
    const ps = read("install.ps1");
    // Plain ASCII: Windows PowerShell reads BOM-less scripts in the ANSI code page.
    expect([...ps].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    // `exit` would close the user's window when the script runs through iex.
    expect(ps).not.toMatch(/^\s*exit\b/m);
    // PowerShell 7-only syntax.
    expect(ps).not.toMatch(/\?\?|\?\.|&&|\|\|/);
    expect(ps.trimEnd().endsWith("Install-LuMinal")).toBe(true);
  });
});

describe("the Windows installer (Inno Setup)", () => {
  const iss = read("windows", "lu-minal.iss");
  const release = read(".github", "workflows", "release.yml");
  const ci = read(".github", "workflows", "ci.yml");

  it("installs for the current user, without administrator rights, where install.ps1 does", () => {
    expect(iss).toMatch(/^PrivilegesRequired=lowest$/m);
    expect(iss).not.toMatch(/PrivilegesRequiredOverridesAllowed/);
    expect(iss).toMatch(/^DefaultDirName=\{localappdata\}\\Programs\\lu-minal$/m);
    expect(read("install.ps1")).toContain("Join-Path $local 'Programs\\lu-minal'");
    // One app id for every version and both architectures: Settings > Apps updates in place.
    expect(iss).toMatch(/^AppId=\{\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/m);
  });

  it("puts lu-minal on the PATH, in Start and Windows Terminal, and takes it all away again", () => {
    for (const task of ["path", "terminal", "desktopicon"]) expect(iss).toMatch(new RegExp(`^Name: "${task}"; Description:`, "m"));
    expect(iss).toContain('Parameters: "setup windows-terminal"; Flags: runhidden waituntilterminated; Tasks: terminal');
    // The profile goes on every uninstall: install.ps1 or `lu-minal setup windows-terminal` may have added it.
    expect(iss).toContain('Parameters: "setup windows-terminal --remove"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId:');
    expect(iss).not.toMatch(/^\[UninstallRun\][^[]*Tasks:/m);
    expect(iss).toMatch(/CurStepChanged[\s\S]*AddToPath\(ExpandConstant\('\{app\}'\)\)/);
    // Off the PATH before the uninstaller tells Explorer, and only an entry this setup added (or the default folder's).
    expect(iss).toMatch(/if CurUninstallStep = usUninstall then[\s\S]*if OwnsPathEntry\(ExpandConstant\('\{app\}'\)\) then RemoveFromPath\(ExpandConstant\('\{app\}'\)\)/);
    expect(iss).toContain("RegWriteStringValue(HKCU, StateKey, 'AddedToPath', Dir)");
    expect(iss).not.toContain("usPostUninstall");
    // Expandable, so the user's %VARIABLE% entries keep working.
    expect(iss).toContain("RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path'");
    expect(iss).toMatch(/^ChangesEnvironment=yes$/m);
    expect(iss).toMatch(/^Name: "\{autoprograms\}\\lu-minal"/m);
    // Through Windows Terminal with the command line too: an open one hasn't loaded the new profile.
    expect(iss).toContain(`Result := '-p "lu-minal" -d "' + ExpandConstant('{%USERPROFILE}') + '" -- "' + ExpandConstant('{app}\\lu-minal.exe') + '"';`);
    expect(iss).not.toContain('Parameters: "-p ""lu-minal"""');
  });

  it("updates over install.ps1's copy and a running lu-minal without stopping it", () => {
    expect(iss).toMatch(/^DirExistsWarning=no$/m);
    expect(iss).toContain("if DirExists(Dir) and not FileExists(AddBackslash(Dir) + 'lu-minal.exe') then");
    expect(iss).toMatch(/^CloseApplications=no$/m);
    expect(iss).toContain("BeforeInstall: MoveRunningExeAside");
    expect(iss).toMatch(/\[InstallDelete\]\n[^[]*Name: "\{app\}\\lu-minal\.old\*\.exe"/);
    // The folder goes when it is empty, also when install.ps1 made it.
    expect(iss).toContain('Name: "{app}"; Flags: uninsalwaysuninstall');
    // The x64 setup points Windows on Arm to the native one.
    expect(iss).toMatch(/#if Arch == "x64"\n\{[^}]*\}\nfunction InitializeSetup: Boolean;[\s\S]*IsArm64/);
  });

  it("is built for x64 and arm64 from the release binaries, with the moon icon", () => {
    expect(iss).toContain('Source: "{#DistDir}\\lu-minal-windows-{#Arch}.exe"; DestDir: "{app}"; DestName: "lu-minal.exe"');
    expect(iss).toMatch(/^OutputBaseFilename=lu-minal-windows-\{#Arch\}-setup$/m);
    expect(iss).toMatch(/^SetupIconFile=\{#DistDir\}\\lu-minal.ico$/m);
    // Also next to the exe, for the Windows Terminal profile's icon.
    expect(iss).toContain('Source: "{#DistDir}\\lu-minal.ico"; DestDir: "{app}"; Flags: ignoreversion');
    // Pre-release parts and build metadata are cut for the numeric file version.
    expect(iss).toContain('#define NumericVersion Copy(VersionCore, 1, Pos("+", VersionCore + "+") - 1) + ".0"');
    expect(read("scripts", "build-binaries.ts")).toContain('icon: writeIco(path.join(opts.outdir, "lu-minal.ico"))');
    expect(release).toContain("foreach ($arch in 'x64', 'arm64')");
    expect(release).toContain('& $env:ISCC /Q "/DAppVersion=$env:VERSION" "/DArch=$arch" windows\\lu-minal.iss');
    const check = /for f in ([\s\S]*?); do/.exec(release)?.[1].replace(/\\\n/g, " ") ?? "";
    for (const arch of ["x64", "arm64"]) expect(check.split(/\s+/)).toContain(`lu-minal-windows-${arch}-setup.exe`);
  });

  it("keeps every Pascal Script comment closed where it looks closed", () => {
    // { ... } comments don't nest: a {app} inside one ends it early and ISCC stops on the rest.
    const code = iss.slice(iss.indexOf("\n[Code]\n"));
    const nested: string[] = [];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === "'") i = code.indexOf("'", i + 1);
      else if (code.startsWith("//", i)) i = code.indexOf("\n", i);
      else if (code[i] === "{") {
        const end = code.indexOf("}", i);
        if (code.slice(i + 1, end).includes("{")) nested.push(code.slice(i, end + 1));
        i = end;
      }
      if (i < 0) break;
    }
    expect(nested).toEqual([]);
  });

  it("is installed, checked and uninstalled on a real Windows machine in CI", () => {
    expect(ci).toContain("'/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=\"path,terminal\"'");
    expect(ci).toContain("(Join-Path $dir 'unins000.exe')");
    for (const left of [
      "lu-minal.exe behind",
      "lu-minal-window.exe behind",
      "moved-aside copies behind",
      "on the user PATH",
      "Windows Terminal profile behind",
      "Start menu shortcut behind",
      "second Start menu entry behind",
      "Settings > Apps entry is still there",
    ]) {
      expect(ci).toContain(left);
    }
  });

  it("installs the window app, which the Start menu, the desktop and 'Start lu-minal' open", () => {
    expect(iss).toMatch(/^#ifndef WindowDir\n {2}#define WindowDir "\.\.\\dist-window"\n#endif$/m);
    expect(iss).toContain('Source: "{#WindowDir}\\lu-minal-window-{#Arch}.exe"; DestDir: "{app}"; DestName: "lu-minal-window.exe"; Flags: ignoreversion; BeforeInstall: MoveRunningWindowAside');
    const icons = iss.slice(iss.indexOf("\n[Icons]\n"), iss.indexOf("\n[Run]\n"));
    expect(icons).toContain('Name: "{autoprograms}\\lu-minal"; Filename: "{app}\\lu-minal-window.exe"; WorkingDir: "{%USERPROFILE}"');
    expect(icons).toMatch(/^Name: "\{autodesktop\}\\lu-minal"; Filename: "\{app\}\\lu-minal-window\.exe";.*Tasks: desktopicon$/m);
    // The way it opened before, as a second entry.
    expect(icons).toContain('Name: "{autoprograms}\\lu-minal in Windows Terminal"; Filename: "{code:TerminalExe}"; Parameters: "{code:TerminalArgs}"');
    expect(icons).toMatch(/^Name: "\{autoprograms\}\\lu-minal in Windows Terminal";.*Check: UseTerminal$/m);
    expect(icons).toMatch(/^Name: "\{autoprograms\}\\lu-minal in the console"; Filename: "\{app\}\\lu-minal\.exe";.*Check: not UseTerminal$/m);
    // Only the window app's entries are called just "lu-minal".
    for (const line of icons.split("\n").filter((l) => /^Name: "\{auto(programs|desktop)\}\\lu-minal";/.test(l))) {
      expect(line, line).toContain('Filename: "{app}\\lu-minal-window.exe"');
    }
    const run = iss.slice(iss.indexOf("\n[Run]\n"), iss.indexOf("\n[UninstallRun]\n"));
    const postinstall = run.split("\n").filter((l) => l.includes("postinstall"));
    expect(postinstall).toEqual(['Filename: "{app}\\lu-minal-window.exe"; WorkingDir: "{%USERPROFILE}"; Description: "Start lu-minal"; Flags: postinstall nowait skipifsilent']);
    expect(iss).toMatch(/^UninstallDisplayIcon=\{app\}\\lu-minal-window\.exe$/m);
  });

  it("moves a running window app aside on an update and cleans up its old copies", () => {
    expect(iss).toMatch(/\[InstallDelete\]\n[^[]*Name: "\{app\}\\lu-minal-window\.old\*\.exe"/);
    expect(iss).toMatch(/\[UninstallDelete\]\n[^[]*Name: "\{app\}\\lu-minal-window\.old\*\.exe"/);
    expect(iss).toMatch(/procedure MoveRunningWindowAside;\nbegin\n {2}MoveAside\('lu-minal-window'\);\nend;/);
    expect(iss).toMatch(/procedure MoveRunningExeAside;\nbegin\n {2}MoveAside\('lu-minal'\);\nend;/);
    expect(iss).toContain("RenameFile(Exe, ExpandConstant('{app}\\') + Name + '.old-' + GetDateTimeString('yyyymmddhhnnsszzz', #0, #0) + '.exe')");
    // lu-minal's own start-up cleanup takes the window app's copies too (src/platform/update.ts).
    expect(read("src", "platform", "update.ts")).toContain("const OLD_COPY = /^lu-minal(?:-window)?\\.old.*\\.exe$/i;");
    // CI updates over a running window and checks that it was moved aside.
    expect(ci).toContain("Get-ChildItem -LiteralPath $dir -Filter 'lu-minal-window.old*.exe'");
  });
});

describe("the Windows window app (windows-app/)", () => {
  const ci = read(".github", "workflows", "ci.yml");
  const release = read(".github", "workflows", "release.yml");
  const cargo = read("windows-app", "Cargo.toml");
  const js = read("windows-app", "web", "terminal.js");
  const env = read("windows-app", "src", "env.rs");
  const web = read("windows-app", "src", "app", "web.rs");
  const build = read("windows-app", "build.rs");

  it("draws the terminal in the Moon palette", () => {
    const theme = /export const MOON_THEME = \{([\s\S]*?)\};/.exec(js)?.[1] ?? "";
    const value = (key: string) => new RegExp(`\\n {2}${key}: "(#[0-9a-f]{6})",`).exec(theme)?.[1];
    expect(value("background")).toBe(MOON_ANSI.background);
    expect(value("foreground")).toBe(MOON_ANSI.foreground);
    expect(value("cursor")).toBe(MOON_ANSI.cursor);
    expect(value("cursorAccent")).toBe(MOON_ANSI.cursorText);
    expect(value("selectionBackground")).toBe(MOON_ANSI.selection);
    for (const key of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const) {
      expect(value(key), key).toBe(MOON_ANSI[key]);
      const bright = `bright${key[0].toUpperCase()}${key.slice(1)}` as keyof typeof MOON_ANSI;
      expect(value(bright), bright).toBe(MOON_ANSI[bright]);
    }
    expect(js).toContain(`const FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", Consolas, monospace';`);
    expect(js).toContain('term.unicode.activeVersion = "11";');
  });

  it("runs lu-minal with the web pane contract, never as the macOS app", () => {
    expect(env).toContain('("LU_MINAL_WEB_PANE", "1")');
    expect(env).toContain('("TERM_PROGRAM", "lu-minal-window")');
    expect(env).toContain('("TERM", "xterm-256color")');
    expect(env).toContain('("COLORTERM", "truecolor")');
    const set = /pub fn child_env[\s\S]*?\n\}\n/.exec(env)?.[0] ?? "";
    expect(set).toContain("LU_MINAL_WEB_PANE");
    expect(set).not.toContain("LU_MINAL_APP");
    expect(/pub const REMOVED_ENV: &\[&str\] = &\[([\s\S]*?)\];/.exec(env)?.[1]).toContain('"LU_MINAL_APP"');
    // The terminals the macOS app's launcher forgets, this one forgets too.
    const mac = /foreignTerminalVariables = \[([\s\S]*?)\]/.exec(read("macos", "Sources", "LuMinal", "Launcher.swift"))?.[1] ?? "";
    for (const [, name] of mac.matchAll(/"([A-Z_]+)"/g)) expect(env, name).toContain(`"${name}"`);
  });

  it("embeds exactly the assets build.rs checks and the npm script copies, pinned in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies: Record<string, string> };
    for (const name of ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-unicode11", "@xterm/addon-webgl"]) {
      expect(pkg.devDependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.devDependencies["@xterm/xterm"]).toBe("6.0.0");
    const embedded = [...web.matchAll(/asset!\("assets", "([^"]+)"\)/g)].map((m) => m[1]).sort();
    const checked = [...(/const ASSETS: &\[&str\] = &\[([^\]]*)\]/.exec(build)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const copied = [...read("scripts", "windows-app-assets.mjs").matchAll(/\["@xterm\/[^"]+", "[^"]+", "([^"]+)"\]/g)].map((m) => m[1]);
    for (const file of embedded) {
      expect(checked, file).toContain(file);
      expect(copied, file).toContain(file);
    }
    expect(checked).toContain("lu-minal.ico");
    const pages = [...web.matchAll(/asset!\("web", "([^"]+)"\)/g)].map((m) => m[1]).sort();
    expect(pages).toEqual(["app.css", "index.html", "terminal.js"]);
    for (const page of pages) expect(fs.existsSync(path.join(ROOT, "windows-app", "web", page)), page).toBe(true);
    expect(read(".gitignore").split("\n")).toEqual(expect.arrayContaining(["windows-app/assets/", "windows-app/target/", "dist-window/"]));
  });

  it("keeps the page under a strict CSP and gives the cloud pane no IPC and no scripts", () => {
    const csp = /pub const CSP: &str = "([^"]+)";/.exec(web)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(read("windows-app", "web", "index.html"))?.[1] ?? "";
    expect(meta.replace(/; /g, ";").split(";").sort()).toEqual(csp.replace("; frame-ancestors 'none'", "").replace(/; /g, ";").split(";").sort());
    const pane = web.slice(web.indexOf("pub fn build_pane"), web.indexOf("fn hook_keys"));
    expect(pane).not.toMatch(/with_ipc_handler|with_initialization_script|with_user_agent|evaluate_script|cookies/);
    expect(read("windows-app", "src", "app", "mod.rs")).not.toMatch(/cookies|initialization_script/);
  });

  it("pins its crates and commits the lock file", () => {
    const deps = cargo.slice(cargo.indexOf("[dependencies]"), cargo.indexOf("[profile.release]"));
    for (const [, name, version] of deps.matchAll(/^([a-z0-9_-]+) = (?:\{ version = )?"([^"]+)"/gm)) {
      expect(version, name).toMatch(/^=\d+\.\d+\.\d+$/);
    }
    for (const name of ["tao", "wry", "portable-pty", "webview2-com"]) expect(deps).toMatch(new RegExp(`^${name} = `, "m"));
    expect(fs.existsSync(path.join(ROOT, "windows-app", "Cargo.lock"))).toBe(true);
    expect(cargo).toContain('version = "0.0.0"');
    expect(build).toContain('json["version"]');
  });

  it("is built, tested and smoke-tested in CI, and goes into both setups of a release", () => {
    expect(ci).toContain("node scripts/windows-app-assets.mjs");
    expect(ci).toContain("cargo build --manifest-path windows-app/Cargo.toml --locked --release --target x86_64-pc-windows-msvc");
    expect(ci).toContain("cargo test --manifest-path windows-app/Cargo.toml --locked");
    expect(ci).toContain("foreach ($kind in 'smoke', 'smoke-osc')");
    expect(ci).toContain("Copy-Item dist-bin\\lu-minal-windows-x64.exe (Join-Path $dir 'lu-minal.exe')");
    expect(ci).toContain("Swatinem/rust-cache@v2");
    // The ISCC step comes after the app is built.
    expect(ci.indexOf("Build the window app")).toBeLessThan(ci.indexOf("& $env:ISCC"));
    expect(release).toContain("rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc");
    expect(release).toContain("@(@('x64', 'x86_64-pc-windows-msvc'), @('arm64', 'aarch64-pc-windows-msvc'))");
    expect(release).toContain('Copy-Item "windows-app\\target\\$triple\\release\\lu-minal-window.exe" "dist-window\\lu-minal-window-$arch.exe"');
    expect(release.indexOf("The window app (lu-minal-window.exe")).toBeLessThan(release.indexOf("foreach ($arch in 'x64', 'arm64')"));
    // It ships only in the setups: not a release file of its own.
    const check = /for f in ([\s\S]*?); do/.exec(release)?.[1] ?? "";
    expect(check.split(/\s+/).filter((f) => f.startsWith("lu-minal-window-") || f.startsWith("lu-minal-window."))).toEqual([]);
    expect(release).toMatch(/name: release-windows\n {10}path: dist-bin\/lu-minal-\*\n/);
  });
});

describe("the release workflow", () => {
  const release = read(".github", "workflows", "release.yml");
  const ci = read(".github", "workflows", "ci.yml");

  it("builds every release target", () => {
    const specs = [...release.matchAll(/build-binaries\.ts --target=([\w,-]+)/g)].map((m) => m[1]);
    const built = new Set(specs.flatMap((s) => resolveTargets(s).map((t) => t.name)));
    expect([...built].sort()).toEqual(RELEASE_TARGETS.map((t) => t.name).sort());
  });

  it("refuses to publish unless every asset the installers ask for is there", () => {
    const check = /for f in ([\s\S]*?); do/.exec(release)?.[1].replace(/\\\n/g, " ") ?? "";
    const listed = check.split(/\s+/).filter(Boolean);
    for (const t of RELEASE_TARGETS) expect(listed, t.asset).toContain(t.asset);
    expect(listed).toContain("lu-minal-macos-app.zip");
  });

  it("can be started by hand for a version and then tags the commit it built", () => {
    // A tag push, or the Actions tab / API with the version (for sessions that can't push tags).
    expect(release).toMatch(/\non:\n {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:\n {4}inputs:\n {6}version:\n/);
    // The version check reads the tag from either and still compares it with package.json.
    expect(release).toContain("TAG: ${{ github.event_name == 'workflow_dispatch' && format('v{0}', inputs.version) || github.ref_name }}");
    expect(release).toContain('tag="${TAG#v}"');
    expect(release).not.toContain("GITHUB_REF_NAME#v");
    // The release (and with it the tag) points at the commit that was tested and built.
    expect(release).toContain("tag_name: v${{ needs.version.outputs.version }}");
    expect(release).toContain("target_commitish: ${{ github.sha }}");
  });

  it("publishes only after the tagged commit passed the tests on all three systems", () => {
    // ci.yml runs for branches only, so a tag push is tested by the release workflow itself.
    expect(ci).toMatch(/push:\n\s+branches: \["\*\*"\]/);
    expect(release).toMatch(/\n {2}test:\n[\s\S]*?os: \[ubuntu-latest, macos-latest, windows-latest\][\s\S]*?npm test/);
    expect(release).toMatch(/needs: \[version, test, linux, windows, macos\]/);
  });

  it("signs the macOS binaries on macOS and checks the signatures", () => {
    const script = read("scripts", "build-binaries.ts");
    expect(script).toContain('if (t.os === "macos" && process.platform === "darwin") adhocSign(outfile);');
    expect(script).toContain('spawnSync("codesign", ["--force", "--sign", "-", file]');
    for (const workflow of [ci, release]) {
      expect(workflow).toContain("codesign --verify --verbose=2 dist-bin/lu-minal-macos-arm64 dist-bin/lu-minal-macos-x64");
    }
  });

  it("keys the SwiftPM cache by the Swift compiler", () => {
    expect(ci).toContain("id: toolchain");
    expect(ci).toMatch(/key: swiftpm-.*\$\{\{ steps\.toolchain\.outputs\.swift \}\}/);
  });

  it("gives only the publish job a write token, and no checkout keeps one in .git/config", () => {
    // npm ci (install scripts), the tests and the bundlers run in the other jobs.
    expect(release).toMatch(/\npermissions:\n {2}contents: read\n/);
    const jobs = release.slice(release.indexOf("\njobs:\n")).split(/\n(?= {2}[\w-]+:\n)/).slice(1);
    expect(jobs.map((j) => j.trim().split(":")[0])).toEqual(["version", "test", "linux", "windows", "macos", "publish"]);
    for (const job of jobs) {
      const name = job.trim().split(":")[0];
      if (name === "publish") expect(job).toMatch(/\n {4}permissions:\n {6}contents: write\n/);
      else expect(job, name).not.toContain("contents: write");
    }
    const checkouts = release.match(/- uses: actions\/checkout@v4\n.*\n.*\n/g) ?? [];
    expect(checkouts.length).toBe((release.match(/actions\/checkout@/g) ?? []).length);
    for (const c of checkouts) expect(c).toMatch(/- uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false\n/);
    // The one third-party action that gets the write token is pinned to a commit.
    expect(release).toMatch(/softprops\/action-gh-release@[0-9a-f]{40} # v2\.\d+\.\d+\n/);
  });

  it("publishes the binaries, the app and SHA256SUMS with contents: write", () => {
    expect(release).toMatch(/permissions:\n\s+contents: write/);
    expect(release).toContain("softprops/action-gh-release@");
    expect(release).toContain("sha256sum lu-minal-* > SHA256SUMS");
    expect(release).toContain("lu-minal-macos-app.zip");
    expect(release).toContain("lu-minal-macos-app.dmg");
    expect(release).toMatch(/tags: \["v\*"\]/);
  });

  it("CI runs the tests on all three systems and smoke-tests every kind of build", () => {
    expect(ci).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    for (const step of ["npm run typecheck", "npm test", "npm run build", "--target=all", "bundle-app.sh", "lu-minal.exe --version", "install.ps1"]) {
      expect(ci, step).toContain(step);
    }
    expect(ci).toContain("oven-sh/setup-bun@v2");
    expect(ci).not.toMatch(/\t/);
    expect(release).not.toMatch(/\t/);
  });
});

describe("the install instructions", () => {
  /** Every file that tells users how to install lu-minal, plus the sources (hints, help texts). */
  function instructionFiles(): string[] {
    const out = ["README.md", "install.sh", "install.ps1", "linux/install-desktop.sh", "macos/README.md"];
    const walk = (rel: string, keep: (name: string) => boolean) => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r, keep);
        else if (keep(e.name)) out.push(r);
      }
    };
    walk("docs", (n) => n.endsWith(".md"));
    walk("macos/Sources", (n) => n.endsWith(".swift"));
    walk("src", (n) => /\.tsx?$/.test(n));
    return out;
  }

  it("never send anyone to the npm registry, where lu-minal is not published", () => {
    // npm refuses the name (it is "luminal" without the dash, which exists), so v0.1.0 has no npm package.
    for (const file of instructionFiles()) {
      expect(read(file), file).not.toMatch(/npm (i|install) (-g|--global) lu-minal|npx lu-minal/);
    }
  });

  it("offer a build from source instead", () => {
    // One command per line in the section: Windows PowerShell 5.1 has no `&&`.
    expect(read("README.md")).toContain("| **From source** (any OS, Node 22+) | `git clone`, `npm ci`, `npm run build`, `npm link` – see [From source](#from-source) |");
    expect(read("README.md")).not.toMatch(/npm ci && npm run build/);
    expect(read("docs", "install.md")).toContain("npm link");
    for (const file of ["install.sh", "install.ps1", "linux/install-desktop.sh", "macos/Sources/LuMinal/Launcher.swift", "macos/README.md"]) {
      expect(read(file), file).toMatch(/https:\/\/github\.com\/(Luna-OS\/lu-minal|\$REPO)#from-source/);
    }
    // The README's "From source" section the installers point to.
    expect(read("README.md")).toMatch(/\n#+ From source\n/);
  });

  it("build dist/ whenever a package is made (npm pack, npm publish)", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; bin: Record<string, string>; files: string[] };
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.bin["lu-minal"]).toBe("dist/cli.js");
    expect(pkg.files).toContain("dist");
  });
});

describe("the docs", () => {
  it("link only to files that exist", () => {
    const docs = ["README.md", "macos/README.md", "windows-app/README.md", ...fs.readdirSync(path.join(ROOT, "docs")).filter((n) => n.endsWith(".md")).map((n) => `docs/${n}`)];
    for (const doc of docs) {
      for (const [, target] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const file = path.join(ROOT, path.dirname(doc), decodeURIComponent(target.split("#")[0]));
        expect(fs.existsSync(file), `${doc} links to ${target}`).toBe(true);
      }
    }
  });
});

describe("the react-devtools-core stub", () => {
  it("does nothing, the way Ink expects", async () => {
    const stub = (await import(pathToFileURL(path.join(ROOT, "scripts", "stubs", "react-devtools-core.js")).href)) as {
      default: { initialize: () => void; connectToDevTools: (o?: unknown) => void };
    };
    expect(typeof stub.default.initialize).toBe("function");
    expect(typeof stub.default.connectToDevTools).toBe("function");
    expect(() => {
      stub.default.initialize();
      stub.default.connectToDevTools({ host: "localhost" });
    }).not.toThrow();
  });
});
