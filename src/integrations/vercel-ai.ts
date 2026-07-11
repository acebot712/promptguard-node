/**
 * Vercel AI SDK integration - middleware for `ai` package.
 *
 * Works with the Vercel AI SDK's `wrapLanguageModel` API to intercept
 * all model calls with PromptGuard security scanning.
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 * import { wrapLanguageModel, generateText } from 'ai';
 * import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';
 *
 * const model = wrapLanguageModel({
 *   model: openai('gpt-5-nano'),
 *   middleware: promptGuardMiddleware({ apiKey: 'pg_live_xxx' }),
 * });
 *
 * const { text } = await generateText({ model, prompt: 'Hello!' });
 * ```
 */

import {
  GuardApiError,
  GuardClient,
  type GuardClientConfig,
  type GuardMessage,
  PromptGuardBlockedError,
  safeErrorLabel,
} from "../guard"
import { type LogLevel, logger, setLogLevel } from "../logger"
import { resolveCredentials } from "../resolve"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PromptGuardMiddlewareOptions extends GuardClientConfig {
  mode?: "enforce" | "monitor"
  scanResponses?: boolean
  failOpen?: boolean
  /**
   * SDK log verbosity (default: `"warn"`). Set to `"silent"` to suppress logs.
   * NOTE: this sets the **process-global** SDK log level (shared with `init()`
   * and other integrations); the most recently constructed instance wins.
   */
  logLevel?: LogLevel
  /** Convenience shorthand for `logLevel: "silent"`. */
  silent?: boolean
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK middleware that scans inputs/outputs via
 * the PromptGuard Guard API.
 *
 * Returns an object conforming to the Vercel AI SDK `LanguageModelMiddleware`
 * interface (`transformParams` + `wrapGenerate`).
 */
export function promptGuardMiddleware(options: PromptGuardMiddlewareOptions) {
  if (options.silent) setLogLevel("silent")
  else if (options.logLevel) setLogLevel(options.logLevel)

  const { apiKey, baseUrl } = resolveCredentials(options.apiKey, options.baseUrl)

  const guard = new GuardClient({ apiKey, baseUrl, timeout: options.timeout })
  const mode = options.mode ?? "enforce"
  const scanResponses = options.scanResponses ?? false
  const failOpen = options.failOpen ?? true

  return {
    /**
     * transformParams - scans the input messages before they reach the model.
     */
    transformParams: async ({ params }: { params: Record<string, unknown> }) => {
      const prompt = params?.prompt
      if (!prompt) return params

      const { messages: guardMessages, indices } = vercelPromptToGuardMessages(prompt)
      if (!guardMessages.length) return params

      try {
        const decision = await guard.scan(
          guardMessages,
          "input",
          (params?.modelId as string) ?? undefined,
          {
            framework: "vercel-ai-sdk",
          },
        )

        if (decision.blocked) {
          if (mode === "enforce") throw new PromptGuardBlockedError(decision)
          logger.warn(`[monitor] would block: ${decision.threatType} (event=${decision.eventId})`)
        }

        if (decision.redacted && decision.redactedMessages && mode === "enforce") {
          return {
            ...params,
            prompt: applyRedactionToPrompt(prompt, decision.redactedMessages, indices),
          }
        }
      } catch (err) {
        if (err instanceof PromptGuardBlockedError) throw err
        // Only a Guard API outage is eligible for fail-open (mirrors
        // patches/base.ts); rethrow the original error when failing closed.
        if (!(err instanceof GuardApiError)) throw err
        if (!failOpen) throw err
        logger.warn(
          `Guard API unavailable, allowing input unscanned (failOpen=true): ${safeErrorLabel(err)}`,
        )
      }

      return params
    },

    /**
     * wrapGenerate - optionally scans the model's response.
     */
    wrapGenerate: scanResponses
      ? async ({
          doGenerate,
          params,
        }: {
          doGenerate: () => Promise<unknown>
          params: Record<string, unknown>
        }) => {
          const result = await doGenerate()
          const typed = result as Record<string, unknown>

          const toolCalls = typed?.toolCalls as Record<string, unknown>[] | undefined
          const text = typed?.text ?? toolCalls?.[0]?.args ?? null
          if (typeof text !== "string" || !text) return result

          try {
            const respDecision = await guard.scan(
              [{ role: "assistant", content: text }],
              "output",
              (params?.modelId as string) ?? undefined,
              { framework: "vercel-ai-sdk" },
            )

            if (respDecision.blocked) {
              if (mode === "enforce") {
                throw new PromptGuardBlockedError(respDecision)
              }
              logger.warn(`[monitor] would block response: ${respDecision.threatType}`)
            }
          } catch (err) {
            if (err instanceof PromptGuardBlockedError) throw err
            // Only a Guard API outage is eligible for fail-open; rethrow
            // the original error when failing closed.
            if (!(err instanceof GuardApiError)) throw err
            if (!failOpen) throw err
            logger.warn(
              `Guard API unavailable, response left unscanned (failOpen=true): ${safeErrorLabel(
                err,
              )}`,
            )
          }

          return result
        }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Vercel AI SDK prompt to guard messages.
 *
 * Messages without scannable text (e.g. image-only content) are skipped, so
 * `indices[k]` records the original prompt index each guard message came
 * from — required to map redactions back without misalignment.
 */
function vercelPromptToGuardMessages(prompt: unknown): {
  messages: GuardMessage[]
  indices: number[]
} {
  if (typeof prompt === "string") {
    return { messages: [{ role: "user", content: prompt }], indices: [0] }
  }

  if (!Array.isArray(prompt)) return { messages: [], indices: [] }

  const messages: GuardMessage[] = []
  const indices: number[] = []
  for (let i = 0; i < prompt.length; i++) {
    const msg = prompt[i]
    if (!msg) continue
    const role = String(msg.role ?? "user")

    if (typeof msg.content === "string") {
      messages.push({ role, content: msg.content })
      indices.push(i)
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = []
      for (const part of msg.content) {
        if (typeof part === "string") textParts.push(part)
        else if (part?.type === "text") textParts.push(part.text ?? "")
      }
      if (textParts.length) {
        messages.push({ role, content: textParts.join("\n") })
        indices.push(i)
      }
    }
  }

  return { messages, indices }
}

/**
 * Map redacted guard messages back onto the original prompt using the
 * original indices recorded during extraction. Structured (array) content
 * is rebuilt as `[{ type: "text", text }]` rather than a bare string so the
 * message still conforms to the AI SDK's content shape.
 */
function applyRedactionToPrompt(
  prompt: unknown,
  redacted: GuardMessage[],
  indices: number[],
): unknown {
  if (typeof prompt === "string") {
    return redacted[0] ? redacted[0].content : prompt
  }

  if (!Array.isArray(prompt)) return prompt

  // Map original prompt index -> redacted guard message.
  const redactionByIndex = new Map<number, GuardMessage>()
  for (let k = 0; k < redacted.length && k < indices.length; k++) {
    redactionByIndex.set(indices[k], redacted[k])
  }

  return (prompt as unknown[]).map((msg: unknown, i: number) => {
    const r = redactionByIndex.get(i)
    if (!r || !msg || typeof msg !== "object") return msg
    const original = msg as Record<string, unknown>
    const content = Array.isArray(original.content)
      ? [{ type: "text", text: r.content }]
      : r.content
    return { ...original, content }
  })
}
