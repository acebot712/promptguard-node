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
} from "../guard"

export interface PatchConfig {
  framework: string
  extractMessages: (
    args: unknown[],
    thisArg: unknown,
  ) => { messages: GuardMessage[]; model?: string }
  extractResponseText?: (response: unknown, args: unknown[]) => string | null
  applyRedaction?: (args: unknown[], redactedMessages: GuardMessage[]) => unknown[]
  shouldIntercept?: (args: unknown[], thisArg: unknown) => boolean
}

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
        if (err instanceof GuardApiError && !isFailOpen()) throw err
      }

      if (decision?.blocked) {
        if (getMode() === "enforce") throw new PromptGuardBlockedError(decision)
        console.warn(
          `[promptguard][monitor] would block: ${decision.threatType} (event=${decision.eventId})`,
        )
      }

      if (decision?.redacted && decision.redactedMessages && config.applyRedaction) {
        if (getMode() === "enforce") {
          args = config.applyRedaction(args, decision.redactedMessages)
        }
      }
    }

    const response = await original.apply(this, args)

    if (shouldScanResponses() && response && guard && config.extractResponseText) {
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
        if (err instanceof GuardApiError && !isFailOpen()) throw err
      }
    }

    return response
  }
}
