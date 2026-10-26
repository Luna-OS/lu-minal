// The change notifier coalesces: one notification after a quiet spell goes out at once, a stream of
// changes (agents streaming text) at most every NOTIFY_INTERVAL_MS, and user input skips the wait.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier, NOTIFY_INTERVAL_MS } from "../../src/core/emitter.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function counted(notifier: Notifier): { calls: number[] } {
  const seen = { calls: [] as number[] };
  notifier.subscribe(() => void seen.calls.push(notifier.snapshot));
  return seen;
}

describe("Notifier", () => {
  it("notifies on the next macrotask after a quiet spell, once per burst", async () => {
    const n = new Notifier();
    const seen = counted(n);
    n.changed();
    n.changed();
    n.changed();
    expect(seen.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.calls).toEqual([3]);
    // Quiet for a while: the next change goes out at once again.
    await vi.advanceTimersByTimeAsync(NOTIFY_INTERVAL_MS);
    n.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.calls).toEqual([3, 4]);
  });

  it("keeps a stream of changes to one notification per interval, the last change included", async () => {
    const n = new Notifier();
    const seen = counted(n);
    // 2 seconds of a change every 2 ms: four busy agents streaming.
    for (let t = 0; t < 2000; t += 2) {
      n.changed();
      await vi.advanceTimersByTimeAsync(2);
    }
    await vi.advanceTimersByTimeAsync(NOTIFY_INTERVAL_MS);
    expect(seen.calls.length).toBeGreaterThanOrEqual(2000 / NOTIFY_INTERVAL_MS - 1);
    expect(seen.calls.length).toBeLessThanOrEqual(2000 / NOTIFY_INTERVAL_MS + 2);
    // Nothing is lost: the last notification saw the last change.
    expect(seen.calls.at(-1)).toBe(n.snapshot);
    expect(n.pending).toBe(false);
  });

  it("lets user input skip the wait", async () => {
    const n = new Notifier();
    const seen = counted(n);
    n.changed();
    await vi.advanceTimersByTimeAsync(0);
    n.changed();
    expect(n.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.calls).toHaveLength(1);
    n.urgent();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.calls).toHaveLength(2);
    // Nothing waiting: urgent() does nothing.
    n.urgent();
    await vi.advanceTimersByTimeAsync(NOTIFY_INTERVAL_MS);
    expect(seen.calls).toHaveLength(2);
  });

  it("flush() notifies right away and drops the waiting notification", async () => {
    const n = new Notifier();
    const seen = counted(n);
    n.changed();
    n.flush();
    expect(seen.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NOTIFY_INTERVAL_MS * 2);
    expect(seen.calls).toHaveLength(1);
  });

  it("waits one interval at most when the clock is set back", async () => {
    const n = new Notifier();
    const seen = counted(n);
    n.changed();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() - 3_600_000);
    n.changed();
    await vi.advanceTimersByTimeAsync(NOTIFY_INTERVAL_MS);
    expect(seen.calls).toHaveLength(2);
  });

  it("can coalesce per macrotask only (interval 0)", async () => {
    const n = new Notifier(0);
    const seen = counted(n);
    for (let i = 0; i < 5; i++) {
      n.changed();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(seen.calls).toHaveLength(5);
  });
});
