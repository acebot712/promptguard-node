/**
 * Tests for PromptGuard client -- namespace parity, new APIs, retry logic.
 */

import { buildRequestUrl, ensureProxySuffix } from "../src/client"
import { PromptGuard, PromptGuardError } from "../src/index"

// ── Helpers ──────────────────────────────────────────────────────────

function makeClient(overrides?: Partial<{ maxRetries: number; retryDelay: number }>) {
  return new PromptGuard({
    apiKey: "pg_test",
    baseUrl: "https://test.promptguard.co",
    maxRetries: overrides?.maxRetries ?? 0,
    retryDelay: overrides?.retryDelay ?? 10,
  })
}

function mockFetchOk(data: unknown = { ok: true }) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  })
}

function mockFetchError(status: number, msg = "fail", code = "ERR") {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: { message: msg, code } }),
  })
}

function mockFetchSequence(responses: Array<{ ok: boolean; status: number; data: unknown }>) {
  let i = 0
  return jest.fn().mockImplementation(() => {
    const r = responses[i++]
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.data),
    })
  })
}

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

// ── Namespace parity ─────────────────────────────────────────────────

describe("PromptGuard namespaces", () => {
  const pg = makeClient()

  test("has chat.completions.create", () => {
    expect(typeof pg.chat.completions.create).toBe("function")
  })

  test("has completions.create", () => {
    expect(typeof pg.completions.create).toBe("function")
  })

  test("has embeddings.create", () => {
    expect(typeof pg.embeddings.create).toBe("function")
  })

  test("has security.scan and redact", () => {
    expect(typeof pg.security.scan).toBe("function")
    expect(typeof pg.security.redact).toBe("function")
  })

  test("has scrape.url and batch", () => {
    expect(typeof pg.scrape.url).toBe("function")
    expect(typeof pg.scrape.batch).toBe("function")
  })

  test("has agent.validateTool and stats", () => {
    expect(typeof pg.agent.validateTool).toBe("function")
    expect(typeof pg.agent.stats).toBe("function")
  })

  test("has redteam methods", () => {
    expect(typeof pg.redteam.listTests).toBe("function")
    expect(typeof pg.redteam.runTest).toBe("function")
    expect(typeof pg.redteam.runAll).toBe("function")
    expect(typeof pg.redteam.runCustom).toBe("function")
  })
})

// ── Completions API ──────────────────────────────────────────────────

describe("Completions.create", () => {
  test("calls POST /completions", async () => {
    const mockData = { id: "cmpl-1", choices: [{ text: "hello" }] }
    global.fetch = mockFetchOk(mockData)
    const pg = makeClient()

    const result = await pg.completions.create({
      model: "gpt-5-nano",
      prompt: "Say hello",
    })

    expect(result).toEqual(mockData)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/completions"),
      expect.objectContaining({ method: "POST" }),
    )
  })
})

// ── Embeddings API ───────────────────────────────────────────────────

describe("Embeddings.create", () => {
  test("calls POST /embeddings", async () => {
    const mockData = { data: [{ embedding: [0.1, 0.2] }] }
    global.fetch = mockFetchOk(mockData)
    const pg = makeClient()

    const result = await pg.embeddings.create({
      model: "text-embedding-3-small",
      input: "hello world",
    })

    expect(result).toEqual(mockData)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/embeddings"),
      expect.objectContaining({ method: "POST" }),
    )
  })

  test("supports array input", async () => {
    global.fetch = mockFetchOk({ data: [] })
    const pg = makeClient()

    await pg.embeddings.create({
      model: "text-embedding-3-small",
      input: ["hello", "world"],
    })

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.input).toEqual(["hello", "world"])
  })
})

// ── Wire serialization ───────────────────────────────────────────────

