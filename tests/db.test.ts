/**
 * The storage layer, end to end.
 *
 * Organised by the claim being checked rather than by module, because the claims are
 * what the rest of the system is entitled to assume. Four of them are load-bearing
 * enough that the tests exist mainly to keep somebody from quietly removing them:
 *
 *   - **No write reaches the database without a ledger entry.** `ctx.write` throws
 *     outside a scope, the three unaudited reasons are asserted as an exact set, and
 *     every call site that uses one is enumerated below. A fourth reason is therefore
 *     a deliberate edit to this file.
 *   - **A token is never stored in plaintext.** Checked by minting one and then
 *     searching the database file *and its write-ahead log* for the bytes. That is a
 *     stronger statement than reading the column back, because the column is not the
 *     only place SQLite writes a value.
 *   - **A ballot from a non-judge cannot exist.** The schema's generated-column
 *     foreign key is what makes that true, and revoking the role cascades. Both
 *     directions are tested.
 *   - **Deadlines are exact.** Asserted at the closing millisecond and the one
 *     before it, because "roughly closed" is the kind of rule an appeal is about.
 *
 * Fixtures come from `tests/support/world.ts` and therefore go through the real
 * repositories. A test whose setup used `insert into ballot ...` could assert on a
 * database state no code path can produce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkIntegrity,
  DatabaseError,
  openDatabase,
  openReadOnly,
} from "../src/db/open.ts";
import { fromIso, manualClock, MS, toIso } from "../src/db/clock.ts";
import { ID_LENGTH, idTime, isId, makeIds } from "../src/db/ids.ts";
import { migrate, migrationStatus, planMigrations, readMigrations, sha256 } from "../src/db/migrate.ts";
import { makeContext, RuleError, UNAUDITED_REASONS } from "../src/db/context.ts";
import type { Ctx } from "../src/db/context.ts";
import { headHash, ledgerLength, readLedger, verifyLedger } from "../src/db/ledger.ts";
import {
  assertGate,
  createEvent,
  createTrack,
  findEventBySlug,
  gatesFor,
  listEvents,
  listTracks,
  setResultsPublic,
  updateEvent,
} from "../src/db/repo/events.ts";
import {
  consumeMagicLink,
  createSession,
  findAccountByEmail,
  grantRole,
  hashToken,
  hasRole,
  issueMagicLink,
  MAGIC_LINK_TTL,
  membersOf,
  mintToken,
  normalizeEmail,
  resolveSession,
  revokeRole,
  revokeSession,
  rolesIn,
  sameToken,
  sessionsOf,
  SESSION_TTL,
  sweepExpired,
  touchSession,
  upsertAccount,
} from "../src/db/repo/accounts.ts";
import { consume, enforce, LIMITS, peek, sweepRateLimits } from "../src/db/repo/rate.ts";
import {
  addTeamMember,
  createProject,
  createTeam,
  disqualifyProject,
  duplicateTitles,
  findProject,
  findProjectIn,
  judgeablePool,
  listProjects,
  submitProject,
  teamOf,
  updateProject,
  withdrawProject,
} from "../src/db/repo/projects.ts";
import type { ProjectRow, TeamRow } from "../src/db/repo/projects.ts";
import { castVote, startVoter, voteTotals } from "../src/db/repo/voting.ts";
import {
  assertScoreInRange,
  createRubricVersion,
  criteriaOf,
  loadRubric,
  publishedVersion,
  publishRubric,
  verifyScoreRanges,
} from "../src/db/repo/rubrics.ts";
import {
  assignmentsOf,
  assignProject,
  ballotsOf,
  canonicalPair,
  comparisonsOf,
  coverageGaps,
  deleteBallot,
  findBallot,
  judgeProgress,
  loadJudgingInput,
  projectCoverage,
  recordComparison,
  saveBallot,
  scoresOf,
  unassignProject,
} from "../src/db/repo/judging.ts";
import { freshDb, FULL_SCORES, tempDb, T0, world } from "./support/world.ts";

// ---------------------------------------------------------------------------
// The handle: pragmas, transactions, and the errors that are worth having.
// ---------------------------------------------------------------------------

test("an on-disk database gets WAL and enforced foreign keys; :memory: skips WAL", () => {
  const h = tempDb();
  assert.equal(h.db.one<{ journal_mode: string }>("pragma journal_mode").journal_mode, "wal");
  assert.equal(h.db.one<{ foreign_keys: number }>("pragma foreign_keys").foreign_keys, 1);
  assert.equal(h.db.one<{ trusted_schema: number }>("pragma trusted_schema").trusted_schema, 0);
  h.close();
  const mem = freshDb();
  // WAL on a memory database is a no-op SQLite reports as `memory`, so asking for it
  // would be a pragma that looks applied and is not.
  assert.equal(mem.db.one<{ journal_mode: string }>("pragma journal_mode").journal_mode, "memory");
  assert.equal(mem.db.one<{ foreign_keys: number }>("pragma foreign_keys").foreign_keys, 1);
  mem.close();
});

test("event settings update atomically and append an auditable change", () => {
  const h = world();
  const before = ledgerLength(h.db);
  const updated = updateEvent(h.asOrganizer, h.event, {
    name: "Updated event",
    timezone: "Asia/Kolkata",
    submissionsOpenAt: h.event.submissions_open_at,
    submissionsCloseAt: h.event.submissions_close_at,
    judgingOpenAt: h.event.judging_open_at,
    judgingCloseAt: h.event.judging_close_at,
    reviewsPerProject: 4,
    pairwiseEnabled: true,
  });
  assert.deepEqual(
    [updated.name, updated.timezone, updated.reviews_per_project, updated.pairwise_enabled],
    ["Updated event", "Asia/Kolkata", 4, 1],
  );
  assert.equal(ledgerLength(h.db), before + 1);
  assert.equal(readLedger(h.db, { subject: h.event.id })[0]?.action, "event.updated");
  h.close();
});

test("public voting enforces quadratic credits and refunds a revised vote", () => {
  const h = world();
  const event = updateEvent(h.asOrganizer, h.event, {
    name: h.event.name,
    timezone: h.event.timezone,
    submissionsOpenAt: h.event.submissions_open_at,
    submissionsCloseAt: h.event.submissions_close_at,
    judgingOpenAt: h.event.judging_open_at,
    judgingCloseAt: h.event.judging_close_at,
    reviewsPerProject: h.event.reviews_per_project,
    pairwiseEnabled: h.event.pairwise_enabled === 1,
    votingOpenAt: T0 - MS.hour,
    votingCloseAt: T0 + MS.hour,
    votingMode: "open",
    votingCredits: 10,
  });
  const voter = startVoter(h.system, event, { fingerprint: "fingerprint", accountId: null });
  const project = (h.projects[0] as ProjectRow).id;
  assert.equal(castVote(h.system, event, voter.token, project, 3).credits, 1);
  assert.equal(castVote(h.system, event, voter.token, project, 1).credits, 9);
  assert.deepEqual(voteTotals(h.db, event.id), [{ projectId: project, votes: 1, credits: 1 }]);
  h.close();
});

test("one() names the query when there is no row, and get() just returns nothing", () => {
  const h = freshDb();
  assert.equal(h.db.get("select 1 as v where 0"), undefined);
  assert.throws(
    () => h.db.one("select 1 as v where 0"),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "db.missing");
      assert.match(error.message, /select 1 as v where 0/);
      return true;
    },
  );
  h.close();
});

test("a transaction rolls back everything it did, including an inner savepoint", () => {
  const h = freshDb();
  const count = () => h.db.one<{ n: number }>("select count(*) as n from account").n;
  assert.equal(h.db.inTransaction(), false);
  h.system.recorded({ action: "account.created", subject: "a" }, () => {
    h.system.write("insert into account (id, email, display_name, created_at) values ('a','a@x.test','A',1)");
  });
  assert.equal(count(), 1);
  assert.throws(() =>
    h.db.tx(() => {
      h.db.run("insert into account (id, email, display_name, created_at) values ('b','b@x.test','B',1)");
      assert.equal(h.db.inTransaction(), true);
      throw new Error("no");
    }),
  );
  assert.equal(count(), 1, "the outer rollback did not undo the insert");
  assert.equal(h.db.inTransaction(), false);
  h.close();
});

test("an inner failure can be caught without losing the outer transaction's work", () => {
  // This is the reason `tx` uses savepoints rather than a bare `begin`: SQLite refuses
  // a nested `begin`, and a runner that noticed it was already in a transaction and
  // did nothing would silently give the inner block no rollback at all.
  const h = freshDb();
  const ids = () =>
    h.db.all<{ id: string }>("select id from account order by id").map((row) => row.id);
  const insert = (id: string) =>
    h.db.run(
      "insert into account (id, email, display_name, created_at) values (:id, :id || '@x.test', :id, 1)",
      { id },
    );
  h.db.tx(() => {
    insert("outer");
    try {
      h.db.tx(() => {
        insert("inner");
        throw new Error("no");
      });
    } catch {
      // Swallowed on purpose: the point is that the outer transaction survives.
    }
    insert("after");
  });
  assert.deepEqual(ids(), ["after", "outer"], "the inner savepoint took the outer rows with it");
  h.close();
});

test("a closed handle refuses to be used again, and closing twice is not an error", () => {
  const h = tempDb();
  h.db.close();
  h.db.close();
  for (const attempt of [
    () => h.db.all("select 1"),
    () => h.db.get("select 1"),
    () => h.db.run("select 1"),
    () => h.db.exec("select 1"),
  ]) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "db.closed");
      return true;
    });
  }
  rmSync(h.dir, { recursive: true, force: true });
});

test("a read-only handle can read a migrated database and cannot write to it", () => {
  const h = tempDb();
  const events = listEvents(h.db).length;
  const reader = openReadOnly(h.path);
  assert.equal(listEvents(reader).length, events);
  assert.deepEqual(checkIntegrity(reader), []);
  assert.throws(() => reader.run("delete from migration"), /readonly|read-only/i);
  reader.close();
  h.close();
});

// ---------------------------------------------------------------------------
// Time and identity.
// ---------------------------------------------------------------------------

test("the manual clock only moves when a test moves it", () => {
  const clock = manualClock(T0);
  assert.equal(clock.now(), T0);
  assert.equal(clock.now(), T0, "reading the clock advanced it");
  clock.advance(MS.hour);
  assert.equal(clock.now(), T0 + MS.hour);
  clock.set(T0);
  assert.equal(clock.now(), T0);
  assert.deepEqual(
    [MS.second, MS.minute, MS.hour, MS.day],
    [1000, 60_000, 3_600_000, 86_400_000],
  );
});

test("ISO conversion round-trips to the millisecond and refuses nonsense", () => {
  assert.equal(toIso(T0), "2026-09-25T18:00:00.000Z");
  assert.equal(fromIso("2026-09-25T18:00:00.000Z"), T0);
  assert.equal(fromIso(toIso(T0 + 1)), T0 + 1);
  assert.throws(() => fromIso("not a date"));
});

test("ids sort by time, stay unique inside one millisecond, and carry their instant", () => {
  const clock = manualClock(T0);
  const newId = makeIds(clock.now);
  const sameMs = [newId(), newId(), newId()];
  assert.equal(new Set(sameMs).size, 3);
  assert.deepEqual([...sameMs].sort(), sameMs, "ids from one millisecond are not ordered");
  for (const id of sameMs) {
    assert.equal(id.length, ID_LENGTH);
    assert.ok(isId(id));
    assert.equal(idTime(id), T0);
  }
  clock.advance(1);
  const later = newId();
  assert.ok(later > (sameMs[2] as string), "a later id does not sort after an earlier one");
  assert.equal(idTime(later), T0 + 1);
  // Crockford base32 excludes I, L, O and U so a transcribed id cannot be ambiguous.
  assert.equal(isId(sameMs[0]?.replace(/./, "I") ?? ""), false);
  assert.equal(isId("too-short"), false);
});

// ---------------------------------------------------------------------------
// Migrations. The four refusals, each one a corrupted environment somebody has
// already had.
// ---------------------------------------------------------------------------

/** A throwaway migrations directory, so these tests do not touch the real one. */
function migrationsDir(files: Record<string, string>): { dir: string; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "manak-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, "utf8");
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

const TABLE_A = "create table a (id text primary key, v integer not null) strict;\n";
const TABLE_B = "create table b (id text primary key) strict;\n";

test("the real migrations apply once and then report the database as current", () => {
  const db = openDatabase(":memory:");
  const clock = manualClock(T0);
  const first = migrate(db, undefined, clock);
  assert.ok(first.applied.length >= 1);
  assert.equal(first.alreadyCurrent, false);
  const second = migrate(db, undefined, clock);
  assert.deepEqual(second.applied, []);
  assert.equal(second.alreadyCurrent, true);
  const status = migrationStatus(db);
  assert.equal(status.current, true);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(status.problems, []);
  assert.equal(status.applied, first.applied.length);
  // `applied_at` is the injected clock's instant, not the wall clock. Without the
  // parameter this assertion is unwritable, which is why `migrate` takes one.
  assert.equal(
    db.one<{ applied_at: number }>("select applied_at from migration limit 1").applied_at,
    T0,
  );
  assert.deepEqual(checkIntegrity(db), []);
  db.close();
});

test("every migration file's recorded hash is the hash of the file on disk", () => {
  const h = freshDb();
  for (const file of readMigrations()) {
    const recorded = h.db.one<{ sha256: string; bytes: number }>(
      "select sha256, bytes from migration where id = :id",
      { id: file.id },
    );
    assert.equal(recorded.sha256, sha256(file.sql));
    assert.equal(recorded.bytes, Buffer.byteLength(file.sql, "utf8"));
  }
  h.close();
});

test("editing an applied migration is refused, with both hashes in the message", () => {
  const { dir, drop } = migrationsDir({ "001_a.sql": TABLE_A });
  const db = openDatabase(":memory:");
  migrate(db, dir, manualClock(T0));
  writeFileSync(join(dir, "001_a.sql"), `${TABLE_A}-- a harmless-looking comment\n`, "utf8");
  const problems = planMigrations(db, dir).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /has changed since it was applied/);
  assert.match(problems[0] ?? "", /Add a new migration instead of editing this one/);
  assert.throws(() => migrate(db, dir, manualClock(T0)), (error: unknown) => {
    assert.ok(error instanceof DatabaseError);
    assert.equal(error.code, "migrate.divergent");
    return true;
  });
  assert.equal(migrationStatus(db, dir).current, false);
  db.close();
  drop();
});

