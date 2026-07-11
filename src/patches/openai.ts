/**
 * OpenAI SDK patch - wraps the `create` method on the Chat Completions
 * prototype (sync and async).
 *
 * This single patch covers every framework built on the `openai` npm
 * package: LangChain.js (ChatOpenAI), Vercel AI SDK (openai provider),
 * AutoGen.js, CrewAI.js, and direct usage.
 */

import type { GuardMessage } from "../guard"
import { logger } from "../logger"
import { createPatchedMethod } from "./base"

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

export function applyRedactionToArgs(args: unknown[], redacted: GuardMessage[]): unknown[] | null {
  const params = (args[0] ?? {}) as Record<string, unknown>
  const messages = params.messages as unknown[] | undefined
  if (!Array.isArray(messages)) return null
  // messagesToGuardFormat skips falsy entries, so track the guard index
  // separately from the array position to keep redactions aligned.
  let guardIdx = 0
  const newMessages = messages.map((msg) => {
    if (!msg) return msg
    const r = redacted[guardIdx++]
    if (r && typeof msg === "object") return { ...msg, content: r.content }
    return msg
  })
  return [{ ...params, messages: newMessages }, ...args.slice(1)]
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(): boolean {
  if (patched) return true

  let Completions: { prototype: { create: unknown } }
  try {
    const mod = require("openai/resources/chat/completions")
    Completions = mod.Completions
    if (!Completions?.prototype?.create) return false
  } catch {
    return false
  }

  const original = Completions.prototype.create as (...args: unknown[]) => unknown
  originalCreate = original

  Completions.prototype.create = createPatchedMethod(original, {
    framework: "openai",
    extractMessages: (args) => {
      const params = (args[0] ?? {}) as Record<string, unknown>
      const messages = params.messages as unknown[] | undefined
      return {
        messages: messages ? messagesToGuardFormat(messages) : [],
        model: params.model ? String(params.model) : undefined,
      }
    },
    extractResponseText: (response) => extractResponseContent(response),
    applyRedaction: applyRedactionToArgs,
  })

  patched = true
  // Logged once per process (apply() is idempotent via the `patched` flag).
  logger.debug(
    "openai patch active: APIPromise helpers (.withResponse()/.asResponse()) " +
      "are not preserved on patched methods — see README 'Limitations'",
  )
  return true
}

export function revert(): void {
  if (!patched || !originalCreate) return

  try {
    const mod = require("openai/resources/chat/completions")
    mod.Completions.prototype.create = originalCreate
  } catch {
    // ignore
  }

  originalCreate = null
  patched = false
}
