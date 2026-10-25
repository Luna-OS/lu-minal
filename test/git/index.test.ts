import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../../src/core/config.js";
import * as git from "../../src/git/index.js";
import { repoHosts } from "../../src/git/index.js";
import { fakeFetch, fjRepo, ghRepo, json, MemoryTokens } from "./helpers.js";

describe("repoHosts", () => {
  it("gives GitHub and Codeberg for the default config", () => {
    const hosts = repoHosts(defaultConfig(), new MemoryTokens(), { ghPath: null });
    expect(hosts.map((h) => [h.kind, h.label, h.instance])).toEqual([
      ["github", "GitHub", "https://github.com"],
      ["forgejo", "Codeberg", "https://codeberg.org"],
    ]);
  });

  it("normalizes instances, drops empty and repeated ones, and names unnamed ones by host", () => {
    const config = mergeConfig({
      forgejo: [
        { name: "Codeberg", url: "https://codeberg.org" },
        { name: "Codeberg again", url: "codeberg.org/" },
        { name: "Blank", url: "   " },
        { name: "", url: "git.example.com/api/v1" },
        { name: "GitHub mirror", url: "https://github.com" },
        null,
        { name: "No URL" },
      ],
    });
    const hosts = repoHosts(config, new MemoryTokens(), { ghPath: null });
    expect(hosts.map((h) => [h.label, h.instance])).toEqual([
      ["GitHub", "https://github.com"],
      ["Codeberg", "https://codeberg.org"],
      ["git.example.com", "https://git.example.com"],
    ]);
  });

  it("wires the config's GitHub owner, the token store and the injected fetch into the hosts", async () => {
    const config = mergeConfig({ github: { owner: "Luna-OS" }, forgejo: [{ name: "Codeberg", url: "https://codeberg.org" }] });
    const tokens = new MemoryTokens({ "forgejo:codeberg.org": "fj_t" });
    const fetch = fakeFetch((url) => {
      if (url.hostname === "api.github.com") return json([ghRepo("Luna-OS/lu-minal")]);
      return json([fjRepo("luna/moon-garden")]);
    });
    const [github, codeberg] = repoHosts(config, tokens, { fetchImpl: fetch, ghPath: null, env: {} });
    expect((await github.listRepos({})).map((r) => r.fullName)).toEqual(["Luna-OS/lu-minal"]);
    expect((await codeberg.listRepos({})).map((r) => r.fullName)).toEqual(["luna/moon-garden"]);
    expect(fetch.calls.map((c) => [c.url, c.headers.get("authorization")])).toEqual([
      ["https://api.github.com/users/Luna-OS/repos?per_page=100&page=1&sort=pushed", null],
      ["https://codeberg.org/api/v1/user/repos?limit=50&page=1", "token fj_t"],
    ]);
  });

  it("re-exports the whole module", () => {
    for (const name of [
      "createGitHubHost",
      "createForgejoHost",
      "cloneRepo",
      "createEmptyProject",
      "normalizeInstanceUrl",
      "forgejoTokenUrl",
      "forgejoTokenId",
      "githubTokenUrl",
      "ghLoginArgs",
      "findGit",
      "findGh",
      "RepoHostError",
      "GitMissingError",
      "CloneError",
    ]) {
      expect(typeof (git as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
