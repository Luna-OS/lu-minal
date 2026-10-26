import { describe, expect, it } from "vitest";
import type { ApprovalRequest, LogEntry } from "../../src/core/types.js";
import type { Theme } from "../../src/themes/types.js";
import { askCard, asksSomething, cardHeight, cardPage, cardRoom, panelRowsFor, pendingAsk, type Ask, type AskSource } from "../../src/ui/ask-card.js";
import type { Row } from "../../src/ui/log-lines.js";
import { width } from "../../src/ui/text.js";

const colors = new Proxy({} as Record<string, unknown>, {
  get: (_t, key) => (key === "agents" ? ["#111111", "#222222"] : `#${String(key).length.toString(16).padStart(6, "0")}`),
});
const theme = { name: "t", label: "T", dark: true, colors, sky: {}, axo: false } as unknown as Theme;

const text = (r: Row) => r.segs.map((s) => s.text).join("");
let n = 0;
const entry = (e: Record<string, unknown>) => ({ id: `e${++n}`, at: 0, ...e }) as LogEntry;

function agent(log: LogEntry[], extra: Partial<AskSource> = {}): AskSource {
  return { status: "idle", log, pendingApproval: null, approvals: [], ...extra };
}

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "ask1",
  agentId: "a",
  tool: "Bash",
  risk: "exec",
  summary: "run npm test",
  detail: "npm test",
  allowKey: "Bash:npm test",
  ...over,
});

const card = (ask: Ask, over: Partial<Parameters<typeof askCard>[1]> = {}) =>
  askCard(ask, { width: 60, panelRows: 19, room: 17, theme, name: "luna", nameColor: "#abcdef", focused: true, ...over });

describe("asksSomething", () => {
  it("finds a question in the last paragraph", () => {
    expect(asksSomething("I fixed the parser.\n\nShould I also update the docs?")).toBe(true);
    expect(asksSomething("Should I also update the docs? I can do it right away.")).toBe(true);
    expect(asksSomething("Done.\n\n**Want me to commit?**")).toBe(true);
    expect(asksSomething("Should I adjust the docs as well？")).toBe(true);
  });

  it("finds options with a question after them, or a question with options under it", () => {
    expect(asksSomething("Two ways:\n1. Keep it\n2. Rewrite it\n\nWhich one do you want?\n\nI'll wait.")).toBe(true);
    expect(asksSomething("Which approach do you prefer?\n\n1. **Keep** the old format\n   with a warning\n2. **Rewrite** every example")).toBe(true);
    expect(asksSomething("What next?\n\n- tests\n- docs")).toBe(true);
  });

  it("ignores answers that only report, and question marks in code and links", () => {
    expect(asksSomething("Done. All 200 tests pass.")).toBe(false);
    expect(asksSomething("Why did it fail? A missing await.\n\nFixed it, all tests pass.")).toBe(false);
    expect(asksSomething("Use `a ?? b` there.")).toBe(false);
    expect(asksSomething("See https://example.com/?q=moon for the details.")).toBe(false);
    expect(asksSomething("Changed:\n```ts\nconst x = ok ? 1 : 2;\nfoo?.bar();\n```")).toBe(false);
    expect(asksSomething("Changes:\n1. parser\n2. docs")).toBe(false);
    expect(asksSomething("")).toBe(false);
  });
});

describe("pendingAsk", () => {
  it("is the oldest open request first, with its log row", () => {
    const r = request();
    const log = [entry({ kind: "text", text: "Should I?" }), entry({ kind: "approval", request: r })];
    const ask = pendingAsk(agent(log, { status: "waiting", pendingApproval: r, approvals: [1, 2] }));
    expect(ask).toEqual({ kind: "approval", id: "ask1", entryId: log[1].id, request: r, queued: 2 });
  });

  it("is the question the last answer of a finished turn asks, until the user writes again", () => {
    const answer = entry({ kind: "text", text: "Should I also update the docs?" });
    const log = [entry({ kind: "user", from: "you", text: "go" }), entry({ kind: "tool", toolCallId: "t", name: "Bash", verb: "run", status: "ok" }), answer, entry({ kind: "info", text: "Claude Code was not allowed to ask." })];
    expect(pendingAsk(agent(log))).toEqual({ kind: "question", id: answer.id, entryId: answer.id, text: "Should I also update the docs?" });
    // Still working, dismissed, or answered: no card.
    expect(pendingAsk(agent(log, { status: "working" }))).toBeNull();
    expect(pendingAsk(agent(log), answer.id)).toBeNull();
    expect(pendingAsk(agent([...log, entry({ kind: "user", from: "you", text: "yes" })]))).toBeNull();
    // A tool call after the answer: the answer wasn't the last word.
    expect(pendingAsk(agent([...log, entry({ kind: "tool", toolCallId: "u", name: "Read", verb: "read", status: "ok" })]))).toBeNull();
    expect(pendingAsk(agent([entry({ kind: "text", text: "All done." })]))).toBeNull();
  });
});

