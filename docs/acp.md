# ACP agents: OpenCode, Gemini CLI and others as team members

lu-minal can run other coding-agent CLIs as members of a team, next to its own agents (API models)
and Claude Code. They are driven over the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP), the open protocol editors such as Zed use to talk to coding agents: lu-minal is the ACP
*client*, the CLI is the ACP *agent*. The CLI keeps its own sign-in, its own model providers and
its own tools; lu-minal gives it a session in the project folder, lu-minal's team tools, and the
approvals.

| Agent | Provider id | Command | Models |
| --- | --- | --- | --- |
| [OpenCode](https://opencode.ai/docs/acp/) | `opencode-cli` | `opencode acp --print-logs --log-level WARN` | everything `opencode models` lists, e.g. `opencode/big-pickle`, `anthropic/claude-sonnet-5-5`, `github-copilot/gpt-6-sol` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini-cli` | `gemini --experimental-acp` | `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.1-pro-preview`, `gemini-2.5-pro`, ... |
| your own | the key in `acpAgents` | whatever you configure | the ids you list |

Every ACP agent also has the model `default`: the agent runs on whatever it is configured to use.

## Using them

A model reference is `<provider id>/<the CLI's own model id>`, and the CLI's id may contain slashes:

- `opencode-cli/opencode/big-pickle` – OpenCode on OpenCode Zen's free Big Pickle
- `opencode-cli/anthropic/claude-sonnet-5-5` – OpenCode on your Anthropic account (`opencode auth login`)
- `gemini-cli/gemini-3.8-flash` – Gemini CLI on Gemini 3.8 Flash
- `opencode-cli/default`, `gemini-cli/default` – the CLI's own choice

Pick one with `/model` (the agents show up once their program is installed), or let the lead start
workers on them: `spawn_agent(task, label, model: "opencode-cli/opencode/big-pickle")`. A Claude
lead can run OpenCode and Gemini workers side by side.

### OpenCode

1. Install it: `npm install -g opencode-ai` (or `curl -fsSL https://opencode.ai/install | bash`,
   Homebrew, Scoop, ...). lu-minal finds `opencode` on the PATH and in the usual install places
   (`~/.opencode/bin`, `%APPDATA%\npm`, Homebrew, `~/.bun/bin`, ...).
2. Sign in, if you want more than the free models: `opencode auth login` in a terminal. OpenCode
   Zen's free models need no sign-in.
3. Pick a model. lu-minal reads OpenCode's model list with `opencode models --verbose` (cached for
   a day) and selects the model in the session (`session/set_config_option`).

OpenCode allows every tool by default. So that lu-minal's permission modes apply, lu-minal starts it
with `OPENCODE_PERMISSION` set to ask for edits, shell commands and web access (merged over your own
`OPENCODE_PERMISSION`; rules you set to `deny` stay). Those questions arrive as ACP permission
requests and are decided like any other approval in lu-minal.

### Gemini CLI

1. Install it: `npm install -g @google/gemini-cli`.
2. Sign in once in a terminal: run `gemini` and choose *Login with Google*, or set `GEMINI_API_KEY`
   (lu-minal then signs the session in with the key by itself).
3. Pick a model; it is passed as `--model <id>` unless the session can select models itself.

## How it works

```
lu-minal (ACP client)                         the CLI (ACP agent), in the project folder
  initialize {fs: off, terminal: off}   ──▶
                                        ◀──   capabilities, auth methods
  session/new {cwd, mcpServers: [luminal]} ─▶ (or session/resume / session/load after a restart)
                                        ◀──   sessionId, config options (model, mode)
  session/set_config_option model       ──▶
  session/prompt [team prompt, message] ──▶
                                        ◀──   session/update: text, thoughts, tool calls, plan, usage
                                        ◀──   session/request_permission  ──▶ the approval row (y / n / a)
                                        ◀──   {stopReason}
  session/cancel (Esc)                  ──▶
```

- **One process per agent**, started in the project folder on the first message and kept between
  messages. Messages that arrive during a turn are sent as the next prompt.
- **The team prompt**: ACP has no system prompt, so lu-minal's team instructions go in front of the
  first message of a session, marked as coming from lu-minal.
- **Team tools**: when the agent can use MCP over HTTP, the session gets lu-minal's MCP server
  (`luminal`, with a per-agent bearer token), so the agent can `send_message`, use the task board,
  `spawn_agent` (leads), switch themes and drive Roblox Studio. OpenCode names them
  `luminal_send_message` and so on. Calls of these tools are allowed without asking; the tools make
  their own approvals.
