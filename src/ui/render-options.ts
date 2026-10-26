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