describe("Completion param serialization", () => {
  test("chat: maxTokens is sent as max_tokens", async () => {
    global.fetch = mockFetchOk({ id: "c1", choices: [] })
    const pg = makeClient()

    await pg.chat.completions.create({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
    })

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.max_tokens).toBe(128)
    expect(body.maxTokens).toBeUndefined()
  })

  test("completions: maxTokens is sent as max_tokens", async () => {
    global.fetch = mockFetchOk({ id: "c2", choices: [] })
    const pg = makeClient()

    await pg.completions.create({ model: "gpt-5-nano", prompt: "hi", maxTokens: 64 })

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.max_tokens).toBe(64)
    expect(body.maxTokens).toBeUndefined()
  })

  test("maxTokens omitted stays omitted", async () => {
    global.fetch = mockFetchOk({ id: "c3", choices: [] })
    const pg = makeClient()

    await pg.chat.completions.create({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "hi" }],
    })

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect("max_tokens" in body).toBe(false)
  })

  test("stream: true is rejected with a clear error", async () => {
    global.fetch = mockFetchOk()
    const pg = makeClient()

    await expect(
      pg.chat.completions.create({
        model: "gpt-5-nano",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    ).rejects.toThrow("streaming not yet supported")
    // The request must be rejected before any network call happens.
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

// ── Retry logic ──────────────────────────────────────────────────────

describe("Retry logic", () => {
  test("retries on 500", async () => {
    global.fetch = mockFetchSequence([
      { ok: false, status: 500, data: { error: { message: "down" } } },
      { ok: true, status: 200, data: { recovered: true } },
    ])
    const pg = makeClient({ maxRetries: 2, retryDelay: 1 })

    const result = await pg.request("POST", "/test")
    expect(result).toEqual({ recovered: true })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test("retries on 429", async () => {
    global.fetch = mockFetchSequence([
      { ok: false, status: 429, data: { error: { message: "rate limit" } } },
      { ok: true, status: 200, data: { ok: true } },
    ])
    const pg = makeClient({ maxRetries: 1, retryDelay: 1 })

    const result = await pg.request("POST", "/test")
    expect(result).toEqual({ ok: true })
  })

  test("does not retry on 400", async () => {
    global.fetch = mockFetchError(400)
    const pg = makeClient({ maxRetries: 3 })

    await expect(pg.request("POST", "/test")).rejects.toThrow(PromptGuardError)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test("exhausts retries and throws", async () => {
    global.fetch = mockFetchSequence([
      { ok: false, status: 503, data: { error: { message: "down" } } },
      { ok: false, status: 503, data: { error: { message: "down" } } },
      { ok: false, status: 503, data: { error: { message: "down" } } },
    ])
    const pg = makeClient({ maxRetries: 2, retryDelay: 1 })

    await expect(pg.request("POST", "/test")).rejects.toThrow(PromptGuardError)
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  test("consumes the response body before retrying (keep-alive hygiene)", async () => {
    const cancel = jest.fn().mockResolvedValue(undefined)
    let calls = 0
    global.fetch = jest.fn().mockImplementation(() => {
      calls++
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          body: { cancel },
          json: () => Promise.resolve({}),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    })
    const pg = makeClient({ maxRetries: 1, retryDelay: 1 })

    await pg.request("POST", "/test")
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test("honors Retry-After header (delta-seconds)", async () => {
    const timeoutSpy = jest.spyOn(global, "setTimeout")
    let calls = 0
    global.fetch = jest.fn().mockImplementation(() => {
      calls++
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (name: string) => (name === "retry-after" ? "0.02" : null) },
          json: () => Promise.resolve({}),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    })
    const pg = makeClient({ maxRetries: 1, retryDelay: 1000 })

    const result = await pg.request("POST", "/test")
    expect(result).toEqual({ ok: true })
    // Retry-After of 0.02s (=20ms) overrides the 1000ms base backoff:
    // the scheduled delay must be 20ms plus at most 25% of backoff jitter.
    const delays = timeoutSpy.mock.calls.map((c) => c[1] as number)
    const retryDelay = Math.max(...delays)
    expect(retryDelay).toBeGreaterThanOrEqual(20)
    expect(retryDelay).toBeLessThan(20 + 0.25 * 1000 + 1)
    timeoutSpy.mockRestore()
  })

  test("clamps Retry-After to 60 seconds", async () => {
    // Fire timers immediately so the clamped 60s delay doesn't slow the
    // suite, while still capturing the scheduled delay values.
    const timeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb()
      return 0 as unknown as NodeJS.Timeout
    }) as never)
    let calls = 0
    global.fetch = jest.fn().mockImplementation(() => {
      calls++
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          // A hostile/misconfigured server asking for a 1-hour delay.
          headers: { get: (name: string) => (name === "retry-after" ? "3600" : null) },
          json: () => Promise.resolve({}),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    })
    try {
      const pg = makeClient({ maxRetries: 1, retryDelay: 1 })
      const result = await pg.request("POST", "/test")
      expect(result).toEqual({ ok: true })
      const delays = timeoutSpy.mock.calls.map((c) => c[1] as number)
      const retryDelay = Math.max(...delays)
      // Clamped to 60s (+ up to 25% of the 1ms base backoff jitter).
      expect(retryDelay).toBeGreaterThanOrEqual(60_000)
      expect(retryDelay).toBeLessThanOrEqual(60_000 + 1)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  test("terminal 2xx JSON-parse failure surfaces as PromptGuardError, not SyntaxError", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    })
    const pg = makeClient({ maxRetries: 0 })

    const err = await pg
      .request("POST", "/test")
      .then(() => null)
      .catch((e) => e)
    expect(err).toBeInstanceOf(PromptGuardError)
    expect((err as PromptGuardError).code).toBe("INVALID_RESPONSE_BODY")
    expect((err as PromptGuardError).statusCode).toBe(200)
  })

  test("2xx JSON-parse failure is retried before failing", async () => {
    let calls = 0
    global.fetch = jest.fn().mockImplementation(() => {
      calls++
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("truncated body")),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    })
    const pg = makeClient({ maxRetries: 1, retryDelay: 1 })

    const result = await pg.request("POST", "/test")
    expect(result).toEqual({ ok: true })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test("does not retry deterministic non-network errors", async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      // e.g. an invalid header value — undici throws before dispatch,
      // without the "fetch failed" message or a cause.
      throw new TypeError("invalid header value")
    })
    const pg = makeClient({ maxRetries: 3, retryDelay: 1 })

    await expect(pg.request("POST", "/test")).rejects.toThrow("invalid header value")
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test("retries on network error", async () => {
    let calls = 0
    global.fetch = jest.fn().mockImplementation(() => {
      calls++
      if (calls === 1) throw new TypeError("fetch failed")
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      })
    })
    const pg = makeClient({ maxRetries: 1, retryDelay: 1 })

    const result = await pg.request("POST", "/test")
    expect(result).toEqual({ ok: true })
  })
})

// ── SDK headers ──────────────────────────────────────────────────────

describe("SDK headers", () => {
  test("sends X-PromptGuard-SDK and Version", async () => {
    global.fetch = mockFetchOk()
    const pg = makeClient()

    await pg.request("GET", "/test")

    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers
    expect(headers["X-PromptGuard-SDK"]).toBe("node")
    // src/version.ts is generated from package.json (prebuild); they must agree.
    expect(headers["X-PromptGuard-Version"]).toBe(require("../package.json").version)
  })
})

// ── Validation ───────────────────────────────────────────────────────

describe("Validation", () => {
  test("throws without API key", () => {
    const originalEnv = process.env.PROMPTGUARD_API_KEY
    // `process.env.X = undefined` would set the literal string "undefined";
    // the variable must actually be removed for the test to be meaningful.
    Reflect.deleteProperty(process.env, "PROMPTGUARD_API_KEY")

    try {
      expect(() => new PromptGuard({ apiKey: "" })).toThrow("API key required")
    } finally {
      if (originalEnv !== undefined) process.env.PROMPTGUARD_API_KEY = originalEnv
      else Reflect.deleteProperty(process.env, "PROMPTGUARD_API_KEY")
    }
  })
})

// ── Proxy base-URL suffix logic ──────────────────────────────────────

describe("ensureProxySuffix", () => {
  test.each([
    // Appends /proxy when missing.
    ["https://api.promptguard.co/api/v1", "https://api.promptguard.co/api/v1/proxy"],
    // Trailing slash is stripped before appending.
    ["https://api.promptguard.co/api/v1/", "https://api.promptguard.co/api/v1/proxy"],
    // Already suffixed -> unchanged.
    ["https://api.promptguard.co/api/v1/proxy", "https://api.promptguard.co/api/v1/proxy"],
    // Already suffixed with trailing slash -> normalized.
    ["https://api.promptguard.co/api/v1/proxy/", "https://api.promptguard.co/api/v1/proxy"],
    // Host with explicit port is preserved.
    ["http://localhost:8080/api/v1", "http://localhost:8080/api/v1/proxy"],
    // Host-only URL.
    ["https://test.promptguard.co", "https://test.promptguard.co/proxy"],
  ])("%s -> %s", (input, expected) => {
    expect(ensureProxySuffix(input)).toBe(expected)
  })

  test("preserves query string", () => {
    expect(ensureProxySuffix("https://api.promptguard.co/api/v1?foo=bar")).toBe(
      "https://api.promptguard.co/api/v1/proxy?foo=bar",
    )
  })

  test("preserves query string with trailing slash", () => {
    expect(ensureProxySuffix("https://api.promptguard.co/api/v1/?foo=bar")).toBe(
      "https://api.promptguard.co/api/v1/proxy?foo=bar",
    )
  })

  test("preserves fragment", () => {
    expect(ensureProxySuffix("https://api.promptguard.co/api/v1#frag")).toBe(
      "https://api.promptguard.co/api/v1/proxy#frag",
    )
  })

  test("does not double-append when already suffixed with a query", () => {
    expect(ensureProxySuffix("https://api.promptguard.co/api/v1/proxy?x=1")).toBe(
      "https://api.promptguard.co/api/v1/proxy?x=1",
    )
  })

  test("does not match 'proxy' as a substring of the last segment", () => {
    expect(ensureProxySuffix("https://api.promptguard.co/api/v1/myproxy")).toBe(
      "https://api.promptguard.co/api/v1/myproxy/proxy",
    )
  })
})

describe("buildRequestUrl", () => {
  test("appends the endpoint path to a plain base URL", () => {
    expect(buildRequestUrl("https://api.promptguard.co/api/v1/proxy", "/chat/completions")).toBe(
      "https://api.promptguard.co/api/v1/proxy/chat/completions",
    )
  })

  test("keeps a query string after the endpoint path", () => {
    expect(buildRequestUrl("https://x.com/api/v1/proxy?token=abc", "/chat/completions")).toBe(
      "https://x.com/api/v1/proxy/chat/completions?token=abc",
    )
  })

  test("keeps a fragment after the endpoint path", () => {
    expect(buildRequestUrl("https://x.com/api/v1/proxy#frag", "/embeddings")).toBe(
      "https://x.com/api/v1/proxy/embeddings#frag",
    )
  })

  test("falls back to concatenation for unparseable base URLs", () => {
    expect(buildRequestUrl("not a url", "/x")).toBe("not a url/x")
  })
})

// ── Quota error parsing ─────────────────────────────────────────────

describe("Quota error parsing", () => {
  const savedFetch = global.fetch

  afterEach(() => {
    global.fetch = savedFetch
  })

  test("quota error includes upgrade fields", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          error: {
            message: "Monthly quota of 10,000 requests exceeded.",
            type: "quota_exceeded",
            code: "monthly_quota_exceeded",
            current_plan: "free",
            requests_used: 10000,
            requests_limit: 10000,
            upgrade_url: "https://app.promptguard.co/billing",
          },
        }),
    })

    const pg = makeClient()
    try {
      await pg.request("POST", "/test")
      throw new Error("Expected PromptGuardError")
    } catch (err) {
      expect(err).toBeInstanceOf(PromptGuardError)
      const e = err as PromptGuardError
      expect(e.statusCode).toBe(429)
      expect(e.code).toBe("monthly_quota_exceeded")
      expect(e.errorType).toBe("quota_exceeded")
      expect(e.upgradeUrl).toBe("https://app.promptguard.co/billing")
      expect(e.currentPlan).toBe("free")
      expect(e.requestsUsed).toBe(10000)
      expect(e.requestsLimit).toBe(10000)
    }
  })
})
