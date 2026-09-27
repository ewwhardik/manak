/**
 * `archive:export` and `archive:import`, run the way an operator runs them.
 *
 * What the round-trip proof does not cover is this file's subject. `tools/prove-roundtrip.ts`
 * establishes that the rows survive; it calls `exportArchive` and `importArchive` directly and
 * never types the command. But the command is where the interesting decisions are, and they
 * point in opposite directions on purpose: **export refuses almost nothing**, because it is what
 * somebody runs when their deployment is already in trouble, and **import refuses almost
 * everything**, because it is the direction in which a mistake destroys something. A test of the
 * module cannot tell those apart — both are the same two functions with the same arguments.
 *
 * So each test here spawns the CLI against a database of its own and reads the exit code, which
 * is the part a backup script depends on and the part no other suite looks at.
 *
 * The cut line: nothing here checks the *contents* of an archive beyond the counts the tool
 * prints. That is `tools/prove-roundtrip.ts`, which asserts it against a database holding a row
 * in all nineteen tables, and duplicating it here would be a second, weaker copy of a claim
 * already proved byte for byte.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  ARCHIVE_TABLES,
  createEvent,
  DatabaseError,
  findEventBySlug,
  grantRole,
  headHash,
  makeContext,
  manualClock,
  migrate,
  MS,
  openDatabase,
  openReadOnly,
  readManifest,
  upsertAccount,
  verifyLedger,
} from "../src/db/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../tools/archive.ts", import.meta.url));
const AT = Date.parse("2026-09-27T09:00:00.000Z");

/** The command, with `MANAK_DATABASE` pointed somewhere this suite owns. */
function archive(
  args: readonly string[],
  database: string,
): { status: number | null; out: string; err: string } {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", cli, ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, MANAK_DATABASE: database } },
  );
  return { status: run.status, out: run.stdout, err: run.stderr };
}

/** A small world, built through the repositories so every row is one the product would write. */
function plant(database: string): void {
  const db = openDatabase(database);
  try {
    const clock = manualClock(AT);
    migrate(db, undefined, clock);
    const ctx = makeContext(db, { clock });
    const event = createEvent(ctx, {
      slug: "archive-test",
      name: "Archive Test",
      submissionsOpenAt: AT - MS.day,
      submissionsCloseAt: AT + MS.day,
      judgingOpenAt: AT - MS.hour,
      judgingCloseAt: AT + MS.day,
    });
    const ada = upsertAccount(ctx, "ada@example.test", "Ada Lovelace");
    grantRole(ctx, event.id, ada.id, "organizer");
  } finally {
    db.close();
  }
}

/** Every file in an archive, as text, so two of them can be compared rather than described. */
function bytesOf(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    files.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return files;
}

/** The ledger head, read and released. */
function head(database: string): string {
  const db = openReadOnly(database);
  try {
    return headHash(db);
  } finally {
    db.close();
  }
}

/** A directory nobody else is using, removed however the test ends. */
function scratch(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "manak-archive-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a deployment moves to another database, and the ledger arrives with it", () => {
  scratch((dir) => {
    const from = join(dir, "from.db");
    const to = join(dir, "nested", "to.db");
    const out = join(dir, "archive");
    plant(from);

    const exported = archive(["export", out], from);
    assert.equal(exported.status, 0, `export failed\n${exported.out}${exported.err}`);
    assert.match(exported.out, new RegExp(`wrote ${ARCHIVE_TABLES.length} files and a manifest`));
    // The warning about what an archive contains is not decoration. It is the one thing an
    // operator needs to know before attaching the directory to a support ticket.
    assert.match(exported.out, /every email address in the deployment/);

    // The target path does not exist yet, directory and all: this is the shape of a restore
    // onto a fresh machine, and a tool that made the operator create the directory first would
    // be one step of a runbook nobody reads.
    const imported = archive(["import", out], to);
    assert.equal(imported.status, 0, `import failed\n${imported.out}${imported.err}`);
    assert.match(imported.out, new RegExp(`imported \\d+ rows into ${ARCHIVE_TABLES.length} tables`));
    assert.match(imported.out, /nobody has to sign in twice/);

    assert.equal(head(to), head(from), "the restored database has a different ledger head");
    const db = openReadOnly(to);
    try {
      assert.deepEqual(verifyLedger(db), []);
      assert.equal(findEventBySlug(db, "archive-test")?.name, "Archive Test");
    } finally {
      db.close();
    }
  });
});

test("two exports of the same rows are the same bytes", () => {
  scratch((dir) => {
    const database = join(dir, "twice.db");
    plant(database);
    assert.equal(archive(["export", join(dir, "one")], database).status, 0);
    assert.equal(archive(["export", join(dir, "two")], database).status, 0);
    // Nothing in an archive is a timestamp, which is what lets a backup script diff yesterday's
    // export against today's and see the rows that changed rather than the minute it ran.
    assert.deepEqual(bytesOf(join(dir, "one")), bytesOf(join(dir, "two")));
  });
});

test("preview validates an archive without opening or changing the deployment database", () => {
  scratch((dir) => {
    const from = join(dir, "from.db");
    const untouched = join(dir, "untouched.db");
    const out = join(dir, "archive");
    plant(from);
    assert.equal(archive(["export", out], from).status, 0);
    const preview = archive(["preview", out], untouched);
    assert.equal(preview.status, 0, preview.err);
    assert.match(preview.out, /preview valid/);
    assert.equal(existsSync(untouched), false);
    const corrupted = join(out, "event.jsonl");
    writeFileSync(corrupted, readFileSync(corrupted, "utf8") + "invalid");
    const refused = archive(["preview", out], untouched);
    assert.equal(refused.status, 1);
    assert.match(refused.err, /hashes to/);
    assert.equal(existsSync(untouched), false);
  });
});

