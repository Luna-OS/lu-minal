import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeDriver, type NativeDriverDeps } from "../../src/agents/native/driver.js";
import { REMOVED_OUTPUT } from "../../src/agents/native/context.js";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";
import type { LogEntry } from "../../src/core/types.js";
import type { ResolvedModel } from "../../src/providers/models.js";
import { ProviderNotReadyError } from "../../src/providers/registry.js";
import {
  ProviderError,
  type AssistantMessage,
  type ChatClient,
  type ChatRequest,
  type StreamEvent,
  type ToolCall,
} from "../../src/providers/types.js";
import { readFileTool } from "../../src/tools/fs.js";
import { defineTool } from "../../src/tools/fs.js";
import type { Tool } from "../../src/tools/types.js";
import { FakeThemes, nullRoblox, removeDir, tempProject } from "../tools/helpers.js";

// ---- a scripted model ------------------------------------------------------------------------

type Step = (req: ChatRequest) => AsyncGenerator<StreamEvent, void, void>;

class ScriptedClient implements ChatClient {
  readonly wire = "openai-chat" as const;
  /** Every request, with its messages copied as they were sent. */
  requests: ChatRequest[] = [];
  constructor(public steps: Step[] = []) {}
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps.shift();
    if (!step) throw new Error("The script ran out of steps.");
    yield* step(request);
  }
}

const usage = (input: number, output: number, cacheRead = 0): StreamEvent => ({ type: "usage", inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead });

function reply(text: string, opts: { usage?: StreamEvent; reasoning?: string } = {}): Step {
  return async function* () {
    if (opts.reasoning) yield { type: "reasoning", text: opts.reasoning };
    for (const piece of text.match(/.{1,4}/gs) ?? []) yield { type: "text", text: piece };
    if (opts.usage) yield opts.usage;
    const message: AssistantMessage = { role: "assistant", content: text };
    yield { type: "done", stopReason: "stop", message };
  };
}

function callTools(calls: Array<Omit<ToolCall, "id"> & { id?: string }>, opts: { text?: string; usage?: StreamEvent; before?: () => void } = {}): Step {
  return async function* () {
    if (opts.text) yield { type: "text", text: opts.text };
    const full = calls.map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, arguments: c.arguments }));
    for (const call of full) yield { type: "tool_call", call };
    opts.before?.();
    if (opts.usage) yield opts.usage;
    yield { type: "done", stopReason: "tool_use", message: { role: "assistant", content: opts.text ?? "", toolCalls: full } };
  };
}

/** A step that streams some text and then hangs, ignoring the abort signal. */
function hang(text: string, onStarted: () => void): Step {
  return async function* () {
    yield { type: "text", text };
    onStarted();
    await new Promise(() => undefined);
  };
}

function failing(error: unknown): Step {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw error;
  };
}

// ---- a project with one native agent -------------------------------------------------------

const MODEL: ResolvedModel = {
  ref: { provider: "opencode", model: "big-pickle" },
  provider: {
    id: "opencode",
    name: "OpenCode Zen",
    kind: "api",
    auth: "optional",
    wire: "openai-chat",
    baseURL: "https://opencode.ai/zen/v1",
    env: [],
    doc: null,
    supported: true,
  },
  model: {
    id: "big-pickle",
    name: "Big Pickle",
    provider: "opencode",
    wire: "openai-chat",
    baseURL: null,
    contextWindow: 200_000,
    maxOutput: 64_000,
    toolCall: true,
    reasoning: true,
    free: false,
    cost: { input: 3, output: 15, cacheRead: 0.3 },
    status: null,
    releaseDate: null,
  },
  endpoint: { baseURL: "https://opencode.ai/zen/v1", apiKey: "public" },
  wire: "openai-chat",
};

const echoTool = defineTool<{ text: string }>({
  name: "echo",
  description: "Echoes text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  risk: "read",
  describe: (a) => ({ verb: "echo", target: a.text }),
  run: async (a) => ({ content: `echo: ${a.text}`, display: { detail: "echoed" } }),
});

/** A tool that runs until the turn is aborted (or `release` is called). */
function slowTool(): { tool: Tool; started: Promise<void>; release: () => void } {
  let markStarted!: () => void;
  const started = new Promise<void>((r) => (markStarted = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const tool = defineTool<Record<string, never>>({
    name: "slow",
    description: "Takes a while.",
    parameters: { type: "object", properties: {} },
    risk: "read",
    describe: () => ({ verb: "wait" }),
    run: async (_a, ctx) => {
      markStarted();
      await Promise.race([released, new Promise((r) => ctx.signal.addEventListener("abort", r))]);
      return { content: ctx.signal.aborted ? "stopped" : "finished" };
    },
  });
  return { tool, started, release };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) removeDir(d);
  dirs = [];
});