describe("askCard", () => {
  it("shows a request's whole command once, wrapped, in an accent frame with the keys", () => {
    const command = "npm run build && npm test -- --run test/ui test/core --reporter verbose && git diff --stat origin/main";
    const r = request({ summary: `run ${command.slice(0, 59)}…`, detail: `${command}\n(Build and test)` });
    const c = card({ kind: "approval", id: r.id, entryId: null, request: r, queued: 2 })!;
    const rows = c.rows.map(text);
    expect(rows[0]).toMatch(/^╭ ▲ luna asks · Bash ─+ 1 of 2 ╮$/);
    expect(rows[rows.length - 1]).toMatch(/^╰ {2}y {2}allow {3}a {2}always {3}n {2}deny ─+╯$/);
    const body = rows.slice(1, -1).map((l) => l.slice(2, -2).trim());
    expect(body.join(" ")).toBe(`run ${command} (Build and test)`);
    for (const row of c.rows) expect(width(text(row))).toBe(60);
    for (const row of c.rows) expect(row.segs[0].color).toBe(colors.accent);
    expect(c.maxTop).toBe(0);
  });

  it("colours an edit's diff and takes about half the panel, scrolling the rest", () => {
    const detail = ["- old line", ...Array.from({ length: 30 }, (_, i) => `+ new line ${i}`)].join("\n");
    const r = request({ tool: "Edit", risk: "edit", summary: "edit src/App.tsx", detail });
    const ask: Ask = { kind: "approval", id: r.id, entryId: null, request: r, queued: 1 };
    const c = card(ask)!;
    expect(c.rows).toHaveLength(10);
    expect(c.top).toBe(0);
    expect(c.maxTop).toBe(32 - 8);
    expect(text(c.rows[1])).toContain("edit src/App.tsx");
    const del = c.rows[2].segs.find((s) => s.text.startsWith("- old"));
    expect(del?.bg).toBe(colors.diffDelBg);
    expect(c.rows[3].segs.find((s) => s.text.startsWith("+ new"))?.bg).toBe(colors.diffAddBg);
    expect(text(c.rows[c.rows.length - 1])).toContain("↓ 24 more · pgdn");
    const next = card(ask, { top: 7 })!;
    expect(text(next.rows[1])).toContain("+ new line 5");
    expect(text(next.rows[next.rows.length - 1])).toContain("↑ 7 ↓ 17 · pgup pgdn");
  });

  it("shows a question whole, or its end with the rest a pgup away", () => {
    const question = Array.from({ length: 20 }, (_, i) => `Point ${i + 1}.`).join("\n") + "\n\nShould I also update the docs?";
    const ask: Ask = { kind: "question", id: "q", entryId: "q", text: question };
    const roomy = card(ask, { panelRows: 31, room: 29 })!;
    expect(roomy.rows.map(text)[0]).toMatch(/^╭ ◆ luna asks ─+╮$/);
    expect(roomy.rows).toHaveLength(24);
    expect(text(roomy.rows[roomy.rows.length - 1])).toContain("answer below · esc dismisses");
    // A small panel: the end (where the question is) shows, with a hint in the top border.
    const small = card(ask, { panelRows: 6, room: 4, focused: false })!;
    expect(small.rows.map(text)).toEqual([
      expect.stringMatching(/^╭ ◆ luna asks ─+ ↑ 19 more · pgup ╮$/),
      expect.stringMatching(/^│ Point 20\. +│$/),
      expect.stringMatching(/^│ +│$/),
      expect.stringMatching(/^│ Should I also update the docs\? +│$/),
    ]);
    // Code in a question wraps instead of being cut.
    const code = card({ kind: "question", id: "c", entryId: "c", text: `Run this?\n\`\`\`\n${"x".repeat(120)}\n\`\`\`` })!;
    expect(code.rows.map(text).join("")).toContain("x".repeat(56));
    expect(code.rows).toHaveLength(2 + 1 + 3);
  });

  it("has no room in a tiny panel", () => {
    const ask: Ask = { kind: "question", id: "q", entryId: "q", text: "Ok?" };
    expect(card(ask, { width: 10 })).toBeNull();
    expect(card(ask, { room: 1 })).toBeNull();
  });

  it("sizes: half the panel for requests, the room for questions, and what a panel needs", () => {
    expect(cardRoom("approval", 19, 17)).toBe(10);
    expect(cardRoom("approval", 6, 4)).toBe(4);
    expect(cardRoom("question", 19, 17)).toBe(16);
    expect(cardRoom("question", 6, 4)).toBe(4);
    const ask: Ask = { kind: "question", id: "q", entryId: "q", text: "Line one.\n\nShould I go on?" };
    expect(cardHeight(ask, 60, theme)).toBe(5);
    expect(panelRowsFor(ask, 60, theme)).toBe(8);
    const r = request();
    expect(panelRowsFor({ kind: "approval", id: r.id, entryId: null, request: r, queued: 1 }, 60, theme)).toBe(5);
  });
});

describe("cardPage", () => {
  const view = { id: "q", top: 5, maxTop: 12, page: 8 };
  it("moves the card a page less a row, and leaves the key to the log at its ends", () => {
    expect(cardPage(view, 1, false)).toBe(12);
    expect(cardPage(view, -1, false)).toBe(0);
    expect(cardPage({ ...view, top: 12 }, 1, false)).toBeNull();
    expect(cardPage({ ...view, top: 0 }, -1, false)).toBeNull();
    // The log comes back down before the card scrolls on.
    expect(cardPage(view, 1, true)).toBeNull();
    expect(cardPage({ ...view, maxTop: 0 }, 1, false)).toBeNull();
    expect(cardPage(null, 1, false)).toBeNull();
  });
});
