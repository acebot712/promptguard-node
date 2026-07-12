#!/usr/bin/env node
/**
 * Generate src/version.ts from package.json so SDK_VERSION can never drift
 * from the published version. Runs automatically via the `prebuild` script;
 * the generated file stays committed so lint/tests work without a build.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))

const outPath = path.join(root, "src", "version.ts")
const content =
  "// Auto-generated from package.json by scripts/generate-version.mjs — do not edit.\n" +
  `export const SDK_VERSION = "${pkg.version}"\n`

const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8") : null
if (existing !== content) {
  fs.writeFileSync(outPath, content)
  console.log(`Generated src/version.ts (SDK_VERSION=${pkg.version})`)
}
