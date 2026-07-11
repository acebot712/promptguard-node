import {
  applyRedactionToArgs as anthropicApplyRedaction,
  extractResponseContent as anthropicExtract,
  messagesToGuardFormat as anthropicMessages,
} from "../src/patches/anthropic"
import {
  BEDROCK_COMMANDS,
  applyRedactionToArgs as bedrockApplyRedaction,
  extractCommandMessages as bedrockExtractCommand,
  extractMessagesFromBody as bedrockExtractMessages,
  extractBedrockResponseText,
} from "../src/patches/bedrock"
import {
  applyRedactionToArgs as cohereApplyRedaction,
  extractResponseText as cohereExtractResponse,
  messagesToGuardFormat as cohereMessages,
} from "../src/patches/cohere"
import {
  contentToGuardFormat,
  extractResponseText,
  applyRedactionToArgs as googleApplyRedaction,
} from "../src/patches/google"
import {
  applyResponsesRedactionToArgs,
  extractResponseContent,
  extractResponsesResponseText,
  messagesToGuardFormat,
  applyRedactionToArgs as openaiApplyRedaction,
  responsesInputToGuardFormat,
} from "../src/patches/openai"

const redacted = (contents: string[]) => contents.map((c) => ({ role: "user", content: c }))

// ---------------------------------------------------------------------------
// OpenAI patch - message conversion
// ---------------------------------------------------------------------------

describe("OpenAI messagesToGuardFormat", () => {
  test("converts dict-style messages", () => {
    const result = messagesToGuardFormat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ])
    expect(result).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ])
  })

  test("handles multimodal content (text + image)", () => {
    const result = messagesToGuardFormat([
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: "https://..." } },
        ],
      },
    ])
    expect(result).toEqual([{ role: "user", content: "What's in this image?" }])
  })

  test("handles empty messages", () => {
    expect(messagesToGuardFormat([])).toEqual([])
    expect(messagesToGuardFormat(null as unknown as unknown[])).toEqual([])
  })

  test("handles null content", () => {
    const result = messagesToGuardFormat([{ role: "assistant", content: null }])
    expect(result).toEqual([{ role: "assistant", content: "" }])
  })
})

describe("OpenAI extractResponseContent", () => {
  test("extracts from choices[0].message.content", () => {
    const response = {
      choices: [{ message: { content: "Hello!" } }],
    }
    expect(extractResponseContent(response)).toBe("Hello!")
  })

  test("returns null for empty response", () => {
    expect(extractResponseContent(null)).toBeNull()
    expect(extractResponseContent({})).toBeNull()
    expect(extractResponseContent({ choices: [] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Anthropic patch - message conversion
// ---------------------------------------------------------------------------

describe("Anthropic messagesToGuardFormat", () => {
  test("includes system prompt", () => {
    const result = anthropicMessages([{ role: "user", content: "Hello" }], "Be helpful")
    expect(result).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
    ])
  })

  test("without system prompt", () => {
    const result = anthropicMessages([{ role: "user", content: "Hello" }])
    expect(result).toEqual([{ role: "user", content: "Hello" }])
  })

  test("handles system as content blocks", () => {
    const result = anthropicMessages(
      [{ role: "user", content: "Hello" }],
      [{ type: "text", text: "System prompt" }],
    )
    expect(result).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
    ])
  })

  test("handles multimodal content blocks", () => {
    const result = anthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", source: {} },
        ],
      },
    ])
    expect(result).toEqual([{ role: "user", content: "Look at this" }])
  })
})

