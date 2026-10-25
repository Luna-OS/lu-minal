// One agent's state: who it is, what it runs on, what it is doing and everything it did (the log
// its panel draws). Drivers (src/agents/) write into it; the UI only reads it.
import type { ModelRef } from "../providers/models.js";
import { formatModelRef } from "../providers/models.js";
import { newId, type Notifier } from "./emitter.js";
import { verdictFor } from "./permissions.js";
import type {
  AgentRole,
  AgentSpec,
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  LogEntry,
  PermissionMode,
} from "./types.js";
import { workVerb } from "./verbs.js";

/** A message for an agent: from the user ("you") or a teammate (their name). */
export interface AgentInput {
  from: string;
  text: string;
}

/** What runs an agent: the native loop for API models or the Claude Code CLI. */
export interface AgentDriver {
  readonly kind: "native" | "claude-code";
  /** Starts the driver (spawns the CLI, resolves the model). */
  start(): Promise<void>;
  /** Hands the agent a message. Starts a turn when idle; otherwise it is read at the next step. */
  send(input: AgentInput): void;
  /** Stops the running turn (the agent becomes idle and keeps its conversation). */
  interrupt(): void;
  /** Ends the agent for good. */
  dispose(): Promise<void>;
  /**
   * The conversation as JSON-safe data, saved with the session so a restart continues it (native
   * agents; Claude Code keeps its own sessions and resumes by id).
   */
  snapshot?(): unknown;
  /** Puts a saved conversation back before the first turn. */
  restore?(state: unknown): void;
}

/** What the session file keeps of an agent. */
export interface SavedAgentState {
  log: LogEntry[];
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  costUsd: number;
  linesAdded: number;
  linesRemoved: number;
  busyMs: number;
  allowed: string[];
  createdAt: number;
}

const SAVED_LOG = 400;

const MAX_LOG = 1500;

type LogInput = LogEntry extends infer E ? (E extends LogEntry ? Omit<E, "id" | "at"> : never) : never;

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

export class Agent {
  readonly id: string;
  createdAt = Date.now();
  name: string;
  role: AgentRole;
  label: string | null;
  model: ModelRef;
  spawnedBy: string;
  instructions: string | null;

  status: AgentStatus = "starting";
  /** The status verb of the running turn ("Charting"), null when idle. */
  activity: string | null = null;
  turnStartedAt: number | null = null;
  /** Total time spent working, ms (finished turns only). */
  busyMs = 0;
  lastError: string | null = null;

  log: LogEntry[] = [];
  /** Tokens read (input + cache) and written over the agent's life. */
  tokensIn = 0;
  tokensOut = 0;
  /** Tokens the conversation takes up right now (the context window's fill). */
  contextTokens = 0;
  /** The model's context window when the driver knows it (Claude Code reports where it compacts). */
  contextWindow: number | null = null;
  costUsd = 0;
  linesAdded = 0;
  linesRemoved = 0;

  permissionMode: PermissionMode;
  /** allowKeys the user said "always" to. */
  readonly allowed = new Set<string>();
  readonly approvals: PendingApproval[] = [];

  /** Messages waiting for the next step (shown as a count in the panel). */
  queued = 0;
  /** Claude Code's session id, to resume after a restart. */
  sessionId: string | null = null;

  driver: AgentDriver | null = null;

  /** Told about every usage report and every diff (the Hub keeps statistics with them). */
  onUsage: ((u: { input: number; output: number; costUsd: number }) => void) | null = null;
  onLines: ((added: number, removed: number) => void) | null = null;

  constructor(
    spec: AgentSpec,
    private readonly notifier: Notifier,
    defaultMode: PermissionMode,
  ) {
    this.id = newId("agent");
    this.name = spec.name;
    this.role = spec.role;
    this.label = spec.label?.trim() || null;
    this.model = spec.model;
    this.spawnedBy = spec.spawnedBy ?? "you";
    this.instructions = spec.instructions?.trim() || null;
    this.permissionMode = spec.permissionMode ?? defaultMode;
  }

  get modelLabel(): string {
    return formatModelRef(this.model);
  }

  get busy(): boolean {
    return this.status === "working" || this.status === "waiting";
  }

  changed(): void {
    this.notifier.changed();
  }

  // ---- the log -------------------------------------------------------------------------------

  append(entry: LogInput): LogEntry {
    const full = { ...entry, id: newId("log"), at: Date.now() } as LogEntry;
    this.log.push(full);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.changed();
    return full;
  }

  update(id: string, patch: Partial<LogEntry>): void {
    const entry = this.log.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.changed();
  }

  /** Adds streamed text to the open text block (or starts one). */
  appendStream(kind: "text" | "reasoning", delta: string): void {
    if (!delta) return;
    const last = this.log[this.log.length - 1];
    if (last && last.kind === kind && last.streaming) {
      last.text += delta;
      this.changed();
      return;
    }
    this.append({ kind, text: delta, streaming: true });
  }

  /** Closes the open text block; `text` replaces its content when given (the final text). */
  endStream(kind: "text" | "reasoning", text?: string): void {
    const last = this.log[this.log.length - 1];
    if (last && last.kind === kind && last.streaming) {
      last.streaming = false;
      if (text !== undefined) last.text = text;
      this.changed();
    } else if (text) {
      this.append({ kind, text });
    }
  }

