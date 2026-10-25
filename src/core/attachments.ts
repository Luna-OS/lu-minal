// Pictures and files for a message: a screenshot from the clipboard (Ctrl+V / Alt+V), files
// dragged into the terminal (the terminal pastes their paths) or added with /attach. Clipboard
// images are saved in the state dir; dropped files are used where they are.
//
// How they reach the models: pictures go in as image blocks to models that can see; text files
// up to MAX_INLINE_TEXT are inlined; anything else is named by its path, so an agent can read it
// with its own tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProgram, runProgram, spawnProgram } from "../platform/process.js";
import { newId } from "./emitter.js";

export type AttachmentKind = "image" | "text" | "file";

export interface Attachment {
  id: string;
  name: string;
  /** Absolute path of the file (a saved copy for clipboard images). */
  path: string;
  kind: AttachmentKind;
  mediaType: string;
  size: number;
}

/** What models accept as pictures (Anthropic, OpenAI, Gemini all take these four). */
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Anthropic's per-image limit; larger pictures are named by path instead. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Text files up to this size go into the message itself. */
export const MAX_INLINE_TEXT = 100 * 1024;

const TEXT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/** True when the bytes look like text (no NUL in the first 8 KB). */
function looksLikeText(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return !buf.subarray(0, n).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** An attachment for a file on disk, or an error message saying why it can't be one. */
export function attachmentFromPath(file: string): Attachment | string {
  const full = path.resolve(file);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return `No such file: ${file}`;
  }
  if (st.isDirectory()) return `${file} is a folder - attach files inside it, or ask an agent to look at it.`;
  if (!st.isFile()) return `${file} is not a regular file.`;
  if (st.size > MAX_FILE_BYTES) return `${path.basename(full)} is larger than 25 MB.`;
  const ext = path.extname(full).toLowerCase();
  const image = IMAGE_TYPES[ext];
  const kind: AttachmentKind = image ? "image" : looksLikeText(full) ? "text" : "file";
  return {
    id: newId("att"),
    name: path.basename(full),
    path: full,
    kind,
    mediaType: image ?? TEXT_TYPES[ext] ?? (kind === "text" ? "text/plain" : "application/octet-stream"),
    size: st.size,
  };
}

/** "screenshot.png · 120 KB". */
export function describeAttachment(a: Attachment): string {
  const kb = a.size / 1024;
  const size = kb < 1 ? `${a.size} B` : kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  return `${a.name} · ${size}`;
}

// ---- dropped files ---------------------------------------------------------------------------------

/**
 * Splits pasted text into the paths a terminal writes when files are dropped on it:
 * `/Users/me/My\ Shot.png` (macOS, backslash-escaped), `'/home/me/a b.png'` (Linux, quoted),
 * `file:///home/me/x.png` (some Linux terminals), `"C:\Users\me\shot.png"` (Windows Terminal).
 */
export function splitDroppedText(text: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  const t = text.trim();
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    // A backslash escapes the next character on POSIX; on Windows it is the path separator.
    if (ch === "\\" && platform !== "win32" && i + 1 < t.length) {
      cur += t[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out.map((p) => {
    if (!p.startsWith("file://")) return p;
    try {
      return decodeURIComponent(new URL(p).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    } catch {
      return p;
    }
  });
}

/**
 * The files in a paste, when the paste is nothing but paths of existing files (so ordinary text
 * that happens to contain a path is still pasted as text). Null otherwise.
 */
export function droppedFiles(text: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if (!text.trim() || text.length > 8192) return null;
  const parts = splitDroppedText(text.replace(/\r?\n/g, " "), platform);
  if (!parts.length) return null;
  for (const p of parts) {
    if (!path.isAbsolute(p) && !p.startsWith("~")) return null;
    const full = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
    try {
      if (!fs.statSync(full).isFile()) return null;
    } catch {
      return null;
    }
  }
  return parts.map((p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p));
}

// ---- the clipboard ---------------------------------------------------------------------------------

/** Where clipboard pictures are saved (pruned after 30 days). */
export function attachmentsDir(stateDir: string): string {
  return path.join(stateDir, "attachments");
}

/** Removes saved attachments older than `maxAgeDays`. */
export function pruneAttachments(dir: string, maxAgeDays = 30, now = Date.now()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeDays * 86_400_000) fs.rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
}

/** Runs a program with its stdout written straight into `file` (binary-safe). */
function runToFile(exe: string, args: string[], file: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    let fd: number;
    try {
      fd = fs.openSync(file, "w");
    } catch {
      resolve(null);
      return;
    }
    const child = spawnProgram(exe, args, { stdio: ["ignore", fd, "ignore"] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      try {
        fs.closeSync(fd);
      } catch {
        // closed
      }
      resolve(code);
    };
    child.on("error", () => done(null));
    child.on("exit", (code) => done(code));
  });
}

function validPng(file: string): boolean {
  try {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
    return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch {
    return false;
  }
}

/** The commands that write the clipboard's picture as PNG to `file`, per platform. */
export function clipboardImageCommands(
  file: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ exe: string; args: string[]; toFile: boolean }> {
  if (platform === "darwin") {
    const script = [
      "try",
      "set png to (the clipboard as «class PNGf»)",
      `set f to open for access POSIX file "${file.replace(/"/g, '\\"')}" with write permission`,
      "set eof f to 0",
      "write png to f",
      "close access f",
      'return "ok"',
      "on error",
      'return "none"',
      "end try",
    ];
    return [{ exe: "osascript", args: script.flatMap((line) => ["-e", line]), toFile: false }];
  }
  if (platform === "win32") {
    const escaped = file.replace(/'/g, "''");
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing;",
      "$img = [System.Windows.Forms.Clipboard]::GetImage();",
      `if ($img) { $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'none' }`,
    ].join(" ");
    const shells = ["powershell.exe", "pwsh.exe"];
    return shells.map((exe) => ({ exe, args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps], toFile: false }));
  }
  const cmds: Array<{ exe: string; args: string[]; toFile: boolean }> = [];
  if (env.WAYLAND_DISPLAY) cmds.push({ exe: "wl-paste", args: ["--no-newline", "--type", "image/png"], toFile: true });
  cmds.push({ exe: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], toFile: true });
  return cmds;
}

