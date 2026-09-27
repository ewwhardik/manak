# Operations

## Boot

`npm run start:demo` runs without package installation on Node 22.18+; local validation used Node 24. Defaults: `data/demo.db`, founder `rosa@example.com`, seed once. Set `MANAK_DEMO=false` to disable seeding, or use `npm start` for an empty production deployment.

Set `MANAK_DATABASE`, `MANAK_FOUNDERS`, `MANAK_PUBLIC_ORIGIN`, and optionally `MANAK_PORT`. By default, sign-in links are printed to stdout; log readers can use them. Optional SMTP uses `MANAK_SMTP_HOST`, `MANAK_SMTP_FROM`, encryption/port and credentials. A hosted deployment may supply a separate mail adapter. Enable proxy trust only behind your controlled proxy and use HTTPS in production. `npm start -- --help` lists settings.

## Backup

Use the archive CLI for consistent snapshots. `npm run archive:export -- <directory>` writes a whole-database archive. `npm run archive:preview -- <directory>` validates its manifest, rows, migrations and ledger in a temporary database without changing the deployment. Only then run `npm run archive:import -- <directory>` against an empty compatible database. The preview does not authenticate an archive supplied by an untrusted party: its manifest digests travel with its contents. See the deterministic round-trip proof.

Back up database, certificate keys, and webhook checkpoint plus its `.status.json` together. Keys and cursor are outside the application-table archive. Never publish private keys, live-session archives, webhook secrets or SMTP credentials. Exercise recovery in a clean instance: preview and import the archive, restore the matching keypair and checkpoint, compare event counts and published revision digests, then verify a pre-backup certificate with the independently retained public key. A new keypair cannot verify old certificates; preserve old public keys even after rotation.

## Durable webhooks

| Variable | Meaning |
| --- | --- |
| `MANAK_WEBHOOK_URL` | Trusted HTTPS receiver, no embedded credentials or fragment. |
| `MANAK_WEBHOOK_EVENT` | Exact event ID from the organizer API. |
| `MANAK_WEBHOOK_SECRET` | Shared HMAC secret, at least 32 characters. |
| `MANAK_WEBHOOK_CHECKPOINT` | Durable cursor; defaults to database path plus `.webhook.json`. |

A new checkpoint replays the selected event's ledger from the beginning. Batches contain at most 25 ordered notifications. JSON includes `id`, `sequence`, `event`, `action`, `timestamp`, and `hash`. Private payloads, actors and subjects are excluded. Receivers use separately authorized API credentials to refresh data.

`X-Manak-Signature` is `sha256=<hex HMAC-SHA256 of exact body>`. Verify with constant-time comparison. Deduplicate `X-Manak-Delivery`, the stable sequence-and-hash ID. Acknowledge with 2xx. Requests time out after five seconds, refuse redirects, and retry with backoff up to 60 seconds. Cursor saves atomically after acknowledgement. A crash can cause duplicate delivery; failed notifications remain in the ledger and block later ones to preserve order.

A new destination or event needs a separate checkpoint. Restored cursors must match ledger hashes. One process owns each checkpoint. Logs report failures. Set `MANAK_WEBHOOK_EVENT` and run `npm run webhook:status` to inspect delivered sequence, pending entries, last attempt/success and consecutive failures without sending a notification or printing the secret. The `.status.json` file is informational; the checkpoint cursor is authoritative. This runtime worker is separate from the reusable in-memory `WebhookDispatcher` helper.

## Signed records

Ed25519 keys are created/loaded on boot. `MANAK_KEY_DIR` defaults beside the database; persist it. The public key is at `/.well-known/manak-key.pub`. Distribute its SHA-256 key ID through a trusted channel outside the portal and pin that public key before accepting certificate claims. `/verify` runs local WebCrypto verification after loading; save the page and trusted keys for offline demonstration with a compatible browser. The certificate includes its issuer key ID and the result publication revision and digest. An older certificate remains cryptographically verifiable after a key rotation when its old trusted public key is retained.

```sh
npm run certs:issue -- dogfood --db ./data/demo.db --keyDir ./data --origin http://localhost:8080 --out ./data/certificates.json
```

Use the server's key directory and origin. Participant records require membership in a team with a submitted project. Judge records require submitted evidence and no unfinished assigned ballot; excluded judge evidence does not earn a record. Placement records require an explicit award decision bound to the current frozen publication, in rubric and hybrid events alike. Shared keys represent declared ties; special awards have no place number. An active voting window prevents issuance based on published results. Output is signed JSON, not a PDF batch or email campaign.

An organizer can revoke or supersede an issued record with `results.correct_cert`, supplying a reason and, for supersession, the replacement recipient details. `results.certificate_status` publishes signed status records without the private replacement certificate; an organizer can retrieve the replacement privately. Give verifiers a current correction bundle and its trusted correction key. An empty bundle cannot establish that no correction has ever been issued. Do not remove an old private key until its issued records and corrections are backed up; rotate by installing a consistent new pair in the persisted key directory, distributing its fingerprint independently, and retaining old public keys. Restore a matching private key from a secure backup if one half is lost; the server refuses a mismatched pair.

Signatures establish issuer-key possession and unchanged contents, not the truth of an award. Certificate JSON includes emails; distribute it privately.

## Offline and performance

Core UI has no CDN, webfont, client framework or production package download. Remote media and SMTP are optional. Prebuild Docker before offline startup. On a Docker host, run `docker compose build`, record `docker image inspect manak:local --format '{{.Id}}'`, and export the image with `docker save -o manak-image.tar manak:local`. In an isolated environment load it with `docker load -i manak-image.tar` and run `docker compose up --no-build --pull never -d`. Exercise sign-in, submission, judging, result publication and offline certificate verification; restart the container and host, then confirm database, ledger head, published digest and key fingerprint are unchanged. Check corrupted-archive and unwritable-volume failures in a disposable deployment. Docker and host-restart evidence must be captured on a Docker-enabled host; the development host used for this repository did not provide Docker.

The server is one synchronous SQLite writer. Cached fits, batched title reads and opt-in limits reduce repeat work; large fits can still pause requests. Validate intended event size on the target host.
