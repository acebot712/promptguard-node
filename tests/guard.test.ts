import {
  GuardApiError,
  GuardClient,
  GuardDecision,
  PromptGuardBlockedError,
  safeErrorLabel,
} from "../src/guard"
import { PromptGuardCallbackHandler } from "../src/integrations/langchain"

// ---------------------------------------------------------------------------
// GuardDecision
// ---------------------------------------------------------------------------

describe("GuardDecision", () => {
  test("allow decision", () => {
    const d = new GuardDecision({
      decision: "allow",
      event_id: "evt-1",
      confidence: 0.1,
      threats: [],
      latency_ms: 5,
    })
    expect(d.allowed).toBe(true)
    expect(d.blocked).toBe(false)
    expect(d.redacted).toBe(false)
    expect(d.eventId).toBe("evt-1")
    expect(d.confidence).toBe(0.1)
  })

  test("block decision", () => {
    const d = new GuardDecision({
      decision: "block",
      event_id: "evt-2",
      confidence: 0.95,
      threat_type: "prompt_injection",
      threats: [{ type: "prompt_injection", confidence: 0.95, details: "detected" }],
      latency_ms: 12,
    })
    expect(d.blocked).toBe(true)
    expect(d.allowed).toBe(false)
    expect(d.threatType).toBe("prompt_injection")
    expect(d.threats).toHaveLength(1)
  })

  test("redact decision", () => {
    const d = new GuardDecision({
      decision: "redact",
      event_id: "evt-3",
      confidence: 0.8,
      threat_type: "pii",
      redacted_messages: [{ role: "user", content: "My SSN is [REDACTED]" }],
      threats: [],
      latency_ms: 8,
    })
    expect(d.redacted).toBe(true)
    expect(d.redactedMessages).toHaveLength(1)
    expect(d.redactedMessages?.[0].content).toBe("My SSN is [REDACTED]")
  })

  test("defaults for missing optional fields", () => {
    const d = new GuardDecision({ decision: "allow" })
    expect(d.decision).toBe("allow")
    expect(d.eventId).toBe("")
    expect(d.confidence).toBe(0)
    expect(d.threatType).toBeUndefined()
    expect(d.threats).toEqual([])
    expect(d.latencyMs).toBe(0)
  })

  test("empty body throws instead of defaulting to allow", () => {
    // A malformed/empty body must never silently become an "allow" —
    // the caller's failOpen policy decides what happens.
    expect(() => new GuardDecision({})).toThrow(GuardApiError)
  })

  test("invalid decision value throws GuardApiError", () => {
    expect(() => new GuardDecision({ decision: "yolo" as unknown as "allow" })).toThrow(
      GuardApiError,
    )
    expect(() => new GuardDecision({ decision: 42 as unknown as "allow" })).toThrow(GuardApiError)
  })
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("GuardApiError", () => {
  test("includes status code", () => {
    const err = new GuardApiError("server error", 500)
    expect(err.message).toBe("server error")
    expect(err.statusCode).toBe(500)
    expect(err.name).toBe("GuardApiError")
  })

  test("works without status code", () => {
    const err = new GuardApiError("network error")
    expect(err.statusCode).toBeUndefined()
  })

  test("safeDescription omits the response body but keeps the status code", () => {
    // .message may embed the raw Guard API body (which can echo prompt content).
    const leaky = new GuardApiError(
      'Guard API returned 500: {"prompt":"my secret password is hunter2"}',
      500,
    )
    const safe = leaky.safeDescription()
    expect(safe).toBe("Guard API error (HTTP 500)")
    expect(safe).not.toContain("hunter2")
    expect(safe).not.toContain("prompt")
  })

  test("safeDescription labels network errors without a status code", () => {
    const netErr = new GuardApiError("Guard API call failed: ECONNREFUSED 10.0.0.5:443")
    const safe = netErr.safeDescription()
    expect(safe).toBe("Guard API unreachable (network error)")
    expect(safe).not.toContain("10.0.0.5")
  })
})

describe("safeErrorLabel", () => {
  test("returns the safe description for a GuardApiError", () => {
    const err = new GuardApiError(
      'Guard API returned 422: {"messages":[{"content":"sensitive user prompt"}]}',
      422,
    )
    const label = safeErrorLabel(err)
    expect(label).toBe("Guard API error (HTTP 422)")
    expect(label).not.toContain("sensitive user prompt")
  })

  test("does not echo arbitrary error contents for non-GuardApiError", () => {
    const label = safeErrorLabel(new Error("leaked: top secret prompt body"))
    expect(label).toBe("unexpected error")
    expect(label).not.toContain("top secret")
  })

  test("never includes the API key", () => {
    const err = new GuardApiError('Guard API returned 401: {"key":"pg_live_supersecret"}', 401)
    expect(safeErrorLabel(err)).not.toContain("pg_live_supersecret")
  })
})

describe("PromptGuardBlockedError", () => {
  test("includes decision and readable message", () => {
    const decision = new GuardDecision({
      decision: "block",
      event_id: "evt-x",
      confidence: 0.92,
      threat_type: "prompt_injection",
      threats: [],
      latency_ms: 5,
    })
    const err = new PromptGuardBlockedError(decision)
    expect(err.name).toBe("PromptGuardBlockedError")
    expect(err.decision).toBe(decision)
    expect(err.message).toContain("prompt_injection")
    expect(err.message).toContain("0.92")
    expect(err.message).toContain("evt-x")
  })

  test("fallback when no threat type", () => {
    const decision = new GuardDecision({
      decision: "block",
      event_id: "evt-y",
      confidence: 0.5,
      threats: [],
      latency_ms: 3,
    })
    const err = new PromptGuardBlockedError(decision)
    expect(err.message).toContain("policy_violation")
  })
})

// ---------------------------------------------------------------------------
// GuardClient
// ---------------------------------------------------------------------------

describe("GuardClient", () => {
  test("constructs correct guard URL", () => {
    const client = new GuardClient({ apiKey: "pg_test" })
    // Access private field for testing
    expect((client as unknown as { guardUrl: string }).guardUrl).toBe(
      "https://api.promptguard.co/api/v1/guard",
    )
  })

  test("strips trailing slash from base URL", () => {
    const client = new GuardClient({
      apiKey: "pg_test",
      baseUrl: "https://example.com/api/v1/",
    })
    expect((client as unknown as { guardUrl: string }).guardUrl).toBe(
      "https://example.com/api/v1/guard",
    )
  })

  test("custom URL", () => {
    const client = new GuardClient({
      apiKey: "pg_test",
      baseUrl: "http://localhost:8080/api/v1",
    })
    expect((client as unknown as { guardUrl: string }).guardUrl).toBe(
      "http://localhost:8080/api/v1/guard",
    )
  })

  test("headers include auth and SDK info", () => {
    const client = new GuardClient({ apiKey: "pg_my_key" })
    const headers = (client as unknown as { headers: () => Record<string, string> }).headers()
    expect(headers["X-API-Key"]).toBe("pg_my_key")
    expect(headers["X-PromptGuard-SDK"]).toBe("node-auto")
    // src/version.ts is generated from package.json (prebuild); they must agree.
    expect(headers["X-PromptGuard-Version"]).toBe(require("../package.json").version)
    expect(headers["Content-Type"]).toBe("application/json")
  })

  test("scan throws GuardApiError on network failure", async () => {
    // Mock global fetch to simulate failure
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"))

    const client = new GuardClient({ apiKey: "pg_test" })
    await expect(client.scan([{ role: "user", content: "hello" }], "input")).rejects.toThrow(
      GuardApiError,
    )

    global.fetch = originalFetch
  })

  test("scan throws GuardApiError on 500 response", async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    })

    // maxRetries: 0 — this test asserts the terminal 500 error shape, not the
    // retry behavior (which is covered in "GuardClient retry" below).
    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 0 })
    await expect(client.scan([{ role: "user", content: "hello" }], "input")).rejects.toThrow(
      GuardApiError,
    )

    global.fetch = originalFetch
  })

  test("scan returns GuardDecision on success", async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        decision: "allow",
        event_id: "evt-ok",
        confidence: 0.05,
        threats: [],
        latency_ms: 3,
      }),
    })

    const client = new GuardClient({ apiKey: "pg_test" })
    const result = await client.scan([{ role: "user", content: "hello" }], "input")

    expect(result).toBeInstanceOf(GuardDecision)
    expect(result.allowed).toBe(true)
    expect(result.eventId).toBe("evt-ok")

    global.fetch = originalFetch
  })

  test("scan throws GuardApiError when a 2xx body is malformed JSON", async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON")
      },
    })

    // maxRetries: 0 — asserts the terminal invalid-JSON error shape; retry of
    // a transient malformed 2xx body is covered in "GuardClient retry" below.
    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 0 })
    const err = await client
      .scan([{ role: "user", content: "hello" }], "input")
      .then(() => null)
      .catch((e) => e)
    expect(err).toBeInstanceOf(GuardApiError)
    expect((err as GuardApiError).statusCode).toBe(200)
    expect((err as GuardApiError).message).toContain("invalid JSON")

    global.fetch = originalFetch
  })

  test("scan throws GuardApiError when a 2xx body has an invalid decision", async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ totally: "unexpected" }),
    })

    const client = new GuardClient({ apiKey: "pg_test" })
    await expect(client.scan([{ role: "user", content: "hello" }], "input")).rejects.toThrow(
      GuardApiError,
    )

    global.fetch = originalFetch
  })
})

