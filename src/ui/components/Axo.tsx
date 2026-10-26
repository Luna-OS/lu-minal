// Axo, the pixel axolotl, in the terminal: 26 columns x 10 rows of half blocks, plus an optional
// caption centred under it. It idles and blinks, types on its moon laptop while the team works,
// cheers when they are done and snores z's while asleep.
import { Box, Text } from "ink";
import stringWidth from "string-width";
import React, { useRef, useState } from "react";
import { truncate } from "../text.js";
import { AXO_COLORS, type AxoMood } from "../axo/frames.js";
import { AXO_COLUMNS, AXO_TICK_MS, axoPose, renderAxoPose } from "../axo/render.js";
import { animationClock, sameRows, useTick } from "../frames.js";

export interface AxoProps {
  mood: AxoMood;
  /** The background Axo sits on (the panel's glass colour, or the sky's bg). */
  bg: string;
  /** A line under Axo, centred and cut to 26 columns. null / undefined: no caption row. */
  caption?: string | null;
  /** Default: Axo's cream. */
  captionColor?: string;
  /** Blink, type, hop and snore (default true). Off: still frames. */
  animate?: boolean;
  /**
   * The animation time (ms) from frames the screen draws anyway (see src/ui/frames.ts). Given, Axo
   * runs no timer of its own and moves with those frames; omitted, it ticks every AXO_TICK_MS.
   */
  clock?: number;
}

/** `text` cut to `width` columns and padded on both sides to exactly `width`. */
export function centerText(text: string, width: number): string {
  const t = truncate(text.replace(/[\r\n\t]+/g, " "), width);
  const free = Math.max(0, width - stringWidth(t));
  const left = Math.floor(free / 2);
  return " ".repeat(left) + t + " ".repeat(free - left);
}

/** Axo (10 rows) and its caption (one more row when given). */
export function Axo({ mood, bg, caption, captionColor, animate = true, clock }: AxoProps) {
  const [ticked, setTicked] = useState(animationClock);
  // Back on its own timer after a clock, Axo goes on from the clock's last time.
  const lastClock = useRef(0);
  if (clock !== undefined) lastClock.current = clock;
  const frame = animate ? Math.floor((clock ?? Math.max(ticked, lastClock.current)) / AXO_TICK_MS) : 0;
  // Ticks count from the moment the mood changed, so "done" always starts with its cheer.
  const since = useRef({ mood, frame });
  if (since.current.mood !== mood || frame < since.current.frame) since.current = { mood, frame };
  const rowsAt = (f: number) => renderAxoPose(axoPose(mood, f - since.current.frame, animate), bg);
  const rows = rowsAt(frame);
  // On its own timer (no clock given) Axo draws a frame only when its pose changes (idle, it
  // blinks every few seconds).
  const shown = useRef(rows);
  shown.current = rows;
  useTick(animate && clock === undefined ? AXO_TICK_MS : null, (at) => {
    if (!sameRows(rowsAt(Math.floor(at / AXO_TICK_MS)), shown.current)) setTicked(at);
  });
  return (
    <Box flexDirection="column" width={AXO_COLUMNS} flexShrink={0}>
      {rows.map((row, i) => (
        <Text key={i} wrap="truncate">
          {row}
        </Text>
      ))}
      {caption != null ? (
        <Text color={captionColor ?? AXO_COLORS.W} backgroundColor={bg} wrap="truncate">
          {centerText(caption, AXO_COLUMNS)}
        </Text>
      ) : null}
    </Box>
  );
}
