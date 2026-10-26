// A render benchmark: the whole <App> in a fake 160x48 terminal, with 3 tabs of 3 agents each,
// either busy (every agent streams like a busy Claude Code agent: ~50 small text deltas a second,
// and every few seconds a tool call, half of them edits with a 200-line diff) or idle (nothing
// runs; only the sky, Axo and the clocks move). It records the CPU time of this process, the frames
// Ink drew, the change notifications the Hub delivered and the bytes written to the terminal.
//
//   npx tsx test/perf/bench.tsx [busy|idle|both] [seconds]       (NODE_ENV=production as in the binaries)
//   node --cpu-prof --import tsx test/perf/bench.tsx busy 10    (a .cpuprofile for the hot spots)
//
// test/perf/render.test.tsx runs it under Vitest when PERF=1. Nothing here touches the network or
// starts a program: the agents' drivers are fakes and the Hub runs offline.
//
// On a 4-core Linux VM (NODE_ENV=production, CPU ms per 10 s, the median of 3 runs):
//              busy (9 agents, ~390 deltas/s)                       idle
//   0.1.3      9169 ms: 14.5 frames/s (CPU-bound), 87 notif./s,     3156 ms: 8.5 frames/s
//              39.1 KiB/s to the terminal                           0.6 KiB/s
//   now        3883 ms: 10 frames/s, 10 notif./s, 36.6 KiB/s        1672 ms: 5.2 frames/s, 0.6 KiB/s
// With React's development build (`node dist/cli.js` before src/production.ts) 0.1.3 took
// ~11100 ms busy and ~4000 ms idle.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { render } from "ink";
import React from "react";
import { Agent, type AgentDriver } from "../../src/core/agent.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import type { DiffLine, LogEntry, PlanUsage } from "../../src/core/types.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";
import { App } from "../../src/ui/App.js";
import { RENDER_OPTIONS } from "../../src/ui/render-options.js";

export interface BenchOptions {
  mode: "busy" | "idle";
  /** How long to measure (after a warm-up second). */
  seconds: number;
  tabs?: number;
  agentsPerTab?: number;
  columns?: number;
  rows?: number;
  /** Text deltas per second and agent while busy. */
  deltasPerSecond?: number;
}

