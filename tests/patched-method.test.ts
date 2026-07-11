/**
 * Tests for the shared patch wrapper (src/patches/base.ts) — every
 * decision × mode × failOpen combination against a stubbed guard client,
 * plus redaction escalation and streaming skip behavior.
 */

import { GuardApiError, GuardDecision, PromptGuardBlockedError } from "../src/guard"
import { createPatchedMethod, type PatchConfig } from "../src/patches/base"

jest.mock("../src/auto", () => ({
  getGuardClient: jest.fn(),
  getMode: jest.fn(),
  isFailOpen: jest.fn(),
  shouldScanResponses: jest.fn(),
}))

// The wrapper resolves ../auto lazily via require(); jest.mock above
// intercepts that resolution, so these accessors control the wrapper.
import * as autoModule from "../src/auto"

const auto = autoModule as unknown as Record<string, jest.Mock>

// ── Decision fixtures ────────────────────────────────────────────────

const allowDecision = () =>
  new GuardDecision({
    decision: "allow",
    event_id: "e-allow",
    confidence: 0,
    threats: [],
    latency_ms: 1,
  })

const blockDecision = () =>
  new GuardDecision({
    decision: "block",
    event_id: "e-block",
    confidence: 0.95,
    threat_type: "prompt_injection",
    threats: [],
    latency_ms: 1,
  })

const redactDecision = () =>
  new GuardDecision({
    decision: "redact",
    event_id: "e-redact",
    confidence: 0.8,
    threat_type: "pii",
    redacted_messages: [{ role: "user", content: "[REDACTED]" }],
    threats: [],
    latency_ms: 1,
  })

// ── Harness ──────────────────────────────────────────────────────────

interface SetupOptions {
  mode?: "enforce" | "monitor"
  failOpen?: boolean
  scanResponses?: boolean
  scanImpl?: jest.Mock
  config?: Partial<PatchConfig>
}

const baseConfig: PatchConfig = {
  framework: "test",
  extractMessages: (args) => {
    const params = (args[0] ?? {}) as { messages?: Array<{ role: string; content: string }> }
    return { messages: params.messages ?? [], model: "test-model" }
  },
  extractResponseText: (response) => (response as { text?: string } | null)?.text ?? null,
  applyRedaction: (args, redacted) => [
    { ...(args[0] as Record<string, unknown>), messages: redacted },
    ...args.slice(1),
  ],
}

function setup(options: SetupOptions = {}) {
  const scan = options.scanImpl ?? jest.fn().mockResolvedValue(allowDecision())
  const guard = { scan }
  auto.getGuardClient.mockReturnValue(guard)
  auto.getMode.mockReturnValue(options.mode ?? "enforce")
  auto.isFailOpen.mockReturnValue(options.failOpen ?? true)
  auto.shouldScanResponses.mockReturnValue(options.scanResponses ?? false)

  const original = jest.fn().mockResolvedValue({ text: "model output" })
  const patched = createPatchedMethod(original, { ...baseConfig, ...options.config })
  return { scan, original, patched }
}

const userMessages = [{ role: "user", content: "hello" }]

afterEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
})

// ── Input decisions × modes ──────────────────────────────────────────

