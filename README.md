<p align="center">
  <img src="src/view/assets/favicon.svg" width="128" height="128" alt="Manak Logo" />
</p>

<h1 align="center">Manak (मानक)</h1>
<p align="center">
  <b>Architected &amp; Built from Scratch by Sai Ram Dash (Hardik)</b><br>
  <i>The Standard for Fair Hackathon Submissions, Calibrated Judging &amp; Auditable Results</i>
</p>

<p align="center">
  <a href="https://manak.up.railway.app"><img src="https://img.shields.io/badge/Live%20Demo-manak.up.railway.app-c4e886?style=flat-square&logo=railway&logoColor=202813" alt="Live Demo" /></a>
  <a href="https://github.com/ewwhardik/manak"><img src="https://img.shields.io/badge/GitHub-ewwhardik%2Fmanak-181717?style=flat-square&logo=github" alt="GitHub Repo" /></a>
  <img src="https://img.shields.io/badge/Version-0.1.0-blue?style=flat-square" alt="Version 0.1.0" />
  <img src="https://img.shields.io/badge/Node.js-22%20%7C%2024-green?style=flat-square&logo=node.js" alt="Node Version" />
  <img src="https://img.shields.io/badge/Tests-570%2F570%20Passed%20(100%25)-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/Dependencies-0%20npm%20packages-success?style=flat-square" alt="0 Dependencies" />
  <img src="https://img.shields.io/badge/Storage-Native%20SQLite%20(1%20File)-orange?style=flat-square&logo=sqlite" alt="Native SQLite" />
  <img src="https://img.shields.io/badge/Cryptography-Ed25519%20%2B%20SHA--256%20Merkle-purple?style=flat-square" alt="Cryptography" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT License" /></a>
</p>

---

## 🌟 Executive Summary for Judges

**Manak** (Sanskrit मानक, *"The Standard / Criterion / Benchmark"*) is a self-hostable, zero-dependency workspace for hackathon project submissions, calibrated peer/panel judging, and cryptographically verifiable results.

Most hackathons suffer from structural evaluation failures: reviewers have disparate scoring standards (harsh vs. lenient), judging panels leave blind spots across tracks, and final results lack a verifiable audit trail. Manak solves this from first principles:
- **0 production npm dependencies**: Built solely on Node.js built-ins and native Node SQLite.
- **Mathematical Fairness**: Normalizes reviewer leniency and severity using Bayesian Bradley-Terry and empirical shrinkage models so no team wins or loses due to reviewer luck.
- **Cryptographic Trust**: Digitally signs awards with Ed25519 keys for offline browser verification (`/verify`), while an immutable SHA-256 Merkle ledger records every vote, score, and state change.
- **Accessible Core**: Every primary page and form operates seamlessly without client-side JavaScript.

---

## ⚡ 60-Second Fast-Track Evaluation Walkthrough

Judges can test the entire platform either on the live deployment or locally in 60 seconds.

### Option A: Test on the Live Deployment (Instant)

Open **<https://manak.up.railway.app>** and use the **"Fast login"** menu in the top navigation bar to assume any role with one click (no email or token required):

1. 👑 **Organizer Persona (`Rosa Iyer`)**:
   - Inspect the real-time **Organizer Dashboard** (`/events/sample-hack-2026/dashboard` or `/events/dogfood/dashboard`) showing live review coverage, judge participation rates, and bottleneck alerts.
   - View **Rubric Management** (`/events/sample-hack-2026/rubric`) and **Judges Roster** (`/events/sample-hack-2026/judges`).
   - Open **Final Results & Certificates** (`/events/dogfood/results`) and **Statistical Confidence Diagnostics** (`/events/dogfood/results/confidence`).
2. ⚖️ **Judge Persona (`Tomas Varga` / `Nils Berg`)**:
   - Test **Pairwise Duels** (`/events/dogfood/duel`): Side-by-side head-to-head project comparisons driven by active learning.
   - Test **Rubric Scoring Queue** (`/events/sample-hack-2026/judging`): Multi-criteria scoring with private draft auto-saving.
3. 🛠️ **Builder Persona (`Beatriz Lima`)**:
   - Browse the **Project Gallery** (`/events/sample-hack-2026/projects`) with 1-click track filter pills and demo video showcases.
   - Manage the **Team Workspace** (`/events/sample-hack-2026/teams`).
