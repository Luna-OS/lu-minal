// One cadence for everything that moves on the screen.
//
// Each frame costs about the same whatever changed in it: React renders and Ink lays out and draws
// every cell of the terminal again (~25 ms for 160 x 48 cells). Before, everything that moved asked
// for frames of its own, at its own moments: the agents' streamed text (a frame per delta), the
// spinners (every 140 ms), the sky (8 a second), Axo (4 a second) and the clocks. Now:
//   - the Hub's change notifications come at most 10 times a second (src/core/emitter.ts), and keys
//     never wait for that (useUrgentInput);
//   - while agents work, the spinners, the sky's twinkle and Axo run no timers of their own: they
//     move by the clock (animationClock) in the frames the agents' text draws anyway, and a pulse
//     makes sure there is a frame at least every BUSY_FRAME_MS when nothing streams (a long tool
//     call), so the spinners keep turning;
//   - while nobody works, the sky, Axo and the header clock tick on one shared timer (useTick), so
//     ticks that fall together make one frame, and the sky and Axo skip the ticks that change none
//     of their cells (about a third of the sky's).
// So 9 agents streaming draw ~10 frames a second instead of all the CPU allows (test/perf/bench.tsx).
import { useInput } from "ink";
import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { Notifier } from "../core/emitter.js";

/** While agents work: a frame at least this often (the sky's 8 fps, the spinners' step). */
export const BUSY_FRAME_MS = 125;
/** While nobody works: the header clock and "Done!" move on once a second. */
export const IDLE_FRAME_MS = 1000;

/** The time everything animates by: milliseconds on a monotonic clock (no jumps with the wall clock). */
export function animationClock(): number {
  return performance.now();
}

/** The spinners' step at `clock` (one step per BUSY_FRAME_MS). */
export function spinnerFrame(clock: number = animationClock()): number {
  return Math.floor(clock / BUSY_FRAME_MS);
}

// ---- the shared timer -----------------------------------------------------------------------

type TickFn = (clock: number) => void;

interface Ticker {
  ms: number;
  /** The last grid time its subscribers were told. */
  last: number;
  subs: Set<{ fn: TickFn }>;
}

const tickers = new Map<number, Ticker>();
let timer: NodeJS.Timeout | null = null;

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!tickers.size) return;
  const now = animationClock();
  let due = Number.POSITIVE_INFINITY;
  for (const t of tickers.values()) due = Math.min(due, (Math.floor(now / t.ms) + 1) * t.ms);
  timer = setTimeout(fire, Math.max(1, Math.ceil(due - now)));
  // The app's input keeps the process alive; a forgotten animation must not.
  timer.unref();
}

function fire(): void {
  timer = null;
  const now = animationClock();
  // Every ticker that is due runs in this one macrotask, so React renders their changes as one.
  for (const t of [...tickers.values()]) {
    const at = Math.floor(now / t.ms) * t.ms;
    if (at <= t.last) continue;
    t.last = at;
    for (const sub of [...t.subs]) sub.fn(at);
  }
  arm();
}

/**
 * Calls `onTick` every `everyMs` (null: not at all) with the clock time of the tick. The ticks of
 * every component sit on one grid of the clock (multiples of their interval) and come from one
 * timer, so a 125 ms sky tick and a 250 ms Axo tick fall into the same frame.
 */
export function useTick(everyMs: number | null, onTick: TickFn): void {
  const latest = useRef(onTick);
  latest.current = onTick;
  useEffect(() => {
    if (!everyMs || !(everyMs > 0)) return;
    const ms = Math.max(1, Math.round(everyMs));
    let ticker = tickers.get(ms);
    if (!ticker) {
      ticker = { ms, last: Math.floor(animationClock() / ms) * ms, subs: new Set() };
      tickers.set(ms, ticker);
    }
    const sub = { fn: (clock: number) => latest.current(clock) };
    ticker.subs.add(sub);
    arm();
    return () => {
      ticker.subs.delete(sub);
      if (!ticker.subs.size && tickers.get(ms) === ticker) tickers.delete(ms);
      arm();
    };
  }, [everyMs]);
}

/** Re-renders the calling component on the shared timer every `everyMs` (null: never). */
export function useTicking(everyMs: number | null): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useTick(everyMs, bump);
}

/** Whether two lists of pre-rendered rows are the same. */
export function sameRows(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- while agents work ----------------------------------------------------------------------

/**
 * Re-renders the calling component when it hasn't rendered for `everyMs` (null: never). Frames
 * that happen anyway (streamed text, typing) push the pulse back, so it only fills the gaps.
 */
export function usePulse(everyMs: number | null): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const renderedAt = useRef(animationClock());
  // After every commit of the component, whatever caused it.
  useLayoutEffect(() => {
    renderedAt.current = animationClock();
  });
  useEffect(() => {
    if (!everyMs || everyMs <= 0) return;
    let pending: NodeJS.Timeout | undefined;
    const check = () => {
      const wait = renderedAt.current + everyMs - animationClock();
      if (wait <= 1) {
        bump();
        pending = setTimeout(check, everyMs);
      } else {
        pending = setTimeout(check, Math.min(everyMs, wait));
      }
    };
    pending = setTimeout(check, everyMs);
    return () => clearTimeout(pending);
  }, [everyMs]);
}

/**
 * Keys never wait for the notifier's interval: a change a key made (another tab, an answered
 * question) goes out on the next macrotask, after every input handler has run.
 */
export function useUrgentInput(notifier: Notifier): void {
  useInput(() => queueMicrotask(() => notifier.urgent()));
}
