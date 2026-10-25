// Installs the lu-minal Studio plugin: finds Roblox Studio's local Plugins folder on Windows,
// macOS and Linux (Studio runs there through Vinegar / Wine) and writes LuMinal.server.luau into
// it with the configured port baked in. The source comes from src/roblox/plugin-source.ts, so this
// works from the single-file binaries too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../platform/files.js";
import { PLUGIN_SOURCE } from "./plugin-source.js";
import { DEFAULT_ROBLOX_PORT } from "./protocol.js";

/** The plugin's file name in Studio's Plugins folder. */
export const PLUGIN_FILE_NAME = "LuMinal.server.luau";

/** Overrides the Plugins folder on every OS. */
export const PLUGINS_DIR_ENV = "LU_MINAL_ROBLOX_PLUGINS";

/** Vinegar, the way to run Roblox Studio on Linux, as a Flatpak. */
export const VINEGAR_FLATPAK_ID = "org.vinegarhq.Vinegar";

export interface PluginsDirOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The home folder (default: LU_MINAL_HOME_DIR or the OS's). */
  home?: string;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function osUser(): string | null {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

/** The Wine prefixes Vinegar keeps Studio in: the Flatpak's first, then a native install's. */
export function vinegarPrefixes(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const p = path.posix;
  const dataHome = env.XDG_DATA_HOME || p.join(home, ".local", "share");
  return [
    p.join(home, ".var", "app", VINEGAR_FLATPAK_ID, "data", "vinegar", "prefixes", "studio"),
    p.join(dataHome, "vinegar", "prefixes", "studio"),
  ];
}

/**
 * Roblox Studio's local Plugins folder, or null when none is known:
 * - `LU_MINAL_ROBLOX_PLUGINS` wins everywhere;
 * - Windows: `%LOCALAPPDATA%\Roblox\Plugins`;
 * - macOS: `~/Documents/Roblox/Plugins`;
 * - Linux: Studio's folder inside Vinegar's Wine prefix
 *   (`~/.var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users/<user>/AppData/Local/Roblox/Plugins`,
 *   or the same under `$XDG_DATA_HOME/vinegar` for a native Vinegar), when that prefix exists.
 */
export function robloxPluginsDir(opts: PluginsDirOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = opts.home ?? (env.LU_MINAL_HOME_DIR || os.homedir());

  const override = env[PLUGINS_DIR_ENV]?.trim();
  if (override) {
    if (override === "~") return home;
    if (override.startsWith("~/") || override.startsWith("~\\")) return p.join(home, override.slice(2));
    return p.normalize(override);
  }

  if (platform === "win32") {
    return p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), "Roblox", "Plugins");
  }
  if (platform === "darwin") {
    return p.join(home, "Documents", "Roblox", "Plugins");
  }

  // Linux and the BSDs: Roblox has no native Studio; Vinegar runs the Windows one in Wine.
  const candidates = [env.USER, env.LOGNAME, opts.env ? null : osUser()].filter((u): u is string => Boolean(u));
  for (const prefix of vinegarPrefixes(home, env)) {
    const users = p.join(prefix, "drive_c", "users");
    if (!isDir(users)) continue;
    const others = listDirs(users).filter((u) => u.toLowerCase() !== "public");
    const user = candidates.find((u) => isDir(p.join(users, u))) ?? others[0];
    if (user) return p.join(users, user, "AppData", "Local", "Roblox", "Plugins");
  }
  return null;
}

/** Why no Plugins folder was found, and what to do, per OS. */
export function noPluginsDirMessage(platform: NodeJS.Platform = process.platform): string {
  const manual = `or copy roblox/${PLUGIN_FILE_NAME} into Studio's Plugins folder yourself (Studio: Plugins tab > Plugins Folder).`;
  if (platform === "win32" || platform === "darwin") {
    return `No Roblox Studio plugins folder found. Set ${PLUGINS_DIR_ENV} to Studio's Plugins folder, ${manual}`;
  }
  return (
    "No Roblox Studio plugins folder found. On Linux, Roblox Studio runs through Vinegar " +
    `(flatpak install flathub ${VINEGAR_FLATPAK_ID}): install it, start Studio once, then run this again. ` +
    `Or set ${PLUGINS_DIR_ENV} to Studio's Plugins folder, ${manual}`
  );
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The plugin's source with `port` as its default port and, when given, `token` as the secret it
 * sends the bridge (hex, from src/roblox/token.ts).
 */
export function renderPlugin(port: number = DEFAULT_ROBLOX_PORT, token?: string | null): string {
  if (!validPort(port)) throw new Error(`The Roblox bridge port must be a whole number from 1 to 65535 (got ${port}).`);
  const line = /^local DEFAULT_PORT = \d+$/m;
  if (!line.test(PLUGIN_SOURCE)) throw new Error("The bundled Studio plugin has no DEFAULT_PORT line.");
  let source = PLUGIN_SOURCE.replace(line, `local DEFAULT_PORT = ${port}`);
  if (token) {
    // Only hex goes into the Luau string literal, so nothing can break out of it.
    if (!/^[0-9a-f]{32,128}$/.test(token)) throw new Error("The Roblox bridge token must be 32 to 128 hex digits.");
    const tokenLine = /^local BRIDGE_TOKEN = ""$/m;
    if (!tokenLine.test(source)) throw new Error("The bundled Studio plugin has no BRIDGE_TOKEN line.");
    source = source.replace(tokenLine, `local BRIDGE_TOKEN = "${token}"`);
  }
  return source;
}

/** The version of the plugin installed in `dir` (default: Studio's Plugins folder), or null. */
export function installedPluginVersion(opts: { dir?: string } = {}): string | null {
  const dir = opts.dir ?? robloxPluginsDir();
  if (!dir) return null;
  try {
    const text = fs.readFileSync(path.join(dir, PLUGIN_FILE_NAME), "utf8");
    return /^local PLUGIN_VERSION = "([^"]+)"/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Writes the plugin (with `port`, default 44766, as its default port) into `dir` (default: Studio's
 * Plugins folder, created if missing) and returns the file's path. Throws with what to do when no
 * folder is known or it can't be written. Studio loads it at its next start (or "Reload Plugins").
 */
export async function installPlugin(opts: { dir?: string; port?: number; token?: string | null } = {}): Promise<string> {
  const source = renderPlugin(opts.port ?? DEFAULT_ROBLOX_PORT, opts.token);
  const dir = opts.dir ?? robloxPluginsDir();
  if (!dir) throw new Error(noPluginsDirMessage());
  const file = path.join(dir, PLUGIN_FILE_NAME);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    // Studio watches the folder and may hold the old plugin open: on Windows the replace is retried,
    // then written in place. Readable only by the user: it carries the bridge token.
    await writeFileAtomic(file, source, { mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = err instanceof Error ? err.message : String(err);
    const hint =
      (code === "EPERM" || code === "EACCES") && process.platform === "darwin"
        ? " macOS may be blocking access to ~/Documents: allow your terminal under System Settings > Privacy & Security > Files and Folders."
        : "";
    throw new Error(`Could not write the Studio plugin to ${file}: ${reason}.${hint}`);
  }
  return file;
}
