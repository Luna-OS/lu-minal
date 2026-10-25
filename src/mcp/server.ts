// A minimal MCP server (Streamable HTTP, JSON responses only) on 127.0.0.1 that gives Claude Code
// agents lu-minal's own tools (team messages, the task board, themes, Roblox Studio) and answers
// Claude Code's permission prompts through the internal "approve" tool.
//
// Every agent gets its own URL (/mcp/<agentId>) and a random bearer token, written into a small
// config file for `claude --mcp-config`. Tool calls run through runToolCall like a native agent's,
// but quietly: the Claude driver logs the row from Claude Code's own stream.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { MCP_TOOL_TIMEOUT_MS } from "../agents/claude-code/cli.js";
import type { Agent } from "../core/agent.js";
import { newId } from "../core/emitter.js";
import type { Project } from "../core/project.js";
import { createToolContext, normalizeArgs, runToolCall } from "../tools/run.js";
import type { Tool, ToolDisplay, ToolServices } from "../tools/types.js";
import { APPROVE_TOOL, APPROVE_TOOL_NAME, approvalAnswer, askWithdrawable, assessClaudeTool, automaticAnswer } from "./approve.js";
import { classify, RPC_ERRORS, RpcError, rpcError, rpcResult, type JsonRpcId, type JsonRpcResponse } from "./jsonrpc.js";

/** The server's name in Claude Code's config: its tools are "mcp__luminal__<tool>". */
export const MCP_SERVER_NAME = "luminal";

/** The MCP revisions this server speaks; a client asking for another one gets the default. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** How long a finished call's display waits for the driver to pick it up. */
const RECENT_TTL_MS = 10 * 60_000;
const MAX_RECENT = 64;
const MAX_SESSIONS_PER_AGENT = 8;

/** What the server needs to run tools for one agent (the Hub resolves it by agent id). */
export interface McpAgentBinding {
  agent: Agent;
  project: Project;
  tools: Tool[];
  services: ToolServices;
}

export interface McpServerOptions {
  /** The agent behind a URL, or null when it is gone. */
  resolve(agentId: string): McpAgentBinding | null;
  /** lu-minal's state dir; the per-agent configs go into <stateDir>/mcp. */
  stateDir: string;
  /** lu-minal's version, for serverInfo. */
  version?: string;
}

interface RecentCall {
  toolUseId: string | null;
  key: string;
  display: ToolDisplay | undefined;
  isError: boolean;
  at: number;
}

interface Registration {
  agentId: string;
  token: string;
  digest: Buffer;
  configFile: string;
  sessions: Set<string>;
  recent: RecentCall[];
  /** Running calls by MCP session and JSON-RPC id (inflightKey), for notifications/cancelled. */
  inflight: Map<string, AbortController>;
}

/** The server entry Claude Code reads from `--mcp-config`. */
export interface McpServerEntry {
  type: "http";
  url: string;
  headers: Record<string, string>;
  /**
   * How long Claude Code waits for one request, in ms. HTTP servers otherwise get 60 s per request,
   * too short for a permission prompt that waits for the user.
   */
  timeout: number;
}

/** JSON-RPC ids are only unique within one MCP session (one Claude Code process). */
const inflightKey = (sessionId: string | null, id: JsonRpcId) => `${sessionId ?? ""}\u0000${String(id)}`;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest();

/** JSON with sorted keys, so the same arguments always give the same text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const callKey = (name: string, args: unknown) => `${name}\u0000${stableStringify(args ?? {})}`;

/** A tools/call result with one text block. */
function textResult(text: string, isError: boolean): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

class BodyTooLarge extends Error {}

