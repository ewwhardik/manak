# Test & Proof Execution Logs

Generated on **Mon, 28 Sep 2026 14:42:35 GMT** via `npm run test:logs`.

This directory contains complete, un-truncated execution logs from all automated test suites,
official acceptance harnesses, and mathematical/cryptographic proofs verifying Manak.

## Summary Matrix

| Log File | Test Suite / Proof | Command | Duration | Status |
| :--- | :--- | :--- | :--- | :--- |
| [`01-acceptance-dogfood.log`](./01-acceptance-dogfood.log) | Official DogFood Acceptance Harness (run.py) | `python run.py .dogfood.toml` | 12.4s | **PASSED** |
| [`02-unit-test-suite.log`](./02-unit-test-suite.log) | Node Test Suite (594 Tests) | `node --experimental-strip-types --test "tests/*.test.ts"` | 19.9s | **PASSED** |
| [`03-docker-test.log`](./03-docker-test.log) | Docker & Compose Security Boundary Tests | `node --experimental-strip-types --test tests/docker.test.ts` | 0.2s | **PASSED** |
| [`04-isolation-proof.log`](./04-isolation-proof.log) | Role Isolation & Refusal Proof (984 Requests) | `node --experimental-strip-types tools/prove-isolation.ts -- --check` | 3.1s | **PASSED** |
| [`05-normalization-proof.log`](./05-normalization-proof.log) | Bayesian Normalization Numerical Proof (1,180 Events) | `node --experimental-strip-types tools/prove-normalization.ts -- --check` | 6.7s | **PASSED** |
| [`06-convergence-proof.log`](./06-convergence-proof.log) | Pairwise Bradley-Terry Convergence Proof | `node --experimental-strip-types tools/prove-convergence.ts -- --check` | 1.6s | **PASSED** |
| [`07-roundtrip-proof.log`](./07-roundtrip-proof.log) | Database Archive Bit-for-Bit Roundtrip Proof | `node --experimental-strip-types tools/prove-roundtrip.ts -- --check` | 1.4s | **PASSED** |
| [`08-fixtures-proof.log`](./08-fixtures-proof.log) | Fixtures & Ballot Consistency Proof | `node --experimental-strip-types tools/prove-fixtures.ts -- --check` | 0.5s | **PASSED** |
| [`09-typecheck.log`](./09-typecheck.log) | Strict TypeScript Compiler Check | `node ./node_modules/typescript/bin/tsc --noEmit` | 0.4s | **PASSED** |

## Key Highlights

1. **Official Acceptance Harness (`run.py .dogfood.toml`)**:
   - 7 of 7 probes passing against live server.
   - T1 (Public submission gallery, project inspection, closed event enforcement) and T2 (Role isolation, peer review concealment, participant blocking, CSV export) claims verified.
   - See [`01-acceptance-dogfood.log`](./01-acceptance-dogfood.log).

2. **Full Node Test Suite (594 Tests)**:
   - 594 total tests declared across all sub-modules (`tests/*.test.ts`).
   - 593 passed, 0 failed, 1 skipped (live SMTP network delivery without mock).
   - Zero external testing frameworks: runs purely on Node 22 built-in test runner.
   - See [`02-unit-test-suite.log`](./02-unit-test-suite.log).

3. **Docker Security & Boundary Verification**:
   - Verified pinned Alpine base image digest, non-root execution, `cap_drop: ALL`, and `no-new-privileges`.
   - Validated one-command container test execution (`docker compose run --rm test`).
   - Validated air-gapped offline boundary (`compose.offline.yaml`).
   - See [`03-docker-test.log`](./03-docker-test.log).

4. **Architectural & Cryptographic Proofs**:
   - **Isolation**: 984 HTTP requests verifying strict role boundaries byte-for-byte ([`04-isolation-proof.log`](./04-isolation-proof.log)).
   - **Bayesian Normalization**: 1,180 simulated events across 59 configurations verifying numerical convergence ([`05-normalization-proof.log`](./05-normalization-proof.log)).
   - **Roundtrip**: 161 rows across 32 files verifying exact bit-for-bit database export/import integrity ([`07-roundtrip-proof.log`](./07-roundtrip-proof.log)).
   - **Strict Type Safety**: TypeScript compiler passes with 0 diagnostic errors ([`09-typecheck.log`](./09-typecheck.log)).

## Reproducing the Logs

Run the entire suite and refresh this directory with one command:

```sh
npm run test:logs
```

Or inside Docker:

```sh
docker compose run --rm test-all
```