export interface BenchResult {
  mode: "busy" | "idle";
  seconds: number;
  /** CPU time of this process (user + system) over the measured seconds. */
  cpuMs: number;
  /** Frames Ink drew (its onRender callbacks). */
  frames: number;
  /** Change notifications the Hub delivered to the UI. */
  notifications: number;
  /** Writes to the terminal and their size. */
  writes: number;
  bytes: number;
  /** What the fake agents did meanwhile. */
  deltas: number;
  toolCalls: number;
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  writes = 0;
  bytes = 0;
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    this.writes++;
    this.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  read = (): string | null => null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const WORDS = (
  "the moon is waxing tonight and every star in the sky keeps its own time while luna reads the plan " +
  "checks `src/ui/App.tsx` and **carefully** writes a small patch for the renderer so the panels stay calm"
).split(" ");

/** A deterministic random number generator (the same run every time). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function diffOf(lines: number, seed: number): DiffLine[] {
  const rand = rng(seed);
  return Array.from({ length: lines }, (_, i): DiffLine => {
    const r = rand();
    const kind = r < 0.45 ? "add" : r < 0.7 ? "del" : "ctx";
    return { kind, line: 10 + i, text: `    const value${i} = compute(${WORDS[i % WORDS.length]}, ${i});` };
  });
}

const idleDriver = (): AgentDriver => ({
  kind: "native",
  start: async () => undefined,
  send: () => undefined,
  interrupt: () => undefined,
  dispose: async () => undefined,
});

/** An earlier conversation in the log, so every panel has history to lay out, like a real session. */
function seedLog(agent: Agent, seed: number): void {
  const rand = rng(seed);
  for (let i = 0; i < 40; i++) {
    agent.append({ kind: "user", from: "you", text: `Please look at part ${i} of the plan.` });
    const words = Array.from({ length: 40 + Math.floor(rand() * 80) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
    agent.append({ kind: "text", text: words.join(" ") });
    agent.append({ kind: "tool", toolCallId: `t${seed}-${i}`, name: "Edit", verb: "edit", target: `src/part${i}.ts`, status: "ok", diff: diffOf(12, seed + i), added: 6, removed: 3 });
  }
}

function fakeUsage(now: number): PlanUsage {
  return {
    available: true,
    plan: "max",
    session: { utilization: 0.42, resetsAt: now + 2 * 3_600_000 },
    week: { utilization: 0.18, resetsAt: now + 3 * 86_400_000 },
    models: [],
    extra: null,
    at: now,
  };
}

/** One agent working: text deltas, now and then a tool call (an edit with a big diff, or a command). */
function work(agent: Agent, index: number, perSecond: number, counters: { deltas: number; toolCalls: number }): () => void {
  const rand = rng(1000 + index);
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  let toolRunning = false;
  let sinceTool = 0;
  // Every ~3 s (staggered per agent) a tool call.
  const toolEvery = Math.round(perSecond * (2.5 + (index % 4) * 0.4));
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };
  agent.startTurn();
  const startedAt = Date.now();
  let emitted = 0;
  const tick = () => {
    // A little jitter, as deltas arrive from a pipe; what a busy event loop held back arrives at
    // once, as lines pile up in the pipe.
    later(Math.max(1, Math.round((1000 / perSecond) * (0.5 + rand()))), tick);
    const due = Math.floor(((Date.now() - startedAt) / 1000) * perSecond) - emitted;
    for (let i = 0; i < due; i++) {
      emitted++;
      step();
    }
  };
  const step = () => {
    if (toolRunning) return;
    if (++sinceTool >= toolEvery) {
      sinceTool = 0;
      toolRunning = true;
      counters.toolCalls++;
      agent.closeStreams();
      const edit = counters.toolCalls % 2 === 0;
      const entry = agent.append({
        kind: "tool",
        toolCallId: `run-${index}-${counters.toolCalls}`,
        name: edit ? "Edit" : "Bash",
        verb: edit ? "edit" : "run",
        target: edit ? `src/ui/part${counters.toolCalls}.ts` : "npm test -- --reporter=dot",
        status: "running",
      });
      later(300 + Math.floor(rand() * 300), () => {
        toolRunning = false;
        if (edit) {
          agent.update(entry.id, { status: "ok", diff: diffOf(200, counters.toolCalls), added: 90, removed: 50, detail: "90 lines added, 50 removed" } as Partial<LogEntry>);
          agent.addLines(90, 50);
        } else {
          agent.update(entry.id, { status: "ok", detail: "200 lines · ✓ 412 tests passed" } as Partial<LogEntry>);
        }
        agent.addUsage({ input: 2400, context: 48_000 + counters.toolCalls * 300, output: 310, turn: true });
      });
      return;
    }
    counters.deltas++;
    const n = 1 + Math.floor(rand() * 3);
    let text = "";
    for (let i = 0; i < n; i++) text += `${WORDS[Math.floor(rand() * WORDS.length)]} `;
    if (rand() < 0.06) text += "\n\n";
    agent.appendStream("text", text);
  };
  later(Math.floor(rand() * 20), tick);
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  const columns = opts.columns ?? 160;
  const rows = opts.rows ?? 48;
  const tabs = opts.tabs ?? 3;
  const perTab = opts.agentsPerTab ?? 3;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-bench-"));
  const config = defaultConfig();
  // The real look: the animated sky (8 fps) and Axo; BENCH_SKY=0 / BENCH_AXO=0 leave them out.
  if (process.env.BENCH_SKY === "0") config.sky.enabled = false;
  if (process.env.BENCH_AXO === "0") config.axo = false;
  const hub = new Hub({
    config,
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
    // Nothing may go out (the pollers below would ask OpenRouter with a key from the environment).
    fetchImpl: async () => {
      throw new Error("no network in the benchmark");
    },
  });
  hub.planUsage = fakeUsage(Date.now());
  hub.ready = true;
  const names = ["luna", "vega", "lyra", "orion", "nova", "sirius"];
  for (let t = 0; t < tabs; t++) {
    const project = new Project({ cwd: dir, name: `moon-${t + 1}` }, hub.notifier, hub);
    for (let a = 0; a < perTab; a++) {
      const agent = new Agent(
        { name: names[a % names.length], role: a === 0 ? "lead" : "worker", label: a === 0 ? undefined : `area ${a}`, model: { provider: "claude-code", model: "opus" } },
        hub.notifier,
        "auto-edit",
      );
      agent.driver = idleDriver();
      agent.setStatus("idle");
      seedLog(agent, t * 10 + a);
      project.agents.push(agent);
    }
    project.focusedId = project.agents[0].id;
    hub.projects.push(project);
  }
  hub.activeIndex = 0;
  // The clocks the running app has (the 1 s tick while agents work, the limits' 30 s tick); the
  // network ones find nothing to do offline.
  (hub as unknown as { startPollers(): void }).startPollers();

  const stdout = new FakeStdout(columns, rows);
  let frames = 0;
  let notifications = 0;
  const unsubscribe = hub.notifier.subscribe(() => notifications++);
  const instance = render(<App hub={hub} onExit={() => undefined} />, {
    ...RENDER_OPTIONS,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout(columns, rows) as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    // Ink would fall back to a non-interactive terminal in CI.
    interactive: true,
    patchConsole: false,
    onRender: () => void frames++,
  });

  const counters = { deltas: 0, toolCalls: 0 };
  const stops: Array<() => void> = [];
  if (opts.mode === "busy") {
    let i = 0;
    for (const project of hub.projects) for (const agent of project.agents) stops.push(work(agent, i++, opts.deltasPerSecond ?? 50, counters));
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Warm up: the first frames, the JIT.
  await sleep(1000);
  const start = { cpu: process.cpuUsage(), frames, notifications, writes: stdout.writes, bytes: stdout.bytes, ...counters };
  await sleep(opts.seconds * 1000);
  const cpu = process.cpuUsage(start.cpu);
  const result: BenchResult = {
    mode: opts.mode,
    seconds: opts.seconds,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    frames: frames - start.frames,
    notifications: notifications - start.notifications,
    writes: stdout.writes - start.writes,
    bytes: stdout.bytes - start.bytes,
    deltas: counters.deltas - start.deltas,
    toolCalls: counters.toolCalls - start.toolCalls,
  };
  for (const stop of stops) stop();
  unsubscribe();
  instance.unmount();
  instance.cleanup();
  await hub.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

/** One line per result: CPU ms and per-second rates. */
export function describeResult(r: BenchResult): string {
  const per = (n: number) => (n / r.seconds).toFixed(1);
  return (
    `${r.mode.padEnd(4)} ${r.seconds}s: cpu ${r.cpuMs} ms (${((r.cpuMs / (r.seconds * 1000)) * 100).toFixed(1)} % of a core) · ` +
    `${per(r.frames)} frames/s · ${per(r.notifications)} notifications/s · ${per(r.writes)} writes/s · ` +
    `${(r.bytes / r.seconds / 1024).toFixed(1)} KiB/s · ${per(r.deltas)} deltas/s · ${r.toolCalls} tool calls`
  );
}

// Run directly: npx tsx test/perf/bench.tsx [busy|idle|both] [seconds]
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const which = process.argv[2] ?? "both";
  const seconds = Number(process.argv[3] ?? 10);
  const modes: Array<"busy" | "idle"> = which === "both" ? ["busy", "idle"] : [which as "busy" | "idle"];
  for (const mode of modes) {
    const r = await runBench({ mode, seconds });
    process.stderr.write(`${describeResult(r)}\n`);
  }
  process.exit(0);
}
