// The provider registry: the catalog plus the user's sign-ins and config overrides, answering
// "which providers and models are there", "which can I use right now" and "how do I reach this
// model" (endpoint, key, headers, wire). Pure lookups over the data it is given; the only I/O is
// reading auth.json through the AuthStore and looking for ACP agents' programs (kept a minute).
import { staticAcpModels } from "../agents/acp/models.js";
import { acpPresets, findAcpProgram, type AcpPreset } from "../agents/acp/presets.js";
import type { Config, ProviderOverride } from "../core/config.js";
import type { ClaudeAccount } from "../core/types.js";
import { keyFor, readEnv, type AuthStore } from "./auth.js";
import {
  acpProviderInfo,
  CLAUDE_CODE_ALIASES,
  CLAUDE_CODE_PROVIDER_ID,
  FEATURED_ORDER,
  sortProviders,
  templateVars,
  type Catalog,
} from "./catalog.js";
import { formatModelRef, type ModelInfo, type ModelRef, type ProviderInfo, type ResolvedModel } from "./models.js";
import type { WireEndpoint, WireKind } from "./types.js";

/** Why a model can't be used yet, with a sentence telling the user what to do about it. */
export class ProviderNotReadyError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ProviderNotReadyError";
  }
}

/** What the registry reads. `config` and `catalog` can be swapped later (setConfig / setCatalog). */
export interface RegistryDeps {
  catalog: Catalog;
  auth: AuthStore;
  config: Config;
  /** Who is signed in to Claude Code; null while unknown. */
  claudeAccount: () => ClaudeAccount | null;
  env?: NodeJS.ProcessEnv;
  /**
   * Where an ACP agent's program is (null: not installed). Defaults to findAcpProgram, whose
   * answers are kept for a minute (refreshAcp() forgets them).
   */
  acpProgram?: (preset: AcpPreset) => string | null;
}

/** How long a "where is opencode / gemini" answer is trusted. */
const ACP_PROGRAM_TTL_MS = 60_000;

/** OpenRouter's app attribution headers. */
export const OPENROUTER_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://github.com/Luna-OS/lu-minal",
  "X-Title": "lu-minal",
};

/** The key OpenCode Zen accepts for its free models (the OpenCode CLI sends the same). */
export const OPENCODE_PUBLIC_KEY = "public";

const WIRES = new Set<WireKind>(["openai-chat", "openai-responses", "anthropic"]);

