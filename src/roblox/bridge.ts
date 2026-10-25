// The Roblox Studio bridge: a small HTTP server on 127.0.0.1 that the lu-minal Studio plugin
// long-polls for commands. Agents call `call(command, args)`; the command waits in a queue until
// the plugin's next GET /poll picks it up, and the plugin posts the answer to /result. Studio's
// output (LogService) arrives in batches on /log.
//
// Security: the server binds to loopback only, every request must carry the X-LuMinal-Plugin
// header, and requests that look like they come from a browser (an Origin or Sec-Fetch-Site header,
// a Host that is not loopback) are refused with 403. A web page therefore can't pose as the plugin
// (custom headers need a CORS preflight, which is never approved), and DNS rebinding fails on Host.
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { PLUGIN_VERSION } from "./plugin-source.js";
import { DEFAULT_ROBLOX_PORT, PLUGIN_HEADER, notConnectedMessage } from "./protocol.js";
import type { RobloxApi, RobloxLogLine, RobloxStatus } from "./types.js";

export interface RobloxBridgeOptions {
  /** Default 44766; 0 picks a free port (status().port tells which). */
  port?: number;
  /** Default "127.0.0.1". Only loopback addresses are accepted. */
  host?: string;
  /** How long GET /poll waits for a command before answering 204 (default 25 000 ms). */
  pollTimeoutMs?: number;
  /** A plugin counts as connected this long after its last request (default 15 000 ms). */
  connectedWindowMs?: number;
  /** How many output lines to keep (default 500). */
  maxOutput?: number;
}

/** The bridge's status: the shared RobloxStatus plus what the plugin said about itself. */
export interface RobloxBridgeStatus extends RobloxStatus {
  /** The connected plugin's version, from its hello. */
  pluginVersion: string | null;
  /** The plugin is older or newer than the one this lu-minal ships (reinstall it). */
  pluginOutdated: boolean;
}

interface PendingPoll {
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

interface Session {
  id: string;
  /** Hello order: the newest live session gets the commands. */
  seq: number;
  place: { name: string; placeId: number; gameId: number };
  studioVersion: string | null;
  pluginVersion: string | null;
  lastSeen: number;
  poll: PendingPoll | null;
}

interface PendingCall {
  id: string;
  command: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  /** The session it was handed to, once a poll picked it up. */
  sessionId: string | null;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Node lower-cases incoming header names. */
const PLUGIN_HEADER_LOWER = PLUGIN_HEADER.toLowerCase();
const MAX_LINE_CHARS = 8000;
/** Sessions that stopped talking are forgotten after this long. */
const SESSION_TTL_MS = 10 * 60_000;

/** Whether `host` (an address or a Host header without the port) is the loopback interface. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::ffff:127.0.0.1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The host part of a Host header ("127.0.0.1:44766" -> "127.0.0.1", "[::1]:44766" -> "::1"). */
function hostOfHeader(value: string): string {
  const v = value.trim();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end > 0 ? v.slice(1, end) : v;
  }
  const colon = v.lastIndexOf(":");
  return colon >= 0 && v.indexOf(":") === colon ? v.slice(0, colon) : v;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Milliseconds since the epoch; accepts seconds (os.time()) too. */
function timestamp(value: unknown, now: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return now;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The bridge to Roblox Studio (see the file header). One instance per lu-minal; the Hub starts it
 * when `roblox.enabled` is set and gives it to the tools as `services.roblox`.
 */
export class RobloxBridge implements RobloxApi {
  private port: number;
  private readonly host: string;
  private readonly pollTimeoutMs: number;
  private readonly connectedWindowMs: number;
  private readonly maxOutput: number;

  private server: http.Server | null = null;
  private starting: Promise<void> | null = null;
  private boundPort: number | null = null;
  private listening = false;
  private error: string | null = null;
  private readonly sockets = new Set<Socket>();

  private readonly sessions = new Map<string, Session>();
  private sessionSeq = 0;
  private callSeq = 0;
  private readonly queue: PendingCall[] = [];
  private readonly inflight = new Map<string, PendingCall>();
  private lastSeen: number | null = null;

  private log: RobloxLogLine[] = [];
  private readonly listeners = new Set<() => void>();
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(opts: RobloxBridgeOptions = {}) {
    this.port = opts.port ?? DEFAULT_ROBLOX_PORT;
    this.host = opts.host ?? "127.0.0.1";
    this.pollTimeoutMs = Math.max(10, opts.pollTimeoutMs ?? 25_000);
    this.connectedWindowMs = Math.max(10, opts.connectedWindowMs ?? 15_000);
    this.maxOutput = Math.max(1, opts.maxOutput ?? 500);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /**
   * Starts listening. Never throws: when the port is taken (EADDRINUSE) or anything else fails,
   * `status().error` says why and `listening` stays false. Calling it while running does nothing.
   */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.listen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async listen(): Promise<void> {
    if (!isLoopbackHost(this.host)) {
      this.error = `Refusing to listen on ${this.host}: the Studio bridge only binds to loopback (127.0.0.1 or ::1).`;
      this.listening = false;
      this.changed();
      return;
    }
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    // Long polls hold requests open; Node's request timeout only covers receiving the request.
    server.keepAliveTimeout = 30_000;
    await new Promise<void>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        this.error =
          err.code === "EADDRINUSE"
            ? `Port ${this.port} is already in use (is another lu-minal running?). Change roblox.port in the settings and reinstall the plugin.`
            : err.code === "EACCES"
              ? `Not allowed to listen on port ${this.port}. Choose another roblox.port in the settings.`
              : `Could not listen on ${this.host}:${this.port}: ${err.message}`;
        this.listening = false;
        resolve();
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const address = server.address() as AddressInfo | null;
        this.boundPort = address?.port ?? this.port;
        this.server = server;
        this.listening = true;
        this.error = null;
        server.on("error", (err) => {
          this.error = errorText(err);
          this.changed();
        });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(this.port, this.host);
      } catch (err) {
        onError(err as NodeJS.ErrnoException);
      }
    });
    this.changed();
  }

