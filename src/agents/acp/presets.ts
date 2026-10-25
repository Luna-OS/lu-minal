// The coding-agent CLIs lu-minal can run over the Agent Client Protocol: OpenCode (`opencode acp`),
// Gemini CLI (`gemini --experimental-acp`) and any ACP command the user adds under `acpAgents` in
// config.json. A preset says how to start the agent, how it names lu-minal's MCP tools, how it
// signs in and how a model is chosen when the protocol can't do it.
import os from "node:os";
import path from "node:path";
import type { AcpAgentConfig, Config } from "../../core/config.js";
import { expandHome } from "../../platform/paths.js";
import { findProgram } from "../../platform/process.js";

/** An auth method as an agent lists it in its initialize answer. */
export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

/** One model of an agent's static model list. */
export interface AcpStaticModel {
  id: string;
  name: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  releaseDate?: string | null;
  /** Takes pictures. */
  vision?: boolean;
}

export interface AcpPreset {
  /** The provider id in lu-minal ("opencode-cli", "gemini-cli", or the config key). */
  id: string;
  name: string;
  /** The program: a bare name found on the PATH (and the known places), or a path. */
  command: string;
  args: string[];
  /** Extra environment variables for the process. */
  env: Record<string, string>;
  /** Where to read about the agent. */
  docs: string | null;
  /** One sentence on how to sign in. */
  signIn: string;
  /** The command that signs in, run in the real terminal (the UI suspends itself). */
  login: { command: string; args: string[] } | null;
  /** How to install it, for "not installed" hints. */
  install: string | null;
  /**
   * How the agent names a tool of lu-minal's MCP server "luminal": OpenCode prefixes "luminal_",
   * Gemini CLI uses the bare name. The team prompt names the tools this way.
   */
  toolPrefix: string;
  /** Where the model list comes from: `opencode models`, a static list, or nothing. */
  models: "opencode" | "static" | "none";
  staticModels: AcpStaticModel[];
  /**
   * Extra command-line arguments that pick a model, for agents whose ACP side can't (Gemini CLI's
   * `--model`). Used only when the session offers no model selection of its own.
   */
  modelArgs: ((model: string) => string[]) | null;
  /** Adjusts the environment before the process starts (OpenCode's permission rules). */
  prepareEnv: ((env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) | null;
  /**
   * A provider error in one of the agent's stderr lines, or null. Some agents retry a failing
   * model provider for minutes without a word over ACP (OpenCode); this lets lu-minal say why.
   */
  stderrError: ((line: string) => string | null) | null;
  /** An auth method that needs no interaction, to call `authenticate` with when the agent asks. */
  autoAuth: ((methods: AcpAuthMethod[], env: NodeJS.ProcessEnv) => string | null) | null;
  /** Install places besides the PATH (apps started from a launcher may not see the shell's PATH). */
  locations: (home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string[];
  /** Built in (false: from config.json). */
  builtin: boolean;
}

/** An `acpAgents` entry in config.json. */
export type { AcpAgentConfig } from "../../core/config.js";

export const OPENCODE_CLI_ID = "opencode-cli";
export const GEMINI_CLI_ID = "gemini-cli";

/** The model id that leaves the choice to the agent (its own configured default). */
export const ACP_DEFAULT_MODEL = "default";

/**
 * The provider error in an OpenCode log line (`--print-logs`): `level=ERROR ... message="stream
 * error" ... error.error="AI_APICallError: Free usage limit reached. ..."` gives "Free usage limit
 * reached. ...". Null for other lines.
 */
export function openCodeLogError(line: string): string | null {
  if (!/\blevel=ERROR\b/.test(line) && !/^ERROR\b/.test(line)) return null;
  const m = /\berror\.error="((?:[^"\\]|\\.)*)"/.exec(line);
  if (!m) return null;
  const text = m[1]
    .replace(/\\(["\\])/g, "$1")
    .replace(/^AI_RetryError: Failed after \d+ attempts\. Last error: /, "")
    .replace(/^(?:AI_)?[A-Za-z]*Error: /, "")
    .trim();
  return text || null;
}

/** OpenCode's permission rules that send edits, commands and web access through lu-minal. */
const OPENCODE_ASK = ["edit", "bash", "webfetch", "websearch"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * OpenCode allows every tool by default, so lu-minal's permission modes would never be asked.
 * OPENCODE_PERMISSION (merged over OpenCode's own config) makes edits, shell commands and web
 * access ask, which arrives as session/request_permission and is decided like any other approval.
 * A rule the user set to "deny" stays.
 */
export function openCodePermissionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let rules: Obj = {};
  const existing = env.OPENCODE_PERMISSION;
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isObj(parsed)) rules = parsed;
    } catch {
      rules = {};
    }
  }
  for (const key of OPENCODE_ASK) if (rules[key] !== "deny") rules[key] = "ask";
  return { ...env, OPENCODE_PERMISSION: JSON.stringify(rules) };
}