interface CleanOverride {
  name?: string;
  baseURL?: string;
  wire?: WireKind;
  headers: Record<string, string>;
  models: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

const stripSlashes = (url: string) => url.replace(/\/+$/, "");

/** A config.json provider entry with everything malformed dropped. */
function cleanOverride(raw: ProviderOverride | undefined): CleanOverride | null {
  if (!isObject(raw)) return null;
  const out: CleanOverride = { headers: {}, models: [] };
  if (typeof raw.name === "string" && raw.name.trim()) out.name = raw.name.trim();
  if (typeof raw.baseURL === "string" && /^https?:\/\//i.test(raw.baseURL.trim())) {
    out.baseURL = stripSlashes(raw.baseURL.trim());
  }
  if (typeof raw.wire === "string" && WIRES.has(raw.wire as WireKind)) out.wire = raw.wire as WireKind;
  if (isObject(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") out.headers[k] = v;
  }
  if (Array.isArray(raw.models)) {
    out.models = [...new Set(raw.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim()))];
  }
  return out;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.") || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/** "MY_PROXY_API_KEY" for a custom provider "my-proxy". */
function envNameFor(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_API_KEY`;
}

const featuredRank = (id: string) => {
  const i = FEATURED_ORDER.indexOf(id);
  return i === -1 ? FEATURED_ORDER.length : i;
};

const isDeprecated = (m: ModelInfo) => m.status === "deprecated";

/** Newest release first; models without a date last. */
const byDateDesc = (a: ModelInfo, b: ModelInfo) => {
  if (a.releaseDate === b.releaseDate) return 0;
  if (!a.releaseDate) return 1;
  if (!b.releaseDate) return -1;
  return b.releaseDate.localeCompare(a.releaseDate);
};

const aliasRank = (m: ModelInfo) => {
  // "default" (the CLI's own choice) leads every CLI provider's list: Claude Code's and ACP agents'.
  if (m.provider !== CLAUDE_CODE_PROVIDER_ID) return m.id === "default" && m.wire === null && m.baseURL === null ? 0 : CLAUDE_CODE_ALIASES.length;
  const i = (CLAUDE_CODE_ALIASES as readonly string[]).indexOf(m.id);
  return i === -1 ? CLAUDE_CODE_ALIASES.length : i;
};

/** Non-deprecated first, Claude Code's aliases first, then newest first (stable otherwise). */
function sortModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const dep = Number(isDeprecated(a.m)) - Number(isDeprecated(b.m));
      if (dep) return dep;
      const alias = aliasRank(a.m) - aliasRank(b.m);
      if (alias) return alias;
      return byDateDesc(a.m, b.m) || a.i - b.i;
    })
    .map((x) => x.m);
}

/**
 * Providers and models with the user's sign-ins applied. It holds no state worth notifying about
 * beyond the catalog and local model lists; whoever calls setCatalog / setLocalModels or changes
 * auth.json should tell the UI.
 */
export class ProviderRegistry {
  private catalog!: Catalog;
  private catalogProviders = new Map<string, ProviderInfo>();
  private catalogModels = new Map<string, ModelInfo[]>();
  private localModels = new Map<string, ModelInfo[]>();
  private acpPrograms = new Map<string, { exe: string | null; at: number }>();

  constructor(private readonly deps: RegistryDeps) {
    this.setCatalog(deps.catalog);
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  /** Replaces the catalog (after a background refresh). */
  setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.deps.catalog = catalog;
    this.catalogProviders = new Map(catalog.providers.map((p) => [p.id, p]));
    this.catalogModels = new Map();
    for (const m of catalog.models) {
      const list = this.catalogModels.get(m.provider);
      if (list) list.push(m);
      else this.catalogModels.set(m.provider, [m]);
    }
  }

  /** Replaces the config (after the user changed settings). */
  setConfig(config: Config): void {
    this.deps.config = config;
  }

  /**
   * The models a local server reported (Ollama's /api/tags), or an ACP agent's own list
   * (listAcpModels, e.g. `opencode models`); replaces earlier ones.
   */
  setLocalModels(providerId: string, models: ModelInfo[]): void {
    this.localModels.set(providerId, models.map((m) => ({ ...m, provider: providerId })));
  }

  // ---- ACP agents -------------------------------------------------------------------------------

  /** Every ACP agent (builtin and from config.json) whose id doesn't clash with another provider. */
  acpPresets(): AcpPreset[] {
    const providers = this.deps.config.providers;
    return acpPresets(this.deps.config).filter(
      (p) => !this.catalogProviders.has(p.id) && (p.builtin || !(isObject(providers) && Object.hasOwn(providers, p.id))),
    );
  }

  /** The ACP agent behind a provider id, or null when it is none. */
  acpPreset(id: string): AcpPreset | null {
    if (this.catalogProviders.has(id)) return null;
    return this.acpPresets().find((p) => p.id === id) ?? null;
  }

  /** The full path of an ACP agent's program, or null when it isn't installed. */
  acpProgram(id: string): string | null {
    const preset = this.acpPreset(id);
    if (!preset) return null;
    if (this.deps.acpProgram) return this.deps.acpProgram(preset);
    const key = `${preset.id}\u0000${preset.command}`;
    const hit = this.acpPrograms.get(key);
    if (hit && Date.now() - hit.at < ACP_PROGRAM_TTL_MS) return hit.exe;
    const exe = findAcpProgram(preset, { env: this.env });
    this.acpPrograms.set(key, { exe, at: Date.now() });
    return exe;
  }

  /** Forgets where the ACP agents are (after an install). */
  refreshAcp(): void {
    this.acpPrograms.clear();
  }

  // ---- providers --------------------------------------------------------------------------------

  private override(id: string): CleanOverride | null {
    const providers = this.deps.config.providers;
    if (!isObject(providers) || !Object.hasOwn(providers, id)) return null;
    return cleanOverride(providers[id]);
  }

  /** A catalog provider with config.json's overrides applied. */
  private effective(base: ProviderInfo): ProviderInfo {
    if (base.kind === "claude-code" || base.kind === "acp") return base;
    const o = this.override(base.id);
    if (!o) return base;
    const baseURL = o.baseURL ?? base.baseURL;
    const wire = o.wire ?? base.wire ?? (o.baseURL ? "openai-chat" : null);
    return {
      ...base,
      name: o.name ?? base.name,
      baseURL,
      wire,
      supported: base.supported || (wire !== null && baseURL !== null),
    };
  }

  /** A provider config.json declares that the catalog doesn't know (an OpenAI-compatible server). */
  private custom(id: string): ProviderInfo | null {
    if (this.catalogProviders.has(id) || this.acpPreset(id)?.builtin) return null;
    const o = this.override(id);
    if (!o?.baseURL) return null;
    const local = isLoopback(o.baseURL);
    return {
      id,
      name: o.name ?? id,
      kind: local ? "local" : "api",
      auth: local ? "none" : "optional",
      wire: o.wire ?? "openai-chat",
      baseURL: o.baseURL,
      env: [envNameFor(id)],
      doc: null,
      supported: true,
      featured: false,
    };
  }

  private isCustom(id: string): boolean {
    return !this.catalogProviders.has(id) && this.custom(id) !== null;
  }

  /** Every provider: featured first, then by name, plus ACP agents and custom ones from config.json. */
  providers(): ProviderInfo[] {
    const list = this.catalog.providers.map((p) => this.effective(p));
    for (const preset of this.acpPresets()) list.push(acpProviderInfo(preset));
    const providers = this.deps.config.providers;
    if (isObject(providers)) {
      for (const id of Object.keys(providers)) {
        const c = this.custom(id);
        if (c) list.push(c);
      }
    }
    return sortProviders(list);
  }

  provider(id: string): ProviderInfo | undefined {
    const base = this.catalogProviders.get(id);
    if (base) return this.effective(base);
    const acp = this.acpPreset(id);
    if (acp) return acpProviderInfo(acp);
    return this.custom(id) ?? undefined;
  }

  // ---- models -----------------------------------------------------------------------------------

  /** A model the catalog doesn't list, as far as the provider tells. */
  private synthesize(provider: ProviderInfo, id: string): ModelInfo {
    const local = provider.kind === "local";
    const claude = provider.kind === "claude-code" || provider.kind === "acp";
    const free = local || (provider.id === "openrouter" && id.endsWith(":free"));
    return {
      id,
      name: id,
      provider: provider.id,
      wire: claude ? null : provider.wire,
      baseURL: claude ? null : provider.baseURL,
      contextWindow: null,
      maxOutput: null,
      toolCall: true,
      reasoning: false,
      free,
      cost: free ? { input: 0, output: 0 } : null,
      status: null,
      releaseDate: null,
    };
  }

  /** Applies config.json's base URL / wire to a model that inherits them from its provider. */
  private effectiveModel(m: ModelInfo, provider: ProviderInfo): ModelInfo {
    const base = this.catalogProviders.get(provider.id);
    if (!base || provider === base) return m;
    // A model with its own endpoint or wire (models.dev's per-model `provider`) keeps it.
    const ownBase = m.baseURL !== base.baseURL;
    const ownWire = m.wire !== base.wire;
    if (ownBase && ownWire) return m;
    return {
      ...m,
      baseURL: ownBase ? m.baseURL : provider.baseURL,
      wire: ownWire ? m.wire : provider.wire,
    };
  }

  /** Everything a provider offers: live local models, the catalog's, config.json's extra ids. */
  private allModels(providerId: string): ModelInfo[] {
    const provider = this.provider(providerId);
    if (!provider) return [];
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    const add = (m: ModelInfo) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      out.push(this.effectiveModel(m, provider));
    };
    for (const m of this.localModels.get(providerId) ?? []) add(m);
    for (const m of this.catalogModels.get(providerId) ?? []) add(m);
    if (provider.kind === "acp") {
      const preset = this.acpPreset(providerId);
      if (preset) for (const m of staticAcpModels(preset)) add(m);
    }
    for (const id of this.override(providerId)?.models ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(this.synthesize(provider, id));
      }
    }
    return out;
  }

  /**
   * A provider's models: non-deprecated first, then newest first. Tool-calling ones only unless
   * `toolsOnly` is false (agents need tools); deprecated ones only with `includeDeprecated`.
   */
  models(providerId: string, opts: { includeDeprecated?: boolean; toolsOnly?: boolean } = {}): ModelInfo[] {
    const toolsOnly = opts.toolsOnly ?? true;
    return sortModels(
      this.allModels(providerId).filter(
        (m) => (opts.includeDeprecated || !isDeprecated(m)) && (!toolsOnly || m.toolCall),
      ),
    );
  }

  /** Whether `model` accepts ids the catalog doesn't list. */
  private acceptsAnyModel(provider: ProviderInfo): boolean {
    return (
      provider.kind === "local" ||
      provider.kind === "claude-code" ||
      provider.kind === "acp" ||
      provider.id === "openrouter" ||
      this.isCustom(provider.id)
    );
  }

  /**
   * One model (deprecated and tool-less ones included). On custom, local, OpenRouter and Claude
   * Code providers an unknown id is synthesized, so a user can type any id.
   */
  model(ref: ModelRef): ModelInfo | undefined {
    const provider = this.provider(ref.provider);
    if (!provider) return undefined;
    const found = this.allModels(ref.provider).find((m) => m.id === ref.model);
    if (found) return found;
    return this.acceptsAnyModel(provider) && ref.model.trim() ? this.synthesize(provider, ref.model) : undefined;
  }

  /**
   * Free models that can run agents (tool-calling, non-deprecated), from every supported provider:
   * connected providers first, then the featured order, then newest. `connectedOnly` keeps those
   * usable right now (OpenCode's count without a key).
   */
  freeModels(opts: { connectedOnly?: boolean } = {}): ModelInfo[] {
    const out: Array<{ m: ModelInfo; connected: boolean; local: boolean; rank: number }> = [];
    for (const p of this.providers()) {
      // ACP agents' free models are the same ones their providers list directly (OpenCode Zen).
      if (!p.supported || p.kind === "acp") continue;
      const connected = this.isConnected(p.id);
      if (opts.connectedOnly && !connected) continue;
      for (const m of this.models(p.id)) {
        if (m.free) out.push({ m, connected, local: p.kind === "local", rank: featuredRank(p.id) });
      }
    }
    return out
      .map((x, i) => ({ ...x, i }))
      .sort(
        (a, b) =>
          Number(b.connected) - Number(a.connected) ||
          Number(a.local) - Number(b.local) ||
          a.rank - b.rank ||
          a.m.provider.localeCompare(b.m.provider) ||
          byDateDesc(a.m, b.m) ||
          a.i - b.i,
      )
      .map((x) => x.m);
  }

  // ---- sign-in state ----------------------------------------------------------------------------

  private keyOf(provider: ProviderInfo): string | null {
    return keyFor(provider.id, provider.env, this.deps.auth, this.env)?.key ?? null;
  }

  private missingVars(url: string | null): string[] {
    return templateVars(url).filter((name) => readEnv(this.env, name) === null);
  }

  /**
   * Whether a provider can be used right now: Claude Code installed and signed in; local servers
   * and OpenCode always; others with a key in auth.json or the environment (and every variable
   * their URL template needs). Unsupported and unknown providers are never connected.
   */
  isConnected(providerId: string): boolean {
    const p = this.provider(providerId);
    if (!p || !p.supported) return false;
    if (p.kind === "claude-code") {
      const account = this.deps.claudeAccount();
      return Boolean(account?.installed && account.loggedIn);
    }
    // An ACP agent keeps its own sign-in: installed is as much as lu-minal can tell.
    if (p.kind === "acp") return this.acpProgram(p.id) !== null;
    if (p.kind === "local" || p.auth === "none" || p.auth === "optional") return true;
    return this.keyOf(p) !== null && this.missingVars(p.baseURL).length === 0;
  }

  /** One sentence telling the user how to sign in to a provider. */
  connectionHint(providerId: string): string {
    const p = this.provider(providerId);
    if (!p) return `Unknown provider "${providerId}". Pick a model with /model.`;
    if (p.kind === "claude-code") {
      const account = this.deps.claudeAccount();
      if (account?.installed) return "Run /login claude to sign in with your Claude subscription.";
      return "Install Claude Code (npm install -g @anthropic-ai/claude-code) and run /login claude.";
    }
    if (p.kind === "acp") {
      const preset = this.acpPreset(p.id);
      if (!preset) return `Add ${p.id} under acpAgents in config.json.`;
      if (this.acpProgram(p.id)) return preset.signIn;
      if (!preset.builtin) return `${preset.name} isn't installed: \`${preset.command}\` was not found (acpAgents.${preset.id}.command in config.json).`;
      return `Install ${preset.name}${preset.install ? ` (${preset.install})` : ""}. ${preset.signIn}`;
    }
    if (!p.supported) {
      return `lu-minal can't talk to ${p.name} yet; set providers.${p.id}.baseURL in config.json to a compatible endpoint.`;
    }
    if (p.id === "openrouter") {
      return "Sign in with /login openrouter (opens your browser), or set OPENROUTER_API_KEY.";
    }
    if (p.id === "opencode") {
      return "Free models work without a key; add an OpenCode Zen key with /login opencode for the others.";
    }
    if (p.id === "ollama") return "Start Ollama (ollama serve) and pull a model, e.g. ollama pull qwen3.";
    if (p.id === "lmstudio") return "Start LM Studio's local server (Developer tab, port 1234) and load a model.";
    if (p.kind === "local" || p.auth === "none") return `Start the server at ${p.baseURL ?? "its address"}.`;
    const vars = this.missingVars(p.baseURL);
    const setVars = vars.length ? ` Also set ${vars.join(" and ")}.` : "";
    const env = p.env[0] ? `, or set ${p.env[0]}` : "";
    return `Add a key with /login ${p.id}${env}.${setVars}`;
  }

