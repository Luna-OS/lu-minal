// File matching for the file tools: a small glob matcher ("src/**/*.ts", "*.{js,ts}", "[abc]?"),
// a reader for simple .gitignore files, and an async directory walker that skips the usual build
// and dependency folders. Paths handed to the matchers always use "/" (see `toPosix`), whatever the
// platform; the walker turns them back into native paths.
import fs from "node:fs";
import path from "node:path";

/** Folders the walker never descends into. */
export const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".venv",
]);

/** A native relative path with "/" separators (globs and .gitignore patterns use "/"). */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\*?]/g;

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, "\\$&");
}

/** Finds the "}" that closes the "{" at `open`, honouring nesting; -1 when unbalanced. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits the inside of "{a,b,{c,d}}" at its top-level commas. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The regex source for a glob (no anchors). */
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "\\" && i + 1 < glob.length) {
      out += escapeRegex(glob[++i]);
    } else if (ch === "*") {
      if (glob[i + 1] === "*") {
        // "**": any number of path segments.
        const atStart = i === 0 || glob[i - 1] === "/";
        let j = i + 2;
        while (glob[j] === "*") j++;
        if (atStart && glob[j] === "/") {
          // "**/" matches zero or more whole directories.
          out += "(?:.*/)?";
          i = j; // the "/" is part of it
        } else {
          out += ".*";
          i = j - 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      let negate = false;
      if (body[0] === "!" || body[0] === "^") {
        negate = true;
        body = body.slice(1);
      }
      const cls = body.replace(/[\\\]^]/g, "\\$&");
      out += negate ? `[^/${cls}]` : `[${cls}]`;
      i = close;
    } else if (ch === "{") {
      const close = closingBrace(glob, i);
      if (close === -1) {
        out += "\\{";
        continue;
      }
      const alternatives = splitAlternatives(glob.slice(i + 1, close));
      out += `(?:${alternatives.map(globSource).join("|")})`;
      i = close;
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

/**
 * A RegExp for a glob over "/"-separated paths: `**` spans directories ("src/**\/*.ts" also matches
 * "src/a.ts"), `*` and `?` stay inside one segment, `{a,b}` picks alternatives (nested too) and
 * `[abc]` / `[!abc]` match one character. The whole path must match.
 */
export function globToRegExp(glob: string, opts: { nocase?: boolean } = {}): RegExp {
  let g = glob.trim();
  if (g.startsWith("./")) g = g.slice(2);
  return new RegExp(`^${globSource(g)}$`, opts.nocase ? "i" : "");
}

/** Whether `glob` has any glob syntax at all. */
export function hasGlobChars(glob: string): boolean {
  return /[*?[\]{}]/.test(glob);
}

/**
 * A matcher for a user's pattern: a pattern with a "/" matches the whole relative path, one
 * without matches the file name at any depth (like `find -name` and .gitignore).
 */
export function patternMatcher(pattern: string, opts: { nocase?: boolean } = {}): (relPosix: string) => boolean {
  const g = pattern.trim().replace(/\\/g, "/");
  if (!g || g === "*" || g === "**" || g === "**/*") return () => true;
  if (g.includes("/")) {
    const re = globToRegExp(g.replace(/^\/+/, ""), opts);
    return (rel) => re.test(rel);
  }
  const re = globToRegExp(g, opts);
  return (rel) => re.test(rel.slice(rel.lastIndexOf("/") + 1));
}

// ---- .gitignore --------------------------------------------------------------------------------

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** Matched against the base name only (no "/" in the pattern). */
  baseOnly: boolean;
}

/** Ignore rules from .gitignore text (comments, "!" negation, trailing "/" and leading "/"). */
export class GitIgnore {
  private readonly rules: IgnoreRule[] = [];

  constructor(text = "", opts: { nocase?: boolean } = {}) {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/(?<!\\)\s+$/, "");
      if (!line || line.startsWith("#")) continue;
      let negate = false;
      if (line.startsWith("!")) {
        negate = true;
        line = line.slice(1);
      }
      if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
      let dirOnly = false;
      if (line.endsWith("/")) {
        dirOnly = true;
        line = line.replace(/\/+$/, "");
      }
      if (!line) continue;
      const anchored = line.includes("/");
      line = line.replace(/^\/+/, "");
      const re = globToRegExp(line, opts);
      this.rules.push({ re, negate, dirOnly, baseOnly: !anchored });
    }
  }

  /** Reads `<dir>/.gitignore`; an empty set of rules when there is none. */
  static async load(dir: string, opts: { nocase?: boolean } = {}): Promise<GitIgnore> {
    try {
      return new GitIgnore(await fs.promises.readFile(path.join(dir, ".gitignore"), "utf8"), opts);
    } catch {
      return new GitIgnore("", opts);
    }
  }

  get empty(): boolean {
    return this.rules.length === 0;
  }

  /** Whether `relPosix` (relative to the .gitignore's folder) is ignored. */
  ignores(relPosix: string, isDir: boolean): boolean {
    let ignored = false;
    const base = relPosix.slice(relPosix.lastIndexOf("/") + 1);
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      const hit = rule.baseOnly ? rule.re.test(base) : rule.re.test(relPosix);
      if (hit) ignored = !rule.negate;
    }
    return ignored;
  }
}

