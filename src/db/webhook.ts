import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./open.ts";
import type { LedgerEntry } from "./ledger.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { sendPinnedWebhook } from "./webhook-transport.ts";

export type WebhookConfig = {
  id: string;
  eventId?: string;
  url: string;
  secret: string;
  actions?: readonly string[];
  active: boolean;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  url: string;
  action: string;
  payload: string;
  attempts: number;
  status: "queued" | "delivered" | "failed";
  statusCode?: number;
  lastError?: string;
  createdAt: number;
  deliveredAt?: number;
};

export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export type WebhookSender = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; ok: boolean; error?: string }>;

export class WebhookDispatcher {
  private subscribers: Map<string, WebhookConfig> = new Map();
  private deliveries: WebhookDelivery[] = [];
  private sender?: WebhookSender;
  private clock: Clock;

  constructor(options?: { sender?: WebhookSender; clock?: Clock }) {
    this.sender = options?.sender;
    this.clock = options?.clock ?? systemClock;
  }

  register(config: Omit<WebhookConfig, "id"> & { id?: string }): WebhookConfig {
    const id = config.id ?? randomBytes(16).toString("hex");
    const sub: WebhookConfig = { ...config, id };
    this.subscribers.set(id, sub);
    return sub;
  }

  unregister(id: string): boolean {
    return this.subscribers.delete(id);
  }

  list(): WebhookConfig[] {
    return Array.from(this.subscribers.values());
  }

  deliveryLog(webhookId?: string): readonly WebhookDelivery[] {
    if (webhookId) {
      return this.deliveries.filter((d) => d.webhookId === webhookId);
    }
    return this.deliveries;
  }

  async dispatch(
    event: { eventId?: string; action: string; subject?: string | null; payload: unknown },
    now?: number,
  ): Promise<WebhookDelivery[]> {
    const at = now ?? this.clock.now();
    const serialized = JSON.stringify({
      event: event.eventId ?? null,
      action: event.action,
      subject: event.subject ?? null,
      payload: event.payload,
      timestamp: at,
    });

    const activeMatches: WebhookConfig[] = [];
    for (const sub of this.subscribers.values()) {
      if (!sub.active) continue;
      if (sub.eventId && sub.eventId !== event.eventId) continue;
      if (sub.actions && !sub.actions.includes("*") && !sub.actions.includes(event.action)) continue;
      activeMatches.push(sub);
    }

    const created: WebhookDelivery[] = [];
    for (const sub of activeMatches) {
      const delivery: WebhookDelivery = {
        id: randomBytes(16).toString("hex"),
        webhookId: sub.id,
        url: sub.url,
        action: event.action,
        payload: serialized,
        attempts: 0,
        status: "queued",
        createdAt: at,
      };
      this.deliveries.push(delivery);
      created.push(delivery);

      if (this.sender) {
        await this.deliverWithRetry(delivery, sub.secret);
      }
    }

    return created;
  }

  private async deliverWithRetry(delivery: WebhookDelivery, secret: string): Promise<void> {
    const maxAttempts = 3;
    const signature = signWebhookPayload(delivery.payload, secret);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Manak-Signature": `sha256=${signature}`,
      "X-Manak-Event": delivery.action,
      "X-Manak-Delivery": delivery.id,
    };

