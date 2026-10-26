// The home screen: the start screen (keys, sign-ins, recent folders, Axo) beside the news (new
// models, Claude Code, Anthropic's status, lu-minal's own version). It stands in for an empty
// window and opens over the tabs with /home or alt+0. Like the tab bar it sits right on the sky:
// only text cells are painted, so the stars shine between the columns. Two columns when there is
// room, one above the other when not; rows that don't fit go, the least useful first.
import fs from "node:fs";
import path from "node:path";
import { Box } from "ink";
import React from "react";
import type { Hub } from "../../core/hub.js";
import { NEW_MODEL_DAYS, newestModels, type NewModel } from "../../core/news.js";
import { samePath, tildify } from "../../platform/paths.js";
import { compareVersions } from "../../platform/update.js";
import type { ThemeColors } from "../../themes/types.js";
import { VERSION } from "../../version.js";
import { AXO_COLUMNS } from "../axo/render.js";
import { formatAgo } from "../format.js";
import type { Rect } from "../layout.js";
import type { Seg } from "../log-lines.js";
import { truncate, truncateStart, width as textWidth } from "../text.js";
import { Axo } from "./Axo.js";
import { Segs } from "./RowView.js";

/** How many recent folders home lists. */
export const HOME_RECENT = 6;
/** Axo's rows with its caption. */
const AXO_ROWS = 11;
/** The widest the two columns get together, and the narrowest that still takes two. */
const MAX_WIDTH = 116;
const TWO_COLUMNS = 76;
/** "Sep 28". */
const DATE_W = 6;

/** A folder from the recent list that is still there. */
export interface RecentFolder {
  cwd: string;
  name: string;
  /** The tab it is open in, or -1. */
  tab: number;
}

export function recentFolders(hub: Hub, max = HOME_RECENT): RecentFolder[] {
  const out: RecentFolder[] = [];
  for (const cwd of hub.config.recent) {
    if (out.length >= max) break;
    try {
      if (!fs.statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ cwd, name: path.basename(cwd) || cwd, tab: hub.projects.findIndex((p) => samePath(p.cwd, cwd)) });
  }
  return out;
}

/** Enter on a recent folder: its tab when it is open, else a new tab. */
export function openRecent(hub: Hub, folder: RecentFolder): void {
  const tab = hub.projects.findIndex((p) => samePath(p.cwd, folder.cwd));
  if (tab >= 0) return hub.switchTo(tab);
  hub.openProject({ cwd: folder.cwd }).catch((err: unknown) => hub.toast(err instanceof Error ? err.message : String(err), "error"));
}

// ---- rows and blocks ----------------------------------------------------------------------------

/** Text at a column offset; the sky shows between pieces. */
interface Piece {
  at: number;
  width: number;
  segs: Seg[];
}

interface HomeRow {
  pieces: Piece[];
  /** When rows run short the highest goes first (on a tie the lower row). */
  cut?: number;
}

/** A title row and its rows. */
export interface HomeBlock {
  title: HomeRow | null;
  rows: HomeRow[];
  /** Rows that stay however short the screen is. */
  min: number;
  /** The row to keep in view when not all fit (the selected folder): the rows scroll instead. */
  pick?: number;
  /** When even the shortest blocks don't fit, the one with the highest goes whole; 0: never. */
  drop?: number;
}

const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + textWidth(s.text), 0);

/** `segs` cut to `w` columns, with an ellipsis where it cuts. */
function clip(segs: Seg[], w: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const sw = textWidth(s.text);
    if (used + sw <= w) {
      out.push(s);
      used += sw;
      continue;
    }
    const t = truncate(s.text, w - used);
    if (t) out.push({ ...s, text: t });
    break;
  }
  return out;
}

const piece = (at: number, width: number, segs: Seg[]): Piece => ({ at, width: Math.max(0, width), segs: clip(segs, Math.max(0, width)) });
const line = (w: number, segs: Seg[], cut?: number): HomeRow => ({ pieces: [piece(0, w, segs)], cut });

