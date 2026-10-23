# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`Unreleased` holds work that is merged but not yet published. Move entries into
a dated version section when a release goes out — an `Unreleased` block that
survives three releases is a changelog nobody is maintaining.


## [Unreleased]

## [2.4.1] — 2026-10-23

### Changed

- **Generated API types and the cross-SDK `/guard` contract (v1.8.0) synced
  from the published spec.** Threats now carry the `threshold` they were
  compared with (`band`, `warn`, `block`, `score`), and an `allow` can report a
  flagged threat in its detector's warn band. Types only; no change to how the
  client decides.

## [2.4.0] — 2026-10-18

### Added

- **`sessionId` for the Vercel AI SDK and LangChain.js integrations**
  (acebot712/promptguard#956). A Vercel AI call names its conversation with
  `providerOptions: { promptguard: { sessionId } }` (`providerMetadata` on ai 4),
  and `promptguard()`, `promptGuardMiddleware()` and the LangChain.js handler
  take a `sessionId` option for a conversation the call does not name; the
  call's own id wins over it. Auto-instrumentation sends an OpenAI Responses
  call's `conversation` as `session_id`. See "Conversations" in the README.
  A session id over 255 characters is dropped with a debug log and the scan
  goes ahead without one; passed as an option, it is a `TypeError`.
- **`promptguard(model)` for the Vercel AI SDK**
  (`promptguard-sdk/integrations/vercel-ai`). Wraps a language model so its
  calls are scanned exactly as `promptGuardMiddleware` scans them under
  `wrapLanguageModel`, for `generateText()` and `streamText()` alike, and
  takes the same options. The wrapped model keeps the original's own
  specification version, provider, model id and other properties, and its
  type, so it goes wherever the original went, frozen models included
  (acebot712/promptguard#976). It does not import `ai`, so it works with
  ai@7, which is ESM-only, from this CommonJS package. It wraps the models of
  ai 5, 6 and 7 (specification V2, V3 and V4); given an ai 4 (V1) model it
  throws a `TypeError` that points at `promptGuardMiddleware`, which still
  serves ai 4. The `ai` peer range is unchanged.
- **`promptGuardMiddleware()` no longer needs `apiKey`.** It falls back to
  `PROMPTGUARD_API_KEY`, as it already did at runtime; only the type required
  it.

- **`instrumentationReport().middleware`**, cross-SDK contract v1.7.0: the
  request-edge middleware alive in the process. Always `[]` here, since this SDK
  has none; the Python SDK's new ASGI/FastAPI middleware reports `fastapi`
  (acebot712/promptguard#945). The key exists in both so one health check
  reads the same in either language.
- **`streamWindowChars` option for the Vercel AI SDK middleware.** How many
  new characters of streamed output enforce mode collects before scanning
  (default `1000`, chosen to balance how long text is held against Guard API
  round trips; `Infinity` holds the whole response for one scan). Invalid
  values throw a `RangeError` when the middleware is created.

### Changed

- **The LangChain.js handler sends the call's thread id as `session_id`, or
  none** (acebot712/promptguard#956). It used to send each call's run id, so
  no two scans ever shared a session. It now sends the call's `thread_id`
  (from LangGraph, or from the call config's `metadata`, where `session_id`
  and `conversation_id` are read too) on the start scan and the end scan
  alike, and a call with no thread sends no `session_id` at all.
- `SECURITY.md` links to the published disclosure policy
  (https://promptguard.co/security#reporting-a-vulnerability) instead of
  keeping its own copy of the response times.

- **Streamed output from the Vercel AI SDK middleware is now delivered after
  it is scanned.** With `scanResponses: true` in enforce mode, text arrives in
  bursts, each after one Guard API round trip, instead of token by token: each
  window is scanned before it is released, and the last 200 characters of
  every window are held and rescanned with the next, so a secret up to 200
  characters long is always seen whole across a window boundary. The complete
  text is scanned again before the stream finishes. Parts that carry no
  scanned text (reasoning, sources, metadata) are not held unless text is
  queued ahead of them. A stream can now end in an error:
  `PromptGuardBlockedError` on a block, or the `GuardApiError` when the Guard
  API is unreachable and `failOpen` is `false`. Monitor mode never holds the
  stream and scans the complete text at the end.

### Fixed

- **Guard requests from the Vercel AI SDK integration now name the model.**
  The middleware read the model id from the call options, where the AI SDK
  never puts it, so every input and output scan reached the Guard API with
  no model. It now takes the id from the model the AI SDK hands its hooks,
  for generated and streamed calls, and `promptguard(model)` does the same.
- **A blocked streamed output no longer hangs ai@5's `await result.text`.**
  The middleware stopped a blocked stream by erroring it, and ai@5 never
  settles `result.text` on an errored stream. For a V2 model (the version
  ai@5 drives) a block, or a fail-closed `GuardApiError`, now ends the stream
  with the AI SDK's `error` part and closes it: `onError` and `fullStream`
  get the error, `result.finishReason` resolves `'error'`, and `textStream`,
  `result.text` and `toTextStreamResponse()` end with the text released
  before the block. V3 and V4 models (ai@6, ai@7) still error the stream, so
  reading it throws; a V2 model under ai@6 or ai@7 gets the error part too.
- **The README now says how a blocked stream reaches `streamText()`**, for
  each case and specification version. It said `onError` and an `error`
  part; on ai@6 and ai@7 that holds only for a blocked prompt, since blocked
  output is thrown from whatever reads the stream and never reaches
  `onError`.
- **`promptGuardMiddleware()` now type-checks with the real `ai` types.**
  Passing it to `wrapLanguageModel` was a TypeScript error on ai@5, ai@6 and
  ai@7: `transformParams` returned `Record<string, unknown>` where each
  expects its call options, and ai@6 also requires
  `specificationVersion: 'v3'` on the middleware. Its hooks are now generic
  over what they pass through, and it carries `specificationVersion: 'v3'`,
  which ai@7 accepts and ai@5 ignores. Runtime behaviour is unchanged.
- **The Vercel AI SDK middleware now scans streamed output.** With
  `scanResponses: true`, `streamText()` output used to reach the application
  unscanned (`wrapStream` only logged the skip), so a streamed secret or PII
  was never blocked. It is now scanned with the same text, decisions and
  fail-open policy as `generateText()` output (acebot712/promptguard#961). A
  Guard API outage mid-stream releases the held parts and leaves the rest of
  that stream unscanned (`failOpen: true`, the default).

### Security

- `sprintf-js` is gone from the dev toolchain (GHSA-hp3w-g68c-fv3c, medium, no
  patched release). It arrived only through `js-yaml` 3, which the coverage
  tooling asks for and which an override here had held on the 3.x line. The
  override now selects `js-yaml` 4, whose `argparse` does not use it. Dev-scope
  only: no published version of this package ever installed it.

## [2.3.0] — 2026-10-10

**No runtime change.** Generated types and development tooling only. The
version is a minor one to stay level with the Python SDK, whose 2.3.0 ships the
same type sync in a module that can be imported.

### Changed

- **Generated API types re-synced from the platform's OpenAPI spec** (#52).
  Additive: nothing was removed or renamed.
  - `GuardRequest.device_findings` (`DeviceFinding[]`, optional): what a
    Device's own masker caught before sending, as category and count pairs.
  - `GuardResponse.unavailable` (`UnavailableCheck[]`, optional): detectors the
    scan would have run but the deployment cannot, each with a reason. An
    `allow` with a non-empty `unavailable` does not mean every check passed.
  - `ThreatType`, the union of threat categories the API returns.
  - Device and Shadow response shapes: `DeviceIdentity`, `DeviceView`,
    `DeviceViewList`, `DeviceRevokedResponse`, `DeviceShadowException`,
    `DeviceShadowExceptionList`, `DeviceToolRequest`, `DeviceToolRequestList`,
    `ActiveGrant` and `ActiveGrantList`.
  - Proxy response shapes: `ProxyChatCompletion`, `ProxyAnthropicMessage`,
    `ProxyResponsesObject`, `ProxyModelList` and `ProxyTokenCount`.
  - Other response shapes: `UsageStatsResponse`, `ApiKeyToggledResponse`,
    `AgentSecurityHealthResponse`, `AgentSessionEndedResponse`,
    `ApiHealthResponse`, `ApiRootResponse`, `ApiVersionProbeResponse` and
    `WebhookAckResponse`.

  As in 2.2.0, none of this is importable from the package: nothing under
  `src/` imports `src/generated/api-types.ts` and the `exports` map publishes
  no `./generated` subpath. The hand-written `GuardRequestBody` and
  `GuardResponseBody` types the SDK exports are unchanged, so the SDK does not
  send `device_findings` or type `unavailable` yet.

- Development tooling only: development dependencies bumped (#55),
  `biome.json` migrated off the deprecated `recommended` field (#54), and the
  type sync now formats its output so its pull request passes lint (#53).

### Security

- **brace-expansion advisories patched** (2.1.7 and 5.0.12). A development
  dependency of the test and build tooling; no runtime code changes.
- **handlebars moved to 4.7.10** for three advisories. Reached only through
  the test coverage reporter; nothing published was affected.

## [2.2.1] — 2026-09-18

### Security

- **browserslist prototype-write advisory patched** (#51). A development
  dependency of the build; no runtime code changes. Published so installs of
  this package no longer resolve the vulnerable version.

### Changed

- **Generated types and the cross-SDK contract re-synced from the platform API**
  (#50). Types only.


## [2.2.0] — 2026-09-06

**No user-facing change.** This release keeps the Node SDK's version in step
with `promptguard-sdk` 2.2.0 on PyPI, which the cross-SDK contract pairs it
with. Everything below is internal, and it is recorded rather than omitted so
the version bump is not unexplained.

### Changed

- The generated API types were re-synced from the spec: `tokenize` joins the
  `pii_detection.mode` literal, `multi_turn_drift` appears on the detector
  configuration, `ApiKeyFullResponse` is gone with the key-reveal endpoint it
  described, and the managed-update-policy docstring names the
  `shadow_fleet_management` entitlement.

  **None of this is reachable from the package.** Nothing under `src/` imports
  `src/generated/api-types.ts`, and the `exports` map publishes no `./generated`
  subpath, so the file ships in the tarball without being importable. The Python
  SDK's equivalent module *is* importable, which is why the same sync is a
  user-facing entry there and an internal note here.

- The auto-instrumentation report is covered by the cross-SDK contract, and the
  SDK's domain model is written down.

## [2.1.0] — 2026-08-30

### Added

- Generated API types for the full per-guardrail project configuration:
  `GuardrailsConfig`, `LevelConfig`, `PIIDetectionConfig`, `ToxicityConfig` and
  `ToggleOnlyConfig`. Synced from the platform's OpenAPI spec, so a client
  configuring guardrails has types for the shape the API accepts instead of
  hand-writing objects.

Additive only — nothing in 2.0.0 changed behaviour or signature.

## [2.0.0] — 2026-08-24

### Fixed

- **The red team client was unreachable for every customer.** Every method on
  `pg.redteam` targeted `/internal/redteam`, which is the platform-admin plane
  and rejects an API key outright — so the namespace could not have worked for
  anyone holding a `pg_live_` key, whatever they did. It now targets the
  customer-facing `/api/v1/security-testing`.

### Removed

- **BREAKING — three namespaces that could only ever 404 are gone**, along with
  the types that described them. `pg.completions`, `pg.embeddings` and
  `pg.scrape` called endpoints the API does not serve, as did
  `pg.redteam.runAutonomous()` and `pg.redteam.intelligenceStats()`. Nothing
  that worked has been taken away — but this is a major version because the
  removed **types** were exported, so code that merely `import type`s them
  compiles today and will not after: `AutonomousRedTeamReport`,
  `AutonomousRedTeamRequest`, `CompletionRequest`, `CompletionResponse`,
  `EmbeddingRequest`, `EmbeddingResponse`, `IntelligenceStats`, `ScrapeResult`.

  If you are affected, the fix is to delete the import — there is no
  replacement, because there was never a working implementation behind it. For
  chat traffic, use `pg.chat.completions.create(...)`, which is unchanged.


## [1.13.0] — 2026-08-19

### Changed

- **Generated API types resynced with the published spec.** Three changes reach
  callers:
  - `GuardMessage.content` widens from `string` to
    `string | Array<Record<string, unknown>>`. The API has accepted
    OpenAI/Anthropic content-block arrays for a while; the types said otherwise,
    so passing one type-checked as an error. Widening only — existing string
    callers are unaffected.
  - `GuardResponse.unscanned` is new (`UnscannedAttachment[]`). It lists the
    parts of a request that reached the API and produced nothing to scan. Worth
    reading rather than ignoring: an `allow` with a non-empty `unscanned` means
    "the text was clean and these parts were never read", not "this content is
    clean".
  - `CreateProjectRequest.strictness_level` narrows from `string` to
    `"strict" | "moderate" | "permissive"`. **This can fail a compile that
    previously passed** — but only where the value being passed was never
    accepted by the API in the first place, which the old type let through
    silently.

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
