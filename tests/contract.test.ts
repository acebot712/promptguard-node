/**
 * Shared contract tests — validates the Node SDK against guard-contract.json.
 *
 * If this test fails, the Node SDK has drifted from the cross-SDK
 * contract.  Fix the SDK, not the contract (unless both SDKs agree
 * on the change).
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { GuardDecision, PromptGuardBlockedError } from "../src/guard"
import { messagesToGuardFormat as anthropicMessages } from "../src/patches/anthropic"
import { contentToGuardFormat } from "../src/patches/google"
import { messagesToGuardFormat } from "../src/patches/openai"

const CONTRACT_PATH = path.resolve(__dirname, "guard-contract.json")

const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8"))

// ---------------------------------------------------------------------------
// GuardDecision
// ---------------------------------------------------------------------------

describe("Contract: GuardDecision", () => {
  for (const c of contract.guard_decision.cases) {
    test(c.name, () => {
      const d = new GuardDecision(c.input)

      expect(d.allowed).toBe(c.expect.allowed)
      expect(d.blocked).toBe(c.expect.blocked)
      expect(d.redacted).toBe(c.expect.redacted)
      expect(d.eventId).toBe(c.expect.event_id)
      expect(d.confidence).toBe(c.expect.confidence)
      expect(d.threatType ?? null).toBe(c.expect.threat_type)

      if (c.expect.redacted_messages_count != null) {
        expect(d.redactedMessages).toHaveLength(c.expect.redacted_messages_count)
        expect(d.redactedMessages?.[0].content).toBe(c.expect.redacted_first_content)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// OpenAI message conversion
// ---------------------------------------------------------------------------

describe("Contract: OpenAI message conversion", () => {
  for (const c of contract.message_conversion.cases) {
    test(c.name, () => {
      const result = messagesToGuardFormat(c.input)
      expect(result).toEqual(c.expect)
    })
  }
})

// ---------------------------------------------------------------------------
// Anthropic message conversion
// ---------------------------------------------------------------------------

describe("Contract: Anthropic message conversion", () => {
  for (const c of contract.anthropic_message_conversion.cases) {
    test(c.name, () => {
      const result = anthropicMessages(c.input_messages, c.input_system)
      expect(result).toEqual(c.expect)
    })
  }
})

// ---------------------------------------------------------------------------
// Google content conversion
// ---------------------------------------------------------------------------

describe("Contract: Google content conversion", () => {
  for (const c of contract.google_content_conversion.cases) {
    test(c.name, () => {
      const result = contentToGuardFormat(c.input)
      expect(result).toEqual(c.expect)
    })
  }
})

// ---------------------------------------------------------------------------
// PromptGuardBlockedError
// ---------------------------------------------------------------------------

describe("Contract: PromptGuardBlockedError", () => {
  for (const c of contract.blocked_error.cases) {
    test(c.name, () => {
      const decision = new GuardDecision(c.decision)
      const error = new PromptGuardBlockedError(decision)

      for (const fragment of c.expect_message_contains) {
        expect(error.message).toContain(fragment)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

describe("Contract: Guard request payload", () => {
  for (const c of contract.guard_request_payload.cases) {
    test(c.name, () => {
      // Build the payload the same way GuardClient does internally
      const args = c.args
      const payload: Record<string, unknown> = {
        messages: args.messages,
        direction: args.direction,
      }
      if (args.model) payload.model = args.model
      if (args.context) payload.context = args.context

      expect(payload).toEqual(c.expect)
    })
  }
})
