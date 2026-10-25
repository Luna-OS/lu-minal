// A JSON-RPC 2.0 peer over a pair of streams, as the Agent Client Protocol uses it: one JSON message
// per line (newline-delimited JSON) on the agent's stdin and stdout. Both sides send requests, so
// the peer matches responses to its own requests by id and answers the other side's requests with
// async handlers. Lines may end in CRLF and arrive in any pieces; stray non-JSON lines (a CLI that
// prints a warning to stdout) are handed to `onStray` instead of breaking the stream.
import type { Readable, Writable } from "node:stream";

export type JsonRpcId = string | number;

/** The standard error codes, plus the ones ACP adds. */
export const RPC_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** ACP: the request was cancelled ($/cancel_request). */
  cancelled: -32800,
  /** ACP: the agent needs `authenticate` first. */
  authRequired: -32000,
  /** ACP: a session, file or other resource is unknown. */
  notFound: -32002,
} as const;

/** An error answer from the other side, or one a handler throws to answer with a specific code. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** The connection closed (the process ended) before the answer came. */
export class RpcClosedError extends Error {
  constructor(message = "The connection closed.") {
    super(message);
    this.name = "RpcClosedError";
  }
}

/** A request of ours took longer than its timeout. */
export class RpcTimeoutError extends Error {
  constructor(readonly method: string, ms: number) {
    super(`${method} got no answer within ${Math.round(ms / 1000)} s.`);
    this.name = "RpcTimeoutError";
  }
}

export type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface RpcPeerOptions {
  /** Where messages come from (the child's stdout). */
  input: Readable;
  /** Where messages go (the child's stdin). */
  output: Writable;
  /** Answers the other side's requests; an unknown method should throw RpcError(methodNotFound). */
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  /** A line that is not JSON-RPC (logged by the caller). */
  onStray?: (line: string) => void;
  /** Every message in and out, for debugging. */
  trace?: (direction: "in" | "out", message: unknown) => void;
  /**
   * Close when the input ends (default true). A caller that watches the process itself turns this
   * off and calls close() with a better reason (the exit code and stderr).
   */
  closeOnEnd?: boolean;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  cleanup: () => void;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const validId = (v: unknown): v is JsonRpcId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Splits a stream of text into lines (LF or CRLF), keeping a partial last line until it ends. */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    },
    end() {
      const rest = buffer.replace(/\r$/, "");
      buffer = "";
      if (rest.trim()) onLine(rest);
    },
  };
}

