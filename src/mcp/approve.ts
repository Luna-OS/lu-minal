// Claude Code's permission prompts as lu-minal approvals. Claude Code runs with
// `--permission-prompt-tool mcp__luminal__approve`, so whenever it would ask before a tool call it
// calls the MCP tool "approve" instead; this file decides what that call risks and how the request
// reads in the panel, so it takes the same path as every other approval (Agent.requestApproval).
import fs from "node:fs";
import { clip, describeClaudeTool, displayPath, firstLine, LUMINAL_TOOL_PREFIX } from "../agents/claude-code/display.js";
import type { Agent } from "../core/agent.js";
import type { ApprovalDecision, ApprovalRequest, PermissionMode, RiskKind } from "../core/types.js";
import { isReadOnlyShellCommand, shellAllowKey } from "../tools/command-risk.js";
import { pathReadings } from "../tools/fs.js";
import { assessRead, assessWrite, writeNote, type SensitiveOptions } from "../tools/sensitive.js";
import { isPrivateUrl } from "../tools/net-guard.js";

/** An approval request for one of Claude Code's tool calls. */
export interface ClaudeApproval {
  risk: RiskKind;
  /** "run npm test", "edit src/App.tsx". */
  summary: string;
  detail?: string;
  /** What "always allow" remembers: "Bash:npm test", or the tool name. */
  allowKey: string;
}

/** The internal MCP tool Claude Code calls for its permission prompts. */
export const APPROVE_TOOL_NAME = "approve";

export const APPROVE_TOOL = {
  name: APPROVE_TOOL_NAME,
  description:
    "Internal: lu-minal's permission prompt for Claude Code (--permission-prompt-tool). Do not call it yourself.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool Claude Code wants to use." },
      input: { type: "object", description: "The tool's input." },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
} as const;

const READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
  "Task",
  "Agent",
  "BashOutput",
  "Skill",
  "ToolSearch",
  "TaskOutput",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "CronList",
  "EnterPlanMode",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "LSP",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const EXEC_TOOLS = new Set(["Bash", "PowerShell", "KillShell", "KillBash", "Monitor", "TaskStop"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- read-only shell commands --------------------------------------------------------------------

/**
 * Whether a shell command only reads: ls, cat, head, tail, pwd, rg, grep, find (without -exec /
 * -delete), git status / diff / log / show, ... alone, in a pipeline or a list, with no
 * expansions, substitutions or redirections into files, and (with `cwd`) no path into a secret
 * store. The rules live in src/tools/command-risk.ts, shared with the native bash tool.
 */
export function isReadOnlyCommand(command: string, cwd?: string, platform: NodeJS.Platform = process.platform): boolean {
  return isReadOnlyShellCommand(command, { cwd, sensitive: sensitiveFor(platform) });
}

// ---- assessing a call ----------------------------------------------------------------------------

/** The secret-store rules for `platform` (another platform than this machine's: its path rules only). */
function sensitiveFor(platform: NodeJS.Platform): SensitiveOptions {
  return platform === process.platform ? {} : { platform };
}

/**
 * What an edit of `file` risks: "edit" for an ordinary file in the project; "other" (always asks)
 * outside it (symlinks followed, so a link to ~/.bashrc is outside), in a secret store, in a home
 * dotfile, or in what git and agents run on their own (.git, .claude, .mcp.json, ...) – matched the
 * way Windows and macOS resolve names (".GIT", "GIT~1", ".git." are .git there). Every reading of
 * the path counts (Claude Code opens "~/.bashrc" in the home folder), the strictest one wins.
 */
function editRisk(file: string, cwd: string, platform: NodeJS.Platform = process.platform) {
  if (!file) return { risk: "edit" as RiskKind, outside: false, reason: null as string | null, abs: "" };
  const all = pathReadings(cwd, file, platform).map((abs) => ({ ...assessWrite(cwd, abs, sensitiveFor(platform)), abs }));
  return all.find((a) => a.risk !== "edit") ?? all[0];
}

/**
 * Where a read tool looks (its file or folder, resolved against the project) and what that risks:
 * like editRisk, the reading that asks if any does, else Claude Code's own.
 */
function readTarget(toolName: string, input: Record<string, unknown>, cwd: string, platform: NodeJS.Platform): { abs: string; risk: RiskKind } | null {
  let file = "";
  if (toolName === "Read") file = str(input.file_path);
  else if (toolName === "NotebookRead") file = str(input.notebook_path);
  // Grep reads file contents below its folder (the project by default).
  else if (toolName === "Grep") file = str(input.path) || ".";
  if (!file) return null;
  const recursive = toolName === "Grep";
  const all = pathReadings(cwd, file, platform).map((abs) => ({ abs, risk: assessRead(abs, { ...sensitiveFor(platform), recursive, cwd }) }));
  return all.find((r) => r.risk !== "read") ?? all[0];
}

/**
 * What a Claude Code tool call risks, under lu-minal's permission modes. `platform` picks the path
 * rules (tests); it defaults to this machine's. Reading is free, except reads of secret stores
 * (~/.ssh, lu-minal's auth.json, ...) and network shares, which ask like any other risky action.
 */
export function claudeToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): RiskKind {
  if (toolName.startsWith(LUMINAL_TOOL_PREFIX)) return "read";
  if (READ_TOOLS.has(toolName)) return readTarget(toolName, input, cwd, platform)?.risk ?? "read";
  if (EDIT_TOOLS.has(toolName)) return editRisk(str(input.file_path) || str(input.notebook_path), cwd, platform).risk;
  if (toolName === "Bash") return isReadOnlyCommand(str(input.command), cwd, platform) ? "read" : "exec";
  if (EXEC_TOOLS.has(toolName)) return "exec";
  // This machine, the local network and cloud metadata endpoints are not the open web.
  if (toolName === "WebFetch") return isPrivateUrl(str(input.url)) ? "other" : "network";
  return "other";
}

/** A few lines of an old → new replacement, for the approval's detail. */
function replacementText(oldText: string, newText: string): string {
  const side = (text: string, mark: string) => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const shown = lines.slice(0, 6).map((l) => `${mark} ${l}`);
    if (lines.length > 6) shown.push(`${mark} … ${lines.length - 6} more lines`);
    return text ? shown : [];
  };
  return [...side(oldText, "-"), ...side(newText, "+")].join("\n");
}

