/**
 * Google Generative AI SDK patch - wraps
 * `GenerativeModel.prototype.generateContent` from `@google/generative-ai`.
 *
 * Covers direct Google AI usage and frameworks built on top (LangChain.js
 * ChatGoogleGenerativeAI, etc.).
 */

import type { GuardMessage } from "../guard"
import { createPatchedMethod } from "./base"

let originalGenerate: ((...args: unknown[]) => unknown) | null = null
let patched = false

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

export function contentToGuardFormat(contents: unknown): GuardMessage[] {
  if (typeof contents === "string") {
    return [{ role: "user", content: contents }]
  }

  if (!Array.isArray(contents)) {
    return [{ role: "user", content: String(contents ?? "") }]
  }

  const result: GuardMessage[] = []
  for (const item of contents) {
    if (typeof item === "string") {
      result.push({ role: "user", content: item })
    } else if (item?.role && item?.parts) {
      const text = extractTextFromParts(item.parts)
      result.push({ role: item.role ?? "user", content: text })
    } else if (item?.parts) {
      result.push({ role: "user", content: extractTextFromParts(item.parts) })
    } else {
      result.push({ role: "user", content: String(item) })
    }
  }

  return result
}

function extractTextFromParts(parts: unknown): string {
  if (typeof parts === "string") return parts
  if (!Array.isArray(parts)) return String(parts ?? "")

  const texts: string[] = []
  for (const part of parts) {
    if (typeof part === "string") texts.push(part)
    else if (part?.text != null) texts.push(String(part.text))
  }
  return texts.join("\n")
}

export function extractResponseText(response: unknown): string | null {
  try {
    const r = response as Record<string, unknown>
    if (typeof r?.text === "function") return (r.text as () => string)()
    if (typeof r?.text === "string") return r.text
    const candidates = r?.candidates as Record<string, unknown>[] | undefined
    if (candidates?.[0]?.content) {
      const content = candidates[0].content as Record<string, unknown>
      if (content?.parts) return extractTextFromParts(content.parts)
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

  let GenerativeModel: { prototype: { generateContent: unknown } }
  try {
    const mod = require("@google/generative-ai")
    GenerativeModel = mod.GenerativeModel
    if (!GenerativeModel?.prototype?.generateContent) return false
  } catch {
    return false
  }

  const original = GenerativeModel.prototype.generateContent as (...args: unknown[]) => unknown
  originalGenerate = original

  GenerativeModel.prototype.generateContent = createPatchedMethod(original, {
    framework: "google-generativeai",
    extractMessages: (args, thisArg) => {
      const contents = args[0]
      const self = thisArg as Record<string, unknown>
      const modelName = String(self.model ?? self.modelName ?? "gemini")
      return {
        messages: contents ? contentToGuardFormat(contents) : [],
        model: modelName,
      }
    },
    extractResponseText: (response) => extractResponseText(response),
  })

  patched = true
  return true
}

export function revert(): void {
  if (!patched || !originalGenerate) return

  try {
    const mod = require("@google/generative-ai")
    if (mod.GenerativeModel) {
      mod.GenerativeModel.prototype.generateContent = originalGenerate
    }
  } catch {
    // ignore
  }

  originalGenerate = null
  patched = false
}
