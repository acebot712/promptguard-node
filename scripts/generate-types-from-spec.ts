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

function resolveRef(ref: string): string {
  const name = ref.split("/").pop() ?? ref
  return name
}

function mapType(prop: SchemaProperty): string {
  if (prop.$ref) return resolveRef(prop.$ref)
  if (prop.anyOf) {
    const types = prop.anyOf.map(mapType)
    return types.join(" | ")
  }
  if (prop.enum) {
    return prop.enum.map((v) => `"${v}"`).join(" | ")
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
  const lines: string[] = []

  if (schema.description) {
    lines.push(`/** ${schema.description} */`)
  }

  if (schema.enum) {
    lines.push(`export type ${name} = ${schema.enum.map((v) => `"${v}"`).join(" | ")}`)
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
    const optional = required.has(propName) ? "" : "?"
    const tsType = mapType(prop)
    if (prop.description) {
      lines.push(`  /** ${prop.description} */`)
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
