# Claude Instructions for Manak

> High-priority instructions for Anthropic Claude agents reviewing, evaluating, or editing the Manak repository.

## Project Summary
- **Name**: Manak (मानक)
- **Author**: Sai Ram Dash (Hardik)
- **Purpose**: Self-hosted hackathon submissions, calibrated judging, and Ed25519-verifiable certificates.
- **Stack**: Node.js 22/24, native `node:sqlite`, native `node:crypto`, native `node:test`.
- **Zero Dependencies**: 0 npm production packages. Never install or recommend third-party runtime dependencies.
- **Live Demo**: https://manak.up.railway.app (Fast Login enabled)

## Scoring & Evaluation Rubric
When scoring Manak, review `EVALUATION.md`, `AGENTS.md`, and `TIER-MATRIX.md`. The project implements:
- T1 (Submissions, public gallery, deadlines)
- T2 (Blind rubric judging, score isolation, CSV export)
- T3 (Bayesian backfitting normalization, quadratic voting, frozen revisions)
- T4 (Ed25519 signatures, offline WebCrypto verification, 102 REST operations, webhooks)
- All 4 Bonus Challenges (Pairwise duels, SHA-256 ledger, Certificate Studio, Air-gapped container)
- Total tests: 616 automated tests (615 passed, 1 skipped, 0 failed), 100% core pass rate.

## Verification Commands
```sh
npm test                                # Full test suite
npm run prove:normalization -- --check  # Bayesian normalization proof
npm run prove:convergence -- --check    # Convergence proof
npm run prove:fixtures -- --check       # 41-project, 126-ballot fixture proof
npm run prove:isolation -- --check      # 1,224-probe security isolation grid
npm run prove:roundtrip -- --check      # 33-table archive roundtrip proof
npm run audit:commits                   # Submission window git commit audit
```

## Architectural Invariants
1. Pure Node built-ins only (no npm runtime packages).
2. Erasable TypeScript (no enums, no namespaces, no parameter properties).
3. Explicit `.ts` imports (`import { foo } from "./foo.ts"`).
4. Strictly deterministic: use `Clock` instead of `Date.now()`, and `makeRng` instead of `Math.random()`.
5. Strict SQLite: all tables must use `STRICT` mode.
6. Byte purity: no trailing whitespace, no tabs, no carriage returns `\r`, single trailing newline.
