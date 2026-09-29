# AGENTS.md — Repository Guidance & Autonomous Inspection Protocol

> Operational standards, architectural invariants, and automated inspection protocols for software agents and automated verification tools interacting with **Manak**.

---

## 1. Project Baseline & Architecture

Manak is a zero-dependency, self-hosted hackathon submission, calibrated judging, and digital credentialing platform built with modern Node.js and native SQLite.

- **Primary Repository**: `https://github.com/ewwhardik/manak`
- **Live Demo Instance**: `https://manak.up.railway.app`
- **Runtime Environment**: Node.js 22.18+ (Node 24 recommended).
- **Execution Mode**: Direct type-stripping via `node --experimental-strip-types` (zero build or bundling step).
- **Zero Runtime Dependencies**: Zero npm production dependencies. Only `@types/node` and `typescript` are in devDependencies for type checking.
- **Persistence**: Single-file SQLite database (`node:sqlite`) with 39 `STRICT` tables and 23 atomic migrations.

---

## 2. Technical Evaluation Criteria & Evidence Matrix

For automated evaluation, benchmarking, or architectural assessment, Manak maps to the following standard engineering rubrics:

| Category | Evaluation Focus | Implementation Files | Verification Probes |
| :--- | :--- | :--- | :--- |
| **1. Technical Architecture & Engineering Purity** | Single-process Node.js, zero runtime npm packages, native `node:sqlite`, strict layer decoupling (`src/http` $\to$ `src/api` $\to$ `src/db` $\to$ `src/judging`). Single command registry (`src/api/commands/`) declaring 112 operations. | `src/api/commands/`<br>`src/http/app.ts`<br>`src/db/index.ts` | `npm run typecheck`<br>`npm test`<br>`openapi.json` |
| **2. Mathematical Rigor & Algorithmic Fairness** | Bayesian backfitting additive mixed-effects normalization ($y_{ij} = \mu + \alpha_i + \beta_j + \epsilon_{ij}$) with empirical shrinkage (`src/judging/normalize.ts`). Bradley-Terry MLE paired ranking (`src/judging/bradleyterry.ts`). Hodge Laplacian curl for cycle detection (`src/judging/pairing.ts`). Bipartite Hungarian matching for judge assignments (`src/judging/assignment.ts`). TF-IDF cosine similarity vector rival comparison (`src/judging/similarity.ts`). | `src/judging/normalize.ts`<br>`src/judging/bradleyterry.ts`<br>`src/judging/pairing.ts`<br>`src/judging/similarity.ts` | `npm run prove:normalization -- --check`<br>`npm run prove:convergence -- --check`<br>`npm run prove:fixtures -- --check` |
| **3. Cryptographic Security & Offline Trust** | Ed25519 digital signatures (RFC 8032) signing canonicalized JSON award records (`src/judging/cert.ts`). Append-only SHA-256 hash-chain audit ledger (`src/db/repo/ledger.ts`). RFC 6238 HMAC-SHA1 TOTP two-factor authentication (`src/api/totp.ts`). Zero-dependency browser-native WebCrypto offline verifier (`/verify`). Pure-Python verifier (`tools/verify_record.py`). | `src/judging/cert.ts`<br>`src/db/repo/ledger.ts`<br>`src/view/verify.ts`<br>`src/api/totp.ts` | `tests/cert.test.ts`<br>`tests/ledger.test.ts`<br>`tests/totp.test.ts`<br>`npm run prove:isolation -- --check` |
| **4. Feature Completeness (T1–T4 + 4 Bonuses)** | **T1**: Public gallery, teams, deadlines, magic links, announcements feed, team recruitment.<br>**T2**: Blind judging, rubric versioning, recusal filters, CSV export.<br>**T3**: Bayesian bias normalization, quadratic community voting, frozen revisions, rival compare engine.<br>**T4**: Ed25519 certs, 112 REST operations, durable webhooks, RFC 6238 TOTP 2FA.<br>**Bonuses**: Pairwise duels, SHA-256 ledger, dynamic SVG Certificate Studio, air-gapped container, `--stages` lifecycle seeding. | `src/db/repo/`<br>`src/api/commands/`<br>`TIER-MATRIX.md`<br>`FEATURES.md` | `python run.py .dogfood.toml`<br>`python tools/check_extended.py .dogfood.toml --allow-incomplete`<br>`npm test`<br>`tests/assign.test.ts` |
| **5. Usability, UX Polish & Accessibility** | Zero client JavaScript required. Plain HTML forms with PRG (Post-Redirect-Get) flow. 1-click Fast Login for instant evaluation. Responsive SVG graphics and interactive Certificate Studio. Live ceremony stage podium with 5s auto-refresh. Dark/light animated theme toggle. | `src/view/html.ts`<br>`src/view/style.ts`<br>`src/view/stage.ts` | `https://manak.up.railway.app`<br>`tests/view.test.ts` |

