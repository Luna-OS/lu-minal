// GitHub as a repository host: who is signed in, the user's repositories (or a public owner's /
// search results when anonymous), and the git options for cloning private repositories. A token
// comes from the auth store ("github"), GITHUB_TOKEN / GH_TOKEN, or the GitHub CLI (`gh auth
// token`), in that order.
import { runProgram } from "../platform/process.js";
import type { FetchLike } from "../providers/types.js";
import {
  basicAuthHeader,
  bodyMessage,
  clampInt,
  createJsonGetter,
  ENOUGH_MATCHES,
  envValue,
  findHostProgram,
  matchesQuery,
  mergeRepos,
  networkText,
  RepoHostError,
  str,
  type TokenStore,
} from "./shared.js";
import type { RepoHost, RepoHostAccount, RepoInfo, RepoQuery } from "./types.js";

/** GitHub's web base URL (RepoInfo.instance for GitHub repositories). */
export const GITHUB_INSTANCE = "https://github.com";
/** The REST API root. */
export const GITHUB_API = "https://api.github.com";
/** The auth store id of a GitHub token. */
export const GITHUB_TOKEN_ID = "github";

const MAX_PER_PAGE = 100;
const GH_TIMEOUT_MS = 8000;
/** How long "gh has no token" is believed before gh is asked again (a `gh auth login` may follow). */
const GH_MISS_TTL_MS = 10_000;
const AFFILIATION = "owner,collaborator,organization_member";

/** The page that creates a classic token with the scopes lu-minal needs. */
export function githubTokenUrl(): string {
  return "https://github.com/settings/tokens/new?scopes=repo,read:org&description=lu-minal";
}

/** Arguments for a browser sign-in with the GitHub CLI (`gh <args>` in the real terminal). */
export function ghLoginArgs(): string[] {
  return ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"];
}

/** Arguments that print the GitHub CLI's token for github.com. */
export function ghTokenArgs(): string[] {
  return ["auth", "token", "--hostname", "github.com"];
}

/** The GitHub CLI: a configured path, the PATH, or its usual install places. Null when missing. */
export function findGh(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  return findHostProgram("gh", { configured, env });
}

/** Options for `createGitHubHost`. */
export interface GitHubHostOptions {
  tokens: TokenStore;
  /** A user or organization whose public repositories are listed when nobody is signed in. */
  owner?: string | null;
  fetchImpl?: FetchLike;
  /**
   * The GitHub CLI. Undefined looks it up (PATH, then the usual install places) the first time a
   * token is needed; null never uses it.
   */
  ghPath?: string | null;
  runImpl?: typeof runProgram;
  env?: NodeJS.ProcessEnv;
  /** The clock for the caches (tests). */
  now?: () => number;
}

/** Where the token in use came from. */
interface Auth {
  token: string;
  via: "token" | "gh";
  from: "store" | "env" | "gh";
}

interface GitHubRepoJson {
  full_name?: unknown;
  name?: unknown;
  owner?: { login?: unknown } | null;
  description?: unknown;
  private?: unknown;
  fork?: unknown;
  clone_url?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
  pushed_at?: unknown;
  updated_at?: unknown;
  stargazers_count?: unknown;
  language?: unknown;
}

/** A GitHub API repository object as a RepoInfo, or null when it lacks the essentials. */
export function mapGitHubRepo(raw: unknown): RepoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as GitHubRepoJson;
  const fullName = str(r.full_name);
  const cloneUrl = str(r.clone_url);
  if (!fullName || !cloneUrl) return null;
  const slash = fullName.indexOf("/");
  const owner = str(r.owner?.login) ?? (slash > 0 ? fullName.slice(0, slash) : "");
  const name = str(r.name) ?? fullName.slice(slash + 1);
  return {
    host: "github",
    instance: GITHUB_INSTANCE,
    fullName,
    owner,
    name,
    description: str(r.description),
    private: r.private === true,
    fork: r.fork === true,
    cloneUrl,
    htmlUrl: str(r.html_url) ?? `${GITHUB_INSTANCE}/${fullName}`,
    defaultBranch: str(r.default_branch),
    updatedAt: str(r.pushed_at) ?? str(r.updated_at),
    stars: typeof r.stargazers_count === "number" ? r.stargazers_count : 0,
    language: str(r.language),
  };
}

function mapList(list: unknown[]): RepoInfo[] {
  return list.map(mapGitHubRepo).filter((r): r is RepoInfo => r !== null);
}

/** "Luna-OS" from "Luna-OS", "@Luna-OS", "https://github.com/Luna-OS/". Null when blank. */
export function normalizeOwner(owner: string | null | undefined): string | null {
  if (!owner) return null;
  const cleaned = owner
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "")
    .split("/")[0];
  return cleaned || null;
}

