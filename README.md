# lu-minal

**A team of coding agents under the night sky.** lu-minal is a terminal app in which a lead agent
and its workers build your project together – each in its own panel, on any provider you like,
talking to each other while you watch. It wears the Luna-OS Moon look: an animated night sky
behind glass panels, the crescent moon, shooting stars, and Axo the pixel axolotl.

```
 ☾ lu-minal   1 gf-sim ●   2 moon-code      + ctrl+t          ◑ session ━━━━━──── 42% 2h 13m
 ◆ luna ×7 · gf-sim · 23m 59s                                              ↓ 550.0k · $146.94
 ╭ ◆ luna ────────────────────────────────────────────── lead · 6 workers · claude opus ╮
 │ ▸ read PLAN.md                                                     ✦    ▄▄▄▄          │
 │   └ 94 lines                                                  ⋆     ▄█▀▀▀▀█▄   ·     │
 │ ▸ run tsc --noEmit                                                  █ ◕  ◕ █         │
 │   └ ✓ 0 errors                                                      Axo, the axolotl │
 │ ✦ Delegating… (23m 59s · ↓ 54.5k)                                                    │
 │ › _                                                                                  │
 ╰──────────────────────────────────────────────────────────────────────────────────────╯
 ╭ ◆ vega ─────────────────── room · opus ╮  │  ╭ ◆ lyra ───────────── her · MiniMax-M3 ╮
 │ ▸ edit Window.ts                        │  │  │ ▸ new Her.ts                           │
 │ 54 + moon = 'full'                      │  │  │ 133 + pose = 'sitting'                 │
 │   └ 1 line added                        │  │  │   └ wrote 78 lines                     │
 │ ✦ Charting… (23m 9s · ↓ 72.6k)          │  ◆  │ ✦ Patching… (22m 7s · ↓ 79.1k)         │
 ╰─────────────────────────────────────────╯     ╰────────────────────────────────────────╯
 ● lead + 6/6 running · edits on (shift+tab)                          +4,872 -919  ctrl+k
```

## What it does

- **Agent teams.** Every tab has a lead (`luna`) that plans, puts tasks on a shared board and
  spawns workers (`vega`, `lyra`, `orion`, …) – one area each, with its own panel, status verb,
  token count and diffs. You can add agents yourself (ctrl+n) and talk to any of them.
- **Agents talk to each other.** `send_message`, `list_agents`, `spawn_agent`, a shared task board
  (`task_add` / `task_update`) – workers report to the lead, coordinate on shared files, and you
  can message anyone with `@name …` (or `@* …` for everyone).
- **Mixed providers in one team.** A Claude Opus lead can run MiniMax, OpenRouter or free OpenCode
  workers – they all speak the same team protocol.
- **Claude without an API key.** Sign in with your Claude subscription: lu-minal drives the official
  Claude Code CLI and never touches your tokens.