/** Reads a request body; past `limit` the rest is drained and dropped, then BodyTooLarge rejects. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > limit) {
        // Keep reading (and dropping) so the client gets to read our answer.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new BodyTooLarge("Request body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    // A client that goes away halfway through the body sends neither "end" nor always "error".
    req.on("close", () => {
      if (!req.complete) reject(new Error("The request was cut off."));
    });
  });
}

/** Browsers send an Origin; only pages on this machine may talk to the server (DNS rebinding). */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function header(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" && v ? v : null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(text)),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

export class McpServer {
  private server: http.Server | null = null;
  private listening: Promise<number> | null = null;
  private port: number | null = null;
  private readonly agents = new Map<string, Registration>();
  /** Session id → agent id. */
  private readonly sessions = new Map<string, string>();

  constructor(private readonly opts: McpServerOptions) {}

  /** "http://127.0.0.1:<port>", or "" while the server is not listening. */
  get baseUrl(): string {
    return this.port === null ? "" : `http://127.0.0.1:${this.port}`;
  }

  /** The port it listens on, or null. */
  get listeningPort(): number | null {
    return this.port;
  }

  /** Starts listening on 127.0.0.1 (port 0 picks a free one). Resolves to the port. */
  start(port = 0): Promise<number> {
    if (this.listening) return this.listening;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, rpcError(null, RPC_ERRORS.internal, err instanceof Error ? err.message : String(err)));
        } else {
          res.end();
        }
      });
    });
    // Approvals can wait a long time for the user: no socket inactivity timeout.
    server.timeout = 0;
    server.keepAliveTimeout = 30_000;
    this.server = server;
    this.listening = new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        this.listening = null;
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        this.port = (server.address() as AddressInfo).port;
        // Agents registered before a restart get configs with the new address.
        for (const reg of this.agents.values()) this.writeConfig(reg);
        resolve(this.port);
      });
    });
    return this.listening;
  }

  /** Stops the server; running calls are aborted (their approvals denied). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.port = null;
    for (const reg of this.agents.values()) {
      for (const c of reg.inflight.values()) c.abort();
      reg.inflight.clear();
    }
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive sockets would hold close() open (guarded: not every runtime has it).
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }

  /**
   * Gives an agent its URL and a fresh token, and writes `<stateDir>/mcp/<agentId>.json` (mode
   * 0600) for `claude --mcp-config`. Starts the server first if needed.
   */
  async register(agent: Agent): Promise<{ configFile: string; serverName: "luminal" }> {
    await (this.listening ?? this.start(0));
    const old = this.agents.get(agent.id);
    if (old) this.forgetSessions(old);
    const token = crypto.randomBytes(32).toString("hex");
    const dir = path.join(this.opts.stateDir, "mcp");
    const configFile = path.join(dir, `${agent.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    const reg: Registration = {
      agentId: agent.id,
      token,
      digest: sha256(token),
      configFile,
      sessions: new Set(),
      recent: [],
      inflight: old?.inflight ?? new Map(),
    };
    this.writeConfig(reg);
    this.agents.set(agent.id, reg);
    return { configFile, serverName: MCP_SERVER_NAME };
  }

  /** Forgets an agent: deletes its config, invalidates its token, aborts its running calls. */
  unregister(agentId: string): void {
    const reg = this.agents.get(agentId);
    if (!reg) return;
    this.agents.delete(agentId);
    this.forgetSessions(reg);
    for (const c of reg.inflight.values()) c.abort();
    reg.inflight.clear();
    try {
      fs.rmSync(reg.configFile, { force: true });
    } catch {
      // already gone
    }
  }

  /** The config file content for an agent (what register writes). */
  configFor(agentId: string): { mcpServers: Record<string, McpServerEntry> } | null {
    const reg = this.agents.get(agentId);
    if (!reg) return null;
    return this.configOf(reg);
  }

  /**
   * The panel's verb and target for a call of one of lu-minal's tools ("send_message" or
   * "mcp__luminal__send_message"), from the tool's own describe(); null when unknown.
   */
  describeTool(agentId: string, name: string, args: Record<string, unknown>): { verb: string; target?: string } | null {
    const binding = this.opts.resolve(agentId);
    if (!binding) return null;
    const bare = this.bareName(name);
    const tool = binding.tools.find((t) => t.name === bare);
    if (!tool) return null;
    try {
      const ctx = createToolContext({
        agent: binding.agent,
        project: binding.project,
        services: binding.services,
        signal: new AbortController().signal,
      });
      return tool.describe(normalizeArgs(args), ctx);
    } catch {
      return null;
    }
  }

  /**
   * The display of a finished call of one of lu-minal's tools, so the driver can show it on the row
   * it logs from Claude Code's stream. Matched by Claude Code's tool use id when the call carried
   * it, else by name and arguments. Each result is handed out once.
   */
  takeDisplay(
    agentId: string,
    call: { toolUseId: string; name: string; input: Record<string, unknown> },
  ): { display: ToolDisplay; isError: boolean } | null {
    const reg = this.agents.get(agentId);
    if (!reg) return null;
    this.prune(reg);
    let i = reg.recent.findIndex((r) => r.toolUseId !== null && r.toolUseId === call.toolUseId);
    if (i < 0) {
      const key = callKey(this.bareName(call.name), call.input);
      i = reg.recent.findIndex((r) => r.key === key);
    }
    if (i < 0) return null;
    const [hit] = reg.recent.splice(i, 1);
    return { display: hit.display ?? {}, isError: hit.isError };
  }

  // ---- internals -------------------------------------------------------------------------------

  private bareName(name: string): string {
    const prefix = `mcp__${MCP_SERVER_NAME}__`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }

  private configOf(reg: Registration): { mcpServers: Record<string, McpServerEntry> } {
    return {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: `${this.baseUrl}/mcp/${encodeURIComponent(reg.agentId)}`,
          headers: { Authorization: `Bearer ${reg.token}` },
          timeout: MCP_TOOL_TIMEOUT_MS,
        },
      },
    };
  }

  private writeConfig(reg: Registration): void {
    if (this.port === null) return;
    const dir = path.dirname(reg.configFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const content = `${JSON.stringify(this.configOf(reg), null, 2)}\n`;
    // Temp file + rename: a starting `claude` never reads half a file.
    const tmp = `${reg.configFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
      fs.renameSync(tmp, reg.configFile);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    try {
      fs.chmodSync(reg.configFile, 0o600);
    } catch {
      // Windows keeps the folder's ACL (the user's own profile).
    }
  }

  private forgetSessions(reg: Registration): void {
    for (const s of reg.sessions) this.sessions.delete(s);
    reg.sessions.clear();
  }

  private prune(reg: Registration): void {
    const cutoff = Date.now() - RECENT_TTL_MS;
    reg.recent = reg.recent.filter((r) => r.at >= cutoff).slice(-MAX_RECENT);
  }

  private authorized(value: string | null, reg: Registration): boolean {
    const m = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
    if (!m) return false;
    return crypto.timingSafeEqual(sha256(m[1].trim()), reg.digest);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return sendText(res, 404, "Not found");
    if (!originAllowed(header(req, "origin") ?? undefined)) return sendText(res, 403, "Forbidden");
    let agentId: string;
    try {
      agentId = decodeURIComponent(match[1]);
    } catch {
      return sendText(res, 404, "Not found");
    }
    const reg = this.agents.get(agentId);
    if (!reg || !this.authorized(header(req, "authorization"), reg)) {
      return sendText(res, 401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="lu-minal"' });
    }
    const sessionId = header(req, "mcp-session-id");
    if (sessionId && this.sessions.get(sessionId) !== agentId) {
      return sendJson(res, 404, rpcError(null, -32001, "Session not found"));
    }
    switch (req.method) {
      case "POST":
        return this.post(req, res, reg, sessionId);
      case "DELETE":
        if (sessionId) {
          this.sessions.delete(sessionId);
          reg.sessions.delete(sessionId);
          // The client ended the session: its running calls (a waiting approval) end with it.
          const prefix = inflightKey(sessionId, "");
          for (const [key, controller] of reg.inflight) if (key.startsWith(prefix)) controller.abort();
        }
        res.writeHead(200, { "Content-Length": "0" });
        res.end();
        return;
      case "GET":
      default:
        // No server-to-client stream: everything is answered on the POST.
        return sendText(res, 405, "Method not allowed", { Allow: "POST, DELETE" });
    }
  }

  private async post(req: http.IncomingMessage, res: http.ServerResponse, reg: Registration, sessionId: string | null): Promise<void> {
    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        return sendJson(res, 413, rpcError(null, RPC_ERRORS.invalidRequest, "Request too large"), { Connection: "close" });
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, rpcError(null, RPC_ERRORS.parse, "Parse error"));
    }

    // A call stops when its HTTP request goes away (Claude Code was interrupted or killed).
    const request = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) request.abort();
    });

    const batch = Array.isArray(parsed);
    const messages: unknown[] = batch ? (parsed as unknown[]) : [parsed];
    if (batch && !messages.length) {
      return sendJson(res, 400, rpcError(null, RPC_ERRORS.invalidRequest, "Empty batch"));
    }
    let newSession: string | null = null;
    const answers = await Promise.all(
      messages.map((m) =>
        this.dispatch(m, reg, sessionId, request.signal, (sid) => {
          newSession = sid;
        }),
      ),
    );
    const responses = answers.filter((a): a is JsonRpcResponse => a !== null);
    if (res.destroyed) return;
    const headers: Record<string, string> = newSession ? { "Mcp-Session-Id": newSession } : {};
    if (!responses.length) {
      res.writeHead(202, { "Content-Length": "0", ...headers });
      res.end();
      return;
    }
    sendJson(res, 200, batch ? responses : responses[0], headers);
  }

  private async dispatch(
    message: unknown,
    reg: Registration,
    sessionId: string | null,
    signal: AbortSignal,
    onSession: (sessionId: string) => void,
  ): Promise<JsonRpcResponse | null> {
    const c = classify(message);
    switch (c.kind) {
      case "response":
        return null;
      case "invalid":
        return rpcError(c.id, RPC_ERRORS.invalidRequest, "Invalid request");
      case "notification":
        if (c.message.method === "notifications/cancelled" && isObj(c.message.params)) {
          const id = c.message.params.requestId;
          if (typeof id === "string" || typeof id === "number") reg.inflight.get(inflightKey(sessionId, id))?.abort();
        }
        return null;
      case "request": {
        const { id, method, params } = c.message;
        try {
          return rpcResult(id, await this.call(method, params, inflightKey(sessionId, id), reg, signal, onSession));
        } catch (err) {
          if (err instanceof RpcError) return rpcError(id, err.code, err.message, err.data);
          return rpcError(id, RPC_ERRORS.internal, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  private async call(
    method: string,
    params: unknown,
    key: string,
    reg: Registration,
    signal: AbortSignal,
    onSession: (sessionId: string) => void,
  ): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const p = isObj(params) ? params : {};
        const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, reg.agentId);
        reg.sessions.add(sessionId);
        while (reg.sessions.size > MAX_SESSIONS_PER_AGENT) {
          const oldest = reg.sessions.values().next().value as string;
          reg.sessions.delete(oldest);
          this.sessions.delete(oldest);
        }
        onSession(sessionId);
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lu-minal", version: this.opts.version ?? "dev" },
        };
      }
      case "ping":
        return {};
      case "logging/setLevel":
        return {};
      case "tools/list":
        return { tools: this.listTools(reg.agentId) };
      case "tools/call":
        return this.callTool(params, key, reg, signal);
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  private listTools(agentId: string): Array<{ name: string; description: string; inputSchema: unknown }> {
    const binding = this.opts.resolve(agentId);
    const tools = binding
      ? binding.tools.filter((t) => t.name !== APPROVE_TOOL_NAME && (!t.leadOnly || binding.agent.role === "lead"))
      : [];
    const listed = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
    // The approve tool is Claude Code's permission prompt; ACP agents ask over ACP instead.
    if (binding?.agent.driver?.kind === "acp") return listed;
    return [
      ...listed,
      { name: APPROVE_TOOL.name, description: APPROVE_TOOL.description, inputSchema: APPROVE_TOOL.inputSchema },
    ];
  }

  private async callTool(params: unknown, key: string, reg: Registration, signal: AbortSignal): Promise<unknown> {
    const p = isObj(params) ? params : {};
    const name = typeof p.name === "string" ? p.name : "";
    if (!name) throw new RpcError(RPC_ERRORS.invalidParams, "tools/call needs a tool name.");
    const args = normalizeArgs(p.arguments);
    const meta = isObj(p._meta) ? p._meta : {};
    const toolUseId = typeof meta["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string) : null;
    const binding = this.opts.resolve(reg.agentId);
    if (!binding) return textResult("This agent is no longer running in lu-minal.", true);
    const isApprove = name === APPROVE_TOOL_NAME;
    const tool = isApprove ? undefined : binding.tools.find((t) => t.name === name);
    if (!isApprove && !tool) throw new RpcError(RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    reg.inflight.set(key, controller);
    try {
      if (isApprove) return await this.approve(binding, args, controller.signal);
      const ctx = createToolContext({
        agent: binding.agent,
        project: binding.project,
        services: binding.services,
        signal: controller.signal,
      });
      const result = await runToolCall({
        agent: binding.agent,
        tool,
        name,
        toolCallId: toolUseId ?? newId("mcp"),
        args,
        ctx,
        quiet: true,
      });
      this.prune(reg);
      reg.recent.push({ toolUseId, key: callKey(name, args), display: result.display, isError: Boolean(result.isError), at: Date.now() });
      return textResult(result.content, Boolean(result.isError));
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (reg.inflight.get(key) === controller) reg.inflight.delete(key);
    }
  }

  /**
   * Claude Code's permission prompt: { tool_name, input, tool_use_id? }. Decided like any other
   * approval (mode, "always" list, or the user), answered as Claude Code expects.
   */
  private async approve(binding: McpAgentBinding, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const { agent, project } = binding;
    const toolName = typeof args.tool_name === "string" && args.tool_name ? args.tool_name : "tool";
    const input = isObj(args.input) ? args.input : {};
    if (signal.aborted) return textResult(JSON.stringify(approvalAnswer(false, input, agent.permissionMode)), false);
    const automatic = automaticAnswer(toolName);
    if (automatic) return textResult(JSON.stringify(automatic), false);
    const assessed = assessClaudeTool(toolName, input, project.cwd);
    const ask = askWithdrawable(agent, {
      tool: toolName,
      risk: assessed.risk,
      summary: assessed.summary,
      detail: assessed.detail,
      allowKey: assessed.allowKey,
    });
    // Claude Code cancels the call (notifications/cancelled) or drops the request when it is
    // interrupted or dies: the question leaves the panel.
    signal.addEventListener("abort", ask.withdraw, { once: true });
    let decision: Awaited<typeof ask.decision>;
    try {
      decision = await ask.decision;
    } finally {
      signal.removeEventListener("abort", ask.withdraw);
    }
    return textResult(JSON.stringify(approvalAnswer(decision !== "deny", input, agent.permissionMode)), false);
  }
}
