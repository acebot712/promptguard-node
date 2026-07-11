/**
 * Minimal namespaced, leveled logger for the PromptGuard SDK.
 *
 * Node has no equivalent of Python's `logging` module, so this provides a
 * small, suppressible logger so the SDK does not write to stdout/stderr by
 * default. Mirrors the suppressibility of the Python SDK's `logging` usage.
 *
 * Levels (most → least verbose): "debug" < "info" < "warn" < "error" < "silent".
 * Default level is "warn": warnings/errors surface, info/debug are suppressed.
 * Set verbosity via {@link setLogLevel} (or the `logLevel` / `silent` options
 * on `init()` / integration constructors).
 *
 * NOTE: the log level is **process-global**, not per-instance. Passing
 * `logLevel` / `silent` to `init()`, `PromptGuardCallbackHandler`, or
 * `promptGuardMiddleware` mutates the shared level for the whole process —
 * the most recently constructed instance wins. If you need different
 * verbosity for different clients, call {@link setLogLevel} around the
 * code paths you care about instead.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

const PREFIX = "[promptguard]"

let currentLevel: LogLevel = "warn"

/** Set the global SDK log level. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

/** Get the current global SDK log level. */
export function getLogLevel(): LogLevel {
  return currentLevel
}

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel] && currentLevel !== "silent"
}

export const logger = {
  debug(message: string): void {
    if (enabled("debug")) console.debug(`${PREFIX} ${message}`)
  },
  info(message: string): void {
    if (enabled("info")) console.info(`${PREFIX} ${message}`)
  },
  warn(message: string): void {
    if (enabled("warn")) console.warn(`${PREFIX} ${message}`)
  },
  error(message: string): void {
    if (enabled("error")) console.error(`${PREFIX} ${message}`)
  },
}
