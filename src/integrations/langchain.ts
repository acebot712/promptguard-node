/**
 * LangChain.js integration - PromptGuardCallbackHandler.
 *
 * Implements the LangChain BaseCallbackHandler interface to scan prompts
 * before LLM calls and responses after, with rich context about chains,
 * tools, and agent steps.
 *
 * @example
 * ```ts
 * import { PromptGuardCallbackHandler } from 'promptguard-sdk/integrations/langchain';
 *
 * const handler = new PromptGuardCallbackHandler({ apiKey: 'pg_live_xxx' });
 *
 * const llm = new ChatOpenAI({ callbacks: [handler] });
 * // or
 * await chain.invoke({ input: '...' }, { callbacks: [handler] });
 * ```
 */

import {
  GuardApiError,
  GuardClient,
  type GuardClientConfig,
  type GuardContext,
  type GuardDecision,
  type GuardMessage,
  PromptGuardBlockedError,
  safeErrorLabel,
} from "../guard"
import { type LogLevel, logger, setLogLevel } from "../logger"
import { resolveCredentials } from "../resolve"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PromptGuardCallbackOptions extends GuardClientConfig {
  mode?: "enforce" | "monitor"
  /**
   * Also scan LLM/tool outputs (default: `false`, consistent with `init()`
   * and the Vercel AI middleware). Enable explicitly if you want output
   * scanning — every scan is a billable Guard API call.
   */
  scanResponses?: boolean
  failOpen?: boolean
  /**
   * SDK log verbosity (default: `"warn"`). Set to `"silent"` to suppress logs.
   * NOTE: this sets the **process-global** SDK log level (shared with `init()`
   * and other integrations); the most recently constructed instance wins.
   */
  logLevel?: LogLevel
  /** Convenience shorthand for `logLevel: "silent"`. */
  silent?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten LangChain message content to scannable text.
 *
 * Structured/multimodal content is a content-part array
 * (`[{ type: "text", text }, { type: "image_url", ... }]`); `String()` on it
 * would yield `"[object Object]"` and the real text would never be scanned.
 * Mirrors the flattening in patches/openai.ts.
 */
function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textParts: string[] = []
    for (const part of content) {
      if (typeof part === "string") textParts.push(part)
      else if ((part as Record<string, unknown> | null)?.type === "text") {
        textParts.push(String((part as Record<string, unknown>).text ?? ""))
      }
    }
    return textParts.join("\n")
  }
  return String(content ?? "")
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * LangChain callback handler that scans prompts and responses via the
 * PromptGuard Guard API.
 *
 * **Redact decisions block in enforce mode:** LangChain callbacks observe
 * calls but cannot rewrite the inputs of the in-flight LLM call, so a
 * `redact` decision cannot be honored here. In enforce mode it is escalated
 * to a block (a {@link PromptGuardBlockedError} is thrown) rather than
 * silently sending the content the Guard API asked us to redact. If you need
 * actual redaction, use auto-instrumentation (`init()`) or explicit
 * `GuardClient.scan()` calls, which can rewrite the outgoing messages.
 */
export class PromptGuardCallbackHandler {
  readonly name = "promptguard"

  /**
   * Tell LangChain's callback manager to re-throw errors from this handler.
   *
   * `@langchain/core` wraps every handler invocation in `consumeCallback`,
   * which catches handler errors and merely `console.error`s them unless
   * `handler.raiseError` is true. Without this, a
   * {@link PromptGuardBlockedError} thrown in enforce mode would be
   * swallowed and the LLM call would proceed — i.e. enforce mode would not
   * actually block.
   */
  readonly raiseError = true

  /**
   * Tell LangChain to await this handler before continuing.
   *
   * `consumeCallback(fn, wait)` only awaits the handler when `wait`
   * (`handler.awaitHandlers`) is true; otherwise the scan runs in the
   * background and cannot abort the LLM call even with `raiseError` set.
   */
  readonly awaitHandlers = true

