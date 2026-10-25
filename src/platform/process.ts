// Finding and starting programs the same way on Windows, macOS and Linux.
//
// Windows needs care: npm-installed CLIs are `.cmd` shims, which Node refuses to spawn directly
// (CVE-2024-27980), so they go through `cmd.exe /d /s /c` with every argument quoted for cmd. An
// argument cmd.exe can't carry (a line break, "%") makes an npm shim start its target directly.
// Programs are looked up with PATHEXT, and Windows' environment variable names ignore case.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWindows } from "./paths.js";

/** Extensions spawnProgram can start on Windows: programs directly, batch files through cmd.exe. */
const RUNNABLE_EXTS = [".com", ".exe", ".bat", ".cmd"];

/**
 * An environment variable of `env`. Windows' names are case-insensitive, and a copy of the
 * environment ({ ...process.env }) keeps whatever spelling it had ("Path", "ComSpec").
 */
export function getEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== "win32") return direct;
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper && env[k] !== undefined);
  return key === undefined ? undefined : env[key];
}

/**
 * The PATH's folders. On Windows an entry may be quoted ("C:\Program Files\x") or hold a
 * variable the registry did not expand (%USERPROFILE%\bin); both are undone here as cmd.exe does.
 */
export function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return (env.PATH ?? env.Path ?? "").split(":").filter(Boolean);
  return (getEnv(env, "PATH", platform) ?? "")
    .split(";")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1").replace(/%([^%;]+)%/g, (all, name: string) => getEnv(env, name, platform) ?? all))
    .filter(Boolean);
}

/** Folders a macOS app started from the Dock or Finder lacks on its PATH (Homebrew's). */
const MAC_EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * A copy of `env` with the folder of `exe` (and Homebrew's on macOS) appended to the PATH when it
 * is missing there, under the PATH's own spelling ("Path" on Windows stays "Path"). npm-installed
 * CLIs are `#!/usr/bin/env node` scripts or .cmd shims that call `node`, which lives next to them
 * for nvm / Volta / Homebrew; an app started from the Dock gets PATH=/usr/bin:/bin:/usr/sbin:/sbin.
 */
export function withProgramPath(
  env: NodeJS.ProcessEnv,
  exe: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const key = windows ? (Object.keys(out).find((k) => k.toUpperCase() === "PATH" && out[k] !== undefined) ?? "Path") : "PATH";
  const delimiter = windows ? ";" : ":";
  const dirs = (out[key] ?? "").split(delimiter).filter(Boolean);
  const norm = (d: string) => (windows ? d.toLowerCase().replace(/[\\/]+$/, "") : d.replace(/\/+$/, ""));
  const have = new Set(dirs.map(norm));
  const extra: string[] = [];
  if (exe && p.isAbsolute(exe)) extra.push(p.dirname(exe));
  if (platform === "darwin") extra.push(...MAC_EXTRA_DIRS);
  for (const dir of extra) {
    if (have.has(norm(dir))) continue;
    dirs.push(dir);
    have.add(norm(dir));
  }
  if (dirs.length) out[key] = dirs.join(delimiter);
  return out;
}

function isExecutable(file: string, windows: boolean): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    // Windows starts nothing without a program or batch extension (npm's extensionless "claude"
    // next to claude.cmd is a script for Git Bash).
    if (windows) return RUNNABLE_EXTS.includes(path.extname(file).toLowerCase());
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The extensions Windows tries for a bare command name (those spawnProgram can start). */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const list = (getEnv(env, "PATHEXT", "win32") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => RUNNABLE_EXTS.includes(e));
  return list.length ? [...new Set(list)] : RUNNABLE_EXTS;
}

/**
 * The full path of `name` on the PATH (or in `extra` places), or null. A `configured` path wins
 * when it exists. On Windows a name or configured path without an extension gets PATHEXT's.
 * `platform` picks the rules (tests), the paths themselves stay native.
 */
