/**
 * Google Gen AI SDK patch — `@google/genai`, the SDK Google ships today.
 *
 * `./google.ts` covers `@google/generative-ai`, which Google deprecated when
 * Gemini 2.0 landed. Both are patched: customers are still on the old one, and
 * dropping it to chase the new one would leave them silently unprotected, which
 * is the exact bug adding this file fixes in the other direction.
 *
 * **This one cannot be patched on the prototype.** Every other patch in this
 * directory does `Klass.prototype.method = wrapped`. In `@google/genai`,
 * `generateContent` is assigned as an **own property in the constructor** —
 * `Models.prototype.generateContent` is `undefined`, and each client instance
 * gets its own copy. Verified against the published package rather than
 * assumed; the prototype approach would have installed cleanly, patched
 * nothing, and reported success.
 *
 * So the exported `GoogleGenAI` constructor is swapped for a subclass that
 * wraps the instance methods after `super()` has created them. Public API only,
 * no reliance on the `*Internal` methods, which are unstable by name.
 */

import type { GuardMessage } from "../guard"
import { createPatchedMethod } from "./base"

export const NAME = "google-genai"

/** Package names that mean this patch is relevant. See `auto.ts`. */
export const DETECTS = ["@google/genai"]

let originalConstructor: unknown = null
let patched = false

// -- Message extraction ------------------------------------------------------

function partText(part: unknown): string {
  if (typeof part === "string") return part
  if (!part || typeof part !== "object") return ""
  const p = part as Record<string, unknown>
  const found: string[] = []

  if (typeof p.text === "string" && p.text) found.push(p.text)

  // Tool traffic. Exfiltration through a tool call is written into the
  // arguments, not into the visible prose, so these are read deliberately.
  for (const key of ["functionCall", "function_call"]) {
    const call = p[key] as Record<string, unknown> | undefined
    if (!call) continue
    if (typeof call.name === "string" && call.name) found.push(call.name)
    if (call.args && typeof call.args === "object") found.push(JSON.stringify(call.args))
  }
  for (const key of ["functionResponse", "function_response"]) {
    const resp = p[key] as Record<string, unknown> | undefined
    if (resp?.response && typeof resp.response === "object")
      found.push(JSON.stringify(resp.response))
  }
  for (const key of ["executableCode", "executable_code"]) {
    const code = p[key] as Record<string, unknown> | undefined
    if (typeof code?.code === "string" && code.code) found.push(code.code)
  }
  for (const key of ["codeExecutionResult", "code_execution_result"]) {
    const result = p[key] as Record<string, unknown> | undefined
    if (typeof result?.output === "string" && result.output) found.push(result.output)
  }

  return found.join("\n")
}

/** Flatten `contents` — a string, a Content, or a list mixing both. */
export function contentsToGuardFormat(contents: unknown): GuardMessage[] {
  if (contents == null) return []
  if (typeof contents === "string") return [{ role: "user", content: contents }]

  const items = Array.isArray(contents) ? contents : [contents]
  const out: GuardMessage[] = []
  for (const item of items) {
    if (typeof item === "string") {
      out.push({ role: "user", content: item })
      continue
    }
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const parts = record.parts
    const text = Array.isArray(parts)
      ? parts.map(partText).filter(Boolean).join("\n")
      : partText(record)
    if (text) out.push({ role: String(record.role ?? "user"), content: text })
  }
  return out
}

/** The system prompt, which lives in `config` and not in `contents` at all. */
export function systemInstructionText(config: unknown): string {
  if (!config || typeof config !== "object") return ""
  const instruction = (config as Record<string, unknown>).systemInstruction
  if (instruction == null) return ""
  if (typeof instruction === "string") return instruction
  const parts = (instruction as Record<string, unknown>).parts
  if (Array.isArray(parts)) return parts.map(partText).filter(Boolean).join("\n")
  return partText(instruction)
}

export function extractMessages(args: unknown[]): { messages: GuardMessage[]; model: string } {
  const request = (args[0] ?? {}) as Record<string, unknown>
  const messages: GuardMessage[] = []

  const system = systemInstructionText(request.config)
  if (system) messages.push({ role: "system", content: system })
  messages.push(...contentsToGuardFormat(request.contents))

  return { messages, model: typeof request.model === "string" ? request.model : "gemini" }
}

export function extractResponseText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null
  const candidates = (response as Record<string, unknown>).candidates
  if (Array.isArray(candidates)) {
    const texts: string[] = []
    for (const candidate of candidates) {
      const content = (candidate as Record<string, unknown>)?.content as
        | Record<string, unknown>
        | undefined
      const parts = content?.parts
      if (Array.isArray(parts)) texts.push(...parts.map(partText).filter(Boolean))
    }
    if (texts.length) return texts.join("\n")
  }
  const text = (response as Record<string, unknown>).text
  return typeof text === "string" ? text : null
}

/**
 * Rewrite `contents` with the redacted text.
 *
 * The system instruction lives in `config` and is not rewritten here, so a
 * redaction that only fired on it returns null and `base.ts` fails safe to a
 * block rather than forwarding text we were told to remove.
 */
export function applyRedactionToArgs(args: unknown[], redacted: GuardMessage[]): unknown[] | null {
  const body = redacted.filter((m) => m.role !== "system")
  if (!body.length) return null
  const request = (args[0] ?? {}) as Record<string, unknown>
  return [
    {
      ...request,
      contents: body.map((m) => ({ role: m.role ?? "user", parts: [{ text: m.content }] })),
    },
    ...args.slice(1),
  ]
}

// -- Apply / revert ----------------------------------------------------------

const WRAPPED_METHODS = ["generateContent", "generateContentStream"]

export function apply(): boolean {
  if (patched) return true

  let mod: Record<string, unknown>
  try {
    mod = require("@google/genai")
  } catch {
    return false
  }

  const Original = mod.GoogleGenAI as (new (...args: unknown[]) => unknown) | undefined
  if (typeof Original !== "function") return false

  const descriptor = Object.getOwnPropertyDescriptor(mod, "GoogleGenAI")
  if (descriptor && descriptor.writable === false && descriptor.configurable === false) return false

  class PatchedGoogleGenAI extends (Original as new (
    ...args: unknown[]
  ) => Record<string, unknown>) {
    constructor(...args: unknown[]) {
      super(...args)
      const models = this.models as Record<string, unknown> | undefined
      if (!models) return
      for (const method of WRAPPED_METHODS) {
        const original = models[method]
        if (typeof original !== "function") continue
        models[method] = createPatchedMethod(
          (original as (...a: unknown[]) => unknown).bind(models),
          {
            framework: NAME,
            extractMessages: (a: unknown[]) => extractMessages(a),
            extractResponseText,
            applyRedaction: applyRedactionToArgs,
          },
        )
      }
    }
  }

  try {
    Object.defineProperty(mod, "GoogleGenAI", {
      value: PatchedGoogleGenAI,
      writable: true,
      configurable: true,
    })
  } catch {
    return false
  }

  originalConstructor = Original
  patched = true
  return true
}

export function revert(): void {
  if (!patched) return
  try {
    const mod = require("@google/genai") as Record<string, unknown>
    Object.defineProperty(mod, "GoogleGenAI", {
      value: originalConstructor,
      writable: true,
      configurable: true,
    })
  } catch {
    // Package went away between apply() and revert(); nothing to restore.
  }
  originalConstructor = null
  patched = false
}
