/**
 * Cohere SDK patch — wraps `Client.prototype.chat` and
 * `ClientV2.prototype.chat` from the `cohere-ai` npm package.
 *
 * Covers direct Cohere usage and frameworks that use it (LangChain.js
 * ChatCohere, Haystack, etc.).
 *
 * Cohere has two client generations:
 *  - V1 (`Client`): `chat({ message, chatHistory })` returning `{ text }`
 *  - V2 (`ClientV2`): `chat({ messages })` returning `{ message.content }`
 */

import { GuardApiError, type GuardMessage, PromptGuardBlockedError } from "../guard"

const originals: Map<string, (...args: unknown[]) => unknown> = new Map()
let patched = false

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function messagesToGuardFormat(params: Record<string, unknown>): GuardMessage[] {
  const result: GuardMessage[] = []

  if (params.messages && Array.isArray(params.messages)) {
    for (const msg of params.messages) {
      if (!msg) continue
      const role = String(msg.role ?? "user")
      const content = String(msg.content ?? "")
      result.push({ role, content })
    }
    return result
  }

  if (params.chatHistory && Array.isArray(params.chatHistory)) {
    for (const msg of params.chatHistory) {
      if (!msg) continue
      const role = String(msg.role ?? "user")
      const content = String(msg.message ?? msg.content ?? "")
      result.push({ role, content })
    }
  }

  if (params.message) {
    result.push({ role: "user", content: String(params.message) })
  }

  return result
}

function extractResponseText(response: unknown): string | null {
  try {
    const r = response as Record<string, unknown>
    if (typeof r?.text === "string") return r.text
    const message = r?.message as Record<string, unknown> | undefined
    if (message?.content) {
      const parts = message.content
      if (Array.isArray(parts)) {
        const texts: string[] = []
        for (const p of parts) {
          if (p?.text) texts.push(String(p.text))
        }
        return texts.length ? texts.join("\n") : null
      }
      return String(parts)
    }
  } catch {
    // ignore
  }
  return null
}

// ---------------------------------------------------------------------------
// Patch factory
// ---------------------------------------------------------------------------

function createPatchedChat(
  originalChat: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedChat(this: unknown, ...args: unknown[]) {
    const { getGuardClient, getMode, isFailOpen, shouldScanResponses } = require("../auto")

    const guard = getGuardClient()
    if (!guard) return originalChat.apply(this, args)

    const params = (args[0] ?? {}) as Record<string, unknown>
    const guardMessages = messagesToGuardFormat(params)
    const model = params.model ? String(params.model) : "cohere"

    // -- Pre-call scan ---------------------------------------------------
    if (guardMessages.length) {
      let decision = null

      try {
        decision = await guard.scan(guardMessages, "input", model, {
          framework: "cohere",
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
    }

    // -- Original call ---------------------------------------------------
    const response = await originalChat.apply(this, args)

    // -- Post-call scan --------------------------------------------------
    if (shouldScanResponses() && response && guard) {
      try {
        const text = extractResponseText(response)
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

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(): boolean {
  if (patched) return true

  let cohere: Record<string, { prototype: { chat?: unknown } }>
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cohere = require("cohere-ai")
  } catch {
    return false
  }

  let patchedAny = false

  for (const className of ["CohereClientV2", "ClientV2", "CohereClient", "Client"]) {
    try {
      const cls = cohere[className]
      if (!cls?.prototype?.chat) continue
      const key = `${className}.chat`
      if (originals.has(key)) continue

      originals.set(key, cls.prototype.chat as (...args: unknown[]) => unknown)
      cls.prototype.chat = createPatchedChat(cls.prototype.chat as (...args: unknown[]) => unknown)
      patchedAny = true
    } catch {
      // class not available in this version
    }
  }

  patched = patchedAny
  return patched
}

export function revert(): void {
  if (!patched) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cohere = require("cohere-ai") as Record<string, { prototype: { chat?: unknown } }>
    for (const [key, original] of originals) {
      const className = key.split(".")[0]
      try {
        const cls = cohere[className]
        if (cls?.prototype) cls.prototype.chat = original
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  originals.clear()
  patched = false
}
