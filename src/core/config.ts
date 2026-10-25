// lu-minal's settings (config.json in the config dir). Missing or broken files fall back to the
// defaults; unknown keys are kept so newer versions don't lose them.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../platform/files.js";
import { configDir, defaultProjectsDir, samePath } from "../platform/paths.js";
import type { ModelRef } from "../providers/models.js";
import type { PermissionMode } from "./types.js";

export interface ForgejoInstance {
  /** "Codeberg", "My Forgejo". */
  name: string;
  /** Web base URL, e.g. "https://codeberg.org". */
  url: string;
}

/** Overrides for a provider: a custom base URL, headers, or a whole custom OpenAI-compatible one. */
export interface ProviderOverride {
  name?: string;
  baseURL?: string;
  wire?: "openai-chat" | "openai-responses" | "anthropic";
  headers?: Record<string, string>;
  /** Extra model ids to offer (for custom providers or models the catalog doesn't list yet). */
  models?: string[];
}

/**
 * A coding-agent CLI that speaks the Agent Client Protocol (ACP), run as a team member
 * (src/agents/acp/). The key under `acpAgents` is its provider id; an entry with a builtin id
 * ("opencode-cli", "gemini-cli") changes that agent's command, arguments or environment.
 */
export interface AcpAgentConfig {
  name?: string;
  /** The program: a name on the PATH or a path ("~/..." works). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Model ids to offer in the picker. */
  models?: string[];
  /** Arguments that pick a model, with "{model}" for the id, e.g. ["--model", "{model}"]. */
  modelArgs?: string[];
  /** How the agent names lu-minal's MCP tools, e.g. "luminal_" (default: the bare tool name). */
  toolPrefix?: string;
  docs?: string;
  /** How to sign in, shown when the agent asks for it. */
  signIn?: string;
}

export interface Config {
  /** The active theme's name. */
  theme: string;
  /** Where repositories from GitHub / Forgejo are cloned. */
  projectsDir: string;
  /** The model a new tab's lead starts on; null picks the best signed-in one. */
  leadModel: ModelRef | null;
  /** The model workers get when nobody names one; null uses the lead's. */
  workerModel: ModelRef | null;
  permissionMode: PermissionMode;
  /** The animated night sky. */
  sky: { enabled: boolean; fps: number };
  axo: boolean;
  github: { owner: string | null };
  forgejo: ForgejoInstance[];
  roblox: { enabled: boolean; port: number };
  /** How often to read the Claude plan's usage, in seconds (0 turns polling off). */
  usagePollSeconds: number;
  /** A configured path to the `claude` program. */
  claudePath: string | null;
  /**
   * Let Claude Code agents use an ANTHROPIC_API_KEY from the environment. Off by default: with it
   * set, `claude -p` bills the API key instead of the Claude subscription.
   */
  claudeUseApiKey: boolean;
  providers: Record<string, ProviderOverride>;
  /** ACP agents (OpenCode, Gemini CLI, custom ones) by provider id. */
  acpAgents: Record<string, AcpAgentConfig>;
  /** Folders opened recently, newest first. */
  recent: string[];
  /** Folders whose own agent settings the user didn't trust (a clone answered "not now", /trust off). */
  untrusted: string[];
  /** Ask GitHub once a day whether a newer lu-minal is out (/update installs it). */
  updates: { check: boolean };
  [key: string]: unknown;
}

export function defaultConfig(): Config {
  return {
    theme: "moon",
    projectsDir: defaultProjectsDir(),
    leadModel: null,
    workerModel: null,
    permissionMode: "auto-edit",
    sky: { enabled: true, fps: 8 },
    axo: true,
    github: { owner: null },
    forgejo: [{ name: "Codeberg", url: "https://codeberg.org" }],
    roblox: { enabled: true, port: 44766 },
    usagePollSeconds: 60,
    claudePath: null,
    claudeUseApiKey: false,
    providers: {},
    acpAgents: {},
    recent: [],
    untrusted: [],
    updates: { check: true },
  };
}

export function configFile(dir = configDir()): string {
  return path.join(dir, "config.json");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Merges a stored config over the defaults, one level deep for the nested groups. */
export function mergeConfig(stored: unknown): Config {
  const base = defaultConfig();
  if (!isObject(stored)) return base;
  const out: Config = { ...base, ...stored } as Config;
  for (const key of ["sky", "github", "roblox", "updates"] as const) {
    out[key] = { ...base[key], ...(isObject(stored[key]) ? stored[key] : {}) } as never;
  }
  if (!Array.isArray(out.forgejo)) out.forgejo = base.forgejo;
  if (!isObject(out.providers)) out.providers = {};
  if (!isObject(out.acpAgents)) out.acpAgents = {};
  if (!Array.isArray(out.recent)) out.recent = [];
  if (!Array.isArray(out.untrusted)) out.untrusted = [];
  if (typeof out.theme !== "string" || !out.theme) out.theme = base.theme;
  return out;
}

export function loadConfig(file = configFile()): Config {
  try {
    return mergeConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return defaultConfig();
  }
}

/** Writes the config atomically (temp file + rename, retried while Windows holds the file). */
export function saveConfig(config: Config, file = configFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Remembers a folder as recently opened (newest first, at most 20). On Windows "c:\code\app"
 * and "C:\Code\App\" are one folder, so a new spelling replaces the old one.
 */
export function rememberRecent(config: Config, folder: string, platform: NodeJS.Platform = process.platform): void {
  config.recent = [folder, ...config.recent.filter((f) => !samePath(f, folder, platform))].slice(0, 20);
}

/**
 * Remembers whether the user trusts a folder's own agent settings, so the answer holds however
 * the folder is opened again (only the "no"s are kept: an unknown folder follows its origin).
 */
export function rememberTrust(config: Config, folder: string, trusted: boolean, platform: NodeJS.Platform = process.platform): void {
  const names = folderNames(folder, platform);
  const rest = config.untrusted.filter((f) => !names.some((n) => samePath(f, n, platform)));
  config.untrusted = trusted ? rest : [names[names.length - 1], ...rest].slice(0, 500);
}

/** Whether the user said no to a folder's own agent settings. */
export function distrusted(config: Config, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  const names = folderNames(folder, platform);
  return config.untrusted.some((f) => names.some((n) => samePath(f, n, platform)));
}

/**
 * The folder as given and as the file system names it (links followed, and on macOS and Windows
 * the case it has on disk), so a folder opened through a link or typed in another case is still
 * the same folder. Only for this machine's own platform: tests that play another one never touch
 * the disk.
 */
function folderNames(folder: string, platform: NodeJS.Platform): string[] {
  if (platform !== process.platform) return [folder];
  try {
    const real = fs.realpathSync.native(folder);
    return real === folder ? [folder] : [folder, real];
  } catch {
    return [folder];
  }
}
