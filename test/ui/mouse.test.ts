// The mouse reports taken out of the terminal's input before Ink sees it: whole, cut in two by the
// chunks, mixed with keys, inside a bracketed paste (where nothing is taken out); and the input
// stream Ink reads through, which also turns the terminal's mouse reporting on and off.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../../src/core/config.js";
import { decodeMouse, MOUSE_OFF, MOUSE_ON, MouseFilter, mouseReportingUseful, MouseStdin, panelAt, type MouseEvent } from "../../src/ui/mouse.js";
import { sleep } from "./ink-helpers.js";

const wheelUp = (x: number, y: number) => `\u001b[<64;${x};${y}M`;
const wheelDown = (x: number, y: number) => `\u001b[<65;${x};${y}M`;
const UP = "\u001b[A";
const PASTE = (t: string) => `\u001b[200~${t}\u001b[201~`;

describe("decodeMouse", () => {
  it("reads the button, what happened and the modifiers, with the cell counted from 0", () => {
    expect(decodeMouse(64, 10, 5, false)).toEqual({ x: 9, y: 4, button: "wheelUp", action: "press", shift: false, meta: false, ctrl: false });
    expect(decodeMouse(65, 1, 1, false)).toMatchObject({ x: 0, y: 0, button: "wheelDown" });
    expect(decodeMouse(0, 3, 4, true)).toMatchObject({ button: "left", action: "release" });
    expect(decodeMouse(2, 3, 4, false)).toMatchObject({ button: "right", action: "press" });
    expect(decodeMouse(32, 3, 4, false)).toMatchObject({ button: "left", action: "move" });
    expect(decodeMouse(4 | 16, 3, 4, false)).toMatchObject({ button: "left", shift: true, ctrl: true, meta: false });
    expect(decodeMouse(64 | 8, 3, 4, false)).toMatchObject({ button: "wheelUp", meta: true });
    // The old encoding's release doesn't say which button.
    expect(decodeMouse(3, 3, 4, false)).toMatchObject({ button: "none", action: "release" });
  });
});

