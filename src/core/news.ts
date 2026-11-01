// News for the home screen: the newest models in the catalog (Claude first), Claude's own release
// notes (model launches, offers; src/core/claude-news.ts), what's new in Claude Code (npm's newest
// version and the top of its changelog), Anthropic's status page and, with a key, Artificial
// Analysis's independent benchmark scores for the new models. The downloads run in parallel when the hub isn't offline, each answer is kept for an hour in
// <cacheDir>/news.json, and a source that can't be loaded is null (the home screen says so).
// Nothing here throws.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../platform/files.js";
import type { ModelInfo, ProviderInfo } from "../providers/models.js";
import type { FetchLike } from "../providers/types.js";
import { fetchClaudeNews, type ClaudeNewsItem } from "./claude-news.js";

/** npm's newest Claude Code release ({ version, ... }). */
export const CLAUDE_CODE_NPM_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
/** Claude Code's changelog: "## <version>" sections of "- " bullets, newest first. */
export const CLAUDE_CODE_CHANGELOG_URL = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
/** Anthropic's status page (Atlassian Statuspage's summary). */
export const ANTHROPIC_STATUS_URL = "https://status.anthropic.com/api/v2/summary.json";
/** Artificial Analysis's free data API: every LLM with its benchmark scores (needs a key). */
export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
/** Where the scores come from; their terms ask for this attribution wherever they are shown. */
export const AA_ATTRIBUTION = "artificialanalysis.ai";
/** The auth.json entry and the environment variable for the Artificial Analysis key. */
export const AA_AUTH_ID = "artificialanalysis";
export const AA_KEY_ENV = ["ARTIFICIAL_ANALYSIS_API_KEY"];
/** Where to get a key. */
export const AA_KEY_URL = "https://artificialanalysis.ai/login";
/** The scores move slowly and the free API allows 1,000 requests a day: asked for every 6 hours. */
export const AA_MAX_AGE_MS = 6 * 60 * 60_000;
/** The cache file's name inside the cache dir. */
export const NEWS_CACHE_FILE = "news.json";
/** How long an answer is used before it is asked for again. */
export const NEWS_MAX_AGE_MS = 60 * 60_000;
/** How soon a source that couldn't be loaded is tried again (when the home screen opens). */
export const NEWS_RETRY_MS = 5 * 60_000;
/** How far back "new models" go, and how many there are at most. */
export const NEW_MODEL_DAYS = 120;
export const NEW_MODEL_LIMIT = 6;

const DAY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 10_000;
/**
 * The newest section is at the top: the first 64 KiB of the changelog are plenty. They are asked
 * for uncompressed: GitHub cuts the range out of its gzip stream, and Bun's fetch (the release
 * binaries) fails on the cut stream and prints "Decompression error: ZlibError" over the screen.
 */
const CHANGELOG_BYTES = 65_536;

/** The newest section of a changelog. */
export interface ChangelogSection {
  version: string;
  bullets: string[];
}

/** What a status page says right now. */
export interface ServiceStatus {
  /** "none", "minor", "major", "critical" (or "maintenance"). */
  indicator: string;
  /** "All Systems Operational", "Partially Degraded Service", ... */
  description: string;
  /** The names of the incidents that aren't resolved yet. */
  incidents: string[];
}

