// A Forgejo or Gitea instance (Codeberg by default) as a repository host: who is signed in, the
// user's repositories or the instance's public search, and the git options for cloning private
// repositories. Tokens are stored as "forgejo:<hostname>".
import type { FetchLike } from "../providers/types.js";
import {
  basicAuthHeader,
  bodyMessage,
  clampInt,
  createJsonGetter,
  ENOUGH_MATCHES,
  matchesQuery,
  mergeRepos,
  networkText,
  RepoHostError,
  str,
  type TokenStore,
} from "./shared.js";
import type { RepoHost, RepoHostAccount, RepoInfo, RepoQuery } from "./types.js";

/** Forgejo / Gitea answer at most 50 items per page by default. */
const PAGE_SIZE = 50;

/**
 * An instance's web base URL from what a user typed: "codeberg.org", "https://Codeberg.org/",
 * "https://git.example.com/api/v1/repos/search" -> "https://codeberg.org",
 * "https://git.example.com". Adds https:// when no scheme is given, lower-cases the host, drops
 * the query, trailing slashes and an /api/v1 tail; keeps a sub-path ("https://x.org/gitea") and a
 * port. Never throws: input that isn't a URL comes back trimmed, without trailing slashes.
 */
export function normalizeInstanceUrl(input: string): string {
  let text = input.trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text.replace(/^\/+/, "")}`;
  try {
    const url = new URL(text);
    const pathname = url.pathname.replace(/\/api\/v1(\/.*)?$/i, "").replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return text.replace(/\/api\/v1(\/.*)?$/i, "").replace(/\/+$/, "");
  }
}

/** The instance's page for creating access tokens. */
export function forgejoTokenUrl(url: string): string {
  return `${normalizeInstanceUrl(url)}/user/settings/applications`;
}

/** The auth store id of an instance's token: "forgejo:codeberg.org". */
export function forgejoTokenId(url: string): string {
  const base = normalizeInstanceUrl(url);
  try {
    return `forgejo:${new URL(base).hostname}`;
  } catch {
    return `forgejo:${base}`;
  }
}

/** Options for `createForgejoHost`. */
export interface ForgejoHostOptions {
  /** The label: "Codeberg", "My Forgejo". */
  name: string;
  /** The web base URL (normalized with `normalizeInstanceUrl`). */
  url: string;
  tokens: TokenStore;
  fetchImpl?: FetchLike;
  /** The clock for the answer cache (tests). */
  now?: () => number;
}

interface ForgejoRepoJson {
  full_name?: unknown;
  name?: unknown;
  owner?: { login?: unknown; username?: unknown } | null;
  description?: unknown;
  private?: unknown;
  fork?: unknown;
  clone_url?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
  updated_at?: unknown;
  stars_count?: unknown;
  language?: unknown;
}

/** A Forgejo / Gitea API repository object as a RepoInfo, or null when it lacks the essentials. */
export function mapForgejoRepo(raw: unknown, instance: string): RepoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as ForgejoRepoJson;
  const fullName = str(r.full_name);
  const cloneUrl = str(r.clone_url);
  if (!fullName || !cloneUrl) return null;
  const slash = fullName.indexOf("/");
  const owner = str(r.owner?.login) ?? str(r.owner?.username) ?? (slash > 0 ? fullName.slice(0, slash) : "");
  return {
    host: "forgejo",
    instance,
    fullName,
    owner,
    name: str(r.name) ?? fullName.slice(slash + 1),
    description: str(r.description)?.trim() || null,
    private: r.private === true,
    fork: r.fork === true,
    cloneUrl,
    htmlUrl: str(r.html_url) ?? `${instance}/${fullName}`,
    defaultBranch: str(r.default_branch),
    updatedAt: str(r.updated_at),
    stars: typeof r.stars_count === "number" ? r.stars_count : 0,
    language: str(r.language),
  };
}

/** Newest update first; repositories without a time go last. */
function byUpdated(a: RepoInfo, b: RepoInfo): number {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) ? (Number.isNaN(tb) ? 0 : 1) : -1;
  return tb - ta;
}

/**
 * A Forgejo / Gitea instance as a RepoHost (kind "forgejo", label `name`, instance the normalized
 * `url`).
 *
 * - The token ("forgejo:<hostname>") is read from the store on every call; API answers are cached
 *   for 60 s per token, so filtering while typing doesn't refetch.
 * - Signed in: the user's repositories (newest first), filtered by the query; with fewer than ten
 *   hits the instance's search is added. Anonymous: the instance's public search.
 * - "owner/name" queries search for "name" and keep the hits whose full name matches.
 * - `account()` saves the login next to the token (`tokens.set`) when it changed; `gitAuthConfig()`
 *   uses that login, or "oauth2" before it is known (Forgejo accepts either with a token).
 */
export function createForgejoHost(opts: ForgejoHostOptions): RepoHost {
  const instance = normalizeInstanceUrl(opts.url);
  const label = opts.name.trim() || forgejoTokenId(instance).slice("forgejo:".length);
  const tokenId = forgejoTokenId(instance);
  const apiRoot = `${instance}/api/v1`;
  const signInHint = `add a token for ${label} with /login`;

  function httpError(res: Response, body: unknown): RepoHostError {
    const message = bodyMessage(body) ?? (res.statusText || `HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      return new RepoHostError(`${label} says: ${message} - ${signInHint}`, res.status);
    }
    if (res.status === 404) {
      return new RepoHostError(`${label} says: ${message} - is ${instance} a Forgejo or Gitea server?`, 404);
    }
    if (res.status === 429) return new RepoHostError(`${label} says: ${message} - try again in a minute`, 429);
    return new RepoHostError(`${label} says: ${message} (HTTP ${res.status})`, res.status);
  }

  const get = createJsonGetter({
    fetchImpl: opts.fetchImpl ?? (globalThis.fetch as FetchLike),
    now: opts.now,
    httpError,
    networkError: (err) => new RepoHostError(`Could not reach ${label} at ${instance} (${networkText(err)})`, null),
    badBody: () =>
      new RepoHostError(`${label} did not answer like a Forgejo or Gitea server - check the address ${instance}`, null),
  });

  /** Logins learned from /user, per token. */
  const logins = new Map<string, string | null>();
  let savedLoginFor: string | null = null;

  function token(): string | null {
    try {
      return opts.tokens.secretFor(tokenId)?.trim() || null;
    } catch {
      return null;
    }
  }

  function storedLogin(t: string): string | null {
    const known = logins.get(t);
    if (known) return known;
    try {
      return str(opts.tokens.get?.(tokenId)?.user);
    } catch {
      return null;
    }
  }

  function api(pathAndQuery: string, t: string | null): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "lu-minal" };
    if (t) headers.authorization = `token ${t}`;
    return get(`${apiRoot}${pathAndQuery}`, headers, t ?? "");
  }

  /** "luna/moon" from a pasted "https://codeberg.org/luna/moon.git"; other text as typed. */
  function stripInstance(text: string): string {
    const trimmed = text.trim();
    const prefix = `${instance.replace(/^https?:\/\//i, "")}/`.toLowerCase();
    const bare = trimmed.replace(/^https?:\/\//i, "");
    if (!bare.toLowerCase().startsWith(prefix)) return trimmed;
    const [owner = "", name = ""] = bare.slice(prefix.length).split(/[/?#]/);
    return `${owner}/${name.replace(/\.git$/i, "")}`;
  }

  function unreadable(what: string): RepoHostError {
    return new RepoHostError(`${label} sent ${what} lu-minal can't read`, null);
  }

  function mapAll(list: unknown[]): RepoInfo[] {
    return list.map((raw) => mapForgejoRepo(raw, instance)).filter((r): r is RepoInfo => r !== null);
  }

  async function search(query: string, t: string | null, page: number, limit: number): Promise<RepoInfo[]> {
    // The search matches repository names; for "owner/name" ask for "name" and filter below.
    const slash = query.lastIndexOf("/");
    const keyword = slash >= 0 ? query.slice(slash + 1).trim() : query;
    const body = (await api(
      `/repos/search?q=${encodeURIComponent(keyword)}&limit=${limit}&page=${page}&sort=updated&order=desc`,
      t,
    )) as { ok?: unknown; data?: unknown; error?: unknown } | null;
    if (body && body.ok === false) {
      throw new RepoHostError(`${label} says: ${bodyMessage(body) ?? "the search failed"}`, null);
    }
    if (!body || !Array.isArray(body.data)) throw unreadable("search results");
    const found = mapAll(body.data);
    return slash >= 0 ? found.filter((r) => matchesQuery(r, query)) : found;
  }

  return {
    kind: "forgejo",
    label,
    instance,

    async account(): Promise<RepoHostAccount> {
      const t = token();
      if (!t) return { signedIn: false, login: null, via: "anonymous" };
      let user: { login?: unknown; username?: unknown } | null;
      try {
        user = (await api("/user", t)) as typeof user;
      } catch (err) {
        if (err instanceof RepoHostError && err.status === 401) return { signedIn: false, login: null, via: "token" };
        throw err;
      }
      const login = str(user?.login) ?? str(user?.username);
      logins.set(t, login);
      if (login && savedLoginFor !== t) {
        savedLoginFor = t;
        try {
          if (opts.tokens.get?.(tokenId)?.user !== login) opts.tokens.set(tokenId, { type: "token", token: t, user: login });
        } catch {
          // Remembering the login is a convenience; a read-only config dir must not break the list.
        }
      }
      return { signedIn: true, login, via: "token" };
    },

    async listRepos(q: RepoQuery): Promise<RepoInfo[]> {
      const query = stripInstance(q.query ?? "");
      const page = clampInt(q.page, 1, 1, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(q.perPage, PAGE_SIZE, 1, PAGE_SIZE);
      const t = token();
      if (!t) return search(query, null, page, limit);
      const body = await api(`/user/repos?limit=${limit}&page=${page}`, t);
      if (!Array.isArray(body)) throw unreadable("a repository list");
      const own = mapAll(body).sort(byUpdated);
      if (!query) return own;
      const matches = own.filter((r) => matchesQuery(r, query));
      if (matches.length >= ENOUGH_MATCHES) return matches;
      let found: RepoInfo[];
      try {
        found = await search(query, t, page, limit);
      } catch (err) {
        if (matches.length > 0) return matches;
        throw err;
      }
      return mergeRepos(matches, found);
    },

    async gitAuthConfig(): Promise<string[]> {
      const t = token();
      if (!t) return [];
      return [`http.${instance}/.extraheader=${basicAuthHeader(storedLogin(t) ?? "oauth2", t)}`];
    },
  };
}
