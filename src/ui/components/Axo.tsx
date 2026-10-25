// Axo, the pixel axolotl, in the terminal: 26 columns x 10 rows of half blocks, plus an optional
// caption centred under it. It idles and blinks, types on its moon laptop while the team works,
// cheers when they are done and snores z's while asleep.
import { Box, Text, useAnimation } from "ink";
import stringWidth from "string-width";
import React, { useRef } from "react";
import { truncate } from "../text.js";
import { AXO_COLORS, type AxoMood } from "../axo/frames.js";
import { AXO_COLUMNS, AXO_TICK_MS, axoPose, renderAxoPose } from "../axo/render.js";

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
}

/** `text` cut to `width` columns and padded on both sides to exactly `width`. */
export function centerText(text: string, width: number): string {
  const t = truncate(text.replace(/[\r\n\t]+/g, " "), width);
  const free = Math.max(0, width - stringWidth(t));
  const left = Math.floor(free / 2);
  return " ".repeat(left) + t + " ".repeat(free - left);
}

/** Axo (10 rows) and its caption (one more row when given). */
export function Axo({ mood, bg, caption, captionColor, animate = true }: AxoProps) {
  const { frame } = useAnimation({ interval: AXO_TICK_MS, isActive: animate });
  // Ticks count from the moment the mood changed, so "done" always starts with its cheer.
  const since = useRef({ mood, frame });
  if (since.current.mood !== mood || frame < since.current.frame) since.current = { mood, frame };
  const tick = frame - since.current.frame;
  const rows = renderAxoPose(axoPose(mood, tick, animate), bg);
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
