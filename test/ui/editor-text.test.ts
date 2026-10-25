import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { editKey, emptyEditor, type EditorState } from "../../src/ui/editor.js";
import { formatCost, formatElapsed, formatTokens } from "../../src/ui/format.js";
import { fit, stripAnsi, truncate, truncateStart, width, wrap } from "../../src/ui/text.js";

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const k = (p: Partial<Key>): Key => ({ ...none, ...p });

function type(state: EditorState, text: string): EditorState {
  const r = editKey(state, text, none);
  if (r.kind !== "edit") throw new Error("not an edit");
  return r.state;
}

function press(state: EditorState, key: Partial<Key>, input = ""): EditorState {
  const r = editKey(state, input, k(key));
  if (r.kind !== "edit") throw new Error(`not an edit: ${r.kind}`);
  return r.state;
}

describe("editKey", () => {
  it("types, moves and deletes by grapheme", () => {
    let s = type(emptyEditor(), "héllo 👋🏽");
    expect(s.cursor).toBe(s.value.length);
    s = press(s, { backspace: true });
    expect(s.value).toBe("héllo ");
    s = press(s, { leftArrow: true });
    s = press(s, { leftArrow: true });
    s = type(s, "X");
    expect(s.value).toBe("héllXo ");
    s = press(s, { delete: true });
    expect(s.value).toBe("héllX ");
  });

  it("supports readline keys", () => {
    let s = type(emptyEditor(), "send the room plan");
    s = press(s, { ctrl: true }, "w");
    expect(s.value).toBe("send the room ");
    s = press(s, { ctrl: true }, "a");
    expect(s.cursor).toBe(0);
    s = press(s, { meta: true }, "f");
    expect(s.cursor).toBe(4);
    s = press(s, { ctrl: true }, "e");
    s = press(s, { ctrl: true }, "u");
    expect(s.value).toBe("");
    expect(editKey(s, "w", k({ ctrl: true })).kind).toBe("ignored");
  });

  it("submits on enter and turns a trailing backslash into a new line", () => {
    const s = type(emptyEditor(), "line one\\");
    const r = editKey(s, "", k({ return: true }));
    expect(r.kind).toBe("edit");
    if (r.kind === "edit") expect(r.state.value).toBe("line one\n");
    expect(editKey(type(emptyEditor(), "go"), "", k({ return: true })).kind).toBe("submit");
  });

  it("ignores navigation keys it doesn't own and strips control characters", () => {
    expect(editKey(emptyEditor(), "", k({ tab: true })).kind).toBe("ignored");
    expect(editKey(emptyEditor(), "", k({ upArrow: true })).kind).toBe("ignored");
    expect(editKey(emptyEditor(), "\u0007", none).kind).toBe("ignored");
  });
});

describe("text helpers", () => {
  it("measures and truncates by columns", () => {
    expect(width("漢字")).toBe(4);
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(width(truncate("漢字漢字漢字", 5))).toBeLessThanOrEqual(5);
    expect(truncateStart("src/ui/App.tsx", 8)).toBe("…App.tsx");
    expect(fit("ab", 4)).toBe("ab  ");
    expect(fit("abcdef", 4)).toBe("abc…");
  });

  it("wraps words, keeps indentation and splits long words", () => {
    expect(wrap("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
    expect(wrap("  - indented item that wraps", 14)).toEqual(["  - indented", "  item that", "  wraps"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
    for (const line of wrap("漢字のテキストを折り返す", 7)) expect(width(line)).toBeLessThanOrEqual(7);
  });

  it("strips ANSI", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007")).toBe("red link");
  });
});

describe("formats", () => {
  it("formats tokens, cost and time like the header", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(54_512)).toBe("54.5k");
    expect(formatTokens(550_000)).toBe("550.0k");
    expect(formatTokens(1_234_567)).toBe("1.23M");
    expect(formatCost(146.936)).toBe("$146.94");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.004)).toBe("$0.004");
    expect(formatElapsed(1_439_000)).toBe("23m 59s");
    expect(formatElapsed(9_000)).toBe("9s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});
