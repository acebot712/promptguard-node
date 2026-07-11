/**
 * Guard client - calls the PromptGuard Guard API for content scanning.
 *
 * Used internally by auto-instrumentation patches and framework
 * integrations.  Sends messages to POST /api/v1/guard and returns
 * the decision (allow / block / redact).
 */

import { buildRequestUrl } from "./client"
import { DEFAULT_BASE_URL } from "./resolve"
import {
  computeRetryDelayMs,
  isRetryableNetworkError,
  parseRetryAfterMs,
  RETRYABLE_STATUS_CODES,
} from "./retry"
import { SDK_VERSION } from "./version"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardMessage {
  role: string
  content: string
}

export interface GuardContext {
  framework?: string
  /** Chain/pipeline name (camelCase, preferred). */
  chainName?: string
  /** Agent identifier (camelCase, preferred). */
  agentId?: string
  /** Session identifier (camelCase, preferred). */
  sessionId?: string
  /** Tool-call records for this turn (camelCase, preferred). */
  toolCalls?: Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
  /** @deprecated snake_case alias for `chainName`; kept for back-compat. */
  chain_name?: string
  /** @deprecated snake_case alias for `agentId`; kept for back-compat. */
  agent_id?: string
  /** @deprecated snake_case alias for `sessionId`; kept for back-compat. */
  session_id?: string
  /** @deprecated snake_case alias for `toolCalls`; kept for back-compat. */
  tool_calls?: Array<Record<string, unknown>>
}

/** Wire-format context (snake_case) sent in the request body. */
export interface GuardContextWire {
  framework?: string
  chain_name?: string
  agent_id?: string
  session_id?: string
  tool_calls?: Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
}

/**
 * Normalize a public {@link GuardContext} (camelCase, with deprecated
 * snake_case aliases) into the snake_case wire shape. camelCase fields win
 * over their deprecated snake_case aliases; only defined fields are emitted so
 * the serialized body carries no camelCase keys and no explicit `undefined`s.
 */
export function serializeGuardContext(context: GuardContext): GuardContextWire {
  const wire: GuardContextWire = {}
  if (context.framework !== undefined) wire.framework = context.framework
  const chainName = context.chainName ?? context.chain_name
  if (chainName !== undefined) wire.chain_name = chainName
  const agentId = context.agentId ?? context.agent_id
  if (agentId !== undefined) wire.agent_id = agentId
  const sessionId = context.sessionId ?? context.session_id
  if (sessionId !== undefined) wire.session_id = sessionId
  const toolCalls = context.toolCalls ?? context.tool_calls
  if (toolCalls !== undefined) wire.tool_calls = toolCalls
  if (context.metadata !== undefined) wire.metadata = context.metadata
  return wire
}

export interface GuardRequestBody {
  messages: GuardMessage[]
  direction: "input" | "output"
  model?: string
  context?: GuardContextWire
}

/** Options-object form for {@link GuardClient.scan}. */
export interface ScanOptions {
  direction?: "input" | "output"
  model?: string
  context?: GuardContext
}

export interface ThreatDetail {
  type: string
  confidence: number
  details: string
}

export interface GuardResponseBody {
  decision: "allow" | "block" | "redact"
  event_id: string
  confidence: number
  threat_type?: string
  redacted_messages?: GuardMessage[]
  threats: ThreatDetail[]
  latency_ms: number
}

// ---------------------------------------------------------------------------
// GuardDecision - immutable result object
// ---------------------------------------------------------------------------

const VALID_DECISIONS = new Set(["allow", "block", "redact"])

export class GuardDecision {
  readonly decision: string
  readonly eventId: string
  readonly confidence: number
  readonly threatType?: string
  readonly redactedMessages?: GuardMessage[]
  readonly threats: ThreatDetail[]
  readonly latencyMs: number

