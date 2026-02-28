/**
 * LangChain.js integration — PromptGuardCallbackHandler.
 *
 * Implements the LangChain BaseCallbackHandler interface to scan prompts
 * before LLM calls and responses after, with rich context about chains,
 * tools, and agent steps.
 *
 * @example
 * ```ts
 * import { PromptGuardCallbackHandler } from 'promptguard-sdk/integrations/langchain';
 *
 * const handler = new PromptGuardCallbackHandler({ apiKey: 'pg_xxx' });
 *
 * const llm = new ChatOpenAI({ callbacks: [handler] });
 * // or
 * await chain.invoke({ input: '...' }, { callbacks: [handler] });
 * ```
 */

import {
  GuardClient,
  type GuardClientConfig,
  type GuardContext,
  type GuardDecision,
  type GuardMessage,
  PromptGuardBlockedError,
} from "../guard"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PromptGuardCallbackOptions extends GuardClientConfig {
  mode?: "enforce" | "monitor"
  scanResponses?: boolean
  failOpen?: boolean
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class PromptGuardCallbackHandler {
  readonly name = "promptguard"

  private readonly guard: GuardClient
  private readonly mode: "enforce" | "monitor"
  private readonly scanResponses: boolean
  private readonly failOpen: boolean

  /** Chain context per run ID for richer threat detection. */
  private chainContext = new Map<string, Record<string, unknown>>()

  constructor(options: PromptGuardCallbackOptions) {
    const apiKey = options.apiKey ?? process.env.PROMPTGUARD_API_KEY ?? ""
    if (!apiKey) {
      throw new Error("PromptGuard API key required. Pass apiKey or set PROMPTGUARD_API_KEY.")
    }

    this.guard = new GuardClient({
      apiKey,
      baseUrl: options.baseUrl,
      timeout: options.timeout,
    })

    this.mode = options.mode ?? "enforce"
    this.scanResponses = options.scanResponses ?? true
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
        const content = String(msg?.content ?? msg?.text ?? "")
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

  // -- Retriever (no-op) ---------------------------------------------------

  handleRetrieverStart(..._args: unknown[]): void {
    /* no-op */
  }
  handleRetrieverEnd(..._args: unknown[]): void {
    /* no-op */
  }
  handleRetrieverError(..._args: unknown[]): void {
    /* no-op */
  }
  handleText(..._args: unknown[]): void {
    /* no-op */
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
    } catch {
      if (!this.failOpen) throw new Error("Guard API unavailable")
      return null
    }
  }

  private handleDecision(decision: GuardDecision | null, runId: string): void {
    if (!decision) return

    if (decision.blocked) {
      if (this.mode === "enforce") throw new PromptGuardBlockedError(decision)
      console.warn(
        `[promptguard][monitor] would block: ${decision.threatType} (event=${decision.eventId}, run=${runId})`,
      )
    }

    if (decision.redacted) {
      console.info(`[promptguard] redacted content (event=${decision.eventId}, run=${runId})`)
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
