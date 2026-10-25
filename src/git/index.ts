// The repository hosts a new tab can open projects from: GitHub first, then every Forgejo / Gitea
// instance in the config (Codeberg by default). Re-exports the whole git module.
import type { Config } from "../core/config.js";
import type { runProgram } from "../platform/process.js";
import type { FetchLike } from "../providers/types.js";
import { createForgejoHost, normalizeInstanceUrl } from "./forgejo.js";
import { createGitHubHost } from "./github.js";
import type { TokenStore } from "./shared.js";
import type { RepoHost } from "./types.js";

export * from "./clone.js";
export * from "./forgejo.js";
export * from "./github.js";
export * from "./shared.js";
export type * from "./types.js";

/** What `repoHosts` passes on to the hosts (tests inject fakes). */
export interface RepoHostDeps {
  fetchImpl?: FetchLike;
  /** The GitHub CLI; undefined looks it up, null never uses it. */
  ghPath?: string | null;
  runImpl?: typeof runProgram;
  env?: NodeJS.ProcessEnv;
}

/**
 * The hosts for the config: GitHub (anonymous listing of `config.github.owner`), then each
 * `config.forgejo` instance in order. Instances with an empty URL, and repeats of the same
 * (normalized) URL, are left out, so every host's `instance` is unique. Hosts cache API answers
 * and the gh token, so create them once per dialog rather than per keystroke.
 */
export function repoHosts(config: Config, tokens: TokenStore, deps: RepoHostDeps = {}): RepoHost[] {
  const hosts: RepoHost[] = [
    createGitHubHost({
      tokens,
      owner: config.github?.owner ?? null,
      fetchImpl: deps.fetchImpl,
      ghPath: deps.ghPath,
      runImpl: deps.runImpl,
      env: deps.env,
    }),
  ];
  const seen = new Set<string>([hosts[0].instance.toLowerCase()]);
  for (const instance of Array.isArray(config.forgejo) ? config.forgejo : []) {
    if (!instance || typeof instance.url !== "string") continue;
    const url = normalizeInstanceUrl(instance.url);
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    const name = typeof instance.name === "string" ? instance.name : "";
    hosts.push(createForgejoHost({ name, url, tokens, fetchImpl: deps.fetchImpl }));
  }
  return hosts;
}
