// A lu-minal theme: the colours every component reads, the night sky behind the panels and
// whether Axo shows. Colours are "#rrggbb" strings (Ink passes them to chalk as truecolor).

export interface ThemeColors {
  /** The sky / app background behind everything. */
  bg: string;
  /** Panel interiors. */
  surface: string;
  /** The focused panel's interior. */
  surfaceFocus: string;
  /** Dialogs and popovers. */
  popover: string;
  border: string;
  borderFocus: string;
  text: string;
  muted: string;
  faint: string;
  /** Primary accent (titles, the ◆ markers, the focused border). */
  accent: string;
  /** Second accent (status verbs, links). */
  accent2: string;
  /** Claude Code agents' colour (the Moon family uses mint). */
  claude: string;
  success: string;
  warning: string;
  error: string;
  /** Diff rows: background and foreground for added and removed lines. */
  diffAddBg: string;
  diffAddFg: string;
  diffDelBg: string;
  diffDelFg: string;
  /** Selected rows in lists. */
  selection: string;
  selectionText: string;
  /** The active tab in the tab bar. */
  tabActiveBg: string;
  tabActiveFg: string;
  /** Per-agent colours, assigned round-robin to workers. */
  agents: string[];
}

export interface ThemeSky {
  /** Draw the animated sky at all. */
  enabled: boolean;
  /** Star colours from faint to bright; a star twinkles along this list. */
  stars: string[];
  /** The glyphs stars are drawn with, from small to big. */
  glyphs: string[];
  /** Stars per 100 cells (0.5 .. 6 looks good). */
  density: number;
  /**
   * How much of the sky shines through the panels (0 = opaque panels, 1 = as bright as outside).
   * The Moon look uses a faint 0.25: the panels are glass.
   */
  glass: number;
  moon: boolean;
  moonColor: string;
  shootingStars: boolean;
  shootingStarColor: string;
}

export interface Theme {
  /** File-safe id: "moon", "moon-day", "tokyo-night". */
  name: string;
  label: string;
  dark: boolean;
  colors: ThemeColors;
  sky: ThemeSky;
  /** Show Axo, the pixel axolotl. */
  axo: boolean;
  /** Who made it (shown in the picker); "lu-minal" for built-ins. */
  author?: string;
}
