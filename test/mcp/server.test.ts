import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { Project, type ProjectRuntime } from "../../src/core/project.js";
import type { PermissionMode } from "../../src/core/types.js";
import { DEFAULT_PROTOCOL_VERSION, McpServer, stableStringify, type McpAgentBinding } from "../../src/mcp/server.js";
import type { Tool, ToolServices } from "../../src/tools/types.js";

const echoTool: Tool = {
  name: "echo",
  description: "Echoes the text back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  risk: "read",
  describe: (args) => ({ verb: "echo", target: String(args.text) }),
  run: async (args, ctx) => ({
    content: `echo: ${args.text} (from ${ctx.agentName})`,
    display: { detail: "echoed", added: 2, removed: 1 },
  }),
  mcp: true,
};

const deployTool: Tool = {
  name: "deploy",
  description: "Deploys the place.",
  parameters: { type: "object", properties: {} },
  risk: "exec",
  describe: () => ({ verb: "deploy", target: "the place" }),
  run: async () => ({ content: "deployed" }),
  mcp: true,
};

const waitTool: Tool = {
  name: "wait",
  description: "Waits until aborted.",
  parameters: { type: "object", properties: {} },
  risk: "read",
  describe: () => ({ verb: "wait" }),
  run: (_args, ctx) =>
    new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve({ content: "aborted", isError: true }), { once: true });
    }),
  mcp: true,
};

const spawnTool: Tool = {
  name: "spawn_agent",
  description: "Starts a worker.",
  parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  risk: "read",
  describe: (args) => ({ verb: "spawn", target: String(args.task) }),
  run: async () => ({ content: "spawned vega" }),
  mcp: true,
  leadOnly: true,
};

let stateDir: string;
let server: McpServer;
let lead: Agent;
let worker: Agent;
let project: Project;

function makeAgent(name: string, role: "lead" | "worker", mode: PermissionMode): Agent {
  return new Agent({ name, role, model: { provider: "claude-code", model: "opus" } }, new Notifier(), mode);
}

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-mcp-"));
  const runtime: ProjectRuntime = { launch: async () => undefined, defaultWorkerModel: () => ({ provider: "x", model: "y" }) };
  project = new Project({ cwd: stateDir, name: "demo" }, new Notifier(), runtime);
  lead = makeAgent("luna", "lead", "auto-edit");
  worker = makeAgent("vega", "worker", "auto-edit");
  project.agents.push(lead, worker);
  const services = {} as ToolServices;
  const bindings = new Map<string, McpAgentBinding>([
    [lead.id, { agent: lead, project, tools: [echoTool, deployTool, waitTool, spawnTool], services }],
    [worker.id, { agent: worker, project, tools: [echoTool, spawnTool], services }],
  ]);
  server = new McpServer({ stateDir, version: "1.2.3", resolve: (id) => bindings.get(id) ?? null });
  await server.start(0);
});

afterEach(async () => {
  await server.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

interface Registered {
  url: string;
  token: string;
  configFile: string;
}

async function register(agent: Agent): Promise<Registered> {
  const { configFile, serverName } = await server.register(agent);
  expect(serverName).toBe("luminal");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const entry = config.mcpServers.luminal;
  return { url: entry.url, token: entry.headers.Authorization.replace(/^Bearer /, ""), configFile };
}

async function post(
  r: Registered,
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; raw?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...opts.headers,
  };
  const token = opts.token === undefined ? r.token : opts.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(r.url, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body), signal: opts.signal });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

