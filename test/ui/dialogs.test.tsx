// Dialogs rendered in a terminal of a real size: the statistics (more rows than fit), the sign-in
// list's coding agents.
import { Box } from "ink";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hub } from "../../src/core/hub.js";
import type { CommandContext } from "../../src/ui/commands.js";
import { createLaunchers } from "../../src/ui/dialogs/index.js";
import { fakeUi, KEYS, renderAt, testHub } from "./ink-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function setup() {
  const t = testHub();
  const ui = fakeUi();
  const launchers = createLaunchers(t.hub, ui, () => ({ hub: t.hub, ui, project: undefined, agent: undefined, setPrompt: () => undefined, toggleZoom: () => undefined, attach: () => undefined, dialogs: launchers }) as CommandContext);
  cleanups.push(t.cleanup);
  return { ...t, ui, launchers };
}

/** Opens the top dialog in a terminal of the given size (dialogs are drawn over a full screen). */
function show(ui: ReturnType<typeof fakeUi>, size: { columns: number; rows: number }) {
  const spec = ui.dialogs.at(-1)!;
  const r = renderAt(
    <Box width={size.columns} height={size.rows}>
      {spec.render(() => ui.closeDialog())}
    </Box>,
    size,
  );
  cleanups.push(r.unmount);
  return r;
}

/** Ten models over five providers and eight projects, like a few days of use. */
function fillStats(hub: Hub) {
  const models = [
    "claude-code/opus",
    "claude-code/sonnet",
    "claude-code/haiku",
    "opencode/big-pickle",
    "openrouter/qwen/qwen3-coder",
    "minimax/MiniMax-M2",
    "openai/gpt-5",
    "google/gemini-3-pro",
    "groq/llama",
    "anthropic/claude-opus-5-5",
  ];
  models.forEach((m, i) => {
    const slash = m.indexOf("/");
    const at = Date.now() - (i % 3) * 86_400_000;
    const project = { cwd: `/work/project-${(i % 8) + 1}`, name: `project-${(i % 8) + 1}` };
    hub.stats.record({ at, provider: m.slice(0, slash), model: m.slice(slash + 1), project, input: 1000 * (i + 1), output: 300 * (i + 1), costUsd: 0.01 * (i + 1) });
  });
  hub.stats.addLines(120, 30);
  hub.stats.agentStarted("claude-code");
  hub.stats.agentStarted("opencode");
}

/** Every line the dialog shows while scrolling from the top to the end. */
async function scrollAll(r: ReturnType<typeof show>): Promise<string[]> {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    for (const line of r.screen().split("\n")) seen.add(line);
    await r.press(KEYS.down, 30);
  }
  for (const line of r.screen().split("\n")) seen.add(line);
  return [...seen];
}

describe("the statistics dialog", () => {
  it("shows every row at 80x24 and scrolls to the last one", async () => {
    const t = setup();
    t.launchers.stats();
    const r = show(t.ui, { columns: 80, rows: 24 });
    await r.waitFor((s) => s.includes("Statistics"), "the dialog");
    const top = r.screen();
    // The first rows are whole, none squashed out.
    for (const row of ["Tokens", "Today", "Last 7 days", "Last 30 days", "All time", "nothing counted yet"]) {
      expect(top).toContain(row);
    }
    expect(top).toContain("↑↓ scroll");
    const lines = await scrollAll(r);
    const text = lines.join("\n");
    for (const row of ["By model", "By provider", "By project", "Agents started: none", "Lines written by agents: +0 -0"]) {
      expect(text).toContain(row);
    }
    // The "–" under each empty section.
    expect(lines.filter((l) => /│ –\s+│/.test(l)).length).toBeGreaterThan(0);
  });

  it("keeps every model, provider and project row at 120x36, each on its own line", async () => {
    const t = setup();
    fillStats(t.hub);
    t.launchers.stats();
    const r = show(t.ui, { columns: 120, rows: 36 });
    await r.waitFor((s) => s.includes("Statistics"), "the dialog");
    const lines = await scrollAll(r);
    const text = lines.join("\n");
    for (const row of ["Tokens", "Last 7 days", "counting since", "Last 14 days"]) expect(text).toContain(row);
    const s = t.hub.stats.summary();
    // (Names longer than the column end in "…".)
    for (const m of s.models.slice(0, 8)) expect(text).toContain(m.model.slice(0, 25));
    for (const p of s.providers) expect(text).toMatch(new RegExp(`│ ${p.provider} +\\d`));
    for (const p of s.projects.slice(0, 6)) expect(text).toContain(p.name);
    expect(text).toMatch(/│ … and 2 more\s+│/);
    expect(text).toMatch(/│ Agents started: claude-code 1 · opencode 1\s+│/);
    expect(text).toMatch(/│ Lines written by agents: \+120 -30\s+│/);
  });

  it("asks before a reset where it can be seen, scrolled or not", async () => {
    const t = setup();
    fillStats(t.hub);
    t.launchers.stats();
    const r = show(t.ui, { columns: 80, rows: 24 });
    await r.waitFor((s) => s.includes("Statistics"), "the dialog");
    await r.press("x");
    expect(r.screen()).toContain("Reset all statistics? y = yes, any other key = no");
    await r.press("y");
    expect(t.hub.stats.summary().allTime.input).toBe(0);
    expect(t.hub.toasts.map((x) => x.text)).toContain("Statistics reset.");
  });
});

describe("the sign-in dialog's coding agents", () => {
  it("say 'not installed' once, so the install command has the room", async () => {
    const t = setup();
    vi.spyOn(t.hub.registry, "acpProgram").mockReturnValue(null);
    t.launchers.login();
    const r = show(t.ui, { columns: 120, rows: 36 });
    await r.waitFor((s) => s.includes("Sign in"), "the dialog");
    await r.press("agents");
    await r.waitFor((s) => s.includes("Gemini CLI"), "the coding agents");
    const rows = r.screen().split("\n");
    const gemini = rows.find((l) => l.includes("Gemini CLI"))!;
    const opencode = rows.find((l) => l.includes("OpenCode (CLI)"))!;
    for (const row of [gemini, opencode]) expect(row.match(/not installed/g)).toHaveLength(1);
    expect(gemini).toContain("npm install -g @google/gemini-cli");
    expect(opencode).toContain("npm install -g opencode-ai (or: curl -fsSL");
  });
});
