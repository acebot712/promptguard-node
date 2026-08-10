#!/usr/bin/env node
/**
 * The version being released must have a CHANGELOG entry.
 *
 * A CHANGELOG is only worth having if it is written when the release is cut.
 * Left to be reconstructed afterwards it becomes a list of tag subjects — which
 * is exactly what every entry below 1.10.1 is, because there was no CHANGELOG
 * until 2026-08-11 and "chore(release): 1.10.0" cannot be turned into a release
 * note after the fact.
 *
 * Deliberately dumb: it checks that somebody wrote something under the version
 * about to ship, not whether the prose is any good. A gate that judged quality
 * would be argued with; one that asks "is there an entry" is either satisfied
 * or it is not.
 *
 *   node scripts/check-changelog.mjs            # check package.json's version
 *   node scripts/check-changelog.mjs 1.11.0     # check a specific one
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CHANGELOG = path.join(ROOT, "CHANGELOG.md")

const version =
  process.argv[2] ?? JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version

let text
try {
  text = readFileSync(CHANGELOG, "utf8")
} catch {
  console.error("error: CHANGELOG.md does not exist")
  process.exit(1)
}

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
if (!new RegExp(`^##\\s*\\[${escaped}\\]`, "m").test(text)) {
  console.error(
    `error: no CHANGELOG entry for ${version}.\n` +
      `       Add a '## [${version}] — YYYY-MM-DD' section describing what changed\n` +
      "       for the people installing it. Reconstructing this after the fact\n" +
      "       produces a list of commit subjects, which is what the pre-1.10.1\n" +
      "       entries already are.",
  )
  process.exit(1)
}

console.log(`✓ CHANGELOG has an entry for ${version}`)
