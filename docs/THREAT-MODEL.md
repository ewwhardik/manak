# Threat model

Two places in the product point here rather than answering a question themselves.
`manak --help` ends with a sentence about sign-in links being printed to stdout and points here;
`src/api/commands/judging.ts` says a claim about whose name a ballot can be filed in belongs here
rather than in a code comment. This document is the thing both of them referred to.
[ARCHITECTURE.md](ARCHITECTURE.md) is its companion, it owns why the code has the shape it has,
and defers every question about who is trusted with what to this file.

It is written for one person: whoever is about to run this on a box and then hand the URL to a
room full of people. What is worth taking, what this product does about it, and, the part most
documents of this kind leave out, the four places where the answer is "very little, and here is
the reason".

Every claim below is one of three kinds, and the kind is stated.

A claim that names a test is re-checked by `npm test`, all 591 of them, on every run. A claim that
names a proof was executed against a server on a real socket and its output is committed:
`npm run prove:isolation -- --check` re-sends all 984 requests and fails if a single byte of
`docs/proof/isolation.md` no longer matches. A claim with neither is an argument, and it is marked
*(argued)* so nobody mistakes reasoning for evidence. A threat model whose every line reads as
reassurance is a marketing document; the ranked list of weaknesses at the end is the part worth
reading first.

## What is worth taking

**The addresses.** A hackathon's roster is a list of live email addresses belonging to people who
write software, which has resale value to somebody sending phishing. Manak holds an address and a
display name per account and nothing else about a person, no password, no phone number, no
profile, no analytics identity. That is a deliberate floor on how bad a full database disclosure
can be, and it is enforced by the schema having nowhere else to put such a thing
(`src/db/migrations/001_init.sql`).

**The result before it is a result.** Between the last ballot and the announcement there is a
ranking that a participant would very much like to read early and an organizer would very much like
to control. The rule is in the handler rather than in the declaration, and the reason is worth
knowing: the dispatcher applies a declared gate *before* it knows the caller's role, so
`gate: "results"` would lock an organizer out of the preview they need in order to decide whether to
publish. `assertGate` is still what throws, so there is one definition of `results.notPublic` and one
message, checked in `tests/http.test.ts`, and deliberately not something the isolation proof speaks
to (see below).

**Somebody else's event.** This product is multi-tenant by default: one process, one file, any
number of hackathons. An organizer of the event next door is, from this deployment's point of
view, simply a signed-in stranger, and the entire isolation argument is that those two are
indistinguishable to the server.

**The credibility of the ranking.** The quiet one, and the reason for the ledger. An altered
ballot, a deleted comparison or an extra judge who is really the organizer scoring in their own
round does not look like an attack; it looks like a result. The defence is that all three leave a
row in a hash-chained ledger whose head hash is published, and that a role ladder which is not a
hierarchy keeps the organizer out of the judging arithmetic entirely.

**And the box's availability in the last hour before submissions close**, which is the only window
in which downtime is unrecoverable rather than annoying.

## Who is trusted, and the one cut line

There are four boundaries. The socket, where every request arrives. The process's standard output
and the shell that reads it. The database file, one path named by `MANAK_DATABASE`. And the
delivery path for sign-in links, which by default is the first of those.

**The operator is inside all four, and this document does not model them as an adversary.** That is
the cut line, stated plainly rather than buried: anybody who can read the database file can read
every address in it, and anybody who can write to it can rewrite a ballot. No amount of application
code changes that, because the application is not in the way, `sqlite3 manak.db` is. A threat
model that claimed otherwise would be claiming to defend against the person holding the disk, and
the honest version of that claim is the one `src/db/ledger.ts` already makes about itself: a hash
chain stored in the same file as its data detects *accidents and careless tampering*, not a
determined administrator.

The three parties this document does model are the ones the product can actually do something
about. A stranger on the network, with no session and no invitation. A signed-in account with no
business in this event, which includes the organizer of another hackathon on the same box, and
that collapse is the point rather than a simplification. And an invited person exceeding their
invitation: a judge who wants to read an unpublished ranking, a participant who wants to edit
another team's entry, an organizer who wants to enter a ballot.

Two things follow that are worth saying out loud. There is no administrator account and no
superuser role, the closest thing is the founder list, which lives in the environment and is
described below. And an account is not evidence of anything: sign-in is a link sent to whatever
address was typed, so obtaining an account here costs one inbox. Everything that matters is
attached to a role in an event, never to having registered.