  /** Closes every open stream block (end of a turn, an interrupt). */
  closeStreams(): void {
    let touched = false;
    for (const e of this.log) {
      if ((e.kind === "text" || e.kind === "reasoning") && e.streaming) {
        e.streaming = false;
        touched = true;
      }
    }
    if (touched) this.changed();
  }

  info(text: string): void {
    this.append({ kind: "info", text });
  }

  error(text: string): void {
    this.lastError = text;
    this.append({ kind: "error", text });
  }

  clearLog(): void {
    this.log = [];
    this.changed();
  }

  // ---- status ----------------------------------------------------------------------------------

  setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.changed();
  }

  startTurn(): void {
    if (this.turnStartedAt === null) {
      this.turnStartedAt = Date.now();
      this.activity = workVerb(this.turnStartedAt);
    }
    this.lastError = null;
    this.status = "working";
    this.changed();
  }

  endTurn(status: AgentStatus = "idle"): void {
    if (this.turnStartedAt !== null) this.busyMs += Date.now() - this.turnStartedAt;
    this.turnStartedAt = null;
    this.activity = null;
    this.closeStreams();
    // Tool calls still "running" at the end of a turn were cut off.
    for (const e of this.log) if (e.kind === "tool" && e.status === "running") e.status = "error";
    this.status = this.approvals.length ? "waiting" : status;
    this.changed();
  }

  setActivity(activity: string | null): void {
    this.activity = activity;
    this.changed();
  }

  addUsage(u: { input?: number; output?: number; context?: number; costUsd?: number }): void {
    if (u.input) this.tokensIn += u.input;
    if (u.output) this.tokensOut += u.output;
    if (u.context !== undefined) this.contextTokens = u.context;
    if (u.costUsd) this.costUsd += u.costUsd;
    if (u.input || u.output || u.costUsd) {
      this.onUsage?.({ input: u.input ?? 0, output: u.output ?? 0, costUsd: u.costUsd ?? 0 });
    }
    this.changed();
  }

  addLines(added: number, removed: number): void {
    this.linesAdded += added;
    this.linesRemoved += removed;
    this.onLines?.(added, removed);
    this.changed();
  }

  // ---- saving and restoring --------------------------------------------------------------------

  saveState(): SavedAgentState {
    return {
      // Approvals that were still open can't be answered after a restart.
      log: this.log.slice(-SAVED_LOG).map((e): LogEntry => {
        if (e.kind === "approval" && !e.decision) return { ...e, decision: "deny" };
        if ((e.kind === "text" || e.kind === "reasoning") && e.streaming) return { ...e, streaming: false };
        return e;
      }),
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      contextTokens: this.contextTokens,
      costUsd: this.costUsd,
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      busyMs: this.busyMs + (this.turnStartedAt !== null ? Date.now() - this.turnStartedAt : 0),
      allowed: [...this.allowed],
      createdAt: this.createdAt,
    };
  }

  restoreState(saved: Partial<SavedAgentState>): void {
    if (Array.isArray(saved.log)) {
      this.log = saved.log.map((e) => (e.kind === "tool" && e.status === "running" ? { ...e, status: "error" as const } : e));
    }
    this.tokensIn = saved.tokensIn ?? 0;
    this.tokensOut = saved.tokensOut ?? 0;
    this.contextTokens = saved.contextTokens ?? 0;
    this.costUsd = saved.costUsd ?? 0;
    this.linesAdded = saved.linesAdded ?? 0;
    this.linesRemoved = saved.linesRemoved ?? 0;
    this.busyMs = saved.busyMs ?? 0;
    for (const key of saved.allowed ?? []) this.allowed.add(key);
    if (saved.createdAt) this.createdAt = saved.createdAt;
    this.changed();
  }

  // ---- messages ------------------------------------------------------------------------------

  /** Hands the agent a message (from the user or a teammate) and logs it. */
  deliver(input: AgentInput): void {
    this.append({ kind: "user", from: input.from, text: input.text });
    if (!this.driver) {
      this.error("This agent is not running.");
      return;
    }
    this.driver.send(input);
  }

  interrupt(): void {
    this.driver?.interrupt();
    for (const a of this.approvals.splice(0)) a.resolve("deny");
    this.changed();
  }

  // ---- approvals -------------------------------------------------------------------------------

  /**
   * Decides whether an action may run: by the permission mode, the "always" list, or by asking the
   * user (the panel shows the request until they answer).
   */
  async requestApproval(request: Omit<ApprovalRequest, "id" | "agentId">): Promise<ApprovalDecision> {
    const verdict = verdictFor(this.permissionMode, request.risk);
    if (verdict === "allow" || this.allowed.has(request.allowKey)) return "allow";
    if (verdict === "deny") return "deny";
    const full: ApprovalRequest = { ...request, id: newId("ask"), agentId: this.id };
    const entry = this.append({ kind: "approval", request: full });
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.approvals.push({ request: full, resolve });
      this.status = "waiting";
      this.changed();
    });
    this.update(entry.id, { decision } as Partial<LogEntry>);
    if (decision === "always") this.allowed.add(request.allowKey);
    if (this.status === "waiting" && this.approvals.length === 0) {
      this.status = this.turnStartedAt !== null ? "working" : "idle";
      this.changed();
    }
    return decision;
  }

  /** The user's answer to the oldest open request. */
  answerApproval(decision: ApprovalDecision): void {
    const pending = this.approvals.shift();
    if (!pending) return;
    pending.resolve(decision);
    this.changed();
  }

  get pendingApproval(): ApprovalRequest | null {
    return this.approvals[0]?.request ?? null;
  }
}
