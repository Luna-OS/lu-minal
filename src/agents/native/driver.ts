// The agent loop for API models: take the queued messages, stream the model's answer into the
// agent's log, run the tool calls it asked for, feed the results back, and repeat until the model
// stops calling tools (or the step budget runs out). Messages that arrive mid-turn are read at the
// next step; an interrupt keeps what was said so far.
import type { Agent, AgentDriver, AgentInput } from "../../core/agent.js";
import type { AgentStatus } from "../../core/types.js";
import type { Project } from "../../core/project.js";
import type { ResolvedModel } from "../../providers/models.js";
import { abortError, isQuotaExhausted, streamWithRetry, type RetryOptions } from "../../providers/retry.js";
import {
  ProviderError,
  type AssistantMessage,
  type ChatClient,
  type ChatMessage,
  type ChatRequest,
  type ToolCall,
  type ToolSpec,
  type ToolResultMessage,
} from "../../providers/types.js";
import { toolSpecs } from "../../tools/index.js";
import { createToolContext, runToolCall } from "../../tools/run.js";
import type { Tool, ToolResult, ToolServices } from "../../tools/types.js";
import {
  contextLimit,
  costOf,
  userMessageFor,
  loadConversation,
  saveConversation,
  trimToolResults,
  type SavedConversation,
} from "./context.js";

export interface NativeDriverDeps {
  agent: Agent;
  project: Project;
  /** Where and how to reach the agent's model; throws ProviderNotReadyError when it can't be used. */
  resolveModel: () => ResolvedModel;
  createClient: (resolved: ResolvedModel) => ChatClient;
  tools: Tool[];
  services: ToolServices;
  /** Called before every request (the roster may have changed). */
  systemPrompt: () => string;
  /** Requests per turn before the loop stops (default 100). */
  maxSteps?: number;
  retry?: RetryOptions;
}

const INTERRUPTED = "[interrupted by the user]";