test("deleting an applied migration is refused too", () => {
  const { dir, drop } = migrationsDir({ "001_a.sql": TABLE_A, "002_b.sql": TABLE_B });
  const db = openDatabase(":memory:");
  migrate(db, dir, manualClock(T0));
  rmSync(join(dir, "002_b.sql"));
  const problems = planMigrations(db, dir).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /002_b\.sql was applied on .* but is no longer in/);
  assert.match(problems[0] ?? "", /A fresh clone would build a different schema/);
  db.close();
  drop();
});

test("a new migration that sorts before an applied one is refused", () => {
  // Two branches merged. Applying 001 after 002 here would give this database a
  // history no fresh clone can reproduce, and the two orders need not agree.
  const { dir, drop } = migrationsDir({ "002_b.sql": TABLE_B });
  const db = openDatabase(":memory:");
  migrate(db, dir, manualClock(T0));
  writeFileSync(join(dir, "001_a.sql"), TABLE_A, "utf8");
  const problems = planMigrations(db, dir).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /001_a\.sql is new but sorts before 002_b\.sql/);
  assert.match(problems[0] ?? "", /Rename it to sort last/);
  db.close();
  drop();
});

test("a migration that fails halfway leaves nothing behind", () => {
  // SQLite has transactional DDL, so a file is applied whole or not at all. Without
  // that guarantee a failed migration leaves a schema no version number describes,
  // which is the state that takes a human to untangle.
  const { dir, drop } = migrationsDir({
    "001_a.sql": TABLE_A,
    "002_half.sql": `${TABLE_B}insert into b (id) values ('x');\nselect nonexistent_function();\n`,
  });
  const db = openDatabase(":memory:");
  assert.throws(() => migrate(db, dir, manualClock(T0)));
  const tables = db
    .all<{ name: string }>("select name from sqlite_master where type = 'table' order by name")
    .map((row) => row.name);
  assert.ok(tables.includes("a"), "the first file should still be applied");
  assert.ok(!tables.includes("b"), "the failed file left its table behind");
  assert.deepEqual(
    db.all<{ id: string }>("select id from migration order by id").map((row) => row.id),
    ["001_a.sql"],
  );
  // And the runner can be pointed at a fixed version of the same file afterwards.
  writeFileSync(join(dir, "002_half.sql"), TABLE_B, "utf8");
  assert.deepEqual(migrate(db, dir, manualClock(T0)).applied, ["002_half.sql"]);
  db.close();
  drop();
});

test("an empty migrations directory is a mistake, not an empty plan", () => {
  const { dir, drop } = migrationsDir({});
  const db = openDatabase(":memory:");
  assert.throws(() => migrate(db, dir, manualClock(T0)), (error: unknown) => {
    assert.ok(error instanceof DatabaseError);
    assert.equal(error.code, "migrate.empty");
    return true;
  });
  db.close();
  drop();
});

// ---------------------------------------------------------------------------
// The audit gate. This section is the invariant the whole ledger story rests on.
// ---------------------------------------------------------------------------

test("a write outside a recorded scope is refused, and the message quotes the SQL", () => {
  const h = freshDb();
  assert.throws(
    () => h.system.write("insert into account (id, email, display_name, created_at) values ('a','a@x.test','A',1)"),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "ctx.unaudited");
      assert.match(error.message, /refusing an unaudited write/);
      assert.match(error.message, /insert into account/);
      return true;
    },
  );
  assert.equal(ledgerLength(h.db), 0);
  h.close();
});

test("the scope closes again afterwards, even when the body throws", () => {
  const h = freshDb();
  assert.throws(() =>
    h.system.recorded({ action: "account.created", subject: "a" }, () => {
      throw new Error("no");
    }),
  );
  // If `permitted` were left incremented, every later write in the process would be
  // allowed through unaudited -- a failure that gets quieter the longer it lives.
  assert.throws(() => h.system.write("delete from account"), /refusing an unaudited write/);
  h.close();
});

test("a rejected write and its ledger entry are lost together", () => {
  const h = freshDb();
  assert.throws(() =>
    h.system.recorded({ action: "account.created", subject: "a" }, () => {
      h.system.write("insert into account (id, email, display_name, created_at) values ('a','a@x.test','A',1)");
      // A constraint violation on the second write, after the first has landed.
      h.system.write("insert into account (id, email, display_name, created_at) values ('a','b@x.test','B',1)");
    }),
  );
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from account").n, 0);
  assert.equal(ledgerLength(h.db), 0, "an entry survived the transaction that failed");
  h.close();
});

test("the ledger entry is appended after the body, so it never describes work that failed", () => {
  const h = freshDb();
  const event = createEvent(h.system, {
    slug: "gate",
    name: "E",
    submissionsOpenAt: T0,
    submissionsCloseAt: T0 + MS.day,
    judgingOpenAt: T0 + MS.day,
    judgingCloseAt: T0 + 2 * MS.day,
  });
  const entry = readLedger(h.db, { subject: event.id })[0];
  assert.equal(entry?.action, "event.created");
  assert.equal(entry?.event_id, event.id);
  assert.equal(entry?.at, T0);
  assert.deepEqual(JSON.parse(entry?.payload ?? "{}").slug, "gate");
  h.close();
});

test("the escape hatch has three reasons, and every call site that uses one is listed here", () => {
  assert.deepEqual(
    [...UNAUDITED_REASONS],
    ["rate-limit counter", "session liveness", "expiry sweep"],
  );
  // Scanned rather than recited, because the value of the list is that a fourth
  // bypass cannot be introduced quietly. If this assertion fails, the question to
  // ask is whether the new write is really bookkeeping -- and if it is, the answer
  // is to add it here on purpose.
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
  };
  const sites: string[] = [];
  for (const file of walk(src)) {
    const relative = file.slice(src.length).split("\\").join("/");
    for (const m of readFileSync(file, "utf8").matchAll(/\.unaudited\(\s*"([^"]*)"/g)) {
      sites.push(`${relative}: ${m[1]}`);
    }
  }
  assert.deepEqual(sites.sort(), [
    "db/repo/accounts.ts: expiry sweep",
    "db/repo/accounts.ts: session liveness",
    "db/repo/rate.ts: expiry sweep",
    "db/repo/rate.ts: rate-limit counter",
  ]);
});

test("a reason that is not on the list is refused before the body runs", () => {
  const h = freshDb();
  let ran = false;
  assert.throws(
    // Cast because the type already forbids this; the check exists for the call
    // that arrives as a string from somewhere the compiler cannot see.
    () => h.system.unaudited("because I said so" as never, () => (ran = true)),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "ctx.reason");
      return true;
    },
  );
  assert.equal(ran, false);
  h.close();
});

test("an unaudited write lands and leaves the ledger alone", () => {
  const h = world();
  const before = ledgerLength(h.db);
  consume(h.system, "signin", "someone@example.test");
  assert.equal(ledgerLength(h.db), before, "bookkeeping wrote to the audit trail");
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from rate_limit").n, 1);
  h.close();
});

// ---------------------------------------------------------------------------
// The event clock. A deadline is the one number an appeal is about, so every
// boundary here is asserted at the closing millisecond and the one before it.
// ---------------------------------------------------------------------------

test("a window is open up to the millisecond before it closes, and shut on it", () => {
  const h = world();
  const event = h.event;
  const at = (now: number) => gatesFor(event, now);
  assert.equal(at(event.submissions_open_at - 1).submissionsOpen, false);
  assert.equal(at(event.submissions_open_at).submissionsOpen, true, "opening is inclusive");
  assert.equal(at(event.submissions_close_at - 1).submissionsOpen, true);
  assert.equal(at(event.submissions_close_at).submissionsOpen, false, "closing is exclusive");
  assert.equal(at(event.judging_close_at - 1).judgingOpen, true);
  assert.equal(at(event.judging_close_at).judgingOpen, false);
  h.close();
});

test("the phase label summarises the booleans and never contradicts them", () => {
  const h = freshDb();
  // Judging opens before submissions close, which is a real format and the reason
  // `phase` is documented as lossy: for one day both windows are open at once.
  const event = createEvent(h.system, {
    slug: "rolling",
    name: "Rolling",
    submissionsOpenAt: T0,
    submissionsCloseAt: T0 + 3 * MS.day,
    judgingOpenAt: T0 + 2 * MS.day,
    judgingCloseAt: T0 + 5 * MS.day,
  });
  const phaseAt = (now: number) => {
    const gates = gatesFor(event, now);
    if (gates.phase === "overlap") assert.ok(gates.submissionsOpen && gates.judgingOpen);
    if (gates.phase === "submissions") assert.ok(gates.submissionsOpen && !gates.judgingOpen);
    if (gates.phase === "judging") assert.ok(!gates.submissionsOpen && gates.judgingOpen);
    if (gates.phase === "upcoming" || gates.phase === "finished") {
      assert.ok(!gates.submissionsOpen && !gates.judgingOpen);
    }
    return gates.phase;
  };
  assert.equal(phaseAt(T0 - 1), "upcoming");
  assert.equal(phaseAt(T0), "submissions");
  assert.equal(phaseAt(T0 + 2 * MS.day), "overlap");
  assert.equal(phaseAt(T0 + 3 * MS.day), "judging");
  assert.equal(phaseAt(T0 + 5 * MS.day), "finished");
  // The next boundary counts down and then runs out.
  assert.equal(gatesFor(event, T0 - 1).nextBoundaryIn, 1);
  assert.equal(gatesFor(event, T0 + 5 * MS.day).nextBoundaryIn, null);
  h.close();
});