test("import refuses a database that already holds rows, and commits nothing", () => {
  scratch((dir) => {
    const from = join(dir, "from.db");
    const to = join(dir, "to.db");
    const out = join(dir, "archive");
    plant(from);
    assert.equal(archive(["export", out], from).status, 0);
    assert.equal(archive(["import", out], to).status, 0);
    const before = head(to);

    const again = archive(["import", out], to);
    assert.equal(again.status, 1, "importing over a live deployment should refuse");
    assert.match(again.err, /already holds/);
    assert.match(again.err, /Merging two deployments is a decision this tool will not make/);
    assert.match(again.err, /nothing was committed/);
    assert.equal(head(to), before, "the refused import moved the ledger");
  });
});

test("export warns about a broken chain and copies the rows out anyway", () => {
  scratch((dir) => {
    const from = join(dir, "from.db");
    const to = join(dir, "to.db");
    const out = join(dir, "archive");
    plant(from);

    // Straight SQL, because no part of the product can do this: the ledger has no update path.
    // This is the state a damaged deployment is actually in when somebody reaches for a backup.
    const db = openDatabase(from);
    try {
      db.run(`update ledger set payload = '{"slug":"edited"}' where seq = 1`);
      assert.ok(verifyLedger(db).length > 0, "the chain was supposed to be broken by now");
    } finally {
      db.close();
    }

    const exported = archive(["export", out], from);
    // Exit 0, deliberately. A tool that refuses to copy the data out of a damaged database on
    // the grounds that it is damaged has confused being careful with being useful.
    assert.equal(exported.status, 0, `a warning became a refusal\n${exported.err}`);
    assert.match(exported.err, /WARNING the audit chain breaks at entry 1 \(1 break\(s\) in all\)/);
    assert.match(exported.err, /keep this copy as evidence rather than as a restore point/);
    assert.match(exported.out, new RegExp(`wrote ${ARCHIVE_TABLES.length} files and a manifest`));

    // And the consequence the warning named, demonstrated rather than promised.
    const imported = archive(["import", out], to);
    assert.equal(imported.status, 1, "an archive with a broken chain should not import");
    assert.match(imported.err, /the imported ledger does not verify/);
    assert.match(imported.err, /this row was edited after it was written/);
    assert.match(imported.err, /nothing was committed/);
  });
});

test("export warns when the database is not at the schema this build applies", () => {
  scratch((dir) => {
    const from = join(dir, "from.db");
    const to = join(dir, "to.db");
    const out = join(dir, "archive");
    plant(from);
    const db = openDatabase(from);
    try {
      // The same shape as a database restored from an older release: the tables are there and
      // the bookkeeping says nothing has been applied. An export has to say so, because the
      // archive it writes records the schema it found and will only import back into that.
      db.run("delete from migration");
    } finally {
      db.close();
    }

    const exported = archive(["export", out], from);
    assert.equal(exported.status, 0, `a warning became a refusal\n${exported.err}`);
    assert.match(exported.err, /migration\(s\) not applied here/);
    assert.match(exported.err, /will only import into it/);

    const imported = archive(["import", out], to);
    assert.equal(imported.status, 1, "an archive from another schema should not import");
    assert.match(imported.err, /nothing was committed/);
  });
});

test("the command says what it wants when it is asked for nothing", () => {
  scratch((dir) => {
    const database = join(dir, "unused.db");
    for (const args of [[], ["export"], ["export", "--force"]]) {
      const run = archive(args, database);
      assert.equal(run.status, 2, `\`archive ${args.join(" ")}\` should print usage`);
      assert.match(run.err, /npm run archive:export -- <directory>/);
    }
    const unknown = archive(["backup", join(dir, "out")], database);
    assert.equal(unknown.status, 2);
    assert.match(unknown.err, /unknown mode backup/);
    // `unused.db` was never created by any of the above. A usage error that left a database
    // file behind would be a tool that acted before it understood the request.
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("exporting a database that is not there fails with the variable that names it", () => {
  scratch((dir) => {
    const missing = archive(["export", join(dir, "out")], join(dir, "nothing.db"));
    assert.equal(missing.status, 1);
    assert.match(missing.err, /cannot open/);
    assert.match(missing.err, /MANAK_DATABASE points at the file to export/);
  });
});

test("a directory that is not an archive is refused before a database is opened", () => {
  scratch((dir) => {
    // The likeliest operator error, and the reason the message names what it found: an
    // `archive:import` pointed one directory too high.
    assert.throws(
      () => readManifest(dir),
      (error: unknown) =>
        error instanceof DatabaseError &&
        error.code === "archive.manifest" &&
        /an empty directory/.test(error.message),
    );
    const run = archive(["import", dir], join(dir, "to.db"));
    assert.equal(run.status, 1);
    assert.match(run.err, /is not readable, so this is not an archive/);
    assert.deepEqual(readdirSync(dir), [], "a refused import created a database anyway");
  });
});

test("every table in the schema is named in the archive's table list", () => {
  scratch((dir) => {
    const database = join(dir, "from.db");
    plant(database);
    assert.equal(archive(["export", join(dir, "out")], database).status, 0);
    const manifest = readManifest(join(dir, "out"));
    // `exportArchive` refuses a table it has never heard of, which is the guard that matters;
    // this is the other half of it, and it is here because the CLI prints one line per table
    // and an operator counting those lines is entitled to assume they are all of them.
    assert.deepEqual(
      manifest.tables.map((table) => table.name),
      [...ARCHIVE_TABLES],
    );
    assert.deepEqual(
      manifest.notExported.map((table) => table.name),
      ["migration", "sqlite_sequence"],
    );
  });
});
