# How Manak is built

Manak is 69 operations over 28 tables in 29,092 lines under `src/` and `bin/`, with no production npm
dependencies, no build step and one process. That combination is not a boast; it is the
constraint that decided nearly every other question in this repository, and this file is
where those decisions are written down with their costs attached rather than left for a
reader to infer from the code.

Four documents, so nobody reads the wrong one. The [README](../README.md) is what the
product does and how to run it. [THREAT-MODEL.md](THREAT-MODEL.md) is who is trusted with
what, and where this design is weakest. [`docs/proof/`](proof) is the evidence for the
three claims that can be measured rather than argued. This file is why the code has the
shape it has, and it is the one that owns the trades the other three defer, including the
one `src/db/migrations/001_init.sql` explicitly hands to it, under *Time is an integer*.

There is no operation reference here on purpose. That document is generated from the
running declarations and served at `/docs`, for the reason the next section gives, and a
copy of it in `docs/` would be a copy that is wrong by the end of the week.

Every count in this file was counted rather than remembered, and most of them are
published by the deployment itself: `/api/about` reports the number of operations and the
number of dependencies, `/api/capabilities` reports the access matrix, and `npm test`
reports the number of tests. Where a number here disagrees with one of those, this file is
what is wrong.

## A command is the unit of everything

There is no router in this codebase, no controller layer, and no place where a URL is
written down twice. An operation exists exactly once, as a `defineCommand({ ... })` literal
in one of the seven modules under `src/api/commands/`, and that literal carries the whole
operation: its name, its method, its path, who may call it, the fields it takes, the shape
it returns, the rate-limit bucket it spends from, the ledger actions it is allowed to
append, and the words its form uses.

That is unusual enough to be worth defending, because the conventional alternative, a
route table, handlers beside it, a schema file, a permissions middleware, and a hand-written
API reference, is not obviously worse. It is worse here for one reason: this product has
five surfaces that describe the same operations, and five hand-maintained descriptions of
one thing are five things that agree until somebody is in a hurry.

| Projection | Where it comes out | Derived from |
| --- | --- | --- |
| JSON API | `/api` + the path | `method`, `path`, `input`, `returns` |
| HTML page or form | the same path without `/api` | `form`, plus a view keyed on the name |
| OpenAPI 3.1 | `/api/openapi.json` | `input`, `returns`, `capability`, `summary` |
| Access matrix | `/api/capabilities` | `capability`, evaluated for six witnesses |
| Audit vocabulary | the `action` column of `ledger` | `records` |

None of the five is written by hand and none of them can omit an operation, because each
one is a `map` over the same array. A feature that exists in the browser and not in the
API is not something this codebase makes difficult; it is something it has nowhere to put.

The 69 operations are declared once: 33 are `GET` and 36 are `POST`.
The isolation proof exercises every declaration through JSON and browser rendering.

**Only `GET` and `POST`, and this is the price paid for the table above.** An HTML form can
send exactly two methods. The moment one operation needs `PUT` or `DELETE`, the browser
needs a hidden `_method` field and the dispatcher needs a second path through itself, and
at that point there are two renderings again, one of which is a simulation of the other.
So the API is not REST-shaped: a reviewer looking for `DELETE /projects/:id` finds
`POST /projects/:id/withdraw`. What that buys is that every route in the OpenAPI document
is a route the browser actually uses, and that the isolation proof covers both interfaces
by covering one.

**An incomplete declaration is a boot failure, not a warning.** `checkCommand` runs inside
`defineCommand`, so a broken command throws at the import of its own module and names that
file; `assertRegistryComplete` then runs over the whole list and reports every problem at
once rather than the first. It refuses a name outside the ledger's dialect, a summary that
is not one sentence, a path parameter the input does not declare, a path parameter that is
optional or is not text-shaped, a role audience with no event to be a role in, a gate with
no event to gate, a `POST` with no rate limit, a `POST` that claims no ledger action, a
`GET` that claims one, a `GET` that returns nothing, two commands with one name, and two
routes that differ only in what they call a parameter. Each of those is a mistake in a
source file rather than a runtime condition, and the last moment worth catching one is
before the socket opens.

## Five layers, one leaf, and one direction an import may run