test("a refusal says which side of the window it is on, and by how much", () => {
  const h = world();
  const event = h.event;
  assert.doesNotThrow(() => assertGate(event, event.judging_close_at - 1, "judging"));
  // Too early.
  assert.throws(
    () => assertGate(event, event.judging_open_at - 5000, "judging"),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "judging.notOpen");
      assert.equal(error.detail.opens_at, event.judging_open_at);
      assert.match(error.message, /in 5000 ms/);
      return true;
    },
  );
  // Too late. `late_by_ms` is the number an organizer adjudicates with.
  assert.throws(
    () => assertGate(event, event.submissions_close_at + 4000, "submissions"),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "submissions.closed");
      assert.equal(error.detail.late_by_ms, 4000);
      assert.match(error.message, /closed at 2026-09-25T17:00:00\.000Z, 4000 ms ago/);
      return true;
    },
  );
  h.close();
});

test("archiving an event shuts every window, whatever the clock says", () => {
  const h = world();
  // Archiving has no repository function yet, so the column is set here inside a
  // recorded scope. Going through the gate rather than around it means the fixture
  // is a state the audit trail can explain.
  h.system.recorded({ action: "event.archived", eventId: h.event.id, subject: h.event.id }, () => {
    h.system.write("update event set archived_at = :at where id = :id", {
      at: T0,
      id: h.event.id,
    });
  });
  const archived = findEventBySlug(h.db, h.event.slug);
  assert.ok(archived);
  const gates = gatesFor(archived, T0);
  assert.deepEqual(
    [gates.submissionsOpen, gates.judgingOpen, gates.archived, gates.phase],
    [false, false, true, "finished"],
  );
  // And the refusal names archiving rather than the deadline, which is the honest
  // reason and the one an organizer can act on.
  assert.throws(() => assertGate(archived, T0, "judging"), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "event.archived");
    return true;
  });
  assert.equal(listEvents(h.db).length, 0, "an archived event is hidden by default");
  assert.equal(listEvents(h.db, true).length, 1);
  h.close();
});

test("results are private until published, and publishing is reversible", () => {
  const h = world();
  assert.equal(gatesFor(h.event, T0).resultsPublic, false, "results defaulted to public");
  setResultsPublic(h.asOrganizer, h.event, true);
  const published = findEventBySlug(h.db, h.event.slug);
  assert.ok(published);
  assert.equal(gatesFor(published, T0).resultsPublic, true);
  setResultsPublic(h.asOrganizer, h.event, false);
  assert.deepEqual(
    readLedger(h.db, { subject: h.event.id }).map((e) => e.action),
    ["event.results_withdrawn", "event.results_published", "event.created"],
  );
  h.close();
});

test("tracks are per event, ordered, and a project cannot point at a track that is gone", () => {
  const h = world({ tracks: ["ai", "tools"] });
  assert.deepEqual(
    listTracks(h.db, h.event.id).map((t) => t.key),
    ["ai", "tools"],
  );
  assert.deepEqual(
    listProjects(h.db, h.event.id).map((p) => p.track_key),
    ["ai", "tools", "ai", "tools"],
  );
  // `restrict` on the composite key: deleting a chosen track would silently re-pool
  // every project that chose it, so the delete is refused instead.
  assert.throws(() =>
    h.system.recorded({ action: "track.deleted", eventId: h.event.id, subject: "ai" }, () => {
      h.system.write("delete from track where event_id = :e and key = 'ai'", { e: h.event.id });
    }),
  );
  h.close();
});

// ---------------------------------------------------------------------------
// Identity: accounts, tokens, sessions, links, roles.
// ---------------------------------------------------------------------------

test("one address is one account, whatever case it arrives in", () => {
  const h = freshDb();
  const first = upsertAccount(h.system, "Ada@Example.TEST", "Ada");
  const again = upsertAccount(h.system, "  ada@example.test  ");
  assert.equal(again.id, first.id, "a second spelling made a second account");
  assert.equal(first.email, "ada@example.test");
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from account").n, 1);
  // The display name falls back to the local part rather than being left empty,
  // because the CHECK forbids empty and a blank name on a dashboard is worse.
  assert.equal(upsertAccount(h.system, "bob@example.test").display_name, "bob");
  assert.equal(findAccountByEmail(h.db, "ADA@EXAMPLE.TEST")?.id, first.id);
  for (const bad of ["", "no-at-sign", "two@@at.test", "trailing@dot.", "spaces in@x.test"]) {
    assert.throws(() => normalizeEmail(bad), (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "account.email");
      return true;
    }, `${JSON.stringify(bad)} was accepted as an address`);
  }
  h.close();
});

test("a minted token is nowhere in the database file, not even in the write-ahead log", () => {
  // The strongest form of this check available without a debugger. Reading the column
  // back would only prove the column is a hash; SQLite also writes pages to the WAL,
  // keeps them in the -shm index, and may leave older copies inside the main file's
  // free pages. So every byte of every file the database consists of is searched.
  const h = tempDb();
  const account = upsertAccount(h.system, "ada@example.test", "Ada");
  const session = createSession(h.system, account.id, { userAgent: "curl/8" });
  const link = issueMagicLink(h.system, { email: "ada@example.test" });
  const bytes = () =>
    ["", "-wal", "-shm"]
      .map((suffix) => {
        try {
          return readFileSync(`${h.path}${suffix}`);
        } catch {
          return Buffer.alloc(0);
        }
      })
      .map((buffer) => buffer.toString("latin1"))
      // Escaped rather than the byte itself, because a literal control byte in a
      // source file turns it binary to grep and diff -- and `tests/source.test.ts`
      // catches it, which is how this line came to be written this way. The separator
      // is here so a token cannot appear to be present by spanning two of the files.
      .join("\u0000");
  const searched = bytes();
  assert.ok(searched.length > 4096, "the scan found no database to search");
  // The positive control comes first. Without it a scan that looked in the wrong
  // place would pass this test by finding nothing at all.
  assert.ok(
    searched.includes(hashToken(session.token)),
    "the scan cannot see stored session rows, so finding no plaintext proves nothing",
  );
  assert.ok(searched.includes(hashToken(link.token)));
  assert.ok(!searched.includes(session.token), "the session token is in the database in plaintext");
  assert.ok(!searched.includes(link.token), "the magic-link token is in the database in plaintext");
  // And the ledger carries eight characters of the hash, which is enough to line a
  // session up with its later revocation and useless as a credential.
  const created = readLedger(h.db, { subject: account.id }).find((e) => e.action === "session.created");
  assert.equal(JSON.parse(created?.payload ?? "{}").token_prefix, hashToken(session.token).slice(0, 8));
  assert.equal(hashToken(session.token).length, 64);
  assert.ok(sameToken(hashToken(session.token), hashToken(session.token)));
  assert.equal(sameToken(hashToken(session.token), hashToken(link.token)), false);
  assert.equal(sameToken("short", "longer"), false, "unequal lengths must not throw");
  h.close();
});

test("a session resolves while it is alive and is indistinguishable from nothing after", () => {
  const h = freshDb();
  const account = upsertAccount(h.system, "ada@example.test", "Ada");
  const { token, expiresAt } = createSession(h.system, account.id);
  assert.equal(expiresAt, T0 + SESSION_TTL);
  assert.equal(resolveSession(h.db, token, T0)?.account.id, account.id);
  assert.equal(resolveSession(h.db, token, expiresAt - 1)?.account.id, account.id);
  // Expiry is a deadline like any other: shut on the millisecond it names.
  assert.equal(resolveSession(h.db, token, expiresAt), undefined);
  assert.equal(resolveSession(h.db, "not-a-token", T0), undefined);
  // Disabled accounts resolve to nothing too, through the same return value, so a
  // caller cannot tell "disabled" from "expired" from "never existed".
  h.system.recorded({ action: "account.disabled", subject: account.id }, () => {
    h.system.write("update account set disabled_at = :at where id = :id", {
      at: T0,
      id: account.id,
    });
  });
  assert.equal(resolveSession(h.db, token, T0), undefined);
  h.close();
});

test("using a session updates its liveness without writing to the ledger", () => {
  const h = freshDb();
  const account = upsertAccount(h.system, "ada@example.test", "Ada");
  const { token } = createSession(h.system, account.id);
  const hash = hashToken(token);
  const before = ledgerLength(h.db);
  h.clock.advance(MS.hour);
  touchSession(h.system, hash);
  assert.equal(
    h.db.one<{ last_seen_at: number }>(
      "select last_seen_at from session where token_hash = :h",
      { h: hash },
    ).last_seen_at,
    T0 + MS.hour,
  );
  assert.equal(ledgerLength(h.db), before, "one entry per request would bury the ledger");
  h.close();
});

test("revoking a session ends it, and the revocation is on the record", () => {
  const h = freshDb();
  const account = upsertAccount(h.system, "ada@example.test", "Ada");
  const signedIn = h.system.as(account.id);
  const first = createSession(signedIn, account.id, { userAgent: "one" });
  const second = createSession(signedIn, account.id, { userAgent: "two" });
  assert.equal(sessionsOf(h.db, account.id, T0).length, 2);
  revokeSession(signedIn, hashToken(first.token));
  assert.equal(resolveSession(h.db, first.token, T0), undefined);
  assert.equal(resolveSession(h.db, second.token, T0)?.account.id, account.id);
  assert.deepEqual(
    sessionsOf(h.db, account.id, T0).map((s) => s.user_agent),
    ["two"],
  );
  const entry = readLedger(h.db, { subject: account.id }).find((e) => e.action === "session.revoked");
  assert.equal(entry?.actor_id, account.id);
  assert.equal(JSON.parse(entry?.payload ?? "{}").token_prefix, hashToken(first.token).slice(0, 8));
  h.close();
});

test("a magic link works once, and the second attempt cannot tell why it failed", () => {
  const h = freshDb();
  const event = createEvent(h.system, {
    slug: "invited",
    name: "Invited",
    submissionsOpenAt: T0,
    submissionsCloseAt: T0 + MS.day,
    judgingOpenAt: T0,
    judgingCloseAt: T0 + MS.day,
  });
  const invite = issueMagicLink(h.system, {
    email: "Judge@Example.test",
    eventId: event.id,
    role: "judge",
  });
  assert.equal(invite.expiresAt, T0 + MAGIC_LINK_TTL);
  // Issuing does not create the account: a mistyped address leaves nothing behind.
  assert.equal(findAccountByEmail(h.db, "judge@example.test"), undefined);
  const redeemed = consumeMagicLink(h.system, invite.token, { displayName: "Judy" });
  assert.equal(redeemed.account.email, "judge@example.test");
  assert.equal(redeemed.role, "judge");
  assert.deepEqual(rolesIn(h.db, event.id, redeemed.account.id), ["judge"]);
  assert.equal(resolveSession(h.db, redeemed.session.token, T0)?.account.id, redeemed.account.id);
  const invalid = (attempt: () => unknown, why: string) =>
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof RuleError, why);
      assert.equal(error.code, "link.invalid");
      assert.match(error.message, /single-use/);
      return true;
    }, why);
  invalid(() => consumeMagicLink(h.system, invite.token), "a spent link was accepted again");
  invalid(() => consumeMagicLink(h.system, mintToken()), "an unknown token was accepted");
  const stale = issueMagicLink(h.system, { email: "late@example.test" });
  h.clock.advance(MAGIC_LINK_TTL);
  invalid(() => consumeMagicLink(h.system, stale.token), "an expired link was accepted");
  h.close();
});

