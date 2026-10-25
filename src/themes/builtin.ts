// The built-in themes. "moon" is the default and keeps the Luna-OS Moon palette value for value
// (Moon Code's src/theme/tokens.css): night-950 sky, night-900 glass, cream text, lavender accent,
// mint for Claude. Shades the CSS gets from color-mix over the night are computed here with mixHex,
// so they are the real opaque colours a terminal can draw.
import { mixHex } from "./color.js";
import type { Theme, ThemeColors, ThemeSky } from "./types.js";

/** The theme lu-minal starts with. */
export const DEFAULT_THEME_NAME = "moon";

/** Star glyphs from small to big; every one is a single terminal column (no emoji presentation). */
export const STAR_GLYPHS: readonly string[] = ["·", "⋆", "✧", "✦"];

// ---- the Moon family palette (tokens.css @theme) ---------------------------------------------

export const MOON_PALETTE = {
  night950: "#0b0920",
  night900: "#141030",
  night800: "#1d1742",
  violet700: "#3b2e6b",
  lavender400: "#b9aefb",
  lavender300: "#d6cffd",
  moon100: "#f4f1ff",
  mint400: "#7fe3c6",
  sky300: "#9ad7f5",
  peach300: "#f7b89a",
  cream100: "#fbf7f0",
  warning400: "#f3c766",
  error500: "#e5626b",
  /** --mc-danger: the readable red for text at night. */
  danger: "#f28b92",
  popover: "#181338",
  /** Axo's gills. */
  pink: "#f6a8c8",
  /** The laptop base / deep lavender of Axo. */
  lavender600: "#8f82e0",
  outline: "#5b4f9e",
} as const;

const P = MOON_PALETTE;

function sky(partial: Partial<ThemeSky> & Pick<ThemeSky, "stars" | "moonColor" | "shootingStarColor">): ThemeSky {
  return {
    enabled: true,
    glyphs: [...STAR_GLYPHS],
    density: 1.6,
    glass: 0.25,
    moon: true,
    shootingStars: true,
    ...partial,
  };
}

function theme(t: Omit<Theme, "author"> & { author?: string }): Theme {
  return { author: "lu-minal", ...t };
}

// ---- moon (night, the default) ---------------------------------------------------------------

const moonColors: ThemeColors = {
  bg: P.night950,
  surface: P.night900,
  surfaceFocus: P.night800,
  popover: P.popover,
  // --mc-border / --mc-border-strong: lavender-400 at 18 % / 36 % over the glass.
  border: mixHex(P.night900, P.lavender400, 0.18),
  borderFocus: mixHex(P.night900, P.lavender400, 0.36),
  text: P.cream100,
  // --mc-text-muted / --mc-text-faint: cream at 62 % / 40 % over the night.
  muted: mixHex(P.night900, P.cream100, 0.62),
  faint: mixHex(P.night900, P.cream100, 0.4),
  accent: P.lavender300,
  accent2: P.sky300,
  claude: P.mint400,
  success: P.mint400,
  warning: P.warning400,
  error: P.error500,
  diffAddBg: "#1f4d43",
  diffAddFg: "#d8fff2",
  diffDelBg: "#4d1f30",
  diffDelFg: "#ffd6dc",
  selection: P.violet700,
  selectionText: P.moon100,
  tabActiveBg: P.violet700,
  tabActiveFg: P.moon100,
  agents: [P.lavender400, P.sky300, P.mint400, P.peach300, P.warning400, P.pink, P.lavender300, "#8ee6e0", P.danger],
};

const moon = theme({
  name: "moon",
  label: "Moon",
  dark: true,
  colors: moonColors,
  sky: sky({
    // From violet-700 to moon-100: a star twinkles along this list.
    stars: [P.violet700, P.outline, P.lavender600, P.lavender400, P.lavender300, P.moon100],
    moonColor: P.moon100,
    shootingStarColor: P.lavender300,
  }),
  axo: true,
});