| | Lines | May import | Owns |
| --- | --- | --- | --- |
| `src/judging` | 7,423 | nothing | the arithmetic: normalization, reliability, per-criterion analysis, pairwise fitting, bootstrap intervals, judge calibration, assignment |
| `src/db` | 6,286 | `node:*`, the engine's types | schema, migrations, repositories, ledger, limiter |
| `src/api` | 9,313 | `src/db/index.ts` | the declarations, capability, schema, errors, OpenAPI |
| `src/view` | 6,007 | `src/db/index.ts`, `src/api` | every string of markup this product emits |
| `src/http` | 1,964 | everything below | the dispatcher, the responses, the socket |
| `src/mail` | 1,058 | `node:*`, one erased type | RFC 5322 composition, an SMTP client, the outbox |
| `bin/manak.ts` | 580 | everything | the environment, migration, signals, the process |
| `tools` | 5,970 | everything, including `src/db` directly | seed, archive, the three proof harnesses |

`src/mail` is the one entry that is not part of the stack, and the shape of its row is the
reason. It sits beside the layers rather than on top of them: it imports `node:*` and one
type (`Delivery`, as `import type`, so nothing survives to run), and it is imported by
`bin/manak.ts` and nothing else. Both halves are enforced. That is what makes it optional in
the way the product needs, with no `MANAK_SMTP_HOST` no outbox is constructed, no socket is
opened, and a sign-in link goes to stdout exactly as it did before the package existed.

Layering is a claim about a codebase that is almost never true, because nothing enforces
it. Here `tests/source.test.ts` does, and it is worth naming which rules have teeth
because each one is there for a failure that is otherwise invisible in review.

**The engine imports nothing at all**, not the database, not a Node module, not a
dependency. Its determinism is the whole basis of `npm run prove:normalization`, and an
engine that could read a database would be an engine whose numbers depend on one.

**Everything above storage reaches it only through `src/db/index.ts`.** This is the rule
the audit trail rests on. Repository code cannot call `db.run`; it calls `ctx.write`, which
throws outside a `recorded()` scope. A handler that imported `src/db/open.ts` by deep path
would hold a raw handle that can `UPDATE` without a ledger entry, quietly, correctly, and
invisibly to every audit test here. The barrel exports no such handle, so the rule holds
for code nobody has written yet. The dispatcher is held to it too, and is the likelier
offender: it is the file with a handle already in hand, and reaching past the barrel for
one repository function would look entirely reasonable in a diff.

**Nothing but `src/http` may import `src/http`.** That is why `src/view` is a sibling of
the transport rather than a folder inside it. A page that could read a cookie would
eventually contain an access check, and then the access rule would have two
implementations: one in `decide` and one in whichever template was last edited.

**`src/db` and `src/judging` may not import `src/api`**, so neither the storage tests nor
the engine's proof can come to depend on the shape of a request. And every module in each
directory must be re-exported from that directory's `index.ts`, which is what keeps the
reach between layers to a single file a reviewer can read.

Two smaller rules in the same file exist because type stripping is not a compiler: every
relative import must carry its `.ts` extension, since an extensionless specifier is a
crash the first time that module loads, and only erasable syntax is allowed, since `enum`,
`namespace` and constructor parameter properties all emit code that stripping cannot
produce. Both mistakes were made here before they were checked.

## The request, in the order its refusals happen

`src/http/app.ts` is ten steps, and the order is a design decision rather than an
implementation detail: every step is a refusal waiting to happen, and the order decides
which refusal a caller receives when more than one applies.

1. **Read the wire**, body size, media type, UTF-8. A 300 KB body is refused before it
   costs a session read.
2. **Route**, no match is a 404; a path that exists on the other method is a 405 with a
   truthful `Allow`.
3. **Authenticate**, one indexed read on the session hash. The only database work ahead of
   the limiter, and what lets the limiter be keyed on an account rather than an address.
4. **Refuse a stranger early**, `decide` is asked with an empty role set and only its
   `unauthenticated` answer is honoured. Asking the real function here, rather than writing
   `if (capability.audience !== "public")`, is what keeps one implementation of the rule.
5. **Parse**, every problem at once, as a 422. Ahead of the limiter, because parsing
   writes nothing and a malformed ballot should not be charged to the judge's bucket.
6. **Resolve the scope**, the event the capability names, by id or by slug. A miss is a
   404. This happens before metering so an event's id and slug share one quota bucket.
7. **Meter**, the declared bucket, keyed on the canonical event id for scoped commands,
   or the account or client otherwise. An anonymous request still spends its bucket before
   the access decision.
8. **Decide**, now with real roles: 403 for a caller in the event with the wrong role, 404
   for one with no role in it at all.
