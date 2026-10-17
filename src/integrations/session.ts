/**
 * The Conversation a framework integration's scans belong to.
 *
 * The Guard API remembers a Conversation's turns when a scan names it in
 * `context.session_id`. An integration must send the framework's real
 * conversation id there — the same value on every turn of one conversation, a
 * different one for another — or nothing at all. A per-call run id would make
 * every scan a conversation of its own.
 */

import { logger } from "../logger"

/**
 * The longest session id sent. Longer is not a conversation id but a payload,
 * and the Guard API refuses it, so it is dropped before the scan.
 */
export const MAX_SESSION_ID_CHARS = 256

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
 * Nor an id over {@link MAX_SESSION_ID_CHARS}: it is dropped with a debug log
 * and the scan goes ahead without one, never failing the call (ADR-0002).
 */
export function asSessionId(value: unknown): string | undefined {
  const id =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string" && value.trim()
        ? value
        : undefined
  if (id !== undefined && id.length > MAX_SESSION_ID_CHARS) {
    logger.debug(
      `session id of ${id.length} characters is over ${MAX_SESSION_ID_CHARS}; scanning without one`,
    )
    return undefined
  }
  return id
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
  if (sessionId.length > MAX_SESSION_ID_CHARS) {
    // Configuration, not a request: refused when the integration is built.
    throw new TypeError(`sessionId must be at most ${MAX_SESSION_ID_CHARS} characters`)
  }
  return sessionId
}
