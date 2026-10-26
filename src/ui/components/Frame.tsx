// A rounded panel frame with a title in its top border, like "╭ ◆ vega ───── room ╮". The inside
// is left unpainted, so the sky's glass rectangle under the frame shows through.
import { Box, Text } from "ink";
import React from "react";
import type { Seg } from "../log-lines.js";
import type { Rect } from "../layout.js";
import { truncate, width as textWidth } from "../text.js";
import { SegText, segsWidth } from "./RowView.js";

export interface FrameProps {
  rect: Rect;
  title: Seg[];
  right?: Seg[];
  borderColor: string;
  /** The background the frame's characters sit on (the glass colour). */
  bg: string;
  /** Horizontal padding inside the border. */
  padding?: number;
  children?: React.ReactNode;
}

/** Shortens title segments to `max` columns. */
function fitSegs(segs: Seg[], max: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const w = textWidth(s.text);
    if (used + w <= max) {
      out.push(s);
      used += w;
      continue;
    }
    const room = max - used;
    if (room > 1) out.push({ ...s, text: truncate(s.text, room) });
    break;
  }
  return out;
}

export function Frame({ rect, title, right = [], borderColor, bg, padding = 1, children }: FrameProps) {
  const w = rect.width;
  const h = rect.height;
  if (w < 4 || h < 2) return null;
  const border = { text: "", color: borderColor };
  const room = w - 4;
  let rightSegs = right.length ? fitSegs(right, Math.max(0, Math.floor(room / 2) - 2)) : [];
  const titleSegs = fitSegs(title, Math.max(1, room - (rightSegs.length ? segsWidth(rightSegs) + 2 : 0)));
  if (!titleSegs.length) rightSegs = [];
  const used = 2 + segsWidth(titleSegs) + (rightSegs.length ? segsWidth(rightSegs) + 2 : 0);
  const fill = Math.max(0, w - used - 2);
  const side = Array.from({ length: Math.max(0, h - 2) }, () => "│").join("\n");
  // The inside clips rows only (overflowY): the rows are cut to the width already (wrap="truncate"),
  // and a sideways clip makes Ink cut every row again in every frame.
  return (
    <Box position="absolute" left={rect.x} top={rect.y} width={w} height={h} flexDirection="column">
      <Text wrap="truncate">
        <SegText seg={{ ...border, text: "╭ " }} bg={bg} />
        {titleSegs.map((s, i) => (
          <SegText key={`t${i}`} seg={s} bg={bg} />
        ))}
        <SegText seg={{ ...border, text: ` ${"─".repeat(fill)}` }} bg={bg} />
        {rightSegs.length ? (
          <>
            <SegText seg={{ text: " ", color: borderColor }} bg={bg} />
            {rightSegs.map((s, i) => (
              <SegText key={`r${i}`} seg={s} bg={bg} />
            ))}
          </>
        ) : null}
        <SegText seg={{ ...border, text: rightSegs.length ? " ╮" : "╮" }} bg={bg} />
      </Text>
      <Box flexDirection="row" width={w} height={h - 2}>
        <Box width={1} height={h - 2}>
          <Text color={borderColor} backgroundColor={bg}>
            {side}
          </Text>
        </Box>
        <Box width={w - 2} height={h - 2} paddingX={padding} flexDirection="column" overflowY="hidden">
          {children}
        </Box>
        <Box width={1} height={h - 2}>
          <Text color={borderColor} backgroundColor={bg}>
            {side}
          </Text>
        </Box>
      </Box>
      <Text color={borderColor} backgroundColor={bg} wrap="truncate">
        {`╰${"─".repeat(w - 2)}╯`}
      </Text>
    </Box>
  );
}