// ---- moon-day (tokens.css :root[data-theme="light"]) -----------------------------------------

const DAY = {
  bg: "#f5f2fb",
  text: "#1c1733",
  accent: "#5b4bc4",
  focus: "#6c5ce0",
  lavender: "#7d6de0",
  warning: "#a86b00",
  danger: "#c2323d",
  success: "#1d7d65",
  sky: "#2f86b5",
  /** The sky blue darkened until it reads as text on white. */
  skyText: "#26739e",
  peach: "#c7663b",
  cyan: "#18808a",
} as const;

const daySurface = mixHex(DAY.bg, "#ffffff", 0.82);

const moonDay = theme({
  name: "moon-day",
  label: "Moon Day",
  dark: false,
  colors: {
    bg: DAY.bg,
    surface: daySurface,
    surfaceFocus: "#ffffff",
    popover: "#ffffff",
    border: mixHex(daySurface, P.violet700, 0.16),
    borderFocus: mixHex(daySurface, P.violet700, 0.32),
    text: DAY.text,
    muted: mixHex(daySurface, DAY.text, 0.64),
    faint: mixHex(daySurface, DAY.text, 0.5),
    accent: DAY.accent,
    accent2: DAY.skyText,
    claude: DAY.success,
    success: DAY.success,
    warning: DAY.warning,
    error: DAY.danger,
    diffAddBg: "#d3f1e6",
    diffAddFg: "#0d4a3a",
    diffDelBg: "#fadbe0",
    diffDelFg: "#7a1c28",
    selection: mixHex("#ffffff", DAY.lavender, 0.18),
    selectionText: "#2b2160",
    tabActiveBg: mixHex(DAY.bg, DAY.lavender, 0.2),
    tabActiveFg: "#2b2160",
    agents: [DAY.lavender, DAY.sky, DAY.success, DAY.peach, DAY.warning, "#b84a86", DAY.accent, DAY.cyan],
  },
  sky: sky({
    enabled: false,
    stars: [mixHex(DAY.bg, DAY.lavender, 0.15), mixHex(DAY.bg, DAY.lavender, 0.35), mixHex(DAY.bg, DAY.lavender, 0.55)],
    density: 0.8,
    glass: 0.15,
    moonColor: mixHex(DAY.bg, P.lavender400, 0.55),
    shootingStars: false,
    shootingStarColor: DAY.lavender,
  }),
  axo: true,
});

// ---- astra (very dark navy, cyan accent, bright diff rows) -----------------------------------

const ASTRA = {
  bg: "#0a1220",
  surface: "#0e1726",
  focus: "#122033",
  text: "#dbe7f5",
  cyan: "#56d4dd",
  sky: "#7fdbff",
} as const;