/** The approval request for a Claude Code tool call: its risk, summary, detail and "always" key. */
export function assessClaudeTool(toolName: string, input: Record<string, unknown>, cwd: string): ClaudeApproval {
  const risk = claudeToolRisk(toolName, input, cwd);
  const described = describeClaudeTool(toolName, input, cwd);
  const plain = [described.verb, described.target].filter(Boolean).join(" ");

  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = str(input.command).trim();
    const description = str(input.description).trim();
    return {
      risk,
      summary: `run ${firstLine(command, 60) || "a command"}`,
      detail: clip(description ? `${command}\n(${description})` : command, 2000),
      // "Bash:npm test" for one simple command; a list, pipe or substitution only as itself.
      allowKey: shellAllowKey(toolName, command, toolName === "PowerShell" ? "powershell" : "bash"),
    };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const file = str(input.file_path) || str(input.notebook_path);
    const assessed = editRisk(file, cwd);
    const where = displayPath(file, cwd) || "a file";
    let verb = "edit";
    if (toolName === "Write") {
      let exists = false;
      try {
        exists = Boolean(file) && fs.existsSync(pathReadings(cwd, file)[0]);
      } catch {
        exists = false;
      }
      verb = exists ? "overwrite" : "create";
    }
    let detail: string | undefined;
    if (toolName === "Edit") detail = replacementText(str(input.old_string), str(input.new_string));
    else if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
      const edits = input.edits.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object");
      const first = edits[0];
      detail = `${edits.length} ${edits.length === 1 ? "change" : "changes"}${first ? `\n${replacementText(str(first.old_string), str(first.new_string))}` : ""}`;
    } else if (toolName === "Write") {
      const content = str(input.content).replace(/\r\n/g, "\n");
      const lines = content ? content.replace(/\n$/, "").split("\n") : [];
      detail = [`${lines.length} ${lines.length === 1 ? "line" : "lines"}`, ...lines.slice(0, 3).map((l) => `+ ${l}`)].join("\n");
    } else if (toolName === "NotebookEdit") {
      detail = clip(str(input.new_source), 400);
    }
    return {
      risk,
      summary: `${verb} ${where}${file ? writeNote(assessed) : ""}`,
      detail: detail || undefined,
      // "always" for an ordinary edit in the project never covers one outside it or in .git.
      allowKey: assessed.risk === "edit" ? toolName : `${toolName}:${assessed.abs}`,
    };
  }

  if (toolName === "WebFetch") {
    const prompt = str(input.prompt).trim();
    const url = str(input.url);
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      // shown as given
    }
    return {
      risk,
      summary: risk === "network" ? plain : `${plain} (this machine or the local network)`,
      detail: [url, prompt ? `(${firstLine(prompt, 120)})` : ""].filter(Boolean).join("\n") || undefined,
      allowKey: risk === "network" ? toolName : `${toolName}:${origin}`,
    };
  }

  const read = READ_TOOLS.has(toolName) ? readTarget(toolName, input, cwd, process.platform) : null;
  if (read && risk !== "read") {
    return {
      risk,
      summary: `${plain || `use ${toolName}`} (a credentials store or network share)`,
      detail: read.abs,
      allowKey: `${toolName}:${read.abs}`,
    };
  }

  if (toolName === "ExitPlanMode") {
    return { risk, summary: "leave plan mode and start working", detail: clip(str(input.plan), 1200) || undefined, allowKey: toolName };
  }

  let detail: string | undefined;
  try {
    const json = JSON.stringify(input);
    detail = json && json !== "{}" ? clip(json, 400) : undefined;
  } catch {
    detail = undefined;
  }
  return { risk, summary: plain || `use ${toolName}`, detail, allowKey: toolName };
}

/**
 * The answer to a permission prompt that lu-minal gives without asking anyone, or null. Claude
 * Code's AskUserQuestion expects the user's picks back in `updatedInput`, which a yes / no approval
 * can't collect, so Claude is told to ask in its reply instead (the user answers with a message).
 */
export function automaticAnswer(toolName: string): { behavior: "deny"; message: string } | null {
  if (toolName === "AskUserQuestion") {
    return {
      behavior: "deny",
      message:
        "lu-minal can't show multiple-choice questions. Ask the user in plain text in your reply instead, then end your turn and wait for their answer.",
    };
  }
  return null;
}

/** What the approve tool answers Claude Code (as the text of its result). */
export function approvalAnswer(
  allowed: boolean,
  input: Record<string, unknown>,
  mode: PermissionMode,
): { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string } {
  if (allowed) return { behavior: "allow", updatedInput: input };
  return {
    behavior: "deny",
    message:
      mode === "plan"
        ? "Not allowed: lu-minal is in plan mode (read-only). Describe the change instead."
        : "The user denied this in lu-minal.",
  };
}

/**
 * Asks for an approval like Agent.requestApproval, with a way to take the question back when the
 * call that asked is gone (Claude Code was interrupted or died): withdraw() removes it from the
 * panel and denies it. A failing request counts as a denial.
 */
export function askWithdrawable(
  agent: Agent,
  request: Omit<ApprovalRequest, "id" | "agentId">,
): { decision: Promise<ApprovalDecision>; withdraw: () => void } {
  const before = new Set(agent.approvals);
  const decision = agent.requestApproval(request).catch((): ApprovalDecision => "deny");
  // The request it queued (none when the mode or the "always" list decided at once).
  const mine = agent.approvals.find((a) => !before.has(a));
  return {
    decision,
    withdraw: () => {
      if (!mine) return;
      const i = agent.approvals.indexOf(mine);
      if (i < 0) return;
      agent.approvals.splice(i, 1);
      mine.resolve("deny");
      agent.changed();
    },
  };
}
