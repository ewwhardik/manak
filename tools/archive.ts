/**
 * Export and import, from a shell.
 *
 *     npm run archive:export -- ./backup-2026-09-28
 *     npm run archive:import -- ./backup-2026-09-28
 *
 * Both read `MANAK_DATABASE` the same way the server does, so the command an operator
 * types about their deployment is the same shape as the command that starts it. The
 * work is in `src/db/archive.ts`; what is here is the part that has to decide what to
 * do when something is wrong, which is a different question from what is true.
 *
 * **Export refuses almost nothing.** An integrity check that failed, a ledger chain
 * that does not verify, a migration that has not been applied: each is printed as a
 * warning and the export runs anyway. That is deliberate and it is the opposite of the
 * rule everywhere else in this repository. The reason is that this is the command
 * somebody runs *because* their deployment is in trouble, and a tool that refuses to
 * copy the data out of a damaged database on the grounds that it is damaged has
 * confused being careful with being useful. The warnings are loud, they name the
 * consequence — an archive with a broken chain will be refused on the way back in —
 * and the operator gets their rows.
 *
 * **Import refuses almost everything.** Wrong format, wrong schema, a bad digest, a
 * database that already holds rows, a chain that does not verify: all of them stop
 * before anything is committed. Import is the direction in which a mistake destroys
 * something, and there is no `--force`, for the same reason `tools/seed-demo.ts` has
 * none: every flag that skips one of these checks is a way to half-restore an event
 * that somebody is still collecting submissions in.
 *
 * The cut line: this is a whole-database tool. There is no per-event export, which is
 * the thing a Raptors organizer running several hackathons on one box would want, and
 * it is not here because a per-event archive is a different and harder claim — the
 * accounts, sessions and ledger entries of one event are entangled with every other,
 * and an export that cut through them would either carry rows belonging to strangers
 * or produce an archive that cannot be imported. Whole database, or nothing.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import {
  checkIntegrity,
  exportArchive,
  importArchive,
  migrate,
  migrationStatus,
  openDatabase,
  openReadOnly,
  readManifest,
  verifyLedger,
} from "../src/db/index.ts";
import type { Db } from "../src/db/index.ts";

const USAGE = `manak archive — the whole database, as a directory of text

  npm run archive:export -- <directory>    write an archive
  npm run archive:preview -- <directory>   validate and count without touching the deployment
  npm run archive:import -- <directory>    load one into an empty database

The database is MANAK_DATABASE, or ./data/manak.db. Name the directory after the
day rather than letting this command choose: an archive is not timestamped, so that
two exports of the same rows are the same bytes.

An archive holds every email address in the deployment. It is a copy of the database
in a form that looks harmless enough to attach to a support ticket.
`;

function databasePath(): string {
  const configured = process.env.MANAK_DATABASE?.trim();
  return configured === undefined || configured === "" ? "./data/manak.db" : configured;
}

/** Everything wrong with a database that an export should mention but not stop for. */
function warnings(db: Db): string[] {
  const found: string[] = [];
  const status = migrationStatus(db);
  if (status.problems.length > 0) {
    for (const problem of status.problems) found.push(`schema: ${problem}`);
  }
  if (status.pending.length > 0) {
    found.push(
      `${status.pending.length} migration(s) not applied here (${status.pending.join(", ")}), so ` +
        `this archive records the older schema and will only import into it`,
    );
  }
  for (const problem of checkIntegrity(db).slice(0, 5)) found.push(`integrity: ${problem}`);
  const breaks = verifyLedger(db);
  if (breaks.length > 0) {
    found.push(
      `the audit chain breaks at entry ${breaks[0]?.seq ?? "?"} (${breaks.length} break(s) in ` +
        `all). The archive will contain these rows and \`archive:import\` will refuse them, so ` +
        `fix the chain here or keep this copy as evidence rather than as a restore point`,
    );
  }
  return found;
}

function doExport(dir: string): number {
  const path = databasePath();
  process.stdout.write(`[archive] reading ${path}\n`);
  let db: Db;
  try {
    // Read-only, so this command cannot be the thing that damaged what it copied.
    // `appliedMigrations` runs a `create table if not exists` on the way through,
    // which SQLite answers without a write when the table is already there.
    db = openReadOnly(path);
  } catch (error) {
    process.stderr.write(
      `[archive] cannot open ${path}: ${error instanceof Error ? error.message : String(error)}\n` +
        `          MANAK_DATABASE points at the file to export.\n`,
    );
    return 1;
  }
  try {
    for (const warning of warnings(db)) process.stderr.write(`[archive] WARNING ${warning}\n`);
    const manifest = exportArchive(db, dir);
    const widest = Math.max(...manifest.tables.map((t) => t.name.length));
    for (const table of manifest.tables) {
      process.stdout.write(
        `[archive]   ${table.name.padEnd(widest)}  ${String(table.rows).padStart(6)} rows  ` +
          `${table.sha256.slice(0, 12)}\n`,
      );
    }
    process.stdout.write(
      `[archive] wrote ${manifest.tables.length} files and a manifest to ${resolve(dir)}\n` +
        `[archive] ${manifest.rows} rows, ledger head ${manifest.head}\n` +
        `[archive] this directory lists every email address in the deployment; ` +
        `treat it as the database\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `[archive] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    db.close();
  }
}

function doImport(dir: string): number {
  let manifest;
  try {
    manifest = readManifest(dir);
  } catch (error) {
    process.stderr.write(`[archive] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const path = databasePath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  process.stdout.write(
    `[archive] ${manifest.rows} rows in ${manifest.tables.length} tables, ` +
      `schema ${manifest.schema.map((m) => m.id).join(", ") || "none"}\n` +
      `[archive] writing ${path}\n`,
  );
  const db = openDatabase(path);
  try {
    migrate(db);
    const result = importArchive(db, dir);
    const problems = checkIntegrity(db);
    if (problems.length > 0) {
      // Reachable only if SQLite accepted rows that violate the schema it enforces,
      // which is a bug in this product or in the runtime rather than in the archive.
      // Reported rather than swallowed; the rows are committed by now.
      process.stderr.write(`[archive] imported, but the result does not check out:\n`);
      for (const problem of problems.slice(0, 10)) {
        process.stderr.write(`          ${problem}\n`);
      }
      return 1;
    }
    process.stdout.write(
      `[archive] imported ${result.rows} rows into ${result.tables} tables\n` +
        `[archive] ledger head ${result.head}, which is the one the manifest recorded\n` +
        `[archive] every session in the archive is live again; nobody has to sign in twice\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `[archive] ${error instanceof Error ? error.message : String(error)}\n` +
        `[archive] nothing was committed.\n`,
    );
    return 1;
  } finally {
    db.close();
  }
}

function doPreview(dir: string): number {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const result = importArchive(db, dir);
    process.stdout.write(`[archive] preview valid: ${result.rows} rows in ${result.tables} tables\n` +
      `[archive] ledger head ${result.head}\n` +
      `[archive] deployment database was not opened or changed. Import repeats these checks.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[archive] preview failed: ${error instanceof Error ? error.message : String(error)}\n` +
      `[archive] deployment database was not opened or changed.\n`);
    return 1;
  } finally { db.close(); }
}

function main(argv: readonly string[]): number {
  const [mode, dir] = argv;
  if (mode === undefined || dir === undefined || dir.startsWith("-")) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (mode === "export") return doExport(dir);
  if (mode === "preview") return doPreview(dir);
  if (mode === "import") return doImport(dir);
  process.stderr.write(`manak archive: unknown mode ${mode}\n\n${USAGE}`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
