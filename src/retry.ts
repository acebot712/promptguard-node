/**
 * Shared transient-failure retry primitives.
 *
 * Both the proxy client ({@link ./client}) and the Guard client
 * ({@link ./guard}) retry the same class of transient failures with the same
 * backoff policy, so the primitives live here to keep the two in lockstep.
 *
 * Retry policy (identical for both clients):
 *  - retry retryable HTTP status codes ({@link RETRYABLE_STATUS_CODES}) and
 *    retryable network dispatch failures ({@link isRetryableNetworkError});
 *  - honor a server-provided `Retry-After` header, clamped to
 *    {@link MAX_RETRY_AFTER_MS};
 *  - otherwise use exponential backoff from a base delay, plus jitter so
 *    concurrent clients don't retry in lockstep.
 *
 * Deterministic pre-flight failures (circular-JSON body, invalid header value)
 * are NOT retryable — retrying them just delays the real error.
 */

/** HTTP status codes worth retrying (transient server/rate-limit failures). */
export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

/**
 * Upper bound on a server-provided `Retry-After` delay. A hostile or
 * misconfigured server must not be able to park the client for hours.
 */
export const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into a
 * delay in milliseconds, or `null` when absent/unparseable. Clamped to
 * {@link MAX_RETRY_AFTER_MS}.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
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
 * Errno codes for transient network dispatch failures that are safe to retry.
 */
const RETRYABLE_ERRNO = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
])

/**
 * Whether a fetch-level failure is worth retrying.
 *
 * Undici surfaces network dispatch failures as `TypeError("fetch failed")`
 * with a `cause`; aborts/timeouts carry the corresponding `name`. Everything
 * else thrown before or during dispatch (circular-JSON serialization,
 * invalid header values) is deterministic and retrying it just delays the
 * real error.
 */
export function isRetryableNetworkError(err: unknown): boolean {
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
 * Compute the delay (ms) before the next retry attempt.
 *
 * A server-provided `Retry-After` (already parsed + clamped) takes precedence
 * over exponential backoff; jitter (a fraction of the exponential backoff) is
 * always added so concurrent clients don't retry in lockstep.
 *
 * @param retryDelay base delay in ms (attempt 0 backoff)
 * @param attempt zero-based attempt index
 * @param retryAfterMs parsed `Retry-After` delay, or `null`
 */
export function computeRetryDelayMs(
  retryDelay: number,
  attempt: number,
  retryAfterMs: number | null = null,
): number {
  const backoff = retryDelay * 2 ** attempt
  const base = retryAfterMs ?? backoff
  return base + Math.random() * 0.25 * backoff
}