describe("Anthropic extractResponseContent", () => {
  test("extracts from content blocks", () => {
    const response = {
      content: [{ type: "text", text: "Hello!" }],
    }
    expect(anthropicExtract(response)).toBe("Hello!")
  })

  test("returns null for empty content", () => {
    expect(anthropicExtract(null)).toBeNull()
    expect(anthropicExtract({})).toBeNull()
    expect(anthropicExtract({ content: [] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Google patch - content conversion
// ---------------------------------------------------------------------------

describe("Google contentToGuardFormat", () => {
  test("handles string input", () => {
    const result = contentToGuardFormat("Hello")
    expect(result).toEqual([{ role: "user", content: "Hello" }])
  })

  test("handles array of strings", () => {
    const result = contentToGuardFormat(["Hello", "World"])
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ])
  })

  test("handles content objects with parts", () => {
    const result = contentToGuardFormat([
      {
        role: "user",
        parts: [{ text: "What is 2+2?" }],
      },
    ])
    expect(result).toEqual([{ role: "user", content: "What is 2+2?" }])
  })

  test("handles non-array non-string input", () => {
    const result = contentToGuardFormat(42)
    expect(result).toEqual([{ role: "user", content: "42" }])
  })

  test("request-object form recurses into .contents", () => {
    // Regression: generateContent({ contents: [...] }) used to fall through
    // to String(contents) and scan "[object Object]" while the real prompt
    // went unscanned.
    const result = contentToGuardFormat({
      contents: [{ role: "user", parts: [{ text: "secret prompt" }] }],
    })
    expect(result).toEqual([{ role: "user", content: "secret prompt" }])
  })

  test("request-object form with string items", () => {
    const result = contentToGuardFormat({ contents: ["Hello", "World"] })
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ])
  })
})

describe("Google extractResponseText", () => {
  test("extracts from text property", () => {
    expect(extractResponseText({ text: "Hello" })).toBe("Hello")
  })

  test("extracts from text function", () => {
    expect(extractResponseText({ text: () => "Hello" })).toBe("Hello")
  })

  test("extracts from candidates", () => {
    const response = {
      candidates: [{ content: { parts: [{ text: "Hello" }] } }],
    }
    expect(extractResponseText(response)).toBe("Hello")
  })

  test("returns null for empty response", () => {
    expect(extractResponseText(null)).toBeNull()
    expect(extractResponseText({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// OpenAI patch - redaction
// ---------------------------------------------------------------------------

describe("OpenAI applyRedactionToArgs", () => {
  test("replaces message contents positionally", () => {
    const args = [
      {
        model: "gpt-5-nano",
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "SSN 123-45-6789" },
        ],
      },
    ]
    const result = openaiApplyRedaction(args, redacted(["Be helpful", "SSN [REDACTED]"]))
    expect(result).not.toBeNull()
    const params = (result as unknown[])[0] as {
      model: string
      messages: Array<{ content: string }>
    }
    expect(params.model).toBe("gpt-5-nano")
    expect(params.messages[0].content).toBe("Be helpful")
    expect(params.messages[1].content).toBe("SSN [REDACTED]")
  })

  test("skips falsy entries without consuming a redacted index", () => {
    const args = [{ messages: [null, { role: "user", content: "secret" }] }]
    const result = openaiApplyRedaction(args, redacted(["[REDACTED]"]))
    const params = (result as unknown[])[0] as { messages: unknown[] }
    expect(params.messages[0]).toBeNull()
    expect((params.messages[1] as { content: string }).content).toBe("[REDACTED]")
  })

  test("returns null when messages is not an array", () => {
    expect(openaiApplyRedaction([{}], redacted(["x"]))).toBeNull()
    expect(openaiApplyRedaction([{ messages: "nope" }], redacted(["x"]))).toBeNull()
  })

  test("multimodal array content is rebuilt as a text part, not a bare string", () => {
    const args = [
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "SSN 123-45-6789" },
              { type: "image_url", image_url: { url: "https://..." } },
            ],
          },
        ],
      },
    ]
    const result = openaiApplyRedaction(args, redacted(["SSN [REDACTED]"]))
    const params = (result as unknown[])[0] as { messages: Array<{ content: unknown }> }
    expect(params.messages[0].content).toEqual([{ type: "text", text: "SSN [REDACTED]" }])
  })
})

// ---------------------------------------------------------------------------
// OpenAI Responses API patch - extraction + redaction
// ---------------------------------------------------------------------------

describe("OpenAI responsesInputToGuardFormat", () => {
  test("string input becomes a user message", () => {
    expect(responsesInputToGuardFormat({ input: "Hello" })).toEqual([
      { role: "user", content: "Hello" },
    ])
  })

  test("instructions are emitted as a system message first", () => {
    expect(responsesInputToGuardFormat({ instructions: "Be helpful", input: "Hello" })).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
    ])
  })

  test("item array with string and part-array content", () => {
    const result = responsesInputToGuardFormat({
      input: [
        { role: "user", content: "plain" },
        { role: "user", content: [{ type: "input_text", text: "part text" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "prev" }] },
      ],
    })
    expect(result).toEqual([
      { role: "user", content: "plain" },
      { role: "user", content: "part text" },
      { role: "assistant", content: "prev" },
    ])
  })

  test("non-message items are skipped", () => {
    const result = responsesInputToGuardFormat({
      input: [
        { type: "function_call_output", call_id: "c1", output: "..." },
        { role: "user", content: "Hello" },
      ],
    })
    expect(result).toEqual([{ role: "user", content: "Hello" }])
  })

  test("empty params extract nothing", () => {
    expect(responsesInputToGuardFormat({})).toEqual([])
  })
})

describe("OpenAI extractResponsesResponseText", () => {
  test("prefers output_text convenience field", () => {
    expect(extractResponsesResponseText({ output_text: "Hello!" })).toBe("Hello!")
  })

  test("falls back to output message items", () => {
    const response = {
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      ],
    }
    expect(extractResponsesResponseText(response)).toBe("Hi")
  })

  test("null for empty response", () => {
    expect(extractResponsesResponseText(null)).toBeNull()
    expect(extractResponsesResponseText({})).toBeNull()
  })
})

