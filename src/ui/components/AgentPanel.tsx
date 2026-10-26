// One agent's panel: the frame with its name, area label and model, the tail of its log, the question
// card while the agent waits on the user, the status line ("✦ Charting… (23m 9s · ↓ 72.6k)") and,
// when focused, the prompt.
import { Box, Text } from "ink";
import React from "react";
import type { Agent } from "../../core/agent.js";
import type { Project } from "../../core/project.js";
import type { Theme } from "../../themes/types.js";
import { askCard, pendingAsk, type CardView } from "../ask-card.js";
import type { EditorState } from "../editor.js";
import { formatElapsed, formatTokens } from "../format.js";
import type { Rect } from "../layout.js";
import { logTail, type Row, type Seg } from "../log-lines.js";
import { chipRanges } from "../paste.js";
import { truncate, width as textWidth } from "../text.js";
import { Frame } from "./Frame.js";
import { RowView, Segs } from "./RowView.js";

const SPINNER = ["✦", "✧", "⋆", "·", "⋆", "✧"];

export function agentColor(project: Project, agent: Agent, theme: Theme): string {
  if (agent.role === "lead") return theme.colors.accent;
  const workers = project.agents.filter((a) => a.role !== "lead");
  const i = Math.max(0, workers.indexOf(agent));
  const list = theme.colors.agents.length ? theme.colors.agents : [theme.colors.accent2];
  return list[i % list.length];
}

export function colorByName(project: Project, theme: Theme): (name: string) => string {
  return (name: string) => {
    if (name === "you") return theme.colors.accent;
    const agent = project.findAgent(name);
    return agent ? agentColor(project, agent, theme) : theme.colors.accent2;
  };
}

/** A short model label for the title: "claude-code/opus" → "opus", OpenRouter ids lose the vendor. */
export function shortModel(agent: Agent): string {
  const m = agent.model.model;
  const base = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  return agent.model.provider === "claude-code" ? `claude ${base}` : base;
}

/** The status line under the log. */
export function statusSegs(agent: Agent, project: Project, theme: Theme, frame: number, now: number): Seg[] {
  const c = theme.colors;
  const tokens = formatTokens(agent.tokensIn + agent.tokensOut);
  switch (agent.status) {
    case "working": {
      const elapsed = formatElapsed(now - (agent.turnStartedAt ?? now));
      return [
        { text: `${SPINNER[frame % SPINNER.length]} `, color: c.accent2 },
        { text: `${agent.activity ?? "Working"}…`, color: c.accent2 },
        { text: ` (${elapsed} · ↓ ${tokens})`, color: c.faint },
        ...(agent.queued > 0 ? [{ text: ` · ${agent.queued} queued`, color: c.warning } as Seg] : []),
      ];
    }
    case "waiting":
      return [
        { text: "▲ ", color: c.warning },
        { text: "waiting for you", color: c.warning, bold: true },
        { text: " · y allow · a always · n deny", color: c.faint },
      ];
    case "starting":
      return [{ text: `${SPINNER[frame % SPINNER.length]} starting ${agent.modelLabel}…`, color: c.faint }];
    case "error": {
      // The error itself is the last log row already; the status line only says what to do.
      const last = agent.log[agent.log.length - 1];
      const shown = last?.kind === "error";
      return [
        { text: "✗ ", color: c.error },
        { text: shown || !agent.lastError ? "needs attention" : firstLine(agent.lastError), color: c.error },
        { text: " · send a message to retry · ctrl+o model", color: c.faint },
      ];
    }
    case "stopped":
      return [{ text: "■ stopped", color: c.faint }];
    default: {
      const busyWorkers = agent.role === "lead" ? project.agents.filter((a) => a !== agent && a.busy) : [];
      if (busyWorkers.length) {
        const since = Math.min(...busyWorkers.map((a) => a.turnStartedAt ?? now));
        return [
          { text: `${SPINNER[frame % SPINNER.length]} `, color: c.accent },
          { text: "Delegating…", color: c.accent },
          { text: ` (${formatElapsed(now - since)} · ↓ ${tokens})`, color: c.faint },
        ];
      }
      return [
        { text: "◇ ", color: c.faint },
        { text: "ready", color: c.muted },
        { text: ` · ${agent.modelLabel}`, color: c.faint },
        ...(agent.contextTokens ? [{ text: ` · ctx ${formatTokens(agent.contextTokens)}`, color: c.faint } as Seg] : []),
      ];
    }
  }
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim()) ?? s;
}

