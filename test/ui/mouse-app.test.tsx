// The mouse in the whole app, as the terminal reports it (SGR reports written to stdin): the wheel
// scrolls the panel under the pointer and stops at the top, a click focuses a panel, a drag says
// how to select text, list dialogs and home move their selection; /mouse turns the terminal's
// reporting on and off; /copy puts the focused agent's last reply on the clipboard.
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, type AgentDriver } from "../../src/core/agent.js";
import type { Hub } from "../../src/core/hub.js";
import type { Project } from "../../src/core/project.js";
import { App } from "../../src/ui/App.js";
import { MOUSE_OFF, MOUSE_ON, SELECT_HINT } from "../../src/ui/mouse.js";
import { addProject, KEYS, renderAt, testHub } from "./ink-helpers.js";

const SIZE = { columns: 120, rows: 36 };
// At 120 x 36 the lead's panel takes rows 2-13 and the worker's rows 15-34 (0-based).
const ON_LEAD = { x: 10, y: 6 };
const ON_WORKER = { x: 10, y: 22 };
const ON_HEADER = { x: 10, y: 1 };

/** An SGR report for the 0-based cell. */
const report = (code: number, at: { x: number; y: number }, release = false) => `\u001b[<${code};${at.x + 1};${at.y + 1}${release ? "m" : "M"}`;
const wheelUp = (at: { x: number; y: number }, times = 1) => report(64, at).repeat(times);
const wheelDown = (at: { x: number; y: number }, times = 1) => report(65, at).repeat(times);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function addWorker(hub: Hub, project: Project, name: string): Agent {
  const w = new Agent({ name, role: "worker", model: { provider: "claude-code", model: "sonnet" } }, hub.notifier, "auto-edit");
  w.driver = { kind: "native", start: async () => undefined, send: () => undefined, interrupt: () => undefined, dispose: async () => undefined } as AgentDriver;
  project.agents.push(w);
  return w;
}

function setup(lines = 40) {
  const t = testHub();
  cleanups.push(t.cleanup);
  const { project, lead } = addProject(t.hub, t.dir);
  const worker = addWorker(t.hub, project, "nova");
  for (let i = 0; i < lines; i++) {
    lead.append({ kind: "info", text: `lead line ${i}` });
    worker.append({ kind: "info", text: `nova line ${i}` });
  }
  const r = renderAt(<App hub={t.hub} onExit={() => undefined} />, SIZE);
  cleanups.push(r.unmount);
  return { ...t, project, lead, worker, r };
}

const scrolledBy = (screen: string) => [...screen.matchAll(/↑ scrolled (\d+) rows/g)].map((m) => Number(m[1]));

