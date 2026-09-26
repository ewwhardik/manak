-- Manak, initial schema.
--
-- Five decisions are made once here and then relied on everywhere, so they are
-- written down where the tables are rather than in a document nobody opens.
--
-- 1. Every table is STRICT. SQLite's default type affinity will happily store
--    the string 'banana' in a column declared INTEGER, which turns a typo in a
--    handler into a wrong number in a published ranking. STRICT makes it an
--    error at the write.
--
-- 2. Every instant is INTEGER epoch milliseconds, named `*_at`. Deadline
--    enforcement is the one piece of clock arithmetic that decides whether a
--    submission counts, and comparing integers is total and timezone-free.
--    Events carry a display `timezone` so a rendered page can be local without
--    the comparison ever being. The cost is that a human reading the database
--    directly sees 1790000000000; `docs/ARCHITECTURE.md` owns that trade.
--
-- 3. Every event-scoped row carries `event_id`, and every reference between two
--    such rows is a composite foreign key through it. The redundancy is the
--    point: it makes a ballot on another event's project unrepresentable rather
--    than merely a bug, and it means isolation is one predicate that a reviewer
--    can grep for. Tables whose own primary key is `id` therefore also declare
--    `unique (event_id, id)` to be a valid parent for those keys. That is a
--    second index on small tables, bought deliberately.
--
-- 4. Deletion is stated on every foreign key, never defaulted. `cascade` where
--    the child is part of the parent (a score belongs to its ballot),
--    `restrict` where the child is evidence (a rubric version that ballots were
--    scored against cannot be deleted out from under them).
--
-- 5. Booleans are INTEGER with a CHECK, closed sets are TEXT with a CHECK, and
--    both are spelled out inline. A closed set in a lookup table is a join for
--    something the code already knows.
--
-- `migration` is created by the runner in `src/db/migrate.ts`, not here: it has
-- to exist before the first migration can be recorded.

create table event (
  id                   text    primary key,
  slug                 text    not null unique,
  name                 text    not null,
  -- IANA zone, for rendering only. No comparison in this database uses it.
  timezone             text    not null default 'UTC',
  submissions_open_at  integer not null,
  submissions_close_at integer not null,
  judging_open_at      integer not null,
  judging_close_at     integer not null,
  -- The results tier is off until an organizer publishes it. Default-closed:
  -- an event that is misconfigured leaks nothing.
  results_public       integer not null default 0 check (results_public in (0, 1)),
  pairwise_enabled     integer not null default 0 check (pairwise_enabled in (0, 1)),
  reviews_per_project  integer not null default 3
                       check (reviews_per_project between 1 and 20),
  created_at           integer not null,
  archived_at          integer,
  -- Slugs appear in URLs, so the character set is narrowed here rather than
  -- trusted to a validator that some future code path forgets to call.
  --
  -- Written as a negated glob for a reason worth knowing: in SQLite's GLOB, `*`
  -- matches any run of any characters, so the natural-looking
  -- `slug glob '[a-z0-9][a-z0-9-]*'` constrains the first two characters and
  -- nothing else -- it accepts 'ab CDE!'. `not glob '*[^set]*'` is the form that
  -- means "no character outside the set, anywhere". It is satisfied by the empty
  -- string, which is why the length check is not decoration.
  check (
    substr(slug, 1, 1) glob '[a-z0-9]'
    and slug not glob '*[^a-z0-9-]*'
    and length(slug) between 2 and 64
  ),
  check (length(name) between 1 and 200),
  check (submissions_close_at > submissions_open_at),
  check (judging_close_at > judging_open_at)
  -- Deliberately absent: any check that judging starts after submissions close.
  -- Rolling judging is a real format, and a constraint an organizer cannot
  -- override is worse than a warning they can read.
) strict;

-- An identity, global to the deployment. Accounts are not event-scoped: the same
-- person judges one event and submits to another, and duplicating them per event
-- would mean two inboxes for one address.
create table account (
  id           text    primary key,
  email        text    not null unique,
  display_name text    not null,
  created_at   integer not null,
  disabled_at  integer,
  -- Stored lower-cased so uniqueness is real. Without this, Ada@x and ada@x are
  -- two accounts and one of them never receives a link.
  check (email = lower(email)),
  check (email like '%_@_%.__%' and length(email) <= 254),
  check (length(display_name) between 1 and 120)
) strict;