/**
 * The prompt row: "› text" with a block cursor, scrolled so the cursor stays visible. `chips` are
 * the paste tokens with a kept text, drawn in the accent colour.
 */
export function promptSegs(editor: EditorState, width: number, theme: Theme, placeholder: string, chips: readonly string[] = []): Seg[] {
  const c = theme.colors;
  const prefix: Seg = { text: "› ", color: c.accent, bold: true };
  const room = Math.max(4, width - 2);
  if (!editor.value) {
    return [prefix, { text: " ", inverse: true, color: c.text }, { text: truncate(placeholder, room - 1), color: c.faint }];
  }
  // Show the current line of a multi-line message.
  const before = editor.value.slice(0, editor.cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEndAt = editor.value.indexOf("\n", editor.cursor);
  const lineEnd = lineEndAt < 0 ? editor.value.length : lineEndAt;
  const line = editor.value.slice(lineStart, lineEnd);
  const col = editor.cursor - lineStart;
  const lineCount = editor.value.split("\n").length;
  const hint = lineCount > 1 ? ` (${lineCount} lines)` : "";
  const avail = Math.max(4, room - hint.length);
  // `from`: the first character of the line that still fits left of the cursor.
  let from = 0;
  while (textWidth(line.slice(from, col)) + 1 > avail - 1 && from < col) from++;
  const left = line.slice(from, col);
  const at = line.slice(col, col + 1) || " ";
  const rightRoom = Math.max(0, avail - textWidth(left) - 1);
  const right = truncate(line.slice(col + 1), rightRoom);
  const ranges = chipRanges(line, chips);
  const inChip = (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  /** `text` as it stands at `start` in the line, split where chips begin and end. */
  const paint = (text: string, start: number): Seg[] => {
    if (!ranges.length) return [{ text, color: c.text }];
    const out: Seg[] = [];
    for (let i = 0; i < text.length; ) {
      const chip = inChip(start + i);
      let j = i + 1;
      while (j < text.length && inChip(start + j) === chip) j++;
      out.push({ text: text.slice(i, j), color: chip ? c.accent : c.text });
      i = j;
    }
    return out;
  };
  return [
    prefix,
    ...paint(left, from),
    { text: at, color: inChip(col) ? c.accent : c.text, inverse: true },
    ...paint(right, col + 1),
    ...(hint ? [{ text: hint, color: c.faint } as Seg] : []),
  ];
}

export interface AgentPanelProps {
  agent: Agent;
  project: Project;
  rect: Rect;
  focused: boolean;
  zoomed: boolean;
  theme: Theme;
  frame: number;
  now: number;
  editor: EditorState | null;
  /** The prompt's paste chips ("[Pasted text #1 +87 lines]"), drawn in the accent colour. */
  chips?: readonly string[];
  /** Rows scrolled up from the bottom. */
  scroll: number;
  /** Columns to keep free on the right (Axo's corner in the lead panel). */
  reserveRight?: number;
  /** Rows the slash-command menu takes above the prompt. */
  menu?: Row[];
  /** The question card's first row in view (pgup / pgdn), for the ask it was scrolled on. */
  cardTop?: { id: string; top: number };
  /** The question the user put away with esc. */
  dismissedAsk?: string;
  /** Told where the question card is scrolled (null: no card), for pgup / pgdn. */
  onCard?: (card: CardView | null) => void;
}

export function AgentPanel(props: AgentPanelProps) {
  const { agent, project, rect, focused, theme, frame, now, editor } = props;
  const c = theme.colors;
  const bg = focused ? c.surfaceFocus : c.surface;
  const innerW = Math.max(4, rect.width - 4 - (props.reserveRight ?? 0));
  const innerH = Math.max(1, rect.height - 2);
  const color = agentColor(project, agent, theme);

  const workers = project.agents.filter((a) => a.role !== "lead").length;
  const title: Seg[] = [
    { text: "◆ ", color },
    { text: agent.name, color: c.text, bold: true },
  ];
  const right: Seg[] = [];
  if (agent.role === "lead") {
    right.push({ text: `lead · ${workers} worker${workers === 1 ? "" : "s"}`, color: c.muted });
  } else if (agent.label) {
    right.push({ text: agent.label, color: c.muted });
  }
  right.push({ text: `${right.length ? " · " : ""}${shortModel(agent)}`, color: c.faint });

  const menu = focused ? (props.menu ?? []) : [];
  const footerRows = 1 + (focused && editor ? 1 : 0) + menu.length;
  const room = Math.max(0, innerH - footerRows);
  // What the agent waits on the user for, in full above the prompt; the log scrolls on above it.
  const ask = pendingAsk(agent, props.dismissedAsk);
  const card = ask
    ? askCard(ask, {
        width: innerW,
        panelRows: innerH,
        room,
        theme,
        name: agent.name,
        nameColor: color,
        focused,
        top: props.cardTop?.id === ask.id ? props.cardTop.top : undefined,
      })
    : null;
  props.onCard?.(ask && card ? { id: ask.id, top: card.top, maxTop: card.maxTop, page: card.page } : null);
  const logRoom = Math.max(0, room - (card?.rows.length ?? 0));
  // Tool output and code keep their first lines until zoomed (ctrl+f).
  const fold = Math.max(2, Math.min(6, Math.floor(innerH / 3)));
  const rows = logTail(agent.log, logRoom + props.scroll, {
    width: innerW,
    theme,
    colorOf: colorByName(project, theme),
    maxDiffLines: props.zoomed ? 500 : fold,
    maxTextLines: props.zoomed ? 0 : Math.max(3, Math.floor(innerH / 2)),
    fullReasoning: props.zoomed,
    maxCodeLines: props.zoomed ? 0 : fold,
    expandHint: props.zoomed ? undefined : "ctrl+f to expand",
    pinned: card ? (ask?.entryId ?? undefined) : undefined,
  });
  const end = Math.max(0, rows.length - props.scroll);
  const visible = rows.slice(Math.max(0, end - logRoom), end);
  const scrolled = props.scroll > 0 && rows.length > logRoom;

  const borderColor =
    agent.status === "waiting" ? c.warning : focused ? c.borderFocus : agent.status === "error" ? c.error : c.border;

  const placeholder = `Message ${agent.name}… (@name for a teammate, / for commands, ctrl+v for a picture)`;
  return (
    <Frame rect={rect} title={title} right={right} borderColor={borderColor} bg={bg}>
      <Box flexDirection="column" width={innerW} height={logRoom}>
        {visible.map((row) => (
          <RowView key={row.key} row={row} width={innerW} bg={bg} />
        ))}
      </Box>
      {card?.rows.map((row) => (
        <RowView key={row.key} row={row} width={innerW} bg={bg} />
      ))}
      {menu.map((row) => (
        <RowView key={row.key} row={row} width={innerW} bg={bg} />
      ))}
      <Box width={innerW}>
        <Segs
          bg={bg}
          segs={
            scrolled
              ? [{ text: `↑ scrolled ${props.scroll} rows · PgDn to follow`, color: c.warning }]
              : statusSegs(agent, project, theme, frame, now)
          }
        />
      </Box>
      {focused && editor ? (
        <Box width={innerW}>
          <Segs bg={bg} segs={promptSegs(editor, innerW, theme, placeholder, props.chips)} />
        </Box>
      ) : null}
    </Frame>
  );
}

/** Text drawn on the glass: a helper for panels that only show a message. */
export function GlassText({ text, color, bg }: { text: string; color: string; bg: string }) {
  return (
    <Text color={color} backgroundColor={bg} wrap="truncate">
      {text}
    </Text>
  );
}
