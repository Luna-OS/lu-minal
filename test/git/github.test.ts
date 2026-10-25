import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitHubHost,
  ghLoginArgs,
  githubTokenUrl,
  mapGitHubRepo,
  normalizeOwner,
  parseGitHubQuery,
  type GitHubHostOptions,
} from "../../src/git/github.js";
import type { TokenStore } from "../../src/git/shared.js";
import type { RunResult } from "../../src/platform/process.js";
import { AuthStore } from "../../src/providers/auth.js";
import { fakeFetch, ghRepo, json, MemoryTokens, tempDir } from "./helpers.js";

const USER_REPOS =
  "https://api.github.com/user/repos?per_page=100&page=1&sort=pushed&affiliation=owner,collaborator,organization_member";

/** A fake `gh` runner: each call takes the next answer (the last one repeats). */
function fakeGh(...answers: Array<Partial<RunResult>>) {
  const calls: Array<{ exe: string; args: string[] }> = [];
  const run = (async (exe: string, args: string[]) => {
    calls.push({ exe, args });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)] ?? {};
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...a };
  }) as NonNullable<GitHubHostOptions["runImpl"]>;
  return { run, calls };
}

function host(opts: Partial<GitHubHostOptions> & { fetchImpl: GitHubHostOptions["fetchImpl"] }) {
  return createGitHubHost({ tokens: new MemoryTokens(), ghPath: null, env: {}, ...opts });
}

describe("GitHub helpers", () => {
  it("names the token page and the gh sign-in arguments", () => {
    expect(githubTokenUrl()).toBe("https://github.com/settings/tokens/new?scopes=repo,read:org&description=lu-minal");
    expect(ghLoginArgs()).toEqual(["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"]);
  });

  it("normalizes a configured owner", () => {
    expect(normalizeOwner("Luna-OS")).toBe("Luna-OS");
    expect(normalizeOwner(" @Luna-OS ")).toBe("Luna-OS");
    expect(normalizeOwner("https://github.com/Luna-OS/")).toBe("Luna-OS");
    expect(normalizeOwner("https://github.com/Luna-OS/lu-minal")).toBe("Luna-OS");
    expect(normalizeOwner("")).toBeNull();
    expect(normalizeOwner(null)).toBeNull();
  });

  it("reads pasted URLs and owner/name queries", () => {
    const scoped = { filter: "Luna-OS/lu-minal", search: "lu-minal in:name user:Luna-OS", scoped: true };
    expect(parseGitHubQuery("Luna-OS/lu-minal")).toEqual(scoped);
    expect(parseGitHubQuery(" https://github.com/Luna-OS/lu-minal ")).toEqual(scoped);
    expect(parseGitHubQuery("https://github.com/Luna-OS/lu-minal.git")).toEqual(scoped);
    expect(parseGitHubQuery("https://www.github.com/Luna-OS/lu-minal/tree/main/src")).toEqual(scoped);
    expect(parseGitHubQuery("git@github.com:Luna-OS/lu-minal.git")).toEqual(scoped);
    expect(parseGitHubQuery("github.com/Luna-OS/")).toEqual({ filter: "Luna-OS/", search: "user:Luna-OS", scoped: true });
    expect(parseGitHubQuery("luna/")).toEqual({ filter: "luna/", search: "user:luna", scoped: true });
    expect(parseGitHubQuery("moon app")).toEqual({ filter: "moon app", search: "moon app", scoped: false });
    expect(parseGitHubQuery("a/b/c")).toEqual({ filter: "a/b/c", search: "a/b/c", scoped: false });
  });

  it("maps a REST repository and drops ones without a name or clone URL", () => {
    expect(mapGitHubRepo(ghRepo("Luna-OS/lu-minal", { private: true, description: null }))).toEqual({
      host: "github",
      instance: "https://github.com",
      fullName: "Luna-OS/lu-minal",
      owner: "Luna-OS",
      name: "lu-minal",
      description: null,
      private: true,
      fork: false,
      cloneUrl: "https://github.com/Luna-OS/lu-minal.git",
      htmlUrl: "https://github.com/Luna-OS/lu-minal",
      defaultBranch: "main",
      updatedAt: "2026-10-24T18:30:00Z",
      stars: 42,
      language: "TypeScript",
    });
    expect(mapGitHubRepo(ghRepo("a/b", { pushed_at: null, language: null, stargazers_count: undefined }))).toMatchObject({
      updatedAt: "2026-10-20T08:00:00Z",
      language: null,
      stars: 0,
    });
    expect(mapGitHubRepo(ghRepo("a/b", { clone_url: undefined }))).toBeNull();
    expect(mapGitHubRepo({ name: "x" })).toBeNull();
    expect(mapGitHubRepo(null)).toBeNull();
  });
});