describe("createPatchedMethod input scanning", () => {
  test("allow: calls original with untouched args", async () => {
    const { original, patched, scan } = setup()
    const result = await patched({ messages: userMessages })
    expect(scan).toHaveBeenCalledWith(userMessages, "input", "test-model", { framework: "test" })
    expect(original).toHaveBeenCalledWith({ messages: userMessages })
    expect(result).toEqual({ text: "model output" })
  })

  test("block + enforce: throws PromptGuardBlockedError, original never called", async () => {
    const { original, patched } = setup({
      mode: "enforce",
      scanImpl: jest.fn().mockResolvedValue(blockDecision()),
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(PromptGuardBlockedError)
    expect(original).not.toHaveBeenCalled()
  })

  test("block + monitor: warns and proceeds", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    const { original, patched } = setup({
      mode: "monitor",
      scanImpl: jest.fn().mockResolvedValue(blockDecision()),
    })
    const result = await patched({ messages: userMessages })
    expect(original).toHaveBeenCalled()
    expect(result).toEqual({ text: "model output" })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[monitor]"))
  })

  test("guard outage + failOpen=true: proceeds unscanned", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    const { original, patched } = setup({
      failOpen: true,
      scanImpl: jest.fn().mockRejectedValue(new GuardApiError("down", 503)),
    })
    const result = await patched({ messages: userMessages })
    expect(original).toHaveBeenCalled()
    expect(result).toEqual({ text: "model output" })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failOpen=true"))
  })

  test("guard outage + failOpen=false: rethrows GuardApiError, original never called", async () => {
    const { original, patched } = setup({
      failOpen: false,
      scanImpl: jest.fn().mockRejectedValue(new GuardApiError("down", 503)),
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(GuardApiError)
    expect(original).not.toHaveBeenCalled()
  })

  test("non-GuardApiError bugs surface even with failOpen=true", async () => {
    const { original, patched } = setup({
      failOpen: true,
      scanImpl: jest.fn().mockRejectedValue(new TypeError("bug in extraction")),
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(TypeError)
    expect(original).not.toHaveBeenCalled()
  })

  test("no guard client: passthrough without scanning", async () => {
    const { original, patched, scan } = setup()
    auto.getGuardClient.mockReturnValue(null)
    await patched({ messages: userMessages })
    expect(scan).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalled()
  })
})

// ── Redaction ────────────────────────────────────────────────────────

describe("createPatchedMethod redaction", () => {
  test("redact + enforce: original called with redacted args", async () => {
    const { original, patched } = setup({
      mode: "enforce",
      scanImpl: jest.fn().mockResolvedValue(redactDecision()),
    })
    await patched({ messages: userMessages })
    expect(original).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "[REDACTED]" }],
    })
  })

  test("redact + enforce + applyRedaction returns null: escalates to block", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation()
    const { original, patched } = setup({
      mode: "enforce",
      scanImpl: jest.fn().mockResolvedValue(redactDecision()),
      config: { applyRedaction: () => null },
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(PromptGuardBlockedError)
    expect(original).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("escalating to block"))
  })

  test("redact + enforce with no applyRedaction configured: escalates to block", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation()
    const { original, patched } = setup({
      mode: "enforce",
      scanImpl: jest.fn().mockResolvedValue(redactDecision()),
      config: { applyRedaction: undefined },
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(PromptGuardBlockedError)
    expect(original).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  test("redact + enforce with missing redactedMessages: escalates to block", async () => {
    // Regression: a redact decision whose body carried no redacted_messages
    // used to fall through and send the unredacted content.
    const errorSpy = jest.spyOn(console, "error").mockImplementation()
    const noMessagesRedact = new GuardDecision({
      decision: "redact",
      event_id: "e-redact-empty",
      confidence: 0.8,
      threat_type: "pii",
      threats: [],
      latency_ms: 1,
    })
    const { original, patched } = setup({
      mode: "enforce",
      scanImpl: jest.fn().mockResolvedValue(noMessagesRedact),
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(PromptGuardBlockedError)
    expect(original).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("escalating to block"))
  })

  test("redact + enforce with empty redactedMessages array: escalates to block", async () => {
    const emptyRedact = new GuardDecision({
      decision: "redact",
      event_id: "e-redact-empty2",
      confidence: 0.8,
      redacted_messages: [],
      threats: [],
      latency_ms: 1,
    })
    jest.spyOn(console, "error").mockImplementation()
    const { original, patched } = setup({
      mode: "enforce",
      scanImpl: jest.fn().mockResolvedValue(emptyRedact),
    })
    await expect(patched({ messages: userMessages })).rejects.toThrow(PromptGuardBlockedError)
    expect(original).not.toHaveBeenCalled()
  })

  test("redact + monitor with missing redactedMessages: warns and proceeds", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    const noMessagesRedact = new GuardDecision({
      decision: "redact",
      event_id: "e-redact-empty3",
      confidence: 0.8,
      threats: [],
      latency_ms: 1,
    })
    const { original, patched } = setup({
      mode: "monitor",
      scanImpl: jest.fn().mockResolvedValue(noMessagesRedact),
    })
    await patched({ messages: userMessages })
    expect(original).toHaveBeenCalledWith({ messages: userMessages })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("would redact"))
  })

  test("redact + monitor: warns and passes original args through", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    const { original, patched } = setup({
      mode: "monitor",
      scanImpl: jest.fn().mockResolvedValue(redactDecision()),
    })
    await patched({ messages: userMessages })
    expect(original).toHaveBeenCalledWith({ messages: userMessages })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("would redact"))
  })
})

