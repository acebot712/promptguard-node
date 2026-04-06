/**
 * PromptGuard Node.js SDK
 *
 * Drop-in security for AI applications.
 *
 * **Option 1 - Auto-instrumentation (recommended)**
 * @example
 * ```ts
 * import { init } from 'promptguard-sdk';
 * init({ apiKey: 'pg_xxx' });
 * // All LLM calls are now secured automatically.
 * ```
 *
 * **Option 2 - Proxy mode**
 * @example
 * ```ts
 * import { PromptGuard } from 'promptguard-sdk';
 * const pg = new PromptGuard({ apiKey: 'pg_xxx' });
 * const response = await pg.chat.completions.create({ ... });
 * ```
 *
 * **Option 3 - Framework integrations**
 * @example
 * ```ts
 * import { PromptGuardCallbackHandler } from 'promptguard-sdk/integrations/langchain';
 * import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';
 * ```
 */

// Auto-instrumentation
export { type InitOptions, init, shutdown } from "./auto"
// Proxy client
export { default, PromptGuard, PromptGuardError } from "./client"
// Guard client (standalone scanning)
export {
  GuardApiError,
  GuardClient,
  type GuardClientConfig,
  type GuardContext,
  GuardDecision,
  type GuardMessage,
  type GuardRequestBody,
  type GuardResponseBody,
  PromptGuardBlockedError,
  type ThreatDetail,
} from "./guard"

// Framework integrations (re-exported for convenience)
export { PromptGuardCallbackHandler } from "./integrations/langchain"
export { promptGuardMiddleware } from "./integrations/vercel-ai"
