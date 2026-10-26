// When lu-minal asks Claude Code for the plan's usage. Each report is `claude -p /usage`: a whole
// Claude Code process that starts, loads its settings and asks claude.ai, so it shouldn't run more
// often than the numbers need. (Before: every 30 s while agents worked, plus the 60 s poll.)
//
// Running Claude Code agents tell the limits live: every model request brings a rate_limit_event,
// and since Claude Code 2.1.310 it carries the 5-hour and weekly windows' utilization
// (unifiedWindows; see applyRateLimit). So:
//   - while agents work and the events carry numbers, no reports at all: the gauges move with the
//     events. Events without numbers (older Claude Code) ask for a report 5 s later, and while agents
//     work there is one at most every 5 minutes, whatever asks for it;
//   - while nobody works, the poll of `usagePollSeconds` (60 s) catches what happens elsewhere
//     (claude.ai, another computer); with event numbers from the last 5 minutes it slows to 2 minutes;
//   - `usagePollSeconds: 0` turns the poll off (events without numbers still ask for reports).
// The extra usage (credits) and the plan only come with a report: after work they come back with the
// next idle poll. /usage's refresh asks right away, whatever the schedule says.

/** How often the schedule looks whether a report is due. */
export const USAGE_CHECK_MS = 5_000;
/** The poll's shortest interval, whatever usagePollSeconds says. */
export const MIN_POLL_MS = 30_000;
/** Event numbers this recent are "live": no polling while agents work, a slower one while idle. */
export const LIVE_FRESH_MS = 5 * 60_000;
/** While agents work, at most one report this often. */
export const BUSY_REPORT_GAP_MS = 5 * 60_000;
/** While idle with live numbers, the poll waits at least this long. */
export const FRESH_IDLE_POLL_MS = 2 * 60_000;
/** A report asked for by an event without numbers waits this long (the turn's next events come). */
export const EVENT_REPORT_DELAY_MS = 5_000;

export interface UsageScheduleState {
  now: number;
  /** config.usagePollSeconds (0: no polling). */
  pollSeconds: number;
  /** Whether any agent is working. */
  busy: boolean;
  /** When the last report started (0: none yet). */
  lastReportAt: number;
  /** When the last rate-limit event with numbers came (0: none). */
  lastLiveAt: number;
  /** Since when an event without numbers waits for a report (null: none waits). */
  askedAt: number | null;
}

/** Whether the event numbers are recent enough to stand in for a report. */
export function liveNumbers(s: Pick<UsageScheduleState, "now" | "lastLiveAt">): boolean {
  return s.lastLiveAt > 0 && s.now - s.lastLiveAt < LIVE_FRESH_MS;
}

/** The poll's interval now, in ms; null when nothing polls (polling off, or live numbers while busy). */
export function pollIntervalMs(s: Pick<UsageScheduleState, "now" | "pollSeconds" | "busy" | "lastLiveAt">): number | null {
  if (!(s.pollSeconds > 0)) return null;
  const base = Math.max(MIN_POLL_MS, s.pollSeconds * 1000);
  const live = liveNumbers(s);
  if (s.busy) return live ? null : Math.max(base, BUSY_REPORT_GAP_MS);
  return live ? Math.max(base, FRESH_IDLE_POLL_MS) : base;
}

/** Why a report is due now ("poll", "event"), or null when none is. */
export function reportDue(s: UsageScheduleState): "poll" | "event" | null {
  const since = s.now - s.lastReportAt;
  if (s.askedAt !== null && s.now - s.askedAt >= EVENT_REPORT_DELAY_MS) {
    // The events moved what they could; the rest waits for the gap while agents work.
    if (since >= (s.busy ? BUSY_REPORT_GAP_MS : MIN_POLL_MS)) return "event";
  }
  const every = pollIntervalMs(s);
  if (every !== null && since >= every) return "poll";
  return null;
}

export interface UsageScheduleDeps {
  /** Starts a report (the Hub's refreshUsage; it calls reported() when one really starts). */
  report: () => void;
  busy: () => boolean;
  pollSeconds: () => number;
  now?: () => number;
}

/** The Hub's usage reports: what came in (reports, events) and a timer that starts the next one. */
export class UsageSchedule {
  lastReportAt = 0;
  lastLiveAt = 0;
  askedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UsageScheduleDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Looks every USAGE_CHECK_MS whether a report is due (no timer keeps the process alive). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), USAGE_CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A report started (from the schedule or asked for by the user). */
  reported(at: number = this.now()): void {
    this.lastReportAt = at;
    this.askedAt = null;
  }

  /** A running agent's rate_limit_event; `numbers`: it carried the windows' utilization. */
  rateLimitEvent(numbers: boolean): void {
    if (numbers) this.lastLiveAt = this.now();
    else this.askedAt ??= this.now();
  }

  state(): UsageScheduleState {
    return {
      now: this.now(),
      pollSeconds: this.deps.pollSeconds(),
      busy: this.deps.busy(),
      lastReportAt: this.lastReportAt,
      lastLiveAt: this.lastLiveAt,
      askedAt: this.askedAt,
    };
  }

  /** Starts a report when one is due; returns why it did (or null). */
  check(): "poll" | "event" | null {
    const due = reportDue(this.state());
    if (due) this.deps.report();
    return due;
  }
}
