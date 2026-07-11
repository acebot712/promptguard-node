#!/usr/bin/env npx ts-node
/**
 * Generate TypeScript type definitions from the OpenAPI developer spec.
 *
 * Output goes to src/generated/api-types.ts — ONLY types, no runtime code.
 * Hand-written client code in src/ is never touched.
 *
 * Usage:
 *   npx ts-node scripts/generate-types-from-spec.ts openapi-developer.json
 */

import * as fs from "node:fs"
import * as path from "node:path"

interface SchemaProperty {
  type?: string
  format?: string
  enum?: string[]
  items?: SchemaProperty
  $ref?: string
  anyOf?: SchemaProperty[]
  description?: string
  default?: unknown
}

interface Schema {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
  enum?: string[]
  description?: string
  title?: string
}

interface OpenAPISpec {
  components?: {
    schemas?: Record<string, Schema>
  }
  info?: {
    version?: string
    title?: string
  }
}

/**
 * Schema and property names are interpolated verbatim into the generated
 * TypeScript, so they must be plain identifiers — anything else could break
 * out of the declaration and inject code (enum values and descriptions are
 * escaped/sanitized; names must be equally constrained). Fail generation
 * loudly rather than emit a compromised file.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function assertValidIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `${kind} ${JSON.stringify(name)} is not a valid TypeScript identifier — ` +
        "refusing to generate (possible spec injection)",
    )
  }
}

function resolveRef(ref: string): string {
  const name = ref.split("/").pop() ?? ref
  assertValidIdentifier(name, "Referenced schema name")
  return name
}

/**
 * Escape an enum value for interpolation inside a double-quoted TS string
 * literal — backslashes first, then quotes, so a `"` in a spec enum can't
 * break out of the generated literal.
 */
function escapeStringLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Sanitize a spec description for interpolation into a block comment —
 * strip the block-comment terminator sequence (asterisk-slash) so a
 * description can't end the comment early and inject code into the
 * generated file.
 */
function sanitizeComment(text: string): string {
  return text.replace(/\*\//g, "")
}

function mapType(prop: SchemaProperty): string {
  if (prop.$ref) return resolveRef(prop.$ref)
  if (prop.anyOf) {
    const types = prop.anyOf.map(mapType)
    return types.join(" | ")
  }
  if (prop.enum) {
    return prop.enum.map((v) => `"${escapeStringLiteral(v)}"`).join(" | ")
  }

  switch (prop.type) {
    case "string":
      return prop.format === "date-time" ? "string" : "string"
    case "integer":
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "array":
      return prop.items ? `Array<${mapType(prop.items)}>` : "unknown[]"
    case "object":
      return "Record<string, unknown>"
    default:
      return "unknown"
  }
}

function generateInterface(name: string, schema: Schema): string {
  assertValidIdentifier(name, "Schema name")
  const lines: string[] = []

  if (schema.description) {
    lines.push(`/** ${sanitizeComment(schema.description)} */`)
  }

  if (schema.enum) {
    lines.push(
      `export type ${name} = ${schema.enum.map((v) => `"${escapeStringLiteral(v)}"`).join(" | ")}`,
    )
    lines.push("")
    return lines.join("\n")
  }

  if (!schema.properties) {
    lines.push(`export type ${name} = Record<string, unknown>`)
    lines.push("")
    return lines.join("\n")
  }

  const required = new Set(schema.required ?? [])

  lines.push(`export interface ${name} {`)
  for (const [propName, prop] of Object.entries(schema.properties)) {
    assertValidIdentifier(propName, "Property name")
    const optional = required.has(propName) ? "" : "?"
    const tsType = mapType(prop)
    if (prop.description) {
      lines.push(`  /** ${sanitizeComment(prop.description)} */`)
    }
    lines.push(`  ${propName}${optional}: ${tsType}`)
  }
  lines.push("}")
  lines.push("")

  return lines.join("\n")
}

function main() {
  const specPath = process.argv[2]
  if (!specPath) {
    console.error("Usage: npx ts-node scripts/generate-types-from-spec.ts <openapi-developer.json>")
    process.exit(2)
  }

  const spec: OpenAPISpec = JSON.parse(fs.readFileSync(specPath, "utf-8"))
  const schemas = spec.components?.schemas ?? {}
  const version = spec.info?.version ?? "unknown"

  const header = [
    "/**",
    ` * Auto-generated from OpenAPI spec (v${version}).`,
    " * DO NOT EDIT — regenerate with: npx ts-node scripts/generate-types-from-spec.ts",
    " *",
    " * These are type-only definitions. Custom client logic lives in src/guard.ts,",
    " * src/client.ts, src/patches/, and src/integrations/ — those files are never",
    " * modified by this generator.",
    " */",
    "",
    "/* eslint-disable */",
    "",
  ].join("\n")

  const body = Object.entries(schemas)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) => generateInterface(name, schema))
    .join("\n")

  const output = header + body

  const outDir = path.join(__dirname, "..", "src", "generated")
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, "api-types.ts")
  fs.writeFileSync(outPath, output)

  const count = Object.keys(schemas).length
  console.log(`Generated ${count} types → ${outPath}`)
}

main()
