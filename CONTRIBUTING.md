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

One `tests/<area>.test.ts` per module (`client`, `guard`, `patches`,
`integrations`, `vercel-ai-*`, `session-id*`, `verify`, ...). The `*-types.test.ts`
files are compile-time only: `readme-types` keeps the README's type imports
valid, and `vercel-ai-types` compiles the integration against ai 5, 6 and 7.

### Contract Tests

`tests/contract.test.ts` validates SDK behavior against `tests/guard-contract.json`, a shared contract that defines expected request/response shapes. The Python SDK uses the same contract file to ensure both SDKs behave identically.

### Coverage Thresholds

Coverage is enforced in `jest.config.js`:

| Metric | Minimum |
|---|---|
| Branches | 55% |
| Functions | 55% |
| Lines | 68% |
| Statements | 65% |

Tests will fail if coverage drops below these thresholds.

### No live-API mode

The whole suite is mocked: no test makes a network call, and no test reads
`PROMPTGUARD_BASE_URL`. Setting `PROMPTGUARD_API_KEY` does not make any test call
a real API; the tests that depend on it set or clear it themselves, so a key in
your shell cannot change their result. To try the SDK against a real backend, write a
throwaway script that imports `dist/` after `npm run build`.

## CI/CD

CI runs on every push to `main` and on PRs (`.github/workflows/ci.yml`):

| Job | What it does |
|---|---|
| **Lint & Type Check** | `npx biome check .` + `npx tsc --noEmit` |
| **Test** | `npm test` on Node 20 and 22 |
| **Validate API Contract** | Downloads the developer OpenAPI spec and checks SDK types against it (`tests/validate-openapi.ts`) |
| **Build** | `npm run build` + `npm pack --dry-run` + `npm run test:pack` (CJS + ESM packaging smoke test) |

Secret scanning runs separately in `.github/workflows/secret-scan.yml`.

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

No token: npm trusted publishing trusts this repository's `release.yml` and mints a one-run credential from its OIDC token. GitHub holds no secrets; the one the release reads, the `#releases` webhook, comes from Google Secret Manager.

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
