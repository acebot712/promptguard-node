/**
 * `verify()` has to report the failures that otherwise look like success.
 *
 * The SDK fails open, so the states worth testing are the quiet ones: a key
 * that is rejected, a Guard API that cannot be reached, and a policy that lets
 * a plain injection through. In every one of those an instrumented application
 * keeps serving traffic and blocks nothing — and in a native-ESM app, where
 * auto-instrumentation may never attach, that is the default rather than the
 * edge case.
 *
 * The distinction pinned down here is fail vs warn. A request that never
 * completed is a **fail** — the integration is broken. A request that completed
 * and came back permissive is a **warn** — it works, and the policy is the
 * thing to look at. Collapsing the two in either direction makes the result
 * useless: all-fail cries wolf on a monitor-mode project, all-warn hides a dead
 * API key.
 *
 * These drive the real client through a stubbed `fetch`, so the error mapping
 * under test is the one that actually runs in production rather than a mock of
 * it.
 */

import { verify } from "../src/verify"

const originalFetch = global.fetch

jest.mock("../src/auto", () => ({
  instrumentationReport: jest.fn(() => ({
    patched: ["openai"],
    detectedUnpatched: [],
    adviceUrl: "https://x.test",
  })),
}))

import { instrumentationReport } from "../src/auto"

const mockedReport = instrumentationReport as jest.MockedFunction<typeof instrumentationReport>

const OPTS = { apiKey: "pg_live_test", baseUrl: "https://api.example.test/api/v1" }

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
    body: { cancel: async () => {} },
  }
}

/** Route by URL so scan and redact can be answered independently. */
function routeFetch(handlers: { scan?: () => unknown; redact?: () => unknown }): jest.Mock {
  return jest.fn(async (url: string) => {
    if (url.includes("/security/scan")) {
      const r = handlers.scan?.()
      if (r instanceof Error) throw r
      return r ?? jsonResponse({ blocked: true })
    }
    if (url.includes("/security/redact")) {
      const r = handlers.redact?.()
      if (r instanceof Error) throw r
      return r ?? jsonResponse({ piiFound: ["email", "ssn"] })
    }
    throw new Error(`unexpected request to ${url}`)
  }) as unknown as jest.Mock
}

function statusOf(report: Awaited<ReturnType<typeof verify>>, name: string) {
  return report.checks.find((c) => c.name === name)?.status
}

afterEach(() => {
  global.fetch = originalFetch
  mockedReport.mockReturnValue({
    patched: ["openai"],
    detectedUnpatched: [],
    adviceUrl: "https://x.test",
  })
})

describe("a healthy integration", () => {
  it("reports ok with every check passing", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(report.ok).toBe(true)
    expect(report.checksFailed).toBe(0)
    expect(statusOf(report, "connectivity")).toBe("pass")
    expect(statusOf(report, "authentication")).toBe("pass")
    expect(statusOf(report, "threat_detection")).toBe("pass")
    expect(statusOf(report, "pii_redaction")).toBe("pass")
  })

  it("names the URL that was actually called, not the one passed in", async () => {
    // The client appends `/proxy`; a report naming the input URL points the
    // reader at somewhere no request ever went.
    global.fetch = routeFetch({}) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(report.baseUrl).toBe("https://api.example.test/api/v1/proxy")
    expect(report.sdkVersion).toBeTruthy()
  })
})

describe("a broken integration", () => {
  it("fails on a rejected API key without blaming the network", async () => {
    global.fetch = routeFetch({
      scan: () => jsonResponse({ error: { message: "Invalid API key" } }, 401),
    }) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(report.ok).toBe(false)
    expect(statusOf(report, "authentication")).toBe("fail")
    // The host answered — it answered 401 — so connectivity is fine, and
    // saying otherwise sends someone to debug a network that works.
    expect(statusOf(report, "connectivity")).toBe("pass")
  })

  it("fails every dependent check when the host never answers", async () => {
    global.fetch = routeFetch({
      scan: () => new TypeError("fetch failed"),
    }) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(report.ok).toBe(false)
    expect(statusOf(report, "connectivity")).toBe("fail")
    expect(statusOf(report, "authentication")).toBe("fail")
    expect(statusOf(report, "threat_detection")).toBe("fail")
    // Reported as not attempted rather than quietly passing.
    expect(statusOf(report, "pii_redaction")).toBe("fail")
  })

  it("does not reject when the scan returns a 2xx with a null body", async () => {
    // A proxy or gateway in front of the Guard API can answer 200 with `null`.
    // Dereferencing that would throw out of verify(), which is documented never
    // to reject for a failed check — so a CI step would die instead of report.
    global.fetch = routeFetch({
      scan: () => jsonResponse(null),
    }) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(statusOf(report, "threat_detection")).toBe("warn")
    expect(statusOf(report, "connectivity")).toBe("pass")
  })

  it("keeps a good scan result when only redaction fails", async () => {
    global.fetch = routeFetch({
      redact: () => jsonResponse({ error: { message: "boom" } }, 500),
    }) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(report.ok).toBe(false)
    expect(statusOf(report, "pii_redaction")).toBe("fail")
    expect(statusOf(report, "threat_detection")).toBe("pass")
  })
})

