# AGENTS.md

Node.js SDK for PromptGuard, published as `promptguard-sdk` on npm from a
public repo. It secures LLM calls three ways: the `PromptGuard` client (proxy
mode), `init()` auto-instrumentation that patches installed provider SDKs, and
framework integrations (LangChain.js, Vercel AI SDK). Domain vocabulary is in
`CONTEXT.md`; layout is the `src/` and `tests/` tree itself.

## Setup

```bash
npm install                 # npm, not pnpm: package-lock.json is the lockfile
pre-commit install          # tracked hooks, once per clone (commit + push stages)
```

## Before you hand back a change

After editing TypeScript, run `npm run format` then `npm run check` (Biome is
the only linter and formatter here). The CI gate, reproduced locally, is
`npm run lint && npm test && npm run build`; `lint` is `tsc --noEmit` plus
Biome. Run tests through `npm test`: it starts Jest under
`--experimental-vm-modules`, which a bare `jest` call omits. Coverage
thresholds in `jest.config.js` fail the suite; add tests rather than lowering
them. Commands, coverage and CI jobs: `CONTRIBUTING.md`.

## Rules

- **Public API**: keep it small (`init()`, the `PromptGuard` client, framework
  integrations). A breaking change ships only with a major version bump.
- **Dependencies**: the package has zero runtime dependencies; provider SDKs
  are optional `peerDependencies`. Raise any new runtime dependency for
  discussion before adding it.
- **Output**: `dist/` is compiled CommonJS and gitignored.
- **Guard contract** (`tests/guard-contract.json`): shared with the Python SDK
  and pinned by `tests/guard-contract.lock.json`, so a hand edit fails the
  suite. Change it upstream in coordination with the Python SDK and adopt it
  via `scripts/sync-guard-contract.ts`; read `docs/adr/0001-shared-guard-contract.md`
  before touching it. `src/generated/` is likewise produced by the weekly
  `sync-from-api` workflow.
- **Commits**: imperative mood ("Add X"), describing the change from the SDK
  user's perspective, referencing issues when there is one.

## Secrets

Keep API keys, tokens and credentials out of every commit. The repo is public
and the package is on npm, so a credential reaching `main` is world-readable
at once and must be rotated, not reverted.

Two gitleaks scans guard it, both scoped to the pushed range: the pre-push hook
(`scripts/hooks/gitleaks-push.sh`) and the `secret-scan.yml` workflow. Scanning
the whole tree or history would fail on the first run and teach everyone
`--no-verify`. When a scan flags a fixture that is meant to look like a
credential, give it an obviously fake shape or allowlist its path in
`.gitleaks.toml` (create the file if absent) so the exemption is reviewable;
fix the finding rather than bypassing the hook.

## GitHub holds no secrets

**Change a secret in Secret Manager; GitHub holds none.** Workflows read every
secret at run time from Google Secret Manager (`promptguard-production-472014`),
signed in as this repository through Workload Identity; GitHub keeps only
identifiers, as variables (`vars.*`). A workflow that names any `secrets.*` but
`GITHUB_TOKEN` fails CI (`scripts/check_no_github_secrets.py`). The inventory,
and how to add a secret with its per-secret grant:
[`ENVIRONMENT_VARIABLES.md` § CI/CD-only](https://github.com/acebot712/promptguard/blob/main/docs/04_engineering/reference/ENVIRONMENT_VARIABLES.md#cicd-only)
in the platform repo.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, worked via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/` at the repo root; add to them as terms and decisions settle. See `docs/agents/domain.md`.
