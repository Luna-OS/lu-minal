# Providers and models

lu-minal runs each agent on a model written as `provider/model`:

```
claude-code/opus             Claude Opus through your Claude subscription (Claude Code)
opencode/big-pickle          a free OpenCode Zen model - no key needed
openrouter/qwen/qwen3-coder:free
minimax/MiniMax-M3
anthropic/claude-sonnet-5-5  Claude through an Anthropic API key
ollama/qwen3-coder           a local Ollama model
```

`lu-minal models` lists every model, `lu-minal models --free` the free ones, and
`lu-minal models minimax` searches. In the app, ctrl+o (or `/model`) picks the focused agent's model.

## Where the list comes from

The provider and model list is [models.dev](https://models.dev)'s catalog – the same one the
OpenCode CLI uses – downloaded once a day into lu-minal's cache folder. Without a network, lu-minal
uses the last download, or a small built-in list.

Each provider speaks one of three protocols, which lu-minal implements itself:

| Protocol | Used by |
| --- | --- |
| OpenAI chat completions | OpenCode Zen, OpenRouter, Google Gemini, Groq, DeepSeek, Z.ai, Moonshot, xAI, Mistral, Together, Fireworks, Cerebras, Ollama, LM Studio and ~190 other OpenAI-compatible APIs |
| Anthropic Messages | Anthropic, MiniMax, some OpenCode Zen models |
| OpenAI Responses | OpenAI |

Providers that need their own SDK (Amazon Bedrock, Google Vertex, Azure) show as unsupported
unless you give them an OpenAI-compatible base URL (below).

## Signing in

| Provider | |
| --- | --- |
| `claude-code` | Your Claude account (Pro, Max, Team, Enterprise) through the official Claude Code CLI. lu-minal never reads its tokens; it runs `claude` in your project. ctrl+l → Claude installs Claude Code if it is missing and runs `claude auth login`. |
| `opencode` | Free models without anything. For paid Zen models, add a key from opencode.ai. |
| `openrouter` | ctrl+l → OpenRouter → "Sign in with the browser": OpenRouter's OAuth (PKCE) creates a key for lu-minal. Or paste a key. |
| everything else | Paste an API key in ctrl+l, run `lu-minal login <provider> <key>`, or set the provider's environment variable (`lu-minal providers` shows which). |

## Your own endpoints

Add any OpenAI-compatible server (vLLM, LiteLLM, a company gateway) in `config.json`:

```json
{
  "providers": {
    "my-gateway": {
      "name": "My gateway",
      "baseURL": "https://llm.example.com/v1",
      "wire": "openai-chat",
      "headers": { "X-Team": "moon" },
      "models": ["qwen3-coder-480b", "llama-4-maverick"]
    }
  }
}
```

and its key with `lu-minal login my-gateway <key>`. The same block overrides a catalog provider,
e.g. `"anthropic": { "baseURL": "https://my-proxy/v1" }`.

## Plan limits and costs

- Claude: the 5-hour session and the weekly limit come from Claude Code's own usage report and from
  every running Claude agent's stream; `/usage` shows the details (per-model weekly windows,
  extra usage).
- OpenRouter: the key's usage and limit.
- Everything else: tokens and the catalog's prices, counted per agent (the header shows the tab's
  total).