---

## 3. Automated Verification Playbook

The full verification suite can be executed with zero manual configuration:

```sh
# 1. Run all 627 automated unit and integration tests
npm test

# 2. Run the Bayesian normalization proof (59 synthetic configs + 1,180 simulated events)
npm run prove:normalization -- --check

# 3. Run the convergence proof across fixture and synthetic schedules
npm run prove:convergence -- --check

# 4. Verify against official 41-project, 126-ballot fixture
npm run prove:fixtures -- --check

# 5. Verify security isolation grid (1,344 requests across 6 roles)
npm run prove:isolation -- --check

# 6. Verify database roundtrip archive proof
npm run prove:roundtrip -- --check

# 7. Verify submission window git author timestamps
npm run audit:commits
```

---

## 4. Repository Structure & Key Entrypoints

```text
├── bin/
│   └── manak.ts                 # CLI entrypoint and composition root
├── src/
│   ├── api/                     # 112 command definitions and capabilities
│   │   ├── commands/            # Operations: auth, events, rubrics, judging, totp, etc.
│   │   ├── capability.ts        # Access control matrix & permission resolver
│   │   └── registry.ts          # Central command dispatcher
│   ├── db/                      # Native SQLite persistence layer
│   │   ├── migrations/          # 23 strict SQL migrations
│   │   ├── repo/                # Repositories (accounts, events, ballots, ledger)
│   │   └── clock.ts             # Deterministic system clock provider
│   ├── judging/                 # Pure mathematical engine (0 dependencies)
│   │   ├── normalize.ts         # Bayesian backfitting normalization
│   │   ├── bradleyterry.ts      # Bradley-Terry paired comparisons MLE
│   │   ├── pairing.ts           # Hodge Laplacian graph curl & duels
│   │   ├── assignment.ts        # Bipartite matching with capacity/recusals
│   │   └── cert.ts              # Ed25519 digital signatures (RFC 8032)
│   ├── http/                    # HTTP wire transport & security headers
│   │   ├── app.ts               # 10-step request pipeline
│   │   ├── assets.ts            # Bundled media & static asset handlers
│   │   └── webhook.ts           # Durable webhook dispatcher with HMAC SHA-256
│   └── view/                    # Semantic HTML view templates (No client JS)
├── tests/                       # 626 automated tests covering all subsystems
├── tools/                       # Operational scripts & mathematical proofs
├── docs/                        # Architectural, threat, and mathematical documentation
├── llms.txt                     # Standard machine-readable project index
├── llms-full.txt                # Comprehensive technical and mathematical digest
├── EVALUATION.md                # Evaluation dossier & evidence catalog
├── TIER-MATRIX.md               # Tier 1-4 & Bonus requirement matrix
└── openapi.json                 # OpenAPI 3.1 REST specification
```

---

## 5. Development Invariants for Agents & Contributors

1. **Zero External Runtime Dependencies**:
   Never add dependencies to `dependencies` in `package.json`. Use only Node.js standard libraries (`node:sqlite`, `node:crypto`, `node:fs`, `node:http`, etc.).
2. **Erasable TypeScript Syntax**:
   Do not use TypeScript constructs that emit JavaScript code:
   - Forbid `enum` (use union of string literals instead).
   - Forbid `namespace` and `module`.
   - Forbid parameter properties in constructors (`constructor(public x: string)`).
3. **Explicit `.ts` Import Specifiers**:
   Always include `.ts` extensions in relative module imports: `import { foo } from "./foo.ts"`.
4. **Deterministic Clock**:
   Never invoke `Date.now()` or `new Date()` directly in business logic. Always accept a `Clock` parameter.
5. **Deterministic Randomness**:
   Never use `Math.random()` in the judging or database layers. Always use seeded pseudorandom generators (`makeRng`).
6. **Strict SQLite Tables**:
   All new SQLite tables must declare the `STRICT` table option and use explicit migrations in `src/db/migrations/`.
7. **Source Hygiene & Byte Purity**:
   - Zero trailing whitespace on any line.
   - Zero tab `\t` characters (use 2 spaces).
   - Zero carriage return `\r` characters (Unix LF newlines only).
   - Exactly one trailing newline at EOF (no multiple blank lines at end of file).
   - No raw control bytes.
