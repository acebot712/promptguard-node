/**
 * The Conversation a framework integration's scans belong to.
 *
 * The Guard API remembers a Conversation's turns when a scan names it in
 * `context.session_id`. An integration must send the framework's real
 * conversation id there — the same value on every turn of one conversation, a
 * different one for another — or nothing at all. A per-call run id would make
 * every scan a conversation of its own.
 */

/**
 * The metadata keys a LangChain call carries its conversation id under, in
 * the order they are read. LangGraph copies the checkpointer's `thread_id`
 * into every callback's metadata; `session_id` and `conversation_id` are the
 * other two keys LangSmith groups a thread by, set through `config.metadata`.
 */
export const CONVERSATION_METADATA_KEYS = ["thread_id", "session_id", "conversation_id"] as const

/**
 * `value` as a session id, or `undefined` when it cannot be one: a non-empty
 * string as it is, a finite number in its decimal form, anything else not.
 */
export function asSessionId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "string" && value.trim()) return value
  return undefined
}

/** The conversation id a LangChain call's metadata names, if any. */
export function sessionIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined
  for (const key of CONVERSATION_METADATA_KEYS) {
    const sessionId = asSessionId(metadata[key])
    if (sessionId !== undefined) return sessionId
  }
  return undefined
}

/** Check a `sessionId` an application passed to an integration. */
export function validateSessionId(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new TypeError(`sessionId must be a non-empty string, got ${JSON.stringify(sessionId)}`)
  }
  return sessionId
}