describe("GitHub host: tokens", () => {
  it("is anonymous without a token and asks nobody when there is nothing to list", async () => {
    const fetch = fakeFetch(() => json({}));
    const gh = createGitHubHost({ tokens: new MemoryTokens(), fetchImpl: fetch, ghPath: null, env: {} });
    expect(gh.kind).toBe("github");
    expect(gh.label).toBe("GitHub");
    expect(gh.instance).toBe("https://github.com");
    expect(await gh.account()).toEqual({ signedIn: false, login: null, via: "anonymous" });
    expect(await gh.listRepos({})).toEqual([]);
    expect(await gh.gitAuthConfig()).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it("reads the stored token, sends GitHub's headers and remembers the login once", async () => {
    const tokens = new MemoryTokens({ github: "ghp_stored" });
    const fetch = fakeFetch((url) => (url.pathname === "/user" ? json({ login: "luna", id: 1, type: "User" }) : json([], 404)));
    const gh = host({ tokens, fetchImpl: fetch });
    expect(await gh.account()).toEqual({ signedIn: true, login: "luna", via: "token" });
    expect(fetch.calls[0].url).toBe("https://api.github.com/user");
    const h = fetch.calls[0].headers;
    expect(h.get("authorization")).toBe("Bearer ghp_stored");
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("x-github-api-version")).toBe("2022-11-28");
    expect(h.get("user-agent")).toBe("lu-minal");
    expect(tokens.writes).toEqual([{ id: "github", entry: { type: "token", token: "ghp_stored", user: "luna" } }]);

    await gh.account();
    expect(fetch.calls).toHaveLength(1); // cached
    expect(tokens.writes).toHaveLength(1);
  });

  it("does not rewrite a stored login that is already right", async () => {
    const tokens = new MemoryTokens({ github: { type: "token", token: "ghp_x", user: "luna" } });
    const gh = host({ tokens, fetchImpl: fakeFetch(() => json({ login: "luna" })) });
    await gh.account();
    expect(tokens.writes).toEqual([]);
  });

  it("prefers the store, then GITHUB_TOKEN, then GH_TOKEN, and only then gh", async () => {
    const seen: Array<string | null> = [];
    const fetch = fakeFetch(() => json({ login: "someone" }));
    const gh = fakeGh({ stdout: "gho_from_cli\n" });
    const check = async (tokens: TokenStore, env: NodeJS.ProcessEnv) => {
      const h = createGitHubHost({ tokens, env, fetchImpl: fetch, ghPath: "/opt/gh", runImpl: gh.run });
      const account = await h.account();
      seen.push(fetch.calls.at(-1)?.headers.get("authorization") ?? null);
      return account.via;
    };
    const env = { GITHUB_TOKEN: " ghp_env1 ", GH_TOKEN: "ghp_env2" };
    expect(await check(new MemoryTokens({ github: "ghp_store" }), env)).toBe("token");
    expect(await check(new MemoryTokens(), env)).toBe("token");
    expect(await check(new MemoryTokens(), { GH_TOKEN: "ghp_env2", GITHUB_TOKEN: "  " })).toBe("token");
    expect(gh.calls).toHaveLength(0);
    expect(await check(new MemoryTokens(), {})).toBe("gh");
    expect(seen).toEqual(["Bearer ghp_store", "Bearer ghp_env1", "Bearer ghp_env2", "Bearer gho_from_cli"]);
    expect(gh.calls).toEqual([{ exe: "/opt/gh", args: ["auth", "token", "--hostname", "github.com"] }]);
  });

  it("caches gh's token for the host's life", async () => {
    const gh = fakeGh({ stdout: "gho_abc123\n" });
    const fetch = fakeFetch((url) => (url.pathname === "/user" ? json({ login: "luna" }) : json([ghRepo("luna/moon")])));
    const h = host({ fetchImpl: fetch, ghPath: "/usr/bin/gh", runImpl: gh.run });
    expect(await h.account()).toEqual({ signedIn: true, login: "luna", via: "gh" });
    expect((await h.listRepos({})).map((r) => r.fullName)).toEqual(["luna/moon"]);
    expect(await h.gitAuthConfig()).toHaveLength(1);
    expect(gh.calls).toHaveLength(1);
    expect(fetch.calls.every((c) => c.headers.get("authorization") === "Bearer gho_abc123")).toBe(true);
  });

  it("asks gh again 10 s after a miss, and after GitHub rejects gh's token", async () => {
    let clock = 1_000_000;
    const gh = fakeGh(
      { code: 1, stderr: "no oauth token found for github.com\n" },
      { stdout: "gho_new\n" },
      { stdout: "gho_new\n" },
    );
    let reject = false;
    const fetch = fakeFetch((url) => {
      if (reject) return json({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, 401);
      return url.pathname === "/user" ? json({ login: "luna" }) : json([]);
    });
    const h = host({ fetchImpl: fetch, ghPath: "gh", runImpl: gh.run, now: () => clock });
    expect((await h.account()).via).toBe("anonymous");
    clock += 5_000;
    expect((await h.account()).via).toBe("anonymous");
    expect(gh.calls).toHaveLength(1);
    clock += 6_000;
    expect(await h.account()).toEqual({ signedIn: true, login: "luna", via: "gh" });
    expect(gh.calls).toHaveLength(2);

    reject = true;
    await expect(h.listRepos({ query: "x", page: 2 })).rejects.toThrow("GitHub says: Bad credentials - sign in with /login github");
    await h.gitAuthConfig();
    expect(gh.calls).toHaveLength(3);
  });

  it("ignores gh output that isn't a token, and never runs gh when ghPath is null", async () => {
    const odd = fakeGh({ stdout: "To get started with GitHub CLI, please run:  gh auth login\n" });
    const h = host({ fetchImpl: fakeFetch(() => json({})), ghPath: "gh", runImpl: odd.run });
    expect((await h.account()).via).toBe("anonymous");

    const never = fakeGh({ stdout: "gho_x" });
    const off = host({ fetchImpl: fakeFetch(() => json({})), ghPath: null, runImpl: never.run });
    expect((await off.account()).via).toBe("anonymous");
    expect(await off.gitAuthConfig()).toEqual([]);
    expect(never.calls).toHaveLength(0);
  });

  it("builds the git auth header from the token", async () => {
    const h = host({ tokens: new MemoryTokens({ github: "ghp_secret" }), fetchImpl: fakeFetch(() => json({})) });
    const config = await h.gitAuthConfig();
    const b64 = Buffer.from("x-access-token:ghp_secret").toString("base64");
    expect(config).toEqual([`http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`]);
  });

  it("works with the real AuthStore and writes the login into auth.json", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = path.join(dir, "auth.json");
      const store: TokenStore = new AuthStore(file);
      store.set("github", { type: "token", token: "ghp_real" });
      const h = host({ tokens: store, fetchImpl: fakeFetch(() => json({ login: "luna" })) });
      expect((await h.account()).login).toBe("luna");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).github).toEqual({ type: "token", token: "ghp_real", user: "luna" });
    } finally {
      cleanup();
    }
  });
});

