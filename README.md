[![npm version](https://img.shields.io/npm/v/promptguard)](https://www.npmjs.com/package/promptguard)
[![CI](https://github.com/acebot712/promptguard-node/actions/workflows/ci.yml/badge.svg)](https://github.com/acebot712/promptguard-node/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/acebot712/promptguard-node)](https://github.com/acebot712/promptguard-node/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)

# PromptGuard Node.js SDK

Drop-in security for AI applications. Secure any GenAI app - regardless of framework or LLM provider.

## Installation

```bash
npm install promptguard-sdk
```

## Option 1: Auto-Instrumentation (Recommended)

One line secures **every** LLM call in your application - no matter which framework you use.

```typescript
import { init } from 'promptguard-sdk';

// Call once at startup - before any LLM SDK usage.
init({ apiKey: 'pg_xxx' });

// Everything below is now secured transparently.
import OpenAI from 'openai';
const client = new OpenAI();

// This call is automatically scanned by PromptGuard.
const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Supported SDKs

Auto-instrumentation patches the `create` / `generateContent` / `chat` / `send` methods on:

| SDK | npm Package | What Gets Patched |
|-----|------------|-------------------|
| OpenAI | `openai` | `chat.completions.create` |
| Anthropic | `@anthropic-ai/sdk` | `messages.create` |
| Google Generative AI | `@google/generative-ai` | `generateContent` |
| Cohere | `cohere-ai` | `Client.chat` / `ClientV2.chat` |
| AWS Bedrock | `@aws-sdk/client-bedrock-runtime` | `BedrockRuntimeClient.send` (InvokeModel, Converse) |

Any framework built on these SDKs is automatically covered: **LangChain.js**, **Vercel AI SDK**, **AutoGen**, **Semantic Kernel**, and more.

### Modes

```typescript
// Enforce mode (default) - blocks policy violations.
init({ apiKey: 'pg_xxx', mode: 'enforce' });

// Monitor mode - logs threats but never blocks. Good for shadow deployment.
init({ apiKey: 'pg_xxx', mode: 'monitor' });
```

### Options

```typescript
init({
  apiKey: 'pg_xxx',           // or set PROMPTGUARD_API_KEY env var
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

const pg = new PromptGuard({ apiKey: 'pg_xxx' });

// Use exactly like the OpenAI client.
const response = await pg.chat.completions.create({
  model: 'gpt-4o',
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
  apiKey: 'pg_xxx',
  mode: 'enforce',
  scanResponses: true,
});

// Attach to a single model
const llm = new ChatOpenAI({
  model: 'gpt-4o',
  callbacks: [handler],
});

// Or use with any chain / agent
const result = await chain.invoke(
  { input: 'Hello' },
  { callbacks: [handler] },
);
```

The callback handler provides rich context to PromptGuard - chain names, tool calls, agent steps - for more precise threat detection.

### Vercel AI SDK

```typescript
import { openai } from '@ai-sdk/openai';
import { wrapLanguageModel, generateText } from 'ai';
import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: promptGuardMiddleware({
    apiKey: 'pg_xxx',
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

const guard = new GuardClient({ apiKey: 'pg_xxx' });

// Scan before sending to LLM
const decision = await guard.scan(
  [{ role: 'user', content: userInput }],
  'input',
  'gpt-4o',
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
  'output',
);
```

## Retry Logic

Both `PromptGuard` and `GuardClient` support configurable retry behavior for transient failures:

```typescript
const pg = new PromptGuard({
  apiKey: 'pg_xxx',
  maxRetries: 3,      // Number of retry attempts (default: 2)
  retryDelay: 500,     // Base delay in ms between retries (default: 250)
});
```

Retries use exponential backoff starting from `retryDelay`. Only transient errors (network timeouts, 5xx responses) are retried; client errors (4xx) fail immediately.

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
const pg = new PromptGuard({ apiKey: 'pg_xxx' });

// Run the autonomous red team agent (LLM-powered mutation)
const report = await pg.redteam.runAutonomous({
  budget: 200,
  target_preset: 'support_bot:strict',
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
