// How lu-minal is distributed and how this copy was installed. The release targets (one standalone
// binary per OS / CPU / C library) are defined here once, so scripts/build-binaries.ts, the release
// workflow, install.sh / install.ps1 and the app itself agree on the asset names. The rest answers
// "what is running right now": a Bun-compiled binary, the macOS app, an npm install or a checkout,
// how to start it again (Windows Terminal profile) and whether the terminal can show true colour.
import os from "node:os";
import path from "node:path";

/** The operating system part of a release asset name ("macos", not "darwin"). */
export type ReleaseOs = "linux" | "macos" | "windows";
/** The CPU part of a release asset name. */
export type ReleaseArch = "x64" | "arm64";

/** One standalone binary lu-minal is released as. */
export interface ReleaseTarget {
  /** The target's name, also the asset's suffix: "linux-x64", "linux-arm64-musl", "windows-x64". */
  name: string;
  os: ReleaseOs;
  arch: ReleaseArch;
  /** Linux only: the C library the binary links against. */
  libc?: "glibc" | "musl";
  /** Bun's `--target` for `bun build --compile`. */
  bunTarget: string;
  /** The file name in the GitHub release: "lu-minal-linux-x64", "lu-minal-windows-x64.exe". */
  asset: string;
}

/** The GitHub repository releases are published to. */
export const RELEASE_REPO = "Luna-OS/lu-minal";

/** Where release assets are downloaded from. */
export const RELEASE_BASE_URL = `https://github.com/${RELEASE_REPO}/releases`;

/** The checksum file every release carries (GNU `sha256sum` format). */
export const CHECKSUMS_FILE = "SHA256SUMS";

function target(name: string, bunTarget: string): ReleaseTarget {
  const [os, arch, libc] = name.split("-") as [ReleaseOs, ReleaseArch, string | undefined];
  return {
    name,
    os,
    arch,
    ...(os === "linux" ? { libc: libc === "musl" ? ("musl" as const) : ("glibc" as const) } : {}),
    bunTarget,
    asset: `lu-minal-${name}${os === "windows" ? ".exe" : ""}`,
  };
}

/**
 * Every binary a release ships. x64 Linux and Windows builds use Bun's "baseline" runtime, which
 * runs on CPUs without AVX2 (older PCs, some VMs and cloud hosts); a TUI does not need the rest.
 */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  target("linux-x64", "bun-linux-x64-baseline"),
  target("linux-arm64", "bun-linux-arm64"),
  target("linux-x64-musl", "bun-linux-x64-musl-baseline"),
  target("linux-arm64-musl", "bun-linux-arm64-musl"),
  target("macos-x64", "bun-darwin-x64"),
  target("macos-arm64", "bun-darwin-arm64"),
  target("windows-x64", "bun-windows-x64-baseline"),
  target("windows-arm64", "bun-windows-arm64"),
];

/** Maps Node's `process.platform` to the release OS name, or null for platforms without a binary. */
export function releaseOs(platform: NodeJS.Platform | string = process.platform): ReleaseOs | null {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return null;
}

/** Maps Node's `process.arch` (or uname's "x86_64" / "aarch64") to the release CPU name. */
export function releaseArch(arch: string = process.arch): ReleaseArch | null {
  const a = arch.toLowerCase();
  if (a === "x64" || a === "x86_64" || a === "amd64") return "x64";
  if (a === "arm64" || a === "aarch64" || a === "armv8" || a === "armv8l") return "arm64";
  return null;
}

/** The release asset's file name for an OS / CPU (and C library on Linux). */
export function releaseAssetName(os: ReleaseOs, arch: ReleaseArch, libc: "glibc" | "musl" = "glibc"): string {
  const musl = os === "linux" && libc === "musl" ? "-musl" : "";
  return `lu-minal-${os}-${arch}${musl}${os === "windows" ? ".exe" : ""}`;
}

/**
 * The download URL of a release asset: the latest release, or a given version ("0.2.0" and
 * "v0.2.0" both work).
 */
export function releaseDownloadUrl(asset: string, version?: string | null): string {
  if (!version || version === "latest") return `${RELEASE_BASE_URL}/latest/download/${asset}`;
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `${RELEASE_BASE_URL}/download/${tag}/${asset}`;
}

/**
 * True on Linux with musl libc (Alpine and friends): Node's report has no glibc version there.
 * Only this machine can be asked, so it is false whenever `platform` is not the running one.
 */
