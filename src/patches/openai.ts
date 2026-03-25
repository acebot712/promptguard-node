/**
 * OpenAI SDK patch - wraps the `create` method on the Chat Completions
 * prototype (sync and async).
 *
 * This single patch covers every framework built on the `openai` npm
 * package: LangChain.js (ChatOpenAI), Vercel AI SDK (openai provider),
 * AutoGen.js, CrewAI.js, and direct usage.
 */

import { GuardApiError, type GuardMessage, PromptGuardBlockedError } from "../guard"

let originalCreate: ((...args: unknown[]) => unknown) | null = null
let patched = false

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

export function messagesToGuardFormat(messages: unknown[]): GuardMessage[] {
  if (!messages) return []
  const result: GuardMessage[] = []

  for (const raw of messages) {
    if (!raw) continue
    const msg = raw as Record<string, unknown>
    const role: string = String(msg.role ?? "user")
    let content: string

    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = []
      for (const part of msg.content) {
        if (typeof part === "string") textParts.push(part)
        else if (part?.type === "text") textParts.push(part.text ?? "")
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
    const r = response as { choices?: { message?: { content?: string } }[] }
    if (r?.choices?.[0]?.message?.content) {
      return r.choices[0].message.content
    }
  } catch {
    // ignore
  }
  return null
}

function applyRedaction(messages: unknown[], redacted: GuardMessage[]): unknown[] {
  return messages.map((msg, i) => {
    if (i < redacted.length && typeof msg === "object" && msg !== null) {
      return { ...msg, content: redacted[i].content }
    }
    return msg
  })
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(): boolean {
  if (patched) return true

  let Completions: { prototype: { create: unknown } }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("openai/resources/chat/completions")
    Completions = mod.Completions
    if (!Completions?.prototype?.create) return false
  } catch {
    return false
  }

  originalCreate = Completions.prototype.create as typeof originalCreate

  Completions.prototype.create = async function patchedCreate(this: unknown, ...args: unknown[]) {
    const { getGuardClient, getMode, isFailOpen, shouldScanResponses } = require("../auto")

    const guard = getGuardClient()
    if (!guard) return originalCreate?.apply(this, args)

    const params = (args[0] ?? {}) as Record<string, unknown>
    const messages = params.messages as unknown[] | undefined
    const model = params.model

    // -- Pre-call scan ---------------------------------------------------
    if (messages) {
      const guardMessages = messagesToGuardFormat(messages)
      let decision = null

      try {
        decision = await guard.scan(guardMessages, "input", model ? String(model) : undefined, {
          framework: "openai",
        })
      } catch (err: unknown) {
        if (err instanceof GuardApiError && !isFailOpen()) throw err
        // fail-open: continue
      }

      if (decision?.blocked) {
        if (getMode() === "enforce") throw new PromptGuardBlockedError(decision)
        console.warn(
          `[promptguard][monitor] would block: ${decision.threatType} (event=${decision.eventId})`,
        )
      }

      if (decision?.redacted && decision.redactedMessages) {
        if (getMode() === "enforce") {
          args[0] = {
            ...params,
            messages: applyRedaction(messages, decision.redactedMessages),
          }
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
        // fail-open
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
    const mod = require("openai/resources/chat/completions")
    mod.Completions.prototype.create = originalCreate
  } catch {
    // ignore
  }

  originalCreate = null
  patched = false
}