## What each audience reaches

Access control is declared, not implemented. Every one of the 82 operations carries a `capability`
in its declaration, and `decide()` in `src/api/capability.ts` is a pure function of that declaration
and the caller, no database, no request, no clock. That is what makes the whole policy printable:
the same function generates the matrix in `docs/proof/isolation.md`, the capability page at
`/capabilities`, and the security section of the OpenAPI document. Access control that lives inside
handlers cannot be audited, because the only way to answer "who can read another team's submission"
is to read every handler and trust that none of them forgot.

There are six audiences, widest first: `public`, `account`, `founder`, `participant`, `judge`,
`organizer`. Three decisions in that list carry most of the weight.

**Roles are not a hierarchy.** An organizer is not implicitly a judge. The reason is arithmetic
rather than principle: an organizer who can file a ballot as themselves becomes an extra judge that
the normalization engine has no way to distinguish from an invited one, and a leniency correction
computed over a phantom judge is wrong for everybody in the round. Where an organizer genuinely has
to act for an absent judge, `src/db/repo/judging.ts` appends `ballot.entered_on_behalf` so the
ledger shows who did it and for whom, and **no HTTP route can reach that branch**, because a judge
id is never accepted as input on a ballot write. That is the claim `src/api/commands/judging.ts`
said belonged in this file: no request, from anybody, can file a ballot in another judge's name. The
storage layer supports the operation; the transport layer does not expose it (checked by
`tests/db.test.ts` for the ledger action, and by the input declarations the isolation proof
enumerates).

**Not yours means not found.** A caller holding no role in an event is told the event does not
exist, 404, never 403. A 403 is an admission that the resource is real, and across events that
admission is the leak: an organizer of one hackathon could otherwise enumerate another's projects by
watching which ids answer 403 and which answer 404. Once a caller holds *any* role in the event the
admission has already been made, and 403 becomes the honest answer, because it tells them to ask for
the right role rather than doubt the URL (checked by `tests/http.test.ts`, proved for every
operation in `docs/proof/isolation.md`).

**Founding is the operator's decision, not a user's.** Since anybody can obtain an account, `account`
cannot be the audience for creating an event, or the first passer-by to find a self-hosted portal
could fill it with their own hackathons. The `founder` audience is held by the addresses named in
`MANAK_FOUNDERS` at boot. It is deliberately not a role and not stored: a founder list in the
database would be a privilege-escalation target, and a founder list in the environment is revoked by
a restart. A refused founder is told 403 rather than 404, which is the one deliberate exception to
the rule above, there is no other tenant whose existence a 404 could protect here, and an operator
whose address is missing from the list needs to be told that rather than sent hunting for a typo.

### Why the matrix is not the same as a passing test

A unit test of `decide()` establishes that the function is right. It says nothing about a dispatcher
that forgets to call it, calls it with the wrong principal, or answers 403 where the rule says 404 -
and those are the interesting failures. So `npm run prove:isolation` starts a server on an ephemeral
port and sends every operation as every witness in both renderings: 82 × 6 × 2 = 984 requests over a
socket. 226 of the answers were refusals, 172 of those refusing an operation that writes, and the
number of ledger entries appended by a refused request was zero, snapshotted around every single
one, which is the observable form of "the check runs before the handler".

The witnesses include a `stranger` who is a real account with a live session, real memberships and an
event of its own, because an empty shell would prove nothing. And every request in the run had to get
past the parser, the limiter and the event lookup first: a 422 or a 429 anywhere is treated as a
broken fixture and no report is written, since either would look exactly like a pass while proving
nothing.

One further check closes the ambiguity a 404 creates. Since the isolation rule and a genuinely wrong
id answer identically on purpose, the matrix includes a control, `events.show` is public and scoped,
so the same witness fetching the same reference must get 200. A 404 in the isolation column therefore
means "refused", not "missing".

And the proof's own cut line, because a reader deserves it before they lean on the table: **it proves
the decision and nothing after it.** Any status that is not 401, 403 or 404 counts as `allow`,
including 409, a rule refusal is an answer the caller got *in* for. So an operation correctly allowed
for an organizer, whose handler then went on to select across every event in the database, would pass
this proof without a murmur. `results.show` is probed against unpublished results and answers 409
exactly like that. Whether a handler reads only what it should is a per-handler claim, and it lives in
`tests/http.test.ts` and `tests/db.test.ts`.

