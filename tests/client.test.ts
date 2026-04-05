/**
 * Tests for PromptGuard client -- namespace parity, new APIs, retry logic.
 */

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
      model: "gpt-3.5-turbo-instruct",
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
    expect(headers["X-PromptGuard-Version"]).toBe("1.5.2")
  })
})

// ── Validation ───────────────────────────────────────────────────────

describe("Validation", () => {
  test("throws without API key", () => {
    const originalEnv = process.env.PROMPTGUARD_API_KEY
    process.env.PROMPTGUARD_API_KEY = undefined

    expect(() => new PromptGuard({ apiKey: "" })).toThrow("API key required")

    if (originalEnv !== undefined) process.env.PROMPTGUARD_API_KEY = originalEnv
  })
})
