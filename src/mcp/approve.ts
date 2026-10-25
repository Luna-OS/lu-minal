// Claude Code's permission prompts as lu-minal approvals. Claude Code runs with
// `--permission-prompt-tool mcp__luminal__approve`, so whenever it would ask before a tool call it
// calls the MCP tool "approve" instead; this file decides what that call risks and how the request
// reads in the panel, so it takes the same path as every other approval (Agent.requestApproval).
import fs from "node:fs";
import path from "node:path";
import { clip, describeClaudeTool, displayPath, firstLine, LUMINAL_TOOL_PREFIX } from "../agents/claude-code/display.js";
import type { Agent } from "../core/agent.js";
import type { ApprovalDecision, ApprovalRequest, PermissionMode, RiskKind } from "../core/types.js";

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

/** Folders inside a project whose files change how tools behave: edits there always ask. */
const SENSITIVE_DIRS = new Set([".git", ".claude"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- read-only shell commands --------------------------------------------------------------------

const READ_ONLY_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "pwd",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "tree",
  "which",
  "stat",
  "file",
  "du",
  "echo",
  "sort",
  "cut",
  "tr",
  "nl",
  "basename",
  "dirname",
  "realpath",
]);

const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "shortlog"]);

/** find's actions that run programs or write files. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Splits a shell command into pipeline segments of words, or null when it does more than a pipeline. */
function pipelineWords(command: string): string[][] | null {
  // Harmless redirections of diagnostics.
  const text = command.replace(/\s+(?:2>\s*\/dev\/null|2>&1|>\s*\/dev\/null)(?=\s|$|\|)/g, " ");
  const segments: string[][] = [[]];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "`" || (ch === "$" && text[i + 1] === "("))) return null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
      continue;
    }
    if (/[;&<>`\n\r(){}]/.test(ch) || (ch === "$" && text[i + 1] === "(")) return null;
    if (ch === "|") {
      endWord();
      if (!segments[segments.length - 1].length) return null; // "||" or a leading "|"
      segments.push([]);
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) return null;
  endWord();
  if (segments.some((s) => !s.length)) return null;
  return segments;
}

function segmentIsReadOnly(words: string[]): boolean {
  const [first, ...args] = words;
  if (!first || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false; // VAR=value cmd
  const program = first.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
  if (program === "git") {
    const rest = args[0] === "--no-pager" ? args.slice(1) : args;
    if (!rest.length || !GIT_READ_ONLY.has(rest[0])) return false;
    return !rest.some((a) => a.startsWith("--output") || a === "-o" || a.startsWith("--ext-diff"));
  }
  if (!READ_ONLY_PROGRAMS.has(program)) return false;
  if (program === "find") return !args.some((a) => FIND_WRITES.has(a));
  if (program === "rg") return !args.some((a) => a === "--pre" || a.startsWith("--pre="));
  if (program === "sort") return !args.some((a) => a === "-o" || a.startsWith("--output") || /^-[a-zA-Z]*o/.test(a));
  return true;
}

/**
 * Whether a shell command only reads: ls, cat, head, tail, pwd, rg, grep, find (without -exec /
 * -delete), git status / diff / log / show, ... alone or in a pipeline, with no redirections into
 * files, command substitution or command lists.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const segments = pipelineWords(trimmed);
  return Boolean(segments && segments.every(segmentIsReadOnly));
}

// ---- assessing a call ----------------------------------------------------------------------------

function isInside(file: string, cwd: string): boolean {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function editRisk(file: string, cwd: string): { risk: RiskKind; outside: boolean } {
  if (!file) return { risk: "edit", outside: false };
  if (!isInside(file, cwd)) return { risk: "other", outside: true };
  const top = path.relative(cwd, path.resolve(cwd, file)).split(/[\\/]/)[0];
  return { risk: SENSITIVE_DIRS.has(top) ? "other" : "edit", outside: false };
}

/** What a Claude Code tool call risks, under lu-minal's permission modes. */
export function claudeToolRisk(toolName: string, input: Record<string, unknown>, cwd: string): RiskKind {
  if (toolName.startsWith(LUMINAL_TOOL_PREFIX)) return "read";
  if (READ_TOOLS.has(toolName)) return "read";
  if (EDIT_TOOLS.has(toolName)) return editRisk(str(input.file_path) || str(input.notebook_path), cwd).risk;
  if (toolName === "Bash") return isReadOnlyCommand(str(input.command)) ? "read" : "exec";
  if (EXEC_TOOLS.has(toolName)) return "exec";
  if (toolName === "WebFetch") return "network";
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
    const words = command.split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    const description = str(input.description).trim();
    return {
      risk,
      summary: `run ${firstLine(command, 60) || "a command"}`,
      detail: clip(description ? `${command}\n(${description})` : command, 2000),
      allowKey: `${toolName}:${words}`,
    };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const file = str(input.file_path) || str(input.notebook_path);
    const { outside } = editRisk(file, cwd);
    const where = displayPath(file, cwd) || "a file";
    let verb = "edit";
    if (toolName === "Write") {
      let exists = false;
      try {
        exists = Boolean(file) && fs.existsSync(path.resolve(cwd, file));
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
      summary: `${verb} ${where}${outside ? " (outside the project)" : ""}`,
      detail: detail || undefined,
      allowKey: toolName,
    };
  }

  if (toolName === "WebFetch") {
    const prompt = str(input.prompt).trim();
    return {
      risk,
      summary: plain,
      detail: [str(input.url), prompt ? `(${firstLine(prompt, 120)})` : ""].filter(Boolean).join("\n") || undefined,
      allowKey: toolName,
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
