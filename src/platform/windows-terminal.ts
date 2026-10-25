// Windows Terminal integration: the "Moon Dark" colour scheme and a lu-minal profile, installed as
// a JSON fragment (https://learn.microsoft.com/windows/terminal/json-fragment-extensions) so it
// never touches the user's settings.json. MOON_ANSI is the Moon terminal palette (Moon Code's
// TerminalView) and the single source of truth for every terminal lu-minal configures: Windows
// Terminal here, the macOS app (macos/Sources/LuMinal/MoonPalette.swift) mirrors it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The Moon terminal palette: the 16 ANSI colours plus background, text, cursor and selection. */
export const MOON_ANSI = {
  /** night-950, the sky. */
  background: "#0b0920",
  foreground: "#e9e4f7",
  /** Moonlight gold. */
  cursor: "#e0c880",
  /** Text under a block cursor. */
  cursorText: "#0b0920",
  /** lavender-400 at a third over night-950 (Moon Code uses #b9aefb55; terminals want it opaque). */
  selection: "#454069",
  black: "#1d1742",
  red: "#f28b92",
  green: "#7fe3c6",
  yellow: "#f3c766",
  blue: "#9ad7f5",
  magenta: "#b9aefb",
  cyan: "#8ee6e0",
  white: "#e9e4f7",
  brightBlack: "#5d5789",
  brightRed: "#ffa3a9",
  brightGreen: "#a3f0da",
  brightYellow: "#f8d98f",
  brightBlue: "#bfe6fa",
  brightMagenta: "#d6cffd",
  brightCyan: "#b5f2ee",
  brightWhite: "#ffffff",
} as const;

/** The 16 ANSI colour names in palette order (index 0 = black ... 15 = bright white). */
export const MOON_ANSI_ORDER = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof typeof MOON_ANSI)[];

/** The 16 ANSI colours as a list, in palette order. */
export function moonAnsiPalette(): string[] {
  return MOON_ANSI_ORDER.map((k) => MOON_ANSI[k]);
}

/** A Windows Terminal colour scheme ("purple" is Windows Terminal's word for magenta). */
export interface WindowsTerminalScheme {
  name: string;
  background: string;
  foreground: string;
  cursorColor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
}

/** The scheme's name in Windows Terminal. */
export const MOON_SCHEME_NAME = "Moon Dark";

/** The Moon palette as a Windows Terminal colour scheme. */
export const MOON_SCHEME: WindowsTerminalScheme = {
  name: MOON_SCHEME_NAME,
  background: MOON_ANSI.background,
  foreground: MOON_ANSI.foreground,
  cursorColor: MOON_ANSI.cursor,
  selectionBackground: MOON_ANSI.selection,
  black: MOON_ANSI.black,
  red: MOON_ANSI.red,
  green: MOON_ANSI.green,
  yellow: MOON_ANSI.yellow,
  blue: MOON_ANSI.blue,
  purple: MOON_ANSI.magenta,
  cyan: MOON_ANSI.cyan,
  white: MOON_ANSI.white,
  brightBlack: MOON_ANSI.brightBlack,
  brightRed: MOON_ANSI.brightRed,
  brightGreen: MOON_ANSI.brightGreen,
  brightYellow: MOON_ANSI.brightYellow,
  brightBlue: MOON_ANSI.brightBlue,
  brightPurple: MOON_ANSI.brightMagenta,
  brightCyan: MOON_ANSI.brightCyan,
  brightWhite: MOON_ANSI.brightWhite,
};

/** The profile's name, and the fragment folder's name (Windows Terminal calls it the app name). */
export const WINDOWS_TERMINAL_APP_NAME = "lu-minal";

/** Windows Terminal's namespace for fragment profile GUIDs. */
const FRAGMENT_NAMESPACE = "f65ddb7e-706b-4499-8a50-40313caf510a";

/** A name-based (version 5, SHA-1) UUID. */
export function uuidV5(name: Buffer | string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/[{}-]/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`Not a UUID: ${namespace}`);
  const bytes = createHash("sha1")
    .update(ns)
    .update(typeof name === "string" ? Buffer.from(name, "utf8") : name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The profile's GUID, computed the way Windows Terminal derives fragment profile GUIDs (UUIDv5 of
 * the UTF-16LE app name in the fragment namespace, then of the UTF-16LE profile name in that), so
 * it never changes between versions and installs. It must stay stable: a new GUID would show up
 * as a second lu-minal profile.
 */
export const WINDOWS_TERMINAL_PROFILE_GUID = `{${uuidV5(
  Buffer.from(WINDOWS_TERMINAL_APP_NAME, "utf16le"),
  uuidV5(Buffer.from(WINDOWS_TERMINAL_APP_NAME, "utf16le"), FRAGMENT_NAMESPACE),
)}}`;

/** A Windows Terminal profile as lu-minal writes it. */
export interface WindowsTerminalProfile {
  guid: string;
  name: string;
  commandline: string;
  startingDirectory: string;
  colorScheme: string;
  icon?: string;
  font: { face: string };
  tabTitle: string;
  hidden: boolean;
}

