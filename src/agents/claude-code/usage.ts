// The Claude plan's usage, as Claude Code's own `/usage` command reports it: the 5-hour session, the
// week, the per-model weekly windows and the extra usage (credits). `claude -p /usage` runs locally:
// it asks claude.ai for the numbers and sends nothing to the model, so it costs no usage. Its result
// carries a structured copy of the numbers beside the text; that copy is what is read here.
//
// The shape (experimental in Claude Code):
//   { subscription_type, rate_limits_available,
//     rate_limits: { five_hour, seven_day, seven_day_opus, seven_day_sonnet: { utilization, resets_at },
//                    model_scoped: [{ display_name, utilization, resets_at }],
//                    extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency } } }
// utilization is in percent there (44 = 44 %); lu-minal uses fractions (0.44). The SDK's usage report
// (SDKUsageReport.rate_limits) names the same number `percent`; both are read.
//
// Between two reports, the `rate_limit_event` lines of running agents move the session and week
// windows (applyRateLimit).
import os from "node:os";
import type { PlanUsage, UsageWindow } from "../../core/types.js";
import { runProgram, type RunResult } from "../../platform/process.js";
import { claudeEnv } from "./cli.js";
import type { ClaudeRateLimitEvent } from "./events.js";

/** `claude` arguments for the usage report: no session file, no MCP servers to start. */
export const USAGE_ARGS: readonly string[] = [
  "-p",
  "/usage",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
];

const MODEL_WINDOWS: Array<[string, string]> = [
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A time from the report (ISO text, seconds or milliseconds) in milliseconds, or null. */
export function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return toMs(Number(t));
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * { utilization (0..1), resetsAt (ms) } from a window of the report, or null. The report counts
 * in percent: `utilization` (Claude Code's own field) or `percent` (the SDK's usage report).
 */
function windowOf(w: unknown): UsageWindow | null {
  if (!isObj(w)) return null;
  const u = num(w.utilization) ?? num(w.percent);
  if (u === null) return null;
  return { utilization: u / 100, resetsAt: toMs(w.resets_at ?? w.resetsAt) };
}

/** The first object (depth first) that has `key` as its own property. */
function findWith(value: unknown, key: string, depth = 0): Obj | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) return value as Obj;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const hit = findWith(v, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * The plan usage from the output of `claude -p /usage` (stream-json or json), or null when the
 * report has no plan numbers (an older Claude Code, a login without that scope). An API-key login
 * comes back as { available: false }.
 */
export function parseUsage(stdout: string, now: number = Date.now()): PlanUsage | null {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    const report = findWith(msg, "rate_limits");
    if (!report) continue;
    const plan = typeof report.subscription_type === "string" && report.subscription_type ? report.subscription_type : null;
    const rl = report.rate_limits;
    if (!isObj(rl)) {
      if (report.rate_limits_available === false) {
        return { available: false, plan, session: null, week: null, models: [], extra: null, at: now };
      }
      return null;
    }
    const models: PlanUsage["models"] = [];
    for (const [key, name] of MODEL_WINDOWS) {
      const w = windowOf(rl[key]);
      if (w) models.push({ name, ...w });
    }
    for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
      if (!isObj(m) || typeof m.display_name !== "string" || !m.display_name) continue;
      const w = windowOf(m);
      if (w && !models.some((x) => x.name === m.display_name)) models.push({ name: m.display_name, ...w });
    }
    const x = rl.extra_usage;
    const xu = isObj(x) ? (num(x.utilization) ?? num(x.percent)) : null;
    return {
      available: true,
      plan,
      session: windowOf(rl.five_hour),
      week: windowOf(rl.seven_day),
      models,
      // Amounts as claude.ai sends them: in cents.
      extra: isObj(x)
        ? {
            enabled: Boolean(x.is_enabled),
            limit: num(x.monthly_limit),
            used: num(x.used_credits),
            utilization: xu === null ? null : xu / 100,
            currency: typeof x.currency === "string" ? x.currency : null,
          }
        : null,
      at: now,
    };
  }
  return null;
}

export interface FetchUsageOptions {
  run?: (exe: string, args: string[], opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<RunResult>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Runs `claude -p /usage` (in the home folder, 45 s at most) and reads the plan's usage from it.
 * Resolves null when there are no numbers or the run failed; never throws.
 */
export async function fetchPlanUsage(exe: string, opts: FetchUsageOptions = {}): Promise<PlanUsage | null> {
  const run = opts.run ?? ((e, a, o) => runProgram(e, a, o));
  try {
    const res = await run(exe, [...USAGE_ARGS], {
      cwd: os.homedir(),
      timeoutMs: opts.timeoutMs ?? 45_000,
      env: claudeEnv(opts.env ?? process.env, exe),
    });
    return parseUsage(res.stdout, (opts.now ?? Date.now)());
  } catch {
    return null;
  }
}

/**
 * The plan usage after a `rate_limit_event` from a running agent: the session and week windows
 * (and per-model weekly windows) the stream reported, everything else (plan, other windows, extra
 * usage) as it was.
 */
export function applyRateLimit(prev: PlanUsage | null, ev: ClaudeRateLimitEvent, now: number = Date.now()): PlanUsage {
  const base: PlanUsage = prev ?? { available: true, plan: null, session: null, week: null, models: [], extra: null, at: now };
  const fresh = ev.models ?? [];
  const moved = Boolean(ev.fiveHour || ev.sevenDay || fresh.length);
  let models = base.models;
  if (fresh.length) {
    models = base.models.map((m) => {
      const hit = fresh.find((f) => f.name === m.name);
      return hit ? { ...hit } : m;
    });
    for (const f of fresh) if (!models.some((m) => m.name === f.name)) models.push({ ...f });
  }
  return {
    ...base,
    available: base.available || moved,
    session: ev.fiveHour ? { ...ev.fiveHour } : base.session,
    week: ev.sevenDay ? { ...ev.sevenDay } : base.week,
    models,
    at: moved ? now : base.at,
  };
}
