// The animated night sky: the first child of the screen's root Box, absolutely positioned at 0,0
// and filling the window. The panels are drawn on top of it and don't paint their own background;
// the sky draws their glass (theme.colors.surface, surfaceFocus for the focused one) under them.
import { Box, Text } from "ink";
import React, { useMemo, useRef, useState } from "react";
import type { Theme } from "../../themes/types.js";
import { animationClock, sameRows, useTick } from "../frames.js";
import { createStarField, DEFAULT_STAR_SEED, skyFrame, type Rect } from "../sky/model.js";

export interface SkyProps {
  width: number;
  height: number;
  theme: Theme;
  /** The panel rectangles to draw glass under. */
  glass: Rect[];
  /** Frames per second while animating (default 8, clamped to 1..30). */
  fps?: number;
  /** Twinkle and shoot (default true). Off: a still sky (and no timer at all). */
  animate?: boolean;
  /**
   * The animation time (ms) from frames the screen draws anyway (see src/ui/frames.ts). Given, the
   * sky runs no timer of its own and moves with those frames; omitted, it ticks at `fps`.
   */
  clock?: number;
  /**
   * Draw stars, moon and shooting stars at all (default true). Off: the plain background with the
   * glass rects, as for a theme whose sky is disabled (e.g. for --no-sky).
   */
  enabled?: boolean;
  /** Moon position override (see skyFrame's `moonAt`); omitted = automatic, null = no moon. */
  moonAt?: { x: number; y: number } | null;
}

function glassKey(glass: Rect[]): string {
  let key = "";
  for (const r of glass) key += `${r.x},${r.y},${r.width},${r.height},${r.focused ? 1 : 0};`;
  return key;
}

/** The sky behind everything: one pre-rendered row of text per terminal row. */
export function Sky({ width, height, theme: themeProp, glass, fps = 8, animate = true, enabled = true, moonAt, clock }: SkyProps) {
  // One object per (theme, enabled), so the sky's per-theme palette cache keeps working.
  const theme = useMemo(
    () => (enabled || !themeProp.sky.enabled ? themeProp : { ...themeProp, sky: { ...themeProp.sky, enabled: false } }),
    [themeProp, enabled],
  );
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const rate = Number.isFinite(fps) && fps > 0 ? Math.min(30, Math.max(1, fps)) : 8;
  const active = animate && theme.sky.enabled && w > 0 && h > 0;
  const [ticked, setTicked] = useState(animationClock);
  // Back on its own timer after a clock, the sky goes on from the clock's last time.
  const lastClock = useRef(0);
  if (clock !== undefined) lastClock.current = clock;
  // A still sky keeps its frame (no new layout for every render of the screen).
  const time = active ? (clock ?? Math.max(ticked, lastClock.current)) : 0;
  const density = theme.sky.density;
  const stars = useMemo(() => createStarField(w, h, density, DEFAULT_STAR_SEED), [w, h, density]);
  const key = glassKey(glass);
  const moonKey = moonAt === undefined ? "auto" : moonAt === null ? "none" : `${moonAt.x},${moonAt.y}`;
  const frameAt = (timeMs: number): string[] => {
    try {
      return skyFrame({ width: w, height: h, timeMs, theme, stars, glass, reduceMotion: !animate, moonAt });
    } catch {
      // A broken custom theme must not take the app down: an empty sky instead.
      return Array.from({ length: h }, () => " ".repeat(w));
    }
  };
  // `glass` and `moonAt` are compared by value through their keys.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => frameAt(time), [w, h, time, active, theme, stars, key, moonKey, animate]);
  // On its own timer (no clock given) the sky draws a frame only when one of its cells changes:
  // about a third of the ticks change none (no star reached another step of its twinkle).
  const shown = useRef(rows);
  shown.current = rows;
  useTick(active && clock === undefined ? Math.round(1000 / rate) : null, (at) => {
    if (!sameRows(frameAt(at), shown.current)) setTicked(at);
  });

  if (!w || !h) return null;
  // No overflow="hidden": the rows are exactly w x h already, and a clip makes Ink cut every row
  // again in every frame.
  return (
    <Box position="absolute" top={0} left={0} width={w} height={h} flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i} wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  );
}
