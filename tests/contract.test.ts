/**
 * Shared contract tests - validates the Node SDK against guard-contract.json.
 *
 * If this test fails, the Node SDK has drifted from the cross-SDK
 * contract.  Fix the SDK, not the contract (unless both SDKs agree
 * on the change).
 *
 * That sentence used to be untrue in an important way. `guard-contract.json` is
 * vendored from the platform monorepo's `packages/sdk-shared/guard-contract.json`
 * and was hand-copied, so every assertion below compared this SDK against a
 * local duplicate of itself. It could not detect the one thing its own comment
 * promised. It did not: on 2026-08-11 the monorepo source turned out to be two
 * minor versions behind this copy (v1.3.0 against v1.5.1), missing the whole
 * `redaction_enforcement` section, and five months stale.
 *
 * "Contract provenance" below is the part that can now fail. The monorepo
 * publishes the contract at a public URL; `.github/workflows/sync-from-api.yml`
 * fetches it weekly and `scripts/sync-guard-contract.ts` records the digest it
 * adopted in `guard-contract.lock.json`. Editing either file by hand breaks the
 * pair, which is exactly the move that caused the drift.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { GuardApiError, GuardDecision, PromptGuardBlockedError } from "../src/guard"

// The redaction-enforcement contract section drives the real patch wrapper
// with a stubbed auto module (resolved lazily via require() inside base.ts).
jest.mock("../src/auto", () => ({
  getGuardClient: jest.fn(),
  getMode: jest.fn(),
  isFailOpen: jest.fn(),
  shouldScanResponses: jest.fn(),
}))

import * as autoModule from "../src/auto"
import { messagesToGuardFormat as anthropicMessages } from "../src/patches/anthropic"
import { createPatchedMethod } from "../src/patches/base"
import { contentToGuardFormat } from "../src/patches/google"
import { messagesToGuardFormat } from "../src/patches/openai"

const CONTRACT_PATH = path.resolve(__dirname, "guard-contract.json")
const LOCK_PATH = path.resolve(__dirname, "guard-contract.lock.json")

// The canonical URL the contract is synced from. Asserted rather than merely
// recorded: repointing the sync at some other origin should be a visible test
// change, not a one-line edit to a workflow nobody reads.
const CANONICAL_SOURCE = "https://promptguard.co/contracts/guard-contract.json"

const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8"))

// ---------------------------------------------------------------------------
// Provenance - the check that was missing
// ---------------------------------------------------------------------------

/**
 * Everything else in this file tests the SDK against the contract.  This block
 * tests the *contract* - that the copy in this repo is still the one that was
 * synced from upstream, and not something someone adjusted locally to make a
 * failing assertion go away.
 */
describe("Contract provenance", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf-8"))

  test("contract matches the digest recorded at sync time", () => {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(CONTRACT_PATH)).digest("hex")

    // Thrown rather than asserted: Jest has no per-assertion message, and a
    // bare digest mismatch tells the next person nothing about what to do.
    if (actual !== lock.sha256) {
      throw new Error(
        "tests/guard-contract.json does not match the digest recorded in " +
          `tests/guard-contract.lock.json.\n  file:     ${actual}\n` +
          `  lockfile: ${lock.sha256}\n\n` +
          "This copy is vendored from the platform monorepo and is not yours to " +
          "edit. If the contract genuinely changed, change it in " +
          "packages/sdk-shared/guard-contract.json, let `make docs` publish it, and " +
          "take the PR that .github/workflows/sync-from-api.yml opens - which " +
          "updates both files together. If you are mid-sync locally, run " +
          "scripts/sync-guard-contract.ts against the fetched file.",
      )
    }
  })

  test("version matches the lockfile", () => {
    expect(contract._version).toBe(lock.version)
  })

  test("lockfile points at the canonical source", () => {
    expect(lock.source).toBe(CANONICAL_SOURCE)
  })

  // A digest comparison that cannot fail is decoration.  The assertion above is
  // only worth having if a single mutated byte actually breaks it, so that is
  // exercised rather than assumed.
  test("a changed byte would be caught", () => {
    const mutated = fs
      .readFileSync(CONTRACT_PATH)
      .toString("utf-8")
      .replace('"_version"', '"_verzion"')

    expect(crypto.createHash("sha256").update(mutated).digest("hex")).not.toBe(lock.sha256)
  })
})

