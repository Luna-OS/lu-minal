// Runs a coding-agent CLI that speaks the Agent Client Protocol (OpenCode, Gemini CLI, custom ones)
// as a lu-minal agent: one process per agent, started in the project folder on the first message
// and kept alive between messages. lu-minal is the ACP client: it opens a session (handing over its
// MCP server for the team tools), sends each message as a session/prompt, turns the agent's
// session/update stream into the agent's log (text, reasoning, tool rows with diffs, the plan,
// usage) and answers its permission requests through Agent.requestApproval.
//
// lu-minal advertises neither file system nor terminal access: the agents use their own tools in
// the project folder, as Claude Code does, and ask before edits and commands.
//
// A process that dies, or that does not settle after a cancel, is replaced on the next message;
// the conversation goes on through session/resume or session/load when the agent supports them.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { Agent, AgentDriver, AgentInput } from "../../core/agent.js";
import type { Project } from "../../core/project.js";
import type { ApprovalDecision, DiffLine, LogEntry } from "../../core/types.js";
import { workVerb } from "../../core/verbs.js";
import { isWindows } from "../../platform/paths.js";
import { killTree, spawnProgram } from "../../platform/process.js";
import type { ToolDisplay } from "../../tools/types.js";
import { firstLine } from "../claude-code/display.js";
import type { McpLink } from "../claude-code/driver.js";
import {
  contentText,
  describeAcpTool,
  diffDisplay,
  diffItems,
  modeFor,
  permissionOptions,
  pickPermissionOption,
  planEntries,
  planSummary,
  resultDetail,
  riskFor,
  rowStatus,
  stopReasonNote,
  toolKind,
  type AcpMode,
  type AcpToolKind,
} from "./display.js";
import { ACP_DEFAULT_MODEL, acpCommandArgs, acpEnv, type AcpAuthMethod, type AcpPreset } from "./presets.js";
import { describeRpcError, RPC_CODES, RpcClosedError, RpcError, RpcPeer, RpcTimeoutError } from "./rpc.js";

/** The ACP version lu-minal speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** lu-minal's MCP server as an ACP agent needs it; McpServer satisfies it. */
export interface AcpMcpLink extends Pick<McpLink, "register" | "unregister" | "describeTool" | "takeDisplay"> {
  /** The server's address and token for an agent (read from the config file when missing). */
  configFor?(agentId: string): { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> } | null;
}

export interface AcpDriverDeps {
  agent: Agent;
  project: Project;
  preset: AcpPreset;
  /** The agent's program (findAcpProgram). */
  exe: string;
  /** The command line; defaults to the preset's arguments (plus its model arguments). */
  args?: string[];
  /** lu-minal's MCP server for the team tools; null runs the agent without them. */
  mcp: AcpMcpLink | null;
  /** The team prompt. ACP has no system prompt, so it goes in front of the first message. */
  systemPrompt: () => string;
  /** Starts the process (tests run a fake agent); defaults to spawnProgram. */
  spawnImpl?: (exe: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** The environment the process inherits (the preset's variables go on top); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long a cancelled prompt may take to settle before the process is killed (default 5 s). */
  cancelGraceMs?: number;
  /** How long initialize and session setup may take (default 120 s: a first start may install things). */
  setupTimeoutMs?: number;
  /** After this long without a word from the agent during a turn, a hint is logged (default 90 s; 0: never). */
  quietNoticeMs?: number;
  /**
   * How long a provider error the agent logged (preset.stderrError) waits before it is shown, so
   * an error the prompt answers with anyway isn't shown twice (default 3 s).
   */
  stderrErrorDelayMs?: number;
  /** lu-minal's version, for clientInfo. */
  version?: string;
}

const STDERR_LINES = 20;
/** Pictures up to this size go in as image blocks (Anthropic's per-image limit). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Text files up to this size go into the prompt itself. */
const MAX_INLINE_TEXT = 100 * 1024;

type Attachment = NonNullable<AgentInput["attachments"]>[number];

/** A message waiting for its prompt. */
interface Outgoing {
  text: string;
  attachments: Attachment[];
}
/** The start of lu-minal's answer to fs/* and terminal/* requests. */
const REFUSAL_MARK = "lu-minal does not offer";
const MCP_NAME = "luminal";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface ConfigOption {
  id: string;
  name: string;
  category: string | null;
  type: string;
  currentValue: unknown;
  values: string[];
}

interface Conn {
  child: ChildProcess;
  rpc: RpcPeer;
  exited: boolean;
  /** Ended on purpose: its exit is no error and its messages are ignored. */
  retired: boolean;
  exitPromise: Promise<void>;
  markExited: () => void;
  caps: { loadSession: boolean; resume: boolean; mcpHttp: boolean; image: boolean; embeddedContext: boolean };
  authMethods: AcpAuthMethod[];
  sessionId: string | null;
  /** session/load replays the conversation as updates; they are already in the log. */
  replaying: boolean;
  /** The team prompt went into this session already. */
  contextSent: boolean;
  modes: AcpMode[];
  currentMode: string | null;
  defaultMode: string | null;
  /** Modes come as a config option (OpenCode) rather than session modes. */
  modeOption: string | null;
  configOptions: ConfigOption[];
  /** The legacy (unstable) model state some agents answer session/new with. */
  legacyModels: { current: string | null; available: string[] } | null;
  /** The session's cumulative cost, as last reported. */
  lastCost: number;
  /** The MCP server was handed over. */
  mcpConnected: boolean;
}

interface ToolRow {
  entryId: string;
  kind: AcpToolKind | null;
  title: string;
  name: string;
  /** The tool's name for approvals and the log: its `name`, else the first title (OpenCode: "bash"). */
  toolName: string;
  rawInput: Obj;
  locations: unknown;
  status: "running" | "ok" | "error";
  diff: { lines: DiffLine[]; added: number; removed: number; isNew: boolean } | null;
  /** Its lines were counted (once, when it completed). */
  counted: boolean;
  /** The bare name of one of lu-minal's own tools, if it is one. */
  luminal: string | null;
}

interface Turn {
  cancelled: boolean;
  lastActivity: number;
  quietTimer: NodeJS.Timeout | null;
  noticed: boolean;
  /** Provider errors from stderr already shown (or waiting to be). */
  stderrErrors: Set<string>;
  stderrTimers: NodeJS.Timeout[];
}

// Children still running when lu-minal exits are ended with it.
const live = new Set<ChildProcess>();
let exitHooked = false;

function track(child: ChildProcess): void {
  live.add(child);
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const c of live) {
      try {
        if (!isWindows && c.pid) process.kill(-c.pid, "SIGTERM");
        else c.kill();
      } catch {
        try {
          c.kill();
        } catch {
          // already gone
        }
      }
    }
  });
}

