// Paths the tools treat with extra care, whatever the permission mode says about plain reads and
// edits. Three kinds:
//
// - Secret stores: lu-minal's own config and state folders (API keys in auth.json, the MCP bearer
//   tokens, session logs) and the usual credential files in the home folder (~/.ssh, ~/.aws,
//   ~/.netrc, browser profiles, ...), plus /proc/<pid>/ on Linux (other processes' environment).
//   Reading one is not "just a read": together with a web fetch it is how a prompt injection
//   exfiltrates keys. Reads there ask first.
// - Protected project files: what git and lu-minal's own agents run on their own, without anyone
//   reviewing a diff (.git anywhere, .claude/, .mcp.json, .gemini/, .opencode/, opencode.json).
//   Edits there always ask, as do edits of the home folder's dotfiles (.bashrc, .zshrc, ...).
// - Windows UNC paths (\\server\share): opening one makes Windows sign in to that server with the
//   user's NTLM credentials, so it counts as reaching out, not as a local read.
//
// Every check works on real paths: symlinks are followed (also a dangling one at the end, which a
// write would follow too), so a link inside the project that points at ~/.bashrc is "outside".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RiskKind } from "../core/types.js";
import { configDir, stateDir } from "../platform/paths.js";

export interface SensitiveOptions {
  /** The home folder (default: LU_MINAL_HOME_DIR or the OS's). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** More secret locations (absolute paths), e.g. for tests. */
  extra?: string[];
}

/** Credential files and folders, relative to the home folder (all platforms). */
const HOME_SECRETS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".gem/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".vault-token",
  ".terraform.d/credentials.tfrc.json",
  ".password-store",
  ".config/gh",
  ".config/hub",
  ".config/gcloud",
  ".config/op",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".mozilla",
  ".local/share/keyrings",
  ".local/share/opencode",
  ".claude.json",
  ".claude/.credentials.json",
  ".gemini/oauth_creds.json",
  ".gemini/google_accounts.json",
  ".codex/auth.json",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
];

const MAC_SECRETS = [
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  // The macOS app's cloud pane: its sign-in to claude.ai (WebKit's data and cookies for the app's
  // bundle id, see macos/README.md).
  "Library/WebKit/os.luna.lu-minal",
  "Library/HTTPStorages/os.luna.lu-minal",
  "Library/HTTPStorages/os.luna.lu-minal.binarycookies",
];

/** Project folders and files that run on their own (git hooks and config, agents' settings). */
const PROTECTED_ANYWHERE = new Set([".git"]);
const PROTECTED_TOP = new Set([".claude", ".mcp.json", ".gemini", ".opencode", "opencode.json", "opencode.jsonc"]);

function homeOf(opts: SensitiveOptions): string {
  const env = opts.env ?? process.env;
  return opts.home ?? (env.LU_MINAL_HOME_DIR || os.homedir());
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Whether the platform's file systems usually ignore case (Windows, macOS). */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * A path in the form comparisons use: case folded where the file system ignores it (by default;
 * `fold` decides where folding would make a check more lenient).
 */
function comparable(p: string, platform: NodeJS.Platform, fold = foldsCase(platform)): string {
  const api = pathApi(platform);
  let out = api.normalize(p);
  if (out.length > 1) out = out.replace(/[\\/]+$/, "");
  if (platform === "win32") out = out.replace(/\//g, "\\");
  return fold ? out.toLowerCase() : out;
}

/** Whether `child` is `parent` or inside it (both comparable). */
function within(parent: string, child: string, platform: NodeJS.Platform): boolean {
  if (child === parent) return true;
  const sep = platform === "win32" ? "\\" : "/";
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/** "\\server\share\x" or "//server/share/x" (not "\\?\C:\..." or "\\.\pipe"): a network path. */
export function isUncPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  const text = String(p ?? "").trim();
  if (platform === "win32") {
    if (/^[\\/]{2}[?.][\\/]/.test(text)) return /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(text);
    return /^[\\/]{2}[^\\/]/.test(text);
  }
  // Git Bash and Cygwin on Windows read "//server/share" as UNC too; elsewhere it is "/".
  return false;
}

/**
 * The real path of `abs`: symlinks resolved as far as the path exists (a dangling link at any
 * point is followed to where it points, as writing through it would), the rest appended.
 */
export function realPath(abs: string, platform: NodeJS.Platform = process.platform): string {
  const api = pathApi(platform);
  if (platform !== process.platform) return api.resolve(abs);
  let current = api.resolve(abs);
  const rest: string[] = [];
  for (let hops = 0; hops < 40; hops++) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? api.join(real, ...rest.slice().reverse()) : real;
    } catch {
      // Missing, or a dangling symlink: follow the link, else go up one level.
    }
    let link: string | null = null;
    try {
      if (fs.lstatSync(current).isSymbolicLink()) link = fs.readlinkSync(current);
    } catch {
      link = null;
    }
    if (link !== null) {
      current = api.resolve(api.dirname(current), link);
      continue;
    }
    const parent = api.dirname(current);
    if (parent === current) break;
    rest.push(api.basename(current));
    current = parent;
  }
  return api.resolve(abs);
}

