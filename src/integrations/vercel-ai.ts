/**
 * Vercel AI SDK integration for the `ai` package (AI SDK 5, 6 and 7).
 *
 * Two ways in, with the same scanning:
 *
 * - `promptguard(model)` wraps a language model, and the wrapped model is
 *   used wherever the original was:
 *
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 * import { generateText } from 'ai';
 * import { promptguard } from 'promptguard-sdk/integrations/vercel-ai';
 *
 * const model = promptguard(openai('gpt-5-nano'), { scanResponses: true });
 * const { text } = await generateText({ model, prompt: 'Hello!' });
 * ```
 *
 * - `promptGuardMiddleware(options)` is the same scanning as AI SDK
 *   middleware, for `wrapLanguageModel` — useful alongside other middleware:
 *
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 * import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';
 *
 * const model = wrapLanguageModel({
 *   model: openai('gpt-5-nano'),
 *   middleware: promptGuardMiddleware({ apiKey: 'pg_live_xxx' }),
 * });
 * ```
 *
 * With `scanResponses: true`, `streamText()` output is scanned too: in
 * enforce mode text is held until it has been scanned, a window
 * (`streamWindowChars`, default 1000 characters) at a time, and the complete
 * text is scanned before the stream finishes. See `vercel-ai-output.ts` for
 * the full behaviour and its guarantee.
 *
 * Neither imports `ai`: the wrapper calls the middleware's hooks the way
 * `wrapLanguageModel` does, so it works with whichever `ai` the application
 * has (ai@7 is ESM-only; this package is CommonJS) and loads without one.
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
import {
  DEFAULT_STREAM_WINDOW_CHARS,
  extractGeneratedText,
  type OutputScanPolicy,
  scanOutputStream,
  scanOutputText,
  validateWindowChars,
} from "./vercel-ai-output"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PromptGuardMiddlewareOptions extends Omit<GuardClientConfig, "apiKey"> {
  /** PromptGuard API key (default: the `PROMPTGUARD_API_KEY` environment variable). */
  apiKey?: string
  mode?: "enforce" | "monitor"
  /**
   * Scan the model's output as well as its input (default: `false`). Applies
   * to `generateText()` and to `streamText()` alike.
   */
  scanResponses?: boolean
  failOpen?: boolean
  /**
   * With `scanResponses` in enforce mode, how many new characters of
   * streamed output are collected before the held text is scanned (default:
   * `1000`; see `DEFAULT_STREAM_WINDOW_CHARS` for why). A smaller window
   * delivers the first text sooner at the cost of more scans; `Infinity`
   * holds the whole response for a single scan at the end.
   */
  streamWindowChars?: number
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
 * interface (`transformParams`, plus `wrapGenerate` and `wrapStream` when
 * `scanResponses` is set). The hooks are generic over the call options and
 * results they pass through, so the object is assignable to the middleware
 * type of each supported `ai` major (checked by `tests/vercel-ai-types.test.ts`).
 */