// ---- walking ------------------------------------------------------------------------------------

export interface WalkedFile {
  /** Absolute native path. */
  abs: string;
  /** Relative to the walk's root, with "/". */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Rules to skip by (paths are tested relative to `ignoreRoot`). */
  ignore?: GitIgnore | null;
  /** The folder the ignore rules are relative to (default: the walk's root). */
  ignoreRoot?: string;
  signal?: AbortSignal;
  /** Stop after this many files. */
  maxFiles?: number;
  /** Stop after looking at this many directory entries (huge trees). */
  maxEntries?: number;
  /** List symlinked files (default true; a search leaves them out, as ripgrep does). */
  links?: boolean;
}

/**
 * Lists the files under `root` (async, so the UI keeps drawing): skips SKIP_DIRS and what the
 * ignore rules exclude, and does not follow symlinked folders. Symlinked files are included
 * unless `links` is false.
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const files: WalkedFile[] = [];
  const maxFiles = opts.maxFiles ?? 100_000;
  const maxEntries = opts.maxEntries ?? 400_000;
  const ignoreRoot = opts.ignoreRoot ?? root;
  let entries = 0;
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop()!;
    let list: fs.Dirent[];
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of list) {
      if (++entries > maxEntries || files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const abs = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (opts.links === false) continue;
        try {
          const st = await fs.promises.stat(abs);
          // Symlinked folders are not followed (loops); symlinked files are listed.
          isDir = false;
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (!isDir && !isFile) continue;
      if (isDir && SKIP_DIRS.has(entry.name)) continue;
      if (opts.ignore && !opts.ignore.empty) {
        const relIgnore = toPosix(path.relative(ignoreRoot, abs));
        if (!relIgnore.startsWith("../") && relIgnore !== ".." && opts.ignore.ignores(relIgnore, isDir)) continue;
      }
      if (isDir) {
        subdirs.push(abs);
        continue;
      }
      try {
        const st = await fs.promises.stat(abs);
        files.push({ abs, rel: toPosix(path.relative(root, abs)), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Vanished meanwhile.
      }
    }
    if (truncated) break;
    // Depth first, in name order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  return { files, truncated };
}

// ---- binary files -----------------------------------------------------------------------------

/** Whether a buffer (the start of a file) looks binary: a NUL byte or mostly control characters. */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  return control / n > 0.1;
}

/** Reads the first `bytes` of a file. */
export async function readHead(file: string, bytes = 8192): Promise<Buffer> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