describe("the mouse wheel", () => {
  it("scrolls the panel under the pointer, and the focused one from outside the panels", async () => {
    const { r } = setup();
    await r.waitFor((s) => s.includes("lead line 39") && s.includes("nova line 39"), "both logs");
    await r.press(wheelUp(ON_LEAD));
    await r.waitFor((s) => scrolledBy(s).join() === "3" && !s.includes("lead line 39") && s.includes("lead line 36") && s.includes("nova line 39"), "the lead scrolled 3 rows");
    await r.press(wheelUp(ON_WORKER, 2));
    await r.waitFor((s) => scrolledBy(s).join() === "3,6" && !s.includes("nova line 39"), "the worker scrolled 6 rows");
    await r.press(wheelDown(ON_LEAD));
    await r.waitFor((s) => scrolledBy(s).join() === "6" && s.includes("lead line 39"), "the lead following again");
    // Over the header: the focused panel (the lead's).
    await r.press(wheelUp(ON_HEADER));
    await r.waitFor((s) => scrolledBy(s).join() === "3,6", "the focused panel scrolled");
  });

  it("stops at the top of the log, so scrolling back down moves at once", async () => {
    const { r } = setup(14);
    await r.waitFor((s) => s.includes("lead line 13"), "the log");
    await r.press(wheelUp(ON_LEAD, 20));
    await r.waitFor((s) => s.includes("lead line 0") && scrolledBy(s).length > 0, "the top of the log");
    const [top] = scrolledBy(r.screen());
    expect(top).toBeLessThan(14);
    // More wheel at the top changes nothing...
    await r.press(wheelUp(ON_LEAD, 5));
    expect(scrolledBy(r.screen())).toEqual([top]);
    // ...and the first step down shows the next rows.
    await r.press(wheelDown(ON_LEAD));
    await r.waitFor((s) => scrolledBy(s).join() === String(top - 3), "one step down");
  });

  it("moves the selection in a list dialog, and the pick on home", async () => {
    const { r, hub, dir } = setup(2);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press("?");
    await r.waitFor((s) => s.includes("keys and commands") && s.includes("› enter"), "the help");
    await r.press(wheelDown(ON_LEAD, 2));
    await r.waitFor((s) => s.includes("› tab, ctrl+↑ ↓"), "the third key picked");
    await r.press(wheelUp(ON_LEAD, 5));
    // The wheel stops at the first item (the arrows wrap around).
    await r.waitFor((s) => s.includes("› enter"), "back at the first");
    await r.press("\u001b");
    await r.waitFor((s) => !s.includes("keys and commands"), "the help closed");

    const folders = ["gf-sim", "moon-code"].map((name) => {
      const d = path.join(dir, "code", name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    });
    hub.config.recent = folders;
    hub.openHome();
    await r.waitFor((s) => s.includes("› gf-sim"), "home");
    await r.press(wheelDown(ON_LEAD));
    await r.waitFor((s) => s.includes("› moon-code"), "the second folder picked");
  });
});

describe("clicks", () => {
  it("focus the panel clicked on", async () => {
    const { r, project, worker } = setup(2);
    await r.waitFor((s) => s.includes("Message luna"), "the lead's prompt");
    await r.press(report(0, ON_WORKER) + report(0, ON_WORKER, true));
    await r.waitFor((s) => s.includes("Message nova"), "the worker's prompt");
    expect(project.focused).toBe(worker);
    expect(r.screen()).not.toContain(SELECT_HINT);
  });

  it("say once how to select text when someone drags", async () => {
    const { r, hub } = setup(2);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press(report(0, ON_LEAD) + report(0, { x: 40, y: 8 }, true));
    expect(hub.toasts.map((x) => x.text)).toEqual([SELECT_HINT]);
    await r.press(report(0, ON_LEAD) + report(0, { x: 30, y: 9 }, true));
    expect(hub.toasts).toHaveLength(1);
  });
});

describe("/mouse", () => {
  it("turns the terminal's mouse reporting on and off, and keeps the choice", async () => {
    const { r, hub } = setup();
    const saved = vi.spyOn(hub, "persistConfig");
    await r.waitFor((s) => s.includes("lead line 39"), "the project");
    expect(r.terminal).toEqual([MOUSE_ON]);
    await r.press("/mouse off");
    await r.press(KEYS.enter);
    await vi.waitFor(() => expect(r.terminal).toEqual([MOUSE_ON, MOUSE_OFF]));
    expect(hub.config.mouse).toBe(false);
    expect(saved).toHaveBeenCalled();
    // Off, the wheel (were it still reported) leaves the panels alone.
    await r.press(wheelUp(ON_LEAD));
    expect(scrolledBy(r.screen())).toEqual([]);
    // Without a word it toggles.
    await r.press("/mouse");
    await r.press(KEYS.enter);
    await vi.waitFor(() => expect(r.terminal).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON]));
    expect(hub.config.mouse).toBe(true);
    expect(hub.toasts.at(-1)?.text).toContain("Shift");
  });

  it("turns reporting off when lu-minal ends", async () => {
    const { r } = setup(2);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    r.unmount();
    expect(r.terminal).toEqual([MOUSE_ON, MOUSE_OFF]);
  });

  it("leaves the mouse to the macOS app's terminal, which keeps the wheel for itself", async () => {
    vi.stubEnv("LU_MINAL_APP", "1");
    const { r } = setup(2);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    expect(r.terminal).toEqual([]);
  });
});

// The fake clipboard programs are shell scripts.
describe.skipIf(process.platform === "win32")("/copy", () => {
  it("copies the focused agent's last reply without the tool output", async () => {
    const t = testHub();
    cleanups.push(t.cleanup);
    const { lead } = addProject(t.hub, t.dir);
    lead.append({ kind: "user", from: "you", text: "make the moon brighter" });
    lead.append({ kind: "text", text: "Looking at the shader." });
    lead.append({ kind: "tool", toolCallId: "t1", name: "Bash", verb: "run", target: "npm test", status: "ok", detail: "42 passed" });
    lead.append({ kind: "text", text: "Done: the moon is 20 % brighter.\nShould the stars follow?" });
    // Fake pbcopy / xclip / wl-copy that keep what they are given.
    const bin = path.join(t.dir, "bin");
    const out = path.join(t.dir, "clipboard.txt");
    fs.mkdirSync(bin);
    for (const name of ["pbcopy", "xclip", "wl-copy"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n/bin/cat > '${out}'\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("DISPLAY", ":0");
    for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "WSL_DISTRO_NAME", "WSL_INTEROP"]) vi.stubEnv(name, "");
    const r = renderAt(<App hub={t.hub} onExit={() => undefined} />, SIZE);
    cleanups.push(r.unmount);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press("/copy");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("Copied 4 lines."), "the toast");
    expect(fs.readFileSync(out, "utf8")).toBe("Looking at the shader.\n\nDone: the moon is 20 % brighter.\nShould the stars follow?");
  });

  it("says so when there is nothing to copy yet", async () => {
    const t = testHub();
    cleanups.push(t.cleanup);
    addProject(t.hub, t.dir);
    const r = renderAt(<App hub={t.hub} onExit={() => undefined} />, SIZE);
    cleanups.push(r.unmount);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press("/copy");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("luna hasn't replied yet"), "the toast");
  });
});