export function promptGuardMiddleware(options: PromptGuardMiddlewareOptions = {}) {
  if (options.silent) setLogLevel("silent")
  else if (options.logLevel) setLogLevel(options.logLevel)

  const { apiKey, baseUrl } = resolveCredentials(options.apiKey, options.baseUrl)

  const guard = new GuardClient({
    apiKey,
    baseUrl,
    timeout: options.timeout,
    maxRetries: options.maxRetries,
    retryDelay: options.retryDelay,
  })
  const mode = options.mode ?? "enforce"
  const scanResponses = options.scanResponses ?? false
  const failOpen = options.failOpen ?? true
  const outputPolicy: OutputScanPolicy = {
    guard,
    mode,
    failOpen,
    windowChars: validateWindowChars(options.streamWindowChars ?? DEFAULT_STREAM_WINDOW_CHARS),
  }

  return {
    /**
     * The middleware specification version. ai@6 requires `"v3"` here;
     * ai@7 accepts any version string, and ai@5 does not read it. The hooks
     * themselves read every call shape from V2 to V4.
     */
    specificationVersion: "v3" as const,

    /**
     * transformParams - scans the input messages before they reach the model.
     */
    transformParams: async <P extends object>({ params }: { params: P }): Promise<P> => {
      const prompt = (params as { prompt?: unknown } | undefined)?.prompt
      if (!prompt) return params

      const { messages: guardMessages, indices } = vercelPromptToGuardMessages(prompt)
      if (!guardMessages.length) return params

      try {
        const decision = await guard.scan(guardMessages, "input", modelIdOf(params), {
          framework: "vercel-ai-sdk",
        })

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
            } as P
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
      ? async <R>({
          doGenerate,
          params,
        }: {
          doGenerate: () => PromiseLike<R>
          params?: object
        }): Promise<R> => {
          const result = await doGenerate()

          const text = extractGeneratedText(result as Record<string, unknown>)
          if (!text) return result

          await scanOutputText(text, outputPolicy, modelIdOf(params))
          return result
        }
      : undefined,

    /**
     * wrapStream - optionally scans the model's streamed response, in
     * windows and then in full, with the same decisions and the same
     * fail-open policy as wrapGenerate (see `vercel-ai-output.ts`).
     */
    wrapStream: scanResponses
      ? async <R>({
          doStream,
          params,
        }: {
          doStream: () => PromiseLike<R>
          params?: object
        }): Promise<R> => {
          const result = await doStream()
          const stream = (result as { stream?: unknown } | null)?.stream
          // Duck-typed: a stream from another realm or polyfill is still a stream.
          if (typeof (stream as ReadableStream | undefined)?.pipeThrough !== "function") {
            logger.warn(
              "streamed response has no readable stream to scan; left unscanned (framework=vercel-ai-sdk)",
            )
            return result
          }
          return {
            ...(result as object),
            stream: scanOutputStream(stream as ReadableStream, outputPolicy, modelIdOf(params)),
          } as R
        }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Model wrapper
// ---------------------------------------------------------------------------

/**
 * What every AI SDK language model specification (V1 to V4) has in common,
 * which is all `promptguard()` relies on.
 */
export interface LanguageModelLike {
  readonly specificationVersion: string
  doGenerate(options: never): PromiseLike<unknown>
  doStream(options: never): PromiseLike<unknown>
}

/**
 * Wrap an AI SDK language model so every call it makes is scanned by
 * PromptGuard, exactly as `promptGuardMiddleware(options)` would scan it
 * under `wrapLanguageModel` — generated and streamed alike.
 *
 * The wrapped model is the model it wraps in every other respect: its own
 * specification version, provider, model id, supported URLs and any other
 * property, so it is accepted wherever the original was and has the same
 * type. Options are the middleware's; the API key defaults to
 * `PROMPTGUARD_API_KEY`, and a missing one throws here rather than on the
 * first call.
 *
 * @example
 * ```ts
 * const model = promptguard(openai('gpt-5-nano'), { scanResponses: true });
 * const result = streamText({ model, prompt: 'Hello!' });
 * ```
 */
export function promptguard<M extends LanguageModelLike>(
  model: M,
  options: PromptGuardMiddlewareOptions = {},
): M {
  if (!isLanguageModel(model)) {
    throw new TypeError(
      "promptguard() takes an AI SDK language model object, e.g. promptguard(openai('gpt-5-nano'))" +
        (typeof model === "string" ? `, not a model id ("${model}")` : ""),
    )
  }
  const middleware = promptGuardMiddleware(options)

  // The same composition `wrapLanguageModel` performs: transform the call's
  // options, then let the wrap hook run the model with them.
  const call = async (type: "generate" | "stream", params: object): Promise<unknown> => {
    const transformed = await middleware.transformParams({ params })
    const doGenerate = () => model.doGenerate(transformed as never)
    const doStream = () => model.doStream(transformed as never)
    if (type === "generate") {
      return middleware.wrapGenerate
        ? middleware.wrapGenerate({ doGenerate, params: transformed })
        : doGenerate()
    }
    return middleware.wrapStream
      ? middleware.wrapStream({ doStream, params: transformed })
      : doStream()
  }
  const doGenerate = (params: object) => call("generate", params)
  const doStream = (params: object) => call("stream", params)

  // A proxy rather than a copy, so getters, methods and fields of any
  // specification version — including ones not yet written — behave as on
  // the original. Everything is read from the model itself, so getters and
  // methods that use its private state keep working.
  return new Proxy(model, {
    get(target, property) {
      if (property === "doGenerate") return doGenerate
      if (property === "doStream") return doStream
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function isLanguageModel(value: unknown): value is LanguageModelLike {
  if (!value || typeof value !== "object") return false
  const model = value as Record<string, unknown>
  return (
    typeof model.specificationVersion === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modelIdOf(params: object | undefined): string | undefined {
  const modelId = (params as { modelId?: unknown } | undefined)?.modelId
  return typeof modelId === "string" ? modelId : undefined
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