async function setup(opts: { steps?: Step[]; tools?: Tool[]; deps?: Partial<NativeDriverDeps>; files?: Record<string, string> } = {}) {
  const dir = tempProject(opts.files ?? {});
  dirs.push(dir);
  const runtime: ProjectRuntime = {
    launch: async () => undefined,
    defaultWorkerModel: () => MODEL.ref,
  };
  const notifier = new Notifier();
  const project = new Project({ cwd: dir, name: "moon-app" }, notifier, runtime);
  const agent = new Agent({ name: "luna", role: "lead", model: MODEL.ref }, notifier, "auto-edit");
  project.agents.push(agent);
  const client = new ScriptedClient(opts.steps ?? []);
  const prompts: string[] = [];
  const driver = new NativeDriver({
    agent,
    project,
    resolveModel: () => MODEL,
    createClient: () => client,
    tools: opts.tools ?? [readFileTool, echoTool],
    services: { team: project.teamApi(), themes: new FakeThemes(), roblox: nullRoblox },
    systemPrompt: () => {
      prompts.push("prompt");
      return `You are luna (prompt #${prompts.length}).`;
    },
    retry: { sleep: async () => undefined, baseDelayMs: 1 },
    ...opts.deps,
  });
  agent.driver = driver;
  await driver.start();
  return { dir, project, agent, client, driver, prompts };
}

const entries = <K extends LogEntry["kind"]>(agent: Agent, kind: K) => agent.log.filter((e): e is Extract<LogEntry, { kind: K }> => e.kind === kind);

// ---- the tests -------------------------------------------------------------------------------

