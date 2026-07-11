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

describe("double init() without shutdown()", () => {
  afterEach(() => {
    jest.dontMock("../src/patches/openai")
    jest.resetModules()
  })

  test("does not duplicate appliedPatches entries and reverts once", () => {
    // Regression: a second init() used to push a duplicate entry for every
    // already-applied patch (apply() is idempotent and reports success), so
    // the getAppliedPatches() canary lied and shutdown() called revert()
    // twice per patch.
    jest.resetModules()
    const revert = jest.fn()
    const apply = jest.fn().mockReturnValue(true)
    jest.doMock("../src/patches/openai", () => ({ apply, revert }))
    jest.spyOn(console, "warn").mockImplementation()

    // Fresh module registry so auto.ts resolves the mocked patch module.
    const auto = require("../src/auto") as typeof import("../src/auto")

    auto.init({ apiKey: "pg_test" })
    auto.init({ apiKey: "pg_test" })

    expect(apply).toHaveBeenCalledTimes(2)
    expect(auto.getAppliedPatches()).toEqual(["openai"])

    auto.shutdown()
    expect(revert).toHaveBeenCalledTimes(1)
    expect(auto.getAppliedPatches()).toEqual([])
  })
})
