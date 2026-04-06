/**
 * Cohere SDK patch - wraps `Client.prototype.chat` and
 * `ClientV2.prototype.chat` from the `cohere-ai` npm package.
 *
 * Covers direct Cohere usage and frameworks that use it (LangChain.js
 * ChatCohere, Haystack, etc.).
 *
 * Cohere has two client generations:
 *  - V1 (`Client`): `chat({ message, chatHistory })` returning `{ text }`
 *  - V2 (`ClientV2`): `chat({ messages })` returning `{ message.content }`
 */

import type { GuardMessage } from "../guard"
import { createPatchedMethod, type PatchConfig } from "./base"

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
// Shared config
// ---------------------------------------------------------------------------

const cohereConfig: PatchConfig = {
  framework: "cohere",
  extractMessages: (args) => {
    const params = (args[0] ?? {}) as Record<string, unknown>
    return {
      messages: messagesToGuardFormat(params),
      model: params.model ? String(params.model) : "cohere",
    }
  },
  extractResponseText: (response) => extractResponseText(response),
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(): boolean {
  if (patched) return true

  let cohere: Record<string, { prototype: { chat?: unknown } }>
  try {
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

      const original = cls.prototype.chat as (...args: unknown[]) => unknown
      originals.set(key, original)
      cls.prototype.chat = createPatchedMethod(original, cohereConfig)
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
