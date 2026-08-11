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
   * Retry attempts for transient Guard API failures (network errors and
   * 429/5xx responses) before the `failOpen` policy governs. Default: `3`.
   * Retries never change the eventual decision — see {@link GuardClientConfig}.
   */
  maxRetries?: number
  /** Base delay in ms between Guard API retries (exponential backoff). Default: `1000`. */
  retryDelay?: number
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
    maxRetries: options.maxRetries,
    retryDelay: options.retryDelay,
  })

  mode = resolvedMode
  failOpen = options.failOpen ?? true
  scanResponses = options.scanResponses ?? false

  applyPatches()

  // One-line confirmation of which provider SDKs are actually protected.
  // Suppressed by default (info level); set logLevel: "info" to see it, or
  // read the same list programmatically via getAppliedPatches(). When ZERO
  // patches applied, applyPatches() already logged a warn (visible by default).
  const protecting = getAppliedPatches()
  logger.info(
    `auto-instrumentation initialised (mode=${mode}, fail_open=${failOpen}) — ` +
      `protecting: ${protecting.length ? protecting.join(", ") : "none"}`,
  )
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

/**
 * Every patch module, with the packages each one can hook.
 *
 * `detects` is what lets `init()` tell "the customer does not use this
 * provider" apart from "the customer uses it and we failed to hook it". Those
 * two used to look identical, so a customer with `openai` and `@google/genai`
 * installed saw a healthy startup and had no idea their Gemini traffic was
 * unscanned.
 */
const PATCH_MODULES = [
  { name: "openai", path: "./patches/openai", detects: ["openai"] },
  { name: "anthropic", path: "./patches/anthropic", detects: ["@anthropic-ai/sdk"] },
  { name: "google-genai", path: "./patches/google-genai", detects: ["@google/genai"] },
  { name: "google-generativeai", path: "./patches/google", detects: ["@google/generative-ai"] },
  { name: "cohere", path: "./patches/cohere", detects: ["cohere-ai"] },
  { name: "bedrock", path: "./patches/bedrock", detects: ["@aws-sdk/client-bedrock-runtime"] },
]

/**
 * Packages we know about and deliberately do NOT hook, with the same advice.
 *
 * Every one works today through the proxy — point the client's base URL at
 * PromptGuard. Listing them is not a promise to hook them; it is the difference
 * between telling a customer "not instrumented, here is the one-line fix" and
 * telling them nothing while they believe they are covered.
 *
 * Frameworks are deliberately absent. LangChain's ChatOpenAI calls the `openai`
 * package underneath, which we patch, so its traffic is scanned transitively —
 * warning about it would be a false alarm that trains people to ignore the real
 * ones.
 */
const KNOWN_UNPATCHED = [
  // VERIFIED 2026-08-11, not assumed: `@ai-sdk/openai` 4.0.36 declares only
  // `@ai-sdk/provider` and `@ai-sdk/provider-utils` as dependencies. It does
  // NOT use the `openai` package, so it makes its own HTTP calls and our
  // `openai` patch never sees them. The Vercel AI SDK is covered by the proxy
  // and by nothing else, which is the opposite of what we told people.
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "groq-sdk",
  "@mistralai/mistralai",
  "together-ai",
  "ollama",
  "@google-cloud/aiplatform",
  "@aws-sdk/client-bedrock-agent-runtime",
]

const ADVICE_URL = "https://docs.promptguard.co/integrations/auto-instrumentation"

function isInstalled(pkg: string): boolean {
  try {
    require.resolve(pkg)
    return true
  } catch {
    return false
  }
}

/** Provider packages that are installed but are NOT being scanned. */
export function detectedUnpatched(): string[] {
  const hooked = new Set(getAppliedPatches())
  const found: string[] = []

  for (const mod of PATCH_MODULES) {
    if (hooked.has(mod.name)) continue
    for (const pkg of mod.detects) if (isInstalled(pkg)) found.push(pkg)
  }
  for (const pkg of KNOWN_UNPATCHED) if (isInstalled(pkg)) found.push(pkg)

  return [...new Set(found)].sort()
}

/**
 * What is and is not instrumented, as data rather than a log line.
 *
 * A startup warning is only read by whoever is watching at startup. The same
 * facts in this form can be asserted in the caller's own CI:
 *
 * ```ts
 * expect(instrumentationReport().detectedUnpatched).toEqual([])
 * ```
 *
 * which turns "we told you" into "you cannot ship without knowing".
 */
export function instrumentationReport(): {
  patched: string[]
  detectedUnpatched: string[]
  adviceUrl: string
} {
  return {
    patched: getAppliedPatches(),
    detectedUnpatched: detectedUnpatched(),
    adviceUrl: ADVICE_URL,
  }
}

function warnAboutUnpatchedLibraries(): void {
  for (const pkg of detectedUnpatched()) {
    logger.warn(
      `PromptGuard: '${pkg}' is installed but auto-instrumentation did NOT hook it — ` +
        `calls made through it are not being scanned. Point that client at the proxy ` +
        `(set its base URL to your PromptGuard endpoint), or see ${ADVICE_URL} for the ` +
        `exact call surfaces we patch.`,
    )
  }
}

function applyPatches(): void {
  const patchModules = PATCH_MODULES

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

  warnAboutUnpatchedLibraries()

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
