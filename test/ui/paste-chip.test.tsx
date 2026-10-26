// Long pastes in the real prompt: a chip instead of 87 lines, the full text for the agent, and the
// chip deleted, forgotten and recalled from the history like one piece.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentDriver, type AgentInput } from "../../src/core/agent.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";
import { App } from "../../src/ui/App.js";

let dir = "";
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-ui-paste-"));
  const config = defaultConfig();
  config.sky = { enabled: false, fps: 0 };
  config.axo = false;
  hub = new Hub({
    config,
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `check` passes (the UI renders asynchronously). */
async function until(check: () => void, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(10);
    }
  }
}

/** A tab with the lead luna and the worker vega, whose drivers record what they get. */
function team(): { luna: AgentInput[]; vega: AgentInput[] } {
  const project = new Project({ cwd: dir, name: "moon" }, hub.notifier, hub);
  const got: Record<string, AgentInput[]> = { luna: [], vega: [] };
  for (const [name, role] of [["luna", "lead"], ["vega", "worker"]] as const) {
    const agent = new Agent({ name, role, model: { provider: "opencode", model: "m" } }, hub.notifier, "auto-edit");
    agent.driver = { kind: "native", start: async () => undefined, send: (i) => got[name].push(i), interrupt: () => undefined, dispose: async () => undefined } as AgentDriver;
    project.agents.push(agent);
  }
  project.focusedId = project.agents[0].id;
  hub.projects.push(project);
  return { luna: got.luna, vega: got.vega };
}

/** Luna's prompt row, the last one in the top panel (her log shows sent messages with "›" too). */
function promptRow(frame: string): string {
  const rows = frame.split("\n");
  return rows[rows.findIndex((r) => r.includes("╰")) - 1] ?? "";
}

const lines = (n: number, word = "line") => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join("\n");
const bracketed = (text: string) => `\u001b[200~${text}\u001b[201~`;
const BACKSPACE = "\u007f";
const UP = "\u001b[A";

describe("pasting a long text", () => {
  it("shows a chip and sends the full text", async () => {
    const got = team();
    const ui = render(<App hub={hub} onExit={() => undefined} />);
    try {
      const frame = () => ui.lastFrame() ?? "";
      const prompt = () => promptRow(frame());
      await sleep(50);
      ui.stdin.write("review this: ");
      await until(() => expect(prompt()).toContain("› review this:"));
      ui.stdin.write(bracketed(lines(87)));
      await until(() => expect(prompt()).toContain("› review this: [Pasted text #1 +87 lines]"));
      expect(frame()).not.toContain("line 87");
      ui.stdin.write("\r");
      await until(() => expect(got.luna).toHaveLength(1));
      expect(got.luna[0].text).toBe(`review this: ${lines(87)}`);
      await until(() => expect(prompt()).not.toContain("[Pasted text #1"));
    } finally {
      ui.unmount();
    }
  });

  it("keeps short pastes as text", async () => {
    const got = team();
    const ui = render(<App hub={hub} onExit={() => undefined} />);
    try {
      await sleep(50);
      ui.stdin.write(bracketed("just a few words"));
      await until(() => expect(promptRow(ui.lastFrame() ?? "")).toContain("› just a few words"));
      ui.stdin.write("\r");
      await until(() => expect(got.luna).toHaveLength(1));
      expect(got.luna[0].text).toBe("just a few words");
    } finally {
      ui.unmount();
    }
  });

  it("deletes the chip at once, forgets it with esc and brings it back from the history", async () => {
    const got = team();
    const ui = render(<App hub={hub} onExit={() => undefined} />);
    try {
      const prompt = () => promptRow(ui.lastFrame() ?? "");
      await sleep(50);
      // Backspace takes the whole chip, and the next paste counts on.
      ui.stdin.write(bracketed(lines(12)));
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +12 lines]"));
      ui.stdin.write(" and ");
      await until(() => expect(prompt()).toContain("lines] and"));
      ui.stdin.write(bracketed(lines(20, "row")));
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +12 lines] and [Pasted text #2 +20 lines]"));
      ui.stdin.write(BACKSPACE);
      await until(() => expect(prompt()).not.toContain("[Pasted text #2"));
      expect(prompt()).toContain("› [Pasted text #1 +12 lines] and ");
      ui.stdin.write(bracketed(lines(7, "item")));
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +12 lines] and [Pasted text #3 +7 lines]"));
      ui.stdin.write("\r");
      await until(() => expect(got.luna).toHaveLength(1));
      expect(got.luna[0].text).toBe(`${lines(12)} and ${lines(7, "item")}`);
      await until(() => expect(prompt()).not.toContain("[Pasted text #1"));

      // Esc clears the prompt and forgets the text: the same words typed by hand stay words.
      ui.stdin.write(bracketed(lines(20, "row")));
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +20 lines]"));
      ui.stdin.write("\u001b");
      await until(() => expect(prompt()).not.toContain("[Pasted text #1"));
      await sleep(50);
      ui.stdin.write("[Pasted text #1 +20 lines]");
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +20 lines]"));
      ui.stdin.write("\r");
      await until(() => expect(got.luna).toHaveLength(2));
      expect(got.luna[1].text).toBe("[Pasted text #1 +20 lines]");

      // A message with a chip, sent and recalled with the up arrow: the chip again, not 20 lines.
      ui.stdin.write(bracketed(lines(20, "row")));
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +20 lines]"));
      ui.stdin.write("\r");
      await until(() => expect(got.luna).toHaveLength(3));
      expect(got.luna[2].text).toBe(lines(20, "row"));
      await until(() => expect(prompt()).not.toContain("[Pasted text #1"));
      ui.stdin.write(UP);
      await until(() => expect(prompt()).toContain("› [Pasted text #1 +20 lines]"));
      ui.stdin.write("\r");
      await until(() => expect(got.luna).toHaveLength(4));
      expect(got.luna[3].text).toBe(lines(20, "row"));
    } finally {
      ui.unmount();
    }
  });

  it("sends the full text to a teammate", async () => {
    const got = team();
    const ui = render(<App hub={hub} onExit={() => undefined} />);
    try {
      const prompt = () => promptRow(ui.lastFrame() ?? "");
      await sleep(50);
      ui.stdin.write("@vega ");
      await until(() => expect(prompt()).toContain("› @vega"));
      ui.stdin.write(bracketed(lines(30)));
      await until(() => expect(prompt()).toContain("› @vega [Pasted text #1 +30 lines]"));
      ui.stdin.write("\r");
      await until(() => expect(got.vega).toHaveLength(1));
      expect(got.vega[0].text).toBe(lines(30));
      expect(got.luna).toEqual([]);
    } finally {
      ui.unmount();
    }
  });
});