4. 📺 **Real-Time Ceremony Leaderboard (`/events/sample-hack-2026/live`)**:
   - Big-screen projector mode with 🥇 Gold, 🥈 Silver, and 🥉 Bronze podium presentation, native 5s auto-refreshing (zero client-side JavaScript), and plain-English explainers for judges and spectators.
5. 🎯 **Finalist Tie-Breaker Assistant (`/events/sample-hack-2026/tie-breaker`)**:
   - Solves the critical 72-hour online hackathon dilemma when top finalists share Tier 1 (e.g. 4.92 vs 4.86).
   - Side-by-side matchup cards, Bradley-Terry pairwise win probability ($P(A \succ B)$), criterion-by-criterion deep dive, and 3 defensible resolution pathways (lightning tie-break duel, split prize co-champions, or audited organizer judgment).
6. 🔐 **Offline Cryptographic Verifier (`/verify`)**:
   - Test the standalone Ed25519 certificate verifier powered by local WebCrypto. Auto-load the server's public key with 1 click to verify award certificates offline.
7. 🗺️ **Platform Guide & Sitemap (`/guide`)**:
   - Interactive platform roadmap and direct-jump directory covering all operational routes.

### Option B: Run Locally (One Command, Zero Package Installs)

Requires Node 22.18+ (Node 24 recommended).

```sh
npm run start:demo
```

Open <http://localhost:8080>. The demo automatically initializes `data/demo.db` and seeds the official **Sample Hack 2026** and **Dogfood Invitational** events.

- **Local / Repository Mode:** Without an external relay configured, sign-in magic links are printed directly to the server terminal, and the header's **Fast login** menu provides instant 1-click access to all roles.
- **Deployed Application (Railway):** Resend HTTPS REST API delivery (`MANAK_RESEND_API_KEY`) is used exclusively in the deployed web application because cloud container hosts restrict outbound SMTP ports (25, 465, 587). Under Resend sandbox mode (`onboarding@resend.dev`), emails are delivered to the owner (`sairamdash17@gmail.com`), while Fast login provides instant 1-click access for all evaluators without requiring email receipt.

---

## 📊 The Numbers

| Metric | Value | Verification Source |
| :--- | :--- | :--- |
| **Production npm dependencies** | **0** | `package.json` (zero runtime dependencies) |
| **Automated test suite** | **570** tests | `npm test` on native `node:test` (100% pass) |
| **Command declarations** | **69 operations** | `src/api/commands/index.ts` & `/api/openapi.json` |
| **Unified route handlers** | **69 handlers** | Same server-side capability matrix for API and HTML |
| **Process architecture** | **1 process** | `bin/manak.ts` (single Node process, single SQLite writer) |
| **Database file** | **1 file** | Native Node SQLite (`data/manak.db`), zero server daemons |
| **Cryptographic keys** | **Ed25519** | Elliptic-curve signed award records (`/.well-known/manak-key.pub`) |
| **Audit integrity** | **SHA-256** | Append-only Merkle-style event ledger (`/api/healthz`) |

---

## 🏛️ Core Architectural Pillars

### 1. Dual-Mode Evaluation Engine
- **Mode 1: Pairwise Head-to-Head Duels (`/duel`)**: Instead of forcing judges to guess absolute numbers on arbitrary scales, evaluators make comparative choices between two projects. An active learning heuristic prioritizes pairings that bridge disconnected components and resolve uncertain ranking boundaries.
- **Mode 2: Criterion-Based Rubric Scoring (`/judging`)**: Evaluators grade assigned projects across weighted dimensions (Technical Execution, Innovation, Polish). Draft ballots are saved privately and can be resumed at any point prior to final submission.

### 2. Mathematical Normalization & Bias Correction
Human judges vary widely in calibration: some rate generously while others grade harshly. Manak incorporates Bayesian Bradley-Terry modeling and empirical shrinkage to calculate each judge's severity/leniency offset and adjust project standings accordingly. Teams receive a fair assessment regardless of panel composition.

### 3. Tamper-Evident SHA-256 Merkle Audit Ledger
Every single mutation—ballot submission, score edit, rubric adjustment, invitation issuance, and results publication—appends a record to an immutable SHA-256 hash chain. Organizers and auditors can download the complete event ledger at any time as CSV (`/api/events/:slug/results/audit.csv`).

### 4. Offline Cryptographic Certificates (`/verify`)
Every issued certificate contains an Ed25519 digital signature generated with the organizer's private key. The in-browser verifier (`/verify`) executes local WebCrypto verification in offline mode without pinging or trusting the server.

