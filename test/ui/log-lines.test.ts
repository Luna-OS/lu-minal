import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/core/types.js";
import type { Theme } from "../../src/themes/types.js";
import { entryRows, logTail, type LogRenderOptions, type Row } from "../../src/ui/log-lines.js";
import { width } from "../../src/ui/text.js";

const colors = new Proxy({} as Record<string, unknown>, {
  get: (_t, key) => (key === "agents" ? ["#111111", "#222222"] : `#${String(key).length.toString(16).padStart(6, "0")}`),
});
const theme = { name: "t", label: "T", dark: true, colors, sky: {}, axo: false } as unknown as Theme;

const opts: LogRenderOptions = {
  width: 40,
  theme,
  colorOf: () => "#abcdef",
  maxDiffLines: 4,
  maxTextLines: 0,
  fullReasoning: false,
};

const text = (r: Row) => r.segs.map((s) => s.text).join("");
let n = 0;
const entry = (e: Record<string, unknown>) => ({ id: `e${++n}`, at: 0, ...e }) as LogEntry;

describe("entryRows", () => {
  it("draws a tool call with its diff and detail like the reference", () => {
    const rows = entryRows(
      entry({
        kind: "tool",
        toolCallId: "t1",
        name: "edit_file",
        verb: "edit",
        target: "Window.ts",
        status: "ok",
        detail: "1 line added",
        diff: [
          { kind: "add", line: 54, text: "moon = 'full'" },
          { kind: "del", line: 88, text: "warmth = 0.4" },
        ],
      }),
      opts,
    );
    expect(rows.map(text)).toEqual(["▸ edit Window.ts", "54 + moon = 'full'", "88 - warmth = 0.4", "  └ 1 line added"]);
    expect(rows[1].fill).toBe(colors.diffAddBg);
    expect(rows[2].fill).toBe(colors.diffDelBg);
  });

  it("limits long diffs and says how many rows are hidden", () => {
    const diff = Array.from({ length: 10 }, (_, i) => ({ kind: "add" as const, line: i + 1, text: `line ${i}` }));
    const rows = entryRows(entry({ kind: "tool", toolCallId: "t", name: "write_file", verb: "new", target: "a.ts", status: "ok", diff }), opts);
    expect(rows.filter((r) => r.fill)).toHaveLength(4);
    expect(text(rows[rows.length - 1])).toContain("6 more");
  });

  it("wraps prose to the width and marks teammates' messages", () => {
    const rows = entryRows(entry({ kind: "user", from: "vega", text: "the room is done, the lamp needs a warmer colour now" }), opts);
    expect(text(rows[0]).startsWith("◂ vega ")).toBe(true);
    for (const r of rows) expect(width(text(r))).toBeLessThanOrEqual(40);
    const mine = entryRows(entry({ kind: "user", from: "you", text: "hi" }), opts);
    expect(text(mine[0])).toBe("› hi");
  });

  it("renders markdown-lite: code fences, inline code, bold and bullets", () => {
    const rows = entryRows(entry({ kind: "text", text: "**Plan**\n- use `tsc`\n```\nnpm test\n```" }), opts);
    expect(rows.map(text)).toEqual(["Plan", "• use tsc", "npm test"]);
    expect(rows[0].segs[0].bold).toBe(true);
    expect(rows[1].segs.find((s) => s.text === "tsc")?.color).toBe(colors.accent2);
  });

  it("shows a pending approval with its keys, and the decision afterwards", () => {
    const request = { id: "a", agentId: "x", tool: "bash", risk: "exec", summary: "run npm test", allowKey: "bash:npm test" };
    const pending = entryRows(entry({ kind: "approval", request }), opts).map(text);
    expect(pending[0]).toBe("▲ run npm test");
    expect(pending[pending.length - 1]).toContain("allow");
    const done = entryRows(entry({ kind: "approval", request, decision: "deny" }), opts).map(text);
    expect(done).toEqual(["▲ run npm test · denied"]);
  });

  it("collapses reasoning to its last line unless zoomed", () => {
    const e = entry({ kind: "reasoning", text: "first thought\nsecond thought" });
    expect(entryRows(e, opts).map(text)).toEqual(["∴ second thought"]);
    expect(entryRows(e, { ...opts, fullReasoning: true }).length).toBe(2);
  });
});

describe("logTail", () => {
  it("returns only the newest rows that fit", () => {
    const log = Array.from({ length: 50 }, (_, i) => entry({ kind: "info", text: `step ${i}` }));
    const rows = logTail(log, 5, opts);
    expect(rows).toHaveLength(5);
    expect(text(rows[4])).toBe("· step 49");
  });
});
