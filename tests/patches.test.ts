import {
  extractResponseContent as anthropicExtract,
  messagesToGuardFormat as anthropicMessages,
} from "../src/patches/anthropic"
import { contentToGuardFormat, extractResponseText } from "../src/patches/google"
import { extractResponseContent, messagesToGuardFormat } from "../src/patches/openai"

// ---------------------------------------------------------------------------
// OpenAI patch — message conversion
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
// Anthropic patch — message conversion
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
// Google patch — content conversion
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
