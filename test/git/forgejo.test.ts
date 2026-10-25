import { describe, expect, it } from "vitest";
import {
  createForgejoHost,
  forgejoTokenId,
  forgejoTokenUrl,
  mapForgejoRepo,
  normalizeInstanceUrl,
  type ForgejoHostOptions,
} from "../../src/git/forgejo.js";
import { fakeFetch, fjRepo, json, MemoryTokens } from "./helpers.js";

const SEARCH = "https://codeberg.org/api/v1/repos/search";

function codeberg(opts: Partial<ForgejoHostOptions> & { fetchImpl: ForgejoHostOptions["fetchImpl"] }) {
  return createForgejoHost({ name: "Codeberg", url: "https://codeberg.org", tokens: new MemoryTokens(), ...opts });
}

const searchBody = (data: unknown[]) => json({ ok: true, data });

describe("Forgejo helpers", () => {
  it("normalizes what people type as an instance address", () => {
    const cases: Array<[string, string]> = [
      ["codeberg.org", "https://codeberg.org"],
      ["  Codeberg.org/ ", "https://codeberg.org"],
      ["https://codeberg.org///", "https://codeberg.org"],
      ["https://codeberg.org/api/v1", "https://codeberg.org"],
      ["https://codeberg.org/api/v1/", "https://codeberg.org"],
      ["https://git.example.com/API/V1/repos/search?q=x", "https://git.example.com"],
      ["http://localhost:3000", "http://localhost:3000"],
      ["git.example.com:8443/gitea/", "https://git.example.com:8443/gitea"],
      ["https://example.com/gitea/api/v1", "https://example.com/gitea"],
      ["https://codeberg.org/?tab=repos#top", "https://codeberg.org"],
      ["", ""],
    ];
    for (const [input, expected] of cases) expect(normalizeInstanceUrl(input), input).toBe(expected);
    expect(() => normalizeInstanceUrl("https://exa mple.com/")).not.toThrow();
  });

  it("names the token page and the token id", () => {
    expect(forgejoTokenUrl("https://codeberg.org")).toBe("https://codeberg.org/user/settings/applications");
    expect(forgejoTokenUrl("git.example.com/")).toBe("https://git.example.com/user/settings/applications");
    expect(forgejoTokenUrl("https://example.com/gitea")).toBe("https://example.com/gitea/user/settings/applications");
    expect(forgejoTokenId("https://codeberg.org")).toBe("forgejo:codeberg.org");
    expect(forgejoTokenId("Git.Example.com:3000/gitea")).toBe("forgejo:git.example.com");
  });

  it("maps a Forgejo repository (empty strings become null)", () => {
    expect(mapForgejoRepo(fjRepo("luna/moon-garden"), "https://codeberg.org")).toEqual({
      host: "forgejo",
      instance: "https://codeberg.org",
      fullName: "luna/moon-garden",
      owner: "luna",
      name: "moon-garden",
      description: null,
      private: false,
      fork: false,
      cloneUrl: "https://codeberg.org/luna/moon-garden.git",
      htmlUrl: "https://codeberg.org/luna/moon-garden",
      defaultBranch: "main",
      updatedAt: "2026-10-01T12:00:00+02:00",
      stars: 7,
      language: null,
    });
    const gitea = fjRepo("org/tool", { owner: { username: "org" }, description: "A tool", language: "Go", private: true, fork: true });
    expect(mapForgejoRepo(gitea, "https://git.example.com")).toMatchObject({
      owner: "org",
      description: "A tool",
      language: "Go",
      private: true,
      fork: true,
    });
    expect(mapForgejoRepo({ full_name: "a/b" }, "https://x.org")).toBeNull();
  });
});

