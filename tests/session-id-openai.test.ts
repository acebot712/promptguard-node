/**
 * Auto-instrumentation sends an OpenAI Responses call's own `conversation` as
 * `session_id` — the same on every turn — and never `previous_response_id`,
 * which names the previous response and so changes every turn.
 *
 * The `openai` SDK is a virtual module here (it is an optional peer), and the
 * Guard API is faked at `fetch`.
 */

import { GuardClient } from "../src/guard"

class MockResponses {
  async create(_params: Record<string, unknown>) {
    return { output: [] }
  }
}

jest.mock("openai/resources/responses/responses", () => ({ Responses: MockResponses }), {
  virtual: true,
})
jest.mock("openai/resources/chat/completions", () => ({}), { virtual: true })

const mockGuard = new GuardClient({ apiKey: "pg_test", maxRetries: 0 })

jest.mock("../src/auto", () => ({
  getGuardClient: () => mockGuard,
  getMode: () => "enforce",
  isFailOpen: () => true,
  shouldScanResponses: () => false,
}))

import { apply, revert } from "../src/patches/openai"

const originalFetch = global.fetch
let fetchMock: jest.Mock

function sessionIds(): string[] {
  return fetchMock.mock.calls.map((call: unknown[]) => {
    const body = JSON.parse((call[1] as { body: string }).body)
    return body.context?.session_id ?? "<none>"
  })
}

beforeEach(() => {
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ decision: "allow", event_id: "e", confidence: 0, threats: [] }),
  }))
  global.fetch = fetchMock as unknown as typeof fetch
  expect(apply()).toBe(true)
})

afterEach(() => {
  revert()
  global.fetch = originalFetch
})

test("the Responses API's conversation names the session", async () => {
  const responses = new MockResponses()
  await responses.create({ model: "gpt-5-nano", input: "hello", conversation: "conv_a" })
  await responses.create({ model: "gpt-5-nano", input: "again", conversation: { id: "conv_a" } })
  await responses.create({ model: "gpt-5-nano", input: "hello", conversation: "conv_b" })

  expect(sessionIds()).toEqual(["conv_a", "conv_a", "conv_b"])
})

test("a call with no conversation sends no session id", async () => {
  const responses = new MockResponses()
  await responses.create({ model: "gpt-5-nano", input: "hello", previous_response_id: "resp_1" })

  expect(sessionIds()).toEqual(["<none>"])
})

test("an overlong conversation is dropped", async () => {
  await new MockResponses().create({
    model: "gpt-5-nano",
    input: "hi",
    conversation: "c".repeat(256),
  })

  expect(sessionIds()).toEqual(["<none>"])
})
