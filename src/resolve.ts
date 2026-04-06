/**
 * Shared credential resolution for all PromptGuard entry points.
 */

export const DEFAULT_BASE_URL = "https://api.promptguard.co/api/v1"

export function resolveCredentials(
  apiKey?: string,
  baseUrl?: string,
  defaultBaseUrl = DEFAULT_BASE_URL,
): { apiKey: string; baseUrl: string } {
  const key = apiKey ?? process.env.PROMPTGUARD_API_KEY ?? ""
  if (!key) {
    throw new Error(
      "PromptGuard API key required. Pass apiKey or set the PROMPTGUARD_API_KEY environment variable.",
    )
  }
  return {
    apiKey: key,
    baseUrl: baseUrl ?? process.env.PROMPTGUARD_BASE_URL ?? defaultBaseUrl,
  }
}
