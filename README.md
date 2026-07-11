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

### Supported SDKs

Auto-instrumentation patches the `create` / `generateContent` / `chat` / `send` methods on:

| SDK | npm Package | What Gets Patched |
|-----|------------|-------------------|
| OpenAI | `openai` | `chat.completions.create`, `responses.create` (string and message-item `input` forms) |
| Anthropic | `@anthropic-ai/sdk` | `messages.create` |
| Google Generative AI | `@google/generative-ai` | `generateContent` |
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

```typescript
import { openai } from '@ai-sdk/openai';
import { wrapLanguageModel, generateText } from 'ai';
import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';

const model = wrapLanguageModel({
  model: openai('gpt-5-nano'),
  middleware: promptGuardMiddleware({
    apiKey: 'pg_live_xxx',
    mode: 'enforce',
    scanResponses: true,
  }),
});

const { text } = await generateText({
  model,
  prompt: 'Hello!',
});
```

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

Both `PromptGuard` and `GuardClient` support configurable retry behavior for transient failures:

```typescript
const pg = new PromptGuard({
  apiKey: 'pg_live_xxx',
  maxRetries: 3,      // Number of retry attempts (default: 3)
  retryDelay: 500,     // Base delay in ms between retries (default: 1000)
});
```

Retries use exponential backoff starting from `retryDelay`, with jitter so concurrent clients don't retry in lockstep. A server-provided `Retry-After` header is honored but clamped to 60 seconds. Only transient errors (network timeouts, 429/5xx responses) are retried; client errors (4xx) fail immediately.

> **Idempotency caveat:** all requests — including `POST`s — are retried on transient failure. If a request reached the server but the response was lost, the retry re-submits it. Chat/completion/scan calls are safe to re-submit, but each attempt may bill separately; set `maxRetries: 0` if you need strict at-most-once semantics.

## Embeddings

Scan and secure embedding requests through the proxy:

```typescript
const response = await pg.embeddings.create({
  model: 'text-embedding-3-small',
  input: 'The quick brown fox jumps over the lazy dog',
});
console.log(response.data[0].embedding.slice(0, 5));
```

Batch embedding requests are also supported:

```typescript
const response = await pg.embeddings.create({
  model: 'text-embedding-3-small',
  input: ['First document', 'Second document', 'Third document'],
});
for (const item of response.data) {
  console.log(`Index ${item.index}: ${item.embedding.length} dimensions`);
}
```

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

```typescript
const pg = new PromptGuard({ apiKey: 'pg_live_xxx' });

// Run the autonomous red team agent (LLM-powered mutation)
const report = await pg.redteam.runAutonomous({
  budget: 200,
  targetPreset: 'support_bot:strict', // snake_case `target_preset` also accepted
});
console.log(`Grade: ${report.grade}, Bypass rate: ${(report.bypass_rate * 100).toFixed(0)}%`);

// Get Attack Intelligence stats
const stats = await pg.redteam.intelligenceStats();
console.log(`Total patterns: ${stats.total_patterns}`);
```

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

- **Verify at runtime** with `getAppliedPatches()` after `init()` — and note that a patch being listed proves the CJS build was patched, not that your ESM imports go through it. `init()` also logs a warning when it applies zero patches.
- **Prefer the ESM-safe APIs**, which don't rely on module patching:
  - LangChain: `PromptGuardCallbackHandler` (`promptguard-sdk/integrations/langchain`)
  - Vercel AI SDK: `promptGuardMiddleware` (`promptguard-sdk/integrations/vercel-ai`)
  - Any framework: explicit `GuardClient.scan()` calls around your LLM invocations
- Transpiled-to-CJS TypeScript apps (the common `tsc`/`ts-node` default) are **not** affected — their `import`s compile to `require()` and hit the patched modules.

### Other limitations

- **Streaming responses are not output-scanned.** With auto-instrumentation and `scanResponses: true`, streaming calls (`stream: true`, Bedrock `ConverseStreamCommand`, etc.) skip the output scan — the stream is consumed incrementally by your code and cannot be buffered without breaking stream semantics. Input scanning still applies. A `debug`-level log is emitted when the output scan is skipped. The same applies to the Vercel AI SDK middleware: `streamText()` outputs are not scanned (`wrapStream` logs the skip); `generateText()` outputs are.
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
} from 'promptguard-sdk';
```

## Links

- [Documentation](https://docs.promptguard.co)
- [SDK Reference](https://docs.promptguard.co/sdks/node)
- [Support](mailto:support@promptguard.co)

## License

MIT
