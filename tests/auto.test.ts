/**
 * Tests for auto-instrumentation orchestration (src/auto.ts).
 *
 * None of the provider SDKs are installed in this repo, so init() exercises
 * the zero-patches path — exactly the situation a native-ESM app (or an app
 * without any supported SDK) ends up in.
 */

import { getAppliedPatches, init, shutdown } from "../src/auto"
import { setLogLevel } from "../src/logger"

afterEach(() => {
  shutdown()
  // init({ logLevel }) mutates the process-global level; reset to default.
  setLogLevel("warn")
  jest.restoreAllMocks()
})

describe("init with no patchable SDKs", () => {
  test("warns loudly when zero patches are applied", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation()

    init({ apiKey: "pg_test" })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ZERO auto-instrumentation patches"),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Limitations: ESM apps"))
  })

  test("getAppliedPatches() reports no applied patches (runtime canary)", () => {
    jest.spyOn(console, "warn").mockImplementation()

    init({ apiKey: "pg_test" })

    expect(getAppliedPatches()).toEqual([])
  })

  test("logs a per-SDK debug reason for every module that was not patched", () => {
    jest.spyOn(console, "warn").mockImplementation()
    const debugSpy = jest.spyOn(console, "debug").mockImplementation()

    init({ apiKey: "pg_test", logLevel: "debug" })

    for (const name of ["openai", "anthropic", "google", "cohere", "bedrock"]) {
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining(`${name} patch not applied`))
    }
  })

  test("rejects an invalid mode", () => {
    jest.spyOn(console, "warn").mockImplementation()
    expect(() => init({ apiKey: "pg_test", mode: "audit" as never })).toThrow(
      "mode must be 'enforce' or 'monitor'",
    )
  })
})
