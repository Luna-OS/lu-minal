// Runs a Claude Code agent: one `claude -p` process in stream-json mode per agent, started in the
// project folder on the first message and kept alive between messages, so the conversation keeps
// its context. Its stream becomes the agent's log (text, reasoning, tool rows with diffs), usage and
// status; lu-minal's own tools and the permission prompts come through the MCP server.
//
// A process that dies, is interrupted the hard way or runs in an outdated permission mode is
// replaced by a new one with `--resume <sessionId>`, so the conversation goes on.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, AgentDriver, AgentInput } from "../../core/agent.js";
import { newId } from "../../core/emitter.js";
import type { Project } from "../../core/project.js";
import type { LogEntry } from "../../core/types.js";
import { workVerb } from "../../core/verbs.js";
import { approvalAnswer, assessClaudeTool } from "../../mcp/approve.js";
import { isWindows } from "../../platform/paths.js";
import { killTree, spawnProgram } from "../../platform/process.js";
import type { ToolDisplay } from "../../tools/types.js";
import {
  chatArgs,
  claudeEnv,
  claudePermissionMode,
  controlErrorLine,
  controlResponseLine,
  interruptLine,
  setPermissionModeLine,
  userMessageLine,
  type ClaudePermissionMode,
} from "./cli.js";
import { cleanResultText, contentBefore, describeClaudeTool, firstLine, toolResultDisplay } from "./display.js";
import { createLineParser, type ClaudeEvent, type ClaudeRateLimitEvent, type ClaudeResultEvent } from "./events.js";

/**
 * What the driver needs from lu-minal's MCP server (McpServer satisfies it). The optional methods
 * make the rows of lu-minal's own tools look like a native agent's.
 */
export interface McpLink {
  /** Gives the agent its MCP config file (for --mcp-config). */
  register(agent: Agent): Promise<{ configFile: string; serverName: string }>;
  unregister(agentId: string): void;
  /** The verb and target of one of lu-minal's tools, from the tool's own describe(). */
  describeTool?(agentId: string, name: string, args: Record<string, unknown>): { verb: string; target?: string } | null;
  /** The display of a finished call of one of lu-minal's tools. */
  takeDisplay?(
    agentId: string,
    call: { toolUseId: string; name: string; input: Record<string, unknown> },
  ): { display: ToolDisplay; isError: boolean } | null;
}

export interface ClaudeDriverDeps {
  agent: Agent;
  project: Project;
  /** The `claude` program (findClaude). */
  exe: string;
  mcp: McpLink;
  /** The team prompt, appended to Claude Code's system prompt (read at every process start). */
  systemPrompt: () => string;
  /** Every rate_limit_event of the stream (the Hub moves the plan usage with it). */
  onRateLimit?: (ev: ClaudeRateLimitEvent) => void;
  /** Starts the process (tests run a fake CLI); defaults to spawnProgram. */
  spawnImpl?: (exe: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** The environment the process inherits (claudeEnv is applied on top); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long interrupt() waits for the CLI to end the turn before it kills the process. */
  interruptGraceMs?: number;
  /**
   * After a result while more messages were sent during the turn: how long to wait for the CLI to
   * start on them before deciding it took them into the finished turn.
   */
  queueGraceMs?: number;
  /** For tests: the platform whose argument rules apply (cmd.exe shims need a prompt file). */
  platform?: NodeJS.Platform;
}

const STDERR_LINES = 20;
/** Windows' CreateProcess limit is 32767 characters; leave room for the rest of the line. */
const MAX_INLINE_PROMPT = 24_000;

interface ToolRow {
  entryId: string;
  name: string;
  input: Record<string, unknown>;
  before: string | null | undefined;
  luminal: boolean;
}

interface Run {
  child: ChildProcess;
  mode: ClaudePermissionMode;
  /** The session id passed to --resume, if any. */
  resumed: string | null;
  /** The init line arrived. */
  initialized: boolean;
  /** Replaced or killed on purpose: its exit is not an error and its lines are ignored. */
  retired: boolean;
  exited: boolean;
  /** The process's running total of total_cost_usd. */
  lastCost: number;
  /** Lines written before init (sent again when resuming fails). */
  sent: string[];
  /** Our control requests waiting for an answer. */
  controls: Map<string, { kind: "mode"; previous: ClaudePermissionMode } | { kind: "interrupt" }>;
  promptFile: string | null;
  warnedMcp: boolean;
  exitPromise: Promise<void>;
  markExited: () => void;
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

const LOGIN_TROUBLE = /invalid api key|please run \/login|not logged in|log in|authentication|oauth token|credit balance/i;
const RESUME_FAILED = /no conversation found|could not find (a )?(session|conversation)|session .*not found/i;

/** The error line for a failed result. */
function resultError(ev: ClaudeResultEvent): string {
  let text = ev.text.trim();
  if (!text) {
    switch (ev.subtype) {
      case "error_max_turns":
        text = "Claude Code stopped: it reached the maximum number of turns.";
        break;
      case "error_max_budget_usd":
        text = "Claude Code stopped: the budget for this session is used up.";
        break;
      case "error_during_execution":
        text = "Claude Code stopped with an error.";
        break;
      default:
        text = `Claude Code stopped${ev.subtype ? ` (${ev.subtype})` : ""}.`;
    }
  }
  if (LOGIN_TROUBLE.test(text)) text += "\nSign in with /login and pick Claude.";
  return text;
}

export class ClaudeCodeDriver implements AgentDriver {
  readonly kind = "claude-code" as const;

