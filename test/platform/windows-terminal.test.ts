// Windows Terminal integration: the Moon Dark scheme, the profile fragment, where it is written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installWindowsTerminalProfile,
  MOON_ANSI,
  MOON_ANSI_ORDER,
  MOON_SCHEME,
  MOON_SCHEME_NAME,
  moonAnsiPalette,
  quoteWindowsArg,
  removeWindowsTerminalProfile,
  uuidV5,
  WINDOWS_TERMINAL_FRAGMENT_FILE,
  WINDOWS_TERMINAL_PROFILE_GUID,
  windowsTerminalCommandline,
  windowsTerminalFragment,
  windowsTerminalFragmentDir,
} from "../../src/platform/windows-terminal.js";

const HEX = /^#[0-9a-f]{6}$/;

/** Splits a command line the way CommandLineToArgvW does (for checking our quoting). */
function commandLineToArgv(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length) break;
    let arg = "";
    let quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (!quoted && (ch === " " || ch === "\t")) break;
      if (ch === "\\") {
        let n = 0;
        while (line[i] === "\\") {
          n++;
          i++;
        }
        if (line[i] === '"') {
          arg += "\\".repeat(Math.floor(n / 2));
          if (n % 2 === 1) arg += '"';
          else quoted = !quoted;
        } else {
          arg += "\\".repeat(n);
          i--;
        }
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      arg += ch;
    }
    args.push(arg);
  }
  return args;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("MOON_ANSI", () => {
  it("is the Moon Code terminal palette on the night-950 sky", () => {
    expect(MOON_ANSI.background).toBe("#0b0920");
    expect(MOON_ANSI.foreground).toBe("#e9e4f7");
    expect(MOON_ANSI.magenta).toBe("#b9aefb"); // lavender-400
    expect(MOON_ANSI.green).toBe("#7fe3c6"); // mint-400
    expect(MOON_ANSI.cursor).toBe("#e0c880"); // moonlight gold
  });

  it("has only lower-case #rrggbb colours", () => {
    for (const [name, value] of Object.entries(MOON_ANSI)) expect(value, name).toMatch(HEX);
  });

  it("lists the 16 ANSI colours in palette order", () => {
    const palette = moonAnsiPalette();
    expect(palette).toHaveLength(16);
    expect(new Set(MOON_ANSI_ORDER).size).toBe(16);
    expect(palette[0]).toBe(MOON_ANSI.black);
    expect(palette[7]).toBe(MOON_ANSI.white);
    expect(palette[8]).toBe(MOON_ANSI.brightBlack);
    expect(palette[15]).toBe("#ffffff");
  });

  it("makes the selection lavender-400 at a third over the night", () => {
    const night = [0x0b, 0x09, 0x20];
    const lavender = [0xb9, 0xae, 0xfb];
    const mixed = night.map((n, i) => Math.round(n + (lavender[i] - n) * (0x55 / 0xff)));
    expect(MOON_ANSI.selection).toBe(`#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
  });

  it("keeps text and the cursor readable on the sky", () => {
    expect(contrast(MOON_ANSI.foreground, MOON_ANSI.background)).toBeGreaterThan(12);
    expect(contrast(MOON_ANSI.cursor, MOON_ANSI.background)).toBeGreaterThan(7);
    for (const name of ["red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const) {
      expect(contrast(MOON_ANSI[name], MOON_ANSI.background), name).toBeGreaterThan(4.5);
    }
  });
});

describe("MOON_SCHEME", () => {
  it("is a complete Windows Terminal scheme called Moon Dark", () => {
    expect(MOON_SCHEME.name).toBe("Moon Dark");
    expect(MOON_SCHEME_NAME).toBe("Moon Dark");
    const keys = [
      "background", "foreground", "cursorColor", "selectionBackground",
      "black", "red", "green", "yellow", "blue", "purple", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite",
    ];
    expect(Object.keys(MOON_SCHEME).sort()).toEqual(["name", ...keys].sort());
    for (const k of keys) expect(MOON_SCHEME[k as keyof typeof MOON_SCHEME], k).toMatch(HEX);
  });

  it("maps magenta to Windows Terminal's purple", () => {
    expect(MOON_SCHEME.purple).toBe(MOON_ANSI.magenta);
    expect(MOON_SCHEME.brightPurple).toBe(MOON_ANSI.brightMagenta);
    expect(MOON_SCHEME.cursorColor).toBe(MOON_ANSI.cursor);
  });
});

describe("uuidV5 and the profile GUID", () => {
  it("matches the RFC 4122 test vector", () => {
    // uuid v5 of "python.org" in the DNS namespace (Python's uuid documentation).
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("is a stable, braced version 5 GUID", () => {
    expect(WINDOWS_TERMINAL_PROFILE_GUID).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/);
    // Changing it would give users a second lu-minal profile: it must never change.
    expect(WINDOWS_TERMINAL_PROFILE_GUID).toBe(`{${uuidV5(
      Buffer.from("lu-minal", "utf16le"),
      uuidV5(Buffer.from("lu-minal", "utf16le"), "f65ddb7e-706b-4499-8a50-40313caf510a"),
    )}}`);
  });

  it("rejects a namespace that is not a UUID", () => {
    expect(() => uuidV5("x", "not-a-uuid")).toThrow(/Not a UUID/);
  });
});

describe("command lines", () => {
  it("quotes arguments the way CommandLineToArgvW reads them back", () => {
    const cases = [
      "plain",
      "with space",
      "",
      'say "hi"',
      "C:\\Program Files\\lu-minal\\",
      "trailing\\",
      'back\\"quote',
      "a\\\\b",
      "tab\there",
      "%USERPROFILE%",
    ];
    for (const arg of cases) {
      const quoted = quoteWindowsArg(arg);
      expect(commandLineToArgv(`x.exe ${quoted}`), JSON.stringify(arg)).toEqual(["x.exe", arg]);
    }
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("")).toBe('""');
  });

  it("puts the program in quotes and quotes the arguments", () => {
    const exe = "C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\lu-minal\\lu-minal.exe";
    expect(windowsTerminalCommandline(exe)).toBe(`"${exe}"`);
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const script = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\lu-minal\\dist\\cli.js";
    const line = windowsTerminalCommandline(node, [script, "--theme", "moon day"]);
    expect(commandLineToArgv(line)).toEqual([node, script, "--theme", "moon day"]);
  });
});

describe("windowsTerminalFragment", () => {
  const exe = "C:\\Users\\Ada\\AppData\\Local\\Programs\\lu-minal\\lu-minal.exe";

  it("has one lu-minal profile using the Moon Dark scheme it brings along", () => {
    const fragment = windowsTerminalFragment(exe);
    expect(fragment.profiles).toHaveLength(1);
    const [profile] = fragment.profiles;
    expect(profile).toMatchObject({
      guid: WINDOWS_TERMINAL_PROFILE_GUID,
      name: "lu-minal",
      commandline: `"${exe}"`,
      colorScheme: "Moon Dark",
      startingDirectory: "%USERPROFILE%",
      font: { face: "Cascadia Mono" },
      hidden: false,
    });
    expect(fragment.schemes).toEqual([MOON_SCHEME]);
    expect(fragment.schemes.map((s) => s.name)).toContain(profile.colorScheme);
  });

  it("is valid JSON that survives a round trip", () => {
    const fragment = windowsTerminalFragment(exe, { args: ["C:\\a b\\cli.js"], startingDirectory: "D:\\code" });
    const parsed = JSON.parse(JSON.stringify(fragment));
    expect(parsed).toEqual(fragment);
    expect(parsed.$schema).toBe("https://aka.ms/terminal-profiles-schema");
    expect(parsed.profiles[0].startingDirectory).toBe("D:\\code");
    expect(commandLineToArgv(parsed.profiles[0].commandline)).toEqual([exe, "C:\\a b\\cli.js"]);
  });

  it("uses an icon next to the program, else the moon", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-wt-icon-"));
    try {
      const program = path.join(dir, "lu-minal.exe");
      fs.writeFileSync(program, "");
      expect(windowsTerminalFragment(program).profiles[0].icon).toBe("\u{1F319}");
      fs.writeFileSync(path.join(dir, "lu-minal.ico"), "");
      expect(windowsTerminalFragment(program).profiles[0].icon).toBe(path.join(dir, "lu-minal.ico"));
      expect(windowsTerminalFragment(program, { icon: "C:\\icons\\moon.png" }).profiles[0].icon).toBe("C:\\icons\\moon.png");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("windowsTerminalFragmentDir", () => {
  it("is under LOCALAPPDATA", () => {
    expect(windowsTerminalFragmentDir({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" })).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\lu-minal",
    );
  });

  it("falls back to USERPROFILE\\AppData\\Local", () => {
    expect(windowsTerminalFragmentDir({ USERPROFILE: "C:\\Users\\Ada" })).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\lu-minal",
    );
  });

  it("fails clearly without either", () => {
    expect(() => windowsTerminalFragmentDir({})).toThrow(/LOCALAPPDATA/);
  });
});

describe("installWindowsTerminalProfile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-wt-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the fragment and returns its path", async () => {
    const target = path.join(dir, "Fragments", "lu-minal");
    const exe = "C:\\Programs\\lu-minal\\lu-minal.exe";
    const file = await installWindowsTerminalProfile(exe, { dir: target });
    expect(file).toBe(path.join(target, WINDOWS_TERMINAL_FRAGMENT_FILE));
    const text = fs.readFileSync(file, "utf8");
    expect(text.charCodeAt(0)).not.toBe(0xfeff); // no BOM
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(windowsTerminalFragment(exe));
    expect(fs.readdirSync(target)).toEqual([WINDOWS_TERMINAL_FRAGMENT_FILE]); // no temp file left
  });

  it("replaces an older fragment", async () => {
    await installWindowsTerminalProfile("C:\\old\\lu-minal.exe", { dir });
    const file = await installWindowsTerminalProfile("C:\\new\\lu-minal.exe", { dir, args: ["--fresh"] });
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json.profiles[0].commandline).toBe('"C:\\new\\lu-minal.exe" --fresh');
  });

  it("finds the fragments folder from the environment on Windows", async () => {
    const file = await installWindowsTerminalProfile("C:\\x\\lu-minal.exe", {
      env: { LOCALAPPDATA: dir },
      platform: "win32",
      ...(process.platform === "win32" ? {} : { dir: path.join(dir, "Microsoft", "Windows Terminal", "Fragments", "lu-minal") }),
    });
    expect(path.basename(path.dirname(file))).toBe("lu-minal");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("refuses to guess a folder on macOS and Linux", async () => {
    await expect(installWindowsTerminalProfile("/usr/local/bin/lu-minal", { platform: "linux" })).rejects.toThrow(/only be installed on Windows/);
  });

  it("removes the fragment again", async () => {
    const target = path.join(dir, "lu-minal");
    await installWindowsTerminalProfile("C:\\x\\lu-minal.exe", { dir: target });
    expect(await removeWindowsTerminalProfile({ dir: target })).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(await removeWindowsTerminalProfile({ dir: target })).toBe(false);
  });
});
