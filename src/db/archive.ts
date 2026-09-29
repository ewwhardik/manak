/**
 * The whole database, as a directory of text.
 *
 * An event's data has to be able to leave. A hackathon portal is run for three days
 * on a box somebody borrowed, and the two things that happen next are that the box
 * goes away and that somebody asks for the results a year later. `cp manak.db` is
 * the honest answer to both and this module still exists, for four reasons a file
 * copy cannot give:
 *
 *   - **It is readable.** `head -1 project.jsonl` answers "what did this event hold"
 *     without SQLite, a client, or this product. In ten years that matters more than
 *     it does today.
 *   - **It is diffable.** Two archives of the same event differ in the rows that
 *     changed, which is what makes the round-trip proof possible at all: a page-level
 *     file copy has no comparison weaker than "identical bytes" and no way to say
 *     what moved.
 *   - **It carries its own integrity.** The manifest holds a sha256 per file, so a
 *     truncated download or a checkout that rewrote line endings is caught at the
 *     import rather than discovered as missing ballots.
 *   - **It localizes damage.** A truncated `.jsonl` identifies the damaged table;
 *     import refuses the entire archive before committing partial state.
 *
 * **Everything is exported.** All 33 application tables, every row, including sessions and
 * unconsumed magic links. Two absences and no others, both named in the manifest so
 * that "what is missing" is a published fact rather than a thing to be discovered:
 * `migration` is rebuilt by the migrator on the way in and is pinned in the manifest
 * instead, and `sqlite_sequence` is SQLite's own bookkeeping, restored implicitly
 * because the ledger's sequence numbers are written explicitly. Session rows contain
 * token digests rather than bearer tokens, but the archive still contains private
 * account and event data and must be handled as a sensitive backup.
 *
 * What an archive *does* hand over is every email address in the deployment, which
 * for this product is the asset worth taking. It is a copy of the database in a form
 * that looks harmless enough to paste into a support ticket. The CLI says so on every
 * export, in one line, because that is the mistake this format makes easy.
 *
 * **The column list is derived, never written down.** `pragma table_info` gives the
 * columns in declaration order and omits generated ones — `assignment.is_judge` and
 * its two siblings — which is exactly the set that can be inserted. A hand-kept list
 * would be a second description of the schema, and the interesting bug is the column
 * added in a migration that the export forgot. The table list, by contrast, *is*
 * written down, and `exportArchive` refuses to run if the schema holds a table it does
 * not name: the order is a foreign-key ordering that a human checked, and a
 * topological sort computed at run time would be a clever way to be wrong quietly.
 *
 * The cut line: an archive can only be imported into the schema it left. The manifest
 * carries the applied migrations and their hashes, and a mismatch is refused rather
 * than attempted, because an import that skipped a column added since would produce a
 * database that is wrong rather than one that is absent. A future migration that
 * changes a table therefore owes this format a converter, and until there is a second
 * migration to test one against, refusing is the only claim worth making.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Db, Param } from "./open.ts";
import { DatabaseError } from "./open.ts";
import { appliedMigrations } from "./migrate.ts";
import { headHash, verifyLedger } from "./ledger.ts";

/**
 * The layout version, bumped when a reader written for an older archive would get
 * this one wrong. Not the product version: two archives of the same rows should be
 * identical bytes, and stamping 0.1.0 into the manifest would make every release
 * produce a different file from the same data for no reader's benefit.
 */
export const ARCHIVE_FORMAT = 1;

/** The one file in an archive that is not a table. */
export const MANIFEST = "manifest.json";

/**
 * Every table, in an order that can be inserted from front to back.
 *
 * This is the declaration order of `001_init.sql`, which is already a foreign-key
 * ordering — each table's parents are above it — and `assertOrder` checks that rather
 * than trusting this comment.
 */
export const ARCHIVE_TABLES: readonly string[] = [
  "event",
  "account",
  "membership",
  "voter",
  "session",
  "magic_link",
  "rate_limit",
  "track",
  "team",
  "team_member",
  "team_invite",
  "project",
  "judge_track",
  "judge_capacity",
  "judge_recusal",
  "vote",
  "vote_discount",
  "abuse_policy",
  "abuse_review",
  "rubric",
  "criterion",
  "assignment",
  "review_request",
  "ballot",
  "score",
  "comparison",
  "result_publication",
  "award_decision",
  "appeal",
  "certificate_batch",
  "certificate_template",
  "certificate_correction",
  "ledger",
];

