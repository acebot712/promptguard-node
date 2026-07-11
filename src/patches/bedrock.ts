/**
 * AWS Bedrock Runtime patch - wraps the `send` method on
 * `BedrockRuntimeClient` from `@aws-sdk/client-bedrock-runtime`.
 *
 * Unlike the other patches which target LLM-specific SDKs, this wraps
 * the AWS SDK v3 command pattern: `client.send(new InvokeModelCommand(...))`
 * and `client.send(new ConverseCommand(...))`.
 *
 * Covers all Bedrock-hosted models: Claude, Titan, Llama, Mistral, Cohere,
 * and any model accessible via the Bedrock Runtime API.
 */

import type { GuardMessage } from "../guard"
import { createPatchedMethod } from "./base"

let originalSend: ((...args: unknown[]) => unknown) | null = null
let patched = false

const BEDROCK_COMMANDS = new Set(["InvokeModelCommand", "ConverseCommand", "ConverseStreamCommand"])

// ---------------------------------------------------------------------------
// Message extraction (Bedrock-specific, handles multiple model formats)
// ---------------------------------------------------------------------------

function flattenContentBlocks(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        if (block.type === "text" || "text" in block) texts.push(String(block.text ?? ""))
      }
    }
    return texts.join("\n")
  }
  return String(content ?? "")
}

function extractSystem(system: unknown, result: GuardMessage[]): void {
  if (!system) return
  if (typeof system === "string") {
    result.push({ role: "system", content: system })
  } else if (Array.isArray(system)) {
    const texts: string[] = []
    for (const block of system) {
      if (typeof block === "object" && block !== null && "text" in block) {
        texts.push(String(block.text ?? ""))
      }
    }
    if (texts.length) result.push({ role: "system", content: texts.join("\n") })
  }
}

export function extractMessagesFromBody(raw: unknown): GuardMessage[] {
  let body = raw
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return []
    }
  }
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      return [{ role: "user", content: body as string }]
    }
  }
  if (typeof body !== "object" || body === null) return []

  const obj = body as Record<string, unknown>
  const result: GuardMessage[] = []

  if (obj.messages && Array.isArray(obj.messages)) {
    extractSystem(obj.system, result)
    for (const msg of obj.messages) {
      if (typeof msg === "object" && msg !== null) {
        result.push({
          role: String(msg.role ?? "user"),
          content: flattenContentBlocks(msg.content ?? ""),
        })
      }
    }
    return result
  }

  if (obj.Messages && Array.isArray(obj.Messages)) {
    extractSystem(obj.System ?? obj.system, result)
    for (const msg of obj.Messages) {
      if (typeof msg === "object" && msg !== null) {
        result.push({
          role: String((msg.Role ?? msg.role ?? "user") as string).toLowerCase(),
          content: flattenContentBlocks(msg.Content ?? msg.content ?? ""),
        })
      }
    }
    return result
  }

  if (obj.inputText) return [{ role: "user", content: String(obj.inputText) }]
  if (obj.prompt) return [{ role: "user", content: String(obj.prompt) }]

  return []
}

// ---------------------------------------------------------------------------
// Redaction (mirrors the extraction rules above)
// ---------------------------------------------------------------------------

/**
 * Whether {@link extractSystem} emitted a system guard-message for this
 * `system` value. Must stay in sync with extractSystem so the redaction
 * index offset matches the guard messages that were actually sent.
 */
function systemGuardEmitted(system: unknown): boolean {
  if (!system) return false
  if (typeof system === "string") return true
  if (Array.isArray(system)) {
    return system.some((block) => typeof block === "object" && block !== null && "text" in block)
  }
  return false
}

/**
 * Redact a `{ system?, messages }` object in place of the guard messages.
 * `makeBlocks` produces the content-block shape for this API surface
 * (Converse uses `[{ text }]`, Anthropic invoke-model bodies use
 * `[{ type: "text", text }]`).
 */
function redactMessagesObject(
  obj: Record<string, unknown>,
  redacted: GuardMessage[],
  makeBlocks: (text: string) => unknown,
): Record<string, unknown> | null {
  const messages = obj.messages
  if (!Array.isArray(messages)) return null

  const newObj = { ...obj }
  let guardIdx = 0
  if (systemGuardEmitted(obj.system)) {
    const r = redacted[0]
    if (r) {
      newObj.system = typeof obj.system === "string" ? r.content : makeBlocks(r.content)
    }
    guardIdx = 1
  }

  newObj.messages = messages.map((msg) => {
    // Non-object entries were skipped by extraction; skip them here too.
    if (typeof msg !== "object" || msg === null) return msg
    const r = redacted[guardIdx++]
    if (!r) return msg
    const m = msg as Record<string, unknown>
    const content = Array.isArray(m.content) ? makeBlocks(r.content) : r.content
    return { ...m, content }
  })
  return newObj
}

