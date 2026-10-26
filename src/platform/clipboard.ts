// Writing text to the system clipboard (reading pictures and copied files is in core/attachments):
// pbcopy on macOS, PowerShell's Set-Clipboard (or clip.exe) on Windows, wl-copy / xclip / xsel on
// Linux and clip.exe in WSL. Where none of them can reach the user's clipboard (an SSH session, no
// display), the terminal is asked to do it with OSC 52, which most terminals honour, over SSH too.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProgram, spawnProgram } from "./process.js";

export interface ClipboardTool {
  /** A program name, looked up on the PATH. */
  exe: string;
  /** "{file}" stands for a temp file holding the text (UTF-8); otherwise it goes in on stdin. */
  args: string[];
  /** How the text is encoded on stdin. clip.exe only reads UTF-16 right (with a BOM). */
  encoding: "utf8" | "utf16le";
  env?: NodeJS.ProcessEnv;
}

/** PowerShell reads the text from a file as UTF-8: the command line would mangle it (and cmd.exe cut it). */
const powershellScript = (file: string) =>
  `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8))`;

function isSsh(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

/**
 * The programs that can put text on the user's clipboard here, in the order to try them. None
 * over SSH on macOS and Windows (they would fill the remote machine's clipboard), nor on Linux
 * without a display (X11 forwarding brings one).
 */
export function clipboardWriteTools(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ClipboardTool[] {
  if (platform === "darwin") {
    if (isSsh(env)) return [];
    // pbcopy reads the text in the locale's encoding: make it UTF-8 where no locale says so.
    const utf8 = /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
    return [{ exe: "pbcopy", args: [], encoding: "utf8", env: utf8 ? undefined : { ...env, LC_CTYPE: "UTF-8" } }];
  }
  if (platform === "win32") {
    if (isSsh(env)) return [];
    const ps = (exe: string): ClipboardTool => ({
      exe,
      args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", powershellScript("{file}")],
      encoding: "utf8",
    });
    return [ps("powershell.exe"), ps("pwsh.exe"), { exe: "clip.exe", args: [], encoding: "utf16le" }];
  }
  const tools: ClipboardTool[] = [];
  if (env.WAYLAND_DISPLAY) tools.push({ exe: "wl-copy", args: [], encoding: "utf8" });
  if (env.DISPLAY) {
    tools.push({ exe: "xclip", args: ["-selection", "clipboard", "-in"], encoding: "utf8" });
    tools.push({ exe: "xsel", args: ["--clipboard", "--input"], encoding: "utf8" });
  }
  // WSL: Windows' own clipboard through interop.
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) tools.push({ exe: "clip.exe", args: [], encoding: "utf16le" });
  return tools;
}

/** The OSC 52 sequence that asks the terminal to put `text` on the clipboard. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

/**
 * Runs one tool with the text. Only its exit counts: xclip, xsel and wl-copy stay behind to serve
 * the clipboard, holding on to whatever output they were given (so they get none).
 */
function runTool(exe: string, tool: ClipboardTool, text: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const usesFile = tool.args.some((a) => a.includes("{file}"));
    let file: string | null = null;
    let args = tool.args;
    if (usesFile) {
      file = path.join(os.tmpdir(), `lu-minal-copy-${randomBytes(6).toString("hex")}.txt`);
      try {
        fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
      } catch {
        resolve(false);
        return;
      }
      args = tool.args.map((a) => a.split("{file}").join(file!));
    }
    let child: ReturnType<typeof spawnProgram> | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      child?.kill();
      done(false);
    }, timeoutMs);
    timer.unref?.();
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (file) fs.rmSync(file, { force: true });
      resolve(ok);
    };
    try {
      child = spawnProgram(exe, args, { stdio: [usesFile ? "ignore" : "pipe", "ignore", "ignore"], env: tool.env ?? env, cwd: os.homedir() });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
    if (!usesFile && child.stdin) {
      child.stdin.on("error", () => undefined);
      const body = tool.encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) : Buffer.from(text, "utf8");
      child.stdin.end(body);
    }
  });
}

export interface CopyResult {
  /** The program that took the text, "osc52" when the terminal was asked, null when nothing could. */
  via: string | null;
}

/**
 * Puts `text` on the clipboard: with the first tool that works, else through the terminal
 * (`terminal` writes to it; OSC 52 can't say whether it worked).
 */
export async function copyToClipboard(
  text: string,
  opts: { terminal?: (data: string) => void; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CopyResult> {
  const env = opts.env ?? process.env;
  for (const tool of clipboardWriteTools(opts.platform, env)) {
    const exe = findProgram(tool.exe, { env });
    if (!exe) continue;
    if (await runTool(exe, tool, text, env, opts.timeoutMs ?? 10_000)) return { via: tool.exe };
  }
  if (!opts.terminal) return { via: null };
  try {
    opts.terminal(osc52(text));
    return { via: "osc52" };
  } catch {
    return { via: null };
  }
}