// ---------------------------------------------------------------------------
// GuardClient retry logic (finding 2)
// ---------------------------------------------------------------------------

describe("GuardClient retry", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  const allowBody = {
    ok: true,
    status: 200,
    json: async () => ({
      decision: "allow",
      event_id: "evt-ok",
      confidence: 0.02,
      threats: [],
      latency_ms: 1,
    }),
  }

  const blockBody = {
    ok: true,
    status: 200,
    json: async () => ({
      decision: "block",
      event_id: "evt-block",
      confidence: 0.95,
      threat_type: "prompt_injection",
      threats: [],
      latency_ms: 1,
    }),
  }

  // A retryable transient HTTP response (503) with the header/body surface the
  // retry loop touches.
  const transient503 = {
    ok: false,
    status: 503,
    headers: { get: () => null },
    text: async () => "temporarily unavailable",
  }

  test("retries a transient network failure, then succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(allowBody)
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 2, retryDelay: 1 })
    const result = await client.scan([{ role: "user", content: "hello" }], "input")

    expect(result.allowed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("retries a 503, then succeeds", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(transient503).mockResolvedValueOnce(blockBody)
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 2, retryDelay: 1 })
    const result = await client.scan([{ role: "user", content: "attack" }], "input")

    expect(result.blocked).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("exhausted retries surface a GuardApiError (network)", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 2, retryDelay: 1 })
    await expect(client.scan([{ role: "user", content: "hi" }], "input")).rejects.toThrow(
      GuardApiError,
    )
    // 1 initial attempt + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("exhausted retries on 503 surface a GuardApiError with status", async () => {
    const fetchMock = jest.fn().mockResolvedValue(transient503)
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 1, retryDelay: 1 })
    const err = await client
      .scan([{ role: "user", content: "hi" }], "input")
      .then(() => null)
      .catch((e) => e)
    expect(err).toBeInstanceOf(GuardApiError)
    expect((err as GuardApiError).statusCode).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("maxRetries: 0 makes exactly one attempt (at-most-once)", async () => {
    const fetchMock = jest.fn().mockResolvedValue(transient503)
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 0 })
    await expect(client.scan([{ role: "user", content: "hi" }], "input")).rejects.toThrow(
      GuardApiError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not retry a non-retryable 4xx", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "bad request",
    })
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 3, retryDelay: 1 })
    await expect(client.scan([{ role: "user", content: "hi" }], "input")).rejects.toThrow(
      GuardApiError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("a definitive block decision (2xx) is never retried", async () => {
    // Enforcement invariant: a real decision is terminal — retries must not
    // re-run it or turn it into anything else.
    const fetchMock = jest.fn().mockResolvedValue(blockBody)
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 3, retryDelay: 1 })
    const result = await client.scan([{ role: "user", content: "attack" }], "input")
    expect(result.blocked).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not retry a deterministic (non-network) fetch error", async () => {
    // A plain Error with no errno/cause is not a transient network failure —
    // retrying just delays the inevitable GuardApiError.
    const fetchMock = jest.fn().mockRejectedValue(new Error("invalid header value"))
    global.fetch = fetchMock

    const client = new GuardClient({ apiKey: "pg_test", maxRetries: 3, retryDelay: 1 })
    await expect(client.scan([{ role: "user", content: "hi" }], "input")).rejects.toThrow(
      GuardApiError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("after exhausted retries, fail-open policy governs end-to-end", async () => {
    // The retry loop does not change enforcement: once retries are exhausted a
    // GuardApiError is thrown, and the caller's existing failOpen policy
    // decides. With failOpen (default), the call proceeds unscanned.
    const fetchMock = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    global.fetch = fetchMock

    const handler = new PromptGuardCallbackHandler({
      apiKey: "pg_test",
      maxRetries: 2,
      retryDelay: 1,
      failOpen: true,
      silent: true,
    })

    // Fail-open: no throw despite the Guard API being unreachable.
    await expect(handler.handleLLMStart({}, ["hello"], "run-fo")).resolves.toBeUndefined()
    // 1 initial attempt + 2 retries before failing open.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("after exhausted retries, fail-closed still blocks the call", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError("fetch failed"))
    global.fetch = fetchMock

    const handler = new PromptGuardCallbackHandler({
      apiKey: "pg_test",
      maxRetries: 1,
      retryDelay: 1,
      failOpen: false,
      silent: true,
    })

    await expect(handler.handleLLMStart({}, ["hello"], "run-fc")).rejects.toThrow(GuardApiError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