/**
 * Saves the picture on the system clipboard as a PNG in `dir` and returns it as an attachment, or
 * null when the clipboard holds no picture (or no clipboard tool is there).
 */
export async function clipboardImage(dir: string): Promise<Attachment | null> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `clipboard-${stamp}-${process.pid}.png`);
  for (const cmd of clipboardImageCommands(file)) {
    const exe = findProgram(cmd.exe);
    if (!exe) continue;
    if (cmd.toFile) {
      const code = await runToFile(exe, cmd.args, file);
      if (code !== 0) continue;
    } else {
      const res = await runProgram(exe, cmd.args, { timeoutMs: 10_000 }).catch(() => null);
      if (!res || res.code !== 0 || !/ok/.test(res.stdout)) continue;
    }
    if (validPng(file)) {
      const a = attachmentFromPath(file);
      if (typeof a !== "string") return { ...a, name: "clipboard.png" };
    }
  }
  fs.rmSync(file, { force: true });
  return null;
}

/** Why there is no picture: a hint per platform when the clipboard tools are missing. */
export function clipboardHint(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "darwin") return "There is no picture on the clipboard (Cmd+Shift+Ctrl+4 copies a screenshot).";
  if (platform === "win32") return "There is no picture on the clipboard (Win+Shift+S copies a screenshot).";
  const tool = env.WAYLAND_DISPLAY ? "wl-paste (wl-clipboard)" : "xclip";
  return findProgram(env.WAYLAND_DISPLAY ? "wl-paste" : "xclip")
    ? "There is no picture on the clipboard."
    : `To paste pictures, install ${tool}.`;
}

// ---- what models get ---------------------------------------------------------------------------

export type AttachmentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name: string };

/**
 * The message parts for `text` with `attachments`: the text (with a list of the files), the text
 * files inlined, and the pictures as base64 when `images` is true (the model can see).
 */
export function messageParts(text: string, attachments: Attachment[], opts: { images: boolean }): AttachmentPart[] {
  if (!attachments.length) return [{ type: "text", text }];
  const lines: string[] = [];
  const images: AttachmentPart[] = [];
  for (const a of attachments) {
    if (a.kind === "image" && opts.images && a.size <= MAX_IMAGE_BYTES) {
      try {
        images.push({ type: "image", mediaType: a.mediaType, data: fs.readFileSync(a.path).toString("base64"), name: a.name });
        lines.push(`- ${a.path} (picture, shown below)`);
        continue;
      } catch {
        // fall through to the path
      }
    }
    if (a.kind === "text" && a.size <= MAX_INLINE_TEXT) {
      try {
        const body = fs.readFileSync(a.path, "utf8");
        lines.push(`- ${a.path}:\n\`\`\`\n${body.replace(/```/g, "`\u200b``")}\n\`\`\``);
        continue;
      } catch {
        // fall through to the path
      }
    }
    const why = a.kind === "image" ? (opts.images ? "picture, too large to show" : "picture; this model can't see pictures") : a.kind;
    lines.push(`- ${a.path} (${why}, ${describeAttachment(a).split(" · ")[1]})`);
  }
  const body = `${text.trim() ? `${text.trim()}\n\n` : ""}Attached files:\n${lines.join("\n")}`;
  return [{ type: "text", text: body }, ...images];
}