export interface News {
  /** npm's newest Claude Code ("2.1.320"); null when it couldn't be loaded. */
  claudeCodeLatest: string | null;
  /** The newest section of Claude Code's changelog; null when it couldn't be loaded. */
  changelog: ChangelogSection | null;
  /** Anthropic's status; null when it couldn't be loaded. */
  status: ServiceStatus | null;
  /** Claude's release notes (apps and platform), newest first; null when neither page loaded. */
  claude: ClaudeNewsItem[] | null;
  /**
   * Artificial Analysis's scores; null without a key or when they couldn't be loaded (and none
   * were in the cache).
   */
  scores?: ModelScore[] | null;
  /**
   * Why the scores couldn't be loaded this time ("HTTP 401", "timed out", ...); the scores may still
   * be the cache's older ones.
   */
  scoresError?: string | null;
  /** When the oldest of these answers was fetched (the time of loading when none was). */
  fetchedAt: number;
  /** When loadNews put this together. */
  loadedAt: number;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// ---- parsers ------------------------------------------------------------------------------------

/** Markdown inline marks out of a line: `code`, **bold**, [text](url). */
function plainText(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first versioned "## " section of a changelog and its first `max` top-level bullets ("- " or
 * "* "). Takes "## 2.1.320", "## v2.1.320" and "## [2.1.320] - 2026-10-20"; a section without a
 * version ("## Unreleased") is skipped. Null when there is no versioned section.
 */
export function parseChangelog(markdown: string, max = 3): ChangelogSection | null {
  let version: string | null = null;
  const bullets: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const head = /^##\s+(.*)$/.exec(line);
    if (head) {
      if (version) break;
      version = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(head[1])?.[1] ?? null;
      continue;
    }
    if (!version || bullets.length >= max) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      const text = plainText(bullet[1]);
      if (text) bullets.push(text);
    }
  }
  return version ? { version, bullets } : null;
}

/**
 * A Statuspage summary.json: the overall status and the incidents that are still open (anything
 * but "resolved", and "postmortem", which comes after it). Null when it isn't one.
 */
export function parseStatus(json: unknown): ServiceStatus | null {
  if (!isObject(json) || !isObject(json.status)) return null;
  const indicator = str(json.status.indicator);
  const description = str(json.status.description);
  if (!indicator || !description) return null;
  const incidents: string[] = [];
  for (const incident of Array.isArray(json.incidents) ? json.incidents : []) {
    if (!isObject(incident)) continue;
    const state = str(incident.status);
    const name = str(incident.name);
    if (name && state !== "resolved" && state !== "postmortem") incidents.push(name);
  }
  return { indicator, description, incidents };
}

