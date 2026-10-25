// The shell tool. On macOS and Linux it runs bash (or sh); on Windows it prefers Git Bash and
// falls back to PowerShell 7, Windows PowerShell and finally cmd.exe, and its description tells the
// model which one it got. Commands that plainly only read (ls, cat, git status, rg, ...) run without
// an approval; everything else is an "exec" the permission mode decides on.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killTree, spawnProgram } from "../platform/process.js";
import type { RiskKind } from "../core/types.js";
import { clip, defineTool, displayPath, resolvePath } from "./fs.js";
import type { Tool, ToolResult } from "./types.js";

// ---- choosing a shell ---------------------------------------------------------------------------

export interface ShellInfo {
  kind: "bash" | "powershell" | "cmd";
  /** The program to start. */
  exe: string;
  /** The arguments that make it run `command` and exit. */
  args(command: string): string[];
  /** What the model and the user are told: "bash", "Git Bash", "PowerShell 7", ... */
  name: string;
  /** Pass the arguments to the program as they are (cmd.exe's quoting). */
  verbatim?: boolean;
}

const defaultExists = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Looks `names` up on the PATH of `env`, with the path flavour of `platform`. */
function onPath(names: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (f: string) => boolean): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (exists(candidate)) out.push(candidate);
    }
  }
  return out;
}

const POWERSHELL_PREAMBLE =
  "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ";

/**
 * The shell the bash tool uses on `platform`: bash (or sh) on macOS / Linux; on Windows Git Bash
 * (Program Files, Program Files (x86), %LOCALAPPDATA%\Programs\Git, or a bash.exe on the PATH that
 * is not WSL's launcher in System32), else pwsh, else Windows PowerShell, else cmd.exe.
 * Called without arguments it looks once and remembers the answer; `exists` is for tests.
 */
export function detectShell(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, exists?: (file: string) => boolean): ShellInfo {
  // The plain call (the Hub asks for every prompt) looks once per process.
  if (platform === undefined && env === undefined && exists === undefined) {
    cachedShell ??= findShell(process.platform, process.env, defaultExists);
    return cachedShell;
  }
  return findShell(platform ?? process.platform, env ?? process.env, exists ?? defaultExists);
}

let cachedShell: ShellInfo | null = null;

function findShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): ShellInfo {
  if (platform !== "win32") {
    const bash = [
      ...(env.SHELL && path.posix.basename(env.SHELL) === "bash" && exists(env.SHELL) ? [env.SHELL] : []),
      ...onPath(["bash"], platform, env, exists),
      "/bin/bash",
      "/usr/bin/bash",
      "/usr/local/bin/bash",
      "/opt/homebrew/bin/bash",
    ].find((f) => exists(f));
    if (bash) return { kind: "bash", exe: bash, args: (c) => ["-c", c], name: "bash" };
    const sh = ["/bin/sh", ...onPath(["sh"], platform, env, exists)].find((f) => exists(f)) ?? "/bin/sh";
    return { kind: "bash", exe: sh, args: (c) => ["-c", c], name: "sh" };
  }

  const w = path.win32;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(Boolean) as string[];
  const gitCandidates = [
    ...roots.flatMap((r) => [w.join(r, "Git", "bin", "bash.exe"), w.join(r, "Git", "usr", "bin", "bash.exe")]),
    ...(env.LOCALAPPDATA ? [w.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")] : []),
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  const system32 = w.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32").toLowerCase();
  const isWslLauncher = (f: string) => {
    const dir = w.dirname(f).toLowerCase();
    return dir === system32 || dir.endsWith("\\system32") || dir.includes("\\windowsapps");
  };
  // Git installed elsewhere: its git.exe on the PATH (<git>\cmd\git.exe) points at <git>\bin\bash.exe.
  const fromGit = onPath(["git.exe"], platform, env, exists).map((git) => w.join(w.dirname(w.dirname(git)), "bin", "bash.exe"));
  const gitBash =
    gitCandidates.find((f) => exists(f)) ??
    fromGit.find((f) => exists(f)) ??
    onPath(["bash.exe"], platform, env, exists).find((f) => !isWslLauncher(f));
  if (gitBash) return { kind: "bash", exe: gitBash, args: (c) => ["-c", c], name: "Git Bash" };

  const psArgs = (c: string) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_PREAMBLE + c];
  const pwsh =
    onPath(["pwsh.exe"], platform, env, exists)[0] ??
    roots.map((r) => w.join(r, "PowerShell", "7", "pwsh.exe")).find((f) => exists(f));
  if (pwsh) return { kind: "powershell", exe: pwsh, args: psArgs, name: "PowerShell 7" };
  const winPs =
    [w.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((f) =>
      exists(f),
    ) ?? onPath(["powershell.exe"], platform, env, exists)[0];
  if (winPs) return { kind: "powershell", exe: winPs, args: psArgs, name: "Windows PowerShell" };
  const cmd = env.ComSpec || "cmd.exe";
  return { kind: "cmd", exe: cmd, args: (c) => ["/d", "/s", "/c", `"${c}"`], name: "cmd.exe", verbatim: true };
}

// ---- read-only commands -------------------------------------------------------------------------

const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "which",
  "where",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "date",
  "whoami",
  "uname",
  "basename",
  "dirname",
  "realpath",
  "type",
  "dir",
  "cd",
  "true",
  "get-childitem",
  "gci",
  "get-content",
  "gc",
  "get-location",
  "gl",
  "select-string",
  "sls",
  "test-path",
  "resolve-path",
  "get-item",
  "gi",
]);

const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "shortlog"]);
const FIND_WRITES = new Set(["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const GIT_BRANCH_WRITES = /^(?:-[dDmMcCf]|--delete|--move|--copy|--force|--set-upstream-to|-u|--unset-upstream|--edit-description)/;
const NULL_TARGETS = new Set(["/dev/null", "nul", "$null", "NUL"]);

interface Parsed {
  /** Each simple command's words, quotes removed. */
  segments: string[][];
  /** Something that runs or writes regardless of the commands (redirects, substitutions, "&"). */
  unsafe: boolean;
}

/**
 * Splits a command line at unquoted `;`, `&&`, `||`, `|`, `|&` and newlines, notes redirects to
 * files, command substitution (`$( )`, backticks, `<( )`) and background jobs.
 */
function parseCommand(command: string): Parsed {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let unsafe = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) unsafe = true;
      else if (ch === "\\" && next !== undefined) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(") || ((ch === "<" || ch === ">") && next === "(")) {
      unsafe = true;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      endSegment();
      continue;
    }
    if (ch === "&") {
      if (next === "&") {
        i++;
        endSegment();
      } else if (command[i - 1] === ">" || command[i - 1] === "<") {
        // "2>&1" handled with the redirect below.
        word += ch;
        inWord = true;
      } else {
        unsafe = true; // a background job
        endSegment();
      }
      continue;
    }
    if (ch === "|") {
      if (next === "|" || next === "&") i++;
      endSegment();
      continue;
    }
    if (ch === ">" || ch === "<") {
      // A redirect: fine when it duplicates a stream ("2>&1") or goes to the null device.
      let j = i + 1;
      if (ch === ">" && command[j] === ">") j++;
      if (command[j] === "&") {
        j++;
        while (/[0-9-]/.test(command[j] ?? "")) j++;
        // Drop a preceding fd number ("2") from the word.
        if (/^\d+$/.test(word)) {
          word = "";
          inWord = false;
        }
        i = j - 1;
        continue;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      let target = "";
      while (j < command.length && !/[\s;&|<>]/.test(command[j])) target += command[j++];
      target = target.replace(/^["']|["']$/g, "");
      if (ch === "<") {
        // Reading a file in is harmless; the target is not a command word.
      } else if (!NULL_TARGETS.has(target) && !NULL_TARGETS.has(target.toLowerCase())) {
        unsafe = true;
      }
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      i = j - 1;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) unsafe = true; // unbalanced quotes: don't guess
  endSegment();
  return { segments, unsafe };
}

function segmentReadOnly(words: string[]): boolean {
  const [first, ...rest] = words;
  if (!first) return true;
  // "FOO=1 cmd" changes the environment of whatever runs; not plainly read-only.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false;
  const name = path.posix.basename(first.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
  if (name === "git") {
    let args = rest;
    while (args[0] === "--no-pager" || args[0] === "-P") args = args.slice(1);
    const sub = args[0];
    if (!sub || !GIT_READ_ONLY.has(sub)) return false;
    const subArgs = args.slice(1);
    if (subArgs.some((a) => a.startsWith("--output") || a === "--ext-diff")) return false;
    if (sub === "branch") return subArgs.every((a) => a.startsWith("-") && !GIT_BRANCH_WRITES.test(a));
    return true;
  }
  if (!READ_ONLY.has(name)) return false;
  if (name === "find") return !rest.some((a) => FIND_WRITES.has(a));
  if (name === "rg") return !rest.some((a) => a === "--pre" || a.startsWith("--pre="));
  return true;
}

/** "read" for commands that plainly only look (ls, cat, git status, rg, ...), else "exec". */
export function classifyCommand(command: string): RiskKind {
  if (typeof command !== "string" || !command.trim()) return "exec";
  const parsed = parseCommand(command);
  if (parsed.unsafe || !parsed.segments.length) return "exec";
  return parsed.segments.every(segmentReadOnly) ? "read" : "exec";
}

/** What "always allow" remembers for a command: "bash:<first two words>". */
export function commandAllowKey(command: string): string {
  const words = parseCommand(command).segments[0] ?? [];
  return `bash:${words.slice(0, 2).join(" ")}`.trim();
}

// ---- running ------------------------------------------------------------------------------------

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Removes colour codes and other terminal escapes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Normalizes line ends and keeps only the last state of "\r"-redrawn lines (progress bars). */
function cleanOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const cr = line.lastIndexOf("\r");
      return cr === -1 ? line : line.slice(cr + 1);
    })
    .join("\n");
}

/** Keeps the first and last `max / 2` characters of a long output. */
class OutputBuffer {
  private head = "";
  private tail = "";
  private total = 0;
  constructor(private readonly max: number) {}

  push(chunk: string): void {
    this.total += chunk.length;
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.max) this.tail = this.tail.slice(-half);
  }

  text(): string {
    if (this.total <= this.max) return cleanOutput(this.head + this.tail);
    const half = Math.floor(this.max / 2);
    // Cut at line ends where that loses little.
    let head = this.head;
    const headEnd = head.lastIndexOf("\n");
    if (headEnd > half / 2) head = head.slice(0, headEnd + 1);
    let tail = this.tail.slice(-half);
    const tailStart = tail.indexOf("\n");
    if (tailStart !== -1 && tailStart < half / 2) tail = tail.slice(tailStart + 1);
    const omitted = this.total - head.length - tail.length;
    return `${cleanOutput(head).replace(/\n$/, "")}\n\n… [${omitted} characters of output omitted] …\n\n${cleanOutput(tail)}`;
  }
}

/** Folders macOS apps started from the Dock or Finder often lack on their PATH. */
const MAC_PATH_EXTRAS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

/**
 * The environment commands run with: the app's own, with pagers and git prompts turned off (no
 * terminal to answer them). On macOS, Homebrew's folders are appended to the PATH when missing,
 * since an app started outside a terminal (the Swift app) gets a bare system PATH.
 */
export function shellEnv(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LU_MINAL: "1" };
  if (platform === "darwin") {
    const parts = (out.PATH ?? "").split(":").filter(Boolean);
    for (const dir of MAC_PATH_EXTRAS) if (!parts.includes(dir)) parts.push(dir);
    out.PATH = parts.join(":");
  }
  return out;
}

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Runs `command` in `shell`, collecting stdout and stderr interleaved (ANSI stripped, at most
 * `maxOutput` characters keeping the head and the tail). On POSIX the command gets its own process
 * group, which is killed on abort or timeout; on Windows the whole tree is killed.
 */
export function runCommand(opts: {
  shell: ShellInfo;
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutput?: number;
}): Promise<ExecResult> {
  const posix = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    // POSIX shells send stderr down the stdout pipe, so both arrive in the order they were written
    // (same line, so error messages keep their line numbers).
    const command = opts.shell.kind === "bash" ? `exec 2>&1; ${opts.command}` : opts.command;
    try {
      child = spawnProgram(opts.shell.exe, opts.shell.args(command), {
        cwd: opts.cwd,
        env: shellEnv(process.platform, opts.env ?? process.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: posix,
        windowsVerbatimArguments: opts.shell.verbatim,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = new OutputBuffer(opts.maxOutput ?? MAX_OUTPUT);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let hardKill: NodeJS.Timeout | null = null;
    const kill = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      if (!posix) {
        killTree(child);
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      hardKill = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 2000);
      hardKill.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => out.push(d));
    child.stderr?.on("data", (d: string) => out.push(d));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, output: out.text(), timedOut, aborted });
    };
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    // "close" waits for the pipes; a background child holding them open would keep it from coming,
    // so "exit" plus a short grace period ends the call too.
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 500).unref();
    });
  });
}