let cache: { key: string; at: number; locations: string[] } | null = null;
const CACHE_MS = 5_000;

/** Every secret location for these options, as comparable real paths (and their plain spelling). */
export function secretLocations(opts: SensitiveOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = homeOf(opts);
  const key = JSON.stringify([home, platform, env.LU_MINAL_HOME ?? "", env.APPDATA ?? "", env.LOCALAPPDATA ?? "", env.XDG_CONFIG_HOME ?? "", env.XDG_STATE_HOME ?? "", opts.extra ?? []]);
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.locations;

  const api = pathApi(platform);
  const raw: string[] = [];
  // lu-minal's own: keys (auth.json), settings (provider headers), MCP tokens, session logs.
  if (platform === process.platform) {
    raw.push(configDir(env), stateDir(env));
  }
  for (const rel of HOME_SECRETS) raw.push(api.join(home, ...rel.split("/")));
  if (platform === "darwin") for (const rel of MAC_SECRETS) raw.push(api.join(home, ...rel.split("/")));
  if (platform === "win32") {
    const appData = env.APPDATA || api.join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || api.join(home, "AppData", "Local");
    raw.push(
      api.join(appData, "Microsoft", "Credentials"),
      api.join(appData, "Microsoft", "Protect"),
      api.join(local, "Microsoft", "Credentials"),
      api.join(appData, "GitHub CLI"),
      api.join(appData, "Mozilla", "Firefox"),
      api.join(local, "Google", "Chrome", "User Data"),
      api.join(local, "Microsoft", "Edge", "User Data"),
      api.join(local, "BraveSoftware"),
      // The Windows window app's cloud pane: its sign-in to claude.ai (cookies, storage).
      // windows-app/src/app/win.rs (data_dir) and src/app/mod.rs keep it here.
      api.join(local, "lu-minal", "WebView2"),
    );
  }
  raw.push(...(opts.extra ?? []));
  const out = new Set<string>();
  for (const p of raw) {
    out.add(comparable(api.resolve(p), platform));
    out.add(comparable(realPath(p, platform), platform));
  }
  const locations = [...out];
  cache = { key, at: now, locations };
  return locations;
}

/** /proc/self/..., /proc/1234/...: another process's environment, memory, command line. */
function isProcPath(p: string, platform: NodeJS.Platform): boolean {
  return platform === "linux" && /^\/proc\/(?:self|thread-self|\d+)(?:\/|$)/.test(p);
}

/** Whether `abs` is a secret store or inside one (symlinks followed). */
export function isSecretPath(abs: string, opts: SensitiveOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const api = pathApi(platform);
  const plain = api.resolve(abs);
  if (isProcPath(plain, platform)) return true;
  const real = realPath(plain, platform);
  if (isProcPath(real, platform)) return true;
  const candidates = [comparable(plain, platform), comparable(real, platform)];
  return secretLocations(opts).some((loc) => candidates.some((c) => within(loc, c, platform)));
}

/** Whether a folder search from `abs` would reach a secret store (it is one, or holds one). */
export function containsSecrets(abs: string, opts: SensitiveOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const api = pathApi(platform);
  const plain = api.resolve(abs);
  if (isSecretPath(plain, opts)) return true;
  if (platform === "linux" && (plain === "/" || plain === "/proc")) return true;
  const candidates = [comparable(plain, platform), comparable(realPath(plain, platform), platform)];
  return secretLocations(opts).some((loc) => candidates.some((c) => within(c, loc, platform)));
}

/**
 * A path segment as the file system resolves it: Windows and macOS ignore case (".GIT" is ".git"),
 * and Windows also drops trailing dots and spaces, reads "name::$DATA" as the file itself and may
 * know a folder by its 8.3 short name ("GIT~1").
 */
export function canonicalSegment(segment: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return segment.toLowerCase();
  if (platform !== "win32") return segment;
  const name = segment.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase();
  const short = /^(git|claude|gemini|opencode|mcp)~\d+(\..*)?$/.exec(name);
  if (!short) return name;
  if (short[1] === "mcp") return ".mcp.json";
  return `.${short[1]}`;
}

/**
 * Whether `abs` is `cwd` or inside it, after following symlinks on both. Case counts except on
 * Windows, as in protectedProjectPath: a case-sensitive macOS volume can hold /Proj next to
 * /proj, and on the default one the real paths already have the case on disk.
 */