/** The tables that are deliberately not rows in an archive, and why. */
export const NOT_EXPORTED: readonly { readonly name: string; readonly reason: string }[] = [
  {
    name: "api_token",
    reason:
      "scoped bearer tokens belong to account sessions and are not exported across deployment instances",
  },
  {
    name: "webhook_subscription",
    reason: "deployment-owned receiver credentials and delivery cursor are reconfigured on restore",
  },
  {
    name: "webhook_delivery",
    reason: "pending delivery attempts belong to the original deployment and must not replay from an archive",
  },
  {
    name: "migration",
    reason:
      "rebuilt by the migrator on import; the applied ids and their hashes are in " +
      "`schema`, where they are checked rather than restored",
  },
  {
    name: "sqlite_sequence",
    reason:
      "SQLite's own autoincrement bookkeeping; restored implicitly, because ledger " +
      "sequence numbers are written explicitly and SQLite tracks the highest",
  },
];

export type ArchiveFile = {
  readonly name: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
};

export type Manifest = {
  readonly format: number;
  /** The migrations the source database had applied, in id order. */
  readonly schema: readonly { readonly id: string; readonly sha256: string }[];
  readonly tables: readonly ArchiveFile[];
  readonly notExported: readonly { readonly name: string; readonly reason: string }[];
  /** The ledger head at export, or the genesis hash for an empty ledger. */
  readonly head: string;
  readonly rows: number;
};

export type ImportResult = {
  readonly tables: number;
  readonly rows: number;
  /** The ledger head after import. Equal to the manifest's, or this threw. */
  readonly head: string;
};

/** A cell, as JSON can carry it. STRICT tables and no BLOB column make this total. */
type Cell = string | number | null;
type Row = Record<string, Cell>;

const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `pragma table_info`, reduced to what an export needs. */
type ColumnInfo = { name: string; pk: number };

/**
 * The insertable columns of a table, in declaration order.
 *
 * Generated columns are absent because `table_info` omits them, which is the whole
 * reason this uses `table_info` rather than `table_xinfo`: `insert into assignment
 * (is_judge)` is an error, and a column list that included it would turn every
 * assignment row into one.
 */
function columnsOf(db: Db, table: string): ColumnInfo[] {
  const columns = db.all<ColumnInfo>(`pragma table_info(${quote(table)})`);
  if (columns.length === 0) {
    throw new DatabaseError("archive.table", `${table} has no columns, or does not exist`);
  }
  return columns;
}

/**
 * The order rows are written in: the primary key, in key order.
 *
 * Every table in this schema has one, so the fallback is an assertion rather than a
 * strategy. Without a total order two exports of one database could differ in the
 * order SQLite happened to return, and the round-trip proof would be comparing the
 * query planner rather than the data.
 */
function orderOf(db: Db, table: string, columns: readonly ColumnInfo[]): string {
  const key = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  if (key.length === 0) {
    throw new DatabaseError(
      "archive.order",
      `${table} has no primary key, so its rows have no total order and an export of ` +
        `it could not be compared with another. Give it one, or exclude it.`,
    );
  }
  return key.map((c) => quote(c.name)).join(", ");
}

/**
 * A SQLite identifier, quoted.
 *
 * Every name this module handles comes from `ARCHIVE_TABLES` or from `table_info`, so
 * none of them is attacker-supplied and none needs escaping. It is done anyway: a
 * pragma cannot take a bound parameter, so this is the one place in the codebase
 * where SQL is built by concatenation, and the rule that holds everywhere else should
 * not be quietly suspended just because the input happens to be safe today.
 */
function quote(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new DatabaseError("archive.name", `refusing to build SQL around the name ${name}`);
  }
  return `"${name}"`;
}

/** Every table the database actually has, excluding SQLite's own. */
function tablesInSchema(db: Db): string[] {
  return db
    .all<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .map((row) => row.name);
}

/**
 * Refuse to export a database whose schema this declaration does not describe.
 *
 * The failure worth catching: migration 002 adds a table, nobody adds it here, and
 * every export from that day on is silently missing it. An archive that is quietly
 * partial is worse than an export that failed, because the second one is noticed on
 * the day it happens and the first is noticed by whoever tries to restore.
 */
