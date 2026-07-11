#!/usr/bin/env node
/**
 * Packaging smoke test — verifies the published tarball resolves under BOTH
 * module systems for every exports entry.
 *
 * Guards against regressions like exports entries missing a `default`
 * condition, which made native ESM `import` throw
 * ERR_PACKAGE_PATH_NOT_EXPORTED while `require()` worked fine.
 *
 * Flow: `npm pack` the real tarball, install it into a temp project, then
 * resolve every subpath via `require()` (CJS) and dynamic `import()` (ESM,
 * via `node --input-type=module`). Run with `npm run test:pack` (expects a
 * fresh `npm run build` first).
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))

// Every exports subpath, normalized to a bare specifier.
const subpaths = Object.keys(pkg.exports).map((key) =>
  key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`,
)

// Symbols that must be reachable through the root entry in both systems.
const rootSymbols = ["PromptGuard", "GuardClient", "init"]

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-pack-smoke-"))
let failed = false

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf-8", ...opts })
}

function check(label, fn) {
  try {
    fn()
    console.log(`  ok: ${label}`)
  } catch (err) {
    failed = true
    console.error(`  FAIL: ${label}`)
    console.error(String(err.stderr || err.message || err).trim())
  }
}

try {
  console.log("Packing tarball…")
  const packOutput = run("npm", ["pack", "--pack-destination", workDir, "--json"], { cwd: root })
  const tarball = path.join(workDir, JSON.parse(packOutput)[0].filename)

  console.log("Installing into temp project…")
  const appDir = path.join(workDir, "app")
  fs.mkdirSync(appDir)
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ private: true }))
  run("npm", ["install", "--no-audit", "--no-fund", "--no-save", tarball], { cwd: appDir })

  for (const specifier of subpaths) {
    check(`require("${specifier}")`, () => {
      run("node", ["-e", `require(${JSON.stringify(specifier)})`], { cwd: appDir })
    })
    check(`import("${specifier}")`, () => {
      run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`], {
        cwd: appDir,
      })
    })
  }

  const symbolCheck = rootSymbols
    .map((s) => `if (typeof sdk[${JSON.stringify(s)}] === "undefined") throw new Error(${JSON.stringify(s)} + " missing")`)
    .join("\n")
  check("root exports expose expected symbols (CJS)", () => {
    run("node", ["-e", `const sdk = require(${JSON.stringify(pkg.name)})\n${symbolCheck}`], {
      cwd: appDir,
    })
  })
  check("root exports expose expected symbols (ESM)", () => {
    run(
      "node",
      [
        "--input-type=module",
        "-e",
        `const sdk = await import(${JSON.stringify(pkg.name)})\n${symbolCheck}`,
      ],
      { cwd: appDir },
    )
  })
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

if (failed) {
  console.error("\nPackaging smoke test FAILED")
  process.exit(1)
}
console.log("\nPackaging smoke test passed")
