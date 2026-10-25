// The distribution files agree with each other and with the code: the macOS app's palette and the
// Windows Terminal scheme, install.sh's embedded desktop entry and icon and linux/, the macOS
// bundle metadata, the installers' asset names and the release workflow's targets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_TARGETS, resolveTargets } from "../../src/platform/install-info.js";
import { MOON_ANSI, moonAnsiPalette } from "../../src/platform/windows-terminal.js";

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
    for (const colour of ["#0b0920", "#1d1742", "#f4f1ff", "#7fe3c6", "#e0c880"]) expect(svg).toContain(colour);
  });

  it("draws the same stars as the macOS icon", () => {
    const svg = read("linux", "lu-minal.svg");
    const swift = read("macos", "scripts", "make-icon.swift");
    const stars = [...svg.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)" fill="#([0-9a-f]{6})"\/>/g)];
    expect(stars.length).toBe(4);
    for (const [, x, y, r, hex] of stars) expect(swift).toContain(`(${x}, ${y}, ${r}, 0x${hex}),`);
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

  it("publishes the binaries, the app and SHA256SUMS with contents: write", () => {
    expect(release).toMatch(/permissions:\n\s+contents: write/);
    expect(release).toContain("softprops/action-gh-release@v2");
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