describe("GitHub host: listing", () => {
  let tokens: MemoryTokens;
  beforeEach(() => {
    tokens = new MemoryTokens({ github: "ghp_t" });
  });
  afterEach(() => {
    tokens.data.clear();
  });

  it("lists the user's repositories with GitHub's paging parameters", async () => {
    const fetch = fakeFetch(() => json([ghRepo("luna/moon-app"), ghRepo("Luna-OS/lu-minal", { fork: true }), { broken: true }]));
    const h = host({ tokens, fetchImpl: fetch });
    const list = await h.listRepos({});
    expect(fetch.calls[0].url).toBe(USER_REPOS);
    expect(list.map((r) => [r.fullName, r.fork])).toEqual([
      ["luna/moon-app", false],
      ["Luna-OS/lu-minal", true],
    ]);
    await h.listRepos({ page: 3, perPage: 250 });
    expect(fetch.calls[1].url).toBe(USER_REPOS.replace("&page=1&", "&page=3&"));
    await h.listRepos({ page: 0, perPage: 30 });
    expect(fetch.calls[2].url).toBe(USER_REPOS.replace("per_page=100", "per_page=30"));
  });

  it("filters by the query client side and doesn't search when there are enough hits", async () => {
    const own = Array.from({ length: 12 }, (_, i) => ghRepo(`luna/moon-${i}`)).concat([ghRepo("luna/sun")]);
    const fetch = fakeFetch(() => json(own));
    const h = host({ tokens, fetchImpl: fetch });
    expect(await h.listRepos({})).toHaveLength(13);
    const hits = await h.listRepos({ query: "  MOON " });
    expect(hits).toHaveLength(12);
    expect(hits.every((r) => r.name.startsWith("moon-"))).toBe(true);
    expect(fetch.calls.map((c) => c.url)).toEqual([USER_REPOS]); // one fetch for both, no search
  });

  it("matches every term of the query against owner/name", async () => {
    const own = [ghRepo("luna/moon-app"), ghRepo("vega/moon-app"), ghRepo("luna/sun"), ...Array.from({ length: 10 }, (_, i) => ghRepo(`luna/app-${i}`))];
    const h = host({ tokens, fetchImpl: fakeFetch(() => json(own)) });
    expect((await h.listRepos({ query: "luna app" })).map((r) => r.fullName)).toEqual([
      "luna/moon-app",
      ...Array.from({ length: 10 }, (_, i) => `luna/app-${i}`),
    ]);
  });

  it("adds search results when the own list has fewer than ten hits: own first, no duplicates", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/search/repositories") {
        return json({
          total_count: 2,
          incomplete_results: false,
          items: [ghRepo("luna/moon-app", { stargazers_count: 1 }), ghRepo("vega/moon-base")],
        });
      }
      return json([ghRepo("luna/moon-app"), ghRepo("luna/other")]);
    });
    const h = host({ tokens, fetchImpl: fetch });
    const list = await h.listRepos({ query: "moon app" });
    expect(list.map((r) => r.fullName)).toEqual(["luna/moon-app", "vega/moon-base"]);
    expect(list[0].stars).toBe(42); // the own entry wins
    expect(fetch.calls[1].url).toBe("https://api.github.com/search/repositories?q=moon%20app&per_page=100&page=1");
    expect(fetch.calls[1].headers.get("authorization")).toBe("Bearer ghp_t");
  });

  it("keeps the own hits when the search fails, and reports the failure when there are none", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname === "/search/repositories"
        ? json({ message: "API rate limit exceeded for user ID 1." }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793000000" })
        : json([ghRepo("luna/moon-app")]),
    );
    const h = host({ tokens, fetchImpl: fetch });
    expect((await h.listRepos({ query: "moon" })).map((r) => r.fullName)).toEqual(["luna/moon-app"]);
    await expect(h.listRepos({ query: "zzz" })).rejects.toThrow(/^GitHub says: API rate limit exceeded for user ID 1\. \(resets at \d\d:\d\d\) - sign in with \/login github$/);
  });

  it("treats a search GitHub can't run (422) as no hits", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname === "/search/repositories"
        ? json({ message: "Validation Failed", errors: [{ code: "invalid" }] }, 422)
        : json([]),
    );
    expect(await host({ tokens, fetchImpl: fetch }).listRepos({ query: "user:nobody-here" })).toEqual([]);
  });

  it("searches a pasted repository URL by owner and name, keeping matching full names", async () => {
    const fetch = fakeFetch(() =>
      json({ total_count: 3, incomplete_results: false, items: [ghRepo("Luna-OS/lu-minal"), ghRepo("Luna-OS/lu-minal-docs"), ghRepo("Luna-OS/old-lu-minal")] }),
    );
    const list = await host({ fetchImpl: fetch }).listRepos({ query: "https://github.com/Luna-OS/lu-minal.git" });
    expect(fetch.calls[0].url).toBe("https://api.github.com/search/repositories?q=lu-minal%20in%3Aname%20user%3ALuna-OS&per_page=100&page=1");
    expect(list.map((r) => r.fullName)).toEqual(["Luna-OS/lu-minal", "Luna-OS/lu-minal-docs"]);
  });

  it("lists a configured owner's public repositories when anonymous", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/users/Luna-OS/repos") return json([ghRepo("Luna-OS/lu-minal"), ghRepo("Luna-OS/moon-ui")]);
      return json({ total_count: 0, incomplete_results: false, items: [] });
    });
    const h = host({ owner: "@Luna-OS", fetchImpl: fetch });
    expect((await h.listRepos({})).map((r) => r.fullName)).toEqual(["Luna-OS/lu-minal", "Luna-OS/moon-ui"]);
    expect(fetch.calls[0].url).toBe("https://api.github.com/users/Luna-OS/repos?per_page=100&page=1&sort=pushed");
    expect(fetch.calls[0].headers.get("authorization")).toBeNull();
    expect((await h.listRepos({ query: "minal" })).map((r) => r.fullName)).toEqual(["Luna-OS/lu-minal"]);
    expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(["/users/Luna-OS/repos", "/search/repositories"]);
  });

  it("says so when the configured owner doesn't exist", async () => {
    const h = host({ owner: "no-such-owner-zz", fetchImpl: fakeFetch(() => json({ message: "Not Found" }, 404)) });
    await expect(h.listRepos({})).rejects.toThrow('GitHub has no user or organization "no-such-owner-zz"');
  });

  it("searches public repositories when anonymous with only a query", async () => {
    const fetch = fakeFetch(() => json({ total_count: 1, incomplete_results: false, items: [ghRepo("Luna-OS/lu-minal")] }));
    const h = host({ fetchImpl: fetch });
    const list = await h.listRepos({ query: "lu-minal", page: 2, perPage: 20 });
    expect(list.map((r) => r.fullName)).toEqual(["Luna-OS/lu-minal"]);
    expect(fetch.calls[0].url).toBe("https://api.github.com/search/repositories?q=lu-minal&per_page=20&page=2");
    expect(fetch.calls[0].headers.get("authorization")).toBeNull();
  });
});

