# HTTP route inventory

Registered JSON routes and their browser spellings are generated from the [OpenAPI document](../openapi.json). Each declares method, input, capability and rate limit in `src/api/commands`. These are the transport routes in `src/http/app.ts` outside that registry:

| Path | Method | Access and projection |
| --- | --- | --- |
| Bundled assets and stylesheet | GET, HEAD | Public immutable asset bytes; no event data. |
| `/widget.js` | GET, HEAD | Public client script. It fetches the public project gallery; HTML insertion escapes untrusted text. |
| `/.well-known/manak-key.pub`, `/manak-key.pub` | GET, HEAD | Public issuer key. Verification requires an independently trusted key fingerprint. |
| `/verify` | GET, HEAD | Public local certificate verifier. It does not receive private certificate contents from the browser. |
| `/guide`, `/api/guide` | GET, HEAD | Public guide with role-specific links only for a valid session. No private result or ballot projection. |
| `/events/:event/live`, `/api/events/:event/live` | GET, HEAD | Public ceremony view drawn from registered `results.show`; unpublished results remain hidden from visitors. Organizers can preview. |
| `/events/:event/tie-breaker`, `/api/events/:event/tie-breaker` | GET, HEAD | Organizer-only finalist view using registered results data. Unavailable model evidence is explicit. |
| `/fast-login` | POST | Exists only with `MANAK_DEMO=true`; same-origin demo form, fixed personas and seeded events. It changes the session and is absent in production mode. |

Unknown paths return 404 and wrong methods return 405, except the disabled demo shortcut, which returns 404. The custom route regressions in `tests/audit-regressions.test.ts` and `tests/http.test.ts` cover access and output behavior. The command isolation proof measures only registry operations; its 948-request count does not include this table.
