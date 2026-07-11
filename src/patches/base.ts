/**
 * Shared patch wrapper — the single place where pre-call scan,
 * block/redact handling, original call, and post-call scan live.
 *
 * Every SDK-specific patch provides a {@link PatchConfig} describing
 * how to extract messages and responses; this module handles the rest.
 */

import {
  GuardApiError,
  type GuardClient,
  type GuardMessage,
  PromptGuardBlockedError,
  safeErrorLabel,
} from "../guard"
import { logger } from "../logger"

export interface PatchConfig {
  framework: string
  extractMessages: (
    args: unknown[],
    thisArg: unknown,
  ) => { messages: GuardMessage[]; model?: string }
  extractResponseText?: (response: unknown, args: unknown[]) => string | null
  /**
   * Rewrite the call args with the redacted message contents.
   * Return `null` when the message shape cannot be redacted safely — in
   * enforce mode that escalates the redact decision to a block.
   */
  applyRedaction?: (args: unknown[], redactedMessages: GuardMessage[]) => unknown[] | null
  shouldIntercept?: (args: unknown[], thisArg: unknown) => boolean
}

/**
 * Best-effort detection of streaming calls/results across the patched SDKs.
 *
 * Covers `{ stream: true }` request params (OpenAI/Anthropic/Cohere),
 * async-iterable results (OpenAI/Anthropic `Stream`), and Bedrock's
 * `ConverseStreamCommand` / `InvokeModelWithResponseStreamCommand`.
 */
function isStreaming(args: unknown[], response: unknown): boolean {
  const params = args[0] as Record<string, unknown> | undefined
  if (params && typeof params === "object") {
    if (params.stream === true) return true
    const commandName = (params.constructor as { name?: string } | undefined)?.name ?? ""
    if (commandName.includes("Stream")) return true
  }
  if (response && typeof response === "object" && Symbol.asyncIterator in response) return true
  return false
}

/**
 * Wrap an SDK method with pre-call (and optionally post-call) Guard scans.
 *
 * Known limitation: the wrapper is a plain `async` function, so SDK-specific
 * augmented promise types are not preserved. In particular the OpenAI SDK's
 * `APIPromise` helpers (`.withResponse()`, `.asResponse()`) are unavailable
 * on patched methods — `await` the call and use the plain result instead.
 * Output scanning (`scanResponses: true`) is also skipped for streaming
 * calls, since the stream is consumed incrementally by the caller; a debug
 * log is emitted when that happens. See README "Limitations".
 */
export function createPatchedMethod(
  original: (...args: unknown[]) => unknown,
  config: PatchConfig,
): (...args: unknown[]) => Promise<unknown> {
  return async function patched(this: unknown, ...args: unknown[]) {
    const { getGuardClient, getMode, isFailOpen, shouldScanResponses } = require("../auto")

    if (config.shouldIntercept && !config.shouldIntercept(args, this)) {
      return original.apply(this, args)
    }

    const guard: GuardClient | null = getGuardClient()
    if (!guard) return original.apply(this, args)

    const { messages, model } = config.extractMessages(args, this)

    if (messages.length) {
      let decision = null

      try {
        decision = await guard.scan(messages, "input", model, { framework: config.framework })
      } catch (err: unknown) {
        // Only the Guard API being unreachable is eligible for fail-open.
        // Any other error is a real bug and must surface.
        if (!(err instanceof GuardApiError)) throw err
        if (!isFailOpen()) throw err
        logger.warn(
          `Guard API unavailable, allowing request unscanned (failOpen=true): ${safeErrorLabel(err)}`,
        )
      }

      if (decision?.blocked) {
        if (getMode() === "enforce") throw new PromptGuardBlockedError(decision)
        logger.warn(`[monitor] would block: ${decision.threatType} (event=${decision.eventId})`)
      }

      if (decision?.redacted && decision.redactedMessages) {
        if (getMode() === "enforce") {
          const redactedArgs = config.applyRedaction
            ? config.applyRedaction(args, decision.redactedMessages)
            : null
          if (redactedArgs === null) {
            // Redaction cannot be applied to this call shape. Sending the
            // unredacted content would silently leak what the Guard API
            // asked us to redact, so escalate to a block in enforce mode.
            logger.error(
              `redact decision could not be applied for ${config.framework}; ` +
                `escalating to block (event=${decision.eventId})`,
            )
            throw new PromptGuardBlockedError(decision)
          }
          args = redactedArgs
        } else {
          logger.warn(
            `[monitor] would redact: content passed through unredacted (event=${decision.eventId})`,
          )
        }
      }
    }

    const response = await original.apply(this, args)

    if (shouldScanResponses() && response && guard && config.extractResponseText) {
      if (isStreaming(args, response)) {
        // Streaming bodies are consumed incrementally by the caller; we
        // cannot buffer them here without breaking stream semantics.
        logger.debug(
          `output scanning skipped for streaming response (framework=${config.framework})`,
        )
        return response
      }
      try {
        const text = config.extractResponseText(response, args)
        if (text) {
          const respDecision = await guard.scan(
            [{ role: "assistant", content: text }],
            "output",
            model,
          )
          if (respDecision.blocked && getMode() === "enforce") {
            throw new PromptGuardBlockedError(respDecision)
          }
        }
      } catch (err: unknown) {
        if (err instanceof PromptGuardBlockedError) throw err
        // Only swallow Guard API outages under fail-open; surface real bugs.
        if (!(err instanceof GuardApiError)) throw err
        if (!isFailOpen()) throw err
        logger.warn(
          `Guard API unavailable, response left unscanned (failOpen=true): ${safeErrorLabel(err)}`,
        )
      }
    }

    return response
  }
}