// ── Output scanning ──────────────────────────────────────────────────

describe("createPatchedMethod output scanning", () => {
  test("blocked output + enforce: throws", async () => {
    const scanImpl = jest
      .fn()
      .mockResolvedValueOnce(allowDecision())
      .mockResolvedValueOnce(blockDecision())
    const { patched } = setup({ mode: "enforce", scanResponses: true, scanImpl })
    await expect(patched({ messages: userMessages })).rejects.toThrow(PromptGuardBlockedError)
    expect(scanImpl).toHaveBeenCalledTimes(2)
    expect(scanImpl).toHaveBeenLastCalledWith(
      [{ role: "assistant", content: "model output" }],
      "output",
      "test-model",
    )
  })

  test("blocked output + monitor: returns result", async () => {
    const scanImpl = jest
      .fn()
      .mockResolvedValueOnce(allowDecision())
      .mockResolvedValueOnce(blockDecision())
    const { patched } = setup({ mode: "monitor", scanResponses: true, scanImpl })
    const result = await patched({ messages: userMessages })
    expect(result).toEqual({ text: "model output" })
  })

  test("output-scan guard outage + failOpen=true: returns result", async () => {
    const scanImpl = jest
      .fn()
      .mockResolvedValueOnce(allowDecision())
      .mockRejectedValueOnce(new GuardApiError("down", 503))
    const { patched } = setup({ scanResponses: true, failOpen: true, scanImpl })
    const result = await patched({ messages: userMessages })
    expect(result).toEqual({ text: "model output" })
  })

  test("output-scan guard outage + failOpen=false: throws", async () => {
    const scanImpl = jest
      .fn()
      .mockResolvedValueOnce(allowDecision())
      .mockRejectedValueOnce(new GuardApiError("down", 503))
    const { patched } = setup({ scanResponses: true, failOpen: false, scanImpl })
    await expect(patched({ messages: userMessages })).rejects.toThrow(GuardApiError)
  })

  test("stream:true param skips output scanning (input still scanned)", async () => {
    const scanImpl = jest.fn().mockResolvedValue(allowDecision())
    const { patched } = setup({ scanResponses: true, scanImpl })
    await patched({ messages: userMessages, stream: true })
    expect(scanImpl).toHaveBeenCalledTimes(1)
    expect(scanImpl).toHaveBeenCalledWith(userMessages, "input", "test-model", {
      framework: "test",
    })
  })

  test("async-iterable response skips output scanning", async () => {
    const streamResult = {
      [Symbol.asyncIterator]: async function* () {
        yield { text: "chunk" }
      },
    }
    const scanImpl = jest.fn().mockResolvedValue(allowDecision())
    setup({ scanResponses: true, scanImpl })
    const original = jest.fn().mockResolvedValue(streamResult)
    const patchedStream = createPatchedMethod(original, {
      ...baseConfig,
      extractResponseText: () => "should never be scanned",
    })
    const result = await patchedStream({ messages: userMessages })
    expect(result).toBe(streamResult)
    expect(scanImpl).toHaveBeenCalledTimes(1)
  })
})
