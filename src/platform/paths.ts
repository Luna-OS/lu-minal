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

/** "~/code/app" for display. */
export function tildify(p: string): string {
  const h = home();
  if (p === h) return "~";
  if (p.startsWith(h + path.sep)) return `~${path.sep}${p.slice(h.length + 1)}`;
  return p;
}

/** Expands a leading "~" (both separators, so "~/x" works on Windows too). */
export function expandHome(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home(), p.slice(2));
  return p;
}