-- Roles are per event, and an account may hold more than one: an organizer who
-- also judges is the common case, so the role is part of the key rather than a
-- column that has to be overwritten.
create table membership (
  event_id   text    not null references event (id) on delete cascade,
  account_id text    not null references account (id) on delete cascade,
  role       text    not null check (role in ('organizer', 'judge', 'participant')),
  created_at integer not null,
  primary key (event_id, account_id, role)
) strict, without rowid;

-- Sessions and magic links store a SHA-256 of the token, never the token. A
-- stolen database backup therefore does not hand over live sessions, and the
-- length check keeps a plaintext token from being written here by mistake.
--
-- The hex check is a negated glob, for the reason given at `event.slug`: `hash
-- glob '[0-9a-f]*'` would only constrain the first character, so a token stored
-- verbatim would pass it as long as it happened to start with a hex digit and
-- ran to 64 characters. `not glob '*[^0-9a-f]*'` means what it looks like.
create table session (
  token_hash   text    not null primary key,
  account_id   text    not null references account (id) on delete cascade,
  created_at   integer not null,
  expires_at   integer not null,
  last_seen_at integer not null,
  revoked_at   integer,
  user_agent   text    not null default '',
  check (length(token_hash) = 64 and token_hash not glob '*[^0-9a-f]*'),
  check (expires_at > created_at)
) strict;

create table magic_link (
  token_hash  text    not null primary key,
  email       text    not null,
  -- Null for a link that signs someone in without joining an event.
  event_id    text    references event (id) on delete cascade,
  invited_role text   check (invited_role in ('organizer', 'judge', 'participant')),
  issued_at   integer not null,
  expires_at  integer not null,
  consumed_at integer,
  check (length(token_hash) = 64 and token_hash not glob '*[^0-9a-f]*'),
  check (email = lower(email)),
  check (expires_at > issued_at),
  check (invited_role is null or event_id is not null)
) strict;

-- Fixed-window counters. The window start is part of the key, so expiry is a
-- delete of old rows rather than a background sweep that has to be scheduled.
create table rate_limit (
  bucket      text    not null,
  window_at   integer not null,
  hits        integer not null default 0 check (hits >= 0),
  primary key (bucket, window_at)
) strict, without rowid;

-- Tracks are optional. An event with no track rows judges one pool; the judging
-- engine warns when tracks split the judge-project graph into pieces with no
-- common reference point, because leniency is not comparable across them.
create table track (
  event_id text    not null references event (id) on delete cascade,
  key      text    not null,
  label    text    not null,
  ordering integer not null default 0,
  primary key (event_id, key),
  check (
    substr(key, 1, 1) glob '[a-z0-9]'
    and key not glob '*[^a-z0-9_-]*'
    and length(key) between 1 and 40
  ),
  check (length(label) between 1 and 120)
) strict, without rowid;

create table team (
  id         text    primary key,
  event_id   text    not null references event (id) on delete cascade,
  name       text    not null,
  created_at integer not null,
  -- Parent key for the composite foreign keys below.
  unique (event_id, id),
  unique (event_id, name),
  check (length(name) between 1 and 120)
) strict;

-- One person, one team, per event. Two teams would make "whose submission is
-- this" ambiguous at exactly the moment it matters.
create table team_member (
  event_id   text    not null,
  team_id    text    not null,
  account_id text    not null references account (id) on delete cascade,
  created_at integer not null,
  primary key (event_id, team_id, account_id),
  unique (event_id, account_id),
  foreign key (event_id, team_id) references team (event_id, id) on delete cascade
) strict, without rowid;

