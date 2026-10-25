import { describe, expect, it } from "vitest";
import { Agent, type AgentDriver, type AgentInput } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";
import { createToolContext, runToolCall } from "../../src/tools/run.js";
import {
  listAgentsTool,
  sendMessageTool,
  spawnAgentTool,
  stopAgentTool,
  taskAddTool,
  tasksListTool,
  taskUpdateTool,
  teamTools,
} from "../../src/tools/team.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";
import { FakeThemes, nullRoblox } from "./helpers.js";

class RecordingDriver implements AgentDriver {
  readonly kind = "native" as const;
  inputs: AgentInput[] = [];
  disposed = false;
  constructor(private readonly agent: Agent, private readonly fail = false) {}
  async start() {
    if (this.fail) throw new Error("no key for minimax");
    this.agent.setStatus("idle");
  }
  send(input: AgentInput) {
    this.inputs.push(input);
  }
  interrupt() {}
  async dispose() {
    this.disposed = true;
  }
}

async function team() {
  const drivers = new Map<string, RecordingDriver>();
  const runtime: ProjectRuntime = {
    async launch(_project, agent) {
      const d = new RecordingDriver(agent, agent.model.provider === "broken");
      drivers.set(agent.name, d);
      agent.driver = d;
      await d.start();
    },
    defaultWorkerModel: () => ({ provider: "opencode", model: "big-pickle" }),
  };
  const project = new Project({ cwd: process.cwd(), name: "moon-app" }, new Notifier(), runtime);
  const luna = await project.addAgent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } });
  const vega = await project.addAgent({ name: "vega", role: "worker", label: "room", model: { provider: "minimax", model: "MiniMax-M3" } });
  const services = { team: project.teamApi(), themes: new FakeThemes(), roblox: nullRoblox };
  const ctxFor = (agent: Agent): ToolContext =>
    createToolContext({ agent, project, services, signal: new AbortController().signal });
  const call = (tool: Tool, agent: Agent, args: Record<string, unknown>) => tool.run(args, ctxFor(agent));
  return { project, drivers, luna, vega, ctxFor, call };
}

