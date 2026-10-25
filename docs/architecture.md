# Architecture

lu-minal is a terminal app (Ink 8 + React 19) that runs **teams of coding agents** on projects.
Every tab is a project; every project has a lead agent and any number of workers. Agents can run
on any provider – Claude through the user's own Claude Code login (no API key), or any HTTP API
from the [models.dev](https://models.dev) catalog (OpenCode Zen's free models, OpenRouter, MiniMax,
OpenAI, Gemini, ...). They talk to each other over the project's bus, share a task board, can switch
the app's theme, and can drive Roblox Studio through a small bridge.

It runs the same on **Windows, macOS and Linux**: as `npx lu-minal`, as a standalone binary per
platform (Bun-compiled, see `scripts/build-binaries.ts`), and on macOS also as a native Swift app
(`macos/`) that hosts the terminal in a Moon-styled window.

## Module map

| Path | What it is |
| --- | --- |
| `src/cli.tsx` | Entry: arguments, sub-commands (`models`, `login`, `roblox install`, ...), starts the UI. |
| `src/core/` | State: `Hub` (the app), `Project` (a tab), `Agent` (one agent and its log), config, permissions. |
| `src/platform/` | Paths per OS, finding / spawning programs (Windows `.cmd` shims), opening URLs. |
| `src/providers/` | Catalog (models.dev), auth store, provider registry, OpenRouter OAuth, the wire clients. |
| `src/providers/wire/` | OpenAI chat completions, OpenAI Responses, Anthropic Messages – streaming + tool calls. |
| `src/agents/native/` | The agent loop for API models (stream → tool calls → results → repeat). |
| `src/agents/claude-code/` | Claude Code CLI: discovery, account, plan usage, stream-json events, the driver. |
| `src/agents/prompts.ts` | System prompts for leads and workers (the team protocol). |
| `src/tools/` | Tools: files, shell, web fetch, team (messages, spawn, tasks), themes, Roblox. |
| `src/mcp/` | A minimal MCP server (Streamable HTTP) that gives Claude Code agents the team/theme/Roblox tools and routes their permission prompts into lu-minal. |
| `src/roblox/` | The Studio bridge (HTTP long-poll server) and plugin installer. `roblox/` has the plugin. |
| `src/git/` | GitHub and Forgejo/Gitea repository lists and cloning. |
| `src/themes/` | Theme type, built-in themes (`moon` is the default), custom themes on disk. |
| `src/ui/` | Ink components: sky, Axo, tab bar, header, agent panels, dialogs, prompt. |
| `macos/` | Native macOS app (Swift, SwiftTerm) that runs lu-minal in a Moon window. |

## Data flow

```
 keyboard ─▶ UI (src/ui) ─▶ Hub actions ─▶ Project / Agent ─▶ AgentDriver
                 ▲                                              │
                 └──── useSyncExternalStore ◀── Notifier ◀──────┘ (log, status, usage)
```

- State lives in plain classes (`Hub`, `Project`, `Agent`) that call `notifier.changed()`; the UI
  subscribes once (`src/ui/store.ts`). Notifications are coalesced per macrotask.
- An `AgentDriver` runs an agent: `NativeDriver` (API models) or `ClaudeCodeDriver` (the CLI). The
  Hub picks one when an agent is launched (`ProjectRuntime.launch`).
- Tools are defined once (`src/tools/types.ts`). Native agents run them in-process through
  `runToolCall` (`src/tools/run.ts`), which asks for approvals by the permission mode and logs the
  call. Claude Code agents get the tools marked `mcp: true` from `src/mcp/server.ts` and use Claude
  Code's own file/shell tools for the rest.
- Approvals: `Agent.requestApproval` decides by the permission mode (`src/core/permissions.ts`), the
  agent's "always" list, or by asking the user (the panel shows the request, `y` / `n` / `a`).
  Claude Code's permission prompts arrive through the MCP tool `approve`
  (`--permission-prompt-tool mcp__luminal__approve`) and take the same path.

## The team protocol

- Each project has one **lead** (default name `luna`) and workers named after stars (`vega`,
  `lyra`, `orion`, ...). Each agent has an optional area **label** shown in its panel title.
- `send_message(to, text)` delivers to a teammate (`"lead"`, a name, or `"*"`). The recipient sees
  it as a new user message `[from vega] ...`; if it is busy, it reads it at its next step.
