// The mouse: the wheel scrolls the panel under the pointer, a click focuses a panel. Ink 8 drops
// the terminal's mouse reports (control sequences that are no key it knows), so the terminal's
// input goes through MouseStdin before Ink sees it: it takes the reports out of the data, hands
// them out as "mouse" events, and forwards everything else to Ink unchanged.
//
// Reporting is on only while Ink reads the keys itself (raw mode): when lu-minal hands the terminal
// to another program (a sign-in) or quits, raw mode goes off and so does the mouse, so the shell
// and the programs after it get a terminal without mouse reports.
//
// With reporting on, the terminal no longer selects text with a plain drag: Shift + drag does
// (Windows Terminal, most Linux terminals, kitty, WezTerm), Option + drag in iTerm2, fn + drag in
// Terminal.app. `/mouse off` (config `mouse: false`) leaves the mouse to the terminal.
import { EventEmitter } from "node:events";
import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import type { Layout, PanelSlot } from "./layout.js";

/** Button events with the wheel (1000), in SGR coordinates (1006); no motion reports (1003). */
export const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";

/** How to select text while the mouse is reported. */
export const SELECT_HINT = "To select text, hold Shift while dragging (Option in iTerm2, fn in Terminal.app), or /mouse off.";

/** Rows one wheel step scrolls. */
export const WHEEL_STEP = 3;

export type MouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight" | "none" | "other";

