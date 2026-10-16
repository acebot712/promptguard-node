/**
 * Output scanning for the Vercel AI SDK integration — generated and streamed.
 *
 * This is the one place that decides what a model's output is scanned as and
 * what a decision about it does. The middleware (`vercel-ai.ts`) calls it from
 * both `wrapGenerate` and `wrapStream`, and anything else that wraps an AI SDK
 * model should call it too rather than restating the policy.
 *
 * Streams are scanned in windows, then once more in full:
 *
 * - **Enforce mode** holds stream parts back until the text they carry has
 *   been scanned. Every `windowChars` characters of output, the window (plus
 *   the end of the previous one as context) is scanned and, if clean, its
 *   parts are released. When the model finishes, the complete text is scanned
 *   — the same text, built the same way, as a generated result — before the
 *   last window and the `finish` part are released. Nothing reaches the caller
 *   unscanned, and at most one window is held at a time.
 * - **Monitor mode** never stops a call, so it never holds one: parts pass
 *   through as they arrive and only the complete text is scanned, at the end.
 *
 * A block (or an output redact, which cannot be honoured on text already
 * generated) stops the stream with `PromptGuardBlockedError`. A Guard API
 * outage fails open by default (ADR-0002): the held parts are released and the
 * rest of that stream passes unscanned, so an outage costs one failed scan per
 * stream rather than one per window. With `failOpen: false` it stops the
 * stream with the `GuardApiError` instead.
 */

import { GuardApiError, type GuardClient, PromptGuardBlockedError, safeErrorLabel } from "../guard"
import { logger } from "../logger"

/** Default characters of streamed output per scanned window. */
export const DEFAULT_STREAM_WINDOW_CHARS = 1000

/**
 * Characters of already-scanned output prepended to each window, so content
 * split across a window boundary is still seen whole.
 */
const WINDOW_CONTEXT_CHARS = 200

export interface OutputScanPolicy {
  guard: GuardClient
  mode: "enforce" | "monitor"
  failOpen: boolean
  /** Characters per streamed window; `Infinity` holds the whole response. */
  windowChars: number
}

/** Throws `RangeError` unless `value` is a usable `streamWindowChars`. */
export function validateWindowChars(value: number): number {
  if (!(value > 0)) {
    throw new RangeError(`streamWindowChars must be a positive number, got ${value}`)
  }
  return value
}

/**
 * Scan one piece of model output. Returns `true` when it was scanned and may
 * be delivered, `false` when the Guard API was unreachable and fail-open let
 * it through unscanned. Throws `PromptGuardBlockedError` when enforce mode
 * stops it, and rethrows the `GuardApiError` when failing closed.
 */
export async function scanOutputText(
  text: string,
  policy: OutputScanPolicy,
  modelId: string | undefined,
  what = "response",
): Promise<boolean> {
  try {
    const decision = await policy.guard.scan(
      [{ role: "assistant", content: text }],
      "output",
      modelId,
      { framework: "vercel-ai-sdk" },
    )
    if (decision.blocked || decision.redacted) {
      // Generated output cannot be rewritten after the fact, so an
      // output-direction redact decision is enforced as a block.
      if (policy.mode === "enforce") throw new PromptGuardBlockedError(decision)
      logger.warn(
        `[monitor] would ${decision.redacted ? "redact" : "block"} ${what}: ${decision.threatType}`,
      )
    }
    return true
  } catch (err) {
    if (err instanceof PromptGuardBlockedError) throw err
    // Only a Guard API outage is eligible for fail-open; rethrow the
    // original error when failing closed.
    if (!(err instanceof GuardApiError)) throw err
    if (!policy.failOpen) throw err
    logger.warn(
      `Guard API unavailable, ${what} left unscanned (failOpen=true): ${safeErrorLabel(err)}`,
    )
    return false
  }
}

/**
 * Extract all scannable text from a `doGenerate` result.
 *
 * Handles both AI SDK result shapes:
 *  - **v4 (LanguageModelV1):** top-level `text` string plus `toolCalls`
 *    (every tool call's `args`/`input` is scanned — not just the first).
 *  - **v5+ (LanguageModelV2/V3):** `content` is an array of parts
 *    (`{ type: "text", text }` / `{ type: "tool-call", input }`) with no
 *    top-level `text`.
 *
 * Returns the concatenated text, or `null` when nothing scannable exists.
 */