9. **Gate**, the window the capability names, as a 409 that says how late the caller was.
10. **Invoke, then render**, JSON under `/api`, a page without it, and a 303 after a form
    post so that a reload cannot repeat the write.

Steps 7 and 8 are in that order for the reason the whole isolation claim turns on. A
request for an event that does not exist and a request for an event that exists and is not
yours must be indistinguishable, so the lookup miss and the no-role refusal have to produce
the same 404, which they cannot if the decision is made before the lookup, or if the
lookup answers 403. Once a caller holds *any* role in the event the admission is already
made, and 403 becomes the honest answer: it tells them to ask for the right role instead of
doubting the URL.

`decide()` in `src/api/capability.ts` is a pure function of a capability and a principal -
no database, no request, no clock. That is what makes the policy printable, and printing it
is what makes it checkable: `/api/capabilities` publishes the full matrix for six
witnesses, and `npm run prove:isolation` sends every operation as every witness in both
renderings against a live server and compares the answers to it.

The six audiences are `public`, `account`, `founder`, `participant`, `judge`, `organizer`,
and they are deliberately not a hierarchy. An organizer is not implicitly a judge, for an
arithmetic reason rather than a principled one: an organizer who could file a ballot as
themselves becomes an extra judge that the normalization cannot tell apart from an invited
one, and a leniency correction fitted over a phantom judge is wrong for everybody. Where an
organizer genuinely has to act for a judge there is a separate operation that records
`ballot.entered_on_behalf`, so the ledger shows a human did it and for whom.

Two error boundaries sit under all of this and are worth stating because the split is not
the obvious one. An `InputError` is a 422 and a `RuleError` is usually a 409, and the line
between them is not input-versus-domain: it is whether the caller can fix this by changing
the payload or only by changing the world. A score of 11 against a rubric that stops at 10
is payload-fixable and therefore a 422, even though only the rubric knows the bound. A
closed deadline is not fixable by resending anything, so it is a 409. `classify` is an
ordered, total table, and a test scans `src/` for every `RuleError` code the product can
throw and fails if one of them reached the fallback.

## What the schema is asked to guarantee, instead of the code

`src/db/migrations/001_init.sql` is 400 lines for 17 tables, and most of what is not a
column definition in it is either a constraint or the sentence explaining one. The reason
for that ratio is a preference for failures that happen at the write over failures that
happen in a published ranking. A validation in a handler protects the paths somebody
remembered; a constraint protects the ones nobody has written yet, including the ones a
repair script will take at two in the morning.

Every table is `STRICT`. SQLite's default affinity will store the string `banana` in a
column declared `INTEGER` without complaint, and the first place that surfaces is a ranking
computed from a score that is not a number. There is no `BLOB` column in the schema and
exactly one `REAL`, `criterion.weight`, so the only floating-point value in storage is the
one that is genuinely a ratio, and everything a ranking is computed from is an integer until
the engine makes it otherwise.

Every event-scoped row carries `event_id`, and every reference between two such rows is a
composite foreign key through it. The redundancy is the point: a ballot on another event's
project is unrepresentable rather than merely a bug, and cross-event isolation becomes one
predicate a reviewer can grep for instead of a property distributed across handlers. Five
tables whose own primary key is `id` therefore also declare `unique (event_id, id)` so they
can be a valid parent for those keys, a second index on a small table, bought deliberately.

Three tables carry a generated virtual column, `is_judge text generated always as ('judge')`,
and it is the neatest trick in the file. `assignment`, `ballot` and `comparison` reference
`membership (event_id, account_id, role)` through it, which pins the role inside the foreign
key: an assignment to somebody who is not a judge in that event fails at the write, and
revoking the role deletes the assignment instead of leaving a ballot slot nobody can fill. A
`CHECK` cannot express that, it would need a subquery, and a trigger would be a second
place to look.

Deletion behaviour is stated on every foreign key and defaulted on none: `cascade` where the
child is part of the parent, `restrict` where the child is evidence. A rubric version that
ballots were scored against cannot be deleted out from under them. Closed sets are `TEXT`
with an inline `CHECK` rather than a lookup table, because a join for something the code
already knows is a join that only obscures what the values are; booleans are `INTEGER` with
a `CHECK` for the same reason. Fourteen indexes are declared at the end of the file, all of
them composite and ten of them led by `event_id`, which is the same isolation predicate
appearing a third time, this time as the thing that makes the scoped query fast.

