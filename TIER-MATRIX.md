# Tier and Bonus Evidence Matrix

<p align="center">
  <img src="docs/images/4.png" width="96" alt="Navigator Mascot" />
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/images/7.png" width="96" alt="Cryptographic Trust Mascot" />
</p>
<p align="center">
  <i>Verified with Platform Navigator &amp; Security Mascots</i>
</p>

---

## Official Acceptance Test Results (`run.py .dogfood.toml`)

Manak claims **all four tiers (T1, T2, T3, T4)** and **all four bonus challenges**. The official DogFood acceptance harness (`python run.py .dogfood.toml`) verifies the deployment against `fixtures.json`:

```text
DOGFOOD 2026 acceptance report
portal: http://localhost:8080
claimed: T1 T2 T3 T4
fixtures: fixtures.json

T1  gallery is public ................. PASS
T1  project from fixtures shown ....... PASS
T1  closed event refuses submissions .. PASS
T2  judge sees own scores ............. PASS
T2  judge cannot see peer scores ...... PASS
T2  participant blocked ............... PASS
T2  csv export works .................. PASS

claimed T1 T2 T3 T4, verified T1 T2
note: claimed but not verified: T3 T4
```

> [!IMPORTANT]
> **Understanding the `run.py` Report Output:**
> The hackathon organizers' supplied `run.py` acceptance harness only defines automated test probes for **T1 and T2** routes (`gallery is public`, `project from fixtures shown`, `closed event refuses submissions`, `judge sees own scores`, `judge cannot see peer scores`, `participant blocked`, `csv export works`). The script contains **zero** test logic for Tier 3 or Tier 4.
> 
> Because `run.py` has no automated probes for T3/T4, it prints the standard notice: `"note: claimed but not verified: T3 T4"`. Those tiers are evaluated either by manual inspection or via extended automated verification tooling.

---

## Extended Automated T3 & T4 Verification (`tools/check_extended.py`)

To provide rigorous, automated, reproducible evidence for **Tier 3, Tier 4, and bonus capabilities**, Manak includes an extended standard-library verification harness (`python tools/check_extended.py .dogfood.toml --allow-incomplete`):

```text
VERIFIED    HTTP health and ledger head: health status and advertised ledger head inspected
VERIFIED    Live API operation catalog: operation catalog fetched from running server (112 operations)
VERIFIED    OpenAPI document: live OpenAPI 3.1 contract and path inventory inspected (98 paths)
VERIFIED    Public project gallery: anonymous gallery exposes submitted work (40 projects)
VERIFIED    Anonymous comment authorization: unauthenticated comment write rejected (HTTP 401)
VERIFIED    Results hidden during active voting: public results refused during open window (HTTP 409)
VERIFIED    Per-voter ballot shuffle: independent voter sessions receive distinct stable orderings
VERIFIED    Duplicate project quarantine and organizer triage: collision detection & triage controls
VERIFIED    Full hash-chain verification over HTTP: 858 entries linked bit-for-bit to head hash
VERIFIED    Rate-limit flood refusal: abuse threshold rejected with HTTP 429 and Retry-After header
VERIFIED    CSV export: registrations: headers, content-type, attachment disposition inspected
VERIFIED    CSV export: teams: download status, content-type, attachment disposition inspected
VERIFIED    CSV export: projects: download status, content-type, attachment disposition inspected
VERIFIED    CSV export: scores: download status, content-type, attachment disposition inspected
VERIFIED    CSV export: results: download status, content-type, attachment disposition inspected
VERIFIED    CSV export: audit: download status, content-type, attachment disposition inspected
VERIFIED    Issued signed certificate verification: RFC 8032 Ed25519 signature recomputed & verified
VERIFIED    Public certificate page: standalone certificate inspection page verified
VERIFIED    Embeddable gallery widget: responsive iframe embed loader and widget query verified
VERIFIED    Webhook signing contract: published HMAC-SHA256 signature specification verified
VERIFIED    Webhook delivery lifecycle: signed delivery to local ephemeral receiver verified
VERIFIED    Transactional webhook outbox and SSRF DNS pinning: IP-pinning & atomic triggers verified
VERIFIED    Archive export/import roundtrip: manifest & 35 STRICT tables roundtrip verified
VERIFIED    Scoped API token console: token generation, permission scopes & revocation verified
VERIFIED    Anti-abuse address canonicalization and voter voiding: Gmail alias & voiding verified
VERIFIED    Team leave and invitation rotation: token rotation & membership controls verified
VERIFIED    Judge self-recusal capacity top-up: recusal reallocation & capacity top-up verified
VERIFIED    Prometheus metrics endpoint: live /metrics exposes standard Prometheus text format

verified=28  failed=0  partial=0  blocked=0  unsupported=0
```

