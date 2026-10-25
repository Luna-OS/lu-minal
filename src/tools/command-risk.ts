// Which shell commands plainly only look (ls, cat, git status, rg, ...) and so may run without an
// approval, and what "always allow" remembers for a command. Shared by the native `bash` tool
// (src/tools/exec.ts) and Claude Code's permission prompts (src/mcp/approve.ts).
//
// The parser errs on the side of "exec": anything the shell would expand or run on its own makes a
// command not read-only — command substitution, variables ($HOME, $@, $'..'), brace and process
// substitution, subshells, here-docs, background jobs, redirections into files (only the null
// device and fd duplication pass), line continuations are followed like the shell does. Each
// program then has its own rules (find -exec, rg --pre / --hostname-bin, sort -o and its GNU
// abbreviations, tree -o, file -C, git's write-ish options and sub-commands), program names must be
// bare (./cat is not cat), globs may not feed options to programs where an option can run or write
// something, and no word may point into a secret store (~/.ssh, lu-minal's auth.json, /proc/self,
// a network share; see sensitive.ts).
import os from "node:os";
import path from "node:path";
import { fromMsysPath } from "../platform/paths.js";
import { assessRead, containsSecrets, isUncPath, type SensitiveOptions } from "./sensitive.js";

/** The shell a command is written for: POSIX sh / bash, PowerShell, or cmd.exe. */
export type ShellKind = "bash" | "powershell" | "cmd";

/** One word of a command after quote removal. */
export interface ShellWord {
  text: string;
  /** It had an unquoted *, ? or [ (the shell may expand it to file names). */
  glob: boolean;
  /** It started with an unquoted ~. */
  tilde: boolean;
}

export interface ParsedShellCommand {
  /** Each simple command's words: pipelines and lists split into their parts. */
  segments: ShellWord[][];
  /** Something that runs, expands or writes on its own: such a command is never read-only. */
  unsafe: boolean;
}