describe("OpenAI applyResponsesRedactionToArgs", () => {
  test("string input replaced", () => {
    const result = applyResponsesRedactionToArgs(
      [{ model: "gpt-5-nano", input: "SSN 123" }],
      redacted(["SSN [REDACTED]"]),
    )
    expect(((result as unknown[])[0] as { input: string }).input).toBe("SSN [REDACTED]")
  })

  test("instructions offset then message items; part arrays rebuilt", () => {
    const result = applyResponsesRedactionToArgs(
      [
        {
          instructions: "secret system",
          input: [
            { type: "function_call_output", call_id: "c1", output: "..." },
            { role: "user", content: [{ type: "input_text", text: "SSN 123" }] },
          ],
        },
      ],
      [
        { role: "system", content: "[SYS REDACTED]" },
        { role: "user", content: "SSN [REDACTED]" },
      ],
    )
    const params = (result as unknown[])[0] as { instructions: string; input: unknown[] }
    expect(params.instructions).toBe("[SYS REDACTED]")
    // Non-message item passes through untouched, no guard index consumed.
    expect(params.input[0]).toEqual({ type: "function_call_output", call_id: "c1", output: "..." })
    expect(params.input[1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "SSN [REDACTED]" }],
    })
  })

  test("returns null for unredactable shapes", () => {
    expect(applyResponsesRedactionToArgs([{}], redacted(["x"]))).toBeNull()
    expect(applyResponsesRedactionToArgs([{ input: 42 }], redacted(["x"]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Anthropic patch - redaction offset
// ---------------------------------------------------------------------------

describe("Anthropic applyRedactionToArgs", () => {
  test("offsets by one when a string system prompt was emitted", () => {
    const args = [
      { system: "Be helpful", messages: [{ role: "user", content: "SSN 123-45-6789" }] },
    ]
    const result = anthropicApplyRedaction(args, [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "SSN [REDACTED]" },
    ])
    const params = (result as unknown[])[0] as {
      system: string
      messages: Array<{ content: string }>
    }
    expect(params.system).toBe("Be helpful")
    expect(params.messages[0].content).toBe("SSN [REDACTED]")
  })

  test("no offset when system is an array with no text blocks", () => {
    // Regression: offset used to be computed from `system != null`, which
    // shifted every redaction by one for array systems with no text blocks
    // (no system guard-message was actually emitted for them).
    const args = [
      {
        system: [{ type: "image", source: {} }],
        messages: [{ role: "user", content: "SSN 123-45-6789" }],
      },
    ]
    const result = anthropicApplyRedaction(args, redacted(["SSN [REDACTED]"]))
    const params = (result as unknown[])[0] as {
      system: unknown
      messages: Array<{ content: string }>
    }
    expect(params.messages[0].content).toBe("SSN [REDACTED]")
    expect(params.system).toEqual([{ type: "image", source: {} }])
  })

  test("preserves array shape of the system prompt", () => {
    const args = [
      {
        system: [{ type: "text", text: "secret system" }],
        messages: [{ role: "user", content: "hi" }],
      },
    ]
    const result = anthropicApplyRedaction(args, [
      { role: "system", content: "[REDACTED]" },
      { role: "user", content: "hi" },
    ])
    const params = (result as unknown[])[0] as { system: unknown }
    expect(params.system).toEqual([{ type: "text", text: "[REDACTED]" }])
  })

  test("returns null when messages is missing", () => {
    expect(anthropicApplyRedaction([{ system: "x" }], redacted(["x"]))).toBeNull()
  })

  test("multimodal array content is rebuilt as a text block, not a bare string", () => {
    const args = [
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "SSN 123-45-6789" },
              { type: "image", source: {} },
            ],
          },
        ],
      },
    ]
    const result = anthropicApplyRedaction(args, redacted(["SSN [REDACTED]"]))
    const params = (result as unknown[])[0] as { messages: Array<{ content: unknown }> }
    expect(params.messages[0].content).toEqual([{ type: "text", text: "SSN [REDACTED]" }])
  })
})

