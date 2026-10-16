/**
 * Fixtures shared by the Vercel AI SDK integration tests: Guard API answers,
 * a scripted fetch, model streams in both stream-part vocabularies, and the
 * helpers that read what a consumer was delivered.
 */

export type Part = Record<string, unknown>

export const ALLOW = {
  decision: "allow",
  event_id: "e-a",
  confidence: 0,
  threats: [],
  latency_ms: 1,
}
export const BLOCK = {
  decision: "block",
  event_id: "e-b",
  confidence: 0.95,
  threat_type: "pii",
  threats: [],
  latency_ms: 1,
}
export const REDACT = {
  decision: "redact",
  event_id: "e-r",
  confidence: 0.8,
  redacted_messages: [{ role: "assistant", content: "[REDACTED]" }],
  threats: [],
  latency_ms: 1,
}

export function guardResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body }
}

/** A fetch mock that answers successive Guard calls with `bodies` in order. */
export function guardFetchSequence(...bodies: Record<string, unknown>[]) {
  const fn = jest.fn()
  for (const body of bodies) fn.mockResolvedValueOnce(guardResponse(body))
  // Any call past the scripted ones is a test bug; make it loud.
  fn.mockRejectedValue(new Error("unexpected extra Guard call"))
  return fn
}

export function streamOf(parts: Part[]): ReadableStream<Part> {
  return new ReadableStream<Part>({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

/** Read every part the consumer receives, and the error that ended it, if any. */
export async function drain(
  stream: ReadableStream<Part>,
): Promise<{ parts: Part[]; error?: unknown }> {
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

export function guardBodies(fetchMock: jest.Mock): Array<{ direction: string; content: string }> {
  return fetchMock.mock.calls.map((call) => {
    const body = JSON.parse(call[1].body as string)
    return { direction: body.direction, content: body.messages[0].content }
  })
}

// LanguageModelV2/V3/V4 (AI SDK 5+) stream parts.
export const V2_LEAK: Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t0" },
  { type: "text-delta", id: "t0", delta: "Sure, the customer's " },
  { type: "text-delta", id: "t0", delta: "SSN is 123-45-6789." },
  { type: "text-end", id: "t0" },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
]

// LanguageModelV1 (AI SDK 3/4) stream parts.
export const V1_LEAK: Part[] = [
  { type: "text-delta", textDelta: "Sure, the customer's " },
  { type: "text-delta", textDelta: "SSN is 123-45-6789." },
  { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 2 } },
]

export const deliveredText = (parts: Part[]) =>
  parts.map((p) => (p.type === "text-delta" ? (p.delta ?? p.textDelta) : "")).join("")
