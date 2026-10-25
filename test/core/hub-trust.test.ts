// Trusting a project's own agent settings: what the Hub remembers across restarts, and how
// /trust restarts the Claude Code agents that read those settings when they start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, type AgentDriver } from "../../src/core/agent.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub, type SavedSession } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

let dir = "";
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-trust-"));
  hub = new Hub({
    config: defaultConfig(),
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p);
  return p;
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

  it("restarts idle Claude Code agents on /trust and leaves busy ones to pick it up later", async () => {
    const project = new Project({ cwd: folder("clone"), name: "clone", origin: "github:luna/moon" }, hub.notifier, hub);
    hub.projects.push(project);
    expect(project.trusted).toBe(false);
    const make = (name: string, provider: string) => {
      const agent = new Agent({ name, role: "worker", model: { provider, model: "m" } }, hub.notifier, "auto-edit");
      const dispose = vi.fn(async () => undefined);
      agent.driver = { kind: provider === "claude-code" ? "claude-code" : "native", start: async () => undefined, send: () => undefined, interrupt: () => undefined, dispose } as AgentDriver;
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
    expect(idle.dispose).toHaveBeenCalledOnce();
    expect(launch.mock.calls.map(([, a]) => a.name)).toEqual(["vega"]);
    expect(busy.dispose).not.toHaveBeenCalled();
    expect(busy.agent.log.at(-1)).toMatchObject({ kind: "info", text: expect.stringContaining("next time it starts") });
    expect(native.dispose).not.toHaveBeenCalled();

    // Setting the same value again changes nothing.
    await hub.setTrust(project, true);
    expect(launch).toHaveBeenCalledOnce();
  });
});
