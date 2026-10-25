// The models an ACP agent offers in lu-minal's picker. OpenCode lists its own (`opencode models
// --verbose`: "provider/model" lines, each followed by a JSON block); Gemini CLI and custom agents
// have a static list. Every agent also gets "default", which leaves the choice to the agent.
//
// The model ids are the agent's own: for OpenCode "opencode/big-pickle" or
// "anthropic/claude-sonnet-5-5", so an agent's ModelRef is { provider: "opencode-cli",
// model: "opencode/big-pickle" }.
import fs from "node:fs";
import path from "node:path";
import { runProgram } from "../../platform/process.js";
import type { ModelInfo } from "../../providers/models.js";
import { ACP_DEFAULT_MODEL, acpEnv, type AcpPreset } from "./presets.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A model of an ACP agent, as the registry stores it. */
export function acpModel(providerId: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    provider: providerId,
    wire: null,
    baseURL: null,
    contextWindow: null,
    maxOutput: null,
    toolCall: true,
    reasoning: false,
    free: false,
    cost: null,
    status: null,
    releaseDate: null,
    ...extra,
  };
}

/** The "default" entry: the agent runs on whatever it is configured to use. */
export function acpDefaultModel(preset: Pick<AcpPreset, "id" | "name">): ModelInfo {
  return acpModel(preset.id, ACP_DEFAULT_MODEL, { name: `Default - ${preset.name.replace(/\s*\(CLI\)$/, "")}'s own choice` });
}

/** The static part of an agent's models (everything but OpenCode's live list). */
export function staticAcpModels(preset: AcpPreset): ModelInfo[] {
  return [
    acpDefaultModel(preset),
    ...preset.staticModels
      .filter((m) => m.id && m.id !== ACP_DEFAULT_MODEL)
      .map((m) =>
        acpModel(preset.id, m.id, {
          name: m.name || m.id,
          contextWindow: m.contextWindow ?? null,
          maxOutput: m.maxOutput ?? null,
          releaseDate: m.releaseDate ?? null,
          reasoning: true,
          ...(m.vision !== undefined ? { vision: m.vision } : {}),
        }),
      ),
  ];
}

const MODEL_LINE = /^([A-Za-z0-9][\w.@-]*)\/(\S+)$/;

/** One model's metadata from `opencode models --verbose` (whatever of it is there). */
function openCodeDetails(meta: Obj | null): Partial<ModelInfo> {
  if (!meta) return {};
  const out: Partial<ModelInfo> = {};
  const name = str(meta.name);
  if (name) out.name = name;
  const limit = isObj(meta.limit) ? meta.limit : {};
  out.contextWindow = num(limit.context);
  out.maxOutput = num(limit.output);
  const cost = isObj(meta.cost) ? meta.cost : null;
  if (cost && typeof cost.input === "number" && typeof cost.output === "number") {
    out.cost = { input: cost.input, output: cost.output };
    out.free = cost.input === 0 && cost.output === 0;
  }
  const caps = isObj(meta.capabilities) ? meta.capabilities : {};
  if (typeof caps.reasoning === "boolean") out.reasoning = caps.reasoning;
  if (typeof caps.toolcall === "boolean") out.toolCall = caps.toolcall;
  if (isObj(caps.input) && typeof caps.input.image === "boolean") out.vision = caps.input.image;
  const status = str(meta.status);
  if (status && status !== "active") out.status = status;
  const release = str(meta.release_date);
  if (release) out.releaseDate = release;
  return out;
}

/**
 * Parses `opencode models` output: one "provider/model" per line, each optionally followed by a
 * JSON object (with --verbose). Lines that are neither (warnings, logs) are skipped.
 */
export function parseOpenCodeModels(text: string, providerId = "opencode-cli"): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    const m = MODEL_LINE.exec(line);
    if (!m) continue;
    const id = `${m[1]}/${m[2]}`;
    // A JSON block may follow, up to the next model line.
    let meta: Obj | null = null;
    if (lines[i]?.trim().startsWith("{")) {
      const block: string[] = [];
      while (i < lines.length && !MODEL_LINE.test(lines[i].trim())) block.push(lines[i++]);
      try {
        const parsed = JSON.parse(block.join("\n")) as unknown;
        if (isObj(parsed)) meta = parsed;
      } catch {
        meta = null;
      }
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const details = openCodeDetails(meta);
    const providerName = m[1];
    out.push(
      acpModel(providerId, id, {
        ...details,
        name: details.name ? (providerName === "opencode" ? details.name : `${details.name} (${providerName})`) : id,
      }),
    );
  }
  return out;
}

export interface ListAcpModelsOptions {
  /** The agent's program (findAcpProgram); null: only the static list. */
  exe: string | null;
  /** Where the list is cached (a day); omit for no file cache. */
  cacheDir?: string;
  /** How old the cache may be, ms (default 24 h). */
  maxAgeMs?: number;
  /** Ask the CLI even when the cache is fresh. */
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Runs the CLI (tests); defaults to runProgram. */
  run?: (exe: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function cacheFile(dir: string, preset: AcpPreset): string {
  return path.join(dir, `acp-models-${preset.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function readModelCache(file: string): { at: number; models: ModelInfo[] } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isObj(parsed) || typeof parsed.at !== "number" || !Array.isArray(parsed.models)) return null;
    const models = parsed.models.filter((m): m is ModelInfo => isObj(m) && typeof m.id === "string" && typeof m.provider === "string");
    return models.length ? { at: parsed.at, models } : null;
  } catch {
    return null;
  }
}

function writeModelCache(file: string, at: number, models: ModelInfo[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at, models }));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, JSON.stringify({ at, models }));
      fs.rmSync(tmp, { force: true });
    }
  } catch {
    // only an optimisation
  }
}

/**
 * The models to offer for an ACP agent: "default", then OpenCode's own list (`opencode models
 * --verbose`, cached for a day in `cacheDir`) or the preset's static list. Never throws; when the
 * CLI can't be asked, a stale cache or the static list is used. The Hub hands the result to
 * `registry.setLocalModels(preset.id, models)`.
 */
export async function listAcpModels(preset: AcpPreset, opts: ListAcpModelsOptions): Promise<ModelInfo[]> {
  const base = staticAcpModels(preset);
  if (preset.models !== "opencode" || !opts.exe) return base;
  const now = opts.now ?? Date.now;
  const file = opts.cacheDir ? cacheFile(opts.cacheDir, preset) : null;
  const cached = file ? readModelCache(file) : null;
  const fresh = cached && now() - cached.at < (opts.maxAgeMs ?? DAY_MS) && now() >= cached.at - 5 * 60_000;
  const merge = (models: ModelInfo[]) => {
    const ids = new Set(base.map((m) => m.id));
    return [...base, ...models.filter((m) => !ids.has(m.id)).map((m) => ({ ...m, provider: preset.id }))];
  };
  if (cached && fresh && !opts.refresh) return merge(cached.models);
  const run =
    opts.run ??
    ((exe: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => runProgram(exe, args, { env: o.env, timeoutMs: o.timeoutMs }));
  try {
    const res = await run(opts.exe, ["models", "--verbose"], { env: acpEnv(preset, opts.env ?? process.env), timeoutMs: opts.timeoutMs ?? 60_000 });
    const models = parseOpenCodeModels(res.stdout, preset.id);
    if (models.length) {
      if (file) writeModelCache(file, now(), models);
      return merge(models);
    }
  } catch {
    // fall through to what we have
  }
  return cached ? merge(cached.models) : base;
}
