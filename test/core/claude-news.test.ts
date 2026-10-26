// Claude's news for the start screen, from trimmed copies of the two real release-notes pages
// (fetched 2026-10-26); every request goes to a fake fetch.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectEarlyResets } from "../../src/agents/claude-code/usage.js";
import {
  APPS_NOTES_URL,
  classifyNews,
  fetchClaudeNews,
  isoDate,
  parseAppNotes,
  parsePlatformNotes,
  PLATFORM_NOTES_URL,
} from "../../src/core/claude-news.js";
import type { PlanUsage } from "../../src/core/types.js";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", name), "utf8");
const APPS = fixture("claude-apps-release-notes.html");
const PLATFORM = fixture("claude-platform-release-notes.md");

describe("Claude's release notes", () => {
  it("reads the apps' page: a dated entry per bold title, launches and offers marked", () => {
    const items = parseAppNotes(APPS);
    expect(items.slice(0, 4).map((i) => [i.date, i.title, i.kind])).toEqual([
      ["2026-10-21", "Claude Duet research preview for Pro and Max plans", "news"],
      ["2026-10-07", "Claude Haiku 5.5 launch", "model"],
      ["2026-10-07", "Monthly API credits for Max and Team plans", "offer"],
      ["2026-09-28", "Claude Sonnet 5.5 launch", "model"],
    ]);
    expect(items.every((i) => i.source === "apps" && i.url === APPS_NOTES_URL)).toBe(true);
    // Bold text inside a description is not an entry of its own.
    expect(items.map((i) => i.title)).not.toContain("Introducing Claude Duet");
  });

  it("reads the platform's Markdown: the first sentence of each bullet, links as text", () => {
    const items = parsePlatformNotes(PLATFORM);
    expect(items[0]).toMatchObject({ date: "2026-10-22", source: "platform" });
    expect(items[0].title).toMatch(/^We've launched Claude Models on Google Cloud \(Anthropic managed\), the Claude API/);
    expect(items.every((i) => !/\]\(|https?:/.test(i.title) && i.title.length <= 160)).toBe(true);
    expect(new Set(items.map((i) => i.date)).has("2026-10-15")).toBe(true);
  });

  it("tells model launches and offers from other news", () => {
    expect(classifyNews("Claude Opus 5.5 launch")).toBe("model");
    expect(classifyNews("We've launched Claude Haiku 5.5, our fastest model")).toBe("model");
    expect(classifyNews("Monthly API credits for Max and Team plans")).toBe("offer");
    expect(classifyNews("Usage limits reset for all Pro and Max plans")).toBe("offer");
    expect(classifyNews("Double usage on weekends for Max plans")).toBe("offer");
    expect(classifyNews("Memory for free users")).toBe("news");
    expect(classifyNews("Claude Opus 5.5 is now available in Claude Code")).toBe("model");
    // A feature for a model is not the model's launch.
    expect(classifyNews("Fast mode is available for Claude Opus 5.5 on Google Cloud")).toBe("news");
    expect(classifyNews("Build plugins for Claude")).toBe("news");
    expect(isoDate("October 7, 2026")).toBe("2026-10-07");
    expect(isoDate("Smarch 7, 2026")).toBeNull();
  });

  it("merges both pages newest first, the platform's API details left out, and leaves out a page that can't be loaded", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL) => {
      calls.push(String(input));
      if (String(input) === APPS_NOTES_URL) return new Response(APPS);
      if (String(input) === PLATFORM_NOTES_URL) return new Response(PLATFORM);
      return new Response("", { status: 404 });
    };
    const items = await fetchClaudeNews({ fetchImpl, limit: 5 });
    expect(calls.sort()).toEqual([APPS_NOTES_URL, PLATFORM_NOTES_URL].sort());
    expect(items.map((i) => [i.date, i.title, i.kind])).toEqual([
      ["2026-10-21", "Claude Duet research preview for Pro and Max plans", "news"],
      ["2026-10-07", "Claude Haiku 5.5 launch", "model"],
      ["2026-10-07", "Monthly API credits for Max and Team plans", "offer"],
      ["2026-09-28", "Claude Sonnet 5.5 launch", "model"],
      ["2026-09-25", "Build plugins for Claude", "news"],
    ]);
    // What the platform page adds: launches and offers only, none the apps' page already has.
    const all = await fetchClaudeNews({ fetchImpl, limit: 100 });
    expect(all.filter((i) => i.source === "platform").every((i) => i.kind !== "news")).toBe(true);
    const bothPages = `### October 7, 2026\n\n* We've launched Claude Haiku 5.5 (claude-haiku-5-5), our most capable small model.\n* Claude Max and Team plans now include monthly API credits.\n* We've launched Claude Fable 5.5 in the API.\n`;
    const merged = await fetchClaudeNews({ fetchImpl: async (u) => new Response(String(u) === APPS_NOTES_URL ? APPS : bothPages), limit: 100 });
    expect(merged.filter((i) => i.date === "2026-10-07").map((i) => [i.title, i.source])).toEqual([
      ["Claude Haiku 5.5 launch", "apps"],
      ["Monthly API credits for Max and Team plans", "apps"],
      ["We've launched Claude Fable 5.5 in the API", "platform"],
    ]);

    const down = async (input: string | URL) => (String(input) === APPS_NOTES_URL ? new Response(APPS) : Promise.reject(new Error("offline")));
    const onlyApps = await fetchClaudeNews({ fetchImpl: down });
    expect(onlyApps.length).toBeGreaterThan(0);
    expect(onlyApps.every((i) => i.source === "apps")).toBe(true);
    expect(await fetchClaudeNews({ fetchImpl: async () => new Response("", { status: 500 }) })).toEqual([]);
  });
});

describe("free resets of the plan's limits", () => {
  const NOW = Date.UTC(2026, 9, 26, 12, 0);
  const usage = (session: number, week: number, sessionReset = NOW + 3 * 3_600_000, weekReset = NOW + 4 * 86_400_000): PlanUsage => ({
    available: true,
    plan: "max",
    session: { utilization: session, resetsAt: sessionReset },
    week: { utilization: week, resetsAt: weekReset },
    models: [],
    extra: null,
    at: NOW,
  });

  it("finds a window that dropped well before its reset time", () => {
    expect(detectEarlyResets(usage(0.4, 0.63), usage(0.41, 0.02), NOW)).toEqual([{ window: "week", was: 0.63 }]);
    expect(detectEarlyResets(usage(0.55, 0.7), usage(0, 0), NOW)).toEqual([
      { window: "session", was: 0.55 },
      { window: "week", was: 0.7 },
    ]);
  });

  it("ignores the normal reset, small moves, low windows and missing numbers", () => {
    // The session's reset was due: that is the ordinary reset.
    expect(detectEarlyResets(usage(0.8, 0.5, NOW + 5 * 60_000), usage(0, 0.5), NOW)).toEqual([]);
    expect(detectEarlyResets(usage(0.5, 0.5), usage(0.45, 0.48), NOW)).toEqual([]);
    expect(detectEarlyResets(usage(0.1, 0.12), usage(0, 0), NOW)).toEqual([]);
    expect(detectEarlyResets(null, usage(0, 0), NOW)).toEqual([]);
    expect(detectEarlyResets({ ...usage(0.5, 0.5), week: null }, usage(0, 0), NOW)).toEqual([{ window: "session", was: 0.5 }]);
  });
});