    while (delivery.attempts < maxAttempts) {
      delivery.attempts += 1;
      try {
        if (!this.sender) break;
        const res = await this.sender(delivery.url, headers, delivery.payload);
        delivery.statusCode = res.status;
        if (res.ok) {
          delivery.status = "delivered";
          delivery.deliveredAt = this.clock.now();
          return;
        }
        delivery.lastError = res.error ?? `HTTP ${res.status}`;
      } catch (err) {
        delivery.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    delivery.status = "failed";
  }
}

/** Durable, ordered, at-least-once notifications from the transactionally written ledger.
 * One deployment-owned HTTPS receiver, scoped to one event. State survives process restarts.
 * The receiver uses its separately authorized API credentials to retrieve changed records.
 */
export function ledgerWebhook(options: {
  db: Db; eventId: string; url: string; secret: string; checkpoint: string;
  send?: typeof fetch;
  clock?: Clock;
}) {
  const { db, eventId, secret, checkpoint } = options;
  const clock = options.clock ?? systemClock;
  const url = new URL(options.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || secret.length < 32) {
    throw new Error("Webhook needs a credential-free HTTPS URL and a secret of at least 32 characters.");
  }
  if (!db.get("select id from event where id = :id", { id: eventId })) throw new Error("Webhook event ID does not exist.");
  const destination = createHash("sha256").update(JSON.stringify([url.href, eventId])).digest("hex");
  let cursor = { seq: 0, hash: "", destination };
  if (existsSync(checkpoint)) {
    const saved = JSON.parse(readFileSync(checkpoint, "utf8")) as typeof cursor;
    if (!Number.isSafeInteger(saved.seq) || saved.seq < 0 || saved.destination !== destination) {
      throw new Error("Webhook checkpoint does not match its destination. Use a separate checkpoint for a new subscription.");
    }
    if (saved.seq > 0 && db.get<{ hash: string }>("select hash from ledger where seq = :seq", { seq: saved.seq })?.hash !== saved.hash) {
      throw new Error("Webhook checkpoint does not match this ledger. Restore a matching checkpoint or explicitly replay with a new path.");
    }
    cursor = saved;
  }
  // Import the legacy checkpoint once; SQLite is authoritative thereafter.
  db.tx(() => {
    db.run("insert or ignore into webhook_subscription(destination, event_id, cursor, cursor_hash) values (:destination, :event, :seq, :hash)",
      { destination, event: eventId, seq: cursor.seq, hash: cursor.hash });
    const stored = db.one<{ cursor: number; cursor_hash: string }>("select cursor, cursor_hash from webhook_subscription where destination = :destination", { destination });
    cursor = { seq: stored.cursor, hash: stored.cursor_hash, destination };
    db.run(`insert or ignore into webhook_delivery(destination, sequence)
      select :destination, seq from ledger where event_id = :event and seq > :seq`,
      { destination, event: eventId, seq: cursor.seq });
  });
  let busy = false;
  const statusPath = `${checkpoint}.status.json`;
  type Status = { cursor: number; lastAttemptAt: number | null; lastSuccessAt: number | null;
    lastError: string | null; consecutiveFailures: number };
  let status: Status = { cursor: cursor.seq, lastAttemptAt: null, lastSuccessAt: null,
    lastError: null, consecutiveFailures: 0 };
  if (existsSync(statusPath)) {
    try {
      const saved = JSON.parse(readFileSync(statusPath, "utf8")) as Status;
      if (Number.isSafeInteger(saved.cursor) && saved.cursor <= cursor.seq) status = { ...saved, cursor: cursor.seq };
    } catch { /* The cursor remains authoritative; a status display can be rebuilt. */ }
  }
  const saveStatus = () => {
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(`${statusPath}.tmp`, JSON.stringify(status) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(`${statusPath}.tmp`, statusPath);
  };
  return {
    position: () => cursor.seq,
    status: () => ({ ...status }),
    async flush(): Promise<number> {
      if (db.inTransaction()) throw new Error("Webhook delivery must run after the database transaction commits.");
      if (busy) return 0;
      busy = true;
      let delivered = 0;
      status.lastAttemptAt = clock.now();
      try {
        const rows = db.all<LedgerEntry>(`select l.* from ledger l join webhook_delivery d on d.sequence = l.seq
          where d.destination = :destination and d.status = 'queued' order by l.seq limit 25`, { destination });
        for (const row of rows) {
          const id = `${row.seq}-${row.hash}`;
          // Omit private payloads, actors and subject identifiers (which may contain an email).
          const body = JSON.stringify({ id, sequence: row.seq, event: eventId, action: row.action, timestamp: row.at, hash: row.hash });
          const headers = { "Content-Type": "application/json", "X-Manak-Delivery": id,
            "X-Manak-Event": row.action, "X-Manak-Signature": `sha256=${signWebhookPayload(body, secret)}` };
          db.run(`update webhook_delivery set attempts = attempts + 1, last_attempt_at = :at
            where destination = :destination and sequence = :seq`, { at: clock.now(), destination, seq: row.seq });
          try {
            const response = options.send
              ? await options.send(url.href, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers, body })
              : await sendPinnedWebhook(url, headers, body);
            if ("body" in response) await response.body?.cancel();
            db.run("update webhook_delivery set status_code = :code where destination = :destination and sequence = :seq",
              { code: response.status, destination, seq: row.seq });
            if (!response.ok) throw new Error(`Webhook receiver returned HTTP ${response.status}; delivery retained for retry.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Webhook delivery failed.";
            db.run("update webhook_delivery set last_error = :message where destination = :destination and sequence = :seq",
              { message, destination, seq: row.seq });
            throw error;
          }
          const next = { seq: row.seq, hash: row.hash, destination };
          db.tx(() => {
            db.run("update webhook_delivery set status = 'delivered', delivered_at = :at, last_error = null where destination = :destination and sequence = :seq",
              { at: clock.now(), destination, seq: row.seq });
            db.run("update webhook_subscription set cursor = :seq, cursor_hash = :hash where destination = :destination", next);
          });
          cursor = next;
          mkdirSync(dirname(checkpoint), { recursive: true });
          writeFileSync(`${checkpoint}.tmp`, JSON.stringify(next) + "\n", { encoding: "utf8", mode: 0o600 });
          renameSync(`${checkpoint}.tmp`, checkpoint);
          delivered++;
        }
        status = { ...status, cursor: cursor.seq, lastSuccessAt: clock.now(),
          lastError: null, consecutiveFailures: 0 };
        saveStatus();
        return delivered;
      } catch (error) {
        status = { ...status, cursor: cursor.seq,
          lastError: error instanceof Error ? error.message : String(error),
          consecutiveFailures: status.consecutiveFailures + 1 };
        saveStatus();
        throw error;
      } finally { busy = false; }
    },
  };
}