  private readonly guard: GuardClient
  private readonly mode: "enforce" | "monitor"
  private readonly scanResponses: boolean
  private readonly failOpen: boolean

  /** Chain context per run ID for richer threat detection. */
  private chainContext = new Map<string, Record<string, unknown>>()

  constructor(options: PromptGuardCallbackOptions) {
    if (options.silent) setLogLevel("silent")
    else if (options.logLevel) setLogLevel(options.logLevel)

    const { apiKey, baseUrl } = resolveCredentials(options.apiKey, options.baseUrl)

    this.guard = new GuardClient({
      apiKey,
      baseUrl,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
      retryDelay: options.retryDelay,
    })
    this.mode = options.mode ?? "enforce"
    // Default false: consistent with init() and the Vercel AI middleware
    // (least surprise + no unexpected per-response Guard API cost).
    this.scanResponses = options.scanResponses ?? false
    this.failOpen = options.failOpen ?? true
  }

  // -- LLM callbacks -------------------------------------------------------

  async handleLLMStart(
    serialized: Record<string, unknown>,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const messages: GuardMessage[] = prompts.map((p) => ({
      role: "user",
      content: p,
    }))
    const model = this.extractModel(serialized)
    const context = this.buildContext(runId, parentRunId, "llm", tags, metadata)

    const decision = await this.safeScan(messages, "input", model, context)
    this.handleDecision(decision, runId)
  }

  async handleChatModelStart(
    serialized: Record<string, unknown>,
    messages: unknown[][],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const guardMessages: GuardMessage[] = []

    for (const messageList of messages) {
      for (const raw of messageList) {
        const msg = raw as Record<string, unknown>
        const role = this.mapRole(String(msg?.type ?? msg?.role ?? "user"))
        const content = flattenMessageContent(msg?.content ?? msg?.text ?? "")
        guardMessages.push({ role, content })
      }
    }

    const model = this.extractModel(serialized)
    const context = this.buildContext(runId, parentRunId, "chat_model", tags, metadata)

    const decision = await this.safeScan(guardMessages, "input", model, context)
    this.handleDecision(decision, runId)
  }

  async handleLLMEnd(output: unknown, runId: string): Promise<void> {
    if (!this.scanResponses) return

    const text = this.extractLLMResponse(output)
    if (!text) return

    const context = this.buildContext(runId, undefined, "llm_response")
    const decision = await this.safeScan(
      [{ role: "assistant", content: text }],
      "output",
      undefined,
      context,
    )
    this.handleDecision(decision, runId)
  }

  handleLLMError(_error: Error, runId: string): void {
    this.chainContext.delete(runId)
  }

  // -- Chain callbacks -----------------------------------------------------

  async handleChainStart(
    serialized: Record<string, unknown>,
    _inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    const chainName = (serialized?.id as string[] | undefined)?.slice(-1)[0] ?? "unknown"
    this.chainContext.set(runId, {
      chain_name: chainName,
      parent_run_id: parentRunId,
      tags,
    })
  }

  handleChainEnd(_outputs: Record<string, unknown>, runId: string): void {
    this.chainContext.delete(runId)
  }

  handleChainError(_error: Error, runId: string): void {
    this.chainContext.delete(runId)
  }

  // -- Tool callbacks ------------------------------------------------------

  async handleToolStart(
    serialized: Record<string, unknown>,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const toolName =
      (serialized?.name as string) ??
      (serialized?.id as string[] | undefined)?.slice(-1)[0] ??
      "unknown"

    const context = this.buildContext(runId, parentRunId, "tool", tags, {
      ...(metadata ?? {}),
      tool_name: toolName,
    })

    const decision = await this.safeScan(
      [{ role: "user", content: input }],
      "input",
      "tool",
      context,
    )
    this.handleDecision(decision, runId)
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    if (!this.scanResponses) return
    const text = output ? String(output) : ""
    if (!text) return

    const context = this.buildContext(runId, undefined, "tool_response")
    const decision = await this.safeScan(
      [{ role: "assistant", content: text }],
      "output",
      undefined,
      context,
    )
    this.handleDecision(decision, runId)
  }

