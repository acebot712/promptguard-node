# Contributing to PromptGuard Node.js SDK

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | >= 20.0.0 | [nodejs.org](https://nodejs.org/) |
| npm | latest | Comes with Node.js |

## Quick Start

```bash
git clone https://github.com/acebot712/promptguard-node.git
cd promptguard-node
npm install
npm test                # Run tests
npm run build           # Compile TypeScript
```

## Development Workflow

### Build

```bash
npm run build           # Compile TypeScript to dist/
```

### Code Quality

```bash
npm run lint            # Type check (tsc --noEmit) + Biome check
npm run check           # Biome check only (lint + format)
npm run format          # Auto-fix formatting with Biome
npm run format:check    # Check formatting without fixing
```

The project uses [Biome](https://biomejs.dev/) for linting and formatting (not ESLint/Prettier).

## Testing

### Running Tests

```bash
npm test                # Run all tests with coverage
```

This runs Jest via `node --experimental-vm-modules` (required for ESM support in ts-jest).

### Test Files

| File | What it tests |
|---|---|
| `tests/client.test.ts` | HTTP client (request building, error handling, retries) |
| `tests/guard.test.ts` | Guard API (scan, redact, validate-tool) |
| `tests/patches.test.ts` | Auto-instrumentation monkey-patching of LLM SDKs |
| `tests/integrations.test.ts` | Framework integrations (LangChain, Vercel AI) |
| `tests/contract.test.ts` | Contract tests against `guard-contract.json` |

### Contract Tests

`tests/contract.test.ts` validates SDK behavior against `tests/guard-contract.json`, a shared contract that defines expected request/response shapes. The Python SDK uses the same contract file to ensure both SDKs behave identically.

### Coverage Thresholds

Coverage is enforced in `jest.config.js`:

| Metric | Minimum |
|---|---|
| Branches | 35% |
| Functions | 45% |
| Lines | 50% |
| Statements | 50% |

Tests will fail if coverage drops below these thresholds.

### Environment Variables

Tests mock the API by default. To run against a live API:

```bash
PROMPTGUARD_API_KEY=pg_test_... PROMPTGUARD_BASE_URL=http://localhost:8080 npm test
```

| Variable | Default | Description |
|---|---|---|
| `PROMPTGUARD_API_KEY` | (none) | API key for live testing |
| `PROMPTGUARD_BASE_URL` | `https://api.promptguard.co` | API base URL |

## CI/CD

CI runs on every push to `main` and on PRs (`.github/workflows/ci.yml`):

| Job | What it does |
|---|---|
| **Lint & Type Check** | `npx biome check .` + `npx tsc --noEmit` |
| **Test** | `npm test` on Node 20 and 22 |
| **Build** | `npm run build` + `npm pack --dry-run` |

Reproduce CI locally:

```bash
npm run lint && npm test && npm run build
```

## Releasing

Releases are triggered by creating a GitHub Release:

1. Update `version` in `package.json`
2. Commit and push to `main`
3. Create a GitHub Release (tag format: `v1.5.3`)

The release workflow (`.github/workflows/release.yml`):

1. Validates (lint, type check, test, build)
2. Checks if the version already exists on npm
3. Publishes to npm with `--provenance` (trusted publishing)

Requires `NPM_TOKEN` secret in GitHub repo settings.

## PR Checklist

- [ ] `npm run lint` passes (Biome + tsc)
- [ ] `npm test` passes with coverage thresholds met
- [ ] `npm run build` succeeds
- [ ] New functionality has tests
- [ ] Contract tests updated if request/response shapes changed
- [ ] PR description explains the change

## Reporting Issues

Open an issue at https://github.com/acebot712/promptguard-node/issues with:

- Node.js version (`node --version`)
- SDK version (`npm ls promptguard-sdk`)
- Minimal reproduction steps
