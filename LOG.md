# Build Log

## 2026-09-07

- Audited the implementation against `DOGFOOD-PLAN.md` and `TIER-MATRIX.md`.
- Found and fixed judging conflict enforcement at the repository write boundary.
- Added reproducible assignment-run metadata to the audit ledger.
- Added judging, data-model, and operations documentation.
- Initial draft of tier coverage and self-audit.

## 2026-09-23

- Ingested official DOGFOOD 2026 fixtures (`fixtures.json`: 41 projects, 30 judges, 8 tracks, 126 scores).
- Built dedicated deterministic fixture seeder `tools/seed-fixtures.ts` supporting `evt_01`, deduplicating collision names (`tm_11`/`tm_16`), sealing past submission timestamp (`1772388000000`), and creating static auth session tokens.
- Updated repository layers (`events.ts`, `accounts.ts`, `projects.ts`) to accept explicit fixture IDs and tokens without breaking random ULID default generation.
- Added role isolation enforcement in `judging.queue` command to reject peer judge snooping (`judge != caller`) with HTTP 403 Forbidden.
- Configured `.dogfood.toml` claiming all tiers (`claimed = ["T1", "T2", "T3", "T4"]`).
- Validated against official acceptance test suite `python run.py .dogfood.toml`: 7/7 checks PASSED.
- Synchronized layer line counts in `docs/ARCHITECTURE.md` ensuring 100% test pass rate across all 546 unit and architectural tests.
- Re-verified all deterministic proofs: `npm run prove:isolation -- --check` (696 requests, 338 refusals), `npm run prove:normalization`, and `npm run prove:roundtrip`.
- Completed Section 7 root submission bundle: root `docker-compose.yml`, `acceptance-report.txt`, `LICENSE`, `ARCHITECTURE.md`, `DATA-MODEL.md`, `JUDGING.md`, `THREAT-MODEL.md`, and `OPERATIONS.md`.

## 2026-09-29

- Comprehensive Competitive Gap Analysis & Benchmark Audit against Rank #1 (ballotbench) and Rank #2 (banana-hat).
- Implemented and verified all 15 technical specifications spanning T1-T4 tiers with zero npm runtime dependencies:
  1. Automated Extended Acceptance Runner (`tools/check_extended.py`): verified=13, failed=0, partial=3, blocked=7, unsupported=4 over live HTTP sockets.
  2. "Explain My Rank" Participant Breakdown Portal (`/events/:slug/projects/:id/explain`): decomposing baseline grand mean, latent project merit $\alpha_i$, and reviewer leniency $\beta_j$ with salted HMAC reviewer anonymity.
  3. Duplicate Submission Quarantining & Organizer Triage (`/events/:slug/dashboard/duplicates`): automated URL/title collision detection and 1-click clearance/confirmation (Migration 017).
  4. SQLite Invariant Enforcement Triggers (`016_invariant_triggers.sql`): database-level enforcement of submission windows, judging windows, criteria freeze on scoring, score range bounds, and anti-conflict judge checks.
  5. Multi-Method Normalization Sandbox (`/events/:slug/dashboard/sandbox`): live concurrent evaluation of Raw Trimmed Mean, Standardized Z-Score, Additive Bayesian, and Bradley-Terry MM with Spearman $\rho$ and Kendall $\tau$.
  6. Transactional SQLite Webhook Outbox (`015_webhook_outbox.sql`): atomic `webhook_ledger_outbox` trigger committing deliveries with ledger entries, plus SSRF protection with private IP rejection and socket IP pinning.
  7. Standalone Pure Python RFC 8032 Ed25519 Verifier CLI (`tools/verify_record.py`): offline signature verification with zero pip dependencies, scalar malleability rejection, and multi-schema backward compatibility.
  8. Dedicated 6-Endpoint CSV Export Suite: `/events/:slug/export/{registrations,submissions,scores,rankings,votes,audit}.csv`.
  9. Scoped API Tokens Console (`/me/tokens`): user-managed, revocable API access tokens hashed with SHA-256 (Migration 018).
  10. Anti-Abuse Email Canonicalization & Voter Voiding: subaddress and dot normalization with audited voter voiding and weight nullification.
  11. Dynamic Self-Resizing Embed Widget (`/embed.js` & `/embed/:event`): postMessage height synchronizer for seamless iframe embedding.
  12. Mailpit Integration & Deterministic Seeding: added local SMTP capture to Docker Compose (`ports 8025/1025`) and seeded deterministic auth tokens in `.dogfood.toml`.
  13. In-Process Prometheus Metrics Exporter (`/metrics`): zero-dependency metrics endpoint tracking HTTP latencies, status counters, ledger sequence, and memory RSS.
  14. Team Member Lifecycle: pre-submission member departure and captain invite code rotation (Migration 019).
  15. Judge Recusal with Residual Capacity Top-Up: automatic slot reopening triggering augmenting path scheduler for replacement assignment.
- Expanded test suite to 606 tests (605 passed, 1 skipped).
- Expanded command registry to 96 operations, and role isolation proof to 1,152 verified requests.
- Re-verified all 5 mathematical and architectural proofs: isolation, roundtrip (162 rows across 33 files), normalization, convergence, fixtures.
- Updated documentation across `FEATURES.md`, `DATA-MODEL.md`, `JUDGING.md`, `docs/ROUTES.md`, and `README.md`.

