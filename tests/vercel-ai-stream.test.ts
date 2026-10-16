/**
 * Streamed output scanning in the Vercel AI SDK middleware (`wrapStream`).
 *
 * The streamed path must scan output the way `wrapGenerate` does — same text,
 * same decisions, same fail-open policy (ADR-0002) — while holding back at
 * most one window of the stream rather than the whole response.
 */

import { GuardApiError, PromptGuardBlockedError } from "../src/guard"
import { promptGuardMiddleware } from "../src/integrations/vercel-ai"

type Part = Record<string, unknown>

const ALLOW = { decision: "allow", event_id: "e-a", confidence: 0, threats: [], latency_ms: 1 }
const BLOCK = {
  decision: "block",
  event_id: "e-b",
  confidence: 0.95,
  threat_type: "pii",
  threats: [],
  latency_ms: 1,
}
const REDACT = {
  decision: "redact",
  event_id: "e-r",
  confidence: 0.8,
  redacted_messages: [{ role: "assistant", content: "[REDACTED]" }],
  threats: [],
  latency_ms: 1,
}

function guardResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body }
}

/** A fetch mock that answers successive Guard calls with `bodies` in order. */
function guardFetchSequence(...bodies: Record<string, unknown>[]) {
  const fn = jest.fn()
  for (const body of bodies) fn.mockResolvedValueOnce(guardResponse(body))
  // Any call past the scripted ones is a test bug; make it loud.
  fn.mockRejectedValue(new Error("unexpected extra Guard call"))
  return fn
}

function streamOf(parts: Part[]): ReadableStream<Part> {
  return new ReadableStream<Part>({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

/** Read every part the consumer receives, and the error that ended it, if any. */
async function drain(stream: ReadableStream<Part>): Promise<{ parts: Part[]; error?: unknown }> {
  const parts: Part[] = []
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { parts }
      parts.push(value)
    }
  } catch (error) {
    return { parts, error }
  }
}

function guardBodies(fetchMock: jest.Mock): Array<{ direction: string; content: string }> {
  return fetchMock.mock.calls.map((call) => {
    const body = JSON.parse(call[1].body as string)
    return { direction: body.direction, content: body.messages[0].content }
  })
}

function middleware(opts: Partial<Parameters<typeof promptGuardMiddleware>[0]> = {}) {
  return promptGuardMiddleware({ apiKey: "pg_test", scanResponses: true, ...opts })
}

async function wrap(
  mw: ReturnType<typeof middleware>,
  stream: ReadableStream<Part>,
): Promise<ReadableStream<Part>> {
  // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
  const result = (await mw.wrapStream!({
    doStream: async () => ({ stream, rawCall: { rawPrompt: null, rawSettings: {} } }),
    params: { modelId: "gpt-5-nano" },
  })) as { stream: ReadableStream<Part>; rawCall: unknown }
  expect(result.rawCall).toEqual({ rawPrompt: null, rawSettings: {} })
  return result.stream
}

// LanguageModelV2/V3 (AI SDK 5+) stream parts.
const V2_LEAK: Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t0" },
  { type: "text-delta", id: "t0", delta: "Sure, the customer's " },
  { type: "text-delta", id: "t0", delta: "SSN is 123-45-6789." },
  { type: "text-end", id: "t0" },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
]

// LanguageModelV1 (AI SDK 3/4) stream parts.
const V1_LEAK: Part[] = [
  { type: "text-delta", textDelta: "Sure, the customer's " },
  { type: "text-delta", textDelta: "SSN is 123-45-6789." },
  { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 2 } },
]

const deliveredText = (parts: Part[]) =>
  parts.map((p) => (p.type === "text-delta" ? (p.delta ?? p.textDelta) : "")).join("")

