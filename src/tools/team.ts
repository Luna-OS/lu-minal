// The team tools: messages between agents, who is on the team, starting and stopping workers, and
// the shared task board. They act on lu-minal's own state (the project), so they never need an
// approval, and Claude Code agents get them through the MCP server too.
import type { TaskItem, TaskStatus } from "../core/types.js";
import { parseModelRef } from "../providers/models.js";
import { clip, defineTool, plural } from "./fs.js";
import type { TeamMember, Tool, ToolContext, ToolResult } from "./types.js";

const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "done", "blocked"];

function fail(content: string, detail?: string): ToolResult {
  return { content, isError: true, display: detail ? { detail } : undefined };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** "vega (worker · room · opencode/big-pickle · working)". */
function memberLine(m: TeamMember, me: string): string {
  const parts = [m.role, m.label ? `area: ${m.label}` : null, m.model, m.status, m.activity].filter(Boolean);
  return `${m.name}${m.name === me ? " (you)" : ""} — ${parts.join(" · ")}`;
}

function roster(ctx: ToolContext): string {
  const others = ctx.services.team.members().filter((m) => m.name !== ctx.agentName);
  if (!others.length) return "You are the only agent in this project.";
  return `Teammates: ${others.map((m) => `${m.name} (${m.role}${m.label ? `, ${m.label}` : ""})`).join(", ")}. Use "lead" for the lead or "*" for everyone.`;
}

/** "#3 [doing] Fix the login form · owner vega · note: waits for the API". */
export function taskLine(t: TaskItem): string {
  const owner = t.owner ? ` · owner ${t.owner}` : "";
  const note = t.note ? ` · note: ${t.note}` : "";
  return `#${t.id} [${t.status}] ${t.title}${owner}${note}`;
}

// ---- messages -----------------------------------------------------------------------------------

type SendArgs = { to: string; text: string };

export const sendMessageTool = defineTool<SendArgs>({
  name: "send_message",
  description:
    "Sends a message to a teammate: `to` is an agent's name, \"lead\" for the lead, or \"*\" for " +
    "everyone. They read it at their next step. Keep it short and concrete (what changed, which " +
    "files, what is next); don't send messages that only acknowledge.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "A teammate's name, \"lead\", or \"*\" for everyone." },
      text: { type: "string", description: "The message." },
    },
    required: ["to", "text"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: "message", target: `→ ${text(args.to) || "?"}` }),
  async run(args, ctx) {
    const to = text(args.to).replace(/^@/, "");
    const body = text(args.text);
    if (!to) return fail(`send_message needs \`to\`. ${roster(ctx)}`);
    if (!body) return fail("send_message needs some `text`.");
    const self = ctx.agentName.toLowerCase();
    const lower = to.toLowerCase();
    if (lower === self || (lower === "lead" && ctx.role === "lead")) {
      return fail(`That is you (${ctx.agentName}). ${roster(ctx)}`, "can't message yourself");
    }
    const got = ctx.services.team.send(ctx.agentName, to, body);
    if (!got.length) {
      const who = lower === "*" || lower === "all" || lower === "everyone" ? "Nobody else is running" : `Nobody named "${to}" is running`;
      return fail(`${who}. ${roster(ctx)}`, "no recipient");
    }
    return {
      content: `Delivered to ${got.join(", ")}.`,
      display: { target: `→ ${got.length === 1 ? got[0] : to}`, detail: got.length === 1 ? "delivered" : `delivered to ${got.length}` },
    };
  },
});

export const listAgentsTool = defineTool<Record<string, never>>({
  name: "list_agents",
  description: "Lists the agents in this project: name, role, area label, model, status and what they are doing.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  mcp: true,
  describe: () => ({ verb: "team" }),
  async run(_args, ctx) {
    const members = ctx.services.team.members();
    return {
      content: members.map((m) => memberLine(m, ctx.agentName)).join("\n") || "No agents.",
      display: { detail: plural(members.length, "agent") },
    };
  },
});