describe("team tools", () => {
  it("are all MCP tools that never need an approval", () => {
    for (const tool of teamTools()) {
      expect(tool.mcp).toBe(true);
      expect(tool.risk).toBe("read");
    }
    expect(teamTools().filter((t) => t.leadOnly).map((t) => t.name)).toEqual(["spawn_agent", "stop_agent"]);
  });

  describe("send_message", () => {
    it("delivers to a teammate by name and to the lead", async () => {
      const { luna, vega, drivers, call, project } = await team();
      const res = await call(sendMessageTool, vega, { to: "lead", text: "Room is done, see src/room.ts" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toBe("Delivered to luna.");
      expect(res.display).toMatchObject({ target: "-> luna", detail: "delivered" });
      expect(drivers.get("luna")!.inputs).toEqual([{ from: "vega", text: "Room is done, see src/room.ts" }]);
      expect(project.messages.at(-1)).toMatchObject({ from: "vega", to: "luna" });

      await call(sendMessageTool, luna, { to: "@Vega", text: "thanks, now the tests" });
      expect(drivers.get("vega")!.inputs.at(-1)).toEqual({ from: "luna", text: "thanks, now the tests" });
      expect(sendMessageTool.describe({ to: "vega", text: "x" }, {} as ToolContext)).toEqual({ verb: "message", target: "-> vega" });
    });

    it("broadcasts with * to everyone but the sender", async () => {
      const { project, luna, drivers, call } = await team();
      await project.addAgent({ name: "lyra", role: "worker", model: { provider: "opencode", model: "big-pickle" } });
      const res = await call(sendMessageTool, luna, { to: "*", text: "freeze: no edits to package.json" });
      expect(res.content).toBe("Delivered to vega, lyra.");
      expect(res.display?.detail).toBe("delivered to 2");
      expect(drivers.get("luna")!.inputs).toEqual([]);
    });

    it("lists the teammates when nobody matches, and refuses messages to yourself", async () => {
      const { luna, vega, call } = await team();
      const res = await call(sendMessageTool, vega, { to: "orion", text: "hi" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('Nobody named "orion"');
      expect(res.content).toContain("luna (lead)");
      const self = await call(sendMessageTool, vega, { to: "vega", text: "hi" });
      expect(self.isError).toBe(true);
      expect((await call(sendMessageTool, luna, { to: "lead", text: "hi" })).isError).toBe(true);
      expect((await call(sendMessageTool, luna, { to: "vega", text: "   " })).isError).toBe(true);
    });
  });

  it("list_agents shows everyone with role, label, model and status", async () => {
    const { vega, call } = await team();
    vega.startTurn();
    const res = await call(listAgentsTool, vega, {});
    const lines = res.content.split("\n");
    expect(lines[0]).toBe("luna — lead · claude-code/opus · idle");
    expect(lines[1]).toMatch(/^vega \(you\) — worker · area: room · minimax\/MiniMax-M3 · working · \w+/);
    expect(res.display?.detail).toBe("2 agents");
  });

  describe("spawn_agent", () => {
    it("starts a worker with the task, label and model, and says it will report back", async () => {
      const { luna, project, drivers, call } = await team();
      const res = await call(spawnAgentTool, luna, {
        task: "Write tests for src/room.ts",
        label: "tests",
        model: "openrouter/qwen/qwen3-coder:free",
        instructions: "Use vitest.",
      });
      expect(res.isError).toBeFalsy();
      const worker = project.findAgent("lyra")!;
      expect(worker).toBeDefined();
      expect(worker.label).toBe("tests");
      expect(worker.model).toEqual({ provider: "openrouter", model: "qwen/qwen3-coder:free" });
      expect(worker.instructions).toBe("Use vitest.");
      expect(worker.spawnedBy).toBe("luna");
      expect(drivers.get("lyra")!.inputs).toEqual([{ from: "luna", text: "Write tests for src/room.ts" }]);
      expect(res.content).toContain("Started lyra on openrouter/qwen/qwen3-coder:free");
      expect(res.content).toContain("report back");
      expect(res.display).toMatchObject({ target: "lyra · tests", detail: "openrouter/qwen/qwen3-coder:free" });
      expect(spawnAgentTool.describe({ task: "x", label: "tests" }, {} as ToolContext).verb).toBe("spawn");
    });

    it("uses the default worker model and a requested name", async () => {
      const { luna, project, call } = await team();
      await call(spawnAgentTool, luna, { task: "Fix the sky", name: "Orion" });
      expect(project.findAgent("orion")!.model).toEqual({ provider: "opencode", model: "big-pickle" });
    });

    it("rejects malformed model ids and reports workers that fail to start", async () => {
      const { luna, call } = await team();
      const bad = await call(spawnAgentTool, luna, { task: "x", model: "sonnet" });
      expect(bad.isError).toBe(true);
      expect(bad.content).toContain("provider/model");
      const broken = await call(spawnAgentTool, luna, { task: "x", model: "broken/model" });
      expect(broken.isError).toBe(true);
      expect(broken.content).toContain("failed to start");
    });

    it("is refused to workers by the tool runner", async () => {
      const { vega, ctxFor, project } = await team();
      const res = await runToolCall({ agent: vega, tool: spawnAgentTool, name: "spawn_agent", toolCallId: "c1", args: { task: "x" }, ctx: ctxFor(vega) });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("Only the lead");
      expect(project.agents).toHaveLength(2);
    });
  });

  it("stop_agent stops workers but not the lead, listing the workers on a miss", async () => {
    const { luna, project, drivers, call } = await team();
    const res = await call(stopAgentTool, luna, { name: "vega" });
    expect(res.content).toBe("Stopped vega.");
    await new Promise((r) => setTimeout(r, 0));
    expect(drivers.get("vega")!.disposed).toBe(true);
    expect(project.findAgent("vega")).toBeUndefined();
    const miss = await call(stopAgentTool, luna, { name: "luna" });
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain("There are no workers.");
  });

  describe("the task board", () => {
    it("adds, lists and updates tasks", async () => {
      const { luna, vega, call, project } = await team();
      expect((await call(tasksListTool, luna, {})).content).toBe("The task board is empty.");

      const added = await call(taskAddTool, luna, { title: "Build the room", owner: "vega", note: "see PLAN.md" });
      expect(added.content).toBe("Added #1 [doing] Build the room · owner vega · note: see PLAN.md");
      await call(taskAddTool, luna, { title: "Write tests" });
      expect(project.tasks[0].createdBy).toBe("luna");

      const claimed = await call(taskUpdateTool, vega, { id: "#2", status: "doing", owner: "vega" });
      expect(claimed.content).toBe("Updated #2 [doing] Write tests · owner vega");
      const done = await call(taskUpdateTool, vega, { id: 1, status: "DONE", note: "" });
      expect(done.content).toBe("Updated #1 [done] Build the room · owner vega");
      const unassigned = await call(taskUpdateTool, vega, { id: "2", owner: "" });
      expect(unassigned.content).toBe("Updated #2 [doing] Write tests");

      const list = await call(tasksListTool, luna, {});
      expect(list.content.split("\n")).toEqual(["#1 [done] Build the room · owner vega", "#2 [doing] Write tests"]);
      expect(list.display?.detail).toBe("2 tasks · 1 open");
    });

    it("explains bad ids, statuses and empty updates", async () => {
      const { luna, call } = await team();
      await call(taskAddTool, luna, { title: "One" });
      const missing = await call(taskUpdateTool, luna, { id: "7", status: "done" });
      expect(missing.isError).toBe(true);
      expect(missing.content).toContain("Tasks: #1");
      const status = await call(taskUpdateTool, luna, { id: "1", status: "finished" });
      expect(status.content).toContain("todo, doing, done, blocked");
      expect((await call(taskUpdateTool, luna, { id: "1" })).isError).toBe(true);
      expect((await call(taskAddTool, luna, { title: " " })).isError).toBe(true);
    });
  });
});
