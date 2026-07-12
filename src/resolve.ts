/**
 * Shared credential resolution for all PromptGuard entry points.
 */

import { PromptGuardError } from "./client"

export const DEFAULT_BASE_URL = "https://api.promptguard.co/api/v1"

export function resolveCredentials(
  apiKey?: string,
  baseUrl?: string,
  defaultBaseUrl = DEFAULT_BASE_URL,
): { apiKey: string; baseUrl: string } {
  const key = apiKey ?? process.env.PROMPTGUARD_API_KEY ?? ""
  if (!key) {
    // Typed error (not a bare `Error`) so callers can branch on
    // `err instanceof PromptGuardError` / `err.code === "missing_api_key"`
    // instead of string-matching the message.
    throw new PromptGuardError(
      "API key required. Pass apiKey or set the PROMPTGUARD_API_KEY environment variable. " +
        "Get a key at https://app.promptguard.co",
      "missing_api_key",
      0,
    )
  }
  return {
    apiKey: key,
    baseUrl: baseUrl ?? process.env.PROMPTGUARD_BASE_URL ?? defaultBaseUrl,
  }
}