export function extractGeneratedText(
  result: Record<string, unknown> | null | undefined,
): string | null {
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
 * Accumulates a model stream's parts into the result `doGenerate` would have
 * returned, so the final scan sees exactly what a generated response would.
 *
 * Recognises both stream-part vocabularies:
 *  - **LanguageModelV1:** `text-delta { textDelta }`,
 *    `tool-call-delta { toolCallId, argsTextDelta }`, `tool-call { args }`.
 *  - **LanguageModelV2/V3:** `text-delta { id, delta }`,
 *    `tool-input-delta { id, delta }`, `tool-call { toolCallId, input }`.
 */
class StreamedOutput {
  /** Text blocks by id, in first-seen order (V1 parts have no id). */
  private readonly texts = new Map<string, string>()
  /** Tool input assembled from deltas, by call id. */
  private readonly toolDeltas = new Map<string, string>()
  /** Complete tool calls, by call id. */
  private readonly toolCalls = new Map<string, unknown>()

  /**
   * Record one part. Returns the newly visible text it carries (for the
   * window), or `""` when it carries none.
   */
  add(part: Record<string, unknown>): string {
    switch (part.type) {
      case "text-delta": {
        const delta = str(part.delta) ?? str(part.textDelta) ?? ""
        const id = str(part.id) ?? ""
        this.texts.set(id, (this.texts.get(id) ?? "") + delta)
        return delta
      }
      case "tool-input-delta":
      case "tool-call-delta": {
        const delta = str(part.delta) ?? str(part.argsTextDelta) ?? ""
        const id = str(part.id) ?? str(part.toolCallId) ?? ""
        this.toolDeltas.set(id, (this.toolDeltas.get(id) ?? "") + delta)
        return delta
      }
      case "tool-call": {
        const id = str(part.toolCallId) ?? ""
        const input = part.input ?? part.args
        if (input == null) return ""
        this.toolCalls.set(id, input)
        // Input already streamed as deltas was counted when it arrived.
        if (this.toolDeltas.has(id)) return ""
        return typeof input === "string" ? input : JSON.stringify(input)
      }
      default:
        return ""
    }
  }

  /** The complete output, as `extractGeneratedText` renders a generated result. */
  text(): string | null {
    const content: Record<string, unknown>[] = []
    for (const text of this.texts.values()) content.push({ type: "text", text })
    for (const [id, input] of this.toolCalls)
      content.push({ type: "tool-call", toolCallId: id, input })
    // A call streamed as deltas whose closing `tool-call` part never came.
    for (const [id, input] of this.toolDeltas) {
      if (!this.toolCalls.has(id)) content.push({ type: "tool-call", toolCallId: id, input })
    }
    return extractGeneratedText({ content })
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Wrap a model stream so its output is scanned as described in this module's
 * header. Parts are passed through unchanged and in order; the returned
 * stream errors with `PromptGuardBlockedError` (or `GuardApiError` when
 * failing closed) instead of delivering output the policy stops.
 */
export function scanOutputStream<T>(
  stream: ReadableStream<T>,
  policy: OutputScanPolicy,
  modelId: string | undefined,
): ReadableStream<T> {
  const output = new StreamedOutput()
  const enforce = policy.mode === "enforce"
  const what = "streamed response"

  let pending: T[] = []
  /** Every window's text so far, for context on the next window. */
  let seen = ""
  /** Text of the current window, not yet scanned. */
  let windowText = ""
  /** Set once fail-open has given up on this stream. */
  let unscanned = false

  const release = (controller: TransformStreamDefaultController<T>) => {
    for (const part of pending) controller.enqueue(part)
    pending = []
  }

  const failedOpen = (controller: TransformStreamDefaultController<T>) => {
    unscanned = true
    release(controller)
  }

  return stream.pipeThrough(
    new TransformStream<T, T>({
      async transform(part, controller) {
        if (unscanned) {
          controller.enqueue(part)
          return
        }
        const added =
          part && typeof part === "object" ? output.add(part as Record<string, unknown>) : ""

        if (!enforce) {
          controller.enqueue(part)
          return
        }

        pending.push(part)
        windowText += added
        if (windowText.length < policy.windowChars) return

        const context = seen.slice(-WINDOW_CONTEXT_CHARS)
        seen += windowText
        const scanText = context + windowText
        windowText = ""
        // Throws on block or fail-closed, which errors the stream with it.
        if (await scanOutputText(scanText, policy, modelId, `rest of ${what}`)) {
          release(controller)
        } else {
          failedOpen(controller)
        }
      },

      async flush(controller) {
        if (unscanned) return
        const text = output.text()
        if (text) await scanOutputText(text, policy, modelId, what)
        release(controller)
      },
    }),
  )
}