The inverse trap is closed, though: the fixture opens every window and plants every id the payload
table names. Ten operations declare a gate and the gate is asserted after the capability decision, so
a fixture with submissions shut would publish a green table in which ten cells were satisfied by the
wrong refusal and no reader could tell.

### Row ownership, which a role cannot express

Being a participant in an event does not make somebody else's project yours to edit. `decide()` does
not enforce that and does not pretend to: `capability.owner` is declaration-only, and a handler-level
function, `ownProject` for `owner: "team"`, is what actually holds the line, raising the same 404 a
stranger gets. The declaration exists so the obligation appears in the published document and the
matrix instead of in a reviewer's memory, and `tests/api.test.ts` asserts the correspondence: every
command declaring `owner: "team"` calls the function. That assertion is the load-bearing part. Without
it, `owner` would be a comment.

### Redaction inside one response, which a capability cannot express either

`results.show` is public, and it has to be: a published ranking that only its author can read is not
published. But the engine now computes more than a ranking, and half of what it computes identifies a
person. A per-judge residual spread on a three-judge panel is a judge; a diagnostic's `subjects` array
is raw account ids; a criterion's judge-divergence figure tells a reader who knows the roster which
judge read the rubric differently. None of that can be held by `decide()`, because the capability is a
property of the operation and this is a property of a field.

So the line is drawn inside the handler, and it is drawn by construction rather than by deletion: the
public projection is assembled from the anonymous half, and the naming half is *absent* from it rather
than emptied. An empty array reads as "we looked and found nothing", which is a different and false
claim. The organizer's `events.dashboard` is where the whole of both passes lands, and the toggle that
publishes results is redacted on the same rule, since that response is the one an organizer
screen-shares while deciding.

This is the one place where the isolation proof cannot help, by its own cut line it proves the
decision and nothing after it, and every request here was correctly allowed. `tests/publish.test.ts`
is what holds it, and it checks by **substring over the whole serialised body** for every organizer
and judge id and address, rather than by walking the fields somebody remembered to name. A leak
arrives in the place nobody thought to look: a warning sentence, a diagnostic subject, an id echoed
into an error message. The rendered public page is searched for the same strings, since the JSON and
the markup are two projections of one command and a leak in either is the leak.

One thing deliberately survives the redaction. The caveats do: a public results page that quietly
withholds "this panel cannot separate the field" is worse than one that never computed it. What is
removed is who, never how much to trust it.

## Sign-in

There are no passwords. Nothing to store, nothing to leak, no reset flow to abuse, and no credential
shared with a site that will be breached later. What it costs is that possession of an inbox is the
entire credential, so the security of an account is the security of its mail, which for a
three-day hackathon is a trade worth making, and for anything longer-lived would not be.

| | |
| --- | --- |
| Sign-in link lifetime | 30 minutes (`MAGIC_LINK_TTL`), single use |
| Session lifetime | 14 days (`SESSION_TTL`) |
| Token | 32 bytes from `randomBytes`, base64url, 256 bits |
| Stored as | `sha256` hex, never the token itself |
| Compared with | `timingSafeEqual`, length-checked first |
| Cookie | `manak_session`; `HttpOnly`; `SameSite=Lax`; `Path`; `Max-Age`; `Secure` when the request arrived over TLS |
| Address limit | 254 bytes, RFC 5321's forward path |

Guessing is not in this model: 256 bits of token means the limiter is not what stands between an
attacker and a session, and saying so is more useful than implying the rate limit is a defence it
is not. Expired links and sessions are deleted by a sweep rather than merely ignored, so a stolen
database is not also a stolen archive of every link ever issued (`sweepExpired`, called at boot and
on a timer from `bin/manak.ts`).

Clicking a link does not sign anybody in. `GET /signin/:token` is deliberately inert, it reads
nothing, writes nothing, and renders one button, and `POST /api/session` is what consumes the
token. The reason is a corporate mail gateway that fetches every URL it forwards: with the
consumption on the GET, a single-use link would be spent by a scanner before the person saw it, and
the symptom would be a portal that appears to reject valid links at exactly one organization.

The cookie is not `__Host-` prefixed. The prefix would pin it to one host and forbid it from ever
being set without `Secure`, which is strictly better on HTTPS and makes the cookie impossible on
plain HTTP anywhere but localhost, and `http://nas:8080` on somebody's own network is a deployment
this product intends to support. `Secure` is derived from the scheme the request actually arrived on
instead, with `MANAK_SECURE_COOKIE` to override when TLS terminates upstream. An operator who does
terminate TLS and forgets both that flag and `MANAK_TRUST_PROXY` gets a cookie without `Secure`,
which is the failure mode to check for first on any deployment behind a proxy.

