// Where everything goes on the screen. Computed by hand (not by flexbox) because the sky needs the
// panel rectangles to draw its glass under them, and the worker grid pages when it doesn't fit.
//
//   row 0      tab bar                       usage
//   row 1      ◆ luna ×7 · project · 23m     ↓ 550.0k · $146.94
//   rows 2..   ╭ lead ──────────────────────────────────────╮
//              ╰────────────────────────────────────────────╯
//              ╭ worker ─────╮  │  ╭ worker ─────╮
//              ╰─────────────╯  │  ╰─────────────╯
//   last row   ● lead + 6/6 running                 +4,872 -919
import type { AgentRole } from "../core/types.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSlot {
  agentId: string;
  rect: Rect;
}

export interface Layout {
  width: number;
  height: number;
  tabBar: Rect;
  header: Rect;
  footer: Rect;
  /** The area between header and footer. */
  content: Rect;
  panels: PanelSlot[];
  /** Workers that didn't fit on this page of the grid. */
  hiddenWorkers: number;
  page: number;
  pages: number;
  /** Axo's corner inside the lead panel, when there is room. */
  axo: Rect | null;
  /** Vertical connector lines in the grid's gutters. */
  connectors: Array<{ x: number; y1: number; y2: number }>;
}

export const MIN_PANEL_HEIGHT = 7;
const GUTTER = 3;
const AXO_COLUMN = 30;

export function gridColumns(width: number, workers: number): number {
  const cols = width >= 168 ? 3 : width >= 92 ? 2 : 1;
  return Math.max(1, Math.min(cols, workers));
}

export function computeLayout(opts: {
  width: number;
  height: number;
  agents: Array<{ id: string; role: AgentRole }>;
  focusedId: string | null;
  zoomed: boolean;
  axo: boolean;
  /**
   * Inner rows the lead's panel would like (for the question card it shows): it grows toward them
   * as long as a row of workers still fits.
   */
  leadRows?: number;
}): Layout {
  const width = Math.max(20, opts.width);
  const height = Math.max(8, opts.height);
  const margin = width >= 60 ? 1 : 0;
  const inner = width - margin * 2;
  const tabBar = { x: 0, y: 0, width, height: 1 };
  const header = { x: margin, y: 1, width: inner, height: 1 };
  const footer = { x: margin, y: height - 1, width: inner, height: 1 };
  const content = { x: margin, y: 2, width: inner, height: Math.max(1, height - 3) };
  const layout: Layout = {
    width,
    height,
    tabBar,
    header,
    footer,
    content,
    panels: [],
    hiddenWorkers: 0,
    page: 0,
    pages: 1,
    axo: null,
    connectors: [],
  };
  if (!opts.agents.length) return layout;

  const focused = opts.agents.find((a) => a.id === opts.focusedId) ?? opts.agents[0];
  if (opts.zoomed) {
    layout.panels.push({ agentId: focused.id, rect: { ...content } });
    return layout;
  }

  const lead = opts.agents.find((a) => a.role === "lead");
  const workers = opts.agents.filter((a) => a !== lead);
  let gridTop = content.y;
  let gridHeight = content.height;

  if (lead) {
    let leadHeight = content.height;
    if (workers.length) {
      const wanted = Math.round(content.height * 0.36);
      leadHeight = Math.max(8, Math.min(16, wanted), (opts.leadRows ?? 0) + 2);
      // Leave room for at least one row of workers.
      leadHeight = Math.min(leadHeight, Math.max(5, content.height - MIN_PANEL_HEIGHT - 1));
    }
    const rect = { x: content.x, y: content.y, width: content.width, height: leadHeight };
    layout.panels.push({ agentId: lead.id, rect });
    if (opts.axo && rect.width >= 96 && rect.height - 2 >= 11) {
      layout.axo = {
        x: rect.x + rect.width - 1 - AXO_COLUMN,
        y: rect.y + 1,
        width: AXO_COLUMN,
        height: Math.min(rect.height - 2, 14),
      };
    }
    gridTop = rect.y + rect.height + 1;
    gridHeight = content.y + content.height - gridTop;
  }

  if (!workers.length || gridHeight < 3) {
    layout.hiddenWorkers = workers.length;
    return layout;
  }

  const cols = gridColumns(content.width, workers.length);
  const rowsNeeded = Math.ceil(workers.length / cols);
  const rowsFit = Math.max(1, Math.floor((gridHeight + 1) / (MIN_PANEL_HEIGHT + 1)));
  const rows = Math.min(rowsNeeded, rowsFit);
  const pageSize = rows * cols;
  const pages = Math.ceil(workers.length / pageSize);
  const focusedWorker = workers.indexOf(focused);
  const page = focusedWorker >= 0 ? Math.floor(focusedWorker / pageSize) : 0;
  const shown = workers.slice(page * pageSize, page * pageSize + pageSize);
  layout.page = page;
  layout.pages = pages;
  layout.hiddenWorkers = workers.length - shown.length;

  const colWidth = Math.floor((content.width - GUTTER * (cols - 1)) / cols);
  const panelHeight = Math.max(3, Math.floor((gridHeight - (rows - 1)) / rows));
  shown.forEach((agent, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = content.x + col * (colWidth + GUTTER);
    const w = col === cols - 1 ? content.x + content.width - x : colWidth;
    layout.panels.push({
      agentId: agent.id,
      rect: { x, y: gridTop + row * (panelHeight + 1), width: w, height: panelHeight },
    });
  });
  const usedRows = Math.ceil(shown.length / cols);
  const bottom = gridTop + usedRows * (panelHeight + 1) - 2;
  for (let col = 1; col < cols; col++) {
    const x = content.x + col * (colWidth + GUTTER) - Math.ceil(GUTTER / 2);
    layout.connectors.push({ x, y1: gridTop - 1, y2: bottom });
  }
  return layout;
}