function assertTables(db: Db): void {
  const present = new Set(tablesInSchema(db));
  const declared = new Set(ARCHIVE_TABLES);
  const known = new Set([...declared, ...NOT_EXPORTED.map((t) => t.name)]);
  const unaccounted = [...present].filter((name) => !known.has(name));
  const absent = [...declared].filter((name) => !present.has(name));
  if (unaccounted.length > 0) {
    throw new DatabaseError(
      "archive.tableSet",
      `the schema holds ${unaccounted.join(", ")}, which src/db/archive.ts does not name. Add ` +
        `each to ARCHIVE_TABLES in an order that keeps parents first, or to NOT_EXPORTED with ` +
        `the reason. Refusing to write an archive that is silently missing a table.`,
    );
  }
  if (absent.length > 0) {
    throw new DatabaseError(
      "archive.tableSet",
      `ARCHIVE_TABLES names ${absent.join(", ")}, which this database does not have. Migrate ` +
        `it before exporting.`,
    );
  }
}

/**
 * Check that `ARCHIVE_TABLES` really is an insertable order.
 *
 * Read from `pragma foreign_key_list` rather than from the migration text, so the
 * thing checked is the schema in front of us. A self-reference is allowed — no table
 * here has one, and a row that points at its own table can be inserted after its
 * parent within the same file — but a parent that sorts later cannot be, and that is
 * the arrangement two merged branches produce.
 */
function assertOrder(db: Db): void {
  const position = new Map(ARCHIVE_TABLES.map((name, index) => [name, index]));
  const late: string[] = [];
  for (const [index, table] of ARCHIVE_TABLES.entries()) {
    for (const fk of db.all<{ table: string }>(`pragma foreign_key_list(${quote(table)})`)) {
      const parent = position.get(fk.table);
      if (parent === undefined || parent > index) late.push(`${table} → ${fk.table}`);
    }
  }
  if (late.length > 0) {
    throw new DatabaseError(
      "archive.order",
      `ARCHIVE_TABLES is not a foreign-key order: ${late.join(", ")} points at a table that ` +
        `sorts later, so an import would fail on the first row. Reorder it.`,
    );
  }
}

/**
 * One row, as one line of JSON.
 *
 * Keys are written in column order rather than however the driver returned them, so
 * that two exports of one row are the same bytes. `null` is written and never elided:
 * an absent key and a null one mean different things on the way back in, and the
 * difference between `repo_url` unset and `repo_url` empty is the sort of thing a
 * dispute turns on.
 */