  /**
   * @throws {GuardApiError} when `data.decision` is missing or not one of
   *   `allow` / `block` / `redact`. A malformed body must never silently
   *   default to "allow" — surfacing it as a {@link GuardApiError} lets the
   *   caller's explicit `failOpen` policy govern instead.
   */
  constructor(data: Partial<GuardResponseBody>) {
    if (typeof data?.decision !== "string" || !VALID_DECISIONS.has(data.decision)) {
      throw new GuardApiError(
        `Guard API returned invalid decision: ${String(JSON.stringify(data?.decision)).slice(0, 50)}`,
      )
    }
    this.decision = data.decision
    this.eventId = data.event_id ?? ""
    this.confidence = data.confidence ?? 0
    this.threatType = data.threat_type
    this.redactedMessages = data.redacted_messages
    this.threats = data.threats ?? []
    this.latencyMs = data.latency_ms ?? 0
  }

  get blocked(): boolean {
    return this.decision === "block"
  }
  get redacted(): boolean {
    return this.decision === "redact"
  }
  get allowed(): boolean {
    return this.decision === "allow"
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GuardApiError extends Error {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = "GuardApiError"
    this.statusCode = statusCode
  }

  /**
   * A content-free description safe to write to logs.
   *
   * The `.message` of a {@link GuardApiError} may embed the raw Guard API
   * response body (see {@link GuardClient.scan}), which can echo prompt
   * content. Loggers must use this instead of `.message` so they never
   * leak prompt content, response bodies, or the API key.
   */
  safeDescription(): string {
    return this.statusCode !== undefined
      ? `Guard API error (HTTP ${this.statusCode})`
      : "Guard API unreachable (network error)"
  }
}

/**
 * Return a log-safe description for an error caught on the fail-open path.
 *
 * For a {@link GuardApiError} this emits only HTTP status + a static message
 * (never the response body or prompt content). Any other error type is a real
 * bug that the fail-open paths re-throw before reaching here, so we fall back
 * to a generic label rather than risk logging arbitrary contents.
 */
export function safeErrorLabel(err: unknown): string {
  if (err instanceof GuardApiError) return err.safeDescription()
  return "unexpected error"
}

export class PromptGuardBlockedError extends Error {
  readonly decision: GuardDecision

  constructor(decision: GuardDecision) {
    const threat = decision.threatType ?? "policy_violation"
    super(
      `PromptGuard blocked this request: ${threat} ` +
        `(confidence=${decision.confidence.toFixed(2)}, event_id=${decision.eventId})`,
    )
    this.name = "PromptGuardBlockedError"
    this.decision = decision
  }
}

// ---------------------------------------------------------------------------
// GuardClient
// ---------------------------------------------------------------------------

export interface GuardClientConfig {
  apiKey: string
  baseUrl?: string
  timeout?: number
  /**
   * Number of retry attempts for transient Guard API failures
   * (network errors and 429/5xx responses). Default: `3`. Set to `0` for
   * strict at-most-once semantics. Retries never change the eventual
   * decision — after they are exhausted a {@link GuardApiError} is thrown so
   * the caller's `failOpen` policy governs, exactly as with no retries.
   */
  maxRetries?: number
  /** Base delay in ms between retries (exponential backoff). Default: `1000`. */
  retryDelay?: number
}

export class GuardClient {
  private readonly apiKey: string
  private readonly guardUrl: string
  private readonly timeout: number
  private readonly maxRetries: number
  private readonly retryDelay: number

  constructor(config: GuardClientConfig) {
    this.apiKey = config.apiKey
    // Splice /guard onto the URL path (not string concat) so a base URL
    // carrying a query string or fragment keeps it after the endpoint path.
    this.guardUrl = buildRequestUrl(config.baseUrl ?? DEFAULT_BASE_URL, "/guard")
    this.timeout = config.timeout ?? 10_000
    // Clamp to >= 0 so a negative value can never collapse the request loop.
    this.maxRetries = Math.max(0, config.maxRetries ?? 3)
    this.retryDelay = Math.max(0, config.retryDelay ?? 1000)
  }

