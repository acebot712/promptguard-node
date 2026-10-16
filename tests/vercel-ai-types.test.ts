/**
 * The Vercel AI SDK integration type-checks against the real `ai` types of
 * every major `promptguard()` supports (ai 5, 6 and 7).
 *
 * ts-jest type-checks this file when the suite runs, so a middleware or a
 * wrapped model that one of those majors would reject fails the suite. The
 * functions below are never called: they exist to be compiled.
 *
 * - ai@5 types its middleware and models as `LanguageModelV2*`, re-exported
 *   from `@ai-sdk/provider@2` — installed here as `ai-sdk-provider-v2`.
 * - ai@6 (`ai-v6`) types `LanguageModelMiddleware` as V3, which requires
 *   `specificationVersion: 'v3'` on the middleware object.
 * - ai@7 (`ai-v7`) is LanguageModelV4 and relaxes the middleware's version.
 *   It is ESM-only, so it is imported for its types alone.
 */

import type { LanguageModelV2, LanguageModelV2Middleware } from "ai-sdk-provider-v2"
import type {
  generateText as generateTextV6,
  LanguageModelMiddleware as MiddlewareV6,
  streamText as streamTextV6,
  wrapLanguageModel as wrapV6,
} from "ai-v6"
import type {
  generateText as generateTextV7,
  LanguageModelMiddleware as MiddlewareV7,
  streamText as streamTextV7,
  wrapLanguageModel as wrapV7,
} from "ai-v7"
import { promptGuardMiddleware, promptguard } from "../src/integrations/vercel-ai"

type ModelV3 = Parameters<typeof wrapV6>[0]["model"]
type ModelV4 = ReturnType<typeof wrapV7>

const middleware = () => promptGuardMiddleware({ apiKey: "pg_test", scanResponses: true })

/** ai@5: the middleware is a LanguageModelV2Middleware; a wrapped V2 model stays V2. */
function aiV5(model: LanguageModelV2) {
  const mw: LanguageModelV2Middleware = middleware()
  const wrapped: LanguageModelV2 = promptguard(model)
  return { mw, wrapped }
}

/** ai@6: the middleware is ai@6's LanguageModelMiddleware; a wrapped model is accepted everywhere a model is. */
function aiV6(model: ModelV3) {
  const mw: MiddlewareV6 = middleware()
  const viaMiddleware: Parameters<typeof wrapV6>[0] = { model, middleware: middleware() }
  const wrapped: ModelV3 = promptguard(model, { apiKey: "pg_test" })
  const generate: Parameters<typeof generateTextV6>[0]["model"] = promptguard(model)
  const stream: Parameters<typeof streamTextV6>[0]["model"] = promptguard(model)
  return { mw, viaMiddleware, wrapped, generate, stream }
}

/** ai@7 (current): the same, for LanguageModelV4. */
function aiV7(model: ModelV4) {
  const mw: MiddlewareV7 = middleware()
  const viaMiddleware: Parameters<typeof wrapV7>[0] = { model, middleware: middleware() }
  const wrapped: ModelV4 = promptguard(model, { scanResponses: true })
  const generate: Parameters<typeof generateTextV7>[0]["model"] = promptguard(model)
  const stream: Parameters<typeof streamTextV7>[0]["model"] = promptguard(model)
  return { mw, viaMiddleware, wrapped, generate, stream }
}

describe("Vercel AI SDK integration types", () => {
  test("compile against ai@5, ai@6 and ai@7", () => {
    // Reaching here means this file compiled; the checks are the signatures above.
    expect([aiV5, aiV6, aiV7].every((fn) => typeof fn === "function")).toBe(true)
  })
})
