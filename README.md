<p align="center">
  <img src="src/view/assets/favicon.svg" width="128" height="128" alt="Manak Logo" />
</p>

<h1 align="center">Manak (मानक)</h1>
<p align="center">
  <b>Architected &amp; Built from Scratch by Sai Ram Dash (Hardik)</b><br>
  <i>The Standard for Fair Hackathon Submissions, Calibrated Judging &amp; Verifiable Results</i>
</p>

<p align="center">
  <a href="https://manak.up.railway.app"><img src="https://img.shields.io/badge/Live%20Demo-manak.up.railway.app-c4e886?style=flat-square&logo=railway&logoColor=202813" alt="Live Demo" /></a>
  <a href="https://github.com/ewwhardik/manak"><img src="https://img.shields.io/badge/GitHub-ewwhardik%2Fmanak-181717?style=flat-square&logo=github" alt="GitHub Repo" /></a>
  <img src="https://img.shields.io/badge/Version-0.1.0-blue?style=flat-square" alt="Version 0.1.0" />
  <img src="https://img.shields.io/badge/Node.js-22%20%7C%2024-green?style=flat-square&logo=node.js" alt="Node Version" />
  <img src="https://img.shields.io/badge/Tests-584%20passed-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/Dependencies-0%20runtime%20npm%20packages-success?style=flat-square" alt="0 Dependencies" />
  <img src="https://img.shields.io/badge/Storage-Native%20SQLite%20(1%20File)-orange?style=flat-square&logo=sqlite" alt="Native SQLite" />
  <img src="https://img.shields.io/badge/Cryptography-Ed25519%20%2B%20SHA--256%20Hash%20Chain-purple?style=flat-square" alt="Cryptography" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT License" /></a>
</p>

---

## Executive Summary for Evaluators

**Manak** (Sanskrit मानक, *"The Standard / Criterion / Benchmark"*) is a self-hostable, zero-runtime-dependency workspace for hackathon project submissions, calibrated peer/panel judging, and cryptographically verifiable results.

Most hackathons suffer from structural evaluation failures: reviewers have disparate scoring standards (harsh vs. lenient), judging panels leave blind spots across tracks, and final results lack a verifiable audit trail. Manak solves this from first principles:
- **0 runtime npm dependencies**: Built solely on Node.js built-ins and native Node SQLite.
- **Mathematical Fairness**: Normalizes reviewer leniency and severity using Bayesian Bradley-Terry and empirical shrinkage models with explicit uncertainty and sparse-panel limitations.
- **Cryptographic Trust**: Digitally signs awards with Ed25519 keys for offline browser verification (`/verify`), while a tamper-evident SHA-256 hash chain records every vote, score, and state change.
- **Accessible Core**: Every primary page and form operates seamlessly without client-side JavaScript.
- **Accountable Lifecycle**: From submission drafts to formal participant appeals with organizer review and frozen result republications.

---

## 60-Second Evaluation Walkthrough

Judges can test the entire platform either on the live deployment or locally in 60 seconds.

### Option A: Test on the Live Deployment (Instant)

Open **<https://manak.up.railway.app>** and use the **"Fast login"** menu in the top navigation bar to sign in as any role with one click:

| Step | Demo persona | What to inspect |
| --- | --- | --- |
| 1. Explore | Visitor | Open `/events`, choose Sample Hack 2026 or Dogfood, browse the project gallery and event schedule. |
| 2. Submit | Builder (`Priya Nair` / `Beatriz Lima`) | Open **My workspace** or team pages. See saved drafts, required submission fields, track filters, and server-enforced deadlines. |
| 3. Review | Judge (`Tomas Varga` / `Nils Berg`) | Open the judging queue, inspect the published rubric, save a draft, submit a ballot, or decide an eligible pairwise duel (`/duel`). Track limits, capacity, and recusal are strictly enforced. |
| 4. Decide | Organizer (`Rosa Iyer`) | Inspect the real-time **Organizer Dashboard** (`/events/sample-hack-2026/dashboard`), coverage diagnostics, judge progress, model caveats, and the assignment reconciliation preview. |
| 5. Finalist Shootout | Organizer | Open the **Finalist Tie-Breaker Assistant** (`/events/sample-hack-2026/tie-breaker`) to compare overlapping 95% confidence intervals and Bradley-Terry win probabilities. |
| 6. Stage Ceremony | Public / Stage | Open the **Live Ceremony Leaderboard** (`/events/sample-hack-2026/live`) for big-screen podium presentation with native 5s auto-refresh. |
| 7. Publish & Appeal | Organizer & Builder | Publish a frozen results revision. File a private team appeal (`/appeals`), review it as an organizer, and publish a corrected result revision. |
| 8. Award & Verify | Organizer & Recipient | Record explicit award decisions against the current publication revision, issue Ed25519 certificates, and verify signed JSON offline at `/verify`. |

