/**
 * PromptGuard proxy client — OpenAI-compatible API with built-in
 * security scanning, retry logic, and namespace helpers.
 */

import { DEFAULT_BASE_URL, resolveCredentials } from "./resolve"
import {
  computeRetryDelayMs,
  isRetryableNetworkError,
  parseRetryAfterMs,
  RETRYABLE_STATUS_CODES,
} from "./retry"
import { SDK_VERSION } from "./version"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PromptGuardConfig {
  apiKey: string
  /**
   * API base URL. Defaults to the public PromptGuard proxy
   * (`https://api.promptguard.co/api/v1/proxy`) or `PROMPTGUARD_BASE_URL`.
   * The `/proxy` suffix is appended automatically when missing.
   */
  baseUrl?: string
  /** HTTP timeout in milliseconds for each request attempt. Default: `30000`. */
  timeout?: number
  /**
   * Number of retry attempts for transient failures (network errors and
   * 429/5xx responses). Default: `3`. Set to `0` for strict at-most-once
   * semantics. Negative values are clamped to `0`.
   */
  maxRetries?: number
  /** Base delay in ms between retries (exponential backoff). Default: `1000`. */
  retryDelay?: number
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface Message {
  role: "system" | "user" | "assistant" | "tool" | "function"
  content: string
}

export interface ChatCompletionRequest {
  model: string
  messages: Message[]
  temperature?: number
  /** Maximum tokens to generate. Serialized to the wire as `max_tokens`. */
  maxTokens?: number
  /**
   * OpenAI-compatible escape hatch: any additional keys (e.g. `top_p`,
   * `frequency_penalty`, `stop`, `tools`) are forwarded verbatim to the proxy.
   * Because these keys are not type-checked, a misspelled parameter is silently
   * passed through rather than flagged at compile time — double-check the
   * spelling of options not listed above. (`stream: true` is the one key
   * rejected: the client parses a single JSON response body, so it throws at
   * runtime instead of forwarding.)
   */
  [key: string]: unknown
}

export interface ChatCompletionResponse {
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

export interface CompletionRequest {
  model: string
  prompt: string
  temperature?: number
  /** Maximum tokens to generate. Serialized to the wire as `max_tokens`. */
  maxTokens?: number
  /**
   * OpenAI-compatible escape hatch: any additional keys are forwarded verbatim
   * to the proxy. Because these keys are not type-checked, a misspelled
   * parameter is silently passed through rather than flagged at compile time.
   * (`stream: true` is rejected at runtime — the client parses a single JSON
   * response body.)
   */
  [key: string]: unknown
}

export interface CompletionResponse {
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

export interface EmbeddingRequest {
  model: string
  input: string | string[]
  /**
   * OpenAI-compatible escape hatch: any additional keys (e.g. `dimensions`,
   * `encoding_format`, `user`) are forwarded verbatim to the proxy. Because
   * these keys are not type-checked, a misspelled parameter is silently passed
   * through rather than flagged at compile time.
   */
  [key: string]: unknown
}

export interface EmbeddingResponse {
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

export interface SecurityScanResult {
  blocked: boolean
  decision: "allow" | "block" | "redact"
  reason?: string
  threatType?: string
  confidence?: number
}

export interface RedactResult {
  original: string
  redacted: string
  piiFound: string[]
}

export interface ScrapeResult {
  url: string
  status: "safe" | "blocked"
  content: string
  /** Normalized from the wire field `threats_detected`. */
  threatsDetected: string[]
  message?: string
}

export interface ToolValidationResult {
  allowed: boolean
  /** Normalized from the wire field `risk_score`. */
  riskScore: number
  /** Normalized from the wire field `risk_level`. */
  riskLevel: string
  reason: string
  warnings: string[]
  /** Normalized from the wire field `blocked_reasons`. */
  blockedReasons: string[]
}

export interface RedTeamTestResult {
  /** Normalized from the wire field `test_name`. */
  testName: string
  prompt: string
  decision: string
  reason: string
  /** Normalized from the wire field `threat_type`. */
  threatType?: string
  confidence: number
  blocked: boolean
  details: Record<string, unknown>
}

export interface RedTeamSummary {
  /** Normalized from the wire field `total_tests`. */
  totalTests: number
  blocked: number
  allowed: number
  /** Normalized from the wire field `block_rate`. */
  blockRate: number
  results: RedTeamTestResult[]
}

export interface AutonomousRedTeamRequest {
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

export interface AutonomousRedTeamReport {
  grade: string
  /** Normalized from the wire field `bypass_rate`. */
  bypassRate: number
  /** Normalized from the wire field `total_attempts`. */
  totalAttempts: number
  /** Normalized from the wire field `bypasses_found`. */
  bypassesFound: number
  bypasses: Array<Record<string, unknown>>
  recommendations: string[]
}

export interface IntelligenceStats {
  /** Normalized from the wire field `total_patterns`. */
  totalPatterns: number
  /** Normalized from the wire field `by_category`. */
  byCategory: Record<string, number>
  /** Normalized from the wire field `by_severity`. */
  bySeverity: Record<string, number>
  /** Normalized from the wire field `recent_discoveries`. */
  recentDiscoveries: number
}

// ---------------------------------------------------------------------------
// Wire response shapes (internal) + camelCase normalizers
// ---------------------------------------------------------------------------
//
// The server returns these bodies in snake_case. The SDK normalizes them to the
// camelCase exported types above so response-field casing is consistent
// SDK-wide (matching GuardDecision and SecurityScanResult). The wire format is
// unchanged — only the SDK-facing DTO is camelCased.

interface ScrapeResultWire {
  url: string
  status: "safe" | "blocked"
  content: string
  threats_detected?: string[]
  message?: string
}

interface ToolValidationResultWire {
  allowed: boolean
  risk_score: number
  risk_level: string
  reason: string
  warnings?: string[]
  blocked_reasons?: string[]
}

interface RedTeamTestResultWire {
  test_name: string
  prompt: string
  decision: string
  reason: string
  threat_type?: string
  confidence: number
  blocked: boolean
  details?: Record<string, unknown>
}

interface RedTeamSummaryWire {
  total_tests: number
  blocked: number
  allowed: number
  block_rate: number
  results?: RedTeamTestResultWire[]
}

interface AutonomousRedTeamReportWire {
  grade: string
  bypass_rate: number
  total_attempts: number
  bypasses_found: number
  bypasses?: Array<Record<string, unknown>>
  recommendations?: string[]
}

interface IntelligenceStatsWire {
  total_patterns: number
  by_category?: Record<string, number>
  by_severity?: Record<string, number>
  recent_discoveries: number
}

function toScrapeResult(w: ScrapeResultWire): ScrapeResult {
  return {
    url: w.url,
    status: w.status,
    content: w.content,
    threatsDetected: w.threats_detected ?? [],
    message: w.message,
  }
}

function toToolValidationResult(w: ToolValidationResultWire): ToolValidationResult {
  return {
    allowed: w.allowed,
    riskScore: w.risk_score,
    riskLevel: w.risk_level,
    reason: w.reason,
    warnings: w.warnings ?? [],
    blockedReasons: w.blocked_reasons ?? [],
  }
}

function toRedTeamTestResult(w: RedTeamTestResultWire): RedTeamTestResult {
  return {
    testName: w.test_name,
    prompt: w.prompt,
    decision: w.decision,
    reason: w.reason,
    threatType: w.threat_type,
    confidence: w.confidence,
    blocked: w.blocked,
    details: w.details ?? {},
  }
}

function toRedTeamSummary(w: RedTeamSummaryWire): RedTeamSummary {
  return {
    totalTests: w.total_tests,
    blocked: w.blocked,
    allowed: w.allowed,
    blockRate: w.block_rate,
    results: (w.results ?? []).map(toRedTeamTestResult),
  }
}

function toAutonomousRedTeamReport(w: AutonomousRedTeamReportWire): AutonomousRedTeamReport {
  return {
    grade: w.grade,
    bypassRate: w.bypass_rate,
    totalAttempts: w.total_attempts,
    bypassesFound: w.bypasses_found,
    bypasses: w.bypasses ?? [],
    recommendations: w.recommendations ?? [],
  }
}

function toIntelligenceStats(w: IntelligenceStatsWire): IntelligenceStats {
  return {
    totalPatterns: w.total_patterns,
    byCategory: w.by_category ?? {},
    bySeverity: w.by_severity ?? {},
    recentDiscoveries: w.recent_discoveries,
  }
}

// ---------------------------------------------------------------------------
// Namespace classes
// ---------------------------------------------------------------------------

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
    // Strip trailing slashes with a linear scan rather than a `/\/+$/` regex
    // (which CodeQL flags as polynomial ReDoS on many-slash input).
    let end = baseUrl.length
    while (end > 0 && baseUrl.charCodeAt(end - 1) === 47 /* "/" */) end--
    const trimmed = baseUrl.slice(0, end)
    return trimmed.split("/").pop() === "proxy" ? trimmed : `${trimmed}/proxy`
  }
  // Strip a single trailing slash from the path so we operate on segments.
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  // Append /proxy only when the last path segment isn't already "proxy".
  url.pathname = path.split("/").pop() === "proxy" ? path : `${path}/proxy`
  return url.toString()
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
    const raw = await this.client.request<ScrapeResultWire>("POST", "/scrape", {
      url,
      render_js: options?.renderJs ?? false,
      extract_text: options?.extractText ?? true,
      timeout: options?.timeout ?? 30,
    })
    return toScrapeResult(raw)
  }
  async batch(urls: string[], options?: Record<string, unknown>): Promise<{ jobId: string }> {
    // Normalize the wire field `job_id` → `jobId` so the scrape namespace is
    // camelCase throughout (consistent with `url()`'s ScrapeResult).
    const raw = await this.client.request<{ job_id: string }>("POST", "/scrape/batch", {
      urls,
      ...options,
    })
    return { jobId: raw.job_id }
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
    const raw = await this.client.request<ToolValidationResultWire>(
      "POST",
      "/agent/validate-tool",
      {
        agent_id: agentId,
        tool_name: toolName,
        arguments: args,
        session_id: sessionId,
      },
    )
    return toToolValidationResult(raw)
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
    const raw = await this.client.request<RedTeamTestResultWire>(
      "POST",
      `${this.base}/test/${encodeURIComponent(testName)}`,
      {
        target_preset: targetPreset,
      },
    )
    return toRedTeamTestResult(raw)
  }
  async runAll(targetPreset = "default"): Promise<RedTeamSummary> {
    const raw = await this.client.request<RedTeamSummaryWire>("POST", `${this.base}/test-all`, {
      target_preset: targetPreset,
    })
    return toRedTeamSummary(raw)
  }
  async runCustom(prompt: string, targetPreset = "default"): Promise<RedTeamTestResult> {
    const raw = await this.client.request<RedTeamTestResultWire>(
      "POST",
      `${this.base}/test-custom`,
      {
        custom_prompt: prompt,
        target_preset: targetPreset,
      },
    )
    return toRedTeamTestResult(raw)
  }
  async runAutonomous(options?: AutonomousRedTeamRequest): Promise<AutonomousRedTeamReport> {
    // Accept camelCase (preferred) with snake_case aliases for back-compat.
    const targetPreset = options?.targetPreset ?? options?.target_preset ?? "default"
    const enabledDetectors = options?.enabledDetectors ?? options?.enabled_detectors
    const raw = await this.client.request<AutonomousRedTeamReportWire>(
      "POST",
      `${this.base}/autonomous`,
      {
        budget: options?.budget ?? 100,
        target_preset: targetPreset,
        ...(enabledDetectors && { enabled_detectors: enabledDetectors }),
      },
    )
    return toAutonomousRedTeamReport(raw)
  }
  async intelligenceStats(): Promise<IntelligenceStats> {
    const raw = await this.client.request<IntelligenceStatsWire>(
      "GET",
      `${this.base}/intelligence/stats`,
    )
    return toIntelligenceStats(raw)
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

  /**
   * The base URL requests actually go to, after normalization.
   *
   * The constructor appends the `/proxy` suffix when it is missing, so this is
   * frequently not the string that was passed in. Anything reporting on the
   * client — `verify()`, a diagnostic, a support dump — has to name the URL
   * that was called rather than the one that was requested, or it points the
   * reader somewhere no request ever went.
   */
  get baseUrl(): string {
    return this.config.baseUrl
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
          const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
          const delay = computeRetryDelayMs(this.config.retryDelay, attempt, retryAfterMs)
          await new Promise((r) => setTimeout(r, delay))
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
            // Server-forwarded codes pass through verbatim; SDK-minted codes use
            // lower_snake_case (matching `missing_api_key` and the server style).
            err?.code || "unknown",
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
            "invalid_response_body",
            response.status,
          )
          if (attempt < this.config.maxRetries) {
            await new Promise((r) =>
              setTimeout(r, computeRetryDelayMs(this.config.retryDelay, attempt)),
            )
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
          await new Promise((r) =>
            setTimeout(r, computeRetryDelayMs(this.config.retryDelay, attempt)),
          )
        }
      }
    }

    throw lastError ?? new PromptGuardError("Max retries exceeded", "max_retries", 0)
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PromptGuardError extends Error {
  /**
   * Machine-readable error code. Server-forwarded codes pass through verbatim
   * (their own casing). Codes minted by the SDK itself use lower_snake_case:
   * `missing_api_key`, `streaming_not_supported`, `invalid_response_body`,
   * `max_retries`, and the fallback `unknown`.
   */
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
    // Keep the human-readable message clean; the machine-readable `code` is
    // exposed as a structured field (not prefixed onto `.message`).
    super(message)
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