`POST /api/session` also returns the session token in its body, because a command-line client has no
cookie jar and `Authorization: Bearer <token>` is the only other way to hold a session. That is a
deliberate second credential path with a consequence worth naming: a bearer token in a shell history
or a CI log is a live 14-day session, and unlike the cookie nothing marks it `HttpOnly`.
`POST /signout` with `everywhere` set revokes every session for the account, which is the answer when
a token has been somewhere it should not have been.

### The default that matters most

**With no relay configured, sign-in links are written to the server's standard output.** Anybody
who can read that log can sign in as anybody who has asked for a link, including an organizer.
`manak --help` says so, the banner says so on every boot, and it is repeated here because it is
the most serious thing about an unconfigured deployment and it is a default rather than a bug.

The default exists because the alternative is refusing to start without a mail relay, which turns
the first five minutes of evaluating this product into a configuration exercise, and because the
failure it produces is one an operator running `docker logs` sees immediately rather than one that
hides. That reasoning does not survive contact with a real event. Before a deployment holds anybody
else's address, either set `MANAK_SMTP_HOST` or treat the log as a credential store: not shipped to
a shared aggregator, not in a terminal on a projector, not in a CI job's output.

**Closing it is six environment variables and no code.** `MANAK_SMTP_HOST` and `MANAK_SMTP_FROM`
are the two that are required; `MANAK_SMTP_PORT`, `MANAK_SMTP_ENCRYPTION`, `MANAK_SMTP_USER` and
`MANAK_SMTP_PASSWORD` are the rest. With a host set, no sign-in link is ever printed: a message
that cannot be sent is reported by recipient and reason and dropped, and the link is deliberately
absent from that line, because falling back to the log on the worst possible day is the exact
exposure the relay was configured to remove.

Three things about that path are security rather than plumbing, and all three are refused rather
than warned about. `MANAK_SMTP_ENCRYPTION=starttls` **will not fall back** to plaintext against a
server that does not offer STARTTLS. Anything the server sends between agreeing to STARTTLS and the
handshake completing ends the connection, because those octets arrived unencrypted and would
otherwise be read as though they had not, CVE-2011-0411, across a generation of mail clients. And
`MANAK_SMTP_USER` on an unencrypted connection is refused at boot and again in the client, with no
override flag, because an override flag is a thing people set once while debugging.

What this product does **not** do is sign. There is no DKIM, no SPF and no DMARC here; the relay
holds the key and does the signing, which is why the setting is a relay's address and not a private
key. A deployment pointed at a relay that does not sign will have its mail treated accordingly by
receiving providers, and that is a fact about the relay to be fixed there.

One related default runs the other way. `MANAK_FOUNDERS` is empty unless set, and an empty list
means **nobody** can create an event over HTTP. A fresh deployment is therefore closed rather than
open, and the demo event exists because `npm run seed:demo` wrote it directly, not because the portal
let a passer-by create one.

## Writes from another origin

There is no CSRF token, and that is a decision rather than an omission.

Every write in this product is a `POST`. Of the 82 operations, 40 are `GET` and 42 are `POST`, there
is no third method, and a request with any other verb is a 405 carrying the methods that path does
accept (`tests/http.test.ts`). That "no `GET` writes" is a fact rather than a convention rests on a
chain worth spelling out: `ctx.write` refuses to run outside a `ctx.recorded()` scope, and
`assertRecordsDeclared` objects if an action is appended that the declaration did not list, so a
command declaring no `records` cannot append, and a command that cannot append cannot write. No `GET`
command declares `records`, and `tests/http.test.ts` asserts it rather than leaving it to
inspection.

The session cookie is `SameSite=Lax`, which means a browser does not attach it to a cross-site form
submission, so an attacker's page posting to `/events/x/ballots` arrives without a session and is
refused as anonymous. `form-action 'self'` in the content security policy closes the reverse
direction, a page of this product posting somewhere else.

`Lax` rather than `Strict` is the trade-off worth explaining. `Strict` would withhold the cookie on
the first top-level navigation into the site from anywhere else, which is exactly how somebody
arrives from their mail client after signing in, and the symptom is a portal that looks signed-out
every time you follow a link to it. What `Lax` still permits is a cross-site top-level `GET` carrying
the cookie, which in this product reaches no state-changing operation because no `GET` writes.

