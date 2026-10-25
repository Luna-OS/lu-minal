# lu-minal – instructions for agents

## Language: English only

Everything in this repository is written in **English**, even when a request, issue or task is
written in German (or any other language): translate the intent and write the result in English.
That covers the UI (labels, hints, dialogs, toasts, sample data), the code (identifiers, comments,
log messages, test names), docs, and git (commit messages, PR titles and descriptions).

Before opening a pull request, check your changes for umlauts:

```sh
git diff origin/main --name-only | xargs grep -n -P "[\x{C4}\x{D6}\x{DC}\x{E4}\x{F6}\x{FC}\x{DF}]"
```

## Stack

- TypeScript (strict, ESM, `module: NodeNext`) on Node 22+. Relative imports end in `.js`.
- The UI is [Ink 8](https://github.com/vadimdemedes/ink) + React 19 (`src/ui/`). State lives outside
  React in `src/core/` and reaches components through `useSyncExternalStore` (`src/ui/store.ts`),
  so the UI can be suspended and remounted without losing anything.
- No AI SDKs: the three wire protocols (OpenAI chat completions, OpenAI Responses, Anthropic
  Messages) are small hand-written clients in `src/providers/wire/`. The provider list and the model
  catalog come from [models.dev](https://models.dev) (`src/providers/catalog.ts`).
- Claude with a subscription never uses an API key: lu-minal drives the official `claude` CLI
  (`src/agents/claude-code/`) and never reads its tokens.
- Tests use Vitest (`test/**/*.test.ts`). Network calls are always faked with an injected `fetch`.

## The Moon look

lu-minal is one of the Luna-OS Moon apps and keeps the family's night-sky palette (`night-950
#0b0920`, `lavender-400 #b9aefb`, `mint-400 #7fe3c6`, ...). Components read colours from the active
theme (`src/themes/`), never raw hex values. Axo, the pixel axolotl, lives in `src/ui/axo/`.

## Checks before a pull request

```sh
npm run typecheck
npm test
npm run build
```
