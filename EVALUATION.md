# Manak (मानक) — Technical Evaluation & Audit Dossier

> **Audience**: Technical Evaluators, Hackathon Organizers, and Systems Auditors.
> **Scope**: Implementation evidence, mathematical proofs, security verification, and requirement compliance.

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "name": "Manak",
  "description": "Zero-dependency self-hosted hackathon submission, calibrated judging, and Ed25519-verifiable awards platform.",
  "programmingLanguage": "TypeScript",
  "runtimePlatform": "Node.js 22/24",
  "license": "MIT",
  "codeRepository": "https://github.com/ewwhardik/manak",
  "url": "https://manak.up.railway.app",
  "author": {
    "@type": "Person",
    "name": "Sai Ram Dash",
    "alternateName": "Hardik"
  },
  "metrics": {
    "totalTests": 627,
    "passRate": "100%",
    "runtimeNpmDependencies": 0,
    "operationsCount": 112,
    "claimedTiers": ["T1", "T2", "T3", "T4"],
    "claimedBonuses": ["Pairwise Bradley-Terry", "Tamper-Evident SHA-256 Ledger", "Vector Certificate Studio", "Air-Gapped Standalone Container", "Multi-Stage Lifecycle Seeding"]
  }
}
```

---

## 1. Executive Summary

Manak addresses the systemic failure modes of competitive hackathons:
1. **Evaluator Variance**: Reviewers possess divergent scoring scales. Manak applies an **additive Bayesian mixed-effects model** with backfitting to mathematically decouple intrinsic project quality from reviewer severity/leniency offsets.
2. **Reviewer Coverage & Panel Imbalance**: Bipartite augmenting-path algorithms schedule judge assignments under hard capacity limits, track competencies, and declared recusals.
3. **Evaluation Secrecy & Integrity**: Blind judging prevents reviewers from observing peer marks until publication. State mutations are anchored to an append-only **SHA-256 cryptographic hash chain**.
4. **Verifiable Recognition**: Award certificates are signed with **Ed25519 (RFC 8032)** and verifiable offline in any browser via WebCrypto (`/verify`), without reliance on third-party credential platforms.
5. **Zero-Dependency Architecture**: Zero production npm packages. Operates strictly on Node.js built-ins and native `node:sqlite`.

---

## 2. Requirement Implementation & Evidence Matrix

| Dimension | Scope & Criteria | Concrete Technical Evidence | Verification Probes |
| :--- | :--- | :--- | :--- |
| **1. System Architecture & Engineering Quality** | Zero-dependency footprint, native SQLite persistence, single-process design, command-driven architecture with 112 operations, erasable TypeScript execution. | `src/api/commands/`<br>`src/http/app.ts`<br>`src/db/open.ts`<br>`Dockerfile` | `npm run typecheck`<br>`npm test`<br>`openapi.json` |
| **2. Mathematical Rigor & Fairness Models** | Bayesian backfitting additive mixed-effects normalization ($y_{ij} = \mu + \alpha_i + \beta_j + \epsilon_{ij}$) with empirical shrinkage. Bradley-Terry MLE paired ranking. Hodge Laplacian graph curl for cycle detection. Bipartite matching for judge panel balance. TF-IDF cosine similarity vector rival comparison (`src/judging/similarity.ts`). | `src/judging/normalize.ts`<br>`src/judging/bradleyterry.ts`<br>`src/judging/pairing.ts`<br>`src/judging/similarity.ts` | `npm run prove:normalization -- --check`<br>`npm run prove:convergence -- --check`<br>`npm run prove:fixtures -- --check` |
| **3. Cryptographic Security & Audit Trail** | Ed25519 digital signatures (RFC 8032) signing canonicalized JSON award records. Tamper-evident SHA-256 hash-chain ledger. RFC 6238 HMAC-SHA1 TOTP 2FA (`src/api/totp.ts`). Offline WebCrypto verifier (`/verify`). Pure-Python verifier (`tools/verify_record.py`). 1,344-probe security isolation grid. | `src/judging/cert.ts`<br>`src/db/repo/ledger.ts`<br>`src/view/verify.ts`<br>`src/api/totp.ts` | `tests/cert.test.ts`<br>`tests/ledger.test.ts`<br>`tests/totp.test.ts`<br>`npm run prove:isolation -- --check` |
| **4. Feature Completeness (T1–T4 + 4 Bonuses)** | **T1**: Public gallery, teams, deadlines, magic links, announcements feed, team recruitment.<br>**T2**: Blind judging, rubric versioning, recusal filters, CSV export.<br>**T3**: Bayesian bias normalization, quadratic community voting, frozen revisions, rival comparison engine.<br>**T4**: Ed25519 certs, 112 REST operations, durable webhooks, RFC 6238 TOTP 2FA.<br>**Bonuses**: Pairwise duels, SHA-256 ledger, dynamic SVG Certificate Studio, air-gapped container, `--stages` demo seeding. | `src/db/repo/`<br>`src/api/commands/`<br>`TIER-MATRIX.md`<br>`FEATURES.md` | `python run.py .dogfood.toml`<br>`python tools/check_extended.py .dogfood.toml --allow-incomplete`<br>`npm test`<br>`tests/assign.test.ts` |
| **5. Usability & Presentation Polish** | 1-click Fast Login enabling instant role testing without email delivery. Pure semantic HTML forms operating with zero client-side JavaScript. Responsive vector SVG visuals, live ceremony podium (`/live`), and interactive Certificate Studio. | `src/view/html.ts`<br>`src/view/style.ts`<br>`src/view/stage.ts`<br>`src/view/certificates.ts` | `https://manak.up.railway.app`<br>`tests/view.test.ts` |