  private headers(): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      "X-PromptGuard-SDK": "node-auto",
      "X-PromptGuard-Version": SDK_VERSION,
    }
  }

  /**
   * Scan messages via the Guard API.
   *
   * Throws {@link GuardApiError} on network/API errors so the caller
   * can decide whether to fail open or closed.
   *
   * Two call styles are supported:
   * ```ts
   * // Options object (preferred, matches the rest of the SDK):
   * await guard.scan(messages, { direction: "input", model: "gpt-5-nano" })
   * // Positional (back-compat):
   * await guard.scan(messages, "input", "gpt-5-nano")
   * ```
   */
  async scan(messages: GuardMessage[], options?: ScanOptions): Promise<GuardDecision>
  async scan(
    messages: GuardMessage[],
    direction?: "input" | "output",
    model?: string,
    context?: GuardContext,
  ): Promise<GuardDecision>
  async scan(
    messages: GuardMessage[],
    directionOrOptions: "input" | "output" | ScanOptions = "input",
    model?: string,
    context?: GuardContext,
  ): Promise<GuardDecision> {
    let direction: "input" | "output"
    if (typeof directionOrOptions === "object") {
      direction = directionOrOptions.direction ?? "input"
      model = directionOrOptions.model
      context = directionOrOptions.context
    } else {
      direction = directionOrOptions
    }

    const payload: GuardRequestBody = { messages, direction }
    if (model) payload.model = model
    // Normalize camelCase context (and deprecated snake_case aliases) into the
    // snake_case wire shape — the wire format stays snake_case regardless of
    // which field names the caller used.
    if (context) payload.context = serializeGuardContext(context)
    const serialized = JSON.stringify(payload)

    // Retry only transient failures (network errors, 429/5xx). Every terminal
    // outcome is still surfaced as a GuardApiError so the caller's `failOpen`
    // policy governs — retries never turn a would-be error into an allow, and
    // a block/redact decision (a successful 2xx) is never retried. This
    // preserves the exact enforcement semantics of the no-retry path.
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let resp: Response
      try {
        resp = await fetch(this.guardUrl, {
          method: "POST",
          headers: this.headers(),
          body: serialized,
          signal: AbortSignal.timeout(this.timeout),
        })
      } catch (err) {
        // Deterministic pre-flight failures can never succeed on retry;
        // only retry genuine transient network dispatch failures.
        if (isRetryableNetworkError(err) && attempt < this.maxRetries) {
          await this.sleep(computeRetryDelayMs(this.retryDelay, attempt))
          continue
        }
        throw new GuardApiError(
          `Guard API call failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      if (RETRYABLE_STATUS_CODES.has(resp.status) && attempt < this.maxRetries) {
        // Release the connection back to the keep-alive pool before retrying.
        await resp.body?.cancel().catch(() => {})
        const retryAfterMs = parseRetryAfterMs(resp.headers?.get?.("retry-after"))
        await this.sleep(computeRetryDelayMs(this.retryDelay, attempt, retryAfterMs))
        continue
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new GuardApiError(
          `Guard API returned ${resp.status}: ${text.slice(0, 200)}`,
          resp.status,
        )
      }

      // A 2xx with a malformed body must not escape as a raw SyntaxError —
      // wrap it in GuardApiError so the caller's failOpen policy governs. A
      // truncated 2xx body can be transient, so it is retried like other
      // transient failures before finally surfacing.
      let body: GuardResponseBody
      try {
        body = (await resp.json()) as GuardResponseBody
      } catch {
        if (attempt < this.maxRetries) {
          await this.sleep(computeRetryDelayMs(this.retryDelay, attempt))
          continue
        }
        throw new GuardApiError("invalid JSON in Guard response", resp.status)
      }
      // A valid 2xx body with an invalid `decision` is a definitive response,
      // not a transient failure — GuardDecision throws GuardApiError and we do
      // NOT retry it (mirrors the no-retry path).
      return new GuardDecision(body)
    }

    // Unreachable in practice: every loop exit above either returns or throws.
    throw new GuardApiError("Guard API unreachable after retries")
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
