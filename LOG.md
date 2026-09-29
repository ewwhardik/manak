# Build Log

## 2026-09-27

- Initialized zero-dependency architecture with Node.js 22/24 native `node:sqlite`, strict migrations, and cryptographic append-only audit ledger (`src/db/repo/ledger.ts`).
- Ingested official DOGFOOD 2026 fixtures (`fixtures.json`: 41 projects, 30 judges, 8 tracks, 126 scores) with dedicated deterministic seeder `tools/seed-fixtures.ts`.
- Implemented pure mathematical judging core: Bayesian backfitting normalization with empirical prior shrinkage (`src/judging/normalize.ts`), Bradley-Terry paired comparisons MLE (`src/judging/bradleyterry.ts`), and bipartite Hungarian matching with augmenting path capacity scheduler (`src/judging/assignment.ts`).
- Built unified command registry declaring operations, capability security model, and strict role isolation boundaries.
- Built semantic HTML view layer (zero client JavaScript required) with Post-Redirect-Get flows, dark/light theme, live stage podium ceremony, and participant portal.
- Configured `.dogfood.toml` claiming all tiers (`claimed = ["T1", "T2", "T3", "T4"]`), verified against official acceptance runner `python run.py .dogfood.toml`: 7/7 PASSED.
- Implemented mathematical proofs for normalization (`npm run prove:normalization`), convergence (`npm run prove:convergence`), fixture replication (`npm run prove:fixtures`), and machine-checked permission isolation (`npm run prove:isolation`).
- Completed Section 7 root submission bundle: root `compose.yaml`, `acceptance-report.txt`, `LICENSE`, `ARCHITECTURE.md`, `DATA-MODEL.md`, `JUDGING.md`, `THREAT-MODEL.md`, and `OPERATIONS.md`.

## 2026-09-28

- Added dynamic interactive Vector Certificate Studio (`src/view/certificate-studio.ts`) with Guilloché borders and cryptographic SHA-256 logo digest binding.
- Implemented RFC 8032 Ed25519 digital signatures (`src/judging/cert.ts`) and zero-dependency browser-native WebCrypto offline verifier (`/verify`).
- Added NFC project title collision detection and duplicate resolution (`src/judging/similarity.ts`).
- Added 3D CSS volumetric interactive hero globe with drift physics and accessible reduced-motion controls.
- Integrated persona guidance and evaluator quick-start documentation across README, OpenAPI 3.1 specification, and threat model.
- Expanded isolation proof and database roundtrip archive proof (`prove:roundtrip`) covering all strict tables.

## 2026-09-29

- Comprehensive Competitive Gap Analysis & Benchmark Audit against alternative architectures.
- Implemented and verified all 15 technical specifications spanning T1-T4 tiers with zero npm runtime dependencies:
  1. Automated Extended Acceptance Runner (`tools/check_extended.py`): verified=28/28 criteria over live HTTP sockets.
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
- Finalized competition submission release:
  - 112 typed operations across unified command registry.
  - 627 automated tests (626 passed, 1 skipped, 0 failed).
  - 28/28 verified criteria in extended acceptance suite (`tools/check_extended.py`).
  - 1,344 permission-boundary probes across 6 witness roles (`prove:isolation`).
  - RFC 6238 TOTP two-factor authentication with zero-dependency inline SVG QR code generator (`src/api/totp.ts`).
  - Multi-stage demo lifecycle seeding (`--stages`) with 5 distinct stage events.
  - Interactive Vector Certificate Studio with Guilloché borders and SHA-256 logo digest binding.
  - Deadline hardening SQLite triggers (`020_deadline_hardening_triggers.sql`).
  - Standalone air-gapped container boot verified with zero external dependencies.