function encodeRow(columns: readonly ColumnInfo[], row: Row, table: string): string {
  const ordered: Row = {};
  for (const column of columns) {
    const value = row[column.name];
    if (value === undefined) {
      throw new DatabaseError(
        "archive.row",
        `${table}.${column.name} was selected but came back undefined`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      // Reachable only through a column that already violates STRICT, but the failure
      // this prevents is silent: JSON turns an infinity into `null`, which imports as
      // a missing value on a column that was not null.
      throw new DatabaseError(
        "archive.row",
        `${table}.${column.name} holds ${String(value)}, which JSON cannot carry`,
      );
    }
    ordered[column.name] = value;
  }
  return JSON.stringify(ordered);
}

/**
 * Write every table to `dir` as `<table>.jsonl`, plus the manifest.
 *
 * A table with no rows gets a file with no bytes rather than no file, so the file list
 * is the table list and a missing file is always an error. The database should be open
 * read-only — `openReadOnly` exists for this — and the export runs inside one read
 * transaction. Without that transaction, separate table reads can describe different
 * moments while a judge is submitting, producing an archive that never existed.
 */
export function exportArchive(db: Db, dir: string): Manifest {
  assertTables(db);
  assertOrder(db);
  mkdirSync(dir, { recursive: true });
  db.raw.exec("begin");
  try {
    const files: ArchiveFile[] = [];
    let total = 0;
    for (const table of ARCHIVE_TABLES) {
      const columns = columnsOf(db, table);
      const names = columns.map((c) => quote(c.name)).join(", ");
      const rows = db.all<Row>(`select ${names} from ${quote(table)} order by ${orderOf(db, table, columns)}`);
      const text = rows.map((row) => `${encodeRow(columns, row, table)}\n`).join("");
      writeFileSync(join(dir, `${table}.jsonl`), text, "utf8");
      files.push({ name: table, rows: rows.length, bytes: Buffer.byteLength(text, "utf8"), sha256: digest(text) });
      total += rows.length;
    }
    const manifest: Manifest = {
      format: ARCHIVE_FORMAT,
      schema: appliedMigrations(db).map((m) => ({ id: m.id, sha256: m.sha256 })),
      tables: files,
      notExported: NOT_EXPORTED,
      head: headHash(db),
      rows: total,
    };
    writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    db.raw.exec("commit");
    return manifest;
  } catch (error) {
    try { db.raw.exec("rollback"); } catch { /* preserve the export error */ }
    throw error;
  }
}

/**
 * Read and structurally check the manifest of an archive.
 *
 * Separated from the import so a tool can print what an archive contains — and refuse
 * a directory that is not one — without opening a database.
 */
export function readManifest(dir: string): Manifest {
  let text: string;
  try {
    text = readFileSync(join(dir, MANIFEST), "utf8");
  } catch {
    const near = (() => {
      try {
        return readdirSync(dir).slice(0, 6).join(", ") || "an empty directory";
      } catch {
        return "a directory that does not exist";
      }
    })();
    throw new DatabaseError(
      "archive.manifest",
      `${join(dir, MANIFEST)} is not readable, so this is not an archive. Found: ${near}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DatabaseError(
      "archive.manifest",
      `${MANIFEST} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parsed as Manifest;
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.tables)) {
    throw new DatabaseError("archive.manifest", `${MANIFEST} has no table list`);
  }
  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new DatabaseError(
      "archive.format",
      `this archive is format ${String(manifest.format)} and this build reads ` +
        `${ARCHIVE_FORMAT}. Import it with the version of Manak that wrote it.`,
    );
  }
  const names = manifest.tables.map((t) => t.name).join(",");
  if (names !== ARCHIVE_TABLES.join(",")) {
    throw new DatabaseError(
      "archive.tableSet",
      `the archive lists ${names || "no tables"}, and this build expects ` +
        `${ARCHIVE_TABLES.join(",")}. A table added or removed since this archive was written ` +
        `is a schema change, and schema changes are refused rather than guessed at.`,
    );
  }
  return manifest;
}

