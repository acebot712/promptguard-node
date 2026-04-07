#!/usr/bin/env npx ts-node
/**
 * Validate that the Node SDK's types match the OpenAPI developer spec.
 *
 * Usage:
 *   npx ts-node tests/validate-openapi.ts openapi-developer.json
 *
 * Exit code 0 = SDK is in sync; non-zero = drift detected.
 */

import * as fs from "node:fs"

interface OpenAPISpec {
  components?: {
    schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>
    securitySchemes?: Record<string, { type?: string; in?: string; name?: string }>
  }
}

function loadSpec(path: string): OpenAPISpec {
  return JSON.parse(fs.readFileSync(path, "utf-8"))
}

function getSchemaProperties(spec: OpenAPISpec, schemaName: string): Set<string> {
  const schema = spec.components?.schemas?.[schemaName]
  if (!schema?.properties) return new Set()
  return new Set(Object.keys(schema.properties))
}

const errors: string[] = []

function check(condition: boolean, msg: string) {
  if (!condition) errors.push(msg)
}

function main() {
  const specPath = process.argv[2]
  if (!specPath) {
    console.error("Usage: npx ts-node tests/validate-openapi.ts <openapi-developer.json>")
    process.exit(2)
  }

  if (!fs.existsSync(specPath)) {
    console.error(`Spec file not found: ${specPath}`)
    process.exit(2)
  }

  const spec = loadSpec(specPath)

  // Security scheme
  const apiKeyAuth = spec.components?.securitySchemes?.ApiKeyAuth
  check(
    apiKeyAuth?.type === "apiKey",
    `ApiKeyAuth type should be 'apiKey', got '${apiKeyAuth?.type}'`,
  )
  check(apiKeyAuth?.in === "header", `ApiKeyAuth 'in' should be 'header', got '${apiKeyAuth?.in}'`)
  check(
    apiKeyAuth?.name === "X-API-Key",
    `ApiKeyAuth name should be 'X-API-Key', got '${apiKeyAuth?.name}'`,
  )

  // Error schemas
  const quotaProps = getSchemaProperties(spec, "QuotaErrorDetail")
  for (const field of [
    "message",
    "type",
    "code",
    "current_plan",
    "requests_used",
    "requests_limit",
    "upgrade_url",
  ]) {
    check(quotaProps.has(field), `QuotaErrorDetail missing field: ${field}`)
  }

  const errorProps = getSchemaProperties(spec, "ErrorDetail")
  for (const field of ["message", "type", "code"]) {
    check(errorProps.has(field), `ErrorDetail missing field: ${field}`)
  }

  // Scan schemas
  const scanReqProps = getSchemaProperties(spec, "ScanRequest")
  check(scanReqProps.has("content"), "ScanRequest missing 'content' field")
  check(!scanReqProps.has("text"), "ScanRequest has deprecated 'text' field")

  const scanRespProps = getSchemaProperties(spec, "ScanResponse")
  for (const field of [
    "blocked",
    "decision",
    "reason",
    "confidence",
    "eventId",
    "processingTimeMs",
  ]) {
    check(scanRespProps.has(field), `ScanResponse missing '${field}' field`)
  }

  // Redact schemas
  const redactReqProps = getSchemaProperties(spec, "RedactRequest")
  check(redactReqProps.has("content"), "RedactRequest missing 'content' field")
  check(!redactReqProps.has("text"), "RedactRequest has deprecated 'text' field")

  const redactRespProps = getSchemaProperties(spec, "RedactResponse")
  for (const field of ["original", "redacted", "piiFound"]) {
    check(redactRespProps.has(field), `RedactResponse missing '${field}' field`)
  }

  if (errors.length > 0) {
    console.error(`SDK/OpenAPI drift detected (${errors.length} issue(s)):`)
    for (const err of errors) {
      console.error(`  - ${err}`)
    }
    process.exit(1)
  } else {
    console.log("SDK types match OpenAPI spec.")
    process.exit(0)
  }
}

main()
