// Cloning a repository into the projects folder (or finding the clone that is already there) and
// creating a new empty project, with git on Windows, macOS and Linux. Tokens never end up in the
// clone URL, the clone's .git/config or git's command line: the host's auth options reach git
// through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n (git 2.31+; older git gets
// `-c` options).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, isWindows } from "../platform/paths.js";
import { killTree, runProgram, spawnProgram } from "../platform/process.js";
import { findHostProgram } from "./shared.js";
import type { CloneProgress, RepoInfo } from "./types.js";

/** The message of the error for a missing git. */
export const GIT_MISSING_MESSAGE = "Git is not installed - get it from https://git-scm.com/downloads";

/** Git can't be found or doesn't run (e.g. macOS's /usr/bin/git without the developer tools). */
export class GitMissingError extends Error {
  constructor() {
    super(GIT_MISSING_MESSAGE);
    this.name = "GitMissingError";
  }
}

/** `git clone` failed. `message` is one line for a toast; `lines` has git's last stderr lines. */
export class CloneError extends Error {
  constructor(
    message: string,
    readonly lines: string[],
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "CloneError";
  }
}

/** Options for `cloneRepo`. */
export interface CloneOptions {
  /** The projects folder; the clone goes to <destRoot>/<repo name> ("~" is expanded). */
  destRoot: string;
  /** `git -c` style "key=value" options, usually `host.gitAuthConfig()`. Never written to disk. */
  gitConfig?: string[];
  onProgress?: (progress: CloneProgress) => void;
  /** Aborting kills git and removes the half-made folder; the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** The git program. Undefined looks it up (PATH, then the usual install places); null means none. */
  git?: string | null;
}

/** Protocols a clone may use (blocks `ext::` and other remote helpers a server could slip in). */
const ALLOWED_PROTOCOLS = "https:http:ssh:git:file";

/** Git: a configured path, the PATH, or its usual install places. Null when missing. */
export function findGit(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  return findHostProgram("git", { configured, env });
}

function resolveGit(git: string | null | undefined): string {
  const found = git === undefined ? findGit() : git;
  if (!found) throw new GitMissingError();
  return found;
}

const versions = new Map<string, Promise<[number, number]>>();

/** git's [major, minor] version ([0, 0] when unreadable); rejects with GitMissingError when it doesn't run. */
function gitVersion(git: string): Promise<[number, number]> {
  let cached = versions.get(git);
  if (!cached) {
    cached = runProgram(git, ["--version"], { timeoutMs: 20_000 }).then(
      (res) => {
        if (res.code !== 0) throw new GitMissingError();
        const m = /(\d+)\.(\d+)/.exec(res.stdout);
        return m ? ([Number(m[1]), Number(m[2])] as [number, number]) : ([0, 0] as [number, number]);
      },
      () => {
        throw new GitMissingError();
      },
    );
    versions.set(git, cached);
    cached.catch(() => versions.delete(git));
  }
  return cached;
}

/** "key=value" -> ["key", "value"]; a bare key means "true", like `git -c key`. */
function splitConfig(entry: string): [string, string] {
  const eq = entry.indexOf("=");
  return eq < 0 ? [entry, "true"] : [entry.slice(0, eq), entry.slice(eq + 1)];
}

/**
 * How `entries` reach git: GIT_CONFIG_COUNT / _KEY_n / _VALUE_n variables (appended after any the
 * environment already has) for git 2.31+, else `-c` arguments.
 */