function parseConfigOptions(v: unknown): ConfigOption[] {
  if (!Array.isArray(v)) return [];
  const out: ConfigOption[] = [];
  for (const o of v) {
    if (!isObj(o) || typeof o.id !== "string") continue;
    const values: string[] = [];
    const collect = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!isObj(item)) continue;
        if (typeof item.value === "string") values.push(item.value);
        else if (Array.isArray(item.options)) collect(item.options); // a group
      }
    };
    collect(o.options);
    out.push({
      id: o.id,
      name: str(o.name) || o.id,
      category: typeof o.category === "string" ? o.category : null,
      type: str(o.type),
      currentValue: o.currentValue,
      values,
    });
  }
  return out;
}

function parseModes(v: unknown): { current: string | null; modes: AcpMode[] } | null {
  if (!isObj(v) || !Array.isArray(v.availableModes)) return null;
  const modes = v.availableModes
    .filter((m): m is Obj => isObj(m) && typeof m.id === "string")
    .map((m) => ({ id: m.id as string, name: str(m.name) || (m.id as string) }));
  return { current: typeof v.currentModeId === "string" ? v.currentModeId : null, modes };
}

function parseLegacyModels(v: unknown): Conn["legacyModels"] {
  if (!isObj(v) || !Array.isArray(v.availableModels)) return null;
  const available = v.availableModels
    .map((m) => (isObj(m) ? str(m.modelId) || str(m.id) : ""))
    .filter(Boolean);
  return { current: typeof v.currentModelId === "string" ? v.currentModelId : null, available };
}

/** The text of a content block in a message chunk ("" for images and the like). */
function chunkText(content: unknown): string {
  if (!isObj(content)) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "resource_link" && typeof content.uri === "string") return content.uri;
  if (content.type === "resource" && isObj(content.resource) && typeof content.resource.text === "string") return content.resource.text;
  return "";
}

/** The team prompt as an ACP agent sees it: its own names for lu-minal's MCP tools. */
export function adaptPrompt(prompt: string, toolPrefix: string): string {
  return prompt.split(`mcp__${MCP_NAME}__`).join(toolPrefix);
}

/** The first message's preamble: the team prompt, marked as coming from lu-minal. */
export function contextBlock(prompt: string, preset: Pick<AcpPreset, "toolPrefix">, mcpConnected: boolean): string {
  const lines = [
    "<lu-minal-context>",
    "This comes from lu-minal, the app that runs you as a member of a team of coding agents (it is not a message from the user). Keep it in mind for the whole conversation.",
    "",
    adaptPrompt(prompt.trim(), preset.toolPrefix),
    "",
    mcpConnected
      ? `lu-minal's team tools come from its MCP server "${MCP_NAME}"${preset.toolPrefix ? ` (named ${preset.toolPrefix}<tool>, e.g. ${preset.toolPrefix}send_message)` : ""}. Use your own tools for files and commands.`
      : "lu-minal's team tools are not connected in this session: answer in your replies instead of calling them.",
    "</lu-minal-context>",
  ];
  return lines.join("\n");
}

export class AcpDriver implements AgentDriver {
  readonly kind = "acp" as const;

  private conn: Conn | null = null;
  private connecting: Promise<Conn> | null = null;
  private mcpRegistered = false;
  /** The config file register() wrote (read when the link has no configFor). */
  private mcpConfigFile: string | null = null;
  private ready = false;
  private disposed = false;
  /** Messages handed over before start() finished. */
  private waiting: Outgoing[] = [];
  /** Messages handed over while a prompt runs (sent as the next prompt). */
  private queue: Outgoing[] = [];
  private turn: Turn | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;
  private readonly rows = new Map<string, ToolRow>();
  private planEntryId: string | null = null;
  /** The message id of the open text and reasoning blocks (a new id starts a new block). */
  private messageIds: { text: string | null; reasoning: string | null } = { text: null, reasoning: null };
  private stderrTail: string[] = [];
  private warnedMcp = false;
  private warnedModel = false;
  private warnedMode = false;

  constructor(private readonly deps: AcpDriverDeps) {}

  private get agent(): Agent {
    return this.deps.agent;
  }

  private get name(): string {
    return this.deps.preset.name.replace(/\s*\(CLI\)$/, "");
  }

  /** The stderr lines kept for error reports (the last 20). */
  get stderr(): string[] {
    return [...this.stderrTail];
  }

  /** The running process's pid, if any. */
  get pid(): number | null {
    return this.conn && !this.conn.exited ? (this.conn.child.pid ?? null) : null;
  }

  /** The ACP session id of the running process, if any. */
  get sessionId(): string | null {
    return this.conn?.sessionId ?? null;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    this.agent.setStatus("starting");
    if (this.deps.mcp) {
      try {
        const reg = await this.deps.mcp.register(this.agent);
        this.mcpConfigFile = reg.configFile;
        this.mcpRegistered = true;
      } catch (err) {
        this.agent.info(
          `lu-minal's team tools are not available to ${this.name} (${err instanceof Error ? err.message : String(err)}). Permission prompts still reach you.`,
        );
      }
    }
    if (this.disposed) return;
    this.ready = true;
    this.agent.setStatus("idle");
    const waiting = this.waiting.splice(0);
    if (waiting.length) void this.runTurn(waiting);
  }

  send(input: AgentInput): void {
    if (this.disposed) return;
    const text = input.from === "you" ? input.text : `[message from ${input.from}] ${input.text}`;
    const message: Outgoing = { text, attachments: input.attachments ?? [] };
    this.agent.startTurn();
    if (!this.ready) {
      this.waiting.push(message);
      return;
    }
    if (this.turn) {
      this.queue.push(message);
      this.updateQueued();
      return;
    }
    void this.runTurn([message]);
  }

