// Fewer frames while agents work: streamed text is coalesced into ~10 frames a second, the spinners
// keep moving on a pulse when nothing streams, the sky and Axo move with those frames instead of
// timers of their own, and keys never wait for the coalescing.
import chalk from "chalk";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Agent, type AgentDriver } from "../../src/core/agent.js";
import { builtinTheme } from "../../src/themes/builtin.js";
import { App } from "../../src/ui/App.js";
import { Axo } from "../../src/ui/components/Axo.js";
import { Sky } from "../../src/ui/components/Sky.js";
import { animationClock, BUSY_FRAME_MS, sameRows, spinnerFrame, usePulse, useTick, useTicking } from "../../src/ui/frames.js";
import { addProject, renderAt, sleep, testHub } from "./ink-helpers.js";

const SIZE = { columns: 120, rows: 36 };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  vi.restoreAllMocks();
});

function setup() {
  const t = testHub();
  cleanups.push(t.cleanup);
  const { project, lead } = addProject(t.hub, t.dir);
  const worker = new Agent({ name: "vega", role: "worker", model: { provider: "claude-code", model: "sonnet" } }, t.hub.notifier, "auto-edit");
  worker.driver = { kind: "native", start: async () => undefined, send: () => undefined, interrupt: () => undefined, dispose: async () => undefined } as AgentDriver;
  project.agents.push(worker);
  const r = renderAt(<App hub={t.hub} onExit={() => undefined} />, SIZE);
  cleanups.push(r.unmount);
  return { ...t, project, lead, worker, r };
}

describe("frames while agents work", () => {
  it("draws streamed text in a handful of frames, not one per delta", async () => {
    const { lead, worker, r } = setup();
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    lead.startTurn();
    worker.startTurn();
    const before = r.stdout.frames.length;
    // 400 deltas in ~1 s, each on its own macrotask, as lines come from two CLIs' pipes.
    for (let i = 0; i < 200; i++) {
      lead.appendStream("text", `moon${i} `);
      worker.appendStream("text", `star${i} `);
      await sleep(5);
    }
    await r.waitFor((s) => s.includes("moon199") && s.includes("star199"), "the last deltas");
    const frames = r.stdout.frames.length - before;
    // (Before: a frame per delta, about 400.) The tests render every commit (debug mode).
    expect(frames).toBeLessThan(60);
    expect(frames).toBeGreaterThan(3);
  });

  it("keeps the spinner turning when nothing streams", async () => {
    const { lead, r } = setup();
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    lead.startTurn();
    // The status line: "✦ Charting… (0s · ↓ 0)".
    const status = () => /([✦✧⋆·]) [A-Z][a-z]+… \(/.exec(r.screen())?.[1];
    await r.waitFor(() => Boolean(status()), "the busy lead");
    const spinners = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const glyph = status();
      if (glyph) spinners.add(glyph);
      await sleep(BUSY_FRAME_MS / 2);
    }
    expect(spinners.size).toBeGreaterThanOrEqual(2);
  });

  it("lets a key skip the coalescing", async () => {
    const { hub, r } = setup();
    await r.waitFor((s) => s.includes("Message luna"), "the project");
    const urgent = vi.spyOn(hub.notifier, "urgent");
    await r.press("x");
    expect(urgent).toHaveBeenCalled();
  });
});

