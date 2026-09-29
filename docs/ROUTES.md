# HTTP route inventory

Registered JSON routes and their browser spellings are generated from the [OpenAPI document](../openapi.json). Each declares method, input, capability and rate limit in `src/api/commands`. These are the transport routes in `src/http/app.ts` outside that registry:

| Path | Method | Access and projection |
| --- | --- | --- |
| Bundled assets and stylesheet | GET, HEAD | Public immutable asset bytes; no event data. |
| `/widget.js` | GET, HEAD | Public client script. It fetches the public project gallery; HTML insertion escapes untrusted text. |
| `/embed.js` | GET, HEAD | Public client embed loader. Injects a responsive iframe with automatic bidirectional postMessage height resizing. |
| `/embed/:event` | GET, HEAD | Public self-contained iframe gallery view styled for seamless host embedding. |
| `/.well-known/manak-key.pub`, `/manak-key.pub` | GET, HEAD | Public issuer key. Verification requires an independently trusted key fingerprint. |
| `/verify` | GET, HEAD | Public local certificate verifier. It does not receive private certificate contents from the browser. |
| `/guide`, `/api/guide` | GET, HEAD | Public guide with role-specific links only for a valid session. No private result or ballot projection. |
| `/events/:event/live`, `/api/events/:event/live` | GET, HEAD | Public ceremony view drawn from registered `results.show`; unpublished results remain hidden from visitors. Organizers can preview. |
| `/events/:event/tie-breaker`, `/api/events/:event/tie-breaker` | GET, HEAD | Organizer-only finalist view using registered results data. Unavailable model evidence is explicit. |
| `/metrics` | GET, HEAD | Prometheus text-format metrics exporter reporting HTTP status counts, request durations, database ledger sequence, and process memory. |
| `/fast-login` | POST | Exists only with `MANAK_DEMO=true`; same-origin demo form, fixed personas and seeded events. It changes the session and is absent in production mode. |

## Notable Registered API & UI Endpoints

The 96 registered operations in `src/api/commands/` declare typed JSON and form handlers. Key additions include:

| Route Path | Capability / Access | Description |
| --- | --- | --- |
| `/events/:event/projects/:project/explain` | Participant / Public | **Explain My Rank**: Decomposes project standing into grand baseline, latent merit, reviewer offsets, criterion breakdown, and bootstrap CI with HMAC judge anonymization. |
| `/events/:event/dashboard/sandbox` | Organizer | **Multi-Method Normalization Sandbox**: Concurrently computes Raw Trimmed Mean, Standardized Z-Score, Additive Bayesian, and Bradley-Terry MM models with Spearman $\rho$ and Kendall $\tau$ concordances. |
| `/events/:event/dashboard/duplicates` | Organizer | **Duplicate Submission Triage**: Lists automated title/URL collisions held in quarantine; allows organizers to clear or confirm duplicates. |
| `/me/tokens` | Authenticated Account | **Scoped API Tokens Console**: Generates and revokes cryptographically hashed API tokens with fine-grained scopes (`read:projects`, `read:results`, `write:projects`, `write:judging`). |
| `/events/:event/export/registrations.csv` | Organizer | Dedicated CSV export of registered attendees and roles. |
| `/events/:event/export/submissions.csv` | Organizer / Public (post-close) | Dedicated CSV export of project submissions and metadata. |
| `/events/:event/export/scores.csv` | Organizer | Dedicated CSV export of all rubric scoring marks and judge remarks. |
| `/events/:event/export/rankings.csv` | Organizer / Public (post-pub) | Dedicated CSV export of raw and Bayesian normalized standings. |
| `/events/:event/export/votes.csv` | Organizer | Dedicated CSV export of community votes, voters, and discount audit. |
| `/events/:event/export/audit.csv` | Organizer | Dedicated CSV export of append-only cryptographic ledger sequence transactions. |

Unknown paths return 404 and wrong methods return 405, except the disabled demo shortcut, which returns 404. The custom route regressions in `tests/audit-regressions.test.ts`, `tests/http.test.ts`, and `tests/metrics.test.ts` cover access and output behavior. The command isolation proof measures only registry operations; its 1,152-request count does not include this table.
