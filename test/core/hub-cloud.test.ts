// Messages to a cloud session run `claude -p` in the project folder: a folder nobody trusted gets
// only the user's own settings there too (no .claude hooks, no .mcp.json servers). Starting,
// teleporting, the picker of all sessions and watching live run in the real terminal, here a fake
// runInTerminal (and a fake claude); the real CLI never runs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToCloud, type CloudSession } from "../../src/cloud/claude-cloud.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub, type TerminalRunner } from "../../src/core/hub.js";
import { findProgram } from "../../src/platform/process.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

vi.mock("../../src/cloud/claude-cloud.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cloud/claude-cloud.js")>()),
  sendToCloud: vi.fn(async () => ({ ok: true, sessionId: "session_q", url: null, error: null })),
}));

let dir = "";
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-cloud-"));
  const config = defaultConfig();
  // Any program that exists: the mocked sendToCloud never runs it.
  config.claudePath = process.execPath;
  hub = new Hub({
    config,
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
  vi.spyOn(hub, "launch").mockResolvedValue(undefined);
  vi.mocked(sendToCloud).mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p);
  return p;
}

describe("sendCloud", () => {
  it("passes the trust of the open tab in that folder, and none for a folder that isn't open", async () => {
    const mine = await hub.openProject({ cwd: folder("mine") });
    const clone = await hub.openProject({ cwd: folder("clone"), origin: "github:mallory/evil", trusted: false });
    await hub.sendCloud({ id: "session_a", cwd: mine.cwd }, "hi");
    await hub.sendCloud({ id: "session_b", cwd: clone.cwd }, "hi");
    await hub.sendCloud({ id: "session_c", cwd: folder("elsewhere") }, "hi");
    const trusted = vi.mocked(sendToCloud).mock.calls.map(([, id, , opts]) => [id, opts?.trusted]);
    expect(trusted).toEqual([
      ["session_a", true],
      ["session_b", false],
      ["session_c", false],
    ]);
  });
});

/** A fake runInTerminal that remembers what it was asked to run and exits with `code`. */
function recorder(code: number | null = 0, onRun?: (exe: string, args: string[]) => void) {
  const calls: Array<{ exe: string; args: string[]; cwd?: string }> = [];
  const run: TerminalRunner = async (exe, args, opts) => {
    calls.push({ exe, args, cwd: opts?.cwd });
    onRun?.(exe, args);
    return code;
  };
  /** The arguments claude got (after the shell that waits on a failure, where there is one). */
  const claudeArgs = (i: number) => {
    const c = calls[i];
    return c.exe === hub.config.claudePath ? c.args : c.args.slice(c.args.indexOf(hub.config.claudePath!) + 1);
  };
  return { run, calls, claudeArgs };
}

function remember(cwd: string, id = "session_01abcdef"): CloudSession {
  const project = { cwd } as never;
  return hub.addCloudSession(project, "Fix the flaky login test", `https://claude.ai/code/${id}`)!;
}

describe("messageCloud", () => {
  it("says how it went, keeps the short error on the session and remembers it for /cloud msg", async () => {
    const s = remember(folder("p"));
    hub.pickedCloudId = null;
    let release: () => void = () => undefined;
    vi.mocked(sendToCloud).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true, sessionId: s.id, url: `${s.url}?from=cli`, error: null }))),
    );
    const sent = hub.messageCloud(s, "also add a test");
    expect(hub.cloudSending.has(s.id)).toBe(true);
    expect(hub.pickedCloudId).toBe(s.id);
    release();
    expect(await sent).toBe(true);
    expect(hub.cloudSending.has(s.id)).toBe(false);
    expect(hub.toasts.at(-1)).toMatchObject({ level: "success", text: 'Sent to "Fix the flaky login test" - queued as the cloud session\'s next message.' });
    expect(s.lastMessageAt).not.toBeNull();

    vi.mocked(sendToCloud).mockResolvedValueOnce({
      ok: false,
      sessionId: s.id,
      url: null,
      error: `Error: failed to send message to cloud session ${s.id}: cloud session ${s.id} is archived and cannot accept new messages`,
    });
    expect(await hub.messageCloud(s, "and another")).toBe(false);
    expect(hub.toasts.at(-1)).toMatchObject({ level: "error", text: `Cloud: Cloud session ${s.id} is archived and cannot accept new messages` });
    expect(s.lastError).toContain("is archived");
  });
});

