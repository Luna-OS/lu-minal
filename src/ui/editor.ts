// The prompt's line editor as a pure function of (state, key), so it is easy to test and the same
// for every panel. Readline-style keys work in every terminal: Ctrl+A/E, Ctrl+U, Ctrl+W, Alt+B/F.
import type { Key } from "ink";

export interface EditorState {
  value: string;
  /** Cursor position in UTF-16 code units, always on a grapheme boundary. */
  cursor: number;
}

export const emptyEditor = (): EditorState => ({ value: "", cursor: 0 });

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prevBoundary(s: string, i: number): number {
  let last = 0;
  for (const { index } of segmenter.segment(s)) {
    if (index >= i) break;
    last = index;
  }
  return last;
}

function nextBoundary(s: string, i: number): number {
  for (const { index, segment } of segmenter.segment(s)) {
    if (index >= i) return index + segment.length;
  }
  return s.length;
}

function wordLeft(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1])) j--;
  while (j > 0 && !/\s/.test(s[j - 1])) j--;
  return j;
}

function wordRight(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  while (j < s.length && !/\s/.test(s[j])) j++;
  return j;
}

export function insertText(state: EditorState, text: string): EditorState {
  const clean = text.replace(/\r\n?/g, "\n");
  return {
    value: state.value.slice(0, state.cursor) + clean + state.value.slice(state.cursor),
    cursor: state.cursor + clean.length,
  };
}

export type EditResult = { kind: "edit"; state: EditorState } | { kind: "submit" } | { kind: "ignored" };

/**
 * Applies one keypress. Enter submits, except after a trailing backslash, which turns into a new
 * line (like Claude Code). Keys the editor doesn't use come back as "ignored".
 */
export function editKey(state: EditorState, input: string, key: Key): EditResult {
  const { value, cursor } = state;
  const edit = (next: EditorState): EditResult => ({ kind: "edit", state: next });
  if (key.return) {
    if (value.slice(0, cursor).endsWith("\\")) {
      return edit(insertText({ value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 }, "\n"));
    }
    if (key.meta || key.shift) return edit(insertText(state, "\n"));
    return { kind: "submit" };
  }
  if (key.backspace) {
    if (key.meta || key.ctrl) {
      const j = wordLeft(value, cursor);
      return edit({ value: value.slice(0, j) + value.slice(cursor), cursor: j });
    }
    if (cursor === 0) return edit(state);
    const j = prevBoundary(value, cursor);
    return edit({ value: value.slice(0, j) + value.slice(cursor), cursor: j });
  }
  if (key.delete) {
    if (cursor >= value.length) return edit(state);
    const j = nextBoundary(value, cursor);
    return edit({ value: value.slice(0, cursor) + value.slice(j), cursor });
  }
  if (key.leftArrow) {
    return edit({ value, cursor: key.meta || key.ctrl ? wordLeft(value, cursor) : prevBoundary(value, cursor) });
  }
  if (key.rightArrow) {
    return edit({ value, cursor: key.meta || key.ctrl ? wordRight(value, cursor) : nextBoundary(value, cursor) });
  }
  if (key.home) return edit({ value, cursor: 0 });
  if (key.end) return edit({ value, cursor: value.length });
  if (key.ctrl) {
    switch (input) {
      case "a":
        return edit({ value, cursor: 0 });
      case "e":
        return edit({ value, cursor: value.length });
      case "u":
        return edit({ value: value.slice(cursor), cursor: 0 });
      case "w": {
        if (!value) return { kind: "ignored" };
        const j = wordLeft(value, cursor);
        return edit({ value: value.slice(0, j) + value.slice(cursor), cursor: j });
      }
      case "b":
        return edit({ value, cursor: prevBoundary(value, cursor) });
      case "f":
        return edit({ value, cursor: nextBoundary(value, cursor) });
      default:
        return { kind: "ignored" };
    }
  }
  if (key.meta) {
    if (input === "b") return edit({ value, cursor: wordLeft(value, cursor) });
    if (input === "f") return edit({ value, cursor: wordRight(value, cursor) });
    if (input === "d") {
      const j = wordRight(value, cursor);
      return edit({ value: value.slice(0, cursor) + value.slice(j), cursor });
    }
    return { kind: "ignored" };
  }
  if (key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
    return { kind: "ignored" };
  }
  if (!input) return { kind: "ignored" };
  // Drop other control characters a terminal may send.
  // eslint-disable-next-line no-control-regex
  const text = input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (!text) return { kind: "ignored" };
  return edit(insertText(state, text));
}