  interrupt(): void {
    this.waiting = [];
    this.queue = [];
    this.updateQueued();
    const turn = this.turn;
    if (!turn) {
      if (this.agent.turnStartedAt !== null) this.agent.endTurn("idle");
      return;
    }
    if (turn.cancelled) return;
    turn.cancelled = true;
    const conn = this.conn;
    if (conn && !conn.exited && conn.sessionId) conn.rpc.notify("session/cancel", { sessionId: conn.sessionId });
    // Until the prompt comes back, its permission requests are answered "cancelled".
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => {
      this.cancelTimer = null;
      if (this.turn !== turn) return;
      // A hard stall: the agent ignores the cancel. Kill it; the next message starts a new process.
      const c = this.conn;
      if (c) this.retire(c, new RpcClosedError(`${this.name} did not stop; it was ended.`));
      else this.finishTurn("idle");
    }, this.deps.cancelGraceMs ?? 5000);
    this.cancelTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.waiting = [];
    this.queue = [];
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    const conn = this.conn;
    if (conn) this.retire(conn, new RpcClosedError("The agent was stopped."));
    if (this.turn || this.agent.turnStartedAt !== null) {
      this.clearTurn();
      this.agent.queued = 0;
      this.agent.endTurn(this.agent.status === "stopped" ? "stopped" : "idle");
    }
    this.rows.clear();
    if (this.mcpRegistered) {
      try {
        this.deps.mcp?.unregister(this.agent.id);
      } catch {
        // nothing to clean up
      }
    }
    if (conn && !conn.exited) {
      await Promise.race([conn.exitPromise, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
    }
  }

  // ---- turns -----------------------------------------------------------------------------------

  private async runTurn(messages: Outgoing[]): Promise<void> {
    if (this.disposed) return;
    const turn: Turn = { cancelled: false, lastActivity: Date.now(), quietTimer: null, noticed: false, stderrErrors: new Set(), stderrTimers: [] };
    this.turn = turn;
    this.agent.startTurn();
    // Each prompt's answer is its own block, also when queued prompts follow each other in one turn.
    this.agent.closeStreams();
    this.messageIds = { text: null, reasoning: null };
    this.updateQueued();
    let status: "idle" | "error" = "idle";
    try {
      const conn = await this.ensureConnection();
      if (turn.cancelled || this.disposed) return;
      await this.syncMode(conn);
      if (turn.cancelled || this.disposed) return;
      const prompt: Obj[] = [];
      if (!conn.contextSent) {
        let system = "";
        try {
          system = this.deps.systemPrompt();
        } catch {
          system = "";
        }
        if (system.trim()) prompt.push({ type: "text", text: contextBlock(system, this.deps.preset, conn.mcpConnected) });
        conn.contextSent = true;
      }
      for (const m of messages) {
        prompt.push({ type: "text", text: m.text });
        prompt.push(...this.attachmentBlocks(conn, m.attachments));
      }
      this.armQuietTimer(turn);
      const result = await conn.rpc.request<unknown>("session/prompt", { sessionId: conn.sessionId, prompt });
      status = this.promptResult(result);
    } catch (err) {
      if (turn.cancelled || this.disposed) return;
      status = "error";
      this.agent.error(this.errorText(err));
    } finally {
      if (this.turn === turn) {
        this.stopTimers(turn);
        this.turn = null;
        if (this.cancelTimer) {
          clearTimeout(this.cancelTimer);
          this.cancelTimer = null;
        }
        const next = turn.cancelled || this.disposed ? [] : this.queue.splice(0);
        if (next.length) {
          void this.runTurn(next);
        } else if (!this.disposed) {
          this.finishTurn(status);
        }
      }
    }
  }

  /**
   * A message's pictures and files as ACP content: image blocks for agents that take images, text
   * files embedded (or inlined), anything else as a resource link the agent can open itself.
   */
  private attachmentBlocks(conn: Conn, attachments: Attachment[]): Obj[] {
    const out: Obj[] = [];
    for (const a of attachments) {
      let uri: string;
      try {
        uri = pathToFileURL(a.path).href;
      } catch {
        continue;
      }
      try {
        if (a.kind === "image" && conn.caps.image && a.size <= MAX_IMAGE_BYTES) {
          out.push({ type: "image", mimeType: a.mediaType, data: fs.readFileSync(a.path).toString("base64"), uri });
          continue;
        }
        if (a.kind === "text" && a.size <= MAX_INLINE_TEXT) {
          const text = fs.readFileSync(a.path, "utf8");
          out.push(
            conn.caps.embeddedContext
              ? { type: "resource", resource: { uri, mimeType: a.mediaType, text } }
              : { type: "text", text: `<file name="${a.name}" path="${a.path}">\n${text}\n</file>` },
          );
          continue;
        }
      } catch {
        // unreadable now: name it instead
      }
      out.push({ type: "resource_link", uri, name: a.name, mimeType: a.mediaType, size: a.size });
    }
    return out;
  }

  /** Usage and the stop reason of a finished prompt; a refusal ends the turn as an error. */
  private promptResult(result: unknown): "idle" | "error" {
    const r = isObj(result) ? result : {};
    const usage = isObj(r.usage) ? r.usage : null;
    if (usage) {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
      const input = n(usage.inputTokens) + n(usage.cachedReadTokens) + n(usage.cachedWriteTokens);
      const output = n(usage.outputTokens) + n(usage.thoughtTokens);
      if (input || output) this.agent.addUsage({ input, output });
    }
    const note = stopReasonNote(r.stopReason, this.name);
    if (!note) return "idle";
    if (note.level === "error") {
      this.agent.error(note.text);
      return "error";
    }
    this.agent.info(note.text);
    return "idle";
  }

  private finishTurn(status: "idle" | "error"): void {
    this.rows.clear();
    this.planEntryId = null;
    this.agent.queued = 0;
    this.agent.endTurn(status);
  }

  private clearTurn(): void {
    if (this.turn) this.stopTimers(this.turn);
    this.turn = null;
  }

  private stopTimers(turn: Turn): void {
    if (turn.quietTimer) clearTimeout(turn.quietTimer);
    turn.quietTimer = null;
    for (const t of turn.stderrTimers.splice(0)) clearTimeout(t);
  }

  /** A provider error the agent logged while it keeps the turn running (it is retrying). */
  private stderrLine(line: string): void {
    const turn = this.turn;
    const parse = this.deps.preset.stderrError;
    if (!turn || turn.cancelled || !parse) return;
    let text: string | null = null;
    try {
      text = parse(line);
    } catch {
      text = null;
    }
    if (!text || turn.stderrErrors.has(text)) return;
    turn.stderrErrors.add(text);
    const timer = setTimeout(() => {
      if (this.turn !== turn || turn.cancelled) return;
      turn.noticed = true; // no "quiet" hint on top of this
      this.agent.error(`${this.name}: ${text} (${this.name} keeps retrying; Esc stops the turn.)`);
    }, this.deps.stderrErrorDelayMs ?? 3000);
    timer.unref?.();
    turn.stderrTimers.push(timer);
  }

  private updateQueued(): void {
    this.agent.queued = this.queue.length;
    this.agent.changed();
  }

  /** Notes the agent is alive (and re-arms the "quiet" hint). */
  private touch(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.lastActivity = Date.now();
  }

  private armQuietTimer(turn: Turn): void {
    const ms = this.deps.quietNoticeMs ?? 90_000;
    if (!ms || ms <= 0) return;
    const check = () => {
      if (this.turn !== turn || turn.cancelled) return;
      const idle = Date.now() - turn.lastActivity;
      if (idle >= ms && !turn.noticed) {
        turn.noticed = true;
        const last = this.stderrTail[this.stderrTail.length - 1];
        this.agent.info(
          `${this.name} has sent nothing for ${Math.round(idle / 1000)} s; it may be waiting on its model provider (a rate limit or retries).${last ? ` Last log line: ${firstLine(last, 160)}` : ""} Esc stops the turn.`,
        );
        return;
      }
      turn.quietTimer = setTimeout(check, Math.max(1000, ms - idle));
      turn.quietTimer.unref?.();
    };
    turn.quietTimer = setTimeout(check, ms);
    turn.quietTimer.unref?.();
  }

  private errorText(err: unknown): string {
    if (err instanceof RpcError && err.code === RPC_CODES.authRequired) {
      return `${this.name} needs you to sign in: ${describeRpcError(err)}\n${this.deps.preset.signIn}`;
    }
    if (err instanceof RpcClosedError || err instanceof RpcTimeoutError) return err.message;
    const text = describeRpcError(err);
    if (/auth|api key|credential|not logged in|login|unauthori[sz]ed/i.test(text)) return `${this.name}: ${text}\n${this.deps.preset.signIn}`;
    return `${this.name}: ${text}`;
  }

  // ---- the process -----------------------------------------------------------------------------

  private async ensureConnection(): Promise<Conn> {
    const current = this.conn;
    if (current && !current.exited && !current.retired && current.sessionId) return current;
    if (this.connecting) return this.connecting;
    const pending = this.connect().finally(() => {
      if (this.connecting === pending) this.connecting = null;
    });
    this.connecting = pending;
    return pending;
  }

  private async connect(): Promise<Conn> {
    const conn = this.spawn();
    const timeoutMs = this.deps.setupTimeoutMs ?? 120_000;
    try {
      const init = await conn.rpc.request<unknown>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "lu-minal", title: "lu-minal", version: this.deps.version ?? process.env.LU_MINAL_VERSION ?? "dev" },
        },
        { timeoutMs },
      );
      this.readInit(conn, init);
      await this.openSession(conn, timeoutMs);
      await this.selectModel(conn);
      return conn;
    } catch (err) {
      if (!conn.retired) this.retire(conn, err instanceof Error ? err : new RpcClosedError(String(err)));
      throw err;
    }
  }

  private readInit(conn: Conn, init: unknown): void {
    const r = isObj(init) ? init : {};
    const caps = isObj(r.agentCapabilities) ? r.agentCapabilities : {};
    const mcp = isObj(caps.mcpCapabilities) ? caps.mcpCapabilities : {};
    const session = isObj(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
    const prompt = isObj(caps.promptCapabilities) ? caps.promptCapabilities : {};
    conn.caps = {
      loadSession: caps.loadSession === true,
      resume: isObj(session.resume),
      mcpHttp: mcp.http === true,
      image: prompt.image === true,
      embeddedContext: prompt.embeddedContext === true,
    };
    conn.authMethods = Array.isArray(r.authMethods)
      ? r.authMethods
          .filter((m): m is Obj => isObj(m) && typeof m.id === "string")
          .map((m) => ({ id: m.id as string, name: str(m.name) || (m.id as string), description: typeof m.description === "string" ? m.description : null }))
      : [];
    if (typeof r.protocolVersion === "number" && r.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.agent.info(`${this.name} speaks ACP version ${r.protocolVersion}; lu-minal speaks ${ACP_PROTOCOL_VERSION}. Some things may not work.`);
    }
  }

  /** lu-minal's MCP server as an ACP mcpServers entry (when the agent can reach it over HTTP). */
  private mcpServers(conn: Conn): Obj[] {
    conn.mcpConnected = false;
    if (!this.deps.mcp || !this.mcpRegistered) return [];
    if (!conn.caps.mcpHttp) {
      if (!this.warnedMcp) {
        this.warnedMcp = true;
        this.agent.info(`${this.name} can't use lu-minal's team tools: it doesn't connect to MCP servers over HTTP. Permission prompts still reach you.`);
      }
      return [];
    }
    const server = this.mcpAddress();
    if (!server) return [];
    conn.mcpConnected = true;
    return [
      {
        type: "http",
        name: MCP_NAME,
        url: server.url,
        headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
      },
    ];
  }

  private mcpAddress(): { url: string; headers: Record<string, string> } | null {
    const mcp = this.deps.mcp;
    if (!mcp) return null;
    let config: unknown = null;
    try {
      config = mcp.configFor?.(this.agent.id) ?? null;
    } catch {
      config = null;
    }
    const pick = (c: unknown) => {
      const servers = isObj(c) && isObj(c.mcpServers) ? c.mcpServers : null;
      const s = servers && isObj(servers[MCP_NAME]) ? (servers[MCP_NAME] as Obj) : null;
      if (!s || typeof s.url !== "string" || !s.url) return null;
      const headers: Record<string, string> = {};
      if (isObj(s.headers)) for (const [k, v] of Object.entries(s.headers)) if (typeof v === "string") headers[k] = v;
      return { url: s.url, headers };
    };
    return pick(config) ?? pick(this.readMcpConfigFile());
  }

  /** The config file register() wrote (what `claude --mcp-config` reads); the port may have changed. */
  private readMcpConfigFile(): unknown {
    if (!this.mcpConfigFile) return null;
    try {
      return JSON.parse(fs.readFileSync(this.mcpConfigFile, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  private async openSession(conn: Conn, timeoutMs: number): Promise<void> {
    const cwd = this.deps.project.cwd;
    const mcpServers = this.mcpServers(conn);
    const previous = this.agent.sessionId;
    if (previous && (conn.caps.resume || conn.caps.loadSession)) {
      try {
        let result: unknown;
        if (conn.caps.resume) {
          result = await conn.rpc.request("session/resume", { sessionId: previous, cwd, mcpServers }, { timeoutMs });
        } else {
          conn.replaying = true;
          conn.sessionId = previous;
          try {
            result = await conn.rpc.request("session/load", { sessionId: previous, cwd, mcpServers }, { timeoutMs });
          } finally {
            conn.replaying = false;
          }
        }
        conn.sessionId = previous;
        conn.contextSent = true;
        this.readSessionState(conn, result);
        return;
      } catch (err) {
        if (conn.exited || err instanceof RpcClosedError || err instanceof RpcTimeoutError) throw err;
        conn.sessionId = null;
        this.agent.info(`The earlier ${this.name} conversation could not be resumed (${describeRpcError(err)}); starting a new one.`);
      }
    } else if (previous) {
      this.agent.info(`${this.name} can't resume conversations; starting a new one.`);
    }
    let result: unknown;
    try {
      result = await conn.rpc.request("session/new", { cwd, mcpServers }, { timeoutMs });
    } catch (err) {
      if (!(err instanceof RpcError) || err.code !== RPC_CODES.authRequired) throw err;
      // Sign in without asking where the agent can (an API key in the environment), then retry.
      const methodId = this.deps.preset.autoAuth?.(conn.authMethods, this.processEnv()) ?? null;
      if (!methodId) throw err;
      await conn.rpc.request("authenticate", { methodId }, { timeoutMs });
      result = await conn.rpc.request("session/new", { cwd, mcpServers }, { timeoutMs });
    }
    const r = isObj(result) ? result : {};
    if (typeof r.sessionId !== "string" || !r.sessionId) throw new Error(`${this.name} started no session.`);
    conn.sessionId = r.sessionId;
    conn.contextSent = false;
    conn.lastCost = 0;
    this.agent.sessionId = r.sessionId;
    this.readSessionState(conn, r);
  }

  private readSessionState(conn: Conn, result: unknown): void {
    const r = isObj(result) ? result : {};
    const modes = parseModes(r.modes);
    if (modes) {
      conn.modes = modes.modes;
      conn.currentMode = modes.current;
      conn.modeOption = null;
    }
    if (Array.isArray(r.configOptions)) this.setConfigOptions(conn, r.configOptions);
    const legacy = parseLegacyModels(r.models);
    if (legacy) conn.legacyModels = legacy;
    // The mode lu-minal returns to outside plan mode: the session's own, unless a resumed session
    // is still in a plan mode from earlier.
    const current = conn.currentMode;
    const planLike = (id: string) => /plan|read.?only/i.test(id);
    conn.defaultMode =
      current && !planLike(current)
        ? current
        : (conn.modes.find((m) => /^(default|build|code|agent)$/i.test(m.id))?.id ?? conn.modes.find((m) => !planLike(m.id))?.id ?? current);
  }

  private setConfigOptions(conn: Conn, raw: unknown): void {
    conn.configOptions = parseConfigOptions(raw);
    const mode = conn.configOptions.find((o) => o.category === "mode" && o.type === "select");
    if (mode && !conn.modes.length) {
      conn.modeOption = mode.id;
      conn.modes = mode.values.map((v) => ({ id: v, name: v }));
      conn.currentMode = typeof mode.currentValue === "string" ? mode.currentValue : null;
    } else if (mode && conn.modeOption === mode.id) {
      conn.currentMode = typeof mode.currentValue === "string" ? mode.currentValue : conn.currentMode;
    }
  }

  /** Picks agent.model.model in the session: a "model" config option, the legacy set_model, or the command line. */
  private async selectModel(conn: Conn): Promise<void> {
    const want = this.agent.model.model.trim();
    if (!want || want === ACP_DEFAULT_MODEL || !conn.sessionId) return;
    const option = conn.configOptions.find((o) => (o.category === "model" || o.id === "model") && o.type === "select");
    if (option) {
      if (option.currentValue === want) return;
      try {
        const res = await conn.rpc.request<unknown>("session/set_config_option", { sessionId: conn.sessionId, configId: option.id, value: want });
        if (isObj(res) && Array.isArray(res.configOptions)) this.setConfigOptions(conn, res.configOptions);
        else option.currentValue = want;
      } catch (err) {
        if (conn.exited) throw err;
        const current = typeof option.currentValue === "string" ? option.currentValue : "its default";
        const known = option.values.includes(want) ? "" : ` (${this.name} doesn't list it)`;
        this.agent.info(`${this.name} couldn't switch to ${want}${known}: ${describeRpcError(err)}. It runs on ${current}.`);
      }
      return;
    }
    if (conn.legacyModels) {
      if (conn.legacyModels.current === want) return;
      try {
        await conn.rpc.request("session/set_model", { sessionId: conn.sessionId, modelId: want });
        conn.legacyModels.current = want;
      } catch (err) {
        if (conn.exited) throw err;
        this.agent.info(`${this.name} couldn't switch to ${want}: ${describeRpcError(err)}.`);
      }
      return;
    }
    if (this.deps.preset.modelArgs) return; // chosen on the command line
    if (!this.warnedModel) {
      this.warnedModel = true;
      this.agent.info(`${this.name} can't be told which model to use; it runs on its own default.`);
    }
  }

  /** Puts the session in the mode lu-minal's permission mode calls for (plan → a read-only mode). */
  private async syncMode(conn: Conn): Promise<void> {
    if (!conn.sessionId || !conn.modes.length) return;
    const desired = modeFor(this.agent.permissionMode, conn.modes, conn.defaultMode);
    if (!desired || desired === conn.currentMode) return;
    try {
      if (conn.modeOption) {
        const res = await conn.rpc.request<unknown>("session/set_config_option", { sessionId: conn.sessionId, configId: conn.modeOption, value: desired });
        if (isObj(res) && Array.isArray(res.configOptions)) this.setConfigOptions(conn, res.configOptions);
      } else {
        await conn.rpc.request("session/set_mode", { sessionId: conn.sessionId, modeId: desired });
      }
      conn.currentMode = desired;
    } catch (err) {
      if (conn.exited) throw err;
      if (!this.warnedMode) {
        this.warnedMode = true;
        this.agent.info(`${this.name} didn't switch to its "${desired}" mode: ${describeRpcError(err)}.`);
      }
    }
  }

  private processEnv(): NodeJS.ProcessEnv {
    return acpEnv(this.deps.preset, this.deps.env ?? process.env);
  }

  private spawn(): Conn {
    const { project, preset, exe } = this.deps;
    const args = this.deps.args ?? acpCommandArgs(preset, this.agent.model.model);
    const options: SpawnOptions = {
      cwd: project.cwd,
      env: this.processEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so killTree ends the agent's shells too (taskkill /T on Windows).
      detached: !isWindows,
      windowsHide: true,
    };
    const child = (this.deps.spawnImpl ?? spawnProgram)(exe, args, options);
    let markExited = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const rpc = new RpcPeer({
      input: child.stdout!,
      output: child.stdin!,
      // The exit handler closes it, with the exit code and stderr as the reason.
      closeOnEnd: false,
      onRequest: (method, params, signal) => this.onRequest(conn, method, params, signal),
      onNotification: (method, params) => this.onNotification(conn, method, params),
      onStray: (line) => {
        if (this.conn === conn) this.pushStderr(line);
      },
    });
    const conn: Conn = {
      child,
      rpc,
      exited: false,
      retired: false,
      exitPromise,
      markExited,
      caps: { loadSession: false, resume: false, mcpHttp: false, image: false, embeddedContext: false },
      authMethods: [],
      sessionId: null,
      replaying: false,
      contextSent: false,
      modes: [],
      currentMode: null,
      defaultMode: null,
      modeOption: null,
      configOptions: [],
      legacyModels: null,
      lastCost: 0,
      mcpConnected: false,
    };
    this.conn = conn;
    this.stderrTail = [];
    track(child);

    let errBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // OpenCode asks fs/write_text_file after every approved edit even though lu-minal doesn't
      // advertise it, and prints the refusal with a stack trace: that is no news.
      if (chunk.includes(REFUSAL_MARK)) return;
      errBuffer += chunk;
      let nl: number;
      while ((nl = errBuffer.indexOf("\n")) >= 0) {
        const line = errBuffer.slice(0, nl).replace(/\r$/, "");
        errBuffer = errBuffer.slice(nl + 1);
        if (this.conn === conn) this.pushStderr(line);
      }
    });
    child.stdin?.on("error", () => undefined);
    // An agent that closes its stdout but keeps running is of no use: end it.
    child.stdout?.on("end", () => {
      setTimeout(() => {
        if (!conn.exited) killTree(conn.child);
      }, 2000).unref?.();
    });
    child.on("error", (err) => this.onExit(conn, null, null, err));
    child.on("close", (code, signal) => {
      if (errBuffer && this.conn === conn) this.pushStderr(errBuffer);
      errBuffer = "";
      this.onExit(conn, code, signal);
    });
    return conn;
  }

  /** Ends a process on purpose (a stall, dispose, a failed start). */
  private retire(conn: Conn, reason: Error): void {
    conn.retired = true;
    if (this.conn === conn) this.conn = null;
    conn.rpc.close(reason);
    try {
      conn.child.stdin?.end();
    } catch {
      // already closed
    }
    if (!conn.exited) killTree(conn.child);
  }

  private onExit(conn: Conn, code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
    if (conn.exited) return;
    conn.exited = true;
    conn.markExited();
    live.delete(conn.child);
    if (this.conn === conn) this.conn = null;
    const tail = this.stderrTail.join("\n").trim();
    const how = err ? err.message : signal ? `signal ${signal}` : `exit code ${code}`;
    const started = conn.sessionId !== null;
    const head = err && !started ? `Could not start ${this.name} (${how}).` : `${this.name} stopped unexpectedly (${how}).`;
    let message = tail ? `${head}\n${tail}` : head;
    if (/auth|log ?in|credential|api key/i.test(tail)) message += `\n${this.deps.preset.signIn}`;
    // Requests still waiting fail with this text (the turn shows it).
    conn.rpc.close(new RpcClosedError(message));
    if (conn.retired || this.disposed) return;
    const failed = Boolean(err) || signal !== null || (code !== null && code !== 0);
    if (this.turn || this.connecting) return; // the turn reports it
    if (!failed) return;
    this.agent.error(message);
    this.agent.setStatus("error");
  }

  private pushStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrLine(line);
    this.stderrTail.push(line.length > 500 ? `${line.slice(0, 499)}…` : line);
    if (this.stderrTail.length > STDERR_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_LINES);
  }

  // ---- what the agent sends ----------------------------------------------------------------------

  private async onRequest(conn: Conn, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (conn !== this.conn || conn.retired || this.disposed) {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
      throw new RpcError(RPC_CODES.internal, "This agent was stopped.");
    }
    this.touch();
    if (method === "session/request_permission") return this.permission(conn, isObj(params) ? params : {}, signal);
    if (method.startsWith("fs/") || method.startsWith("terminal/")) {
      throw new RpcError(RPC_CODES.methodNotFound, `${REFUSAL_MARK} ${method} (the capability is not advertised); use your own tools.`);
    }
    throw new RpcError(RPC_CODES.methodNotFound, `Method not found: ${method}`);
  }

  private onNotification(conn: Conn, method: string, params: unknown): void {
    if (conn !== this.conn || conn.retired || this.disposed) return;
    if (method !== "session/update" || !isObj(params)) return; // extension notifications ("_...") are ignored
    if (conn.sessionId && typeof params.sessionId === "string" && params.sessionId !== conn.sessionId) return;
    const update = isObj(params.update) ? params.update : null;
    if (!update) return;
    this.touch();
    this.onUpdate(conn, update);
  }

  private onUpdate(conn: Conn, u: Obj): void {
    const agent = this.agent;
    const kind = str(u.sessionUpdate);
    // A loaded session replays its history: the log already has it.
    if (conn.replaying && kind !== "current_mode_update" && kind !== "config_option_update" && kind !== "usage_update") return;
    switch (kind) {
      case "agent_message_chunk": {
        const text = chunkText(u.content);
        if (!text) return;
        agent.endStream("reasoning");
        this.newMessage("text", u.messageId);
        agent.appendStream("text", text);
        return;
      }
      case "agent_thought_chunk": {
        const text = chunkText(u.content);
        if (!text) return;
        this.newMessage("reasoning", u.messageId);
        agent.appendStream("reasoning", text);
        return;
      }
      case "user_message_chunk":
        return;
      case "tool_call":
        agent.closeStreams();
        this.toolCall(u);
        return;
      case "tool_call_update":
        this.toolCall(u);
        return;
      case "plan":
        this.plan(u.entries);
        return;
      case "current_mode_update":
        if (typeof u.currentModeId === "string") conn.currentMode = u.currentModeId;
        return;
      case "config_option_update":
        if (Array.isArray(u.configOptions)) this.setConfigOptions(conn, u.configOptions);
        return;
      case "usage_update":
        this.usageUpdate(conn, u);
        return;
      case "notice": {
        const title = str(u.title).trim();
        if (!title) return;
        if (u.severity === "error") agent.error(`${this.name}: ${title}`);
        else agent.info(`${this.name}: ${title}`);
        return;
      }
      case "compaction_update": {
        if (u.status === "in_progress") agent.setActivity("Compacting");
        else if (agent.activity === "Compacting" && agent.turnStartedAt !== null) agent.setActivity(workVerb(agent.turnStartedAt));
        if (u.status === "failed" && typeof u.error === "string" && u.error) agent.info(`${this.name} could not compact the conversation: ${u.error}`);
        return;
      }
      default:
        // available_commands_update, session_info_update, compaction_summary_chunk, future kinds.
        return;
    }
  }

  /** A chunk with another message id than the open block's starts a new block. */
  private newMessage(kind: "text" | "reasoning", messageId: unknown): void {
    if (typeof messageId !== "string" || !messageId) return;
    const open = this.messageIds[kind];
    if (open && open !== messageId) this.agent.endStream(kind);
    this.messageIds[kind] = messageId;
  }

  private usageUpdate(conn: Conn, u: Obj): void {
    const used = typeof u.used === "number" && Number.isFinite(u.used) ? u.used : null;
    const size = typeof u.size === "number" && Number.isFinite(u.size) && u.size > 0 ? u.size : null;
    if (size !== null) this.agent.contextWindow = size;
    const cost = isObj(u.cost) ? u.cost : null;
    let costUsd = 0;
    if (cost && typeof cost.amount === "number" && Number.isFinite(cost.amount) && (cost.currency === "USD" || cost.currency === undefined)) {
      // The session's running total: count what was added since the last report.
      costUsd = cost.amount >= conn.lastCost ? cost.amount - conn.lastCost : cost.amount;
      conn.lastCost = cost.amount;
    }
    this.agent.addUsage({ ...(used !== null ? { context: used } : {}), costUsd });
  }

  private plan(raw: unknown): void {
    const text = planSummary(planEntries(raw));
    if (this.planEntryId && this.agent.log.some((e) => e.id === this.planEntryId)) {
      this.agent.update(this.planEntryId, { text } as Partial<LogEntry>);
      return;
    }
    this.planEntryId = this.agent.append({ kind: "info", text }).id;
  }

  // ---- tool rows -------------------------------------------------------------------------------

  /**
   * The bare name of one of lu-minal's own tools behind a call: "luminal_send_message" (OpenCode),
   * "send_message (luminal MCP Server)" (Gemini CLI's title), or a bare name the MCP server knows.
   */
  private luminalName(title: string, name: string): string | null {
    const prefix = this.deps.preset.toolPrefix;
    const server = new RegExp(`^(\\S+) \\(${MCP_NAME} MCP Server\\)`, "i").exec(title.trim());
    if (server) return server[1];
    const candidates = [name, title.trim().split(/\s+/)[0] ?? ""].filter(Boolean);
    for (const candidate of candidates) {
      for (const p of [`mcp__${MCP_NAME}__`, `${MCP_NAME}__`, `${MCP_NAME}_`, prefix].filter(Boolean)) {
        if (candidate.startsWith(p) && candidate.length > p.length) return candidate.slice(p.length);
      }
    }
    // Agents that use the bare names: ask the MCP server whether it is one of its tools.
    if (!prefix && this.deps.mcp?.describeTool && this.conn?.mcpConnected) {
      for (const candidate of candidates) {
        try {
          if (/^[a-z][a-z0-9_]*$/.test(candidate) && this.deps.mcp.describeTool(this.agent.id, candidate, {})) return candidate;
        } catch {
          // not one of ours
        }
      }
    }
    return null;
  }

  /** Creates or updates the row of a tool call (from tool_call, tool_call_update or a permission request). */
  private toolCall(u: Obj): ToolRow | null {
    const id = str(u.toolCallId);
    if (!id) return null;
    const cwd = this.deps.project.cwd;
    let row = this.rows.get(id);
    const kind = toolKind(u.kind);
    if (!row) {
      // An update for a call we never saw (or a new call): start a row.
      row = {
        entryId: "",
        kind,
        title: str(u.title),
        name: str(u.name),
        toolName: str(u.name) || str(u.title) || kind || "tool",
        rawInput: isObj(u.rawInput) ? u.rawInput : {},
        locations: u.locations,
        status: "running",
        diff: null,
        counted: false,
        luminal: null,
      };
      this.rows.set(id, row);
    } else {
      if (kind) row.kind = kind;
      if (typeof u.title === "string" && u.title) row.title = u.title;
      if (typeof u.name === "string" && u.name) row.name = row.toolName = u.name;
      if (isObj(u.rawInput) && Object.keys(u.rawInput).length) row.rawInput = u.rawInput;
      if (Array.isArray(u.locations)) row.locations = u.locations;
    }
    row.luminal = this.luminalName(row.title, row.name);
    const items = diffItems(u.content);
    if (items.length) row.diff = diffDisplay(items, cwd);
    const status = u.status !== undefined && u.status !== null ? rowStatus(u.status) : row.status;

    let described: { verb: string; target?: string } | null = null;
    if (row.luminal) {
      try {
        described = this.deps.mcp?.describeTool?.(this.agent.id, row.luminal, row.rawInput) ?? null;
      } catch {
        described = null;
      }
    }
    described ??= describeAcpTool({ kind: row.kind, title: row.title, name: row.name, rawInput: row.rawInput, locations: row.locations }, cwd, row.diff?.isNew ?? false);

    const patch: Record<string, unknown> = { verb: described.verb, target: described.target };
    if (row.diff) {
      patch.diff = row.diff.lines;
      patch.added = row.diff.added;
      patch.removed = row.diff.removed;
    }
    if (status !== "running") {
      const text = contentText(u.content);
      let display: ToolDisplay | null = null;
      if (row.luminal && status === "ok") {
        try {
          display =
            this.deps.mcp?.takeDisplay?.(this.agent.id, { toolUseId: id, name: row.luminal, input: row.rawInput })?.display ?? null;
        } catch {
          display = null;
        }
      }
      if (display) {
        for (const key of ["verb", "target", "detail", "diff", "added", "removed"] as const) {
          if (display[key] !== undefined) patch[key] = display[key];
        }
      }
      if (patch.detail === undefined) patch.detail = resultDetail(row.kind, status, text, u.rawOutput, row.diff && status === "ok" ? row.diff : null);
      // Lines count once, when an edit went through (runToolCall counts lu-minal's own tools).
      if (status === "ok" && row.diff && !row.counted && !row.luminal) {
        row.counted = true;
        if (row.diff.added || row.diff.removed) this.agent.addLines(row.diff.added, row.diff.removed);
      }
    }
    patch.status = status;
    row.status = status;
    if (!row.entryId) {
      const entry = this.agent.append({
        kind: "tool",
        toolCallId: id,
        name: row.toolName,
        verb: described.verb,
        target: described.target,
        status: "running",
      });
      row.entryId = entry.id;
    }
    this.agent.update(row.entryId, patch as Partial<LogEntry>);
    return row;
  }

  // ---- permissions -----------------------------------------------------------------------------

  private async permission(conn: Conn, params: Obj, signal: AbortSignal): Promise<unknown> {
    const cancelled = { outcome: { outcome: "cancelled" } };
    const options = permissionOptions(params.options);
    const turn = this.turn;
    if (!turn || turn.cancelled) return cancelled;
    const call = isObj(params.toolCall) ? params.toolCall : {};
    // The request may carry the call (or a newer view of it, with the diff): show it on its row.
    const row = this.toolCall(call);
    const kind = row?.kind ?? toolKind(call.kind);
    const cwd = this.deps.project.cwd;
    if (row?.luminal) {
      // lu-minal's own tools decide their approvals themselves (runToolCall in the MCP server).
      const optionId = pickPermissionOption(options, "allow");
      return optionId ? { outcome: { outcome: "selected", optionId } } : cancelled;
    }
    const view = {
      kind,
      title: row?.title ?? str(call.title),
      name: row?.name ?? str(call.name),
      rawInput: row?.rawInput ?? (isObj(call.rawInput) ? call.rawInput : {}),
      locations: row?.locations ?? call.locations,
    };
    const described = describeAcpTool(view, cwd, row?.diff?.isNew ?? false);
    const summary = [described.verb, described.target].filter(Boolean).join(" ");
    const detailParts: string[] = [];
    if (row?.diff) {
      detailParts.push(
        row.diff.lines
          .map((l) => (l.kind === "add" ? `+ ${l.text}` : l.kind === "del" ? `- ${l.text}` : l.kind === "gap" ? l.text : `  ${l.text}`))
          .slice(0, 60)
          .join("\n"),
      );
    } else {
      const command = str(view.rawInput.command);
      if (command) detailParts.push(command);
      else if (view.title && view.title !== summary) detailParts.push(view.title);
    }
    const risk = riskFor(kind);
    const allowKey =
      kind === "execute"
        ? `${this.deps.preset.id}:run:${str(view.rawInput.command) || view.title}`
        : kind === "edit" || kind === "delete" || kind === "move"
          ? `${this.deps.preset.id}:edit`
          : `${this.deps.preset.id}:${kind ?? "other"}:${view.name || view.title}`;

    const agent = this.agent;
    const before = new Set(agent.approvals);
    const pending = agent.requestApproval({
      tool: row?.toolName || view.name || kind || "tool",
      risk,
      summary,
      detail: detailParts.join("\n") || undefined,
      allowKey,
    });
    // The request it queued (none when the mode or the "always" list decided at once).
    const mine = agent.approvals.find((a) => !before.has(a));
    const onAbort = () => {
      if (!mine) return;
      const i = agent.approvals.indexOf(mine);
      if (i < 0) return;
      agent.approvals.splice(i, 1);
      mine.resolve("deny");
      agent.changed();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let decision: ApprovalDecision;
    try {
      decision = await pending;
    } catch {
      decision = "deny";
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted || turn.cancelled || conn.retired || conn.exited) return cancelled;
    const optionId = pickPermissionOption(options, decision);
    if (!optionId) return cancelled;
    return { outcome: { outcome: "selected", optionId } };
  }
}
