import { GuardApiError, GuardDecision, PromptGuardBlockedError } from "../src/guard"
import { PromptGuardCallbackHandler } from "../src/integrations/langchain"
import { promptGuardMiddleware } from "../src/integrations/vercel-ai"

// ---------------------------------------------------------------------------
// LangChain.js callback handler
// ---------------------------------------------------------------------------

describe("PromptGuardCallbackHandler", () => {
  test("requires API key", () => {
    const origEnv = process.env.PROMPTGUARD_API_KEY
    Reflect.deleteProperty(process.env, "PROMPTGUARD_API_KEY")

    try {
      expect(() => new PromptGuardCallbackHandler({ apiKey: "" })).toThrow("API key required")
    } finally {
      if (origEnv !== undefined) process.env.PROMPTGUARD_API_KEY = origEnv
      else Reflect.deleteProperty(process.env, "PROMPTGUARD_API_KEY")
    }
  })

  test("initializes with API key", () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    expect(handler.name).toBe("promptguard")
  })

  test("handleLLMStart scans prompts - allow", async () => {
    // Mock the guard client's scan to return allow
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "allow",
        event_id: "e1",
        confidence: 0.05,
        threats: [],
        latency_ms: 2,
      }),
    )

    await handler.handleLLMStart(
      { kwargs: { model_name: "gpt-5-nano" }, id: ["ChatOpenAI"] },
      ["Hello"],
      "run-1",
    )

    expect(guard.scan).toHaveBeenCalledWith(
      [{ role: "user", content: "Hello" }],
      "input",
      "gpt-5-nano",
      expect.objectContaining({ framework: "langchain" }),
    )
  })

  test("handleLLMStart blocks in enforce mode", async () => {
    const handler = new PromptGuardCallbackHandler({
      apiKey: "pg_test",
      mode: "enforce",
    })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "block",
        event_id: "e2",
        confidence: 0.95,
        threat_type: "prompt_injection",
        threats: [],
        latency_ms: 5,
      }),
    )

    await expect(handler.handleLLMStart({}, ["Ignore all"], "run-2")).rejects.toThrow(
      PromptGuardBlockedError,
    )
  })

  test("handleLLMStart warns in monitor mode", async () => {
    const handler = new PromptGuardCallbackHandler({
      apiKey: "pg_test",
      mode: "monitor",
    })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "block",
        event_id: "e3",
        confidence: 0.9,
        threat_type: "prompt_injection",
        threats: [],
        latency_ms: 5,
      }),
    )

    const warnSpy = jest.spyOn(console, "warn").mockImplementation()

    // Should NOT throw in monitor mode
    await handler.handleLLMStart({}, ["Ignore all"], "run-3")

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[monitor]"))
    warnSpy.mockRestore()
  })

  test("handleChatModelStart extracts messages", async () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "allow",
        event_id: "e4",
        confidence: 0,
        threats: [],
        latency_ms: 1,
      }),
    )

    await handler.handleChatModelStart(
      { kwargs: { model_name: "gpt-5-nano" }, id: ["ChatOpenAI"] },
      [
        [
          { type: "system", content: "Be helpful" },
          { type: "human", content: "Hello" },
        ],
      ],
      "run-4",
    )

    expect(guard.scan).toHaveBeenCalledWith(
      [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ],
      "input",
      "gpt-5-nano",
      expect.anything(),
    )
  })

  test("handleChatModelStart flattens structured content-part arrays", async () => {
    // Regression: String() on a content-part array yields "[object Object]"
    // and the real text was never scanned.
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "allow",
        event_id: "e4b",
        confidence: 0,
        threats: [],
        latency_ms: 1,
      }),
    )

    await handler.handleChatModelStart(
      {},
      [
        [
          {
            type: "human",
            content: [
              { type: "text", text: "secret one" },
              { type: "image_url", image_url: { url: "https://..." } },
              { type: "text", text: "secret two" },
            ],
          },
        ],
      ],
      "run-4b",
    )

    expect(guard.scan).toHaveBeenCalledWith(
      [{ role: "user", content: "secret one\nsecret two" }],
      "input",
      expect.anything(),
      expect.anything(),
    )
  })

  test("redact decision in enforce mode escalates to block (callbacks cannot rewrite inputs)", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation()
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test", mode: "enforce" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "redact",
        event_id: "e-redact",
        confidence: 0.8,
        redacted_messages: [{ role: "user", content: "[REDACTED]" }],
        threats: [],
        latency_ms: 1,
      }),
    )

    await expect(handler.handleLLMStart({}, ["SSN 123-45-6789"], "run-r1")).rejects.toThrow(
      PromptGuardBlockedError,
    )
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("escalating to block"))
    errorSpy.mockRestore()
  })

  test("redact decision in monitor mode warns accurately and proceeds", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test", mode: "monitor" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "redact",
        event_id: "e-redact2",
        confidence: 0.8,
        threats: [],
        latency_ms: 1,
      }),
    )

    // Must not throw, and must not claim content was redacted (it wasn't).
    await handler.handleLLMStart({}, ["SSN 123-45-6789"], "run-r2")
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("would redact: content passed through unredacted"),
    )
    warnSpy.mockRestore()
  })

  test("handleToolStart scans tool input", async () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "allow",
        event_id: "e5",
        confidence: 0,
        threats: [],
        latency_ms: 1,
      }),
    )

    await handler.handleToolStart({ name: "web_search" }, "search query", "run-5")

    expect(guard.scan).toHaveBeenCalledWith(
      [{ role: "user", content: "search query" }],
      "input",
      "tool",
      expect.objectContaining({
        metadata: expect.objectContaining({ tool_name: "web_search" }),
      }),
    )
  })

  test("chain context tracking", async () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })

    await handler.handleChainStart(
      { id: ["RunnableSequence", "MyChain"] },
      { input: "test" },
      "chain-1",
    )

    expect(
      (handler as unknown as { chainContext: Map<string, unknown> }).chainContext.has("chain-1"),
    ).toBe(true)

    handler.handleChainEnd({}, "chain-1")
    expect(
      (handler as unknown as { chainContext: Map<string, unknown> }).chainContext.has("chain-1"),
    ).toBe(false)
  })

  test("handleLLMEnd scans response when scanResponses=true", async () => {
    const handler = new PromptGuardCallbackHandler({
      apiKey: "pg_test",
      scanResponses: true,
    })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "allow",
        event_id: "e6",
        confidence: 0,
        threats: [],
        latency_ms: 1,
      }),
    )

    await handler.handleLLMEnd(
      {
        generations: [[{ text: "Here is the answer" }]],
      },
      "run-6",
    )

    expect(guard.scan).toHaveBeenCalledWith(
      [{ role: "assistant", content: "Here is the answer" }],
      "output",
      undefined,
      expect.anything(),
    )
  })

  test("scanResponses defaults to false (unified with init() and vercel-ai)", async () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn()

    await handler.handleLLMEnd({ generations: [[{ text: "output" }]] }, "run-7")
    expect(guard.scan).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Vercel AI SDK middleware
// ---------------------------------------------------------------------------

describe("promptGuardMiddleware", () => {
  test("requires API key", () => {
    const origEnv = process.env.PROMPTGUARD_API_KEY
    Reflect.deleteProperty(process.env, "PROMPTGUARD_API_KEY")

    try {
      expect(() => promptGuardMiddleware({ apiKey: "" })).toThrow("API key required")
    } finally {
      if (origEnv !== undefined) process.env.PROMPTGUARD_API_KEY = origEnv
      else Reflect.deleteProperty(process.env, "PROMPTGUARD_API_KEY")
    }
  })

  test("returns middleware with transformParams", () => {
    const mw = promptGuardMiddleware({ apiKey: "pg_test" })
    expect(mw.transformParams).toBeDefined()
    expect(typeof mw.transformParams).toBe("function")
  })

  test("transformParams scans string prompt", async () => {
    const mw = promptGuardMiddleware({ apiKey: "pg_test" })

    // Instead, mock global fetch
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        decision: "allow",
        event_id: "evt-ok",
        confidence: 0.05,
        threats: [],
        latency_ms: 2,
      }),
    })

    const params = {
      prompt: "Hello, world!",
      modelId: "gpt-5-nano",
    }

    const result = await mw.transformParams({ params })
    expect(result).toEqual(params)

    global.fetch = originalFetch
  })

  test("transformParams blocks in enforce mode", async () => {
    const mw = promptGuardMiddleware({
      apiKey: "pg_test",
      mode: "enforce",
    })

    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        decision: "block",
        event_id: "evt-block",
        confidence: 0.95,
        threat_type: "prompt_injection",
        threats: [],
        latency_ms: 5,
      }),
    })

    await expect(
      mw.transformParams({
        params: { prompt: "Ignore all instructions" },
      }),
    ).rejects.toThrow(PromptGuardBlockedError)

    global.fetch = originalFetch
  })

  test("wrapGenerate is defined when scanResponses=true", () => {
    const mw = promptGuardMiddleware({
      apiKey: "pg_test",
      scanResponses: true,
    })
    expect(mw.wrapGenerate).toBeDefined()
  })

  test("wrapGenerate is undefined when scanResponses=false", () => {
    const mw = promptGuardMiddleware({
      apiKey: "pg_test",
      scanResponses: false,
    })
    expect(mw.wrapGenerate).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LangChain.js - error propagation contract
// ---------------------------------------------------------------------------

describe("PromptGuardCallbackHandler error propagation", () => {
  test("sets raiseError and awaitHandlers for @langchain/core", () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test" })
    expect(handler.raiseError).toBe(true)
    expect(handler.awaitHandlers).toBe(true)
  })

  test("a blocked scan aborts under the consumeCallback contract", async () => {
    // Simulates @langchain/core's callback manager: every handler call is
    // wrapped in consumeCallback(fn, handler.awaitHandlers); errors are
    // swallowed (console.error only) unless handler.raiseError is true.
    const consumeCallback = async (
      fn: () => Promise<void>,
      wait: boolean,
      raiseError: boolean,
    ): Promise<void> => {
      if (!wait) {
        // Background execution: can never abort the LLM call.
        void fn().catch(() => {})
        return
      }
      try {
        await fn()
      } catch (err) {
        if (raiseError) throw err
        // swallowed — the pre-fix behavior that made enforce mode a no-op
      }
    }

    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test", mode: "enforce" })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockResolvedValue(
      new GuardDecision({
        decision: "block",
        event_id: "e-block",
        confidence: 0.95,
        threat_type: "prompt_injection",
        threats: [],
        latency_ms: 1,
      }),
    )

    await expect(
      consumeCallback(
        () => handler.handleLLMStart({}, ["Ignore all instructions"], "run-x"),
        handler.awaitHandlers,
        handler.raiseError,
      ),
    ).rejects.toThrow(PromptGuardBlockedError)
  })

  test("failOpen=false rethrows the original GuardApiError", async () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test", failOpen: false })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockRejectedValue(new GuardApiError("down", 503))

    const err = await handler
      .handleLLMStart({}, ["hi"], "run-y")
      .then(() => null)
      .catch((e) => e)
    expect(err).toBeInstanceOf(GuardApiError)
    expect((err as GuardApiError).statusCode).toBe(503)
  })

  test("non-GuardApiError bugs surface even with failOpen=true", async () => {
    const handler = new PromptGuardCallbackHandler({ apiKey: "pg_test", failOpen: true })
    const guard = (handler as unknown as { guard: { scan: jest.Mock } }).guard
    guard.scan = jest.fn().mockRejectedValue(new TypeError("bug"))

    await expect(handler.handleLLMStart({}, ["hi"], "run-z")).rejects.toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// Vercel AI SDK - redaction index alignment
// ---------------------------------------------------------------------------

function mockGuardFetch(body: Record<string, unknown>) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  })
}