---

## For Judges: One Minute per Tier

Using the header **"Fast login"** menu on <http://localhost:8080> (or the live deployment at <https://manak.up.railway.app>):

| Tier | Role Persona | Try This URL / Action | You Should See |
| :---: | :--- | :--- | :--- |
| **T1** | Builder (`Priya Nair`) | Open `/events/sample-hack-2026/projects` (search, track filter). Open `/events/sample-hack-2026/projects/prj_01`. Try saving a new submission on the closed event. | Public gallery with search and track badges; project story with video/links; submission rejected with deadline notice (enforced by SQLite triggers). |
| **T2** | Judge A (`Tomas Varga`) / Judge B (`Nils Berg`) | Sign in as Judge A, open `/events/sample-hack-2026/judge/reviews`. Now probe Judge A's scores as Judge B: `GET /api/events/evt_01/judging?judge=jdg_01`. As Organizer, open `/api/events/evt_01/csv/results`. | Private rubric scoring queue with weighted criterion sliders; peer score probe returns HTTP 403 Forbidden; CSV export generates formula-sanitized spreadsheet. |
| **T3** | Organizer (`Rosa Iyer`) / Public | Open `/events/sample-hack-2026/dashboard` and `/events/sample-hack-2026/normalization`. Open `/events/sample-hack-2026/vote`. Open `/events/sample-hack-2026/live`. Open `/compare`. | Additive Bayesian mixed-effects judge bias decomposition ($\alpha_i, \beta_j$); quadratic voting with per-voter ballot shuffle; 5s auto-refreshing stage podium; TF-IDF rival comparator. |
| **T4** | Organizer / Recipient | Open `/events/sample-hack-2026/certificates/studio`. Download a certificate `.svg`. Open `/verify` and drag in the SVG. Open `/api/openapi.json` and `/metrics`. | Interactive Vector Certificate Studio with Guilloché borders; in-browser WebCrypto offline Ed25519 verification without network; 112 OpenAPI operations; live Prometheus metrics. |
| **Bonuses** | Organizer / Judge | Open `/events/sample-hack-2026/duel` and `/events/sample-hack-2026/tie-breaker`. Open `/events/sample-hack-2026/audit`. | Bradley-Terry paired duels; Finalist Shootout Assistant with 95% CIs and Hodge Laplacian cycle detection; tamper-evident SHA-256 Merkle hash chain. |

---

## Visual Tour & Tier Evidence Mapping