/** The version in npm's answer for a package's `latest` tag, or null. */
export function parseNpmLatest(json: unknown): string | null {
  const version = isObject(json) ? str(json.version) : null;
  return version && /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

// ---- Artificial Analysis -----------------------------------------------------------------------

/** One model's scores at Artificial Analysis. */
export interface ModelScore {
  name: string;
  /** "Anthropic", "OpenAI", ... */
  creator: string | null;
  /** The Artificial Analysis Intelligence Index (0-100). */
  intelligence: number | null;
  /** Its Coding Index (0-100). */
  coding: number | null;
  /** Output tokens a second (median). */
  speed: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The LLMs endpoint's answer ({ data: [...] }) as scores; models without any score are left out. */
export function parseAaModels(json: unknown): ModelScore[] | null {
  if (!isObject(json) || !Array.isArray(json.data)) return null;
  const out: ModelScore[] = [];
  for (const m of json.data) {
    if (!isObject(m)) continue;
    const name = str(m.name);
    const ev = isObject(m.evaluations) ? m.evaluations : {};
    const score: ModelScore = {
      name: name ?? "",
      creator: isObject(m.model_creator) ? str(m.model_creator.name) : null,
      intelligence: num(ev.artificial_analysis_intelligence_index),
      coding: num(ev.artificial_analysis_coding_index),
      speed: num(m.median_output_tokens_per_second),
    };
    if (name && (score.intelligence !== null || score.coding !== null)) out.push(score);
  }
  return out.length ? out : null;
}

/**
 * "Claude Opus 5.5 (Reasoning)", "Claude 5.5 Opus" -> the words "5_5 claude opus": names that
 * differ in order only meet. A version stays one word, so Opus 5.5 never meets Opus 5.
 */
function nameWords(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/(\d)[.,](?=\d)/g, "$1_")
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return [...new Set(words)].sort().join(" ");
}

/**
 * Artificial Analysis's scores for a model by its name. They test a model in several modes
 * ("(Reasoning)", "(high)"): the best of them counts. Undefined when they haven't tested it.
 */
export function scoreFor(scores: ModelScore[] | null | undefined, name: string): ModelScore | undefined {
  if (!scores?.length) return undefined;
  const key = nameWords(name);
  if (!key) return undefined;
  let best: ModelScore | undefined;
  for (const s of scores) {
    if (nameWords(s.name) !== key) continue;
    if (!best || (s.intelligence ?? -1) > (best.intelligence ?? -1)) best = s;
  }
  return best;
}

function asScores(v: unknown): ModelScore[] | null {
  if (!Array.isArray(v)) return null;
  const items = v.filter((i): i is ModelScore => isObject(i) && typeof i.name === "string");
  return items.length ? items : null;
}

// ---- new models ---------------------------------------------------------------------------------

/** What newestModels reads (the ProviderRegistry). */
export interface ModelSource {
  providers(): ProviderInfo[];
  models(providerId: string): ModelInfo[];
  isConnected(providerId: string): boolean;
}

export interface NewModel {
  name: string;
  /** The provider to name for it: one that can run it right now when there is one. */
  provider: string;
  /** "2026-10-12". */
  releaseDate: string;
  /** A connected provider can run it right now. */
  connected: boolean;
  /** One of Anthropic's (listed first). */
  claude: boolean;
}

/** "2026-10-12" (or "2026-10") as ms since the epoch, UTC; null when it isn't a date. */
export function releaseTime(date: string | null): number | null {
  const m = date ? /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
  return Number.isFinite(t) ? t : null;
}

/**
 * The labs whose own catalogs the news comes from. Resellers list the same models under many names
 * ("Claude Opus 5.5 (EU)") and hundreds more besides; they count when they are connected: for free
 * models, and to tell that a lab's model can run right now.
 */
export const MODEL_MAKERS = ["anthropic", "openai", "google", "xai", "mistral", "deepseek", "minimax", "moonshotai", "alibaba", "zai", "meta", "xiaomi", "nvidia", "cohere"];

/** Whom to name for a model: Claude through the subscription when it is connected, then the lab. */
function providerRank(id: string, usable: boolean): number {
  if (id === "claude-code") return usable ? -1 : MODEL_MAKERS.length + 1;
  const i = MODEL_MAKERS.indexOf(id);
  return i === -1 ? MODEL_MAKERS.length : i;
}

/** "Claude Opus 5.5", "Claude Opus 5.5 (AWS Bedrock)" -> "claude opus 5 5": one model on many providers. */
function sameModelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bfree\s*$/, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const isClaude = (providerId: string, name: string) => providerId === "anthropic" || providerId === "claude-code" || /^claude\b/i.test(name);

interface Group {
  time: number;
  claude: boolean;
  /** A lab lists it, or a connected provider runs it for free. */
  listed: boolean;
  pick: NewModel;
  rank: [number, number];
}

/**
 * The newest models in the catalog: released in the last `days` days (default 120) by one of the
 * labs (MODEL_MAKERS, Claude Code), or free on a connected provider; one row per model however
 * many providers offer it, newest first. Anthropic's come first and take at most half of the
 * `limit` (default 6) rows while there are others to show. A provider with an optional key
 * (OpenCode Zen) only runs its free models without one.
 */
export function newestModels(source: ModelSource, now: number, opts: { days?: number; limit?: number } = {}): NewModel[] {
  const since = now - (opts.days ?? NEW_MODEL_DAYS) * DAY_MS;
  const limit = Math.max(0, opts.limit ?? NEW_MODEL_LIMIT);
  const groups = new Map<string, Group>();
  for (const p of source.providers()) {
    const lab = p.id === "claude-code" || MODEL_MAKERS.includes(p.id);
    let connected: boolean | null = lab ? null : source.isConnected(p.id);
    // A reseller nobody signed in to adds nothing.
    if (connected === false) continue;
    for (const m of source.models(p.id)) {
      const time = releaseTime(m.releaseDate);
      // A date a little ahead is a time zone; one far ahead is an announcement.
      if (time === null || time < since || time > now + DAY_MS) continue;
      connected ??= source.isConnected(p.id);
      const usable = connected && (p.auth !== "optional" || m.free);
      const rank: [number, number] = [usable ? 0 : 1, providerRank(p.id, usable)];
      const row: NewModel = { name: m.name, provider: p.id, releaseDate: m.releaseDate!, connected: usable, claude: false };
      const key = sameModelKey(m.name);
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { time, claude: isClaude(p.id, m.name), listed: lab || (usable && m.free), pick: row, rank });
        continue;
      }
      group.claude ||= isClaude(p.id, m.name);
      group.listed ||= lab || (usable && m.free);
      // The earliest listing is the release; a reseller's may come a day later.
      if (time < group.time) group.time = time;
      if (rank[0] < group.rank[0] || (rank[0] === group.rank[0] && rank[1] < group.rank[1])) {
        group.pick = row;
        group.rank = rank;
      }
    }
  }
  const sorted = [...groups.values()].filter((g) => g.listed).sort((a, b) => b.time - a.time || a.pick.name.localeCompare(b.pick.name));
  const claude = sorted.filter((g) => g.claude);
  const others = sorted.filter((g) => !g.claude);
  const claudeRows = Math.min(claude.length, Math.max(Math.ceil(limit / 2), limit - others.length));
  return [...claude.slice(0, claudeRows), ...others.slice(0, limit - claudeRows)].map((g) => ({
    ...g.pick,
    releaseDate: new Date(g.time).toISOString().slice(0, 10),
    claude: g.claude,
  }));
}

