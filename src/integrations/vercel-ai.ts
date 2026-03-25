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
 *   model: openai('gpt-4o'),
 *   middleware: promptGuardMiddleware({ apiKey: 'pg_xxx' }),
 * });
 *
 * const { text } = await generateText({ model, prompt: 'Hello!' });
 * ```
 */

import {
  GuardClient,
  type GuardClientConfig,
  type GuardMessage,
  PromptGuardBlockedError,
} from "../guard"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PromptGuardMiddlewareOptions extends GuardClientConfig {
  mode?: "enforce" | "monitor"
  scanResponses?: boolean
  failOpen?: boolean
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
  const apiKey = options.apiKey ?? process.env.PROMPTGUARD_API_KEY ?? ""
  if (!apiKey) {
    throw new Error("PromptGuard API key required. Pass apiKey or set PROMPTGUARD_API_KEY.")
  }

  const guard = new GuardClient({
    apiKey,
    baseUrl: options.baseUrl,
    timeout: options.timeout,
  })

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

      const guardMessages = vercelPromptToGuardMessages(prompt)
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
          console.warn(
            `[promptguard][monitor] would block: ${decision.threatType} (event=${decision.eventId})`,
          )
        }

        if (decision.redacted && decision.redactedMessages && mode === "enforce") {
          return {
            ...params,
            prompt: applyRedactionToPrompt(prompt, decision.redactedMessages),
          }
        }
      } catch (err) {
        if (err instanceof PromptGuardBlockedError) throw err
        if (!failOpen) throw err
        // fail-open: continue with original params
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
              console.warn(
                `[promptguard][monitor] would block response: ${respDecision.threatType}`,
              )
            }
          } catch (err) {
            if (err instanceof PromptGuardBlockedError) throw err
            if (!failOpen) throw err
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
 * Convert the Vercel AI SDK prompt structure to GuardMessages.
 *
 * The Vercel AI SDK prompt can be:
 * - A string (simple prompt)
 * - An array of message objects with `role` and `content`
 */
function vercelPromptToGuardMessages(prompt: unknown): GuardMessage[] {
  if (typeof prompt === "string") {
    return [{ role: "user", content: prompt }]
  }

  if (!Array.isArray(prompt)) return []

  const result: GuardMessage[] = []
  for (const msg of prompt) {
    if (!msg) continue
    const role = String(msg.role ?? "user")

    if (typeof msg.content === "string") {
      result.push({ role, content: msg.content })
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = []
      for (const part of msg.content) {
        if (typeof part === "string") textParts.push(part)
        else if (part?.type === "text") textParts.push(part.text ?? "")
      }
      if (textParts.length) {
        result.push({ role, content: textParts.join("\n") })
      }
    }
  }

  return result
}

/**
 * Apply redacted content back into the Vercel AI SDK prompt structure.
 */
function applyRedactionToPrompt(prompt: unknown, redacted: GuardMessage[]): unknown {
  if (typeof prompt === "string" && redacted[0]) {
    return redacted[0].content
  }

  if (!Array.isArray(prompt)) return prompt

  return (prompt as unknown[]).map((msg: unknown, i: number) => {
    if (i < redacted.length && msg && typeof msg === "object") {
      return { ...msg, content: redacted[i].content }
    }
    return msg
  })
}