  handleToolError(_error: Error, runId: string): void {
    this.chainContext.delete(runId)
  }

  // -- Internal helpers ----------------------------------------------------

  private async safeScan(
    messages: GuardMessage[],
    direction: "input" | "output",
    model?: string,
    context?: GuardContext,
  ): Promise<GuardDecision | null> {
    try {
      return await this.guard.scan(messages, direction, model, context)
    } catch (err) {
      // Only a Guard API outage is eligible for fail-open (mirrors
      // patches/base.ts). Any other error is a real bug and must surface.
      if (!(err instanceof GuardApiError)) throw err
      // Failing closed rethrows the original typed error so callers keep
      // the status code and cause instead of an anonymous Error.
      if (!this.failOpen) throw err
      logger.warn(
        `Guard API unavailable, allowing ${direction} unscanned (failOpen=true): ${safeErrorLabel(
          err,
        )}`,
      )
      return null
    }
  }

  private handleDecision(decision: GuardDecision | null, runId: string): void {
    if (!decision) return

    if (decision.blocked) {
      if (this.mode === "enforce") throw new PromptGuardBlockedError(decision)
      logger.warn(
        `[monitor] would block: ${decision.threatType} (event=${decision.eventId}, run=${runId})`,
      )
    }

    if (decision.redacted) {
      if (this.mode === "enforce") {
        // Callbacks cannot rewrite the in-flight call's inputs, so the
        // redaction cannot be applied. Proceeding would silently send the
        // content the Guard API asked us to redact — escalate to a block.
        logger.error(
          `redact decision cannot be applied from a LangChain callback; ` +
            `escalating to block (event=${decision.eventId}, run=${runId})`,
        )
        throw new PromptGuardBlockedError(decision)
      }
      logger.warn(
        `[monitor] would redact: content passed through unredacted ` +
          `(event=${decision.eventId}, run=${runId})`,
      )
    }
  }

  private buildContext(
    runId: string,
    parentRunId?: string,
    component = "unknown",
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): GuardContext {
    const chainInfo =
      this.chainContext.get(runId) ??
      (parentRunId ? this.chainContext.get(parentRunId) : undefined) ??
      {}

    return {
      framework: "langchain",
      chain_name: chainInfo.chain_name as string | undefined,
      session_id: runId,
      metadata: {
        component,
        tags: tags ?? (chainInfo.tags as string[] | undefined),
        ...(metadata ?? {}),
      },
    }
  }

  private extractModel(serialized: Record<string, unknown>): string {
    const kwargs = serialized?.kwargs as Record<string, unknown> | undefined
    return (
      (kwargs?.model_name as string) ??
      (kwargs?.model as string) ??
      ((serialized?.id as string[]) ?? []).slice(-1)[0] ??
      "unknown"
    )
  }

  private mapRole(type: string): string {
    const map: Record<string, string> = {
      human: "user",
      ai: "assistant",
      system: "system",
    }
    return map[type] ?? type
  }

  private extractLLMResponse(output: unknown): string | null {
    try {
      const typed = output as Record<string, unknown>
      if (typed?.generations) {
        const texts: string[] = []
        for (const genList of typed.generations as unknown[]) {
          for (const gen of genList as Record<string, unknown>[]) {
            if (gen?.text) texts.push(gen.text as string)
            else if ((gen?.message as Record<string, unknown>)?.content)
              texts.push(String((gen.message as Record<string, unknown>).content))
          }
        }
        return texts.length ? texts.join("\n") : null
      }
    } catch {
      // ignore
    }
    return null
  }
}
