// The whole chain: a ClaudeCodeDriver starts the fake CLI with the MCP config McpServer wrote, and
// the fake talks to the server over HTTP like Claude Code does (approvals and lu-minal's tools).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeDriver } from "../../src/agents/claude-code/driver.js";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";
import type { LogEntry } from "../../src/core/types.js";
import { McpServer } from "../../src/mcp/server.js";
import type { Tool, ToolServices } from "../../src/tools/types.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

const echoTool: Tool = {
  name: "echo",
  description: "Echoes the text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  risk: "read",
  describe: (args) => ({ verb: "echo", target: `“${String(args.text)}”` }),
  run: async (args) => ({ content: `echo: ${args.text}`, display: { detail: "echoed 1 line", added: 1 } }),
  mcp: true,
};

let dir: string;
let server: McpServer;
let agent: Agent;
let driver: ClaudeCodeDriver;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-mcp-int-"));
  const notifier = new Notifier();
  const runtime: ProjectRuntime = { launch: async () => undefined, defaultWorkerModel: () => ({ provider: "x", model: "y" }) };
  const project = new Project({ cwd: dir, name: "demo" }, notifier, runtime);
  agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "sonnet" } }, notifier, "ask");
  project.agents.push(agent);
  server = new McpServer({
    stateDir: path.join(dir, "state"),
    resolve: (id) => (id === agent.id ? { agent, project, tools: [echoTool], services: {} as ToolServices } : null),
  });
  await server.start(0);
  driver = new ClaudeCodeDriver({
    agent,
    project,
    exe: "claude",
    mcp: server,
    systemPrompt: () => "You are luna.",
    spawnImpl: (_exe, args, options) => spawn(process.execPath, [FAKE, ...args], options),
  });
  agent.driver = driver;
  await driver.start();
});

afterEach(async () => {
  await driver.dispose();
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const texts = () => agent.log.filter((e): e is Extract<LogEntry, { kind: "text" }> => e.kind === "text").map((e) => e.text);
const idle = () => waitFor(() => agent.status === "idle" && agent.turnStartedAt === null, "the turn to end");

describe("Claude Code through lu-minal's MCP server", () => {
  it("routes the CLI's permission prompt to the user and back", async () => {
    agent.deliver({ from: "you", text: "mcp-approve npm run deploy" });
    await waitFor(() => agent.pendingApproval !== null, "the approval");
    expect(agent.pendingApproval).toMatchObject({ tool: "Bash", risk: "exec", summary: "run npm run deploy", allowKey: "Bash:npm run" });
    expect(agent.status).toBe("waiting");
    agent.answerApproval("allow");
    await idle();
    expect(texts()).toEqual(["approve=allow"]);

    agent.deliver({ from: "you", text: "mcp-approve rm -rf dist" });
    await waitFor(() => agent.pendingApproval !== null, "the second approval");
    agent.answerApproval("deny");
    await idle();
    expect(texts()[1]).toBe("approve=deny: The user denied this in lu-minal.");
  });

  it("an interrupt withdraws a pending permission prompt", async () => {
    agent.deliver({ from: "you", text: "mcp-approve make release" });
    await waitFor(() => agent.pendingApproval !== null, "the approval");
    agent.interrupt();
    await idle();
    expect(agent.pendingApproval).toBeNull();
    const entry = agent.log.find((e) => e.kind === "approval") as Extract<LogEntry, { kind: "approval" }>;
    await waitFor(() => entry.decision === "deny", "the denial");
  });

  it("drops a pending permission prompt when Claude Code dies while it waits", async () => {
    agent.deliver({ from: "you", text: "mcp-approve-die npm run deploy" });
    await waitFor(() => agent.pendingApproval !== null, "the approval");
    await waitFor(() => agent.turnStartedAt === null, "the turn to end");
    expect(agent.pendingApproval).toBeNull();
    expect(agent.status).toBe("error");
    expect(agent.log.some((e) => e.kind === "error" && /stopped unexpectedly \(exit code 9\)/.test(e.text))).toBe(true);
    const entry = agent.log.find((e) => e.kind === "approval") as Extract<LogEntry, { kind: "approval" }>;
    await waitFor(() => entry.decision === "deny", "the denial");
  });

  it("shows lu-minal's own tool call with the tool's verb and display", async () => {
    agent.deliver({ from: "you", text: "mcp-echo hello team" });
    await idle();
    const row = agent.log.find((e): e is Extract<LogEntry, { kind: "tool" }> => e.kind === "tool")!;
    expect(row).toMatchObject({
      name: "mcp__luminal__echo",
      verb: "echo",
      target: "“hello team”",
      status: "ok",
      detail: "echoed 1 line",
      added: 1,
    });
    // Counted once, by runToolCall in the server.
    expect(agent.linesAdded).toBe(1);
    expect(texts()).toEqual(["tools=echo,approve"]);
  });
});
