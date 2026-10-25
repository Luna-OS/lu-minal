// The whole screen in a terminal of a real size: quitting, the clocks and moods that move on while
// nothing else happens, and the help dialog on the welcome screen.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/ui/App.js";
import { addProject, KEYS, renderAt, testHub } from "./ink-helpers.js";

const SIZE = { columns: 120, rows: 36 };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  vi.restoreAllMocks();
});

function setup() {
  const t = testHub();
  cleanups.push(t.cleanup);
  return t;
}

function show(t: ReturnType<typeof setup>, onExit: () => void = () => undefined) {
  const r = renderAt(<App hub={t.hub} onExit={onExit} />, SIZE);
  cleanups.push(r.unmount);
  return r;
}

/** Lets the test move the clock forward without any time passing (and so without a render). */
function clock() {
  const real = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
  return { skip: (ms: number) => void (offset += ms) };
}

describe("<App>", () => {
  it("quits on ctrl+c twice after sitting idle", async () => {
    const t = setup();
    addProject(t.hub, t.dir);
    const time = clock();
    const onExit = vi.fn();
    const r = show(t, onExit);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    time.skip(12_000);
    await r.press(KEYS.ctrlC, 300);
    expect(t.hub.toasts.map((x) => x.text)).toEqual(["Press ctrl+c again to quit."]);
    await r.press(KEYS.ctrlC, 300);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
    // Only one "again" toast: the second press quit.
    expect(t.hub.toasts).toHaveLength(1);
  });

  it("moves the header clock on and lets Axo stop cheering while nobody works", async () => {
    const t = setup();
    const { lead } = addProject(t.hub, t.dir);
    lead.setStatus("working");
    const time = clock();
    const r = show(t);
    await r.waitFor((s) => s.includes("Working…"), "the busy lead");
    lead.setStatus("idle");
    await r.waitFor((s) => s.includes("Done!"), "Axo's cheer");
    expect(r.screen()).toMatch(/proj · 0s/);
    time.skip(5_000);
    // Five skipped seconds plus the real one the tick waits.
    await r.waitFor((s) => /proj · [5-9]s/.test(s) && s.includes("Ready when you are.") && !s.includes("Done!"), "the clock and Axo to move on", 2500);
  });

  it("runs a command picked in the help on the welcome screen", async () => {
    const t = setup();
    const r = show(t);
    await r.waitFor((s) => s.includes("a team of coding agents"), "the welcome screen");
    await r.press("?");
    await r.waitFor((s) => s.includes("keys and commands"), "the help");
    await r.press("/tab");
    await r.waitFor((s) => s.includes("› /tab"), "/tab picked");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("New tab") && s.includes("one project per tab"), "the New tab dialog");
  });

  it("puts a command picked in the help into the prompt when there is one", async () => {
    const t = setup();
    addProject(t.hub, t.dir);
    const r = show(t);
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    await r.press("?");
    await r.waitFor((s) => s.includes("keys and commands"), "the help");
    await r.press("/stats");
    await r.waitFor((s) => s.includes("› /stats"), "/stats picked");
    await r.press(KEYS.enter);
    await r.waitFor((s) => s.includes("› /stats") && !s.includes("keys and commands"), "the command in the prompt");
    expect(r.screen()).not.toContain("◆ Statistics");
  });
});
