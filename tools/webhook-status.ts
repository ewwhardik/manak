/** Read-only status for the durable webhook worker. No secret or payload is printed. */
import { existsSync, readFileSync } from "node:fs";
import { openReadOnly } from "../src/db/index.ts";

const database = process.env.MANAK_DATABASE?.trim() || "./data/manak.db";
const checkpoint = process.env.MANAK_WEBHOOK_CHECKPOINT?.trim() || `${database}.webhook.json`;
const event = process.env.MANAK_WEBHOOK_EVENT?.trim();
if (!event) throw new Error("Set MANAK_WEBHOOK_EVENT to the configured event ID.");
const db = openReadOnly(database);
try {
  const cursor = existsSync(checkpoint)
    ? JSON.parse(readFileSync(checkpoint, "utf8")) as { seq: number; hash: string }
    : { seq: 0, hash: "" };
  const status = existsSync(`${checkpoint}.status.json`)
    ? JSON.parse(readFileSync(`${checkpoint}.status.json`, "utf8")) as {
      lastAttemptAt: number | null; lastSuccessAt: number | null;
      lastError: string | null; consecutiveFailures: number }
    : { lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 };
  const pending = db.one<{ count: number; latest: number | null }>(
    "select count(*) as count, max(seq) as latest from ledger where event_id = :event and seq > :seq",
    { event, seq: cursor.seq });
  if (cursor.seq > 0 && db.get<{ hash: string }>("select hash from ledger where seq = :seq", { seq: cursor.seq })?.hash !== cursor.hash)
    throw new Error("The checkpoint hash does not match this database ledger.");
  process.stdout.write(JSON.stringify({ event, deliveredThrough: cursor.seq, pending: pending.count,
    latestPendingSequence: pending.latest, ...status }, null, 2) + "\n");
} finally { db.close(); }
