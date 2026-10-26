// Long pastes stay out of the prompt (like OpenCode and Claude Code): the prompt gets a chip such as
// "[Pasted text #1 +87 lines]" and the full text is kept next to it, to go out with the message.
// Pure functions of (prompt, pastes), so the prompt keeps its one-line editor and stays testable.
import type { EditorState } from "./editor.js";

/** A paste kept out of the prompt: the prompt shows `token`, the message gets `text`. */
export interface PastedText {
  id: number;
  token: string;
  text: string;
}

/** The texts behind one prompt's chips. */
export interface Pastes {
  /** The number the next paste gets: they count up from 1 in every prompt. */
  next: number;
  items: readonly PastedText[];
}

export const noPastes = (): Pastes => ({ next: 1, items: [] });

/** A paste of more lines or characters than this becomes a chip. */
export const PASTE_MAX_LINES = 5;
export const PASTE_MAX_CHARS = 1000;

/** Anything that looks like a chip; only the ones with a kept text count. */
const TOKEN = /\[Pasted text #\d+ \+[\d,]+ (?:lines|chars)\]/g;

/** Terminals send a pasted line break as "\r" (Windows: "\r\n"). */
export const normalizePaste = (text: string): string => text.replace(/\r\n?/g, "\n");

/** Lines of text; a final line break doesn't start another one. */
export function lineCount(text: string): number {
  const t = normalizePaste(text);
  if (!t) return 0;
  return t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
}

/** Whether a paste becomes a chip. Blank lines alone don't: a chip of nothing would send nothing. */
export function isLongPaste(text: string): boolean {
  const t = normalizePaste(text);
  if (!t.trim()) return false;
  return lineCount(t) > PASTE_MAX_LINES || t.length > PASTE_MAX_CHARS;
}

/** "[Pasted text #1 +87 lines]", or "+1,234 chars" for one very long line. */
export function pasteToken(id: number, text: string): string {
  const t = normalizePaste(text);
  const lines = lineCount(t);
  const size = lines > 1 ? `${lines.toLocaleString("en-US")} lines` : `${t.length.toLocaleString("en-US")} chars`;
  return `[Pasted text #${id} +${size}]`;
}

/** Keeps `text` under the next number; the token goes into the prompt. */
export function addPaste(pastes: Pastes, text: string): { pastes: Pastes; token: string } {
  const clean = normalizePaste(text);
  const token = pasteToken(pastes.next, clean);
  return { pastes: { next: pastes.next + 1, items: [...pastes.items, { id: pastes.next, token, text: clean }] }, token };
}

/**
 * The message as sent: every chip with a kept text becomes that text, in one pass, so a chip inside
 * a pasted text stays as it is. Chips without a kept text (forgotten, or typed) stay too.
 */
export function expandPastes(value: string, pastes: Pastes): string {
  if (!pastes.items.length) return value;
  return value.replace(TOKEN, (m) => pastes.items.find((p) => p.token === m)?.text ?? m);
}

/**
 * Forgets the texts whose chip is no longer in the prompt (deleted, or cut in half); an empty
 * prompt forgets them all and counts from 1 again. Unchanged pastes come back as the same object.
 */
export function keepReferenced(pastes: Pastes, value: string): Pastes {
  if (!value) return pastes.items.length || pastes.next !== 1 ? noPastes() : pastes;
  const items = pastes.items.filter((p) => value.includes(p.token));
  return items.length === pastes.items.length ? pastes : { next: pastes.next, items };
}

/**
 * Backspace right after a chip deletes the whole chip. `word` (ctrl+w, alt+backspace) also takes
 * the spaces between the chip and the cursor, as those keys do for a word. Null when the cursor
 * isn't after a chip.
 */
export function deleteChipBefore(editor: EditorState, pastes: Pastes, word = false): EditorState | null {
  const { value, cursor } = editor;
  let end = cursor;
  if (word) while (end > 0 && /\s/.test(value[end - 1])) end--;
  const before = value.slice(0, end);
  const chip = pastes.items.find((p) => before.endsWith(p.token));
  if (!chip) return null;
  const start = end - chip.token.length;
  return { value: value.slice(0, start) + value.slice(cursor), cursor: start };
}

/** Where the chips with a kept text are in `line`, as [start, end) ranges in order. */
export function chipRanges(line: string, tokens: readonly string[]): Array<[number, number]> {
  if (!tokens.length) return [];
  const known = new Set(tokens);
  const out: Array<[number, number]> = [];
  for (const m of line.matchAll(TOKEN)) {
    if (known.has(m[0])) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
