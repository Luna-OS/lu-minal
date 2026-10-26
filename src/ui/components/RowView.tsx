// Draws one Row (a list of styled segments). Rows are only as wide as their text, so the glass sky
// shows through the rest of the panel; rows with `fill` (diffs) span the whole width.
import { Text } from "ink";
import React from "react";
import type { Row, Seg } from "../log-lines.js";
import { width as textWidth } from "../text.js";

export function SegText({ seg, bg }: { seg: Seg; bg: string }) {
  return (
    <Text
      color={seg.color}
      backgroundColor={seg.bg ?? bg}
      bold={seg.bold}
      italic={seg.italic}
      dimColor={seg.dim}
      inverse={seg.inverse}
    >
      {seg.text}
    </Text>
  );
}

/**
 * Memoized: a log row laid out once keeps its object (log-lines.ts remembers them), so a frame
 * doesn't render the rows that stayed the same again.
 */
export const RowView = React.memo(function RowView({ row, width, bg }: { row: Row; width: number; bg: string }) {
  const used = row.segs.reduce((n, s) => n + textWidth(s.text), 0);
  const pad = row.fill ? Math.max(0, width - used) : 0;
  return (
    <Text wrap="truncate">
      {row.segs.map((seg, i) => (
        <SegText key={i} seg={seg} bg={bg} />
      ))}
      {pad > 0 ? <Text backgroundColor={row.fill}>{" ".repeat(pad)}</Text> : null}
    </Text>
  );
});

/** A row from loose segments (headers, footers, dialogs). */
export function Segs({ segs, bg }: { segs: Seg[]; bg: string }) {
  return (
    <Text wrap="truncate">
      {segs.map((seg, i) => (
        <SegText key={i} seg={seg} bg={bg} />
      ))}
    </Text>
  );
}

export function segsWidth(segs: Seg[]): number {
  return segs.reduce((n, s) => n + textWidth(s.text), 0);
}
