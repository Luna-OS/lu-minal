// Trusting a project's own agent settings: what the Hub remembers per folder and across restarts,
// and how /trust reaches the Claude Code agents that read those settings when their process starts.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeDriver } from "../../src/agents/claude-code/driver.js";
import { Agent, type AgentDriver } from "../../src/core/agent.js";
import { defaultConfig, loadConfig, type Config } from "../../src/core/config.js";
import { Hub, type SavedSession } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
let dir = "";
let hub: Hub;

function makeHub(config: Config = defaultConfig(), configPath: string | null = null): Hub {
  return new Hub({
    config,
    configPath,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-trust-"));
  hub = makeHub();
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  // fs.rmSync ignores maxRetries for EBUSY in some Node versions; the promise version retries.
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

function savedProject(cwd: string, origin: string, trusted?: boolean): SavedSession["projects"][number] {
  return {
    cwd,
    name: path.basename(cwd),
    origin,
    permissionMode: "auto-edit",
    ...(trusted === undefined ? {} : { trusted }),
    createdAt: 1,
    focused: null,
    tasks: [],
    messages: [],
    agents: [],
  };
}

/** A clone with a Claude Code lead whose launch() runs the real driver over the fake CLI. */
async function claudeClone(opts: { trusted?: boolean } = {}) {
  const project = new Project({ cwd: folder("clone"), name: "clone", origin: "github:luna/moon" }, hub.notifier, hub);
  if (opts.trusted !== undefined) project.setTrusted(opts.trusted);
  hub.projects.push(project);
  const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, hub.notifier, "auto-edit");
  project.agents.push(agent);
  const logFile = path.join(dir, "starts.jsonl");
  const children: ChildProcess[] = [];
  const launch = vi.spyOn(hub, "launch").mockImplementation(async (p, a) => {
    a.driver = new ClaudeCodeDriver({
      agent: a,
      project: p,
      exe: "claude",
      mcp: { register: async () => ({ configFile: path.join(dir, "mcp.json"), serverName: "luminal" }), unregister: () => undefined },
      systemPrompt: () => "You are luna.",
      spawnImpl: (_exe, args, options) => {
        const child = spawn(process.execPath, [FAKE, ...args], options);
        children.push(child);
        return child;
      },
      env: { ...process.env, FAKE_CLAUDE_LOG: logFile },
    });
    await a.driver.start();
  });
  cleanups.push(async () => {
    await agent.driver?.dispose();
    // Windows keeps a process's working folder locked until it has exited, so wait for that
    // before the folder is removed.
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
  await hub.launch(project, agent);
  launch.mockClear();
  const starts = (): string[][] =>
    fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv)
      : [];
  const answers = () => agent.log.filter((e) => e.kind === "text").length;
  const idle = (what = "the turn to end") => waitFor(() => agent.status === "idle" && agent.turnStartedAt === null, what);
  return { project, agent, driver: agent.driver as ClaudeCodeDriver, launch, starts, answers, idle };
}

describe("project trust", () => {
  it("survives a restart, and a clone saved before trust existed stays untrusted", async () => {
    const saved: SavedSession = {
      version: 2,
      savedAt: 1,
      active: 0,
      projects: [
        savedProject(folder("mine"), "local"),
        savedProject(folder("trusted-clone"), "github:luna/moon", true),
        savedProject(folder("old-clone"), "forgejo:luna/sky"),
      ],
    };
    expect(await hub.restoreSession(saved)).toBe(3);
    expect(hub.projects.map((p) => p.trusted)).toEqual([true, true, false]);
    expect(hub.snapshotSession().projects.map((p) => p.trusted)).toEqual([true, true, false]);
  });

  it("keeps a folder the user didn't trust untrusted when it is opened again, also after a restart", async () => {
    const configPath = path.join(dir, "config", "config.json");
    hub = makeHub(defaultConfig(), configPath);
    vi.spyOn(hub, "launch").mockResolvedValue(undefined);
    const cwd = folder("evil-repo");
    // The clone question answered "not now".
    const first = await hub.openProject({ cwd, origin: "github:mallory/evil-repo", trusted: false });
    expect(first.trusted).toBe(false);
    await hub.closeProject(first);
    // Recent, "A folder...", `lu-minal <dir>`: no origin, no answer.
    const again = await hub.openProject({ cwd });
    expect(again.trusted).toBe(false);
    await hub.closeProject(again);

    // A new start reads the config from disk.
    const restarted = makeHub(loadConfig(configPath), configPath);
    vi.spyOn(restarted, "launch").mockResolvedValue(undefined);
    const later = await restarted.openProject({ cwd: cwd + path.sep });
    expect(later.trusted).toBe(false);
    const session = makeHub(loadConfig(configPath), configPath);
    vi.spyOn(session, "launch").mockResolvedValue(undefined);
    expect(await session.restoreSession({ version: 2, savedAt: 1, active: 0, projects: [savedProject(cwd, "local")] })).toBe(1);
    expect(session.projects[0].trusted).toBe(false);
  });

  it("remembers /trust for the folder in both directions", async () => {
    vi.spyOn(hub, "launch").mockResolvedValue(undefined);
    const cwd = folder("mine");
    const mine = await hub.openProject({ cwd });
    expect(mine.trusted).toBe(true);
    await hub.setTrust(mine, false);
    await hub.closeProject(mine);
    const off = await hub.openProject({ cwd });
    expect(off.trusted).toBe(false);
    await hub.setTrust(off, true);
    await hub.closeProject(off);
    expect((await hub.openProject({ cwd })).trusted).toBe(true);
    expect(hub.config.untrusted).toEqual([]);

    // A clone the user trusted when it was cloned stays trusted too.
    const clone = folder("clone");
    await hub.closeProject(await hub.openProject({ cwd: clone, origin: "github:luna/moon", trusted: true }));
    expect((await hub.openProject({ cwd: clone })).trusted).toBe(true);
  });

  it("neither disposes nor relaunches drivers on /trust, and tells the Claude Code agents when they follow", async () => {
    const project = new Project({ cwd: folder("clone"), name: "clone", origin: "github:luna/moon" }, hub.notifier, hub);
    hub.projects.push(project);
    expect(project.trusted).toBe(false);
    const make = (name: string, provider: string) => {
      const agent = new Agent({ name, role: "worker", model: { provider, model: "m" } }, hub.notifier, "auto-edit");
      const driver: AgentDriver =
        provider === "claude-code"
          ? new ClaudeCodeDriver({ agent, project, exe: "claude", mcp: { register: async () => ({ configFile: "", serverName: "luminal" }), unregister: () => undefined }, systemPrompt: () => "" })
          : { kind: "native", start: async () => undefined, send: () => undefined, interrupt: () => undefined, dispose: async () => undefined };
      const dispose = vi.spyOn(driver, "dispose");
      agent.driver = driver;
      project.agents.push(agent);
      return { agent, dispose };
    };
    const idle = make("vega", "claude-code");
    const busy = make("lyra", "claude-code");
    busy.agent.setStatus("working");
    const native = make("orion", "minimax");
    const launch = vi.spyOn(hub, "launch").mockResolvedValue(undefined);

    await hub.setTrust(project, true);
    expect(project.trusted).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    for (const a of [idle, busy, native]) expect(a.dispose).not.toHaveBeenCalled();
    expect(idle.agent.log.at(-1)).toMatchObject({ kind: "info", text: expect.stringContaining("at the next message") });
    expect(busy.agent.log.at(-1)).toMatchObject({ kind: "info", text: expect.stringContaining("when this turn ends") });
    expect(native.agent.log).toEqual([]);

    // Setting the same value again changes nothing.
    const entries = idle.agent.log.length;
    await hub.setTrust(project, true);
    expect(idle.agent.log).toHaveLength(entries);
  });

  it("a busy Claude Code agent picks up /trust when its turn ends", async () => {
    const t = await claudeClone();
    t.agent.deliver({ from: "you", text: "pause" }); // answers after 300 ms
    expect(t.agent.busy).toBe(true);
    await hub.setTrust(t.project, true);
    await t.idle("the first turn");
    t.agent.deliver({ from: "you", text: "hello" });
    await waitFor(() => t.answers() === 2 && t.agent.status === "idle" && t.agent.turnStartedAt === null, "the second answer");
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain("--setting-sources");
    expect(starts[1]).not.toContain("--setting-sources");
    expect(starts[1]).not.toContain("--strict-mcp-config");
    expect(starts[1]).toContain("--resume");
    expect(t.agent.log.filter((e) => e.kind === "error")).toEqual([]);
  });

  it("a busy agent's process ends with its turn after /trust off", async () => {
    const t = await claudeClone({ trusted: true });
    t.agent.deliver({ from: "you", text: "pause" });
    await hub.setTrust(t.project, false);
    expect(t.driver.pid).not.toBeNull();
    await t.idle("the first turn");
    // The folder's hooks and MCP servers don't outlive the turn.
    await waitFor(() => t.driver.pid === null, "the old process to end");
    expect(t.agent.log.filter((e) => e.kind === "error")).toEqual([]);
  });

  it("/trust off ends an idle agent's process at once; the next message resumes without the folder's settings", async () => {
    const t = await claudeClone({ trusted: true });
    t.agent.deliver({ from: "you", text: "hello" });
    await waitFor(() => t.answers() === 1 && t.agent.status === "idle", "the first answer");
    const driver = t.agent.driver as ClaudeCodeDriver;
    expect(driver.pid).not.toBeNull();
    await hub.setTrust(t.project, false);
    await waitFor(() => driver.pid === null, "the old process to end");
    t.agent.deliver({ from: "you", text: "hello" });
    await waitFor(() => t.answers() === 2 && t.agent.status === "idle" && t.agent.turnStartedAt === null, "the second answer");
    const starts = t.starts();
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toContain("--setting-sources");
    expect(starts[1]).toContain("--setting-sources");
    expect(starts[1]).toContain("--strict-mcp-config");
    expect(starts[1]).toContain("--resume");
  });

  it("a message that arrives during /trust reaches the agent", async () => {
    const t = await claudeClone();
    t.agent.deliver({ from: "you", text: "hello" });
    await waitFor(() => t.answers() === 1 && t.agent.status === "idle", "the first answer");
    const pending = hub.setTrust(t.project, true);
    // A teammate's send_message (or the user's enter) while /trust is on its way.
    t.agent.deliver({ from: "vega", text: "the build is green" });
    await pending;
    // An answer's row appears when it starts streaming: wait for the turn to end before reading it.
    await waitFor(() => t.answers() === 2 && t.agent.status === "idle" && t.agent.turnStartedAt === null, "the answer to the teammate");
    expect(t.agent.log.filter((e) => e.kind === "text").at(-1)).toMatchObject({ text: "got [message from vega] the build is green" });
  });
});
