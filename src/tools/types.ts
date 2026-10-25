// The tool contract. A tool is defined once and used two ways:
// - native agents (API providers) call `run` in-process from their agent loop;
// - Claude Code agents reach the tools marked `mcp: true` through lu-minal's MCP server
//   (src/mcp/), since Claude Code brings its own file and shell tools.
import type { JsonSchema } from "../providers/types.js";
import type {
  AgentRole,
  DiffLine,
  PermissionMode,
  RiskKind,
  TaskItem,
  TaskStatus,
} from "../core/types.js";
import type { Theme } from "../themes/types.js";
import type { RobloxApi } from "../roblox/types.js";

/** How a finished tool call shows up in the agent's panel. */
export interface ToolDisplay {
  /** Overrides the verb ("read", "edit", "run", ...). */
  verb?: string;
  /** Overrides the target (a path, a command). */
  target?: string;
  /** One line under the call: "94 lines", "✓ 0 errors", "38 hits". */
  detail?: string;
  diff?: DiffLine[];
  added?: number;
  removed?: number;
}

export interface ToolResult {
  /** What the model reads. */
  content: string;
  isError?: boolean;
  display?: ToolDisplay;
}

/** An approval as a tool asks for it (the runtime fills in ids). */
export interface ToolApproval {
  risk: RiskKind;
  summary: string;
  detail?: string;
  /** What "always allow" remembers; defaults to the tool name. */
  allowKey?: string;
}

/** Everything a tool may use while it runs. */
export interface ToolContext {
  /** The project root; relative paths resolve against it. */
  cwd: string;
  agentId: string;
  agentName: string;
  role: AgentRole;
  permissionMode: PermissionMode;
  signal: AbortSignal;
  /**
   * Asks the user (or the permission mode) whether this may happen. Resolves false when denied.
   * The agent loop already asks for a tool's `risk` before `run`; tools call this themselves only
   * for extra, finer-grained checks.
   */
  approve(request: ToolApproval): Promise<boolean>;
  services: ToolServices;
}

export interface Tool<Args extends Record<string, unknown> = Record<string, any>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * What the call risks, so the loop can ask before running it. A function can decide per call
   * (e.g. `bash` treats `git status` as "read"). "read" never asks.
   */
  risk: RiskKind | ((args: Args, ctx: ToolContext) => RiskKind);
  /** The verb and target for the panel while the call runs: { verb: "read", target: "PLAN.md" }. */
  describe(args: Args, ctx: ToolContext): { verb: string; target?: string };
  /** The approval text for a risky call (defaults to "<verb> <target>"). */
  approval?(args: Args, ctx: ToolContext): ToolApproval;
  run(args: Args, ctx: ToolContext): Promise<ToolResult>;
  /** Also offered to Claude Code agents through the MCP server. */
  mcp?: boolean;
  /** Only the lead may use it (spawning agents). */
  leadOnly?: boolean;
}

/** An agent as teammates see it. */
export interface TeamMember {
  id: string;
  name: string;
  role: AgentRole;
  label: string | null;
  model: string;
  status: string;
  activity: string | null;
}

/** The team side of a project, as tools reach it. */
export interface TeamApi {
  members(): TeamMember[];
  /** Sends a message to one teammate by name, or to everyone with "*". Returns who got it. */
  send(from: string, to: string, text: string): string[];
  /** Starts a new agent in this project; returns its name. */
  spawn(
    by: string,
    spec: { name?: string; label?: string; model?: string; task: string; instructions?: string },
  ): Promise<string>;
  /** Stops an agent by name. */
  stop(by: string, name: string): boolean;
  tasks(): TaskItem[];
  addTask(by: string, title: string, owner?: string | null, note?: string | null): TaskItem;
  updateTask(
    by: string,
    id: string,
    patch: { status?: TaskStatus; owner?: string | null; note?: string | null; title?: string },
  ): TaskItem | null;
}

/** Themes, as the `set_theme` / `create_theme` tools reach them. */
export interface ThemeApi {
  list(): Array<{ name: string; label: string; dark: boolean; builtin: boolean }>;
  current(): Theme;
  /** Switches the app to a theme by name; false if there is none. */
  set(name: string): boolean;
  /** Saves (and optionally applies) a custom theme. */
  save(theme: Theme, apply: boolean): Promise<void>;
}

/** Claude Code cloud sessions (claude.ai/code) started from lu-minal, as tools reach them. */
export interface CloudApi {
  list(): Array<{ id: string; url: string; task: string; startedAt: number }>;
  /** Sends a follow-up message to a cloud session; resolves to its URL or rejects with the error. */
  send(sessionId: string, text: string): Promise<string>;
}

export interface ToolServices {
  team: TeamApi;
  themes: ThemeApi;
  roblox: RobloxApi;
  /** Present when Claude Code is installed. */
  cloud?: CloudApi;
}