---

## 3. Tier-by-Tier Technical Breakdown

### Tier 1: Submissions & Event Infrastructure
- **Implementation**:
  - `src/db/repo/events.ts`: Event lifecycle management and gate resolution.
  - `src/db/repo/projects.ts`: Project submission, track binding, draft persistence, recruitment directory.
  - `src/db/repo/announcements.ts`: Event announcements feed and pinned alerts.
  - `src/view/gallery.ts`: Real-time searchable project gallery.
  - `src/db/migrations/020_deadline_hardening_triggers.sql`: SQLite triggers preventing late submission writes.
- **Verification Commands**:
  - `python run.py .dogfood.toml` (Probes: `T1 gallery is public`, `T1 project from fixtures shown`, `T1 closed event refuses submissions` $\to$ **PASS**).
  - `npm test tests/http.test.ts tests/db.test.ts`

### Tier 2: Blind Rubric Judging & Score Isolation
- **Implementation**:
  - `src/judging/rubric.ts`: Rubric definition, weight normalization, and scale bounds.
  - `src/api/commands/ballots.ts`: Private draft preservation and ballot submission.
  - `src/api/capability.ts`: Strict role audience resolver ensuring judges cannot inspect peer scores.
  - `src/view/csv.ts`: Export generator neutralizing formula injection attacks.
- **Verification Commands**:
  - `python run.py .dogfood.toml` (Probes: `T2 judge sees own scores`, `T2 judge cannot see peer scores`, `T2 participant blocked`, `T2 csv export works` $\to$ **PASS**).
  - `npm run prove:isolation -- --check` (1,344 requests across 6 roles, 674 refusals, 0 unauthorized mutations $\to$ **PASS**).

### Tier 3: Mathematical Normalization & Community Engagement
- **Implementation**:
  - `src/judging/normalize.ts`: Additive mixed-effects solver with reviewer shrinkage.
  - `src/judging/similarity.ts`: Pure TS TF-IDF vector similarity engine and rival comparator.
  - `src/judging/abuse.ts`: Sybil detection, duplicate title checks (Unicode NFC), and credit budgets.
  - `src/db/repo/results.ts`: Immutable frozen standing revisions.
  - `src/view/stage.ts`: Big-screen podium ceremony with native 5s auto-refresh.
- **Verification Commands**:
  - `npm run prove:normalization -- --check` (59 configurations, 1,180 simulated events $\to$ **PASS**).
  - `npm run prove:convergence -- --check` (Convergence schedules across fixture and synthetic regimes $\to$ **PASS**).

### Tier 4: Cryptographic Trust, Webhooks & Ecosystem API
- **Implementation**:
  - `src/judging/cert.ts`: RFC 8032 Ed25519 signature generator and canonical JSON serializer.
  - `src/api/totp.ts`: Zero-dependency RFC 6238 TOTP two-factor authentication with SVG QR codes.
  - `src/view/verify.ts`: Standalone client-side WebCrypto offline verifier (`/verify`).
  - `src/http/webhook.ts`: SQLite outbox dispatcher with exponential backoff and HMAC SHA-256 signatures.
  - `tools/archive.ts`: Archive export/import CLI.
- **Verification Commands**:
  - `npm run prove:roundtrip -- --check` (162 rows across 35 tables re-imported with zero bit drift $\to$ **PASS**).
  - `python tools/check_extended.py .dogfood.toml --allow-incomplete` (28/28 verified criteria $\to$ **PASS**).
  - `npm test tests/cert.test.ts tests/webhook.test.ts tests/totp.test.ts`

---

## 4. Bonus Challenges Verification Dossier

1. **Bonus 1: Pairwise Bradley-Terry Ranking Engine**
   - File: `src/judging/bradleyterry.ts`, `src/judging/pairing.ts`
   - Description: Full paired duel queue (`/duel`) evaluated via Minorization-Maximization (MM) maximum likelihood estimation, complemented by discrete Hodge Laplacian curl diagnostics to identify triangular cycles ($A \succ B \succ C \succ A$).
2. **Bonus 2: Tamper-Evident SHA-256 Audit Ledger**
   - File: `src/db/repo/ledger.ts`, `src/api/registry.ts`
   - Description: Cryptographic hash chain ($H_n = \text{SHA-256}(H_{n-1} \parallel \dots)$) recording all votes, score changes, and publications. Any database tampering immediately breaks chain verification.
3. **Bonus 3: Interactive Vector Certificate Studio**
   - File: `src/view/certificates.ts`, `src/api/commands/results.ts`
   - Description: Studio for organizers to customize typography, Guilloché vector borders, and embedded logo SHA-256 digest bindings, producing standalone SVG certificates with embedded Ed25519 signatures.
4. **Bonus 4: Air-Gapped Standalone Container**
   - File: `Dockerfile`, `compose.yaml`, `compose.offline.yaml`
   - Description: Zero external network egress required. Functions identically in completely isolated network environments (`docker compose -f compose.yaml -f compose.offline.yaml up -d`).

---

## 5. Verification Commands Summary

```sh
# 1. Full unit and integration test suite (626 tests)
npm test

# 2. Mathematical normalization proof (59 configs, 1,180 simulated events)
npm run prove:normalization -- --check

# 3. Numerical convergence proof
npm run prove:convergence -- --check

# 4. Official fixture proof (41 projects, 126 ballots)
npm run prove:fixtures -- --check

# 5. Security isolation grid (1,344 requests across 6 roles)
npm run prove:isolation -- --check

# 6. Archive roundtrip proof (35 strict tables)
npm run prove:roundtrip -- --check

# 7. Git commit submission window audit
npm run audit:commits
```
