/**
 * Auto-generated from OpenAPI spec (v1.0.0).
 * DO NOT EDIT — regenerate with: npx ts-node scripts/generate-types-from-spec.ts
 *
 * These are type-only definitions. Custom client logic lives in src/guard.ts,
 * src/client.ts, src/patches/, and src/integrations/ — those files are never
 * modified by this generator.
 */

/* eslint-disable */
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
  active_sessions: number
  anomalies_detected: number
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
  fail_mode?: string
  use_case?: string
  strictness_level?: string
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
  ca_cert?: string | unknown
  ca_key?: string | unknown
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

/** Optional rich context from framework integrations. */
export interface GuardContext {
  /** Framework name, e.g. 'langchain', 'crewai' */
  framework?: string | unknown
  /** LangChain chain name or pipeline identifier */
  chain_name?: string | unknown
  /** Agent identifier for multi-agent systems */
  agent_id?: string | unknown
  /** Session identifier for multi-turn tracking */
  session_id?: string | unknown
  /** Tool calls in this turn */
  tool_calls?: Array<Record<string, unknown>> | unknown
  /** Arbitrary framework-specific metadata */
  metadata?: Record<string, unknown> | unknown
}

/** A single message in the conversation. */
export interface GuardMessage {
  /** Message role: system, user, assistant, tool */
  role: string
  /** Message text content */
  content?: string
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
  /** RAG-retrieved documents to scan for knowledge poisoning. Each document is individually scanned before being merged into the LLM prompt. Optional; backwards-compatible. */
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
  /** Primary threat type detected */
  threat_type?: string | unknown
  /** Redacted messages (only present when decision='redact') */
  redacted_messages?: Array<GuardMessage> | unknown
  /** Detailed threat breakdown */
  threats?: Array<ThreatDetail>
  /** Processing time in milliseconds */
  latency_ms: number
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
  /** Media type: 'image' or 'audio' */
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
  /** Specific PII types to redact (default: all) */
  pii_types?: Array<string> | unknown
}

export interface RedactResponse {
  original: string
  redacted: string
  piiFound: Array<string>
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

/** Individual threat found during scanning. */
export interface ThreatDetail {
  type: string
  confidence: number
  details: string
}

export interface ValidationError {
  loc: Array<string | number>
  msg: string
  type: string
  input?: unknown
  ctx?: Record<string, unknown>
}