export function findProgram(
  name: string,
  opts: { configured?: string | null; extra?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string | null {
  const env = opts.env ?? process.env;
  const windows = (opts.platform ?? process.platform) === "win32";
  const exts = windows ? windowsExtensions(env) : [];
  const variants = (file: string) =>
    windows && !RUNNABLE_EXTS.includes(path.extname(file).toLowerCase()) ? exts.map((ext) => file + ext) : [file];
  if (opts.configured) {
    for (const candidate of variants(opts.configured)) if (isExecutable(candidate, windows)) return candidate;
  }
  const names = variants(name);
  for (const dir of pathDirs(env, windows ? "win32" : "linux")) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (isExecutable(candidate, windows)) return candidate;
    }
  }
  for (const candidate of opts.extra ?? []) if (isExecutable(candidate, windows)) return candidate;
  return null;
}

/**
 * Quotes one argument for cmd.exe running a batch file. Inside the quotes cmd.exe leaves `&`, `|`,
 * `<`, `>`, `^` and `(` alone; quotes are doubled, which keeps cmd.exe's own quote state in step and
 * which the program behind the batch file (the C runtime's rules) reads as one quote. Backslashes
 * right before a quote, or at the end before the closing one, are doubled for those rules too. A
 * lone "%" stays literal; "%NAME%" of a defined variable expands, which no quoting prevents (so
 * spawnProgram avoids cmd.exe for such arguments where it can).
 */
export function cmdQuote(arg: string): string {
  if (/^[\w\-.,:/\\=@+]+$/.test(arg)) return arg;
  const body = arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1");
  return `"${body}"`;
}