The residual risk, stated rather than dismissed: a token would be strictly stronger than a cookie
attribute, because it does not depend on the browser implementing `SameSite` correctly, and there are
browsers in the world that do not. The reason it is not here is that a token has to be minted,
embedded in every form, and checked on every write, three places where a new route can silently
forget it, in a product whose entire design is that a route cannot silently forget anything. A
correct token scheme is a better defence than this one; an inconsistently applied one is worse.
Bearer-token callers are unaffected either way, since no browser attaches an `Authorization` header
on somebody else's behalf. *(argued)*

## What the browser is allowed to do

There is no client-side JavaScript in this product, not a bundle, not an inline handler, not a
sprinkle of progressive enhancement, and the policy says so, so an injection that got as far as the
page would have nothing to execute it. Every response carries these, from one place
(`SECURITY_HEADERS` in `src/http/respond.ts`, asserted in `tests/http.test.ts`):

```
content-security-policy: default-src 'none'; style-src 'self'; form-action 'self';
                         frame-ancestors 'none'; base-uri 'none'
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: same-origin
permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
```

`default-src 'none'` is the whole argument: no script source is allowed, including `'self'`, so
adding a script tag to this product means editing this header first and noticing that you are doing
it. Nothing else is granted either: there is no `img-src` line, because the product emits no `<img>`,
no favicon link and no `url()`, the colour behind every page is a pair of gradients, which no fetch
directive governs, and a directive that names a capability nothing uses is an allowance somebody
eventually spends. `frame-ancestors` and `x-frame-options` together refuse framing on old browsers
and new ones,
because the clickjacking case here is concrete, a judge's console framed inside a page that
overlays its own buttons, on whatever browser is installed on a venue laptop. `permissions-policy` is
written out rather than left to the default because the default is "allow".

Every response except the stylesheet is `cache-control: no-store`. Per-route caching would be a
correctness question asked once per route and answered wrong once, and the wrong answer is a judge
seeing another judge's page out of a shared cache. The stylesheet is `public, max-age=3600` and
contains no data.

Text placed in markup goes through `esc()`, which replaces five characters including both quote
marks. The default in the view layer is to escape, and a value that is deliberately markup has to
name itself in a `raw` list, named by term rather than by index, so that dropping a conditional row
cannot silently start trusting a different cell. This matters most for the strings a stranger
controls: project titles, summaries, team names and ballot comments all render inside a page an
organizer reads.

## What reaches SQLite

Every statement in `src/db` binds named parameters; no query is assembled from a value. Inputs are
parsed and typed by the field declarations before a handler runs, a malformed payload is a 422 from
the dispatcher, not a defensive check inside a handler, and the isolation proof treats any 422 as a
broken fixture precisely so that "the parser refused it" can never be mistaken for "the policy
refused it".

Two lower-level protections are worth naming because they are the kind of thing that gets discovered
in production. The migration runner applies pending files before the socket opens or throws, so a
half-migrated schema never serves a request. And `pragma integrity_check` runs at boot: a database
file that a volume mangled stops the process with a message an operator can act on, rather than
producing a stream of 500s an hour later.

## Rate limits

Fixed windows, all of them in one table in `src/db/repo/rate.ts` so they can be read as a policy
rather than found by grepping handlers. A fixed window rather than a leaky bucket because "ten
sign-in links per address per hour" is a sentence a participant can be told when they hit it. The
known cost is burstiness across a window edge, twenty links in two minutes, which for these
actions is not a threat.

| Bucket | Limit | Keyed on | What it is for |
| --- | --- | --- | --- |
| `signin` | 10 / hour | the email address | one inbox being flooded, not one caller |
| `signin` on `POST /api/session` | 10 / hour | the token | replay of one link |
| `invite` | 200 / hour | the event | an organizer's invitation list becoming a mailer |
| `ballot` | 60 / minute | the judge | a runaway client, not a person |
| `submission` | 30 / minute | the team | the same |
| `read` | 600 / minute | the account, or the client address | cheap scraping |
| `event` | 20 / hour | the founder | a founder credential that has been taken |
| `organize` | 120 / minute | the event | co-organizers share one budget, deliberately |

