/**
 * PromptGuard proxy client — OpenAI-compatible API with built-in
 * security scanning, retry logic, and namespace helpers.
 */

import { DEFAULT_BASE_URL, resolveCredentials } from "./resolve"
import { SDK_VERSION } from "./version"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PromptGuardConfig {
  apiKey: string
  baseUrl?: string
  timeout?: number
  maxRetries?: number
  retryDelay?: number
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

interface Message {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatCompletionRequest {
  model: string
  messages: Message[]
  temperature?: number
  /** Maximum tokens to generate. Serialized to the wire as `max_tokens`. */
  maxTokens?: number
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

interface ScrapeResult {
  url: string
  status: "safe" | "blocked"
  content: string
  threats_detected: string[]
  message?: string
}

interface ToolValidationResult {
  allowed: boolean
  risk_score: number
  risk_level: string
  reason: string
  warnings: string[]
  blocked_reasons: string[]
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
  /** Target preset to attack (camelCase, preferred). */
  targetPreset?: string
  /** Detectors to enable for the run (camelCase, preferred). */
  enabledDetectors?: string[]
  /** @deprecated snake_case alias for `targetPreset`; kept for back-compat. */
  target_preset?: string
  /** @deprecated snake_case alias for `enabledDetectors`; kept for back-compat. */
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

// ---------------------------------------------------------------------------
// Namespace classes
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])
const PROXY_BASE_URL = `${DEFAULT_BASE_URL}/proxy`

/**
 * Serialize camelCase SDK params to the wire format the server expects
 * (`maxTokens` → `max_tokens`), and reject options we cannot honor.
 *
 * Streaming is rejected explicitly: `request()` always parses the response
 * as a single JSON body, so `stream: true` would hang or retry the JSON
 * parse failure instead of streaming.
 */
function serializeCompletionParams(params: Record<string, unknown>): Record<string, unknown> {
  if (params.stream === true) {
    throw new PromptGuardError(
      "streaming not yet supported by the PromptGuard proxy client — remove `stream: true`",
      "streaming_not_supported",
      400,
    )
  }
  const { maxTokens, ...rest } = params
  if (maxTokens !== undefined) rest.max_tokens = maxTokens
  return rest
}

/**
 * Upper bound on a server-provided `Retry-After` delay. A hostile or
 * misconfigured server must not be able to park the client for hours.
 */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into a
 * delay in milliseconds, or `null` when absent/unparseable. Clamped to
 * {@link MAX_RETRY_AFTER_MS}.
 */
function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS)
  }
  return null
}

/**
 * Ensure the proxy base URL's path ends with `/proxy`.
 *
 * The proxy endpoints live under `/api/v1/proxy`. Users frequently set
 * `PROMPTGUARD_BASE_URL` (or pass `baseUrl`) to `.../api/v1` without the
 * `/proxy` suffix, which would route proxy requests to the wrong path.
 * Append it when missing so requests always land on the proxy.
 *
 * Uses `URL` parsing so a trailing slash, query string, or fragment is handled
 * correctly and the scheme/host/port/query/fragment are preserved exactly.
 */
export function ensureProxySuffix(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    // Not a parseable absolute URL — fall back to safe string handling so we
    // never throw from the constructor on an unusual but intended value.
    const trimmed = baseUrl.replace(/\/+$/, "")
    return trimmed.split("/").pop() === "proxy" ? trimmed : `${trimmed}/proxy`
  }
  // Strip a single trailing slash from the path so we operate on segments.
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  // Append /proxy only when the last path segment isn't already "proxy".
  url.pathname = path.split("/").pop() === "proxy" ? path : `${path}/proxy`
  return url.toString()
}

/**
 * Whether a fetch-level failure is worth retrying.
 *
 * Undici surfaces network dispatch failures as `TypeError("fetch failed")`
 * with a `cause`; aborts/timeouts carry the corresponding `name`. Everything
 * else thrown before or during dispatch (circular-JSON serialization,
 * invalid header values) is deterministic and retrying it just delays the
 * real error.
 */