/** `left`, with `right` flush to the right edge when there is room for both. */
function split(w: number, left: Seg[], right: Seg[], cut?: number): HomeRow {
  const rw = segsWidth(right);
  if (!rw || segsWidth(left) + 2 + rw > w) return line(w, left, cut);
  return { pieces: [piece(0, w - rw - 2, left), piece(w - rw, rw, right)], cut };
}

/** The first of `texts` (longest first) that fits `w` columns, else the last. */
const fitting = (w: number, ...texts: string[]) => texts.find((t) => textWidth(t) <= w) ?? texts[texts.length - 1];

function titleRow(c: ThemeColors, w: number, title: string, hint = ""): HomeRow {
  return split(w, [{ text: "◆ ", color: c.accent }, { text: title, color: c.text, bold: true }], hint ? [{ text: hint, color: c.faint }] : []);
}

function visibleRows(block: HomeBlock, count: number): HomeRow[] {
  if (count >= block.rows.length) return block.rows;
  if (block.pick !== undefined) {
    const start = Math.max(0, Math.min(block.pick - count + 1, block.rows.length - count));
    return block.rows.slice(start, start + count);
  }
  return block.rows
    .map((row, i) => ({ i, cut: row.cut ?? 0 }))
    .sort((a, b) => a.cut - b.cut || a.i - b.i)
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
    .map((x) => block.rows[x.i]);
}

/** The rows all of `blocks` take when nothing has to go (a blank row between two). */
export function blocksHeight(blocks: HomeBlock[]): number {
  return blocks.reduce((n, b) => n + (b.title ? 1 : 0) + b.rows.length, 0) + Math.max(0, blocks.length - 1);
}

/** Blocks with a `drop` this high only decorate: they go before any block loses more than half. */
const DECORATION = 3;

/**
 * The rows of `blocks` (null: a blank one) in `height` rows. Whatever has to go goes in this
 * order: rows, one at a time from the block with the most to spare, until each block has half of
 * its rows; the decorations; more rows, down to each block's minimum; the blank rows between
 * blocks; whole blocks (the highest `drop` first).
 */
export function fitBlocks(blocks: HomeBlock[], height: number): Array<HomeRow | null> {
  const count = blocks.map((b) => b.rows.length);
  const least = blocks.map((b) => Math.min(b.min, b.rows.length));
  const live = blocks.map(() => true);
  let gaps = true;
  const total = () => {
    let n = 0;
    let shown = 0;
    blocks.forEach((b, i) => {
      if (!live[i]) return;
      shown++;
      n += (b.title ? 1 : 0) + count[i];
    });
    return n + (gaps ? Math.max(0, shown - 1) : 0);
  };
  const cutTo = (floor: (i: number) => number) => {
    while (total() > height) {
      let most = -1;
      blocks.forEach((_, i) => {
        if (live[i] && count[i] > floor(i) && (most < 0 || count[i] - floor(i) >= count[most] - floor(most))) most = i;
      });
      if (most < 0) return;
      count[most]--;
    }
  };
  const dropFrom = (level: number) => {
    while (total() > height) {
      let drop = -1;
      blocks.forEach((b, i) => {
        if (live[i] && (b.drop ?? 0) >= level && (drop < 0 || (b.drop ?? 0) > (blocks[drop].drop ?? 0))) drop = i;
      });
      if (drop < 0) return;
      live[drop] = false;
    }
  };
  cutTo((i) => Math.max(least[i], Math.ceil(blocks[i].rows.length / 2)));
  dropFrom(DECORATION);
  cutTo((i) => least[i]);
  if (total() > height) gaps = false;
  dropFrom(1);
  const out: Array<HomeRow | null> = [];
  blocks.forEach((b, i) => {
    if (!live[i]) return;
    if (out.length && gaps) out.push(null);
    if (b.title) out.push(b.title);
    out.push(...visibleRows(b, count[i]));
  });
  return out;
}

