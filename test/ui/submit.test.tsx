// Sending from the prompt: what happens to the attached files when a message goes out (or doesn't).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-ui-submit-"));
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

describe("submitting a message with attachments", () => {
  it("keeps the files (and the text) when an @name matches nobody", async () => {
    const shot = path.join(dir, "shot.png");
    fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const got = team();
    const ui = render(<App hub={hub} onExit={() => undefined} />);
    try {
      const frame = () => ui.lastFrame() ?? "";
      /** Types `text` into the prompt and presses enter once it shows. */
      const send = async (text: string) => {
        ui.stdin.write(text);
        await until(() => expect(frame()).toContain(text));
        ui.stdin.write("\r");
      };
      // Relative to the project folder.
      await send("/attach shot.png");
      await until(() => expect(frame()).toContain("shot.png · 8 B"));

      // A typo in the name: nobody gets it, and nothing typed or attached is lost.
      await send("@vgea look at this");
      await until(() => expect(hub.toasts.map((t) => t.text)).toContain('Nobody called "vgea" here.'));
      await sleep(50);
      expect(frame()).toContain("shot.png · 8 B");
      expect(frame()).toContain("@vgea look at this");
      expect(got.vega).toEqual([]);

      // Fixed: vega gets the text and the picture, and the chips are gone.
      ui.stdin.write("\u001b");
      await until(() => expect(frame()).not.toContain("@vgea look at this"));
      await send("@vega look at this");
      await until(() => expect(got.vega).toHaveLength(1));
      expect(got.vega[0].text).toBe("look at this");
      expect(got.vega[0].attachments?.map((a) => a.name)).toEqual(["shot.png"]);
      await until(() => expect(frame()).not.toContain("shot.png · 8 B"));
      expect(got.luna).toEqual([]);
    } finally {
      ui.unmount();
    }
  });
});

describe("pasting from the clipboard", () => {
  // A fake xclip on the PATH with a screenshot on "the clipboard"; the real ones aren't touched.
  it.skipIf(process.platform !== "linux")("attaches the picture on an empty paste, as Windows Terminal sends for Ctrl+V", async () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const picture = path.join(dir, "screenshot.png");
    fs.writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    fs.writeFileSync(
      path.join(bin, "xclip"),
      `#!/bin/sh\ncase "$*" in\n  *TARGETS*) printf 'TARGETS\\nimage/png\\n' ;;\n  *image/png*) cat '${picture}' ;;\n  *) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("WAYLAND_DISPLAY", "");
    team();
    const ui = render(<App hub={hub} onExit={() => undefined} />);
    try {
      await sleep(50);
      ui.stdin.write("\u001b[200~\u001b[201~");
      await until(() => expect(ui.lastFrame() ?? "").toContain("clipboard.png · 11 B"));
    } finally {
      ui.unmount();
      vi.unstubAllEnvs();
    }
  });
});