// ---------------------------------------------------------------------------
// Google patch - redaction
// ---------------------------------------------------------------------------

describe("Google applyRedactionToArgs", () => {
  test("string contents replaced by redacted string", () => {
    const result = googleApplyRedaction(["my SSN is 123"], redacted(["my SSN is [REDACTED]"]))
    expect((result as unknown[])[0]).toBe("my SSN is [REDACTED]")
  })

  test("array of strings replaced elementwise", () => {
    const result = googleApplyRedaction([["a", "b"]], redacted(["x", "y"]))
    expect((result as unknown[])[0]).toEqual(["x", "y"])
  })

  test("content objects get rebuilt parts", () => {
    const contents = [{ role: "user", parts: [{ text: "secret" }] }]
    const result = googleApplyRedaction([contents], redacted(["[REDACTED]"]))
    expect((result as unknown[])[0]).toEqual([{ role: "user", parts: [{ text: "[REDACTED]" }] }])
  })

  test("request-object form redacts inner contents and preserves the wrapper", () => {
    const request = {
      contents: [{ role: "user", parts: [{ text: "secret" }] }],
      generationConfig: { temperature: 0 },
    }
    const result = googleApplyRedaction([request], redacted(["[REDACTED]"]))
    expect(result).not.toBeNull()
    expect((result as unknown[])[0]).toEqual({
      contents: [{ role: "user", parts: [{ text: "[REDACTED]" }] }],
      generationConfig: { temperature: 0 },
    })
    // Original request untouched.
    expect(request.contents).toEqual([{ role: "user", parts: [{ text: "secret" }] }])
  })

  test("returns null for unsupported shapes", () => {
    expect(googleApplyRedaction([{ foo: "bar" }], redacted(["x"]))).toBeNull()
    expect(googleApplyRedaction([42], redacted(["x"]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cohere patch - extraction + redaction
// ---------------------------------------------------------------------------

describe("Cohere messagesToGuardFormat", () => {
  test("V2 messages map 1:1", () => {
    const result = cohereMessages({
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ],
    })
    expect(result).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
    ])
  })

  test("V1 chatHistory then message", () => {
    const result = cohereMessages({
      chatHistory: [{ role: "USER", message: "earlier" }],
      message: "current",
    })
    expect(result).toEqual([
      { role: "USER", content: "earlier" },
      { role: "user", content: "current" },
    ])
  })

  test("V2 structured content-part arrays are flattened, not String()ed", () => {
    // Regression: String([{type:"text",...}]) yields "[object Object]" and
    // the real text was never scanned.
    const result = cohereMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "secret one" },
            { type: "image_url", image_url: { url: "https://..." } },
            { type: "text", text: "secret two" },
          ],
        },
      ],
    })
    expect(result).toEqual([{ role: "user", content: "secret one\nsecret two" }])
  })
})

