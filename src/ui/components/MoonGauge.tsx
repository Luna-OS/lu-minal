// The moon gauge for a plan limit (the Claude 5-hour session, the week): a moon that fills with
// the window's utilization, a bar, the percentage and the time until the window resets. The bar
// is mint (success), turns gold (warning) at 75 % and red (error) at 90 %, like Moon Code's
// MoonPhase gauges. The compact form is for the tab bar.
//
//   full:     ◑ session ━━━━━━━──────────── 42% · 2h 13m
//   compact:  ◑ session 42% 2h13m
import { Box, Text } from "ink";
import stringWidth from "string-width";
import React from "react";
import type { UsageWindow } from "../../core/types.js";
import type { Theme } from "../../themes/types.js";
import { truncate } from "../text.js";

/** The moon phases from new to full; each one terminal column wide. */
export const MOON_PHASES: readonly string[] = ["○", "◔", "◑", "◕", "●"];
/** Bar glyphs (filled, empty). */
export const GAUGE_BAR = { filled: "━", empty: "─" } as const;
/** Shown instead of numbers when the window is unknown. */
export const GAUGE_UNKNOWN = "–";

/** Thresholds (fractions of the window) where the gauge turns warning / error. */
export const GAUGE_WARNING_AT = 0.75;
export const GAUGE_ERROR_AT = 0.9;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Time until a reset, short: "now" (under a minute, or already past), "45m", "2h 13m", "2h",
 * "3d 4h", "3d". Units are floored: 45 min 50 s reads "45m".
 */
