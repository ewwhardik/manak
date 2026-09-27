# Manak — hackathon submissions, judging, and accountable results

Manak is a self-hosted workspace for a complete hackathon: teams submit projects, eligible judges review them, organizers inspect evidence and publish results, and recipients verify signed records. It runs in one Node process with native SQLite and no production npm dependencies.

**For evaluators:** [Open the live demo](https://manak.up.railway.app), then use **Fast login** to switch among the seeded organizer, judge, and builder accounts. Fast login is available only when `MANAK_DEMO=true`; it creates disposable demo sessions and is disabled by default in a production start.

## What to inspect in five minutes

| Step | Demo persona | What to look for |
| --- | --- | --- |
| 1. Explore | Visitor | Open `/events`, choose Sample Hack 2026 or Dogfood, browse the project gallery and event schedule. |
| 2. Submit | Builder | Open **My workspace** or the event's team page. See a saved draft, required submission fields, and the server-enforced deadline. |
| 3. Review | Judge | Open the judging queue, inspect the published rubric, save a draft, submit a ballot, or decide an eligible pairwise duel. Track limits, capacity, and recusal are enforced on writes. |
| 4. Decide | Organizer | Inspect dashboard readiness, coverage, judge progress, model caveats, and the assignment preview before applying it. Previewed plans include retained scored assignments and existing cross-track load. |
| 5. Publish | Organizer, then visitor | Publish a frozen results revision. Compare the public leaderboard, history, and live ceremony. Private evidence-exclusion notes stay in organizer history; public history shows a separate summary. |
| 6. Award and verify | Organizer, then recipient | Record explicit award decisions against the current publication revision, issue certificates for earned participation, completed judging, and declared awards, then verify the signed JSON at `/verify`. |

The [evaluation guide](https://manak.up.railway.app/guide) in the running app links to each event surface. The [feature guide](FEATURES.md) and [tier evidence matrix](TIER-MATRIX.md) map the implementation to the challenge requirements. Claims in this README describe code behavior; external checker acceptance requires its own evidence.

## Local start

Requires Node.js 22.18 or later. Node 24 was used for the local test run.

```sh
npm run start:demo
```

Open <http://localhost:8080>. The demo command seeds `data/demo.db` once and enables five Fast login personas: organizer Rosa, Sample Hack judge Tomas, Dogfood judge Nils, Sample Hack builder Priya, and Dogfood builder Beatriz. The shortcut is a same-origin POST, limited to the seeded demo events. Demo accounts can exercise the real UI and API permissions for their assigned roles.

For an empty deployment with Fast login disabled:

```sh
npm start
```

Set `MANAK_FOUNDERS` to the founder email list, `MANAK_PUBLIC_ORIGIN` to the HTTPS origin, and `MANAK_DATABASE` to a persistent path. By default, passwordless sign-in links are printed to the terminal, so protect its logs. Optional SMTP is described in [OPERATIONS.md](OPERATIONS.md). Never enable `MANAK_DEMO` on a production dataset.

## How the result is produced

1. A versioned, weighted rubric defines scoring criteria. Submitted ballots keep raw criterion scores and the rubric version they used. Draft ballots do not count.
2. The rubric model estimates project scores and judge effects with bounded iterative fitting, regularization, and sparse-evidence warnings. Panel overlap matters: normalization can reduce severity differences but cannot guarantee a fair ordering.
3. Pairwise duels use a separate Bradley–Terry model. Its beta values and modeled comparison probabilities are not rubric points or probabilities of deserving an award. Disconnected or nonconverged fits carry explicit caveats.
4. Coverage, connectivity, uncertainty, and close-call diagnostics help organizers decide when to request more evidence. An organizer can request an additional eligible review with a private reason. The organizer remains responsible for award decisions; the system does not silently turn a narrow decimal gap into a winner.
5. Publication stores a frozen report, rubric and algorithm options, evidence digest, ledger head, reason, and revision number. Later corrections append a revision; public reads use the stored report. An explicit award decision references one revision and one submitted project.

The [judging guide](JUDGING.md) describes the models and limits. [Proof reports](docs/proof/) cover synthetic recovery, convergence, isolation, and archive round trips. A SHA-256 hash chain makes later ledger mutation detectable when a trusted head is retained; it does not make a database physically immutable. Ed25519 signatures establish the issuer key and unchanged certificate bytes, not the truth of a submission or award.

## Architecture and access

Manak has **76 operations** in the command registry. The same declarations drive API dispatch, access checks, browser forms, and OpenAPI generation. A few transport routes, including the guide, ceremony, verifier, widget, and demo shortcut, are separately covered by tests and documented as exceptions. JSON API routes live under `/api`; most browser pages use the corresponding path without that prefix. See [the architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT-MODEL.md), and `/api/openapi.json`.

| Layer | Responsibility |
| --- | --- |
| `src/db` | SQLite schema, migrations, transactions, event rules, publication snapshots, archive, certificate records, audit ledger |
| `src/judging` | Assignment, rubric normalization, pairwise fitting, uncertainty, diagnostics |
| `src/api` | Declared commands, fields, permissions, rate limits, response schemas |
| `src/view` | Server-rendered HTML, forms, accessible states; core workflows work without scripts |
| `src/http` and `bin` | Request parsing, sessions, headers, transport-only routes, process lifecycle |

Roles are event scoped. A role in one event does not grant access to another. Public result routes refuse unpublished results; private judge and organizer evidence stays behind authorization. The exported archive contains sensitive data and must be protected like a database backup.

## Verify the repository

```sh
npm ci
npm test # 581 tests
npm run typecheck
npm run prove:normalization -- --check
npm run prove:convergence -- --check
npm run prove:fixtures -- --check
npm run prove:isolation -- --check
npm run prove:roundtrip -- --check
npm run verify:workflow
```

`npm ci` installs development types and TypeScript for `typecheck`; `npm start` does not install packages. The tests include role isolation, assignment capacity and retained work, private publication notes, certificates, archive restore, and demo login refusal when disabled. The supplied challenge checker exercises only part of the tier matrix. One process-signal test is skipped on Windows; see the final test output for the exact count.

The registry currently declares **76 operations**. Generated [OpenAPI](openapi.json) and the [browser API reference](https://manak.up.railway.app/docs) expose their current contracts. Run `npm run docs:generate` after adding commands or changing measured source counts.

## Deployment and limits

`Dockerfile`, `compose.yaml`, and `railway.json` describe a one-port deployment. Persist the database and certificate key directory together. The Docker image runs as the unprivileged `node` user. A clean Docker build, network-isolated startup, host restart, and volume ownership still need verification on a Docker-enabled host; the local development host used for this work does not have Docker.

The current UI uses linked HTTPS media rather than storing uploads. Search is case-insensitive substring matching. The organizer dashboard refreshes on reload; the ceremony page can auto-refresh. Large synchronous model fits may delay requests, so benchmark at the intended event size. Community abuse signals require human review. Certificate corrections are signed, append-only records; a verifier needs the trusted public key and current correction status.

See [OPERATIONS.md](OPERATIONS.md) for backup, restore, webhook, key, and offline procedures; [DATA-MODEL.md](DATA-MODEL.md) for schema; and [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) for audit completion and outstanding external evidence.

## License

MIT. Created by [Sai Ram Dash (Hardik)](https://nastik.me).