Migrations are content-addressed: each applied file's SHA-256 is recorded, and
`planMigrations` refuses a history that diverges from what is on disk rather than trying to
reconcile it. That is why `tests/source.test.ts` scans the `.sql` files for trailing
whitespace along with the TypeScript, a stray space added by an editor is a hash change,
and a hash change is a database that will not open. It also asserts that every migration is
named `NNN_lower_snake.sql`, since the zero padding is what stops `10_x.sql` from sorting
ahead of `2_x.sql` and making the repository unmigratable.

None of the above works on a default connection, which is why `src/db/open.ts` is the only
place that opens one. `foreign_keys` is off by default in SQLite, every composite key
described above would be decoration, so it is set and then *asserted*, because a pragma
silently ignored is worse than one nobody wrote. WAL is set so that an organizer holding a
dashboard open never blocks a judge submitting a ballot, and `synchronous = normal` is its
documented pairing: durable across a process crash, able to lose the last transactions only
if the machine loses power. For a hackathon whose entire state can be re-exported that is
the right end of the trade, and an operator who disagrees sets `synchronous = full` and pays
an fsync per commit. Transactions nest through savepoints, so a repository method that
writes a row and appends a ledger entry composes inside a caller that wraps ten of them, and
either everything lands or nothing does.

## Time is an integer, and that is this file's debt

The schema's second decision defers its cost here, so this is where it is paid. All 28
instant-valued columns in Manak are `integer` epoch milliseconds, and every one of them is
named `*_at`. Opening the file with `sqlite3` and asking for a deadline returns
`1790000000000`, which is nobody's idea of a date. That is a real cost and it is worth being
precise about what it buys, because the alternative, ISO 8601 text, the choice most schemas
make, is not obviously worse.

Deadline enforcement is the one piece of clock arithmetic in this product that decides
whether somebody's work counts. Comparing integers is total: any two values compare, the
comparison means what it looks like, and there is no representation in which two equal
instants are unequal. Text comparison is total only if every value in the column has the
same length, the same precision and the same offset spelling, and `2026-09-28T18:00:00Z`
and `2026-09-28T18:00:00+00:00` are the same instant that sort apart. Guaranteeing they
never coexist is a job for the write path, and `STRICT` cannot help: SQLite has no date type
to check against and no regular expressions with which to write the constraint by hand. So a
text column would make the correctness of every deadline in the product a bet on the
discipline of every insert that ever touches it, which is exactly the kind of bet the rest of
this schema exists to avoid.

Seconds were rejected for a smaller reason: milliseconds are what the platform hands you, a
division at the boundary has to be applied in both directions and consistently, and two
ballots filed in the same second would sort arbitrarily. A `REAL` Julian day was rejected
because it makes equality on an instant approximate.

The mitigations are three, and they are all in the code rather than in a convention. Reading
the database by hand is a one-line conversion, which is worth writing down here since it is
the thing this decision costs an operator:

```sql
select slug, datetime(closes_at / 1000, 'unixepoch') as closes from event;
```

Second, no page ever shows an operator that integer: `when()` in `src/view/pages.ts` renders
every instant in the event's own zone with the zone named beside it -
`2026-09-28 18:00 Asia/Kolkata`, using `en-CA` for the date, because it is the one common
locale that spells it `2026-09-28`, and a deadline that reads 09/28 to one person and 28/09
to another is a deadline nobody can act on. That includes the pages nobody wrote: the health
check has no hand-written view, and the generic renderer formats any field named `at` or ending
in `At` through the same function, in UTC, because it has no event to ask. It used to print the
integer, which is how a rule stated in a document and held by nothing at all eventually reads.
The zone comes from `event.timezone`, a display
column that is validated at the write by handing it to `Intl.DateTimeFormat` and seeing
whether the runtime accepts it. Nothing compares in it, ever.

That column is also the argument for the whole trade rather than against it. The thing an
ISO string appears to give you is a local time you can read, and a local time is precisely
what SQLite cannot compute, because there is no zone database inside it; the recipe above can
take a fixed `'+05:30'` and nothing more. A text column holding local time would therefore
hold a value the database cannot convert and the application has to reinterpret, and the
reinterpretation is where a submission deadline goes wrong by an hour on the last Sunday in
October. Storing the instant and rendering the zone puts the conversion in the one place that
has a zone table.

Third, time enters the product through one clock and `tests/source.test.ts` fails the suite
if it enters anywhere else. `src/db/clock.ts` is the only module allowed to read
`Date.now()`; everything downstream takes a `Clock`, which is how a test asserts on both
sides of a deadline one millisecond apart without sleeping. The dispatcher reads the clock
once per request and passes that instant down, so every timestamp written by one request
agrees, a row and the ledger entry describing it cannot differ by the two milliseconds the
insert took.

