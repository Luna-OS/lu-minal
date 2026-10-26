// Long pastes as chips in the prompt: when a paste becomes one, what the chip says, what goes out
// with the message, and how the prompt deletes and draws it.
import { describe, expect, it } from "vitest";
import { builtinTheme } from "../../src/themes/builtin.js";
import { promptSegs } from "../../src/ui/components/AgentPanel.js";
import {
  addPaste,
  chipRanges,
  deleteChipBefore,
  expandPastes,
  isLongPaste,
  keepReferenced,
  lineCount,
  noPastes,
  pasteToken,
  type Pastes,
} from "../../src/ui/paste.js";

const lines = (n: number, end = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + end;

/** A prompt with one pasted text per entry of `texts`, each chip after `before`. */
function pasted(texts: string[], before = ""): { value: string; pastes: Pastes } {
  let pastes = noPastes();
  let value = before;
  for (const t of texts) {
    const r = addPaste(pastes, t);
    pastes = r.pastes;
    value += r.token;
  }
  return { value, pastes };
}

describe("which pastes become a chip", () => {
  it("counts lines the way they read, whatever the terminal sends for a line break", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\n")).toBe(1);
    expect(lineCount("one\ntwo")).toBe(2);
    expect(lineCount("one\r\ntwo\rthree\n")).toBe(3);
  });

  it("takes more than 5 lines or more than 1000 characters", () => {
    expect(isLongPaste(lines(5))).toBe(false);
    expect(isLongPaste(lines(5, "\n"))).toBe(false);
    expect(isLongPaste(lines(6))).toBe(true);
    expect(isLongPaste(lines(6).replace(/\n/g, "\r"))).toBe(true);
    expect(isLongPaste("x".repeat(1000))).toBe(false);
    expect(isLongPaste("x".repeat(1001))).toBe(true);
    expect(isLongPaste("short")).toBe(false);
  });

  it("leaves blank pastes alone", () => {
    expect(isLongPaste("\n".repeat(20))).toBe(false);
    expect(isLongPaste(" ".repeat(2000))).toBe(false);
  });
});

describe("the chip", () => {
  it("says how many lines, or characters for one long line", () => {
    expect(pasteToken(1, lines(87))).toBe("[Pasted text #1 +87 lines]");
    expect(pasteToken(1, lines(87, "\n"))).toBe("[Pasted text #1 +87 lines]");
    expect(pasteToken(2, lines(1234))).toBe("[Pasted text #2 +1,234 lines]");
    expect(pasteToken(3, "y".repeat(1234))).toBe("[Pasted text #3 +1,234 chars]");
  });

  it("numbers count up in a prompt and the text is kept with normalized line breaks", () => {
    let p = noPastes();
    const a = addPaste(p, lines(8).replace(/\n/g, "\r"));
    p = a.pastes;
    const b = addPaste(p, lines(9));
    expect(a.token).toBe("[Pasted text #1 +8 lines]");
    expect(b.token).toBe("[Pasted text #2 +9 lines]");
    expect(b.pastes.next).toBe(3);
    expect(b.pastes.items.map((x) => x.text)).toEqual([lines(8), lines(9)]);
  });
});

describe("expanding chips when the message goes out", () => {
  it("puts every pasted text back where its chip is", () => {
    const { value, pastes } = pasted([lines(7), lines(10)], "look: ");
    const text = `${value.replace("][", "] and [")} thanks`;
    expect(expandPastes(text, pastes)).toBe(`look: ${lines(7)} and ${lines(10)} thanks`);
  });

  it("leaves chips without a kept text as they are", () => {
    const { value } = pasted([lines(7)]);
    expect(expandPastes(value, noPastes())).toBe(value);
    expect(expandPastes("[Pasted text #9 +12 lines]", pasted([lines(7)]).pastes)).toBe("[Pasted text #9 +12 lines]");
  });

  it("doesn't expand a chip that is part of a pasted text", () => {
    const inner = `${lines(6)}\n[Pasted text #1 +7 lines]`;
    const { value, pastes } = pasted([inner]);
    expect(value).toBe("[Pasted text #1 +7 lines]");
    expect(expandPastes(value, pastes)).toBe(inner);
  });
});

describe("forgetting pasted texts", () => {
  it("drops the texts whose chip was deleted, and keeps counting", () => {
    const { value, pastes } = pasted([lines(7), lines(8)]);
    const first = pastes.items[0].token;
    const left = keepReferenced(pastes, first);
    expect(left.items.map((x) => x.id)).toEqual([1]);
    expect(left.next).toBe(3);
    expect(keepReferenced(pastes, value)).toBe(pastes);
    // A chip cut in half is just text now.
    expect(keepReferenced(pastes, first.slice(0, -1)).items).toEqual([]);
  });

  it("forgets everything when the prompt is cleared", () => {
    const { pastes } = pasted([lines(7)]);
    expect(keepReferenced(pastes, "")).toEqual(noPastes());
    const empty = noPastes();
    expect(keepReferenced(empty, "")).toBe(empty);
  });
});

describe("deleting a chip", () => {
  const { value, pastes } = pasted([lines(7)], "see ");

  it("goes at once with backspace right after it", () => {
    expect(deleteChipBefore({ value, cursor: value.length }, pastes)).toEqual({ value: "see ", cursor: 4 });
    const after = `${value} ok`;
    expect(deleteChipBefore({ value: after, cursor: value.length }, pastes)).toEqual({ value: "see  ok", cursor: 4 });
  });

  it("leaves other places to the editor", () => {
    expect(deleteChipBefore({ value, cursor: value.length - 1 }, pastes)).toBeNull();
    expect(deleteChipBefore({ value: `${value} `, cursor: value.length + 1 }, pastes)).toBeNull();
    expect(deleteChipBefore({ value, cursor: value.length }, noPastes())).toBeNull();
  });

  it("takes the spaces before the cursor too for ctrl+w and alt+backspace", () => {
    expect(deleteChipBefore({ value: `${value}  `, cursor: value.length + 2 }, pastes, true)).toEqual({ value: "see ", cursor: 4 });
    expect(deleteChipBefore({ value: "see you ", cursor: 8 }, pastes, true)).toBeNull();
  });
});

describe("drawing chips in the prompt", () => {
  const theme = builtinTheme("moon")!;
  const c = theme.colors;

  it("finds only the chips with a kept text", () => {
    const line = "a [Pasted text #1 +7 lines] b [Pasted text #2 +9 lines]";
    expect(chipRanges(line, ["[Pasted text #1 +7 lines]"])).toEqual([[2, 27]]);
    expect(chipRanges(line, [])).toEqual([]);
  });

  it("draws the chip in the accent colour and the rest as before", () => {
    const { value, pastes } = pasted([lines(7)], "see ");
    const text = `${value} please`;
    const segs = promptSegs({ value: text, cursor: text.length }, 80, theme, "", pastes.items.map((p) => p.token));
    const chip = segs.find((s) => s.text === "[Pasted text #1 +7 lines]");
    expect(chip?.color).toBe(c.accent);
    expect(segs.filter((s) => s.text.includes("see") || s.text.includes("please")).every((s) => s.color === c.text)).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe(`› ${text} `);
  });

  it("looks the same as before without chips", () => {
    const segs = promptSegs({ value: "hello", cursor: 2 }, 80, theme, "");
    expect(segs.slice(1)).toEqual([
      { text: "he", color: c.text },
      { text: "l", color: c.text, inverse: true },
      { text: "lo", color: c.text },
    ]);
  });
});
