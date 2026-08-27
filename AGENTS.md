# AGENTS.md

## Overview

Node.js SDK for PromptGuard (`promptguard-sdk` on npm). Provides auto-instrumentation for LLM SDKs (OpenAI, Anthropic, Google, Cohere, Bedrock), a Guard API client, and framework integrations (LangChain.js, Vercel AI SDK).

## Repository Layout

```
src/
├── index.ts           # Public exports
├── client.ts          # HTTP client (proxy mode)
├── guard.ts           # Guard API client
├── auto.ts            # Auto-instrumentation (init())
├── patches/           # SDK monkey-patches
└── integrations/      # Framework integrations

tests/
├── client.test.ts
├── guard.test.ts
├── patches.test.ts
├── integrations.test.ts
└── contract.test.ts

dist/                  # Compiled output (not committed)
```

## Setup

```bash
npm install
pre-commit install          # tracked git hooks; once per clone
```

`pre-commit install` wires both stages. The push stage runs one thing: a
gitleaks scan of the commits you are pushing. It is scoped to that range on
purpose — this package is published to npm and the repo is public, so a
credential reaching `main` is world-readable at once, while scanning the whole
tree or the history fails on its first run and teaches everyone `--no-verify`.
CI here runs no secret scanning, so this hook is the only one there is. A
fixture that is meant to look like a credential belongs in `.gitleaks.toml`,
not behind a bypass.

## Building and Testing

```bash
npm run build                    # Compile TypeScript (tsc)
npm test                         # Run all tests (Jest)
npm run lint                     # TypeScript type check (tsc --noEmit)

# Live API tests (optional)
PROMPTGUARD_API_KEY=pg_... PROMPTGUARD_BASE_URL=https://api.promptguard.co npm test
```

## Code Quality

```bash
npm run check                    # Biome lint
npm run format                   # Biome format
npm run format:check             # Check formatting
```

Always run `npm run check` and `npm run format` after editing TypeScript files.

## Coding Standards

- Node.js >= 20, TypeScript strict mode
- Biome for linting and formatting (not ESLint/Prettier)
- Jest for testing with `ts-jest` and `--experimental-vm-modules`
- Keep the public API surface small: `init()`, `PromptGuard` client, framework integrations
- No runtime dependencies beyond what's in `package.json` without discussion
- Compiled output goes to `dist/` (CommonJS)

## Commit Messages

- Imperative mood: "Add X" not "Added X"
- Focus on what changed from the user's perspective
- Reference issues when applicable

## Boundaries

### Never
- Commit API keys, tokens, or credentials
- Add heavyweight runtime dependencies
- Break the public API without a major version bump
- Modify the contract test spec without coordinating with the Python SDK

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, worked via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/` at the repo root, both created lazily. See `docs/agents/domain.md`.