export function formatResetIn(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** The gauge colour for a utilization (0..1): success, warning from 75 %, error from 90 %. */
export function gaugeColor(util: number, theme: Theme): string {
  const u = Number.isFinite(util) ? util : 0;
  if (u >= GAUGE_ERROR_AT) return theme.colors.error;
  if (u >= GAUGE_WARNING_AT) return theme.colors.warning;
  return theme.colors.success;
}

/** The moon phase glyph for a utilization (0..1): ○ under 12.5 %, ● from 87.5 %. */
export function moonPhaseGlyph(util: number): string {
  const u = Number.isFinite(util) ? Math.max(0, Math.min(1, util)) : 0;
  return MOON_PHASES[Math.min(MOON_PHASES.length - 1, Math.floor(u * (MOON_PHASES.length - 1) + 0.5))];
}

/** A styled piece of the gauge. */
export interface GaugeSeg {
  text: string;
  color: string;
  bold?: boolean;
}

export interface GaugeOptions {
  label: string;
  window: UsageWindow | null;
  theme: Theme;
  /** Columns available; the result is never wider. */
  width: number;
  compact?: boolean;
  /** "Now" in ms since the epoch (default Date.now()). */
  now?: number;
}

/**
 * The gauge as styled segments, at most `width` columns (pure: the component draws these, and the
 * header can use them in its own rows). Parts are dropped from the end when room runs out: the
 * reset time, then the label.
 */
export function gaugeSegs({ label, window, theme, width, compact = false, now = Date.now() }: GaugeOptions): GaugeSeg[] {
  const c = theme.colors;
  const room = Math.max(0, Math.floor(width));
  if (!room) return [];

  if (!window) {
    // "○ session ────────── –", or "○ session –" when compact or narrow.
    const segs: GaugeSeg[] = [{ text: MOON_PHASES[0], color: c.faint }];
    const tail = ` ${GAUGE_UNKNOWN}`;
    const name = label ? ` ${label}` : "";
    const bar = room - 1 - stringWidth(name) - 1 - stringWidth(tail);
    if (compact || bar < 4) {
      if (1 + stringWidth(name) + stringWidth(tail) <= room) segs.push({ text: name, color: c.muted });
      segs.push({ text: tail, color: c.muted });
    } else {
      segs.push({ text: name, color: c.muted }, { text: ` ${GAUGE_BAR.empty.repeat(bar)}`, color: c.border }, { text: tail, color: c.muted });
    }
    return clip(segs, room);
  }

  const util = Number.isFinite(window.utilization) ? Math.max(0, window.utilization) : 0;
  const shown = Math.min(1, util);
  const pct = `${Math.round(shown * 100)}%`;
  const color = gaugeColor(util, theme);
  const hot = util >= GAUGE_WARNING_AT;
  const reset = window.resetsAt != null && Number.isFinite(window.resetsAt) ? formatResetIn(window.resetsAt - now) : null;
  const glyph: GaugeSeg = { text: moonPhaseGlyph(shown), color: hot ? color : c.accent };
  const pctSeg: GaugeSeg = { text: pct, color: hot ? color : c.text, bold: util >= GAUGE_ERROR_AT };

  if (compact) {
    const resetText = reset ? reset.replace(" ", "") : null;
    const tryParts = (withLabel: boolean, withReset: boolean): GaugeSeg[] => {
      const segs: GaugeSeg[] = [glyph];
      if (withLabel && label) segs.push({ text: ` ${label}`, color: c.muted });
      segs.push({ text: " ", color: c.muted }, pctSeg);
      if (withReset && resetText) segs.push({ text: ` ${resetText}`, color: c.faint });
      return segs;
    };
    for (const [l, r] of [
      [true, true],
      [false, true],
      [false, false],
    ] as const) {
      const segs = tryParts(l, r);
      if (segsWidth(segs) <= room) return segs;
    }
    return clip(tryParts(false, false), room);
  }

  // Full form: glyph label bar pct · reset, the bar takes what is left (at least 4 cells).
  const build = (withLabel: boolean, withReset: boolean): GaugeSeg[] | null => {
    const head: GaugeSeg[] = [glyph];
    if (withLabel && label) head.push({ text: ` ${label}`, color: c.muted });
    const tail: GaugeSeg[] = [{ text: " ", color: c.muted }, pctSeg];
    if (withReset && reset) tail.push({ text: " · ", color: c.faint }, { text: reset, color: c.muted });
    const bar = room - segsWidth(head) - 1 - segsWidth(tail);
    if (bar < 4) return null;
    const filled = Math.min(bar, Math.round(shown * bar));
    const segs = [...head, { text: " ", color: c.muted }];
    if (filled) segs.push({ text: GAUGE_BAR.filled.repeat(filled), color });
    if (bar - filled) segs.push({ text: GAUGE_BAR.empty.repeat(bar - filled), color: c.border });
    return [...segs, ...tail];
  };
  return build(true, true) ?? build(true, false) ?? build(false, true) ?? build(false, false) ?? gaugeSegs({ label, window, theme, width, compact: true, now });
}

function segsWidth(segs: GaugeSeg[]): number {
  return segs.reduce((n, s) => n + stringWidth(s.text), 0);
}

/** Cuts segments to `room` columns. */
function clip(segs: GaugeSeg[], room: number): GaugeSeg[] {
  const out: GaugeSeg[] = [];
  let left = room;
  for (const s of segs) {
    if (left <= 0) break;
    const w = stringWidth(s.text);
    if (w <= left) {
      out.push(s);
      left -= w;
    } else {
      out.push({ ...s, text: truncate(s.text, left, "") });
      left = 0;
    }
  }
  return out;
}

export interface MoonGaugeProps {
  label: string;
  window: UsageWindow | null;
  theme: Theme;
  /** Columns (default 28). The gauge's box is always this wide; the text never wider. */
  width?: number;
  /** Background for the text cells (the panel's glass, or the sky's bg). */
  bg?: string;
  /** The one-line form for the tab bar. */
  compact?: boolean;
  /** "Now" for the reset countdown (default Date.now()); for tests and synchronized clocks. */
  now?: number;
}

/** One row: the moon gauge. Cells it doesn't use stay transparent (the sky shows through). */
export function MoonGauge({ label, window, theme, width = 28, bg, compact = false, now }: MoonGaugeProps) {
  const w = Math.max(1, Math.floor(width));
  const segs = gaugeSegs({ label, window, theme, width: w, compact, now });
  return (
    <Box width={w} height={1} flexShrink={0}>
      <Text wrap="truncate">
        {segs.map((s, i) => (
          <Text key={i} color={s.color} backgroundColor={bg} bold={s.bold}>
            {s.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
