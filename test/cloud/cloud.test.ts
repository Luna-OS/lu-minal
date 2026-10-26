import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cliError,
  cloudReadiness,
  cloudStartCommand,
  cloudTarget,
  parseCloudSession,
  parseSendResult,
  pausingCommand,
  sendToCloud,
  sessionFromTranscript,
  shortCloudError,
  shQuote,
  takeTranscript,
  teleportArgs,
  teleportPickerArgs,
  watchArgs,
  type CloudSession,
} from "../../src/cloud/claude-cloud.js";
import type { RunResult } from "../../src/platform/process.js";

describe("parseCloudSession", () => {
  it("finds the session in CLI output, a pasted link or a bare id", () => {
    const out = "\u001b[32m✓\u001b[0m Session ready\nOpen in browser: https://claude.ai/code/session_01AbCdEf123?from=cli\n";
    expect(parseCloudSession(out)).toEqual({ id: "session_01AbCdEf123", url: "https://claude.ai/code/session_01AbCdEf123" });
    expect(parseCloudSession("cse_9xYz_42-ab")?.id).toBe("cse_9xYz_42-ab");
    expect(parseCloudSession("nothing here")).toBeNull();
  });
});

describe("cloudStartCommand", () => {
  it("runs plainly on Windows and records through script elsewhere", () => {
    expect(cloudStartCommand("C:\\claude.exe", "fix it", { platform: "win32" })).toEqual({
      exe: "C:\\claude.exe",
      args: ["--cloud", "fix it"],
      transcript: null,
    });
    const mac = cloudStartCommand("/usr/local/bin/claude", "fix it", { platform: "darwin", transcript: "/tmp/t.log" });
    if (mac.transcript) expect(mac.args).toEqual(["-q", "/tmp/t.log", "/usr/local/bin/claude", "--cloud", "fix it"]);
    const linux = cloudStartCommand("/usr/bin/claude", "fix 'it'", { platform: "linux", transcript: "/tmp/t.log" });
    if (linux.transcript) expect(linux.args).toEqual(["-q", "-e", "-c", "/usr/bin/claude --cloud 'fix '\\''it'\\'''", "/tmp/t.log"]);
  });

  it.runIf(process.platform !== "win32")("records into a private folder of its own, removed with the transcript", async () => {
    const c = cloudStartCommand("/usr/bin/claude", "fix it", { platform: process.platform });
    if (!c.transcript) return; // no `script` here
    const dir = path.dirname(c.transcript);
    expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir)).toMatch(/^lu-minal-cloud-/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(c.args).toContain(c.transcript);
    expect(sessionFromTranscript(c.transcript)).toBeNull();
    await vi.waitFor(() => expect(fs.existsSync(dir)).toBe(false));
  });

  it("quotes for a POSIX shell", () => {
    expect(shQuote("plain-arg_1")).toBe("plain-arg_1");
    expect(shQuote("two words")).toBe("'two words'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("transcripts and replies", () => {
  it("reads the session from a transcript and removes the file", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lu-cloud-")), "t.log");
    fs.writeFileSync(file, "Setting up…\r\nView: https://claude.ai/code/session_abcdef123\r\n");
    expect(sessionFromTranscript(file)?.id).toBe("session_abcdef123");
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(file)).toBe(false);
    expect(sessionFromTranscript(null)).toBeNull();
  });

  it("parses the JSON and text replies of a follow-up message", () => {
    expect(parseSendResult('{"ok":true,"session_id":"session_x1y2z3","url":"https://claude.ai/code/session_x1y2z3?from=cli&m=0"}')).toEqual({
      ok: true,
      sessionId: "session_x1y2z3",
      url: "https://claude.ai/code/session_x1y2z3?from=cli&m=0",
      error: null,
    });
    expect(parseSendResult('{"ok":false,"session_id":"session_x","error":"Session archived"}')).toMatchObject({ ok: false, error: "Session archived" });
    expect(parseSendResult("Sent to cloud session.\nSession ID: session_abc123\nView: https://claude.ai/code/session_abc123")).toMatchObject({ ok: true, sessionId: "session_abc123" });
    expect(parseSendResult("", "error: not signed in")).toMatchObject({ ok: false, error: "error: not signed in" });
  });

  it("sends with -p --cloud and json output, with only the user's own settings unless the folder is trusted", async () => {
    let seen: string[] = [];
    const run = async (_exe: string, args: string[]): Promise<RunResult> => {
      seen = args;
      return { code: 0, stdout: '{"ok":true,"session_id":"session_q","url":"https://claude.ai/code/session_q"}\n', stderr: "", timedOut: false };
    };
    const r = await sendToCloud("claude", "session_q", "also add tests", { run: run as never });
    expect(seen).toEqual(["-p", "also add tests", "--cloud", "session_q", "--output-format", "json", "--setting-sources", "user", "--strict-mcp-config"]);
    expect(r.ok).toBe(true);
    await sendToCloud("claude", "session_q", "also add tests", { run: run as never, trusted: true });
    expect(seen).toEqual(["-p", "also add tests", "--cloud", "session_q", "--output-format", "json"]);
  });
});