export interface MouseEvent {
  /** The cell, 0-based from the top left corner. */
  x: number;
  y: number;
  button: MouseButton;
  action: "press" | "release" | "move";
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

/** A report's button byte and position (1-based, as the terminal counts) as an event. */
export function decodeMouse(code: number, x: number, y: number, release: boolean): MouseEvent {
  const low = code & 3;
  let button: MouseButton;
  if (code & 128) button = "other";
  else if (code & 64) button = (["wheelUp", "wheelDown", "wheelLeft", "wheelRight"] as const)[low];
  else button = (["left", "middle", "right", "none"] as const)[low];
  return {
    x: Math.max(0, x - 1),
    y: Math.max(0, y - 1),
    button,
    // The old encoding says "released" with button 3 and doesn't say which one.
    action: release || button === "none" ? "release" : code & 32 ? "move" : "press",
    shift: Boolean(code & 4),
    meta: Boolean(code & 8),
    ctrl: Boolean(code & 16),
  };
}

export const isWheel = (e: MouseEvent): boolean => e.button === "wheelUp" || e.button === "wheelDown";

const ESC = "\u001b";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
/** SGR: ESC [ < button ; column ; row M (press) or m (release). */
const SGR = /\u001b\[<(\d{1,4});(\d{1,5});(\d{1,5})([Mm])/y;
/** The beginning of an SGR report, cut off at the end of a chunk. */
const SGR_START = /^\u001b(?:\[(?:<\d{0,4}(?:;\d{0,5}(?:;\d{0,5})?)?)?)?$/;
/** What a cut SGR report leaves: never a key (no key starts with ESC [ <). */
const SGR_CUT = /\u001b\[<[\d;]*/y;
/** The old X10 encoding (terminals without 1006): ESC [ M and three bytes, each value + 32. */
const X10_START = /^\u001b\[M[\s\S]{0,2}$/;
/** After a report, more may be on the way for this long (a turning wheel, a slow SSH link). */
const BURST_MS = 500;

/** Whether held text is the beginning of a report rather than of a key. */
const reportStart = (held: string) => held.startsWith("\u001b[<") || held.startsWith("\u001b[M");

/**
 * Takes the mouse reports out of the terminal's input. Pasted text (between the bracketed-paste
 * markers) goes through untouched, whatever it holds. A report cut in two by the chunks is held
 * back until the rest arrives; the beginning of a report is never typed (dropped when something
 * else follows it), while an ESC or ESC [ at the end of a chunk can be a key, which `flush` gives up.
 */
export class MouseFilter {
  private held = "";
  private inPaste = false;
  /** The end of a paste so far, to find an end marker cut in two. */
  private tail = "";
  private lastReportAt = -Infinity;

  push(chunk: string, now = Date.now()): { text: string; events: MouseEvent[] } {
    const s = this.held + chunk;
    this.held = "";
    let text = "";
    const events: MouseEvent[] = [];
    let i = 0;
    while (i < s.length) {
      if (this.inPaste) {
        const look = this.tail + s.slice(i);
        const at = look.indexOf(PASTE_END);
        if (at < 0) {
          text += s.slice(i);
          this.tail = look.slice(-(PASTE_END.length - 1));
          break;
        }
        const stop = i + at - this.tail.length + PASTE_END.length;
        text += s.slice(i, stop);
        i = stop;
        this.inPaste = false;
        this.tail = "";
        continue;
      }
      const esc = s.indexOf(ESC, i);
      if (esc < 0) {
        text += s.slice(i);
        break;
      }
      text += s.slice(i, esc);
      SGR.lastIndex = esc;
      const m = SGR.exec(s);
      if (m) {
        events.push(decodeMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "m"));
        this.lastReportAt = now;
        i = esc + m[0].length;
        continue;
      }
      if (s.startsWith("\u001b[M", esc) && s.length - esc >= 6) {
        const at = (k: number) => s.charCodeAt(esc + k) - 32;
        events.push(decodeMouse(at(3), at(4), at(5), false));
        this.lastReportAt = now;
        i = esc + 6;
        continue;
      }
      if (s.startsWith(PASTE_START, esc)) {
        text += PASTE_START;
        i = esc + PASTE_START.length;
        this.inPaste = true;
        this.tail = "";
        continue;
      }
      const rest = s.slice(esc, esc + 24);
      if (rest.length === s.length - esc && (SGR_START.test(rest) || X10_START.test(rest) || PASTE_START.startsWith(rest))) {
        // A lone ESC is the escape key - unless reports are coming in, and it may be the next one's.
        if (!(rest === ESC && esc === 0 && !this.inBurst(now))) {
          this.held = rest;
          break;
        }
      }
      SGR_CUT.lastIndex = esc;
      const cut = SGR_CUT.exec(s);
      if (cut) {
        // The beginning of a report that something else followed: dropped, not typed.
        i = esc + cut[0].length;
        continue;
      }
      text += ESC;
      i = esc + 1;
    }
    return { text, events };
  }

  /** Whether reports came in just now (a turning wheel): a cut one is worth waiting for longer. */
  inBurst(now = Date.now()): boolean {
    return now - this.lastReportAt < BURST_MS;
  }

  /** Whether the beginning of a key is waiting (flush gives it up); a report's beginning waits for its rest. */
  get pending(): boolean {
    return this.held.length > 0 && !reportStart(this.held);
  }

  /** Gives up waiting for the rest of a key: what was held back, as typed. */
  flush(): string {
    if (reportStart(this.held)) return "";
    const t = this.held;
    this.held = "";
    return t;
  }

  reset(): void {
    this.held = "";
    this.inPaste = false;
    this.tail = "";
    this.lastReportAt = -Infinity;
  }
}

type Source = Pick<NodeJS.ReadStream, "read" | "on" | "off" | "setRawMode" | "setEncoding"> & {
  isTTY?: boolean;
  ref?: () => unknown;
  unref?: () => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
};

/**
 * The terminal's input as Ink reads it (`render(<App />, { stdin })`), minus the mouse reports,
 * which come out as "mouse" events. Ink reads with `read()` on "readable" and switches raw mode;
 * both reach the real stdin. It also turns the terminal's mouse reporting on and off: on while it
 * is wanted (`setMouse`) and Ink is in raw mode.
 */
export class MouseStdin extends EventEmitter {
  private readonly filter = new MouseFilter();
  private ready = "";
  private timer: NodeJS.Timeout | null = null;
  private wanted = false;
  private raw = false;
  private reportingOn = false;

  constructor(
    readonly source: Source,
    private readonly out: { write(data: string): unknown },
    /** How long an ESC at the end of the input waits for the rest of a report (10x while the wheel turns). */
    private readonly holdMs = 20,
  ) {
    super();
    // Reading starts and stops with Ink's own interest in the input.
    this.on("newListener", (event: string | symbol) => {
      if (event === "readable" && this.listenerCount("readable") === 0) source.on("readable", this.forward);
    });
    this.on("removeListener", (event: string | symbol) => {
      if (event === "readable" && this.listenerCount("readable") === 0) source.off("readable", this.forward);
    });
  }

  private readonly forward = () => this.emit("readable");

  get isTTY(): boolean {
    return this.source.isTTY === true;
  }

  /** Whether the terminal is reporting the mouse now. */
  get reporting(): boolean {
    return this.reportingOn;
  }

  /** Whether lu-minal wants mouse reports (they come while Ink reads the keys). */
  setMouse(wanted: boolean): void {
    this.wanted = wanted;
    this.sync();
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode(mode);
    this.raw = mode;
    if (!mode) {
      // Ink starts over too; the next program gets the terminal as it is.
      this.filter.reset();
      this.ready = "";
      this.clearTimer();
    }
    this.sync();
    return this;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.source.setEncoding(encoding);
    return this;
  }

  ref(): this {
    this.source.ref?.();
    return this;
  }

  unref(): this {
    this.source.unref?.();
    return this;
  }

  pause(): this {
    this.source.pause?.();
    return this;
  }

  resume(): this {
    this.source.resume?.();
    return this;
  }

  read(): string | null {
    if (this.ready) {
      const t = this.ready;
      this.ready = "";
      return t;
    }
    for (;;) {
      const chunk: unknown = this.source.read();
      if (chunk === null || chunk === undefined) {
        if (this.filter.pending) this.armFlush();
        return null;
      }
      this.clearTimer();
      const { text, events } = this.filter.push(typeof chunk === "string" ? chunk : String(chunk));
      for (const e of events) this.emit("mouse", e);
      if (text) return text;
    }
  }

  /** Mouse reporting off for good (lu-minal is ending). */
  dispose(): void {
    this.wanted = false;
    this.sync();
    this.clearTimer();
  }

  private sync(): void {
    const on = this.wanted && this.raw;
    if (on === this.reportingOn) return;
    this.reportingOn = on;
    try {
      this.out.write(on ? MOUSE_ON : MOUSE_OFF);
    } catch {
      // the terminal is gone
    }
  }

  /** Gives a held ESC up as typed after a while: longer while the wheel turns (it may be a report's). */
  private armFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.ready += this.filter.flush();
        if (this.ready) this.emit("readable");
      },
      this.filter.inBurst() ? this.holdMs * 10 : this.holdMs,
    );
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Whether reporting the mouse helps in this terminal. The macOS app's terminal (SwiftTerm 1.10)
 * scrolls its own buffer with the wheel and never reports it, and while an app has mouse reports
 * on it doesn't select text at all: there the mouse stays the terminal's.
 */
export function mouseReportingUseful(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LU_MINAL_APP !== "1";
}

/** Calls `handler` for each mouse event while `isActive` (when Ink reads through a MouseStdin). */
export function useMouse(handler: (e: MouseEvent) => void, opts: { isActive?: boolean } = {}): void {
  const { stdin } = useStdin();
  const ref = useRef(handler);
  ref.current = handler;
  const active = opts.isActive !== false;
  useEffect(() => {
    if (!active || !(stdin instanceof MouseStdin)) return;
    const on = (e: MouseEvent) => ref.current(e);
    stdin.on("mouse", on);
    return () => {
      stdin.off("mouse", on);
    };
  }, [stdin, active]);
}

/** The MouseStdin Ink reads from, if it does. */
export function useMouseInput(): MouseStdin | null {
  const { stdin } = useStdin();
  return stdin instanceof MouseStdin ? stdin : null;
}

/** The panel at a cell, if any. */
export function panelAt(layout: Pick<Layout, "panels">, x: number, y: number): PanelSlot | undefined {
  return layout.panels.find((p) => x >= p.rect.x && x < p.rect.x + p.rect.width && y >= p.rect.y && y < p.rect.y + p.rect.height);
}
