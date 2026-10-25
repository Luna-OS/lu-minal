import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeDriver, type McpLink } from "../../src/agents/claude-code/driver.js";
import type { ClaudeRateLimitEvent } from "../../src/agents/claude-code/events.js";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";
import type { LogEntry } from "../../src/core/types.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

interface Start {
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
  pid: number;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function setup(opts: {
  env?: Record<string, string>;
  mcp?: Partial<McpLink>;
  exe?: string;
  platform?: NodeJS.Platform;
  register?: McpLink["register"];
  onSpawn?: (args: string[], options: SpawnOptions) => void;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-driver-"));
  const logFile = path.join(dir, "starts.jsonl");
  const notifier = new Notifier();
  const runtime: ProjectRuntime = {
    launch: async () => undefined,
    defaultWorkerModel: () => ({ provider: "claude-code", model: "sonnet" }),
  };
  const project = new Project({ cwd: dir, name: "demo", permissionMode: "auto-edit" }, notifier, runtime);
  const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, notifier, "auto-edit");
  project.agents.push(agent);
  const unregistered: string[] = [];
  const configFile = path.join(dir, "mcp", `${agent.id}.json`);
  const mcp: McpLink = {
    register: opts.register ?? (async () => ({ configFile, serverName: "luminal" })),
    unregister: (id) => {
      unregistered.push(id);
    },
    ...opts.mcp,
  };
  const rateLimits: ClaudeRateLimitEvent[] = [];
  const children: ChildProcess[] = [];
  const driver = new ClaudeCodeDriver({
    agent,
    project,
    exe: opts.exe ?? "claude",
    mcp,
    systemPrompt: () => "You are luna, the lead of team demo.\nTalk to vega with send_message.",
    onRateLimit: (ev) => rateLimits.push(ev),
    spawnImpl: (_exe, args, options) => {
      opts.onSpawn?.(args, options);
      const child = spawn(process.execPath, [FAKE, ...args], options);
      children.push(child);
      return child;
    },
    env: { ...process.env, FAKE_CLAUDE_LOG: logFile, ...opts.env },
    interruptGraceMs: 300,
    queueGraceMs: 2000,
    platform: opts.platform,
  });
  agent.driver = driver;
  const endTurns = vi.spyOn(agent, "endTurn");
  cleanups.push(async () => {
    await driver.dispose();
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const starts = (): Start[] =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Start)
      : [];
  const kinds = () => agent.log.map((e) => e.kind);
  const texts = () => agent.log.filter((e): e is Extract<LogEntry, { kind: "text" }> => e.kind === "text").map((e) => e.text);
  const tools = () => agent.log.filter((e): e is Extract<LogEntry, { kind: "tool" }> => e.kind === "tool");
  const idle = (what = "the turn to end") => waitFor(() => agent.status === "idle" && agent.turnStartedAt === null, what);
  return { dir, agent, project, driver, mcp, unregistered, rateLimits, children, starts, kinds, texts, tools, idle, endTurns, configFile };
}

describe("ClaudeCodeDriver", () => {
  it("runs a turn: streamed text, reasoning, usage, session, rate limit", async () => {
    const t = setup();
    await t.driver.start();
    expect(t.agent.status).toBe("idle");

    t.agent.deliver({ from: "you", text: "hello" });
    expect(t.agent.status).toBe("working");
    await t.idle();

    expect(t.kinds()).toEqual(["user", "reasoning", "text"]);
    const [, reasoning, text] = t.agent.log as any[];
    expect(reasoning).toMatchObject({ text: "Let me think.", streaming: false });
    expect(text).toMatchObject({ text: "Hello there!", streaming: false });
    expect(t.texts()).not.toContain("inner");

    const [start] = t.starts();
    expect(t.agent.sessionId).toBe(`sess-${start.pid}`);
    expect(t.agent.tokensIn).toBe(10 + 4141);
    expect(t.agent.tokensOut).toBe(12);
    expect(t.agent.contextTokens).toBe(4151);
    expect(t.agent.costUsd).toBeCloseTo(0.01, 6);
    expect(t.rateLimits).toHaveLength(1);
    expect(t.rateLimits[0].fiveHour).toEqual({ utilization: 0.48, resetsAt: 1791081600000 });
    expect(t.endTurns.mock.calls).toEqual([["idle"]]);

    // The command line and the environment.
    expect(fs.realpathSync(start.cwd)).toBe(fs.realpathSync(t.dir));
    expect(start.argv.slice(0, 7)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
    expect(flagValue(start.argv, "--model")).toBe("opus");
    expect(flagValue(start.argv, "--permission-mode")).toBe("acceptEdits");
    expect(flagValue(start.argv, "--mcp-config")).toBe(t.configFile);
    expect(flagValue(start.argv, "--permission-prompt-tool")).toBe("mcp__luminal__approve");
    expect(flagValue(start.argv, "--allowedTools")).toBe("mcp__luminal");
    expect(flagValue(start.argv, "--append-system-prompt")).toMatch(/^You are luna/);
    expect(start.argv).not.toContain("--resume");
    expect(start.env.MCP_TOOL_TIMEOUT).toBe("86400000");
  });

  it("keeps one process across messages and counts only the cost each turn added", async () => {
    const t = setup({ env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "outer" } });
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    t.agent.deliver({ from: "vega", text: "please review the room" });
    await t.idle();
    expect(t.starts()).toHaveLength(1);
    expect(t.texts()).toEqual(["Hello there!", "got [message from vega] please review the room"]);
    // total_cost_usd is a running total (0.01, then 0.02).
    expect(t.agent.costUsd).toBeCloseTo(0.02, 6);
    expect(t.starts()[0].env).toMatchObject({ CLAUDECODE: null, CLAUDE_CODE_SESSION_ID: null });
  });

  it("a model of 'default' passes no --model", async () => {
    const t = setup();
    t.agent.model = { provider: "claude-code", model: "default" };
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    expect(t.starts()[0].argv).not.toContain("--model");
  });

  it("shows an Edit as a diff at the file's real line and counts its lines", async () => {
    const t = setup();
    const file = path.join(t.dir, "room.lua");
    fs.writeFileSync(file, ["-- room", "local a = 1", "local b = 2", "", "local c = 3", "local d = 4", "old line", "return a"].join("\n"));
    await t.driver.start();
    t.agent.deliver({ from: "you", text: `edit ${file}` });
    await t.idle();
    const [row] = t.tools();
    expect(row).toMatchObject({ name: "Edit", verb: "edit", target: "room.lua", status: "ok", added: 2, removed: 1 });
    expect(row.diff).toEqual([
      { kind: "del", line: 7, text: "old line" },
      { kind: "add", line: 7, text: "new line" },
      { kind: "add", line: 8, text: "another line" },
    ]);
    expect(row.detail).toBe("1 line changed, 1 line added");
    expect(t.agent.linesAdded).toBe(2);
    expect(t.agent.linesRemoved).toBe(1);
    expect(t.texts()).toEqual(["Done."]);
    // Two model responses: input counted for both.
    expect(t.agent.tokensIn).toBe(2 * 4151);
    expect(t.agent.tokensOut).toBe(23);
  });

  it("uses the CLI's structured patch for a Write", async () => {
    const t = setup();
    const file = path.join(t.dir, "abc.txt");
    fs.writeFileSync(file, "a\nb\nc\n");
    await t.driver.start();
    t.agent.deliver({ from: "you", text: `write ${file}` });
    await t.idle();
    const [row] = t.tools();
    expect(row).toMatchObject({ verb: "write", target: "abc.txt", status: "ok", detail: "1 line changed" });
    expect(row.diff).toEqual([
      { kind: "ctx", line: 1, text: "a" },
      { kind: "del", line: 2, text: "b" },
      { kind: "add", line: 2, text: "B" },
      { kind: "ctx", line: 3, text: "c" },
    ]);
  });

  it("marks a failed command with its exit code", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "bash" });
    await t.idle();
    expect(t.tools()[0]).toMatchObject({ verb: "run", target: "npm test", status: "error", detail: 'exit 1 · npm ERR! Missing script: "test"' });
  });