const astra = theme({
  name: "astra",
  label: "Astra",
  dark: true,
  colors: {
    bg: ASTRA.bg,
    surface: ASTRA.surface,
    surfaceFocus: ASTRA.focus,
    popover: "#111d30",
    border: mixHex(ASTRA.surface, ASTRA.cyan, 0.2),
    borderFocus: mixHex(ASTRA.surface, ASTRA.cyan, 0.5),
    text: ASTRA.text,
    muted: mixHex(ASTRA.surface, ASTRA.text, 0.64),
    faint: mixHex(ASTRA.surface, ASTRA.text, 0.42),
    accent: ASTRA.cyan,
    accent2: ASTRA.sky,
    claude: "#6ee7b7",
    success: "#4ade80",
    warning: "#fbbf24",
    error: "#f87171",
    diffAddBg: "#1e6b2e",
    diffAddFg: "#eaffea",
    diffDelBg: "#7a1f1f",
    diffDelFg: "#ffe5e5",
    selection: "#1b3350",
    selectionText: "#eaf6ff",
    tabActiveBg: "#15334a",
    tabActiveFg: "#e6fbff",
    agents: [ASTRA.cyan, ASTRA.sky, "#4ade80", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c", "#60a5fa"],
  },
  sky: sky({
    stars: ["#1b2c45", "#2c4a70", "#4f7cab", "#7fa9d6", "#b4d4f2", "#e6f3ff"],
    density: 1.4,
    glass: 0.2,
    moonColor: "#e6f3ff",
    shootingStarColor: ASTRA.sky,
  }),
  axo: true,
});

// ---- tokyo-night ----------------------------------------------------------------------------

const TOKYO = {
  bg: "#16161e",
  surface: "#1a1b26",
  focus: "#1f2335",
  text: "#c0caf5",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
  green: "#9ece6a",
  teal: "#73daca",
  yellow: "#e0af68",
  orange: "#ff9e64",
  red: "#f7768e",
} as const;

const tokyoNight = theme({
  name: "tokyo-night",
  label: "Tokyo Night",
  dark: true,
  colors: {
    bg: TOKYO.bg,
    surface: TOKYO.surface,
    surfaceFocus: TOKYO.focus,
    popover: "#24283b",
    border: "#292e42",
    borderFocus: "#414868",
    text: TOKYO.text,
    muted: "#a9b1d6",
    faint: "#737aa2",
    accent: TOKYO.blue,
    accent2: TOKYO.cyan,
    claude: TOKYO.teal,
    success: TOKYO.green,
    warning: TOKYO.yellow,
    error: TOKYO.red,
    diffAddBg: "#203a2e",
    diffAddFg: "#c8f0b0",
    diffDelBg: "#3f2130",
    diffDelFg: "#ffc8d2",
    selection: "#283457",
    selectionText: TOKYO.text,
    tabActiveBg: "#2f3a5e",
    tabActiveFg: "#e1e6ff",
    agents: [TOKYO.blue, TOKYO.magenta, TOKYO.cyan, TOKYO.green, TOKYO.orange, TOKYO.yellow, TOKYO.teal, TOKYO.red],
  },
  sky: sky({
    stars: ["#292e42", "#3b4261", "#565f89", "#7aa2f7", "#a9b1d6", "#c0caf5"],
    density: 1.4,
    glass: 0.2,
    moonColor: "#c0caf5",
    shootingStarColor: TOKYO.magenta,
  }),
  axo: true,
});

// ---- catppuccin-mocha ------------------------------------------------------------------------

const MOCHA = {
  crust: "#11111b",
  mantle: "#181825",
  base: "#1e1e2e",
  surface0: "#313244",
  surface1: "#45475a",
  overlay1: "#7f849c",
  subtext0: "#a6adc8",
  text: "#cdd6f4",
  lavender: "#b4befe",
  blue: "#89b4fa",
  sky: "#89dceb",
  teal: "#94e2d5",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  red: "#f38ba8",
  mauve: "#cba6f7",
  pink: "#f5c2e7",
  rosewater: "#f5e0dc",
} as const;

const catppuccinMocha = theme({
  name: "catppuccin-mocha",
  label: "Catppuccin Mocha",
  dark: true,
  colors: {
    bg: MOCHA.crust,
    surface: MOCHA.base,
    surfaceFocus: mixHex(MOCHA.base, MOCHA.surface0, 0.45),
    popover: MOCHA.surface0,
    border: MOCHA.surface1,
    borderFocus: MOCHA.overlay1,
    text: MOCHA.text,
    muted: MOCHA.subtext0,
    faint: MOCHA.overlay1,
    accent: MOCHA.mauve,
    accent2: MOCHA.sky,
    claude: MOCHA.teal,
    success: MOCHA.green,
    warning: MOCHA.yellow,
    error: MOCHA.red,
    diffAddBg: mixHex(MOCHA.base, MOCHA.green, 0.22),
    diffAddFg: "#e3f8e0",
    diffDelBg: mixHex(MOCHA.base, MOCHA.red, 0.22),
    diffDelFg: "#ffe0ea",
    selection: MOCHA.surface1,
    selectionText: MOCHA.text,
    tabActiveBg: MOCHA.surface1,
    tabActiveFg: MOCHA.lavender,
    agents: [MOCHA.mauve, MOCHA.blue, MOCHA.teal, MOCHA.peach, MOCHA.yellow, MOCHA.pink, MOCHA.lavender, MOCHA.green],
  },
  sky: sky({
    stars: [MOCHA.surface0, MOCHA.surface1, "#6c7086", MOCHA.lavender, MOCHA.text, MOCHA.rosewater],
    density: 1.5,
    glass: 0.22,
    moonColor: MOCHA.rosewater,
    shootingStarColor: MOCHA.lavender,
  }),
  axo: true,
});

// ---- dracula --------------------------------------------------------------------------------

const DRACULA = {
  darker: "#1e1f29",
  bg: "#282a36",
  line: "#44475a",
  fg: "#f8f8f2",
  comment: "#6272a4",
  cyan: "#8be9fd",
  green: "#50fa7b",
  orange: "#ffb86c",
  pink: "#ff79c6",
  purple: "#bd93f9",
  red: "#ff5555",
  yellow: "#f1fa8c",
} as const;

const dracula = theme({
  name: "dracula",
  label: "Dracula",
  dark: true,
  colors: {
    bg: DRACULA.darker,
    surface: DRACULA.bg,
    surfaceFocus: "#2f3241",
    popover: "#343746",
    border: DRACULA.line,
    borderFocus: DRACULA.comment,
    text: DRACULA.fg,
    muted: mixHex(DRACULA.bg, DRACULA.fg, 0.72),
    faint: mixHex(DRACULA.bg, DRACULA.fg, 0.46),
    accent: DRACULA.purple,
    accent2: DRACULA.cyan,
    claude: DRACULA.green,
    success: DRACULA.green,
    warning: DRACULA.yellow,
    error: DRACULA.red,
    diffAddBg: mixHex(DRACULA.bg, DRACULA.green, 0.2),
    diffAddFg: "#e6ffec",
    diffDelBg: mixHex(DRACULA.bg, DRACULA.red, 0.22),
    diffDelFg: "#ffe1e1",
    selection: DRACULA.line,
    selectionText: DRACULA.fg,
    tabActiveBg: DRACULA.line,
    tabActiveFg: DRACULA.fg,
    agents: [DRACULA.purple, DRACULA.cyan, DRACULA.green, DRACULA.pink, DRACULA.orange, DRACULA.yellow, DRACULA.red],
  },
  sky: sky({
    stars: [DRACULA.line, DRACULA.comment, "#9580ff", DRACULA.purple, "#e2d4ff", DRACULA.fg],
    density: 1.5,
    glass: 0.22,
    moonColor: DRACULA.fg,
    shootingStarColor: DRACULA.pink,
  }),
  axo: true,
});

// ---- nord -----------------------------------------------------------------------------------

const NORD = {
  night: "#242933",
  nord0: "#2e3440",
  nord1: "#3b4252",
  nord2: "#434c5e",
  nord3: "#4c566a",
  comment: "#7b88a1",
  snow0: "#d8dee9",
  snow2: "#eceff4",
  frost0: "#8fbcbb",
  frost1: "#88c0d0",
  frost2: "#81a1c1",
  /** frost2 lifted until it reads on the popover. */
  frost2Text: "#94b4d4",
  frost3: "#5e81ac",
  red: "#d57780",
  orange: "#d08770",
  yellow: "#ebcb8b",
  green: "#a3be8c",
  purple: "#b48ead",
} as const;

const nord = theme({
  name: "nord",
  label: "Nord",
  dark: true,
  colors: {
    bg: NORD.night,
    surface: NORD.nord0,
    surfaceFocus: mixHex(NORD.nord0, NORD.nord1, 0.55),
    popover: NORD.nord1,
    border: NORD.nord2,
    borderFocus: "#616e88",
    text: NORD.snow2,
    muted: NORD.snow0,
    faint: NORD.comment,
    accent: NORD.frost1,
    accent2: NORD.frost2Text,
    claude: NORD.frost0,
    success: NORD.green,
    warning: NORD.yellow,
    error: NORD.red,
    diffAddBg: mixHex(NORD.nord0, NORD.green, 0.25),
    diffAddFg: NORD.snow2,
    diffDelBg: mixHex(NORD.nord0, "#bf616a", 0.3),
    diffDelFg: "#fbe6e8",
    selection: NORD.nord2,
    selectionText: NORD.snow2,
    tabActiveBg: NORD.nord3,
    tabActiveFg: NORD.snow2,
    agents: [NORD.frost1, NORD.green, NORD.purple, NORD.yellow, NORD.orange, NORD.frost0, NORD.frost2, NORD.red],
  },
  sky: sky({
    stars: [NORD.nord1, NORD.nord3, "#616e88", NORD.frost2, NORD.snow0, NORD.snow2],
    density: 1.4,
    glass: 0.2,
    moonColor: NORD.snow2,
    shootingStarColor: NORD.frost1,
  }),
  axo: true,
});

// ---- gruvbox-dark ---------------------------------------------------------------------------

const GRUV = {
  bg0h: "#1d2021",
  bg0: "#282828",
  bg0s: "#32302f",
  bg1: "#3c3836",
  bg2: "#504945",
  bg4: "#7c6f64",
  fg: "#ebdbb2",
  fg0: "#fbf1c7",
  fg3: "#bdae93",
  fg4: "#a89984",
  gray: "#928374",
  red: "#fb4934",
  green: "#b8bb26",
  yellow: "#fabd2f",
  blue: "#83a598",
  purple: "#d3869b",
  aqua: "#8ec07c",
  orange: "#fe8019",
} as const;

const gruvboxDark = theme({
  name: "gruvbox-dark",
  label: "Gruvbox Dark",
  dark: true,
  colors: {
    bg: GRUV.bg0h,
    surface: GRUV.bg0,
    surfaceFocus: GRUV.bg0s,
    popover: mixHex(GRUV.bg0s, GRUV.bg1, 0.5),
    border: GRUV.bg2,
    borderFocus: GRUV.bg4,
    text: GRUV.fg,
    muted: GRUV.fg3,
    faint: GRUV.gray,
    accent: GRUV.yellow,
    accent2: GRUV.blue,
    claude: GRUV.aqua,
    success: GRUV.green,
    warning: GRUV.orange,
    error: GRUV.red,
    diffAddBg: mixHex(GRUV.bg0, GRUV.green, 0.22),
    diffAddFg: "#f4f7cf",
    diffDelBg: mixHex(GRUV.bg0, GRUV.red, 0.22),
    diffDelFg: "#ffdcd4",
    selection: GRUV.bg2,
    selectionText: GRUV.fg0,
    tabActiveBg: GRUV.bg2,
    tabActiveFg: GRUV.fg0,
    agents: [GRUV.yellow, GRUV.blue, GRUV.aqua, GRUV.purple, GRUV.orange, GRUV.green, GRUV.red, GRUV.fg4],
  },
  sky: sky({
    stars: [GRUV.bg1, GRUV.bg2, GRUV.bg4, GRUV.fg4, "#d5c4a1", GRUV.fg0],
    density: 1.4,
    glass: 0.2,
    moonColor: GRUV.fg0,
    shootingStarColor: GRUV.yellow,
  }),
  axo: true,
});

// ---- rose-pine ------------------------------------------------------------------------------

const ROSE = {
  base: "#191724",
  surface: "#1f1d2e",
  overlay: "#26233a",
  muted: "#6e6a86",
  subtle: "#908caa",
  text: "#e0def4",
  love: "#eb6f92",
  gold: "#f6c177",
  rose: "#ebbcba",
  pine: "#31748f",
  foam: "#9ccfd8",
  iris: "#c4a7e7",
  hlMed: "#403d52",
  hlHigh: "#524f67",
} as const;

const rosePine = theme({
  name: "rose-pine",
  label: "Rosé Pine",
  dark: true,
  colors: {
    bg: ROSE.base,
    surface: ROSE.surface,
    surfaceFocus: "#232136",
    popover: ROSE.overlay,
    border: ROSE.hlMed,
    borderFocus: ROSE.hlHigh,
    text: ROSE.text,
    muted: ROSE.subtle,
    faint: ROSE.muted,
    accent: ROSE.iris,
    accent2: ROSE.rose,
    claude: ROSE.foam,
    success: ROSE.foam,
    warning: ROSE.gold,
    error: ROSE.love,
    diffAddBg: mixHex(ROSE.surface, ROSE.pine, 0.5),
    diffAddFg: "#e6f7fa",
    diffDelBg: mixHex(ROSE.surface, ROSE.love, 0.25),
    diffDelFg: "#ffe0e8",
    selection: ROSE.hlMed,
    selectionText: ROSE.text,
    tabActiveBg: ROSE.hlMed,
    tabActiveFg: ROSE.text,
    agents: [ROSE.iris, ROSE.foam, ROSE.rose, ROSE.gold, ROSE.love, "#3e8fb0", ROSE.subtle],
  },
  sky: sky({
    stars: [ROSE.overlay, ROSE.hlMed, ROSE.muted, ROSE.subtle, ROSE.iris, ROSE.text],
    density: 1.5,
    glass: 0.22,
    moonColor: ROSE.rose,
    shootingStarColor: ROSE.iris,
  }),
  axo: true,
});

// ---- mono (greyscale) -----------------------------------------------------------------------

const mono = theme({
  name: "mono",
  label: "Mono",
  dark: true,
  colors: {
    bg: "#0c0c0c",
    surface: "#151515",
    surfaceFocus: "#1e1e1e",
    popover: "#232323",
    border: "#3a3a3a",
    borderFocus: "#6a6a6a",
    text: "#e6e6e6",
    muted: "#a8a8a8",
    faint: "#727272",
    accent: "#ffffff",
    accent2: "#c8c8c8",
    claude: "#d8d8d8",
    // Severity reads as brightness: success < warning < error.
    success: "#b4b4b4",
    warning: "#dcdcdc",
    error: "#ffffff",
    diffAddBg: "#383838",
    diffAddFg: "#ffffff",
    diffDelBg: "#1c1c1c",
    diffDelFg: "#b0b0b0",
    selection: "#3a3a3a",
    selectionText: "#ffffff",
    tabActiveBg: "#e6e6e6",
    tabActiveFg: "#0c0c0c",
    agents: ["#ffffff", "#d4d4d4", "#b4b4b4", "#e8e8e8", "#c4c4c4", "#a4a4a4"],
  },
  sky: sky({
    stars: ["#262626", "#3d3d3d", "#5c5c5c", "#8a8a8a", "#c0c0c0", "#f0f0f0"],
    density: 1.4,
    glass: 0.2,
    moonColor: "#e6e6e6",
    shootingStarColor: "#ffffff",
  }),
  axo: true,
});

/** Every built-in theme, the default first. Treat them as read-only. */
export const BUILTIN_THEMES: Theme[] = [
  moon,
  moonDay,
  astra,
  tokyoNight,
  catppuccinMocha,
  dracula,
  nord,
  gruvboxDark,
  rosePine,
  mono,
];

/** The built-in theme by name, or undefined. */
export function builtinTheme(name: string): Theme | undefined {
  return BUILTIN_THEMES.find((t) => t.name === name);
}

/** The default theme ("moon"). */
export function defaultTheme(): Theme {
  return BUILTIN_THEMES[0];
}

/** True when `name` is taken by a built-in theme. */
export function isBuiltinName(name: string): boolean {
  return BUILTIN_THEMES.some((t) => t.name === name);
}
