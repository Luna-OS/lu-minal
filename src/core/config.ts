// lu-minal's settings (config.json in the config dir). Missing or broken files fall back to the
// defaults; unknown keys are kept so newer versions don't lose them.
import fs from "node:fs";
import path from "node:path";
import { configDir, defaultProjectsDir } from "../platform/paths.js";
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
  /** Folders opened recently, newest first. */
  recent: string[];
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
    recent: [],
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
  for (const key of ["sky", "github", "roblox"] as const) {
    out[key] = { ...base[key], ...(isObject(stored[key]) ? stored[key] : {}) } as never;
  }
  if (!Array.isArray(out.forgejo)) out.forgejo = base.forgejo;
  if (!isObject(out.providers)) out.providers = {};
  if (!Array.isArray(out.recent)) out.recent = [];
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

/** Writes the config atomically (temp file + rename). */
export function saveConfig(config: Config, file = configFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Remembers a folder as recently opened (newest first, at most 20). */
export function rememberRecent(config: Config, folder: string): void {
  config.recent = [folder, ...config.recent.filter((f) => f !== folder)].slice(0, 20);
}
