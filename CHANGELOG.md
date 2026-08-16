# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`Unreleased` holds work that is merged but not yet published. Move entries into
a dated version section when a release goes out — an `Unreleased` block that
survives three releases is a changelog nobody is maintaining.


## [Unreleased]

## [1.12.0] — 2026-08-16

### Added

- **`verify()` — a positive check that protection is actually live.** `init()`
  resolving has never meant anything is being scanned: the SDK fails open, so a
  rejected API key, an unreachable Guard API or a provider SDK we never hooked
  all leave an application that runs perfectly and blocks nothing. In a
  native-ESM app, where the patches may never attach at all, that is the default
  rather than the edge case. Each of those already logged a warning, but a
  warning in a log nobody tails is indistinguishable from silence. `verify()`
  makes the real calls — reachability, authentication, a live injection probe, a
  PII probe — and returns what came back, so a deployment can assert it instead
  of assuming it. The checks and their names mirror `promptguard verify` in the
  CLI and `promptguard.verify()` in the Python SDK so all three agree on what
  "working" means. It never rejects for a failed check, so CI sees every problem
  at once rather than only the first, and it retries once rather than three
  times — a diagnostic that takes seven seconds of backoff to report a dead host
  is a diagnostic nobody waits for.
- **`PromptGuard.baseUrl`** — the base URL requests actually go to, after the
  `/proxy` suffix is applied. Previously only readable from the private config,
  which meant anything reporting on the client had to guess or re-derive it.

## [1.11.0] — 2026-08-11

### Fixed

- **Gemini calls made through `@google/genai` were not being scanned.**
  Auto-instrumentation patched `@google/generative-ai`, the SDK Google
  deprecated with Gemini 2.0. Both are now patched. Note this one could not be
  patched on the prototype like every other adapter: `@google/genai` assigns
  `generateContent` as an own property in the constructor, so the exported
  `GoogleGenAI` class is wrapped instead.

### Added

- **An installed provider SDK we did not hook is now named at startup**, with
  the one-line fix (point that client at the proxy). Previously `init()` warned
  only when it applied zero patches, so partial coverage was silent.
- `instrumentationReport()` — coverage as data, assertable in your own CI.

### Changed

- `@ai-sdk/openai` (Vercel AI SDK) is listed as **not** auto-instrumented.
- Two high-severity advisories pinned out of the dev toolchain (`js-yaml`,
  `brace-expansion`). Both are dev-scope and were never installed by anyone
  consuming this package, so no published version exposed a user.
  Verified rather than assumed: it declares no dependency on the `openai`
  package and issues its own HTTP calls, so the patch never sees them. It is
  fully covered by the proxy.


<!-- Entries below are reconstructed from git tags: this file did not exist
     until 2026-08-11, so the tag subject is all the detail anyone recorded.
     Accurate about WHAT shipped, thin on WHY. Entries from here on are
     written when the release is cut -- scripts/check-changelog.mjs fails the
     release if the version being published has no section. -->

## [1.10.1] — 2026-08-03

### Changed

- v1.10.1 — dependency updates and generated-type sync

## [1.10.0] — 2026-07-12

### Changed

- chore(release): 1.10.0

## [1.9.0] — 2026-06-01

### Changed

- feat: leveled logger, security-safe error logging, scan ergonomics (v1.9.0) (#20)

## [1.8.0] — 2026-04-11

### Changed

- fix: update version expectations in tests for v1.8.0

## [1.7.1] — 2026-04-10

### Changed

- chore: update model references to gpt-5-nano in docs and tests

## [1.7.0] — 2026-04-07

### Changed

- feat: add API contract testing, OpenAPI validation, and quota error handling

## [1.6.0] — 2026-04-06

### Changed

- fix: update test version assertions to match v1.6.0

## [1.5.3] — 2026-04-05

### Changed

- chore: bump version to 1.5.3

## [1.5.2] — 2026-03-25

### Changed

- v1.5.2: format and lint fixes

## [1.5.1] — 2026-02-28

### Changed

- Use Node 24 for publish job (npm 11.5.1+ required for trusted publishing)
