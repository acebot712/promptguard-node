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

function extractMessagesFromBody(raw: unknown): GuardMessage[] {
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
