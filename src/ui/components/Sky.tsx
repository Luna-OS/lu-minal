// The animated night sky: the first child of the screen's root Box, absolutely positioned at 0,0
// and filling the window. The panels are drawn on top of it and don't paint their own background;
// the sky draws their glass (theme.colors.surface, surfaceFocus for the focused one) under them.
import { Box, Text, useAnimation } from "ink";
import React, { useMemo } from "react";
import type { Theme } from "../../themes/types.js";
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
export function Sky({ width, height, theme: themeProp, glass, fps = 8, animate = true, enabled = true, moonAt }: SkyProps) {
  // One object per (theme, enabled), so the sky's per-theme palette cache keeps working.
  const theme = useMemo(
    () => (enabled || !themeProp.sky.enabled ? themeProp : { ...themeProp, sky: { ...themeProp.sky, enabled: false } }),
    [themeProp, enabled],
  );
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const rate = Number.isFinite(fps) && fps > 0 ? Math.min(30, Math.max(1, fps)) : 8;
  const active = animate && theme.sky.enabled && w > 0 && h > 0;
  const { time } = useAnimation({ interval: Math.round(1000 / rate), isActive: active });
  const density = theme.sky.density;
  const stars = useMemo(() => createStarField(w, h, density, DEFAULT_STAR_SEED), [w, h, density]);
  const key = glassKey(glass);
  const moonKey = moonAt === undefined ? "auto" : moonAt === null ? "none" : `${moonAt.x},${moonAt.y}`;
  const rows = useMemo(() => {
    try {
      return skyFrame({ width: w, height: h, timeMs: active ? time : 0, theme, stars, glass, reduceMotion: !animate, moonAt });
    } catch {
      // A broken custom theme must not take the app down: an empty sky instead.
      return Array.from({ length: h }, () => " ".repeat(w));
    }
    // `glass` and `moonAt` are compared by value through their keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, time, active, theme, stars, key, moonKey, animate]);

  if (!w || !h) return null;
  return (
    <Box position="absolute" top={0} left={0} width={w} height={h} flexDirection="column" overflow="hidden">
      {rows.map((row, i) => (
        <Text key={i} wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  );
}
