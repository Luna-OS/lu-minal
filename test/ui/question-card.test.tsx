// The question card in a real 80x24 terminal: an agent that asks something after a lot of tool
// output, and a permission request with a long command, are readable in full above the prompt.
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../src/core/agent.js";
import { App } from "../../src/ui/App.js";
import { addProject, KEYS, renderAt, testHub } from "./ink-helpers.js";

const SIZE = { columns: 80, rows: 24 };
const PAGE_UP = "\u001b[5~";
const ESC = "\u001b";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function setup() {
  const t = testHub();
  cleanups.push(t.cleanup);
  t.hub.config.axo = false;
  const { lead } = addProject(t.hub, t.dir);
  const r = renderAt(<App hub={t.hub} onExit={() => undefined} />, SIZE);
  cleanups.push(r.unmount);
  return { ...t, lead, r };
}

/** The screen as one line of words: the frames' lines and the wrapping are gone. */
const words = (screen: string) => screen.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");

const QUESTION = [
  "I rewrote the config parser and ran the whole suite: all 200 tests pass, the build is clean.",
  "",
  "Two things are left open:",
  "1. The old `moon.toml` keys still load, with a warning.",
  "2. The README still shows the old format in three examples.",
  "",
  "Should I also update the docs?",
].join("\n");

/** A turn like a coding agent's: 30 reads, a test run with 200 lines of output, a new file, the question. */
function codingTurn(agent: Agent, answer: string): void {
  agent.startTurn();
  for (let i = 0; i < 30; i++) {
    agent.append({ kind: "tool", toolCallId: `r${i}`, name: "Read", verb: "read", target: `src/file${i}.ts`, status: "ok", detail: "94 lines" });
  }
  const output = Array.from({ length: 200 }, (_, i) => `✓ test/case-${i}.test.ts (${i % 7} ms)`).join("\n");
  agent.append({ kind: "tool", toolCallId: "t", name: "Bash", verb: "run", target: "npm test", status: "ok", detail: output });
  const diff = Array.from({ length: 120 }, (_, i) => ({ kind: "add" as const, line: i + 1, text: `export const key${i} = ${i};` }));
  agent.append({ kind: "tool", toolCallId: "w", name: "Write", verb: "new", target: "src/keys.ts", status: "ok", detail: "120 lines added", diff });
  agent.appendStream("text", answer);
  agent.endStream("text");
  agent.endTurn("idle");
}

describe("the question card", () => {
  it("shows the whole question after 200 lines of tool output, until the user answers", async () => {
    const { lead, r } = setup();
    const got: string[] = [];
    lead.driver!.send = (input) => {
      got.push(input.text);
      if (got.length === 1) codingTurn(lead, QUESTION);
      else {
        lead.startTurn();
        lead.appendStream("text", "Done: the docs show the new format.");
        lead.endStream("text");
        lead.endTurn("idle");
      }
    };
    await r.waitFor((s) => s.includes("Message luna"), "the prompt");
    await r.press("parse the new config format");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("luna asks"), "the question card");

    const screen = r.screen();
    // Every word of the answer is on the screen, in order: nothing cut off at the top.
    expect(words(screen)).toContain(words(QUESTION.replace(/`/g, "")));
    expect(screen).toMatch(/╭ ◆ luna asks ─+╮/);
    expect(screen).toContain("Should I also update the docs?");
    expect(screen).toContain("esc dismisses");
    // The card sits right above the status line and the prompt.
    const lines = screen.split("\n");
    const bottom = lines.findIndex((l) => /╰ answer below/.test(l));
    expect(lines[bottom + 1]).toContain("ready");
    expect(lines[bottom + 2]).toContain("Message luna");

    // Answering puts the card away; the next answer asks nothing.
    await r.press("yes please");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("Done: the docs show the new format."), "the next answer");
    expect(r.screen()).not.toContain("luna asks");
    expect(got).toEqual(["parse the new config format", "yes please"]);
  });

  it("goes away with esc and leaves the question in the log", async () => {
    const { lead, r } = setup();
    await r.waitFor((s) => s.includes("Message luna"), "the prompt");
    codingTurn(lead, "The parser is done.\n\nShould I also update the docs?");
    await r.waitFor((s) => s.includes("luna asks"), "the question card");
    await r.press(ESC);
    await r.waitFor((s) => !s.includes("luna asks"), "the card to go");
    expect(r.screen()).toContain("Should I also update the docs?");
    // Above it, the tool output and the new file stay short until zoomed.
    await r.press(PAGE_UP);
    await r.waitFor((s) => s.includes("more lines (ctrl+f to expand)"), "the collapsed output");
  });

  it("shows a pending request with a long command in full, answered with y", async () => {
    const { lead, r } = setup();
    await r.waitFor((s) => s.includes("Message luna"), "the prompt");
    const command =
      "npm run build && npm test -- --run test/ui test/core --reporter verbose && git diff --stat origin/main && echo all checks passed for the night sky release";
    const decision = lead.requestApproval({
      tool: "Bash",
      risk: "exec",
      summary: `run ${command.slice(0, 59)}…`,
      detail: `${command}\n(Build, test and compare with main)`,
      allowKey: "Bash:npm run build",
    });
    await r.waitFor((s) => s.includes("luna asks"), "the request card");
    const screen = r.screen();
    expect(words(screen)).toContain(`run ${command}`);
    expect(words(screen)).toContain("(Build, test and compare with main)");
    expect(screen).toMatch(/╭ ▲ luna asks · Bash ─+╮/);
    expect(screen).toMatch(/╰ {2}y {2}allow {3}a {2}always {3}n {2}deny ─+╯/);
    // The log keeps the request to its one line.
    expect(screen.match(/run npm run build/g)).toHaveLength(2);

    await r.press("y");
    await expect(decision).resolves.toBe("allow");
    await r.waitFor((s) => !s.includes("luna asks"), "the card to go");
  });

  it("scrolls a request longer than half the panel with pgdn and pgup", async () => {
    const { lead, r } = setup();
    await r.waitFor((s) => s.includes("Message luna"), "the prompt");
    // Edits ask first in this mode.
    lead.permissionMode = "ask";
    const diff = Array.from({ length: 40 }, (_, i) => `+ line ${i + 1} of the new file`).join("\n");
    void lead.requestApproval({ tool: "Write", risk: "edit", summary: "create src/moon.ts", detail: `40 lines\n${diff}`, allowKey: "Write" });
    await r.waitFor((s) => s.includes("luna asks"), "the request card");
    // The card's rows: inside the panel's border, its own (╭, │ or ╰).
    const cardRows = () => r.screen().split("\n").filter((l) => /^ │ [╭│╰]/.test(l));
    expect(r.screen()).toContain("│ create src/moon.ts");
    expect(r.screen()).not.toContain("line 12 of the new file");
    expect(r.screen()).toContain("↓ 34 more · pgdn");
    // About half the 19-row panel; the log keeps the rest.
    expect(cardRows()).toHaveLength(10);

    await r.press(KEYS.pageDown);
    await r.waitFor((s) => s.includes("line 12 of the new file"), "the next page");
    expect(r.screen()).not.toContain("│ create src/moon.ts");
    await r.press(PAGE_UP);
    await r.waitFor((s) => s.includes("│ create src/moon.ts"), "the first page again");
  });
});
