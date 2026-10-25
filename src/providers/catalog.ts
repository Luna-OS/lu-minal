// The provider and model catalog: models.dev's api.json (cached for a day in the cache dir, with a
// small bundled fallback), mapped onto lu-minal's three wires, plus the two providers models.dev
// doesn't have (Claude through the Claude Code CLI, and a local Ollama server).
import fs from "node:fs";
import path from "node:path";
import { FALLBACK_MODELS_DEV } from "./catalog-fallback.js";
import type { ModelInfo, ProviderAuth, ProviderInfo, ProviderKind } from "./models.js";
import type { FetchLike, WireKind } from "./types.js";

/** Everything lu-minal knows about providers and models right now. */
export interface Catalog {
  providers: ProviderInfo[];
  models: ModelInfo[];
  /** When the models.dev data was downloaded (ms since epoch); null for the bundled fallback. */
  fetchedAt: number | null;
  source: "network" | "cache" | "fallback";
}

/** models.dev's catalog. */
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** The cache file's name inside the cache dir. */
export const CATALOG_CACHE_FILE = "models-dev.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far in the future a cache timestamp may be and still count as fresh (file times, clocks). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Providers shown first in pickers, in this order (everything else follows alphabetically). */
export const FEATURED_ORDER = [
  "claude-code",
  "opencode",
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "minimax",
  "ollama",
  "lmstudio",
];
/** How many of FEATURED_ORDER (the first ones that exist) get `featured: true`. */
const FEATURED_COUNT = 8;

/** Claude through the Claude Code CLI and the user's subscription. */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
/** A local Ollama server. */
export const OLLAMA_PROVIDER_ID = "ollama";
/** Ollama's OpenAI-compatible endpoint on this machine. */
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
/** The Claude Code CLI's model aliases, in picker order. */
export const CLAUDE_CODE_ALIASES = ["default", "opus", "sonnet", "haiku"] as const;

const OPENAI_CHAT_DEFAULTS: Record<string, string | null> = {
  "@ai-sdk/openai-compatible": null,
  "@openrouter/ai-sdk-provider": "https://openrouter.ai/api/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@ai-sdk/alibaba": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "@ai-sdk/cohere": "https://api.cohere.ai/compatibility/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta/openai",
  "venice-ai-sdk-provider": "https://api.venice.ai/api/v1",
  "@aihubmix/ai-sdk-provider": "https://aihubmix.com/v1",
};

const OTHER_WIRES: Record<string, { wire: WireKind; baseURL: string }> = {
  "@ai-sdk/anthropic": { wire: "anthropic", baseURL: "https://api.anthropic.com/v1" },
  "@ai-sdk/openai": { wire: "openai-responses", baseURL: "https://api.openai.com/v1" },
};

/** Base URLs for providers whose catalog entry may lack an `api`. */
const PROVIDER_DEFAULTS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  opencode: "https://opencode.ai/inference/openai/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  ollama: OLLAMA_BASE_URL,
};

/** Model types that aren't chat models (embeddings, image, speech, ...). Untyped means chat. */
const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "transcription", "speech", "realtime", "reranking"]);
/** Providers whose models cost nothing even when the catalog lists no price. */
const LOCAL_FREE = new Set(["lmstudio", "ollama"]);

function stripSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The wire for a models.dev `npm` package: "openai-chat" for the OpenAI-compatible family,
 * "anthropic" for `@ai-sdk/anthropic`, "openai-responses" for `@ai-sdk/openai`; null for SDKs
 * lu-minal can't speak (Bedrock, Vertex, Azure, gateways with their own SDKs, ...).
 */
export function wireForNpm(npm: string | null | undefined): WireKind | null {
  if (!npm) return null;
  if (npm in OPENAI_CHAT_DEFAULTS) return "openai-chat";
  return OTHER_WIRES[npm]?.wire ?? null;
}

/** The base URL a provider uses when the catalog names none (no trailing slash), or null. */
export function defaultBaseURL(npm: string | null | undefined, providerId: string): string | null {
  if (npm && OTHER_WIRES[npm]) return OTHER_WIRES[npm].baseURL;
  const known = npm ? OPENAI_CHAT_DEFAULTS[npm] : undefined;
  if (known) return stripSlashes(known);
  const byId = PROVIDER_DEFAULTS[providerId];
  return byId ? stripSlashes(byId) : null;
}