- **All the providers.** The [models.dev](https://models.dev) catalog (230+ providers): OpenCode
  Zen (free models, no key needed), OpenRouter (browser sign-in, `:free` models), Anthropic, OpenAI,
  Google Gemini, MiniMax, Groq, DeepSeek, Z.ai, Moonshot, xAI, Mistral, Ollama and LM Studio
  locally, and any OpenAI-compatible endpoint you add.
- **Live plan limits.** The 5-hour session and the weekly limit of your Claude plan, as moons that
  fill up, live from every running agent and polled in the background.
- **Tabs per project.** Open a folder, or clone a repository from **GitHub** or any **Forgejo /
  Gitea** instance (Codeberg by default) straight into a new tab.
- **Themes.** Moon (the default), Moon Day, Astra, Tokyo Night, Catppuccin, Dracula, Nord,
  Gruvbox, Rosé Pine, Mono – or ask an agent to design a new one (`create_theme`).
- **Roblox Studio.** A Studio plugin connects to lu-minal, and agents can read the place tree, edit
  scripts, create instances and run Luau in Studio.
- **Windows, macOS and Linux.** `npx lu-minal`, a standalone binary per platform, and a native
  macOS app written in Swift.

## Install

| | |
| --- | --- |
| **npm** (any OS, Node 22+) | `npm i -g lu-minal` or `npx lu-minal` |
| **macOS / Linux** | `curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh \| sh` |
| **Windows** (PowerShell) | `irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 \| iex` |
| **macOS app** | `lu-minal.app` from the [releases](https://github.com/Luna-OS/lu-minal/releases) – a native Swift window running lu-minal |

Then run `lu-minal` in a project folder. Details for every platform (Windows Terminal profile,
the Linux desktop entry, terminals with true colour) are in [docs/install.md](docs/install.md).

## Sign in

Press **ctrl+l** (or `/login`):

| Provider | How |
| --- | --- |
| **Claude** (Pro / Max) | Your Claude account through Claude Code – **no API key**. lu-minal installs Claude Code if needed and runs `claude auth login` for you. |
| **OpenCode Zen** | Nothing to do: the free models work without a key. Add a key for the paid ones. |
| **OpenRouter** | "Sign in with the browser" creates a key for lu-minal (OAuth) – or paste one. |
| **Anthropic, OpenAI, Gemini, MiniMax, …** | Paste an API key, or set the usual environment variable (`MINIMAX_API_KEY`, …). |
| **Ollama / LM Studio** | Start the local server; lu-minal finds the models. |
| **GitHub / Forgejo** | For private repositories: the GitHub CLI or a token, a Forgejo token. |

Keys are stored in `auth.json` in lu-minal's config folder, readable only by you.

## Working with a team

1. Open a project (lu-minal opens the current folder as the first tab).
2. Tell the lead what you want. It plans, fills the task board and spawns workers.
3. Watch the panels. Focus one with **tab**, zoom it with **ctrl+f**, talk to it directly, or
   message anyone with `@vega make the lamp warmer`.
4. Approve what needs approving with **y** (allow), **a** (always) or **n** (deny).

**Permission modes** (shift+tab): *edits on* (the default – edits run, commands ask), *ask first*,
*do everything*, *plan only* (read-only).

**Models:** pick one per agent (ctrl+o), for example a Claude Opus lead with `minimax/MiniMax-M3`
and `opencode/big-pickle` workers: `/new minimax/MiniMax-M3 [voice] add text-to-speech`.

## Keys

| Key | |
| --- | --- |
| enter | send (end a line with `\` for a new line) |
| `@name text` | message a teammate, `@*` for everyone |
| tab, ctrl+↑ ↓ | focus the next / previous agent |
| shift+tab | permission mode |
| ctrl+t, ctrl+w | new tab, close tab |
| alt+1…9, alt+← → | switch tabs (also ctrl+pageup / pagedown) |
| ctrl+n | add an agent |
| ctrl+o | change the focused agent's model |
| ctrl+l | sign in |
| ctrl+k | command palette |
| ctrl+f | zoom |
| pgup, pgdn | scroll |
| esc | interrupt the focused agent |
| ctrl+c twice, ctrl+q | quit |

Every key has a slash command too (`/help` lists them), since some terminals keep certain keys for
themselves.

## Themes

`/theme` previews the themes as you move through them. To make a new one, ask an agent – "make me
a sunset theme with warm stars" – it uses `create_theme` and switches to it. Custom themes are JSON
files in the config folder's `themes/` directory; see [docs/themes.md](docs/themes.md).

## Roblox Studio

```sh
lu-minal roblox install
```

installs the lu-minal plugin into Studio's plugins folder. Open Studio, allow HTTP requests to
localhost when it asks, and click **Connect** on the lu-minal toolbar. Agents then have
`roblox_get_tree`, `roblox_get_script`, `roblox_set_script`, `roblox_create_instance`,
`roblox_run_luau` and more. See [docs/roblox.md](docs/roblox.md).

## Files

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Settings, keys, themes | `%APPDATA%\lu-minal` | `~/.config/lu-minal` | `$XDG_CONFIG_HOME/lu-minal` |
| Cache (model catalog) | `%LOCALAPPDATA%\lu-minal\cache` | `~/Library/Caches/lu-minal` | `$XDG_CACHE_HOME/lu-minal` |
| Session (open tabs) | `%LOCALAPPDATA%\lu-minal\state` | `~/Library/Application Support/lu-minal` | `$XDG_STATE_HOME/lu-minal` |

`lu-minal --continue` reopens the tabs of the last session (Claude Code agents resume their
conversations).

## Development

```sh
npm install
npm run dev          # run from source
npm test             # vitest
npm run typecheck
npm run build        # dist/ for npm
npm run build:bin    # standalone binaries for every platform (needs Bun)
```

How it fits together: [docs/architecture.md](docs/architecture.md).

## License

MIT, see [LICENSE](LICENSE).