describe("cloud sessions in the real terminal", () => {
  it("teleports one, opens Claude Code's picker of all of them and watches live, all in the project's folder", async () => {
    const project = await hub.openProject({ cwd: folder("repo") });
    const s = remember(project.cwd);
    hub.pickedCloudId = null;
    const r = recorder(0);
    await hub.teleport(project, s, r.run);
    await hub.browseCloud(project, r.run);
    expect(await hub.watchCloud(project, s, r.run)).toBe(true);
    expect([r.claudeArgs(0), r.claudeArgs(1), r.claudeArgs(2)]).toEqual([["--teleport", s.id], ["--teleport"], ["--cloud", s.id]]);
    expect(r.calls.map((c) => c.cwd)).toEqual([project.cwd, project.cwd, project.cwd]);
    // Nothing went wrong, so nothing to say; the session is the one /cloud msg writes to now.
    expect(hub.toasts.filter((t) => t.level === "warning")).toEqual([]);
    expect(hub.pickedCloudId).toBe(s.id);
  });

  it("points to teleport when the account can't watch live, and forgets the pick with the session", async () => {
    const project = await hub.openProject({ cwd: folder("repo") });
    const s = remember(project.cwd);
    expect(await hub.watchCloud(project, s, recorder(1).run)).toBe(false);
    expect(hub.toasts.at(-1)?.text).toContain("t (teleport) works for everyone");
    hub.forgetCloud(s.id);
    expect(hub.pickedCloudId).toBeNull();
  });

  const hasScript = process.platform !== "win32" && findProgram("script") !== null;
  it.runIf(hasScript)("starts a session from the link Claude Code printed, and says its error instead of asking for a link", async () => {
    const project = await hub.openProject({ cwd: folder("repo") });
    const printing = (text: string) =>
      recorder(0, (_exe, args) => {
        const transcript = args.find((a) => a.endsWith("session.log"));
        if (transcript) fs.writeFileSync(transcript, text);
      });
    const started = await hub.startCloud(project, "Fix it", printing("✓ Session ready\r\nView: https://claude.ai/code/session_01Started?from=cli\r\n").run);
    expect(started).toMatchObject({ id: "session_01Started", task: "Fix it", cwd: project.cwd });
    expect(hub.pickedCloudId).toBe("session_01Started");
    await expect(
      hub.startCloud(project, "Fix it", printing("Error: Cloud sessions are disabled by your organization's policy. Contact your organization admin to enable them.\r\n").run),
    ).rejects.toThrow("Claude Code: Cloud sessions are disabled by your organization's policy.");
    // Nothing to go on (cancelled): the dialog asks for the link.
    expect(await hub.startCloud(project, "Fix it", printing("").run)).toBeNull();
  });

  // The real wrapper and a fake claude: the "terminal" here is a pipe that presses enter.
  it.runIf(process.platform !== "win32")("runs a fake claude through the wrapper that waits after a failure", async () => {
    const project = await hub.openProject({ cwd: folder("repo") });
    const s = remember(project.cwd);
    const log = path.join(dir, "fake-claude.log");
    const fake = path.join(dir, "claude");
    fs.writeFileSync(
      fake,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `const argv = process.argv.slice(2);\n` +
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");\n` +
        `if (argv[0] === "--cloud") { console.log("Error: Attaching to an existing cloud session is not enabled for your account."); process.exit(1); }\n`,
      { mode: 0o755 },
    );
    hub.config.claudePath = fake;
    const outputs: string[] = [];
    const terminal: TerminalRunner = async (exe, args, opts) => {
      const r = spawnSync(exe, args, { cwd: opts?.cwd, env: opts?.env, input: "\n", encoding: "utf8", timeout: 15_000 });
      outputs.push(r.stdout);
      return r.status;
    };
    expect(await hub.watchCloud(project, s, terminal)).toBe(false);
    await hub.browseCloud(project, terminal);
    const runs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(runs.map((x) => x.argv)).toEqual([["--cloud", s.id], ["--teleport"]]);
    expect(runs.every((x) => fs.realpathSync(x.cwd) === fs.realpathSync(project.cwd))).toBe(true);
    expect(outputs[0]).toContain("not enabled for your account");
    expect(outputs[0]).toContain("Press enter to go back to lu-minal");
    expect(outputs[1]).not.toContain("Press enter");
    expect(hub.toasts.at(-1)?.text).toContain("t (teleport) works for everyone");
  });
});