/**
 * The base URL for `npm` given the catalog's `api` (which may be missing). `api` must be http(s);
 * `${VAR}` placeholders are kept (the registry fills them in from the environment). For
 * `@ai-sdk/google` the catalog's `api` is Gemini's native root, so "/openai" is appended to reach
 * the OpenAI-compatible endpoint.
 */
export function baseURLFor(npm: string | null | undefined, api: string | null | undefined, providerId: string): string | null {
  if (typeof api === "string" && /^https?:\/\//i.test(api.trim())) {
    let url = stripSlashes(api.trim());
    if (npm === "@ai-sdk/google" && !/\/openai$/i.test(url)) url += "/openai";
    return url;
  }
  return defaultBaseURL(npm, providerId);
}

/** The `${VAR}` names a URL template needs from the environment. */
export function templateVars(url: string | null | undefined): string[] {
  if (!url) return [];
  return [...url.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

// ---- parsing models.dev -------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

function providerAuth(id: string): ProviderAuth {
  if (id === "opencode") return "optional";
  if (id === "openrouter") return "oauth";
  if (id === "lmstudio") return "none";
  return "api-key";
}

function providerKind(id: string): ProviderKind {
  return id === "lmstudio" ? "local" : "api";
}

function parseCost(v: unknown): ModelInfo["cost"] {
  if (!isObject(v)) return null;
  const input = num(v.input);
  const output = num(v.output);
  if (input === null || output === null) return null;
  const cost: NonNullable<ModelInfo["cost"]> = { input, output };
  const cacheRead = num(v.cache_read);
  const cacheWrite = num(v.cache_write);
  if (cacheRead !== null) cost.cacheRead = cacheRead;
  if (cacheWrite !== null) cost.cacheWrite = cacheWrite;
  return cost;
}

function outputsText(m: Json): boolean {
  const modalities = m.modalities;
  if (!isObject(modalities)) return true; // models.dev always has them; be lenient if not
  const output = modalities.output;
  return Array.isArray(output) ? output.includes("text") : true;
}

/**
 * Maps models.dev's api.json to lu-minal's providers and models. Skips models that don't write
 * text (and non-chat types like embeddings). A model's own `provider.npm` / `provider.api` win over
 * the provider's. Never throws: anything that isn't the expected shape is ignored.
 */
export function parseModelsDev(json: unknown): { providers: ProviderInfo[]; models: ModelInfo[] } {
  const providers: ProviderInfo[] = [];
  const models: ModelInfo[] = [];
  if (!isObject(json)) return { providers, models };

  for (const [key, raw] of Object.entries(json)) {
    if (!isObject(raw)) continue;
    const id = str(raw.id) ?? key;
    const npm = str(raw.npm);
    const api = str(raw.api);
    const wire = wireForNpm(npm);
    const baseURL = wire ? baseURLFor(npm, api, id) : null;
    const rawModels = isObject(raw.models) ? raw.models : {};

    const providerModels: ModelInfo[] = [];
    const urls: Array<string | null> = [baseURL];
    for (const [modelKey, m] of Object.entries(rawModels)) {
      if (!isObject(m)) continue;
      if (typeof m.type === "string" && NON_CHAT_TYPES.has(m.type)) continue;
      if (!outputsText(m)) continue;
      const own = isObject(m.provider) ? m.provider : {};
      const ownNpm = str(own.npm);
      const ownApi = str(own.api);
      let mWire = wire;
      let mBase = baseURL;
      if (ownNpm || ownApi) {
        const effNpm = ownNpm ?? npm;
        mWire = wireForNpm(effNpm);
        mBase = mWire ? baseURLFor(effNpm, ownApi ?? api, id) : null;
      }
      urls.push(mBase);
      const cost = parseCost(m.cost);
      const limit = isObject(m.limit) ? m.limit : {};
      const modelId = str(m.id) ?? modelKey;
      providerModels.push({
        id: modelId,
        name: str(m.name) ?? modelId,
        provider: id,
        wire: mWire,
        baseURL: mBase,
        contextWindow: positive(limit.context),
        maxOutput: positive(limit.output),
        toolCall: m.tool_call === true,
        reasoning: m.reasoning === true,
        free: cost ? cost.input === 0 && cost.output === 0 : LOCAL_FREE.has(id),
        cost,
        status: str(m.status),
        releaseDate: str(m.release_date),
      });
    }

    // Variables that only fill URL templates (account ids, regions) aren't keys.
    const urlVars = new Set(urls.flatMap(templateVars));
    const env = (Array.isArray(raw.env) ? raw.env : [])
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .filter((e) => !urlVars.has(e));

    providers.push({
      id,
      name: str(raw.name) ?? id,
      kind: providerKind(id),
      auth: providerAuth(id),
      wire,
      baseURL,
      env,
      doc: str(raw.doc),
      supported:
        (wire !== null && baseURL !== null) || providerModels.some((m) => m.wire !== null && m.baseURL !== null),
    });
    models.push(...providerModels);
  }
  return { providers, models };
}

// ---- lu-minal's own providers -------------------------------------------------------------------

/** "claude-code" (the Claude Code CLI) and "ollama" (a local server), which models.dev lacks. */
export function builtinProviders(): ProviderInfo[] {
  return [
    {
      id: CLAUDE_CODE_PROVIDER_ID,
      name: "Claude (subscription)",
      kind: "claude-code",
      auth: "cli",
      wire: null,
      baseURL: null,
      env: [],
      doc: "https://docs.claude.com/en/docs/claude-code/overview",
      supported: true,
      featured: true,
    },
    {
      id: OLLAMA_PROVIDER_ID,
      name: "Ollama",
      kind: "local",
      auth: "none",
      wire: "openai-chat",
      baseURL: OLLAMA_BASE_URL,
      env: [],
      doc: "https://ollama.com/library",
      supported: true,
    },
  ];
}

const DATED_ID = /-\d{8}$/;

function claudeCodeModel(id: string, name: string, from?: ModelInfo, alias = false): ModelInfo {
  return {
    id,
    name,
    provider: CLAUDE_CODE_PROVIDER_ID,
    wire: null,
    baseURL: null,
    contextWindow: from?.contextWindow ?? null,
    maxOutput: from?.maxOutput ?? null,
    toolCall: true,
    reasoning: from?.reasoning ?? true,
    free: false,
    cost: null,
    status: alias ? null : (from?.status ?? null),
    releaseDate: alias ? null : (from?.releaseDate ?? null),
  };
}

const newestFirst = (a: ModelInfo, b: ModelInfo) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");

/**
 * The "claude-code" models: the CLI's aliases ("default", "opus", "sonnet", "haiku") followed by
 * every non-dated Anthropic model id (e.g. "claude-opus-5-5"). Aliases take their context window
 * from the newest non-deprecated Anthropic model of their family, and carry no release date.
 */
export function builtinModels(anthropicModels: ModelInfo[]): ModelInfo[] {
  const claude = anthropicModels.filter((m) => m.id.startsWith("claude-"));
  const current = claude.filter((m) => m.status !== "deprecated").sort(newestFirst);
  const familyHead = (family: string) => current.find((m) => m.id.includes(`-${family}-`) || m.id.endsWith(`-${family}`));
  const out: ModelInfo[] = [
    claudeCodeModel("default", "Default - your plan's model", undefined, true),
    claudeCodeModel("opus", "Opus", familyHead("opus"), true),
    claudeCodeModel("sonnet", "Sonnet", familyHead("sonnet"), true),
    claudeCodeModel("haiku", "Haiku", familyHead("haiku"), true),
  ];
  const seen = new Set(out.map((m) => m.id));
  for (const m of claude) {
    if (DATED_ID.test(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(claudeCodeModel(m.id, m.name, m));
  }
  return out;
}

// ---- ordering -----------------------------------------------------------------------------------

/** Featured providers first (FEATURED_ORDER), then the rest by name. Returns a new array. */
export function sortProviders(providers: ProviderInfo[]): ProviderInfo[] {
  const rank = (id: string) => {
    const i = FEATURED_ORDER.indexOf(id);
    return i === -1 ? FEATURED_ORDER.length : i;
  };
  return [...providers].sort((a, b) => {
    const r = rank(a.id) - rank(b.id);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  });
}

function markFeatured(providers: ProviderInfo[]): ProviderInfo[] {
  const featured = new Set(FEATURED_ORDER.filter((id) => providers.some((p) => p.id === id)).slice(0, FEATURED_COUNT));
  return providers.map((p) => ({ ...p, featured: featured.has(p.id) }));
}

/** A whole catalog from an api.json document: parsed, with the builtins added, sorted. */
export function buildCatalog(json: unknown, source: Catalog["source"], fetchedAt: number | null): Catalog {
  const parsed = parseModelsDev(json);
  const builtins = builtinProviders();
  const builtinIds = new Set(builtins.map((p) => p.id));
  const catalogModels = parsed.models.filter((m) => !builtinIds.has(m.provider));
  const providers = markFeatured(
    sortProviders([...builtins, ...parsed.providers.filter((p) => !builtinIds.has(p.id))]),
  );
  const anthropic = catalogModels.filter((m) => m.provider === "anthropic");
  return {
    providers,
    models: [...catalogModels, ...builtinModels(anthropic)],
    fetchedAt,
    source,
  };
}

/** The catalog from the bundled snapshot, available instantly (before `loadCatalog` resolves). */
export function fallbackCatalog(): Catalog {
  return buildCatalog(FALLBACK_MODELS_DEV, "fallback", null);
}

// ---- loading ------------------------------------------------------------------------------------

/** Options for `loadCatalog`. */
export interface LoadCatalogOptions {
  /** The cache dir (`cacheDir()` from src/platform/paths.ts); the file is `models-dev.json`. */
  cacheDir: string;
  fetchImpl?: FetchLike;
  /** How old the cache may be before it is downloaded again (default 24 h). */
  maxAgeMs?: number;
  /** Never download; use the cache however old, else the fallback. */
  offline?: boolean;
  url?: string;
  /** Download timeout (default 8000 ms). */
  timeoutMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

interface CacheFile {
  fetchedAt: number;
  url: string;
  data: unknown;
}

function hasProviders(json: unknown): boolean {
  return parseModelsDev(json).providers.length > 0;
}

function readCache(file: string): { fetchedAt: number; data: unknown } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (isObject(parsed) && typeof parsed.fetchedAt === "number" && "data" in parsed) {
      return hasProviders(parsed.data) ? { fetchedAt: parsed.fetchedAt, data: parsed.data } : null;
    }
    // A plain api.json someone put there: its age is the file's.
    return hasProviders(parsed) ? { fetchedAt: fs.statSync(file).mtimeMs, data: parsed } : null;
  } catch {
    return null;
  }
}

function writeCache(file: string, content: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(content));
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse to replace a file another process has open; write in place instead.
      fs.writeFileSync(file, JSON.stringify(content));
      fs.rmSync(tmp, { force: true });
    }
  } catch {
    // The cache is only an optimisation.
  }
}

