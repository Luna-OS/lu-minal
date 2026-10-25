// `claude -p` skips Claude Code's workspace-trust dialog, so in a repository nobody trusted yet (a
// fresh clone) lu-minal starts it with only the user's own settings and its own MCP server: the
// repository's .claude/settings.json (hooks, apiKeyHelper, allow rules) and .mcp.json don't run.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeDriver } from "../../src/agents/claude-code/driver.js";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startArgs(origin: string, trusted?: boolean): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-untrusted-"));
  const runtime: ProjectRuntime = { launch: async () => undefined, defaultWorkerModel: () => ({ provider: "claude-code", model: "sonnet" }) };
  const notifier = new Notifier();
  const project = new Project({ cwd: dir, name: "demo", origin }, notifier, runtime);
  if (trusted !== undefined) project.setTrusted(trusted);
  const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, notifier, "auto-edit");
  project.agents.push(agent);
  let args: string[] = [];
  const children: ChildProcess[] = [];
  const driver = new ClaudeCodeDriver({
    agent,
    project,
    exe: "claude",
    mcp: { register: async () => ({ configFile: path.join(dir, "mcp.json"), serverName: "luminal" }), unregister: () => undefined },
    systemPrompt: () => "You are luna.",
    spawnImpl: (_exe, a, options) => {
      args = a;
      const child = spawn(process.execPath, [FAKE, ...a], options);
      children.push(child);
      return child;
    },
    env: { ...process.env, FAKE_CLAUDE_LOG: path.join(dir, "starts.jsonl") },
  });
  agent.driver = driver;
  cleanups.push(async () => {
    await driver.dispose();
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await driver.start();
  agent.deliver({ from: "you", text: "hello" });
  const until = Date.now() + 8000;
  while (!args.length && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return args;
}

describe("Claude Code in an untrusted workspace", () => {
  it("loads only the user's settings and lu-minal's MCP server for a fresh clone", async () => {
    const args = await startArgs("github:someone/repo");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
  });

  it("keeps the project's settings in a folder the user opened or trusted", async () => {
    for (const args of [await startArgs("local"), await startArgs("github:me/mine", true)]) {
      expect(args).toContain("--mcp-config");
      expect(args).not.toContain("--setting-sources");
      expect(args).not.toContain("--strict-mcp-config");
    }
  });
});
