# Security model

lu-minal runs on a developer's machine with their API keys, drives Claude Code with their
subscription, and lets models run tools: files, a shell, web fetches, Roblox Luau. Everything a
model reads is treated as untrusted input that may contain instructions, including web pages,
repositories, tool output and teammates' messages. This page lists what lu-minal protects and how.

## What a prompt injection can and can't do

Permissions are enforced in code, never by the model. The permission mode (`ask`, `auto-edit`,
`yolo`, `plan`) and the user's "always" answers are the only things that let an action run without
a question. No tool, message or file can change them.

| Action | ask | auto-edit (default) | plan | yolo |
| --- | --- | --- | --- | --- |
| Plain reads (files, `ls`, `git status`, ...) | free | free | free | free |
| Edits of ordinary project files | ask | free | refused | free |
| Commands, Roblox Luau, Studio edits | ask | ask | refused | free |
| Public web fetches | ask | free | free | free |
| "other": see below | ask | ask | refused | free |

Things that look harmless but aren't are classified as "other", so they always ask, and plan mode
refuses them:

- **Secret stores.** Reads of lu-minal's own config and state folders (`auth.json`, the MCP bearer
  tokens, `session.json`), the usual credential files (`~/.ssh`, `~/.aws`, `~/.netrc`,
  `~/.git-credentials`, `~/.npmrc`, `~/.config/gh`, `~/.claude.json`, browser profiles, shell
  histories, ...) and `/proc/<pid>/` on Linux and in Git Bash. A search (`grep`, `rg`, the grep
  tool, Claude Code's Grep) from a folder that contains one, such as `~`, counts too. Paths are
  checked the way the agent reads them: Claude Code opens `~/.ssh/x` in the home folder and Git
  Bash's `/c/Users/...` as `C:\Users\...`, so every such reading is checked and the strictest
  wins. A secret read followed by a web fetch is the usual way an injection exfiltrates keys.
- **Writes that run on their own.** Edits outside the project (symlinks are followed, a dangling
  one too), in `.git` at any depth (hooks, config), in agents' project settings (`.claude/`,
  `.mcp.json`, `.gemini/`, `.opencode/`, `opencode.json`), in secret stores and in the home
  folder's dotfiles (`.bashrc`, `.zshrc`, ...). Windows and macOS spellings (`.GIT`, `GIT~1`,
  `.git.`) are matched as the file system resolves them.
- **Local network.** Fetches of this machine, private networks, link-local and cloud metadata
  addresses (`169.254.169.254`), `*.local`, `*.internal` and single-label names. `web_fetch`
  follows redirects by hand and checks every hop and, with the system resolver, what the host
  name resolves to (so `rebind.example -> 127.0.0.1` asks as well). Only `http` and `https` are
  fetched.
- **Network shares.** On Windows, opening `\\server\share` makes the system sign in to that server
  with the user's NTLM credentials.
- **Claude cloud sessions.** `cloud_send` asks, because the cloud agent acts with the user's
  claude.ai account and can push branches and open pull requests.

### Shell commands

A command runs without asking only when it plainly reads (`src/tools/command-risk.ts`, shared by
the native `bash` tool and Claude Code's permission prompts):

- Every program must be on a short read-only list (`ls`, `cat`, `grep`, `rg`, `find`, `git status`
  / `diff` / `log` / `show`, ...), named bare or from a system folder (`./cat` is not `cat`).
- Anything the shell expands or runs on its own makes it a command that asks: `$VAR`, `$@`,
  `$'..'`, `$( )`, backticks, `{a,b}`, subshells, here-docs, `<`, background jobs, and redirections
  into files (`>file`, `>&file`, `&>file`). Only the null device and fd duplication (`2>&1`) pass.
  Line continuations are followed like the shell does. PowerShell (`$`, `( )`, `{ }`, `@( )`,
  backtick) and cmd.exe (`%VAR%`, `!VAR!`, `^`, `'` not being a quote) have their own rules.
- Options that run programs or write files make it ask: `find -exec` / `-delete` / `-fprint`,
  `rg --pre` / `--hostname-bin`, `sort -o` and its GNU abbreviations (`--o`, `--out`) and
  `--compress-program`, `tree -o` / `-R`, `file -C`, `date -s`, and git's global options (`-c`,
  `-C`), `--output`, `--ext-diff` and branch changes.
- An unquoted glob never feeds a program where an option can run something: a file named
  `--pre=sh` must not turn `rg foo *` into code execution.
- No word may point into a secret store, a network share, or (with a glob) outside the project.
  `cd` is followed (with an option such as `cd -P` it asks). A glob, `grep -R` and `rg -L` follow
  symlinks, so a link into a secret store where they reach makes them ask; the grep tool skips
  links it finds, as ripgrep does. PowerShell's `-Path:value`, `a,b` arrays and wildcards are
  checked too, and its provider paths (`env:`, `HKCU:`, `FileSystem::...`) ask.

"Always allow" remembers `bash:<first two words>` only for one simple command. A list, pipeline,
substitution or redirection is remembered as the exact text (`bash=<command>`), so an "always" for
`npm test` never covers `npm test && curl … | sh`. Edits remember the tool for ordinary project
files and the exact path for everything else. A local fetch remembers its origin. In plan mode the
mode's "no" wins over every "always".

### Agents talking to agents