/** What cmd.exe can't carry on a command line: a line break ends it, "%NAME%" expands. */
const CMD_UNSAFE = /[\r\n%]/;

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * What an npm `.cmd` shim (cmd-shim) starts, so it can be started without cmd.exe: the package's
 * script under node (the node.exe next to the shim, else the PATH's), or the program it points at.
 * Null for any other batch file.
 */
export function resolveCmdShim(
  shim: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; findNode?: () => string | null } = {},
): { exe: string; args: string[] } | null {
  let text: string;
  try {
    const st = fs.statSync(shim);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    text = fs.readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(shim);
  const local = (rel: string) => path.join(dir, ...rel.split(/[\\/]+/).filter(Boolean));
  // npm 7+: ... & "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
  // npm 6:  "%~dp0\node.exe"  "%~dp0\node_modules\pkg\cli.js" %*   (or `node  "%~dp0\..." %*`)
  const viaNode =
    /(?:"%_prog%"|"%~dp0\\node\.exe"|(?:^|[\s&(])node)[ \t]+([^"%\r\n]*?)[ \t]*"%(?:dp0%|~dp0)\\([^"%\r\n]+)"[ \t]+%\*[ \t]*\r?$/im.exec(text);
  if (viaNode) {
    const script = local(viaNode[2]);
    if (!fileExists(script)) return null;
    const bundled = local("node.exe");
    const node = fileExists(bundled)
      ? bundled
      : (opts.findNode ?? (() => findProgram("node", { env: opts.env, platform: opts.platform })))();
    if (!node) return null;
    const nodeArgs = viaNode[1].trim() ? viaNode[1].trim().split(/\s+/) : [];
    return { exe: node, args: [...nodeArgs, script] };
  }
  // A package whose bin is a program: "%dp0%\node_modules\pkg\bin\tool.exe"   %*
  const direct = /^[ \t]*@?"%(?:dp0%|~dp0)\\([^"%\r\n]+\.(?:exe|com))"[ \t]+%\*[ \t]*\r?$/im.exec(text);
  if (direct) {
    const exe = local(direct[1]);
    return fileExists(exe) ? { exe, args: [] } : null;
  }
  return null;
}

/**
 * How spawnProgram starts `exe args` on Windows: a program directly; a batch file through
 * `cmd.exe /d /s /c` with every argument quoted for it, except an npm shim whose arguments cmd.exe
 * can't carry (line breaks, "%"), which starts what the shim would start. Throws for another batch
 * file with a line break in an argument, which cmd.exe would silently cut there.
 */
export function windowsSpawnPlan(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; verbatim: boolean } {
  if (!/\.(cmd|bat)$/i.test(exe)) return { file: exe, args, verbatim: false };
  if (args.some((a) => CMD_UNSAFE.test(a))) {
    const target = resolveCmdShim(exe, { env, platform: "win32" });
    if (target) return { file: target.exe, args: [...target.args, ...args], verbatim: false };
    if (args.some((a) => /[\r\n]/.test(a))) {
      throw new Error(`${path.basename(exe)} is a batch file, and cmd.exe would cut its arguments at the first line break.`);
    }
  }
  const line = [exe, ...args].map(cmdQuote).join(" ");
  return { file: getEnv(env, "ComSpec", "win32") || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** Starts `exe args`; on Windows a .cmd/.bat shim goes through cmd.exe (see windowsSpawnPlan). */
export function spawnProgram(exe: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (isWindows) {
    const plan = windowsSpawnPlan(exe, args, options.env ?? process.env);
    return spawn(plan.file, plan.args, {
      ...options,
      windowsVerbatimArguments: plan.verbatim || options.windowsVerbatimArguments,
      windowsHide: true,
    });
  }
  return spawn(exe, args, { ...options, windowsHide: true });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a program to the end and collects its output. */
export function runProgram(
  exe: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
    signal?: AbortSignal;
    maxOutput?: number;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProgram(exe, args, {
        cwd: opts.cwd ?? os.homedir(),
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group on POSIX, so killTree reaches grandchildren too.
        detached: !isWindows,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const max = opts.maxOutput ?? 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // After a kill, a grandchild that escaped the group could still hold the pipes open: give up
    // on them after a grace period instead of waiting for it.
    const giveUp = () =>
      setTimeout(() => {
        if (settled) return;
        // Whatever ignored the polite signal goes now.
        killTree(child, { signal: "SIGKILL" });
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode);
      }, 2000).unref();
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
          giveUp();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      killTree(child);
      giveUp();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => finish(code));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

export interface KillTreeOptions {
  /** POSIX: the signal for the process group (default SIGTERM). Windows always ends the tree hard. */
  signal?: NodeJS.Signals;
  /** The platform whose rules apply (tests). */
  platform?: NodeJS.Platform;
  /** Starts taskkill (tests). */
  spawnImpl?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
}

/** Windows' own programs by full path, so a trimmed PATH can't hide them. */
function system32(program: string, env: NodeJS.ProcessEnv): string {
  const root = getEnv(env, "SystemRoot", "win32") || getEnv(env, "windir", "win32") || "C:\\Windows";
  return path.win32.join(root, "System32", program);
}

/** Ends a process and its children (taskkill /T on Windows, the process group elsewhere). */
export function killTree(child: ChildProcess, opts: KillTreeOptions = {}): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if ((opts.platform ?? process.platform) === "win32") {
    const fallback = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    try {
      const killer = (opts.spawnImpl ?? spawn)(
        system32("taskkill.exe", opts.env ?? process.env),
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      // spawn reports a taskkill that can't start through "error", later: unhandled, it would
      // crash lu-minal.
      killer.on("error", fallback);
    } catch {
      fallback();
    }
    return;
  }
  const signal = opts.signal ?? "SIGTERM";
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * The command that opens a URL (or file) with the user's default app: rundll32's
 * FileProtocolHandler on Windows (it takes the URL as one argument, so "&" in a query string needs
 * no escaping and cmd.exe is never involved), `open` on macOS, xdg-open elsewhere (wslview first
 * under WSL, where xdg-open usually has no browser to hand the URL to).
 */
export function openCommand(
  target: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; find?: (name: string) => string | null } = {},
): { exe: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === "win32") return { exe: system32("rundll32.exe", env), args: ["url.dll,FileProtocolHandler", target] };
  if (platform === "darwin") return { exe: "/usr/bin/open", args: [target] };
  const find = opts.find ?? ((name: string) => findProgram(name, { env }));
  const wsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  const order = wsl ? ["wslview", "xdg-open"] : ["xdg-open", "wslview"];
  for (const name of order) {
    const exe = find(name);
    if (exe) return { exe, args: [target] };
  }
  return { exe: "xdg-open", args: [target] };
}

/** Opens a URL (or file) in the user's default browser / app. Resolves false if that failed. */
export function openExternal(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const cmd = openCommand(target);
      child = spawn(cmd.exe, cmd.args, { stdio: "ignore", detached: true, windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
