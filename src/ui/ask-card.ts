// The question card: what an agent waits on the user for, pinned at the bottom of its panel above
// the prompt, so it reads in full however much code and tool output the log above holds.
//   ╭ ▲ luna asks · Bash ──────────────────────────────── 1 of 2 ╮
//   │ run npm run build && npm test -- --run test/ui              │
//   │ (Build, then run the UI tests)                              │
//   ╰  y  allow   a  always   n  deny ───────────────────────────╯
// Two kinds: a pending permission request (y / a / n answer it), and a question the agent's last
// answer ends its turn with (the user answers with a message, esc puts the card away). A body
// longer than the card scrolls with pgup / pgdn. Pure (no React), so it is tested on its own.
import type { AgentStatus, ApprovalRequest, LogEntry } from "../core/types.js";
import type { Theme } from "../themes/types.js";
import { prose, type Row, type Seg } from "./log-lines.js";
import { truncate, width, wrap } from "./text.js";

export type Ask =
  | {
      kind: "approval";
      /** The request's id. */
      id: string;
      /** Its row in the log (kept to one line there while the card shows it). */
      entryId: string | null;
      request: ApprovalRequest;
      /** Open requests, this one included. */
      queued: number;
    }
  | {
      kind: "question";
      /** The id of the answer that asks (its log entry). */
      id: string;
      entryId: string;
      text: string;
    };

/** What pendingAsk reads of an agent. */
export interface AskSource {
  status: AgentStatus;
  log: LogEntry[];
  pendingApproval: ApprovalRequest | null;
  approvals: readonly unknown[];
}

// ---- is it a question? ---------------------------------------------------------------------------

/** A sentence ending in a question mark: "…the docs?", "**Proceed?**", "(yes or no?)". */
const QUESTION = /[?？][*_)\]"'»”’]*(?=\s|$)/;
/** A numbered option: "1. Keep it", "2) Rewrite". */
const NUMBERED = /^\s*\d{1,2}[.)]\s+\S/;
/** Any list item: numbered, "a)", or a bullet. */
const ITEM = /^\s*(?:\d{1,2}[.)]|[a-z]\)|[-*•])\s+\S/;

