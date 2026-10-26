// The home screen in a real-size terminal: /home and alt+0 open it over the tabs, its blocks fit
// 80x24 and 120x36, esc and alt+1 leave it, nothing typed there reaches a prompt, the recent
// folders open with enter, and the tab bar marks it like an active tab.
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { News } from "../../src/core/news.js";
import { buildCatalog } from "../../src/providers/catalog.js";
import { App } from "../../src/ui/App.js";
import { shortDate } from "../../src/ui/components/Home.js";
import { parseRow } from "./ansi-helpers.js";
import { addProject, KEYS, renderAt, testHub } from "./ink-helpers.js";

const ALT_0 = "\u001b0";
const ALT_1 = "\u001b1";
const ESC = "\u001b";

let level: typeof chalk.level;
beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  vi.restoreAllMocks();
});

const NEWS: News = {
  claudeCodeLatest: "2.1.320",
  changelog: { version: "2.1.320", bullets: ["Added /rewind to step back through a conversation", "Fixed a hang with slow MCP servers", "Faster start on Windows"] },
  status: { indicator: "minor", description: "Partially Degraded Service", incidents: ["Elevated errors on Claude Opus 5.5"] },
  fetchedAt: Date.now() - 5 * 60_000,
  loadedAt: Date.now(),
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const chat = (id: string, name: string, released: string, free = false) => ({
  id,
  name,
  tool_call: true,
  release_date: released,
  modalities: { input: ["text"], output: ["text"] },
  cost: free ? { input: 0, output: 0 } : { input: 1, output: 5 },
});
/** A models.dev catalog whose models came out a few weeks ago, whenever the test runs. */
const CATALOG = {
  anthropic: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"], models: { "claude-haiku-5-5": chat("claude-haiku-5-5", "Claude Haiku 5.5", daysAgo(19)) } },
  openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], models: { "gpt-6.1-sol": chat("gpt-6.1-sol", "GPT-6.1 Sol", daysAgo(27)), "gpt-4o": chat("gpt-4o", "GPT-4o", "2024-05-13") } },
  opencode: { id: "opencode", name: "OpenCode Zen", npm: "@ai-sdk/openai-compatible", api: "https://opencode.ai/zen/v1", env: [], models: { "flint-40b-free": chat("flint-40b-free", "Flint 40B Free", daysAgo(5), true) } },
};

