/**
 * Migrations, forward only, with teeth.
 *
 * The runner is deliberately small — read the `.sql` files next to this one in
 * name order, apply the ones not yet recorded, record what was applied — and then
 * spends its remaining complexity on refusing to run in four situations that a
 * simpler runner performs silently. Each one has cost somebody a corrupted
 * environment at some point, and none of them is detectable later.
 *
 *   - **An applied migration whose file has changed.** The hash of every applied
 *     file is stored. Editing `001_init.sql` after it ran gives a database whose
 *     shape does not match the file that claims to describe it, and a fresh clone
 *     then builds a different schema from the same repository. Refused.
 *   - **An applied migration whose file is gone.** The same divergence from the
 *     other direction. Refused.
 *   - **A new migration that sorts before an applied one.** Two branches merged,
 *     and this machine would apply `003` after `004`. A fresh clone would not.
 *     Since the two orders can produce different schemas, refused.
 *   - **A partially applied file.** Each file runs inside a transaction, so it
 *     lands whole or not at all. SQLite has transactional DDL; this is the reason
 *     to be glad of it.
 *
 * Known limitation, stated rather than discovered: a migration that needs
 * `pragma foreign_keys = off` — SQLite's twelve-step table rebuild — cannot use it
 * here, because that pragma is a no-op inside a transaction. Such a migration must
 * be written as a new table plus a copy, which is what the twelve steps amount to
 * anyway.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Db } from "./open.ts";
import { DatabaseError } from "./open.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

export type MigrationFile = { id: string; sql: string; sha256: string; bytes: number };
export type AppliedMigration = { id: string; applied_at: number; sha256: string; bytes: number };

/** Where the `.sql` files live, resolved relative to this module rather than cwd. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const CREATE_BOOKKEEPING = `
create table if not exists migration (
  id         text    not null primary key,
  applied_at integer not null,
  sha256     text    not null,
  bytes      integer not null
) strict, without rowid;
`;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every migration on disk, in the order it must be applied. */
export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) {
    throw new DatabaseError("migrate.empty", `no .sql migrations found in ${dir}`);
  }
  return names.map((id) => {
    // Read as text and normalize nothing: the hash has to be of the bytes a
    // reviewer sees. `.gitattributes` pins these files to LF so the hash is the
    // same on every platform, which is why that file is not cosmetic.
    const sql = readFileSync(join(dir, id), "utf8");
    return { id, sql, sha256: sha256(sql), bytes: Buffer.byteLength(sql, "utf8") };
  });
}

export function appliedMigrations(db: Db): AppliedMigration[] {
  db.exec(CREATE_BOOKKEEPING);
  return db.all<AppliedMigration>("select id, applied_at, sha256, bytes from migration order by id");
}

export type MigrationPlan = {
  pending: MigrationFile[];
  applied: AppliedMigration[];
  problems: string[];
};

/**
 * Work out what would happen, without doing any of it.
 *
 * Separated from `migrate` so the health endpoint and the Docker entrypoint can
 * both ask "is this database current?" without the answer being a side effect.
 */
export function planMigrations(db: Db, dir: string = MIGRATIONS_DIR): MigrationPlan {
  const files = readMigrations(dir);
  const applied = appliedMigrations(db);
  const onDisk = new Map(files.map((f) => [f.id, f]));
  const problems: string[] = [];

  for (const record of applied) {
    const file = onDisk.get(record.id);
    if (!file) {
      problems.push(
        `${record.id} was applied on ${new Date(record.applied_at).toISOString()} but is no ` +
          `longer in ${dir}. A fresh clone would build a different schema than this database has.`,
      );
      continue;
    }
    if (file.sha256 !== record.sha256) {
      problems.push(
        `${record.id} has changed since it was applied (recorded ${record.sha256.slice(0, 12)}, ` +
          `on disk ${file.sha256.slice(0, 12)}). Add a new migration instead of editing this one.`,
      );
    }
  }

  const last = applied.length > 0 ? (applied[applied.length - 1] as AppliedMigration).id : "";
  const done = new Set(applied.map((a) => a.id));
  const pending = files.filter((f) => !done.has(f.id));
  for (const file of pending) {
    if (file.id < last) {
      problems.push(
        `${file.id} is new but sorts before ${last}, which is already applied. Applying it now ` +
          `would give this database a different history than a fresh clone. Rename it to sort last.`,
      );
    }
  }
  return { pending, applied, problems };
}

export type MigrationResult = { applied: string[]; alreadyCurrent: boolean };

/**
 * Bring the database up to date.
 *
 * Returns the ids it applied so a caller can log them; logging is not done here
 * because this module has no opinion about where output goes.
 *
 * The clock is a parameter for the same reason it is everywhere else in this layer:
 * `applied_at` is a domain timestamp that a test asserts on, and a reading of the
 * system clock buried in a function body is a value no test can pin.
 */
export function migrate(
  db: Db,
  dir: string = MIGRATIONS_DIR,
  clock: Clock = systemClock,
): MigrationResult {
  const plan = planMigrations(db, dir);
  if (plan.problems.length > 0) {
    throw new DatabaseError(
      "migrate.divergent",
      `refusing to migrate:\n  - ${plan.problems.join("\n  - ")}`,
    );
  }
  const at = clock.now();
  const applied: string[] = [];
  for (const file of plan.pending) {
    db.tx(() => {
      db.exec(file.sql);
      db.run(
        "insert into migration (id, applied_at, sha256, bytes) values (:id, :at, :sha, :bytes)",
        { id: file.id, at, sha: file.sha256, bytes: file.bytes },
      );
    });
    applied.push(file.id);
  }
  return { applied, alreadyCurrent: applied.length === 0 };
}

/**
 * A one-line summary for the health endpoint.
 *
 * A deployment serving requests against a database with pending migrations is a
 * deployment about to fail on whichever query touches the missing column, so this
 * is the sort of thing an operator should be able to see without a shell.
 */
export function migrationStatus(db: Db, dir: string = MIGRATIONS_DIR): {
  current: boolean;
  applied: number;
  pending: string[];
  problems: string[];
} {
  const plan = planMigrations(db, dir);
  return {
    current: plan.pending.length === 0 && plan.problems.length === 0,
    applied: plan.applied.length,
    pending: plan.pending.map((f) => f.id),
    problems: plan.problems,
  };
}
