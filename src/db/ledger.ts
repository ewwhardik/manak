/**
 * The audit ledger.
 *
 * Every state change an organizer or judge makes is appended here, and every entry
 * carries the hash of the one before it. Removing an entry, reordering two, or
 * editing a payload therefore breaks the chain from that point to the end, and
 * `verifyLedger` finds the exact row where it broke.
 *
 * What this does and does not prove is worth being precise about, because
 * "tamper-proof" is a claim this design does not support. Anyone who can write to
 * the database can also recompute the whole chain forward from their edit; a hash
 * chain in the same file as the data it describes detects *accidents and careless
 * tampering*, not a determined administrator. What it does give is a single number
 * — the head hash — that can be written down, printed in a results page, or read
 * out at a prize ceremony, after which no earlier entry can be changed without the
 * published number changing too. That is the property worth having at a hackathon:
 * an organizer can commit to the audit trail before the appeals start.
 *
 * The hashed form is deliberately re-derivable by hand:
 *
 *     hash = sha256(JSON.stringify([prev, seq, at, event, actor, action, subject, payload]))
 *
 * A JSON array rather than a delimiter-joined string, because `action`, `subject`
 * and `payload` are arbitrary text and any separator character could appear inside
 * them — which is how a chain gets two different entry sets that hash the same.
 * Payloads are canonicalized with sorted keys so that re-serializing an entry
 * during export produces the same bytes it was hashed as.
 */

import { createHash } from "node:crypto";

import type { Db } from "./open.ts";
import { DatabaseError } from "./open.ts";

/** The `prev_hash` of the first entry. 64 zeros, so the CHECK on the column holds. */
export const GENESIS = "0".repeat(64);

export type LedgerEntry = {
  seq: number;
  at: number;
  event_id: string | null;
  actor_id: string | null;
  action: string;
  subject: string;
  payload: string;
  prev_hash: string;
  hash: string;
};

export type LedgerAppend = {
  /** Dotted lower-case, e.g. `ballot.submitted`. The schema enforces the shape. */
  action: string;
  /** Null for a deployment-wide action such as creating an account. */
  eventId?: string | null;
  /** The account that did it; null for the system, e.g. a scheduled sweep. */
  actorId?: string | null;
  /** The id of the thing acted on. Empty when the action has no single subject. */
  subject?: string;
  payload?: Readonly<Record<string, unknown>>;
};