### 5. Community Choice Quadratic Voting (`/voting`)
Community choice awards use quadratic voting with fixed credit budgets to mathematically dampen vote brigading and reflect genuine community consensus.

### 6. Real-Time Ceremony Leaderboard & Stage Podium (`/live`)
Built for auditorium projection during hackathon closing ceremonies:
- **Finalist Podium**: 🥇 Gold, 🥈 Silver, and 🥉 Bronze cards with adjusted scores, confidence tiers, and rank shifts.
- **Native 5s Auto-Refresh**: Natively refreshes every 5 seconds via HTTP `<meta http-equiv="refresh">` (zero client-side JS, zero tracking, strict CSP).
- **Plain-English Explainer for Judges**: Translates Bayesian normalization, confidence tiers, and Merkle checkpoints into clear everyday language.
- **Live Stream API (`/api/events/:slug/live`)**: High-throughput JSON endpoint for live OBS overlays, external projectors, and mobile apps.

### 7. Finalist Tie-Breaker Assistant (`/events/:slug/tie-breaker`)
Tailored for 72-hour online hackathons where top finalists often score within hundredths of a point (e.g. 4.92 vs 4.86) and deciding grand prize winners on raw decimal differences is statistical nonsense:
- **Head-to-Head Finalist Matchup**: Side-by-side shootout cards comparing 95% confidence intervals, ballot counts, and tracks.
- **Bradley-Terry Win Probability**: Computes exact pairwise likelihood $P(A \succ B) = \frac{1}{1 + e^{-(\theta_A - \theta_B)}}$.
- **3 Defensible Resolution Pathways**:
  1. *Lightning Tie-Break Duel*: Deploy a decisive pairwise comparison queue to senior judges.
  2. *Split-Prize Co-Champions*: Mathematically honest award defense under Wright & Masters separation strata.
  3. *Documented Organizer Rationale*: Qualitative review recorded directly into the tamper-evident audit ledger.

---

## 🧪 Verification & Proof Harnesses

Run the complete verification pipeline locally:

```sh
npm ci
npm test       # 569 tests
npm run typecheck
npm run prove:normalization -- --check
npm run prove:convergence -- --check
npm run prove:fixtures -- --check
npm run prove:isolation -- --check
npm run prove:roundtrip -- --check
npm run verify:workflow
```

- `npm ci` is needed only for the TypeScript development typechecker (`tsc`), never for running the application or test suite.
- The proof scripts compare mathematical convergence and isolation against committed evidence in `docs/proof/`.
- [acceptance-report.txt](acceptance-report.txt) records the supplied checker's local T1/T2 results.

---

## 📖 Complete Documentation Sitemap

- [FEATURE GUIDE](FEATURES.md) — Exhaustive matrix of all features, capabilities, routes, and limits.
- [ARCHITECTURE](docs/ARCHITECTURE.md) — Layer boundaries, isolation rules, and design trade-offs.
- [DATA MODEL](DATA-MODEL.md) — Schema definitions, migrations, and archival structures.
- [JUDGING ENGINE](JUDGING.md) — Statistical models, Bradley-Terry formulas, and outlier diagnostics.
- [OPERATIONS](OPERATIONS.md) — Production deployment, durable webhooks, backups, and key rotation.
- [THREAT MODEL](docs/THREAT-MODEL.md) — Security boundaries, trust assumptions, and known constraints.
- [TIER MATRIX](TIER-MATRIX.md) — Feature matrix and evidence breakdown for hackathon tiers.

---

## ⚖️ Current Limits & Technical Truths

Media attachments are linked via external HTTPS URLs rather than stored locally. Event custom questions are text fields. Project search uses case-insensitive substring matching. The organizer dashboard updates on demand or page reload; it does not maintain an open socket. Community abuse flags require human organizer review. Certificates are signed JSON payloads; corrections are append-only status records checked against an independently trusted public key. Public standings reflect frozen versioned revisions, while organizer diagnostics reflect live submitted evidence. Docker, SMTP delivery, and demonstration video assets are configured as external deployment options.

---

## 📜 License & Authorship

Manak is open source software released under the [MIT License](LICENSE).  
Architected, engineered, and maintained by **Sai Ram Dash (Hardik)** ([nastik.me](https://nastik.me) · [@ewwhardik](https://github.com/ewwhardik)).
