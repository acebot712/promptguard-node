/**
 * Guard client - calls the PromptGuard Guard API for content scanning.
 *
 * Used internally by auto-instrumentation patches and framework
 * integrations.  Sends messages to POST /api/v1/guard and returns
 * the decision (allow / block / redact).
 */

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

export class GuardDecision {
  readonly decision: string
  readonly eventId: string
  readonly confidence: number
  readonly threatType?: string
  readonly redactedMessages?: GuardMessage[]
  readonly threats: ThreatDetail[]
  readonly latencyMs: number

  constructor(data: Partial<GuardResponseBody>) {
    this.decision = data.decision ?? "allow"
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
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.guardUrl = `${base}/guard`
    this.timeout = config.timeout ?? 10_000
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
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
   */
  async scan(
    messages: GuardMessage[],
    direction: "input" | "output" = "input",
    model?: string,
    context?: GuardContext,
  ): Promise<GuardDecision> {
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

    const body = (await resp.json()) as GuardResponseBody
    return new GuardDecision(body)
  }
}