// ---- the columns --------------------------------------------------------------------------------

function startBlocks(hub: Hub, w: number, recent: RecentFolder[], pick: number): HomeBlock[] {
  const c = hub.theme.colors;
  const acc = hub.claudeAccount;
  const free = hub.registry.freeModels({ connectedOnly: true }).length;
  const keyRow = (key: string, long: string, short: string, cut: number, after: Seg[] = []): HomeRow => ({
    pieces: [piece(0, 9, [{ text: key, color: c.accent2 }]), piece(9, w - 9, [{ text: fitting(w - 9 - segsWidth(after), long, short), color: c.text }, ...after])],
    cut,
  });
  const claude = acc?.loggedIn
    ? `✓ Claude: ${acc.email ?? "signed in"}${acc.plan ? ` (${acc.plan})` : ""}`
    : acc?.installed
      ? fitting(w, "○ Claude Code is installed - ctrl+l to sign in", "○ Claude Code: ctrl+l to sign in")
      : fitting(w, "○ Claude Code not found - ctrl+l installs it", "○ Claude Code: ctrl+l installs it");
  const freeText = fitting(w, `✓ ${free} free models ready (OpenCode Zen - no key needed)`, `✓ ${free} free models ready (OpenCode Zen)`, `✓ ${free} free models ready`);

  const nameW = Math.min(Math.max(8, ...recent.map((f) => textWidth(f.name))), Math.floor(w * 0.45));
  const folderRow = (f: RecentFolder, selected: boolean): HomeRow => {
    const pieces = [
      piece(0, 2 + nameW, [
        { text: selected ? "› " : "  ", color: c.accent, bold: true },
        { text: f.name, color: selected ? c.accent : c.text, bold: selected },
      ]),
    ];
    const tab = f.tab >= 0 ? `tab ${f.tab + 1}` : "";
    const at = 2 + nameW + 2;
    const room = w - at - (tab ? textWidth(tab) + 2 : 0);
    if (room >= 6) pieces.push(piece(at, room, [{ text: truncateStart(tildify(path.dirname(f.cwd)), room), color: c.faint }]));
    if (tab) pieces.push(piece(w - textWidth(tab), textWidth(tab), [{ text: tab, color: c.success }]));
    return { pieces };
  };

  return [
    {
      title: line(w, [{ text: "lu-minal", color: c.accent, bold: true }]),
      rows: [line(w, [{ text: fitting(w, "a team of coding agents under the night sky", "coding agents under the night sky"), color: c.muted }])],
      min: 0,
      drop: DECORATION,
    },
    {
      title: titleRow(c, w, "Start"),
      rows: [
        keyRow("ctrl+t", "open a project (folder, GitHub, Forgejo)", "open a project", 2),
        keyRow("ctrl+l", "sign in - Claude, OpenRouter, API keys", "sign in", 3),
        keyRow("ctrl+k", "all commands", "commands", 4, [{ text: "   " }, { text: "?", color: c.accent2 }, { text: "  help", color: c.text }]),
        line(w, [{ text: claude, color: acc?.loggedIn ? c.success : c.faint }], 0),
        line(w, [{ text: freeText, color: free ? c.success : c.faint }], 1),
      ],
      min: 1,
      drop: 2,
    },
    {
      title: titleRow(c, w, "Recent", recent.length ? "↑↓ enter" : ""),
      rows: recent.length ? recent.map((f, i) => folderRow(f, i === pick)) : [line(w, [{ text: "No folders yet - ctrl+t opens one", color: c.faint }])],
      min: 1,
      pick: recent.length ? pick : undefined,
    },
  ];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12" -> "Oct 12". */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : date;
}

