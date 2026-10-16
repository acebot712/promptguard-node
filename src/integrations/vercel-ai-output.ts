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
 * - **Enforce mode** holds back the stream parts that carry scanned text
 *   (text deltas, tool-call input) until that text has been scanned. Each
 *   time `windowChars` new characters have arrived, everything held is
 *   scanned and, if clean, released — except the last `WINDOW_OVERLAP_CHARS`
 *   characters, which stay held and are scanned again at the head of the next
 *   window. So every released character has been scanned together with at
 *   least the overlap that follows it, and a secret up to the overlap long is
 *   always seen whole before any of it is released. When the model finishes,
 *   the complete text is scanned — the same text, built the same way, as a
 *   generated result — before the held tail and the `finish` part are
 *   released. Parts that carry no scanned text (stream start, reasoning,
 *   sources, files, metadata) are delivered at once when nothing is held
 *   ahead of them, and queue behind held text otherwise, so order is kept.
 * - **Monitor mode** never stops a call, so it never holds one: parts pass
 *   through as they arrive and only the complete text is scanned, at the end.
 *
 * Reasoning is not scanned, here or on the generated path.
 *
 * A block (or an output redact, which cannot be honoured on text already
 * generated) stops the stream with `PromptGuardBlockedError`. A Guard API
 * outage fails open by default (ADR-0002): the held parts are released and the
 * rest of that stream passes unscanned, so an outage costs one failed scan per
 * stream rather than one per window. With `failOpen: false` it stops the
 * stream with the `GuardApiError` instead.
 *
 * How a stopped stream ends is the caller's choice (`StreamStop`): by
 * erroring it, so whatever reads it throws, or by delivering one AI SDK
 * `error` part and closing it. Either way nothing held is released and the
 * `finish` part never arrives.
 */

import { GuardApiError, type GuardClient, PromptGuardBlockedError, safeErrorLabel } from "../guard"
import { logger } from "../logger"

/**
 * Default new characters of streamed output per scanned window.
 *
 * Not taken from any external standard: 1000 was chosen as a balance between
 * how long output is held and how many Guard API round trips a stream costs.
 * At roughly four characters a token it is about 250 tokens, which takes a
 * model a few seconds to generate — about as long as one Guard round trip, so
 * scanning a window roughly keeps pace with generating the next. A smaller
 * window delivers the first text sooner and costs more scans; a larger one
 * costs fewer scans and holds output longer.
 */
export const DEFAULT_STREAM_WINDOW_CHARS = 1000

/**
 * Characters of scanned text always kept held and rescanned at the head of
 * the next window — the longest secret guaranteed to be seen whole across a
 * window boundary.
 */
export const WINDOW_OVERLAP_CHARS = 200

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
 * What happened to a piece of output that was allowed through: `"scanned"`
 * when the Guard API saw it, `"failed-open"` when it was unreachable and
 * fail-open let the output through unscanned.
 */
export type OutputScanOutcome = "scanned" | "failed-open"

/**
 * Scan one piece of model output. Resolves when the output may be delivered;
 * throws `PromptGuardBlockedError` when enforce mode stops it, and rethrows
 * the `GuardApiError` when failing closed.
 */
export async function scanOutputText(
  text: string,
  policy: OutputScanPolicy,
  modelId: string | undefined,
  what = "response",
): Promise<OutputScanOutcome> {
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
    return "scanned"
  } catch (err) {
    if (err instanceof PromptGuardBlockedError) throw err
    // Only a Guard API outage is eligible for fail-open; rethrow the
    // original error when failing closed.
    if (!(err instanceof GuardApiError)) throw err
    if (!policy.failOpen) throw err
    logger.warn(
      `Guard API unavailable, ${what} left unscanned (failOpen=true): ${safeErrorLabel(err)}`,
    )
    return "failed-open"
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
 * How a stream the policy stops ends: `"error"` errors the stream, so the
 * reader's next read throws the error; `"error-part"` delivers one
 * `{ type: "error", error }` stream part — the AI SDK's own way for a model to
 * report a failure mid-stream — and then closes the stream.
 */
export type StreamStop = "error" | "error-part"

/**
 * Wrap a model stream so its output is scanned as described in this module's
 * header. Parts are passed through unchanged and in order; where the policy
 * stops the output, the stream ends with `PromptGuardBlockedError` (or the
 * `GuardApiError` when failing closed), as `stopAs` says.
 */
export function scanOutputStream<T>(
  stream: ReadableStream<T>,
  policy: OutputScanPolicy,
  modelId: string | undefined,
  stopAs: StreamStop = "error",
): ReadableStream<T> {
  const output = new StreamedOutput()
  const enforce = policy.mode === "enforce"
  const what = "streamed response"

  /** Held parts, in order, with the scanned text each carries. */
  let held: { part: T; text: string }[] = []
  /** Total length of the text carried by `held`. */
  let heldChars = 0
  /** Characters that have arrived since the last window scan. */
  let unscannedChars = 0
  /** Set once fail-open has given up on this stream. */
  let unscanned = false
  /** Set once the stream has ended with an error part. */
  let stopped = false

  const releaseAll = (controller: TransformStreamDefaultController<T>) => {
    for (const { part } of held) controller.enqueue(part)
    held = []
    heldChars = 0
  }

  /** Release from the front while the overlap stays held behind it. */
  const releaseScanned = (controller: TransformStreamDefaultController<T>) => {
    while (held.length && heldChars - held[0].text.length >= WINDOW_OVERLAP_CHARS) {
      const front = held.shift() as { part: T; text: string }
      heldChars -= front.text.length
      controller.enqueue(front.part)
    }
  }

  return stream.pipeThrough(
    new TransformStream<T, T>({
      async transform(part, controller) {
        if (stopped) return
        try {
          await step(part, controller)
        } catch (err) {
          stop(err, controller)
          // Ends the stream here, and cancels the model's stream behind it.
          controller.terminate()
        }
      },

      async flush(controller) {
        if (stopped) return
        try {
          await finish(controller)
        } catch (err) {
          stop(err, controller)
        }
      },
    }),
  )

  /** End a stopped stream as `stopAs` says. */
  function stop(err: unknown, controller: TransformStreamDefaultController<T>): void {
    if (stopAs === "error") throw err
    stopped = true
    controller.enqueue({ type: "error", error: err } as T)
  }

  async function step(part: T, controller: TransformStreamDefaultController<T>): Promise<void> {
    if (unscanned) {
      controller.enqueue(part)
      return
    }
    const record = part && typeof part === "object" ? (part as Record<string, unknown>) : null
    const text = record ? output.add(record) : ""

    if (!enforce) {
      controller.enqueue(part)
      return
    }

    // Nothing to scan and nothing ahead of it: no reason to hold it. The
    // finish part always waits for the final scan.
    if (!text && !held.length && record?.type !== "finish") {
      controller.enqueue(part)
      return
    }

    held.push({ part, text })
    heldChars += text.length
    unscannedChars += text.length
    if (unscannedChars < policy.windowChars) return

    unscannedChars = 0
    const window = held.map((h) => h.text).join("")
    // Throws on block or fail-closed, which stops the stream (see `stop`).
    const outcome = await scanOutputText(window, policy, modelId, `rest of ${what}`)
    if (outcome === "scanned") {
      releaseScanned(controller)
    } else {
      unscanned = true
      releaseAll(controller)
    }
  }

  async function finish(controller: TransformStreamDefaultController<T>): Promise<void> {
    if (unscanned) return
    const text = output.text()
    if (text) await scanOutputText(text, policy, modelId, what)
    releaseAll(controller)
  }
}