  /** Stops the server: open polls are closed and every pending call is rejected. */
  async stop(): Promise<void> {
    if (this.starting) await this.starting;
    const server = this.server;
    this.server = null;
    this.listening = false;
    this.boundPort = null;
    this.error = null;
    for (const session of this.sessions.values()) this.endPoll(session, 503);
    this.sessions.clear();
    this.rejectAll("The Roblox Studio bridge stopped.");
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await closed;
    }
    this.changed();
  }

  /** Changes the port; takes effect at the next start(). */
  setPort(port: number): void {
    this.port = port;
  }

  // ---- RobloxApi -------------------------------------------------------------------------------

  status(): RobloxBridgeStatus {
    const active = this.listening ? this.activeSession() : null;
    return {
      listening: this.listening,
      port: this.boundPort ?? this.port,
      connected: active !== null,
      place: active ? { ...active.place } : null,
      studioVersion: active?.studioVersion ?? null,
      lastSeen: this.lastSeen,
      error: this.error,
      pluginVersion: active?.pluginVersion ?? null,
      pluginOutdated: Boolean(active?.pluginVersion && active.pluginVersion !== PLUGIN_VERSION),
    };
  }

  /**
   * Sends `command` to the connected plugin and resolves with its result. Rejects right away when
   * no plugin is connected (with how to connect one), after `timeoutMs` (a command no poll picked
   * up is dropped), or with the plugin's error message.
   */
  call<T = unknown>(command: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.listening || !this.activeSession()) {
      return Promise.reject(new Error(notConnectedMessage(this.status())));
    }
    return new Promise<T>((resolve, reject) => {
      const id = `${++this.callSeq}-${randomUUID().slice(0, 8)}`;
      const call: PendingCall = {
        id,
        command,
        args: args ?? {},
        timeoutMs,
        sessionId: null,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => this.timeOut(call), Math.max(1, timeoutMs)),
      };
      call.timer.unref?.();
      this.queue.push(call);
      this.pump();
    });
  }

  output(limit?: number): RobloxLogLine[] {
    const n = limit === undefined ? this.log.length : Math.max(0, Math.floor(limit));
    return this.log.slice(Math.max(0, this.log.length - n)).map((line) => ({ ...line }));
  }

  /** Forgets the collected output. */
  clearOutput(): void {
    if (!this.log.length) return;
    this.log = [];
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- sessions and the queue ------------------------------------------------------------------

  private alive(session: Session, now = Date.now()): boolean {
    if (session.poll) return true;
    for (const call of this.inflight.values()) if (call.sessionId === session.id) return true;
    return now - session.lastSeen <= this.connectedWindowMs;
  }

  /** The newest session that is still talking to us; commands go there. */
  private activeSession(): Session | null {
    const now = Date.now();
    let best: Session | null = null;
    for (const session of this.sessions.values()) {
      if (!this.alive(session, now)) {
        if (now - session.lastSeen > SESSION_TTL_MS) this.sessions.delete(session.id);
        continue;
      }
      if (!best || session.seq > best.seq) best = session;
    }
    return best;
  }

  private touch(session: Session): void {
    session.lastSeen = Date.now();
    this.lastSeen = session.lastSeen;
  }

  /** Hands the next queued command to the active session's open poll. */
  private pump(): void {
    if (!this.queue.length) return;
    const active = this.activeSession();
    if (!active?.poll) return;
    const call = this.queue.shift()!;
    const poll = active.poll;
    active.poll = null;
    clearTimeout(poll.timer);
    call.sessionId = active.id;
    this.inflight.set(call.id, call);
    this.touch(active);
    this.send(poll.res, 200, { id: call.id, command: call.command, args: call.args });
  }

  private timeOut(call: PendingCall): void {
    const queued = this.queue.indexOf(call);
    if (queued >= 0) this.queue.splice(queued, 1);
    const wasInflight = this.inflight.delete(call.id);
    if (queued < 0 && !wasInflight) return;
    const seconds = Math.round(call.timeoutMs / 100) / 10;
    call.reject(
      new Error(
        queued >= 0
          ? `Roblox Studio did not pick up "${call.command}" within ${seconds}s; the command was dropped. Is Studio busy or paused?`
          : `Roblox Studio did not answer "${call.command}" within ${seconds}s (it may still be running in Studio).`,
      ),
    );
    this.changed();
  }

  private endPoll(session: Session, status: number): void {
    const poll = session.poll;
    if (!poll) return;
    session.poll = null;
    clearTimeout(poll.timer);
    if (!poll.res.writableEnded && !poll.res.destroyed) {
      poll.res.statusCode = status;
      poll.res.end();
    }
  }

  private dropSession(session: Session, reason: string): void {
    this.endPoll(session, 204);
    this.sessions.delete(session.id);
    for (const call of [...this.inflight.values()]) {
      if (call.sessionId !== session.id) continue;
      this.inflight.delete(call.id);
      clearTimeout(call.timer);
      call.reject(new Error(`${reason} The command "${call.command}" may not have finished.`));
    }
    if (!this.activeSession()) {
      for (const call of this.queue.splice(0)) {
        clearTimeout(call.timer);
        call.reject(new Error(`${reason} The command "${call.command}" was not sent.`));
      }
    } else {
      this.pump();
    }
  }

  private rejectAll(reason: string): void {
    for (const call of [...this.queue.splice(0), ...this.inflight.values()]) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    this.inflight.clear();
  }

  // ---- notifications ---------------------------------------------------------------------------

  private changed(): void {
    this.scheduleWatch();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not break the bridge.
      }
    }
  }

  /**
   * "connected" also flips by itself when a plugin goes quiet; a timer notices that moment. Polls
   * and running commands end with events of their own, so only quiet sessions need the timer.
   */
  private scheduleWatch(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (!this.listening) return;
    const now = Date.now();
    let expires = 0;
    for (const session of this.sessions.values()) {
      if (!this.alive(session, now)) continue;
      if (session.poll || [...this.inflight.values()].some((c) => c.sessionId === session.id)) return;
      expires = Math.max(expires, session.lastSeen + this.connectedWindowMs);
    }
    if (!expires) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.changed();
    }, Math.max(5, expires - now + 5));
    this.watchTimer.unref?.();
  }

  // ---- HTTP ------------------------------------------------------------------------------------

  private send(res: http.ServerResponse, status: number, body?: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.statusCode = status;
    res.setHeader("Cache-Control", "no-store");
    if (body === undefined) {
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.end(text);
  }

  /** Why a request is refused, or null when it may pass. */
  private refusal(req: http.IncomingMessage): string | null {
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
      return "Requests from web pages are not allowed.";
    }
    const host = req.headers.host;
    if (host !== undefined && !isLoopbackHost(hostOfHeader(host))) return "Only loopback hosts are allowed.";
    if (req.method === "OPTIONS") return "Cross-origin requests are not allowed.";
    const marker = req.headers[PLUGIN_HEADER_LOWER];
    if (typeof marker !== "string" || !marker.trim()) return `Missing the ${PLUGIN_HEADER} header.`;
    return null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const refusal = this.refusal(req);
    if (refusal) {
      req.resume();
      this.send(res, 403, { ok: false, error: refusal });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      this.send(res, 400, { ok: false, error: "Bad URL." });
      return;
    }
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
    switch (route) {
      case "GET /poll":
        req.resume();
        this.onPoll(url, res);
        return;
      case "GET /status":
        req.resume();
        this.send(res, 200, { ok: true, ...this.status() });
        return;
      case "POST /hello":
      case "POST /result":
      case "POST /log":
      case "POST /bye":
        this.readJson(req, res, (body) => {
          if (route === "POST /hello") this.onHello(body, res);
          else if (route === "POST /result") this.onResult(body, res);
          else if (route === "POST /log") this.onLog(body, res);
          else this.onBye(body, res);
        });
        return;
      default:
        req.resume();
        this.send(res, 404, { ok: false, error: `No route ${route}.` });
    }
  }

  private readJson(req: http.IncomingMessage, res: http.ServerResponse, then: (body: Record<string, unknown>) => void): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        this.send(res, 413, { ok: false, error: "Request body too large." });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          this.send(res, 400, { ok: false, error: "The body is not valid JSON." });
          return;
        }
      }
      if (!isObject(body)) {
        // Roblox encodes an empty table as [].
        body = {};
      }
      try {
        then(body as Record<string, unknown>);
      } catch (err) {
        this.send(res, 500, { ok: false, error: errorText(err) });
      }
    });
    req.on("error", () => undefined);
  }

  private sessionFrom(value: unknown): Session | undefined {
    return typeof value === "string" ? this.sessions.get(value) : undefined;
  }

  private onHello(body: Record<string, unknown>, res: http.ServerResponse): void {
    const place = isObject(body.place) ? body.place : {};
    const session: Session = {
      id: randomUUID(),
      seq: ++this.sessionSeq,
      place: { name: str(place.name, "Place"), placeId: num(place.placeId), gameId: num(place.gameId) },
      studioVersion: strOrNull(body.studioVersion),
      pluginVersion: strOrNull(body.pluginVersion),
      lastSeen: Date.now(),
      poll: null,
    };
    this.touch(session);
    this.sessions.set(session.id, session);
    this.send(res, 200, {
      ok: true,
      session: session.id,
      pollTimeoutMs: this.pollTimeoutMs,
      pluginVersion: PLUGIN_VERSION,
    });
    this.changed();
  }

  private onPoll(url: URL, res: http.ServerResponse): void {
    const session = this.sessionFrom(url.searchParams.get("session"));
    if (!session) {
      this.send(res, 409, { ok: false, error: "Unknown session; say hello again." });
      return;
    }
    this.touch(session);
    // A plugin has one poll open at a time; a new one replaces the old.
    this.endPoll(session, 204);
    const poll: PendingPoll = {
      res,
      timer: setTimeout(() => {
        if (session.poll !== poll) return;
        session.poll = null;
        this.touch(session);
        this.send(res, 204);
        this.changed();
      }, this.pollTimeoutMs),
    };
    poll.timer.unref?.();
    session.poll = poll;
    res.on("close", () => {
      clearTimeout(poll.timer);
      if (session.poll !== poll) return;
      // The plugin gave up on this poll (Studio's own HTTP timeout, a disconnect).
      session.poll = null;
      this.touch(session);
      this.changed();
    });
    this.pump();
    this.changed();
  }

  private onResult(body: Record<string, unknown>, res: http.ServerResponse): void {
    const call = this.inflight.get(String(body.id ?? ""));
    if (!call) {
      // Too late (timed out) or never sent; nothing to do.
      this.send(res, 200, { ok: true, ignored: true });
      return;
    }
    this.inflight.delete(call.id);
    clearTimeout(call.timer);
    const session = call.sessionId ? this.sessions.get(call.sessionId) : undefined;
    if (session) this.touch(session);
    this.send(res, 200, { ok: true });
    if (body.ok === true) call.resolve(body.result);
    else call.reject(new Error(str(body.error, `Roblox Studio could not run "${call.command}".`)));
    this.changed();
  }

  private onLog(body: Record<string, unknown>, res: http.ServerResponse): void {
    const session = this.sessionFrom(body.session);
    if (session) this.touch(session);
    const now = Date.now();
    let added = 0;
    for (const raw of Array.isArray(body.lines) ? body.lines : []) {
      if (!isObject(raw) || typeof raw.text !== "string") continue;
      const text = raw.text.length > MAX_LINE_CHARS ? `${raw.text.slice(0, MAX_LINE_CHARS - 1)}…` : raw.text;
      this.log.push({ at: timestamp(raw.at, now), type: str(raw.type, "MessageOutput"), text });
      added++;
    }
    if (this.log.length > this.maxOutput) this.log = this.log.slice(this.log.length - this.maxOutput);
    this.send(res, 200, { ok: true, received: added });
    if (added || session) this.changed();
  }

  private onBye(body: Record<string, unknown>, res: http.ServerResponse): void {
    const session = this.sessionFrom(body.session);
    this.send(res, 200, { ok: true });
    if (!session) return;
    this.touch(session);
    this.dropSession(session, "Roblox Studio disconnected.");
    this.changed();
  }
}
