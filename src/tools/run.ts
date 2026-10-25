// Runs one tool call the same way for every agent: ask for approval if its risk needs it, run it,
// and record it in the agent's log (the "▸ read PLAN.md / └ 94 lines" rows).
import type { Agent } from "../core/agent.js";
import type { Project } from "../core/project.js";
import type { ToolApproval, ToolContext, ToolResult, ToolServices, Tool } from "./types.js";

/** Builds the context a tool runs in for `agent`. */
export function createToolContext(opts: {
  agent: Agent;
  project: Project;
  services: ToolServices;
  signal: AbortSignal;
}): ToolContext {
  const { agent, project, services, signal } = opts;
  return {
    cwd: project.cwd,
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    permissionMode: agent.permissionMode,
    signal,
    services,
    approve: async (req: ToolApproval) => {
      const decision = await agent.requestApproval({
        tool: "tool",
        risk: req.risk,
        summary: req.summary,
        detail: req.detail,
        allowKey: req.allowKey ?? req.summary,
      });
      return decision !== "deny";
    },
  };
}

function riskOf(tool: Tool, args: Record<string, unknown>, ctx: ToolContext) {
  return typeof tool.risk === "function" ? tool.risk(args, ctx) : tool.risk;
}

/** Parses arguments that may arrive as a JSON string. */
export function normalizeArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/**
 * Runs `tool` with `args` for `agent`, logging the call. Never throws: failures come back as an
 * error result the model can read.
 */
export async function runToolCall(opts: {
  agent: Agent;
  tool: Tool | undefined;
  name: string;
  toolCallId: string;
  args: unknown;
  ctx: ToolContext;
  /** Don't add a log row (the caller logs it, e.g. Claude Code's own tool rows). */
  quiet?: boolean;
}): Promise<ToolResult> {
  const { agent, tool, name, toolCallId, ctx } = opts;
  const args = normalizeArgs(opts.args);
  if (!tool) {
    return { content: `Unknown tool "${name}".`, isError: true };
  }
  if (tool.leadOnly && ctx.role !== "lead") {
    return { content: `Only the lead may use ${name}.`, isError: true };
  }

  let described: { verb: string; target?: string };
  try {
    described = tool.describe(args as never, ctx);
  } catch {
    described = { verb: name };
  }
  const entry = opts.quiet
    ? null
    : agent.append({
        kind: "tool",
        toolCallId,
        name,
        verb: described.verb,
        target: described.target,
        status: "running",
      });

  const finish = (result: ToolResult): ToolResult => {
    if (entry) {
      const d = result.display ?? {};
      agent.update(entry.id, {
        status: result.isError ? "error" : "ok",
        verb: d.verb ?? described.verb,
        target: d.target ?? described.target,
        detail: d.detail ?? (result.isError ? firstLine(result.content) : undefined),
        diff: d.diff,
        added: d.added,
        removed: d.removed,
      } as never);
    }
    if (result.display && (result.display.added || result.display.removed)) {
      agent.addLines(result.display.added ?? 0, result.display.removed ?? 0);
    }
    return result;
  };

  try {
    const risk = riskOf(tool, args, ctx);
    if (risk !== "read") {
      const approval = tool.approval?.(args as never, ctx) ?? {
        risk,
        summary: [described.verb, described.target].filter(Boolean).join(" "),
      };
      const decision = await agent.requestApproval({
        tool: name,
        risk: approval.risk ?? risk,
        summary: approval.summary,
        detail: approval.detail,
        allowKey: approval.allowKey ?? name,
      });
      if (decision === "deny") {
        return finish({
          content:
            agent.permissionMode === "plan"
              ? "Not allowed: the project is in plan mode (read-only). Describe the change instead."
              : "The user denied this action. Ask them or try something else.",
          isError: true,
          display: { detail: "denied" },
        });
      }
    }
    if (ctx.signal.aborted) return finish({ content: "Interrupted.", isError: true });
    return finish(await tool.run(args as never, ctx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish({ content: `Error: ${message}`, isError: true });
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
