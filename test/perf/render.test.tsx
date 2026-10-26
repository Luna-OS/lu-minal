// The render benchmark (bench.tsx) under Vitest: PERF=1 npx vitest run test/perf. Skipped otherwise,
// as it takes ~25 s and its numbers depend on the machine. Prints CPU ms, frames, notifications and
// bytes for 10 s with 3 tabs x 3 busy agents, and for 10 s idle. (Vitest runs React's development
// build; `NODE_ENV=production npx tsx test/perf/bench.tsx` measures what the binaries run.)
import { describe, expect, it } from "vitest";
import { describeResult, runBench } from "./bench.js";

const SECONDS = Number(process.env.PERF_SECONDS ?? 10);

describe.skipIf(!process.env.PERF)("render benchmark", () => {
  it(
    "stays at ~10 frames a second while 9 agents stream",
    async () => {
      const busy = await runBench({ mode: "busy", seconds: SECONDS });
      process.stderr.write(`${describeResult(busy)}\n`);
      expect(busy.deltas / SECONDS).toBeGreaterThan(200);
      expect(busy.notifications / SECONDS).toBeLessThanOrEqual(11);
      expect(busy.frames / SECONDS).toBeLessThanOrEqual(12);
    },
    (SECONDS + 10) * 1000,
  );

  it(
    "draws only the sky's frames while idle",
    async () => {
      const idle = await runBench({ mode: "idle", seconds: SECONDS });
      process.stderr.write(`${describeResult(idle)}\n`);
      expect(idle.notifications).toBe(0);
      expect(idle.frames / SECONDS).toBeLessThanOrEqual(10);
    },
    (SECONDS + 10) * 1000,
  );
});