describe("Cohere extractResponseText", () => {
  test("V1 text field", () => {
    expect(cohereExtractResponse({ text: "hi" })).toBe("hi")
  })

  test("V2 message content blocks", () => {
    expect(cohereExtractResponse({ message: { content: [{ type: "text", text: "hi" }] } })).toBe(
      "hi",
    )
  })

  test("null for empty", () => {
    expect(cohereExtractResponse(null)).toBeNull()
    expect(cohereExtractResponse({})).toBeNull()
  })
})

describe("Cohere applyRedactionToArgs", () => {
  test("V2 messages redacted 1:1", () => {
    const args = [{ messages: [{ role: "user", content: "secret" }] }]
    const result = cohereApplyRedaction(args, redacted(["[REDACTED]"]))
    const params = (result as unknown[])[0] as { messages: Array<{ content: string }> }
    expect(params.messages[0].content).toBe("[REDACTED]")
  })

  test("V1 chatHistory and message redacted in guard order", () => {
    const args = [
      {
        chatHistory: [{ role: "USER", message: "old secret" }],
        message: "new secret",
      },
    ]
    const result = cohereApplyRedaction(args, redacted(["old [REDACTED]", "new [REDACTED]"]))
    const params = (result as unknown[])[0] as {
      chatHistory: Array<{ message: string }>
      message: string
    }
    expect(params.chatHistory[0].message).toBe("old [REDACTED]")
    expect(params.message).toBe("new [REDACTED]")
  })

  test("V1 message-only params redact the message", () => {
    const result = cohereApplyRedaction([{ message: "secret" }], redacted(["[REDACTED]"]))
    expect(((result as unknown[])[0] as { message: string }).message).toBe("[REDACTED]")
  })

  test("returns null when no known shape present", () => {
    expect(cohereApplyRedaction([{}], redacted(["x"]))).toBeNull()
  })

  test("V2 array content is rebuilt as a text part, not a bare string", () => {
    const args = [{ messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }] }]
    const result = cohereApplyRedaction(args, redacted(["[REDACTED]"]))
    const params = (result as unknown[])[0] as { messages: Array<{ content: unknown }> }
    expect(params.messages[0].content).toEqual([{ type: "text", text: "[REDACTED]" }])
  })
})

// ---------------------------------------------------------------------------
// Bedrock patch - extraction + redaction
// ---------------------------------------------------------------------------

class ConverseCommand {
  constructor(public input: Record<string, unknown>) {}
}
class InvokeModelCommand {
  constructor(public input: Record<string, unknown>) {}
}
class InvokeModelWithResponseStreamCommand {
  constructor(public input: Record<string, unknown>) {}
}
class UnknownCommand {
  constructor(public input: Record<string, unknown>) {}
}

describe("Bedrock extractMessagesFromBody", () => {
  test("anthropic-style JSON string body", () => {
    const body = JSON.stringify({
      system: "Be helpful",
      messages: [{ role: "user", content: "Hello" }],
    })
    expect(bedrockExtractMessages(body)).toEqual([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
    ])
  })

  test("Uint8Array body", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ messages: [{ role: "user", content: [{ text: "Hi" }] }] }),
    )
    expect(bedrockExtractMessages(body)).toEqual([{ role: "user", content: "Hi" }])
  })

  test("titan inputText body", () => {
    expect(bedrockExtractMessages(JSON.stringify({ inputText: "Hi" }))).toEqual([
      { role: "user", content: "Hi" },
    ])
  })

  test("prompt body", () => {
    expect(bedrockExtractMessages(JSON.stringify({ prompt: "Hi" }))).toEqual([
      { role: "user", content: "Hi" },
    ])
  })
})

