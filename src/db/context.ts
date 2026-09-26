/**
 * The write context: a database handle, a clock, an id generator, and whoever is
 * responsible for what is about to happen.
 *
 * The reason this exists rather than passing four arguments everywhere is a single
 * invariant it makes structural: **no write reaches the database without an audit
 * entry describing it.** Repository code cannot call `db.run` — it calls
 * `ctx.write`, which throws unless it is inside a `recorded()` scope. That scope
 * opens a transaction, runs the mutation, and appends the ledger entry, so the row
 * and the record of the row commit together or not at all.
 *
 * There is one escape hatch, `ctx.unaudited`, and it takes a mandatory reason.
 * Three kinds of write genuinely do not belong in an audit trail: rate-limit
 * counters, session liveness touches, and sweeps of expired rows. Left unaudited
 * they are invisible; audited they would be most of the ledger, and an activity
 * feed nobody can read is not oversight. Every call site is enumerated by
 * `tests/db.test.ts`, so a fourth one is a deliberate change to a test rather than
 * a line that slipped in.
 */

import type { Db } from "./open.ts";
import { DatabaseError } from "./open.ts";
import type { Params } from "./open.ts";
import type { LedgerAppend, LedgerEntry } from "./ledger.ts";
import { appendLedger } from "./ledger.ts";
import { makeIds } from "./ids.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

export type Ctx = {
  readonly db: Db;
  /** Current instant in epoch milliseconds. Never `Date.now()` at a call site. */
  readonly now: () => number;
  readonly newId: () => string;
  /** The account responsible; null for system actions such as a scheduled sweep. */
  readonly actorId: string | null;
  /** Mutate. Refuses outside a `recorded` or `unaudited` scope. */
  readonly write: (sql: string, params?: Params) => { changes: number };
  /** Same context, different actor. Used when a request's identity is resolved. */
  readonly as: (actorId: string | null) => Ctx;
  readonly unaudited: <T>(reason: UnauditedReason, body: () => T) => T;
  readonly recorded: <T>(entry: LedgerAppend, body: () => T) => T;
  /** The entries appended so far in this process. Diagnostic, not persisted. */
  readonly appended: () => readonly LedgerEntry[];
};

/**
 * The complete list of things allowed to bypass the audit trail. Adding a member
 * is a visible change: `tests/db.test.ts` asserts on this exact set.
 */
export const UNAUDITED_REASONS = [
  "rate-limit counter",
  "session liveness",
  "expiry sweep",
] as const;
export type UnauditedReason = (typeof UNAUDITED_REASONS)[number];

export type ContextOptions = {
  clock?: Clock;
  newId?: () => string;
  actorId?: string | null;
};

export function makeContext(db: Db, options: ContextOptions = {}): Ctx {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? makeIds(clock.now);
  const appended: LedgerEntry[] = [];
  let permitted = 0;

  const build = (actorId: string | null): Ctx => {
    const ctx: Ctx = {
      db,
      now: clock.now,
      newId,
      actorId,
      write: (sql, params) => {
        if (permitted === 0) {
          throw new DatabaseError(
            "ctx.unaudited",
            `refusing an unaudited write. Wrap it in ctx.recorded({ action: ... }) so the ` +
              `ledger explains it, or in ctx.unaudited(reason) if it is bookkeeping:\n  ${
                sql.trim().split("\n")[0]
              }`,
          );
        }
        return { changes: db.run(sql, params).changes };
      },
      as: (next) => build(next),
      unaudited: (reason, body) => {
        if (!UNAUDITED_REASONS.includes(reason)) {
          throw new DatabaseError("ctx.reason", `not an allowed unaudited reason: ${reason}`);
        }
        permitted += 1;
        try {
          return body();
        } finally {
          permitted -= 1;
        }
      },
      recorded: (entry, body) =>
        db.tx(() => {
          permitted += 1;
          let value: ReturnType<typeof body>;
          try {
            value = body();
          } finally {
            permitted -= 1;
          }
          // Appended after the body so the entry describes work that succeeded,
          // and inside the transaction so it cannot describe work that did not.
          appended.push(
            appendLedger(db, clock.now(), {
              ...entry,
              actorId: entry.actorId ?? actorId,
            }),
          );
          return value;
        }),
      appended: () => appended,
    };
    return ctx;
  };

  return build(options.actorId ?? null);
}

/**
 * A domain rule was broken — a deadline missed, a role missing, a score out of
 * range. Distinct from `DatabaseError`, which means the storage layer itself said
 * no, because the two map to different HTTP statuses and different copy.
 */
export class RuleError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "RuleError";
    this.code = code;
    this.detail = detail;
  }
}
