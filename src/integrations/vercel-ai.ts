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

        if (decision.redacted) {
          const redactedMessages = decision.redactedMessages ?? []
          // A redactedMessages list SHORTER than the scanned guard messages
          // would leave the unmatched trailing messages unredacted (the
          // index map below only covers the returned entries), so a partial
          // list cannot be honored either.
          const isPartial = redactedMessages.length < guardMessages.length
          if (mode === "enforce") {
            if (!redactedMessages.length || isPartial) {
              // A redact decision without (or with too few) redacted
              // messages cannot be honored; proceeding would silently send
              // the content the Guard API asked us to redact — escalate to
              // a block.
              logger.error(
                `redact decision returned ` +
                  (isPartial && redactedMessages.length
                    ? `${redactedMessages.length} redacted messages for ${guardMessages.length} scanned`
                    : "no redacted messages") +
                  `; escalating to block (event=${decision.eventId})`,
              )
              throw new PromptGuardBlockedError(decision)
            }
            return {
              ...params,
              prompt: applyRedactionToPrompt(prompt, redactedMessages, indices),
            }
          }
          logger.warn(
            `[monitor] would redact: content passed through unredacted` +
              (isPartial
                ? ` (partial: ${redactedMessages.length} redacted messages for ${guardMessages.length} scanned)`
                : "") +
              ` (event=${decision.eventId})`,
          )
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

          const text = extractGeneratedText(result as Record<string, unknown>)
          if (!text) return result

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
 * Extract all scannable text from a `doGenerate` result.
 *
 * Handles both AI SDK result shapes:
 *  - **v4 (LanguageModelV1):** top-level `text` string plus `toolCalls`
 *    (every tool call's `args`/`input` is scanned — not just the first).
 *  - **v5 (LanguageModelV2):** `content` is an array of parts
 *    (`{ type: "text", text }` / `{ type: "tool-call", input }`) with no
 *    top-level `text`.
 *
 * Returns the concatenated text, or `null` when nothing scannable exists.
 */
function extractGeneratedText(result: Record<string, unknown> | null | undefined): string | null {
  const texts: string[] = []

  const stringify = (value: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value)

  if (typeof result?.text === "string" && result.text) texts.push(result.text)

  if (Array.isArray(result?.content)) {
    for (const raw of result.content) {
      if (!raw || typeof raw !== "object") continue
      const part = raw as Record<string, unknown>
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        texts.push(part.text)
      } else if (part.type === "tool-call") {
        const args = part.input ?? part.args
        if (args != null) texts.push(stringify(args))
      }
    }
  }

  if (Array.isArray(result?.toolCalls)) {
    for (const raw of result.toolCalls) {
      if (!raw || typeof raw !== "object") continue
      const call = raw as Record<string, unknown>
      const args = call.args ?? call.input
      if (args != null) texts.push(stringify(args))
    }
  }

  const combined = texts.join("\n")
  return combined || null
}

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
