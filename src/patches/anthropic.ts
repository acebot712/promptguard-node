/**
 * Anthropic SDK patch - wraps `Messages.prototype.create` from
 * `@anthropic-ai/sdk`.
 *
 * Covers direct Anthropic usage and frameworks that use it (LangChain.js
 * ChatAnthropic, etc.).
 */

import type { GuardMessage } from "../guard"
import { createPatchedMethod } from "./base"

let originalCreate: ((...args: unknown[]) => unknown) | null = null
let patched = false

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

export function messagesToGuardFormat(messages: unknown[], system?: unknown): GuardMessage[] {
  const result: GuardMessage[] = []

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
    const mod = require("@anthropic-ai/sdk/resources/messages")
    Messages = mod.Messages
    if (!Messages?.prototype?.create) return false
  } catch {
    return false
  }

  const original = Messages.prototype.create as (...args: unknown[]) => unknown
  originalCreate = original

  Messages.prototype.create = createPatchedMethod(original, {
    framework: "anthropic",
    extractMessages: (args) => {
      const params = (args[0] ?? {}) as Record<string, unknown>
      const messages = params.messages as unknown[] | undefined
      return {
        messages: messages ? messagesToGuardFormat(messages, params.system) : [],
        model: params.model ? String(params.model) : undefined,
      }
    },
    extractResponseText: (response) => extractResponseContent(response),
    applyRedaction: (args, redactedMessages) => {
      const params = (args[0] ?? {}) as Record<string, unknown>
      const messages = params.messages as unknown[]
      const hasSystem = params.system != null
      const offset = hasSystem ? 1 : 0

      const newParams = { ...params }
      if (hasSystem && redactedMessages[0]) {
        newParams.system = redactedMessages[0].content
      }
      newParams.messages = messages.map((msg: unknown, i: number) => {
        const idx = i + offset
        if (idx < redactedMessages.length) {
          return { ...(msg as Record<string, unknown>), content: redactedMessages[idx].content }
        }
        return msg
      })
      return [newParams, ...args.slice(1)]
    },
  })

  patched = true
  return true
}

export function revert(): void {
  if (!patched || !originalCreate) return

  try {
    const mod = require("@anthropic-ai/sdk/resources/messages")
    mod.Messages.prototype.create = originalCreate
  } catch {
    // ignore
  }

  originalCreate = null
  patched = false
}