- `spawn_agent(task, label?, model?, name?)` (lead only) starts a worker – on any provider, so a
  Claude Opus lead can run MiniMax or free OpenCode workers.
- `tasks_list` / `task_add` / `task_update` share a board (todo → doing → done / blocked).
- `list_agents` shows who is there, their model, status and what they are doing.
- Workers report back to the lead with `send_message("lead", ...)` when they finish.

## Providers

`src/providers/catalog.ts` loads models.dev's `api.json` (cached for a day in the cache dir, with a
small bundled fallback) and maps each provider's `npm` package to one of the three wires:

| models.dev `npm` | Wire | Base URL |
| --- | --- | --- |
| `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`, `@ai-sdk/groq`, `@ai-sdk/xai`, `@ai-sdk/mistral`, `@ai-sdk/deepinfra`, `@ai-sdk/cerebras`, `@ai-sdk/togetherai`, `@ai-sdk/perplexity`, `@ai-sdk/alibaba`, `@ai-sdk/cohere`, `@ai-sdk/google`, ... | `openai-chat` | the catalog's `api`, or a known default (`https://generativelanguage.googleapis.com/v1beta/openai` for Google, ...) |
| `@ai-sdk/anthropic` | `anthropic` | `api` or `https://api.anthropic.com/v1` |
| `@ai-sdk/openai` | `openai-responses` | `api` or `https://api.openai.com/v1` |
| Bedrock, Vertex, Azure, gateways with their own SDKs | unsupported (listed, greyed out) unless the config overrides the base URL |

A model's own `provider.npm` / `provider.api` (models.dev puts them on single models, e.g. OpenCode's
MiniMax models use the Anthropic wire) wins over the provider's.

lu-minal adds two providers models.dev doesn't have:

- `claude-code` – Claude through the Claude Code CLI and the user's subscription. Models are the
  CLI's aliases (`default`, `opus`, `sonnet`, `haiku`, `fable`) plus every Anthropic model id.
- `ollama` – a local Ollama server (`http://127.0.0.1:11434/v1`), models read from `/api/tags`.

Free models: models with input and output cost 0. OpenCode Zen's free models work **without a key**
(lu-minal sends the key `public`, as the OpenCode CLI does). OpenRouter's `:free` models need an
OpenRouter key, which the browser sign-in (OAuth PKCE) creates without copy-pasting.

Keys live in `auth.json` in the config dir (mode 0600), or come from the environment variables the
catalog names (`OPENROUTER_API_KEY`, `MINIMAX_API_KEY`, ...).

## Claude without an API key

lu-minal never talks to the Claude API with a subscription and never reads Claude Code's tokens. It
runs the official `claude` program:

| Step | Command |
| --- | --- |
| Find it | `claude` on the PATH, `~/.local/bin`, `~/.claude/local`, `%APPDATA%\npm` (or `claudePath` in the config) |
| Sign in | `claude auth login` in the real terminal (the UI suspends itself meanwhile) |
| Who is signed in | `claude auth status --json` + `~/.claude.json` |
| An agent | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <m> --mcp-config <file> --permission-prompt-tool mcp__luminal__approve --append-system-prompt <team prompt>` in the project folder |
| Plan limits | `claude -p /usage --output-format stream-json --verbose --no-session-persistence --strict-mcp-config` every `usagePollSeconds`, plus every `rate_limit_event` from running agents |

## Cross-platform rules

- Paths: always `path.join` / `path.resolve`; never hard-code `/`. Config, cache and state dirs come
  from `src/platform/paths.ts` (`%APPDATA%` / `%LOCALAPPDATA%` on Windows, `~/Library` on macOS,
  XDG on Linux).
- Programs: find them with `findProgram` and start them with `spawnProgram` / `runProgram`
  (`src/platform/process.ts`), which handle Windows `.cmd` shims and PATHEXT.
- The shell tool runs `bash` on macOS/Linux; on Windows it prefers Git Bash and falls back to
  PowerShell, and tells the model which one it got.
- Line endings: tools keep a file's existing `\r\n` when editing it.
- Keys: every shortcut also has a slash command, because terminals (VS Code, Windows Terminal,
  macOS Terminal) swallow different key combinations.