test("the sweep removes what can no longer be used and leaves the rest", () => {
  const h = freshDb();
  const account = upsertAccount(h.system, "ada@example.test", "Ada");
  const short = createSession(h.system, account.id, { ttl: MS.hour });
  const long = createSession(h.system, account.id, { ttl: 30 * MS.day });
  issueMagicLink(h.system, { email: "ada@example.test", ttl: 2 * MS.hour });
  const spent = issueMagicLink(h.system, { email: "ada@example.test" });
  consumeMagicLink(h.system, spent.token);
  const before = ledgerLength(h.db);
  h.clock.advance(MS.hour);
  // At this instant the first link has an hour left and the consumed one has none
  // regardless of the clock, which is why the sweep takes it on the other half of
  // its predicate. The short session has just expired; the long one has not.
  assert.deepEqual(sweepExpired(h.system), { sessions: 1, links: 1 });
  assert.equal(resolveSession(h.db, short.token, h.clock.now()), undefined);
  assert.ok(resolveSession(h.db, long.token, h.clock.now()));
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from magic_link").n, 1);
  assert.equal(ledgerLength(h.db), before, "the sweep wrote to the audit trail");
  h.close();
});

test("roles are additive, per event, and granting twice is not two rows", () => {
  const h = world();
  const other = createEvent(h.system, {
    slug: "elsewhere",
    name: "Elsewhere",
    submissionsOpenAt: T0,
    submissionsCloseAt: T0 + MS.day,
    judgingOpenAt: T0,
    judgingCloseAt: T0 + MS.day,
  });
  const judge = h.judges[0] as { id: string };
  grantRole(h.system, h.event.id, judge.id, "organizer");
  assert.deepEqual(rolesIn(h.db, h.event.id, judge.id), ["judge", "organizer"]);
  const before = ledgerLength(h.db);
  grantRole(h.system, h.event.id, judge.id, "judge");
  assert.equal(ledgerLength(h.db), before, "a redundant grant wrote an entry");
  // The isolation property, at the storage layer: standing in one event is not
  // standing in another. `prove:isolation` will demonstrate the same thing over HTTP.
  assert.deepEqual(rolesIn(h.db, other.id, judge.id), []);
  assert.equal(hasRole(h.db, other.id, judge.id, "judge"), false);
  assert.deepEqual(
    membersOf(h.db, h.event.id, "judge").map((a) => a.display_name),
    ["Judge 0", "Judge 1", "Judge 2"],
  );
  assert.deepEqual(membersOf(h.db, other.id, "judge"), []);
  h.close();
});

// ---------------------------------------------------------------------------
// Rate limits. Fixed windows, chosen because an operator can explain them.
// ---------------------------------------------------------------------------

test("a refused attempt still counts, so hammering the boundary does not reopen it", () => {
  const h = freshDb();
  const max = LIMITS.signin.max;
  for (let i = 1; i <= max; i += 1) {
    const verdict = consume(h.system, "signin", "ada@example.test");
    assert.deepEqual([verdict.allowed, verdict.used], [true, i]);
  }
  const refused = consume(h.system, "signin", "ada@example.test");
  assert.deepEqual([refused.allowed, refused.used], [false, max + 1]);
  // The counter kept going. A limiter that stopped counting once it started
  // refusing would let a caller sit on the boundary and get a full quota the
  // instant the window turned over.
  assert.equal(consume(h.system, "signin", "ada@example.test").used, max + 2);
  assert.equal(peek(h.db, "signin", "ada@example.test", T0).used, max + 2);
  // A different key is a different bucket; so is a different limit.
  assert.equal(consume(h.system, "signin", "bob@example.test").allowed, true);
  assert.equal(consume(h.system, "read", "ada@example.test").allowed, true);
  h.close();
});

test("peek says what the next attempt will get, without spending anything", () => {
  // The two functions compute `allowed` differently -- `used < max` before the
  // increment, `used <= max` after it -- and that is exactly what makes them agree.
  // Written as a loop across the boundary because an off-by-one here shows up as a
  // limit that is one too strict or one too loose, and neither is visible by reading.
  const h = freshDb();
  for (let i = 0; i <= LIMITS.signin.max + 1; i += 1) {
    const predicted = peek(h.db, "signin", "ada@example.test", T0);
    const actual = consume(h.system, "signin", "ada@example.test");
    assert.equal(
      predicted.allowed,
      actual.allowed,
      `peek and consume disagreed on attempt ${i + 1}`,
    );
    assert.equal(predicted.used, i, "peek spent something");
    assert.equal(predicted.resetAt, actual.resetAt);
  }
  h.close();
});

test("the window turns over on its own boundary and the quota comes back whole", () => {
  const h = freshDb();
  const window = LIMITS.signin.window;
  const start = Math.floor(T0 / window) * window;
  for (let i = 0; i < LIMITS.signin.max; i += 1) consume(h.system, "signin", "ada@example.test");
  const spent = consume(h.system, "signin", "ada@example.test");
  assert.equal(spent.allowed, false);
  assert.equal(spent.resetAt, start + window);
  // One millisecond short of the reset: still refused.
  h.clock.set(spent.resetAt - 1);
  assert.equal(consume(h.system, "signin", "ada@example.test").allowed, false);
  h.clock.set(spent.resetAt);
  const fresh = consume(h.system, "signin", "ada@example.test");
  assert.deepEqual([fresh.allowed, fresh.used], [true, 1]);
  // The old row is still there -- expiry is the sweep's job, not the counter's.
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from rate_limit").n, 2);
  h.close();
});

test("enforce turns the verdict into a refusal a person can act on", () => {
  const h = freshDb();
  for (let i = 0; i < LIMITS.signin.max; i += 1) enforce(h.system, "signin", "ada@example.test");
  assert.throws(
    () => enforce(h.system, "signin", "ada@example.test"),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "rate.signin");
      assert.equal(error.detail.max, LIMITS.signin.max);
      assert.equal(error.detail.used, LIMITS.signin.max + 1);
      // The message names the limit in the terms it was set in, and says when the
      // window ends -- the two things a support reply needs.
      assert.match(error.message, /sign-in links for one address/);
      assert.match(error.message, /the limit is 10 per 60 minutes/);
      assert.match(error.message, /Try again after 2026-09-25T19:00:00\.000Z/);
      return true;
    },
  );
  h.close();
});

test("the sweep only drops windows no limit could still be counting against", () => {
  const h = freshDb();
  consume(h.system, "ballot", "judge-0");
  consume(h.system, "signin", "ada@example.test");
  const rows = () => h.db.one<{ n: number }>("select count(*) as n from rate_limit").n;
  assert.equal(rows(), 2);
  // The cutoff is one full width of the widest window back, so a minute-wide bucket
  // is kept far longer than it needs to be. That is the intended direction to be
  // wrong in: sweeping a live counter would hand out a second quota.
  h.clock.advance(MS.hour);
  assert.equal(sweepRateLimits(h.system), 0, "a bucket inside the retained window was swept");
  h.clock.advance(2 * MS.hour);
  assert.equal(sweepRateLimits(h.system), 2);
  assert.equal(rows(), 0);
  h.close();
});

// ---------------------------------------------------------------------------
// Teams, projects, and the deadline they are measured against.
// ---------------------------------------------------------------------------

/**
 * A team created as of a given instant, without disturbing the caller's clock.
 *
 * The fixture's event has already closed submissions, so tests that need a new draft
 * have to move back inside the window; doing it through a helper keeps the clock
 * arithmetic out of the assertions.
 */
function createTeamAt(h: { clock: { now: () => number; set: (at: number) => void }; system: Ctx; event: { id: string } }, at: number, name: string): TeamRow {
  const was = h.clock.now();
  h.clock.set(at);
  try {
    return createTeam(h.system, h.event.id, name);
  } finally {
    h.clock.set(was);
  }
}

test("a person is on one team per event, and the refusal names the team they are on", () => {
  const h = world();
  const builder = upsertAccount(h.system, "builder0@example.test");
  const first = h.teams[0] as TeamRow;
  const second = h.teams[1] as TeamRow;
  assert.equal(teamOf(h.db, h.event.id, builder.id)?.id, first.id);
  const before = ledgerLength(h.db);
  addTeamMember(h.system, first, builder.id);
  assert.equal(ledgerLength(h.db), before, "re-adding somebody to their own team wrote an entry");
  assert.throws(
    () => addTeamMember(h.system, second, builder.id),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "team.alreadyJoined");
      assert.match(error.message, new RegExp(first.name));
      assert.equal(error.detail.team, first.id);
      return true;
    },
  );
  assert.equal(teamOf(h.db, h.event.id, builder.id)?.id, first.id, "the second attempt moved them");
  assert.notEqual(first.id, second.id);
  // Two teams cannot share a name inside one event, and the same name in another
  // event is fine -- which is the composite key doing its job.
  assert.throws(() => createTeam(h.system, h.event.id, "Team 0"));
  h.close();
});

test("a submission on the closing millisecond is late, and the margin is on the record", () => {
  const h = world();
  const close = h.event.submissions_close_at;
  const team = createTeamAt(h, close - MS.hour, "Late Team");
  h.clock.set(close - 1);
  const draft = createProject(h.system, h.event, team, {
    title: "Just In Time",
    summary: "Submitted with a millisecond to spare.",
  });
  const submitted = submitProject(h.system, h.event, draft);
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.submitted_at, close - 1);
  assert.equal(
    JSON.parse(
      readLedger(h.db, { subject: draft.id }).find((e) => e.action === "project.submitted")?.payload ??
        "{}",
    ).with_ms_to_spare,
    1,
  );
  // And one millisecond later the same call is refused.
  const late = createTeamAt(h, close - MS.hour, "Later Team");
  const lateDraft = createProject(h.system.as(null), h.event, late, {
    title: "Not In Time",
    summary: "Submitted a millisecond too late.",
  });
  h.clock.set(close);
  assert.throws(() => submitProject(h.system, h.event, lateDraft), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "submissions.closed");
    assert.equal(error.detail.late_by_ms, 0);
    return true;
  });
  assert.equal(findProject(h.db, lateDraft.id)?.status, "draft");
  h.close();
});

test("submitting twice is the same submission, and an empty one is refused", () => {
  const h = world();
  const team = createTeamAt(h, h.event.submissions_close_at - MS.hour, "Twice");
  h.clock.set(h.event.submissions_close_at - MS.hour);
  const draft = createProject(h.system, h.event, team, { title: "Titled" });
  assert.throws(() => submitProject(h.system, h.event, draft), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "project.incomplete");
    return true;
  });
  const ready = updateProject(h.system, h.event, draft, { summary: "Now it says what it is." });
  const first = submitProject(h.system, h.event, ready);
  const before = ledgerLength(h.db);
  const again = submitProject(h.system, h.event, first);
  assert.equal(again.submitted_at, first.submitted_at);
  assert.equal(ledgerLength(h.db), before, "a repeated submission wrote a second entry");
  // Editing after the deadline is refused whatever the status.
  h.clock.set(T0);
  assert.throws(() => updateProject(h.system, h.event, first, { title: "Renamed" }), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "submissions.closed");
    return true;
  });
  h.close();
});

