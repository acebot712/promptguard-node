/**
 * Auto-instrumentation for PromptGuard (Node.js).
 *
 * Call {@link init} once at application startup to automatically
 * secure **all** LLM calls made through popular SDKs - regardless of
 * which framework (LangChain.js, Vercel AI SDK, etc.) sits on top.
 *
 * @example
 * ```ts
 * import { init } from 'promptguard-sdk/auto';
 *
 * init({ apiKey: 'pg_live_xxx' });
 *
 * // Everything below is now secured transparently.
 * import OpenAI from 'openai';
 * const client = new OpenAI();
 * await client.chat.completions.create({ ... }); // ← scanned by PromptGuard
 * ```
 */

import { GuardClient } from "./guard"
import { type LogLevel, logger, setLogLevel } from "./logger"
import { resolveCredentials } from "./resolve"

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let guardClient: GuardClient | null = null
let mode: "enforce" | "monitor" = "enforce"
let failOpen = true
let scanResponses = false

const appliedPatches: Array<{ name: string; revert: () => void }> = []

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitOptions {
  apiKey?: string
  baseUrl?: string
  /** `"enforce"` blocks violations, `"monitor"` logs only (default: `"enforce"`). */
  mode?: "enforce" | "monitor"
  /** Allow LLM calls when Guard API is unreachable (default: `true`). */
  failOpen?: boolean
  /** Also scan LLM responses (default: `false`). */
  scanResponses?: boolean
  /** HTTP timeout in ms for Guard API calls (default: `10000`). */
  timeout?: number
  /**
   * SDK log verbosity (default: `"warn"`). Set to `"silent"` to suppress all
   * SDK logging, or `"info"`/`"debug"` for the init banner and more detail.
   * NOTE: this sets the **process-global** SDK log level (shared with the
   * framework integrations); the most recent setter wins.
   */
  logLevel?: LogLevel
  /** Convenience shorthand for `logLevel: "silent"`. */
  silent?: boolean
}

/**
 * Initialise PromptGuard auto-instrumentation.
 *
 * Patches the provider SDKs (`openai`, `@anthropic-ai/sdk`,
 * `@google/generative-ai`, `cohere-ai`, `@aws-sdk/client-bedrock-runtime`)
 * so every LLM call they make is scanned by the Guard API.
 *
 * **Limitation — ESM apps (dual-package hazard):** patches are applied to the
 * module instances resolved via CommonJS `require()`. If your application runs
 * as native ESM (`"type": "module"` / `.mjs`) and the provider ships separate
 * ESM builds, your `import`ed module instances can be *different objects* from
 * the patched CJS ones — in that case auto-instrumentation silently protects
 * nothing. Use {@link getAppliedPatches} as a runtime canary to verify the
 * providers you use were actually patched, and prefer the ESM-safe
 * alternatives: the LangChain callback handler
 * (`promptguard-sdk/integrations/langchain`), the Vercel AI SDK middleware
 * (`promptguard-sdk/integrations/vercel-ai`), or explicit `GuardClient.scan()`
 * calls. See README "Limitations: ESM apps".
 *
 * When zero patches could be applied, a warning is logged so a
 * misconfiguration never fails silently.
 */
export function init(options: InitOptions = {}): void {
  if (options.silent) {
    setLogLevel("silent")
  } else if (options.logLevel) {
    setLogLevel(options.logLevel)
  }

  const { apiKey, baseUrl } = resolveCredentials(options.apiKey, options.baseUrl)

  const resolvedMode = options.mode ?? "enforce"
  if (resolvedMode !== "enforce" && resolvedMode !== "monitor") {
    throw new Error(`mode must be 'enforce' or 'monitor', got '${resolvedMode}'`)
  }

  guardClient = new GuardClient({
    apiKey,
    baseUrl,
    timeout: options.timeout ?? 10_000,
  })

  mode = resolvedMode
  failOpen = options.failOpen ?? true
  scanResponses = options.scanResponses ?? false

  applyPatches()

  // Suppressed by default (info level). Set logLevel: "info" to see this.
  logger.info(`auto-instrumentation initialised (mode=${mode}, fail_open=${failOpen})`)
}

export function shutdown(): void {
  for (const patch of appliedPatches) {
    try {
      patch.revert()
    } catch {
      // best-effort
    }
  }
  appliedPatches.length = 0
  guardClient = null
}

// ---------------------------------------------------------------------------
// Accessors (used by patches)
// ---------------------------------------------------------------------------

export function getGuardClient(): GuardClient | null {
  return guardClient
}

export function getMode(): "enforce" | "monitor" {
  return mode
}

export function isFailOpen(): boolean {
  return failOpen
}

export function shouldScanResponses(): boolean {
  return scanResponses
}

/**
 * Runtime canary: the names of the auto-instrumentation patches that were
 * actually applied by {@link init} (e.g. `["openai", "anthropic"]`).
 *
 * Because patches attach to the CJS-resolved provider modules, an ESM app can
 * call `init()` successfully and still be unprotected (see the dual-package
 * hazard note on {@link init}). Assert on this at startup when you rely on
 * enforce mode:
 *
 * @example
 * ```ts
 * init({ apiKey: "pg_live_xxx" });
 * if (!getAppliedPatches().includes("openai")) {
 *   throw new Error("PromptGuard did not patch the openai SDK");
 * }
 * ```
 */
export function getAppliedPatches(): string[] {
  return appliedPatches.map((p) => p.name)
}

// ---------------------------------------------------------------------------
// Patch orchestration
// ---------------------------------------------------------------------------

function applyPatches(): void {
  const patchModules = [
    { name: "openai", path: "./patches/openai" },
    { name: "anthropic", path: "./patches/anthropic" },
    { name: "google", path: "./patches/google" },
    { name: "cohere", path: "./patches/cohere" },
    { name: "bedrock", path: "./patches/bedrock" },
  ]

  for (const mod of patchModules) {
    try {
      const patchModule = require(mod.path) as {
        apply: () => boolean
        revert: () => void
      }
      if (patchModule.apply()) {
        // apply() is idempotent per patch module, so a second init() without
        // shutdown() reports "already patched" success. Skip the push when
        // the patch is already tracked — a duplicate entry would make the
        // getAppliedPatches() canary lie and call revert() twice on
        // shutdown().
        if (!appliedPatches.some((p) => p.name === mod.name)) {
          appliedPatches.push({ name: mod.name, revert: patchModule.revert })
        }
      } else {
        logger.debug(
          `${mod.name} patch not applied: SDK not resolvable via require() ` +
            `(not installed, or only reachable as ESM)`,
        )
      }
    } catch (err: unknown) {
      logger.debug(
        `${mod.name} patch not applied: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (appliedPatches.length === 0) {
    logger.warn(
      "init() applied ZERO auto-instrumentation patches — no supported LLM SDK was " +
        "resolvable via CommonJS require(), so NO calls are being scanned. If your app " +
        'runs as native ESM ("type": "module" / .mjs), auto-instrumentation cannot see ' +
        "the module instances your code imports (dual-package hazard). Use the ESM-safe " +
        "integrations instead: the LangChain callback handler, the Vercel AI SDK " +
        "middleware, or explicit GuardClient.scan() calls. " +
        'See README "Limitations: ESM apps". Set logLevel: "debug" for per-SDK reasons.',
    )
  }
}