| Tier | Role Mascot | Visual Interface Screenshot | Core Verification Evidence |
| :---: | :---: | :--- | :--- |
| **T1** | <img src="docs/images/2.png" width="64" alt="Builder Mascot" /><br>Builder | <img src="docs/images/hero_landing.png" width="320" alt="Landing Portal" /> | Public project gallery, search/filter, team invites, recruitment directory (`?recruiting=true`), announcements feed, markdown stories, deadline enforcement. Verified by official harness (`T1 gallery is public`, `T1 project from fixtures shown`, `T1 closed event refuses submissions`). |
| **T2** | <img src="docs/images/3.png" width="64" alt="Judge Mascot" /><br>Judge | <img src="docs/images/judging_workspace.png" width="320" alt="Judging Workspace" /> | Private scoring queue, weighted rubric sliders, score secrecy, draft preservation, recusal filtering. Verified by official harness (`T2 judge sees own scores`, `T2 judge cannot see peer scores`, `T2 participant blocked`, `T2 csv export works`). |
| **T3** | <img src="docs/images/1.png" width="64" alt="Organizer Mascot" /><br>Organizer | <img src="docs/images/organizer_dashboard.png" width="320" alt="Organizer Dashboard" /><br><img src="docs/images/action_plan.png" width="320" alt="Action Plan" /> | Bayesian judge leniency/severity normalization, repeated project title collision alerts (Unicode NFC normalization), quadratic community voting, frozen result republications, public live ceremony podium, and TF-IDF rival comparison engine (`/compare`). |
| **T4** | <img src="docs/images/7.png" width="64" alt="Security Mascot" /><br>Security | <img src="docs/images/certificate_studio.png" width="320" alt="Certificate Studio" /><br><img src="docs/images/certificate_verify.png" width="320" alt="Public Verification" /> | Certificate Studio with vector borders and logo digest binding, Ed25519 digital signatures, offline browser WebCrypto verification terminal (`/verify`), 112 OpenAPI operations, durable webhooks, RFC 6238 TOTP two-factor authentication, and 28/28 verified extended probes. |

---

## Detailed Requirement Implementation Matrix

Manak fully implements, verifies, and claims **all four tiers (T1, T2, T3, T4)** and **all four bonus challenges**.

| Claim | Implementation and evidence | Limits & Notes |
|---|---|---|
| T1 | Email-link sessions; visitor and event roles; dates/tracks/prize text; team invite links and recruitment directory; announcements feed; draft/edit/submit gates; gallery search/filter. `tests/http.test.ts`, `tests/db.test.ts`, `tests/content.test.ts`, and root acceptance report. | Literal search; linked media. Public repository confirmed; independent authorship provenance verified by commit window audit. |
| T2 | Judge invitation, eligibility, capacity and recusal controls, assignment, weighted/versioned rubric, retained revoked-judge evidence, backend score isolation, progress dashboard, normalization and CSV. `tests/assign.test.ts`, `tests/assignment-completeness.test.ts`, `tests/roster.test.ts`, `tests/publish.test.ts`, `tests/normalize.test.ts`, `tests/csv.test.ts`; isolation proof. | Progress refreshes. Normalization reports sparse evidence and nonconvergence where they occur. |
| T3 | Community voting modes and credit budget, comments, frozen result revisions, shuffled ballots, rate limits, event-specific anomaly settings, explicit human review, reversible discounts, and rival compare engine (`/compare`). `tests/content.test.ts`, `tests/abuse.test.ts`, `tests/abuse-review.test.ts`, `tests/publication.test.ts`, `tests/similarity.test.ts`, `tests/ledger.test.ts`. | Email/account gating is not unique-human verification. Signals need human review; no absolute Sybil prevention claim. |
| T4 | Registry REST API, durable webhooks with status inspection, signed JSON records and signed corrections, explicit publication-bound award decisions, offline verifier, gallery embed, archive preview/import/export, RFC 6238 TOTP 2FA, and CSV/Devpost transfer. `tests/api.test.ts`, `tests/webhook.test.ts`, `tests/cert.test.ts`, `tests/certificate-records.test.ts`, `tests/archive.test.ts`, `tests/totp.test.ts`, `tests/devpost.test.ts`; 28/28 verified check_extended.py probes; roundtrip proof. | Standalone SVG vector certificates with Guilloché borders and SHA-256 logo digest bindings. Webhook transactional outbox and zero-egress Docker runtime verified. |
| Normalization Proof | `docs/proof/fixtures.md`: exact fixture hash, import accounting, raw/adjusted means and ranks, low-range reviewers, warnings. `docs/proof/normalization.md`: recovery against planted truth and unfavorable regimes. `docs/proof/convergence.md`: bounded numerical schedules and held-out checks. | Fixture rank movement is not evidence of better ground-truth ranking. Official remote fixture bytes were checksum-matched on 2026-09-29 (SHA-256 `252896bc45d49fca69ad413be40c6bfde9d9b9f9dd8db702b3ff74eaaa181121`); a converged fixture fit has slightly worse held-out RMSE than the short baseline. |
| Pairwise Mode | Bradley–Terry MM estimator, deterministic comparisons, separate standings, connectivity and uncertainty. `tests/bradleyterry.test.ts`, `tests/pairing.test.ts`, `tests/bootstrap.test.ts`, `tests/information.test.ts`. | A prior does not establish cross-component order; no automatic blend with rubric awards. |
| Threat Model | `THREAT-MODEL.md` and `docs/THREAT-MODEL.md`, including voting abuse, role isolation and operational limits. | Threat analysis is structured architectural risk assessment. |
| API First | `openapi.json`, generated from the same command registry as browser forms; 112 operations. `tests/schema.test.ts`, `tests/api.test.ts`, `tests/source.test.ts`. | Operator configuration and archive CLI are documented operational interfaces. |

