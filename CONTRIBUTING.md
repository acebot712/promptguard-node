# Contributing to PromptGuard Node.js SDK

Thank you for your interest in contributing to PromptGuard!

## Development Setup

```bash
git clone https://github.com/acebot712/promptguard-node.git
cd promptguard-node
npm install
```

## Code Quality

```bash
# Type checking
npx tsc --noEmit

# Build
npm run build
```

## Running Tests

```bash
npm test
```

## Pull Requests

1. Fork the repo and create a feature branch from `main`.
2. Write tests for any new functionality.
3. Ensure `tsc --noEmit` passes with zero errors.
4. Open a PR with a clear description of the change.

## Reporting Issues

Open an issue at https://github.com/acebot712/promptguard-node/issues with:
- Node.js version
- SDK version (`npm ls promptguard-sdk`)
- Minimal reproduction steps
