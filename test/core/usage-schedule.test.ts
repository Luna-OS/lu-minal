// When `claude -p /usage` runs (a whole Claude Code process each time): never while agents work and
// their rate-limit events carry the numbers, at most every 5 minutes while they work otherwise, the
// configured poll while idle (slowed to 2 minutes while the event numbers are fresh).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRateLimitEvent } from "../../src/agents/claude-code/events.js";
import { Agent } from "../../src/core/agent.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import {
  BUSY_REPORT_GAP_MS,
  EVENT_REPORT_DELAY_MS,
  FRESH_IDLE_POLL_MS,
  LIVE_FRESH_MS,
  pollIntervalMs,
  reportDue,
  USAGE_CHECK_MS,
  UsageSchedule,
  type UsageScheduleState,
} from "../../src/core/usage-schedule.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

const state = (s: Partial<UsageScheduleState> = {}): UsageScheduleState => ({
  now: T0,
  pollSeconds: 60,
  busy: false,
  lastReportAt: T0 - 10 * MIN,
  lastLiveAt: 0,
  askedAt: null,
  ...s,
});

describe("the poll's interval", () => {
  it("is usagePollSeconds while idle (30 s at least), and off with 0", () => {
    expect(pollIntervalMs(state())).toBe(MIN);
    expect(pollIntervalMs(state({ pollSeconds: 5 }))).toBe(30_000);
    expect(pollIntervalMs(state({ pollSeconds: 600 }))).toBe(10 * MIN);
    expect(pollIntervalMs(state({ pollSeconds: 0 }))).toBeNull();
    expect(pollIntervalMs(state({ pollSeconds: 0, busy: true }))).toBeNull();
  });

  it("slows to 2 minutes while idle with fresh event numbers", () => {
    expect(pollIntervalMs(state({ lastLiveAt: T0 - MIN }))).toBe(FRESH_IDLE_POLL_MS);
    // A longer configured poll stays longer.
    expect(pollIntervalMs(state({ pollSeconds: 300, lastLiveAt: T0 - MIN }))).toBe(5 * MIN);
    // Old numbers are not fresh: back to the configured poll.
    expect(pollIntervalMs(state({ lastLiveAt: T0 - LIVE_FRESH_MS }))).toBe(MIN);
  });

  it("stops while agents work and the events carry the numbers, else waits 5 minutes", () => {
    expect(pollIntervalMs(state({ busy: true, lastLiveAt: T0 - 2_000 }))).toBeNull();
    expect(pollIntervalMs(state({ busy: true }))).toBe(BUSY_REPORT_GAP_MS);
    expect(pollIntervalMs(state({ busy: true, lastLiveAt: T0 - LIVE_FRESH_MS - 1 }))).toBe(BUSY_REPORT_GAP_MS);
    expect(pollIntervalMs(state({ busy: true, pollSeconds: 900 }))).toBe(15 * MIN);
  });
});

describe("reportDue", () => {
  it("polls when the interval has passed since the last report", () => {
    expect(reportDue(state({ lastReportAt: T0 - 59_000 }))).toBeNull();
    expect(reportDue(state({ lastReportAt: T0 - MIN }))).toBe("poll");
    expect(reportDue(state({ lastReportAt: T0 - 90_000, lastLiveAt: T0 - MIN }))).toBeNull();
    expect(reportDue(state({ lastReportAt: T0 - FRESH_IDLE_POLL_MS, lastLiveAt: T0 - MIN }))).toBe("poll");
  });

  it("never reports while agents work with live numbers", () => {
    expect(reportDue(state({ busy: true, lastLiveAt: T0 - 1_000, lastReportAt: T0 - 60 * MIN }))).toBeNull();
  });

  it("answers an event without numbers 5 s later, at most every 5 minutes while agents work", () => {
    const asked = { busy: true, askedAt: T0 - EVENT_REPORT_DELAY_MS };
    expect(reportDue(state({ ...asked, askedAt: T0 - 1_000, lastReportAt: T0 - BUSY_REPORT_GAP_MS }))).toBe("poll");
    expect(reportDue(state({ ...asked, askedAt: T0 - 1_000, lastReportAt: T0 - MIN }))).toBeNull();
    expect(reportDue(state({ ...asked, lastReportAt: T0 - 4 * MIN }))).toBeNull();
    expect(reportDue(state({ ...asked, lastReportAt: T0 - BUSY_REPORT_GAP_MS }))).toBe("event");
    // The agents stopped meanwhile: 30 s since the last report are enough.
    expect(reportDue(state({ ...asked, busy: false, pollSeconds: 0, lastReportAt: T0 - 30_000 }))).toBe("event");
    expect(reportDue(state({ ...asked, busy: false, pollSeconds: 0, lastReportAt: T0 - 20_000 }))).toBeNull();
  });
});