/** Redact an InvokeModelCommand JSON body, preserving its encoding. */
function redactInvokeModelBody(rawBody: unknown, redacted: GuardMessage[]): unknown | null {
  let bodyStr: string
  let wasBinary: boolean
  if (
    rawBody instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(rawBody))
  ) {
    try {
      bodyStr = new TextDecoder().decode(rawBody as Uint8Array)
      wasBinary = true
    } catch {
      return null
    }
  } else if (typeof rawBody === "string") {
    bodyStr = rawBody
    wasBinary = false
  } else {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyStr)
  } catch {
    // Extraction treated an unparseable string body as one user message.
    return !wasBinary && redacted[0] ? redacted[0].content : null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  let newObj: Record<string, unknown> | null = null
  if (Array.isArray(obj.messages)) {
    newObj = redactMessagesObject(obj, redacted, (text) => [{ type: "text", text }])
  } else if (obj.inputText != null && redacted[0]) {
    newObj = { ...obj, inputText: redacted[0].content }
  } else if (obj.prompt != null && redacted[0]) {
    newObj = { ...obj, prompt: redacted[0].content }
  }
  if (newObj === null) return null

  const newStr = JSON.stringify(newObj)
  return wasBinary ? new TextEncoder().encode(newStr) : newStr
}

/**
 * Map redacted guard messages back onto a Bedrock command.
 *
 * Returns `null` for shapes we cannot rewrite safely (e.g. the capitalized
 * `Messages` variant) — in enforce mode the caller escalates to a block
 * rather than sending unredacted content.
 */
export function applyRedactionToArgs(args: unknown[], redacted: GuardMessage[]): unknown[] | null {
  try {
    const command = args[0] as Record<string, unknown> | undefined
    if (!command || typeof command !== "object") return null
    const commandName = (command.constructor as { name?: string })?.name ?? ""
    const input = (command.input ?? {}) as Record<string, unknown>

    let newInput: Record<string, unknown> | null = null
    if (commandName === "InvokeModelCommand") {
      const newBody = redactInvokeModelBody(input.body, redacted)
      newInput = newBody === null ? null : { ...input, body: newBody }
    } else if (commandName === "ConverseCommand" || commandName === "ConverseStreamCommand") {
      newInput = redactMessagesObject(input, redacted, (text) => [{ text }])
    }
    if (newInput === null) return null

    // Clone preserving the prototype so `constructor.name` checks and the
    // command's middleware still work, then swap in the redacted input.
    const newCommand = Object.assign(Object.create(Object.getPrototypeOf(command)), command, {
      input: newInput,
    })
    return [newCommand, ...args.slice(1)]
  } catch {
    return null
  }
}

function extractBedrockResponseText(response: unknown, commandName: string): string {
  if (!response || typeof response !== "object") return ""
  const obj = response as Record<string, unknown>

  if (commandName === "ConverseCommand") {
    const output = obj.output as Record<string, unknown> | undefined
    const message = output?.message as Record<string, unknown> | undefined
    const content = message?.content as unknown[] | undefined
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "object" && block !== null && "text" in block) {
            return String((block as Record<string, unknown>).text)
          }
          return ""
        })
        .join("")
    }
    return ""
  }

  const body = obj.body
  if (body instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(body))) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body as Uint8Array)) as Record<
        string,
        unknown
      >
      if (typeof parsed.completion === "string") return parsed.completion
      if (typeof parsed.generation === "string") return parsed.generation
      const results = parsed.results as Array<Record<string, unknown>> | undefined
      if (Array.isArray(results) && results.length > 0) {
        return String(results[0].outputText ?? results[0].text ?? "")
      }
    } catch {
      return ""
    }
  }

  return ""
}

// ---------------------------------------------------------------------------
// Apply / revert
// ---------------------------------------------------------------------------

export function apply(): boolean {
  if (patched) return true

  let BedrockRuntimeClient: { prototype: { send: unknown } }
  try {
    const mod = require("@aws-sdk/client-bedrock-runtime")
    BedrockRuntimeClient = mod.BedrockRuntimeClient
    if (!BedrockRuntimeClient?.prototype?.send) return false
  } catch {
    return false
  }

  const original = BedrockRuntimeClient.prototype.send as (...args: unknown[]) => unknown
  originalSend = original

  BedrockRuntimeClient.prototype.send = createPatchedMethod(original, {
    framework: "aws-bedrock",
    shouldIntercept: (args) => {
      const command = args[0] as Record<string, unknown>
      const commandName = (command?.constructor as { name?: string })?.name ?? ""
      return BEDROCK_COMMANDS.has(commandName)
    },
    extractMessages: (args) => {
      const command = args[0] as Record<string, unknown>
      const commandName = (command?.constructor as { name?: string })?.name ?? ""
      const input = (command.input ?? {}) as Record<string, unknown>
      const modelId = String(input.modelId ?? input.ModelId ?? "bedrock")
      const messages =
        commandName === "InvokeModelCommand"
          ? extractMessagesFromBody(input.body)
          : extractMessagesFromBody(input)
      return { messages, model: modelId }
    },
    extractResponseText: (response, args) => {
      const command = args[0] as Record<string, unknown>
      const commandName = (command?.constructor as { name?: string })?.name ?? ""
      return extractBedrockResponseText(response, commandName) || null
    },
    applyRedaction: applyRedactionToArgs,
  })

  patched = true
  return true
}

export function revert(): void {
  if (!patched || !originalSend) return

  try {
    const mod = require("@aws-sdk/client-bedrock-runtime")
    if (mod.BedrockRuntimeClient?.prototype) {
      mod.BedrockRuntimeClient.prototype.send = originalSend
    }
  } catch {
    // ignore
  }

  originalSend = null
  patched = false
}