function newsBlocks(hub: Hub, w: number, models: NewModel[], now: number): HomeBlock[] {
  const c = hub.theme.colors;
  const news = hub.news;
  // What a source shows before the news came in.
  const pending = hub.offline ? "offline" : "loading…";

  // A table: "● name  provider  date", as narrow as the names allow; the providers go when the
  // column is tight.
  const provW = Math.min(12, Math.max(0, ...models.map((m) => textWidth(m.provider))));
  const withProvider = w - 2 - 2 - provW - 2 - DATE_W >= 14;
  const nameW = Math.min(Math.max(0, ...models.map((m) => textWidth(m.name))), w - 2 - 2 - DATE_W - (withProvider ? provW + 2 : 0));
  const modelRows = models.map((m): HomeRow => {
    const date = shortDate(m.releaseDate);
    const pieces = [
      piece(0, 2 + nameW, [
        { text: m.connected ? "● " : "○ ", color: m.connected ? c.success : c.faint },
        { text: m.name, color: c.text },
      ]),
    ];
    if (withProvider) pieces.push(piece(2 + nameW + 2, provW, [{ text: m.provider, color: c.muted }]));
    const end = 2 + nameW + 2 + (withProvider ? provW + 2 : 0) + DATE_W;
    pieces.push(piece(end - textWidth(date), textWidth(date), [{ text: date, color: c.faint }]));
    return { pieces };
  });

  const acc = hub.claudeAccount;
  const installed = acc?.installed ? acc.version : null;
  const latest = news?.claudeCodeLatest ?? null;
  const version: Seg[] = acc?.installed
    ? [{ text: "installed ", color: c.faint }, { text: installed ?? "–", color: c.text }]
    : [{ text: "not installed", color: c.faint }];
  version.push({ text: " · newest ", color: c.faint }, { text: latest ?? (news ? "–" : pending), color: latest ? c.text : c.faint });
  // The update line stays longest: it is the one to act on.
  const claudeRows: HomeRow[] = [line(w, version, 1)];
  if (installed && latest && compareVersions(latest, installed) > 0) {
    claudeRows.push(line(w, [{ text: `↑ ${latest} is out - claude update`, color: c.success }], 0));
  }
  if (news?.changelog) {
    for (const bullet of news.changelog.bullets) claudeRows.push(line(w, [{ text: "· ", color: c.accent2 }, { text: bullet, color: c.muted }], 2));
  } else if (news) {
    claudeRows.push(line(w, [{ text: "changelog: couldn't load", color: c.faint }], 2));
  }

  const status = news?.status ?? null;
  const calm = status?.indicator === "none";
  const statusRows: HomeRow[] = status
    ? [
        line(w, [{ text: `● ${status.description}`, color: calm ? c.success : c.warning }], 0),
        ...status.incidents.slice(0, 3).map((name) => line(w, [{ text: "▲ ", color: c.warning }, { text: name, color: c.text }], 1)),
      ]
    : [line(w, [{ text: news ? "– couldn't load status.anthropic.com" : pending, color: c.faint }])];

  const own: Seg[] = [{ text: "version ", color: c.faint }, { text: VERSION, color: c.text }];
  if (hub.updateStatus) own.push({ text: " · ", color: c.faint }, { text: hub.updateStatus, color: c.accent2 });
  else if (hub.updateInstalled) own.push({ text: " · ", color: c.faint }, { text: `✓ ${hub.updateInstalled} installed - restart`, color: c.success });
  else if (hub.updateAvailable) own.push({ text: " · ", color: c.faint }, { text: `↑ ${hub.updateAvailable.version} is out - /update`, color: c.success });

  return [
    {
      title: line(w, [{ text: "News", color: c.accent, bold: true }]),
      rows: [line(w, [{ text: news ? `updated ${formatAgo(news.fetchedAt, now)}` : hub.offline ? "offline - nothing is downloaded" : "loading…", color: c.muted }])],
      min: 0,
      drop: DECORATION + 1,
    },
    {
      title: titleRow(c, w, "New models", `last ${NEW_MODEL_DAYS} days`),
      rows: modelRows.length ? modelRows : [line(w, [{ text: `Nothing new in the last ${NEW_MODEL_DAYS} days.`, color: c.faint }])],
      min: 1,
    },
    { title: titleRow(c, w, "Claude Code", news?.changelog ? `new in ${news.changelog.version}` : ""), rows: claudeRows, min: 1 },
    { title: titleRow(c, w, "Anthropic status"), rows: statusRows, min: 1 },
    { title: titleRow(c, w, "lu-minal"), rows: [line(w, own)], min: 1, drop: 1 },
  ];
}