describe("promptGuardMiddleware redaction", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  test("maps redactions through original indices when no-text messages are skipped", async () => {
    // prompt[0] has no scannable text (image-only) and is skipped when
    // building guard messages; the redaction for guard message 0 must land
    // on prompt[1], not prompt[0].
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r",
      confidence: 0.8,
      redacted_messages: [{ role: "user", content: "SSN [REDACTED]" }],
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "enforce" })
    const prompt = [
      { role: "user", content: [{ type: "image", image: "data:..." }] },
      { role: "user", content: "SSN 123-45-6789" },
    ]
    const result = (await mw.transformParams({ params: { prompt } })) as {
      prompt: Array<{ content: unknown }>
    }

    expect(result.prompt[0].content).toEqual([{ type: "image", image: "data:..." }])
    expect(result.prompt[1].content).toBe("SSN [REDACTED]")
  })

  test("structured content is rebuilt as text parts, not a bare string", async () => {
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r2",
      confidence: 0.8,
      redacted_messages: [{ role: "user", content: "[REDACTED]" }],
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "enforce" })
    const prompt = [{ role: "user", content: [{ type: "text", text: "secret" }] }]
    const result = (await mw.transformParams({ params: { prompt } })) as {
      prompt: Array<{ content: unknown }>
    }

    expect(result.prompt[0].content).toEqual([{ type: "text", text: "[REDACTED]" }])
  })

  test("monitor mode leaves the prompt unredacted", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r3",
      confidence: 0.8,
      redacted_messages: [{ role: "user", content: "[REDACTED]" }],
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "monitor" })
    const params = { prompt: [{ role: "user", content: "secret" }] }
    const result = await mw.transformParams({ params })
    expect(result).toBe(params)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("would redact"))
    warnSpy.mockRestore()
  })

  test("enforce + redact decision without redacted messages escalates to block", async () => {
    // Regression: a redact decision with no redacted_messages used to fall
    // through and send the unredacted prompt.
    const errorSpy = jest.spyOn(console, "error").mockImplementation()
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r4",
      confidence: 0.8,
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "enforce" })
    await expect(
      mw.transformParams({ params: { prompt: [{ role: "user", content: "secret" }] } }),
    ).rejects.toThrow(PromptGuardBlockedError)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("escalating to block"))
    errorSpy.mockRestore()
  })

  test("enforce + redact decision with empty redacted messages escalates to block", async () => {
    jest.spyOn(console, "error").mockImplementation()
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r5",
      confidence: 0.8,
      redacted_messages: [],
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "enforce" })
    await expect(
      mw.transformParams({ params: { prompt: [{ role: "user", content: "secret" }] } }),
    ).rejects.toThrow(PromptGuardBlockedError)
  })

  test("enforce + FEWER redacted messages than scanned escalates to block", async () => {
    // Regression: a partial redacted_messages list used to be applied
    // anyway, silently keeping the original content for the unmatched
    // trailing prompt messages.
    const errorSpy = jest.spyOn(console, "error").mockImplementation()
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r6",
      confidence: 0.8,
      redacted_messages: [{ role: "user", content: "[REDACTED]" }],
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "enforce" })
    const prompt = [
      { role: "user", content: "SSN 123-45-6789" },
      { role: "user", content: "card 4111 1111 1111 1111" },
    ]
    await expect(mw.transformParams({ params: { prompt } })).rejects.toThrow(
      PromptGuardBlockedError,
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 redacted messages for 2 scanned"),
    )
    errorSpy.mockRestore()
  })

  test("monitor + FEWER redacted messages than scanned warns about the partial list", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()
    global.fetch = mockGuardFetch({
      decision: "redact",
      event_id: "e-r7",
      confidence: 0.8,
      redacted_messages: [{ role: "user", content: "[REDACTED]" }],
      threats: [],
      latency_ms: 1,
    })

    const mw = promptGuardMiddleware({ apiKey: "pg_test", mode: "monitor" })
    const params = {
      prompt: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
    }
    const result = await mw.transformParams({ params })
    expect(result).toBe(params)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("partial: 1 redacted messages for 2 scanned"),
    )
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Vercel AI SDK - wrapGenerate
// ---------------------------------------------------------------------------

