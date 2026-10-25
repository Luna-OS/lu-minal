// The shapes of lu-minal's state: projects (tabs), agents, their logs, team messages, the shared
// task board, approvals and plan usage. The classes that hold them live next to this file.
import type { ModelRef } from "../providers/models.js";

export type AgentRole = "lead" | "worker";

/**
 * - starting: the driver is coming up (spawning the CLI, resolving the model)
 * - idle:     waiting for a message
 * - working:  a turn is running
 * - waiting:  blocked on the user (an approval)
 * - error:    the last turn failed; a new message tries again
 * - stopped:  disposed or killed
 */
export type AgentStatus = "starting" | "idle" | "working" | "waiting" | "error" | "stopped";

/**
 * What an agent may do without asking:
 * - ask:       reading is free; edits and commands need an OK
 * - auto-edit: edits inside the project are free; commands need an OK (the default)
 * - yolo:      everything is free
 * - plan:      read-only; edits and commands are refused
 */
export type PermissionMode = "ask" | "auto-edit" | "yolo" | "plan";

export const PERMISSION_MODES: PermissionMode[] = ["auto-edit", "ask", "yolo", "plan"];

/** What kind of action an approval is for. */
export type RiskKind = "read" | "edit" | "exec" | "network" | "other";

/** One line of a diff as the panels draw it (line numbers of the new file, old for deletions). */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  line: number | null;
  text: string;
}

export interface ApprovalRequest {
  id: string;
  agentId: string;
  /** The tool's name, e.g. "bash", "Edit", "write_file". */
  tool: string;
  risk: RiskKind;
  /** One line: "run npm test", "edit src/App.tsx". */
  summary: string;
  /** More context (the command, the diff as text). */
  detail?: string;
  /** What "always allow" remembers, e.g. "bash:npm test" or "Edit". */
  allowKey: string;
}

export type ApprovalDecision = "allow" | "deny" | "always";

interface LogBase {
  id: string;
  at: number;
}

export type LogEntry =
  /** A message to this agent from the user ("you") or from a teammate. */
  | (LogBase & { kind: "user"; from: string; text: string; attachments?: string[] })
  | (LogBase & { kind: "text"; text: string; streaming?: boolean })
  | (LogBase & { kind: "reasoning"; text: string; streaming?: boolean })
  | (LogBase & {
      kind: "tool";
      toolCallId: string;
      /** The tool's real name ("read_file", "Bash", "mcp__luminal__send_message"). */
      name: string;
      /** The short verb shown in bold: "read", "edit", "run", "grep", "new", "message". */
      verb: string;
      /** What it acts on: a path, a command, a pattern. */
      target?: string;
      status: "running" | "ok" | "error";
      /** The one-line result under it: "94 lines", "✓ 0 errors", "1 line added". */
      detail?: string;
      diff?: DiffLine[];
      added?: number;
      removed?: number;
    })
  /** A message this agent sent to a teammate (out) – incoming ones are "user" entries. */
  | (LogBase & { kind: "message"; to: string; text: string })
  | (LogBase & { kind: "info"; text: string })
  | (LogBase & { kind: "error"; text: string })
  | (LogBase & { kind: "approval"; request: ApprovalRequest; decision?: ApprovalDecision });

export type LogEntryKind = LogEntry["kind"];

/** A message on a project's team bus. `to` is an agent name or "*" for everyone. */
export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

/** An item on the project's shared task board. */
export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  createdBy: string;
  note: string | null;
  updatedAt: number;
}

/** What starts an agent. */
export interface AgentSpec {
  name: string;
  role: AgentRole;
  /** The short area label in the panel's title ("room", "voice", "physics"). */
  label?: string;
  model: ModelRef;
  /** The first message, if any. */
  task?: string;
  /** Who started it ("you" or an agent's name). */
  spawnedBy?: string;
  permissionMode?: PermissionMode;
  /** Extra instructions appended to the agent's system prompt. */
  instructions?: string;
}

/** A plan's rate-limit window: how much is used (0..1) and when it resets (ms since epoch). */
export interface UsageWindow {
  utilization: number;
  resetsAt: number | null;
}

/** The Claude plan's limits: the 5-hour session and the week (plus per-model weekly windows). */
export interface PlanUsage {
  available: boolean;
  plan: string | null;
  session: UsageWindow | null;
  week: UsageWindow | null;
  models: Array<{ name: string } & UsageWindow>;
  /** Pay-as-you-go credits beyond the plan, in cents, when claude.ai reports them. */
  extra: {
    enabled: boolean;
    limit: number | null;
    used: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
  /** When these numbers were read. */
  at: number;
}

/** A provider's own balance or key limit (OpenRouter credits, ...). */
export interface ProviderBalance {
  provider: string;
  label: string;
  /** Amount used so far, in `unit`. */
  used: number | null;
  /** The limit, null for none. */
  limit: number | null;
  unit: "usd" | "credits" | "requests";
  at: number;
}

/** Who is signed in to Claude Code. */
export interface ClaudeAccount {
  installed: boolean;
  exe: string | null;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  organization: string | null;
  plan: string | null;
}