test("withdrawing after the deadline takes an organizer, and the entry says so", () => {
  const h = world();
  const project = h.projects[0] as { id: string };
  const row = findProject(h.db, project.id);
  assert.ok(row);
  // A team cannot quietly pull a submission out of judging once the window has shut.
  assert.throws(() => withdrawProject(h.system, h.event, row), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "submissions.closed");
    return true;
  });
  const withdrawn = withdrawProject(h.asOrganizer, h.event, row, {
    byOrganizer: true,
    reason: "Withdrawn at the team's request.",
  });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.withdrawn_at, T0);
  // `submitted_at` survives: that the work arrived on time stays true.
  assert.equal(withdrawn.submitted_at, row.submitted_at);
  const payload = JSON.parse(
    readLedger(h.db, { subject: row.id }).find((e) => e.action === "project.withdrawn")?.payload ?? "{}",
  );
  assert.deepEqual([payload.by_organizer, payload.after_close], [true, true]);
  assert.deepEqual(
    judgeablePool(h.db, h.event.id).map((p) => p.id),
    h.projects.slice(1).map((p) => p.id),
    "a withdrawn project is still in the judging pool",
  );
  // A draft was never in, so there is nothing to withdraw.
  const team = createTeamAt(h, h.event.submissions_close_at - MS.hour, "Draftee");
  h.clock.set(h.event.submissions_close_at - MS.hour);
  const draft = createProject(h.system, h.event, team, { title: "D", summary: "S" });
  assert.throws(() => withdrawProject(h.system, h.event, draft), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "project.notSubmitted");
    return true;
  });
  h.close();
});

test("disqualification needs a stated reason and no deadline applies to it", () => {
  const h = world();
  const row = findProject(h.db, (h.projects[0] as { id: string }).id);
  assert.ok(row);
  for (const reason of ["", "  ", "no"]) {
    assert.throws(() => disqualifyProject(h.asOrganizer, h.event, row, reason), (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "project.reasonRequired");
      return true;
    }, `${JSON.stringify(reason)} was accepted as a reason`);
  }
  const out = disqualifyProject(h.asOrganizer, h.event, row, "  Submitted work that predates the event.  ");
  assert.equal(out.status, "disqualified");
  assert.equal(out.submitted_at, row.submitted_at, "the arrival time was rewritten");
  assert.equal(out.withdrawn_at, null);
  assert.equal(
    JSON.parse(
      readLedger(h.db, { subject: row.id }).find((e) => e.action === "project.disqualified")?.payload ??
        "{}",
    ).reason,
    "Submitted work that predates the event.",
  );
  assert.ok(!judgeablePool(h.db, h.event.id).some((p) => p.id === row.id));
  // Disqualification is terminal for editing and for resubmission.
  h.clock.set(h.event.submissions_close_at - MS.hour);
  for (const [code, attempt] of [
    ["project.disqualified", () => updateProject(h.system, h.event, out, { title: "x" })],
    ["project.disqualified", () => submitProject(h.system, h.event, out)],
  ] as [string, () => unknown][]) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, code);
      return true;
    });
  }
  h.close();
});

test("the status column and its two timestamps cannot disagree", () => {
  // The CHECKs are `(submitted_at is null) = (status = 'draft')` and
  // `(withdrawn_at is not null) = (status = 'withdrawn')`. Between them, no row can
  // claim to be a draft that was submitted, or withdrawn without a moment of
  // withdrawal. Asserted by trying to write each contradiction directly, because
  // every repository function goes through them and none of them can produce one.
  const h = world();
  const row = findProject(h.db, (h.projects[0] as { id: string }).id);
  assert.ok(row);
  const force = (sql: string) =>
    h.system.recorded({ action: "project.updated", eventId: h.event.id, subject: row.id }, () => {
      h.system.write(`update project set ${sql} where id = :id`, { id: row.id });
    });
  for (const contradiction of [
    "status = 'draft'",
    "submitted_at = null",
    "status = 'withdrawn'",
    "withdrawn_at = 1",
  ]) {
    assert.throws(() => force(contradiction), `${contradiction} was accepted`);
  }
  // And the pair moved together is fine.
  assert.doesNotThrow(() => force("status = 'withdrawn', withdrawn_at = 1"));
  h.close();
});

test("duplicate titles are reported rather than refused", () => {
  // The schema deliberately has no unique on (event_id, title): a submission bounced
  // at the deadline over a title collision is a worse outcome than two projects
  // called "Untitled". The organizer dashboard reads this instead.
  const h = world();
  h.clock.set(h.event.submissions_close_at - MS.hour);
  const ids: string[] = [];
  for (const name of ["Copycat A", "Copycat B"]) {
    const team = createTeamAt(h, h.clock.now(), name);
    const draft = createProject(h.system, h.event, team, {
      title: "Project 0",
      summary: "The same title as somebody else.",
    });
    ids.push(submitProject(h.system, h.event, draft).id);
  }
  const duplicates = duplicateTitles(h.db, h.event.id);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.title, "Project 0");
  assert.equal(duplicates[0]?.ids.length, 3);
  for (const id of ids) assert.ok(duplicates[0]?.ids.includes(id));
  h.close();
});

test("duplicate title query folds case and whitespace but respects punctuation, status and event", () => {
  const h = world();
  try {
    h.clock.set(h.event.submissions_close_at - MS.hour);
    const make = (name: string, title: string, submit = true) => {
      const team = createTeamAt(h, h.clock.now(), name);
      const draft = createProject(h.system, h.event, team, { title, summary: "A project." });
      return submit ? submitProject(h.system, h.event, draft) : draft;
    };
    const draft = make("Whitespace", "project\t 0", false);
    const upper = make("Case", "PROJECT 0");
    const punctuated = make("Punctuation", "Project 0!");
    const composed = make("Accented", "Café");
    const decomposed = make("Decomposed", "Cafe\u0301", false);
    const withdrawn = make("Withdrawn", "project 0");
    withdrawProject(h.system, h.event, withdrawn);
    const disqualified = make("Disqualified", "PROJECT 0");
    disqualifyProject(h.asOrganizer, h.event, disqualified, "Duplicate entry");

    // Normal project writes trim the outside; preserve a legacy/imported title to
    // exercise the query's outer-whitespace comparison as well.
    h.system.recorded({ action: "project.updated", eventId: h.event.id, subject: upper.id }, () =>
      h.system.write("update project set title = :title where id = :id", { title: "  PROJECT 0  ", id: upper.id }));
    const other = createEvent(h.system, {
      slug: "another-event", name: "Another event",
      submissionsOpenAt: h.event.submissions_open_at,
      submissionsCloseAt: h.event.submissions_close_at,
      judgingOpenAt: h.event.judging_open_at,
      judgingCloseAt: h.event.judging_close_at,
      reviewsPerProject: 2, pairwiseEnabled: false,
    });
    const otherTeam = createTeam(h.system, other.id, "Other team");
    submitProject(h.system, other, createProject(h.system, other, otherTeam,
      { title: "project 0", summary: "Other event." }));

    const groups = duplicateTitles(h.db, h.event.id);
    assert.equal(groups.length, 2);
    const projectZero = groups.find((group) => group.ids.includes(h.projects[0]!.id));
    assert.equal(projectZero?.title, "  PROJECT 0  ");
    assert.deepEqual(new Set(projectZero?.ids), new Set([h.projects[0]!.id, draft.id, upper.id]));
    assert.deepEqual(projectZero?.projects.map((p) => [p.id, p.title, p.status]), [
      [upper.id, "  PROJECT 0  ", "submitted"],
      [h.projects[0]!.id, "Project 0", "submitted"],
      [draft.id, "project\t 0", "draft"],
    ]);
    assert.deepEqual(new Set(groups.find((group) => group.ids.includes(composed.id))?.ids),
      new Set([composed.id, decomposed.id]));
    assert.ok(groups.every((group) => !group.ids.includes(punctuated.id)));
    assert.ok(groups.every((group) => !group.ids.includes(withdrawn.id)));
    assert.ok(groups.every((group) => !group.ids.includes(disqualified.id)));
    assert.deepEqual(duplicateTitles(h.db, other.id), []);
  } finally { h.close(); }
});

// ---------------------------------------------------------------------------
// Rubrics, which are versioned rather than edited.
// ---------------------------------------------------------------------------

test("a rubric change is a new version, and the ballots on the old one keep their scale", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const project = (h.projects[0] as { id: string }).id;
  const event = h.event;
  saveBallot(h.asJudge(0), event, { judgeId: judge, projectId: project, scores: FULL_SCORES });
  assert.equal(publishedVersion(h.db, event.id), 1);
  // Version two narrows novelty from 0..10 to 1..5. If this were an edit rather than
  // a version, the ballot above would silently claim a 10 on a five-point scale.
  const next = createRubricVersion(h.asOrganizer, event.id, [
    { key: "impact", label: "Impact", weight: 2, min: 1, max: 5 },
    { key: "craft", label: "Craft", weight: 1, min: 1, max: 5 },
    { key: "novelty", label: "Novelty", weight: 1, min: 1, max: 5 },
  ]);
  assert.equal(next.version, 2);
  assert.equal(publishedVersion(h.db, event.id), 1, "creating a version published it");
  assert.equal(loadRubric(h.db, event.id, 1).criteria.find((c) => c.key === "novelty")?.max, 10);
  assert.equal(loadRubric(h.db, event.id, 2).criteria.find((c) => c.key === "novelty")?.max, 5);
  publishRubric(h.asOrganizer, event.id, 2);
  assert.equal(publishedVersion(h.db, event.id), 2);
  // The old ballot still says 10, and still means 10 out of 10.
  const ballot = findBallot(h.db, event.id, judge, project);
  assert.equal(ballot?.rubric_version, 1);
  assert.equal(scoresOf(h.db, ballot?.id ?? "").novelty, 10);
  assert.deepEqual(verifyScoreRanges(h.db), [], "a score fell outside its own criterion");
  // And revising it now is refused rather than mixing two scales in one row.
  assert.throws(
    () => saveBallot(h.asJudge(0), event, { judgeId: judge, projectId: project, scores: { impact: 5, craft: 5, novelty: 5 } }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "ballot.staleRubric");
      assert.deepEqual([error.detail.was, error.detail.now], [1, 2]);
      return true;
    },
  );
  h.close();
});

test("publishing is one-way, and a rubric version with ballots against it cannot be deleted", () => {
  const h = world();
  const event = h.event;
  saveBallot(h.asJudge(0), event, {
    judgeId: (h.judges[0] as { id: string }).id,
    projectId: (h.projects[0] as { id: string }).id,
    scores: FULL_SCORES,
  });
  const before = ledgerLength(h.db);
  assert.equal(publishRubric(h.asOrganizer, event.id, 1).version, 1);
  assert.equal(ledgerLength(h.db), before, "re-publishing wrote a second entry");
  assert.throws(() => publishRubric(h.asOrganizer, event.id, 9), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "rubric.missing");
    return true;
  });
  // `restrict` on the ballot's foreign key: the version a ballot was scored against
  // is evidence, so deleting it is refused rather than cascading the ballots away.
  assert.throws(() =>
    h.system.recorded({ action: "rubric.deleted", eventId: event.id, subject: "v1" }, () => {
      h.system.write("delete from rubric where event_id = :e and version = 1", { e: event.id });
    }),
  );
  h.close();
});

