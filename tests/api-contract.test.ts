/**
 * Contract tests that validate the Node SDK against api-contract.json.
 *
 * These tests ensure error parsing, request field names, and response
 * field expectations stay in sync with the backend API.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { PromptGuard, PromptGuardError } from "../src/index"

interface ErrorCase {
  name: string
  status_code: number
  body: Record<string, unknown>
  expect: Record<string, unknown>
  expect_has_detail?: boolean
}

const CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, "api-contract.json"), "utf-8"))

function makeClient() {
  return new PromptGuard({
    apiKey: "pg_test_key",
    baseUrl: "https://test.promptguard.co",
    maxRetries: 0,
  })
}

// ── Error parsing ──────────────────────────────────────────────────────

describe("Error contract", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  const errorCases: ErrorCase[] = (CONTRACT.error_responses.cases as ErrorCase[]).filter(
    (c) => !c.expect_has_detail,
  )

  for (const tc of errorCases) {
    test(tc.name, async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: tc.status_code,
        json: () => Promise.resolve(tc.body),
      })

      const pg = makeClient()
      try {
        await pg.request("POST", "/test")
        throw new Error("Expected PromptGuardError")
      } catch (err) {
        expect(err).toBeInstanceOf(PromptGuardError)
        const e = err as PromptGuardError
        expect(e.statusCode).toBe(tc.status_code)
        expect(e.message).toContain(tc.expect.code as string)

        if (tc.expect.type) {
          expect(e.errorType).toBe(tc.expect.type)
        }
        if (tc.expect.upgrade_url) {
          expect(e.upgradeUrl).toBe(tc.expect.upgrade_url)
        }
        if (tc.expect.current_plan) {
          expect(e.currentPlan).toBe(tc.expect.current_plan)
        }
        if (tc.expect.requests_used !== undefined) {
          expect(e.requestsUsed).toBe(tc.expect.requests_used)
        }
        if (tc.expect.requests_limit !== undefined) {
          expect(e.requestsLimit).toBe(tc.expect.requests_limit)
        }
      }
    })
  }
})

// ── SDK headers ────────────────────────────────────────────────────────

describe("Header contract", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  test("sends required and recommended headers", async () => {
    let capturedHeaders: Record<string, string> = {}
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      capturedHeaders = { ...h }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    })

    const pg = makeClient()
    await pg.request("GET", "/test")

    for (const name of Object.keys(CONTRACT.sdk_headers.required_headers)) {
      expect(capturedHeaders[name]).toBeDefined()
    }
    for (const name of Object.keys(CONTRACT.sdk_headers.recommended_headers)) {
      expect(capturedHeaders[name]).toBeDefined()
    }
    expect(capturedHeaders["X-API-Key"]).toBe("pg_test_key")
  })
})

// ── Scan field contract ────────────────────────────────────────────────

describe("Scan contract", () => {
  test("request requires 'content', not 'text'", () => {
    const scan = CONTRACT.security_scan
    expect(scan.request_fields.required).toContain("content")
    expect(scan.request_fields.required).not.toContain("text")
  })

  test("response has required fields", () => {
    const required = new Set<string>(CONTRACT.security_scan.response_fields.required)
    for (const testCase of CONTRACT.security_scan.cases) {
      const keys = new Set(Object.keys(testCase.response))
      for (const field of required) {
        expect(keys.has(field)).toBe(true)
      }
    }
  })
})

// ── Redact field contract ──────────────────────────────────────────────

describe("Redact contract", () => {
  test("request requires 'content', not 'text'", () => {
    const redact = CONTRACT.security_redact
    expect(redact.request_fields.required).toContain("content")
    expect(redact.request_fields.required).not.toContain("text")
  })

  test("response uses 'original', 'redacted', 'piiFound'", () => {
    const required: string[] = CONTRACT.security_redact.response_fields.required
    expect(required).toContain("original")
    expect(required).toContain("redacted")
    expect(required).toContain("piiFound")
  })
})
