// The home screen's state in the hub: shown over the tabs until a tab is picked (so it survives a
// UI remount), and its news, loaded in the background unless lu-minal runs offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { ANTHROPIC_STATUS_URL, CLAUDE_CODE_CHANGELOG_URL, CLAUDE_CODE_NPM_URL } from "../../src/core/news.js";
import { PLATFORM_NOTES_URL } from "../../src/core/claude-news.js";
import { Project } from "../../src/core/project.js";
import { AuthStore } from "../../src/providers/auth.js";
import type { FetchLike } from "../../src/providers/types.js";
import { ThemeManager } from "../../src/themes/manager.js";
import { fakeFetch } from "../providers/helpers.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-home-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const hubWith = (opts: { offline: boolean; fetchImpl?: FetchLike }) =>
  new Hub({
    config: defaultConfig(),
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: path.join(dir, "cache"),
    stateDir: dir,
    servers: false,
    ...opts,
  });

/** Tabs without agents (nothing to launch). */
function tabs(hub: Hub, names: string[]): void {
  for (const name of names) hub.projects.push(new Project({ cwd: dir, name }, hub.notifier, hub));
}

const newsFetch = () =>
  fakeFetch((url) => {
    if (url === CLAUDE_CODE_NPM_URL) return Response.json({ version: "2.1.320" });
    if (url === CLAUDE_CODE_CHANGELOG_URL) return new Response("## 2.1.320\n\n- Added /rewind\n");
    if (url === ANTHROPIC_STATUS_URL) return Response.json({ incidents: [], status: { indicator: "none", description: "All Systems Operational" } });
    if (url === PLATFORM_NOTES_URL) return new Response("### October 7, 2026\n\n* We've launched Claude Haiku 5.5.\n");
    return new Response("", { status: 404 });
  });

describe("the home screen in the hub", () => {
  it("is all there is without tabs, and covers them when asked for until a tab is picked", () => {
    const hub = hubWith({ offline: true });
    expect(hub.homeShown).toBe(true);
    // Nothing to go back to.
    hub.closeHome();
    expect(hub.homeShown).toBe(true);

    tabs(hub, ["a", "b", "c"]);
    hub.activeIndex = 1;
    expect(hub.homeShown).toBe(false);
    hub.openHome();
    expect(hub.homeShown).toBe(true);
    hub.closeHome();
    expect([hub.homeShown, hub.activeIndex]).toEqual([false, 1]);

    hub.openHome();
    hub.switchTo(7);
    expect(hub.homeShown).toBe(true);
    hub.switchTo(2);
    expect([hub.homeShown, hub.activeIndex]).toEqual([false, 2]);

    // Home sits before the first tab.
    hub.openHome();
    hub.cycleTab(1);
    expect([hub.homeShown, hub.activeIndex]).toEqual([false, 0]);
    hub.openHome();
    hub.cycleTab(-1);
    expect([hub.homeShown, hub.activeIndex]).toEqual([false, 2]);
  });

  it("goes when a folder is opened", async () => {
    const hub = hubWith({ offline: true });
    tabs(hub, ["a"]);
    hub.openHome();
    const project = await hub.openProject({ cwd: dir });
    expect(hub.homeShown).toBe(false);
    expect(hub.activeProject).toBe(project);
    await hub.dispose();
  });

  it("loads the news in the background, never offline", async () => {
    const offlineFetch = newsFetch();
    const offline = hubWith({ offline: true, fetchImpl: offlineFetch });
    offline.openHome();
    await offline.refreshNews(true);
    expect(offline.news).toBeNull();
    expect(offlineFetch.calls).toHaveLength(0);

    const fetchImpl = newsFetch();
    const hub = hubWith({ offline: false, fetchImpl });
    hub.openHome();
    // One load at a time: asking again while it runs joins it.
    await hub.refreshNews();
    // npm, the changelog, the status and Claude's two release-notes pages.
    expect(fetchImpl.calls).toHaveLength(5);
    expect(hub.news).toMatchObject({
      claudeCodeLatest: "2.1.320",
      changelog: { bullets: ["Added /rewind"] },
      status: { indicator: "none" },
      claude: [{ date: "2026-10-07", title: "We've launched Claude Haiku 5.5", kind: "model" }],
    });

    // Fresh news isn't asked for again when home opens once more.
    hub.closeHome();
    tabs(hub, ["a"]);
    hub.openHome();
    await hub.refreshNews();
    expect(fetchImpl.calls).toHaveLength(5);
    await hub.refreshNews(true);
    expect(fetchImpl.calls).toHaveLength(10);
  });
});