  it("asks the MCP server how lu-minal's own tools look", async () => {
    const describeTool = vi.fn(() => ({ verb: "message", target: "→ vega" }));
    const takeDisplay = vi.fn(() => ({ display: { detail: "sent to vega" }, isError: false }));
    const t = setup({ mcp: { describeTool, takeDisplay } });
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "luminal" });
    await t.idle();
    expect(describeTool).toHaveBeenCalledWith(t.agent.id, "send_message", { to: "vega", text: "please review" });
    expect(takeDisplay).toHaveBeenCalledWith(t.agent.id, {
      toolUseId: expect.stringMatching(/^toolu_msg_/),
      name: "mcp__luminal__send_message",
      input: { to: "vega", text: "please review" },
    });
    expect(t.tools()[0]).toMatchObject({ verb: "message", target: "→ vega", status: "ok", detail: "sent to vega" });
  });

  it("falls back to the result text for lu-minal's tools without a server display", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "luminal" });
    await t.idle();
    expect(t.tools()[0]).toMatchObject({ verb: "message", target: "→ vega", detail: "Delivered to vega." });
  });

  it("reports permission denials the log doesn't show yet", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "deny" });
    await t.idle();
    expect(t.agent.log.some((e) => e.kind === "info" && e.text === "Claude Code was not allowed to run rm -rf build.")).toBe(true);
  });

  it("ends a failed turn with an error and a sign-in hint", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "fail" });
    await waitFor(() => t.agent.status === "error", "the error status");
    const error = t.agent.log.find((e) => e.kind === "error") as any;
    expect(error.text).toContain("Invalid API key");
    expect(error.text).toContain("/login");
    expect(t.endTurns.mock.calls).toEqual([["error"]]);
  });

  it("reports a crash with stderr and resumes the session on the next message", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "crash" });
    await waitFor(() => t.agent.status === "error", "the crash");
    const first = t.starts()[0];
    const error = t.agent.log.find((e) => e.kind === "error") as any;
    expect(error.text).toContain("exit code 3");
    expect(error.text).toContain("fatal: something broke");
    expect(t.driver.stderr).toEqual(["fatal: something broke", "at main (cli.js:1:1)"]);
    expect(t.agent.sessionId).toBe(`sess-${first.pid}`);

    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(flagValue(starts[1].argv, "--resume")).toBe(`sess-${first.pid}`);
    expect(t.texts()).toEqual(["Hello there!"]);
  });

  it("interrupts softly: the process stays and takes the next message", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "slow" });
    await waitFor(() => t.texts().includes("Working"), "the streamed text");
    t.agent.interrupt();
    await t.idle("the interrupt");
    expect(t.endTurns.mock.calls).toEqual([["idle"]]);
    const first = t.children[0];
    expect(first.exitCode).toBeNull();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    expect(t.starts()).toHaveLength(1);
    expect(t.texts()).toEqual(["Working", "Hello there!"]);
  });

  it("kills a process that ignores the interrupt and resumes next time", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hang" });
    await waitFor(() => t.texts().includes("Working"), "the streamed text");
    const began = Date.now();
    t.agent.interrupt();
    await t.idle("the hard stop");
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    await waitFor(() => t.children[0].exitCode !== null || t.children[0].signalCode !== null, "the old process to end");
    expect(t.agent.log.some((e) => e.kind === "error")).toBe(false);

    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(flagValue(starts[1].argv, "--resume")).toBe(`sess-${starts[0].pid}`);
  });

  it("sends a message that arrives during a soft interrupt once the turn has stopped", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "slow" });
    await waitFor(() => t.texts().includes("Working"), "the streamed text");
    t.agent.interrupt();
    t.agent.deliver({ from: "you", text: "hello" });
    await waitFor(() => t.texts().includes("Hello there!") && t.agent.status === "idle", "the new message's answer");
    expect(t.starts()).toHaveLength(1);
    expect(t.endTurns.mock.calls).toEqual([["idle"], ["idle"]]);
  });

  it("sends a message that arrives during a hard interrupt to the resumed process", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hang" });
    await waitFor(() => t.texts().includes("Working"), "the streamed text");
    t.agent.interrupt();
    t.agent.deliver({ from: "you", text: "hello" });
    expect(t.agent.status).toBe("working");
    await waitFor(() => t.texts().includes("Hello there!") && t.agent.status === "idle", "the new message's answer");
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(flagValue(starts[1].argv, "--resume")).toBe(`sess-${starts[0].pid}`);
  });

  it("a second interrupt drops what was sent during the first", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hang" });
    await waitFor(() => t.texts().includes("Working"), "the streamed text");
    t.agent.interrupt();
    t.agent.deliver({ from: "you", text: "hello" });
    t.agent.interrupt();
    await t.idle("the hard stop");
    await new Promise((r) => setTimeout(r, 200));
    expect(t.starts()).toHaveLength(1);
    expect(t.texts()).toEqual(["Working"]);
  });

  it("restarts an idle process with --resume when the permission mode changed", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "mode" });
    await t.idle();
    t.agent.permissionMode = "plan";
    t.agent.deliver({ from: "you", text: "mode" });
    await t.idle();
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(flagValue(starts[1].argv, "--permission-mode")).toBe("plan");
    expect(flagValue(starts[1].argv, "--resume")).toBe(`sess-${starts[0].pid}`);
    expect(t.texts()).toEqual(["mode=acceptEdits", "mode=plan"]);
  });

  it("switches a busy process's mode in place and counts both turns", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "pause" });
    t.agent.permissionMode = "yolo";
    t.agent.deliver({ from: "you", text: "mode" });
    expect(t.agent.queued).toBe(1);
    await waitFor(() => t.texts().length === 2 && t.agent.status === "idle", "both turns");
    expect(t.texts()).toEqual(["Paused.", "mode=bypassPermissions"]);
    expect(t.endTurns.mock.calls).toEqual([["idle"]]);
    expect(t.starts()).toHaveLength(1);
    expect(t.agent.queued).toBe(0);
  });

  it("restarts later when the CLI refuses the mode switch", async () => {
    const t = setup({ env: { FAKE_CLAUDE_REFUSE_MODE: "1" } });
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "pause" });
    t.agent.permissionMode = "yolo";
    t.agent.deliver({ from: "you", text: "mode" });
    await waitFor(() => t.texts().length === 2 && t.agent.status === "idle", "both turns");
    expect(t.texts()[1]).toBe("mode=acceptEdits");
    t.agent.deliver({ from: "you", text: "mode" });
    await t.idle();
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(flagValue(starts[1].argv, "--permission-mode")).toBe("bypassPermissions");
    expect(t.texts()[2]).toBe("mode=bypassPermissions");
  });

  it("answers the CLI's own permission requests through the agent's approvals", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "ask" });
    await waitFor(() => t.agent.pendingApproval !== null, "the approval request");
    expect(t.agent.status).toBe("waiting");
    expect(t.agent.pendingApproval).toMatchObject({ tool: "Bash", risk: "exec", summary: "run npm publish", allowKey: "Bash:npm publish" });
    t.agent.answerApproval("deny");
    await t.idle();
    expect(t.texts()).toEqual(["behavior=deny"]);

    t.agent.deliver({ from: "you", text: "ask" });
    await waitFor(() => t.agent.pendingApproval !== null, "the second request");
    t.agent.answerApproval("always");
    await t.idle();
    expect(t.texts()[1]).toBe("behavior=allow");
    // "always" is remembered: the third request is not shown at all.
    t.agent.deliver({ from: "you", text: "ask" });
    await t.idle();
    expect(t.texts()[2]).toBe("behavior=allow");
  });

  it("starts a new conversation when the one to resume is gone", async () => {
    const t = setup({ env: { FAKE_CLAUDE_MISSING_SESSION: "gone-1" } });
    t.agent.sessionId = "gone-1";
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(flagValue(starts[0].argv, "--resume")).toBe("gone-1");
    expect(starts[1].argv).not.toContain("--resume");
    expect(t.texts()).toEqual(["Hello there!"]);
    expect(t.agent.sessionId).toBe(`sess-${starts[1].pid}`);
    expect(t.agent.log.some((e) => e.kind === "info" && /could not be resumed/.test(e.text))).toBe(true);
    expect(t.agent.log.some((e) => e.kind === "error")).toBe(false);
  });

  it("takes messages sent before start() finished", async () => {
    let release = () => {};
    const t = setup({
      register: () =>
        new Promise((resolve) => {
          release = () => resolve({ configFile: "x.json", serverName: "luminal" });
        }),
    });
    const started = t.driver.start();
    t.driver.send({ from: "you", text: "hello" });
    expect(t.starts()).toHaveLength(0);
    release();
    await started;
    await t.idle();
    expect(t.texts()).toEqual(["Hello there!"]);
  });

  it("runs without lu-minal's tools when the MCP server can't register it", async () => {
    const t = setup({ register: async () => Promise.reject(new Error("MCP server is down")) });
    await t.driver.start();
    expect(t.agent.status).toBe("idle");
    expect(t.agent.log.some((e) => e.kind === "info" && e.text.includes("MCP server is down"))).toBe(true);
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    const [start] = t.starts();
    expect(start.argv).not.toContain("--mcp-config");
    expect(start.argv).not.toContain("--permission-prompt-tool");
    expect(start.argv).not.toContain("--allowedTools");
  });

  it("warns when Claude Code could not connect to lu-minal's MCP server", async () => {
    const t = setup({ env: { FAKE_CLAUDE_MCP_STATUS: "failed" } });
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    expect(t.agent.log.some((e) => e.kind === "info" && e.text.includes("MCP: failed"))).toBe(true);
  });

  it("puts the prompt into a file for a Windows .cmd shim", async () => {
    let promptFile = "";
    let promptText = "";
    const t = setup({
      exe: "C:\\Users\\luna\\AppData\\Roaming\\npm\\claude.cmd",
      platform: "win32",
      onSpawn: (args) => {
        promptFile = flagValue(args, "--append-system-prompt-file") ?? "";
        promptText = promptFile ? fs.readFileSync(promptFile, "utf8") : "";
        expect(args).not.toContain("--append-system-prompt");
      },
    });
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    expect(path.dirname(promptFile)).toBe(path.dirname(t.configFile));
    expect(promptText).toBe("You are luna, the lead of team demo.\nTalk to vega with send_message.");
  });

  it("shows a compaction as the agent's activity, then goes back to its verb", async () => {
    const t = setup();
    const activities = vi.spyOn(t.agent, "setActivity");
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "compact" });
    await t.idle();
    const shown = activities.mock.calls.map((c) => c[0]);
    expect(shown[0]).toBe("Compacting");
    expect(shown[1]).toMatch(/^[A-Z][a-z]+ing$/);
    expect(shown[1]).not.toBe("Compacting");
    expect(t.agent.contextTokens).toBe(900 + 4141);
    expect(t.texts()).toEqual(["Compacted."]);
  });

  it("handles CRLF output", async () => {
    const t = setup({ env: { FAKE_CLAUDE_CRLF: "1" } });
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "hello" });
    await t.idle();
    expect(t.texts()).toEqual(["Hello there!"]);
  });

  it("dispose ends the process and unregisters from MCP", async () => {
    const t = setup();
    await t.driver.start();
    t.agent.deliver({ from: "you", text: "slow" });
    await waitFor(() => t.texts().includes("Working"), "the streamed text");
    const child = t.children[0];
    await t.driver.dispose();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(t.unregistered).toEqual([t.agent.id]);
    expect(t.agent.turnStartedAt).toBeNull();
    // A disposed driver takes no more messages.
    t.driver.send({ from: "you", text: "hello" });
    expect(t.starts()).toHaveLength(1);
  });
});