describe("Forgejo host: anonymous", () => {
  it("searches the instance's public repositories", async () => {
    const fetch = fakeFetch(() => searchBody([fjRepo("luna/moon-garden"), fjRepo("vega/moonlight", { description: "Night tools" })]));
    const h = codeberg({ fetchImpl: fetch });
    expect(h.kind).toBe("forgejo");
    expect(h.label).toBe("Codeberg");
    expect(h.instance).toBe("https://codeberg.org");
    expect(await h.account()).toEqual({ signedIn: false, login: null, via: "anonymous" });
    const list = await h.listRepos({ query: "moon" });
    expect(list.map((r) => [r.fullName, r.description])).toEqual([
      ["luna/moon-garden", null],
      ["vega/moonlight", "Night tools"],
    ]);
    expect(fetch.calls[0].url).toBe(`${SEARCH}?q=moon&limit=50&page=1&sort=updated&order=desc`);
    expect(fetch.calls[0].headers.get("authorization")).toBeNull();
    expect(fetch.calls[0].headers.get("accept")).toBe("application/json");
    expect(await h.gitAuthConfig()).toEqual([]);
  });

  it("caps the page size at 50 and passes the page, also without a query", async () => {
    const fetch = fakeFetch(() => searchBody([]));
    const h = codeberg({ fetchImpl: fetch });
    await h.listRepos({ perPage: 100, page: 3 });
    await h.listRepos({ query: "c++ tools", perPage: 20 });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${SEARCH}?q=&limit=50&page=3&sort=updated&order=desc`,
      `${SEARCH}?q=c%2B%2B%20tools&limit=20&page=1&sort=updated&order=desc`,
    ]);
  });

  // An exact "owner/name" is looked up first (GET /repos/{owner}/{name}); here it doesn't exist.
  const missingExact = (url: URL) =>
    url.pathname.endsWith("/repos/search") ? null : json({ message: "not found" }, 404);

  it("searches by name for owner/name queries and keeps matching full names", async () => {
    const fetch = fakeFetch((url) => missingExact(url) ?? searchBody([fjRepo("luna/moon"), fjRepo("vega/moon"), fjRepo("luna/moonbase")]));
    const list = await codeberg({ fetchImpl: fetch }).listRepos({ query: "luna/moon" });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      "https://codeberg.org/api/v1/repos/luna/moon",
      `${SEARCH}?q=moon&limit=50&page=1&sort=updated&order=desc`,
    ]);
    expect(list.map((r) => r.fullName)).toEqual(["luna/moon", "luna/moonbase"]);
  });

  it("reads a pasted repository URL of the instance as owner/name", async () => {
    const fetch = fakeFetch((url) => missingExact(url) ?? searchBody([fjRepo("luna/moon"), fjRepo("vega/moon")]));
    const list = await codeberg({ fetchImpl: fetch }).listRepos({ query: "https://codeberg.org/luna/moon.git" });
    expect(fetch.calls[1].url).toBe(`${SEARCH}?q=moon&limit=50&page=1&sort=updated&order=desc`);
    expect(list.map((r) => r.fullName)).toEqual(["luna/moon"]);
  });

  it("puts the exact owner/name first even when the search doesn't find it", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname.endsWith("/repos/search") ? searchBody([fjRepo("other/fgj-fork")]) : json(fjRepo("romaintb/fgj")),
    );
    const list = await codeberg({ fetchImpl: fetch }).listRepos({ query: "romaintb/fgj" });
    expect(list.map((r) => r.fullName)[0]).toBe("romaintb/fgj");
  });

  it("reports a failed search ({ ok: false })", async () => {
    const fetch = fakeFetch(() => json({ ok: false, error: "search is not available" }, 500));
    await expect(codeberg({ fetchImpl: fetch }).listRepos({ query: "x" })).rejects.toThrow("Codeberg says: search is not available (HTTP 500)");
    const ok200 = fakeFetch(() => json({ ok: false, error: "indexer is still starting" }));
    await expect(codeberg({ fetchImpl: ok200 }).listRepos({ query: "x" })).rejects.toThrow("Codeberg says: indexer is still starting");
  });

  it("uses the instance's sub-path for the API", async () => {
    const fetch = fakeFetch(() => searchBody([fjRepo("team/app", {}, "https://example.com/gitea")]));
    const h = createForgejoHost({ name: "Work", url: "example.com/gitea/", tokens: new MemoryTokens(), fetchImpl: fetch });
    expect(h.instance).toBe("https://example.com/gitea");
    const [repo] = await h.listRepos({});
    expect(fetch.calls[0].url).toBe("https://example.com/gitea/api/v1/repos/search?q=&limit=50&page=1&sort=updated&order=desc");
    expect(repo).toMatchObject({ instance: "https://example.com/gitea", cloneUrl: "https://example.com/gitea/team/app.git" });
  });
});

describe("Forgejo host: signed in", () => {
  it("reads the account with the token header and remembers the login", async () => {
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "fj_token_1" });
    const fetch = fakeFetch(() => json({ id: 4321, login: "luna", username: "luna", email: "luna@noreply.codeberg.org" }));
    const h = codeberg({ tokens, fetchImpl: fetch });
    expect(await h.account()).toEqual({ signedIn: true, login: "luna", via: "token" });
    expect(fetch.calls[0].url).toBe("https://codeberg.org/api/v1/user");
    expect(fetch.calls[0].headers.get("authorization")).toBe("token fj_token_1");
    expect(tokens.writes).toEqual([{ id: "forgejo:codeberg.org", entry: { type: "token", token: "fj_token_1", user: "luna" } }]);
    await h.account();
    expect(tokens.writes).toHaveLength(1);
  });

  it("lists the user's repositories newest first, filtered client side", async () => {
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "t" });
    const own = [
      fjRepo("luna/old-moon", { updated_at: "2024-01-01T00:00:00Z" }),
      fjRepo("luna/no-date", { updated_at: undefined }),
      fjRepo("luna/new-moon", { updated_at: "2026-10-20T00:00:00Z", private: true }),
      ...Array.from({ length: 10 }, (_, i) => fjRepo(`team/moon-${i}`, { updated_at: `2025-0${(i % 9) + 1}-01T00:00:00Z` })),
    ];
    const fetch = fakeFetch(() => json(own));
    const h = codeberg({ tokens, fetchImpl: fetch });
    const all = await h.listRepos({ page: 2 });
    expect(fetch.calls[0].url).toBe("https://codeberg.org/api/v1/user/repos?limit=50&page=2");
    expect(fetch.calls[0].headers.get("authorization")).toBe("token t");
    expect(all[0].fullName).toBe("luna/new-moon");
    expect(all.at(-2)?.fullName).toBe("luna/old-moon");
    expect(all.at(-1)?.fullName).toBe("luna/no-date");
    const hits = await h.listRepos({ query: "moon", page: 2 });
    expect(hits).toHaveLength(12);
    expect(fetch.calls).toHaveLength(1); // cached, and enough hits: no search
  });

  it("adds the instance's search when the own list has few hits", async () => {
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "t" });
    const fetch = fakeFetch((url) =>
      url.pathname.endsWith("/repos/search")
        ? searchBody([fjRepo("luna/moon-garden"), fjRepo("forgejo/moon-theme")])
        : json([fjRepo("luna/moon-garden"), fjRepo("luna/sun")]),
    );
    const list = await codeberg({ tokens, fetchImpl: fetch }).listRepos({ query: "moon" });
    expect(list.map((r) => r.fullName)).toEqual(["luna/moon-garden", "forgejo/moon-theme"]);
    expect(fetch.calls[1].url).toBe(`${SEARCH}?q=moon&limit=50&page=1&sort=updated&order=desc`);
    expect(fetch.calls[1].headers.get("authorization")).toBe("token t");
  });

  it("keeps the own hits when the search fails", async () => {
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "t" });
    const fetch = fakeFetch((url) =>
      url.pathname.endsWith("/repos/search") ? json({ message: "Too Many Requests" }, 429) : json([fjRepo("luna/moon")]),
    );
    const h = codeberg({ tokens, fetchImpl: fetch });
    expect((await h.listRepos({ query: "moon" })).map((r) => r.fullName)).toEqual(["luna/moon"]);
    await expect(h.listRepos({ query: "zzz" })).rejects.toThrow("Codeberg says: Too Many Requests - try again in a minute");
  });

  it("builds the git auth header with the login, or oauth2 before it is known", async () => {
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "fj_secret" });
    const h = codeberg({ tokens, fetchImpl: fakeFetch(() => json({ login: "luna" })) });
    const header = (user: string) =>
      `http.https://codeberg.org/.extraheader=AUTHORIZATION: basic ${Buffer.from(`${user}:fj_secret`).toString("base64")}`;
    expect(await h.gitAuthConfig()).toEqual([header("oauth2")]);
    await h.account();
    expect(await h.gitAuthConfig()).toEqual([header("luna")]);

    const stored = new MemoryTokens({ "forgejo:codeberg.org": { type: "token", token: "fj_secret", user: "vega" } });
    expect(await codeberg({ tokens: stored, fetchImpl: fakeFetch(() => json({})) }).gitAuthConfig()).toEqual([header("vega")]);
  });

  it("explains a rejected token and reports the account as signed out", async () => {
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "expired" });
    const fetch = fakeFetch(() => json({ message: "user does not exist [uid: 0, name: ]", url: "https://codeberg.org/api/swagger" }, 401));
    const h = codeberg({ tokens, fetchImpl: fetch });
    expect(await h.account()).toEqual({ signedIn: false, login: null, via: "token" });
    await expect(h.listRepos({})).rejects.toThrow(
      "Codeberg says: user does not exist [uid: 0, name: ] - add a token for Codeberg with /login",
    );
  });
});

