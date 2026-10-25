// Finding and starting programs the same way on Windows, macOS and Linux.
//
// Windows needs care: npm-installed CLIs are `.cmd` shims, which Node refuses to spawn directly
// (CVE-2024-27980), so they go through `cmd.exe /d /s /c` with every argument quoted for cmd.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMac, isWindows } from "./paths.js";

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (isWindows) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The extensions Windows tries for a bare command name. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const list = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return list.map((e) => e.toLowerCase());
}

/**
 * The full path of `name` on the PATH (or in `extra` places), or null. A `configured` path wins
 * when it exists.
 */
export function findProgram(
  name: string,
  opts: { configured?: string | null; extra?: string[]; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = opts.env ?? process.env;
  if (opts.configured && isExecutable(opts.configured)) return opts.configured;
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const names = isWindows && !path.extname(name)
    ? windowsExtensions(env).map((ext) => name + ext)
    : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (isExecutable(candidate)) return candidate;
    }
  }
  for (const candidate of opts.extra ?? []) if (isExecutable(candidate)) return candidate;
  return null;
}

/** Quotes one argument for cmd.exe. */
export function cmdQuote(arg: string): string {
  if (/^[\w\-.,:/\\=@+]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""').replace(/%/g, "%%")}"`;
}

/** Starts `exe args`; on Windows a .cmd/.bat shim goes through cmd.exe, everything else directly. */
export function spawnProgram(exe: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (isWindows && /\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...args].map(cmdQuote).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
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
      });
    } catch (err) {
      reject(err);
      return;
    }
    const max = opts.maxOutput ?? 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;
    const onAbort = () => killTree(child);
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
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Ends a process and its children (taskkill /T on Windows, the process group elsewhere). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** Opens a URL (or file) in the user's default browser / app. Resolves false if that failed. */
export function openExternal(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      if (isWindows) {
        // rundll32 takes the URL as one argument, so "&" in query strings needs no escaping.
        child = spawn("rundll32", ["url.dll,FileProtocolHandler", target], {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });
      } else if (isMac) {
        child = spawn("open", [target], { stdio: "ignore", detached: true });
      } else {
        const opener = findProgram("xdg-open") ?? findProgram("wslview") ?? "xdg-open";
        child = spawn(opener, [target], { stdio: "ignore", detached: true });
      }
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
