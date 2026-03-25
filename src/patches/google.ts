/**
 * Google Generative AI SDK patch - wraps
 * `GenerativeModel.prototype.generateContent` from `@google/generative-ai`.
 *
 * Covers direct Google AI usage and frameworks built on top (LangChain.js
 * ChatGoogleGenerativeAI, etc.).
 */

import { GuardApiError, type GuardMessage, PromptGuardBlockedError } from "../guard"

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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@google/generative-ai")
    GenerativeModel = mod.GenerativeModel
    if (!GenerativeModel?.prototype?.generateContent) return false
  } catch {
    return false
  }

  originalGenerate = GenerativeModel.prototype.generateContent as typeof originalGenerate

  GenerativeModel.prototype.generateContent = async function patchedGenerate(
    this: Record<string, unknown>,
    ...args: unknown[]
  ) {
    const { getGuardClient, getMode, isFailOpen, shouldScanResponses } = require("../auto")

    const guard = getGuardClient()
    if (!guard) return originalGenerate?.apply(this, args)

    const contents = args[0]
    const modelName = String(this.model ?? this.modelName ?? "gemini")

    // -- Pre-call scan ---------------------------------------------------
    if (contents) {
      const guardMessages = contentToGuardFormat(contents)
      let decision = null

      try {
        decision = await guard.scan(guardMessages, "input", modelName, {
          framework: "google-generativeai",
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
    const response = await originalGenerate?.apply(this, args)

    // -- Post-call scan --------------------------------------------------
    if (shouldScanResponses() && response && guard) {
      try {
        const text = extractResponseText(response)
        if (text) {
          const respDecision = await guard.scan(
            [{ role: "assistant", content: text }],
            "output",
            modelName,
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
  if (!patched || !originalGenerate) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