const RETRYABLE_ERRNO = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
])
function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "AbortError" || err.name === "TimeoutError") return true
  // `Error.cause` needs lib es2022; this tsconfig targets earlier, so read it
  // through a structural cast.
  const cause = (err as Error & { cause?: unknown }).cause
  const code =
    (err as NodeJS.ErrnoException).code ?? (cause as NodeJS.ErrnoException | undefined)?.code
  if (code !== undefined && RETRYABLE_ERRNO.has(code)) return true
  return err instanceof TypeError && (cause !== undefined || err.message === "fetch failed")
}

/**
 * Join an endpoint path onto the configured base URL.
 *
 * Plain string concatenation broke base URLs carrying a query string or
 * fragment (which `ensureProxySuffix` deliberately preserves): the endpoint
 * path landed inside the query/fragment value and every namespaced call
 * routed to the wrong endpoint. Splice the path onto the URL's pathname so
 * the query/fragment stay where they belong.
 */
export function buildRequestUrl(baseUrl: string, path: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    // Not a parseable absolute URL — keep the historical concat behavior.
    return `${baseUrl}${path}`
  }
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  url.pathname = `${basePath}${path}`
  return url.toString()
}

class ChatCompletions {
  private client: PromptGuard
  constructor(client: PromptGuard) {
    this.client = client
  }
  async create(params: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.client.request<ChatCompletionResponse>(
      "POST",
      "/chat/completions",
      serializeCompletionParams(params),
    )
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
    return this.client.request<CompletionResponse>(
      "POST",
      "/completions",
      serializeCompletionParams(params),
    )
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
    return this.client.request<SecurityScanResult>("POST", "/security/scan", { content, type })
  }
  async redact(content: string, piiTypes?: string[]): Promise<RedactResult> {
    return this.client.request<RedactResult>("POST", "/security/redact", {
      content,
      pii_types: piiTypes,
    })
  }
}

class Scrape {
  private client: PromptGuard
  constructor(client: PromptGuard) {
    this.client = client
  }
  async url(
    url: string,
    options?: { renderJs?: boolean; extractText?: boolean; timeout?: number },
  ): Promise<ScrapeResult> {
    return this.client.request<ScrapeResult>("POST", "/scrape", {
      url,
      render_js: options?.renderJs ?? false,
      extract_text: options?.extractText ?? true,
      timeout: options?.timeout ?? 30,
    })
  }
  async batch(urls: string[], options?: Record<string, unknown>): Promise<{ job_id: string }> {
    return this.client.request("POST", "/scrape/batch", { urls, ...options })
  }
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
    // Encode so an id containing "/", "?", "#", or ".." cannot reroute the
    // authenticated request to a different endpoint.
    return this.client.request("GET", `/agent/${encodeURIComponent(agentId)}/stats`)
  }
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
    return this.client.request<RedTeamTestResult>(
      "POST",
      `${this.base}/test/${encodeURIComponent(testName)}`,
      {
        target_preset: targetPreset,
      },
    )
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
  async runAutonomous(options?: AutonomousRedTeamRequest): Promise<AutonomousRedTeamReport> {
    // Accept camelCase (preferred) with snake_case aliases for back-compat.
    const targetPreset = options?.targetPreset ?? options?.target_preset ?? "default"
    const enabledDetectors = options?.enabledDetectors ?? options?.enabled_detectors
    return this.client.request<AutonomousRedTeamReport>("POST", `${this.base}/autonomous`, {
      budget: options?.budget ?? 100,
      target_preset: targetPreset,
      ...(enabledDetectors && { enabled_detectors: enabledDetectors }),
    })
  }
  async intelligenceStats(): Promise<IntelligenceStats> {
    return this.client.request<IntelligenceStats>("GET", `${this.base}/intelligence/stats`)
  }
}

// ---------------------------------------------------------------------------
// PromptGuard client
// ---------------------------------------------------------------------------

export class PromptGuard {
  private config: Required<PromptGuardConfig>

  chat: Chat
  completions: Completions
  embeddings: Embeddings
  security: Security
  scrape: Scrape
  agent: Agent
  redteam: RedTeam