/** The text without code (fenced blocks go, inline code becomes a word): code asks nothing. */
function plainLines(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) out.push(line.replace(/`[^`]*`/g, "code"));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * Whether an answer asks the user something: its last paragraph has a question in it, a numbered
 * list of options comes before a question, or the answer ends with options under a question.
 */
export function asksSomething(text: string): boolean {
  const lines = plainLines(text);
  if (!lines.length) return false;
  let start = lines.length - 1;
  while (start > 0 && lines[start - 1].trim()) start--;
  if (lines.slice(start).some((l) => QUESTION.test(l))) return true;

  let lastOption = -1;
  let options = 0;
  lines.forEach((l, i) => {
    if (NUMBERED.test(l)) {
      options++;
      lastOption = i;
    }
  });
  if (options >= 2 && lines.slice(lastOption + 1).some((l) => QUESTION.test(l))) return true;

  // "Which one do you want?" and the options under it, to the end.
  let i = lines.length - 1;
  let items = 0;
  while (i >= 0 && (ITEM.test(lines[i]) || !lines[i].trim() || /^\s{2,}\S/.test(lines[i]))) {
    if (ITEM.test(lines[i])) items++;
    i--;
  }
  return items >= 2 && i >= 0 && QUESTION.test(lines[i]);
}

/** The agent's last answer, when nothing but notes and reasoning came after it. */
function lastAnswer(log: LogEntry[]): (LogEntry & { kind: "text" }) | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === "text") {
      if (e.text.trim()) return e;
      continue;
    }
    if (e.kind !== "info" && e.kind !== "reasoning") return null;
  }
  return null;
}

/**
 * What the agent waits on the user for: the oldest open permission request, else (its turn over)
 * a question its last answer asks, until the user writes to it again or dismissed that one.
 */
export function pendingAsk(agent: AskSource, dismissed?: string | null): Ask | null {
  const request = agent.pendingApproval;
  if (request) {
    let entryId: string | null = null;
    for (let i = agent.log.length - 1; i >= 0; i--) {
      const e = agent.log[i];
      if (e.kind === "approval" && e.request.id === request.id) {
        entryId = e.id;
        break;
      }
    }
    return { kind: "approval", id: request.id, entryId, request, queued: agent.approvals.length };
  }
  if (agent.status !== "idle") return null;
  const answer = lastAnswer(agent.log);
  if (!answer || answer.id === dismissed || !asksSomething(answer.text)) return null;
  return { kind: "question", id: answer.id, entryId: answer.id, text: answer.text };
}

// ---- the card ------------------------------------------------------------------------------------

/**
 * Rows the card may take: about half the panel for a request; for a question all of the log's room
 * it needs (a big panel keeps one log row above it).
 */
export function cardRoom(kind: Ask["kind"], panelRows: number, room: number): number {
  if (kind === "approval") return Math.min(room, Math.max(4, Math.ceil(panelRows / 2)));
  return room > 10 ? room - 1 : room;
}

export interface AskCardOptions {
  /** The panel's inner width (the card's). */
  width: number;
  /** The panel's inner height. */
  panelRows: number;
  /** Rows for the log and the card together (the panel less its status line, menu and prompt). */
  room: number;
  theme: Theme;
  /** The agent's name and colour, for the title. */
  name: string;
  nameColor: string;
  /** The first body row in view; unset: a request from its start, a question to its end. */
  top?: number;
  /** The focused panel (its keys answer). */
  focused: boolean;
}

export interface AskCard {
  rows: Row[];
  /** The first body row in view, and the last one it can be (0: the body fits). */
  top: number;
  maxTop: number;
  /** Body rows in view. */
  page: number;
}

/** Where the card is scrolled, as the panel reports it (pgup / pgdn move it). */
export interface CardView {
  id: string;
  top: number;
  maxTop: number;
  page: number;
}

/**
 * The card's first row after pgup (-1) or pgdn (1), or null when the key scrolls the log: the card
 * fits, it is at that end already, or (pgdn) the log is scrolled up and comes back first.
 */
export function cardPage(card: CardView | null | undefined, dir: -1 | 1, logScrolled: boolean): number | null {
  if (!card || card.maxTop <= 0) return null;
  if (dir > 0 && logScrolled) return null;
  const top = Math.max(0, Math.min(card.maxTop, card.top + dir * Math.max(1, card.page - 1)));
  return top === card.top ? null : top;
}

const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s.text), 0);

/** Segments cut to `max` columns. */
function fitSegs(segs: Seg[], max: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const w = width(s.text);
    if (used + w <= max) {
      out.push(s);
      used += w;
      continue;
    }
    if (max - used > 1) out.push({ ...s, text: truncate(s.text, max - used) });
    break;
  }
  return out;
}

/** "╭ title ───── right ╮" (or ╰ … ╯), exactly `w` columns. */
function borderRow(key: string, ends: [string, string], title: Seg[], right: Seg[], w: number, color: string): Row {
  const room = w - 2;
  const r = right.length ? fitSegs(right, Math.max(0, Math.floor(room / 2) - 2)) : [];
  const rw = r.length ? segsWidth(r) + 2 : 0;
  const t = title.length ? fitSegs(title, Math.max(0, room - rw - 3)) : [];
  const tw = t.length ? segsWidth(t) + 2 : 0;
  const fill = Math.max(0, room - tw - rw);
  const pad = (text: string): Seg => ({ text, color });
  return {
    key,
    segs: [
      pad(ends[0]),
      ...(t.length ? [pad(" "), ...t, pad(" ")] : []),
      pad("─".repeat(fill)),
      ...(r.length ? [pad(" "), ...r, pad(" ")] : []),
      pad(ends[1]),
    ],
  };
}

/** Wraps `text` into body lines of one style. */
function lines(text: string, w: number, seg: Omit<Seg, "text">): Seg[][] {
  return wrap(text, w).map((l) => [{ ...seg, text: l }]);
}

/** A request's body: what it does (the whole command or path), then its detail (the diff). */
function requestBody(request: ApprovalRequest, w: number, theme: Theme): Seg[][] {
  const c = theme.colors;
  const summary = request.summary.trim();
  let detail = (request.detail ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  let head = summary;
  // "run npm te…" + the command: the verb and the command in full, once.
  const verb = /^\S+/.exec(summary)?.[0] ?? "";
  const rest = summary.slice(verb.length).trim().replace(/…$/, "");
  const [first = "", ...more] = detail.split("\n");
  if (detail.trim() === summary) detail = "";
  else if (rest && first.trim().startsWith(rest)) {
    head = `${verb} ${first.trim()}`;
    detail = more.join("\n");
  }
  const out = lines(head, w, { color: c.text, bold: true });
  const diff = request.risk === "edit" || /edit|write|notebook/i.test(request.tool);
  for (const line of detail ? detail.split("\n") : []) {
    if (diff && /^\+/.test(line)) out.push(...lines(line, w, { color: c.diffAddFg, bg: c.diffAddBg }));
    else if (diff && /^-/.test(line)) out.push(...lines(line, w, { color: c.diffDelFg, bg: c.diffDelBg }));
    else out.push(...lines(line, w, { color: /^\s*\(.*\)\s*$/.test(line) || /^\s*…/.test(line) ? c.muted : c.text }));
  }
  return out;
}

/** The card's text, wrapped to `w` columns: one list of segments per row. */
function cardBody(ask: Ask, w: number, theme: Theme): Seg[][] {
  const body =
    ask.kind === "approval"
      ? requestBody(ask.request, w, theme)
      : prose("ask", ask.text, w, [], { text: "", color: theme.colors.text }, theme, 0, { wrap: true }).map((r) => r.segs);
  return body.length ? body : [[{ text: "" }]];
}

/** The rows a card for `ask` takes in full in a panel `width` columns wide inside (borders too). */
export function cardHeight(ask: Ask, width: number, theme: Theme): number {
  return width - 4 < 8 ? 0 : cardBody(ask, width - 4, theme).length + 2;
}

/**
 * The inner rows a panel `width` columns wide inside needs to show the card for `ask` whole, with
 * its status line and prompt (the lead's panel grows toward them while it asks).
 */
export function panelRowsFor(ask: Ask, width: number, theme: Theme): number {
  const h = cardHeight(ask, width, theme);
  if (!h) return 0;
  return ask.kind === "approval" ? Math.max(2 * h - 1, h + 2) : h + 3;
}

/** The card for `ask`, or null when the panel has no room for one. */
export function askCard(ask: Ask, o: AskCardOptions): AskCard | null {
  const c = o.theme.colors;
  const inner = o.width - 4;
  const cap = cardRoom(ask.kind, o.panelRows, o.room);
  if (inner < 8 || cap < 2) return null;

  const body = cardBody(ask, inner, o.theme);
  // The bottom border when everything fits with it, or in a big panel; else the text gets its row.
  const bottom = body.length + 2 <= cap || cap >= 10;
  const page = Math.max(1, Math.min(body.length, cap - (bottom ? 2 : 1)));
  const maxTop = body.length - page;
  const top = Math.max(0, Math.min(maxTop, o.top ?? (ask.kind === "question" ? maxTop : 0)));

  const scroll: Seg[] = [];
  const below = maxTop - top;
  if (top && below) scroll.push({ text: `↑ ${top} ↓ ${below} · pgup pgdn`, color: c.faint });
  else if (below) scroll.push({ text: `↓ ${below} more · pgdn`, color: c.faint });
  else if (top) scroll.push({ text: `↑ ${top} more · pgup`, color: c.faint });

  const title: Seg[] =
    ask.kind === "approval"
      ? [
          { text: "▲ ", color: c.warning, bold: true },
          { text: o.name, color: o.nameColor, bold: true },
          { text: " asks", color: c.muted },
          { text: ` · ${ask.request.tool}`, color: c.faint },
        ]
      : [
          { text: "◆ ", color: c.accent },
          { text: o.name, color: o.nameColor, bold: true },
          { text: " asks", color: c.muted },
        ];
  const queued: Seg[] = ask.kind === "approval" && ask.queued > 1 ? [{ text: `1 of ${ask.queued}`, color: c.warning }] : [];
  const keys: Seg[] =
    ask.kind === "approval"
      ? [
          { text: " y ", color: c.bg, bg: c.success, bold: true },
          { text: " allow  ", color: c.muted },
          { text: " a ", color: c.bg, bg: c.accent, bold: true },
          { text: " always  ", color: c.muted },
          { text: " n ", color: c.bg, bg: c.error, bold: true },
          { text: " deny", color: c.muted },
        ]
      : o.focused
        ? [{ text: "answer below · esc dismisses", color: c.faint }]
        : [];

  const border = c.accent;
  const rows: Row[] = [borderRow("ask:top", ["╭", "╮"], title, bottom ? queued : scroll.length ? scroll : queued, o.width, border)];
  body.slice(top, top + page).forEach((segs, i) => {
    const fitted = fitSegs(segs, inner);
    rows.push({
      key: `ask:${i}`,
      segs: [
        { text: "│ ", color: border },
        ...fitted,
        { text: " ".repeat(Math.max(0, inner - segsWidth(fitted))) },
        { text: " │", color: border },
      ],
    });
  });
  if (bottom) rows.push(borderRow("ask:bottom", ["╰", "╯"], keys, scroll, o.width, border));
  return { rows, top, maxTop, page };
}
