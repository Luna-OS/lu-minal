// Where lu-minal keeps its files on Windows, macOS and Linux. LU_MINAL_HOME overrides all of them
// (tests and portable installs use it).
import os from "node:os";
import path from "node:path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

function home(): string {
  return process.env.LU_MINAL_HOME_DIR || os.homedir();
}

/** Settings, sign-ins and custom themes. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LU_MINAL_HOME) return path.join(env.LU_MINAL_HOME, "config");
  if (isWindows) return path.join(env.APPDATA || path.join(home(), "AppData", "Roaming"), "lu-minal");
  return path.join(env.XDG_CONFIG_HOME || path.join(home(), ".config"), "lu-minal");
}

/** Downloaded catalogs and other things that can be thrown away. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LU_MINAL_HOME) return path.join(env.LU_MINAL_HOME, "cache");
  if (isWindows) {
    return path.join(env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), "lu-minal", "cache");
  }
  if (isMac) return path.join(home(), "Library", "Caches", "lu-minal");
  return path.join(env.XDG_CACHE_HOME || path.join(home(), ".cache"), "lu-minal");
}

/** Session state (open tabs, logs, per-agent MCP configs). */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LU_MINAL_HOME) return path.join(env.LU_MINAL_HOME, "state");
  if (isWindows) {
    return path.join(env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), "lu-minal", "state");
  }
  if (isMac) return path.join(home(), "Library", "Application Support", "lu-minal");
  return path.join(env.XDG_STATE_HOME || path.join(home(), ".local", "state"), "lu-minal");
}

/** Where repositories opened from GitHub / Forgejo are cloned by default. */
export function defaultProjectsDir(): string {
  return path.join(home(), "lu-minal-projects");
}

/**
 * "~/code/app" for display. On Windows the comparison ignores case and takes "/" as a separator
 * too ("c:/users/ada/code" is inside "C:\Users\Ada"), since both spellings reach the same folder.
 */
export function tildify(p: string, platform: NodeJS.Platform = process.platform): string {
  const h = home();
  if (platform !== "win32") {
    if (p === h) return "~";
    if (p.startsWith(h + path.posix.sep)) return `~${path.posix.sep}${p.slice(h.length + 1)}`;
    return p;
  }
  // Same-length normalisation (separators only), so indexes into `p` stay valid.
  const norm = (s: string) => s.replace(/\//g, "\\");
  const base = h.replace(/[\\/]+$/, "");
  if (!base) return p;
  const head = norm(p.slice(0, base.length));
  if (head.toLowerCase() !== norm(base).toLowerCase()) return p;
  const rest = p.slice(base.length);
  if (rest === "" || /^[\\/]+$/.test(rest)) return "~";
  if (rest[0] !== "\\" && rest[0] !== "/") return p;
  return `~\\${rest.replace(/^[\\/]+/, "")}`;
}

/**
 * Whether two paths name the same folder or file: resolved first, and on Windows without regard to
 * case or a trailing separator ("c:\\Code\\App\\" and "C:\\code\\app" are the same there).
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    const n = (p: string) => path.win32.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    return n(a) === n(b);
  }
  const n = (p: string) => {
    const r = path.posix.resolve(p);
    return r.length > 1 ? r.replace(/\/+$/, "") : r;
  };
  return n(a) === n(b);
}

/**
 * A Windows path for an MSYS / Git Bash style one: "/c/Users/ada/x" and "/cygdrive/c/x" become
 * "C:\\Users\\ada\\x" and "C:\\x". The bash tool runs Git Bash on Windows, whose `pwd` prints such
 * paths, and models hand them on to the file tools. Anything else (and every path on macOS and
 * Linux) comes back unchanged.
 */
export function fromMsysPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return p;
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/^\/+/, "").replace(/\//g, "\\")}`;
}

/** Expands a leading "~" (both separators, so "~/x" works on Windows too). */
export function expandHome(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home(), p.slice(2));
  return p;
}
