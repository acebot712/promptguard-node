/**
 * Auto-instrumentation for PromptGuard (Node.js).
 *
 * Call {@link init} once at application startup to automatically
 * secure **all** LLM calls made through popular SDKs — regardless of
 * which framework (LangChain.js, Vercel AI SDK, etc.) sits on top.
 *
 * @example
 * ```ts
 * import { init } from 'promptguard-sdk/auto';
 *
 * init({ apiKey: 'pg_xxx' });
 *
 * // Everything below is now secured transparently.
 * import OpenAI from 'openai';
 * const client = new OpenAI();
 * await client.chat.completions.create({ ... }); // ← scanned by PromptGuard
 * ```
 */

import { GuardClient } from "./guard"

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let guardClient: GuardClient | null = null
let mode: "enforce" | "monitor" = "enforce"
let failOpen = true
let scanResponses = false
let initialized = false

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
}

export function init(options: InitOptions = {}): void {
  const resolvedKey = options.apiKey ?? process.env.PROMPTGUARD_API_KEY ?? ""
  if (!resolvedKey) {
    throw new Error(
      "PromptGuard API key required. Pass apiKey or set the " +
        "PROMPTGUARD_API_KEY environment variable.",
    )
  }

  const resolvedUrl =
    options.baseUrl ?? process.env.PROMPTGUARD_BASE_URL ?? "https://api.promptguard.co/api/v1"

  const resolvedMode = options.mode ?? "enforce"
  if (resolvedMode !== "enforce" && resolvedMode !== "monitor") {
    throw new Error("mode must be 'enforce' or 'monitor'")
  }

  guardClient = new GuardClient({
    apiKey: resolvedKey,
    baseUrl: resolvedUrl,
    timeout: options.timeout ?? 10_000,
  })

  mode = resolvedMode
  failOpen = options.failOpen ?? true
  scanResponses = options.scanResponses ?? false
  initialized = true

  applyPatches()

  // eslint-disable-next-line no-console
  console.log(
    `[promptguard] auto-instrumentation initialised (mode=${mode}, fail_open=${failOpen})`,
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
  initialized = false
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

export function isInitialized(): boolean {
  return initialized
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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const patchModule = require(mod.path) as {
        apply: () => boolean
        revert: () => void
      }
      if (patchModule.apply()) {
        appliedPatches.push({ name: mod.name, revert: patchModule.revert })
      }
    } catch {
      // SDK not installed or incompatible — skip silently
    }
  }
}