// ---------------------------------------------------------------------------
// GuardDecision
// ---------------------------------------------------------------------------

describe("Contract: GuardDecision", () => {
  for (const c of contract.guard_decision.cases) {
    test(c.name, () => {
      if (c.expect_error) {
        // Malformed decisions must raise the SDK's API-error type instead
        // of silently defaulting to allow.
        expect(c.expect_error).toBe("GuardApiError")
        expect(() => new GuardDecision(c.input)).toThrow(GuardApiError)
        return
      }

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

// ---------------------------------------------------------------------------
// Redaction enforcement (contract v1.5.0)
// ---------------------------------------------------------------------------

describe("Contract: Redaction enforcement", () => {
  const auto = autoModule as unknown as Record<string, jest.Mock>

  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  for (const c of contract.redaction_enforcement.cases) {
    test(c.name, async () => {
      // Monitor-mode passthrough cases warn; keep test output clean.
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

      const decision = new GuardDecision(c.decision)
      auto.getGuardClient.mockReturnValue({ scan: jest.fn().mockResolvedValue(decision) })
      auto.getMode.mockReturnValue(c.mode)
      auto.isFailOpen.mockReturnValue(true)

      if ((c.direction ?? "input") === "output") {
        // Output-direction cases drive the response-scan path: no input
        // scan (nothing extracted), the wrapped call returns the scanned
        // content as its response, and a redact decision must block in
        // enforce mode (responses cannot be rewritten in flight).
        auto.shouldScanResponses.mockReturnValue(true)
        const responseText: string = c.scanned_messages[0].content
        const original = jest.fn().mockResolvedValue(responseText)
        const patched = createPatchedMethod(original, {
          framework: "contract",
          extractMessages: () => ({ messages: [] }),
          extractResponseText: (response) => response as string,
        })

        if (c.expect === "block") {
          await expect(patched({})).rejects.toThrow(PromptGuardBlockedError)
          expect(original).toHaveBeenCalled()
        } else if (c.expect === "passthrough") {
          await expect(patched({})).resolves.toBe(responseText)
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("would redact"))
        } else {
          throw new Error(`${c.name}: unknown output expect ${c.expect}`)
        }

        warnSpy.mockRestore()
        return
      }

      auto.shouldScanResponses.mockReturnValue(false)

      const forwarded: unknown[] = []
      const original = jest.fn((...args: unknown[]) => {
        forwarded.push(...args)
        return Promise.resolve("ok")
      })

      const patched = createPatchedMethod(original, {
        framework: "contract",
        extractMessages: () => ({ messages: c.scanned_messages }),
        applyRedaction: c.has_redaction_applier
          ? (args, redacted) => [
              { ...(args[0] as Record<string, unknown>), messages: redacted },
              ...args.slice(1),
            ]
          : undefined,
      })

      if (c.expect === "block") {
        await expect(patched({ messages: c.scanned_messages })).rejects.toThrow(
          PromptGuardBlockedError,
        )
        expect(original).not.toHaveBeenCalled()
      } else if (c.expect === "apply") {
        await patched({ messages: c.scanned_messages })
        expect((forwarded[0] as { messages: unknown }).messages).toEqual(
          c.decision.redacted_messages,
        )
      } else if (c.expect === "passthrough") {
        await patched({ messages: c.scanned_messages })
        expect((forwarded[0] as { messages: unknown }).messages).toEqual(c.scanned_messages)
      } else {
        throw new Error(`${c.name}: unknown expect ${c.expect}`)
      }

      warnSpy.mockRestore()
    })
  }
})