/** The line of an output that best says what went wrong. */
function errorLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /\b(error|fail(ed|ure)?|fatal|cannot|can't|not found|denied|exception|panic)\b/i.test(l));
  return hit ?? lines[lines.length - 1] ?? "";
}

type BashArgs = { command: string; timeout_ms?: number; workdir?: string };

/** The first line of a command, for the panel. */
function commandTarget(command: string): string {
  const first = String(command ?? "").split(/\r?\n/)[0] ?? "";
  const more = String(command ?? "").includes("\n") ? " …" : "";
  return clip(first, 60) + more;
}

function shellHints(shell: ShellInfo): string {
  if (shell.kind === "powershell") {
    return (
      ` Commands run in ${shell.name} on Windows: use PowerShell syntax (Get-ChildItem, Select-String, ` +
      "$env:NAME, `;` between commands, no `&&` in Windows PowerShell)."
    );
  }
  if (shell.kind === "cmd") return " Commands run in cmd.exe on Windows: use cmd syntax.";
  if (shell.name === "Git Bash") {
    return " Commands run in Git Bash on Windows: POSIX syntax works, paths may be written C:/like/this.";
  }
  return ` Commands run in ${shell.name}.`;
}

/** The bash tool for `shell` (detected when not given). */
export function createBashTool(shell: ShellInfo = detectShell()): Tool {
  return defineTool<BashArgs>({
    name: "bash",
    description:
      "Runs a shell command in the project folder and returns its output (stdout and stderr, cut to " +
      "30000 characters) and its exit code." +
      shellHints(shell) +
      " Commands run without a terminal: no interactive prompts, editors or pagers. Default timeout " +
      "120 s, at most 600 s (`timeout_ms`); don't start servers or watchers that never exit. Prefer " +
      "read_file, list_files and grep for reading and searching.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: { type: "integer", description: "Stop the command after this many milliseconds (default 120000, max 600000)." },
        workdir: { type: "string", description: "The folder to run in, relative to the project folder (default: the project folder)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    risk: (args) => classifyCommand(args.command),
    describe: (args) => ({ verb: "run", target: commandTarget(args.command) }),
    approval: (args, ctx) => {
      const where = args.workdir ? ` (in ${displayPath(ctx.cwd, resolvePath(ctx.cwd, args.workdir))})` : "";
      return {
        risk: "exec",
        summary: `run ${commandTarget(args.command)}${where}`,
        detail: String(args.command ?? ""),
        allowKey: commandAllowKey(String(args.command ?? "")),
      };
    },
    async run(args, ctx): Promise<ToolResult> {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) return { content: "bash needs a `command`.", isError: true };
      const cwd = args.workdir ? resolvePath(ctx.cwd, args.workdir) : ctx.cwd;
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error("not a folder");
      } catch {
        return { content: `The folder ${displayPath(ctx.cwd, cwd)} does not exist.`, isError: true, display: { detail: "no such folder" } };
      }
      const requested = Number(args.timeout_ms);
      const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_TIMEOUT) : DEFAULT_TIMEOUT;
      const res = await runCommand({ shell, command, cwd, timeoutMs, signal: ctx.signal });
      const body = res.output.trim() ? res.output.replace(/\s+$/, "") : "(no output)";
      if (res.aborted) {
        return { content: `${body}\n\nInterrupted by the user.`, isError: true, display: { detail: "✗ interrupted" } };
      }
      if (res.timedOut) {
        return {
          content: `${body}\n\nThe command timed out after ${Math.round(timeoutMs / 1000)} s and was stopped.`,
          isError: true,
          display: { detail: `✗ timed out after ${Math.round(timeoutMs / 1000)} s` },
        };
      }
      const code = res.code ?? 1;
      if (code === 0) return { content: body, display: { detail: "✓ exit 0" } };
      const why = errorLine(res.output);
      return {
        content: `${body}\n\nexit code ${code}`,
        isError: true,
        display: { detail: `✗ exit ${code}${why ? ` · ${clip(why, 60)}` : ""}` },
      };
    },
  });
}
