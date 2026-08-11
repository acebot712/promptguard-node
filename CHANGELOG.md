# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`Unreleased` holds work that is merged but not yet published. Move entries into
a dated version section when a release goes out — an `Unreleased` block that
survives three releases is a changelog nobody is maintaining.


## [Unreleased]

### Fixed

- **Gemini calls made through `@google/genai` were not being scanned.**
  Auto-instrumentation patched `@google/generative-ai`, the SDK Google
  deprecated with Gemini 2.0. Both are now patched. Note this one could not be
  patched on the prototype like every other adapter: `@google/genai` assigns
  `generateContent` as an own property in the constructor, so the exported
  `GoogleGenAI` class is wrapped instead.

### Added

- **An installed provider SDK we did not hook is now named at startup**, with
  the one-line fix (point that client at the proxy). Previously `init()` warned
  only when it applied zero patches, so partial coverage was silent.
- `instrumentationReport()` — coverage as data, assertable in your own CI.

### Changed

- `@ai-sdk/openai` (Vercel AI SDK) is listed as **not** auto-instrumented.
  Verified rather than assumed: it declares no dependency on the `openai`
  package and issues its own HTTP calls, so the patch never sees them. It is
  fully covered by the proxy.