async function download(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "lu-minal" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!hasProviders(json)) throw new Error("models.dev sent no providers");
  return json;
}

/**
 * Loads the catalog: a fresh cache file, else a download (written to the cache atomically), else a
 * stale cache, else the bundled fallback. Never throws. The builtin providers are always included.
 */
export async function loadCatalog(opts: LoadCatalogOptions): Promise<Catalog> {
  const now = opts.now ?? Date.now;
  const file = path.join(opts.cacheDir, CATALOG_CACHE_FILE);
  const maxAge = opts.maxAgeMs ?? DAY_MS;
  const url = opts.url ?? MODELS_DEV_URL;
  const cached = readCache(file);

  if (cached) {
    const age = now() - cached.fetchedAt;
    // A timestamp well in the future (a changed clock) counts as stale; a little skew doesn't.
    if (opts.offline || (age > -CLOCK_SKEW_MS && age < maxAge)) return buildCatalog(cached.data, "cache", cached.fetchedAt);
  } else if (opts.offline) {
    return fallbackCatalog();
  }

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (fetchImpl) {
    try {
      const data = await download(url, fetchImpl, opts.timeoutMs ?? 8000);
      const fetchedAt = now();
      writeCache(file, { fetchedAt, url, data });
      return buildCatalog(data, "network", fetchedAt);
    } catch {
      // fall through to what we have
    }
  }
  if (cached) return buildCatalog(cached.data, "cache", cached.fetchedAt);
  return fallbackCatalog();
}
