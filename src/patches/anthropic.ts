/**
 * Anthropic SDK patch — wraps `Messages.prototype.create` from
 * `@anthropic-ai/sdk`.
 *
 * Covers direct Anthropic usage and frameworks that use it (LangChain.js
 * ChatAnthropic, etc.).
 */

import { GuardApiError, type GuardMessage, PromptGuardBlockedError } from "../guard"

let originalCreate: ((...args: unknown[]) => unknown) | null = null
let patched = false

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

export function messagesToGuardFormat(messages: unknown[], system?: unknown): GuardMessage[] {
  const result: GuardMessage[] = []

  // Anthropic separates the system prompt from the messages array.
  if (system) {
    if (typeof system === "string") {
      result.push({ role: "system", content: system })
    } else if (Array.isArray(system)) {
      const parts: string[] = []
      for (const block of system) {
        if (typeof block === "object" && block?.type === "text") {
          parts.push(block.text ?? "")
        }
      }
      if (parts.length) result.push({ role: "system", content: parts.join("\n") })
    }
  }

  if (!messages) return result

  for (const raw of messages) {
    if (!raw) continue
    const msg = raw as Record<string, unknown>
    const role = String(msg.role ?? "user")
    let content: string

    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = []
      for (const block of msg.content) {
        if (typeof block === "string") textParts.push(block)
        else if (block?.type === "text") textParts.push(block.text ?? "")
      }
      content = textParts.join("\n")
    } else {
      content = String(msg.content ?? "")
    }

    result.push({ role, content })
  }

  return result
}

export function extractResponseContent(response: unknown): string | null {
  try {
    const r = response as Record<string, unknown>
    if (r?.content && Array.isArray(r.content)) {
      const parts: string[] = []
      for (const block of r.content) {
        if (block?.type === "text") parts.push(block.text ?? "")
      }
      return parts.length ? parts.join("\n") : null
    }
  } catch {
    // ignore
  }
  return null
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(): boolean {
  if (patched) return true

  let Messages: { prototype: { create: unknown } }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@anthropic-ai/sdk/resources/messages")
    Messages = mod.Messages
    if (!Messages?.prototype?.create) return false
  } catch {
    return false
  }

  originalCreate = Messages.prototype.create as typeof originalCreate

  Messages.prototype.create = async function patchedCreate(this: unknown, ...args: unknown[]) {
    const { getGuardClient, getMode, isFailOpen, shouldScanResponses } = require("../auto")

    const guard = getGuardClient()
    if (!guard) return originalCreate?.apply(this, args)

    const params = (args[0] ?? {}) as Record<string, unknown>
    const messages = params.messages as unknown[] | undefined
    const system = params.system
    const model = params.model

    // -- Pre-call scan ---------------------------------------------------
    if (messages) {
      const guardMessages = messagesToGuardFormat(messages, system)
      let decision = null

      try {
        decision = await guard.scan(guardMessages, "input", model ? String(model) : undefined, {
          framework: "anthropic",
        })
      } catch (err: unknown) {
        if (err instanceof GuardApiError && !isFailOpen()) throw err
      }

      if (decision?.blocked) {
        if (getMode() === "enforce") throw new PromptGuardBlockedError(decision)
        console.warn(
          `[promptguard][monitor] would block: ${decision.threatType} (event=${decision.eventId})`,
        )
      }

      if (decision?.redacted && decision.redactedMessages) {
        if (getMode() === "enforce") {
          const redacted = decision.redactedMessages
          const hasSystem = system != null
          const offset = hasSystem ? 1 : 0

          const newParams = { ...params }
          if (hasSystem && redacted[0]) {
            newParams.system = redacted[0].content
          }
          newParams.messages = messages.map((msg: unknown, i: number) => {
            const idx = i + offset
            if (idx < redacted.length) {
              const typedMsg = msg as Record<string, unknown>
              return { ...typedMsg, content: redacted[idx].content }
            }
            return msg
          })
          args[0] = newParams
        }
      }
    }

    // -- Original call ---------------------------------------------------
    const response = await originalCreate?.apply(this, args)

    // -- Post-call scan --------------------------------------------------
    if (shouldScanResponses() && response && guard) {
      try {
        const text = extractResponseContent(response)
        if (text) {
          const respDecision = await guard.scan(
            [{ role: "assistant", content: text }],
            "output",
            model ? String(model) : undefined,
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

  patched = true
  return true
}

export function revert(): void {
  if (!patched || !originalCreate) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@anthropic-ai/sdk/resources/messages")
    mod.Messages.prototype.create = originalCreate
  } catch {
    // ignore
  }

  originalCreate = null
  patched = false
}
