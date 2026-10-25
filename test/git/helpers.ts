// Shared helpers for the git tests: a routing fake fetch, an in-memory token store, realistic
// GitHub / Forgejo repository payloads, temp dirs, a real origin repository made with the real
// git, and a scripted fake git program (a Node script behind a sh / .cmd launcher).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TokenEntry, TokenStore } from "../../src/git/shared.js";
import type { FetchLike } from "../../src/providers/types.js";

export interface FetchCall {
  url: string;
  headers: Headers;
}

/** A fetch that answers with `respond` and records every call (URL and headers). */
export function fakeFetch(respond: (url: URL) => Response | Promise<Response>): FetchLike & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return respond(new URL(url));
  }) as FetchLike & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An in-memory TokenStore that records writes. */
export class MemoryTokens implements TokenStore {
  readonly data = new Map<string, TokenEntry>();
  readonly writes: Array<{ id: string; entry: TokenEntry }> = [];

  constructor(initial: Record<string, string | TokenEntry> = {}) {
    for (const [id, v] of Object.entries(initial)) {
      this.data.set(id, typeof v === "string" ? { type: "token", token: v } : v);
    }
  }

  secretFor(id: string): string | null {
    return this.data.get(id)?.token ?? null;
  }

  get(id: string): TokenEntry | null {
    return this.data.get(id) ?? null;
  }

  set(id: string, entry: TokenEntry): void {
    this.writes.push({ id, entry });
    this.data.set(id, entry);
  }

  remove(id: string): void {
    this.data.delete(id);
  }
}

/** A GitHub REST repository object, trimmed from a real /user/repos answer. */
export function ghRepo(fullName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    id: 812_345_678,
    node_id: "R_kgDOMGs1Tg",
    name,
    full_name: fullName,
    private: false,
    owner: { login: owner, id: 98_765, type: "Organization", site_admin: false },
    html_url: `https://github.com/${fullName}`,
    description: `${name} - a test repository`,
    fork: false,
    url: `https://api.github.com/repos/${fullName}`,
    created_at: "2024-01-02T10:00:00Z",
    updated_at: "2026-10-20T08:00:00Z",
    pushed_at: "2026-10-24T18:30:00Z",
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `https://github.com/${fullName}.git`,
    stargazers_count: 42,
    watchers_count: 42,
    language: "TypeScript",
    forks_count: 3,
    archived: false,
    visibility: "public",
    default_branch: "main",
    permissions: { admin: true, push: true, pull: true },
    ...extra,
  };
}

/** A Forgejo / Gitea API repository object, trimmed from a real Codeberg answer. */
export function fjRepo(fullName: string, extra: Record<string, unknown> = {}, instance = "https://codeberg.org"): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    id: 1_234_567,
    owner: { id: 4321, login: owner, username: owner, full_name: "", avatar_url: `${instance}/avatars/x` },
    name,
    full_name: fullName,
    description: "",
    empty: false,
    private: false,
    fork: false,
    template: false,
    mirror: false,
    size: 2048,
    language: "",
    html_url: `${instance}/${fullName}`,
    ssh_url: `ssh://git@${new URL(instance).host}/${fullName}.git`,
    clone_url: `${instance}/${fullName}.git`,
    website: "",
    stars_count: 7,
    forks_count: 1,
    watchers_count: 2,
    open_issues_count: 0,
    default_branch: "main",
    archived: false,
    created_at: "2025-03-01T09:00:00+01:00",
    updated_at: "2026-10-01T12:00:00+02:00",
    permissions: { admin: true, push: true, pull: true },
    ...extra,
  };
}

/** A new empty temp dir, removed by the returned cleanup. */
export function tempDir(prefix = "lu-minal-git-"): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/** Runs the real git for test fixtures (no system / global config, fixed identity). */
export function git(gitPath: string, args: string[], cwd: string): string {
  return execFileSync(gitPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(cwd, ".no-global-gitconfig"),
      GIT_AUTHOR_NAME: "Luna",
      GIT_AUTHOR_EMAIL: "luna@example.com",
      GIT_COMMITTER_NAME: "Luna",
      GIT_COMMITTER_EMAIL: "luna@example.com",
    },
  });
}

/** A bare origin repository with two commits; `url` is its file:// URL (git shows progress for it). */
export function makeOrigin(gitPath: string, root: string, name = "moon-app"): { bare: string; url: string } {
  const work = path.join(root, `${name}-work`);
  fs.mkdirSync(work, { recursive: true });
  git(gitPath, ["init", "-q"], work);
  fs.writeFileSync(path.join(work, "README.md"), `# ${name}\n`);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(work, `file-${i}.txt`), `line ${i}\n`.repeat(50 + i));
  git(gitPath, ["add", "-A"], work);
  git(gitPath, ["commit", "-q", "-m", "first"], work);
  fs.writeFileSync(path.join(work, "second.txt"), "second\n");
  git(gitPath, ["add", "-A"], work);
  git(gitPath, ["commit", "-q", "-m", "second"], work);
  const bare = path.join(root, "origins", `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(gitPath, ["clone", "-q", "--bare", work, bare], root);
  return { bare, url: pathToFileURL(bare).href };
}

/**
 * A fake git program in `dir`. `script` is the body of an ES module that sees `args` (argv after
 * the program) and `log(obj)` (appends one JSON line to `<dir>/git-log.jsonl`); it is preceded by
 * imports of fs and path. Returns the program path (a sh launcher, or a .cmd on Windows) and the
 * log reader.
 */
export function fakeGit(dir: string, script: string): { program: string; log: () => Array<Record<string, any>> } {
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "git-log.jsonl");
  const js = path.join(dir, "fake-git.mjs");
  fs.writeFileSync(
    js,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      `const log = (obj) => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(obj) + "\\n");`,
      script,
    ].join("\n"),
  );
  let program: string;
  if (process.platform === "win32") {
    program = path.join(dir, "git.cmd");
    fs.writeFileSync(program, `@"${process.execPath}" "${js}" %*\r\n`);
  } else {
    program = path.join(dir, "git");
    fs.writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    fs.chmodSync(program, 0o755);
  }
  return {
    program,
    log: () =>
      fs.existsSync(logFile)
        ? fs
            .readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, any>)
        : [],
  };
}