/** A hub with one tab, two recent folders, the news, a Claude Code that is behind and a lu-minal update. */
function setup() {
  const t = testHub();
  cleanups.push(t.cleanup);
  t.hub.registry.setCatalog(buildCatalog(CATALOG, "network", Date.now()));
  const folders = ["gf-sim", "moon-code"].map((name) => {
    const d = path.join(t.dir, "code", name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  });
  t.hub.config.recent = [...folders, t.dir];
  const tab = addProject(t.hub, t.dir);
  t.hub.news = NEWS;
  t.hub.claudeAccount = { installed: true, exe: "/bin/claude", version: "2.1.300", loggedIn: true, authMethod: "claude.ai", email: "ada@example.com", organization: null, plan: "max" };
  t.hub.updateAvailable = { version: "0.1.4", url: "https://github.com/Luna-OS/lu-minal/releases/tag/v0.1.4" };
  return { ...t, ...tab, folders };
}

function show(t: ReturnType<typeof setup>, size: { columns: number; rows: number }) {
  const r = renderAt(<App hub={t.hub} onExit={() => undefined} />, size);
  cleanups.push(r.unmount);
  return r;
}

/** Every block of home, as it reads on the screen. */
const BLOCKS = [
  "◆ Start",
  "◆ Recent",
  "› gf-sim",
  "◆ New models",
  "Claude Haiku 5.5",
  "◆ Claude Code",
  "installed 2.1.300 · newest 2.1.320",
  "↑ 2.1.320 is out - claude update",
  "◆ Anthropic status",
  "● Partially Degraded Service",
  "◆ lu-minal",
  "↑ 0.1.4 is out - /update",
];

describe("the home screen", () => {
  it("opens with /home at 120x36, every block whole, and esc goes back to the tab", async () => {
    const t = setup();
    const r = show(t, { columns: 120, rows: 36 });
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press("/home");
    await r.press(KEYS.enter);
    await r.waitFor((s) => BLOCKS.every((b) => s.includes(b)), "every block of home");
    const screen = r.screen();
    expect(screen).not.toContain("Message luna");
    expect(screen).toContain("a team of coding agents under the night sky");
    expect(screen).toContain("· Added /rewind to step back through a conversation");
    expect(screen).toContain("▲ Elevated errors on Claude Opus 5.5");
    // Claude first (through the subscription), the free one ready, the old one gone.
    const models = screen.split("\n").filter((row) => /[●○] (Claude|GPT|Flint)/.test(row)).map((row) => row.slice(row.search(/[●○]/)).replace(/\s+/g, " ").trim());
    expect(models).toEqual([`● Claude Haiku 5.5 claude-code ${shortDate(daysAgo(19))}`, `● Flint 40B Free opencode ${shortDate(daysAgo(5))}`, `○ GPT-6.1 Sol openai ${shortDate(daysAgo(27))}`]);
    expect(screen).toContain("esc back to proj");
    // Nothing is wider than the window.
    expect(screen.split("\n").every((row) => row.length <= 120)).toBe(true);
    expect(t.hub.showHome).toBe(true);

    await r.press(ESC, 150);
    await r.waitFor((s) => s.includes("Message luna") && !s.includes("◆ New models"), "the tab again");
    expect(t.hub.showHome).toBe(false);
  });

  it("opens with alt+0 at 80x24, keeps a row of every block, takes no typing and goes with alt+1", async () => {
    const t = setup();
    const r = show(t, { columns: 80, rows: 24 });
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press(ALT_0);
    await r.waitFor((s) => BLOCKS.every((b) => s.includes(b)), "every block of home");
    expect(r.screen().split("\n")).toHaveLength(24);

    await r.press("hello");
    await r.press(ALT_1);
    await r.waitFor((s) => s.includes("Message luna"), "the tab again");
    expect(r.screen()).not.toContain("hello");
    expect(t.hub.showHome).toBe(false);
  });

  it("stands in for an empty window, where esc stays and ? opens the help", async () => {
    const t = setup();
    t.hub.projects.splice(0);
    t.hub.news = null;
    const r = show(t, { columns: 100, rows: 30 });
    await r.waitFor((s) => s.includes("◆ New models") && s.includes("offline"), "home without news");
    expect(r.screen()).toContain("ctrl+t open a project");
    await r.press(ESC, 150);
    expect(r.screen()).toContain("◆ New models");
    await r.press("?");
    await r.waitFor((s) => s.includes("keys and commands") && s.includes("home: recent folders and news"), "the help");
  });

  it("opens a recent folder with ↓ and enter, and switches to its tab when it is open", async () => {
    const t = setup();
    const opened = vi.spyOn(t.hub, "openProject").mockImplementation(async () => t.project);
    const r = show(t, { columns: 120, rows: 36 });
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press(ALT_0);
    await r.waitFor((s) => s.includes("› gf-sim"), "the recent folders");
    await r.press(KEYS.down);
    await r.waitFor((s) => s.includes("› moon-code"), "the second folder picked");
    await r.press(KEYS.enter);
    expect(opened).toHaveBeenCalledWith({ cwd: t.folders[1] });

    t.hub.openHome();
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.waitFor((s) => /› \S+\s+\S+\s+tab 1/.test(s), "the open folder picked");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("Message luna"), "its tab");
    expect(opened).toHaveBeenCalledOnce();
  });

  it("marks ☾ lu-minal in the tab bar like the active tab", async () => {
    const t = setup();
    const c = t.hub.theme.colors;
    const r = show(t, { columns: 120, rows: 36 });
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    /** The background of the tab bar's "lu-minal" and of the tab's name. */
    const backgrounds = () => {
      const cells = parseRow(r.stdout.frames.at(-1)!.split("\n")[0]);
      const text = cells.map((cell) => cell.char).join("");
      return { logo: cells[text.indexOf("lu-minal")].bg, tab: cells[text.indexOf("1 proj")].bg };
    };
    expect(backgrounds()).toEqual({ logo: c.bg, tab: c.tabActiveBg });
    await r.press(ALT_0);
    await r.waitFor((s) => s.includes("◆ New models"), "home");
    expect(backgrounds()).toEqual({ logo: c.tabActiveBg, tab: c.bg });
  });
});