  // ---- resolving --------------------------------------------------------------------------------

  /**
   * Everything needed to talk to a model. Throws ProviderNotReadyError when the provider or model
   * is unknown, lu-minal can't speak its protocol, or a key / URL variable is missing.
   */
  resolve(ref: ModelRef): ResolvedModel {
    const provider = this.provider(ref.provider);
    if (!provider) {
      throw new ProviderNotReadyError(
        `Unknown provider "${ref.provider}".`,
        ref.provider,
        `Pick a model with /model, or add "${ref.provider}" under providers in config.json.`,
      );
    }
    const model = this.model(ref);
    if (!model) {
      throw new ProviderNotReadyError(
        `${provider.name} has no model "${ref.model}".`,
        provider.id,
        `Pick one with /model, or add it to providers.${provider.id}.models in config.json.`,
      );
    }

    if (provider.kind === "claude-code") {
      const account = this.deps.claudeAccount();
      if (account && !(account.installed && account.loggedIn)) {
        throw new ProviderNotReadyError(
          account.installed ? "Claude Code isn't signed in." : "Claude Code isn't installed.",
          provider.id,
          this.connectionHint(provider.id),
        );
      }
      return { ref, provider, model, endpoint: null, wire: null };
    }

    if (provider.kind === "acp") {
      if (!this.acpProgram(provider.id)) {
        throw new ProviderNotReadyError(`${provider.name} isn't installed.`, provider.id, this.connectionHint(provider.id));
      }
      return { ref, provider, model, endpoint: null, wire: null };
    }

    const wire = model.wire;
    const template = model.baseURL;
    if (!provider.supported || !wire || !template) {
      throw new ProviderNotReadyError(
        `lu-minal can't talk to ${provider.name} (${formatModelRef(ref)}) yet.`,
        provider.id,
        `Set providers.${provider.id}.baseURL (and wire) in config.json to a compatible endpoint, or pick another model.`,
      );
    }

    const missing = this.missingVars(template);
    if (missing.length) {
      throw new ProviderNotReadyError(
        `${provider.name} needs ${missing.join(" and ")} to build its address.`,
        provider.id,
        `Set ${missing.join(" and ")} in your environment, or set providers.${provider.id}.baseURL in config.json.`,
      );
    }
    const baseURL = stripSlashes(template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => readEnv(this.env, name) ?? ""));