const NULL_TARGETS: Record<ShellKind, Set<string>> = {
  bash: new Set(["/dev/null"]),
  powershell: new Set(["$null"]),
  cmd: new Set(["nul", "nul:"]),
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * Splits a command line into simple commands (at `;`, newlines, `&&`, `||`, `|`, `|&` and, in
 * cmd.exe, `&`) and their words, and notes whether anything in it expands or runs on its own.
 */
export function parseShellCommand(command: string, shell: ShellKind = "bash"): ParsedShellCommand {
  const s = String(command ?? "");
  const n = s.length;
  const segments: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let text = "";
  let inWord = false;
  let glob = false;
  let tilde = false;
  let quotedAny = false;
  let quote: "'" | '"' | null = null;
  let unsafe = false;
  /** The last operator that needs a command after it ("|", "&&", "||"), until one comes. */
  let dangling = false;

  const fail = () => {
    unsafe = true;
  };
  const resetWord = () => {
    text = "";
    inWord = false;
    glob = false;
    tilde = false;
    quotedAny = false;
  };
  const endWord = () => {
    if (inWord) {
      words.push({ text, glob, tilde });
      dangling = false;
    }
    resetWord();
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  /** An operator that joins two commands: there must be one before it and one after it. */
  const joiner = () => {
    endWord();
    if (!words.length) fail(); // "| x", "&& x", "ls | | y"
    endSegment();
    dangling = true;
  };

  /** A redirection starting at s[i] (">" or, for "&>", the ">"); returns the last index used. */
  const redirect = (i: number): number => {
    // "2>", "*>" (PowerShell): the fd belongs to the redirection, not to the words.
    if (inWord && !quotedAny && (/^\d+$/.test(text) || (shell === "powershell" && text === "*"))) resetWord();
    else endWord();
    let j = i + 1;
    if (s[j] === ">") j++;
    if (s[j] === "|") {
      fail();
      return j;
    }
    if (s[j] === "&") {
      // Duplicating or closing a stream (2>&1, >&2, 2>&-) writes no file; ">&file" does.
      j++;
      const start = j;
      while (j < n && /[0-9]/.test(s[j])) j++;
      if (j === start && s[j] === "-") j++;
      if (j === start || (j < n && !/[\s;&|<>]/.test(s[j]))) fail();
      return j - 1;
    }
    while (s[j] === " " || s[j] === "\t") j++;
    let target = "";
    while (j < n && !/[\s;&|<>()]/.test(s[j])) target += s[j++];
    target = target.replace(/^["']|["']$/g, "");
    if (!NULL_TARGETS[shell].has(shell === "bash" ? target : target.toLowerCase())) fail();
    return j - 1;
  };

  for (let i = 0; i < n; i++) {
    const ch = s[i];
    const next = s[i + 1];

    // ---- inside quotes ----
    if (quote === "'") {
      if (ch === "'") {
        if (shell === "powershell" && next === "'") {
          text += "'";
          i++;
        } else {
          quote = null;
        }
      } else {
        text += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        if (shell === "powershell" && next === '"') {
          text += '"';
          i++;
        } else {
          quote = null;
        }
        continue;
      }
      if (shell === "bash") {
        if (ch === "$" || ch === "`") fail();
        if (ch === "\\") {
          if (next === "\n") {
            i++;
            continue;
          }
          if (next !== undefined && '$`"\\'.includes(next)) {
            text += next;
            i++;
            continue;
          }
        }
      } else if (shell === "powershell") {
        if (ch === "$" || ch === "`") fail();
      } else if (ch === "%" || ch === "!") {
        fail(); // cmd expands %VAR% and !VAR! inside quotes too
      }
      if (CONTROL.test(ch)) fail();
      text += ch;
      continue;
    }

    // ---- unquoted ----
    if (ch === '"' || (ch === "'" && shell !== "cmd")) {
      quote = ch;
      inWord = true;
      quotedAny = true;
      continue;
    }
    if (shell === "bash" && ch === "\\") {
      if (next === undefined) {
        fail();
        continue;
      }
      if (next === "\n") {
        // A line continuation: the shell drops both characters.
        i++;
        continue;
      }
      if (CONTROL.test(next)) fail();
      text += next;
      inWord = true;
      quotedAny = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endSegment();
      if (dangling) fail();
      continue;
    }
    if (ch === "&") {
      if (next === "&") {
        joiner();
        i++;
        continue;
      }
      if (shell === "bash" && next === ">") {
        // "&>file" / "&>>file": both streams into a file.
        i = redirect(i + 1);
        continue;
      }
      if (shell === "cmd") {
        // cmd.exe's "a & b": one after the other.
        endSegment();
        continue;
      }
      fail(); // a background job (sh) or the call operator (PowerShell)
      endSegment();
      continue;
    }
    if (ch === "|") {
      if (next === "|" || (shell === "bash" && next === "&")) i++;
      joiner();
      continue;
    }
    if (ch === ">") {
      i = redirect(i);
      continue;
    }
    if (ch === "<") {
      // Input redirection, here-docs, process substitution, PowerShell's <# comments.
      fail();
      text += ch;
      inWord = true;
      continue;
    }
    if (CONTROL.test(ch) || ch === "\r") {
      fail();
      continue;
    }
    if (shell === "bash" && "`$(){}".includes(ch)) fail();
    if (shell === "powershell" && ("`$(){}".includes(ch) || (ch === "@" && !inWord))) fail();
    if (shell === "cmd" && "%!^()".includes(ch)) fail();
    if (shell === "bash" && (ch === "*" || ch === "?" || ch === "[")) glob = true;
    if (shell === "bash" && ch === "~" && !inWord) tilde = true;
    text += ch;
    inWord = true;
  }
  if (quote) fail(); // unbalanced quotes: don't guess
  endSegment();
  if (dangling) fail(); // "ls |", "ls &&"
  if (shell === "powershell" && segments.some((seg) => seg.some((w) => w.text === "--%"))) fail();
  return { segments, unsafe };
}

// ---- programs --------------------------------------------------------------------------------

/** Programs (and PowerShell cmdlets) that only read, given the argument rules below. */
const READ_ONLY = new Set([
  "git",
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
  "sort",
  "cut",
  "tr",
  "nl",
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

/** Programs that read file contents below a folder (a search from ~ would reach ~/.ssh). */
const RECURSIVE_READERS = new Set(["rg", "grep", "egrep", "fgrep", "select-string", "sls", "get-childitem", "gci"]);

/** Programs where an option can run something or write a file: a glob must not reach them. */
const GLOB_SENSITIVE = new Set(["find", "rg", "sort", "tree", "file", "git", "date"]);

const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "shortlog", "branch"]);
const GIT_BRANCH_WRITES = /^(?:-[dDmMcCf]|--delete|--move|--copy|--force|--set-upstream-to|-u|--unset-upstream|--edit-description)/;
/** find's actions that run programs or write files. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Folders a program may be named by its full path from (the system's own). */
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/;

/** The program a word names ("ls", "/usr/bin/ls", "Get-Content", "where.exe"), or null for a path. */
function programName(word: ShellWord, shell: ShellKind): string | null {
  if (word.glob || word.tilde) return null;
  const t = word.text;
  if (/[\\/]/.test(t)) {
    // ./cat or node_modules/.bin/ls could be anything; only the system's folders count.
    if (shell !== "bash" || !SYSTEM_BIN.test(t)) return null;
  }
  const base = t.split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|com)$/, "") || null;
}

/** The option's name in "--name=value". */
const optName = (a: string) => (a.startsWith("--") ? a.split("=")[0] : a);

function gitArgsOk(args: string[]): boolean {
  let rest = args;
  while (rest[0] === "--no-pager" || rest[0] === "-P" || rest[0] === "--no-optional-locks") rest = rest.slice(1);
  const sub = rest[0];
  // Global options (-c, -C, --git-dir, --exec-path, ...) come before the sub-command: not read-only.
  if (!sub || !GIT_READ_ONLY.has(sub)) return false;
  const subArgs = rest.slice(1);
  const bad = subArgs.some((a) => {
    const name = optName(a);
    return (
      name.startsWith("--ou") || // --output (and its abbreviations) writes a file
      name.startsWith("--ext") || // --ext-diff runs the configured diff program
      name.startsWith("--open-files") ||
      name === "-o" ||
      /^-O/.test(a)
    );
  });
  if (bad) return false;
  if (sub === "branch") return subArgs.every((a) => a.startsWith("-") && !GIT_BRANCH_WRITES.test(a));
  return true;
}

/** Whether a program's arguments keep it read-only. */
function argsOk(name: string, args: string[], shell: ShellKind): boolean {
  switch (name) {
    case "git":
      return gitArgsOk(args);
    case "find":
      return !args.some((a) => FIND_WRITES.has(a));
    case "rg":
      return !args.some((a) => {
        const opt = optName(a);
        return opt === "--pre" || opt === "--hostname-bin";
      });
    case "sort":
      // -o FILE (also inside "-uo"), --output and its GNU abbreviations (--o, --out, ...),
      // --compress-program (runs a program; --co, --comp, ...), Windows sort.exe's /O.
      return !args.some((a) => /^-[^-]*o/.test(a) || /^--o/.test(a) || /^--co/.test(a) || /^\/o/i.test(a));
    case "tree":
      // -o FILE writes the listing; -R writes 00Tree.html into every folder.
      return !args.some((a) => /^-[^-]*[oR]/.test(a) || /^--o/.test(a));
    case "file":
      // -C / --compile writes a compiled magic file.
      return !args.some((a) => /^-[^-]*C/.test(a) || /^--com/.test(a));
    case "date":
      // -s / --set changes the clock; cmd.exe's `date` without /T asks for a new date.
      if (shell === "cmd") return args.some((a) => a.toLowerCase() === "/t");
      return !args.some((a) => /^-[^-]*s/.test(a) || /^--s/.test(a));
    case "cd":
      return args.length <= 1 && args[0] !== "-";
    default:
      return true;
  }
}

// ---- paths in arguments --------------------------------------------------------------------------

/** The texts of a word that may name a file: the word, and the value of "--opt=value". */
function pathTexts(word: ShellWord): string[] {
  const t = word.text;
  if (!t) return [];
  if (t.startsWith("-")) {
    const eq = t.indexOf("=");
    return eq > 0 ? [t.slice(eq + 1)] : [];
  }
  return [t];
}

function expandTilde(t: string, home: string): string | null {
  if (!t.startsWith("~")) return t;
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(home, t.slice(2));
  return null; // ~user, ~+, ~-: another folder than we can tell
}

interface Where {
  shell: ShellKind;
  /** Every folder the command may be in at this point (cd moves it; pipes may not). */
  cwds: string[];
  sensitive: SensitiveOptions | false;
}

/** Whether the words of a read-only program stay clear of secret stores and network shares. */
function pathsOk(name: string, args: ShellWord[], where: Where): boolean {
  if (where.sensitive === false) return true;
  const opts = where.sensitive;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? (opts.env?.LU_MINAL_HOME_DIR || process.env.LU_MINAL_HOME_DIR || os.homedir());
  const recursive = RECURSIVE_READERS.has(name);
  const api = platform === "win32" ? path.win32 : path.posix;
  for (const word of args) {
    for (const raw of pathTexts(word)) {
      const t = platform === "win32" && where.shell === "bash" ? fromMsysPath(raw, platform) : raw;
      const expanded = expandTilde(t, home);
      if (expanded === null) return false;
      // A glob outside the project could expand to anything there.
      if (word.glob && (api.isAbsolute(expanded) || t.startsWith("~") || t.split(/[\\/]/).includes(".."))) return false;
      if (isUncPath(expanded, platform) && !where.cwds.length) return false;
      const bases = api.isAbsolute(expanded) ? [null] : where.cwds;
      for (const base of bases) {
        const abs = base === null ? api.resolve(expanded) : api.resolve(base, expanded);
        // A network share counts as reaching out unless it is the project's own folder.
        if (assessRead(abs, { ...opts, recursive, cwd: base ?? where.cwds[0] }) !== "read") return false;
      }
    }
  }
  // A search without a folder argument starts where the command runs.
  if (recursive && where.cwds.some((c) => containsSecrets(c, opts))) return false;
  return true;
}

export interface ReadOnlyOptions {
  /** The folder the command runs in; relative paths are checked against it. */
  cwd?: string;
  shell?: ShellKind;
  /** How secret stores are found (home folder, env); false skips the path checks. */
  sensitive?: SensitiveOptions | false;
}

/**
 * Whether a command plainly only reads: ls, cat, head, tail, rg, grep, find (no -exec / -delete),
 * git status / diff / log / show / branch (listing), ... alone, in a pipeline or in a list, with no
 * expansions, substitutions, background jobs or redirections into files, and no word that points
 * into a secret store.
 */
export function isReadOnlyShellCommand(command: string, opts: ReadOnlyOptions = {}): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const shell = opts.shell ?? "bash";
  const parsed = parseShellCommand(command, shell);
  if (parsed.unsafe || !parsed.segments.length) return false;
  const platform = (opts.sensitive && opts.sensitive.platform) || process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  const where: Where = {
    shell,
    cwds: opts.cwd ? [api.resolve(opts.cwd)] : [],
    sensitive: opts.sensitive === false ? false : { ...(opts.sensitive ?? {}) },
  };
  for (const words of parsed.segments) {
    const [first, ...rest] = words;
    if (!first) continue;
    // "FOO=1 cmd" changes the environment of whatever runs.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text)) return false;
    const name = programName(first, shell);
    if (!name || !READ_ONLY.has(name)) return false;
    if (!argsOk(name, rest.map((w) => w.text), shell)) return false;
    if (GLOB_SENSITIVE.has(name) && rest.some((w) => w.glob)) return false;
    if (!pathsOk(name, rest, where)) return false;
    if (name === "cd" && where.cwds.length) {
      const home = where.sensitive ? where.sensitive.home : undefined;
      const target = rest[0] ? expandTilde(rest[0].text, home ?? os.homedir()) : (home ?? os.homedir());
      if (target === null) return false;
      // Keep the old folder too: "cd x | cat y" runs cat where it was.
      where.cwds = [...new Set([...where.cwds, ...where.cwds.map((c) => api.resolve(c, target))])];
    }
  }
  return true;
}

/**
 * What "always allow" remembers for a command: `<prefix>:<first two words>` for one simple command
 * (so "npm test --watch" is covered by an earlier "npm test"), and `<prefix>=<the whole command>`
 * for anything else — a list, a pipeline, a substitution or a redirection is only ever allowed as
 * the exact same text, so "npm test && curl … | sh" never rides on "npm test".
 */
export function shellAllowKey(prefix: string, command: string, shell: ShellKind = "bash"): string {
  const text = String(command ?? "").trim();
  const parsed = parseShellCommand(text, shell);
  const words = parsed.segments[0] ?? [];
  const simple = !parsed.unsafe && parsed.segments.length === 1 && words.length > 0 && !words.slice(0, 2).some((w) => w.glob || w.tilde);
  if (simple) return `${prefix}:${words.slice(0, 2).map((w) => w.text).join(" ")}`;
  return `${prefix}=${text}`;
}
