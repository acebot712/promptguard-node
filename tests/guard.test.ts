import { GuardApiError, GuardClient, GuardDecision, PromptGuardBlockedError } from "../src/guard"

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

  test("defaults for missing fields", () => {
    const d = new GuardDecision({})
    expect(d.decision).toBe("allow")
    expect(d.eventId).toBe("")
    expect(d.confidence).toBe(0)
    expect(d.threatType).toBeUndefined()
    expect(d.threats).toEqual([])
    expect(d.latencyMs).toBe(0)
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
    expect(headers.Authorization).toBe("Bearer pg_my_key")
    expect(headers["X-PromptGuard-SDK"]).toBe("node-auto")
    expect(headers["X-PromptGuard-Version"]).toBe("1.5.2")
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

    const client = new GuardClient({ apiKey: "pg_test" })
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
})