  private run: Run | null = null;
  private mcpConfig: { configFile: string; serverName: string } | null = null;
  private ready = false;
  private disposed = false;
  /** Messages handed over before start() finished. */
  private waiting: string[] = [];
  /** Messages handed over while an interrupt is settling (sent once it has). */
  private deferred: string[] = [];
  /** Messages written whose result has not arrived yet. */
  private outstanding = 0;
  private interrupting: { timer: NodeJS.Timeout } | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private readonly rows = new Map<string, ToolRow>();
  /** Tool calls of the running turn, to tell denials already shown on a row from others. */
  private readonly turnTools = new Set<string>();
  private stderrTail: string[] = [];
  /** The stream reported token usage this turn (the result's usage is only a fallback). */
  private streamedUsage = false;

  constructor(private readonly deps: ClaudeDriverDeps) {}

  private get agent(): Agent {
    return this.deps.agent;
  }

  /** The stderr lines kept for error reports (the last 20). */
  get stderr(): string[] {
    return [...this.stderrTail];
  }

  /** The running process's pid, if any (for diagnostics). */
  get pid(): number | null {
    return this.run && !this.run.exited ? (this.run.child.pid ?? null) : null;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    this.agent.setStatus("starting");
    try {
      this.mcpConfig = await this.deps.mcp.register(this.agent);
    } catch (err) {
      this.mcpConfig = null;
      this.agent.info(
        `lu-minal's team tools are not available to Claude (${err instanceof Error ? err.message : String(err)}). Permission prompts still reach you.`,
      );
    }
    if (this.disposed) return;
    this.ready = true;
    this.agent.setStatus("idle");
    const waiting = this.waiting.splice(0);
    if (waiting.length) {
      this.agent.startTurn();
      for (const text of waiting) this.write(text);
    }
  }

  send(input: AgentInput): void {
    if (this.disposed) return;
    const text = input.from === "you" ? input.text : `[message from ${input.from}] ${input.text}`;
    this.agent.startTurn();
    if (!this.ready) {
      this.waiting.push(text);
      return;
    }
    if (this.interrupting) {
      this.deferred.push(text);
      return;
    }
    this.write(text);
  }

