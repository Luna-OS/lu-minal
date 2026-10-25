// Claude Code on the web ("cloud sessions") from lu-minal, through the official CLI:
// - start:    `claude --cloud "<task>"` - an interactive flow in the real terminal (the CLI rejects
//             -p for creating sessions). It clones the project's GitHub remote at the current
//             branch, so the branch has to be pushed.
// - message:  `claude -p "<text>" --cloud <session-id> --output-format json` -> { ok, session_id, url }
// - teleport: `claude --teleport <session-id>` - continues the cloud session in this terminal.
// The CLI has no command that lists cloud sessions, so lu-minal remembers the ones it started.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProgram, runProgram } from "../platform/process.js";

export interface CloudSession {
  /** "session_…" or "cse_…". */
  id: string;
  url: string;
  task: string;
  /** The project folder it was started from. */
  cwd: string;
  startedAt: number;
  lastMessageAt: number | null;
  lastError: string | null;
}

/** Session URLs and ids as the CLI prints them (https://claude.ai/code/session_…). */
const URL_RE = /https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9_-]+)[^\s"'<>)]*/;
const ID_RE = /\b((?:session|cse)_[A-Za-z0-9_-]{6,})\b/;

/** The session a piece of CLI output (or a pasted link) talks about. */
export function parseCloudSession(text: string): { id: string; url: string } | null {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");
  const url = URL_RE.exec(clean);
  if (url) return { id: url[1], url: `https://claude.ai/code/${url[1]}` };
  const id = ID_RE.exec(clean);
  if (id) return { id: id[1], url: `https://claude.ai/code/${id[1]}` };
  return null;
}

/**
 * The command that starts a cloud session in the real terminal. On macOS and Linux it runs through
 * `script`, which keeps the terminal a terminal while recording what the CLI prints, so lu-minal
 * can pick up the session link afterwards. Windows has no `script`; there the user pastes the link.
 */
export function cloudStartCommand(
  claude: string,
  task: string,
  opts: { platform?: NodeJS.Platform; transcript?: string } = {},
): { exe: string; args: string[]; transcript: string | null } {
  const platform = opts.platform ?? process.platform;
  const args = ["--cloud", task];
  const script = platform === "win32" ? null : findProgram("script");
  if (!script) return { exe: claude, args, transcript: null };
  // In a folder of its own (mode 0700): a predictable name in a shared /tmp could be a symlink
  // another user planted, and the transcript (the session link) is nobody else's business.
  const transcript = opts.transcript ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-cloud-")), "session.log");
  if (platform === "darwin") {
    // BSD script: script [-q] file command ...
    return { exe: script, args: ["-q", transcript, claude, ...args], transcript };
  }
  // util-linux script: script -q -e -c "<command line>" file
  const line = [claude, ...args].map(shQuote).join(" ");
  return { exe: script, args: ["-q", "-e", "-c", line, transcript], transcript };
}

/** Quotes an argument for a POSIX shell. */
export function shQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Reads (and deletes) a transcript written by `script`, returning the session it names. */
export function sessionFromTranscript(transcript: string | null): { id: string; url: string } | null {
  if (!transcript) return null;
  try {
    const text = fs.readFileSync(transcript, "utf8");
    return parseCloudSession(text);
  } catch {
    return null;
  } finally {
    fs.rm(transcript, { force: true }, () => {
      // The private folder cloudStartCommand made for it goes too.
      const dir = path.dirname(transcript);
      if (path.basename(dir).startsWith("lu-minal-cloud-")) fs.rm(dir, { recursive: true, force: true }, () => undefined);
    });
  }
}

export interface CloudSendResult {
  ok: boolean;
  sessionId: string | null;
  url: string | null;
  error: string | null;
}

/** Parses the JSON `claude -p … --cloud <id> --output-format json` prints. */
export function parseSendResult(stdout: string, stderr = ""): CloudSendResult {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as { ok?: boolean; session_id?: string; url?: string; error?: string };
      return {
        ok: Boolean(j.ok),
        sessionId: j.session_id ?? null,
        url: j.url ?? null,
        error: j.ok ? null : (j.error ?? "The cloud session did not take the message."),
      };
    } catch {
      // try the previous line
    }
  }
  const text = `${stdout}\n${stderr}`.trim();
  const found = parseCloudSession(text);
  if (/Sent to cloud session/i.test(text) && found) return { ok: true, sessionId: found.id, url: found.url, error: null };
  return { ok: false, sessionId: null, url: null, error: text.split(/\r?\n/).filter(Boolean).pop() ?? "No answer from Claude Code." };
}

/**
 * Sends a follow-up message to a cloud session (works without a terminal). `trusted`: the folder's
 * own settings may load (`claude -p` would start its .mcp.json servers without asking).
 */
export async function sendToCloud(
  claude: string,
  sessionId: string,
  text: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; run?: typeof runProgram; trusted?: boolean } = {},
): Promise<CloudSendResult> {
  const run = opts.run ?? runProgram;
  const strict = opts.trusted ? [] : ["--setting-sources", "user", "--strict-mcp-config"];
  try {
    const res = await run(claude, ["-p", text, "--cloud", sessionId, "--output-format", "json", ...strict], {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: 120_000,
    });
    return parseSendResult(res.stdout, res.stderr);
  } catch (err) {
    return { ok: false, sessionId: null, url: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function teleportArgs(sessionId: string): string[] {
  return ["--teleport", sessionId];
}

/**
 * Whether a folder is ready for a cloud session: a git repository whose branch is pushed (the
 * cloud clones the remote, not the local checkout). Returns a warning to show, or null.
 */
export async function cloudReadiness(cwd: string, run: typeof runProgram = runProgram): Promise<string | null> {
  const git = findProgram("git");
  if (!git) return "Git is not installed; Claude uploads the folder as a bundle instead of cloning it.";
  const inside = await run(git, ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 10_000 }).catch(() => null);
  if (!inside || inside.code !== 0) return "This folder is not a git repository; Claude uploads it as a bundle.";
  const remote = await run(git, ["remote", "get-url", "origin"], { cwd, timeoutMs: 10_000 }).catch(() => null);
  if (!remote || remote.code !== 0 || !/github\.com/i.test(remote.stdout)) {
    return "No GitHub remote; Claude uploads the folder as a bundle.";
  }
  const status = await run(git, ["status", "--porcelain=v1", "--branch"], { cwd, timeoutMs: 10_000 }).catch(() => null);
  if (!status || status.code !== 0) return null;
  const head = status.stdout.split(/\r?\n/)[0] ?? "";
  const changes = status.stdout.split(/\r?\n/).slice(1).filter(Boolean).length;
  const ahead = /\[ahead (\d+)/.exec(head)?.[1];
  const noUpstream = !head.includes("...");
  const notes: string[] = [];
  if (changes) notes.push(`${changes} uncommitted change${changes === 1 ? "" : "s"}`);
  if (ahead) notes.push(`${ahead} unpushed commit${ahead === "1" ? "" : "s"}`);
  if (noUpstream) notes.push("the branch is not pushed");
  return notes.length ? `The cloud clones the pushed branch - ${notes.join(", ")} won't be there.` : null;
}

/** Where cloud sessions are listed in the browser. */
export const CLOUD_HOME = "https://claude.ai/code";