// ---- loading ------------------------------------------------------------------------------------

type SourceId = "npm" | "changelog" | "status" | "claude" | "aa";

interface CachedAnswer {
  at: number;
  value: unknown;
}

type NewsCache = Partial<Record<SourceId, CachedAnswer>>;

export interface LoadNewsOptions {
  /** The cache dir; the file is `news.json`. */
  cacheDir: string;
  fetchImpl?: FetchLike;
  /** The clock (ms since the epoch). */
  now?: number;
  /** Ask every source again, however fresh the cache is. */
  force?: boolean;
  /** Per-request timeout (default 10 s). */
  timeoutMs?: number;
  /** The Artificial Analysis key; without one there are no scores. */
  aaKey?: string | null;
}

function readCache(file: string): NewsCache {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isObject(raw) || !isObject(raw.sources)) return {};
    const out: NewsCache = {};
    for (const id of ["npm", "changelog", "status", "claude", "aa"] as const) {
      const entry = raw.sources[id];
      if (isObject(entry) && typeof entry.at === "number" && entry.value != null) out[id] = { at: entry.at, value: entry.value };
    }
    return out;
  } catch {
    return {};
  }
}

/** Text from `url`, or null for any failure (status, network, timeout). */
async function download(fetchImpl: FetchLike, url: string, headers: Record<string, string>, timeoutMs: number): Promise<string | null> {
  return (await fetchText(fetchImpl, url, headers, timeoutMs)).text;
}

