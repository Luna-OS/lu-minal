// Every built-in tool, and which of them each kind of agent gets: native agents (API models) get
// all of them, Claude Code agents only the ones marked `mcp: true` (it brings its own file and shell
// tools), and workers never get the lead-only ones.
import type { AgentRole } from "../core/types.js";
import type { FetchLike, ToolSpec } from "../providers/types.js";
import { cloudTools } from "./cloud.js";
import { createBashTool, detectShell, type ShellInfo } from "./exec.js";
import { fileTools } from "./fs.js";
import { robloxTools } from "./roblox.js";
import { teamTools } from "./team.js";
import { themeTools } from "./theme.js";
import type { Tool } from "./types.js";
import { createWebFetchTool, webFetchTool } from "./web.js";

export interface ToolOptions {
  /** The fetch web_fetch uses (default: the global fetch). */
  fetchImpl?: FetchLike;
  /** The shell bash runs in (default: detected once). */
  shell?: ShellInfo;
  /** The ripgrep program for grep: a path, null for the built-in search, undefined to look it up. */
  rg?: string | null;
}

let defaultBash: Tool | null = null;

function bashTool(shell?: ShellInfo): Tool {
  if (shell) return createBashTool(shell);
  defaultBash ??= createBashTool(detectShell());
  return defaultBash;
}

/** Every built-in tool: files, shell, web, team, themes, Roblox Studio and Claude cloud sessions. */
export function allTools(opts: ToolOptions = {}): Tool[] {
  return [
    ...fileTools({ rg: opts.rg }),
    bashTool(opts.shell),
    opts.fetchImpl ? createWebFetchTool(opts.fetchImpl) : webFetchTool,
    ...teamTools(),
    ...themeTools(),
    ...robloxTools(),
    ...cloudTools(),
  ];
}

/**
 * The tools an agent gets: native agents all of them, Claude Code agents the `mcp` ones; workers
 * lose the lead-only tools (spawn_agent, stop_agent).
 */
export function toolsForAgent(role: AgentRole, kind: "native" | "claude-code", opts: ToolOptions = {}): Tool[] {
  return allTools(opts).filter((t) => (kind === "native" || t.mcp) && (role === "lead" || !t.leadOnly));
}

/** The tools as the model sees them. */
export function toolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export { classifyCommand, commandAllowKey, detectShell, type ShellInfo } from "./exec.js";
