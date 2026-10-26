// The home screen's news: the parsers for Claude Code's changelog, npm's answer and Anthropic's
// status page, the newest models of the catalog, and loading them (an hour's cache, sources that
// fail on their own, never a throw). Every request goes to a fake fetch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_STATUS_URL,
  CLAUDE_CODE_CHANGELOG_URL,
  CLAUDE_CODE_NPM_URL,
  loadNews,
  NEWS_CACHE_FILE,
  NEWS_MAX_AGE_MS,
  NEWS_RETRY_MS,
  newestModels,
  newsStale,
  parseChangelog,
  parseNpmLatest,
  parseStatus,
  releaseTime,
  type ModelSource,
  type News,
} from "../../src/core/news.js";
import type { ModelInfo, ProviderInfo } from "../../src/providers/models.js";
import { APPS_NOTES_URL, parseAppNotes, parsePlatformNotes, PLATFORM_NOTES_URL } from "../../src/core/claude-news.js";
import { fakeFetch } from "../providers/helpers.js";

// Trimmed copies of Claude's two release-notes pages.
const APPS_NOTES = fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "claude-apps-release-notes.html"), "utf8");
const PLATFORM_NOTES = fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "claude-platform-release-notes.md"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-news-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const CHANGELOG = `# Changelog

## 2.1.320

- Added \`/rewind\` to step back through a conversation and its file edits
- Fixed a hang when an MCP server never answered the **initialize** request
- Improved startup time on Windows ([#4211](https://github.com/anthropics/claude-code/issues/4211))
- Settings: \`permissions.defaultMode\` now accepts \`plan\`

## 2.1.319

- Fixed the status line on narrow terminals
`;

const STATUS = {
  page: { id: "tymt9n04zgry", name: "Anthropic", url: "https://status.anthropic.com", time_zone: "Etc/UTC", updated_at: "2026-10-26T08:12:44.123Z" },
  components: [
    { id: "k8w3r06qmzrp", name: "claude.ai", status: "operational", position: 1, showcase: true },
    { id: "rwppv331jlwc", name: "Claude API (api.anthropic.com)", status: "degraded_performance", position: 2, showcase: true },
  ],
  incidents: [
    {
      id: "8x1l2w0v0n5c",
      name: "Elevated errors on Claude Opus 5.5",
      status: "investigating",
      impact: "minor",
      created_at: "2026-10-26T07:58:02.000Z",
      shortlink: "https://stspg.io/abc123",
      incident_updates: [{ status: "investigating", body: "We are investigating elevated error rates." }],
    },
    { id: "q9z8y7x6w5v4", name: "Slow responses on claude.ai", status: "resolved", impact: "minor" },
    { id: "m1n2b3v4c5x6", name: "Login failures", status: "postmortem", impact: "major" },
  ],
  scheduled_maintenances: [],
  status: { indicator: "minor", description: "Partially Degraded Service" },
};

const NPM = {
  name: "@anthropic-ai/claude-code",
  version: "2.1.320",
  description: "Use Claude, Anthropic's AI assistant, right from your terminal.",
  bin: { claude: "cli.js" },
  dist: { tarball: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.320.tgz", shasum: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6" },
};

describe("parseChangelog", () => {
  it("reads the newest section's first three bullets as plain text", () => {
    expect(parseChangelog(CHANGELOG)).toEqual({
      version: "2.1.320",
      bullets: [
        "Added /rewind to step back through a conversation and its file edits",
        "Fixed a hang when an MCP server never answered the initialize request",
        "Improved startup time on Windows (#4211)",
      ],
    });
    expect(parseChangelog(CHANGELOG, 10)?.bullets).toHaveLength(4);
  });

  it("takes other heading styles and skips a section without a version", () => {
    expect(parseChangelog("## Unreleased\n- not yet\n\n## [2.1.0] - 2026-10-01\r\n* first\r\n- second\r\n")).toEqual({ version: "2.1.0", bullets: ["first", "second"] });
    expect(parseChangelog("## v3.0.0-beta.2\n  - an indented line is not a top-level bullet\n- top\n")).toEqual({ version: "3.0.0-beta.2", bullets: ["top"] });
  });

  it("is null without a versioned section", () => {
    expect(parseChangelog("# Changelog\n\nNothing here.\n")).toBeNull();
    expect(parseChangelog("<html>rate limited</html>")).toBeNull();
  });
});

describe("parseStatus", () => {
  it("reads the overall status and the incidents still open", () => {
    expect(parseStatus(STATUS)).toEqual({
      indicator: "minor",
      description: "Partially Degraded Service",
      incidents: ["Elevated errors on Claude Opus 5.5"],
    });
    expect(parseStatus({ ...STATUS, incidents: [], status: { indicator: "none", description: "All Systems Operational" } })).toEqual({
      indicator: "none",
      description: "All Systems Operational",
      incidents: [],
    });
  });

  it("is null for anything else", () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({ status: "ok" })).toBeNull();
    expect(parseStatus({ status: { indicator: "none" } })).toBeNull();
  });
});

