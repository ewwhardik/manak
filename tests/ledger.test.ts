/**
 * The audit ledger.
 *
 * These tests are about one question: if somebody changes the record of what
 * happened, does anything notice. So most of them tamper — edit a payload, delete a
 * row, reorder two entries — and assert on what `verifyLedger` reports.
 *
 * One test asserts the *limitation* rather than the guarantee. Anyone who can write
 * to the database can recompute the chain forward from their edit, and the result
 * verifies clean. That is a property of putting the hashes in the same file as the
 * data, not a bug, and the value of the chain is that the head hash can be published
 * somewhere the database cannot reach. A test that pretends otherwise would be the
 * most dangerous thing in this file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  appendLedger,
  canonicalJson,
  entryHash,
  GENESIS,
  headHash,
  ledgerLength,
  readLedger,
  verifyLedger,
} from "../src/db/ledger.ts";
import type { LedgerEntry } from "../src/db/ledger.ts";
import { DatabaseError } from "../src/db/open.ts";
import { freshDb, T0 } from "./support/world.ts";

test("canonicalJson sorts object keys at every depth", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [3, { z: 1, y: 2 }] }),
    '{"a":[3,{"y":2,"z":1}],"b":1}',
  );
  // Array order is data, not presentation, and must survive untouched.
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test("canonicalJson drops undefined and refuses what JSON would silently ruin", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
    assert.throws(() => canonicalJson({ v: value }), (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "ledger.payload");
      return true;
    });
  }
  assert.throws(() => canonicalJson({ f: () => 1 }), /cannot hold a function/);
});

test("entryHash depends on every field it covers", () => {
  const base: Omit<LedgerEntry, "hash"> = {
    seq: 1,
    at: T0,
    event_id: "E",
    actor_id: "A",
    action: "ballot.submitted",
    subject: "P",
    payload: '{"a":1}',
    prev_hash: GENESIS,
  };
  const original = entryHash(base);
  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(entryHash(base), original, "hashing is not stable");
  const mutations: Partial<Omit<LedgerEntry, "hash">>[] = [
    { seq: 2 },
    { at: T0 + 1 },
    { event_id: "E2" },
    { event_id: null },
    { actor_id: "A2" },
    { actor_id: null },
    { action: "ballot.revised" },
    { subject: "P2" },
    { payload: '{"a":2}' },
    { prev_hash: "1".repeat(64) },
  ];
  for (const patch of mutations) {
    assert.notEqual(
      entryHash({ ...base, ...patch }),
      original,
      `changing ${Object.keys(patch).join(",")} did not change the hash`,
    );
  }
});

test("an empty ledger has the genesis head and nothing in it", () => {
  const h = freshDb();
  assert.equal(ledgerLength(h.db), 0);
  assert.equal(headHash(h.db), GENESIS);
  h.close();
});

test("appended entries number from one and link to the one before", () => {
  const h = freshDb();
  const first = appendLedger(h.db, T0, { action: "event.created", subject: "E", payload: { a: 1 } });
  const second = appendLedger(h.db, T0 + 1, { action: "team.created", subject: "T" });
  const third = appendLedger(h.db, T0 + 2, { action: "project.created", subject: "P" });
  assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
  assert.equal(first.prev_hash, GENESIS);
  assert.equal(second.prev_hash, first.hash);
  assert.equal(third.prev_hash, second.hash);
  assert.equal(headHash(h.db), third.hash);
  assert.equal(ledgerLength(h.db), 3);
  // Defaults: an action with no subject and no payload is still a well-formed row.
  assert.equal(second.subject, "T");
  assert.equal(second.payload, "{}");
  assert.equal(second.event_id, null);
  assert.deepEqual(verifyLedger(h.db), []);
  h.close();
});

test("payloads are stored canonically, so a re-read hashes to the same value", () => {
  const h = freshDb();
  const entry = appendLedger(h.db, T0, {
    action: "ballot.submitted",
    payload: { scores: { novelty: 3, craft: 5, impact: 1 }, draft: false },
  });
  assert.equal(entry.payload, '{"draft":false,"scores":{"craft":5,"impact":1,"novelty":3}}');
  const stored = h.db.one<LedgerEntry>(
    `select seq, at, event_id, actor_id, action, subject, payload, prev_hash, hash
       from ledger where seq = 1`,
  );
  assert.equal(entryHash(stored), stored.hash);
  h.close();
});

test("editing a payload is reported as a hash break on that entry alone", () => {
  const h = freshDb();
  for (let i = 1; i <= 5; i += 1) {
    appendLedger(h.db, T0 + i, { action: "ballot.submitted", payload: { n: i } });
  }
  assert.deepEqual(verifyLedger(h.db), []);
  h.db.run("update ledger set payload = :p where seq = 3", { p: '{"n":99}' });
  const breaks = verifyLedger(h.db);
  assert.equal(breaks.length, 1, JSON.stringify(breaks));
  assert.deepEqual(
    breaks.map((b) => `${b.seq}:${b.reason}`),
    ["3:hash"],
  );
  assert.match(breaks[0]?.detail ?? "", /edited after it was written/);
  h.close();
});

test("deleting an entry breaks both the numbering and the link", () => {
  const h = freshDb();
  for (let i = 1; i <= 4; i += 1) {
    appendLedger(h.db, T0 + i, { action: "ballot.submitted", payload: { n: i } });
  }
  h.db.run("delete from ledger where seq = 2");
  const breaks = verifyLedger(h.db);
  // Sequence 3 is where both problems surface: it is not the entry that was expected,
  // and it follows a hash no remaining entry produces.
  assert.deepEqual(
    breaks.map((b) => `${b.seq}:${b.reason}`),
    ["3:sequence", "3:link"],
  );
  h.close();
});

test("a single edit does not make everything after it look sound", () => {
  // The chain walks forward on the stored hash rather than the recomputed one, so
  // one edited row reports as one break — and the rows after it, whose prev_hash
  // still matches what is stored, are not accused of a crime they did not commit.
  const h = freshDb();
  for (let i = 1; i <= 6; i += 1) {
    appendLedger(h.db, T0 + i, { action: "ballot.submitted", payload: { n: i } });
  }
  h.db.run("update ledger set actor_id = 'someone-else' where seq = 2");
  const breaks = verifyLedger(h.db);
  assert.deepEqual(breaks.map((b) => `${b.seq}:${b.reason}`), ["2:hash"]);
  h.close();
});

test("a chain recomputed forward from an edit verifies clean, and that is the point", () => {
  // Stated as a test because it is the honest limit of the design. A hash chain in
  // the same file as the data it describes catches accidents and careless tampering.
  // It does not catch an administrator who rewrites the chain, and the only defence
  // against that is publishing the head hash somewhere else -- which is why
  // `headHash` is on the health endpoint rather than buried in a diagnostic.
  const h = freshDb();
  for (let i = 1; i <= 4; i += 1) {
    appendLedger(h.db, T0 + i, { action: "ballot.submitted", payload: { n: i } });
  }
  const before = headHash(h.db);
  h.db.run("update ledger set payload = '{\"n\":99}' where seq = 2");
  let previous = GENESIS;
  for (const row of h.db.all<LedgerEntry>(
    `select seq, at, event_id, actor_id, action, subject, payload, prev_hash, hash
       from ledger order by seq`,
  )) {
    const hash = entryHash({ ...row, prev_hash: previous });
    h.db.run("update ledger set prev_hash = :prev, hash = :hash where seq = :seq", {
      prev: previous,
      hash,
      seq: row.seq,
    });
    previous = hash;
  }
  assert.deepEqual(verifyLedger(h.db), [], "the rewritten chain should be internally consistent");
  assert.notEqual(headHash(h.db), before, "but the published head hash has moved");
  h.close();
});

test("verification is batched, and the batch size does not change the answer", () => {
  const h = freshDb();
  for (let i = 1; i <= 25; i += 1) {
    appendLedger(h.db, T0 + i, { action: "ballot.submitted", payload: { n: i } });
  }
  h.db.run("update ledger set subject = 'x' where seq = 17");
  for (const size of [1, 3, 10, 1000]) {
    assert.deepEqual(
      verifyLedger(h.db, size).map((b) => `${b.seq}:${b.reason}`),
      ["17:hash"],
      `batch size ${size} disagreed`,
    );
  }
  h.close();
});

test("the schema refuses a malformed entry even by direct insert", () => {
  // Worth more than it looks. Every check here was written as
  // `hash glob '[0-9a-f]*'` first, which in SQLite's GLOB constrains the first
  // character and then matches any run of anything -- so a 64-character token
  // starting with 'a' passed the "this column holds a hex digest" check, and
  // 'ballot submitted' passed the action check. The rows below are the cases that
  // exposed it, and they are the reason the constraints are negated globs now.
  const h = freshDb();
  const good = {
    at: T0,
    event: null,
    actor: null,
    action: "ballot.submitted",
    subject: "P",
    payload: "{}",
    prev: GENESIS,
    hash: "a".repeat(64),
  };
  const insert = (patch: Record<string, unknown>) =>
    h.db.run(
      `insert into ledger (at, event_id, actor_id, action, subject, payload, prev_hash, hash)
       values (:at, :event, :actor, :action, :subject, :payload, :prev, :hash)`,
      { ...good, ...patch } as Record<string, string | number | null>,
    );
  insert({});
  for (const [why, patch] of [
    ["a short hash", { hash: "b".repeat(63) }],
    ["a hash that is not hex at the start", { hash: `Z${"a".repeat(63)}` }],
    ["a hash that is not hex at the end", { hash: `${"a".repeat(63)}Z` }],
    ["a hash that is not hex in the middle", { hash: `${"a".repeat(30)}!${"b".repeat(33)}` }],
    ["an upper-case hash", { hash: "A".repeat(64) }],
    ["a short prev_hash", { prev: "c".repeat(10), hash: "d".repeat(64) }],
    ["a prev_hash that is not hex at the end", { prev: `${"c".repeat(63)}Z`, hash: "e".repeat(64) }],
    ["an upper-case action", { action: "Ballot.Submitted", hash: "f".repeat(64) }],
    ["an action with a space", { action: "ballot submitted", hash: "1".repeat(64) }],
    ["an action with a slash", { action: "ballot/submitted", hash: "2".repeat(64) }],
    ["an action with a newline", { action: "ballot.submitted\nx", hash: "3".repeat(64) }],
    ["an action too short to be a sentence", { action: "b", hash: "4".repeat(64) }],
    ["a payload that is not JSON", { payload: "not json", hash: "5".repeat(64) }],
    ["a duplicate hash", { subject: "Q" }],
  ] as [string, Record<string, unknown>][]) {
    assert.throws(() => insert(patch), `${why} was accepted`);
  }
  // And the shapes that must still be allowed, so the tightening did not overshoot:
  // no event, no actor, an empty subject, and a dotted multi-part action.
  insert({ action: "event.results_published", subject: "", hash: "6".repeat(64) });
  insert({ action: "ctx.unaudited", event: "E", actor: "A", hash: "7".repeat(64) });
  h.close();
});

test("readLedger filters by event and subject, newest first", () => {
  const h = freshDb();
  appendLedger(h.db, T0, { action: "event.created", eventId: "E1", subject: "E1" });
  appendLedger(h.db, T0 + 1, { action: "project.created", eventId: "E1", subject: "P1" });
  appendLedger(h.db, T0 + 2, { action: "project.created", eventId: "E2", subject: "P2" });
  appendLedger(h.db, T0 + 3, { action: "account.created", subject: "A1" });
  assert.deepEqual(
    readLedger(h.db, { eventId: "E1" }).map((e) => e.seq),
    [2, 1],
  );
  assert.deepEqual(
    readLedger(h.db, { eventId: null }).map((e) => e.action),
    ["account.created"],
  );
  assert.deepEqual(
    readLedger(h.db, { subject: "P2" }).map((e) => e.seq),
    [3],
  );
  assert.deepEqual(
    readLedger(h.db, { before: 3 }).map((e) => e.seq),
    [2, 1],
  );
  assert.equal(readLedger(h.db, { limit: 2 }).length, 2);
  // A caller asking for a million rows gets the cap, not the million.
  assert.equal(readLedger(h.db, { limit: 10 ** 6 }).length, 4);
  h.close();
});