describe("promptGuardMiddleware wrapGenerate", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  const generated = { text: "leaked SSN 123-45-6789" }
  const doGenerate = () => Promise.resolve(generated)

  function middleware(opts: Partial<Parameters<typeof promptGuardMiddleware>[0]> = {}) {
    return promptGuardMiddleware({ apiKey: "pg_test", scanResponses: true, ...opts })
  }

  test("blocked response + enforce throws", async () => {
    global.fetch = mockGuardFetch({
      decision: "block",
      event_id: "e-b",
      confidence: 0.9,
      threat_type: "pii",
      threats: [],
      latency_ms: 1,
    })
    const mw = middleware({ mode: "enforce" })
    await expect(
      // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
      mw.wrapGenerate!({ doGenerate, params: {} }),
    ).rejects.toThrow(PromptGuardBlockedError)
  })

  test("blocked response + monitor returns the result", async () => {
    global.fetch = mockGuardFetch({
      decision: "block",
      event_id: "e-b2",
      confidence: 0.9,
      threat_type: "pii",
      threats: [],
      latency_ms: 1,
    })
    const mw = middleware({ mode: "monitor" })
    // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
    const result = await mw.wrapGenerate!({ doGenerate, params: {} })
    expect(result).toBe(generated)
  })

  test("guard outage + failOpen=true returns the result", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    // maxRetries: 0 — this test asserts the fail-open outcome of an outage, not
    // the retry schedule (covered by the GuardClient retry tests).
    const mw = middleware({ failOpen: true, maxRetries: 0 })
    // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
    const result = await mw.wrapGenerate!({ doGenerate, params: {} })
    expect(result).toBe(generated)
  })

  test("guard outage + failOpen=false rethrows the GuardApiError", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    // maxRetries: 0 — asserts the fail-closed outcome, not the retry schedule.
    const mw = middleware({ failOpen: false, maxRetries: 0 })
    await expect(
      // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
      mw.wrapGenerate!({ doGenerate, params: {} }),
    ).rejects.toThrow(GuardApiError)
  })

  test("allow decision returns the result", async () => {
    global.fetch = mockGuardFetch({
      decision: "allow",
      event_id: "e-a",
      confidence: 0,
      threats: [],
      latency_ms: 1,
    })
    const mw = middleware({ mode: "enforce" })
    // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
    const result = await mw.wrapGenerate!({ doGenerate, params: {} })
    expect(result).toBe(generated)
  })

  test("v5 (LanguageModelV2) content-array results are scanned", async () => {
    // Regression: v5 results carry `content: [...]` parts and no top-level
    // `text`, so response scanning used to no-op entirely.
    global.fetch = mockGuardFetch({
      decision: "block",
      event_id: "e-v5",
      confidence: 0.9,
      threat_type: "pii",
      threats: [],
      latency_ms: 1,
    })
    const v5Result = {
      content: [
        { type: "text", text: "leaked SSN 123-45-6789" },
        { type: "tool-call", toolCallId: "t1", toolName: "search", input: { q: "secret" } },
      ],
    }
    const mw = middleware({ mode: "enforce" })
    await expect(
      // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
      mw.wrapGenerate!({ doGenerate: () => Promise.resolve(v5Result), params: {} }),
    ).rejects.toThrow(PromptGuardBlockedError)

    // Both the text part and the tool-call args must be in the scanned body.
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string)
    expect(body.messages[0].content).toContain("leaked SSN 123-45-6789")
    expect(body.messages[0].content).toContain('{"q":"secret"}')
  })

  test("all tool-call args are scanned, not just the first", async () => {
    global.fetch = mockGuardFetch({
      decision: "allow",
      event_id: "e-tc",
      confidence: 0,
      threats: [],
      latency_ms: 1,
    })
    const result = {
      toolCalls: [
        { toolName: "a", args: '{"first":true}' },
        { toolName: "b", args: { second: true } },
      ],
    }
    const mw = middleware()
    // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
    await mw.wrapGenerate!({ doGenerate: () => Promise.resolve(result), params: {} })

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string)
    expect(body.messages[0].content).toContain('{"first":true}')
    expect(body.messages[0].content).toContain('{"second":true}')
  })

  test("results with nothing scannable are returned without a Guard call", async () => {
    global.fetch = jest.fn()
    const empty = { finishReason: "stop" }
    const mw = middleware()
    // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
    const result = await mw.wrapGenerate!({ doGenerate: () => Promise.resolve(empty), params: {} })
    expect(result).toBe(empty)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