/** A typed query as GitHub search needs it. */
export interface GitHubQuery {
  /** What the own list is filtered by ("owner/name" text, matched against full names). */
  filter: string;
  /** GitHub search's q. */
  search: string;
  /** The query named an owner, so search hits are filtered by `filter` too. */
  scoped: boolean;
}

/**
 * Reads a query: a pasted repository URL ("https://github.com/Luna-OS/lu-minal.git",
 * "git@github.com:Luna-OS/lu-minal") becomes "Luna-OS/lu-minal"; "owner/name" searches
 * "name in:name user:owner" ("owner/" all of the owner's); anything else is searched as typed.
 */
export function parseGitHubQuery(input: string): GitHubQuery {
  let text = input.trim();
  const url = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@\s/]+@)?(?:www\.)?github\.com[:/]+([^/?#\s:]+)(?:\/([^/?#\s]*))?/i.exec(text);
  if (url) text = `${url[1]}/${url[2] ?? ""}`;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]*?)(?:\.git)?\/?$/.exec(text);
  if (!m) return { filter: text, search: text, scoped: false };
  const [, owner, name] = m;
  const filter = `${owner}/${name}`;
  return { filter, search: name ? `${name} in:name user:${owner}` : `user:${owner}`, scoped: true };
}

/** "14:05" (local time) for a Unix time in seconds. */
function clock(seconds: number): string {
  return new Date(seconds * 1000).toTimeString().slice(0, 5);
}