/** Iterates `source`, giving up as soon as `signal` aborts (even when the source ignores it). */
async function* abortable<T>(source: AsyncGenerator<T, void, void>, signal: AbortSignal): AsyncGenerator<T, void, void> {
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const next = await Promise.race([source.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    source.return(undefined).catch(() => undefined);
  }
}

/** `promise`'s value, or null when `signal` aborts first. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function isNotReady(err: unknown): err is Error & { hint: string } {
  return err instanceof Error && err.name === "ProviderNotReadyError" && typeof (err as { hint?: unknown }).hint === "string";
}

/** The error line the panel shows. */
export function describeError(err: unknown): string {
  if (isNotReady(err)) return `${err.message} ${err.hint}`.trim();
  if (err instanceof ProviderError) {
    const hint =
      err.status === 401 || err.status === 403
        ? " Check the sign-in or API key (/login)."
        : err.status === 402
          ? " The account may be out of credits."
          : err.status === 404
            ? " Check the model id (/model)."
            : err.status === 413 || /context|too long|maximum.*tokens/i.test(err.message)
              ? " The conversation may be too long for this model; /clear it or pick a model with a bigger context."
              : err.status === 429 && isQuotaExhausted(err)
                ? " The free quota for your connection is used up. Try OpenRouter's free models (/login openrouter), add a key for this provider, or pick another model (/model)."
                : err.status === 429
                  ? " Rate limited; try again in a moment."
                  : "";
    return `${err.status} ${err.message}${hint}`;
  }
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** "429 rate limited" / "network error" for retry rows. */
function retryReason(err: unknown): string {
  if (err instanceof ProviderError) {
    const msg = err.message.length > 60 ? `${err.message.slice(0, 59)}…` : err.message;
    return `${err.status} ${msg}`;
  }
  if (err instanceof Error) return (err as { code?: string }).code ?? err.message;
  return String(err);
}

export class NativeDriver implements AgentDriver {
  readonly kind = "native" as const;
  private messages: ChatMessage[] = [];
  private queue: AgentInput[] = [];
  /** Inputs that were waiting when the user interrupted; they join the conversation unanswered. */
  private held: AgentInput[] = [];
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private interrupted = false;
  private disposed = false;
  /** Input tokens of the last request (the context's fill). */
  private lastInputTokens = 0;
  private readonly toolMap: Map<string, Tool>;
  private readonly specs: ToolSpec[];

  constructor(private readonly deps: NativeDriverDeps) {
    this.toolMap = new Map(deps.tools.map((t) => [t.name, t]));
    this.specs = toolSpecs(deps.tools);
  }

  /** The conversation so far (read-only view, for tests and debugging). */
  get conversation(): readonly ChatMessage[] {
    return this.messages;
  }

  /** Whether a turn is running. */
  get busy(): boolean {
    return this.running !== null;
  }

  async start(): Promise<void> {
    const { agent } = this.deps;
    try {
      this.deps.resolveModel();
      if (!this.running) agent.setStatus("idle");
    } catch (err) {
      agent.error(describeError(err));
      if (!this.running) agent.setStatus("error");
    }
  }

  send(input: AgentInput): void {
    if (this.disposed) return;
    this.queue.push(input);
    this.deps.agent.queued = this.queue.length;
    this.deps.agent.changed();
    this.kick();
  }

  interrupt(): void {
    const controller = this.controller;
    if (!controller || controller.signal.aborted) return;
    this.interrupted = true;
    this.held.push(...this.queue.splice(0));
    this.deps.agent.queued = 0;
    controller.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue = [];
    this.deps.agent.queued = 0;
    this.controller?.abort();
    const running = this.running;
    if (running) {
      await Promise.race([running, new Promise<void>((r) => setTimeout(r, 3000).unref())]);
    }
  }

  snapshot(): SavedConversation {
    return saveConversation(this.messages);
  }

  restore(state: unknown): void {
    if (this.running) return;
    const messages = loadConversation(state);
    if (messages) this.messages = messages;
  }

  /** Resolves when no turn is running any more (the next queued turn included). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  // ---- the loop --------------------------------------------------------------------------------

  private kick(): void {
    if (this.running || this.disposed || !this.queue.length) return;
    const run: Promise<void> = this.runTurn()
      .catch(() => undefined)
      .finally(() => {
        if (this.running === run) this.running = null;
        this.kick();
      });
    this.running = run;
  }

  /** Whether the agent's model takes pictures (false while it can't be resolved). */
  private canSee(): boolean {
    try {
      return this.deps.resolveModel().model.vision === true;
    } catch {
      return false;
    }
  }

  /** Moves the queued inputs into the conversation. */
  private takeQueue(): void {
    const vision = this.canSee();
    for (const input of this.queue.splice(0)) this.messages.push(userMessageFor(input, vision));
    this.deps.agent.queued = 0;
  }

  private finishTurn(status: AgentStatus): void {
    const { agent } = this.deps;
    agent.queued = this.queue.length;
    agent.endTurn(agent.status === "stopped" ? "stopped" : status);
  }

  private async runTurn(): Promise<void> {
    const { agent } = this.deps;
    const controller = new AbortController();
    this.controller = controller;
    this.interrupted = false;
    const signal = controller.signal;
    agent.startTurn();
    let phase: "setup" | "stream" | "tools" = "setup";
    let partial = "";
    try {
      // Taken first, so a turn that fails to start doesn't leave them queued (and retried forever).
      this.takeQueue();
      // Resolved per turn: the user may have signed in since the last one.
      const resolved = this.deps.resolveModel();
      const client = this.deps.createClient(resolved);
      const maxSteps = this.deps.maxSteps ?? 100;
      for (let step = 0; ; step++) {
        if (step >= maxSteps) {
          agent.info(`Stopped after ${maxSteps} steps. Send a message to let it go on.`);
          break;
        }
        this.takeQueue();
        this.manageContext(resolved);
        phase = "stream";
        partial = "";
        const { message, stopReason } = await this.streamStep(client, resolved, signal, (t) => {
          partial += t;
        });
        this.messages.push(message);
        partial = "";
        const calls = message.toolCalls ?? [];
        if (calls.length) {
          phase = "tools";
          // At the output limit the last call's arguments may be cut off (and "repaired" into
          // something that parses), so it is not run: a half-written file is worse than none.
          const truncated = stopReason === "max_tokens" ? calls[calls.length - 1] : null;
          await this.runTools(truncated ? calls.slice(0, -1) : calls, signal);
          if (truncated) {
            agent.info("The answer hit the output limit; its last tool call was not run.");
            this.messages.push(
              this.resultMessage(truncated, {
                content:
                  "Not run: your answer reached the output token limit, so this call's arguments may be incomplete. " +
                  "Split the work into smaller steps (e.g. several edit_file calls instead of one large write_file).",
                isError: true,
              }),
            );
          }
        }
        if (signal.aborted) throw abortError();
        phase = "setup";
        if (!calls.length && !this.queue.length) break;
      }
      this.finishTurn("idle");
    } catch (err) {
      if (signal.aborted || this.interrupted) {
        if (phase === "stream") {
          const text = partial.trimEnd();
          this.messages.push({ role: "assistant", content: text ? `${text}\n\n${INTERRUPTED}` : INTERRUPTED });
        } else if (phase === "tools") {
          const last = this.messages[this.messages.length - 1];
          if (last?.role === "tool" && !last.content.includes(INTERRUPTED)) last.content += `\n${INTERRUPTED}`;
        }
        for (const input of this.held.splice(0)) this.messages.push(userMessageFor(input, this.canSee()));
        if (!this.disposed) agent.info("Interrupted.");
        this.finishTurn("idle");
      } else {
        // Keep what the user already saw, so the next turn knows it was said.
        if (phase === "stream" && partial.trim()) {
          this.messages.push({ role: "assistant", content: `${partial.trimEnd()}\n\n[the answer was cut off by an error]` });
        }
        agent.error(describeError(err));
        this.finishTurn("error");
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.held = [];
    }
  }

  /** Drops old tool output when the last request filled most of the context window. */
  private manageContext(resolved: ResolvedModel): void {
    if (this.lastInputTokens <= contextLimit(resolved.model)) return;
    const trimmed = trimToolResults(this.messages);
    if (trimmed) this.deps.agent.info(`Context is getting full: removed the output of ${trimmed} old tool calls.`);
  }

  /** One request: streams the answer into the log and returns the finished assistant message. */
  private async streamStep(
    client: ChatClient,
    resolved: ResolvedModel,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<{ message: AssistantMessage; stopReason: string }> {
    const { agent } = this.deps;
    const request: ChatRequest = {
      model: resolved.model.id || resolved.ref.model,
      system: this.deps.systemPrompt(),
      messages: [...this.messages],
      tools: this.specs,
      maxTokens: Math.min(resolved.model.maxOutput ?? 16_384, 32_000),
      signal,
    };
    const retry: RetryOptions = {
      ...this.deps.retry,
      signal,
      onRetry: (error, attempt, delayMs) => {
        agent.info(`retrying in ${Math.max(1, Math.round(delayMs / 1000))}s (${retryReason(error)})`);
        this.deps.retry?.onRetry?.(error, attempt, delayMs);
      },
    };
    let final: AssistantMessage | null = null;
    let stopReason = "end_turn";
    let streamedText = false;
    for await (const ev of abortable(streamWithRetry(client, request, retry), signal)) {
      switch (ev.type) {
        case "text":
          if (!ev.text) break;
          streamedText = true;
          onText(ev.text);
          agent.appendStream("text", ev.text);
          break;
        case "reasoning":
          agent.appendStream("reasoning", ev.text);
          break;
        case "usage": {
          this.lastInputTokens = ev.inputTokens;
          agent.addUsage({
            input: ev.inputTokens,
            output: ev.outputTokens,
            context: ev.inputTokens + ev.outputTokens,
            costUsd: costOf(ev, resolved.model.cost),
          });
          break;
        }
        case "done":
          final = ev.message;
          stopReason = ev.stopReason;
          break;
        default:
          break;
      }
    }
    if (signal.aborted) throw abortError();
    if (!final) throw new Error("The model's answer ended early (no final message).");
    if (streamedText) agent.endStream("text");
    else if (final.content) agent.endStream("text", final.content);
    agent.closeStreams();
    return { message: final, stopReason };
  }

  /** Runs the calls one after another and appends a result message for each. */
  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    const { agent, project, services } = this.deps;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (signal.aborted) {
        for (const rest of calls.slice(i)) {
          this.messages.push(this.resultMessage(rest, { content: "Not run: the user interrupted.", isError: true }));
        }
        return;
      }
      const ctx = createToolContext({ agent, project, services, signal });
      const pending = runToolCall({
        agent,
        tool: this.toolMap.get(call.name),
        name: call.name,
        toolCallId: call.id,
        args: call.arguments,
        ctx,
      });
      const result = (await unlessAborted(pending, signal)) ?? { content: "Interrupted by the user.", isError: true };
      this.messages.push(this.resultMessage(call, result));
    }
  }

  private resultMessage(call: ToolCall, result: ToolResult): ToolResultMessage {
    const message: ToolResultMessage = { role: "tool", toolCallId: call.id, name: call.name, content: result.content };
    if (result.isError) message.isError = true;
    return message;
  }
}
