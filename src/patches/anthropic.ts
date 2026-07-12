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

/**
 * Flatten an Anthropic `system` param (string or content-block array) into
 * guard-message text. Returns `null` when no system guard-message would be
 * emitted (absent, or an array with no text blocks) — the single source of
 * truth for the redaction index offset in {@link applyRedactionToArgs}.
 */
export function systemToGuardContent(system: unknown): string | null {
  if (!system) return null
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    const parts: string[] = []
    for (const block of system) {
      if (typeof block === "object" && block?.type === "text") {
        parts.push(block.text ?? "")
      }
    }
    if (parts.length) return parts.join("\n")
  }
  return null
}

export function messagesToGuardFormat(messages: unknown[], system?: unknown): GuardMessage[] {
  const result: GuardMessage[] = []

  const systemContent = systemToGuardContent(system)
  if (systemContent !== null) {
    result.push({ role: "system", content: systemContent })
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

/**
 * Map redacted guard messages back onto Anthropic call args.
 *
 * The redaction offset is computed from whether a system guard-message was
 * actually emitted by {@link messagesToGuardFormat} (via
 * {@link systemToGuardContent}) — not merely from `system` being present —
 * so an array system with no text blocks does not shift indices.
 */
export function applyRedactionToArgs(
  args: unknown[],
  redactedMessages: GuardMessage[],
): unknown[] | null {
  const params = (args[0] ?? {}) as Record<string, unknown>
  const messages = params.messages as unknown[] | undefined
  if (!Array.isArray(messages)) return null

  const systemEmitted = systemToGuardContent(params.system) !== null
  const offset = systemEmitted ? 1 : 0

  const newParams = { ...params }
  if (systemEmitted && redactedMessages[0]) {
    // Preserve the original shape: content-block array stays an array.
    newParams.system = Array.isArray(params.system)
      ? [{ type: "text", text: redactedMessages[0].content }]
      : redactedMessages[0].content
  }
  // messagesToGuardFormat skips falsy entries, so track the guard index
  // separately from the array position to keep redactions aligned.
  let guardIdx = offset
  newParams.messages = messages.map((msg: unknown) => {
    if (!msg) return msg
    const r = redactedMessages[guardIdx++]
    if (r && typeof msg === "object") {
      const m = msg as Record<string, unknown>
      // Preserve the multimodal shape: array content is rebuilt as a text
      // block rather than collapsed to a bare string.
      const content = Array.isArray(m.content) ? [{ type: "text", text: r.content }] : r.content
      return { ...m, content }
    }
    return msg
  })
  return [newParams, ...args.slice(1)]
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
    applyRedaction: applyRedactionToArgs,
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