describe("frames.ts", () => {
  it("steps the spinner by the clock", () => {
    const t = Math.floor(animationClock() / BUSY_FRAME_MS) * BUSY_FRAME_MS;
    expect(spinnerFrame(t + BUSY_FRAME_MS) - spinnerFrame(t)).toBe(1);
    expect(spinnerFrame(t + BUSY_FRAME_MS - 1)).toBe(spinnerFrame(t));
    expect(sameRows(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameRows(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameRows(["a"], ["a", "b"])).toBe(false);
  });

  it("ticks every component on one grid, ticks that fall together in one macrotask", async () => {
    const ticks: Array<{ who: string; at: number; task: number }> = [];
    let task = 0;
    const counter = setInterval(() => task++, 1);
    function Ticker({ who, every }: { who: string; every: number }) {
      useTick(every, (at) => void ticks.push({ who, at, task }));
      return <Text>{who}</Text>;
    }
    const r = render(
      <Box>
        <Ticker who="fast" every={40} />
        <Ticker who="slow" every={80} />
      </Box>,
    );
    await sleep(500);
    r.unmount();
    clearInterval(counter);
    const fast = ticks.filter((t) => t.who === "fast");
    const slow = ticks.filter((t) => t.who === "slow");
    expect(fast.length).toBeGreaterThanOrEqual(8);
    expect(slow.length).toBeGreaterThanOrEqual(4);
    for (const t of fast) expect(t.at % 40).toBe(0);
    // Every slow tick came with a fast one in the same task (so in one frame). Usually at the same
    // time; a timer that fires late on a busy machine puts the fast one a step further on its grid.
    for (const s of slow) expect(fast.some((f) => f.task === s.task && f.at - s.at >= 0 && f.at - s.at < 80)).toBe(true);
    // Unmounted: no more ticks.
    const count = ticks.length;
    await sleep(120);
    expect(ticks.length).toBe(count);
  });

  it("re-renders on the shared timer with useTicking", async () => {
    let renders = 0;
    function Probe() {
      useTicking(50);
      renders++;
      return <Text>probe</Text>;
    }
    const r = render(<Probe />);
    await sleep(330);
    r.unmount();
    expect(renders).toBeGreaterThanOrEqual(4);
    expect(renders).toBeLessThanOrEqual(9);
  });

  it("re-renders on a pulse only when nothing else renders", async () => {
    let renders = 0;
    function Probe({ every }: { every: number | null }) {
      usePulse(every);
      renders++;
      return <Text>probe</Text>;
    }
    const pulsing = render(<Probe every={40} />);
    await sleep(420);
    pulsing.unmount();
    expect(renders).toBeGreaterThanOrEqual(5);
    expect(renders).toBeLessThanOrEqual(14);

    renders = 0;
    const off = render(<Probe every={null} />);
    await sleep(200);
    off.unmount();
    expect(renders).toBe(1);

    // Renders that happen anyway push the pulse back.
    renders = 0;
    const busy = render(<Probe every={60} />);
    for (let i = 0; i < 20; i++) {
      busy.rerender(<Probe every={60} />);
      await sleep(15);
    }
    busy.unmount();
    expect(renders).toBeLessThanOrEqual(23);
  });
});

describe("the sky and Axo on the screen's clock", () => {
  // In colour, as in a terminal (without colours most of the twinkle is invisible).
  let level: typeof chalk.level;
  beforeAll(() => {
    level = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = level;
  });
  const moon = builtinTheme("moon")!;
  const dense = { ...moon, sky: { ...moon.sky, density: 6 } };
  const Screen = ({ children }: { children: React.ReactNode }) => (
    <Box width={60} height={10}>
      {children}
    </Box>
  );

  it("moves the sky with the clock it is given, and with no timer of its own", async () => {
    const r = render(<Screen><Sky width={60} height={10} theme={dense} glass={[]} fps={20} clock={1000} /></Screen>);
    await sleep(300);
    expect(new Set(r.frames).size).toBe(1);
    const first = r.lastFrame();
    r.rerender(<Screen><Sky width={60} height={10} theme={dense} glass={[]} fps={20} clock={4321} /></Screen>);
    expect(r.lastFrame()).not.toBe(first);
    r.unmount();
  });

  it("draws no frame for a tick that changes no cell", async () => {
    // No stars, no moon, no shooting stars: every tick of the sky looks the same.
    const empty = { ...moon, sky: { ...moon.sky, density: 0, moon: false, shootingStars: false } };
    const still = render(<Screen><Sky width={60} height={10} theme={empty} glass={[]} fps={20} /></Screen>);
    await sleep(400);
    expect(new Set(still.frames).size).toBe(1);
    expect(still.frames.length).toBeLessThanOrEqual(2);
    still.unmount();
    // A starry sky on its own timer still twinkles.
    const live = render(<Screen><Sky width={60} height={10} theme={dense} glass={[]} fps={20} /></Screen>);
    await sleep(500);
    const frames = [...live.frames];
    live.unmount();
    expect(new Set(frames).size).toBeGreaterThan(1);
    // Axo idle only blinks now and then: far fewer frames than its 4 ticks a second.
    const axo = render(<Axo mood="idle" bg="#141030" />);
    await sleep(1000);
    const axoFrames = axo.frames.length;
    axo.unmount();
    expect(axoFrames).toBeLessThanOrEqual(3);
  });

  it("moves Axo with the clock it is given", async () => {
    const r = render(<Axo mood="work" bg="#141030" clock={0} />);
    await sleep(600);
    expect(new Set(r.frames).size).toBe(1);
    const seen = new Set<string>();
    for (let t = 0; t < 4000; t += 250) {
      r.rerender(<Axo mood="work" bg="#141030" clock={t} />);
      seen.add(r.lastFrame() ?? "");
    }
    r.unmount();
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});