describe("a permissive policy", () => {
  it("warns on an unblocked injection without clearing ok", async () => {
    global.fetch = routeFetch({
      scan: () => jsonResponse({ blocked: false }),
    }) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(statusOf(report, "threat_detection")).toBe("warn")
    expect(report.checksWarned).toBeGreaterThanOrEqual(1)
    // Monitor-mode projects legitimately do not block. Failing here would make
    // verify() unusable for them, and a check people must ignore is a check
    // they stop reading.
    expect(report.ok).toBe(true)
  })

  it("warns when the PII probe comes back clean", async () => {
    global.fetch = routeFetch({
      redact: () => jsonResponse({ piiFound: [] }),
    }) as unknown as typeof fetch

    expect(statusOf(await verify(OPTS), "pii_redaction")).toBe("warn")
  })

  it("does not read a missing piiFound key as success", async () => {
    // Guards the field name: `piiFound` is camelCase on the wire, and spelling
    // it `pii_found` would warn on every healthy integration instead — the same
    // silent wrongness this module exists to prevent.
    global.fetch = routeFetch({
      redact: () => jsonResponse({ redacted: "..." }),
    }) as unknown as typeof fetch

    expect(statusOf(await verify(OPTS), "pii_redaction")).toBe("warn")
  })
})

describe("the instrumentation check", () => {
  it("names an installed but unhooked provider", async () => {
    mockedReport.mockReturnValue({
      patched: ["openai"],
      detectedUnpatched: ["@google/genai"],
      adviceUrl: "https://x.test",
    })
    global.fetch = routeFetch({}) as unknown as typeof fetch

    const report = await verify(OPTS)
    const check = report.checks.find((c) => c.name === "instrumentation")

    expect(check?.status).toBe("warn")
    expect(check?.detail).toContain("@google/genai")
  })

  it("warns but does not fail when nothing is patched", async () => {
    // The native-ESM case, and the proxy-client case. One of those is a
    // problem and the other is normal, so this cannot be a failure — but it
    // must not be silent either.
    mockedReport.mockReturnValue({
      patched: [],
      detectedUnpatched: [],
      adviceUrl: "https://x.test",
    })
    global.fetch = routeFetch({}) as unknown as typeof fetch

    const report = await verify(OPTS)

    expect(statusOf(report, "instrumentation")).toBe("warn")
    expect(report.ok).toBe(true)
  })
})

describe("caller errors", () => {
  it("throws on a missing API key rather than reporting a failed check", async () => {
    const previous = process.env.PROMPTGUARD_API_KEY
    delete process.env.PROMPTGUARD_API_KEY
    try {
      await expect(verify({ baseUrl: OPTS.baseUrl })).rejects.toThrow(/API key required/)
    } finally {
      if (previous !== undefined) process.env.PROMPTGUARD_API_KEY = previous
    }
  })
})

describe("diagnostic retry defaults", () => {
  it("does not ride out the client's full backoff schedule", async () => {
    // The client retries 3 times with 1s/2s/4s backoff. Inheriting that would
    // make a dead host take ~7s to report, so verify() retries once.
    const fetchMock = routeFetch({ scan: () => new TypeError("fetch failed") })
    global.fetch = fetchMock as unknown as typeof fetch

    const started = Date.now()
    await verify(OPTS)

    // 1 initial attempt + 1 retry for scan; redaction is skipped when the host
    // is unreachable.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
