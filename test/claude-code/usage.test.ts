import os from "node:os";
import { describe, expect, it } from "vitest";
import type { ClaudeRateLimitEvent } from "../../src/agents/claude-code/events.js";
import { applyRateLimit, fetchPlanUsage, parseUsage, toMs, USAGE_ARGS } from "../../src/agents/claude-code/usage.js";
import type { PlanUsage } from "../../src/core/types.js";

const NOW = Date.UTC(2026, 9, 4, 8, 0);

/** A /usage run as Claude Code prints it with --output-format stream-json. */
function report(rateLimits: unknown, extra: Record<string, unknown> = {}, eol = "\n"): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "x", tools: [], mcp_servers: [] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Total cost: $0" }] } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      local_command: "usage",
      usage_report: {
        session: { total_cost_usd: 0 },
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: rateLimits,
        ...extra,
      },
    }),
    "",
  ].join(eol);
}

describe("USAGE_ARGS", () => {
  it("runs /usage locally, without MCP servers or a session file", () => {
    expect(USAGE_ARGS.slice(0, 2)).toEqual(["-p", "/usage"]);
    expect(USAGE_ARGS).toContain("--no-session-persistence");
    expect(USAGE_ARGS).toContain("--strict-mcp-config");
    expect(USAGE_ARGS).toContain("stream-json");
  });
});

describe("parseUsage", () => {
  it("reads the windows, per-model rows and extra usage (percent → fraction, ISO → ms)", () => {
    const u = parseUsage(
      report({
        five_hour: { utilization: 44, resets_at: "2026-10-04T09:40:00Z" },
        seven_day: { utilization: 79.5, resets_at: "2026-10-09T02:00:00+00:00" },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 31, resets_at: 1791511200 },
        model_scoped: [
          { display_name: "Fable", utilization: 12, resets_at: "2026-10-09T02:00:00Z" },
          { display_name: "Sonnet", utilization: 99, resets_at: null },
          { utilization: 5 },
        ],
        extra_usage: { is_enabled: true, monthly_limit: 4000, used_credits: 1250, utilization: 31.25, currency: "EUR" },
      }),
      NOW,
    )!;
    expect(u.available).toBe(true);
    expect(u.plan).toBe("max");
    expect(u.session).toEqual({ utilization: 0.44, resetsAt: Date.UTC(2026, 9, 4, 9, 40) });
    expect(u.week).toEqual({ utilization: 0.795, resetsAt: Date.UTC(2026, 9, 9, 2, 0) });
    expect(u.models).toEqual([
      { name: "Sonnet", utilization: 0.31, resetsAt: 1791511200000 },
      { name: "Fable", utilization: 0.12, resetsAt: Date.UTC(2026, 9, 9, 2, 0) },
    ]);
    expect(u.extra).toEqual({ enabled: true, limit: 4000, used: 1250, utilization: 0.3125, currency: "EUR" });
    expect(u.at).toBe(NOW);
  });

  it("works with CRLF output and a plain json result", () => {
    const crlf = parseUsage(report({ five_hour: { utilization: 3, resets_at: null } }, {}, "\r\n"), NOW)!;
    expect(crlf.session).toEqual({ utilization: 0.03, resetsAt: null });
    expect(crlf.week).toBeNull();
    expect(crlf.extra).toBeNull();
    const json = parseUsage(JSON.stringify({ rate_limits: { seven_day: { utilization: 50 } } }), NOW)!;
    expect(json.week).toEqual({ utilization: 0.5, resetsAt: null });
    expect(json.plan).toBeNull();
  });

  it("is null without plan numbers, and 'not available' for an API key", () => {
    expect(parseUsage("")).toBeNull();
    expect(parseUsage("Usage is only available for subscription plans.\n")).toBeNull();
    expect(parseUsage('{"type":"result","result":"Total cost: $0"}\n')).toBeNull();
    expect(parseUsage('{"broken json\n', NOW)).toBeNull();
    expect(
      parseUsage(JSON.stringify({ type: "result", x: { subscription_type: null, rate_limits_available: false, rate_limits: null } }), NOW),
    ).toEqual({ available: false, plan: null, session: null, week: null, models: [], extra: null, at: NOW });
  });
});