// ---- workers ------------------------------------------------------------------------------------

type SpawnArgs = { task: string; label?: string; model?: string; name?: string; instructions?: string };

export const spawnAgentTool = defineTool<SpawnArgs>({
  name: "spawn_agent",
  description:
    "Starts a worker agent in this project with a task (lead only). Give one focused, self-contained " +
    "task per worker: the goal, the files or area it owns, constraints, how to verify, and to report " +
    "back with send_message(\"lead\", ...). `label` is a short area name for its panel (\"api\", " +
    "\"ui\"). `model` is any \"provider/model\" id (\"opencode/big-pickle\", \"claude-code/sonnet\", " +
    "\"openrouter/<id>\", \"minimax/MiniMax-M3\"); without it the default worker model is used. The " +
    "worker reports back by message, so there is no need to poll it.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The worker's task, complete enough to work on alone." },
      label: { type: "string", description: "A short area label for its panel (one or two words)." },
      model: { type: "string", description: "\"provider/model\", e.g. \"opencode/big-pickle\" or \"claude-code/sonnet\"." },
      name: { type: "string", description: "A name for it (default: the next free star name)." },
      instructions: { type: "string", description: "Extra standing instructions for its system prompt." },
    },
    required: ["task"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  leadOnly: true,
  describe: (args) => ({ verb: "spawn", target: text(args.label) || text(args.name) || clip(text(args.task), 50) }),
  async run(args, ctx) {
    const task = text(args.task);
    if (!task) return fail("spawn_agent needs a `task`.");
    const model = text(args.model);
    if (model && !parseModelRef(model)) {
      return fail(`"${model}" is not a model id; use "provider/model", e.g. "opencode/big-pickle" or "claude-code/sonnet".`, "bad model id");
    }
    const label = text(args.label).slice(0, 24) || undefined;
    const name = await ctx.services.team.spawn(ctx.agentName, {
      task,
      label,
      model: model || undefined,
      name: text(args.name) || undefined,
      instructions: text(args.instructions) || undefined,
    });
    const member = ctx.services.team.members().find((m) => m.name === name);
    const on = member ? ` on ${member.model}` : "";
    const status = member?.status === "error" ? " It failed to start; see its panel (or try another model)." : "";
    return {
      content:
        `Started ${name}${on}${label ? ` (area: ${label})` : ""} with the task.${status} It will report back ` +
        `with send_message when it is done or blocked; you don't need to poll it. Keep working, or end ` +
        "your turn and wait for its message.",
      isError: member?.status === "error" ? true : undefined,
      display: { target: label ? `${name} · ${label}` : name, detail: member?.model ?? "started" },
    };
  },
});

type StopArgs = { name: string };

export const stopAgentTool = defineTool<StopArgs>({
  name: "stop_agent",
  description: "Stops a worker for good (lead only), e.g. when its part is done and it is no longer needed.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The worker's name." } },
    required: ["name"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  leadOnly: true,
  describe: (args) => ({ verb: "stop", target: text(args.name) }),
  async run(args, ctx) {
    const name = text(args.name).replace(/^@/, "");
    if (!name) return fail("stop_agent needs a `name`.");
    if (!ctx.services.team.stop(ctx.agentName, name)) {
      const workers = ctx.services.team.members().filter((m) => m.role === "worker" && m.name !== ctx.agentName);
      const list = workers.length ? `Workers: ${workers.map((w) => w.name).join(", ")}.` : "There are no workers.";
      return fail(`Can't stop "${name}". ${list}`, "no such worker");
    }
    return { content: `Stopped ${name}.`, display: { detail: "stopped" } };
  },
});

// ---- the task board -----------------------------------------------------------------------------