describe("parseNpmLatest", () => {
  it("reads the version of the latest tag", () => {
    expect(parseNpmLatest(NPM)).toBe("2.1.320");
    expect(parseNpmLatest({ version: "  3.0.0-rc.1 " })).toBe("3.0.0-rc.1");
  });

  it("is null without a version", () => {
    expect(parseNpmLatest({ error: "Not found" })).toBeNull();
    expect(parseNpmLatest({ version: "latest" })).toBeNull();
    expect(parseNpmLatest("2.1.320")).toBeNull();
  });
});

describe("newestModels", () => {
  const NOW = Date.UTC(2026, 9, 26, 12);

  const provider = (id: string, auth: ProviderInfo["auth"] = "api-key"): ProviderInfo => ({
    id,
    name: id,
    kind: id === "claude-code" ? "claude-code" : "api",
    auth,
    wire: null,
    baseURL: null,
    env: [],
    doc: null,
    supported: true,
  });
  const model = (providerId: string, id: string, name: string, releaseDate: string | null, free = false): ModelInfo => ({
    id,
    name,
    provider: providerId,
    wire: null,
    baseURL: null,
    contextWindow: null,
    maxOutput: null,
    toolCall: true,
    reasoning: true,
    free,
    cost: null,
    status: null,
    releaseDate,
  });

  /** A registry with `connected` signed in. */
  function source(connected: string[], extra: ModelInfo[] = []): ModelSource {
    const providers = [
      provider("claude-code", "cli"),
      provider("opencode", "optional"),
      provider("openrouter", "oauth"),
      provider("anthropic"),
      provider("openai"),
      provider("moonshotai"),
      provider("amazon-bedrock"),
    ];
    const models = [
      model("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", "2026-10-07"),
      model("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", "2026-09-28"),
      model("anthropic", "claude-opus-5-5", "Claude Opus 5.5", "2026-09-22"),
      model("anthropic", "claude-fable-5-1", "Claude Fable 5.1", "2026-09-01"),
      model("anthropic", "claude-opus-4-5", "Claude Opus 4.5", "2025-11-24"),
      model("claude-code", "opus", "Opus", null),
      model("claude-code", "claude-opus-5-5", "Claude Opus 5.5", "2026-09-22"),
      model("claude-code", "claude-haiku-5-5", "Claude Haiku 5.5", "2026-10-07"),
      model("amazon-bedrock", "eu.anthropic.claude-opus-5-5-v1:0", "Claude Opus 5.5 (EU)", "2026-09-22"),
      model("openai", "gpt-6.1-sol", "GPT-6.1 Sol", "2026-09-29"),
      model("openai", "gpt-7", "GPT-7", "2027-03-01"),
      model("opencode", "gpt-6.1-sol", "GPT-6.1 Sol", "2026-09-29"),
      model("opencode", "flint-40b-free", "Flint 40B Free", "2026-10-21", true),
      model("openrouter", "moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro", "2026-10-23"),
      model("openrouter", "elorian/glimpse", "Glimpse", "2026-10-17"),
      model("moonshotai", "kimi-k3.1-pro", "Kimi K3.1 Pro", "2026-10-23"),
      ...extra,
    ];
    return {
      providers: () => providers,
      models: (id) => models.filter((m) => m.provider === id),
      isConnected: (id) => connected.includes(id),
    };
  }

  it("lists Claude first, one row per model, the subscription when it is connected", () => {
    const rows = newestModels(source(["claude-code", "opencode"]), NOW);
    expect(rows.map((r) => `${r.connected ? "●" : "○"} ${r.name} ${r.provider} ${r.releaseDate}`)).toEqual([
      "● Claude Haiku 5.5 claude-code 2026-10-07",
      "○ Claude Sonnet 5.5 anthropic 2026-09-28",
      "● Claude Opus 5.5 claude-code 2026-09-22",
      "○ Kimi K3.1 Pro moonshotai 2026-10-23",
      "● Flint 40B Free opencode 2026-10-21",
      // OpenCode Zen runs only its free models without a key.
      "○ GPT-6.1 Sol openai 2026-09-29",
    ]);
    expect(rows.slice(0, 3).every((r) => r.claude)).toBe(true);
  });

  it("names Anthropic for Claude without the subscription and a connected reseller for the rest", () => {
    const rows = newestModels(source(["openrouter"]), NOW);
    expect(rows.find((r) => r.name === "Claude Opus 5.5")).toMatchObject({ provider: "anthropic", connected: false });
    expect(rows.find((r) => r.name === "Kimi K3.1 Pro")).toMatchObject({ provider: "openrouter", connected: true });
    // A reseller's own long tail is not news, nor a free model nobody can run.
    expect(rows.map((r) => r.name)).not.toContain("Glimpse");
    expect(rows.map((r) => r.name)).not.toContain("Flint 40B Free");
  });

  it("keeps to the last 120 days and leaves announcements out", () => {
    const names = newestModels(source([]), NOW, { limit: 20 }).map((r) => r.name);
    expect(names).toContain("Claude Fable 5.1");
    expect(names).not.toContain("Claude Opus 4.5");
    expect(names).not.toContain("GPT-7");
    expect(names).not.toContain("Opus");
    expect(newestModels(source([]), NOW, { days: 30, limit: 20 }).map((r) => r.name)).toEqual(["Claude Haiku 5.5", "Claude Sonnet 5.5", "Kimi K3.1 Pro", "GPT-6.1 Sol"]);
  });

  it("gives Claude the rows the others don't need, and no more than the limit", () => {
    const onlyClaude: ModelSource = { ...source([]), providers: () => [provider("anthropic")] };
    expect(newestModels(onlyClaude, NOW).map((r) => r.name)).toEqual(["Claude Haiku 5.5", "Claude Sonnet 5.5", "Claude Opus 5.5", "Claude Fable 5.1"]);
    const many = Array.from({ length: 9 }, (_, i) => model("openai", `gpt-x${i}`, `GPT X${i}`, `2026-10-1${i}`));
    const rows = newestModels(source([], many), NOW);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.claude)).toHaveLength(3);
    expect(rows.slice(3).map((r) => r.name)).toEqual(["Kimi K3.1 Pro", "GPT X8", "GPT X7"]);
    expect(newestModels(source([]), NOW, { limit: 0 })).toEqual([]);
  });

  it("reads release dates", () => {
    expect(releaseTime("2026-10-12")).toBe(Date.UTC(2026, 9, 12));
    expect(releaseTime("2026-10")).toBe(Date.UTC(2026, 9, 1));
    expect(releaseTime("soon")).toBeNull();
    expect(releaseTime(null)).toBeNull();
  });
});

