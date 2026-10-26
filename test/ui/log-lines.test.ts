import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/core/types.js";
import type { Theme } from "../../src/themes/types.js";
import { cachedEntryRows, collapse, entryRows, logTail, moreLines, type LogRenderOptions, type Row } from "../../src/ui/log-lines.js";
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

describe("collapsing tool output and code", () => {
  const compact: LogRenderOptions = { ...opts, width: 60, maxDiffLines: 6, maxTextLines: 9, maxCodeLines: 6, expandHint: "ctrl+f to expand" };
  const output = Array.from({ length: 126 }, (_, i) => `ok ${i + 1}`).join("\n");

  it("keeps the first lines of a long tool result and says how to see the rest", () => {
    const rows = entryRows(entry({ kind: "tool", toolCallId: "t", name: "Bash", verb: "run", target: "npm test", status: "ok", detail: output }), compact).map(text);
    expect(rows).toEqual(["▸ run npm test", "  └ ok 1", "    ok 2", "    ok 3", "    ok 4", "    ok 5", "    ok 6", "    … 120 more lines (ctrl+f to expand)"]);
    // Zoomed (no limit): every line.
    const all = entryRows(entry({ kind: "tool", toolCallId: "t", name: "Bash", verb: "run", status: "ok", detail: output }), { ...compact, maxCodeLines: 0 });
    expect(all).toHaveLength(127);
    // A one-line result stays one row.
    const one = entryRows(entry({ kind: "tool", toolCallId: "t", name: "Read", verb: "read", status: "ok", detail: "94 lines" }), compact).map(text);
    expect(one).toEqual(["▸ read", "  └ 94 lines"]);
  });

  it("collapses a long diff with the same hint, and never to hide a single line", () => {
    const diff = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "add" as const, line: i + 1, text: `line ${i}` }));
    const long = entryRows(entry({ kind: "tool", toolCallId: "t", name: "write_file", verb: "new", target: "a.ts", status: "ok", diff: diff(126) }), compact);
    expect(long.filter((r) => r.fill)).toHaveLength(6);
    expect(text(long[long.length - 1])).toBe("    … 120 more lines (ctrl+f to expand)");
    const seven = entryRows(entry({ kind: "tool", toolCallId: "t", name: "write_file", verb: "new", target: "a.ts", status: "ok", diff: diff(7) }), compact);
    expect(seven.filter((r) => r.fill)).toHaveLength(7);
  });

  it("collapses long code blocks in an answer but never its prose", () => {
    const code = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const prose = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} of the answer.`).join("\n");
    const rows = entryRows(entry({ kind: "text", text: `${prose}\n\`\`\`ts\n${code}\n\`\`\`\nShould I also update the docs?` }), compact).map(text);
    // All 40 lines of prose (maxTextLines doesn't cut the agent's own answer), 6 of code, the question.
    expect(rows.filter((r) => r.startsWith("Sentence number"))).toHaveLength(40);
    expect(rows.filter((r) => r.startsWith("const v"))).toEqual(["const v0 = 0;", "const v1 = 1;", "const v2 = 2;", "const v3 = 3;", "const v4 = 4;", "const v5 = 5;"]);
    expect(rows).toContain("… 24 more lines (ctrl+f to expand)");
    expect(rows[rows.length - 1]).toBe("Should I also update the docs?");
    // Short blocks and an answer still streaming its block.
    expect(entryRows(entry({ kind: "text", text: "```\na\nb\n```" }), compact).map(text)).toEqual(["a", "b"]);
    const open = entryRows(entry({ kind: "text", text: `Here:\n\`\`\`\n${code}`, streaming: true }), compact).map(text);
    expect(open).toHaveLength(1 + 6 + 1);
  });

  it("keeps a pending approval to one row, and leaves out the answer, that the question card shows", () => {
    const request = { id: "a", agentId: "x", tool: "Bash", risk: "exec", summary: "run npm test", detail: "npm test\n(the suite)", allowKey: "Bash:npm test" };
    const approval = entry({ kind: "approval", request });
    expect(entryRows(approval, compact).length).toBeGreaterThan(1);
    expect(entryRows(approval, { ...compact, pinned: approval.id }).map(text)).toEqual(["▲ run npm test"]);
    const answer = entry({ kind: "text", text: "Should I also update the docs?" });
    expect(entryRows(answer, { ...compact, pinned: answer.id })).toEqual([]);
    expect(entryRows(answer, { ...compact, pinned: "other" }).map(text)).toEqual(["Should I also update the docs?"]);
  });

  it("collapse() hides nothing when only one item would go", () => {
    expect(collapse([1, 2, 3], 2)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(collapse([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], hidden: 2 });
    expect(collapse([1, 2, 3, 4], 0)).toEqual({ shown: [1, 2, 3, 4], hidden: 0 });
    expect(moreLines(1)).toBe("… 1 more line");
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

describe("cachedEntryRows", () => {
  it("lays an unchanged entry out once, frame after frame", () => {
    const e = entry({ kind: "text", text: "the moon is waxing tonight and every star keeps its own time" });
    const first = cachedEntryRows(e, opts);
    expect(cachedEntryRows(e, { ...opts, colorOf: () => "#abcdef" })).toBe(first);
    expect(first.map(text)).toEqual(entryRows(e, opts).map(text));
  });

  it("lays it out again when the agent changed it in place, or the width, options or theme changed", () => {
    const e = entry({ kind: "text", text: "streaming", streaming: true });
    const a = cachedEntryRows(e, opts);
    (e as { text: string }).text += " more words";
    const b = cachedEntryRows(e, opts);
    expect(b).not.toBe(a);
    expect(text(b[0])).toContain("more words");
    // The final text can be as long as the streamed one.
    Object.assign(e, { text: "streaming more wordz", streaming: false });
    expect(text(cachedEntryRows(e, opts)[0])).toContain("wordz");
    const narrow = cachedEntryRows(e, { ...opts, width: 10 });
    expect(narrow.length).toBeGreaterThan(1);
    expect(cachedEntryRows(e, { ...opts, width: 10, maxTextLines: 1 })).not.toBe(narrow);
    const wide = cachedEntryRows(e, opts);
    expect(cachedEntryRows(e, { ...opts, theme: { ...theme } as Theme })).not.toBe(wide);

    const tool = entry({ kind: "tool", toolCallId: "t", name: "Bash", verb: "run", target: "npm test", status: "running" });
    const running = cachedEntryRows(tool, opts);
    Object.assign(tool, { status: "ok", detail: "412 tests passed" });
    const done = cachedEntryRows(tool, opts);
    expect(done).not.toBe(running);
    expect(done.map(text).join("\n")).toContain("412 tests passed");
  });

  it("lays an entry out again once the question card no longer shows it, or its code is folded differently", () => {
    const e = entry({ kind: "text", text: "Should I also update the docs?" });
    expect(cachedEntryRows(e, { ...opts, pinned: e.id })).toEqual([]);
    // Another entry on the card leaves this one's rows as they were.
    const shown = cachedEntryRows(e, opts);
    expect(text(shown[0])).toContain("update the docs");
    expect(cachedEntryRows(e, { ...opts, pinned: "other" })).toBe(shown);

    const code = entry({ kind: "text", text: ["```", ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "```"].join("\n") });
    const folded = cachedEntryRows(code, { ...opts, maxCodeLines: 3, expandHint: "ctrl+f to expand" });
    expect(folded.map(text).join("\n")).toContain("ctrl+f to expand");
    expect(cachedEntryRows(code, { ...opts, maxCodeLines: 3 }).map(text).join("\n")).not.toContain("ctrl+f");
    expect(cachedEntryRows(code, opts).length).toBeGreaterThan(folded.length);
  });

  it("follows a teammate's colour", () => {
    const e = entry({ kind: "user", from: "vega", text: "done" });
    const blue = cachedEntryRows(e, { ...opts, colorOf: () => "#0000ff" });
    const red = cachedEntryRows(e, { ...opts, colorOf: () => "#ff0000" });
    expect(red).not.toBe(blue);
    expect(red[0].segs[0].color).toBe("#ff0000");
  });
});