describe("toMs", () => {
  it("reads ISO text, seconds and milliseconds", () => {
    expect(toMs("2026-10-04T09:40:00Z")).toBe(Date.UTC(2026, 9, 4, 9, 40));
    expect(toMs(1791100000)).toBe(1791100000000);
    expect(toMs(1791100000000)).toBe(1791100000000);
    expect(toMs("1791100000")).toBe(1791100000000);
    expect(toMs("soon")).toBeNull();
    expect(toMs(null)).toBeNull();
    expect(toMs(Number.NaN)).toBeNull();
  });
});

describe("fetchPlanUsage", () => {
  it("runs claude -p /usage in the home folder with a timeout", async () => {
    let seen: { exe: string; args: string[]; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv } | null = null;
    const usage = await fetchPlanUsage("/usr/local/bin/claude", {
      env: { PATH: "/usr/bin", CLAUDECODE: "1" },
      now: () => NOW,
      run: async (exe, args, opts) => {
        seen = { exe, args, ...opts };
        return { code: 0, stdout: report({ five_hour: { utilization: 10, resets_at: null } }), stderr: "", timedOut: false };
      },
    });
    expect(usage?.session).toEqual({ utilization: 0.1, resetsAt: null });
    expect(seen!.args).toEqual([...USAGE_ARGS]);
    expect(seen!.cwd).toBe(os.homedir());
    expect(seen!.timeoutMs).toBe(45_000);
    expect(seen!.env.CLAUDECODE).toBeUndefined();
  });

  it("resolves null instead of throwing", async () => {
    expect(
      await fetchPlanUsage("claude", {
        run: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeNull();
    expect(
      await fetchPlanUsage("claude", { run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) }),
    ).toBeNull();
  });
});

describe("applyRateLimit", () => {
  const ev = (patch: Partial<ClaudeRateLimitEvent> = {}): ClaudeRateLimitEvent => ({
    kind: "rate-limit",
    status: "allowed",
    type: "five_hour",
    fiveHour: { utilization: 0.5, resetsAt: 1791081600000 },
    sevenDay: { utilization: 0.7, resetsAt: 1791504000000 },
    usingOverage: false,
    ...patch,
  });

  it("moves the session and week windows and keeps the rest", () => {
    const prev: PlanUsage = {
      available: true,
      plan: "max",
      session: { utilization: 0.4, resetsAt: 1 },
      week: { utilization: 0.6, resetsAt: 2 },
      models: [{ name: "Opus", utilization: 0.2, resetsAt: 3 }],
      extra: { enabled: true, limit: 100, used: 5, utilization: 0.05, currency: "USD" },
      at: 10,
    };
    const next = applyRateLimit(prev, ev({ sevenDay: null }), NOW);
    expect(next).toEqual({ ...prev, session: { utilization: 0.5, resetsAt: 1791081600000 }, at: NOW });
    expect(prev.session).toEqual({ utilization: 0.4, resetsAt: 1 });
  });

  it("starts from nothing, and marks a plan without /usage numbers available", () => {
    const fresh = applyRateLimit(null, ev(), NOW);
    expect(fresh).toEqual({
      available: true,
      plan: null,
      session: { utilization: 0.5, resetsAt: 1791081600000 },
      week: { utilization: 0.7, resetsAt: 1791504000000 },
      models: [],
      extra: null,
      at: NOW,
    });
    const before: PlanUsage = { available: false, plan: "pro", session: null, week: null, models: [], extra: null, at: 1 };
    expect(applyRateLimit(before, ev(), NOW).available).toBe(true);
    expect(applyRateLimit(before, ev({ fiveHour: null, sevenDay: null }), NOW)).toEqual(before);
  });
});