describe("cloudReadiness", () => {
  const fake = (answers: Record<string, Partial<RunResult>>) =>
    (async (_exe: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...(answers[key] ?? {}) };
    }) as never;

  it("warns about unpushed work and missing remotes", async () => {
    const ok = await cloudReadiness(process.cwd(), fake({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "remote get-url": { stdout: "https://github.com/Luna-OS/lu-minal.git\n" },
      "status --porcelain=v1": { stdout: "## main...origin/main\n" },
    }));
    expect(ok).toBeNull();
    const ahead = await cloudReadiness(process.cwd(), fake({
      "remote get-url": { stdout: "git@github.com:Luna-OS/lu-minal.git\n" },
      "status --porcelain=v1": { stdout: "## main...origin/main [ahead 2]\n M src/a.ts\n" },
    }));
    expect(ahead).toContain("2 unpushed commits");
    expect(ahead).toContain("1 uncommitted change");
    const noRemote = await cloudReadiness(process.cwd(), fake({ "remote get-url": { code: 2 } }));
    expect(noRemote).toContain("bundle");
  });
});

describe("errors", () => {
  it("picks Claude Code's error out of a recorded start, and shortens send errors", () => {
    const said =
      "\u001b[2K\u001b[1G◐ Checking your account…\r\nError: Cloud sessions need a claude.ai sign-in. Run `claude auth login` (or /login in a local session), then try again.\r\n";
    expect(cliError(said)).toBe("Cloud sessions need a claude.ai sign-in. Run `claude auth login` (or /login in a local session), then try again.");
    expect(cliError("Setting up…\nView: https://claude.ai/code/session_abc123\n")).toBeNull();
    expect(
      shortCloudError("Error: failed to send message to cloud session session_x1: cloud session session_x1 is archived and cannot accept new messages"),
    ).toBe("Cloud session session_x1 is archived and cannot accept new messages");
    expect(shortCloudError("Error: failed to send message to cloud session https://claude.ai/code/session_x1: Session not found: session_x1")).toBe(
      "Session not found: session_x1",
    );
    expect(shortCloudError("error: not signed in")).toBe("Not signed in");
    expect(shortCloudError("Session archived")).toBe("Session archived");
  });

  it("takes a transcript's text and removes the file", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lu-cloud-")), "t.log");
    fs.writeFileSync(file, "Error: Unable to get organization UUID\n");
    expect(takeTranscript(file)).toContain("organization UUID");
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
    expect(takeTranscript(null)).toBeNull();
  });
});

describe("the terminal commands", () => {
  it("teleports one session, opens the picker of all of them, and watches with --cloud but no -p", () => {
    expect(teleportArgs("session_a1b2c3")).toEqual(["--teleport", "session_a1b2c3"]);
    expect(teleportPickerArgs()).toEqual(["--teleport"]);
    expect(watchArgs("session_a1b2c3")).toEqual(["--cloud", "session_a1b2c3"]);
  });

  it("runs the program plainly on Windows (no POSIX shell to wait in)", () => {
    expect(pausingCommand("C:\\claude.exe", ["--teleport"], "win32")).toEqual({ exe: "C:\\claude.exe", args: ["--teleport"], pauses: false });
  });

  it.runIf(process.platform !== "win32")("waits for enter after a failure and keeps the exit code; a success goes straight back", () => {
    const fail = pausingCommand(process.execPath, ["-e", "console.log('Attaching to an existing cloud session is not enabled for your account.'); process.exit(3)"]);
    expect(fail.pauses).toBe(true);
    const r = spawnSync(fail.exe, fail.args, { input: "\n", encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("is not enabled for your account.");
    expect(r.stdout).toContain("Claude Code stopped (exit code 3). Press enter to go back to lu-minal.");
    const ok = pausingCommand(process.execPath, ["-e", "process.exit(0)"]);
    const r2 = spawnSync(ok.exe, ok.args, { input: "", encoding: "utf8", timeout: 10_000 });
    expect(r2.status).toBe(0);
    expect(r2.stdout).not.toContain("Press enter");
  });

  it.runIf(process.platform !== "win32")("hands the arguments over untouched (quotes, spaces, $)", () => {
    const args = ["it's", "$HOME", "two words", "--cloud", "session_x"];
    const cmd = pausingCommand(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args]);
    const r = spawnSync(cmd.exe, cmd.args, { input: "", encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(r.stdout.trim())).toEqual(args);
  });
});

describe("cloudTarget", () => {
  const s = (id: string, cwd: string, startedAt: number): CloudSession => ({
    id,
    url: `https://claude.ai/code/${id}`,
    task: id,
    cwd,
    startedAt,
    lastMessageAt: null,
    lastError: null,
  });

  it("messages the session used last, else the newest from this folder, else the newest", () => {
    const list = [s("session_oldhere", "/work/a", 1), s("session_newhere", "/work/a", 5), s("session_newest", "/work/b", 9)];
    expect(cloudTarget(list, "/work/a", null)?.id).toBe("session_newhere");
    expect(cloudTarget(list, "/work/c", null)?.id).toBe("session_newest");
    expect(cloudTarget(list, null, null)?.id).toBe("session_newest");
    expect(cloudTarget(list, "/work/a", "session_newest")?.id).toBe("session_newest");
    // A forgotten one doesn't count.
    expect(cloudTarget(list, "/work/a", "session_gone")?.id).toBe("session_newhere");
    expect(cloudTarget([], "/work/a", null)).toBeNull();
  });
});