describe("MouseFilter", () => {
  it("takes SGR reports out and keeps the keys around them in order", () => {
    const f = new MouseFilter();
    const got = f.push(`a${wheelDown(10, 5)}b${UP}${wheelUp(2, 3)}\r`);
    expect(got.text).toBe(`ab${UP}\r`);
    expect(got.events.map((e) => [e.button, e.x, e.y])).toEqual([
      ["wheelDown", 9, 4],
      ["wheelUp", 1, 2],
    ]);
  });

  it("reads a burst of wheel reports in one chunk", () => {
    const got = new MouseFilter().push(wheelUp(1, 1).repeat(5));
    expect(got).toEqual({ text: "", events: Array(5).fill(expect.objectContaining({ button: "wheelUp" })) });
  });

  it("puts a report cut in two by the chunks back together, wherever the cut is", () => {
    const report = `${wheelUp(12, 7)}`;
    for (let cut = 1; cut < report.length; cut++) {
      const f = new MouseFilter();
      const first = f.push(`x${report.slice(0, cut)}`);
      expect(first).toEqual({ text: "x", events: [] });
      // ESC and ESC [ may be keys (flush would type them); from ESC [ < on it is a report's.
      expect(f.pending).toBe(cut < 3);
      const second = f.push(`${report.slice(cut)}y`);
      expect(second.text).toBe("y");
      expect(second.events).toEqual([expect.objectContaining({ button: "wheelUp", x: 11, y: 6 })]);
      expect(f.pending).toBe(false);
    }
  });

  it("never types the beginning of a report, however long the rest takes", () => {
    const f = new MouseFilter();
    expect(f.push("\u001b[<65;1")).toEqual({ text: "", events: [] });
    expect(f.flush()).toBe("");
    expect(f.push("2;3M")).toEqual({ text: "", events: [expect.objectContaining({ button: "wheelDown", x: 11, y: 2 })] });
    // What a cut report leaves when something else follows is dropped, not typed.
    expect(f.push("\u001b[<64;1")).toEqual({ text: "", events: [] });
    expect(f.push("hello")).toEqual({ text: "hello", events: [] });
    expect(f.push(`a\u001b[<64;b${UP}`)).toEqual({ text: `ab${UP}`, events: [] });
  });

  it("holds an ESC while the wheel turns: over a slow link it may be the next report's", () => {
    const f = new MouseFilter();
    expect(f.push(wheelUp(1, 1), 1000).events).toHaveLength(1);
    expect(f.inBurst(1100)).toBe(true);
    expect(f.push("\u001b", 1100)).toEqual({ text: "", events: [] });
    expect(f.push("[<65;1;1M", 1300).events).toEqual([expect.objectContaining({ button: "wheelDown" })]);
    // Once the wheel has stopped, the escape key goes through at once again.
    expect(f.inBurst(5000)).toBe(false);
    expect(f.push("\u001b", 5000)).toEqual({ text: "\u001b", events: [] });
  });

  it("lets the escape key through at once, and gives up a held beginning as typed text", () => {
    const f = new MouseFilter();
    expect(f.push("\u001b")).toEqual({ text: "\u001b", events: [] });
    // Alt+[ at the end of a chunk could be the start of a report: held, then given up.
    expect(f.push("ab\u001b[")).toEqual({ text: "ab", events: [] });
    expect(f.flush()).toBe("\u001b[");
    expect(f.pending).toBe(false);
  });

  it("leaves other escape sequences alone", () => {
    const f = new MouseFilter();
    const keys = `${UP}\u001b[1;5C\u001b[27;5u\u001b[?1u\u001b[2~\u001bx\u001b\u001b[B`;
    expect(f.push(keys)).toEqual({ text: keys, events: [] });
  });

  it("never touches a bracketed paste, also when it looks like a report", () => {
    const f = new MouseFilter();
    const paste = PASTE(`a ${wheelUp(1, 1)} b\nline two`);
    expect(f.push(`${paste}${wheelDown(4, 4)}`)).toEqual({ text: paste, events: [expect.objectContaining({ button: "wheelDown" })] });
  });

  it("finds the paste markers when the chunks cut them", () => {
    const f = new MouseFilter();
    // The start marker cut: held until it is whole, then the paste goes through untouched.
    expect(f.push("\u001b[20")).toEqual({ text: "", events: [] });
    expect(f.push(`0~one ${wheelUp(1, 1)}`)).toEqual({ text: `\u001b[200~one ${wheelUp(1, 1)}`, events: [] });
    // The end marker cut: the paste text passes as it comes, and reports count again after it.
    expect(f.push("two\u001b[20")).toEqual({ text: "two\u001b[20", events: [] });
    expect(f.push(`1~${wheelUp(3, 3)}`)).toEqual({ text: "1~", events: [expect.objectContaining({ button: "wheelUp", x: 2, y: 2 })] });
  });

  it("reads the old X10 encoding of terminals without SGR reports", () => {
    const f = new MouseFilter();
    // ESC [ M, then button, column and row, each plus 32: the wheel up at column 1, row 2.
    const got = f.push(`k\u001b[M${String.fromCharCode(64 + 32, 1 + 32, 2 + 32)}j`);
    expect(got.text).toBe("kj");
    expect(got.events).toEqual([expect.objectContaining({ button: "wheelUp", x: 0, y: 1 })]);
  });
});

/** A stdin as Ink reads it: chunks queued, read() until null, "readable" when there is more. */
class FakeSource extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  chunks: string[] = [];
  refs = 0;
  feed(...chunks: string[]) {
    this.chunks.push(...chunks);
    this.emit("readable");
  }
  read(): string | null {
    return this.chunks.shift() ?? null;
  }
  setRawMode(mode: boolean) {
    this.raw.push(mode);
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {
    this.refs++;
  }
  unref() {
    this.refs--;
  }
}

function setup(holdMs = 20) {
  const source = new FakeSource();
  const written: string[] = [];
  const input = new MouseStdin(source as unknown as NodeJS.ReadStream, { write: (s) => void written.push(s) }, holdMs);
  const events: MouseEvent[] = [];
  input.on("mouse", (e: MouseEvent) => events.push(e));
  /** What Ink would read: everything until read() says null, on each "readable". */
  const typed: string[] = [];
  const reader = () => {
    for (let t = input.read(); t !== null; t = input.read()) typed.push(t);
  };
  return { source, input, written, events, typed, reader };
}

