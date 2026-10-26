// /yolo: one switch that lets every agent in every tab run everything without asking. The hub puts
// every tab and its agents into "yolo", allows the questions still open, and makes "yolo" the
// default that new tabs, new agents and restored tabs start in; off goes back to "edits on".
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeDriver } from "../../src/agents/claude-code/driver.js";
import type { Agent, AgentDriver } from "../../src/core/agent.js";
import { defaultConfig, loadConfig, type Config } from "../../src/core/config.js";
import { Hub, type SavedSession } from "../../src/core/hub.js";
import type { Project } from "../../src/core/project.js";
import type { ApprovalDecision } from "../../src/core/types.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
let dir = "";
let hub: Hub;

function makeHub(config: Config = defaultConfig(), configPath: string | null = null): Hub {
  const made = new Hub({
    config,
    configPath,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
  // Every agent gets a driver that does nothing: no CLI, no network.
  vi.spyOn(made, "launch").mockImplementation(async (_project, agent) => {
    agent.driver = fakeDriver();
  });
  return made;
}

function fakeDriver(): AgentDriver {
  return { kind: "native", start: async () => undefined, send: () => undefined, interrupt: () => undefined, dispose: async () => undefined };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-yolo-"));
  hub = makeHub();
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function folder(name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p);
  return p;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Two tabs: one with a lead and a worker in "ask", one with a lead in "plan". */
async function twoTabs(): Promise<{ a: Project; b: Project; agents: Agent[] }> {
  const a = await hub.openProject({ cwd: folder("moon"), permissionMode: "ask" });
  await a.addAgent({ name: "", role: "worker", model: { provider: "minimax", model: "MiniMax-M3" }, spawnedBy: "luna" });
  const b = await hub.openProject({ cwd: folder("sky"), permissionMode: "plan" });
  return { a, b, agents: [...a.agents, ...b.agents] };
}

function ask(agent: Agent, command: string): Promise<ApprovalDecision> {
  return agent.requestApproval({ tool: "bash", risk: "exec", summary: `run ${command}`, allowKey: `bash:${command}` });
}

describe("/yolo in the hub", () => {
  it("puts every tab and its agents into yolo and allows the questions still open", async () => {
    const { a, b, agents } = await twoTabs();
    const [luna, worker] = a.agents;
    const first = ask(luna, "npm test");
    const second = ask(luna, "npm run build");
    const third = ask(worker, "rm -rf dist");
    expect(luna.approvals).toHaveLength(2);
    expect(hub.allowingEverything).toBe(false);

    expect(hub.allowEverything(true)).toBe(3);
    expect([a.permissionMode, b.permissionMode]).toEqual(["yolo", "yolo"]);
    expect(agents.map((x) => x.permissionMode)).toEqual(["yolo", "yolo", "yolo"]);
    await expect(Promise.all([first, second, third])).resolves.toEqual(["allow", "allow", "allow"]);
    for (const x of agents) expect(x.pendingApproval).toBeNull();
    // "allow", not "always": nothing is remembered for after /yolo off.
    expect(luna.allowed.size).toBe(0);
    expect(hub.allowingEverything).toBe(true);
    expect(hub.toasts.at(-1)).toMatchObject({
      level: "warning",
      text: "Every agent in every tab now runs everything without asking - /yolo off to stop.",
    });

    // New questions don't reach the panel any more.
    await expect(ask(worker, "git push --force")).resolves.toBe("allow");
    expect(worker.pendingApproval).toBeNull();
  });

  it("makes yolo the default, saved for the next start", async () => {
    const configPath = path.join(dir, "config", "config.json");
    hub = makeHub(defaultConfig(), configPath);
    hub.allowEverything(true);
    expect(hub.config.permissionMode).toBe("yolo");
    expect(loadConfig(configPath).permissionMode).toBe("yolo");
    // With no tab open, the default alone is enough.
    expect(hub.allowingEverything).toBe(true);

    hub.allowEverything(false);
    expect(loadConfig(configPath).permissionMode).toBe("auto-edit");
  });

  it("starts tabs opened later and agents added later in yolo", async () => {
    const { a } = await twoTabs();
    hub.allowEverything(true);
    const worker = await a.addAgent({ name: "", role: "worker", model: { provider: "minimax", model: "MiniMax-M3" }, spawnedBy: "you" });
    expect(worker.permissionMode).toBe("yolo");
    const later = await hub.openProject({ cwd: folder("later") });
    expect(later.permissionMode).toBe("yolo");
    expect(later.lead?.permissionMode).toBe("yolo");
    const spawned = await later.teamApi().spawn("luna", { task: "look around" });
    expect(later.findAgent(spawned)?.permissionMode).toBe("yolo");
    expect(hub.allowingEverything).toBe(true);
    // A single tab switched back with /perm means not everything runs on its own any more.
    later.setPermissionMode("auto-edit");
    expect(hub.allowingEverything).toBe(false);
  });

  it("brings restored tabs back in yolo while it is on, and in their own mode after /yolo off", async () => {
    const saved = (cwd: string, permissionMode: SavedSession["projects"][number]["permissionMode"]): SavedSession => ({
      version: 2,
      savedAt: 1,
      active: 0,
      projects: [
        {
          cwd,
          name: path.basename(cwd),
          origin: "local",
          permissionMode,
          createdAt: 1,
          focused: "luna",
          tasks: [],
          messages: [],
          agents: [
            {
              name: "luna",
              role: "lead",
              label: null,
              model: { provider: "minimax", model: "MiniMax-M3" },
              sessionId: null,
              instructions: null,
              spawnedBy: "you",
              state: { log: [], tokensIn: 0, tokensOut: 0, contextTokens: 0, costUsd: 0, linesAdded: 0, linesRemoved: 0, busyMs: 0, allowed: [], createdAt: 1 },
              conversation: null,
            },
          ],
        },
      ],
    });
    hub.allowEverything(true);
    expect(await hub.restoreSession(saved(folder("old"), "ask"))).toBe(1);
    expect(hub.projects[0].permissionMode).toBe("yolo");
    expect(hub.projects[0].lead?.permissionMode).toBe("yolo");

    const other = makeHub();
    expect(await other.restoreSession(saved(folder("planned"), "plan"))).toBe(1);
    expect(other.projects[0].permissionMode).toBe("plan");
    expect(other.projects[0].lead?.permissionMode).toBe("plan");
  });

  it("/yolo off puts every tab and the default back to edits on", async () => {
    const { a, b, agents } = await twoTabs();
    hub.allowEverything(true);
    expect(hub.allowEverything(false)).toBe(0);
    expect([a.permissionMode, b.permissionMode]).toEqual(["auto-edit", "auto-edit"]);
    expect(agents.map((x) => x.permissionMode)).toEqual(["auto-edit", "auto-edit", "auto-edit"]);
    expect(hub.config.permissionMode).toBe("auto-edit");
    expect(hub.allowingEverything).toBe(false);
    expect(hub.toasts.at(-1)?.level).toBe("info");
    expect((await hub.openProject({ cwd: folder("next") })).permissionMode).toBe("auto-edit");

    // Commands ask again.
    const pending = ask(a.agents[0], "npm test");
    expect(a.agents[0].pendingApproval).toMatchObject({ summary: "run npm test" });
    a.agents[0].answerApproval("deny");
    await expect(pending).resolves.toBe("deny");
  });

  it("switches a Claude Code agent's process to bypassPermissions at its next message", async () => {
    const project = await hub.openProject({ cwd: folder("claude") });
    const logFile = path.join(dir, "starts.jsonl");
    const children: ChildProcess[] = [];
    vi.spyOn(hub, "launch").mockImplementation(async (p, agent) => {
      agent.driver = new ClaudeCodeDriver({
        agent,
        project: p,
        exe: "claude",
        mcp: { register: async () => ({ configFile: path.join(dir, "mcp.json"), serverName: "luminal" }), unregister: () => undefined },
        systemPrompt: () => "You are vega.",
        spawnImpl: (_exe, args, options) => {
          const child = spawn(process.execPath, [FAKE, ...args], options);
          children.push(child);
          return child;
        },
        env: { ...process.env, FAKE_CLAUDE_LOG: logFile },
      });
      await agent.driver.start();
    });
    const vega = await project.addAgent({ name: "vega", role: "worker", model: { provider: "claude-code", model: "opus" }, spawnedBy: "you" });
    cleanups.push(async () => {
      await vega.driver?.dispose();
      // Windows keeps a process's working folder locked until it has exited.
      await Promise.all(
        children.map(
          (c) =>
            new Promise<void>((resolve) => {
              if (c.exitCode !== null || c.signalCode !== null) return resolve();
              const timer = setTimeout(resolve, 5000);
              c.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              c.kill("SIGKILL");
            }),
        ),
      );
    });
    const texts = () => vega.log.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    const idle = () => vega.status === "idle" && vega.turnStartedAt === null;

    vega.deliver({ from: "you", text: "mode" });
    await waitFor(() => texts().length === 1 && idle(), "the first answer");
    expect(texts()[0]).toBe("mode=acceptEdits");

    hub.allowEverything(true);
    vega.deliver({ from: "you", text: "mode" });
    await waitFor(() => texts().length === 2 && idle(), "the second answer");
    expect(texts()[1]).toBe("mode=bypassPermissions");
  });
});
