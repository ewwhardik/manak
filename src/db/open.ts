/**
 * Opening a database, and the small typed surface everything else uses.
 *
 * `node:sqlite` is a thin binding: it gives you `prepare`, `run`, `get`, `all` and
 * nothing about connection settings, transactions or statement reuse. Those are
 * decided once here, because each of them is a correctness question rather than a
 * preference.
 *
 * **Pragmas.** `foreign_keys` is off by default in SQLite, which means every
 * composite key in `001_init.sql` would be decoration. It is set here and then
 * asserted, because a pragma silently ignored is worse than one that was never
 * written. WAL is set so a long-running read — an organizer refreshing a dashboard
 * — never blocks a judge submitting a ballot. `synchronous = normal` is the
 * documented WAL pairing: durable across a process crash, and able to lose the
 * last transactions only if the machine loses power. For a hackathon whose whole
 * state can be re-exported that is the right end of the trade; an operator who
 * disagrees sets `synchronous = full` and pays about an fsync per commit.
 *
 * **Statement caching.** Every query in this codebase is a literal, so a statement
 * cache keyed on the SQL text is both safe and worth having: the ballot insert
 * path prepares four statements per submission otherwise.
 *
 * **Transactions.** Nested calls share one transaction through savepoints, so a
 * repository method that writes a row and appends a ledger entry composes with a
 * caller that wraps ten of them, and either everything lands or nothing does.
 */

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

/** What a statement may be given. `null` is distinct from absent. */
export type Param = string | number | bigint | null | Uint8Array;
export type Params = readonly Param[] | Readonly<Record<string, Param>>;

export type Db = {
  /** The underlying handle. Reach for it only in migrations and diagnostics. */
  readonly raw: DatabaseSync;
  /** Where this database lives; `:memory:` for a temporary one. */
  readonly path: string;
  all: <T>(sql: string, params?: Params) => T[];
  get: <T>(sql: string, params?: Params) => T | undefined;
  /** Like `get`, but a missing row is a programming error rather than a `null`. */
  one: <T>(sql: string, params?: Params) => T;
  run: (sql: string, params?: Params) => { changes: number; lastInsertRowid: number };
  exec: (sql: string) => void;
  /** Run `body` in a transaction, or in the caller's if one is already open. */
  tx: <T>(body: () => T) => T;
  /** True while a transaction is open. Used by writes that must not run alone. */
  inTransaction: () => boolean;
  close: () => void;
};

export type OpenOptions = {
  /** Skip WAL and the tuning pragmas. Set for `:memory:`, where WAL is a no-op. */
  readonly journal?: "wal" | "default";
  /** Milliseconds to wait on a locked database before giving up. */
  readonly busyTimeout?: number;
  readonly readOnly?: boolean;
};