describe("Bedrock InvokeModelWithResponseStreamCommand", () => {
  test("is in the intercepted command set", () => {
    // Regression: the streaming invoke command was missing, so its input
    // was never scanned at all.
    expect(BEDROCK_COMMANDS.has("InvokeModelWithResponseStreamCommand")).toBe(true)
  })

  test("extractCommandMessages extracts from the JSON body like InvokeModelCommand", () => {
    const cmd = new InvokeModelWithResponseStreamCommand({
      modelId: "anthropic.claude-3",
      body: JSON.stringify({
        system: "Be helpful",
        messages: [{ role: "user", content: "SSN 123" }],
      }),
    })
    expect(bedrockExtractCommand([cmd])).toEqual({
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "SSN 123" },
      ],
      model: "anthropic.claude-3",
    })
  })

  test("redaction rewrites the body like InvokeModelCommand", () => {
    const cmd = new InvokeModelWithResponseStreamCommand({
      modelId: "anthropic.claude-3",
      body: JSON.stringify({ messages: [{ role: "user", content: "SSN 123" }] }),
    })
    const result = bedrockApplyRedaction([cmd], redacted(["SSN [REDACTED]"]))
    expect(result).not.toBeNull()
    const newCmd = (result as unknown[])[0] as InvokeModelWithResponseStreamCommand
    expect(newCmd.constructor.name).toBe("InvokeModelWithResponseStreamCommand")
    const body = JSON.parse(newCmd.input.body as string)
    expect(body.messages).toEqual([{ role: "user", content: "SSN [REDACTED]" }])
  })

  test("extractCommandMessages: Converse commands extract from input directly", () => {
    const cmd = new ConverseCommand({
      modelId: "anthropic.claude-3",
      messages: [{ role: "user", content: [{ text: "Hi" }] }],
    })
    expect(bedrockExtractCommand([cmd])).toEqual({
      messages: [{ role: "user", content: "Hi" }],
      model: "anthropic.claude-3",
    })
  })
})

describe("Bedrock applyRedactionToArgs", () => {
  test("ConverseCommand: system offset + content blocks rebuilt", () => {
    const cmd = new ConverseCommand({
      modelId: "anthropic.claude-3",
      system: [{ text: "Be helpful" }],
      messages: [{ role: "user", content: [{ text: "SSN 123" }] }],
    })
    const result = bedrockApplyRedaction(
      [cmd],
      [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "SSN [REDACTED]" },
      ],
    )
    expect(result).not.toBeNull()
    const newCmd = (result as unknown[])[0] as ConverseCommand
    // Prototype must be preserved for shouldIntercept's constructor.name check.
    expect(newCmd.constructor.name).toBe("ConverseCommand")
    expect(newCmd.input.system).toEqual([{ text: "Be helpful" }])
    expect(newCmd.input.messages).toEqual([{ role: "user", content: [{ text: "SSN [REDACTED]" }] }])
    // Original command untouched.
    expect(cmd.input.messages).toEqual([{ role: "user", content: [{ text: "SSN 123" }] }])
  })

  test("InvokeModelCommand: JSON string body rewritten with anthropic blocks", () => {
    const cmd = new InvokeModelCommand({
      modelId: "anthropic.claude-3",
      body: JSON.stringify({
        system: "Be helpful",
        messages: [{ role: "user", content: [{ type: "text", text: "SSN 123" }] }],
      }),
    })
    const result = bedrockApplyRedaction(
      [cmd],
      [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "SSN [REDACTED]" },
      ],
    )
    const newCmd = (result as unknown[])[0] as InvokeModelCommand
    const body = JSON.parse(newCmd.input.body as string)
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "SSN [REDACTED]" }] },
    ])
  })

  test("InvokeModelCommand: Uint8Array body stays binary", () => {
    const cmd = new InvokeModelCommand({
      body: new TextEncoder().encode(JSON.stringify({ inputText: "SSN 123" })),
    })
    const result = bedrockApplyRedaction([cmd], redacted(["SSN [REDACTED]"]))
    const newCmd = (result as unknown[])[0] as InvokeModelCommand
    expect(newCmd.input.body).toBeInstanceOf(Uint8Array)
    const body = JSON.parse(new TextDecoder().decode(newCmd.input.body as Uint8Array))
    expect(body.inputText).toBe("SSN [REDACTED]")
  })

  test("returns null for unknown commands and unsupported shapes", () => {
    expect(bedrockApplyRedaction([new UnknownCommand({})], redacted(["x"]))).toBeNull()
    // Capitalized `Messages` variant is extract-only; redaction escalates.
    expect(
      bedrockApplyRedaction(
        [new InvokeModelCommand({ body: JSON.stringify({ Messages: [] }) })],
        redacted(["x"]),
      ),
    ).toBeNull()
  })
})

