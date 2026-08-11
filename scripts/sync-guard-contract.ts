#!/usr/bin/env npx ts-node
/**
 * Adopt a freshly-fetched cross-SDK contract into tests/, and stamp its lockfile.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tests/guard-contract.json` is the cross-SDK contract: this SDK and the Python
 * SDK must both satisfy every case in it. Its source of truth is the platform
 * monorepo's `packages/sdk-shared/guard-contract.json`, and for a long time the
 * only thing connecting the two was somebody remembering to copy the file.
 *
 * Nobody did. On 2026-08-11 the monorepo source was found two minor versions
 * behind this copy (v1.3.0 against v1.5.1) and missing an entire
 * `redaction_enforcement` section. Five months, undetected — because
 * `tests/contract.test.ts` opens with "if this test fails, the Node SDK has
 * drifted from the cross-SDK contract" while reading a local duplicate of
 * itself. A file compared against its own copy cannot detect drift.
 *
 * The monorepo now publishes the contract at a public URL, and
 * `.github/workflows/sync-from-api.yml` fetches it weekly beside the OpenAPI
 * spec. This script is the "adopt" half of that: it writes the fetched contract
 * over the vendored copy and records where it came from in
 * `tests/guard-contract.lock.json`.
 *
 * The lockfile is what gives `tests/contract.test.ts` something external to
 * check against. Hand-editing `tests/guard-contract.json` now fails the suite,
 * because the digest no longer matches the one recorded at sync time. Both files
 * move together only through this script, and only inside a reviewed PR — the
 * workflow never pushes to a branch anyone merges from.
 *
 * Usage:
 *   npx ts-node scripts/sync-guard-contract.ts <fetched-contract.json>
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

const REPO = path.resolve(__dirname, "..")
const CONTRACT = path.join(REPO, "tests", "guard-contract.json")
const LOCK = path.join(REPO, "tests", "guard-contract.lock.json")

// Where the monorepo publishes it. Repeated in sync-from-api.yml (the fetch)
// and asserted in tests/contract.test.ts, so moving it is a three-line change
// that shows up in review rather than a silent redirect.
const SOURCE_URL = "https://promptguard.co/contracts/guard-contract.json"

function main(argv: string[]): number {
  const fetched = argv[2]
  if (!fetched) {
    process.stderr.write("Usage: npx ts-node scripts/sync-guard-contract.ts <file.json>\n")
    return 2
  }

  if (!fs.existsSync(fetched)) {
    process.stderr.write(`No such file: ${fetched}\n`)
    return 1
  }

  const raw = fs.readFileSync(fetched)

  // Parse before adopting. A 200 carrying an HTML error page would otherwise be
  // written straight over the contract and only fail later, somewhere less
  // obvious.
  let contract: { _version?: string }
  try {
    contract = JSON.parse(raw.toString("utf-8"))
  } catch (err) {
    process.stderr.write(`Aborting: ${fetched} is not JSON (${err}); refusing to adopt\n`)
    return 1
  }

  const version = contract._version
  if (!version) {
    process.stderr.write(`Aborting: ${fetched} carries no _version; refusing to adopt\n`)
    return 1
  }

  const digest = crypto.createHash("sha256").update(raw).digest("hex")

  fs.writeFileSync(CONTRACT, raw)
  fs.writeFileSync(
    LOCK,
    `${JSON.stringify(
      {
        _comment:
          "Provenance for tests/guard-contract.json. Written by " +
          "scripts/sync-guard-contract.ts from " +
          ".github/workflows/sync-from-api.yml. Do not hand-edit: " +
          "tests/contract.test.ts checks the contract against the digest " +
          "recorded here, so editing either file alone fails the suite — " +
          "which is the drift this pair exists to catch.",
        source: SOURCE_URL,
        version,
        sha256: digest,
      },
      null,
      2,
    )}\n`,
  )

  process.stderr.write(`Adopted cross-SDK contract v${version} → sha256 ${digest}\n`)
  return 0
}

process.exit(main(process.argv))