function githubError(res: Response, body: unknown): RepoHostError {
  const raw = bodyMessage(body) ?? (res.statusText || `HTTP ${res.status}`);
  // GitHub's rate-limit message ends with a long "(But here's the good news: ...)" advert.
  const message = raw.replace(/\s*\(But here's the good news[\s\S]*$/, "").trim();
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limited = res.status === 429 || (res.status === 403 && (remaining === "0" || /rate limit/i.test(raw)));
  if (limited) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` (resets at ${clock(reset)})` : "";
    return new RepoHostError(`GitHub says: ${message}${when} - sign in with /login github`, res.status);
  }
  if (res.status === 401 || res.status === 403) {
    return new RepoHostError(`GitHub says: ${message} - sign in with /login github`, res.status);
  }
  return new RepoHostError(`GitHub says: ${message} (HTTP ${res.status})`, res.status);
}

/**
 * GitHub as a RepoHost (kind "github", label "GitHub", instance "https://github.com").
 *
 * - The token is looked up on every call (store, then GITHUB_TOKEN / GH_TOKEN, then `gh auth
 *   token`), so a sign-in while the host lives is seen at once. gh's token is cached for the host's
 *   life; "gh has none" only for 10 s, and a gh token GitHub rejects (401) is forgotten.
 * - API answers are cached for 60 s per token, so filtering while typing doesn't refetch.
 * - `account()` saves the login next to a stored token (`tokens.set`) when it changed.
 */
export function createGitHubHost(opts: GitHubHostOptions): RepoHost {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const env = opts.env ?? process.env;
  const run = opts.runImpl ?? runProgram;
  const now = opts.now ?? Date.now;
  const owner = normalizeOwner(opts.owner);
  const get = createJsonGetter({
    fetchImpl,
    now,
    httpError: githubError,
    networkError: (err) => new RepoHostError(`Could not reach GitHub (${networkText(err)})`, null),
    badBody: (url) => new RepoHostError(`GitHub sent an answer lu-minal can't read (${url})`, null),
  });

  let ghPath: string | null | undefined = opts.ghPath;
  let ghToken: { at: number; value: Promise<string | null> } | null = null;
  let savedLoginFor: string | null = null;

  async function readGhToken(): Promise<string | null> {
    if (ghPath === undefined) ghPath = findGh(null, env);
    if (!ghPath) return null;
    try {
      const res = await run(ghPath, ghTokenArgs(), { env, timeoutMs: GH_TIMEOUT_MS });
      if (res.code !== 0 || res.timedOut) return null;
      const token = res.stdout.trim().split(/\r?\n/)[0]?.trim();
      return token && !/\s/.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  async function ghTokenCached(): Promise<string | null> {
    if (ghPath === null) return null;
    const cached = ghToken;
    if (cached) {
      const value = await cached.value;
      if (value !== null || now() - cached.at < GH_MISS_TTL_MS) return value;
      if (ghToken && ghToken !== cached) return ghToken.value;
    }
    const entry = { at: now(), value: readGhToken() };
    ghToken = entry;
    const value = await entry.value;
    entry.at = now();
    return value;
  }

  async function resolveAuth(): Promise<Auth | null> {
    let stored: string | null = null;
    try {
      stored = opts.tokens.secretFor(GITHUB_TOKEN_ID)?.trim() || null;
    } catch {
      stored = null;
    }
    if (stored) return { token: stored, via: "token", from: "store" };
    const fromEnv = envValue(env, "GITHUB_TOKEN") ?? envValue(env, "GH_TOKEN");
    if (fromEnv) return { token: fromEnv, via: "token", from: "env" };
    const fromGh = await ghTokenCached();
    if (fromGh) return { token: fromGh, via: "gh", from: "gh" };
    return null;
  }

  function headers(auth: Auth | null): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "lu-minal",
    };
    if (auth) h.authorization = `Bearer ${auth.token}`;
    return h;
  }

  /** A GET against the API; a 401 for gh's token makes the next call ask gh again. */
  async function api(pathAndQuery: string, auth: Auth | null): Promise<unknown> {
    try {
      return await get(`${GITHUB_API}${pathAndQuery}`, headers(auth), auth?.token ?? "");
    } catch (err) {
      if (auth?.from === "gh" && err instanceof RepoHostError && err.status === 401) ghToken = null;
      throw err;
    }
  }

  function saveLogin(auth: Auth, login: string | null): void {
    if (auth.from !== "store" || !login || savedLoginFor === auth.token) return;
    savedLoginFor = auth.token;
    try {
      const entry = opts.tokens.get?.(GITHUB_TOKEN_ID);
      if (entry && entry.user === login) return;
      opts.tokens.set(GITHUB_TOKEN_ID, { type: "token", token: auth.token, user: login });
    } catch {
      // Remembering the login is a convenience; a read-only config dir must not break the list.
    }
  }

  async function search(query: GitHubQuery, auth: Auth | null, page: number, perPage: number): Promise<RepoInfo[]> {
    let body: unknown;
    try {
      body = await api(`/search/repositories?q=${encodeURIComponent(query.search)}&per_page=${perPage}&page=${page}`, auth);
    } catch (err) {
      // 422: a query GitHub can't run (only operators, a qualifier for a missing user) has no hits.
      if (err instanceof RepoHostError && err.status === 422) return [];
      throw err;
    }
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new RepoHostError("GitHub sent search results lu-minal can't read", null);
    const found = mapList(items);
    return query.scoped ? found.filter((r) => matchesQuery(r, query.filter)) : found;
  }

  /** `own` filtered by the query, plus search results when that leaves fewer than ten. */
  async function withSearch(own: RepoInfo[], query: GitHubQuery | null, auth: Auth | null, page: number, perPage: number) {
    if (!query) return own;
    const matches = own.filter((r) => matchesQuery(r, query.filter));
    if (matches.length >= ENOUGH_MATCHES) return matches;
    let found: RepoInfo[];
    try {
      found = await search(query, auth, page, perPage);
    } catch (err) {
      if (matches.length > 0) return matches;
      throw err;
    }
    return mergeRepos(matches, found);
  }

  function listOf(body: unknown, what: string): RepoInfo[] {
    if (!Array.isArray(body)) throw new RepoHostError(`GitHub sent ${what} lu-minal can't read`, null);
    return mapList(body);
  }

  return {
    kind: "github",
    label: "GitHub",
    instance: GITHUB_INSTANCE,

    async account(): Promise<RepoHostAccount> {
      const auth = await resolveAuth();
      if (!auth) return { signedIn: false, login: null, via: "anonymous" };
      try {
        const user = (await api("/user", auth)) as { login?: unknown } | null;
        const login = str(user?.login);
        saveLogin(auth, login);
        return { signedIn: true, login, via: auth.via };
      } catch (err) {
        if (err instanceof RepoHostError && err.status === 401) return { signedIn: false, login: null, via: auth.via };
        throw err;
      }
    },

    async listRepos(q: RepoQuery): Promise<RepoInfo[]> {
      const text = (q.query ?? "").trim();
      const query = text ? parseGitHubQuery(text) : null;
      const page = clampInt(q.page, 1, 1, Number.MAX_SAFE_INTEGER);
      const perPage = clampInt(q.perPage, MAX_PER_PAGE, 1, MAX_PER_PAGE);
      const auth = await resolveAuth();
      if (auth) {
        const body = await api(`/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=${AFFILIATION}`, auth);
        return withSearch(listOf(body, "a repository list"), query, auth, page, perPage);
      }
      if (owner) {
        let body: unknown;
        try {
          body = await api(`/users/${encodeURIComponent(owner)}/repos?per_page=${perPage}&page=${page}&sort=pushed`, null);
        } catch (err) {
          if (err instanceof RepoHostError && err.status === 404) {
            throw new RepoHostError(`GitHub has no user or organization "${owner}" (github.owner in the config)`, 404);
          }
          throw err;
        }
        return withSearch(listOf(body, "a repository list"), query, null, page, perPage);
      }
      return query ? search(query, null, page, perPage) : [];
    },

    async gitAuthConfig(): Promise<string[]> {
      const auth = await resolveAuth();
      if (!auth) return [];
      return [`http.${GITHUB_INSTANCE}/.extraheader=${basicAuthHeader("x-access-token", auth.token)}`];
    },
  };
}
