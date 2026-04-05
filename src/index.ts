/**
 * PromptGuard Node.js SDK
 *
 * Drop-in security for AI applications.
 *
 * **Option 1 - Auto-instrumentation (recommended)**
 * @example
 * ```ts
 * import { init } from 'promptguard-sdk';
 * init({ apiKey: 'pg_xxx' });
 * // All LLM calls are now secured automatically.
 * ```
 *
 * **Option 2 - Proxy mode**
 * @example
 * ```ts
 * import { PromptGuard } from 'promptguard-sdk';
 * const pg = new PromptGuard({ apiKey: 'pg_xxx' });
 * const response = await pg.chat.completions.create({ ... });
 * ```
 *
 * **Option 3 - Framework integrations**
 * @example
 * ```ts
 * import { PromptGuardCallbackHandler } from 'promptguard-sdk/integrations/langchain';
 * import { promptGuardMiddleware } from 'promptguard-sdk/integrations/vercel-ai';
 * ```
 */

// Auto-instrumentation
export { type InitOptions, init, shutdown } from "./auto"
// Guard client (standalone scanning)
export {
  GuardApiError,
  GuardClient,
  type GuardClientConfig,
  type GuardContext,
  GuardDecision,
  type GuardMessage,
  type GuardRequestBody,
  type GuardResponseBody,
  PromptGuardBlockedError,
  type ThreatDetail,
} from "./guard"

// Framework integrations (re-exported for convenience)
export { PromptGuardCallbackHandler } from "./integrations/langchain"
export { promptGuardMiddleware } from "./integrations/vercel-ai"

interface PromptGuardConfig {
  apiKey: string
  baseUrl?: string
  timeout?: number
  maxRetries?: number
  retryDelay?: number
}

interface Message {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatCompletionRequest {
  model: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  [key: string]: unknown
}

interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: Message
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface SecurityScanResult {
  blocked: boolean
  decision: "allow" | "block" | "redact"
  reason?: string
  threatType?: string
  confidence?: number
}

interface RedactResult {
  original: string
  redacted: string
  piiFound: string[]
}

interface CompletionRequest {
  model: string
  prompt: string
  temperature?: number
  maxTokens?: number
  [key: string]: unknown
}

interface CompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    text: string
    index: number
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface EmbeddingRequest {
  model: string
  input: string | string[]
  [key: string]: unknown
}

interface EmbeddingResponse {
  object: string
  data: Array<{
    object: string
    embedding: number[]
    index: number
  }>
  model: string
  usage?: {
    prompt_tokens: number
    total_tokens: number
  }
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

class ChatCompletions {
  private client: PromptGuard

  constructor(client: PromptGuard) {
    this.client = client
  }

  async create(params: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.client.request<ChatCompletionResponse>("POST", "/chat/completions", params)
  }
}

class Chat {
  completions: ChatCompletions

  constructor(client: PromptGuard) {
    this.completions = new ChatCompletions(client)
  }
}

class Completions {
  private client: PromptGuard

  constructor(client: PromptGuard) {
    this.client = client
  }

  async create(params: CompletionRequest): Promise<CompletionResponse> {
    return this.client.request<CompletionResponse>("POST", "/completions", params)
  }
}

class Embeddings {
  private client: PromptGuard

  constructor(client: PromptGuard) {
    this.client = client
  }

  async create(params: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.client.request<EmbeddingResponse>("POST", "/embeddings", params)
  }
}

class Security {
  private client: PromptGuard

  constructor(client: PromptGuard) {
    this.client = client
  }

  async scan(content: string, type: "prompt" | "response" = "prompt"): Promise<SecurityScanResult> {
    return this.client.request<SecurityScanResult>("POST", "/security/scan", {
      content,
      type,
    })
  }

  async redact(content: string, piiTypes?: string[]): Promise<RedactResult> {
    return this.client.request<RedactResult>("POST", "/security/redact", {
      content,
      pii_types: piiTypes,
    })
  }
}

interface ScrapeResult {
  url: string
  status: "safe" | "blocked"
  content: string
  threats_detected: string[]
  message?: string
}

class Scrape {
  private client: PromptGuard

  constructor(client: PromptGuard) {
    this.client = client
  }

  async url(
    url: string,
    options?: {
      renderJs?: boolean
      extractText?: boolean
      timeout?: number
    },
  ): Promise<ScrapeResult> {
    return this.client.request<ScrapeResult>("POST", "/scrape", {
      url,
      render_js: options?.renderJs ?? false,
      extract_text: options?.extractText ?? true,
      timeout: options?.timeout ?? 30,
    })
  }

  async batch(urls: string[], options?: Record<string, unknown>): Promise<{ job_id: string }> {
    return this.client.request("POST", "/scrape/batch", {
      urls,
      ...options,
    })
  }
}

interface ToolValidationResult {
  allowed: boolean
  risk_score: number
  risk_level: string
  reason: string
  warnings: string[]
  blocked_reasons: string[]
}

class Agent {
  private client: PromptGuard

  constructor(client: PromptGuard) {
    this.client = client
  }