  interrupt(): void {
    this.waiting = [];
    this.deferred = [];
    const run = this.run;
    if (!run || run.exited || this.outstanding === 0) {
      if (this.outstanding === 0 && this.agent.turnStartedAt !== null && !this.interrupting) this.agent.endTurn("idle");
      return;
    }
    if (this.interrupting) return;
    // Messages queued behind the turn would run after a soft interrupt, and a process that has not
    // started its turn may not listen yet: stop it outright (the next message resumes).
    if (this.outstanding > 1 || !run.initialized) {
      this.stopHard(run);
      return;
    }
    const requestId = newId("interrupt");
    run.controls.set(requestId, { kind: "interrupt" });
    const timer = setTimeout(() => {
      if (this.interrupting && this.run === run) this.stopHard(run);
    }, this.deps.interruptGraceMs ?? 3000);
    timer.unref?.();
    this.interrupting = { timer };
    if (!this.writeLine(run, interruptLine(requestId))) this.stopHard(run);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.waiting = [];
    this.deferred = [];
    this.clearTimers();
    const run = this.run;
    if (run) this.retire(run);
    if (this.outstanding > 0 || this.agent.turnStartedAt !== null) {
      this.outstanding = 0;
      this.agent.endTurn(this.agent.status === "stopped" ? "stopped" : "idle");
    }
    this.rows.clear();
    try {
      this.deps.mcp.unregister(this.agent.id);
    } catch {
      // nothing to clean up
    }
    if (run && !run.exited) {
      await Promise.race([run.exitPromise, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
    }
  }

  // ---- the process -----------------------------------------------------------------------------

  private write(text: string): void {
    const desired = claudePermissionMode(this.agent.permissionMode);
    let run = this.run;
    if (run && run.mode !== desired) {
      if (this.outstanding === 0 && !this.interrupting) {
        // Idle: restart in the new mode, on the same conversation.
        this.retire(run);
        run = null;
      } else {
        this.requestMode(run, desired);
      }
    }
    if (!run) {
      try {
        run = this.spawn();
      } catch (err) {
        this.agent.error(`Could not start Claude Code: ${err instanceof Error ? err.message : String(err)}`);
        this.outstanding = 0;
        this.agent.endTurn("error");
        return;
      }
    }
    this.clearQueueTimer();
    this.outstanding++;
    this.updateQueued();
    const line = userMessageLine(text);
    if (!run.initialized) run.sent.push(line);
    this.writeLine(run, line);
  }

  private writeLine(run: Run, line: string): boolean {
    const stdin = run.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || run.exited) return false;
    try {
      stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  private promptFileFor(prompt: string): string | null {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== "win32" || !prompt) return null;
    // cmd.exe can't carry a multi-line argument, and CreateProcess has a length limit.
    if (!/\.(cmd|bat)$/i.test(this.deps.exe) && prompt.length <= MAX_INLINE_PROMPT) return null;
    const dir = this.mcpConfig ? path.dirname(this.mcpConfig.configFile) : os.tmpdir();
    const file = path.join(dir, `${this.agent.id.replace(/[^A-Za-z0-9_-]/g, "_")}.prompt.md`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, prompt, { mode: 0o600 });
      return file;
    } catch {
      return null;
    }
  }

  private spawn(): Run {
    const { agent, project, exe } = this.deps;
    const mode = claudePermissionMode(agent.permissionMode);
    let prompt = "";
    try {
      prompt = this.deps.systemPrompt();
    } catch {
      prompt = "";
    }
    const promptFile = this.promptFileFor(prompt);
    const server = this.mcpConfig?.serverName;
    const resume = agent.sessionId ?? null;
    const args = chatArgs({
      model: agent.model.model,
      permissionMode: mode,
      resume: resume ?? undefined,
      mcpConfigFile: this.mcpConfig?.configFile,
      permissionPromptTool: server ? `mcp__${server}__approve` : undefined,
      allowedTools: server ? [`mcp__${server}`] : undefined,
      appendSystemPrompt: promptFile ? undefined : prompt,
      appendSystemPromptFile: promptFile ?? undefined,
    });
    const options: SpawnOptions = {
      cwd: project.cwd,
      env: claudeEnv(this.deps.env ?? process.env, exe),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so killTree ends Claude Code's shells too (taskkill /T on Windows).
      detached: !isWindows,
      windowsHide: true,
    };
    const child = (this.deps.spawnImpl ?? spawnProgram)(exe, args, options);
    let markExited = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const run: Run = {
      child,
      mode,
      resumed: resume,
      initialized: false,
      retired: false,
      exited: false,
      lastCost: 0,
      sent: [],
      controls: new Map(),
      promptFile,
      warnedMcp: false,
      exitPromise,
      markExited,
    };
    this.run = run;
    this.stderrTail = [];
    track(child);

    const parser = createLineParser((ev) => this.onEvent(run, ev));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => parser.push(chunk));
    let errBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      errBuffer += chunk;
      let nl: number;
      while ((nl = errBuffer.indexOf("\n")) >= 0) {
        const line = errBuffer.slice(0, nl).replace(/\r$/, "");
        errBuffer = errBuffer.slice(nl + 1);
        if (this.run === run) this.pushStderr(line);
      }
    });
    // A closed stdin (the process died) must not crash lu-minal.
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => this.onExit(run, null, null, err));
    child.on("close", (code, signal) => {
      parser.end();
      if (errBuffer && this.run === run) this.pushStderr(errBuffer);
      errBuffer = "";
      this.onExit(run, code, signal);
    });
    return run;
  }

  /** Ends a process on purpose (restart, hard interrupt, dispose). */
  private retire(run: Run): void {
    run.retired = true;
    if (this.run === run) this.run = null;
    try {
      run.child.stdin?.end();
    } catch {
      // already closed
    }
    if (!run.exited) killTree(run.child);
    this.removePromptFile(run);
  }

  private removePromptFile(run: Run): void {
    if (!run.promptFile) return;
    try {
      fs.rmSync(run.promptFile, { force: true });
    } catch {
      // not there
    }
    run.promptFile = null;
  }

  private onExit(run: Run, code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
    if (run.exited) return;
    run.exited = true;
    run.markExited();
    live.delete(run.child);
    this.removePromptFile(run);
    if (this.run === run) this.run = null;
    if (run.retired || this.disposed) return;

    const tail = this.stderrTail.join("\n").trim();
    if (!run.initialized && run.resumed && RESUME_FAILED.test(tail)) {
      this.resumeAfresh(run.sent.slice());
      return;
    }
    if (this.interrupting) {
      this.finishInterrupt();
      return;
    }
    const busy = this.outstanding > 0;
    this.outstanding = 0;
    this.clearTimers();
    const how = err ? err.message : signal ? `signal ${signal}` : `exit code ${code}`;
    const failed = Boolean(err) || signal !== null || (code !== null && code !== 0);
    if (!busy && !failed) return;
    const head = err && !run.initialized ? `Could not start Claude Code (${how}).` : `Claude Code stopped unexpectedly (${how}).`;
    let message = tail ? `${head}\n${tail}` : head;
    if (LOGIN_TROUBLE.test(tail)) message += "\nSign in with /login and pick Claude.";
    this.agent.error(message);
    if (busy) {
      this.endTurn("error");
    } else {
      this.agent.setStatus("error");
    }
  }

  /** The conversation to resume is gone: start a new one and send the messages (`lines`) again. */
  private resumeAfresh(lines: string[]): void {
    this.agent.sessionId = null;
    this.agent.info("The earlier Claude conversation could not be resumed; starting a new one.");
    if (!this.outstanding || !lines.length) {
      this.outstanding = 0;
      return;
    }
    let next: Run;
    try {
      next = this.spawn();
    } catch (err) {
      this.agent.error(`Could not start Claude Code: ${err instanceof Error ? err.message : String(err)}`);
      this.outstanding = 0;
      this.endTurn("error");
      return;
    }
    for (const line of lines) {
      next.sent.push(line);
      this.writeLine(next, line);
    }
  }

  private stopHard(run: Run): void {
    this.retire(run);
    this.clearTimers();
    this.interrupting = null;
    this.outstanding = 0;
    this.endTurn("idle");
    this.flushDeferred();
  }

  private finishInterrupt(): void {
    if (this.interrupting) clearTimeout(this.interrupting.timer);
    this.interrupting = null;
    this.outstanding = 0;
    this.endTurn("idle");
    this.flushDeferred();
  }

  /** Sends the messages that arrived while an interrupt was settling. */
  private flushDeferred(): void {
    const texts = this.deferred.splice(0);
    if (!texts.length || this.disposed) return;
    this.agent.startTurn();
    for (const text of texts) this.write(text);
  }

  private requestMode(run: Run, mode: ClaudePermissionMode): void {
    const id = newId("mode");
    run.controls.set(id, { kind: "mode", previous: run.mode });
    run.mode = mode;
    this.writeLine(run, setPermissionModeLine(id, mode));
  }

  // ---- the stream ------------------------------------------------------------------------------

  private onEvent(run: Run, ev: ClaudeEvent): void {
    if (run !== this.run || run.retired || this.disposed) return;
    if (ev.kind === "stderr") {
      this.pushStderr(ev.text);
      return;
    }
    if (ev.kind !== "rate-limit") this.clearQueueTimer();
    const agent = this.agent;
    switch (ev.kind) {
      case "init":
        run.initialized = true;
        run.sent = [];
        if (ev.sessionId) agent.sessionId = ev.sessionId;
        this.checkMcp(run, ev.mcpServers);
        return;
      case "status":
        if (ev.status === "compacting") agent.setActivity("Compacting");
        else if (agent.activity === "Compacting" && agent.turnStartedAt !== null) agent.setActivity(workVerb(agent.turnStartedAt));
        return;
      case "text-delta":
        this.ensureTurn();
        agent.endStream("reasoning");
        agent.appendStream("text", ev.text);
        return;
      case "thinking-delta":
        this.ensureTurn();
        agent.appendStream("reasoning", ev.text);
        return;
      case "text":
        this.ensureTurn();
        agent.endStream("reasoning");
        agent.endStream("text", ev.text);
        return;
      case "tool-use":
        this.ensureTurn();
        agent.closeStreams();
        this.toolUse(ev.id, ev.name, ev.input);
        return;
      case "tool-result":
        this.toolResult(ev.toolUseId, ev.text, ev.isError, ev.meta);
        return;
      case "context":
        this.streamedUsage = true;
        agent.addUsage({ input: ev.tokens, context: ev.tokens });
        return;
      case "output":
        this.streamedUsage = true;
        agent.addUsage({ output: ev.tokens });
        return;
      case "context-window":
        return;
      case "rate-limit":
        try {
          this.deps.onRateLimit?.(ev);
        } catch {
          // the listener's problem
        }
        return;
      case "result":
        this.result(run, ev);
        return;
      case "control-response": {
        const pending = ev.requestId ? run.controls.get(ev.requestId) : undefined;
        if (!pending || !ev.requestId) return;
        run.controls.delete(ev.requestId);
        // The CLI refused the mode switch: the next message restarts it in the right mode.
        if (pending.kind === "mode" && !ev.ok) run.mode = pending.previous;
        return;
      }
      case "control-request":
        void this.controlRequest(run, ev.requestId, ev.subtype, ev.request);
        return;
    }
  }

  /** Content outside a turn we started (the CLI went on by itself): it is a turn all the same. */
  private ensureTurn(): void {
    if (this.outstanding > 0 || this.interrupting) return;
    this.outstanding = 1;
    this.agent.startTurn();
  }

  private checkMcp(run: Run, servers: Array<{ name: string; status: string }>): void {
    const name = this.mcpConfig?.serverName;
    if (!name || run.warnedMcp) return;
    const server = servers.find((s) => s.name === name);
    if (server && /failed|needs-auth|error/i.test(server.status)) {
      run.warnedMcp = true;
      this.agent.info(`Claude could not reach lu-minal's team tools (MCP: ${server.status}).`);
    }
  }

  private isLuminal(name: string): string | null {
    const server = this.mcpConfig?.serverName ?? "luminal";
    const prefix = `mcp__${server}__`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : null;
  }

  private toolUse(id: string, name: string, input: Record<string, unknown>): void {
    if (this.rows.has(id)) return;
    const cwd = this.deps.project.cwd;
    const bare = this.isLuminal(name);
    let described: { verb: string; target?: string } | null = null;
    if (bare !== null) {
      try {
        described = this.deps.mcp.describeTool?.(this.agent.id, bare, input) ?? null;
      } catch {
        described = null;
      }
    }
    described ??= describeClaudeTool(name, input, cwd);
    const entry = this.agent.append({
      kind: "tool",
      toolCallId: id,
      name,
      verb: described.verb,
      target: described.target,
      status: "running",
    });
    this.rows.set(id, { entryId: entry.id, name, input, before: contentBefore(name, input, cwd), luminal: bare !== null });
    this.turnTools.add(id);
  }

  private toolResult(id: string, text: string, isError: boolean, meta: unknown): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    let display: ToolDisplay;
    let countLines = true;
    if (row.luminal) {
      // runToolCall (in the MCP server) already counted its lines.
      countLines = false;
      let found: { display: ToolDisplay; isError: boolean } | null = null;
      try {
        found = this.deps.mcp.takeDisplay?.(this.agent.id, { toolUseId: id, name: row.name, input: row.input }) ?? null;
      } catch {
        found = null;
      }
      display = { ...(found?.display ?? {}) };
      if (!display.detail) display.detail = firstLine(cleanResultText(text)) || (isError ? "failed" : "done");
    } else {
      display = toolResultDisplay(row.name, row.input, text, isError, this.deps.project.cwd, { before: row.before, meta });
    }
    const patch: Record<string, unknown> = { status: isError ? "error" : "ok" };
    for (const key of ["verb", "target", "detail", "diff", "added", "removed"] as const) {
      if (display[key] !== undefined) patch[key] = display[key];
    }
    this.agent.update(row.entryId, patch as Partial<LogEntry>);
    if (countLines && (display.added || display.removed)) this.agent.addLines(display.added ?? 0, display.removed ?? 0);
  }

  private result(run: Run, ev: ClaudeResultEvent): void {
    const agent = this.agent;
    // total_cost_usd is the process's running total: count only what this turn added.
    let cost = 0;
    if (ev.costUsd !== null) {
      cost = ev.costUsd >= run.lastCost ? ev.costUsd - run.lastCost : ev.costUsd;
      run.lastCost = ev.costUsd;
    }
    const usage =
      !this.streamedUsage && ev.usage
        ? { input: ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite, output: ev.usage.output }
        : {};
    agent.addUsage({ ...usage, costUsd: cost });
    this.streamedUsage = false;
    if (ev.sessionId) agent.sessionId = ev.sessionId;

    if (!ev.ok && !run.initialized && run.resumed && RESUME_FAILED.test(ev.text)) {
      const lines = run.sent.slice();
      this.retire(run);
      this.resumeAfresh(lines);
      return;
    }

    for (const d of ev.denials) {
      if (d.toolUseId && this.turnTools.has(d.toolUseId)) continue; // its row already says so
      const what = describeClaudeTool(d.tool, d.input, this.deps.project.cwd);
      agent.info(`Claude Code was not allowed to ${[what.verb, what.target].filter(Boolean).join(" ")}.`);
    }

    this.outstanding = Math.max(0, this.outstanding - 1);
    if (this.interrupting) {
      this.finishInterrupt();
      return;
    }
    if (this.outstanding > 0) {
      if (!ev.ok) agent.error(resultError(ev));
      this.updateQueued();
      this.startQueueTimer(run);
      return;
    }
    if (!ev.ok) agent.error(resultError(ev));
    this.endTurn(ev.ok ? "idle" : "error");
  }

  /** A permission request straight from the CLI (no permission-prompt tool): asked like any other. */
  private async controlRequest(run: Run, requestId: string, subtype: string, request: Record<string, unknown>): Promise<void> {
    if (subtype !== "can_use_tool") {
      this.writeLine(run, controlErrorLine(requestId, `lu-minal does not handle "${subtype || "this request"}".`));
      return;
    }
    const agent = this.agent;
    const toolName = typeof request.tool_name === "string" && request.tool_name ? request.tool_name : "tool";
    const input =
      request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? (request.input as Record<string, unknown>)
        : {};
    const assessed = assessClaudeTool(toolName, input, this.deps.project.cwd);
    let decision: string;
    try {
      decision = await agent.requestApproval({
        tool: toolName,
        risk: assessed.risk,
        summary: assessed.summary,
        detail: assessed.detail,
        allowKey: assessed.allowKey,
      });
    } catch {
      decision = "deny";
    }
    if (run.exited || run.retired) return;
    this.writeLine(run, controlResponseLine(requestId, approvalAnswer(decision !== "deny", input, agent.permissionMode)));
  }

  // ---- turns -----------------------------------------------------------------------------------

  private endTurn(status: "idle" | "error"): void {
    this.rows.clear();
    this.turnTools.clear();
    this.agent.queued = 0;
    this.agent.endTurn(status);
  }

  private updateQueued(): void {
    this.agent.queued = Math.max(0, this.outstanding - 1);
    this.agent.changed();
  }

  /**
   * More messages were written during the finished turn. If the CLI runs them as turns of their
   * own, its next lines come at once; if it took them into the finished turn, nothing comes.
   */
  private startQueueTimer(run: Run): void {
    this.clearQueueTimer();
    const timer = setTimeout(() => {
      this.queueTimer = null;
      if (this.run !== run || this.interrupting || this.outstanding === 0) return;
      this.outstanding = 0;
      this.endTurn("idle");
    }, this.deps.queueGraceMs ?? 10_000);
    timer.unref?.();
    this.queueTimer = timer;
  }

  private clearQueueTimer(): void {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
  }

  private clearTimers(): void {
    this.clearQueueTimer();
    if (this.interrupting) clearTimeout(this.interrupting.timer);
    this.interrupting = null;
  }

  private pushStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line.length > 500 ? `${line.slice(0, 499)}…` : line);
    if (this.stderrTail.length > STDERR_LINES) this.stderrTail.splice(0, this.stderrTail.length - STDERR_LINES);
  }
}