create table project (
  id           text    primary key,
  event_id     text    not null references event (id) on delete cascade,
  team_id      text    not null,
  title        text    not null,
  summary      text    not null default '',
  repo_url     text,
  demo_url     text,
  track_key    text,
  status       text    not null default 'draft'
               check (status in ('draft', 'submitted', 'withdrawn', 'disqualified')),
  created_at   integer not null,
  submitted_at integer,
  withdrawn_at integer,
  unique (event_id, id),
  foreign key (event_id, team_id)   references team  (event_id, id)  on delete cascade,
  -- restrict: deleting a track that projects chose would silently re-pool them.
  foreign key (event_id, track_key) references track (event_id, key) on delete restrict,
  check (length(title) between 1 and 200),
  check (length(summary) <= 4000),
  -- http:// submissions would be linked from a judge's browser. Refuse them at
  -- the schema so no handler has to remember.
  check (repo_url is null or repo_url like 'https://%'),
  check (demo_url is null or demo_url like 'https://%'),
  -- The timestamp and the status cannot disagree. `submitted_at` stays set once
  -- a project has been submitted, including after withdrawal: the fact that it
  -- was in before the deadline is exactly what a dispute turns on.
  check ((submitted_at is null) = (status = 'draft')),
  check ((withdrawn_at is not null) = (status = 'withdrawn'))
  -- Deliberately absent: unique (event_id, title). Duplicate titles are bad for
  -- judges and worse as a submission refused at the deadline; the organizer
  -- dashboard flags collisions instead.
) strict;

-- Rubrics are versioned, and a ballot binds to the version it was scored
-- against. An organizer who edits criteria mid-judging creates a new version;
-- the old ballots keep meaning what they meant.
create table rubric (
  event_id     text    not null references event (id) on delete cascade,
  version      integer not null check (version >= 1),
  published_at integer,
  created_at   integer not null,
  primary key (event_id, version)
) strict, without rowid;

create table criterion (
  event_id       text    not null,
  rubric_version integer not null,
  key            text    not null,
  label          text    not null,
  weight         real    not null check (weight > 0),
  min_score      integer not null,
  max_score      integer not null,
  ordering       integer not null default 0,
  primary key (event_id, rubric_version, key),
  foreign key (event_id, rubric_version)
    references rubric (event_id, version) on delete cascade,
  check (
    substr(key, 1, 1) glob '[a-z]'
    and key not glob '*[^a-z0-9_]*'
    and length(key) between 1 and 40
  ),
  check (length(label) between 1 and 160),
  check (max_score > min_score)
) strict, without rowid;

-- Who is asked to judge what. The `is_judge` generated column exists so the
-- foreign key can reach `membership`'s three-column key with the role pinned:
-- an assignment to somebody who is not a judge in that event fails at the
-- write, and revoking the role deletes the assignment rather than leaving a
-- ballot slot nobody can fill. A CHECK cannot do this — it would need a
-- subquery — and a trigger would be a second place to look.
create table assignment (
  event_id   text    not null,
  judge_id   text    not null,
  project_id text    not null,
  reason     text    not null default 'schedule'
             check (reason in ('schedule', 'manual', 'backfill')),
  created_at integer not null,
  is_judge   text    generated always as ('judge') virtual,
  primary key (event_id, judge_id, project_id),
  foreign key (event_id, project_id) references project (event_id, id) on delete cascade,
  foreign key (event_id, judge_id, is_judge)
    references membership (event_id, account_id, role) on delete cascade
) strict, without rowid;

create table ballot (
  id             text    primary key,
  event_id       text    not null,
  judge_id       text    not null,
  project_id     text    not null,
  rubric_version integer not null,
  comment        text    not null default '',
  created_at     integer not null,
  submitted_at   integer,
  is_judge       text    generated always as ('judge') virtual,
  unique (event_id, id),
  -- Parent key for `score`, which carries the version so its criteria can be
  -- checked against the same rubric the ballot was scored on.
  unique (event_id, id, rubric_version),
  -- The judging engine refuses two ballots from one judge on one project. Here
  -- that precondition is structural instead of a validation the engine has to
  -- perform on data it did not choose.
  unique (event_id, judge_id, project_id),
  foreign key (event_id, project_id) references project (event_id, id) on delete cascade,
  foreign key (event_id, judge_id, is_judge)
    references membership (event_id, account_id, role) on delete cascade,
  -- restrict: a rubric version with ballots against it is evidence.
  foreign key (event_id, rubric_version)
    references rubric (event_id, version) on delete restrict,
  check (length(comment) <= 4000)
) strict;

create table score (
  event_id       text    not null,
  ballot_id      text    not null,
  rubric_version integer not null,
  criterion_key  text    not null,
  value          integer not null,
  primary key (ballot_id, criterion_key),
  foreign key (event_id, ballot_id, rubric_version)
    references ballot (event_id, id, rubric_version) on delete cascade,
  foreign key (event_id, rubric_version, criterion_key)
    references criterion (event_id, rubric_version, key) on delete restrict
  -- Deliberately absent: a check that `value` is within the criterion's own
  -- [min_score, max_score]. That needs a subquery, which SQLite forbids in a
  -- CHECK. It is enforced in `src/db/repo/judging.ts` on the way in and
  -- re-checked by `verifyScoreRanges`, which reports rows the schema cannot.
) strict, without rowid;