describe("UsageSchedule", () => {
  afterEach(() => vi.useRealTimers());

  function schedule(opts: { busy?: boolean; pollSeconds?: number } = {}) {
    const busy = { value: opts.busy ?? false };
    const reports: number[] = [];
    const s: UsageSchedule = new UsageSchedule({
      // As the Hub's refreshUsage does: a report that starts says so.
      report: () => {
        reports.push(Date.now());
        s.reported();
      },
      busy: () => busy.value,
      pollSeconds: () => opts.pollSeconds ?? 60,
    });
    return { s, busy, reports };
  }

  it("runs no report while agents work and their events carry numbers, then polls slowly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: T0 });
    const { s, busy, reports } = schedule({ busy: true });
    s.reported();
    s.start();
    // An hour of work, a rate-limit event with numbers every 20 s.
    for (let t = 0; t < 60 * MIN; t += 20_000) {
      s.rateLimitEvent(true);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(reports).toEqual([]);
    // Done: the poll comes back, every 2 minutes while the numbers are fresh, then every minute.
    busy.value = false;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const gaps = reports.slice(1).map((at, i) => at - reports[i]);
    expect(reports[0] - (T0 + 60 * MIN)).toBeLessThanOrEqual(USAGE_CHECK_MS);
    expect(gaps[0]).toBeGreaterThanOrEqual(FRESH_IDLE_POLL_MS);
    expect(gaps.at(-1)).toBeLessThan(MIN + USAGE_CHECK_MS);
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(MIN);
    s.stop();
  });

  it("reports at most every 5 minutes while agents work when the events carry no numbers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: T0 });
    const { s, reports } = schedule({ busy: true });
    s.reported();
    s.start();
    for (let t = 0; t < 20 * MIN; t += 10_000) {
      s.rateLimitEvent(false);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    s.stop();
    // Before: one every 30 s (40 in 20 minutes).
    expect(reports.length).toBe(4);
    for (let i = 1; i < reports.length; i++) expect(reports[i] - reports[i - 1]).toBeGreaterThanOrEqual(BUSY_REPORT_GAP_MS);
  });

  it("starts no timer twice and stops", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: T0 });
    const { s } = schedule();
    s.start();
    s.start();
    expect(vi.getTimerCount()).toBe(1);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the Hub and the rate-limit events", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function hub(): Hub {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-usage-schedule-"));
    dirs.push(dir);
    return new Hub({
      config: defaultConfig(),
      configPath: null,
      auth: new AuthStore(path.join(dir, "auth.json")),
      themes: new ThemeManager({ dir: path.join(dir, "themes") }),
      cacheDir: dir,
      stateDir: dir,
      offline: true,
      servers: false,
    });
  }

  const event = (fiveHour: number | null): ClaudeRateLimitEvent => ({
    kind: "rate-limit",
    status: "allowed",
    type: "five_hour",
    fiveHour: fiveHour === null ? null : { utilization: fiveHour, resetsAt: Date.now() + 3_600_000 },
    sevenDay: fiveHour === null ? null : { utilization: 0.2, resetsAt: Date.now() + 86_400_000 },
    usingOverage: false,
  });

  it("moves the limits with an event and runs no /usage for it", async () => {
    const h = hub();
    const project = new Project({ cwd: os.tmpdir(), name: "moon" }, h.notifier, h);
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, h.notifier, "auto-edit");
    project.agents.push(agent);
    h.projects.push(project);
    agent.startTurn();
    const refresh = vi.spyOn(h, "refreshUsage").mockResolvedValue(undefined);
    h.usageSchedule.reported(Date.now() - 60 * 60_000);

    h.rateLimitEvent(event(0.42));
    expect(h.planUsage?.session?.utilization).toBe(0.42);
    expect(h.usageSchedule.check()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();

    // An event without numbers asks for a report (5 s later).
    const fresh = hub();
    fresh.projects.push(project);
    const asked = vi.spyOn(fresh, "refreshUsage").mockResolvedValue(undefined);
    fresh.usageSchedule.reported(Date.now() - 60 * 60_000);
    fresh.rateLimitEvent(event(null));
    expect(fresh.usageSchedule.askedAt).not.toBeNull();
    fresh.usageSchedule.askedAt = Date.now() - EVENT_REPORT_DELAY_MS;
    expect(fresh.usageSchedule.check()).toBe("event");
    expect(asked).toHaveBeenCalledOnce();
    await h.dispose();
    await fresh.dispose();
  });
});