describe("GitHub host: errors", () => {
  it("explains a rejected token and reports the account as signed out", async () => {
    const fetch = fakeFetch(() => json({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }, 401));
    const h = host({ tokens: new MemoryTokens({ github: "ghp_old" }), fetchImpl: fetch });
    expect(await h.account()).toEqual({ signedIn: false, login: null, via: "token" });
    await expect(h.listRepos({})).rejects.toThrow("GitHub says: Bad credentials - sign in with /login github");
  });

  it("trims GitHub's anonymous rate-limit advert and names the reset time", async () => {
    const reset = Math.floor(Date.UTC(2026, 9, 25, 14, 5) / 1000);
    const fetch = fakeFetch(() =>
      json(
        {
          message:
            "API rate limit exceeded for 203.0.113.7. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)",
          documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
        },
        403,
        { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      ),
    );
    const err = await host({ fetchImpl: fetch }).listRepos({ query: "moon" }).catch((e: Error) => e);
    const local = new Date(reset * 1000).toTimeString().slice(0, 5);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`GitHub says: API rate limit exceeded for 203.0.113.7. (resets at ${local}) - sign in with /login github`);
    expect((err as { status?: number }).status).toBe(403);
  });

  it("explains a 403 that isn't a rate limit (SSO, missing scope)", async () => {
    const fetch = fakeFetch(() =>
      json({ message: "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization." }, 403),
    );
    await expect(host({ tokens: new MemoryTokens({ github: "t" }), fetchImpl: fetch }).listRepos({})).rejects.toThrow(
      /^GitHub says: Resource protected by organization SAML enforcement\..* - sign in with \/login github$/,
    );
  });

  it("reports server errors, unreachable networks and unreadable answers", async () => {
    const tokens = new MemoryTokens({ github: "t" });
    await expect(host({ tokens, fetchImpl: fakeFetch(() => json({ message: "Server Error" }, 502)) }).listRepos({})).rejects.toThrow(
      "GitHub says: Server Error (HTTP 502)",
    );
    const offline = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
    });
    await expect(host({ tokens, fetchImpl: offline }).listRepos({})).rejects.toThrow(
      "Could not reach GitHub (fetch failed: getaddrinfo ENOTFOUND api.github.com)",
    );
    const html = fakeFetch(() => new Response("<html>captive portal</html>", { status: 200 }));
    await expect(host({ tokens, fetchImpl: html }).listRepos({})).rejects.toThrow("GitHub sent an answer lu-minal can't read");
    const weird = fakeFetch(() => json({ not: "a list" }));
    await expect(host({ tokens, fetchImpl: weird }).listRepos({})).rejects.toThrow("GitHub sent a repository list lu-minal can't read");
  });

  it("doesn't cache failures", async () => {
    let fail = true;
    const fetch = fakeFetch(() => (fail ? json({ message: "Server Error" }, 500) : json([ghRepo("a/b")])));
    const h = host({ tokens: new MemoryTokens({ github: "t" }), fetchImpl: fetch });
    await expect(h.listRepos({})).rejects.toThrow();
    fail = false;
    expect(await h.listRepos({})).toHaveLength(1);
    expect(fetch.calls).toHaveLength(2);
  });
});