describe("Forgejo host: wrong addresses", () => {
  it("says when the address isn't a Forgejo / Gitea server", async () => {
    const html = fakeFetch(() => new Response("<!doctype html><title>GitLab</title>", { status: 200, headers: { "content-type": "text/html" } }));
    const h = createForgejoHost({ name: "Work", url: "gitlab.example.com", tokens: new MemoryTokens(), fetchImpl: html });
    await expect(h.listRepos({})).rejects.toThrow(
      "Work did not answer like a Forgejo or Gitea server - check the address https://gitlab.example.com",
    );
    const notFound = fakeFetch(() => new Response("404 page not found", { status: 404, statusText: "Not Found" }));
    const h2 = createForgejoHost({ name: "Work", url: "https://example.com", tokens: new MemoryTokens(), fetchImpl: notFound });
    await expect(h2.listRepos({})).rejects.toThrow("Work says: Not Found - is https://example.com a Forgejo or Gitea server?");
  });

  it("reports an unreachable instance", async () => {
    const offline = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3000") });
    });
    const h = createForgejoHost({ name: "", url: "http://localhost:3000", tokens: new MemoryTokens(), fetchImpl: offline });
    expect(h.label).toBe("localhost");
    await expect(h.listRepos({})).rejects.toThrow(
      "Could not reach localhost at http://localhost:3000 (fetch failed: connect ECONNREFUSED 127.0.0.1:3000)",
    );
  });
});
