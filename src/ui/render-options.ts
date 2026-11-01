// How the app is handed to Ink (src/cli.tsx), in one place so the render benchmark
// (test/perf/bench.tsx) measures exactly what users run.
import type { RenderOptions } from "ink";

export const RENDER_OPTIONS = {
  alternateScreen: true,
  incrementalRendering: true,
  exitOnCtrlC: false,
  maxFps: 30,
  kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
} satisfies RenderOptions;

/**
 * Whether the app leaves the terminal's last row free. On Windows Ink clears the whole screen and
 * draws it again on every frame that fills the terminal (its fix for consoles that scroll when the
 * bottom-right cell is written), which made every clock tick and sky twinkle a full repaint. One
 * row less keeps Windows on Ink's incremental path: only the lines that changed are written.
 */
export function spareRowFor(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** The rows the app draws in a terminal of `rows` rows. */
export function frameRows(rows: number, spareRow: boolean): number {
  return spareRow ? Math.max(1, rows - 1) : rows;
}
