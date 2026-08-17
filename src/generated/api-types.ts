/**
 * Auto-generated from OpenAPI spec (v1.0.0).
 * DO NOT EDIT — regenerate with: npx ts-node scripts/generate-types-from-spec.ts
 *
 * These are type-only definitions. Custom client logic lives in src/guard.ts,
 * src/client.ts, src/patches/, and src/integrations/ — those files are never
 * modified by this generator.
 */

/* eslint-disable */
/** Content being written to, or read back from, an agent's memory. */
export interface AgentMemoryRequest {
  /** The memory chunk to scan */
  content: string
  /** 'write' before persisting a chunk, 'read' when a stored chunk is retrieved. Scan both: a chunk poisoned before this endpoint existed, or written through another path, is only catchable on read. */
  direction?: string
  /** Your identifier for the chunk */
  memory_id?: string | unknown
}

/** Verdict on one memory chunk. */
export interface AgentMemoryResponse {
  decision: string
  detected: boolean
  reason?: string
  confidence?: number
  match_type?: string | unknown
  content_hash?: string | unknown
  event_id: string
}

export interface AgentPoliciesResponse {
  policies: Array<developer__policies__router__AgentPolicy>
  total: number
}

/** Request to register a new agent identity. */
export interface AgentRegisterRequest {
  agent_name: string
  allowed_tools?: Array<string> | unknown
}

/** Response from agent registration — secret is shown only once. */
export interface AgentRegisterResponse {
  agent_id: string
  agent_name: string
  agent_secret: string
  credential_prefix: string
}

/** Response from credential rotation. */
export interface AgentRotateResponse {
  agent_id: string
  new_secret: string
  credential_prefix: string
  old_credential_revoked: boolean
}

/** Statistics for an agent */
export interface AgentStats {
  agent_id: string
  total_tool_calls: number
  blocked_calls: number
  avg_risk_score: number
  /** Always 0. Agent session state is not retained across requests; this field is deprecated and will be removed in the next API version. */
  active_sessions?: number
  anomalies_detected: number
}

/** Capability profile for one tool along the four lethal-trifecta axes. */
export interface AgentToolLabels {
  untrusted_content?: boolean
  private_data?: boolean
  public_sink?: boolean
  destructive?: boolean
}

/** One event of a full agent execution trace.

An event with a ``tool_name`` is a tool call: its ``arguments`` (a sink's
inputs) and ``output`` (a source of taint) drive the trace-level detectors.
Events without one are plain assistant / user turns, kept as context. */
export interface AgentTraceEvent {
  role?: string
  tool_name?: string | unknown
  arguments?: Record<string, unknown>
  output?: unknown
  content?: string
  thought?: string
}

/** A single detector hit, normalized across detectors. */
export interface AgentTraceFinding {
  detector: string
  code: string
  severity: string
  reason: string
  decision: string
  metadata?: Record<string, unknown>
}

/** A full agent execution trace to audit post-hoc.

Unlike ``/validate-tool`` (a pre-execution check of a single tool name +
args), this carries the whole chronological trace *with tool outputs* plus
the user's original objective, so the value-level dataflow-taint and
goal-alignment detectors can fire. */
export interface AgentTraceRequest {
  user_objective?: string
  events?: Array<AgentTraceEvent>
  tool_labels?: Record<string, unknown> | unknown
}

/** Aggregated verdict over the ingested trace. */
export interface AgentTraceResponse {
  decision: string
  findings?: Array<AgentTraceFinding>
  event_id: string
}

/** Response containing the full API key for copy functionality */
export interface ApiKeyFullResponse {
  id: string
  name: string
  prefix: string
  key: string
}

export interface ApiKeyResponse {
  id: string
  name: string
  prefix: string
  key?: string | unknown
  project_id: string | unknown
  project_name: string | unknown
  permissions: Array<string>
  is_active: boolean
  last_used_at: string | unknown
  expires_at?: string | unknown
  created_at: string
}

export interface AuthErrorEnvelope {
  error: ErrorDetail
}

/** A document retrieved by a RAG pipeline to be scanned for poisoning. */
export interface ContextDoc {
  /** Document text content */
  content: string
  /** Source identifier (URL, doc ID, etc.) */
  source?: string | unknown
  /** Extra metadata */
  metadata?: Record<string, unknown> | unknown
}