const call = (id: number, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("McpServer: registration", () => {
  it("listens on 127.0.0.1 and writes a private config per agent", async () => {
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await register(lead);
    expect(r.configFile).toBe(path.join(stateDir, "mcp", `${lead.id}.json`));
    expect(JSON.parse(fs.readFileSync(r.configFile, "utf8"))).toEqual({
      mcpServers: {
        luminal: { type: "http", url: `${server.baseUrl}/mcp/${lead.id}`, headers: { Authorization: `Bearer ${r.token}` } },
      },
    });
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect(fs.statSync(r.configFile).mode & 0o777).toBe(0o600);
    // Each registration gets its own token.
    const again = await register(lead);
    expect(again.token).not.toBe(r.token);
    expect((await post(r, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await post(again, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  it("starts itself when an agent registers first", async () => {
    await server.stop();
    expect(server.baseUrl).toBe("");
    const r = await register(lead);
    expect(server.baseUrl).not.toBe("");
    expect((await post(r, { jsonrpc: "2.0", id: 1, method: "ping" })).json).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("rewrites the configs when it comes back on another port", async () => {
    const r = await register(lead);
    const before = server.baseUrl;
    await server.stop();
    await server.start(0);
    const config = JSON.parse(fs.readFileSync(r.configFile, "utf8"));
    expect(config.mcpServers.luminal.url).toBe(`${server.baseUrl}/mcp/${lead.id}`);
    expect(config.mcpServers.luminal.headers.Authorization).toBe(`Bearer ${r.token}`);
    if (server.baseUrl !== before) await expect(fetch(r.url, { method: "POST", body: "{}" })).rejects.toThrow();
    expect((await post({ ...r, url: config.mcpServers.luminal.url }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  it("forgets an agent on unregister", async () => {
    const r = await register(lead);
    server.unregister(lead.id);
    expect(fs.existsSync(r.configFile)).toBe(false);
    expect((await post(r, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    server.unregister(lead.id);
  });
});

describe("McpServer: HTTP", () => {
  it("rejects missing, wrong and other agents' tokens", async () => {
    const r = await register(lead);
    const w = await register(worker);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const none = await post(r, ping, { token: null });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await post(r, ping, { token: "0".repeat(64) })).status).toBe(401);
    expect((await post(r, ping, { token: "short" })).status).toBe(401);
    expect((await post(r, ping, { token: w.token })).status).toBe(401);
    expect((await post({ ...r, url: `${server.baseUrl}/mcp/agent_nobody` }, ping)).status).toBe(401);
    expect((await post({ ...r, url: `${server.baseUrl}/other` }, ping)).status).toBe(404);
    expect((await post(r, ping)).status).toBe(200);
  });

  it("refuses browsers from other origins", async () => {
    const r = await register(lead);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(r, ping, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await post(r, ping, { headers: { Origin: "http://localhost:5173" } })).status).toBe(200);
  });

  it("initializes with a protocol version it speaks and a session id", async () => {
    const r = await register(lead);
    const res = await post(r, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: { roots: {} }, clientInfo: { name: "claude-code", version: "2.1.310" } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.json).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lu-minal", version: "1.2.3" },
      },
    });
    const session = res.headers.get("mcp-session-id");
    expect(session).toMatch(/^[0-9a-f-]{36}$/);

    const unknown = await post(r, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.json.result.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
    expect(DEFAULT_PROTOCOL_VERSION).toBe("2025-06-18");

    // The session works, ends with DELETE, and is unknown afterwards.
    const withSession = { headers: { "Mcp-Session-Id": session! } };
    expect((await post(r, { jsonrpc: "2.0", id: 2, method: "ping" }, withSession)).status).toBe(200);
    const del = await fetch(r.url, { method: "DELETE", headers: { Authorization: `Bearer ${r.token}`, "Mcp-Session-Id": session! } });
    expect(del.status).toBe(200);
    expect((await post(r, { jsonrpc: "2.0", id: 3, method: "ping" }, withSession)).status).toBe(404);
  });

  it("answers notifications and responses with 202 and no body", async () => {
    const r = await register(lead);
    const n = await post(r, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    expect(n.text).toBe("");
    const resp = await post(r, { jsonrpc: "2.0", id: 5, result: {} });
    expect(resp.status).toBe(202);
  });

  it("speaks JSON-RPC errors: parse, invalid request, unknown method", async () => {
    const r = await register(lead);
    const bad = await post(r, null, { raw: "{not json" });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect((await post(r, { id: 1, method: "ping" })).json).toMatchObject({ id: 1, error: { code: -32600 } });
    expect((await post(r, { jsonrpc: "2.0", id: 2, method: "resources/list" })).json).toMatchObject({
      id: 2,
      error: { code: -32601 },
    });
    expect((await post(r, [], {})).json).toMatchObject({ error: { code: -32600 } });
  });

  it("allows only POST and DELETE", async () => {
    const r = await register(lead);
    const get = await fetch(r.url, { headers: { Authorization: `Bearer ${r.token}`, Accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, DELETE");
    const put = await fetch(r.url, { method: "PUT", headers: { Authorization: `Bearer ${r.token}` }, body: "{}" });
    expect(put.status).toBe(405);
  });

  it("refuses bodies over 4 MB", async () => {
    const r = await register(lead);
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(4 * 1024 * 1024 + 10) } });
    const res = await post(r, null, { raw: huge });
    expect(res.status).toBe(413);
  });

  it("answers a batch in one response", async () => {
    const r = await register(lead);
    const res = await post(r, [
      { jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "ping" },
      { jsonrpc: "2.0", id: "c", method: "tools/list" },
      { jsonrpc: "2.0", id: "d", method: "nope" },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    expect(res.json.map((m: any) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(res.json[1]).toEqual({ jsonrpc: "2.0", id: "b", result: {} });
    expect(res.json[2].result.tools.length).toBeGreaterThan(0);
    expect(res.json[3].error.code).toBe(-32601);
    const onlyNotifications = await post(r, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(onlyNotifications.status).toBe(202);
  });
});

describe("McpServer: tools", () => {
  it("lists the agent's tools plus the internal approve tool, lead-only ones for the lead only", async () => {
    const r = await register(lead);
    const list = (await post(r, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result.tools;
    expect(list.map((t: any) => t.name)).toEqual(["echo", "deploy", "wait", "spawn_agent", "approve"]);
    expect(list[0]).toEqual({ name: "echo", description: "Echoes the text back.", inputSchema: echoTool.parameters });
    expect(list[4].inputSchema.required).toEqual(["tool_name", "input"]);

    const w = await register(worker);
    const workerList = (await post(w, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result.tools;
    expect(workerList.map((t: any) => t.name)).toEqual(["echo", "approve"]);
  });

  it("runs a tool quietly and keeps its display for the driver", async () => {
    const r = await register(lead);
    const res = await post(r, call(7, "echo", { text: "hi" }));
    expect(res.json).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "echo: hi (from luna)" }], isError: false },
    });
    // No row of its own (the driver logs Claude Code's), but the lines count.
    expect(lead.log.filter((e) => e.kind === "tool")).toHaveLength(0);
    expect(lead.linesAdded).toBe(2);
    expect(lead.linesRemoved).toBe(1);
    const call1 = { toolUseId: "toolu_1", name: "mcp__luminal__echo", input: { text: "hi" } };
    expect(server.takeDisplay(lead.id, call1)).toEqual({ display: { detail: "echoed", added: 2, removed: 1 }, isError: false });
    expect(server.takeDisplay(lead.id, call1)).toBeNull();
  });

  it("matches a display by Claude Code's tool use id when the call carries one", async () => {
    const r = await register(lead);
    await post(r, call(1, "echo", { text: "one" }, { "claudecode/toolUseId": "toolu_A" }));
    await post(r, call(2, "echo", { text: "one" }, { "claudecode/toolUseId": "toolu_B" }));
    expect(server.takeDisplay(lead.id, { toolUseId: "toolu_B", name: "echo", input: { text: "one" } })).not.toBeNull();
    expect(server.takeDisplay(lead.id, { toolUseId: "toolu_X", name: "echo", input: { text: "one" } })).not.toBeNull();
    expect(server.takeDisplay(lead.id, { toolUseId: "toolu_A", name: "echo", input: { text: "one" } })).toBeNull();
  });

  it("describes a tool by its own describe()", () => {
    expect(server.describeTool(lead.id, "mcp__luminal__echo", { text: "x" })).toEqual({ verb: "echo", target: "x" });
    expect(server.describeTool(lead.id, "spawn_agent", { task: "Build" })).toEqual({ verb: "spawn", target: "Build" });
    expect(server.describeTool(lead.id, "missing", {})).toBeNull();
    expect(server.describeTool("agent_nobody", "echo", {})).toBeNull();
  });

  it("answers an unknown tool with invalid params and a missing agent with an error result", async () => {
    const r = await register(lead);
    expect((await post(r, call(1, "nope", {}))).json).toMatchObject({ id: 1, error: { code: -32602, message: "Unknown tool: nope" } });
    expect((await post(r, { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} })).json.error.code).toBe(-32602);
    const ghost = makeAgent("ghost", "worker", "yolo");
    const g = await register(ghost);
    expect((await post(g, call(3, "echo", { text: "x" }))).json.result).toEqual({
      content: [{ type: "text", text: "This agent is no longer running in lu-minal." }],
      isError: true,
    });
  });

  it("asks before a risky tool runs, through the agent's approvals", async () => {
    const r = await register(lead);
    const pending = post(r, call(1, "deploy", {}));
    await waitFor(() => lead.pendingApproval !== null, "the approval");
    expect(lead.pendingApproval).toMatchObject({ tool: "deploy", risk: "exec", summary: "deploy the place" });
    lead.answerApproval("allow");
    expect((await pending).json.result).toEqual({ content: [{ type: "text", text: "deployed" }], isError: false });
  });

  it("aborts a running call on notifications/cancelled", async () => {
    const r = await register(lead);
    const running = post(r, call(42, "wait", {}));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await post(r, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } })).status).toBe(202);
    expect((await running).json.result).toEqual({ content: [{ type: "text", text: "aborted" }], isError: true });
  });
});

describe("McpServer: Claude Code's permission prompts (approve)", () => {
  const approve = (id: number, toolName: string, input: Record<string, unknown>) =>
    call(id, "approve", { tool_name: toolName, input, tool_use_id: `toolu_${id}` });
  const answer = (res: { json: any }) => {
    expect(res.json.result.isError).toBe(false);
    return JSON.parse(res.json.result.content[0].text);
  };

  it("allows at once when the permission mode does", async () => {
    lead.permissionMode = "yolo";
    const r = await register(lead);
    expect(answer(await post(r, approve(1, "Bash", { command: "rm -rf build" })))).toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf build" },
    });
    lead.permissionMode = "auto-edit";
    expect(answer(await post(r, approve(2, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" })))).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
    });
    expect(answer(await post(r, approve(3, "Bash", { command: "git status" }))).behavior).toBe("allow");
    expect(lead.log.filter((e) => e.kind === "approval")).toHaveLength(0);
  });

  it("asks the user and passes the answer on", async () => {
    lead.permissionMode = "ask";
    const r = await register(lead);
    const pending = post(r, approve(1, "Bash", { command: "npm test", description: "Run the tests" }));
    await waitFor(() => lead.pendingApproval !== null, "the approval");
    expect(lead.status).toBe("waiting");
    expect(lead.pendingApproval).toMatchObject({
      tool: "Bash",
      risk: "exec",
      summary: "run npm test",
      detail: "npm test\n(Run the tests)",
      allowKey: "Bash:npm test",
    });
    lead.answerApproval("deny");
    expect(answer(await pending)).toEqual({ behavior: "deny", message: "The user denied this in lu-minal." });

    const again = post(r, approve(2, "Bash", { command: "npm test -- --run" }));
    await waitFor(() => lead.pendingApproval !== null, "the second approval");
    lead.answerApproval("always");
    expect(answer(await again).behavior).toBe("allow");
    // "Bash:npm test" is remembered now.
    expect(answer(await post(r, approve(3, "Bash", { command: "npm test" }))).behavior).toBe("allow");
    expect(lead.pendingApproval).toBeNull();
  });

  it("refuses edits in plan mode with a reason Claude can act on", async () => {
    lead.permissionMode = "plan";
    const r = await register(lead);
    expect(answer(await post(r, approve(1, "Write", { file_path: "x.ts", content: "" })))).toEqual({
      behavior: "deny",
      message: "Not allowed: lu-minal is in plan mode (read-only). Describe the change instead.",
    });
  });

  it("withdraws the question when Claude Code goes away", async () => {
    lead.permissionMode = "ask";
    const r = await register(lead);
    const controller = new AbortController();
    const pending = post(r, approve(1, "Bash", { command: "make deploy" }), { signal: controller.signal }).catch((e) => e);
    await waitFor(() => lead.pendingApproval !== null, "the approval");
    controller.abort();
    await pending;
    await waitFor(() => lead.pendingApproval === null, "the withdrawn approval");
    const entry = lead.log.find((e) => e.kind === "approval") as any;
    await waitFor(() => entry.decision === "deny", "the logged decision");
  });
});

describe("stableStringify", () => {
  it("sorts keys at every level", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(stableStringify({ a: undefined, b: "x" })).toBe('{"b":"x"}');
  });
});
