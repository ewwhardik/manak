# Audit implementation status

The September 27 engineering audit in the parent workspace was used as a task list. This file travels with the standalone Manak repository; it records what the repository now implements and which claims still need external evidence. It is not an official judge decision.

## Implemented in this repository

| Audit finding | Implementation and local evidence |
| --- | --- |
| Mutable public results | `result_publication` stores versioned reports, model options, evidence digest and ledger head. Public results and CSV read frozen revisions; corrections require a reason and retain history. `tests/publication.test.ts`. |
| Revoked judge evidence | Inactive membership removes access while retaining assignments, ballots and comparisons. An explicit reasoned exclusion changes a later publication. `tests/roster.test.ts` and `tests/publication.test.ts`. |
| Numerical convergence | Bounded defaults and finite fallback, fixture/synthetic schedule comparison, held-out RMSE and planted-truth recovery. `docs/proof/convergence.md`, `docs/proof/fixtures.md`, and `tests/normalize.test.ts`. |
| Judge roster | Per-event track eligibility, capacity and recusal are persisted, previewed and enforced for assignment and ballot writes. `tests/roster.test.ts`. |
| Certificate correction | Stable key IDs, publication binding and signed revoke/supersede records; the offline verifier requires a trusted key and can check a correction bundle. `tests/certificate-records.test.ts`. |
| Abuse review | Event thresholds, explicit review states and audited discounts preserve raw votes. Benign shared-network fixture prevents treating similarity as a verdict. `tests/abuse-review.test.ts`. |
| Operator recovery | Archive preview, 28-table round-trip proof and read-only webhook status. `docs/proof/roundtrip.md`, `tests/archive.test.ts` and `tests/evidence-lab.test.ts`. |
| Workflow and accessibility polish | Gallery, submission, invite, judging, voting, organizer and result copy/interaction improvements; visible skip-link focus and responsive layout. Browser checks cover narrow pages and accessibility-tree labels; a full screen-reader pass remains external. |
| Maintainability | Report builders extracted from the results command module, redundant style tokens removed, generated OpenAPI and documentation inventories refreshed. |

## Evidence still needed outside this workspace

- Build and run Docker on a Docker-enabled host without network access, restart the host and container, and record persistence, key identity, archive recovery and failure drills. The development host had no Docker.
- Confirm the bundled fixture checksum with the organizer's official download. The local fixture digest alone establishes only byte identity among bundled copies.
- Supply a public Git repository URL and evidence that the submitted code was written during the authorized event window. This workspace has no Git metadata.
- Record and link the required five-minute lifecycle video. The repository includes a script, not a completed video.
- Exercise SMTP and webhook delivery with controlled external receivers and complete a manual keyboard and screen-reader pass across all roles.

The supplied checker verifies T1/T2 only. The local proof and test suite support the broader implementation claims but do not replace official acceptance.
