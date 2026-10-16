[![npm version](https://img.shields.io/npm/v/promptguard-sdk)](https://www.npmjs.com/package/promptguard-sdk)
[![CI](https://github.com/acebot712/promptguard-node/actions/workflows/ci.yml/badge.svg)](https://github.com/acebot712/promptguard-node/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/acebot712/promptguard-node)](https://github.com/acebot712/promptguard-node/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)

# PromptGuard Node.js SDK

Drop-in security for AI applications. Secure any GenAI app - regardless of framework or LLM provider.

## Installation

```bash
npm install promptguard-sdk
```

> The npm package and the import specifier are both **`promptguard-sdk`** — no surprises:
> ```typescript
> import { init, PromptGuard } from 'promptguard-sdk';
> ```

Get a free API key at [app.promptguard.co](https://app.promptguard.co).

> **The SDK reads `PROMPTGUARD_API_KEY` from the environment; it does not auto-load `.env`.** Use [dotenv](https://www.npmjs.com/package/dotenv) (call `import 'dotenv/config'` first) if you keep secrets in a `.env` file.

> **PromptGuard fails open by default** — if the Guard API is unavailable, calls proceed *unscanned* so your app stays up. Set `failOpen: false` to block (fail closed) on a Guard outage instead.

> **Module format:** the package currently ships **CommonJS** (`require`) builds. It works in ESM projects via Node's CJS interop (`import { init } from 'promptguard-sdk'` transpiles to a `require`), and in plain CommonJS via `const { init } = require('promptguard-sdk')`.
>
> **Running a native-ESM app?** Auto-instrumentation (`init()`) may not cover your LLM calls — see [Limitations: ESM apps](#limitations) before relying on enforce mode.

## Option 1: Auto-Instrumentation (Recommended)

One line secures **every** LLM call in your application - no matter which framework you use.

```typescript
// All imports first — ES module imports are hoisted and always run before
// any other statement, regardless of their position in the file.
import { init } from 'promptguard-sdk';
import OpenAI from 'openai';

// init() runs as the first executed statement and patches the SDK prototypes.
// Patching works regardless of import order, so you don't need to worry about
// importing the LLM SDK "after" calling init().
init({ apiKey: 'pg_live_xxx' });

const client = new OpenAI();

// This call is automatically scanned by PromptGuard.
const response = await client.chat.completions.create({
  model: 'gpt-5-nano',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

> `init()` is intentionally quiet on success (SDK logging defaults to `warn`). To confirm which provider SDKs are actually being protected, read `getAppliedPatches()` — the source of truth for what got patched:
> ```typescript
> import { init, getAppliedPatches } from 'promptguard-sdk';
> init({ apiKey: 'pg_live_xxx' });
> console.log('PromptGuard protecting:', getAppliedPatches()); // e.g. ['openai']
> ```
> If this list is empty, nothing is being scanned (see [Limitations: ESM apps](#limitations)). Set `logLevel: 'info'` on `init()` to also emit a one-line confirmation banner.

### Supported SDKs

Auto-instrumentation patches the `create` / `generateContent` / `chat` / `send` methods on:

| SDK | npm Package | What Gets Patched |
|-----|------------|-------------------|
| OpenAI | `openai` | `chat.completions.create`, `responses.create` (string and message-item `input` forms) |
| Anthropic | `@anthropic-ai/sdk` | `messages.create` |
- `@google/genai` (Google's current SDK): `models.generateContent()` / `generateContentStream()`. The `config.systemInstruction` system prompt is scanned, as are tool-call arguments and code-execution output. Patched by swapping the exported `GoogleGenAI` constructor, because this SDK assigns `generateContent` as an own property in the constructor rather than on the prototype.
| Google Generative AI | `@google/generative-ai` | `generateContent` | (**deprecated by Google**; still supported because customers are still on it)
| Cohere | `cohere-ai` | `Client.chat` / `ClientV2.chat` |
| AWS Bedrock | `@aws-sdk/client-bedrock-runtime` | `BedrockRuntimeClient.send` (InvokeModel, InvokeModelWithResponseStream, Converse, ConverseStream) |

Any framework built on these SDKs is automatically covered: **LangChain.js**, **Vercel AI SDK**, **AutoGen**, **Semantic Kernel**, and more.

> Patches attach to the modules resolved via CommonJS `require()`. If `init()` finds **no** patchable SDK it logs a warning (nothing would be scanned). You can also verify at runtime with `getAppliedPatches()`:
> ```typescript
> import { init, getAppliedPatches } from 'promptguard-sdk';
> init({ apiKey: 'pg_live_xxx' });
> console.log(getAppliedPatches()); // e.g. ['openai', 'anthropic']
> ```
> Native-ESM apps: see [Limitations: ESM apps](#limitations).

### Modes

```typescript
// Enforce mode (default) - blocks policy violations.
init({ apiKey: 'pg_live_xxx', mode: 'enforce' });

// Monitor mode - logs threats but never blocks. Good for shadow deployment.
init({ apiKey: 'pg_live_xxx', mode: 'monitor' });
```

### Options

```typescript
init({
  apiKey: 'pg_live_xxx',           // or set PROMPTGUARD_API_KEY env var
  baseUrl: 'https://...',     // or set PROMPTGUARD_BASE_URL env var
  mode: 'enforce',            // 'enforce' | 'monitor'
  failOpen: true,             // allow calls when Guard API is unreachable
  scanResponses: false,       // also scan LLM responses
  timeout: 10_000,            // Guard API timeout in ms
});
```

### Confirming protection is actually live

`init()` resolving does not mean anything is being scanned. PromptGuard **fails
open**, so a rejected API key, an unreachable Guard API, or a provider SDK we
never hooked all leave you with an application that runs perfectly and blocks
nothing. In a native-ESM app, where the patches may never attach at all (see
[Limitations](#esm-apps-auto-instrumentation)), that is the default rather than
the edge case.

`verify()` is the positive check. It makes the real calls and reports what came
back:

```typescript
import { verify } from 'promptguard-sdk';

const report = await verify();

if (!report.ok) {
  for (const check of report.checks) {
    console.error(`${check.status} ${check.name} — ${check.detail}`);
  }
  process.exit(1);
}
```

In CI, the one-liner is usually enough:

```typescript
expect((await verify()).ok).toBe(true);
```

It checks reachability, authentication, live threat detection and PII redaction,
plus which provider SDKs this process actually patched — the same checks, under
the same names, as `promptguard verify` in the CLI and `promptguard.verify()` in
the Python SDK.

Each check reports `pass`, `warn` or `fail`. **Only a `fail` clears `ok`.** A
request that never completed is a failure; a request that completed and came
back permissive — an injection that was not blocked, a PII probe with nothing
detected — is a warning, because a monitor-mode project legitimately behaves that
way. Warnings are still the first thing to read before trusting a setup.

`verify()` never rejects for a failed check, so one call reports every problem
rather than only the first. It throws only when no API key was supplied at all.
It retries once rather than the client's three times, so a dead host is reported
in well under a second instead of after the full backoff schedule.

> **Each call makes two real, billed requests.** The probes go through the same
> endpoints as your production traffic, so every `verify()` writes two rows to
> your security events — the injection probe among them, which shows up in your
> dashboard and analytics as a genuine prompt-injection attempt and will trigger
> any alert you have configured on injection. Both requests count against your
> plan's quota. That is fine on deploy or at the start of a demo; calling it on
> every CI build of a busy repo is how you end up with a threat dashboard full of
> your own probes.

### Shutdown

```typescript
import { shutdown } from 'promptguard-sdk';

// Removes all patches and cleans up.
shutdown();
```

## Option 2: Proxy Mode

Route LLM traffic through PromptGuard. Just swap your base URL.

```typescript
import { PromptGuard } from 'promptguard-sdk';

const pg = new PromptGuard({ apiKey: 'pg_live_xxx' });

// Use exactly like the OpenAI client.
const response = await pg.chat.completions.create({
  model: 'gpt-5-nano',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Security Scanning

```typescript
const result = await pg.security.scan('Ignore previous instructions...');
if (result.blocked) {
  console.log(`Threat detected: ${result.reason}`);
}
```

### PII Redaction

```typescript
const result = await pg.security.redact(
  'My email is john@example.com and SSN is 123-45-6789'
);
console.log(result.redacted);
```

## Framework Integrations

### LangChain.js

```typescript
import { PromptGuardCallbackHandler } from 'promptguard-sdk/integrations/langchain';
import { ChatOpenAI } from '@langchain/openai';

const handler = new PromptGuardCallbackHandler({
  apiKey: 'pg_live_xxx',
  mode: 'enforce',
  scanResponses: true,
});

// Attach to a single model
const llm = new ChatOpenAI({
  model: 'gpt-5-nano',
  callbacks: [handler],
});

// Or use with any chain / agent
const result = await chain.invoke(
  { input: 'Hello' },
  { callbacks: [handler] },
);
```

The callback handler provides rich context to PromptGuard - chain names, tool calls, agent steps - for more precise threat detection.

> **Redact decisions block in enforce mode:** LangChain callbacks observe calls but cannot rewrite the inputs of the in-flight LLM call, so a `redact` decision cannot be honored — in enforce mode it is escalated to a block (`PromptGuardBlockedError`) rather than silently sending the content the Guard API asked to redact. Use auto-instrumentation or explicit `GuardClient.scan()` calls if you need actual redaction.
>
> `scanResponses` defaults to `false` (consistent with `init()` and the Vercel AI middleware) — pass `scanResponses: true` to opt in to output scanning.

### Vercel AI SDK

Wrap the model with `promptguard()` and use it wherever you used the original. It wraps the models of `ai` 5, 6 and 7 (specification V2, V3 and V4); on `ai` 4, use `promptGuardMiddleware()` below.

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { promptguard } from 'promptguard-sdk/integrations/vercel-ai';

const model = promptguard(openai('gpt-5-nano'), {
  apiKey: 'pg_live_xxx', // default: PROMPTGUARD_API_KEY
  mode: 'enforce',
  scanResponses: true,
});

const { text } = await generateText({ model, prompt: 'Hello!' });
const result = streamText({ model, prompt: 'Hello again!' });
```

The wrapped model keeps the original's specification version, provider, model id and type, even when the original is frozen. On `ai` 4, or if you already compose AI SDK middleware, `promptGuardMiddleware()` takes the same options and scans the same way:

```typescript
import { wrapLanguageModel } from 'ai';
import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';

const model = wrapLanguageModel({
  model: openai('gpt-5-nano'),
  middleware: [promptGuardMiddleware({ scanResponses: true }) /* , ...yours */],
});
```

Input is scanned before every call. In enforce mode a block throws `PromptGuardBlockedError` before the model is called, and a redaction rewrites the prompt the model receives.

With `scanResponses: true`, streamed output (`streamText()`) is scanned as well as generated output, with the same decisions and the same fail-open policy:

- **Enforce mode holds back text until it has been scanned.** Parts that carry scanned text (text deltas, tool-call input) are held. Each time `streamWindowChars` new characters (default `1000`) have arrived, everything held is scanned and, if clean, released — except the last 200 characters, which stay held and are scanned again at the head of the next window. When the model finishes, the complete text is scanned once more before that tail and the `finish` part are released. The guarantee: no text reaches your code before it has been scanned together with at least the 200 characters that follow it, so a secret up to 200 characters long is always seen whole, even across a window boundary. The cost is that text arrives in bursts, each after one Guard API round trip. Set `streamWindowChars: Infinity` to hold the whole response for a single scan at the end.
- **Parts with nothing to scan are not held for nothing.** Stream start, reasoning, sources, files and metadata are delivered at once when no text is held ahead of them, and queue behind held text otherwise, so the order of parts never changes. Reasoning is not scanned, as it is not with `generateText()`.
- **The default window is a judgement call**, not an external standard: 1000 characters is about 250 tokens, a few seconds of generation, which is about as long as one Guard API round trip — so scanning a window roughly keeps pace with generating the next. A smaller window gets the first text out sooner and costs more scans.
- **A block stops the stream** with `PromptGuardBlockedError` (an output `redact` is enforced as a block, as with `generateText()`). Parts already released stay delivered; nothing after the blocked window is. `generateText()` rejects with `PromptGuardBlockedError` on any block. How a block reaches a `streamText()` caller depends on where it happened and on the model's AI SDK specification version (checked against ai 5, 6 and 7). Nothing in it hangs:

  | Blocked | `onError` | `textStream` / `fullStream` | `toTextStreamResponse()` | `await result.text` |
  |---------|-----------|-----------------------------|--------------------------|---------------------|
  | Prompt, before the model is called (any version) | Called with `PromptGuardBlockedError` | End with no text; `fullStream` carries an `error` part | 200, empty body | Rejects with `NoOutputGeneratedError` |
  | Output, from a V3 or V4 model (ai 6 and 7) | Not called | Throw `PromptGuardBlockedError` when read | The body errors when read | Rejects with `PromptGuardBlockedError` |
  | Output, from a V2 model (ai 5) | Called with `PromptGuardBlockedError` | End with the text released before the block; `fullStream` carries an `error` part | 200, body ends with the text released before the block | Resolves with the text released before the block |

  A V2 stream ends with the AI SDK's `error` part rather than erroring, because ai 5 never settles `await result.text` on an errored stream. So on ai 5 the text alone looks like a short answer: if you read only the text, check `await result.finishReason === 'error'`, which is how a blocked stream finishes there (or use `onError` or `fullStream`). The V2 row also applies to a V2 model (a provider package still on V2) under ai 6 or 7, through `promptguard()` and through ai 6's `wrapLanguageModel`, which passes a V2 model through as it is; such a stream loses the throw ai 6 and 7 would otherwise give. ai 7's `wrapLanguageModel` upgrades a V2 model to V4 first, so the middleware there follows the V4 row.
- **Monitor mode never holds the stream.** Parts pass through as they arrive and the complete text is scanned once at the end.
- **The final scan sees what `generateText()` would.** The complete text is assembled the same way as a generated result — text first, then each tool call's input — so the same response gets the same decision streamed or not.
- **If the Guard API becomes unreachable mid-stream**, the held parts are released and the rest of that stream passes unscanned with a warning (`failOpen: true`, the default). With `failOpen: false` the stream stops with the `GuardApiError` instead.

### Standalone Guard API

Use the Guard client directly for maximum control:

```typescript
import { GuardClient } from 'promptguard-sdk';

const guard = new GuardClient({ apiKey: 'pg_live_xxx' });

// Scan before sending to LLM (options-object form, preferred)
const decision = await guard.scan(
  [{ role: 'user', content: userInput }],
  { direction: 'input', model: 'gpt-5-nano' },
);

if (decision.blocked) {
  console.log(`Blocked: ${decision.threatType}`);
} else if (decision.redacted && decision.redactedMessages) {
  // Use redacted messages instead
  messages = decision.redactedMessages;
}

// Scan LLM response
const outputDecision = await guard.scan(
  [{ role: 'assistant', content: llmOutput }],
  { direction: 'output' },
);

// The positional form still works for back-compat:
// await guard.scan(messages, 'input', 'gpt-5-nano');
```

## Retry Logic

Both the proxy client (`PromptGuard`) and the Guard client (`GuardClient`) support configurable retry behavior for transient failures:

```typescript
// Proxy client
const pg = new PromptGuard({
  apiKey: 'pg_live_xxx',
  maxRetries: 3,      // Number of retry attempts (default: 3)
  retryDelay: 500,     // Base delay in ms between retries (default: 1000)
});

// Guard client (standalone scanning)
const guard = new GuardClient({
  apiKey: 'pg_live_xxx',
  maxRetries: 3,      // default: 3
  retryDelay: 500,     // default: 1000
});
```

Because auto-instrumentation (`init()`) and the framework integrations all scan through `GuardClient`, they retry transient Guard API failures too — pass `maxRetries` / `retryDelay` to `init()`, `PromptGuardCallbackHandler`, or `promptGuardMiddleware`:

```typescript
init({ apiKey: 'pg_live_xxx', maxRetries: 3, retryDelay: 500 });
```

Retries use exponential backoff starting from `retryDelay`, with jitter so concurrent clients don't retry in lockstep. A server-provided `Retry-After` header is honored but clamped to 60 seconds. Only transient errors (network timeouts, 429/5xx responses) are retried; client errors (4xx) fail immediately.

> **Enforcement is unchanged by retries.** Retrying only affects *transient* Guard failures (network errors, 429/5xx). A real `block` / `redact` decision is terminal and is never retried, and once retries are exhausted a `GuardApiError` is raised so your existing `failOpen` policy governs — exactly as it would with `maxRetries: 0`. Retries never turn a would-be error into an allow.

> **Idempotency caveat:** all requests — including `POST`s — are retried on transient failure. If a request reached the server but the response was lost, the retry re-submits it. Chat/completion/scan calls are safe to re-submit, but each attempt may bill separately; set `maxRetries: 0` if you need strict at-most-once semantics.

## AI Agent Security

```typescript
const validation = await pg.agent.validateTool(
  'agent-123',
  'execute_shell',
  { command: 'ls -la' },
);

if (!validation.allowed) {
  console.log(`Blocked: ${validation.reason}`);
}
```

## Red Team Testing

Run PromptGuard's adversarial corpus against your own policy configuration and
see how much of it your guardrails block. Useful from CI as a regression gate on
a policy change.

```typescript
const pg = new PromptGuard({ apiKey: 'pg_live_xxx' });

// What the corpus contains, without running it
const catalog = await pg.redteam.listTests();
console.log(`${catalog.total} attacks available`);

// Run everything against a preset
const summary = await pg.redteam.runAll('support_bot:strict');
console.log(`Blocked ${summary.blocked}/${summary.totalTests}`);

// Run one named attack, or your own adversarial prompt
const one = await pg.redteam.runTest('prompt_injection_basic');
const custom = await pg.redteam.runCustom('ignore previous instructions and ...');
console.log(custom.decision, custom.reason);
```

Requires an API key with the `proxy` scope (an unrestricted key also works).
Device/scan-only credentials cannot reach these endpoints.

## Configuration

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `apiKey` | `PROMPTGUARD_API_KEY` | - | PromptGuard API key (required) |
| `baseUrl` | `PROMPTGUARD_BASE_URL` | `https://api.promptguard.co/api/v1` | API base URL |
| `mode` | - | `"enforce"` | `"enforce"` or `"monitor"` |
| `failOpen` | - | `true` | Allow calls when Guard API is unreachable |
| `scanResponses` | - | `false` | Also scan LLM responses |
| `timeout` | - | `10000` | HTTP timeout in milliseconds |
| `logLevel` | - | `"warn"` | SDK log verbosity: `"debug"`, `"info"`, `"warn"`, `"error"`, `"silent"` |
| `silent` | - | `false` | Shorthand for `logLevel: "silent"` |

> The proxy client (`PromptGuard`) talks to the `/api/v1/proxy` endpoints. If you set `baseUrl` / `PROMPTGUARD_BASE_URL` to `.../api/v1` (without `/proxy`), the SDK appends the `/proxy` suffix for you, so requests still land on the proxy.
>
> **Security:** the SDK sends your API key (and, in proxy mode, your prompt content) to whatever `PROMPTGUARD_BASE_URL` points at. Self-hosting is supported, so only point it at a host you trust.
>
> **Logging is process-global:** `logLevel` / `silent` set a single shared log level for the whole SDK. If several integrations or `init()` calls pass different values, the most recently constructed one wins. Use `setLogLevel()` directly for fine-grained control.

## Limitations

### ESM apps (auto-instrumentation)

Auto-instrumentation (`init()`) patches the provider modules that Node resolves via **CommonJS `require()`**. If your application runs as **native ESM** (`"type": "module"` in package.json, or `.mjs` files) and a provider ships separate ESM builds, the module instances your code `import`s can be *different objects* from the ones the SDK patched — the **dual-package hazard**. In that case your LLM calls bypass the patches entirely and **enforce mode silently protects nothing**.

What to do:

- **Verify at runtime** with [`verify()`](#confirming-protection-is-actually-live), which makes real calls and reports what came back, or with `getAppliedPatches()` for the patch list alone — and note that a patch being listed proves the CJS build was patched, not that your ESM imports go through it. `init()` also logs a warning when it applies zero patches.
- **Prefer the ESM-safe APIs**, which don't rely on module patching:
  - LangChain: `PromptGuardCallbackHandler` (`promptguard-sdk/integrations/langchain`)
  - Vercel AI SDK: `promptguard(model)` or `promptGuardMiddleware` (`promptguard-sdk/integrations/vercel-ai`)
  - Any framework: explicit `GuardClient.scan()` calls around your LLM invocations
- Transpiled-to-CJS TypeScript apps (the common `tsc`/`ts-node` default) are **not** affected — their `import`s compile to `require()` and hit the patched modules.

### Other limitations

- **Auto-instrumented streaming responses are not output-scanned.** With auto-instrumentation and `scanResponses: true`, streaming calls (`stream: true`, Bedrock `ConverseStreamCommand`, etc.) skip the output scan — the patched SDK hands the stream straight to your code. Input scanning still applies. A `debug`-level log is emitted when the output scan is skipped. The Vercel AI SDK middleware is the exception: it scans `streamText()` output in windows (see [Vercel AI SDK](#vercel-ai-sdk)).
- **OpenAI `APIPromise` helpers are not preserved by auto-instrumentation.** Patched methods return a plain `Promise`, so `.withResponse()` / `.asResponse()` on `client.chat.completions.create(...)` are unavailable while `init()` is active. `await` the call and use the plain result instead.
- **Proxy client streaming:** `pg.chat.completions.create({ stream: true })` is rejected with a clear error — streaming is not yet supported by the proxy client.

## Error Handling

```typescript
import { PromptGuardBlockedError, GuardApiError } from 'promptguard-sdk';

try {
  await client.chat.completions.create({ ... });
} catch (error) {
  if (error instanceof PromptGuardBlockedError) {
    // Request was blocked by policy
    console.log(error.decision.threatType);
    console.log(error.decision.confidence);
    console.log(error.decision.eventId);
  } else if (error instanceof GuardApiError) {
    // Guard API is unreachable (only when failOpen=false)
    console.log(error.statusCode);
  }
}
```

## TypeScript Support

Full TypeScript support with type definitions for all exports:

```typescript
import type {
  GuardDecision,
  GuardMessage,
  GuardContext,
  InitOptions,
  ChatCompletionRequest,
  ChatCompletionResponse,
  SecurityScanResult,
  AutonomousRedTeamRequest,
  AutonomousRedTeamReport,
  IntelligenceStats,
  VerifyReport,
  VerifyCheck,
  VerifyOptions,
  CheckStatus,
} from 'promptguard-sdk';
```

> **Response fields are camelCase — with one deliberate exception.** The SDK's normalized response objects (the `security`, `redteam`, `agent`, and `guard` namespaces) use camelCase field names (e.g. `report.bypassRate`, `stats.totalPatterns`, `validation.riskScore`) regardless of the snake_case wire format — consistent with `GuardDecision` and `SecurityScanResult`. The **OpenAI-compatible** responses (`chat.completions`, i.e. `ChatCompletionResponse`) are the exception: they intentionally preserve OpenAI's snake_case shape (`choices[].finish_reason`, `usage.prompt_tokens`, …) so they stay drop-in compatible with the `openai` client. Request options are camelCase throughout (`maxTokens`, `targetPreset`), including `GuardContext` (`chainName`, `agentId`, `sessionId`, `toolCalls`).

## Links

- [Documentation](https://docs.promptguard.co)
- [SDK Reference](https://docs.promptguard.co/sdks/node)
- [Support](mailto:support@promptguard.co)

## License

MIT