/**
 * JSON with object keys in sorted order, recursively.
 *
 * `JSON.stringify` preserves insertion order, so two payloads with the same
 * meaning and different key order would hash differently — and then an export that
 * rebuilt the object from a query would fail to reproduce its own hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DatabaseError(
        "ledger.payload",
        `a ledger payload cannot hold ${String(value)}: JSON turns it into null, which would ` +
          `make the entry unreadable while still hashing cleanly`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new DatabaseError(
    "ledger.payload",
    `a ledger payload cannot hold a ${typeof value}`,
  );
}

/** The hash of one entry, given the hash of the one before it. */
export function entryHash(entry: Omit<LedgerEntry, "hash">): string {
  const canonical = JSON.stringify([
    entry.prev_hash,
    entry.seq,
    entry.at,
    entry.event_id,
    entry.actor_id,
    entry.action,
    entry.subject,
    entry.payload,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The current head of the chain, or `GENESIS` for an empty ledger. */
export function headHash(db: Db): string {
  const row = db.get<{ hash: string }>("select hash from ledger order by seq desc limit 1");
  return row?.hash ?? GENESIS;
}

export function ledgerLength(db: Db): number {
  return db.one<{ n: number }>("select count(*) as n from ledger").n;
}

/**
 * Append one entry and return it.
 *
 * Always runs inside a transaction. The sequence number is read rather than left to
 * AUTOINCREMENT because the hash covers it, and reading the previous head and
 * writing the next entry have to be one atomic step — `begin immediate` takes the
 * write lock up front, so a second writer cannot land between them and produce two
 * entries claiming the same predecessor.
 */
export function appendLedger(db: Db, at: number, append: LedgerAppend): LedgerEntry {
  return db.tx(() => {
    const previous = db.get<{ seq: number; hash: string }>(
      "select seq, hash from ledger order by seq desc limit 1",
    );
    const entry: Omit<LedgerEntry, "hash"> = {
      seq: (previous?.seq ?? 0) + 1,
      at,
      event_id: append.eventId ?? null,
      actor_id: append.actorId ?? null,
      action: append.action,
      subject: append.subject ?? "",
      payload: canonicalJson(append.payload ?? {}),
      prev_hash: previous?.hash ?? GENESIS,
    };
    const hash = entryHash(entry);
    db.run(
      `insert into ledger (seq, at, event_id, actor_id, action, subject, payload, prev_hash, hash)
       values (:seq, :at, :event_id, :actor_id, :action, :subject, :payload, :prev_hash, :hash)`,
      { ...entry, hash },
    );
    return { ...entry, hash };
  });
}

export type LedgerBreak = {
  seq: number;
  reason: "sequence" | "link" | "hash";
  detail: string;
};

/**
 * Walk the whole chain and report every break.
 *
 * Verification is global, not per event, and that is not an oversight: one chain
 * covers the deployment, so an entry deleted from event A invalidates every later
 * entry including event B's. A per-event verification would report event B as
 * sound while its hashes no longer follow from anything, which is worse than no
 * verification at all because it is reassuring.
 *
 * Reads in batches so a long-running event does not need the entire ledger
 * resident to be checked.
 */
export function verifyLedger(db: Db, batchSize = 1000): LedgerBreak[] {
  const breaks: LedgerBreak[] = [];
  let previousHash = GENESIS;
  let expectedSeq = 1;
  let after = 0;
  for (;;) {
    const rows = db.all<LedgerEntry>(
      `select seq, at, event_id, actor_id, action, subject, payload, prev_hash, hash
         from ledger where seq > :after order by seq limit :limit`,
      { after, limit: batchSize },
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        breaks.push({
          seq: row.seq,
          reason: "sequence",
          detail: `expected sequence number ${expectedSeq}, found ${row.seq}: ${
            row.seq > expectedSeq ? "entries are missing" : "entries are out of order"
          }`,
        });
        expectedSeq = row.seq;
      }
      if (row.prev_hash !== previousHash) {
        breaks.push({
          seq: row.seq,
          reason: "link",
          detail: `entry ${row.seq} follows ${row.prev_hash.slice(0, 12)} but the previous ` +
            `entry hashes to ${previousHash.slice(0, 12)}`,
        });
      }
      const recomputed = entryHash({ ...row, prev_hash: row.prev_hash });
      if (recomputed !== row.hash) {
        breaks.push({
          seq: row.seq,
          reason: "hash",
          detail: `entry ${row.seq} stores ${row.hash.slice(0, 12)} but its contents hash to ` +
            `${recomputed.slice(0, 12)}: this row was edited after it was written`,
        });
      }
      // Chain forward on the stored hash, not the recomputed one. Otherwise a
      // single edited row reports as one break and everything after it as fine,
      // which understates the damage.
      previousHash = row.hash;
      expectedSeq = row.seq + 1;
      after = row.seq;
    }
  }
  return breaks;
}

/** Entries for one event, newest first. The organizer's activity feed. */
export function readLedger(
  db: Db,
  options: { eventId?: string | null; subject?: string; limit?: number; before?: number } = {},
): LedgerEntry[] {
  const where: string[] = [];
  const params: Record<string, string | number | null> = {
    limit: Math.min(Math.max(options.limit ?? 100, 1), 1000),
    before: options.before ?? Number.MAX_SAFE_INTEGER,
  };
  if (options.eventId !== undefined) {
    where.push(options.eventId === null ? "event_id is null" : "event_id = :event_id");
    if (options.eventId !== null) params.event_id = options.eventId;
  }
  if (options.subject !== undefined) {
    where.push("subject = :subject");
    params.subject = options.subject;
  }
  where.push("seq < :before");
  return db.all<LedgerEntry>(
    `select seq, at, event_id, actor_id, action, subject, payload, prev_hash, hash
       from ledger where ${where.join(" and ")} order by seq desc limit :limit`,
    params,
  );
}