export function gitConfigTransport(
  entries: string[],
  version: [number, number],
  env: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: Record<string, string> } {
  const list = entries.filter((e) => e && !e.startsWith("="));
  if (list.length === 0) return { args: [], env: {} };
  const [major, minor] = version;
  if (major < 2 || (major === 2 && minor < 31)) return { args: list.flatMap((e) => ["-c", e]), env: {} };
  const base = Math.max(0, Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0);
  const vars: Record<string, string> = { GIT_CONFIG_COUNT: String(base + list.length) };
  list.forEach((entry, i) => {
    const [key, value] = splitConfig(entry);
    vars[`GIT_CONFIG_KEY_${base + i}`] = key;
    vars[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  return { args: [], env: vars };
}

/** One stderr line of `git clone --progress` as progress ("Receiving objects:  42% (420/1000)" -> 42). */
export function parseCloneProgress(raw: string): CloneProgress | null {
  const line = raw.trim();
  if (!line) return null;
  const m = /(\d{1,3})%/.exec(line);
  const percent = m ? Math.min(100, Number(m[1])) : null;
  return { line, percent };
}

/**
 * A remote URL reduced to what identifies the repository: host and path, lower-cased, without
 * scheme, credentials, port, trailing slashes or ".git". "git@github.com:Luna-OS/lu-minal.git"
 * and "https://github.com/luna-os/lu-minal" give the same key; local paths and file:// URLs are
 * compared as resolved paths.
 */
export function remoteKey(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  let key: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      key = parsed.protocol === "file:"
        ? `file:${path.resolve(fileURLToPath(parsed))}`
        : `${parsed.hostname}${decodeURIComponent(parsed.pathname)}`;
    } catch {
      key = trimmed;
    }
  } else {
    // scp-like "user@host:path"; a one-letter "host" is a Windows drive ("C:\repo").
    const scp = /^(?:[^@/\\\s]+@)?([^:/\\\s]{2,}):(?!\/\/)(.*)$/.exec(trimmed);
    key = scp ? `${scp[1]}/${scp[2].replace(/^\/+/, "")}` : `file:${path.resolve(trimmed)}`;
  }
  return key.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

/** Whether two remote URLs point at the same repository (see `remoteKey`). */
export function sameRemote(a: string, b: string): boolean {
  return remoteKey(a) === remoteKey(b);
}

/**
 * A name that is a valid folder on Windows, macOS and Linux: characters Windows forbids become
 * "-", trailing dots / spaces go, reserved device names (CON, NUL, COM1, ...) get a "_" suffix.
 */
export function safeDirName(name: string): string {
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").trim().replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = `${out}_`;
  if (!out || out === "." || out === "..") out = "project";
  return out;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` is a git work tree of its own whose origin is `repo`. */
async function isCloneOf(git: string, dir: string, repo: RepoInfo): Promise<boolean> {
  // Without its own .git, `git -C` would answer for a repository the folder happens to sit in.
  if (!exists(path.join(dir, ".git"))) return false;
  try {
    const res = await runProgram(git, ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 20_000 });
    if (res.code !== 0) return false;
    const origin = res.stdout.trim();
    return Boolean(origin) && (sameRemote(origin, repo.cloneUrl) || sameRemote(origin, repo.htmlUrl));
  } catch {
    return false;
  }
}

function abortError(): Error {
  const err = new Error("The clone was cancelled.");
  err.name = "AbortError";
  return err;
}

/** Removes a folder git left behind, retrying while Windows still holds files in it. */
async function removeDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Nothing more to do; the next clone picks another name.
  }
}

function hostName(repo: RepoInfo): string {
  if (repo.host === "github") return "GitHub";
  try {
    return new URL(repo.instance).hostname;
  } catch {
    return repo.instance;
  }
}

function cloneFailure(repo: RepoInfo, tail: string[], code: number | null): CloneError {
  const lines = tail.filter((l) => !/^Cloning into\b/i.test(l)).slice(-6);
  const needsAuth = lines.some((l) =>
    /could not read (username|password)|terminal prompts disabled|authentication failed|returned error: 40[13]|invalid username or password/i.test(l),
  );
  let reason: string;
  if (needsAuth) {
    const how = repo.host === "github" ? "sign in with /login github" : "add a token with /login";
    reason = `${hostName(repo)} wants a sign-in for it - ${how}`;
  } else {
    const key = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1];
    reason = key ? key.replace(/^(fatal|error):\s*/i, "") : `git stopped with exit code ${code ?? "?"}`;
  }
  return new CloneError(`Could not clone ${repo.fullName}: ${reason}`, lines, code);
}

/** A clone URL git may be given: no option-like or `transport::address` forms. */
function checkCloneUrl(repo: RepoInfo): void {
  const url = repo.cloneUrl.trim();
  if (!url || url.startsWith("-") || /^[a-z][a-z0-9+.-]*::/i.test(url)) {
    throw new CloneError(`Could not clone ${repo.fullName}: the clone address "${url}" looks wrong`, [], null);
  }
}

async function runClone(git: string, repo: RepoInfo, dir: string, cwd: string, opts: CloneOptions): Promise<void> {
  const version = await gitVersion(git);
  if (opts.signal?.aborted) throw abortError();
  const transport = gitConfigTransport(opts.gitConfig ?? [], version);
  const args = [...transport.args, "clone", "--progress", "--", repo.cloneUrl.trim(), dir];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...transport.env,
    // Never let git ask for a password on the terminal the UI is drawing on.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL || ALLOWED_PROTOCOLS,
  };
  const child = spawnProgram(git, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group on macOS / Linux, so cancelling also stops git's helpers.
    detached: !isWindows,
  });

  const tail: string[] = [];
  let pending = "";
  let last = "";
  const handle = (raw: string) => {
    const progress = parseCloneProgress(raw);
    if (!progress) return;
    if (progress.percent === null) {
      tail.push(progress.line);
      if (tail.length > 30) tail.shift();
    }
    if (progress.line === last) return;
    last = progress.line;
    try {
      opts.onProgress?.(progress);
    } catch {
      // A failing progress display must not break the clone.
    }
  };
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const parts = (pending + chunk).split(/\r\n|\r|\n/);
    pending = parts.pop() ?? "";
    for (const part of parts) handle(part);
  });

  const onAbort = () => killTree(child);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      // `on`, not `once`: a late "error" (a failed kill) must never be an unhandled event.
      child.on("error", reject);
      child.once("close", (c) => resolve(c));
    });
  } catch (err) {
    opts.signal?.removeEventListener("abort", onAbort);
    await removeDir(dir);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new GitMissingError();
    throw err;
  }
  opts.signal?.removeEventListener("abort", onAbort);
  handle(pending);
  if (opts.signal?.aborted) {
    await removeDir(dir);
    throw abortError();
  }
  if (code !== 0) {
    await removeDir(dir);
    throw cloneFailure(repo, tail, code);
  }
}

/**
 * Clones `repo` into <destRoot>/<name> (the name made safe for every OS; destRoot is created).
 * A folder that already is a clone of the repository (its origin matches the clone or web URL,
 * ignoring case, ".git" and https-vs-ssh) is returned with `existed: true`; any other existing
 * folder makes it try <name>-2, <name>-3, ... (and reuses a matching clone found there).
 *
 * Rejects with GitMissingError when git is missing, CloneError when git fails (the half-made
 * folder is removed), or an AbortError when `signal` aborts (git is killed, the folder removed).
 */
export async function cloneRepo(repo: RepoInfo, opts: CloneOptions): Promise<{ dir: string; existed: boolean }> {
  if (opts.signal?.aborted) throw abortError();
  const git = resolveGit(opts.git);
  checkCloneUrl(repo);
  const root = path.resolve(expandHome(opts.destRoot));
  await fsp.mkdir(root, { recursive: true });
  const base = safeDirName(repo.name || repo.fullName.split("/").pop() || "repository");
  for (let n = 1; n < 1000; n++) {
    const dir = path.join(root, n === 1 ? base : `${base}-${n}`);
    if (!exists(dir)) {
      await runClone(git, repo, dir, root, opts);
      return { dir, existed: false };
    }
    if (await isCloneOf(git, dir, repo)) return { dir, existed: true };
    if (opts.signal?.aborted) throw abortError();
  }
  throw new CloneError(`Could not clone ${repo.fullName}: ${root} has no free folder name for it`, [], null);
}

/**
 * Creates <destRoot>/<name> (made safe for every OS; <name>-2, -3, ... when taken) with a
 * README.md ("# <name>") and runs `git init` in it when git is there (`git`: undefined looks it
 * up, null skips it; a failing `git init` is ignored). Resolves with the folder.
 */
export async function createEmptyProject(destRoot: string, name: string, git?: string | null): Promise<string> {
  const title = name.trim();
  if (!title) throw new Error("A new project needs a name.");
  const root = path.resolve(expandHome(destRoot));
  await fsp.mkdir(root, { recursive: true });
  const base = safeDirName(title);
  let dir = path.join(root, base);
  for (let n = 2; exists(dir); n++) dir = path.join(root, `${base}-${n}`);
  await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, "README.md"), `# ${title}\n`);
  const program = git === undefined ? findGit() : git;
  if (program) {
    try {
      await runProgram(program, ["init"], { cwd: dir, timeoutMs: 20_000 });
    } catch {
      // A project without git still works; the user can `git init` later.
    }
  }
  return dir;
}