export function isMuslLinux(platform: string = process.platform): boolean {
  if (platform !== "linux" || process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** The release target for a platform (defaults: this machine), or null when there is none. */
export function hostReleaseTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  opts: { musl?: boolean } = {},
): ReleaseTarget | null {
  const o = releaseOs(platform);
  const a = releaseArch(arch);
  if (!o || !a) return null;
  const musl = o === "linux" && (opts.musl ?? isMuslLinux(platform));
  const asset = releaseAssetName(o, a, musl ? "musl" : "glibc");
  return RELEASE_TARGETS.find((t) => t.asset === asset) ?? null;
}

/** Normalises a target name: "darwin-arm64", "bun-darwin-aarch64", "win32-x64" -> "macos-arm64" ... */
function normaliseTargetName(raw: string): string {
  let n = raw.trim().toLowerCase().replace(/^bun-/, "").replace(/\.exe$/, "").replace(/^lu-minal-/, "");
  n = n.replace(/-baseline$/, "").replace(/-modern$/, "");
  const parts = n.split("-");
  const os = parts[0] === "darwin" || parts[0] === "mac" || parts[0] === "osx" ? "macos"
    : parts[0] === "win32" || parts[0] === "win" ? "windows"
    : parts[0];
  const arch = parts[1] ? (releaseArch(parts[1]) ?? parts[1]) : "";
  return [os, arch, ...parts.slice(2)].filter(Boolean).join("-");
}

/**
 * Picks release targets from a spec: undefined / "" / "all" for every target, "host" (or
 * "current") for this machine, or a comma-separated list of names. Names may use Node's or Bun's
 * spelling ("darwin-arm64", "bun-windows-x64", "linux-aarch64"); an OS alone ("linux", "macos",
 * "windows") picks all of its targets. Throws on an unknown name, listing the valid ones.
 */
export function resolveTargets(spec?: string | null, host: { platform?: string; arch?: string } = {}): ReleaseTarget[] {
  const raw = (spec ?? "").trim();
  if (!raw || raw === "all") return [...RELEASE_TARGETS];
  const picked: ReleaseTarget[] = [];
  const add = (t: ReleaseTarget) => {
    if (!picked.includes(t)) picked.push(t);
  };
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (item === "host" || item === "current" || item === "native") {
      const t = hostReleaseTarget(host.platform ?? process.platform, host.arch ?? process.arch);
      if (!t) throw new Error(`No lu-minal binary for this machine (${host.platform ?? process.platform}-${host.arch ?? process.arch}).`);
      add(t);
      continue;
    }
    const name = normaliseTargetName(item);
    const exact = RELEASE_TARGETS.find((t) => t.name === name);
    if (exact) {
      add(exact);
      continue;
    }
    const byOs = RELEASE_TARGETS.filter((t) => t.os === name);
    if (byOs.length) {
      byOs.forEach(add);
      continue;
    }
    throw new Error(
      `Unknown target "${item}". Valid targets: all, host, linux, macos, windows, ${RELEASE_TARGETS.map((t) => t.name).join(", ")}.`,
    );
  }
  return picked;
}

/** A SHA256SUMS file (GNU coreutils format, sorted by file name) for `sha256sum -c` / `shasum -c`. */
export function formatChecksums(entries: Iterable<{ file: string; sha256: string }>): string {
  const rows = [...entries]
    .map((e) => ({ file: path.basename(e.file), sha256: e.sha256.toLowerCase() }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const r of rows) {
    if (!/^[0-9a-f]{64}$/.test(r.sha256)) throw new Error(`Not a SHA-256 hash for ${r.file}: ${r.sha256}`);
  }
  return rows.map((r) => `${r.sha256}  ${r.file}\n`).join("");
}

/**
 * Reads a SHA256SUMS file into file -> hash (lower case). Accepts text ("hash  file") and binary
 * ("hash *file") mode lines, CRLF line endings, blank lines and "#" comments.
 */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

// ---- what is running right now ----------------------------------------------------------------

/** How this copy of lu-minal was installed. */
export type InstallKind = "binary" | "macos-app" | "npm" | "source";

export interface InstallInfo {
  kind: InstallKind;
  /** The program that starts lu-minal: the binary itself, or node / bun for a script install. */
  exe: string;
  /** Arguments that go before lu-minal's own arguments (the script path for npm / source). */
  args: string[];
  /** The release asset this machine uses (for updates), or null when there is no binary for it. */
  asset: string | null;
}

export interface DetectOptions {
  argv?: string[];
  execPath?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
}

/**
 * True when this process is a Bun-compiled standalone binary: Bun runs the bundled entry from its
 * embedded file system, "/$bunfs/root/..." (POSIX) or "B:\~BUN\root\..." (Windows).
 */
export function isCompiledBinary(argv: string[] = process.argv): boolean {
  const entry = argv[1] ?? "";
  return entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry);
}