Three details decide whether that table means anything. The counter increments on refused attempts
too, so a caller cannot hammer the boundary and have the window reopen at full quota. Signed-in
callers are keyed on the account and anonymous ones on the client address, which is
`socket.remoteAddress` unless `MANAK_TRUST_PROXY` is set, and this is the flag that matters most,
because with it off behind a proxy every request appears to come from the proxy and one bucket
covers the world, while with it on and *nothing* rewriting `X-Forwarded-For` an attacker sends a
different address per request and the limiter counts to one forever. Neither default is safe in the
wrong topology; the flag has to match the deployment.

The third detail is the token-keyed exception. `POST /api/session` is keyed on the token rather than
the address because the deployment this product is written for is a room: fifty people behind one
venue NAT clicking their links in the first hour would exhaust an address-keyed bucket of ten and
lock out the rest of the room. Guessing is not what that limit defends against, 256 bits is, so
the bucket bounds replay of a single link instead.

None of this is DoS protection. A fixed-window counter in the same SQLite file as the data will not
save a single-process server from somebody who wants it down; what it does is stop an accident, a
scraper and a stolen credential from being cheap. Anything more belongs in front of the container.
*(argued)*

## The audit ledger

Every state change an organizer or judge makes is appended to one table, and every entry carries the
hash of the one before it. Removing an entry, reordering two or editing a payload breaks the chain
from that point to the end, and `verifyLedger` reports the exact row where it broke.

The hashed form is re-derivable by hand, on purpose:

```
hash = sha256(JSON.stringify([prev, seq, at, event, actor, action, subject, payload]))
```

A JSON array rather than a delimiter-joined string, because `action`, `subject` and `payload` are
arbitrary text and any separator could appear inside them, which is how a chain ends up with two
different entry sets that hash identically. Payloads are canonicalized with sorted keys so that
re-serializing an entry during an export reproduces the bytes it was hashed as.

**What it proves.** That nothing was appended by a refused request, measured at zero across all 984
requests of the isolation proof. That every write is attributed: `ctx.write` refuses to run outside a
`ctx.recorded()` scope, so a repository function that forgot to record would fail its own tests
rather than write silently, and `ctx.as(id)` is how an actor is rebound (which is why the demo seed's
projects are attributed to the participants who submitted them and not to the seeder). And that a
head hash written down at a prize ceremony pins everything before it: `/api/healthz` publishes the
ledger's length and head hash to anybody, so an organizer can commit to the audit trail in public
before the appeals start, and a participant can keep a copy of the number.

**What it does not prove.** Anybody who can write to the database can also recompute the chain
forward from their edit. In the ledger's own words: a hash chain in the same file as the data it
describes detects accidents and careless tampering, not a determined administrator. Publishing the
head hash early is the only thing that converts it into evidence, and that is a habit rather than a
mechanism.

A broken chain does not stop the server. It is printed as a warning at boot with the failing rows
named, and the process starts anyway, because the pages that would let somebody work out what
happened are served by this process and refusing to boot would hide the evidence while removing the
only tool for reading it. A corrupt *database* does stop it. That asymmetry is deliberate and it is
the one place this product chooses to serve something it has already told you not to trust.

## What the logs contain

One line per request, and the path is redacted before it is written, but only for segments whose
input declaration says `secret: true`, which is how a sign-in token stays out of the log while a
project id stays in (`loggedPath` in `src/http/app.ts`). Request bodies are never logged. The
exception is delivery: with no delivery configured, `logDelivery` writes the recipient's address, the
subject and the link itself, which is the finding at the top of this document.

Ledger payloads are a second copy of anything a handler chose to record. They are inside the database
rather than in the log, and they are readable by an organizer of the event, worth knowing before
recording anything in a payload that an organizer should not see.

## What an archive contains

`npm run archive:export` writes the whole database as a directory of JSONL, and the honest way to
describe that directory is that it *is* the database in a form that looks harmless enough to attach
to a support ticket. It lists every email address in the deployment, every display name, every
project summary and every ledger payload, in plain text, with no encryption offered and no key to
manage. Nothing in it is redacted, because an archive that dropped a column would be a restore that
lost one.

What it does not contain is a live credential. Sessions and magic links are stored as SHA-256 hashes
of their tokens and the archive carries the hashes, so a stolen archive does not sign anybody in -
but an imported one does, because the hash is all `resolveSession` ever compares. That is the
intended behaviour for a restore: moving a deployment to another machine should not sign every judge
out mid-event. It is also the reason an archive should be treated as a set of live sessions rather
than as a dead copy, and why importing somebody else's archive into a server you control hands you
their event, ledger and all.