// ---- the screen ---------------------------------------------------------------------------------

function RowLine({ row, width, bg }: { row: HomeRow; width: number; bg: string }) {
  return (
    <Box width={width} height={1}>
      {row.pieces.map((p, i) => (
        <Box key={i} position="absolute" left={p.at} width={Math.max(1, p.width)} height={1}>
          <Segs segs={p.segs} bg={bg} />
        </Box>
      ))}
    </Box>
  );
}

export interface HomeProps {
  hub: Hub;
  /** The area between the tab bar and the footer. */
  area: Rect;
  recent: RecentFolder[];
  /** The selected recent folder. */
  pick: number;
  /** The newest models (newestModels), worked out by the caller. */
  models: NewModel[];
  now: number;
}

export function Home({ hub, area, recent, pick, models, now }: HomeProps) {
  const c = hub.theme.colors;
  const total = Math.min(area.width, MAX_WIDTH);
  const x = area.x + Math.max(0, Math.floor((area.width - total) / 2));
  const two = total >= TWO_COLUMNS;
  const gap = total >= 100 ? 4 : 3;
  const leftW = two ? Math.min(56, Math.max(34, Math.floor((total - gap) * 0.45))) : total;
  const rightW = two ? total - gap - leftW : total;
  const start = startBlocks(hub, leftW, recent, pick);
  const newsList = newsBlocks(hub, rightW, models, now);
  const axoWanted = hub.theme.axo && hub.config.axo;

  // Axo only when everything else fits whole beside it.
  const column = (blocks: HomeBlock[], at: number, w: number, axo: boolean) => {
    const withAxo = axo && blocksHeight(blocks) + AXO_ROWS + 1 <= area.height;
    return { at, w, axo: withAxo, rows: fitBlocks(blocks, area.height - (withAxo ? AXO_ROWS + 1 : 0)) };
  };
  const columns = two
    ? [column(start, x, leftW, axoWanted), column(newsList, x + leftW + gap, rightW, false)]
    : [column([...start, ...newsList], x, total, axoWanted)];
  const height = Math.max(...columns.map((col) => col.rows.length + (col.axo ? AXO_ROWS + 1 : 0)));
  const top = area.y + Math.max(0, Math.floor((area.height - height) / 2));

  const busy = hub.projects.filter((p) => p.agents.some((a) => a.busy)).length;
  const caption = busy ? `${busy} tab${busy === 1 ? "" : "s"} at work…` : hub.ready ? "Ready when you are." : "Waking up…";
  return (
    <>
      {columns.map((col, i) => (
        <Box key={i} position="absolute" left={col.at} top={top} width={col.w} flexDirection="column">
          {col.axo ? (
            <Box width={col.w} justifyContent="center">
              <Box width={AXO_COLUMNS}>
                <Axo mood={busy ? "work" : hub.ready ? "idle" : "sleep"} bg={c.bg} caption={caption} captionColor={busy ? c.accent2 : c.muted} animate={hub.config.sky.enabled} />
              </Box>
            </Box>
          ) : null}
          {col.axo ? <Box height={1} /> : null}
          {col.rows.map((row, j) =>
            row ? (
              <RowLine key={j} row={row} width={col.w} bg={c.bg} />
            ) : (
              // A blank row that leaves the sky visible.
              <Box key={j} height={1} />
            ),
          )}
        </Box>
      ))}
    </>
  );
}
