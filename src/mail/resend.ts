/** Deployment-only HTTPS mail outbox. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Delivery } from "../api/index.ts";
import type { Outbox } from "./outbox.ts";

type Item = { id: string; to: string; reason: Delivery["reason"];
  message?: Delivery; state: "queued" | "delivered" | "failed";
  attempts: number; nextAt: number; lastStatus?: number };

export function makeResendOutbox(
  key: string,
  from: string,
  path: string,
  clock: { readonly now: () => number },
): Outbox {
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  if (!Array.isArray(parsed)) throw new Error("The deployed mail outbox is not an array.");
  const items = parsed as Item[];
  if (items.some((item) => !item || typeof item.id !== "string" ||
    !["queued", "delivered", "failed"].includes(item.state) ||
    (item.state === "queued" && !item.message))) {
    throw new Error("The deployed mail outbox contains an invalid record.");
  }
  let accepting = true;
  let stopped = false;
  let draining: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waiters: Array<() => void> = [];
  const log = (line: string): void => { process.stdout.write(`[mail] ${line}\n`); };
  const pending = (): number => items.filter((item) => item.state === "queued").length;
  const wake = (): void => {
    if (pending() !== 0 || draining !== null) return;
    for (const waiter of waiters.splice(0)) waiter();
  };
  const save = (): void => {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(items), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  };
  const kick = (): void => {
    if (stopped || draining !== null) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const head = items.find((item) => item.state === "queued");
    if (!head) { wake(); return; }
    const delay = Math.max(0, head.nextAt - clock.now());
    if (delay > 0) {
      timer = setTimeout(() => { timer = null; kick(); }, delay);
      return;
    }
    draining = (async () => {
      const message = head.message!;
      try {
        const body = message.link === undefined ? message.body : `${message.body}\n\n${message.link}\n`;
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
            "Idempotency-Key": head.id },
          body: JSON.stringify({ from, to: message.to, subject: message.subject, text: body }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw Object.assign(new Error("Provider refused the request"),
          { status: response.status });
        head.state = "delivered";
        delete head.message;
        head.lastStatus = response.status;
        save();
        log(`sent ${head.reason} to ${head.to}; status=${response.status}`);
      } catch (error) {
        head.attempts += 1;
        const status = typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status) : 0;
        head.lastStatus = status;
        if (head.attempts >= 3 || (status >= 400 && status < 500 && status !== 429)) {
          head.state = "failed";
          delete head.message;
          log(`failed ${head.reason} to ${head.to}; attempts=${head.attempts}; status=${status}`);
        } else {
          head.nextAt = clock.now() + 2000 * 2 ** (head.attempts - 1);
          log(`retrying ${head.reason} to ${head.to}; attempts=${head.attempts}; status=${status}`);
        }
        save();
      }
    })().finally(() => {
      draining = null;
      wake();
      kick();
    });
  };
  // A queued request remains on disk during the network attempt. Restart replays its
  // stable idempotency key, so a response lost after provider acceptance does not duplicate it.
  kick();
  return {
    deliver: (message) => {
      if (!accepting) { log(`refused ${message.reason} to ${message.to}; shutting down`); return; }
      if (pending() >= 500) { log(`refused ${message.reason} to ${message.to}; queue full`); return; }
      items.push({ id: randomUUID(), to: message.to, reason: message.reason,
        message, state: "queued", attempts: 0, nextAt: 0 });
      save();
      kick();
    },
    pending,
    idle: () => new Promise<void>((resolve) => {
      if (pending() === 0 && draining === null) resolve(); else waiters.push(resolve);
    }),
    close: async (grace = 5000) => {
      accepting = false;
      if (pending() > 0 || draining !== null) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)),
          new Promise<void>((resolve) => { timeout = setTimeout(resolve, grace); })]);
        if (timeout !== undefined) clearTimeout(timeout);
      }
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (pending() > 0) log(`${pending()} message(s) remain queued on disk for restart`);
    },
  };
}