## Identity is a ULID, for three reasons and one of them is about people

Ids are 26 characters of Crockford base32: ten encoding a 48-bit millisecond timestamp, then
sixteen encoding 80 random bits. They sort by creation time as text, so `order by id` is a
stable tiebreak everywhere in the product and an exported table diffs in a sensible order.
They carry no information about how many of a thing exist, a sequential integer in a URL
tells a participant how many teams registered before them, and tells anybody holding one id
that the one below it probably exists. And they are minted by the application rather than the
database, so an insert knows the id it is about to write and the ledger entry describing that
insert can name its subject inside the same transaction.

The third reason is the one that is about people rather than about data: Crockford base32
excludes I, L, O and U, so an id read down a phone line or copied out of a screenshot has no
ambiguous characters in it and cannot accidentally spell a word.

Monotonicity within a process is not free and is implemented rather than assumed. Two ids
minted in the same millisecond would otherwise sort arbitrarily, and a seeded event that
inserts sixty projects in one tick would produce a ranking whose tiebreak order changed
between runs, which would quietly make the normalization proof non-reproducible. So when the
clock has not advanced, the random field is incremented instead of redrawn, which is the ULID
specification's own answer and keeps the sort total.

## The engine is arithmetic, and it is the reason for the rest

`src/judging` is 3,453 lines that import nothing. It is the part of this product that could
not be bought: everything else here is a portal, and portals exist.

The problem it solves is that judging is an incomplete block design. Each judge sees a subset
of the projects, so a raw mean carries two separate judge artefacts, *leniency*, a judge who
marks a point high across the board, and *scale*, a judge who uses the whole range while
another lives between 3 and 4. Averaging treats a 4 from a harsh judge and a 4 from a
generous one as the same evidence. They are not, and the projects that drew the generous
judge win.

The model is additive with a per-judge scale, `y_ij = mu + theta_i + b_j + eps` with
`eps ~ N(0, sigma^2 / s_j^2)`, fitted by weighted backfitting: `mu` pinned to the grand mean
and the judge effects constrained to average zero, which is what makes the parameters
identifiable at all. Scale is estimated as the slope of a judge's leniency-removed scores
against current project quality, then shrunk toward 1 in proportion to how many ballots that
judge actually filed.

The shrinkage is the load-bearing part, and the case worth naming is the judge who marks
everything a 3: their scale estimate is near zero, and dividing by it would explode. Four
things stop that, shrinkage bounds the estimate, a hard floor clamps it, the ballot's
information weight collapses so it barely moves the *ordering* while the leniency term still
absorbs the offset, and the judge is flagged in the diagnostics so an organizer can add a
review. The last one matters most, because the correct fix for a judge who is not
discriminating is a human one.

Pairwise comparisons are fitted separately, by Bradley–Terry, and the results page prints the
gap between the two rankings rather than averaging them into one. Two methods that agree are
worth more than a single number that hides where they did not.

Two passes then read that fit without being able to change it, which is what makes them safe
to print beside a ranking. `reliability.ts` decomposes the spread into project, judge and
residual shares, turns the residual into a standard error and a 95% interval around every
adjusted score, and collapses the field into the tiers those intervals actually separate -
Wright and Masters' separation index and strata, `strata = (4G + 1) / 3`, so a page can say
"the evidence resolves four levels across forty projects" instead of implying it resolves
forty. `criteria.ts` reads the rubric line by line: how much of each criterion's declared
range the panel used, how much of its spread is between projects rather than within one, how
far apart the panel read its words once each judge's overall strictness is subtracted, and
which pairs correlate closely enough to be one question asked twice under two weights.
Neither pass can move a ranking; both can only describe one.

Where each lands is a boundary decision rather than a layout one, and it is drawn by field.
The anonymous half of the first pass is public, `results.show` publishes the shares, the
separation, the tier count and a per-project interval, because a reader entitled to the order
is entitled to know how much of it the evidence supports. Everything that identifies a person
is organizer-only: the per-judge residual spreads, the flagged ballots, the diagnostics whose
`subjects` array carries raw ids, and the whole of the criteria pass, since judge divergence on
a three-judge panel lets a reader who knows the roster work backwards to who differed.
`tests/publish.test.ts` asserts that line by searching the serialised body for every roster id
rather than by inspecting the fields somebody remembered to check.