The [evaluation guide](https://manak.up.railway.app/guide) in the running app links to each event surface. The [feature guide](FEATURES.md) and [tier evidence matrix](TIER-MATRIX.md) map the implementation to the challenge requirements.

### Option B: Run Locally (One Command, Zero Package Installs)

Requires Node.js 22.18+ (Node 24 recommended).

```sh
npm run start:demo
```

Open <http://localhost:8080>. The demo command seeds `data/demo.db` once and enables Fast login for evaluation personas.

- **Local / Repository Mode:** Without an external relay configured, sign-in magic links are printed directly to the server terminal, and the header's **Fast login** menu provides instant 1-click access to all roles.
- **Deployed Application (Railway):** Resend HTTPS delivery (`MANAK_RESEND_API_KEY`) is supported in hosted environments with a persistent queue beside the database. Under Resend sandbox mode (`onboarding@resend.dev`), Fast login provides instant 1-click access for all evaluators without requiring email receipt.

For an empty production deployment with Fast login disabled:

```sh
npm start
```

Set `MANAK_FOUNDERS` to the founder email list, `MANAK_PUBLIC_ORIGIN` to the HTTPS origin, and `MANAK_DATABASE` to a persistent path. Optional SMTP is described in [OPERATIONS.md](OPERATIONS.md). Never enable `MANAK_DEMO` on a production dataset.

---

## The Numbers

| Metric | Value | Verification Source |
| :--- | :--- | :--- |
| **Production npm dependencies** | **0** | `package.json` (zero runtime dependencies) |
| **Automated test suite** | **584** tests | `npm test` on native `node:test`; Windows skips one SIGTERM case |
| **Command declarations** | **79 operations** | `src/api/commands/index.ts` & `/api/openapi.json` |
| **Route inventory** | **79 operations** | Declared commands plus transport exceptions in `docs/ROUTES.md` |
| **Process architecture** | **1 process** | `bin/manak.ts` (single Node process, single SQLite writer) |
| **Database file** | **1 file** | Native Node SQLite (`data/manak.db`), strict schema, 31 tables, 13 migrations |
| **Cryptographic keys** | **Ed25519** | Elliptic-curve signed award records (`/.well-known/manak-key.pub`) |
| **Audit integrity** | **SHA-256** | Append-only hash-chained event ledger (`/api/healthz`) |

---

## Core Architectural Pillars

### 1. Dual-Mode Evaluation Engine
- **Mode 1: Pairwise Head-to-Head Duels (`/duel`)**: Instead of forcing judges to guess absolute numbers on arbitrary scales, evaluators make comparative choices between two projects. An active learning heuristic prioritizes pairings that bridge disconnected components and resolve uncertain ranking boundaries.
- **Mode 2: Criterion-Based Rubric Scoring (`/judging`)**: Evaluators grade assigned projects across weighted dimensions (Technical Execution, Innovation, Polish). Draft ballots are saved privately and can be resumed at any point prior to final submission.

### 2. Mathematical Normalization & Bias Correction
Human judges vary widely in calibration: some rate generously while others grade harshly. Manak incorporates additive judge-effect modeling and shrunk scale estimates to calculate reviewer offsets and adjust project standings accordingly. Panel composition and overlap still affect identifiability; correction cannot guarantee fairness.

### 3. Tamper-Evident SHA-256 Hash-Chain Audit Ledger
Every single mutation—ballot submission, score edit, rubric adjustment, invitation issuance, and results publication—appends a record to an immutable SHA-256 hash chain. Organizers and auditors can download the complete event ledger at any time as CSV (`/api/events/:slug/csv/audit`).

### 4. Offline Cryptographic Certificates (`/verify`)
Every issued certificate contains an Ed25519 digital signature generated with the organizer's private key. The in-browser verifier (`/verify`) executes local WebCrypto verification in offline mode without pinging or trusting the server.

### 5. Community Choice Quadratic Voting (`/voting`)
Community choice awards use quadratic voting with fixed credit budgets to mathematically dampen vote brigading and reflect genuine community consensus.

### 6. Real-Time Ceremony Leaderboard & Stage Podium (`/live`)
Built for auditorium projection during hackathon closing ceremonies:
- **Finalist Podium**: Gold, Silver, and Bronze cards with adjusted scores, confidence tiers, and rank shifts.
- **Native 5s Auto-Refresh**: Natively refreshes every 5 seconds via HTTP `<meta http-equiv="refresh">` (zero client-side JS, zero tracking, strict CSP).
- **Plain-English Explainer for Judges**: Translates Bayesian normalization, confidence tiers, and Merkle checkpoints into clear everyday language.
- **Live Stream API (`/api/events/:slug/live`)**: High-throughput JSON endpoint for live OBS overlays, external projectors, and mobile apps.

### 7. Finalist Tie-Breaker Assistant (`/events/:slug/tie-breaker`)
Tailored for hackathons where top finalists score within hundredths of a point (e.g. 4.92 vs 4.86) and deciding grand prize winners on raw decimal differences is statistical nonsense:
- **Head-to-Head Finalist Matchup**: Side-by-side shootout cards comparing 95% confidence intervals, ballot counts, and tracks.
- **Bradley-Terry Win Probability**: Computes exact pairwise likelihood $P(A \succ B) = \frac{1}{1 + e^{-(\theta_A - \theta_B)}}$.
- **3 Defensible Resolution Pathways**:
  1. *Lightning Tie-Break Duel*: Deploy a decisive pairwise comparison queue to senior judges.
  2. *Split-Prize Co-Champions*: Mathematically honest award defense under Wright & Masters separation strata.
  3. *Documented Organizer Rationale*: Qualitative review recorded directly into the tamper-evident audit ledger.

### 8. Formal Participant Appeals (`/appeals`)
Teams can file a private appeal within 7 days of publication. Messages remain strictly confidential to the appealing team and organizers. Organizers inspect evidence, log internal deliberations, and upon acceptance, atomically publish a corrected result revision with signed audit records.

---

## How the Result is Produced

1. A versioned, weighted rubric defines scoring criteria. Submitted ballots keep raw criterion scores and the rubric version they used. Draft ballots do not count.
2. The rubric model estimates project scores and judge effects with bounded iterative fitting, regularization, and sparse-evidence warnings. Panel overlap matters: normalization can reduce severity differences but cannot guarantee a fair ordering.
3. Pairwise duels use a separate Bradley–Terry model. Its beta values and modeled comparison probabilities are not rubric points or probabilities of deserving an award. Disconnected or nonconverged fits carry explicit caveats.
4. Coverage, connectivity, uncertainty, and close-call diagnostics help organizers decide when to request more evidence. An organizer can request an additional eligible review with a private reason. The organizer remains responsible for award decisions; the system does not silently turn a narrow decimal gap into a winner.
5. Publication stores a frozen report, rubric and algorithm options, evidence digest, ledger head, reason, and revision number. Later corrections append a revision; public reads use the stored report. An explicit award decision references one revision and one submitted project.

The [judging guide](JUDGING.md) describes the models and limits. [Proof reports](docs/proof/) cover synthetic recovery, convergence, isolation, and archive round trips. A SHA-256 hash chain makes later ledger mutation detectable when a trusted head is retained; it does not make a database physically immutable. Ed25519 signatures establish the issuer key and unchanged certificate bytes, not the truth of a submission or award.

---

## Architecture and Access

Manak has **79 operations** in the command registry. The same declarations drive API dispatch, access checks, browser forms, and OpenAPI generation. A few transport routes, including the guide, ceremony, verifier, widget, and demo shortcut, are separately covered by tests in the [route inventory](docs/ROUTES.md). JSON API routes live under `/api`; most browser pages use the corresponding path without that prefix. See [the architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT-MODEL.md), and `/api/openapi.json`.

| Layer | Responsibility |
| --- | --- |
| `src/db` | SQLite schema, migrations, transactions, event rules, publication snapshots, archive, certificate records, audit ledger |
| `src/judging` | Assignment, rubric normalization, pairwise fitting, uncertainty, diagnostics |
| `src/api` | Declared commands, fields, permissions, rate limits, response schemas |
| `src/view` | Server-rendered HTML, forms, accessible states; core workflows work without scripts |
| `src/mail` | RFC 5322 composition, SMTP client, resilient outbox, and hosted HTTPS delivery |
| `src/http` and `bin` | Request parsing, sessions, headers, transport-only routes, process lifecycle |

Roles are event scoped. A role in one event does not grant access to another. Public result routes refuse unpublished results; private judge and organizer evidence stays behind authorization. The exported archive contains sensitive data and must be protected like a database backup.

---

## Verify the Repository

Run the complete verification pipeline locally:

```sh
npm ci
npm test       # 584 tests
npm run typecheck
npm run prove:normalization -- --check
npm run prove:convergence -- --check
npm run prove:fixtures -- --check
npm run prove:isolation -- --check
npm run prove:roundtrip -- --check
npm run verify:workflow
```

- `npm ci` installs development types and TypeScript for `typecheck`; `npm start` does not install packages.
- The proof scripts compare mathematical convergence, isolation, and round trips against committed evidence in `docs/proof/`.
- One process-signal test is skipped on Windows; see the final test output for the exact count.
- The registry currently declares **79 operations**. Generated [OpenAPI](openapi.json) and the [browser API reference](https://manak.up.railway.app/docs) expose their current contracts. Run `npm run docs:generate` after adding commands or changing measured source counts.

---

## Deployment and Limits

`Dockerfile`, `compose.yaml`, and `railway.json` describe a one-port deployment. Persist the database and certificate key directory together. The Docker container runs securely with persistent volume permissions handled via `su-exec` to drop privileges to `node`.

The current UI uses linked HTTPS media rather than storing uploads. Search is case-insensitive substring matching. The organizer dashboard refreshes on reload; the ceremony page auto-refreshes. Large synchronous model fits may delay requests, so benchmark at the intended event size. Community abuse signals require human review. Certificate corrections are signed, append-only records; a verifier needs the trusted public key and current correction status.

---

## Complete Documentation Sitemap

- [FEATURE GUIDE](FEATURES.md) — Exhaustive matrix of all features, capabilities, routes, and limits.
- [ARCHITECTURE](docs/ARCHITECTURE.md) — Layer boundaries, isolation rules, and design trade-offs.
- [HTTP ROUTES](docs/ROUTES.md) — Complete inventory of transport routes outside the command registry.
- [DATA MODEL](DATA-MODEL.md) — Schema definitions, migrations, and archival structures.
- [JUDGING ENGINE](JUDGING.md) — Statistical models, Bradley-Terry formulas, and outlier diagnostics.
- [OPERATIONS](OPERATIONS.md) — Production deployment, durable webhooks, backups, and key rotation.
- [THREAT MODEL](docs/THREAT-MODEL.md) — Security boundaries, trust assumptions, and known constraints.
- [TIER MATRIX](TIER-MATRIX.md) — Feature matrix and evidence breakdown for hackathon tiers.
- [IMPLEMENTATION STATUS](IMPLEMENTATION-STATUS.md) — Audit completion status and locally verified claims.

---

## License & Authorship

Manak is open source software released under the [MIT License](LICENSE).  
Architected, engineered, and maintained by **Sai Ram Dash (Hardik)** ([nastik.me](https://nastik.me) · [@ewwhardik](https://github.com/ewwhardik)).