-- One pairwise decision. The pair is stored in canonical order (`left_id <
-- right_id`) so that "these two projects" is one row shape rather than two, and
-- the unique below can then actually prevent a judge from ruling on the same
-- pair twice.
--
-- A skip is recorded, not dropped. The engine only consumes decisive rows, but
-- a judge who skips two thirds of their duels is a diagnostic an organizer
-- should see, and that is only possible if the skip was written down.
create table comparison (
  id         text    primary key,
  event_id   text    not null,
  judge_id   text    not null,
  left_id    text    not null,
  right_id   text    not null,
  outcome    text    not null check (outcome in ('left', 'right', 'skip')),
  winner_id  text,
  -- Why the scheduler offered this pair; 'manual' is a duel a judge asked for.
  reason     text    not null
             check (reason in ('bridge', 'informative', 'explore', 'exposure', 'manual')),
  decided_at integer not null,
  is_judge   text    generated always as ('judge') virtual,
  unique (event_id, id),
  unique (event_id, judge_id, left_id, right_id),
  foreign key (event_id, left_id)  references project (event_id, id) on delete cascade,
  foreign key (event_id, right_id) references project (event_id, id) on delete cascade,
  foreign key (event_id, judge_id, is_judge)
    references membership (event_id, account_id, role) on delete cascade,
  check (left_id < right_id),
  check ((winner_id is null) = (outcome = 'skip')),
  check (winner_id is null or winner_id in (left_id, right_id)),
  check ((outcome = 'left') = (winner_id is not null and winner_id = left_id))
) strict;

-- The audit ledger: append-only, hash-chained, and deliberately without foreign
-- keys. An audit trail whose rows vanish when the thing they describe is deleted
-- is not an audit trail — "organizer disqualified project X" has to outlive
-- project X. `event_id` and `actor_id` are therefore plain text, nullable for
-- deployment-wide and system actions respectively.
--
-- `hash` covers the previous hash, so altering any earlier row invalidates every
-- row after it. `src/db/ledger.ts` walks the chain to prove it; the unique on
-- `hash` only catches accidents.
create table ledger (
  seq        integer primary key autoincrement,
  at         integer not null,
  event_id   text,
  actor_id   text,
  action     text    not null,
  subject    text    not null default '',
  payload    text    not null default '{}',
  prev_hash  text    not null,
  hash       text    not null unique,
  check (length(hash) = 64 and hash not glob '*[^0-9a-f]*'),
  check (length(prev_hash) = 64 and prev_hash not glob '*[^0-9a-f]*'),
  -- `action` is the vocabulary the audit trail is read by, so it is kept to
  -- lower-case dotted words. Negated glob, again: `action glob '[a-z][a-z0-9._]*'`
  -- accepted 'ballot submitted' and any other sentence starting with two letters.
  check (
    substr(action, 1, 1) glob '[a-z]'
    and action not glob '*[^a-z0-9._]*'
    and length(action) between 3 and 64
  ),
  check (json_valid(payload))
) strict;

-- Indexes for the reads that exist rather than the reads that might. Every
-- composite primary key above already indexes its own leftmost columns, so what
-- is left is the accesses that start somewhere other than the key.
create index ballot_by_project    on ballot (event_id, project_id);
create index ballot_by_judge      on ballot (event_id, judge_id, submitted_at);
create index score_by_event       on score (event_id, rubric_version);
create index comparison_by_judge  on comparison (event_id, judge_id, decided_at);
create index comparison_by_left   on comparison (event_id, left_id);
create index comparison_by_right  on comparison (event_id, right_id);
create index project_by_status    on project (event_id, status, submitted_at);
create index project_by_title     on project (event_id, title);
create index assignment_by_project on assignment (event_id, project_id);
create index membership_by_account on membership (account_id, event_id);
create index session_by_account   on session (account_id, expires_at);
create index magic_link_by_email   on magic_link (email, issued_at);
create index ledger_by_event      on ledger (event_id, seq);
create index ledger_by_subject    on ledger (subject, seq);