export const tasksListTool = defineTool<Record<string, never>>({
  name: "tasks_list",
  description: "Shows the project's shared task board (id, status, title, owner, note).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  mcp: true,
  describe: () => ({ verb: "tasks" }),
  async run(_args, ctx) {
    const tasks = ctx.services.team.tasks();
    if (!tasks.length) return { content: "The task board is empty.", display: { detail: "0 tasks" } };
    const open = tasks.filter((t) => t.status !== "done").length;
    return {
      content: tasks.map(taskLine).join("\n"),
      display: { detail: `${plural(tasks.length, "task")} · ${open} open` },
    };
  },
});

type TaskAddArgs = { title: string; owner?: string; note?: string };

export const taskAddTool = defineTool<TaskAddArgs>({
  name: "task_add",
  description: "Puts a task on the shared board. With an `owner` it starts as \"doing\", otherwise \"todo\".",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What needs doing, in a few words." },
      owner: { type: "string", description: "The agent who does it." },
      note: { type: "string", description: "Details, links, dependencies." },
    },
    required: ["title"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: "task", target: clip(text(args.title), 60) }),
  async run(args, ctx) {
    const title = text(args.title);
    if (!title) return fail("task_add needs a `title`.");
    const task = ctx.services.team.addTask(ctx.agentName, title, text(args.owner) || null, text(args.note) || null);
    return { content: `Added ${taskLine(task)}`, display: { target: `#${task.id} ${clip(task.title, 50)}`, detail: task.status } };
  },
});

type TaskUpdateArgs = { id: string | number; status?: string; owner?: string | null; note?: string | null; title?: string };

export const taskUpdateTool = defineTool<TaskUpdateArgs>({
  name: "task_update",
  description:
    "Updates a task on the board: `status` (todo, doing, done, blocked), `owner` (\"\" to clear), " +
    "`note`. Claim a task by setting yourself as owner and status \"doing\"; mark it done when it is.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The task's id (\"3\" or \"#3\")." },
      status: { type: "string", enum: TASK_STATUSES, description: "The new status." },
      owner: { type: "string", description: "Who does it (\"\" for nobody)." },
      note: { type: "string", description: "A note (replaces the old one; \"\" clears it)." },
      title: { type: "string", description: "A new title." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: "task", target: `#${String(args.id ?? "?").replace(/^#/, "")}${args.status ? ` → ${args.status}` : ""}` }),
  async run(args, ctx) {
    const id = String(args.id ?? "").trim().replace(/^#/, "");
    if (!id) return fail("task_update needs the task's `id`.");
    const patch: { status?: TaskStatus; owner?: string | null; note?: string | null; title?: string } = {};
    if (args.status !== undefined && args.status !== null && args.status !== "") {
      const status = String(args.status).trim().toLowerCase() as TaskStatus;
      if (!TASK_STATUSES.includes(status)) return fail(`Unknown status "${args.status}"; use one of ${TASK_STATUSES.join(", ")}.`);
      patch.status = status;
    }
    if (args.owner !== undefined) {
      const owner = text(args.owner);
      patch.owner = owner && owner.toLowerCase() !== "none" ? owner : null;
    }
    if (args.note !== undefined) patch.note = text(args.note) || null;
    if (text(args.title)) patch.title = text(args.title);
    if (!Object.keys(patch).length) return fail("Nothing to change: pass status, owner, note or title.");
    const task = ctx.services.team.updateTask(ctx.agentName, id, patch);
    if (!task) {
      const ids = ctx.services.team.tasks().map((t) => `#${t.id}`);
      return fail(`There is no task #${id}. ${ids.length ? `Tasks: ${ids.join(", ")}.` : "The board is empty."}`, "no such task");
    }
    return { content: `Updated ${taskLine(task)}`, display: { target: `#${task.id} ${clip(task.title, 50)}`, detail: task.status } };
  },
});

/** The team tools in the order the model sees them. */
export function teamTools(): Tool[] {
  return [sendMessageTool, listAgentsTool, spawnAgentTool, stopAgentTool, tasksListTool, taskAddTool, taskUpdateTool];
}
