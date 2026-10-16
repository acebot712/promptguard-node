/**
 * `promptguard(model)` — the Vercel AI SDK model wrapper.
 *
 * The wrapper must behave exactly like `promptGuardMiddleware` applied with
 * the AI SDK's own `wrapLanguageModel`, generated and streamed, while leaving
 * the model it wraps the model it was: same specification version, same
 * provider and model id, same properties.
 */

import { generateText, streamText, wrapLanguageModel } from "ai-v6"
import { MockLanguageModelV3 } from "ai-v6/test"
import { PromptGuardError } from "../src/client"
import { PromptGuardBlockedError } from "../src/guard"
import * as sdk from "../src/index"
import {
  type PromptGuardMiddlewareOptions,
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
} satisfies PromptGuardMiddlewareOptions

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

      // A V2 stream ends with an error part (ai@5 hangs on an errored
      // stream); later versions error the stream.
      const stoppedWith =
        spec === "v2" ? out.parts.find((p) => p.type === "error")?.error : out.error
      expect(stoppedWith).toBeInstanceOf(PromptGuardBlockedError)
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

  describe("the Guard API is told which model made the call", () => {
    /** The `model` field of every Guard request, in order. */
    const guardModels = (fetchMock: jest.Mock) =>
      fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).model)

    const viaMiddleware = (m: ReturnType<typeof fakeModel>) =>
      wrapLanguageModel({
        model: m as never,
        middleware: promptGuardMiddleware(OPTS),
      }) as unknown as ReturnType<typeof fakeModel>
    const viaWrapper = (m: ReturnType<typeof fakeModel>) => promptguard(m, OPTS)

    test.each([
      ["promptguard(model)", viaWrapper],
      ["the middleware under wrapLanguageModel", viaMiddleware],
    ])("%s, generated and streamed, input and output", async (_label, wrap) => {
      // The AI SDK puts no model id in the call options: it is on the model.
      const generated = guardFetchSequence(ALLOW, ALLOW)
      global.fetch = generated
      await wrap(fakeModel("v3")).doGenerate({ prompt: PROMPT })
      expect(guardModels(generated)).toEqual(["gpt-5-nano", "gpt-5-nano"])

      const streamed = guardFetchSequence(ALLOW, ALLOW)
      global.fetch = streamed
      const result = (await wrap(fakeModel("v3")).doStream({ prompt: PROMPT })) as {
        stream: ReadableStream<Part>
      }
      await drain(result.stream)
      expect(guardModels(streamed)).toEqual(["gpt-5-nano", "gpt-5-nano"])
    })
  })

  describe("how a blocked stream reaches an ai@6 streamText caller", () => {
    // Recorded against the real ai@6 here, and ai@7 in the pack smoke test;
    // the README states the same, so a change in either shows up as a failure.
    function streaming(onError: jest.Mock) {
      const usage = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      }
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: streamOf([
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: LEAKED_TEXT },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ]) as never,
        }),
      })
      return streamText({ model: promptguard(model, OPTS), prompt: "Hello!", onError })
    }

    async function readText(result: ReturnType<typeof streaming>) {
      let text = ""
      try {
        for await (const chunk of result.textStream) text += chunk
      } catch (error) {
        return { text, thrown: error }
      }
      return { text }
    }

    test("blocked output: textStream throws PromptGuardBlockedError; onError is not called", async () => {
      global.fetch = guardFetchSequence(ALLOW, BLOCK)
      const onError = jest.fn()
      const out = await readText(streaming(onError))
      expect(out.thrown).toBeInstanceOf(PromptGuardBlockedError)
      expect(out.text).toBe("")
      expect(onError).not.toHaveBeenCalled()
    })

    test("blocked input: onError and an error part get PromptGuardBlockedError; textStream ends empty", async () => {
      global.fetch = guardFetchSequence(BLOCK)
      const onError = jest.fn()
      const result = streaming(onError)
      const errorParts: unknown[] = []
      for await (const part of result.fullStream)
        if (part.type === "error") errorParts.push(part.error)
      expect(errorParts).toHaveLength(1)
      expect(errorParts[0]).toBeInstanceOf(PromptGuardBlockedError)
      expect(onError.mock.calls[0][0].error).toBeInstanceOf(PromptGuardBlockedError)

      global.fetch = guardFetchSequence(BLOCK)
      expect(await readText(streaming(jest.fn()))).toEqual({ text: "" })
    })
  })

  test("forwards a class-based model's getters and stays an instance of its class", async () => {
    const model = new MockLanguageModelV3({ supportedUrls: { "image/*": [/^https:/] } })
    const wrapped = promptguard(model, OPTS)
    // `supportedUrls` is a getter over a private field of the instance.
    expect(await wrapped.supportedUrls).toEqual({ "image/*": [/^https:/] })
    expect(wrapped).toBeInstanceOf(MockLanguageModelV3)
  })

  describe("a model that cannot be modified", () => {
    test("a frozen model is wrapped, keeps its properties and is scanned", async () => {
      const model = Object.freeze(fakeModel("v3"))
      const wrapped = promptguard(model, OPTS)
      expect(wrapped.specificationVersion).toBe("v3")
      expect(wrapped.provider).toBe("fake.chat")
      expect(wrapped.modelId).toBe("gpt-5-nano")
      expect(wrapped.supportedUrls).toBe(model.supportedUrls)

      const fetchMock = guardFetchSequence(ALLOW, BLOCK)
      global.fetch = fetchMock
      await expect(wrapped.doGenerate({ prompt: PROMPT })).rejects.toBeInstanceOf(
        PromptGuardBlockedError,
      )
      expect(guardBodies(fetchMock)).toEqual([
        { direction: "input", content: "What is the customer's SSN?" },
        { direction: "output", content: LEAKED_TEXT },
      ])
    })

    test("a frozen class-based model stays an instance of its class, its getters forward, and generateText accepts it", async () => {
      const model = Object.freeze(
        new MockLanguageModelV3({
          supportedUrls: { "image/*": [/^https:/] },
          doGenerate: {
            content: [{ type: "text", text: "Hello back." }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
            warnings: [],
          },
        }),
      )
      const wrapped = promptguard(model, OPTS)
      expect(wrapped).toBeInstanceOf(MockLanguageModelV3)
      expect(Object.getPrototypeOf(wrapped)).toBe(MockLanguageModelV3.prototype)
      expect(await wrapped.supportedUrls).toEqual({ "image/*": [/^https:/] })

      global.fetch = guardFetchSequence(ALLOW, ALLOW)
      const { text } = await generateText({ model: wrapped, prompt: "Hello!" })
      expect(text).toBe("Hello back.")
    })

    test("supportedUrls given as a promise is the model's own promise", () => {
      const supportedUrls = Promise.resolve({ "image/*": [/^https:\/\//] })
      const model = Object.freeze({ ...fakeModel("v3"), supportedUrls })
      expect(promptguard(model, OPTS).supportedUrls).toBe(supportedUrls)
    })

    test("its own properties still spread and enumerate as the model's", () => {
      const model = Object.freeze(fakeModel("v4"))
      const wrapped = promptguard(model, OPTS)
      expect(Object.keys(wrapped)).toEqual(Object.keys(model))
      expect("supportedUrls" in wrapped).toBe(true)
      const copy = { ...wrapped }
      expect(copy.modelId).toBe("gpt-5-nano")
      expect(copy.doGenerate).toBe(wrapped.doGenerate)
    })
  })

  test("refuses a specification-v1 (ai 4) model with a TypeError naming the supported versions and the ai 4 integration", () => {
    const v1 = { ...fakeModel("v4"), specificationVersion: "v1" }
    let thrown: unknown
    try {
      promptguard(v1, OPTS)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    const message = (thrown as TypeError).message
    for (const named of ["v1", "v2", "v3", "v4", "promptGuardMiddleware", "wrapLanguageModel"])
      expect(message).toContain(named)
  })

  test("is exported from the package root too", () => {
    expect(sdk.promptguard).toBe(promptguard)
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