function posixPlaces(home: string, name: string, extra: string[] = []): string[] {
  const p = path.posix;
  return [
    ...extra,
    p.join(home, ".local", "bin", name),
    "/usr/local/bin/" + name,
    "/opt/homebrew/bin/" + name,
    p.join(home, ".npm-global", "bin", name),
    p.join(home, ".bun", "bin", name),
    p.join(home, ".volta", "bin", name),
  ];
}

function windowsPlaces(home: string, env: NodeJS.ProcessEnv, name: string, extra: string[] = []): string[] {
  const p = path.win32;
  const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
  return [
    ...extra,
    p.join(appData, "npm", `${name}.cmd`),
    p.join(home, ".bun", "bin", `${name}.exe`),
    p.join(home, "scoop", "shims", `${name}.exe`),
    ...(env.LOCALAPPDATA ? [p.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", `${name}.exe`)] : []),
  ];
}

/** The Gemini models offered in the picker (models.dev's current Gemini line). */
export const GEMINI_CLI_MODELS: AcpStaticModel[] = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon", contextWindow: 1_048_576, maxOutput: 32_768, releaseDate: "2026-10-13", vision: true },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2026-09-02", vision: true },
  { id: "gemini-flash-latest", name: "Gemini Flash Latest", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2026-08-13", vision: true },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2026-07-21", vision: true },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2026-02-19", vision: true },
  { id: "gemini-pro-latest", name: "Gemini Pro Latest", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2026-02-19", vision: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2025-06-17", vision: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_048_576, maxOutput: 65_536, releaseDate: "2025-06-17", vision: true },
];

/** The agents lu-minal knows without any configuration. */
export function builtinAcpPresets(): AcpPreset[] {
  return [
    {
      id: OPENCODE_CLI_ID,
      name: "OpenCode (CLI)",
      command: "opencode",
      // Its errors on stderr (warnings and up): it retries a failing provider silently otherwise.
      args: ["acp", "--print-logs", "--log-level", "WARN"],
      env: {},
      docs: "https://opencode.ai/docs/acp/",
      signIn:
        "OpenCode's free models need no sign-in; run `opencode auth login` to add your own providers (Anthropic, OpenAI, GitHub Copilot, ...).",
      login: { command: "opencode", args: ["auth", "login"] },
      install: "npm install -g opencode-ai (or: curl -fsSL https://opencode.ai/install | bash)",
      toolPrefix: "luminal_",
      models: "opencode",
      staticModels: [],
      modelArgs: null,
      prepareEnv: openCodePermissionEnv,
      stderrError: openCodeLogError,
      autoAuth: null,
      locations: (home, env, platform) =>
        platform === "win32"
          ? windowsPlaces(home, env, "opencode", [path.win32.join(home, ".opencode", "bin", "opencode.exe")])
          : posixPlaces(home, "opencode", [path.posix.join(home, ".opencode", "bin", "opencode")]),
      builtin: true,
    },
    {
      id: GEMINI_CLI_ID,
      name: "Gemini CLI",
      command: "gemini",
      args: ["--experimental-acp"],
      env: {},
      docs: "https://github.com/google-gemini/gemini-cli",
      signIn: "Run `gemini` once in a terminal and choose \"Login with Google\", or set GEMINI_API_KEY.",
      login: { command: "gemini", args: [] },
      install: "npm install -g @google/gemini-cli",
      toolPrefix: "",
      models: "static",
      staticModels: GEMINI_CLI_MODELS,
      modelArgs: (model) => ["--model", model],
      prepareEnv: null,
      stderrError: null,
      autoAuth: (methods, env) => {
        if (env.GEMINI_API_KEY && methods.some((m) => m.id === "gemini-api-key")) return "gemini-api-key";
        return null;
      },
      locations: (home, env, platform) =>
        platform === "win32" ? windowsPlaces(home, env, "gemini") : posixPlaces(home, "gemini"),
      builtin: true,
    },
  ];
}

const cleanStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];

function cleanEnv(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

/** The config.json entries, with everything malformed dropped. */
function configEntries(config: Pick<Config, "acpAgents"> | null | undefined): Array<[string, AcpAgentConfig]> {
  const raw = (config as { acpAgents?: unknown } | null | undefined)?.acpAgents;
  if (!isObj(raw)) return [];
  return Object.entries(raw).filter((e): e is [string, AcpAgentConfig] => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e[0]) && isObj(e[1]));
}

function modelArgsFrom(template: string[]): ((model: string) => string[]) | null {
  if (!template.length) return null;
  return (model) => template.map((a) => a.split("{model}").join(model));
}