test("a rubric that cannot be scored against is refused at creation", () => {
  const h = world({ publishRubric: false });
  const event = h.event;
  const attempts: [string, () => unknown][] = [
    ["rubric.empty", () => createRubricVersion(h.asOrganizer, event.id, [])],
    [
      "rubric.duplicateKey",
      () =>
        createRubricVersion(h.asOrganizer, event.id, [
          { key: "craft", label: "Craft" },
          { key: "craft", label: "Craft again" },
        ]),
    ],
    [
      "rubric.weight",
      () => createRubricVersion(h.asOrganizer, event.id, [{ key: "craft", label: "Craft", weight: 0 }]),
    ],
    [
      "rubric.range",
      () =>
        createRubricVersion(h.asOrganizer, event.id, [
          { key: "craft", label: "Craft", min: 3, max: 3 },
        ]),
    ],
  ];
  for (const [code, attempt] of attempts) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof RuleError, code);
      assert.equal(error.code, code);
      return true;
    }, `${code} was accepted`);
  }
  // A weight of zero is refused rather than accepted, because a criterion that counts
  // for nothing is a criterion judges spend time on for no effect.
  assert.match(
    (() => {
      try {
        createRubricVersion(h.asOrganizer, event.id, [{ key: "craft", label: "Craft", weight: 0 }]);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    /should be removed, not weighted zero/,
  );
  // None of the refusals left a version behind.
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from rubric").n, 1);
  h.close();
});

test("a ballot cannot be saved against an unpublished rubric", () => {
  const h = world({ publishRubric: false });
  assert.equal(publishedVersion(h.db, h.event.id), undefined);
  assert.throws(
    () =>
      saveBallot(h.asJudge(0), h.event, {
        judgeId: (h.judges[0] as { id: string }).id,
        projectId: (h.projects[0] as { id: string }).id,
        scores: FULL_SCORES,
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "rubric.unpublished");
      return true;
    },
  );
  assert.throws(() => loadJudgingInput(h.db, h.event.id), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "rubric.unpublished");
    return true;
  });
  h.close();
});

test("the range check the schema cannot make is made on the way in", () => {
  // SQLite forbids a subquery in a CHECK, so `score.value` cannot be constrained to
  // its own criterion's bounds by the schema. That makes `assertScoreInRange` the
  // only thing standing between a typo and a ranking computed from a 50.
  const h = world();
  const criteria = criteriaOf(h.db, h.event.id, 1);
  const novelty = criteria.find((c) => c.key === "novelty");
  assert.ok(novelty);
  assert.deepEqual([novelty.min_score, novelty.max_score], [0, 10]);
  for (const value of [-1, 11, 2.5, Number.NaN]) {
    assert.throws(() => assertScoreInRange(novelty, value), (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "score.range");
      assert.equal(error.detail.value, value);
      return true;
    }, `${value} was accepted as a score`);
  }
  assert.doesNotThrow(() => assertScoreInRange(novelty, 0));
  assert.doesNotThrow(() => assertScoreInRange(novelty, 10));
  // The same refusal through the repository, and an unknown criterion as well.
  const input = { judgeId: (h.judges[0] as { id: string }).id, projectId: (h.projects[0] as { id: string }).id };
  for (const [code, scores] of [
    ["score.range", { impact: 5, craft: 5, novelty: 11 }],
    ["score.unknownCriterion", { impact: 5, craft: 5, novelty: 5, vibes: 3 }],
    ["ballot.incomplete", { impact: 5, craft: 5 }],
  ] as [string, Record<string, number>][]) {
    assert.throws(() => saveBallot(h.asJudge(0), h.event, { ...input, scores }), (error: unknown) => {
      assert.ok(error instanceof RuleError, code);
      assert.equal(error.code, code);
      return true;
    }, `${code} was accepted`);
  }
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from ballot").n, 0);
  // And the sweep that reports what got in another way finds nothing.
  assert.deepEqual(verifyScoreRanges(h.db), []);
  h.close();
});

// ---------------------------------------------------------------------------
// Ballots, comparisons, and the one function the engine is handed.
// ---------------------------------------------------------------------------

test("saving twice edits one ballot, and the scores are replaced rather than merged", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const project = (h.projects[0] as { id: string }).id;
  const first = saveBallot(h.asJudge(0), h.event, {
    judgeId: judge,
    projectId: project,
    scores: { impact: 4, craft: 3, novelty: 7 },
    comment: "Solid.",
  });
  h.clock.set(T0 + MS.minute);
  const second = saveBallot(h.asJudge(0), h.event, {
    judgeId: judge,
    projectId: project,
    scores: { impact: 5, craft: 3, novelty: 7 },
  });
  assert.equal(second.id, first.id, "a second save made a second ballot");
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from ballot").n, 1);
  // Three score rows, not six: the old ones are deleted before the new ones land, so a
  // criterion dropped from the submission is dropped from the ballot.
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from score").n, 3);
  assert.deepEqual(scoresOf(h.db, second.id), { craft: 3, impact: 5, novelty: 7 });
  assert.equal(second.comment, "Solid.", "an omitted comment erased the old one");
  assert.equal(second.submitted_at, T0 + MS.minute);
  // The ledger says revised, not submitted, and both entries carry the scores as they
  // stood — which is the only record of the 4 that became a 5.
  const entries = readLedger(h.db, { subject: first.id }).reverse();
  assert.deepEqual(entries.map((e) => e.action), ["ballot.submitted", "ballot.revised"]);
  assert.deepEqual(
    entries.map((e) => JSON.parse(e.payload).scores.impact),
    [4, 5],
  );
  h.close();
});

test("an unassigned judge scoring a project in the pool gets the assignment, marked manual", () => {
  const h = world();
  const judge = (h.judges[1] as { id: string }).id;
  const project = (h.projects[2] as { id: string }).id;
  assert.deepEqual(assignmentsOf(h.db, h.event.id, judge), []);
  saveBallot(h.asJudge(1), h.event, { judgeId: judge, projectId: project, scores: FULL_SCORES });
  const assignments = assignmentsOf(h.db, h.event.id, judge);
  assert.deepEqual(assignments.map((a) => [a.project_id, a.reason]), [[project, "manual"]]);
  // Assigning again is a no-op rather than a duplicate row or a second ledger entry.
  const before = ledgerLength(h.db);
  assignProject(h.asOrganizer, h.event.id, judge, project, "schedule");
  assert.equal(ledgerLength(h.db), before);
  assert.equal(assignmentsOf(h.db, h.event.id, judge).length, 1);
  assert.equal(assignmentsOf(h.db, h.event.id, judge)[0]?.reason, "manual", "the reason was rewritten");
  unassignProject(h.asOrganizer, h.event.id, judge, project);
  assert.deepEqual(assignmentsOf(h.db, h.event.id, judge), []);
  // Unassigning does not take the ballot: the review happened, and deleting the
  // evidence because the schedule changed would be the wrong kind of tidy.
  assert.ok(findBallot(h.db, h.event.id, judge, project));
  h.close();
});

test("a draft may be incomplete, and the engine never sees it", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const project = (h.projects[0] as { id: string }).id;
  const draft = saveBallot(h.asJudge(0), h.event, {
    judgeId: judge,
    projectId: project,
    scores: { impact: 4 },
    submit: false,
  });
  assert.equal(draft.submitted_at, null);
  assert.deepEqual(scoresOf(h.db, draft.id), { impact: 4 });
  assert.equal(JSON.parse(readLedger(h.db, { subject: draft.id })[0]?.payload ?? "{}").draft, true);
  assert.deepEqual(loadJudgingInput(h.db, h.event.id).ballots, [], "a draft reached the engine");
  // A draft counts as work in progress on the dashboard and as nothing at all in the
  // coverage arithmetic, which is the pessimistic reading on purpose.
  const progress = judgeProgress(h.db, h.event.id).find((p) => p.judgeId === judge);
  assert.deepEqual([progress?.drafts, progress?.submitted], [1, 0]);
  const coverage = projectCoverage(h.db, h.event).find((c) => c.projectId === project);
  assert.deepEqual([coverage?.drafts, coverage?.submitted, coverage?.short], [1, 0, 3]);
  // Submitting the same ballot needs every criterion, and then it is one ballot.
  assert.throws(
    () => saveBallot(h.asJudge(0), h.event, { judgeId: judge, projectId: project, scores: { impact: 4 } }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "ballot.incomplete");
      assert.deepEqual(error.detail.missing, ["craft", "novelty"]);
      return true;
    },
  );
  const submitted = saveBallot(h.asJudge(0), h.event, {
    judgeId: judge,
    projectId: project,
    scores: FULL_SCORES,
  });
  assert.equal(submitted.id, draft.id);
  assert.equal(loadJudgingInput(h.db, h.event.id).ballots.length, 1);
  h.close();
});

test("an organizer entering a judge's ballot is recorded, not refused", () => {
  // A paper ballot read out at a table is a real workflow. Refusing it makes the
  // organizer sign in as the judge, which is worse: the ledger would then say the
  // judge typed it.
  const h = world();
  const judge = (h.judges[2] as { id: string }).id;
  const project = (h.projects[1] as { id: string }).id;
  const ballot = saveBallot(h.asOrganizer, h.event, {
    judgeId: judge,
    projectId: project,
    scores: FULL_SCORES,
  });
  assert.equal(ballot.judge_id, judge, "the ballot was attributed to the organizer");
  const onBehalf = readLedger(h.db, { eventId: h.event.id }).find(
    (e) => e.action === "ballot.entered_on_behalf",
  );
  assert.ok(onBehalf, "nothing in the ledger says who typed it");
  assert.equal(onBehalf.actor_id, h.organizer.id);
  assert.equal(JSON.parse(onBehalf.payload).judge, judge);
  assert.equal(onBehalf.subject, project);
  // A judge entering their own ballot adds no such entry.
  const before = ledgerLength(h.db);
  saveBallot(h.asJudge(0), h.event, {
    judgeId: (h.judges[0] as { id: string }).id,
    projectId: project,
    scores: FULL_SCORES,
  });
  assert.equal(
    readLedger(h.db, { eventId: h.event.id }).filter((e) => e.action === "ballot.entered_on_behalf")
      .length,
    1,
  );
  assert.ok(ledgerLength(h.db) > before);
  h.close();
});

test("only a submitted project can be scored, and only while judging is open", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const withdrawn = h.projects[3] as ProjectRow;
  withdrawProject(h.asOrganizer, h.event, withdrawn, { byOrganizer: true, reason: "team asked" });
  for (const [projectId, code] of [
    [withdrawn.id, "project.notJudgeable"],
    ["01JQZZZZZZZZZZZZZZZZZZZZZZ", "project.missing"],
  ] as [string, string][]) {
    assert.throws(
      () => saveBallot(h.asJudge(0), h.event, { judgeId: judge, projectId, scores: FULL_SCORES }),
      (error: unknown) => {
        assert.ok(error instanceof RuleError, code);
        assert.equal(error.code, code);
        return true;
      },
      `${code} was accepted`,
    );
  }
  // The gate is checked before anything else, so a closed window refuses even a
  // perfectly valid ballot — and says how late it is.
  h.clock.set(h.event.judging_close_at);
  assert.throws(
    () =>
      saveBallot(h.asJudge(0), h.event, {
        judgeId: judge,
        projectId: (h.projects[0] as ProjectRow).id,
        scores: FULL_SCORES,
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "judging.closed");
      assert.equal(error.detail.late_by_ms, 0);
      return true;
    },
  );
  h.close();
});