  constructor(config: PromptGuardConfig) {
    const { apiKey, baseUrl } = resolveCredentials(config.apiKey, config.baseUrl, PROXY_BASE_URL)

    this.config = {
      apiKey,
      baseUrl: ensureProxySuffix(baseUrl),
      timeout: config.timeout ?? 30000,
      // Clamp to >= 0 so a negative value can never collapse the request loop
      // to zero attempts (which would silently skip the security scan).
      maxRetries: Math.max(0, config.maxRetries ?? 3),
      retryDelay: Math.max(0, config.retryDelay ?? 1000),
    }

    this.chat = new Chat(this)
    this.completions = new Completions(this)
    this.embeddings = new Embeddings(this)
    this.security = new Security(this)
    this.scrape = new Scrape(this)
    this.agent = new Agent(this)
    this.redteam = new RedTeam(this)
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = buildRequestUrl(this.config.baseUrl, path)
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            "X-API-Key": this.config.apiKey,
            "Content-Type": "application/json",
            "X-PromptGuard-SDK": "node",
            "X-PromptGuard-Version": SDK_VERSION,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.config.timeout),
        })

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.config.maxRetries) {
          // Consume the body so undici can release the connection back to
          // the keep-alive pool instead of leaking it per retried attempt.
          await response.body?.cancel().catch(() => {})
          // Honor Retry-After when the server provides one; otherwise use
          // exponential backoff. Add small jitter to avoid thundering herds.
          const backoff = this.config.retryDelay * 2 ** attempt
          const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
          const delay = retryAfterMs ?? backoff
          await new Promise((r) => setTimeout(r, delay + Math.random() * 0.25 * backoff))
          continue
        }

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: {
              message?: string
              code?: string
              type?: string
              upgrade_url?: string
              current_plan?: string
              requests_used?: number
              requests_limit?: number
            }
          }
          const err = errorBody.error
          throw new PromptGuardError(
            err?.message || "Request failed",
            err?.code || "UNKNOWN",
            response.status,
            {
              type: err?.type,
              upgradeUrl: err?.upgrade_url,
              currentPlan: err?.current_plan,
              requestsUsed: err?.requests_used,
              requestsLimit: err?.requests_limit,
            },
          )
        }

        try {
          return (await response.json()) as T
        } catch {
          // A 2xx with an unparseable body may be transient (truncation), so
          // it stays retryable — but it must never surface as a raw
          // SyntaxError. Wrap it so the terminal failure is a typed error.
          lastError = new PromptGuardError(
            "invalid JSON in response body",
            "INVALID_RESPONSE_BODY",
            response.status,
          )
          if (attempt < this.config.maxRetries) {
            const backoff = this.config.retryDelay * 2 ** attempt
            await new Promise((r) => setTimeout(r, backoff + Math.random() * 0.25 * backoff))
            continue
          }
          throw lastError
        }
      } catch (err) {
        if (err instanceof PromptGuardError) throw err
        // Deterministic pre-flight failures (circular JSON body, invalid
        // header value) can never succeed on retry — surface them
        // immediately instead of burning the full backoff schedule.
        if (!isRetryableNetworkError(err)) throw err
        lastError = err as Error
        if (attempt < this.config.maxRetries) {
          // Mirror the status-code retry path: exponential backoff plus
          // jitter so concurrent clients don't retry in lockstep.
          const backoff = this.config.retryDelay * 2 ** attempt
          await new Promise((r) => setTimeout(r, backoff + Math.random() * 0.25 * backoff))
        }
      }
    }

    throw lastError ?? new PromptGuardError("Max retries exceeded", "MAX_RETRIES", 0)
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PromptGuardError extends Error {
  code: string
  statusCode: number
  errorType?: string
  upgradeUrl?: string
  currentPlan?: string
  requestsUsed?: number
  requestsLimit?: number

  constructor(
    message: string,
    code: string,
    statusCode: number,
    extra?: {
      type?: string
      upgradeUrl?: string
      currentPlan?: string
      requestsUsed?: number
      requestsLimit?: number
    },
  ) {
    super(`${code}: ${message}`)
    this.name = "PromptGuardError"
    this.code = code
    this.statusCode = statusCode
    this.errorType = extra?.type
    this.upgradeUrl = extra?.upgradeUrl
    this.currentPlan = extra?.currentPlan
    this.requestsUsed = extra?.requestsUsed
    this.requestsLimit = extra?.requestsLimit
  }
}

export default PromptGuard
