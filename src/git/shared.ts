// What the GitHub and Forgejo hosts share: the token store they read, a JSON GET with a short-lived
// in-memory cache, the client-side name filter, merging a user's own repositories with search
// results, and the places git / gh are installed when they are not on the PATH (GUI apps on macOS
// start with a minimal PATH, Windows installers don't always add theirs).
import path from "node:path";
import { registerSecret } from "../core/secrets.js";
import { isMac, isWindows } from "../platform/paths.js";
import { findProgram } from "../platform/process.js";
import type { FetchLike } from "../providers/types.js";
import type { RepoInfo } from "./types.js";

/** A git host's personal access token as the auth store keeps it. */
export interface TokenEntry {
  type: "token";
  token: string;
  /** The account the token belongs to, once known. */
  user?: string | null;
}

/**
 * The part of the auth store (src/providers/auth.ts, `AuthStore`) the hosts use. Ids are "github"
 * and "forgejo:<hostname>". `get` is optional; with it, the hosts read the stored login and only
 * write it back when it changed.
 */
export interface TokenStore {
  secretFor(id: string): string | null;
  set(id: string, entry: TokenEntry): void;
  remove(id: string): void;
  get?(id: string): { type: string; user?: string | null } | null;
}

/** An HTTP or network failure talking to a repository host. `status` is null for network errors. */
export class RepoHostError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "RepoHostError";
  }
}

/** An environment variable's trimmed value (case-insensitive names on Windows), or null. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  let value = env[name];
  if (value === undefined && isWindows) {
    const upper = name.toUpperCase();
    const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
    if (key) value = env[key];
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** "AUTHORIZATION: basic <base64(user:token)>" for an http.<url>.extraheader git option. */
export function basicAuthHeader(user: string, token: string): string {
  const encoded = Buffer.from(`${user}:${token}`, "utf8").toString("base64");
  // Neither may show up in a tool's output or an error row.
  registerSecret(token);
  registerSecret(encoded);
  return `AUTHORIZATION: basic ${encoded}`;
}

/** A clamped positive integer (page numbers, page sizes). */
export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Whether every whitespace-separated term of `query` occurs in the repository's "owner/name". */
export function matchesQuery(repo: RepoInfo, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const name = repo.fullName.toLowerCase();
  return terms.every((t) => name.includes(t));
}

/** `first`, then the repositories of `second` that aren't in it (by "owner/name", ignoring case). */
export function mergeRepos(first: RepoInfo[], second: RepoInfo[]): RepoInfo[] {
  const seen = new Set<string>();
  const out: RepoInfo[] = [];
  for (const repo of [...first, ...second]) {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/** The own list has enough hits for a query below which a server-side search is added. */
export const ENOUGH_MATCHES = 10;

/** A string field, or null when missing / empty / not a string. */
export function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The "message" (or "error") an API put in an error body. */
export function bodyMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { message?: unknown; error?: unknown };
  return str(b.message)?.trim() || str(b.error)?.trim() || null;
}

/** Options for `createJsonGetter`. */
export interface JsonGetterOptions {
  fetchImpl: FetchLike;
  /** How long a successful answer is reused (default 60 s). */
  ttlMs?: number;
  /** How long one request may take (default 20 s). */
  timeoutMs?: number;
  now?: () => number;
  /** Turns a non-2xx answer into an error. `body` is the parsed JSON, or null. */
  httpError(res: Response, body: unknown): Error;
  /** Turns a failed request (no answer, timeout) into an error. */
  networkError(err: unknown): Error;
  /** The error for a 2xx answer that isn't JSON. */
  badBody(url: string): Error;
}

/**
 * A JSON GET with a small cache: answers are kept per (cacheKey, url) for `ttlMs`, and concurrent
 * requests for the same key share one fetch. Errors are never cached. `cacheKey` separates
 * identities (a token, or "" when anonymous) and stays in memory only.
 */
export function createJsonGetter(
  opts: JsonGetterOptions,
): (url: string, headers: Record<string, string>, cacheKey: string) => Promise<unknown> {
  const ttl = opts.ttlMs ?? 60_000;
  const timeout = opts.timeoutMs ?? 20_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();

  async function load(url: string, headers: Record<string, string>): Promise<unknown> {
    let res: Response;
    try {
      res = await opts.fetchImpl(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw opts.networkError(err);
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw opts.networkError(err);
    }
    let body: unknown;
    let parsed = true;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
      body = null;
    }
    if (!res.ok) throw opts.httpError(res, body);
    if (!parsed) throw opts.badBody(url);
    return body;
  }

  return (url, headers, cacheKey) => {
    const key = `${cacheKey}\n${url}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = load(url, headers);
    cache.set(key, { at: now(), value });
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  };
}

/** The text of a network error for messages ("fetch failed: getaddrinfo ENOTFOUND ..."). */
export function networkText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "no answer in time";
    const cause = err.cause instanceof Error ? err.cause.message : null;
    return cause && cause !== err.message ? `${err.message}: ${cause}` : err.message;
  }
  return String(err);
}

function joined(...parts: Array<string | undefined>): string | null {
  return parts.every((p) => typeof p === "string" && p) ? path.join(...(parts as string[])) : null;
}

/**
 * Where `git` or `gh` usually lives when it isn't on the PATH: Git for Windows / the GitHub CLI
 * installers and Scoop on Windows, Homebrew and the system on macOS, distro / Snap / Linuxbrew on
 * Linux.
 */
export function installCandidates(program: "git" | "gh", env: NodeJS.ProcessEnv = process.env): string[] {
  const list: Array<string | null> = [];
  if (isWindows) {
    const pf = envValue(env, "ProgramFiles") ?? "C:\\Program Files";
    const pf86 = envValue(env, "ProgramFiles(x86)") ?? undefined;
    const local = envValue(env, "LOCALAPPDATA") ?? undefined;
    const profile = envValue(env, "USERPROFILE") ?? undefined;
    if (program === "git") {
      list.push(joined(pf, "Git", "cmd", "git.exe"));
      list.push(joined(pf86, "Git", "cmd", "git.exe"));
      list.push(joined(local, "Programs", "Git", "cmd", "git.exe"));
    } else {
      list.push(joined(pf, "GitHub CLI", "gh.exe"));
      list.push(joined(local, "Programs", "GitHub CLI", "gh.exe"));
    }
    list.push(joined(profile, "scoop", "shims", `${program}.exe`));
  } else if (isMac) {
    list.push(`/opt/homebrew/bin/${program}`, `/usr/local/bin/${program}`, `/usr/bin/${program}`);
  } else {
    list.push(`/usr/bin/${program}`, `/usr/local/bin/${program}`, `/snap/bin/${program}`);
    list.push(`/home/linuxbrew/.linuxbrew/bin/${program}`);
  }
  return list.filter((p): p is string => Boolean(p));
}

/** `findProgram` for git / gh, with the usual install places as a fallback. */
export function findHostProgram(
  program: "git" | "gh",
  opts: { configured?: string | null; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = opts.env ?? process.env;
  return findProgram(program, { configured: opts.configured, env, extra: installCandidates(program, env) });
}