export interface CreateApiKeyRequest {
  /** API key name */
  name: string
  project_id?: string | unknown
  permissions?: Array<string>
  expires_at?: string | unknown
}

export interface CreateApiKeyResponse {
  key: string
  id: string
  name: string
  prefix: string
}

export interface CreateExceptionRequest {
  destination_host: string
  policy_id?: string | unknown
  threat?: string | unknown
  reason_category?: string | unknown
  justification?: string | unknown
  requested_minutes?: number
}

export interface CreateToolRequest {
  requested_host: string
  requested_name?: string | unknown
  justification?: string | unknown
}

/** Request to validate a tool call */
export interface developer__agent__router__ToolCallRequest {
  agent_id: string
  tool_name: string
  arguments: Record<string, unknown>
  session_id?: string | unknown
}

/** Response from tool call validation */
export interface developer__agent__router__ToolCallResponse {
  allowed: boolean
  risk_score: number
  risk_level: string
  reason: string
  warnings?: Array<string>
  blocked_reasons?: Array<string>
}

/** A single enforced rule, flattened for the agent UI. */
export interface developer__policies__router__AgentPolicy {
  id: string
  name: string
  description?: string | unknown
  action: string
  threat_types?: Array<string>
  priority?: number
}

export interface developer__projects__schemas__CreateProjectRequest {
  name: string
  description?: string | unknown
  /** Behaviour when the detection engine errors: 'open' forwards the request, 'closed' rejects it with 503. */
  fail_mode?: "open" | "closed"
  use_case?: string
  strictness_level?: "strict" | "moderate" | "permissive"
}

export interface developer__projects__schemas__ProjectResponse {
  id: string
  name: string
  description: string | unknown
  fail_mode: string
  use_case: string
  strictness_level: string
  zero_retention?: boolean
  created_at: string
}

export interface DivergenceItemOut {
  text_preview: string
  category: string
  base_decision: string
  base_confidence: number
  candidate_decision: string
  candidate_confidence: number
  divergence: string
}

export interface EnrollRequest {
  /** Enrollment token from the admin */
  token: string
  /** Hostname / device label */
  device_name: string
  /** macos | windows | browser | linux */
  platform?: string
  /** Employee attribution label */
  end_user_id?: string | unknown
  /** Capture tier the agent is running: 'extension' or 'proxy' */
  coverage?: string
}

export interface EnrollResponse {
  api_key: string
  project_id: string
  device_id: string
  organization_id: string
  enforced?: boolean
  mode?: string
  fail_closed?: boolean
  end_user_label?: string | unknown
  account_name?: string | unknown
  account_type?: string
}

export interface ErrorDetail {
  /** Human-readable error description */
  message: string
  /** Error category, e.g. 'authentication_error' */
  type: string
  /** Machine-readable error code */
  code: string
}

export interface ErrorEnvelope {
  error: ErrorDetail
}

/** Optional rich context from framework integrations.

Only ``tool_calls`` is scanned. The rest is descriptive — it labels the
event for the dashboard and the audit log, and does not reach a detector. */
export interface GuardContext {
  /** Framework name, e.g. 'langchain', 'crewai' */
  framework?: string | unknown
  /** LangChain chain name or pipeline identifier */
  chain_name?: string | unknown
  /** Agent identifier for multi-agent systems */
  agent_id?: string | unknown
  /** Session identifier for multi-turn tracking */
  session_id?: string | unknown
  /** Tool calls in this turn. The tool NAME and its ARGUMENTS are assembled into the scanned text and get the same detection stack as the messages — tool arguments are where an exfiltration payload actually travels, so they are scanned rather than logged. Both provider spellings are read: OpenAI's `{'type':'function','function':{'name','arguments'}}` and Anthropic's `{'type':'tool_use','name','input'}`, plus LangChain's `{'name','args'}`. A call in none of those shapes is reported in the response's `unscanned` array with its position; it is never quietly skipped. */
  tool_calls?: Array<Record<string, unknown>> | unknown
  /** Arbitrary framework-specific metadata (not scanned) */
  metadata?: Record<string, unknown> | unknown
}