The purity is what makes any of this checkable. `npm run prove:normalization` plants a truth
- project qualities, judge leniencies and scales, ballots generated through them and
quantised to integers a judge can actually click, assignment drawn by the real scheduler, and
scores three methods by Kendall's tau against an ordering none of them was shown, over 20
seeds per regime. An engine that could read a database would be an engine whose numbers
depend on one, which is why the layer rule is enforced by a test rather than a convention. A
source rule in the same file forbids `Math.random` anywhere under `src/`, since a random
number nobody can reproduce would void the same guarantee more quietly.

## The ledger, and the claim it does not make

Every state change an organizer or a judge makes is appended to `ledger`, and every entry
carries the hash of the one before it. The hashed form is deliberately re-derivable by hand:

```
hash = sha256(JSON.stringify([prev, seq, at, event, actor, action, subject, payload]))
```

A JSON array rather than a delimiter-joined string, because `action`, `subject` and `payload`
are arbitrary text and any separator character could appear inside one of them, which is how
a chain ends up with two different entry sets that hash the same. Payloads are canonicalized
with recursively sorted keys, so re-serializing an entry during an export reproduces the bytes
it was hashed as; without that, the export would fail to verify its own chain.

What makes this structural rather than diligent is `ctx.write`. Repository code has no access
to a raw handle, `tests/source.test.ts` forbids `db.run` and `db.exec` under `src/db/repo/`,
and the barrel exports nothing that would grant one, and `ctx.write` throws unless it is
inside a `recorded()` scope. That scope opens a transaction, runs the mutation, and appends
the entry: after the body, so the entry describes work that succeeded, and inside the
transaction, so it cannot describe work that did not. The row and the record of the row commit
together or not at all.

There is one escape hatch, `ctx.unaudited`, and it takes a mandatory reason from a closed set
of exactly three: rate-limit counters, session liveness touches, and sweeps of expired rows.
Left unaudited they are invisible; audited they would be most of the ledger, and an activity
feed nobody can read is not oversight. `tests/db.test.ts` asserts on that exact set, so a
fourth member is a deliberate edit to a test rather than a line that slipped into a diff.

Now the claim this design does not support. **It is not tamper-proof.** Anybody who can write
to the database can recompute the whole chain forward from their edit, and a hash chain living
in the same file as the data it describes detects accidents and careless tampering, not a
determined administrator. `npm run prove:roundtrip` demonstrates the boundary rather than
talking around it: eleven damaged archives are each refused with nothing committed, and a
twelfth, a row edited and every digest around it repaired, is *accepted*, because a manifest
that travels inside the archive cannot authenticate it. What survives that edit is the
original value still sitting in the ledger payload, under a chain that still verifies.

What the design does give is one number. The head hash is published at `/api/healthz` on every
request, so an organizer can write it down, print it in a results page, or read it out at the
opening of judging, after which no earlier entry can be changed without the published number
changing too. That is the property that is actually worth having at a hackathon: a commitment
made before the appeals start. Boot verifies the chain and *warns* rather than refusing, on
the reasoning that the portal's own pages are the only tool an operator has for investigating
a break, and a product that bricks itself over a finding it also publishes is a product that
gets restored from a backup instead of examined.

The vocabulary is closed from both ends. The `action` column has a `CHECK` on its shape,
every write command declares the actions it may append, 26 distinct ones across the 20
writes, and boot refuses a command whose declared action is not in the dialect. A repository
that wrote `ballot.enteredOnBehalf` therefore does not fail review; it fails at the insert.
That exact string was in this repository until the check was tightened, which is why the
source scan checks the spelling of every `action:` literal under `src/` as well.

## Rendering, and why there is no client

A view is a function from one command's result to markup, looked up by the command's name.
The obvious alternative, a `page` property on the declaration itself, was rejected because
it puts HTML in the file the OpenAPI document is generated from, and then the claim that the
JSON API is not the second-class rendering becomes a matter of discipline rather than of
structure.

A missing view is not an error. Of the 69 operations, 21 have a hand-written page and
three of the remaining GETs, the OpenAPI document, the capability matrix and the health check -
render through a generic renderer that shows the same data as a definition list. The other twenty
are POSTs, which never render at all: a browser that posts one gets a 303 to the page that shows
the result, so the thing it reads afterwards is a hand-written page belonging to a different
operation. That is what makes the generic renderer worth having rather than a placeholder, every
command has a browser spelling from the moment it is declared, and nothing is ever blocked on a
template. The lookup is keyed on the name and never on the path, because a path
is a fact about routing that can change while a name is the operation's identity, and
`makeApp` refuses to boot if a key in `VIEWS` is not a command, which is the check that stops
a renamed command from silently falling back to the generic page. That failure is otherwise
invisible, because the generic page works.

