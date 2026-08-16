/**
 * README "TypeScript Support" smoke test.
 *
 * The README advertises an `import type { ... } from 'promptguard-sdk'` block.
 * Every type it lists MUST be a public export or the snippet fails to compile
 * for users. ts-jest type-checks this file when the suite runs, so a missing
 * export here fails CI — keeping the README snippet honest.
 *
 * This mirrors the exact identifiers in README.md "TypeScript Support", plus
 * the other proxy/redteam types the SDK re-exports, and exercises the
 * proxy `Message` role union (finding 6: `tool` / `function`).
 */

import type {
  AutonomousRedTeamReport,
  AutonomousRedTeamRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  CheckStatus,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  GuardContext,
  GuardDecision,
  GuardMessage,
  InitOptions,
  IntelligenceStats,
  Message,
  PromptGuardConfig,
  RedactResult,
  RedTeamSummary,
  RedTeamTestResult,
  ScrapeResult,
  SecurityScanResult,
  ToolValidationResult,
  VerifyCheck,
  VerifyOptions,
  VerifyReport,
} from "../src/index"

describe("README TypeScript Support snippet", () => {
  test("every advertised type is a public export (compile-time)", () => {
    // The assignments below only need to type-check; if any imported name were
    // not exported, ts-jest would fail to compile this file. `satisfies`-style
    // typed locals keep biome's noUnusedVariables happy while exercising each
    // type in a value position.
    const scan: SecurityScanResult = { blocked: false, decision: "allow" }
    const redact: RedactResult = { original: "a", redacted: "a", piiFound: [] }
    const guardMsg: GuardMessage = { role: "user", content: "hi" }
    // camelCase request-side fields (README claims request options are camelCase).
    const ctx: GuardContext = {
      framework: "test",
      chainName: "chain",
      agentId: "agent",
      sessionId: "sess",
      toolCalls: [{ name: "lookup" }],
    }
    const init: InitOptions = { apiKey: "pg_test", maxRetries: 2, retryDelay: 100 }
    const checkStatus: CheckStatus = "warn"
    const verifyCheck: VerifyCheck = { name: "connectivity", status: checkStatus, detail: "" }
    const verifyOpts: VerifyOptions = { apiKey: "pg_test", maxRetries: 1 }
    const verifyReport: VerifyReport = {
      ok: true,
      checks: [verifyCheck],
      checksPassed: 1,
      checksFailed: 0,
      checksWarned: 0,
      instrumentation: { patched: [], detectedUnpatched: [], adviceUrl: "" },
      baseUrl: "",
      sdkVersion: "",
    }
    const cfg: PromptGuardConfig = { apiKey: "pg_test", maxRetries: 1 }
    const rtReq: AutonomousRedTeamRequest = { budget: 10 }
    const rtRep: AutonomousRedTeamReport = {
      grade: "A",
      bypassRate: 0,
      totalAttempts: 0,
      bypassesFound: 0,
      bypasses: [],
      recommendations: [],
    }
    const stats: IntelligenceStats = {
      totalPatterns: 0,
      byCategory: {},
      bySeverity: {},
      recentDiscoveries: 0,
    }
    const tool: ToolValidationResult = {
      allowed: true,
      riskScore: 0,
      riskLevel: "low",
      reason: "",
      warnings: [],
      blockedReasons: [],
    }
    const rtTest: RedTeamTestResult = {
      testName: "t",
      prompt: "p",
      decision: "allow",
      reason: "",
      confidence: 0,
      blocked: false,
      details: {},
    }
    const rtSummary: RedTeamSummary = {
      totalTests: 0,
      blocked: 0,
      allowed: 0,
      blockRate: 0,
      results: [],
    }
    const scrape: ScrapeResult = {
      url: "https://x",
      status: "safe",
      content: "",
      threatsDetected: [],
    }
    const embReq: EmbeddingRequest = { model: "m", input: "x" }
    const embResp: EmbeddingResponse = { object: "list", data: [], model: "m" }
    const compReq: CompletionRequest = { model: "m", prompt: "p" }
    const compResp: CompletionResponse = {
      id: "1",
      object: "text_completion",
      created: 0,
      model: "m",
      choices: [],
    }

    // Message role union must accept tool-calling roles (finding 6).
    const toolMsg: Message = { role: "tool", content: "result" }
    const fnMsg: Message = { role: "function", content: "result" }
    const chatReq: ChatCompletionRequest = {
      model: "gpt-5-nano",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        toolMsg,
        fnMsg,
      ],
    }
    const chatResp: ChatCompletionResponse = {
      id: "1",
      object: "chat.completion",
      created: 0,
      model: "gpt-5-nano",
      choices: [],
    }

    // A GuardDecision-typed local proves the type is importable (value class,
    // used here purely as a type annotation on a nullable local).
    const decision: GuardDecision | null = null

    expect(scan.decision).toBe("allow")
    expect(redact.piiFound).toEqual([])
    expect(guardMsg.role).toBe("user")
    expect(ctx.framework).toBe("test")
    expect(ctx.chainName).toBe("chain")
    expect(init.maxRetries).toBe(2)
    expect(cfg.maxRetries).toBe(1)
    expect(rtReq.budget).toBe(10)
    expect(rtRep.grade).toBe("A")
    expect(stats.totalPatterns).toBe(0)
    expect(tool.allowed).toBe(true)
    expect(rtTest.decision).toBe("allow")
    expect(rtSummary.totalTests).toBe(0)
    expect(scrape.status).toBe("safe")
    expect(embReq.model).toBe("m")
    expect(embResp.model).toBe("m")
    expect(compReq.model).toBe("m")
    expect(compResp.model).toBe("m")
    expect(toolMsg.role).toBe("tool")
    expect(fnMsg.role).toBe("function")
    expect(chatReq.messages).toHaveLength(5)
    expect(chatResp.model).toBe("gpt-5-nano")
    expect(decision).toBeNull()
    expect(verifyReport.ok).toBe(true)
    expect(verifyOpts.maxRetries).toBe(1)
  })
})
