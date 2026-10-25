// A project is one tab: a folder, the team of agents working in it, the team's message bus and the
// shared task board.
import path from "node:path";
import { parseModelRef, type ModelRef } from "../providers/models.js";
import type { TeamApi, TeamMember } from "../tools/types.js";
import { Agent } from "./agent.js";
import { newId, type Notifier } from "./emitter.js";
import type {
  AgentSpec,
  PermissionMode,
  TaskItem,
  TaskStatus,
  TeamMessage,
} from "./types.js";

/** What a project needs from the app to start and stop agents (the Hub provides it). */
export interface ProjectRuntime {
  /** Creates the agent's driver and starts it. */
  launch(project: Project, agent: Agent): Promise<void>;
  /** The model new workers get when the spawner names none. */
  defaultWorkerModel(project: Project, spawner: Agent | null): ModelRef;
}

/** Star names for new workers (the lead is "luna"). */
export const STAR_NAMES = [
  "vega",
  "lyra",
  "orion",
  "nova",
  "sirius",
  "altair",
  "deneb",
  "rigel",
  "capella",
  "electra",
  "mira",
  "atlas",
  "castor",
  "pollux",
  "spica",
  "antares",
  "polaris",
  "maia",
  "elara",
  "io",
];

const MAX_MESSAGES = 500;
const MAX_AGENTS = 24;

export class Project {
  readonly id = newId("proj");
  createdAt = Date.now();
  name: string;
  cwd: string;
  agents: Agent[] = [];
  focusedId: string | null = null;
  /** The focused panel fills the screen. */
  zoomed = false;
  messages: TeamMessage[] = [];
  tasks: TaskItem[] = [];
  permissionMode: PermissionMode;
  /** Where the project came from ("github:owner/name", "forgejo:...", "local"). */
  origin: string;

  constructor(
    opts: { name?: string; cwd: string; permissionMode?: PermissionMode; origin?: string },
    private readonly notifier: Notifier,
    private readonly runtime: ProjectRuntime,
  ) {
    this.cwd = path.resolve(opts.cwd);
    this.name = opts.name?.trim() || path.basename(this.cwd) || this.cwd;
    this.permissionMode = opts.permissionMode ?? "auto-edit";
    this.origin = opts.origin ?? "local";
  }

  changed(): void {
    this.notifier.changed();
  }

  // ---- agents ----------------------------------------------------------------------------------

  get lead(): Agent | undefined {
    return this.agents.find((a) => a.role === "lead");
  }

  get focused(): Agent | undefined {
    return this.agents.find((a) => a.id === this.focusedId) ?? this.lead ?? this.agents[0];
  }

  findAgent(nameOrId: string): Agent | undefined {
    const key = nameOrId.trim().replace(/^@/, "").toLowerCase();
    return this.agents.find((a) => a.id === nameOrId || a.name.toLowerCase() === key);
  }