`src/view` knows nothing about a request: no cookies, no headers, no status codes. It is
handed a result and a `whoami`, and it returns a string. There is one stylesheet, built in
`src/view/style.ts` and served from one route, and there is no asset pipeline, nothing is
compiled, bundled, hashed or minified, because nothing needs to be.

That one file is also where the product's surface is decided, and it is decided entirely in
CSS: the translucency, the layered gradients under it, the spring on a hover, the `rise` a
panel arrives on. All of it is switched off wholesale under `prefers-reduced-motion`, which is
the only branch in the file that is about a person rather than a shape. The strangest thing in
it is a consequence rather than a choice, fifty-one classes, `.meter.p0` through `.meter.p100`
in two-point steps, because `style-src 'self'` forbids the inline `width` a bar chart would
normally carry, and a proportion is the one piece of styling that genuinely depends on data.
So the width comes from a class and `meter()` in `src/view/html.ts` snaps the fraction to the
nearest rung, while the figure beside the bar is printed to one decimal and repeated in its
`aria-label`. The graphic is therefore the coarser of the two by a factor of twenty, which is the
property that matters: no comparison on these pages has to be made off the pixels, and nothing on
them is readable only as a bar. Neither number is the unrounded quantity, a variance share is a
share of a fit's own sum on an incomplete design, and its fourth significant figure is not
something to act on, but the rounding a reader sees is stated where it happens rather than
implied by a bar's width.

Two of these primitives exist because CSS on its own produced a page that looked finished and
was not usable. A table wide enough to scroll was wrapped in `overflow-x: auto`, which is a
mouse, a trackpad and a finger, on a narrow window the last columns of the dashboard's
diagnostics table could not be reached at all without one. The fix is `scroller()`, and it
takes a label as a required argument rather than an optional one, because a box that is
focusable and announces as nothing is the same defect wearing the other coat. Every table goes
through it, including narrow ones that will never overflow: CSS cannot tell a caller whether a
box is currently scrolling, and a tab stop that turns out to have nothing to scroll is a much
smaller cost than a column no keyboard can see. The same reasoning retired a `@keyframes`
block that was defined and never played and a `pre` rule for an element no page emits, both
were silent, and both are now checked in `tests/view.test.ts` and `tests/source.test.ts`
rather than remembered.

There is no client-side JavaScript in this product. Not "progressive enhancement", not a
sprinkle: none. Which is why the Content Security Policy on every response is
`default-src 'none'` with `style-src 'self'` beside it and nothing else granted, not even
`img-src`, because the product emits no image and the two washes of colour behind every page
are gradients, rather than the usual `script-src 'self'`. That header is a description of the
truth rather than a budget somebody might spend later, and it is the one security control here
that cannot rot, because adding a script would break the page in the same request that added it.

That absence also settles CSRF without a token. Three facts stand in for one: the session
cookie is `SameSite=Lax`, `form-action 'self'` forbids a form on this origin from posting
anywhere else, and **no `GET` in this product can write**, which is not a convention but a
boot failure, since `checkEffect` refuses a `GET` that declares any ledger action. A write
therefore requires a same-site `POST`, and every one of them answers a browser with a 303 so
that a reload cannot repeat it.

## Boot, and the process

`bin/manak.ts` is outside `src/` and that placement is enforced from the other side: nothing
under `src/` except `src/http/` may import `src/http/`, so the only places that may call
`listen` are `tools/` and this file. The layer rule and the question "where does this process
actually start" therefore have the same answer, and a stray `listen` in a repository module
fails the suite rather than review.

It owns three things nothing above it does. It reads the environment, every option `makeApp`
takes is a value somebody has to supply, and doing it in one file is most of what keeps
`process.env` out of 69 handlers. Anything that is not plainly a boolean is refused rather
than read as false, because `MANAK_TRUST_PROXY=maybe` meaning "off" is a misconfiguration
that never announces itself. It migrates before serving, which is a deliberate trade in favour
of a one-command boot and is safe only because `planMigrations` refuses a divergent history:
an automatic migration either applies the pending files or throws before the socket opens. And
it decides what stops the process, a corrupt database does, a broken ledger chain does not -
and how it stops: on `SIGTERM`, stop listening, give in-flight responses five seconds, close
the database, exit 0, with a second signal meaning somebody is out of patience.