export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const memory = path === ":memory:";
  const raw = new DatabaseSync(path, { readOnly: options.readOnly === true });

  // Order matters. `foreign_keys` and `journal_mode` are both refused inside a
  // transaction, and nothing has opened one yet at this point.
  raw.exec(`pragma busy_timeout = ${Math.trunc(options.busyTimeout ?? 5000)}`);
  if (!options.readOnly) raw.exec("pragma foreign_keys = on");
  const enforcing = raw.prepare("pragma foreign_keys").get() as { foreign_keys?: number };
  if (!options.readOnly && enforcing?.foreign_keys !== 1) {
    throw new DatabaseError(
      "db.foreignKeys",
      "SQLite refused `pragma foreign_keys = on`, so every composite key in the " +
        "schema is decoration. Refusing to run rather than enforcing nothing.",
    );
  }
  if ((options.journal ?? (memory ? "default" : "wal")) === "wal") {
    raw.exec("pragma journal_mode = wal");
    raw.exec("pragma synchronous = normal");
  }
  if (!memory) raw.exec("pragma cache_size = -8000");
  // Disallows a function marked unsafe from being reached through a view, trigger
  // or index expression. Manak's schema only uses innocuous ones, so this costs
  // nothing and closes the door on a schema-injection route into the process.
  raw.exec("pragma trusted_schema = off");

  const cache = new Map<string, StatementSync>();
  let closed = false;
  let depth = 0;

  const prepare = (sql: string): StatementSync => {
    if (closed) throw new DatabaseError("db.closed", "the database is closed");
    const hit = cache.get(sql);
    if (hit) return hit;
    const statement = raw.prepare(sql);
    // Repositories pass plain objects, so `{ id }` binds to `:id` without the
    // caller having to write the prefix at every call site.
    statement.setAllowBareNamedParameters(true);
    cache.set(sql, statement);
    return statement;
  };

  // Keep named and positional overloads distinct so the compiler can check bindings.
  const query = (sql: string, mode: "all" | "get" | "run", params?: Params) => {
    const statement = prepare(sql);
    if (params === undefined) return statement[mode]();
    if (Array.isArray(params)) return statement[mode](...(params as Param[]));
    return statement[mode](params as Readonly<Record<string, Param>>);
  };

  const db: Db = {
    raw,
    path,
    all: <T>(sql: string, params?: Params): T[] =>
      query(sql, "all", params) as T[],
    get: <T>(sql: string, params?: Params): T | undefined =>
      query(sql, "get", params) as T | undefined,
    one: <T>(sql: string, params?: Params): T => {
      const row = query(sql, "get", params) as T | undefined;
      if (row === undefined) {
        throw new DatabaseError("db.missing", `expected a row from: ${sql}`);
      }
      return row;
    },
    run: (sql: string, params?: Params) => {
      const result = query(sql, "run", params) as { changes: number | bigint; lastInsertRowid: number | bigint };
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    exec: (sql: string) => {
      if (closed) throw new DatabaseError("db.closed", "the database is closed");
      raw.exec(sql);
    },
    inTransaction: () => depth > 0,
    tx: <T>(body: () => T): T => {
      // A savepoint rather than a nested `begin`, which SQLite rejects. The name
      // carries the depth so an inner rollback releases only its own work.
      const name = `manak_${depth}`;
      const begin = depth === 0 ? "begin immediate" : `savepoint ${name}`;
      const commit = depth === 0 ? "commit" : `release ${name}`;
      const undo = depth === 0 ? "rollback" : `rollback to ${name}`;
      raw.exec(begin);
      depth += 1;
      try {
        const value = body();
        depth -= 1;
        raw.exec(commit);
        return value;
      } catch (error) {
        depth -= 1;
        try {
          raw.exec(undo);
          // An inner savepoint has to be released after rolling back to it, or
          // it stays on the stack and the outer commit reports a stray savepoint.
          if (depth > 0) raw.exec(`release ${name}`);
        } catch {
          // The rollback itself failing means the connection is unusable; the
          // original error is the one worth propagating, so this is swallowed.
        }
        throw error;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      // `optimize` writes back any statistics gathered this session so the next
      // process plans queries against real row counts. Cheap, and skipped on a
      // read-only handle, which cannot write them.
      try {
        if (!options.readOnly) {
          raw.exec("pragma analysis_limit = 400");
          raw.exec("pragma optimize");
        }
      } catch {
        // A failure here loses a planning hint and nothing else.
      }
      cache.clear();
      raw.close();
    },
  };
  return db;
}

/**
 * Open a database purely to read it.
 *
 * Used by the export path and by `--check` style tools, where opening read-only is
 * a statement that the tool cannot be the thing that corrupted what it inspected.
 */
export function openReadOnly(path: string): Db {
  return openDatabase(path, { readOnly: true, journal: "default" });
}

/** SQLite's own integrity check, plus the foreign key sweep it does not include. */
export function checkIntegrity(db: Db): string[] {
  const problems: string[] = [];
  for (const row of db.all<{ integrity_check: string }>("pragma integrity_check")) {
    if (row.integrity_check !== "ok") problems.push(row.integrity_check);
  }
  for (const row of db.all<{ table: string; rowid: number | null; parent: string }>(
    "pragma foreign_key_check",
  )) {
    problems.push(`${row.table} row ${row.rowid ?? "?"} has no parent in ${row.parent}`);
  }
  return problems;
}
