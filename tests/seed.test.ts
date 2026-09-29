/**
 * The demo seed, run the way an operator runs it.
 *
 * `tools/seed-demo.ts` prints a summary of the world it just built — how many entries, how
 * many ballots, how many comparisons — and a printed count is a claim. This suite exists
 * because the last generated artefact in this repository that nothing re-ran was wrong for
 * as long as it took somebody to notice: `docs/proof/isolation.md` described seventeen
 * operations of a product that had forty-two. So the printed counts are checked against the
 * rows, by a query rather than by the array the tool counted.
 *
 * Invoked as a subprocess against a real file rather than imported. Two reasons, and the
 * second is the one that matters: the command an evaluator types is the artefact under test,
 * exit code and all, and the seed's refusal to run twice can only be observed by running it
 * twice against something that persists.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { findEventBySlug, headHash, ledgerLength, openReadOnly, verifyLedger } from "../src/db/index.ts";
import type { Db } from "../src/db/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const seeder = fileURLToPath(new URL("../tools/seed-demo.ts", import.meta.url));

/** The seed, pointed at a database of our own. */
function run(database: string, extraArgs: string[] = []): { status: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", seeder, ...extraArgs], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MANAK_DATABASE: database },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

/** Rows in one event, counted by a query that names `:e`. */
function count(db: Db, from: string, event: string): number {
  return db.one<{ n: number }>(`select count(*) as n from ${from}`, { e: event }).n;
}

/** The ledger head, read and released — a read-only handle held open blocks nothing but is untidy. */
function chain(database: string): { head: string; length: number } {
  const db = openReadOnly(database);
  try {
    return { head: headHash(db), length: ledgerLength(db) };
  } finally {
    db.close();
  }
}

test("the seed builds the event it says it builds, and the ledger it wrote verifies", () => {
  const dir = mkdtempSync(join(tmpdir(), "manak-seed-"));
  const database = join(dir, "seed.db");
  try {
    const first = run(database);
    assert.equal(first.status, 0, `npm run seed:demo failed\n${first.out}${first.err}`);

    const db = openReadOnly(database);
    try {
      const event = findEventBySlug(db, "dogfood");
      assert.ok(event, "the seed reported success without leaving an event behind");
      assert.equal(event.results_public, 1, "the seed says it publishes the results");
      assert.deepEqual(verifyLedger(db), [], "the seed wrote a chain that does not verify");

      // Both windows open at the moment it finished: the phase the product calls `overlap`,
      // and the only one in which every page of the demo is reachable. A seed that invented a
      // submissions window already closed would send an evaluator to the schema to find out
      // why the form answers 409.
      const now = Date.now();
      assert.ok(event.submissions_open_at < now && event.submissions_close_at > now);
      assert.ok(event.judging_open_at < now && event.judging_close_at > now);

      const of = (from: string): number => count(db, `${from} where event_id = :e`, event.id);
      assert.equal(of("project"), 6);
      assert.equal(count(db, "project where event_id = :e and status = 'submitted'", event.id), 5);
      assert.equal(of("ballot"), 11);
      assert.equal(of("comparison"), 13);
      assert.match(
        first.out,
        /6 entries \(5 submitted\), 11 ballots, 13 comparisons, results published/,
      );
      assert.match(first.out, new RegExp(`ledger ${ledgerLength(db)} entries, head ${headHash(db)}`));

      // Three judges, six teams, and every account the summary offered to sign in as.
      assert.equal(count(db, "membership where event_id = :e and role = 'judge'", event.id), 3);
      assert.equal(of("team"), 6);
      for (const email of ["rosa@example.com", "nils@example.com", "dev@example.com"]) {
        assert.match(first.out, new RegExp(email.replace(".", "\\.")));
      }

      // One comparison is a skip and one assignment holds no ballot. Both are deliberate:
      // they are what an organizer's dashboard has to be able to show, and a fixture in which
      // every judge finished everything cannot demonstrate either. The decided count is pinned
      // beside the total because the two move independently — a duel added as a skip and a duel
      // added as a decision both raise the total, and only one of them is a bigger comparison
      // graph for the Bradley–Terry fit to work with.
      assert.equal(count(db, "comparison where event_id = :e and outcome = 'skip'", event.id), 1);
      assert.equal(count(db, "comparison where event_id = :e and outcome != 'skip'", event.id), 12);
      assert.equal(of("assignment"), 12);

      // The uneven panel, which is the whole demonstration: two entries seen by all three
      // judges, two by a pair, one by a single judge, against a `reviews_per_project` of 3.
      // If this ever evens out, the ranking page stops having anything to say and
      // `rankMove` is zero down the column.
      const seen = db
        .all<{ n: number }>(
          `select count(*) as n from ballot where event_id = :e group by project_id order by n desc`,
          { e: event.id },
        )
        .map((row) => row.n);
      assert.deepEqual(seen, [3, 3, 2, 2, 1]);
      assert.equal(event.reviews_per_project, 3);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second run refuses without touching the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "manak-seed-"));
  const database = join(dir, "seed.db");
  try {
    assert.equal(run(database).status, 0);
    const before = chain(database);

    const second = run(database);
    assert.equal(second.status, 1, "a second seed should refuse rather than reconcile");
    assert.match(second.err, /already exists in this database/);
    // The head hash is the assertion that matters. Exit 1 after a partial write would leave a
    // deployment holding two half-demos, so the refusal has to happen before the first
    // insert, and an unmoved head is how that becomes visible rather than assumed.
    assert.deepEqual(chain(database), before, "the refused run wrote to the ledger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-stage seeding (--stages) builds 5 distinct lifecycle events that verify in the ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "manak-stages-"));
  const database = join(dir, "stages.db");
  try {
    const res = run(database, ["--stages"]);
    assert.equal(res.status, 0, `seed --stages failed\n${res.out}${res.err}`);
    assert.match(res.out, /5 multi-stage demo events created/);

    const db = openReadOnly(database);
    try {
      assert.deepEqual(verifyLedger(db), [], "the multi-stage seed wrote a chain that does not verify");
      for (const slug of ["stage-setup", "stage-submissions", "stage-judging", "stage-results", "stage-certificates"]) {
        const event = findEventBySlug(db, slug);
        assert.ok(event, `missing stage event ${slug}`);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bin/manak.ts seed --stages CLI command creates the 5 multi-stage demo events", () => {
  const dir = mkdtempSync(join(tmpdir(), "manak-cli-"));
  const database = join(dir, "cli.db");
  try {
    const cliPath = join(root, "bin", "manak.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cliPath, "seed", "--stages"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MANAK_DATABASE: database },
    });
    assert.equal(result.status, 0, `bin/manak.ts seed --stages failed\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /5 multi-stage demo events created/);

    const db = openReadOnly(database);
    try {
      assert.deepEqual(verifyLedger(db), []);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
