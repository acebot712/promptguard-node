/**
 * Every integration names the framework's real Conversation in `session_id`.
 *
 * The Guard API remembers a Conversation's turns when a scan names it in
 * `context.session_id`, so the id on the wire has to be the framework's own
 * conversation id: the same on every turn of one conversation, different for
 * another, and absent when the framework has none. A per-call run id — what
 * the LangChain handler used to send — makes every scan a conversation of its
 * own.
 *
 * The Guard API is faked at `fetch`, so each assertion reads the JSON body
 * that would have been sent.
 */

import { generateText, wrapLanguageModel } from "ai-v6"
import { MockLanguageModelV3 } from "ai-v6/test"
import { PromptGuardCallbackHandler } from "../src/integrations/langchain"
import { promptGuardMiddleware } from "../src/integrations/vercel-ai"

const NO_SESSION = "<none>"

interface FakeGuardApi {
  fetch: jest.Mock
  /** The `context.session_id` of every scan, `NO_SESSION` where absent. */
  sessionIds(): string[]
}

function fakeGuardApi(): FakeGuardApi {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      decision: "allow",
      event_id: "evt",
      confidence: 0,
      threats: [],
      latency_ms: 1,
    }),
  }))
  return {
    fetch: fn,
    sessionIds: () =>
      fn.mock.calls.map((call: unknown[]) => {
        const body = JSON.parse((call[1] as { body: string }).body)
        return body.context?.session_id ?? NO_SESSION
      }),
  }
}

const originalFetch = global.fetch
let api: FakeGuardApi

beforeEach(() => {
  api = fakeGuardApi()
  global.fetch = api.fetch as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// LangChain.js callback handler
// ---------------------------------------------------------------------------

let runCounter = 0

/**
 * One chat-model call as @langchain/core reports it to a callback handler: a
 * start with the call's metadata, then an end that carries none.
 */
async function langchainTurn(
  handler: PromptGuardCallbackHandler,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const runId = `run-${++runCounter}`
  await handler.handleChatModelStart(
    { id: ["langchain", "chat_models", "openai", "ChatOpenAI"] },
    [[{ type: "human", content: text }]],
    runId,
    `parent-${runCounter}`,
    undefined,
    undefined,
    metadata,
  )
  await handler.handleLLMEnd({ generations: [[{ text: `re: ${text}` }]] }, runId)
}

function handler(options: Record<string, unknown> = {}): PromptGuardCallbackHandler {
  return new PromptGuardCallbackHandler({
    apiKey: "pg_test",
    maxRetries: 0,
    scanResponses: true,
    ...options,
  })
}

describe("LangChain.js callback handler", () => {
  test("two calls in one thread send the same session id", async () => {
    const h = handler()
    await langchainTurn(h, "hello", { thread_id: "thread-a" })
    await langchainTurn(h, "and again", { thread_id: "thread-a" })

    expect(api.sessionIds()).toEqual(Array(4).fill("thread-a"))
  })

  test("another thread is another session", async () => {
    const h = handler()
    await langchainTurn(h, "hello", { thread_id: "thread-a" })
    await langchainTurn(h, "hello", { thread_id: "thread-b" })

    expect(api.sessionIds()).toEqual(["thread-a", "thread-a", "thread-b", "thread-b"])
  })

  test("a call with no thread sends no session id", async () => {
    const h = handler()
    await langchainTurn(h, "hello")
    await langchainTurn(h, "hello", { ls_provider: "openai" })

    expect(api.sessionIds()).toEqual(Array(4).fill(NO_SESSION))
  })

  test.each(["session_id", "conversation_id"])(
    "the LangSmith thread key %s names the session",
    async (key) => {
      const h = handler()
      await langchainTurn(h, "hello", { [key]: "conv-1" })
      await langchainTurn(h, "again", { [key]: "conv-1" })

      expect(api.sessionIds()).toEqual(Array(4).fill("conv-1"))
    },
  )

  test("a numeric thread id is sent as a string", async () => {
    const h = handler()
    await langchainTurn(h, "hello", { thread_id: 42 })

    expect(api.sessionIds()).toEqual(["42", "42"])
  })

  test("an explicit sessionId applies when the call names none", async () => {
    const h = handler({ sessionId: "user-chat-7" })
    await langchainTurn(h, "hello")
    await langchainTurn(h, "hello", { thread_id: "thread-a" })

    // The call's own thread is more specific than the handler's default.
    expect(api.sessionIds()).toEqual(["user-chat-7", "user-chat-7", "thread-a", "thread-a"])
  })

  test("an empty explicit sessionId is refused", () => {
    expect(() => handler({ sessionId: " " })).toThrow("sessionId")
  })

  test("a tool call carries its thread", async () => {
    const h = handler()
    await h.handleToolStart({ name: "search" }, "query", "tool-run", undefined, undefined, {
      thread_id: "thread-a",
    })
    await h.handleToolEnd("result", "tool-run")

    expect(api.sessionIds()).toEqual(["thread-a", "thread-a"])
  })

  test("the run is forgotten once it ends", async () => {
    const h = handler()
    await langchainTurn(h, "hello", { thread_id: "thread-a" })

    expect((h as unknown as { runSessions: Map<string, unknown> }).runSessions.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Vercel AI SDK middleware
// ---------------------------------------------------------------------------

function vercelModel(options: Record<string, unknown> = {}) {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "fine" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  })
  return wrapLanguageModel({
    model,
    middleware: promptGuardMiddleware({ apiKey: "pg_test", maxRetries: 0, ...options }),
  })
}

async function vercelTurn(
  model: ReturnType<typeof vercelModel>,
  text: string,
  sessionId?: string,
): Promise<void> {
  await generateText({
    model,
    prompt: text,
    ...(sessionId ? { providerOptions: { promptguard: { sessionId } } } : {}),
  })
}

describe("Vercel AI SDK middleware", () => {
  test("a call names its conversation in providerOptions.promptguard.sessionId", async () => {
    const model = vercelModel()
    await vercelTurn(model, "hello", "chat-a")
    await vercelTurn(model, "again", "chat-a")
    await vercelTurn(model, "hello", "chat-b")

    expect(api.sessionIds()).toEqual(["chat-a", "chat-a", "chat-b"])
  })

  test("a call that names no conversation sends no session id", async () => {
    const model = vercelModel()
    await vercelTurn(model, "hello")

    expect(api.sessionIds()).toEqual([NO_SESSION])
  })

  test("the middleware's sessionId applies when the call names none", async () => {
    const model = vercelModel({ sessionId: "chat-default" })
    await vercelTurn(model, "hello")
    await vercelTurn(model, "hello", "chat-a")

    expect(api.sessionIds()).toEqual(["chat-default", "chat-a"])
  })

  test("output scans name the same conversation", async () => {
    const model = vercelModel({ scanResponses: true })
    await vercelTurn(model, "hello", "chat-a")

    expect(api.sessionIds()).toEqual(["chat-a", "chat-a"])
  })

  test("an empty sessionId is refused", () => {
    expect(() => promptGuardMiddleware({ apiKey: "pg_test", sessionId: "" })).toThrow("sessionId")
  })
})