/** A single message in the conversation.

``content`` takes either a plain string or a provider-shaped content-block
array — OpenAI's ``text``/``image_url``/``input_audio``/``file`` and
Anthropic's ``text``/``image``/``document`` are all understood, because
those are the two shapes our own proxy already receives.

Blocks are accepted as loose dicts rather than a closed union on purpose.
Both providers add block types faster than we can model them, and a strict
schema would 422 a request we could otherwise have scanned the text of.
Anything unrecognised is *reported* in the response's ``unscanned`` rather
than dropped — see ``shared.security.content_parts``. */
export interface GuardMessage {
  /** Message role: system, user, assistant, tool */
  role: string
  /** Message text, or an OpenAI/Anthropic content-block array. Attachments carried in blocks are extracted and scanned like any other text; blocks we cannot read are listed in `unscanned`. */
  content?: string | Array<Record<string, unknown>>
}

/** Per-guardrail override the overlay wants to apply.

Matches the ``guardrails`` override shape PolicyEngine already reads:
``{enabled, level, threshold}``. ``enabled=False`` disables a detector and
is only ever a *loosening* op (surfaced as a critical warning). */
export interface GuardrailDelta {
  enabled?: boolean | unknown
  level?: "strict" | "moderate" | "permissive" | unknown
  threshold?: number | unknown
}

/** Request body for the guard endpoint. */
export interface GuardRequest {
  /** Messages to scan (OpenAI-style message array) */
  messages: Array<GuardMessage>
  /** Scan direction: 'input' (pre-LLM) or 'output' (post-LLM) */
  direction?: string
  /** Model being used (for logging) */
  model?: string | unknown
  /** Optional framework context */
  context?: GuardContext | unknown
  /** RAG-retrieved documents to scan for knowledge poisoning. Each document is scanned individually; the first poisoned one blocks the request, and its position and source are returned in the event metadata so you know which document to drop. Scanning stops at that point, so a request with several poisoned documents reports the first. Optional; backwards-compatible. */
  retrieved_context?: Array<ContextDoc> | unknown
  /** Media attachments to scan for steganographic payloads, adversarial patches, and font injection. Optional. */
  media?: Array<MediaPartSchema> | unknown
}

/** Response from the guard endpoint. */
export interface GuardResponse {
  /** Policy decision: 'allow', 'block', or 'redact' */
  decision: string
  /** Unique event identifier for tracking */
  event_id: string
  /** Confidence score of the decision */
  confidence: number
  /** Aggregate decision-driving score (severity * confidence, clamped to [0, 1]) when a severity-carrying detector decided the verdict; null otherwise. Raw confidence stays in the `confidence` field. */
  weighted_score?: number | unknown
  /** Primary threat type detected */
  threat_type?: string | unknown
  /** Redacted messages (only present when decision='redact'). Always the TEXT projection: a message sent as content blocks comes back as a string. Attachments are never rewritten — we do not re-encode a PDF with the secret removed, and returning one that looked redacted would be worse than returning none. */
  redacted_messages?: Array<GuardMessage> | unknown
  /** Detailed threat breakdown */
  threats?: Array<ThreatDetail>
  /** Processing time in milliseconds */
  latency_ms: number
  /** Parts that reached us and produced nothing to scan. An `allow` with a non-empty `unscanned` is NOT 'this content is clean' — it is 'the text was clean and these parts were never read'. Reasons: url_only (we do not fetch caller-supplied URLs, that would be an SSRF primitive), file_id_unsupported, encrypted, no_text_extracted (a scanned/rasterised document), too_large, undecodable, unsupported_type, extractor_unavailable, unsupported_block, unsupported_tool_call (an entry in `context.tool_calls` in none of the shapes we can read — `index` is its position in that list). */
  unscanned?: Array<UnscannedAttachment>
}

export interface HTTPValidationError {
  detail?: Array<ValidationError>
}

/** The managed update policy an enrolled Shadow AI device should apply.
``fleet`` reflects the org's ``shadow_ai_fleet`` entitlement; when false the
other fields are null and the device keeps its local user preference. */
export interface ManagedPolicyResponse {
  fleet?: boolean
  force_update_mode?: string | unknown
  pinned_channel?: string | unknown
  min_version_override?: string | unknown
}