Import refuses a database that already holds rows and there is no `--force`, so an archive cannot be
used to merge one deployment into another or to slip rows into a running event. Export is the
opposite and warns rather than refuses, a broken chain, a failed integrity check, an unapplied
migration are all printed and the export runs anyway, because the command exists for the day the
deployment is already damaged. The consequence is named in the warning: an archive with a broken
chain will be refused on the way back in. Both directions, and eleven ways of being damaged, are
executed in `docs/proof/roundtrip.md` (checked by `tests/archive.test.ts`, proved by
`npm run prove:roundtrip -- --check`).

The digests in the manifest are a check against damage, not against a person. The manifest travels
inside the archive it describes, so anybody who edits a row can recompute the hash that covers it -
and the proof demonstrates exactly that rather than claiming otherwise. What survives the edit is the
ledger: the value as it was entered is in the payload the hash chain covers, and rewriting that means
rewriting every entry after it.

## Staying up, and shutting down

One process, one port, one file. There is no clustering and no read replica, so the availability story
is the operator's: a restart policy, a volume that survives the container, and a backup of one file.
What the product contributes is that it does not corrupt itself on the way down. `SIGTERM` reaches
node directly, the container's `CMD` is exec-form for exactly this reason, the listener stops
accepting, requests in flight get five seconds, and SQLite is closed properly, which checkpoints the
write-ahead log so the next boot opens one file instead of recovering three.

The database runs in WAL mode with `foreign_keys` on and a busy timeout, so a concurrent reader does
not block a writer and a lock contention surfaces as a delay rather than an error. Migrations run
before the socket opens. The health probe answers 200 even when the deployment is degraded, and the
degradation is in the body: a probe that returned 500 on a pending migration would put the container
in a restart loop, and a restart loop is the one state in which nobody reads the message. The
`HEALTHCHECK` in the `Dockerfile` therefore reads `status` out of the JSON rather than trusting the
status line.

Uploads are the risk that is absent by construction: this product accepts no files. A submission is
text and links. There is nothing to store, nothing to scan, nothing to serve back with the wrong
content type, and no disk to fill but the ledger's.

## Out of scope

Named rather than left implied, because an unstated scope is how a threat model gets read as a
guarantee.

The operator, as established. The host operating system, its other tenants and its update policy. TLS
- this product speaks plain HTTP and expects a reverse proxy in front of it for anything public,
which is also the only supported way to get `Secure` cookies right. Mail transport: whatever you wire
`deliver` to, its security is that system's problem, and by default there is no mail at all. Where an
archive goes after `archive:export` writes it, and whether it is encrypted at rest, the command
writes plain text and offers no key management, and the directory is as sensitive as the database.
Physical access to the disk. Timing side channels beyond the constant-time
token compare, since nothing else here branches on a secret. Denial of service, as discussed.

Supply chain deserves a sentence rather than a dismissal. This product has no dependencies, no lock
file and no build step, so there is no package that can be replaced overnight and no transitive tree
to audit, `npm install` does nothing because there is nothing to install. What remains is Node
itself and the base image, which is why the `Dockerfile` pins `node:22-alpine` by major rather than by
digest: the tag is where 22.x security patches arrive, and a frozen digest is reproducible and stale.
The trade is explicit, rebuilds are not bit-identical, and anybody who needs them to be should pin
the digest in their own fork, where they will also see when it goes out of date.

And one thing that is out of scope because software cannot fix it: a judge who scores dishonestly.
Normalization removes systematic leniency and severity, not intent. What the product offers instead is
that every ballot is attributable, every comparison is recorded including the skips, and the ranking
publishes both the raw and the adjusted table so a disagreement between them is visible rather than
resolved silently.

## Known weaknesses, worst first

