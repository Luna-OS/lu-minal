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
  workers – they all speak the same team protocol. Other coding agents join too: the OpenCode CLI
  and Gemini CLI run as team members over the [Agent Client Protocol](docs/acp.md).
- **Claude without an API key.** Sign in with your Claude subscription: lu-minal drives the official
  Claude Code CLI and never touches your tokens.
- **All the providers.** The [models.dev](https://models.dev) catalog (230+ providers): OpenCode
  Zen (free models, no key needed), OpenRouter (browser sign-in, `:free` models), Anthropic, OpenAI,
  Google Gemini, MiniMax, Groq, DeepSeek, Z.ai, Moonshot, xAI, Mistral, Ollama and LM Studio
  locally, and any OpenAI-compatible endpoint you add.
- **Live plan limits.** The 5-hour session and the weekly limit of your Claude plan, as moons that
  fill up, live from every running agent and polled in the background. `/usage` shows it all like
  the Claude app does – context window per agent, session, weekly limits per model, extra credits –
  plus every other model in use (OpenRouter credits, tokens and cost).
- **Statistics.** `/stats`: tokens in and out, cost, lines changed and sessions – in total, per
  day, per model and per project.
- **Pictures and files.** Paste a screenshot or files copied in Explorer / Finder with the
  terminal's own paste key (ctrl+v in Windows Terminal, cmd+v in the macOS app), drop files on the
  terminal, or pick them with `/attach`. Models that can see get the picture; text files go into
  the message.
- **Claude cloud sessions, in the terminal.** `/cloud` starts a task on claude.ai/code, browses
  every cloud session of your account in Claude Code's own picker (`claude --teleport`), and per
  session: enter types a follow-up, t teleports it here, w watches it live (not every account has
  that yet). `/cloud msg <text>` messages the session used last right from the prompt. In the
  lu-minal app the real claude.ai/code website opens beside the terminal, in the same window:
  `/web`, **Cmd+Shift+K** on macOS, **Ctrl+Shift+K** in the Windows window app (see
  [Claude cloud](#claude-cloud)).
- **Close and come back.** lu-minal saves the session as you work: quit, start it again, and every
  tab, agent, log and conversation is back where it was.
- **Tabs per project.** Open a folder, or clone a repository from **GitHub** or any **Forgejo /
  Gitea** instance (Codeberg by default) straight into a new tab.
- **Themes.** Moon (the default), Moon Day, Astra, Tokyo Night, Catppuccin, Dracula, Nord,
  Gruvbox, Rosé Pine, Mono – or ask an agent to design a new one (`create_theme`).
- **Roblox Studio.** A Studio plugin connects to lu-minal, and agents can read the place tree, edit
  scripts, create instances and run Luau in Studio.
- **Windows, macOS and Linux.** A standalone binary per platform, a native macOS app written in
  Swift, or a build from source with Node.

## Install

| | |
| --- | --- |
| **macOS / Linux** | `curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh \| sh` |
| **Windows** (setup) | `lu-minal-windows-x64-setup.exe` (or `-arm64-`) from the [releases](https://github.com/Luna-OS/lu-minal/releases/latest), from 0.1.1 on: no administrator rights; PATH, Start menu and Windows Terminal profile; uninstall in Settings > Apps. The Start menu entry opens **lu-minal's own window**, with the Claude Code website beside the terminal ([windows-app](windows-app/README.md)) |
| **Windows** (PowerShell) | `irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 \| iex` |
| **macOS app** | `lu-minal-macos-app.dmg` (or `.zip`) from the [releases](https://github.com/Luna-OS/lu-minal/releases/latest): **LuMinal.app**, a native Swift window running lu-minal |
| **Standalone binary** | `lu-minal-linux-x64`, `lu-minal-macos-arm64`, `lu-minal-windows-x64.exe`, … from the [releases](https://github.com/Luna-OS/lu-minal/releases/latest), with `SHA256SUMS` (all files: [docs/install.md](docs/install.md)) |
| **From source** (any OS, Node 22+) | `git clone`, `npm ci`, `npm run build`, `npm link` – see [From source](#from-source) |

Then run `lu-minal` in a project folder. Details for every platform (Windows Terminal profile,
the Linux desktop entry, terminals with true colour) are in [docs/install.md](docs/install.md).

**Updates** (from 0.1.1 on): lu-minal asks GitHub once a day whether a newer version is out and
shows `↑ 0.1.2 /update` in the tab bar. `/update` (or `lu-minal update` in a shell) installs it the
way lu-minal was installed, checked against the release's `SHA256SUMS`; start lu-minal again to use
it, and your tabs come back. See [docs/install.md](docs/install.md#updates).

### From source

lu-minal is not published to npm yet. With Node.js 22 or newer and git, on any system:

```sh
git clone https://github.com/Luna-OS/lu-minal
cd lu-minal
npm ci
npm run build
npm link        # puts lu-minal on your PATH
```

To update, run `git pull`, `npm ci` and `npm run build` in that folder; `npm unlink -g lu-minal`
removes it. If `npm link` fails with EACCES, your global npm folder belongs to root: use a Node
version manager (nvm, fnm, Volta) or point npm at your home folder (`npm config set prefix ~/.local`).

## Sign in

Press **ctrl+l** (or `/login`):

| Provider | How |
| --- | --- |
| **Claude** (Pro / Max) | Your Claude account through Claude Code – **no API key**. lu-minal installs Claude Code if needed and runs `claude auth login` for you. |
| **OpenCode Zen** | Nothing to do: the free models work without a key. Add a key for the paid ones. |
| **OpenRouter** | "Sign in with the browser" creates a key for lu-minal (OAuth) – or paste one. |
| **Anthropic, OpenAI, Gemini, MiniMax, …** | Paste an API key, or set the usual environment variable (`MINIMAX_API_KEY`, …). |
| **OpenCode CLI, Gemini CLI** | Install the CLI; lu-minal runs its own sign-in (`opencode auth login`). Models are `opencode-cli/<provider/model>` (e.g. `opencode-cli/opencode/big-pickle`) and `gemini-cli/<model>`; more agents go in config.json's `acpAgents` – see [docs/acp.md](docs/acp.md). |
| **Ollama / LM Studio** | Start the local server; lu-minal finds the models. |
| **GitHub / Forgejo** | For private repositories: the GitHub CLI or a token, a Forgejo token. |

Keys are stored in `auth.json` in lu-minal's config folder, readable only by you.

## Working with a team

1. Open a project (lu-minal opens the current folder as the first tab).
2. Tell the lead what you want. It plans, fills the task board and spawns workers.
3. Watch the panels. Focus one with **tab**, zoom it with **ctrl+f**, talk to it directly, or
   message anyone with `@vega make the lamp warmer`.
4. Approve what needs approving with **y** (allow), **a** (always) or **n** (deny). Claude Code's
   multiple-choice questions are asked in the chat instead: lu-minal tells Claude to ask in plain
   text, and you answer with a message. Whatever an agent waits on you for – the whole command or
   edit, or the question its answer ends with – shows in a card above the prompt (pgup / pgdn
   scroll a long one, esc puts a question away), while tool output and code in the log keep their
   first lines until you zoom with **ctrl+f**.
5. Add pictures and files to a message: paste a screenshot (Win+Shift+S, Cmd+Shift+Ctrl+4) or
   files you copied in Explorer / Finder with the terminal's paste key – **ctrl+v** in Windows
   Terminal (1.24 or newer) and most Linux terminals, **cmd+v** in the macOS app, **ctrl+v** in Terminal.app and
   iTerm2, **alt+v** anywhere, or `/paste` – drop files on the terminal, or use `/attach`. They show
   as chips above the prompt; backspace on an empty prompt removes the last one.
   A long pasted text (more than 5 lines or 1000 characters) shows as `[Pasted text #1 +87 lines]`
   in the prompt, goes out in full when you send, and backspace deletes it in one go.

**Permission modes** (shift+tab): *edits on* (the default – edits run, commands ask), *ask first*,
*do everything*, *plan only* (read-only). Reading credential stores, writing into `.git` or agent
settings, and fetching local addresses always ask, even with edits on. `/yolo` (or `/allow-all`)
puts every agent in every tab on *do everything*, allows the questions still open and keeps it the
default for new tabs and the next start; `/yolo off` goes back to *edits on*.

**Trust:** a repository you clone starts untrusted – Claude Code agents there don't load its own
`.claude` settings, CLAUDE.md or `.mcp.json` servers until you say so (lu-minal asks after the
clone; `/trust` changes it). How lu-minal keeps agents in check: [docs/security.md](docs/security.md).

**Models:** pick one per agent (ctrl+o), for example a Claude Opus lead with `minimax/MiniMax-M3`
and `opencode/big-pickle` workers: `/new minimax/MiniMax-M3 [voice] add text-to-speech`.

## Claude cloud

`/cloud` (or `/remote`) runs Claude Code's cloud sessions from the terminal, through the official
`claude` CLI:

- **✦ New cloud session…** starts a task on claude.ai/code (`claude --cloud "<task>"`); Claude
  works on it in a fresh clone of your pushed branch.
- **All my cloud sessions…** is Claude Code's own picker of every session of your account
  (`claude --teleport`): pull one into this terminal.
- On a session: **enter** types a follow-up, **t** teleports it here, **w** watches it live (not
  every account can yet), **o** opens it on the web, **x** forgets it. `/cloud msg <text>`
  messages the session used last, right from the prompt.

**The website beside the terminal.** In the lu-minal app the real claude.ai/code website shows in
a pane next to the terminal, in the same window. The app only displays the page – nothing is
automated, nothing in it is read.

| | |
| --- | --- |
| macOS app | **Cmd+Shift+K**, the View menu or the button in the window – see [macos/README.md](macos/README.md) |
| Windows window app | **Ctrl+Shift+K** or the button in the window – see `windows-app/README.md` |
| in lu-minal | `/web` shows or hides the pane, `/web show`, `/web hide`, `/web <claude.ai link>` opens a page there. In `/cloud`, **o** shows a session there, and the list has **Cloud website beside the terminal** |

In any other terminal `/web` and **o** open claude.ai/code in your browser instead.

Sign in once inside the pane with **Continue with email** (Claude sends you a code): Google
refuses its sign-in inside embedded web views, and the pane says so. The sign-in is kept for the
next start; links to other sites open in your browser. lu-minal tells the pane what to show with a
private escape sequence, for claude.ai pages only ([docs/architecture.md](docs/architecture.md#the-web-pane-beside-the-terminal));
neither lu-minal nor the app reads the page, its cookies or Claude Code's tokens.

## Keys

| Key | |
| --- | --- |
| enter | send (end a line with `\` for a new line) |
| `@name text` | message a teammate, `@*` for everyone |
| tab, ctrl+↑ ↓ | focus the next / previous agent |
| shift+tab | permission mode |
| ctrl+t, ctrl+w | new tab, close tab |
| alt+1…9, alt+← → | switch tabs (also ctrl+pageup / pagedown) |
| alt+0 (`/home`) | home: recent folders, Claude's news (✦ model launches, ★ offers and free resets of your limits), new models, Claude Code news, Anthropic status (esc goes back) |
| ctrl+n | add an agent |
| ctrl+o | change the focused agent's model |
| ctrl+l | sign in |
| ctrl+k | command palette |
| ctrl+f | zoom |
| pgup, pgdn | scroll |
| mouse wheel, click | scroll the panel under the pointer, focus a panel. With **Shift** held (**Option** in iTerm2, **fn** in Terminal.app) the mouse is the terminal's: drag to select text, right-click to paste in Windows Terminal. `/mouse off` leaves it to the terminal for good (the macOS app always does) |
| `/copy` | copy the focused agent's last reply – its words, not the tool output – to the clipboard |
| esc | interrupt the focused agent |
| ctrl+v, alt+v (`/paste`) | paste a screenshot or copied files from the clipboard |
| cmd+shift+k (macOS app), ctrl+shift+k (Windows window app), `/web` | show / hide the claude.ai/code website beside the terminal; elsewhere `/web` opens it in the browser |
| ctrl+c twice, ctrl+q | quit |

For a Claude Code agent, esc asks the CLI to stop the turn. If it hasn't stopped after 3 s (or you
press esc again), lu-minal sends SIGINT (macOS / Linux) and then stops the process; the next
message resumes the same conversation.

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

lu-minal reopens the last session on its own: every tab with its agents, logs, task board and
conversations (Claude Code and ACP agents resume their sessions). `lu-minal --fresh` starts
without them. Pictures you attached are kept in the state folder's `attachments/` for 30 days.

## Development

```sh
npm install
npm run dev          # run from source
npm test             # vitest
npm run typecheck
npm run build        # dist/ (node dist/cli.js; npm link puts it on the PATH)
npm run build:bin    # standalone binaries for every platform (needs Bun)
npm run build:app    # macOS only: LuMinal.app in macos/build (needs Xcode)
```

The Windows window app (`lu-minal-window.exe`, Rust + WebView2) is in [windows-app](windows-app/README.md).

How it fits together: [docs/architecture.md](docs/architecture.md).

## License

MIT, see [LICENSE](LICENSE).
