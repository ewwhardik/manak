# Manak

Manak is a self-hosted hackathon portal. An organizer can set up an event, teams can submit projects, judges can review assigned work, and the organizer can publish results with an audit trail. The app runs as one Node process with a SQLite database. Its core pages work without browser JavaScript.

This repository is a working implementation and a hackathon submission target. Local tests show what the code does. The supplied acceptance checker passes all seven probes; it only verifies T1/T2. T3/T4 and all four bonus claims have separate evidence in [TIER-MATRIX.md](TIER-MATRIX.md) and are not official awards.

## Try the full workflow

Use Node 22.18 or newer. Node 24 was used for local validation.

```sh
npm run start:demo
```

Open <http://localhost:8080>. The demo creates `data/demo.db` on first run and keeps existing data on later runs. Sign in as `rosa@example.com` for organizer tools. Use `nils@example.com`, `amara@example.com`, or `kenji@example.com` for judge tools. If SMTP is not configured, the sign-in link appears in the server terminal. A person who can read that terminal can use the link, so this mode is for local demos only.

To run the container, use `docker compose up --build` from this repository root. Docker startup has not been checked on the development host. Build the image before an offline demonstration.

## What to show a judge

1. Open an event and follow its submission and judging dates. Browse the project gallery and filters.
2. Sign in as a participant. Join a team, create a project draft, add its story and links, then submit it before the deadline.
3. Sign in as a judge. Open the assigned queue, save a rubric ballot as a draft, submit it, and make a pairwise choice when that mode is enabled.
4. Sign in as Rosa. Check review coverage and readiness, inspect private diagnostics, then publish results after the required windows close.
5. Open `/docs` for the browser API guide, `/api/openapi.json` for the machine-readable contract, and the proof files under `docs/proof/` for repeatable local checks.

The [feature guide](FEATURES.md) explains every product area, who can use it, how it works, its route or command, and the current limit.

## System at a glance

| Area | Current behavior |
| --- | --- |
| Identity | Email sign-in links create server-side sessions. Event roles control access. |
| Events | A founder creates an event. Organizers set dates, tracks, prizes, questions, judging mode, and invitations. |
| Submissions | Teams own projects. Drafts can be edited before the deadline. Submitted projects appear in a searchable gallery. |
| Judging | Published weighted rubrics, conflict-aware assignments, draft and final ballots, and optional pairwise decisions. |
| Evidence | Organizer-only progress, normalization, uncertainty, connectivity checks, and optional deeper diagnostics. |
| Public activity | Comments and configurable community voting with a fixed credit budget and shuffled ballot order. |
| Results | Publication freezes versioned standings and their evidence digest. Corrections append a revision with a reason; rubric and pairwise orders stay separate. |
| Portability | CSV, JSONL archives, Devpost import, OpenAPI, signed webhook notifications, and signed JSON records. |

## Technical shape

- TypeScript runs directly on Node. There are no production npm package dependencies or client framework bundles.
- Native Node SQLite stores application data in one file. Migrations, foreign keys, and an append-only hash chain protect structural and audit integrity.
- One command registry defines 69 operations for browser and API clients. It supplies parsing, access rules, forms, and OpenAPI descriptions. All 69 handlers use the same server-side role boundary on both surfaces.
- Server-rendered HTML and CSS provide the interface. The certificate verifier and embeddable gallery widget are separate script-enabled routes.
- The server is a single synchronous SQLite writer. Large first-time statistical fits may pause other requests. Test the expected event size on the deployment host.

The [architecture](docs/ARCHITECTURE.md) explains the layers and tradeoffs. [DATA-MODEL.md](DATA-MODEL.md) describes storage and archives. [JUDGING.md](JUDGING.md) explains scoring, normalization, pairwise ranking, and the limits of each diagnostic. [OPERATIONS.md](OPERATIONS.md) covers deployment, backups, webhooks, and signed records. [The threat model](docs/THREAT-MODEL.md) describes access boundaries and known weaknesses.

## Check the implementation

```sh
npm ci
npm test       # 566 tests
npm run typecheck
npm run prove:normalization -- --check
npm run prove:convergence -- --check
npm run prove:fixtures -- --check
npm run prove:isolation -- --check
npm run prove:roundtrip -- --check
npm run verify:workflow
```

`npm ci` is needed for the TypeScript development checker, not for the running server or Node test suite. The proof scripts write or compare local evidence under `docs/proof/`. [acceptance-report.txt](acceptance-report.txt) records the supplied checker's local T1/T2 result. Do not treat local tests as a substitute for the organizers' fixtures.

## Current limits

Media is linked by HTTPS URL rather than uploaded to Manak. Event questions and answers are text fields. Search is case-insensitive literal matching. The dashboard refreshes on request or by page refresh; it does not stream updates. Community abuse signals require human review and do not establish a person's identity. Certificates are signed JSON, not PDFs or an email campaign; corrections are signed and must be checked against an independently trusted key and current status bundle. Public results use frozen revisions, while organizer diagnostics can use live evidence. The public ranking does not use a joint Bayesian consensus model. Docker, SMTP delivery, remote fixture provenance, public repository/code-window evidence, and the required demonstration video need external completion.

Manak is MIT licensed. Built by Sai Ram (Hardik) Dash.