A teammate's message arrives as `[message from <name>]`. It is a peer's request, not the user's
word, and the team prompt says so. Team tools never change permissions: `spawn_agent` starts
workers in the project's permission mode (its `instructions` only add to the worker's prompt),
and `stop_agent` can't stop the lead or the caller. Theme names are slugged before they become file
names, and theme files are validated.

ACP agents (OpenCode, Gemini CLI) ask lu-minal before acting. A call is only taken for one of
lu-minal's own tools (whose approvals run in the MCP server) when it has no built-in action kind and
its whole title or name is exactly that tool's name. Titles are often written by the model:
OpenCode's bash title is its `description`, so a command titled `luminal_send_message && rm -rf ~`
is still a command.

### Untrusted workspaces

`claude -p` skips Claude Code's workspace-trust dialog. A repository's `.claude/settings.json` can
hold hooks, an `apiKeyHelper` and allow rules, and its `.mcp.json` can start programs. So a project
nobody trusted yet (`Project.trusted`: a folder the user opened is trusted, a repository cloned from
GitHub or Forgejo is not until the user says so) starts Claude Code with `--setting-sources user
--strict-mcp-config`: only the user's own settings and lu-minal's MCP server.

## Secrets

- `auth.json` (keys and tokens) is written atomically with mode 0600 in a 0700 folder, also on
  updates, and copied to `auth.json.bak` (0600) before a broken file is replaced. Windows relies on
  the profile folder's ACL. The MCP configs (one bearer token per agent) are 0600 in a 0700 folder,
  and so is the Roblox bridge token.
- Keys are never written to `config.json`, `session.json`, `stats.json` or command lines. Git tokens
  reach git through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (git 2.31+), never
  the clone URL or `.git/config`. Only git older than 2.31 gets them as `-c`, where other users of
  the machine could see them in the process list.
- A provider's key is only sent to its own endpoint. The wire clients build headers per request
  (`Authorization: Bearer` or `x-api-key`) from that provider's key only. For the well-known
  providers (Anthropic, OpenAI, OpenRouter, Google, OpenCode, Groq, xAI, Mistral) the key only goes
  to that provider's domain. A tampered models.dev answer or cache file can't point the OpenAI model
  at another host, while a `providers.<id>.baseURL` the user sets in `config.json` is their choice.
- Git tokens are scoped by URL (`http.https://github.com/.extraheader`, the Forgejo instance's own
  URL), so a GitHub token never goes to a Forgejo host or over plain http. curl drops the header on
  a redirect to another host. Clones run with `GIT_TERMINAL_PROMPT=0` and `GIT_ALLOW_PROTOCOL`
  (no `ext::`), and option-like clone URLs are refused.
- Known secrets are redacted (`[redacted]`) from every tool result a model reads and from error
  rows. This covers stored keys, secret-looking environment variables (`*_API_KEY`, `*_TOKEN`, ...),
  MCP tokens and git tokens in plain and basic-auth form. It is defense in depth: Claude Code's own
  tools and ACP agents' tools don't pass through lu-minal.

## Local servers

All three listen on loopback only (`127.0.0.1`, plus `::1` for the OAuth callback).

- **MCP server** (Claude Code and ACP agents): a random 256-bit bearer token per agent, compared
  as SHA-256 digests in constant time before the body is read. Each agent's URL only serves that
  agent. It refuses a `Host` that isn't its own loopback address and port (DNS rebinding) and any
  non-local `Origin`. It sends no CORS headers, so browsers can't add the `Authorization` header.
  Bodies are limited to 4 MB, headers must arrive within 15 s and the whole request within 120 s
  (approvals wait after that, without a limit).
- **Roblox Studio bridge**: every request needs the `X-LuMinal-Plugin` header, which a web page
  can't send without a CORS preflight the bridge never approves. Requests with an `Origin` or
  `Sec-Fetch-Site` header, a non-loopback `Host`, or `OPTIONS` are refused, and bodies are limited
  to 16 MB. With a bridge token (`src/roblox/token.ts`, baked into the plugin by the installer),
  the bridge also requires `X-LuMinal-Token`, so another program on the machine can't pose as
  Studio, take the agents' commands or feed them results. `roblox_run_luau` is an "exec" action.
- **OpenRouter sign-in** (OAuth PKCE): a 256-bit verifier with S256, one code exchange per sign-in
  against a fixed https URL, a 5-minute limit, and an HTML-escaped answer page.

## Known limits

- In `auto-edit` mode, reads and public web fetches are free. An injection can still read ordinary
  project files (including a project's own `.env`) and send them to a public URL. Use `ask` mode for
  untrusted content. lu-minal blocks the well-known secret stores, not every secret.
- Claude Code's own tools run inside Claude Code: lu-minal decides only what Claude Code asks it
  about (`--permission-prompt-tool`). In `auto-edit` mode Claude Code accepts in-project edits
  itself.
- ACP agents load their own project config (`opencode.json`, `.gemini/settings.json`), which can
  start MCP servers or loosen the agent's permission rules, before lu-minal is asked anything. Only
  start them in repositories you trust.
- The Roblox plugin trusts whatever answers on its port: a program that takes the port before
  lu-minal starts could drive Studio. lu-minal then reports the port as busy.
- `web_fetch` checks DNS before connecting, but a name that changes its answer between the check
  and the connection (fast DNS rebinding) is not caught.
- A web page can make the browser call the OpenRouter callback and end a sign-in early. It can't
  sign the user in to another account, because PKCE ties the code to lu-minal's verifier.