describe("MouseStdin", () => {
  it("reads the real stdin only while Ink listens, and forwards its modes", () => {
    const { source, input, reader } = setup();
    expect(input.isTTY).toBe(true);
    expect(source.listenerCount("readable")).toBe(0);
    input.on("readable", reader);
    expect(source.listenerCount("readable")).toBe(1);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.ref();
    input.off("readable", reader);
    expect(source.listenerCount("readable")).toBe(0);
    expect(source.raw).toEqual([true]);
    expect(source.refs).toBe(1);
  });

  it("hands Ink the keys and the App the mouse", () => {
    const { source, input, events, typed, reader } = setup();
    input.on("readable", reader);
    source.feed(`hi${wheelUp(5, 6)}`, wheelDown(1, 1), "!");
    expect(typed).toEqual(["hi", "!"]);
    expect(events.map((e) => e.button)).toEqual(["wheelUp", "wheelDown"]);
  });

  it("gives a held ESC [ up as typed (Alt+[) when nothing follows", async () => {
    const { source, input, typed, reader } = setup(10);
    input.on("readable", reader);
    source.feed("a\u001b[");
    expect(typed).toEqual(["a"]);
    await sleep(40);
    expect(typed).toEqual(["a", "\u001b["]);
  });

  it("waits for the rest of a cut report, however late it comes", async () => {
    const { source, input, events, typed, reader } = setup(10);
    input.on("readable", reader);
    source.feed("\u001b[<64;2");
    await sleep(60);
    source.feed("0;9M");
    expect(typed).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ button: "wheelUp", x: 19, y: 8 })]);
  });

  it("reports the mouse only while it is wanted and Ink reads the keys (raw mode)", () => {
    const { input, written } = setup();
    input.setMouse(true);
    expect(written).toEqual([]);
    input.setRawMode(true);
    expect(written).toEqual([MOUSE_ON]);
    // Ink hands the terminal to another program (or quits): raw mode off, the mouse too.
    input.setRawMode(false);
    expect(written).toEqual([MOUSE_ON, MOUSE_OFF]);
    input.setRawMode(true);
    input.setMouse(false);
    input.setMouse(true);
    input.dispose();
    expect(written).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON, MOUSE_OFF, MOUSE_ON, MOUSE_OFF]);
    expect(input.reporting).toBe(false);
    // Button events with the wheel, in SGR coordinates; no motion reports.
    expect(MOUSE_ON).toBe("\u001b[?1000h\u001b[?1006h");
    expect(MOUSE_OFF).toBe("\u001b[?1006l\u001b[?1000l");
  });
});

describe("the mouse setting", () => {
  it("is on by default and keeps a stored choice", () => {
    expect(defaultConfig().mouse).toBe(true);
    expect(mergeConfig({ mouse: false }).mouse).toBe(false);
    expect(mergeConfig({ mouse: "no" }).mouse).toBe(true);
    expect(mergeConfig({}).mouse).toBe(true);
  });

  it("stays the terminal's in the macOS app", () => {
    expect(mouseReportingUseful({ LU_MINAL_APP: "1" })).toBe(false);
    expect(mouseReportingUseful({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
  });
});

describe("panelAt", () => {
  it("finds the panel under a cell", () => {
    const panels = [
      { agentId: "lead", rect: { x: 1, y: 2, width: 50, height: 10 } },
      { agentId: "w1", rect: { x: 1, y: 13, width: 24, height: 8 } },
    ];
    expect(panelAt({ panels }, 1, 2)?.agentId).toBe("lead");
    expect(panelAt({ panels }, 50, 11)?.agentId).toBe("lead");
    expect(panelAt({ panels }, 51, 11)).toBeUndefined();
    expect(panelAt({ panels }, 10, 12)).toBeUndefined();
    expect(panelAt({ panels }, 24, 20)?.agentId).toBe("w1");
    expect(panelAt({ panels }, 0, 0)).toBeUndefined();
  });
});