/** Text from `url`, or why there is none ("HTTP 429", "timed out", "network error"). */
async function fetchText(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ text: string; error: null } | { text: null; error: string }> {
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": "lu-minal", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { text: null, error: `HTTP ${res.status}` };
    return { text: await res.text(), error: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { text: null, error: name === "TimeoutError" || name === "AbortError" ? "timed out" : "network error" };
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A cached changelog section or status as it was written (null when it has the wrong shape). */
function asSection(v: unknown): ChangelogSection | null {
  return isObject(v) && typeof v.version === "string" && Array.isArray(v.bullets) ? { version: v.version, bullets: v.bullets.filter((b): b is string => typeof b === "string") } : null;
}

function asClaudeNews(v: unknown): ClaudeNewsItem[] | null {
  if (!Array.isArray(v)) return null;
  const items = v.filter(
    (i): i is ClaudeNewsItem =>
      isObject(i) && typeof i.date === "string" && typeof i.title === "string" && typeof i.url === "string" && ["model", "offer", "news"].includes(i.kind as string),
  );
  return items.length ? items : null;
}

function asStatus(v: unknown): ServiceStatus | null {
  return isObject(v) && typeof v.indicator === "string" && typeof v.description === "string" && Array.isArray(v.incidents)
    ? { indicator: v.indicator, description: v.description, incidents: v.incidents.filter((i): i is string => typeof i === "string") }
    : null;
}

/**
 * The news: each source from the cache while its answer is less than an hour old (unless `force`),
 * else downloaded (all at once, 10 s each). Answers that came in are written back to the cache. A
 * source that fails keeps its last answer from the cache, however old (one failed download would
 * otherwise wipe what was there); only the status is null then, as an old status would mislead.
 * Never throws.
 */
export async function loadNews(opts: LoadNewsOptions): Promise<News> {
  const now = opts.now ?? Date.now();
  const file = path.join(opts.cacheDir, NEWS_CACHE_FILE);
  const cache = readCache(file);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const fresh = (id: SourceId): CachedAnswer | null => {
    const hit = cache[id];
    if (!hit || opts.force) return null;
    const age = now - hit.at;
    return age >= 0 && age < (id === "aa" ? AA_MAX_AGE_MS : NEWS_MAX_AGE_MS) ? hit : null;
  };
  let wrote = false;
  const get = async <T>(id: SourceId, load: (fetchImpl: FetchLike) => Promise<T | null>, revive: (v: unknown) => T | null): Promise<{ value: T | null; at: number }> => {
    const hit = fresh(id);
    const cached = hit ? revive(hit.value) : null;
    if (hit && cached !== null) return { value: cached, at: hit.at };
    const value = fetchImpl ? await load(fetchImpl).catch(() => null) : null;
    if (value !== null) {
      cache[id] = { at: now, value };
      wrote = true;
      return { value, at: now };
    }
    const old = id === "status" ? undefined : cache[id];
    const stale = old ? revive(old.value) : null;
    return stale !== null && old ? { value: stale, at: old.at } : { value: null, at: now };
  };

  const aaKey = opts.aaKey?.trim() || null;
  let aaError: string | null = null;
  const loadScores = async (f: FetchLike): Promise<ModelScore[] | null> => {
    const got = await fetchText(f, AA_MODELS_URL, { accept: "application/json", "x-api-key": aaKey! }, timeoutMs);
    if (got.error !== null) {
      aaError = got.error;
      return null;
    }
    const parsed = parseAaModels(parseJson(got.text));
    if (!parsed) aaError = "an answer lu-minal can't read";
    return parsed;
  };
  const [npm, changelog, status, claude, scores] = await Promise.all([
    get(
      "npm",
      async (f) => parseNpmLatest(parseJson(await download(f, CLAUDE_CODE_NPM_URL, { accept: "application/json" }, timeoutMs))),
      (v) => (typeof v === "string" ? v : null),
    ),
    get(
      "changelog",
      async (f) => {
        const text = await download(f, CLAUDE_CODE_CHANGELOG_URL, { accept: "text/plain", "accept-encoding": "identity", range: `bytes=0-${CHANGELOG_BYTES - 1}` }, timeoutMs);
        return text === null ? null : parseChangelog(text);
      },
      asSection,
    ),
    get("status", async (f) => parseStatus(parseJson(await download(f, ANTHROPIC_STATUS_URL, { accept: "application/json" }, timeoutMs))), asStatus),
    get(
      "claude",
      async (f) => {
        const items = await fetchClaudeNews({ fetchImpl: f, limit: 12, timeoutMs });
        return items.length ? items : null;
      },
      asClaudeNews,
    ),
    aaKey ? get("aa", loadScores, asScores) : Promise.resolve({ value: null, at: now }),
  ]);

  if (wrote) {
    try {
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      writeFileAtomicSync(file, `${JSON.stringify({ version: 1, sources: cache })}\n`);
    } catch {
      // The cache only saves downloads.
    }
  }
  const loaded = [npm, changelog, status, claude].filter((s) => s.value !== null);
  return {
    claudeCodeLatest: npm.value,
    changelog: changelog.value,
    status: status.value,
    claude: claude.value,
    // The error also when the cache filled in: an old list shouldn't hide that the key stopped working.
    ...(aaKey ? { scores: scores.value, scoresError: aaError ?? (scores.value === null ? "no answer" : null) } : {}),
    fetchedAt: loaded.length ? Math.min(...loaded.map((s) => s.at)) : now,
    loadedAt: now,
  };
}

/**
 * Whether the hub should load the news again: none yet, an hour old, or a source missing and the
 * last try a few minutes back.
 */
export function newsStale(news: News | null, now: number): boolean {
  if (!news) return true;
  if (now - news.fetchedAt >= NEWS_MAX_AGE_MS || now < news.loadedAt) return true;
  const missing = news.claudeCodeLatest === null || news.changelog === null || news.status === null || news.claude === null;
  return missing && now - news.loadedAt >= NEWS_RETRY_MS;
}