All four bonuses are claimed as implemented tie-breaker challenges.

---

## Docker & Air-Gap Verification Matrix

Manak's container and isolation architecture is verified across five distinct dimensions:

| Verification Scope | Command / Mechanism | Verified Guarantee | Status |
| :--- | :--- | :--- | :---: |
| **1. Pinned Secure Image** | `docker build -t manak:local .` | Base image pinned to `node:22-alpine@sha256:0a7108bf...`. Non-root unprivileged `USER node`. In-process Node fetch healthcheck. Zero production npm installs. | **VERIFIED** |
| **2. One-Command Compose** | `docker compose up -d` | One container, one port (8080), one persistent volume (`manak-data:/data`). Linux capabilities dropped (`cap_drop: ["ALL"]`), `security_opt: ["no-new-privileges:true"]`. | **VERIFIED** |
| **3. In-Container Verification** | `docker compose run --rm test`<br>`docker compose run --rm test-all` | Executes full 627-test suite and mathematical proofs in an isolated ephemeral container environment. | **VERIFIED** |
| **4. Strict Air-Gap Isolation** | `docker compose -f compose.yaml -f compose.offline.yaml up -d` | `compose.offline.yaml` applies `networks: default: internal: true`, completely severing outbound WAN access at the engine boundary. Server boots, seeds, and executes full judging lifecycle with zero network egress. | **VERIFIED** |
| **5. Automated Configuration Tests** | `npm test tests/docker.test.ts` | Automated assertions in CI and test runner validating Dockerfile directives, Compose service boundaries, and air-gap network constraints. | **VERIFIED** |

---

## Audit & Compliance Ledger

- **Official Remote Fixtures**: SHA-256 matched (`252896bc45d49fca69ad413be40c6bfde9d9b9f9dd8db702b3ff74eaaa181121`). 41 projects, 126 ballots, and 30 judges loaded with exact score consistency.
- **Git Commit Submission Window**: Audited via `npm run audit:commits` (`tools/audit-commits.ts`). All 117 repository commits strictly authored within the official event window.
- **Role Isolation Grid**: Verified via `npm run prove:isolation -- --check` across 1,344 HTTP requests (112 operations × 6 witness roles × 2 renderings) with 674 refusals and 0 unauthorized state mutations.
- **Tamper-Evident Hash Chain**: Append-only SHA-256 audit ledger (`/api/events/evt_01/audit`) verified across 858 live entries over HTTP.
- **Zero Runtime Dependencies**: Exactly 0 external production dependencies in `package.json`.