describe("Bedrock extractBedrockResponseText", () => {
  const invokeBody = (obj: unknown) =>
    ({ body: new TextEncoder().encode(JSON.stringify(obj)) }) as unknown

  test("ConverseCommand: concatenates output.message.content text blocks", () => {
    const response = {
      output: {
        message: {
          role: "assistant",
          content: [{ text: "Hello" }, { toolUse: { name: "t" } }, { text: " world" }],
        },
      },
      stopReason: "end_turn",
    }
    expect(extractBedrockResponseText(response, "ConverseCommand")).toBe("Hello world")
  })

  test("ConverseCommand: returns empty string when content is missing", () => {
    expect(extractBedrockResponseText({ output: {} }, "ConverseCommand")).toBe("")
    expect(extractBedrockResponseText({}, "ConverseCommand")).toBe("")
    expect(extractBedrockResponseText(null, "ConverseCommand")).toBe("")
  })

  test("InvokeModelCommand: anthropic `completion` body", () => {
    const response = invokeBody({ completion: "Hi from Claude", stop_reason: "end_turn" })
    expect(extractBedrockResponseText(response, "InvokeModelCommand")).toBe("Hi from Claude")
  })

  test("InvokeModelCommand: llama/mistral `generation` body", () => {
    const response = invokeBody({ generation: "Hi from Llama" })
    expect(extractBedrockResponseText(response, "InvokeModelCommand")).toBe("Hi from Llama")
  })

  test("InvokeModelCommand: titan `results[].outputText` body", () => {
    const response = invokeBody({ results: [{ outputText: "Hi from Titan" }] })
    expect(extractBedrockResponseText(response, "InvokeModelCommand")).toBe("Hi from Titan")
  })

  test("InvokeModelCommand: `results[].text` fallback", () => {
    const response = invokeBody({ results: [{ text: "Hi" }] })
    expect(extractBedrockResponseText(response, "InvokeModelCommand")).toBe("Hi")
  })

  test("InvokeModelCommand: Buffer body is decoded like Uint8Array", () => {
    const response = { body: Buffer.from(JSON.stringify({ completion: "buffered" })) }
    expect(extractBedrockResponseText(response, "InvokeModelCommand")).toBe("buffered")
  })

  test("InvokeModelCommand: malformed or missing body yields empty string", () => {
    expect(
      extractBedrockResponseText(
        { body: new TextEncoder().encode("not json") },
        "InvokeModelCommand",
      ),
    ).toBe("")
    expect(extractBedrockResponseText({ body: "plain string" }, "InvokeModelCommand")).toBe("")
    expect(extractBedrockResponseText({}, "InvokeModelCommand")).toBe("")
    // Unrecognized body keys extract nothing.
    expect(extractBedrockResponseText(invokeBody({ other: "x" }), "InvokeModelCommand")).toBe("")
  })
})