test("deleting a ballot puts the scores it removed into the ledger", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const project = (h.projects[0] as { id: string }).id;
  const ballot = saveBallot(h.asJudge(0), h.event, {
    judgeId: judge,
    projectId: project,
    scores: { impact: 2, craft: 4, novelty: 9 },
  });
  deleteBallot(h.asOrganizer, h.event, ballot);
  assert.equal(findBallot(h.db, h.event.id, judge, project), undefined);
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from score").n, 0, "scores outlived the ballot");
  const entry = readLedger(h.db, { subject: ballot.id })[0];
  assert.equal(entry?.action, "ballot.deleted");
  assert.deepEqual(JSON.parse(entry?.payload ?? "{}").scores, { craft: 4, impact: 2, novelty: 9 });
  assert.deepEqual(verifyLedger(h.db), []);
  h.close();
});

test("a pair is one row whichever way round it arrives, and a change of mind says so", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const [a, b] = [(h.projects[0] as ProjectRow).id, (h.projects[1] as ProjectRow).id];
  const { left, right } = canonicalPair(a, b);
  assert.deepEqual(canonicalPair(b, a), { left, right }, "the pair is not canonical");
  assert.ok(left < right);
  assert.throws(() => canonicalPair(a, a), (error: unknown) => {
    assert.ok(error instanceof RuleError);
    assert.equal(error.code, "comparison.samePair");
    return true;
  });
  const first = recordComparison(h.asJudge(0), h.event, { judgeId: judge, a, b, winner: a, reason: "bridge" });
  assert.deepEqual([first.left_id, first.right_id], [left, right]);
  assert.equal(first.winner_id, a);
  assert.equal(first.outcome, a === left ? "left" : "right");
  // The same pair, the other way round, with the other winner: one row, revised.
  h.clock.set(T0 + MS.minute);
  const second = recordComparison(h.asJudge(0), h.event, { judgeId: judge, a: b, b: a, winner: b });
  assert.equal(second.id, first.id, "the reversed pair made a second row");
  assert.equal(second.winner_id, b);
  assert.equal(second.decided_at, T0 + MS.minute);
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from comparison").n, 1);
  const entries = readLedger(h.db, { subject: first.id }).reverse();
  assert.deepEqual(entries.map((e) => e.action), ["comparison.recorded", "comparison.revised"]);
  assert.equal(JSON.parse(entries[0]?.payload ?? "{}").reason, "bridge");
  assert.equal(JSON.parse(entries[1]?.payload ?? "{}").previous_outcome, first.outcome);
  h.close();
});

test("a skip is stored, counted, and kept out of the fit", () => {
  // A skip says something about the judge or the pair, and nothing about which project
  // is better. Discarding it would hide a judge skipping two thirds of their duels.
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const skip = recordComparison(h.asJudge(0), h.event, {
    judgeId: judge,
    a: (h.projects[0] as ProjectRow).id,
    b: (h.projects[1] as ProjectRow).id,
    winner: null,
  });
  assert.deepEqual([skip.outcome, skip.winner_id], ["skip", null]);
  recordComparison(h.asJudge(0), h.event, {
    judgeId: judge,
    a: (h.projects[2] as ProjectRow).id,
    b: (h.projects[3] as ProjectRow).id,
    winner: (h.projects[2] as ProjectRow).id,
  });
  assert.equal(comparisonsOf(h.db, h.event.id, judge).length, 2);
  const progress = judgeProgress(h.db, h.event.id).find((p) => p.judgeId === judge);
  assert.deepEqual([progress?.comparisons, progress?.skipped], [1, 1]);
  // Only the decided one is offered to the engine, and it keeps the canonical order.
  const input = loadJudgingInput(h.db, h.event.id);
  assert.equal(input.comparisons.length, 1);
  assert.equal(input.comparisons[0]?.winner, (h.projects[2] as ProjectRow).id);
  assert.ok(input.comparisons.every((c) => c.left < c.right));
  h.close();
});

test("a comparison is refused when the event says no, the winner is a stranger, or the pool is not", () => {
  const off = world({ pairwise: false });
  assert.throws(
    () =>
      recordComparison(off.asJudge(0), off.event, {
        judgeId: (off.judges[0] as { id: string }).id,
        a: (off.projects[0] as ProjectRow).id,
        b: (off.projects[1] as ProjectRow).id,
        winner: (off.projects[0] as ProjectRow).id,
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "pairwise.disabled");
      return true;
    },
  );
  off.close();

  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const [a, b, c] = [h.projects[0] as ProjectRow, h.projects[1] as ProjectRow, h.projects[2] as ProjectRow];
  assert.throws(
    () => recordComparison(h.asJudge(0), h.event, { judgeId: judge, a: a.id, b: b.id, winner: c.id }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "comparison.winner");
      return true;
    },
  );
  disqualifyProject(h.asOrganizer, h.event, b, "used someone else's repository");
  assert.throws(
    () => recordComparison(h.asJudge(0), h.event, { judgeId: judge, a: a.id, b: b.id, winner: a.id }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "project.notJudgeable");
      assert.equal(error.detail.project, b.id);
      return true;
    },
  );
  h.clock.set(h.event.judging_close_at + 1);
  assert.throws(
    () => recordComparison(h.asJudge(0), h.event, { judgeId: judge, a: a.id, b: c.id, winner: a.id }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "judging.closed");
      return true;
    },
  );
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from comparison").n, 0);
  h.close();
});

test("a judge cannot score or compare a project owned by their own team", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const project = h.projects[0] as ProjectRow;
  addTeamMember(h.system, h.teams[0] as TeamRow, judge);

  assert.throws(
    () => saveBallot(h.asJudge(0), h.event, { judgeId: judge, projectId: project.id, scores: FULL_SCORES }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "judging.conflict");
      return true;
    },
  );
  assert.throws(
    () => recordComparison(h.asJudge(0), h.event, {
      judgeId: judge,
      a: project.id,
      b: (h.projects[1] as ProjectRow).id,
      winner: project.id,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "judging.conflict");
      return true;
    },
  );
  h.close();
});

test("what the engine is handed is exactly the submitted work on the published version", () => {
  const h = world();
  // Every judge scores every project, one project left with a draft, and one ballot on
  // a version that is about to be superseded.
  for (let j = 0; j < h.judges.length; j += 1) {
    for (const [index, project] of h.projects.entries()) {
      if (j === 0 && index === 3) continue;
      saveBallot(h.asJudge(j), h.event, {
        judgeId: (h.judges[j] as { id: string }).id,
        projectId: (project as ProjectRow).id,
        scores: { impact: ((index + j) % 5) + 1, craft: (j % 5) + 1, novelty: index + j },
      });
    }
  }
  saveBallot(h.asJudge(0), h.event, {
    judgeId: (h.judges[0] as { id: string }).id,
    projectId: (h.projects[3] as ProjectRow).id,
    scores: { impact: 3 },
    submit: false,
  });
  const input = loadJudgingInput(h.db, h.event.id);
  assert.equal(input.rubricVersion, 1);
  assert.equal(input.rubric.id, `${h.event.id}/v1`);
  assert.deepEqual(input.rubric.criteria.map((c) => c.key), ["impact", "craft", "novelty"]);
  assert.equal(input.ballots.length, h.judges.length * h.projects.length - 1);
  // Every ballot arrives complete and on one version, which is the precondition the
  // engine would otherwise have to check on data it did not choose.
  for (const ballot of input.ballots) {
    assert.equal(ballot.rubricVersion, 1);
    assert.deepEqual(Object.keys(ballot.scores).sort(), ["craft", "impact", "novelty"]);
  }
  assert.equal(new Set(input.ballots.map((b) => `${b.judge}/${b.project}`)).size, input.ballots.length);
  assert.deepEqual(verifyScoreRanges(h.db), []);
  // A second version, published: the same call now describes an event nobody has
  // scored yet rather than silently mixing the two scales.
  createRubricVersion(h.asOrganizer, h.event.id, [{ key: "impact", label: "Impact" }]);
  publishRubric(h.asOrganizer, h.event.id, 2);
  assert.deepEqual(loadJudgingInput(h.db, h.event.id).ballots, []);
  // And version one is still readable by asking for it, because the ballots are still
  // there and an organizer comparing the two needs both.
  assert.equal(loadJudgingInput(h.db, h.event.id, 1).ballots.length, input.ballots.length);
  h.close();
});

test("coverage counts what is missing, per track, and the gap list empties as it fills", () => {
  const h = world({ tracks: ["ai", "tools"], projects: 4, reviewsPerProject: 2 });
  assert.deepEqual(
    projectCoverage(h.db, h.event).map((c) => [c.title, c.trackKey, c.target, c.short]),
    [
      ["Project 0", "ai", 2, 2],
      ["Project 1", "tools", 2, 2],
      ["Project 2", "ai", 2, 2],
      ["Project 3", "tools", 2, 2],
    ],
  );
  assert.equal(coverageGaps(h.db, h.event).length, 4);
  assert.deepEqual(
    projectCoverage(h.db, h.event, "ai").map((c) => c.title),
    ["Project 0", "Project 2"],
  );
  for (let j = 0; j < 2; j += 1) {
    for (const project of h.projects) {
      saveBallot(h.asJudge(j), h.event, {
        judgeId: (h.judges[j] as { id: string }).id,
        projectId: (project as ProjectRow).id,
        scores: FULL_SCORES,
      });
    }
  }
  assert.deepEqual(coverageGaps(h.db, h.event), [], "coverage did not close");
  assert.deepEqual(
    projectCoverage(h.db, h.event).map((c) => [c.submitted, c.short]),
    [[2, 0], [2, 0], [2, 0], [2, 0]],
  );
  // The third judge has done nothing, and the dashboard says so rather than averaging
  // them away. Ordering is by display name, so the row is where an organizer looks.
  const progress = judgeProgress(h.db, h.event.id);
  assert.deepEqual(progress.map((p) => p.name), ["Judge 0", "Judge 1", "Judge 2"]);
  assert.deepEqual(progress.map((p) => p.submitted), [4, 4, 0]);
  assert.equal(progress[2]?.lastActiveAt, null);
  assert.equal(progress[0]?.email, "judge0@example.test");
  h.clock.set(T0 + MS.hour);
  recordComparison(h.asJudge(2), h.event, {
    judgeId: (h.judges[2] as { id: string }).id,
    a: (h.projects[0] as ProjectRow).id,
    b: (h.projects[1] as ProjectRow).id,
    winner: (h.projects[0] as ProjectRow).id,
  });
  // lastActiveAt is the later of the two kinds of work, not the later ballot.
  const refreshed = judgeProgress(h.db, h.event.id);
  assert.equal(refreshed[2]?.lastActiveAt, T0 + MS.hour);
  assert.equal(refreshed[0]?.lastActiveAt, T0);
  assert.deepEqual(
    projectCoverage(h.db, h.event).map((c) => c.comparisons),
    [1, 1, 0, 0],
  );
  h.close();
});

// ---------------------------------------------------------------------------
// The claim the schema makes on its own: a ballot from a non-judge cannot exist.
// ---------------------------------------------------------------------------

