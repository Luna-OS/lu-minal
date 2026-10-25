import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import { dayKey, StatsStore } from "../../src/core/stats.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";
import { sparkline } from "../../src/ui/format.js";

const DAY = 86_400_000;
const project = { cwd: "/work/gf-sim", name: "gf-sim" };

describe("StatsStore", () => {
  it("adds usage by day, model, provider and project", () => {
    const stats = new StatsStore(null);
    const now = new Date(2026, 9, 25, 12).getTime();
    stats.record({ at: now, provider: "claude-code", model: "opus", project, input: 1000, output: 200, costUsd: 0.5 });
    stats.record({ at: now, provider: "claude-code", model: "opus", project, input: 500, output: 100, costUsd: 0.25 });
    stats.record({ at: now - 3 * DAY, provider: "minimax", model: "MiniMax-M3", project, input: 4000, output: 1000, costUsd: 0.1 });
    stats.record({ at: now - 20 * DAY, provider: "opencode", model: "big-pickle", project: { cwd: "/x", name: "x" }, input: 100, output: 0, costUsd: 0 });
    stats.record({ at: now - 60 * DAY, provider: "opencode", model: "big-pickle", project, input: 7, output: 3, costUsd: 0 });
    stats.record({ at: now, provider: "opencode", model: "big-pickle", project, input: 0, output: 0, costUsd: 0 });

    const s = stats.summary(now);
    expect(s.today).toEqual({ input: 1500, output: 300, costUsd: 0.75, turns: 2 });
    expect(s.week.input).toBe(5500);
    expect(s.month.input).toBe(5600);
    expect(s.allTime).toMatchObject({ input: 5607, output: 1303, turns: 5 });
    expect(s.models[0].model).toBe("minimax/MiniMax-M3");
    expect(s.providers.map((p) => p.provider)).toEqual(["minimax", "claude-code", "opencode"]);
    expect(s.projects.find((p) => p.cwd === "/work/gf-sim")?.input).toBe(5507);
    expect(s.daily).toHaveLength(14);
    expect(s.daily[13]).toMatchObject({ day: dayKey(now), input: 1500 });
    expect(s.since).toBe(dayKey(now - 60 * DAY));
  });

  it("counts only the turns a report says it closes", () => {
    const stats = new StatsStore(null);
    const at = Date.now();
    // One Claude Code reply: its context, its output, the cost from the result.
    stats.record({ at, provider: "claude-code", model: "haiku", project, input: 4151, output: 0, costUsd: 0, turns: 1 });
    stats.record({ at, provider: "claude-code", model: "haiku", project, input: 0, output: 12, costUsd: 0, turns: 0 });
    stats.record({ at, provider: "claude-code", model: "haiku", project, input: 0, output: 0, costUsd: 0.01, turns: 0 });
    // A report that says nothing is still nothing.
    stats.record({ at, provider: "claude-code", model: "haiku", project, input: 0, output: 0, costUsd: 0, turns: 0 });
    const s = stats.summary(at);
    expect(s.allTime).toEqual({ input: 4151, output: 12, costUsd: 0.01, turns: 1 });
    expect(s.projects[0].turns).toBe(1);
  });

  it("survives a restart through its file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-stats-"));
    const file = path.join(dir, "stats.json");
    const a = new StatsStore(file, 10);
    a.record({ at: Date.now(), provider: "openrouter", model: "qwen/qwen3-coder:free", project, input: 42, output: 8, costUsd: 0 });
    a.agentStarted("openrouter");
    a.addLines(10, 3);
    a.flush();
    const b = new StatsStore(file);
    const s = b.summary();
    expect(s.allTime.input).toBe(42);
    expect(s.agents).toEqual({ openrouter: 1 });
    expect(s.lines).toEqual({ added: 10, removed: 3 });
    b.reset();
    expect(b.summary().allTime.input).toBe(0);
  });

  it("starts empty from a broken file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-stats-"));
    const file = path.join(dir, "stats.json");
    fs.writeFileSync(file, "{not json");
    expect(new StatsStore(file).summary().allTime.turns).toBe(0);
  });
});

describe("the Hub's statistics", () => {
  it("count a turn where an agent's usage report says one ended", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-stats-"));
    const hub = new Hub({
      config: defaultConfig(),
      configPath: null,
      auth: new AuthStore(path.join(dir, "auth.json")),
      themes: new ThemeManager({ dir: path.join(dir, "themes") }),
      cacheDir: dir,
      stateDir: dir,
      offline: true,
      servers: false,
    });
    const p = new Project({ cwd: dir, name: "demo" }, hub.notifier, hub);
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "haiku" } }, hub.notifier, "auto-edit");
    (hub as unknown as { watchUsage(p: Project, a: Agent): void }).watchUsage(p, agent);
    agent.addUsage({ input: 4151, context: 4151, turn: true });
    agent.addUsage({ output: 12 });
    agent.addUsage({ costUsd: 0.01 });
    expect(hub.stats.summary().allTime).toEqual({ input: 4151, output: 12, costUsd: 0.01, turns: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("sparkline", () => {
  it("scales bars to the largest value", () => {
    expect(sparkline([0, 1, 2, 4, 8])).toBe("·▂▃▅█");
    expect(sparkline([0, 0])).toBe("··");
  });
});