| # | Weakness | Severity | What closing it takes |
| --- | --- | --- | --- |
| 1 | Sign-in links are printed to stdout unless `deliver` is wired, so log access is account access | High | Wire a delivery function before the deployment holds anybody else's address, and treat the log as a credential store until then |
| 2 | There is no delivery configuration, `AppOptions.deliver` is a code seam, and no SMTP support ships in 0.1.0 | Medium, and the cause of #1 | An entry point of your own that calls `listen` with a `deliver`; a first-class mail setting is unbuilt work, not a decision |
| 3 | `POST /api/session` returns a 14-day bearer token in its body, and a bearer token in a shell history or CI log is a live session | Medium | Shorter lifetime for bearer credentials than for cookies, or a separate token class. Today the answer is `POST /signout` with `everywhere` |
| 4 | An export is a plain-text directory holding every address in the deployment, and the session hashes in it are live again once imported | Medium | Encrypt it where it lands and delete it when the event is over. Encryption in the tool would mean key management this product has no way to do well |
| 5 | No CSRF token; cross-origin writes are refused by `SameSite=Lax` and `form-action 'self'` alone | Low, accepted | A minted per-form token, at the cost of three places a new route could forget it |
| 6 | The hash chain lives in the same file as the data it describes, and in the same directory as any archive of it | Structural | Publishing the head hash somewhere the operator cannot rewrite. The mechanism is a habit, not code |
| 7 | `MANAK_TRUST_PROXY` is wrong in both directions by default: off behind a proxy collapses the anonymous limiter to one bucket, on without a rewriting proxy makes it useless | Medium, configuration | Set it to match the topology, and verify by watching a 429 arrive for the right caller |
| 8 | A deployment behind upstream TLS that sets neither `MANAK_TRUST_PROXY` nor `MANAK_SECURE_COOKIE` serves a session cookie without `Secure` | Medium, configuration | One of the two flags. This is the first thing to check on any proxied deployment |
| 9 | Sessions can be revoked one at a time or all at once, but there is no list of active sessions to revoke a specific other one from | Low | A session index page; `everywhere` is the current answer |
| 10 | No per-account deletion or export: the whole database can leave, one person's rows cannot | Low, and a real gap | A command pair, plus a decision about what deleting an account does to ballots already counted |
| 11 | `synchronous = normal`, so a power cut can lose the most recent commits | Low, durability rather than security | `pragma synchronous = full`, at roughly an fsync per commit |

Nothing in that table is a surprise to the code: each row is a decision recorded in a comment at the
place it was made. The purpose of collecting them here is that a reader should not have to find ten
comments to learn what this product is bad at, and an operator deciding whether to run it deserves the
list before the event rather than after it.

## If you find something else

This is version 0.1.0 of a portal written for one hackathon, and it would be dishonest to publish a
security address with a response-time promise behind it. Report it wherever you obtained this code.
Please do not include a live token, a session cookie or a real participant's address in the report -
a reproduction against `npm run seed:demo` needs none of them.

---

Manak 0.1.0, a self-hostable hackathon submission and judging portal. Written by Sai Ram (Hardik)
Dash, <https://github.com/ewwhardik>, MIT licensed. The claims in this document are re-checkable with
`npm test`, `npm run prove:isolation -- --check` and `npm run prove:normalization -- --check`; if one
of them ever contradicts this file, the file is what is wrong.

## Added content and integration boundaries

Submission stories, answers, tags, prizes, questions, comments and reasons are escaped as text. Media is credential-free HTTPS, validated on write and render. Images use lazy loading and no-referrer. The CSP permits HTTPS images: a remote image host can learn the viewer's IP. The server does not fetch or scan media.

Comments require an authenticated account and a submitted project, have a 2,000-character limit, and consume a rate-limit bucket. Only event organizers can hide them, with a reason. Hiding excludes public projection but retains append-only ledger content. Administrators and private archive holders can read it; moderation is not erasure.

Public standings and confidence results remain hidden throughout active voting, even if previously published. Organizer preview remains accessible; publication is refused during voting. Cached numerical fits never cache access decisions or public redaction.

The private evidence lab provides advisory Hodge, distribution and vote-pattern signals. These cannot prove collusion, causal bias or unique human identity. Shared IP/user-agent fingerprints can flag innocent venue participants. Analysis bounds are exposed.

Runtime webhooks have one trusted operator-configured event and HTTPS destination. End users cannot supply URLs. Redirects are refused, requests time out after five seconds, and private payloads/subjects/actors are omitted. Exact bytes are HMAC-signed. Receivers must verify signatures and deduplicate delivery IDs. At-least-once delivery retains failed notifications; later notifications wait to preserve order. Atomic cursors are bound to ledger hashes but cannot prevent a trusted administrator from rewriting deployment state.

Certificate keys are generated on boot and persisted beside the database by default. Full recipient IDs avoid timestamp-prefix serial collisions. Judge records require submitted ballots or comparisons, but a signing operator can still lie. Certificates include email addresses; distribute privately. Pairwise/hybrid placement policy is not inferred. Back up keys and cursors separately, as described in [OPERATIONS.md](../OPERATIONS.md).