/** The error text of a JSON-RPC error object, with its data when it says more. */
export function describeRpcError(err: unknown): string {
  if (err instanceof RpcError) {
    const data = err.data;
    let extra = "";
    if (typeof data === "string" && data.trim() && !err.message.includes(data.trim())) extra = data.trim();
    else if (isObj(data)) {
      const detail = [data.message, data.details, data.error].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      if (detail && !err.message.includes(detail.trim())) extra = detail.trim();
    }
    return extra ? `${err.message}: ${extra}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  /** The other side's requests we are working on, by id (for $/cancel_request and close). */
  private readonly incoming = new Map<JsonRpcId, AbortController>();
  private closedWith: Error | null = null;
  private readonly splitter: ReturnType<typeof createLineSplitter>;
  private readonly onData = (chunk: Buffer | string) => this.splitter.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  private readonly onEnd = () => {
    this.splitter.end();
    if (this.opts.closeOnEnd !== false) this.close(new RpcClosedError());
  };

  constructor(private readonly opts: RpcPeerOptions) {
    this.splitter = createLineSplitter((line) => this.onLine(line));
    if (typeof (opts.input as { setEncoding?: unknown }).setEncoding === "function") opts.input.setEncoding("utf8");
    opts.input.on("data", this.onData);
    opts.input.on("end", this.onEnd);
    opts.input.on("close", this.onEnd);
    // A closed pipe (the process died) must not crash lu-minal.
    opts.output.on("error", () => this.close(new RpcClosedError()));
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  /** Requests of ours still waiting for an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Sends a request and resolves to its result; rejects with RpcError for an error answer,
   * RpcClosedError when the connection ends first, RpcTimeoutError after `timeoutMs`, or the
   * signal's reason when `signal` aborts (the request is then forgotten, not cancelled remotely).
   */
  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error(`${method} was aborted.`));
      };
      const entry: Pending = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
        cleanup: () => {
          if (entry.timer) clearTimeout(entry.timer);
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          entry.cleanup();
          reject(new RpcTimeoutError(method, opts.timeoutMs!));
        }, opts.timeoutMs);
        entry.timer.unref?.();
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error(`${method} was aborted.`));
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, entry);
      const message: Obj = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      if (!this.send(message)) {
        this.pending.delete(id);
        entry.cleanup();
        reject(this.closedWith ?? new RpcClosedError());
      }
    });
  }

  /** Sends a notification (no answer). Returns false when the connection is gone. */
  notify(method: string, params?: unknown): boolean {
    if (this.closedWith) return false;
    const message: Obj = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    return this.send(message);
  }

  /** Ends the connection: every waiting request rejects with `reason`, running handlers are aborted. */
  close(reason: Error = new RpcClosedError()): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    this.opts.input.off("data", this.onData);
    this.opts.input.off("end", this.onEnd);
    this.opts.input.off("close", this.onEnd);
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.cleanup();
      p.reject(reason);
    }
    for (const c of this.incoming.values()) c.abort();
    this.incoming.clear();
  }

  // ---- internals -------------------------------------------------------------------------------

  private send(message: Obj): boolean {
    const out = this.opts.output as Writable & { destroyed?: boolean; writableEnded?: boolean };
    if (out.destroyed || out.writableEnded) return false;
    try {
      this.opts.trace?.("out", message);
      out.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.opts.onStray?.(line);
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of messages) this.onMessage(m, line);
  }

  private onMessage(m: unknown, line: string): void {
    if (!isObj(m) || (m.jsonrpc !== undefined && m.jsonrpc !== "2.0")) {
      this.opts.onStray?.(line);
      return;
    }
    this.opts.trace?.("in", m);
    if (typeof m.method === "string") {
      if (m.id === undefined || m.id === null) {
        this.onNotification(m.method, m.params);
        return;
      }
      if (!validId(m.id)) {
        this.send({ jsonrpc: "2.0", id: null, error: { code: RPC_CODES.invalidRequest, message: "Invalid request id" } });
        return;
      }
      void this.onRequest(m.id, m.method, m.params);
      return;
    }
    if ("result" in m || "error" in m) {
      if (!validId(m.id)) return; // an error about something we can't place
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      p.cleanup();
      if ("error" in m && m.error !== undefined && m.error !== null) {
        const e = isObj(m.error) ? m.error : {};
        const code = typeof e.code === "number" ? e.code : RPC_CODES.internal;
        const message = typeof e.message === "string" && e.message ? e.message : `${p.method} failed`;
        p.reject(new RpcError(code, message, e.data));
      } else {
        p.resolve(m.result);
      }
      return;
    }
    this.opts.onStray?.(line);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "$/cancel_request") {
      const id = isObj(params) ? params.requestId : undefined;
      if (validId(id)) this.incoming.get(id)?.abort();
      return;
    }
    try {
      this.opts.onNotification?.(method, params);
    } catch {
      // the listener's problem
    }
  }

  private async onRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    this.incoming.set(id, controller);
    let reply: Obj;
    try {
      if (!this.opts.onRequest) throw new RpcError(RPC_CODES.methodNotFound, `Method not found: ${method}`);
      const result = await this.opts.onRequest(method, params, controller.signal);
      reply = { jsonrpc: "2.0", id, result: result === undefined ? null : result };
    } catch (err) {
      const error: Obj =
        err instanceof RpcError
          ? { code: err.code, message: err.message }
          : { code: RPC_CODES.internal, message: err instanceof Error ? err.message : String(err) };
      if (err instanceof RpcError && err.data !== undefined) error.data = err.data;
      reply = { jsonrpc: "2.0", id, error };
    } finally {
      this.incoming.delete(id);
    }
    if (!this.closedWith) this.send(reply);
  }
}