/** A builtin preset with a config.json entry of the same id applied (another path, more args). */
function overridePreset(base: AcpPreset, entry: AcpAgentConfig): AcpPreset {
  const args = Array.isArray(entry.args) ? cleanStrings(entry.args) : base.args;
  const modelArgs = Array.isArray(entry.modelArgs) ? modelArgsFrom(cleanStrings(entry.modelArgs)) : base.modelArgs;
  const staticModels = cleanStrings(entry.models).map((id) => ({ id, name: id }));
  return {
    ...base,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : base.name,
    command: typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : base.command,
    args,
    env: { ...base.env, ...cleanEnv(entry.env) },
    modelArgs,
    staticModels: staticModels.length ? [...base.staticModels, ...staticModels.filter((m) => !base.staticModels.some((b) => b.id === m.id))] : base.staticModels,
    toolPrefix: typeof entry.toolPrefix === "string" ? entry.toolPrefix : base.toolPrefix,
    docs: typeof entry.docs === "string" && entry.docs.trim() ? entry.docs.trim() : base.docs,
    signIn: typeof entry.signIn === "string" && entry.signIn.trim() ? entry.signIn.trim() : base.signIn,
  };
}

/** A preset for an agent only config.json knows. */
function customPreset(id: string, entry: AcpAgentConfig): AcpPreset | null {
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  if (!command) return null;
  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
    command,
    args: cleanStrings(entry.args),
    env: cleanEnv(entry.env),
    docs: typeof entry.docs === "string" && entry.docs.trim() ? entry.docs.trim() : null,
    signIn:
      typeof entry.signIn === "string" && entry.signIn.trim()
        ? entry.signIn.trim()
        : `Sign in the way ${typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : command} expects (see its docs).`,
    login: null,
    install: null,
    toolPrefix: typeof entry.toolPrefix === "string" ? entry.toolPrefix : "",
    models: "static",
    staticModels: cleanStrings(entry.models).map((m) => ({ id: m, name: m })),
    modelArgs: modelArgsFrom(cleanStrings(entry.modelArgs)),
    prepareEnv: null,
    stderrError: null,
    autoAuth: null,
    locations: () => [],
    builtin: false,
  };
}

/** Every ACP agent: the builtins (with their config.json overrides), then the custom ones. */
export function acpPresets(config?: Pick<Config, "acpAgents"> | null): AcpPreset[] {
  const builtins = builtinAcpPresets();
  const entries = configEntries(config);
  const out = builtins.map((b) => {
    const entry = entries.find(([id]) => id === b.id);
    return entry ? overridePreset(b, entry[1]) : b;
  });
  for (const [id, entry] of entries) {
    if (builtins.some((b) => b.id === id)) continue;
    const preset = customPreset(id, entry);
    if (preset) out.push(preset);
  }
  return out;
}

/** The preset for a provider id, or null when it is no ACP agent. */
export function findAcpAgent(id: string, config?: Pick<Config, "acpAgents"> | null): AcpPreset | null {
  return acpPresets(config).find((p) => p.id === id) ?? null;
}

export type ProgramFinder = typeof findProgram;

export interface FindAcpOptions {
  find?: ProgramFinder;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/** The full path of the agent's program, or null when it isn't installed. */
export function findAcpProgram(preset: AcpPreset, opts: FindAcpOptions = {}): string | null {
  const find = opts.find ?? findProgram;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const command = expandHome(preset.command);
  // A path (not a bare name) is used as it is.
  if (/[\\/]/.test(command)) return find(path.basename(command), { configured: command, extra: [], env: { ...env, PATH: "", Path: "" } });
  return find(command, { extra: preset.locations(home, env, platform), env });
}

/** Every ACP agent and whether (where) it is installed. */
export function detectAcpAgents(
  config?: Pick<Config, "acpAgents"> | null,
  opts: FindAcpOptions = {},
): Array<{ preset: AcpPreset; exe: string | null }> {
  return acpPresets(config).map((preset) => ({ preset, exe: findAcpProgram(preset, opts) }));
}

/** The command line for an agent on `model` ("default" or empty: the agent's own choice). */
export function acpCommandArgs(preset: AcpPreset, model: string | null | undefined, opts: { modelArgs?: boolean } = {}): string[] {
  const args = [...preset.args];
  const m = model?.trim();
  if (opts.modelArgs !== false && preset.modelArgs && m && m !== ACP_DEFAULT_MODEL) args.push(...preset.modelArgs(m));
  return args;
}

/** The environment for the agent's process: the inherited one, the preset's variables, its tweaks. */
export function acpEnv(preset: AcpPreset, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv = { ...base, ...preset.env };
  if (preset.prepareEnv) env = preset.prepareEnv(env);
  return env;
}