/** The JSON fragment file's content. */
export interface WindowsTerminalFragment {
  $help: string;
  $schema: string;
  profiles: WindowsTerminalProfile[];
  schemes: WindowsTerminalScheme[];
}

export interface FragmentOptions {
  /** Arguments after the program (e.g. the script path when lu-minal runs on node). */
  args?: string[];
  /** The tab icon: an image path or an emoji. Default: lu-minal.ico / .png next to the program, else the moon emoji. */
  icon?: string;
  /** Default: "%USERPROFILE%" (Windows Terminal expands it). */
  startingDirectory?: string;
}

/** Quotes one argument the way CommandLineToArgvW / the MSVC runtime split it again. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * The profile's command line: the program in double quotes (Windows paths cannot contain `"`, so
 * nothing inside needs escaping), then the arguments quoted for CommandLineToArgvW.
 */
export function windowsTerminalCommandline(exePath: string, args: string[] = []): string {
  return [`"${exePath}"`, ...args.map(quoteWindowsArg)].join(" ");
}

function defaultIcon(exePath: string): string {
  const pathApi = /^[A-Za-z]:[\\/]|\\/.test(exePath) ? path.win32 : path;
  const ext = pathApi.extname(exePath);
  const base = ext ? exePath.slice(0, -ext.length) : exePath;
  for (const candidate of [`${base}.ico`, `${base}.png`, pathApi.join(pathApi.dirname(exePath), "lu-minal.ico")]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return "\u{1F319}";
}

/** The Windows Terminal fragment for a lu-minal program: one profile and the Moon Dark scheme. */
export function windowsTerminalFragment(exePath: string, opts: FragmentOptions = {}): WindowsTerminalFragment {
  return {
    $help: "https://aka.ms/terminal-documentation",
    $schema: "https://aka.ms/terminal-profiles-schema",
    profiles: [
      {
        guid: WINDOWS_TERMINAL_PROFILE_GUID,
        name: WINDOWS_TERMINAL_APP_NAME,
        commandline: windowsTerminalCommandline(exePath, opts.args ?? []),
        startingDirectory: opts.startingDirectory ?? "%USERPROFILE%",
        colorScheme: MOON_SCHEME_NAME,
        icon: opts.icon ?? defaultIcon(exePath),
        font: { face: "Cascadia Mono" },
        tabTitle: "lu-minal",
        hidden: false,
      },
    ],
    schemes: [MOON_SCHEME],
  };
}

/**
 * Where Windows Terminal reads lu-minal's fragment from (per user, for both the Store and the
 * unpackaged Windows Terminal): %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\lu-minal.
 */
export function windowsTerminalFragmentDir(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA
    || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Local") : null);
  if (!local) throw new Error("LOCALAPPDATA is not set: cannot find Windows Terminal's fragments folder.");
  return path.win32.join(local, "Microsoft", "Windows Terminal", "Fragments", WINDOWS_TERMINAL_APP_NAME);
}

/** The fragment's file name. */
export const WINDOWS_TERMINAL_FRAGMENT_FILE = "lu-minal.json";

export interface InstallProfileOptions extends FragmentOptions {
  env?: NodeJS.ProcessEnv;
  /** Write here instead of Windows Terminal's fragments folder (tests, portable setups). */
  dir?: string;
  /** Default: process.platform. Without `dir`, installing only works on Windows. */
  platform?: string;
}

function fragmentDir(opts: { env?: NodeJS.ProcessEnv; dir?: string; platform?: string }): string {
  if (opts.dir) return opts.dir;
  if ((opts.platform ?? process.platform) !== "win32") {
    throw new Error("Windows Terminal profiles can only be installed on Windows.");
  }
  return windowsTerminalFragmentDir(opts.env ?? process.env);
}

/**
 * Writes (or replaces) the lu-minal fragment and returns its path. Windows Terminal picks it up the
 * next time it starts: the "lu-minal" profile appears in the new-tab menu with the Moon Dark scheme.
 */
export async function installWindowsTerminalProfile(exePath: string, opts: InstallProfileOptions = {}): Promise<string> {
  const dir = fragmentDir(opts);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, WINDOWS_TERMINAL_FRAGMENT_FILE);
  const json = `${JSON.stringify(windowsTerminalFragment(exePath, opts), null, 2)}\n`;
  // Write next to it and rename, so Windows Terminal never reads half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, json, "utf8");
  await fs.promises.rename(tmp, file);
  return file;
}

/** Removes the lu-minal fragment (and its folder when empty). Resolves false if it was not there. */
export async function removeWindowsTerminalProfile(
  opts: { env?: NodeJS.ProcessEnv; dir?: string; platform?: string } = {},
): Promise<boolean> {
  const dir = fragmentDir(opts);
  const file = path.join(dir, WINDOWS_TERMINAL_FRAGMENT_FILE);
  try {
    await fs.promises.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    await fs.promises.rmdir(dir);
  } catch {
    // not empty, or already gone
  }
  return true;
}