  async validateTool(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<ToolValidationResult> {
    return this.client.request<ToolValidationResult>("POST", "/agent/validate-tool", {
      agent_id: agentId,
      tool_name: toolName,
      arguments: args,
      session_id: sessionId,
    })
  }

  async stats(agentId: string): Promise<Record<string, unknown>> {
    return this.client.request("GET", `/agent/${agentId}/stats`)
  }
}

interface RedTeamTestResult {
  test_name: string
  prompt: string
  decision: string
  reason: string
  threat_type?: string
  confidence: number
  blocked: boolean
  details: Record<string, unknown>
}

interface RedTeamSummary {
  total_tests: number
  blocked: number
  allowed: number
  block_rate: number
  results: RedTeamTestResult[]
}

interface AutonomousRedTeamRequest {
  budget?: number
  target_preset?: string
  enabled_detectors?: string[]
}

interface AutonomousRedTeamReport {
  grade: string
  bypass_rate: number
  total_attempts: number
  bypasses_found: number
  bypasses: Array<Record<string, unknown>>
  recommendations: string[]
}

interface IntelligenceStats {
  total_patterns: number
  by_category: Record<string, number>
  by_severity: Record<string, number>
  recent_discoveries: number
}

class RedTeam {
  private client: PromptGuard
  private base = "/internal/redteam"

  constructor(client: PromptGuard) {
    this.client = client
  }

  async listTests(): Promise<{ total: number; tests: Array<Record<string, unknown>> }> {
    return this.client.request("GET", `${this.base}/tests`)
  }

  async runTest(testName: string, targetPreset = "default"): Promise<RedTeamTestResult> {
    return this.client.request<RedTeamTestResult>("POST", `${this.base}/test/${testName}`, {
      target_preset: targetPreset,
    })
  }

  async runAll(targetPreset = "default"): Promise<RedTeamSummary> {
    return this.client.request<RedTeamSummary>("POST", `${this.base}/test-all`, {
      target_preset: targetPreset,
    })
  }

  async runCustom(prompt: string, targetPreset = "default"): Promise<RedTeamTestResult> {
    return this.client.request<RedTeamTestResult>("POST", `${this.base}/test-custom`, {
      custom_prompt: prompt,
      target_preset: targetPreset,
    })
  }

  /**
   * Run the autonomous red team agent.
   *
   * Uses LLM-powered mutation to discover novel attack vectors
   * that bypass the current policy configuration.
   */
  async runAutonomous(options?: AutonomousRedTeamRequest): Promise<AutonomousRedTeamReport> {
    return this.client.request<AutonomousRedTeamReport>("POST", `${this.base}/autonomous`, {
      budget: options?.budget ?? 100,
      target_preset: options?.target_preset ?? "default",
      ...(options?.enabled_detectors && { enabled_detectors: options.enabled_detectors }),
    })
  }

  /** Get statistics from the Attack Intelligence DB. */
  async intelligenceStats(): Promise<IntelligenceStats> {
    return this.client.request<IntelligenceStats>("GET", `${this.base}/intelligence/stats`)
  }
}

export class PromptGuard {
  private config: Required<PromptGuardConfig>

  // OpenAI-compatible APIs
  chat: Chat
  completions: Completions
  embeddings: Embeddings

  // PromptGuard-specific APIs
  security: Security
  scrape: Scrape
  agent: Agent
  redteam: RedTeam

  constructor(config: PromptGuardConfig) {
    const apiKey = config.apiKey ?? process.env.PROMPTGUARD_API_KEY

    if (!apiKey) {
      throw new Error(
        "API key required. Pass apiKey in config or set PROMPTGUARD_API_KEY environment variable.",
      )
    }

    this.config = {
      apiKey,
      baseUrl:
        config.baseUrl ??
        process.env.PROMPTGUARD_BASE_URL ??
        "https://api.promptguard.co/api/v1/proxy",
      timeout: config.timeout ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    }

    // OpenAI-compatible
    this.chat = new Chat(this)
    this.completions = new Completions(this)
    this.embeddings = new Embeddings(this)

    // PromptGuard-specific
    this.security = new Security(this)
    this.scrape = new Scrape(this)
    this.agent = new Agent(this)
    this.redteam = new RedTeam(this)
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-PromptGuard-SDK": "node",
            "X-PromptGuard-Version": "1.5.2",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.config.timeout),
        })

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, this.config.retryDelay * 2 ** attempt))
          continue
        }

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: { message?: string; code?: string }
          }
          throw new PromptGuardError(
            errorBody.error?.message || "Request failed",
            errorBody.error?.code || "UNKNOWN",
            response.status,
          )
        }

        return response.json() as Promise<T>
      } catch (err) {
        if (err instanceof PromptGuardError) throw err
        lastError = err as Error
        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, this.config.retryDelay * 2 ** attempt))
        }
      }
    }

    throw lastError ?? new PromptGuardError("Max retries exceeded", "MAX_RETRIES", 0)
  }
}

export class PromptGuardError extends Error {
  code: string
  statusCode: number

  constructor(message: string, code: string, statusCode: number) {
    super(`${code}: ${message}`)
    this.name = "PromptGuardError"
    this.code = code
    this.statusCode = statusCode
  }
}

export default PromptGuard
