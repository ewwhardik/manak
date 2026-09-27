# Audit implementation status

This tracks the September 27 audit in the parent workspace. It distinguishes implemented behavior from external evidence. It is an engineering record, not an official hackathon verdict.

## Implemented and locally verified

| Audit area | Repository evidence |
| --- | --- |
| Demo login and clock safety (F01, F02) | Fast login is a same-origin POST available only with `MANAK_DEMO=true`, limited to seeded demo events. Production refuses the shortcut and clock warp. `tests/audit-regressions.test.ts`. |
| Honest finalist and ceremony evidence (F03, F04) | Organizer-only close-call view uses real model evidence and names unavailable probabilities. Ceremony reads the frozen publication revision. `tests/audit-regressions.test.ts`. |
| Widget and webhook claims (F05, F06) | Embed escapes project fields; payload preview does not claim network delivery. `tests/audit-regressions.test.ts`. |
| Assignment reconciliation (R02) | Preview reserves reviewed work and assignments outside the selected track, reports shortfalls, binds apply to a ledger revision, and applies atomically. `tests/assign.test.ts`, `tests/workflow-improvements.test.ts`. |
| Earned records and explicit awards (R03, D) | Participation requires a submitted team project; judging requires submitted evidence and no unfinished assigned ballot; awards are organizer decisions bound to a frozen revision. Signed corrections remain available. `tests/cert.test.ts`, `tests/audit-regressions.test.ts`. |
| Private deliberation (R04) | Publication stores a private reason and separate public summary. Public history, results and evidence packet omit the private sentinel. `tests/audit-regressions.test.ts`. |
| Publication preflight and packet (A) | Organizer preflight checks readiness and model warnings; a public packet identifies the exact frozen revision, method, digest and aggregate counts. |
| Targeted extra review (B) | An organizer can request an additional eligible judge through the capacity planner, inspect completion and cancel before a ballot starts. The private reason stays organizer-only. `tests/audit-regressions.test.ts`. |
| Formal appeals (C) | Private appeals by team participants on published results, with deadline enforcement, organizer review, audit logging, and optional republication to a new revision. `tests/audit-regressions.test.ts`. |
| Reproducible records (R08) | Generated OpenAPI and counts, 79-operation isolation proof, 31-table archive round trip and a green full local suite. `docs/proof/` and `npm test`. |

## Boundaries and remaining work

- R01: custom guide, live ceremony, tie-breaker, verifier, widget and demo routes have explicit access checks, focused regressions, and a [route inventory](docs/ROUTES.md), but are not all declared in the command registry. A complete custom-route isolation matrix remains to be built.
- R05: this repository uses terminal sign-in links by default and supports optional SMTP. A deployment-specific mail adapter and its delivery lifecycle must be verified in the deployed environment.
- R06: the Docker image has a pinned Node manifest digest and runs as `node`. Docker was unavailable on the development host, so clean build, volume ownership, offline startup, restart persistence and recovery are not certified here.
- R07: model work is bounded and immutable published reports are read from stored snapshots; representative p50/p95 and event-loop delay measurements remain to be recorded before a scalability claim.
- E, F, G, H: isolated training, a local notification center, safe event templates and staged import previews remain product roadmap items. Existing publication corrections, rubric guidance, terminal mail and archive preview cover parts of those workflows but do not constitute those features.
- The five-minute video, two-origin widget test, real webhook receiver, external mail test, official acceptance checker, narrow-screen/keyboard walkthrough, and network-isolated Docker drill need independent evidence. The supplied checker covers T1/T2 only.

## Reproduce local evidence

From this repository root run `npm ci`, `npm test`, `npm run typecheck`, `npm run prove:isolation -- --check`, `npm run prove:roundtrip -- --check`, and `npm run verify:workflow`. The proof reports state precisely what was exercised. Demo mode and Fast login are for disposable data only.