export function isRealInside(cwd: string, abs: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApi(platform);
  if (foreignShare(abs, cwd, platform)) return false;
  const fold = platform === "win32";
  const root = comparable(realPath(cwd, platform), platform, fold);
  const target = comparable(realPath(api.resolve(cwd, abs), platform), platform, fold);
  return within(root, target, platform);
}

/**
 * Why an edit of `abs` inside the project must ask: ".git" (git runs hooks and config from it),
 * ".claude" / ".mcp.json" / ".gemini" / ".opencode" / "opencode.json" (agents' settings, hooks and
 * MCP servers), or null for an ordinary file. Checked on the real path relative to the real
 * project folder.
 */
export function protectedProjectPath(cwd: string, abs: string, platform: NodeJS.Platform = process.platform): string | null {
  const api = pathApi(platform);
  const candidates = [api.relative(api.resolve(cwd), api.resolve(cwd, abs))];
  if (platform === process.platform) candidates.push(api.relative(realPath(cwd, platform), realPath(api.resolve(cwd, abs), platform)));
  for (const rel of candidates) {
    if (!rel || rel === ".." || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel)) continue;
    const segments = rel.split(/[\\/]+/).filter(Boolean).map((s) => canonicalSegment(s, platform));
    const hit = segments.find((s) => PROTECTED_ANYWHERE.has(s));
    if (hit) return hit;
    if (segments[0] && PROTECTED_TOP.has(segments[0])) return segments[0];
  }
  return null;
}

/** A dotfile right in the home folder (.bashrc, .zshrc, .profile, .gitconfig, ...). */
function isHomeDotfile(abs: string, opts: SensitiveOptions): boolean {
  const platform = opts.platform ?? process.platform;
  const api = pathApi(platform);
  const home = comparable(realPath(homeOf(opts), platform), platform);
  const real = realPath(abs, platform);
  return comparable(api.dirname(real), platform) === home && api.basename(real).startsWith(".");
}

export interface WriteAssessment {
  /** "edit" for an ordinary file in the project, "other" (always asks) for the rest. */
  risk: RiskKind;
  /** The real target is outside the project (or on a network share). */
  outside: boolean;
  /** Why it asks although it is inside: "secret", "home dotfile", ".git", ".claude", ... */
  reason: string | null;
}

/** Whether `abs` is `cwd` or inside it, by spelling only (no file system access). */
function lexicallyInside(cwd: string, abs: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  return within(comparable(api.resolve(cwd), platform), comparable(api.resolve(cwd, abs), platform), platform);
}

/** A network share that isn't the project's own folder (a project on a share is the user's choice). */
function foreignShare(abs: string, cwd: string | undefined, platform: NodeJS.Platform): boolean {
  return isUncPath(abs, platform) && !(cwd && lexicallyInside(cwd, abs, platform));
}

/** What writing `abs` risks for a project in `cwd` (symlinks followed). */
export function assessWrite(cwd: string, abs: string, opts: SensitiveOptions = {}): WriteAssessment {
  const platform = opts.platform ?? process.platform;
  if (foreignShare(abs, cwd, platform)) return { risk: "other", outside: true, reason: "network path" };
  const inside = isRealInside(cwd, abs, platform);
  if (!inside) return { risk: "other", outside: true, reason: isSecretPath(abs, opts) ? "secret" : null };
  if (isSecretPath(abs, opts)) return { risk: "other", outside: false, reason: "secret" };
  if (isHomeDotfile(abs, opts)) return { risk: "other", outside: false, reason: "home dotfile" };
  const prot = protectedProjectPath(cwd, abs, platform);
  if (prot) return { risk: "other", outside: false, reason: prot };
  return { risk: "edit", outside: false, reason: null };
}

/**
 * What reading `abs` risks: "other" (asks first) for a secret store, a network share other than
 * the project's own folder (`cwd`), or, with `recursive`, a folder whose search would reach a
 * secret store; "read" otherwise.
 */
export function assessRead(abs: string, opts: SensitiveOptions & { recursive?: boolean; cwd?: string } = {}): RiskKind {
  const platform = opts.platform ?? process.platform;
  if (foreignShare(abs, opts.cwd, platform)) return "other";
  if (opts.recursive ? containsSecrets(abs, opts) : isSecretPath(abs, opts)) return "other";
  return "read";
}

/** The note an approval shows for a write that asks although it is in the project. */
export function writeNote(a: WriteAssessment): string {
  if (a.outside) return a.reason === "network path" ? " (a network share)" : " (outside the project)";
  if (!a.reason) return "";
  if (a.reason === "secret") return " (a credentials file)";
  if (a.reason === "home dotfile") return " (a shell or tool startup file)";
  if (a.reason === ".git") return " (inside .git: git runs hooks and config from there)";
  return ` (${a.reason}: agent settings that can run commands)`;
}