    let apiKey: string | undefined = this.keyOf(provider) ?? undefined;
    if (!apiKey) {
      if (provider.id === "opencode") {
        if (!model.free) {
          throw new ProviderNotReadyError(
            `${model.name} needs an OpenCode Zen key.`,
            provider.id,
            "Add a key with /login opencode, or pick one of OpenCode's free models.",
          );
        }
        apiKey = OPENCODE_PUBLIC_KEY;
      } else if (provider.auth === "api-key" || provider.auth === "oauth") {
        throw new ProviderNotReadyError(`${provider.name} needs an API key.`, provider.id, this.connectionHint(provider.id));
      }
    }

    const headers: Record<string, string> = {
      ...(provider.id === "openrouter" ? OPENROUTER_HEADERS : {}),
      ...(this.override(provider.id)?.headers ?? {}),
    };
    const endpoint: WireEndpoint = { baseURL };
    if (apiKey) endpoint.apiKey = apiKey;
    if (Object.keys(headers).length) endpoint.headers = headers;
    return { ref, provider, model, endpoint, wire };
  }

  // ---- search and defaults ----------------------------------------------------------------------

  /**
   * Models matching every whitespace-separated term of `query` (case-insensitive, against
   * "provider/model", the model's name and the provider's name). Connected providers first, then
   * supported ones, non-deprecated, exact and prefix matches, the featured order, newest.
   * Tool-calling models only. An empty query lists everything in that order.
   */
  search(query: string, limit = 50): ModelInfo[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const q = query.trim().toLowerCase();
    const hits: Array<{ m: ModelInfo; key: number[]; i: number }> = [];
    for (const p of this.providers()) {
      const connected = this.isConnected(p.id);
      for (const m of this.models(p.id, { includeDeprecated: true })) {
        const ref = `${p.id}/${m.id}`.toLowerCase();
        const hay = `${ref} ${m.name.toLowerCase()} ${p.name.toLowerCase()}`;
        if (!terms.every((t) => hay.includes(t))) continue;
        const id = m.id.toLowerCase();
        const exact = q && (id === q || ref === q) ? 0 : q && (id.startsWith(q) || ref.startsWith(q)) ? 1 : 2;
        hits.push({
          m,
          i: hits.length,
          key: [connected ? 0 : 1, p.supported ? 0 : 1, isDeprecated(m) ? 1 : 0, exact, featuredRank(p.id)],
        });
      }
    }
    hits.sort((a, b) => {
      for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k];
      return a.m.provider.localeCompare(b.m.provider) || byDateDesc(a.m, b.m) || a.i - b.i;
    });
    return hits.slice(0, Math.max(0, limit)).map((h) => h.m);
  }

  private newest(providerId: string, test: (m: ModelInfo) => boolean): ModelInfo | undefined {
    return this.models(providerId)
      .filter((m) => !isDeprecated(m) && test(m))
      .sort((a, b) => Number(/-\d{8}$/.test(a.id)) - Number(/-\d{8}$/.test(b.id)) || byDateDesc(a, b))[0];
  }

  /**
   * The model a new lead starts on: config.json's leadModel when its provider is connected; else
   * Claude Code's Opus when signed in; else the newest Claude Sonnet with an Anthropic key; else a
   * strong tool-calling OpenRouter model; else the best free OpenCode model (no key needed).
   */
  defaultLeadModel(): ModelRef {
    const configured = this.deps.config.leadModel;
    if (configured && this.isConnected(configured.provider)) return { ...configured };
    if (this.isConnected(CLAUDE_CODE_PROVIDER_ID)) return { provider: CLAUDE_CODE_PROVIDER_ID, model: "opus" };
    if (this.isConnected("anthropic")) {
      const sonnet = this.newest("anthropic", (m) => m.id.includes("claude-sonnet"));
      if (sonnet) return { provider: "anthropic", model: sonnet.id };
    }
    if (this.isConnected("openrouter")) {
      for (const pattern of [/^anthropic\/claude-sonnet/, /^anthropic\/claude-opus/, /^openai\/gpt-/, /^google\/gemini-/]) {
        const m = this.newest("openrouter", (x) => pattern.test(x.id) && !x.free);
        if (m) return { provider: "openrouter", model: m.id };
      }
      const any = this.newest("openrouter", (x) => !x.free);
      if (any) return { provider: "openrouter", model: any.id };
    }
    const free = this.models("opencode").filter((m) => m.free && !isDeprecated(m));
    const pick =
      free.find((m) => m.id === "big-pickle") ??
      [...free].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0];
    return { provider: "opencode", model: pick?.id ?? "big-pickle" };
  }

  /**
   * The model workers get when nobody names one: config.json's workerModel when its provider is
   * connected; Sonnet for a Claude Code lead; else the lead's own model.
   */
  defaultWorkerModel(lead: ModelRef): ModelRef {
    const configured = this.deps.config.workerModel;
    if (configured && this.isConnected(configured.provider)) return { ...configured };
    if (lead.provider === CLAUDE_CODE_PROVIDER_ID) return { provider: CLAUDE_CODE_PROVIDER_ID, model: "sonnet" };
    return { ...lead };
  }
}
