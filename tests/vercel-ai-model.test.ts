/**
 * `promptguard(model)` — the Vercel AI SDK model wrapper.
 *
 * The wrapper must behave exactly like `promptGuardMiddleware` applied with
 * the AI SDK's own `wrapLanguageModel`, generated and streamed, while leaving
 * the model it wraps the model it was: same specification version, same
 * provider and model id, same properties.
 */

import { generateText, wrapLanguageModel } from "ai-v6"
import { MockLanguageModelV3 } from "ai-v6/test"
import { PromptGuardError } from "../src/client"
import { PromptGuardBlockedError } from "../src/guard"
import {
  type PromptGuardModelOptions,
  promptGuardMiddleware,
  promptguard,
} from "../src/integrations/vercel-ai"
import {
  ALLOW,
  BLOCK,
  deliveredText,
  drain,
  guardBodies,
  guardFetchSequence,
  type Part,
  REDACT,
  streamOf,
  V2_LEAK,
} from "./support/vercel-ai-fixtures"

const PROMPT = [{ role: "user", content: [{ type: "text", text: "What is the customer's SSN?" }] }]
const LEAKED_TEXT = "Sure, the customer's SSN is 123-45-6789."

type Spec = "v2" | "v3" | "v4"

/** A minimal model of the given specification version, recording what it was called with. */
function fakeModel(specificationVersion: Spec) {
  return {
    specificationVersion,
    provider: "fake.chat",
    modelId: "gpt-5-nano",
    supportedUrls: { "image/*": [/^https:\/\//] },
    doGenerate: jest.fn(async (_options: Record<string, unknown>) => ({
      content: [{ type: "text", text: LEAKED_TEXT }],
      finishReason: "stop",
      usage: {},
      warnings: [],
    })),
    doStream: jest.fn(async (_options: Record<string, unknown>) => ({ stream: streamOf(V2_LEAK) })),
  }
}

const OPTS = {
  apiKey: "pg_test",
  scanResponses: true,
  maxRetries: 0,
} satisfies PromptGuardModelOptions

describe("promptguard(model)", () => {
  const originalFetch = global.fetch
  const originalKey = process.env.PROMPTGUARD_API_KEY
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation()
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.PROMPTGUARD_API_KEY
    else process.env.PROMPTGUARD_API_KEY = originalKey
    warnSpy.mockRestore()
  })

  describe.each(["v2", "v3", "v4"] as const)("a %s model", (spec) => {
    test("keeps its own specification version, provider, model id and supported URLs", () => {
      const model = fakeModel(spec)
      const wrapped = promptguard(model, OPTS)
      expect(wrapped.specificationVersion).toBe(spec)
      expect(wrapped.provider).toBe("fake.chat")
      expect(wrapped.modelId).toBe("gpt-5-nano")
      expect(wrapped.supportedUrls).toBe(model.supportedUrls)
    })

    test("a blocked prompt never reaches the model, generated or streamed", async () => {
      const model = fakeModel(spec)
      const wrapped = promptguard(model, OPTS)

      global.fetch = guardFetchSequence(BLOCK)
      await expect(wrapped.doGenerate({ prompt: PROMPT })).rejects.toBeInstanceOf(
        PromptGuardBlockedError,
      )
      global.fetch = guardFetchSequence(BLOCK)
      await expect(wrapped.doStream({ prompt: PROMPT })).rejects.toBeInstanceOf(
        PromptGuardBlockedError,
      )
      expect(model.doGenerate).not.toHaveBeenCalled()
      expect(model.doStream).not.toHaveBeenCalled()
    })

    test("a redacted prompt is what the model receives", async () => {
      const model = fakeModel(spec)
      global.fetch = guardFetchSequence(REDACT)
      await promptguard(model, { ...OPTS, scanResponses: false }).doGenerate({ prompt: PROMPT })
      expect(model.doGenerate).toHaveBeenCalledWith({
        prompt: [{ role: "user", content: [{ type: "text", text: "[REDACTED]" }] }],
      })
    })

    test("generated output is scanned, and a block is thrown", async () => {
      const fetchMock = guardFetchSequence(ALLOW, BLOCK)
      global.fetch = fetchMock
      await expect(
        promptguard(fakeModel(spec), OPTS).doGenerate({ prompt: PROMPT }),
      ).rejects.toBeInstanceOf(PromptGuardBlockedError)
      expect(guardBodies(fetchMock)).toEqual([
        { direction: "input", content: "What is the customer's SSN?" },
        { direction: "output", content: LEAKED_TEXT },
      ])
    })

    test("streamed output is blocked before any of the secret is delivered", async () => {
      const fetchMock = guardFetchSequence(ALLOW, BLOCK)
      global.fetch = fetchMock
      const result = (await promptguard(fakeModel(spec), OPTS).doStream({ prompt: PROMPT })) as {
        stream: ReadableStream<Part>
      }
      const out = await drain(result.stream)

      expect(out.error).toBeInstanceOf(PromptGuardBlockedError)
      expect(deliveredText(out.parts)).not.toContain("123-45-6789")
      expect(guardBodies(fetchMock)).toEqual([
        { direction: "input", content: "What is the customer's SSN?" },
        { direction: "output", content: LEAKED_TEXT },
      ])
    })

    test("an allowed stream is delivered unchanged", async () => {
      global.fetch = guardFetchSequence(ALLOW, ALLOW)
      const result = (await promptguard(fakeModel(spec), OPTS).doStream({ prompt: PROMPT })) as {
        stream: ReadableStream<Part>
      }
      expect(await drain(result.stream)).toEqual({ parts: V2_LEAK })
    })
  })

  describe("behaves like promptGuardMiddleware under the AI SDK's wrapLanguageModel", () => {
    /** An error by its class name, so outcomes from two runs compare equal. */
    const named = (e: unknown) => (e instanceof Error ? e.constructor.name : e)

    /** Run one call through a wrapped model; record the Guard calls and what the caller saw. */
    async function run(
      call: (model: ReturnType<typeof fakeModel>) => Promise<unknown>,
      wrap: (model: ReturnType<typeof fakeModel>) => ReturnType<typeof fakeModel>,
      answers: readonly Record<string, unknown>[],
    ) {
      const fetchMock = guardFetchSequence(...answers)
      global.fetch = fetchMock
      let outcome: unknown
      try {
        const result = (await call(wrap(fakeModel("v3")))) as { stream?: ReadableStream<Part> }
        if (result.stream) {
          const { parts, error } = await drain(result.stream)
          outcome = { parts, error: named(error) }
        } else {
          outcome = { result }
        }
      } catch (error) {
        outcome = { thrown: named(error) }
      }
      return { calls: guardBodies(fetchMock), outcome }
    }

    const viaWrapper = (m: ReturnType<typeof fakeModel>) => promptguard(m, OPTS)
    const viaMiddleware = (m: ReturnType<typeof fakeModel>) =>
      wrapLanguageModel({
        model: m as never,
        middleware: promptGuardMiddleware(OPTS),
      }) as unknown as ReturnType<typeof fakeModel>

    const generate = (m: ReturnType<typeof fakeModel>) => m.doGenerate({ prompt: PROMPT })
    const stream = (m: ReturnType<typeof fakeModel>) => m.doStream({ prompt: PROMPT })

    test.each([
      ["generated, allowed", generate, [ALLOW, ALLOW]],
      ["generated, input blocked", generate, [BLOCK]],
      ["generated, output blocked", generate, [ALLOW, BLOCK]],
      ["streamed, allowed", stream, [ALLOW, ALLOW]],
      ["streamed, input blocked", stream, [BLOCK]],
      ["streamed, output blocked", stream, [ALLOW, BLOCK]],
      ["streamed, output redacted", stream, [ALLOW, REDACT]],
    ] as const)("%s", async (_label, call, answers) => {
      const wrapper = await run(call, viaWrapper, answers)
      const middleware = await run(call, viaMiddleware, answers)
      expect(wrapper).toEqual(middleware)
      expect(wrapper.calls.length).toBe(answers.length)
    })
  })

  test("is accepted by the AI SDK's generateText", async () => {
    global.fetch = guardFetchSequence(ALLOW, ALLOW)
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "Hello back." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      },
    })
    const { text } = await generateText({ model: promptguard(model, OPTS), prompt: "Hello!" })
    expect(text).toBe("Hello back.")

    global.fetch = guardFetchSequence(BLOCK)
    await expect(
      generateText({ model: promptguard(model, OPTS), prompt: "Hello!" }),
    ).rejects.toBeInstanceOf(PromptGuardBlockedError)
  })

  test("forwards getters and methods of a class-based model", () => {
    const model = new MockLanguageModelV3({ supportedUrls: { "image/*": [/^https:/] } })
    const wrapped = promptguard(model, OPTS)
    // `supportedUrls` is a getter over a private field of the instance.
    expect(wrapped.supportedUrls).toEqual({ "image/*": [/^https:/] })
    expect(wrapped).toBeInstanceOf(MockLanguageModelV3)
  })

  test("reads the API key from PROMPTGUARD_API_KEY when none is passed", () => {
    process.env.PROMPTGUARD_API_KEY = "pg_from_env"
    expect(() => promptguard(fakeModel("v4"))).not.toThrow()
  })

  test("without an API key, wrapping fails at once with missing_api_key", () => {
    delete process.env.PROMPTGUARD_API_KEY
    let thrown: unknown
    try {
      promptguard(fakeModel("v4"))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PromptGuardError)
    expect((thrown as PromptGuardError).code).toBe("missing_api_key")
  })

  test.each([
    ["a model id string", "gpt-5-nano"],
    ["an object that is not a model", { modelId: "gpt-5-nano" }],
    ["undefined", undefined],
  ])("rejects %s with a TypeError", (_label, notAModel) => {
    expect(() => promptguard(notAModel as never, OPTS)).toThrow(TypeError)
  })
})
