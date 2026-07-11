/**
 * Guard client - calls the PromptGuard Guard API for content scanning.
 *
 * Used internally by auto-instrumentation patches and framework
 * integrations.  Sends messages to POST /api/v1/guard and returns
 * the decision (allow / block / redact).
 */

import { buildRequestUrl } from "./client"
import { DEFAULT_BASE_URL } from "./resolve"
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
  chain_name?: string
  agent_id?: string
  session_id?: string
  tool_calls?: Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
}

export interface GuardRequestBody {
  messages: GuardMessage[]
  direction: "input" | "output"
  model?: string
  context?: GuardContext
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
}

export class GuardClient {
  private readonly apiKey: string
  private readonly guardUrl: string
  private readonly timeout: number

  constructor(config: GuardClientConfig) {
    this.apiKey = config.apiKey
    // Splice /guard onto the URL path (not string concat) so a base URL
    // carrying a query string or fragment keeps it after the endpoint path.
    this.guardUrl = buildRequestUrl(config.baseUrl ?? DEFAULT_BASE_URL, "/guard")
    this.timeout = config.timeout ?? 10_000
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
    if (context) payload.context = context

    let resp: Response
    try {
      resp = await fetch(this.guardUrl, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeout),
      })
    } catch (err) {
      throw new GuardApiError(
        `Guard API call failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      throw new GuardApiError(
        `Guard API returned ${resp.status}: ${text.slice(0, 200)}`,
        resp.status,
      )
    }

    // A 2xx with a malformed body must not escape as a raw SyntaxError —
    // wrap it in GuardApiError so the caller's failOpen policy governs.
    let body: GuardResponseBody
    try {
      body = (await resp.json()) as GuardResponseBody
    } catch {
      throw new GuardApiError("invalid JSON in Guard response", resp.status)
    }
    return new GuardDecision(body)
  }
}