test("a ballot, assignment or comparison for somebody who is not a judge cannot be written", () => {
  // No repository refuses this. The refusal is the generated column `is_judge` plus a
  // composite foreign key into `membership (event_id, account_id, role)`, which means
  // the role is pinned inside the key rather than checked by code that could be
  // bypassed. Written directly, with the audit gate open, so what is being tested is
  // the schema and nothing else.
  const h = world();
  const builder = findAccountByEmail(h.db, "builder0@example.test");
  assert.ok(builder);
  assert.deepEqual(rolesIn(h.db, h.event.id, builder.id), ["participant"]);
  const project = (h.projects[0] as ProjectRow).id;
  const other = (h.projects[1] as ProjectRow).id;
  const write = (sql: string, params: Record<string, string | number | null>) =>
    h.system.recorded({ action: "test.probe", eventId: h.event.id, subject: project }, () => {
      h.system.write(sql, params);
    });
  assert.throws(
    () =>
      write(
        `insert into ballot (id, event_id, judge_id, project_id, rubric_version, comment,
           created_at, submitted_at)
         values ('B1', :e, :j, :p, 1, '', :at, :at)`,
        { e: h.event.id, j: builder.id, p: project, at: T0 },
      ),
    /FOREIGN KEY/,
    "a participant got a ballot",
  );
  assert.throws(
    () =>
      write(
        `insert into assignment (event_id, judge_id, project_id, reason, created_at)
         values (:e, :j, :p, 'manual', :at)`,
        { e: h.event.id, j: builder.id, p: project, at: T0 },
      ),
    /FOREIGN KEY/,
  );
  const { left, right } = canonicalPair(project, other);
  assert.throws(
    () =>
      write(
        `insert into comparison (id, event_id, judge_id, left_id, right_id, outcome,
           winner_id, reason, decided_at)
         values ('C1', :e, :j, :l, :r, 'left', :l, 'manual', :at)`,
        { e: h.event.id, j: builder.id, l: left, r: right, at: T0 },
      ),
    /FOREIGN KEY/,
  );
  // Granting the role makes the same insert legal, which is what proves the refusal
  // was about the role and not about something else in the row.
  grantRole(h.system, h.event.id, builder.id, "judge");
  assert.doesNotThrow(() =>
    write(
      `insert into ballot (id, event_id, judge_id, project_id, rubric_version, comment,
         created_at, submitted_at)
       values ('B1', :e, :j, :p, 1, '', :at, :at)`,
      { e: h.event.id, j: builder.id, p: project, at: T0 },
    ),
  );
  h.close();
});

test("revoking a judge removes access while retaining their judging evidence", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  const keeper = (h.judges[1] as { id: string }).id;
  for (const [index, project] of h.projects.entries()) {
    for (const [who, ctx] of [[judge, h.asJudge(0)], [keeper, h.asJudge(1)]] as [string, Ctx][]) {
      saveBallot(ctx, h.event, {
        judgeId: who,
        projectId: (project as ProjectRow).id,
        scores: FULL_SCORES,
        ...(index === 3 && who === judge ? { submit: false } : {}),
      });
    }
  }
  recordComparison(h.asJudge(0), h.event, {
    judgeId: judge,
    a: (h.projects[0] as ProjectRow).id,
    b: (h.projects[1] as ProjectRow).id,
    winner: (h.projects[0] as ProjectRow).id,
  });
  assert.equal(ballotsOf(h.db, h.event.id, judge).length, 4);
  assert.equal(loadJudgingInput(h.db, h.event.id).ballots.length, 7, "the draft was counted");

  revokeRole(h.system, h.event.id, judge, "judge");

  assert.equal(ballotsOf(h.db, h.event.id, judge).length, 4);
  assert.equal(assignmentsOf(h.db, h.event.id, judge).length, 4);
  assert.equal(comparisonsOf(h.db, h.event.id, judge).length, 1);
  assert.equal(
    h.db.one<{ n: number }>(
      "select count(*) as n from score where ballot_id not in (select id from ballot)",
    ).n,
    0,
    "scores outlived the ballot they belong to",
  );
  assert.equal(h.db.one<{ n: number }>("select count(*) as n from score").n, 24);
  assert.equal(ballotsOf(h.db, h.event.id, keeper).length, 4, "the wrong judge was cleared");
  assert.equal(loadJudgingInput(h.db, h.event.id).ballots.length, 7);
  // The account itself survives, and so does its other role if it has one. Revocation
  // is about one role in one event, not about deleting a person.
  assert.ok(findAccountByEmail(h.db, "judge0@example.test"));
  assert.deepEqual(rolesIn(h.db, h.event.id, judge), []);
  assert.deepEqual(judgeProgress(h.db, h.event.id).map((p) => p.name), ["Judge 1", "Judge 2"]);
  // The ledger points to evidence that remains available for an appeal.
  const entry = readLedger(h.db, { subject: judge }).find((e) => e.action === "membership.revoked");
  assert.deepEqual(JSON.parse(entry?.payload ?? "{}"), { role: "judge", retained_ballots: 4 });
  assert.deepEqual(verifyLedger(h.db), []);
  h.close();
});

// ---------------------------------------------------------------------------
// Tracks, attribution, and the one number worth publishing.
// ---------------------------------------------------------------------------

test("tracks are per event, ordered by the organizer, and cannot be pulled out from under a project", () => {
  const h = world({ tracks: ["ai", "tools"] });
  createTrack(h.asOrganizer, h.event.id, { key: "hardware", label: "Hardware", ordering: 5 });
  createTrack(h.asOrganizer, h.event.id, { key: "climate", label: "Climate", ordering: 1 });
  // Ordering first, key second: two tracks an organizer left at the default still come
  // out in a stable order rather than whichever order SQLite felt like.
  assert.deepEqual(listTracks(h.db, h.event.id).map((t) => t.key), ["ai", "climate", "tools", "hardware"]);
  assert.throws(
    () => createTrack(h.asOrganizer, h.event.id, { key: "ai", label: "AI again" }),
    /UNIQUE|PRIMARY KEY/,
  );
  for (const key of ["AI", "a i", "ai/ml", ""]) {
    assert.throws(
      () => createTrack(h.asOrganizer, h.event.id, { key, label: "No" }),
      /CHECK/,
      `track key ${JSON.stringify(key)} was accepted`,
    );
  }
  // The key is only unique within an event, which is the point of the composite key:
  // two events may both have an "ai" track and neither can see the other's.
  const other = createEvent(h.system, {
    slug: "other-2026",
    name: "Other 2026",
    submissionsOpenAt: T0,
    submissionsCloseAt: T0 + MS.day,
    judgingOpenAt: T0,
    judgingCloseAt: T0 + MS.day,
  });
  assert.doesNotThrow(() => createTrack(h.system, other.id, { key: "ai", label: "AI" }));
  assert.deepEqual(listTracks(h.db, other.id).map((t) => t.key), ["ai"]);
  // restrict, not cascade: a track with projects in it is a category those projects
  // were judged in, and deleting it would leave a ranking nobody can group.
  assert.equal(judgeablePool(h.db, h.event.id, "ai").length, 2);
  assert.throws(
    () =>
      h.system.recorded({ action: "track.deleted", eventId: h.event.id, subject: "ai" }, () => {
        h.system.write("delete from track where event_id = :e and key = 'ai'", { e: h.event.id });
      }),
    /FOREIGN KEY/,
  );
  assert.doesNotThrow(() =>
    h.system.recorded({ action: "track.deleted", eventId: h.event.id, subject: "hardware" }, () => {
      h.system.write("delete from track where event_id = :e and key = 'hardware'", { e: h.event.id });
    }),
  );
  h.close();
});

test("who did it is on the entry, and a context can only ever speak for one actor", () => {
  const h = world();
  const judge = (h.judges[0] as { id: string }).id;
  saveBallot(h.asJudge(0), h.event, {
    judgeId: judge,
    projectId: (h.projects[0] as ProjectRow).id,
    scores: FULL_SCORES,
  });
  const entry = readLedger(h.db, { eventId: h.event.id })[0];
  assert.equal(entry?.actor_id, judge);
  // `as` returns a new context rather than mutating one, so a handler that derives a
  // context for an impersonated write cannot accidentally leave the original pointing
  // at somebody else for the rest of the request.
  const asJudge = h.asJudge(0);
  const asOrganizer = asJudge.as(h.organizer.id);
  assert.equal(asJudge.actorId, judge);
  assert.equal(asOrganizer.actorId, h.organizer.id);
  assert.notEqual(asJudge, asOrganizer);
  // A context with no actor is the system, and the column says so rather than naming
  // some convenient account.
  const fresh = makeContext(h.db, { clock: h.clock, newId: h.system.newId });
  assert.equal(fresh.actorId, null);
  fresh.recorded({ action: "event.results_published", eventId: h.event.id, subject: h.event.id }, () => {
    fresh.write("update event set results_public = 1 where id = :id", { id: h.event.id });
  });
  assert.equal(readLedger(h.db, { eventId: h.event.id })[0]?.actor_id, null);
  h.close();
});

test("the same operations produce the same head hash, which is why publishing it means something", () => {
  // The head hash is on the health endpoint so an organizer can write it down
  // somewhere the database cannot reach. That is only worth doing if the hash is a
  // function of what happened rather than of when it ran, so two worlds built by the
  // same sequence of calls are compared here byte for byte.
  const a = world();
  const b = world();
  assert.equal(ledgerLength(a.db), ledgerLength(b.db));
  assert.equal(headHash(a.db), headHash(b.db), "the ledger is not a function of the operations");
  assert.match(headHash(a.db), /^[0-9a-f]{64}$/);
  const before = headHash(a.db);
  // One more operation on one of them, and the two part company for good.
  setResultsPublic(a.asOrganizer, a.event, true);
  assert.notEqual(headHash(a.db), before);
  assert.notEqual(headHash(a.db), headHash(b.db));
  // And the same operation on the other brings them back together, because the entry
  // covers what happened and not who asked or how long it took.
  setResultsPublic(b.asOrganizer, b.event, true);
  assert.equal(headHash(a.db), headHash(b.db));
  assert.deepEqual(verifyLedger(a.db), []);
  a.close();
  b.close();
});

test("nothing crosses an event boundary, not even by direct insert", () => {
  // Every event-scoped row carries `event_id` and every foreign key goes through it, so
  // a judge of one event cannot be given a project from another. This is the isolation
  // story's foundation: the API layer's checks are a second line, not the only one.
  const h = world();
  const other = createEvent(h.system, {
    slug: "other-2026",
    name: "Other 2026",
    submissionsOpenAt: T0 - MS.day,
    submissionsCloseAt: T0 + MS.day,
    judgingOpenAt: T0 - MS.day,
    judgingCloseAt: T0 + MS.day,
  });
  const judge = (h.judges[0] as { id: string }).id;
  grantRole(h.system, other.id, judge, "judge");
  createRubricVersion(h.system, other.id, [{ key: "impact", label: "Impact" }]);
  publishRubric(h.system, other.id, 1);
  const stranger = (h.projects[0] as ProjectRow).id;
  // Through the repository the answer is "no such project", which is also the answer
  // the API is required to give: a 404, not a 403, so the id itself stays private.
  assert.throws(
    () => saveBallot(h.asJudge(0), other, { judgeId: judge, projectId: stranger, scores: { impact: 3 } }),
    (error: unknown) => {
      assert.ok(error instanceof RuleError);
      assert.equal(error.code, "project.missing");
      return true;
    },
  );
  assert.equal(findProject(h.db, stranger)?.event_id, h.event.id);
  assert.equal(findProjectIn(h.db, other.id, stranger), undefined);
  // And directly, the composite key refuses the same thing.
  assert.throws(
    () =>
      h.system.recorded({ action: "test.probe", eventId: other.id, subject: stranger }, () => {
        h.system.write(
          `insert into ballot (id, event_id, judge_id, project_id, rubric_version, comment,
             created_at, submitted_at)
           values ('B2', :e, :j, :p, 1, '', :at, :at)`,
          { e: other.id, j: judge, p: stranger, at: T0 },
        );
      }),
    /FOREIGN KEY/,
  );
  assert.deepEqual(loadJudgingInput(h.db, other.id).ballots, []);
  assert.deepEqual(projectCoverage(h.db, other), []);
  h.close();
});
