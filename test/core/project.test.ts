import { describe, expect, it } from "vitest";
import { Agent, type AgentDriver, type AgentInput } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { verdictFor, nextPermissionMode } from "../../src/core/permissions.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";

class RecordingDriver implements AgentDriver {
  readonly kind = "native" as const;
  inputs: AgentInput[] = [];
  disposed = false;
  constructor(private readonly agent: Agent) {}
  async start() {
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

function makeProject() {
  const drivers = new Map<string, RecordingDriver>();
  const runtime: ProjectRuntime = {
    async launch(_project, agent) {
      const d = new RecordingDriver(agent);
      drivers.set(agent.name, d);
      agent.driver = d;
      await d.start();
    },
    defaultWorkerModel: () => ({ provider: "opencode", model: "big-pickle" }),
  };
  const project = new Project({ cwd: process.cwd(), name: "demo" }, new Notifier(), runtime);
  return { project, drivers };
}

describe("Project", () => {
  it("names workers after stars and keeps names unique", async () => {
    const { project } = makeProject();
    await project.addAgent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } });
    const a = await project.addAgent({ name: "", role: "worker", model: { provider: "opencode", model: "big-pickle" } });
    const b = await project.addAgent({ name: "Voice UI!", role: "worker", model: { provider: "opencode", model: "big-pickle" } });
    const c = await project.addAgent({ name: "voice-ui", role: "worker", model: { provider: "opencode", model: "big-pickle" } });
    expect(a.name).toBe("vega");
    expect(b.name).toBe("voice-ui");
    expect(c.name).toBe("voice-ui-2");
    await expect(project.addAgent({ name: "x", role: "lead", model: { provider: "a", model: "b" } })).rejects.toThrow(/lead/);
  });

  it("delivers messages by name, to the lead, and to everyone but the sender", async () => {
    const { project, drivers } = makeProject();
    await project.addAgent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } });
    await project.addAgent({ name: "vega", role: "worker", model: { provider: "minimax", model: "MiniMax-M3" } });
    await project.addAgent({ name: "lyra", role: "worker", model: { provider: "opencode", model: "big-pickle" } });

    expect(project.send("vega", "lead", "done with the room")).toEqual(["luna"]);
    expect(drivers.get("luna")!.inputs).toEqual([{ from: "vega", text: "done with the room" }]);

    expect(project.send("luna", "*", "stand-up").sort()).toEqual(["lyra", "vega"]);
    expect(drivers.get("luna")!.inputs).toHaveLength(1);

    expect(project.send("you", "@LYRA", "hi")).toEqual(["lyra"]);
    expect(project.send("you", "nobody", "hi")).toEqual([]);
    expect(project.send("you", "vega", "   ")).toEqual([]);

    const vega = project.findAgent("vega")!;
    expect(vega.log.some((e) => e.kind === "message" && e.to === "luna")).toBe(true);
    expect(project.messages).toHaveLength(3);
  });

  it("keeps a shared task board", async () => {
    const { project } = makeProject();
    const t = project.addTask("luna", "Build the room", "vega");
    expect(t).toMatchObject({ id: "1", status: "doing", owner: "vega" });
    const u = project.addTask("luna", "Voice");
    expect(u.status).toBe("todo");
    expect(project.updateTask("vega", "#1", { status: "done", note: "merged" })).toMatchObject({ status: "done", note: "merged" });
    expect(project.updateTask("vega", "9", { status: "done" })).toBeNull();
  });

  it("spawns workers through the team API with the runtime's default model", async () => {
    const { project, drivers } = makeProject();
    await project.addAgent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } });
    const team = project.teamApi();
    const name = await team.spawn("luna", { label: "physics", task: "add gravity" });
    expect(name).toBe("vega");
    const vega = project.findAgent("vega")!;
    expect(vega.model).toEqual({ provider: "opencode", model: "big-pickle" });
    expect(vega.label).toBe("physics");
    expect(drivers.get("vega")!.inputs).toEqual([{ from: "luna", text: "add gravity" }]);
    const named = await team.spawn("luna", { name: "orion", model: "minimax/MiniMax-M3", task: "voice" });
    expect(project.findAgent(named)!.model).toEqual({ provider: "minimax", model: "MiniMax-M3" });
    expect(team.stop("luna", "luna")).toBe(false);
    expect(team.stop("luna", "orion")).toBe(true);
    expect(team.members().map((m) => m.name)).toContain("vega");
  });

  it("totals tokens, cost and lines across agents", async () => {
    const { project } = makeProject();
    const a = await project.addAgent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } });
    a.addUsage({ input: 1000, output: 500, costUsd: 0.25 });
    a.addLines(10, 2);
    expect(project.totals()).toMatchObject({ agents: 1, tokens: 1500, costUsd: 0.25, added: 10, removed: 2 });
  });
});

describe("approvals", () => {
  it("follows the permission mode", () => {
    expect(verdictFor("auto-edit", "edit")).toBe("allow");
    expect(verdictFor("auto-edit", "exec")).toBe("ask");
    expect(verdictFor("ask", "edit")).toBe("ask");
    expect(verdictFor("yolo", "exec")).toBe("allow");
    expect(verdictFor("plan", "edit")).toBe("deny");
    expect(verdictFor("plan", "read")).toBe("allow");
    expect(nextPermissionMode("plan")).toBe("auto-edit");
  });

  it("asks the user and remembers 'always'", async () => {
    const agent = new Agent({ name: "vega", role: "worker", model: { provider: "x", model: "y" } }, new Notifier(), "ask");
    const pending = agent.requestApproval({ tool: "bash", risk: "exec", summary: "run npm test", allowKey: "bash:npm test" });
    expect(agent.status).toBe("waiting");
    expect(agent.pendingApproval?.summary).toBe("run npm test");
    agent.answerApproval("always");
    await expect(pending).resolves.toBe("always");
    expect(agent.pendingApproval).toBeNull();
    await expect(agent.requestApproval({ tool: "bash", risk: "exec", summary: "run npm test", allowKey: "bash:npm test" })).resolves.toBe("allow");
    const entry = agent.log.find((e) => e.kind === "approval");
    expect(entry && entry.kind === "approval" && entry.decision).toBe("always");
  });

  it("denies open requests on interrupt", async () => {
    const agent = new Agent({ name: "vega", role: "worker", model: { provider: "x", model: "y" } }, new Notifier(), "ask");
    const pending = agent.requestApproval({ tool: "edit", risk: "edit", summary: "edit a.ts", allowKey: "edit" });
    agent.interrupt();
    await expect(pending).resolves.toBe("deny");
  });
});

describe("Agent log", () => {
  it("streams text into one block and closes it", () => {
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "x", model: "y" } }, new Notifier(), "auto-edit");
    agent.appendStream("text", "Hel");
    agent.appendStream("text", "lo");
    expect(agent.log).toHaveLength(1);
    agent.endStream("text", "Hello!");
    expect(agent.log[0]).toMatchObject({ kind: "text", text: "Hello!", streaming: false });
    agent.appendStream("text", "Next");
    expect(agent.log).toHaveLength(2);
  });

  it("marks cut-off tool calls as errors at the end of a turn", () => {
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "x", model: "y" } }, new Notifier(), "auto-edit");
    agent.startTurn();
    expect(agent.activity).toBeTruthy();
    agent.append({ kind: "tool", toolCallId: "1", name: "bash", verb: "run", status: "running" });
    agent.endTurn();
    expect(agent.log[0]).toMatchObject({ status: "error" });
    expect(agent.status).toBe("idle");
    expect(agent.activity).toBeNull();
  });
});