A sweep of expired sessions, spent links and closed rate-limit windows runs every fifteen
minutes on an unreferenced timer, wrapped so that a throw inside it cannot take the server
with it. Nothing in it is required for correctness, an unswept expired row is already inert,
because `resolveSession` reads `expires_at`, so a lost sweep costs disk rather than safety,
and the right response to one is a line on stderr.

One line per request goes to stdout, carrying the refusal's code and none of the caller's
input, because a log that echoes submissions is a log that eventually contains a magic-link
token and this product has no way to redact one afterwards. That sentence is why the logged
path is not simply the path: `GET /api/signin/:token` carries a credential in the URL itself,
so a path segment that matched a field declared `secret` is written back as its parameter
name. One gap is worth naming rather than hiding: a log line carries no correlation id, so a
stack trace cannot be tied to its request when two arrive at once.

## How to check this file

Nothing above has to be taken on trust, and the point of the shape it describes is that most
of it is checkable from outside the source. `/api/capabilities` publishes the access matrix,
computed from the same declarations the dispatcher enforces, so every refusal this deployment
intends to make can be read before a single request is sent, and then
`npm run prove:isolation` sends
69 × 6 × 2 = 828 requests over a real socket and compares every answer to it.
`npm run prove:normalization` re-derives the engine's numbers from a seed.
`npm run prove:roundtrip` exports 145 rows through 19 files, imports them into an empty
database, exports again and compares the bytes. All three are committed, re-executable, and
run as tests by `tests/proof.test.ts`, so a change that quietly invalidates one fails
`npm test` rather than waiting to be noticed.

The 568 tests are Node's own runner with no framework. Three files in there are load-bearing in
a way the rest are not: `tests/source.test.ts` holds every layer and source rule described
above,
`tests/api.test.ts` asserts that every refusal the published document describes is one the
command layer can actually send, and `tests/schema.test.ts` asserts that every response
matches the schema that document publishes for it, in both directions, so a field a handler
added without a schema edit fails the suite rather than shipping undocumented.

## The cut line: there is no abstraction over storage

Every architecture document should name what it declined to build, so here is the one that
would take the most work to reverse. **There is no repository interface, no query builder, no
driver seam, and no supported path to Postgres.** `src/db/repo/*.ts` is SQL literals against
`node:sqlite`, and moving this product to another database means rewriting that directory.

The reason is that the schema guarantees described above *are* the choice of SQLite, not
decoration on top of it. `STRICT` tables, a role pinned inside a foreign key by a generated
column,
`without rowid` composite primary keys, `CHECK` constraints holding closed sets inline, a
portable layer would have to either give those up or reimplement them as validations in
TypeScript, which is precisely the trade this schema was written to avoid. An abstraction over
two databases when only one is in use is an abstraction fitted to one, and it would arrive
with the cost of a second dependency in a product whose first claim is that it has none.

The honest mitigation is not that the decision is right in general; it is that its blast radius
is bounded and measurable. Everything above storage reaches it through one file, enforced by a
test, so the surface that would have to be reimplemented is 3,965 lines of TypeScript in one
directory plus 400 lines of SQL in one migration, and the round-trip proof means the data
could leave first. A portal for a three-day event on one box does not have a second writer to
serve, and SQLite in WAL mode is not the thing that will run out first.

---

## Content, evidence lab and integrations

Rich project content uses an additive migration. Media is validated on ingestion and output. Comments are projected from creation/moderation ledger events, returning up to 100 visible entries. Hidden text remains in private audit history.

The organizer dashboard exposes readiness first. Numerical fits are cached per database/event/ledger head with a 32-event bound. Authorization and publication checks stay outside that cache. Hodge, reviewer W2 and voting analyses are explicit `lab` requests with input bounds. None modifies scores. See [JUDGING.md](../JUDGING.md).

The composition root starts an optional webhook worker. Its durable source is the ledger; an atomic destination-bound cursor tracks acknowledgements. Messages are signed event invalidations, and authorized receivers fetch details through the API. One worker owns a checkpoint. Key generation, retry/backoff, and graceful shutdown occur at the process boundary. See [OPERATIONS.md](../OPERATIONS.md).

Manak 0.1.0, written by Sai Ram (Hardik) Dash, <https://github.com/ewwhardik>. MIT.