/** One line of a `.jsonl`, checked against the columns it claims to fill. */
function decodeRow(
  columns: readonly ColumnInfo[],
  line: string,
  table: string,
  lineNumber: number,
): Param[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new DatabaseError(
      "archive.row",
      `${table}.jsonl line ${lineNumber} is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DatabaseError(
      "archive.row",
      `${table}.jsonl line ${lineNumber} is not an object`,
    );
  }
  const row = parsed as Record<string, unknown>;
  const extra = Object.keys(row).filter((key) => !columns.some((c) => c.name === key));
  if (extra.length > 0) {
    throw new DatabaseError(
      "archive.row",
      `${table}.jsonl line ${lineNumber} carries ${extra.join(", ")}, which ${table} does not ` +
        `have. This archive was written against a different schema.`,
    );
  }
  return columns.map((column) => {
    const value = row[column.name];
    if (value === undefined) {
      throw new DatabaseError(
        "archive.row",
        `${table}.jsonl line ${lineNumber} has no ${column.name}. A null is written as null, so ` +
          `an absent key is a truncated row rather than an empty value.`,
      );
    }
    if (value === null || typeof value === "string" || typeof value === "number") return value;
    throw new DatabaseError(
      "archive.row",
      `${table}.jsonl line ${lineNumber} gives ${column.name} as a ${typeof value}, and every ` +
        `column in this schema is text, integer or real`,
    );
  });
}

/**
 * Load an archive into a migrated, empty database.
 *
 * Three refusals, in this order, and each is a thing that would otherwise be found out
 * later: an archive whose format or table list this build does not read, an archive
 * written against a different set of migrations, and a target that already holds rows.
 * The third is the seed's rule for the same reason — reconciling two datasets is a
 * decision a tool should not make on somebody's event — and it is checked over the
 * archive's own tables, since `migration` is populated by then and always will be.
 *
 * Then one transaction. Every table, in order, with the digests checked before a single
 * row is parsed, and the ledger chain verified before the commit: an archive that lost
 * a ledger row or altered a payload cannot be committed, because the hash chain is a
 * checksum over the nine columns of the table that matters most and it is cheaper to
 * check than to explain. A failure anywhere rolls the whole thing back, so the outcome
 * is the archive or the empty database and never half of each.
 *
 * Foreign keys are left on throughout — the usual restore trick of disabling them is
 * not available inside a transaction anyway, which is the same limitation the migration
 * runner documents — so `ARCHIVE_TABLES` being a parents-first order is load-bearing
 * rather than tidy. `assertOrder` proves it against the live schema on the way out.
 */
export function importArchive(db: Db, dir: string): ImportResult {
  const manifest = readManifest(dir);
  assertTables(db);

  const applied = appliedMigrations(db)
    .map((m) => `${m.id}@${m.sha256}`)
    .join(",");
  const wanted = manifest.schema.map((m) => `${m.id}@${m.sha256}`).join(",");
  if (applied !== wanted) {
    throw new DatabaseError(
      "archive.schema",
      `this archive was written from ${wanted || "no migrations"} and this database has ` +
        `${applied || "none"} applied. An import that ignored the difference would fill the ` +
        `columns both versions share and leave the rest at their defaults, which is a database ` +
        `that is wrong rather than one that is empty. Import into the build that wrote it.`,
    );
  }

  const occupied = ARCHIVE_TABLES.map((table) => ({
    table,
    rows: db.one<{ n: number }>(`select count(*) as n from ${quote(table)}`).n,
  })).filter((entry) => entry.rows > 0);
  if (occupied.length > 0) {
    throw new DatabaseError(
      "archive.notEmpty",
      `refusing to import into a database that already holds ` +
        `${occupied.map((e) => `${e.rows} ${e.table}`).join(", ")}. Merging two deployments is a ` +
        `decision this tool will not make for you; import into an empty database and move what ` +
        `you meant to keep.`,
    );
  }

  // Every file is read and checked before a transaction is opened, so a truncated
  // archive fails without having touched the database at all.
  const loaded = manifest.tables.map((file) => {
    const path = join(dir, `${file.name}.jsonl`);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new DatabaseError(
        "archive.missing",
        `${file.name}.jsonl is missing. A table with no rows is written as a file with no ` +
          `bytes, so an absent file is an incomplete archive rather than an empty table.`,
      );
    }
    const found = digest(text);
    if (found !== file.sha256) {
      throw new DatabaseError(
        "archive.digest",
        `${file.name}.jsonl hashes to ${found.slice(0, 12)} and the manifest says ` +
          `${file.sha256.slice(0, 12)}. The usual causes, in order of likelihood: the archive ` +
          `was truncated in transit, it was edited by hand, or a checkout rewrote its line ` +
          `endings to CRLF. Manak writes LF.`,
      );
    }
    const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
    if (lines.length !== file.rows) {
      throw new DatabaseError(
        "archive.count",
        `${file.name}.jsonl holds ${lines.length} lines and the manifest claims ${file.rows}`,
      );
    }
    return { name: file.name, lines };
  });

  return db.tx(() => {
    let total = 0;
    for (const file of loaded) {
      const columns = columnsOf(db, file.name);
      const sql = `insert into ${quote(file.name)} (${columns
        .map((c) => quote(c.name))
        .join(", ")}) values (${columns.map(() => "?").join(", ")})`;
      for (const [index, line] of file.lines.entries()) {
        db.run(sql, decodeRow(columns, line, file.name, index + 1));
      }
      total += file.lines.length;
    }
    if (total !== manifest.rows) {
      throw new DatabaseError(
        "archive.count",
        `inserted ${total} rows and the manifest totals ${manifest.rows}`,
      );
    }

    const breaks = verifyLedger(db);
    if (breaks.length > 0) {
      throw new DatabaseError(
        "archive.ledger",
        `the imported ledger does not verify: ${breaks
          .slice(0, 3)
          .map((b) => b.detail)
          .join("; ")}${breaks.length > 3 ? `, and ${breaks.length - 3} more` : ""}. Nothing was ` +
          `committed.`,
      );
    }
    const head = headHash(db);
    if (head !== manifest.head) {
      throw new DatabaseError(
        "archive.ledger",
        `the imported ledger heads at ${head.slice(0, 12)} and the manifest recorded ` +
          `${manifest.head.slice(0, 12)}. Nothing was committed.`,
      );
    }
    return { tables: loaded.length, rows: total, head };
  });
}