/** Works out how lu-minal is installed and how to start this same copy again. */
export function detectInstall(opts: DetectOptions = {}): InstallInfo {
  const argv = opts.argv ?? process.argv;
  const execPath = opts.execPath ?? process.execPath;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const t = hostReleaseTarget(platform, opts.arch ?? process.arch);
  const asset = t?.asset ?? null;
  // Paths may come from another OS in tests: accept both separators.
  const norm = (p: string) => p.replace(/\\/g, "/");
  if (isCompiledBinary(argv)) {
    const inApp = env.LU_MINAL_APP === "1" || /\.app\/Contents\/(Resources|MacOS)\//.test(norm(execPath));
    return { kind: inApp ? "macos-app" : "binary", exe: execPath, args: [], asset };
  }
  const script = argv[1] ?? "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const scriptPath = script ? pathApi.resolve(script) : "";
  const execArgv = (opts.execArgv ?? process.execArgv).filter((a) => !a.startsWith("--inspect"));
  const kind: InstallKind = /\/node_modules\/lu-minal\//.test(norm(scriptPath)) ? "npm" : "source";
  return { kind, exe: execPath, args: [...execArgv, ...(scriptPath ? [scriptPath] : [])], asset };
}

/** The program and leading arguments that start this copy of lu-minal (for shortcuts and profiles). */
export function launchCommand(opts: DetectOptions = {}): { exe: string; args: string[] } {
  const info = detectInstall(opts);
  return { exe: info.exe, args: info.args };
}

// ---- the terminal it runs in --------------------------------------------------------------------

/** Terminals lu-minal recognises. */
export type TerminalName =
  | "lu-minal-app"
  | "lu-minal-window"
  | "windows-terminal"
  | "conhost"
  | "vscode"
  | "apple-terminal"
  | "iterm2"
  | "ghostty"
  | "wezterm"
  | "kitty"
  | "alacritty"
  | "unknown";

export interface TerminalInfo {
  name: TerminalName;
  /** Whether 24-bit colour works (the night sky and the Moon palette need it to look right). */
  truecolor: boolean;
  /** A one-line suggestion for a better terminal, or null when this one is fine. */
  hint: string | null;
}

/**
 * Recognises the terminal from the environment. Darwin 25 is macOS 26, the first macOS whose
 * Terminal.app shows true colour; older ones have 256 colours only.
 */
export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  osRelease: string = os.release(),
): TerminalInfo {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const saysTruecolor = colorterm === "truecolor" || colorterm === "24bit";
  const program = env.TERM_PROGRAM ?? "";
  const term = env.TERM ?? "";
  const ok = (name: TerminalName): TerminalInfo => ({ name, truecolor: true, hint: null });
  if (env.LU_MINAL_APP === "1" || program === "lu-minal") return ok("lu-minal-app");
  // The Windows window app (windows-app/): xterm.js with true colour. It never sets LU_MINAL_APP.
  if (program === "lu-minal-window") return ok("lu-minal-window");
  if (program === "vscode") return ok("vscode");
  if (program === "iTerm.app" || env.ITERM_SESSION_ID) return ok("iterm2");
  if (program === "ghostty" || term === "xterm-ghostty") return ok("ghostty");
  if (program === "WezTerm" || env.WEZTERM_EXECUTABLE) return ok("wezterm");
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID) return ok("kitty");
  if (term === "alacritty" || env.ALACRITTY_WINDOW_ID) return ok("alacritty");
  if (env.WT_SESSION) return ok("windows-terminal");
  if (program === "Apple_Terminal") {
    const darwinMajor = Number.parseInt(osRelease.split(".")[0] ?? "0", 10);
    if (saysTruecolor || darwinMajor >= 25) return ok("apple-terminal");
    return {
      name: "apple-terminal",
      truecolor: false,
      hint: "Terminal.app before macOS 26 shows 256 colours only - the lu-minal app, iTerm2, Ghostty or WezTerm show the real Moon colours.",
    };
  }
  if (platform === "win32") {
    // No WT_SESSION and no known TERM_PROGRAM: the classic console host. It draws 24-bit colour
    // since Windows 10 build 14931, but slowly and with poor key support.
    const build = Number.parseInt(osRelease.split(".")[2] ?? "0", 10);
    return {
      name: "conhost",
      truecolor: saysTruecolor || build >= 14931,
      hint: "Windows Terminal is recommended (it has true colour and better keys): run `lu-minal setup windows-terminal` to add a lu-minal profile.",
    };
  }
  return { name: "unknown", truecolor: saysTruecolor, hint: null };
}