describe("NativeDriver", () => {
  it("starts idle and answers a message with streamed text, usage and cost", async () => {
    const { agent, client, driver } = await setup({ steps: [reply("Hi! The moon is full tonight.", { usage: usage(1000, 50, 400) })] });
    expect(agent.status).toBe("idle");
    expect(driver.kind).toBe("native");

    agent.deliver({ from: "you", text: "hello" });
    expect(agent.status).toBe("working");
    await driver.idle();

    expect(client.requests).toHaveLength(1);
    const req = client.requests[0];
    expect(req.model).toBe("big-pickle");
    expect(req.system).toBe("You are luna (prompt #1).");
    expect(req.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(req.tools.map((t) => t.name)).toEqual(["read_file", "echo"]);
    expect(req.maxTokens).toBe(32_000);
    expect(req.signal).toBeInstanceOf(AbortSignal);

    const texts = entries(agent, "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "Hi! The moon is full tonight.", streaming: false });
    expect(agent.status).toBe("idle");
    expect(agent.tokensIn).toBe(1000);
    expect(agent.tokensOut).toBe(50);
    expect(agent.contextTokens).toBe(1050);
    // 600 fresh * $3 + 400 cached * $0.30 + 50 out * $15, per million.
    expect(agent.costUsd).toBeCloseTo((600 * 3 + 400 * 0.3 + 50 * 15) / 1e6, 12);
    expect(driver.conversation).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi! The moon is full tonight." },
    ]);
  });

  it("logs reasoning separately from the answer", async () => {
    const { agent, driver } = await setup({ steps: [reply("42", { reasoning: "Let me think about the moon." })] });
    agent.deliver({ from: "you", text: "?" });
    await driver.idle();
    expect(entries(agent, "reasoning").map((e) => [e.text, e.streaming])).toEqual([["Let me think about the moon.", false]]);
    expect(entries(agent, "text").map((e) => e.text)).toEqual(["42"]);
  });

  it("runs a tool call and sends the result back", async () => {
    const { agent, client, driver } = await setup({
      files: { "PLAN.md": "# Plan\n- build the room\n- add the voice\n" },
      steps: [callTools([{ name: "read_file", arguments: { path: "PLAN.md" } }], { text: "Reading the plan." }), reply("The plan has two steps.")],
    });
    agent.deliver({ from: "you", text: "What is the plan?" });
    await driver.idle();

    expect(client.requests).toHaveLength(2);
    const second = client.requests[1].messages;
    expect(second[1]).toMatchObject({ role: "assistant", content: "Reading the plan.", toolCalls: [{ id: "call_0", name: "read_file" }] });
    expect(second[2]).toEqual({
      role: "tool",
      toolCallId: "call_0",
      name: "read_file",
      content: "   1\t# Plan\n   2\t- build the room\n   3\t- add the voice",
    });
    const tool = entries(agent, "tool")[0];
    expect(tool).toMatchObject({ name: "read_file", verb: "read", target: "PLAN.md", status: "ok", detail: "3 lines", toolCallId: "call_0" });
    expect(entries(agent, "text").map((e) => e.text)).toEqual(["Reading the plan.", "The plan has two steps."]);
    expect(entries(agent, "text").every((e) => !e.streaming)).toBe(true);
    expect(agent.status).toBe("idle");
  });

  it("runs several calls in order and reports unknown tools as errors", async () => {
    const { client, agent, driver } = await setup({
      steps: [
        callTools([
          { name: "echo", arguments: { text: "one" } },
          { name: "nope", arguments: {} },
          { name: "echo", arguments: { text: "two" } },
        ]),
        reply("ok"),
      ],
    });
    agent.deliver({ from: "you", text: "go" });
    await driver.idle();
    const results = client.requests[1].messages.filter((m) => m.role === "tool");
    expect(results).toEqual([
      { role: "tool", toolCallId: "call_0", name: "echo", content: "echo: one" },
      { role: "tool", toolCallId: "call_1", name: "nope", content: 'Unknown tool "nope".', isError: true },
      { role: "tool", toolCallId: "call_2", name: "echo", content: "echo: two" },
    ]);
  });

  it("reads a teammate's message that arrives mid-turn at the next step", async () => {
    let agentRef: Agent | null = null;
    const { agent, client, driver } = await setup({
      steps: [
        callTools([{ name: "echo", arguments: { text: "working" } }], {
          before: () => agentRef!.deliver({ from: "vega", text: "the API is ready" }),
        }),
        reply("Thanks, wiring it up."),
      ],
    });
    agentRef = agent;
    const queuedSeen: number[] = [];
    agent.deliver({ from: "you", text: "build the room" });
    queuedSeen.push(agent.queued);
    await driver.idle();
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].messages.slice(-2)).toEqual([
      { role: "tool", toolCallId: "call_0", name: "echo", content: "echo: working" },
      { role: "user", content: "[message from vega] the API is ready" },
    ]);
    expect(agent.queued).toBe(0);
    expect(entries(agent, "user").map((e) => [e.from, e.text])).toEqual([
      ["you", "build the room"],
      ["vega", "the API is ready"],
    ]);
  });

  it("keeps going when a message arrives during the last answer, and starts a new turn after it", async () => {
    let agentRef: Agent | null = null;
    const { agent, client, driver } = await setup({
      steps: [
        async function* () {
          yield { type: "text", text: "All done." };
          agentRef!.deliver({ from: "lyra", text: "one more thing" });
          expect(agentRef!.queued).toBe(1);
          yield { type: "done", stopReason: "stop", message: { role: "assistant", content: "All done." } };
        },
        reply("Handled lyra's thing."),
        reply("And the user's."),
      ],
    });
    agentRef = agent;
    agent.deliver({ from: "you", text: "start" });
    await driver.idle();
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].messages.at(-1)).toEqual({ role: "user", content: "[message from lyra] one more thing" });

    agent.deliver({ from: "you", text: "and now?" });
    await driver.idle();
    expect(client.requests).toHaveLength(3);
    expect(client.requests[2].messages.at(-1)).toEqual({ role: "user", content: "and now?" });
  });

  it("interrupts a stream that ignores the signal and keeps the partial answer", async () => {
    let started!: () => void;
    const streaming = new Promise<void>((r) => (started = r));
    const { agent, client, driver } = await setup({ steps: [hang("I am halfway thro", () => started()), reply("Starting over.")] });
    agent.deliver({ from: "you", text: "write the docs" });
    await streaming;
    agent.interrupt();
    await driver.idle();

    expect(agent.status).toBe("idle");
    expect(driver.conversation.at(-1)).toEqual({ role: "assistant", content: "I am halfway thro\n\n[interrupted by the user]" });
    expect(entries(agent, "text")[0]).toMatchObject({ text: "I am halfway thro", streaming: false });
    expect(entries(agent, "info").map((e) => e.text)).toContain("Interrupted.");

    agent.deliver({ from: "you", text: "try again" });
    await driver.idle();
    expect(client.requests[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "I am halfway thro\n\n[interrupted by the user]" },
      { role: "user", content: "try again" },
    ]);
  });

  it("interrupts a running tool, answers every call and keeps waiting messages unanswered", async () => {
    const slow = slowTool();
    const { agent, client, driver } = await setup({
      tools: [slow.tool, echoTool],
      steps: [callTools([{ name: "slow", arguments: {} }, { name: "echo", arguments: { text: "never" } }]), reply("next")],
    });
    agent.deliver({ from: "you", text: "go" });
    await slow.started;
    agent.deliver({ from: "vega", text: "status?" });
    expect(agent.queued).toBe(1);
    agent.interrupt();
    await driver.idle();

    expect(client.requests).toHaveLength(1);
    expect(agent.status).toBe("idle");
    expect(agent.queued).toBe(0);
    const tail = driver.conversation.slice(-3);
    expect(tail[0]).toMatchObject({ role: "tool", toolCallId: "call_0", isError: true });
    expect(tail[0].content).toMatch(/Interrupted by the user|stopped/);
    expect(tail[1]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "echo",
      content: "Not run: the user interrupted.\n[interrupted by the user]",
      isError: true,
    });
    expect(tail[2]).toEqual({ role: "user", content: "[message from vega] status?" });

    agent.deliver({ from: "you", text: "carry on" });
    await driver.idle();
    expect(client.requests[1].messages.slice(-2)).toEqual([
      { role: "user", content: "[message from vega] status?" },
      { role: "user", content: "carry on" },
    ]);
  });

  it("shows provider errors with their status and recovers on the next message", async () => {
    const { agent, driver } = await setup({
      steps: [failing(new ProviderError("invalid x-api-key", 401)), reply("Back again.")],
    });
    agent.deliver({ from: "you", text: "hi" });
    await driver.idle();
    expect(agent.status).toBe("error");
    expect(agent.lastError).toBe("401 invalid x-api-key Check the sign-in or API key (/login).");
    expect(entries(agent, "error")).toHaveLength(1);
    // The user's message stays in the conversation, so a retry still answers it.
    expect(driver.conversation).toEqual([{ role: "user", content: "hi" }]);

    agent.deliver({ from: "you", text: "hi again" });
    await driver.idle();
    expect(agent.status).toBe("idle");
    expect(agent.lastError).toBeNull();
    expect(driver.conversation.map((m) => m.content)).toEqual(["hi", "hi again", "Back again."]);
  });

  it("retries rate limits with an info row", async () => {
    const { agent, client, driver } = await setup({
      steps: [failing(new ProviderError("Rate limit exceeded", 429, 4000)), reply("Made it.")],
    });
    agent.deliver({ from: "you", text: "hi" });
    await driver.idle();
    expect(client.requests).toHaveLength(2);
    expect(entries(agent, "info").map((e) => e.text)).toEqual(["retrying in 4s (429 Rate limit exceeded)"]);
    expect(agent.status).toBe("idle");
    expect(entries(agent, "text").map((e) => e.text)).toEqual(["Made it."]);
  });

  it("keeps text that streamed before an error", async () => {
    const { agent, driver } = await setup({
      steps: [
        async function* () {
          yield { type: "text", text: "The answer is" };
          throw new ProviderError("upstream closed", 502);
        },
      ],
    });
    agent.deliver({ from: "you", text: "?" });
    await driver.idle();
    expect(agent.status).toBe("error");
    expect(driver.conversation.at(-1)).toEqual({ role: "assistant", content: "The answer is\n\n[the answer was cut off by an error]" });
  });

  it("stops after maxSteps", async () => {
    const loop = () => callTools([{ name: "echo", arguments: { text: "again" } }]);
    const { agent, client, driver } = await setup({ steps: [loop(), loop(), loop(), loop()], deps: { maxSteps: 3 } });
    agent.deliver({ from: "you", text: "loop" });
    await driver.idle();
    expect(client.requests).toHaveLength(3);
    expect(entries(agent, "info").map((e) => e.text)).toEqual(["Stopped after 3 steps. Send a message to let it go on."]);
    expect(agent.status).toBe("idle");
    expect(driver.conversation.at(-1)).toMatchObject({ role: "tool", content: "echo: again" });
  });

  it("reports a provider that isn't ready at start and resolves again at each turn", async () => {
    let ready = false;
    const { agent, client, driver } = await setup({
      steps: [reply("Signed in now.")],
      deps: {
        resolveModel: () => {
          if (!ready) throw new ProviderNotReadyError("OpenRouter needs an API key.", "openrouter", "Open /login and sign in with OpenRouter.");
          return MODEL;
        },
      },
    });
    expect(agent.status).toBe("error");
    expect(agent.lastError).toBe("OpenRouter needs an API key. Open /login and sign in with OpenRouter.");

    agent.deliver({ from: "you", text: "hi" });
    await driver.idle();
    expect(agent.status).toBe("error");
    expect(client.requests).toHaveLength(0);

    ready = true;
    agent.deliver({ from: "you", text: "hi again" });
    await driver.idle();
    expect(agent.status).toBe("idle");
    expect(client.requests[0].messages.map((m) => m.content)).toEqual(["hi", "hi again"]);
  });

  it("drops old tool output when the context gets full", async () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ name: "echo", arguments: { text: `result number ${i} with plenty of text` } }));
    const small: ResolvedModel = { ...MODEL, model: { ...MODEL.model, contextWindow: 1000 } };
    const { agent, client, driver } = await setup({
      steps: [callTools(calls, { usage: usage(900, 20) }), reply("done")],
      deps: { resolveModel: () => small },
    });
    agent.deliver({ from: "you", text: "go" });
    await driver.idle();
    const results = client.requests[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results.slice(0, 2)).toEqual([REMOVED_OUTPUT, REMOVED_OUTPUT]);
    expect(results.slice(2)).toEqual(calls.slice(2).map((c) => `echo: ${c.arguments.text}`));
    expect(entries(agent, "info").some((e) => e.text.includes("removed the output of 2 old tool calls"))).toBe(true);
  });

  it("asks the system prompt again for every request", async () => {
    const { agent, client, driver } = await setup({ steps: [callTools([{ name: "echo", arguments: { text: "x" } }]), reply("y")] });
    agent.deliver({ from: "you", text: "go" });
    await driver.idle();
    expect(client.requests.map((r) => r.system)).toEqual(["You are luna (prompt #1).", "You are luna (prompt #2)."]);
  });

  it("saves and restores the conversation", async () => {
    const first = await setup({ steps: [callTools([{ name: "echo", arguments: { text: "x" } }]), reply("Noted.")] });
    first.agent.deliver({ from: "you", text: "remember the moon" });
    await first.driver.idle();
    const saved = JSON.parse(JSON.stringify(first.driver.snapshot()));

    const second = await setup({ steps: [reply("You said: remember the moon.")] });
    second.driver.restore(saved);
    expect(second.driver.conversation).toHaveLength(4);
    second.agent.deliver({ from: "you", text: "what did I say?" });
    await second.driver.idle();
    expect(second.client.requests[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);

    // Garbage is ignored; dangling tool calls get a result.
    second.driver.restore({ nope: true });
    expect(second.driver.conversation).toHaveLength(6);
    const third = await setup();
    third.driver.restore({
      version: 1,
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "echo", arguments: {} }] },
        { bogus: 1 },
      ],
    });
    expect(third.driver.conversation.at(-1)).toMatchObject({ role: "tool", toolCallId: "a", isError: true });
  });

  it("dispose stops a running turn and leaves a stopped agent stopped", async () => {
    let started!: () => void;
    const streaming = new Promise<void>((r) => (started = r));
    const { agent, driver, project } = await setup({ steps: [hang("...", () => started())] });
    agent.deliver({ from: "you", text: "go" });
    await streaming;
    await project.removeAgent(agent);
    await driver.idle();
    expect(agent.status).toBe("stopped");
    agent.deliver({ from: "you", text: "anyone?" });
    expect(driver.busy).toBe(false);
  });

  it("writes files through the tools inside the project folder", async () => {
    const write = (await import("../../src/tools/fs.js")).writeFileTool;
    const { agent, dir, driver } = await setup({
      tools: [write],
      steps: [callTools([{ name: "write_file", arguments: { path: path.join("src", "room.ts"), content: "export const room = 1;\n" } }]), reply("Created it.")],
    });
    agent.deliver({ from: "you", text: "make a room" });
    await driver.idle();
    expect(fs.readFileSync(path.join(dir, "src", "room.ts"), "utf8")).toBe("export const room = 1;\n");
    expect(agent.linesAdded).toBe(1);
    expect(entries(agent, "tool")[0]).toMatchObject({ verb: "new", status: "ok", added: 1 });
  });
});
