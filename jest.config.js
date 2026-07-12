/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleDirectories: ["node_modules", "src"],
  collectCoverage: true,
  coverageDirectory: "coverage",
  // Raised after the audit-round-1 test additions (actual: ~58/59/72/69).
  // Keep a small buffer below actuals so unrelated refactors don't flake,
  // but never lower these without adding equivalent coverage elsewhere.
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 55,
      lines: 68,
      statements: 65,
    },
  },
}