describe("loadNews", () => {
  const NOW = Date.UTC(2026, 9, 26, 12);

  function sources(overrides: Partial<Record<string, () => Response | Promise<Response>>> = {}) {
    return fakeFetch((url) => {
      const own = overrides[url];
      if (own) return own();
      if (url === CLAUDE_CODE_NPM_URL) return Response.json(NPM);
      if (url === CLAUDE_CODE_CHANGELOG_URL) return new Response(CHANGELOG, { status: 206 });
      if (url === ANTHROPIC_STATUS_URL) return Response.json(STATUS);
      if (url === APPS_NOTES_URL) return new Response(APPS_NOTES);
      if (url === PLATFORM_NOTES_URL) return new Response(PLATFORM_NOTES);
      return new Response("not found", { status: 404 });
    });
  }

  it("asks every source at once and keeps the answers for an hour", async () => {
    const fetchImpl = sources();
    const news = await loadNews({ cacheDir: dir, fetchImpl, now: NOW });
    const claude = [...parseAppNotes(APPS_NOTES), ...parsePlatformNotes(PLATFORM_NOTES).filter((i) => i.kind !== "news")].sort((a, b) => b.date.localeCompare(a.date));
    expect(news).toEqual({
      claudeCodeLatest: "2.1.320",
      changelog: parseChangelog(CHANGELOG),
      status: parseStatus(STATUS),
      claude: expect.any(Array),
      fetchedAt: NOW,
      loadedAt: NOW,
    });
    // Claude's release notes, newest first, a dozen at most.
    expect(news.claude?.map((i) => i.date)).toEqual(claude.slice(0, 12).map((i) => i.date));
    expect(news.claude?.some((i) => i.title === "Claude Haiku 5.5 launch" && i.kind === "model")).toBe(true);
    expect(fetchImpl.calls.map((c) => c.url).sort()).toEqual([ANTHROPIC_STATUS_URL, APPS_NOTES_URL, CLAUDE_CODE_CHANGELOG_URL, CLAUDE_CODE_NPM_URL, PLATFORM_NOTES_URL].sort());
    // Only the top of the changelog, with a deadline for every request.
    const changelog = fetchImpl.calls.find((c) => c.url === CLAUDE_CODE_CHANGELOG_URL)!;
    expect((changelog.init?.headers as Record<string, string>).range).toBe("bytes=0-65535");
    expect(fetchImpl.calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
    expect(fs.existsSync(path.join(dir, NEWS_CACHE_FILE))).toBe(true);

    const later = await loadNews({ cacheDir: dir, fetchImpl, now: NOW + 30 * 60_000 });
    expect(fetchImpl.calls).toHaveLength(5);
    expect(later).toMatchObject({ claudeCodeLatest: "2.1.320", fetchedAt: NOW, loadedAt: NOW + 30 * 60_000 });
    expect(later.claude).toEqual(news.claude);

    await loadNews({ cacheDir: dir, fetchImpl, now: NOW + NEWS_MAX_AGE_MS });
    expect(fetchImpl.calls).toHaveLength(10);
    await loadNews({ cacheDir: dir, fetchImpl, now: NOW + NEWS_MAX_AGE_MS + 1, force: true });
    expect(fetchImpl.calls).toHaveLength(15);
  });

  it("gives each source that fails its own null and tries it again next time", async () => {
    const broken = sources({
      [CLAUDE_CODE_NPM_URL]: () => new Response("Service Unavailable", { status: 503 }),
      [CLAUDE_CODE_CHANGELOG_URL]: () => Promise.reject(new TypeError("fetch failed")),
      [ANTHROPIC_STATUS_URL]: () => new Response("<html>Just a moment...</html>", { headers: { "content-type": "text/html" } }),
      [APPS_NOTES_URL]: () => new Response("", { status: 500 }),
      [PLATFORM_NOTES_URL]: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(loadNews({ cacheDir: dir, fetchImpl: broken, now: NOW })).resolves.toEqual({
      claudeCodeLatest: null,
      changelog: null,
      status: null,
      claude: null,
      fetchedAt: NOW,
      loadedAt: NOW,
    });
    expect(fs.existsSync(path.join(dir, NEWS_CACHE_FILE))).toBe(false);

    const statusDown = sources({ [ANTHROPIC_STATUS_URL]: () => new Response("", { status: 500 }) });
    const partial = await loadNews({ cacheDir: dir, fetchImpl: statusDown, now: NOW + 60_000 });
    expect(partial).toMatchObject({ claudeCodeLatest: "2.1.320", status: null });
    expect(partial.changelog?.version).toBe("2.1.320");

    // Only the one that failed is asked again.
    const fetchImpl = sources();
    const whole = await loadNews({ cacheDir: dir, fetchImpl, now: NOW + 2 * 60_000 });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([ANTHROPIC_STATUS_URL]);
    expect(whole).toMatchObject({ status: { indicator: "minor" }, fetchedAt: NOW + 60_000 });
  });

  it("stops waiting for a source that doesn't answer", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === CLAUDE_CODE_CHANGELOG_URL) return new Response(CHANGELOG);
      // Never answers on its own: only the timeout's signal ends it.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    });
    const started = Date.now();
    const news = await loadNews({ cacheDir: dir, fetchImpl, now: NOW, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(news).toMatchObject({ claudeCodeLatest: null, status: null });
    expect(news.changelog?.version).toBe("2.1.320");
  });

  it("ignores a cache file it can't read", async () => {
    fs.writeFileSync(path.join(dir, NEWS_CACHE_FILE), "{ not json");
    const fetchImpl = sources();
    expect((await loadNews({ cacheDir: dir, fetchImpl, now: NOW })).claudeCodeLatest).toBe("2.1.320");
    fs.writeFileSync(path.join(dir, NEWS_CACHE_FILE), JSON.stringify({ version: 1, sources: { npm: { at: NOW, value: 42 }, status: { at: NOW, value: { indicator: 1 } } } }));
    const again = await loadNews({ cacheDir: dir, fetchImpl, now: NOW + 1000 });
    expect(again).toMatchObject({ claudeCodeLatest: "2.1.320", status: { indicator: "minor" } });
  });
});

describe("newsStale", () => {
  const NOW = Date.UTC(2026, 9, 26, 12);
  const news = (over: Partial<News> = {}): News => ({
    claudeCodeLatest: "2.1.320",
    changelog: { version: "2.1.320", bullets: [] },
    status: { indicator: "none", description: "All Systems Operational", incidents: [] },
    claude: [{ date: "2026-10-07", title: "Claude Haiku 5.5 launch", kind: "model", source: "apps", url: "https://support.claude.com/" }],
    fetchedAt: NOW,
    loadedAt: NOW,
    ...over,
  });

  it("wants news when there is none, when it is an hour old, or a part is missing a while", () => {
    expect(newsStale(null, NOW)).toBe(true);
    expect(newsStale(news(), NOW + 59 * 60_000)).toBe(false);
    expect(newsStale(news(), NOW + NEWS_MAX_AGE_MS)).toBe(true);
    expect(newsStale(news({ status: null }), NOW + 60_000)).toBe(false);
    expect(newsStale(news({ status: null }), NOW + NEWS_RETRY_MS)).toBe(true);
    // A clock that went back.
    expect(newsStale(news(), NOW - 60_000)).toBe(true);
  });
});