- **The log**: `agent_message_chunk` and `agent_thought_chunk` stream into text and reasoning
  blocks; each tool call is a row whose verb comes from its kind (`read`, `edit` / `new` with the
  diff, `run`, `grep`, `fetch`, `think`, ...) and whose status follows the call (pending and
  in_progress run, completed is done, failed is an error). Plans show as one line that updates
  ("plan 1/3 · ▸ Write the fix"). `usage_update` fills the context gauge and the cost, the prompt's
  usage the token counts.
- **Approvals**: a permission request is decided by the agent's permission mode, its "always" list,
  or by asking you. The risk comes from the tool kind: read, search and think are reads; edit,
  delete and move are edits; execute is a command; fetch is network; everything else asks. lu-minal
  answers with the agent's matching option (`allow_always` when you said "always").
- **Plan mode**: lu-minal also switches the session into the agent's own plan mode when it has one
  (OpenCode's `plan`); in every other mode the agent stays in its default mode and keeps asking.
- **Stopping**: Esc sends `session/cancel` and answers open permission requests with "cancelled".
  An agent that doesn't stop within a few seconds is killed; the next message starts it again.
- **Restarts**: the ACP session id is saved with the agent. After a restart (or a crash) lu-minal
  continues the conversation with `session/resume`, or `session/load` (whose replayed history is
  not shown twice), when the agent supports one of them.
- **Files and terminals**: lu-minal does not offer the client file system or terminal capabilities.
  The agents use their own tools, as Claude Code does, and requests for them are answered with an
  error. (OpenCode sends `fs/write_text_file` after an approved edit anyway; it applies the edit
  itself.)
- **Provider errors**: OpenCode retries a failing model provider (a rate limit, "Free usage limit
  reached") for as long as it takes, without a word over ACP. lu-minal starts it with
  `--print-logs --log-level WARN`, reads the error from its log line on stderr and shows it in the
  agent's log ("OpenCode: Free usage limit reached ... (OpenCode keeps retrying; Esc stops the
  turn.)"). OpenCode's own log file then only gets warnings and errors for these sessions. For any
  agent, 90 seconds without a word during a turn are noted in the log as well.

## Your own ACP agents

Any program that speaks ACP over stdio can be added under `acpAgents` in `config.json`. The key is
the provider id (it must not be the id of another provider):

```json
{
  "acpAgents": {
    "goose": {
      "name": "Goose",
      "command": "goose",
      "args": ["acp"],
      "models": ["gpt-6-sol", "claude-sonnet-5-5"],
      "modelArgs": ["--model", "{model}"],
      "env": { "GOOSE_MODE": "approve" },
      "signIn": "Run `goose configure` in a terminal."
    },
    "my-agent": {
      "command": "~/src/my-agent/bin/agent",
      "args": ["--stdio"],
      "toolPrefix": "luminal__"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `command` | The program: a name on the PATH or a path (`~/...` works). Required for custom agents. |
| `args` | Its arguments. |
| `env` | Extra environment variables. |
| `name` | The name shown in pickers (default: the id). |
| `models` | Model ids to offer (`default` is always there). Any id can be typed in `/model`. |
| `modelArgs` | Arguments that pick a model when the agent can't select one over ACP; `{model}` is replaced by the id. |
| `toolPrefix` | How the agent names lu-minal's MCP tools, so the team prompt can name them right (default: the bare name). |
| `signIn`, `docs` | Shown when the agent asks for a sign-in. |

An entry with the id `opencode-cli` or `gemini-cli` changes that builtin agent instead, e.g. another
path: `"opencode-cli": { "command": "C:/tools/opencode/opencode.exe" }`. Its `args`, when given,
replace the builtin arguments; `models` are added to the builtin list.

## Code

| File | What it is |
| --- | --- |
| `src/agents/acp/rpc.ts` | JSON-RPC 2.0 over newline-delimited JSON: requests, notifications, incoming requests, framing. |
| `src/agents/acp/presets.ts` | The agents (OpenCode, Gemini CLI, `acpAgents`), finding their programs, their environment. |
| `src/agents/acp/models.ts` | Model lists: `opencode models --verbose` (cached), static lists, `default`. |
| `src/agents/acp/display.ts` | Tool rows, diffs, risks, permission options, stop reasons, plans, modes. |
| `src/agents/acp/driver.ts` | `AcpDriver`: the process, the session, the stream into the agent's log, approvals. |
| `src/providers/registry.ts` | ACP agents as providers of kind `acp` (connected = installed). |
| `test/fixtures/fake-acp-agent.mjs` | A fake ACP agent with OpenCode's message shapes, for the tests. |
