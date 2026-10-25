# Themes

A theme is the colours every part of lu-minal reads, the night sky behind the panels and whether
Axo shows. Components never use raw colours, so a theme changes the whole app.

## Picking one

- `/theme` opens the picker. It previews each theme while you move through the list; enter keeps
  it, esc goes back to the one you had. `/theme nord` switches directly. The theme you switch to
  is saved in `config.json` (`theme`) for the next start.
- `lu-minal --theme <name>` starts with a theme for that run.
- `lu-minal themes` lists the built-in and custom themes.

The built-in themes: `moon` (the default), `moon-day`, `astra`, `tokyo-night`, `catppuccin-mocha`,
`dracula`, `nord`, `gruvbox-dark`, `rose-pine` and `mono`.

## Asking an agent

Every agent has three theme tools: `list_themes`, `set_theme` and `create_theme`. Ask for a look
("make me a sunset theme with warm stars", "the same, but greener") and the agent calls
`create_theme` with a name, an optional base theme (default: the one in use) and only the
colours and sky settings it changes. lu-minal checks them, saves the theme as a file (see below)
with the agent as its author, and switches to it unless the agent passes `apply: false`.
Built-in names are refused; pick another name for a custom theme. The picker's "Ask an agent to
design a new theme" row starts that message for you.

## Custom theme files

Custom themes are JSON files, one per theme, in the `themes` folder of lu-minal's config folder:

| Windows | macOS | Linux |
| --- | --- | --- |
| `%APPDATA%\lu-minal\themes` | `~/.config/lu-minal/themes` | `$XDG_CONFIG_HOME/lu-minal/themes` (`~/.config/lu-minal/themes`) |

With `LU_MINAL_HOME` set, it is `$LU_MINAL_HOME/config/themes`. lu-minal reads the folder when it
starts and after `create_theme` saved a theme, so restart it after editing a file by hand.

A file only needs a name and what differs from its base; everything else comes from the base:

```json
{
  "name": "sunset",
  "label": "Sunset",
  "base": "moon",
  "colors": {
    "bg": "#1a0f1f",
    "accent": "#ffb38a",
    "accent2": "#f28b92",
    "agents": ["#ffb38a", "#f28b92", "#b9aefb", "#7fe3c6"]
  },
  "sky": {
    "stars": ["#3a2440", "#8a5a6a", "#ffb38a", "#ffe9c7"],
    "density": 2,
    "moonColor": "#ffe9c7"
  }
}
```

| Field | |
| --- | --- |
| `name` | The theme's id, made file-safe (`"Forest Night"` becomes `forest-night`, at most 40 characters). Without one, the file name is used. |
| `label` | The name shown in the picker (default: from `name`). |
| `base` | The built-in theme the rest comes from (default: `moon`). |
| `dark` | Whether it is a dark theme, shown in the picker (default: worked out from `colors.bg`). |
| `axo` | Show Axo, the pixel axolotl (`true` / `false`). `"axo": false` in `config.json` hides it for every theme. |
| `author` | Who made it (`create_theme` puts the agent's name here). |
| `colors` | The colours below, as `"#rrggbb"` (`"#rgb"` works too). |
| `sky` | The sky settings below. |

Colours:

| Key | Used for |
| --- | --- |
| `bg` | The sky and app background behind everything. |
| `surface`, `surfaceFocus` | Panel interiors, and the focused panel's. |
| `popover` | Dialogs and popovers. |
| `border`, `borderFocus` | Panel borders, and the focused panel's. |
| `text`, `muted`, `faint` | Text, from normal to least important. |
| `accent` | The main accent: titles, the markers, the focused border. |
| `accent2` | The second accent: status verbs, links. |
| `claude` | Claude Code agents (the Moon family uses mint). |
| `success`, `warning`, `error` | States, toasts and gauges. |
| `diffAddBg`, `diffAddFg`, `diffDelBg`, `diffDelFg` | Added and removed lines in diffs. |
| `selection`, `selectionText` | The selected row in lists. |
| `tabActiveBg`, `tabActiveFg` | The active tab in the tab bar. |
| `agents` | A list of colours, given to the workers in turn. |

Sky:

| Key | |
| --- | --- |
| `enabled` | Draw the animated sky at all (`--no-sky` turns it off for every theme). |
| `stars` | Star colours from faint to bright; a star twinkles along this list. |
| `glyphs` | The characters stars are drawn with, from small to big; only ones a single column wide are kept. |
| `density` | Stars per 100 cells, 0 to 20 (0.5 to 6 looks good). |
| `glass` | How much of the sky shines through the panels, 0 (opaque) to 1. The Moon look uses 0.25. |
| `moon`, `moonColor` | Draw the moon, and its colour. |
| `shootingStars`, `shootingStarColor` | Draw shooting stars, and their colour. |

Numbers outside their range are clamped and unusable glyphs are dropped. A file with broken JSON,
a colour that is not hex, or an `enabled`, `moon` or `shootingStars` that is not `true` or
`false` is skipped, so it does not show up in the list. A custom theme named like a built-in one becomes `<name>-custom`; when two files claim
the same name, the file called `<name>.json` keeps it and the others get `-2`, `-3`, ...

The code is in `src/themes/`: the types (`types.ts`), the built-in themes (`builtin.ts`), the
checks for files and tools (`validate.ts`) and the folder of custom themes (`manager.ts`).