/** A media attachment to be scanned for steganographic/adversarial payloads. */
export interface MediaPartSchema {
  /** Media type: 'image', 'audio' or 'document' */
  type: string
  /** MIME type, e.g. 'image/png', 'audio/wav' */
  mime_type: string
  /** URL to fetch the media from */
  url?: string | unknown
  /** Base64-encoded media data */
  base64?: string | unknown
  /** Extra metadata */
  metadata?: Record<string, unknown> | unknown
}

export interface OverlayApplyRequest {
  name: string
  delta: OverlayDelta
  project_id?: string | unknown
  acknowledge_loosening?: boolean
}

/** Additive deltas over a base policy config.

Everything here is meant to *tighten*. Loosening ops (raising a threshold,
dropping a detection level toward permissive, disabling a guardrail) are
permitted to be expressed but are flagged as warnings in the diff. */
export interface OverlayDelta {
  detection_levels?: Record<string, unknown>
  toxicity_threshold?: number | unknown
  add_custom_patterns?: Array<string>
  add_blocked_domains?: Array<string>
  guardrails?: Record<string, unknown>
}

export interface OverlayOut {
  id: string
  name: string
  version: number
  status: string
  project_id: string | unknown
  warnings: Array<OverlayWarningOut>
}

export interface OverlayPreviewRequest {
  delta: OverlayDelta
  sample?: SampleSource
  max_examples?: number
  project_id?: string | unknown
}

export interface OverlayWarningOut {
  kind: string
  field: string
  message: string
  severity: "warning" | "critical"
}

export interface QuotaErrorDetail {
  message: string
  /** 'quota_exceeded' or 'spending_limit_exceeded' */
  type: string
  /** 'monthly_quota_exceeded' or 'spending_limit_exceeded' */
  code: string
  current_plan: string
  requests_used: number
  requests_limit: number
  upgrade_url: string
  retry_after?: number | unknown
}

export interface QuotaErrorEnvelope {
  error: QuotaErrorDetail
}

export interface RedactRequest {
  /** Text to redact */
  content: string
  /** Entity types to redact. Omit to use the policy's configured entities. Accepts detector entity names ('email', 'ssn', 'credit_card', 'phone_us'), the family aliases 'phone', 'ip_address' and 'passport', and 'api_key'. An unrecognized name is rejected rather than ignored. */
  pii_types?: Array<string> | unknown
}

export interface RedactResponse {
  original: string
  redacted: string
  piiFound: Array<string>
}

/** Where the shadow traffic sample comes from.

``corpus`` reuses the curated Shadow eval corpus (offline, deterministic);
``inline`` lets the caller pass their own recent-traffic prompts. */
export interface SampleSource {
  kind?: "corpus" | "inline"
  limit?: number
  texts?: Array<string>
}

export interface ScanRequest {
  /** Text to scan */
  content: string
  /** Content type: 'prompt' or 'response' */
  type?: string
}

export interface ScanResponse {
  blocked: boolean
  decision: string
  reason: string
  threatType?: string | unknown
  confidence: number
  eventId: string
  processingTimeMs: number
}

export interface ShadowReportOut {
  total: number
  counts: Record<string, unknown>
  blocked_base: number
  blocked_candidate: number
  warnings: Array<OverlayWarningOut>
  examples: Record<string, unknown>
}

/** Individual threat found during scanning. */
export interface ThreatDetail {
  type: string
  confidence: number
  details: string
  /** severity_score * confidence, clamped to [0, 1]. The decision-driving number when a severity-carrying detector (e.g. structural heuristics) fired; null when confidence alone is the signal. */
  weighted_score?: number | unknown
}

/** One part of the request we could not read, and why. */
export interface UnscannedAttachment {
  /** Position within the list the reason names — the combined attachment list, or `context.tool_calls` for `unsupported_tool_call`. -1 when the part has no position, which is every `unsupported_block`. */
  index: number
  /** Stable machine-readable code */
  reason: string
  /** Reason with any extra qualifier, e.g. 'no_text_extracted:pages=3' */
  detail: string
}

export interface ValidationError {
  loc: Array<string | number>
  msg: string
  type: string
  input?: unknown
  ctx?: Record<string, unknown>
}