describe("promptGuardMiddleware wrapStream", () => {
  const originalFetch = global.fetch
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation()
  })

  afterEach(() => {
    global.fetch = originalFetch
    warnSpy.mockRestore()
  })

  test("is undefined when scanResponses=false", () => {
    expect(promptGuardMiddleware({ apiKey: "pg_test" }).wrapStream).toBeUndefined()
  })

  test.each([
    ["v2 parts", V2_LEAK],
    ["v1 parts", V1_LEAK],
  ])(
    "a streamed secret is blocked in enforce mode before any of it is delivered (%s)",
    async (_label, leak) => {
      const fetchMock = guardFetchSequence(BLOCK)
      global.fetch = fetchMock
      const out = await drain(await wrap(middleware({ mode: "enforce" }), streamOf(leak)))

      expect(out.error).toBeInstanceOf(PromptGuardBlockedError)
      expect((out.error as PromptGuardBlockedError).decision.eventId).toBe("e-b")
      expect(deliveredText(out.parts)).not.toContain("123-45-6789")
      expect(out.parts.find((p) => p.type === "finish")).toBeUndefined()

      // Scanned as the non-streamed path scans it: one output scan of the text.
      expect(guardBodies(fetchMock)).toEqual([
        { direction: "output", content: "Sure, the customer's SSN is 123-45-6789." },
      ])
    },
  )

  test("the streamed and non-streamed paths send the Guard API the same text", async () => {
    const streamFetch = guardFetchSequence(ALLOW)
    global.fetch = streamFetch
    await drain(await wrap(middleware(), streamOf(V2_LEAK)))

    const generateFetch = guardFetchSequence(ALLOW)
    global.fetch = generateFetch
    // biome-ignore lint/style/noNonNullAssertion: defined when scanResponses=true
    await middleware().wrapGenerate!({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Sure, the customer's SSN is 123-45-6789." }],
      }),
      params: { modelId: "gpt-5-nano" },
    })

    expect(guardBodies(streamFetch)).toEqual(guardBodies(generateFetch))
  })

  test("an output redact decision is enforced as a block, as on the non-streamed path", async () => {
    global.fetch = guardFetchSequence(REDACT)
    const out = await drain(await wrap(middleware({ mode: "enforce" }), streamOf(V2_LEAK)))
    expect(out.error).toBeInstanceOf(PromptGuardBlockedError)
    expect(deliveredText(out.parts)).toBe("")
  })

  test("an allowed stream is delivered unchanged and in order", async () => {
    global.fetch = guardFetchSequence(ALLOW)
    const out = await drain(await wrap(middleware(), streamOf(V2_LEAK)))
    expect(out.error).toBeUndefined()
    expect(out.parts).toEqual(V2_LEAK)
  })

  test("monitor mode delivers the stream and logs what it would have blocked", async () => {
    global.fetch = guardFetchSequence(BLOCK)
    const out = await drain(await wrap(middleware({ mode: "monitor" }), streamOf(V2_LEAK)))
    expect(out.error).toBeUndefined()
    expect(out.parts).toEqual(V2_LEAK)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("would block"))
  })

  test("tool-call input streamed as deltas is scanned", async () => {
    const fetchMock = guardFetchSequence(BLOCK)
    global.fetch = fetchMock
    const parts: Part[] = [
      { type: "tool-input-start", id: "c1", toolName: "lookup" },
      { type: "tool-input-delta", id: "c1", delta: '{"ssn":"123-' },
      { type: "tool-input-delta", id: "c1", delta: '45-6789"}' },
      { type: "tool-input-end", id: "c1" },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: '{"ssn":"123-45-6789"}' },
      { type: "finish", finishReason: "tool-calls", usage: {} },
    ]
    const out = await drain(await wrap(middleware(), streamOf(parts)))
    expect(out.error).toBeInstanceOf(PromptGuardBlockedError)
    expect(out.parts).toEqual([])
    // The final scan carries the call's input once, as the non-streamed path does.
    expect(guardBodies(fetchMock)).toEqual([
      { direction: "output", content: '{"ssn":"123-45-6789"}' },
    ])
  })

  test("a stream with nothing scannable is passed through without a Guard call", async () => {
    const fetchMock = jest.fn()
    global.fetch = fetchMock
    const parts: Part[] = [{ type: "finish", finishReason: "stop", usage: {} }]
    const out = await drain(await wrap(middleware(), streamOf(parts)))
    expect(out.parts).toEqual(parts)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe("windowed scanning", () => {
    test("releases a scanned window before the model has finished", async () => {
      global.fetch = guardFetchSequence(ALLOW, ALLOW)
      let source!: ReadableStreamDefaultController<Part>
      const upstream = new ReadableStream<Part>({
        start(c) {
          source = c
        },
      })
      const reader = (await wrap(middleware({ streamWindowChars: 10 }), upstream)).getReader()

      source.enqueue({ type: "text-delta", id: "t", delta: "first window!" })
      // Delivered while the upstream is still open: the stream is not buffered.
      const first = await reader.read()
      expect(first.value).toEqual({ type: "text-delta", id: "t", delta: "first window!" })

      source.enqueue({ type: "text-delta", id: "t", delta: " tail" })
      source.close()
      const rest: Part[] = []
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value)
      expect(rest).toEqual([{ type: "text-delta", id: "t", delta: " tail" }])
    })

    test("a block found mid-stream stops the stream before the offending window", async () => {
      const fetchMock = guardFetchSequence(ALLOW, BLOCK)
      global.fetch = fetchMock
      const parts: Part[] = [
        { type: "text-delta", id: "t", delta: "harmless opening " },
        { type: "text-delta", id: "t", delta: "SSN 123-45-6789 " },
        { type: "text-delta", id: "t", delta: "never reached" },
        { type: "finish", finishReason: "stop", usage: {} },
      ]
      const out = await drain(await wrap(middleware({ streamWindowChars: 15 }), streamOf(parts)))

      expect(out.error).toBeInstanceOf(PromptGuardBlockedError)
      expect(out.parts).toEqual([parts[0]])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // The second window is scanned with the end of the first as context, so
      // a secret split across a window boundary is still seen whole.
      expect(guardBodies(fetchMock)[1].content).toContain("opening SSN 123-45-6789")
    })

    test("the complete text is scanned once more at the end", async () => {
      const fetchMock = guardFetchSequence(ALLOW, ALLOW, BLOCK)
      global.fetch = fetchMock
      const parts: Part[] = [
        { type: "text-delta", id: "t", delta: "aaaaaaaaaaaa" },
        { type: "text-delta", id: "t", delta: "bbbbbbbbbbbb" },
        { type: "text-delta", id: "t", delta: "cc" },
        { type: "finish", finishReason: "stop", usage: {} },
      ]
      const out = await drain(await wrap(middleware({ streamWindowChars: 10 }), streamOf(parts)))

      expect(out.error).toBeInstanceOf(PromptGuardBlockedError)
      expect(out.parts).toEqual([parts[0], parts[1]])
      const bodies = guardBodies(fetchMock)
      expect(bodies).toHaveLength(3)
      expect(bodies[2].content).toBe("aaaaaaaaaaaabbbbbbbbbbbbcc")
    })

    test("streamWindowChars: Infinity holds the whole response for one scan", async () => {
      const fetchMock = guardFetchSequence(ALLOW)
      global.fetch = fetchMock
      const parts: Part[] = [
        { type: "text-delta", id: "t", delta: "x".repeat(5000) },
        { type: "text-delta", id: "t", delta: "y".repeat(5000) },
        { type: "finish", finishReason: "stop", usage: {} },
      ]
      const out = await drain(
        await wrap(middleware({ streamWindowChars: Number.POSITIVE_INFINITY }), streamOf(parts)),
      )
      expect(out.parts).toEqual(parts)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test.each([0, -5, Number.NaN])("rejects streamWindowChars=%p", (bad) => {
      expect(() => middleware({ streamWindowChars: bad })).toThrow(RangeError)
    })
  })

  describe("Guard API unreachable mid-stream (ADR-0002)", () => {
    const parts: Part[] = [
      { type: "text-delta", id: "t", delta: "first window!" },
      { type: "text-delta", id: "t", delta: "second window" },
      { type: "text-delta", id: "t", delta: "!" },
      { type: "finish", finishReason: "stop", usage: {} },
    ]

    test("failOpen=true (default) delivers the rest of the stream unscanned", async () => {
      // The first window scans clean; the Guard API then goes away.
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(guardResponse(ALLOW))
        .mockRejectedValue(new TypeError("fetch failed"))
      global.fetch = fetchMock
      const out = await drain(
        await wrap(middleware({ streamWindowChars: 10, maxRetries: 0 }), streamOf(parts)),
      )

      expect(out.error).toBeUndefined()
      expect(out.parts).toEqual(parts)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Guard API unavailable, rest of streamed response left unscanned"),
      )
      // One outage costs one failed call, not one per remaining window.
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test("failOpen=false stops the stream with the GuardApiError", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(guardResponse(ALLOW))
        .mockRejectedValue(new TypeError("fetch failed"))
      const out = await drain(
        await wrap(
          middleware({ streamWindowChars: 10, maxRetries: 0, failOpen: false }),
          streamOf(parts),
        ),
      )

      expect(out.error).toBeInstanceOf(GuardApiError)
      expect(out.parts).toEqual([parts[0]])
    })
  })
})