  /** A free agent name: the given one (made unique) or the next unused star name. */
  uniqueName(wanted?: string): string {
    const taken = new Set(this.agents.map((a) => a.name.toLowerCase()));
    const base = (wanted ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    if (base && !taken.has(base) && base !== "you" && base !== "all") return base;
    if (base) {
      for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
    for (const star of STAR_NAMES) if (!taken.has(star)) return star;
    for (let i = 1; ; i++) if (!taken.has(`star-${i}`)) return `star-${i}`;
  }

  /** Adds an agent and launches it. */
  async addAgent(spec: AgentSpec): Promise<Agent> {
    if (this.agents.length >= MAX_AGENTS) {
      throw new Error(`A project can have at most ${MAX_AGENTS} agents.`);
    }
    if (spec.role === "lead" && this.lead) throw new Error("This project already has a lead.");
    const agent = new Agent(
      { ...spec, name: this.uniqueName(spec.name) },
      this.notifier,
      this.permissionMode,
    );
    this.agents.push(agent);
    if (!this.focusedId) this.focusedId = agent.id;
    this.changed();
    try {
      await this.runtime.launch(this, agent);
    } catch (err) {
      agent.error(err instanceof Error ? err.message : String(err));
      agent.setStatus("error");
    }
    if (spec.task) agent.deliver({ from: spec.spawnedBy ?? "you", text: spec.task });
    return agent;
  }

  async removeAgent(agent: Agent): Promise<void> {
    agent.interrupt();
    agent.setStatus("stopped");
    await agent.driver?.dispose().catch(() => undefined);
    this.agents = this.agents.filter((a) => a !== agent);
    if (this.focusedId === agent.id) this.focusedId = this.lead?.id ?? this.agents[0]?.id ?? null;
    this.changed();
  }

  focus(agent: Agent | undefined): void {
    if (!agent) return;
    this.focusedId = agent.id;
    this.changed();
  }

  /** Moves the focus by `step` panels (Tab / Shift+Tab). */
  cycleFocus(step: number): void {
    if (!this.agents.length) return;
    const i = Math.max(0, this.agents.findIndex((a) => a.id === this.focused?.id));
    const next = this.agents[(i + step + this.agents.length) % this.agents.length];
    this.focus(next);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    for (const a of this.agents) a.permissionMode = mode;
    this.changed();
  }

  async dispose(): Promise<void> {
    await Promise.all(this.agents.map((a) => a.driver?.dispose().catch(() => undefined)));
    for (const a of this.agents) a.setStatus("stopped");
  }

  // ---- the bus ---------------------------------------------------------------------------------

  /**
   * Sends `text` from `from` (an agent name or "you") to `to` (a name, "lead", or "*" for everyone
   * but the sender). Returns the names that got it.
   */
  send(from: string, to: string, text: string): string[] {
    const body = text.trim();
    if (!body) return [];
    const target = to.trim().replace(/^@/, "").toLowerCase();
    let recipients: Agent[];
    if (target === "*" || target === "all" || target === "everyone") {
      recipients = this.agents.filter((a) => a.name !== from && a.status !== "stopped");
    } else if (target === "lead") {
      recipients = this.lead && this.lead.name !== from ? [this.lead] : [];
    } else {
      const agent = this.findAgent(target);
      recipients = agent && agent.status !== "stopped" ? [agent] : [];
    }
    if (!recipients.length) return [];
    const message: TeamMessage = {
      id: newId("msg"),
      from,
      to: recipients.length === 1 ? recipients[0].name : "*",
      text: body,
      at: Date.now(),
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    const sender = this.findAgent(from);
    sender?.append({ kind: "message", to: message.to, text: body });
    for (const r of recipients) r.deliver({ from, text: body });
    this.changed();
    return recipients.map((r) => r.name);
  }

  // ---- the task board --------------------------------------------------------------------------

  addTask(by: string, title: string, owner: string | null = null, note: string | null = null): TaskItem {
    const task: TaskItem = {
      id: String(this.tasks.length + 1),
      title: title.trim().slice(0, 200),
      status: owner ? "doing" : "todo",
      owner: owner ? owner.replace(/^@/, "") : null,
      createdBy: by,
      note: note?.trim() || null,
      updatedAt: Date.now(),
    };
    this.tasks.push(task);
    this.changed();
    return task;
  }

  updateTask(
    _by: string,
    id: string,
    patch: { status?: TaskStatus; owner?: string | null; note?: string | null; title?: string },
  ): TaskItem | null {
    const task = this.tasks.find((t) => t.id === String(id).replace(/^#/, ""));
    if (!task) return null;
    if (patch.status) task.status = patch.status;
    if (patch.owner !== undefined) task.owner = patch.owner ? patch.owner.replace(/^@/, "") : null;
    if (patch.note !== undefined) task.note = patch.note?.trim() || null;
    if (patch.title) task.title = patch.title.trim().slice(0, 200);
    task.updatedAt = Date.now();
    this.changed();
    return task;
  }

  // ---- totals for the header and footer --------------------------------------------------------

  totals(): {
    agents: number;
    running: number;
    tokens: number;
    costUsd: number;
    added: number;
    removed: number;
    busyMs: number;
  } {
    let running = 0;
    let tokens = 0;
    let costUsd = 0;
    let added = 0;
    let removed = 0;
    let busyMs = 0;
    const now = Date.now();
    for (const a of this.agents) {
      if (a.busy) running++;
      tokens += a.tokensIn + a.tokensOut;
      costUsd += a.costUsd;
      added += a.linesAdded;
      removed += a.linesRemoved;
      busyMs += a.busyMs + (a.turnStartedAt !== null ? now - a.turnStartedAt : 0);
    }
    return { agents: this.agents.length, running, tokens, costUsd, added, removed, busyMs };
  }

  // ---- the team as tools see it ----------------------------------------------------------------

  teamApi(): TeamApi {
    return {
      members: () => this.agents.map((a) => memberOf(a)),
      send: (from, to, text) => this.send(from, to, text),
      spawn: async (by, spec) => {
        const spawner = this.findAgent(by) ?? null;
        const model = (spec.model && parseModelRef(spec.model)) || this.runtime.defaultWorkerModel(this, spawner);
        const agent = await this.addAgent({
          name: spec.name ?? "",
          role: "worker",
          label: spec.label,
          model,
          task: spec.task,
          spawnedBy: by,
          instructions: spec.instructions,
        });
        return agent.name;
      },
      stop: (by, name) => {
        const agent = this.findAgent(name);
        if (!agent || agent.role === "lead" || agent.name === by) return false;
        void this.removeAgent(agent);
        return true;
      },
      tasks: () => this.tasks.map((t) => ({ ...t })),
      addTask: (by, title, owner, note) => this.addTask(by, title, owner ?? null, note ?? null),
      updateTask: (by, id, patch) => this.updateTask(by, id, patch),
    };
  }
}

export function memberOf(a: Agent): TeamMember {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    label: a.label,
    model: a.modelLabel,
    status: a.status,
    activity: a.activity,
  };
}
