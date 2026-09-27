/**
 * The composition root: environment in, running server out.
 *
 * This file is outside `src/` for a reason `tests/source.test.ts` enforces from the other
 * side. Nothing under `src/` except `src/http/` may import `src/http/`, so the only places
 * that may call `listen` are `tools/` and here — which means the layer rule and the question
 * "where does this process actually start" have the same answer, and a stray `listen` in a
 * repository module fails the suite rather than review.
 *
 * What it owns, that nothing above it does:
 *
 * **Reading the environment.** Every option `makeApp` takes is a value somebody has to
 * supply, and a self-hosted product's answer is the environment. Doing it in one file keeps
 * `process.env` out of seventeen command handlers, which is most of what makes them testable
 * by calling them.
 *
 * **Migrating before serving.** `migrate` runs on every boot rather than being a second
 * command an operator has to know about, and that is a deliberate trade in favour of the
 * one-command boot. It is safe because `planMigrations` already refuses a divergent history:
 * an automatic migration either applies the pending files or throws before the socket opens,
 * so it cannot quietly reinterpret somebody's data.
 *
 * **Failing loudly before the socket, and only warning after it.** A corrupt database stops
 * the process with a message. A broken ledger chain does not — it is printed as a warning and
 * the server starts anyway, because the portal's own pages are the only tool an operator has
 * for investigating one, and a product that bricks itself over a finding it also publishes is
 * a product that gets restored from a backup instead of examined.
 *
 * **Deciding whether there is a mail relay.** `src/mail` is a leaf beside the layer stack and
 * this is its only caller, which is what makes it optional in the way the product needs: with
 * no `MANAK_SMTP_HOST` no outbox is constructed, no socket is opened, and sign-in links go to
 * stdout exactly as they did before that package existed. When a host *is* set, every mistake
 * an operator can make in the other five settings is refused here rather than at the first
 * message — a `From` that is not an address, a password with no user, a password on an
 * unencrypted connection — because a relay that fails per message fails in a log nobody is
 * reading yet.
 *
 * **Stopping.** SIGTERM is how a container is asked to stop, and the default answer — die at
 * once — drops requests in flight and leaves a write-ahead log to recover. So: stop
 * listening, give open connections a moment, drain the outbox, close the database, exit 0. A
 * second signal means somebody is out of patience, and it exits immediately.
 *
 * The cut line, stated so nobody goes looking for it: one process, one port, no clustering
 * and no TLS. SQLite has a single writer, so a second worker buys queueing rather than
 * throughput; and a portal that terminated TLS itself would own certificate renewal, which is
 * the job of the proxy an operator running one already has. `trustProxy` is the seam for that
 * arrangement and it is off until asked for, because a rate limit keyed on a header anybody
 * can set is not a rate limit.
 *
 * One known gap, named rather than hidden: a request log line carries no correlation id, so a
 * stack trace from `report` cannot be tied to the request that produced it when two arrive at
 * once. Closing it means a field on `LogRecord` and an argument to `report` — a change to the
 * dispatcher, not to its caller, and not one to make from here.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/index.ts";
import type { Delivery } from "../src/api/index.ts";
import {
  checkIntegrity,
  headHash,
  getOrCreateKeypair,
  ledgerLength,
  ledgerWebhook,
  makeContext,
  migrate,
  openDatabase,
  sweepExpired,
  sweepRateLimits,
  systemClock,
  verifyLedger,
} from "../src/db/index.ts";
import type { Db } from "../src/db/index.ts";
import { listen } from "../src/http/index.ts";
import type { LogRecord } from "../src/http/index.ts";
import { mailbox, makeOutbox } from "../src/mail/index.ts";
import type { Encryption, Outbox } from "../src/mail/index.ts";
import { VIEWS } from "../src/view/index.ts";

/** Where the database goes when nobody says. Relative, so a bare `npm start` works. */
const DEFAULT_DATABASE = "./data/manak.db";

/** How long an in-flight response has after the socket stops accepting, in milliseconds. */
const SHUTDOWN_GRACE = 5_000;

/**
 * How often expired sessions, spent links and stale rate-limit rows are deleted.
 *
 * Fifteen minutes, and the interval is unreferenced so it never keeps the process alive on
 * its own. None of this is required for correctness — `resolveSession` checks `expires_at`
 * and `consume` checks the window, so an unswept row is already inert. It is here so that a
 * portal left running between two hackathons does not carry every session it ever issued,
 * and so a `magic_link` row stops existing shortly after it stops working.
 */
const SWEEP_EVERY = 15 * 60 * 1000;

/** An environment variable, trimmed, or undefined when it is absent or blank. */
function text(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A boolean setting, or a thrown error for anything that is not plainly one.
 *
 * `MANAK_TRUST_PROXY=maybe` meaning false is a security misconfiguration that never
 * announces itself: the operator believes their proxy's header is being read, the limiter is
 * counting every request into one bucket, and nothing in the log says so. Refusing to start
 * is the only answer that reaches them.
 */
function flag(name: string): boolean {
  const value = text(name)?.toLowerCase();
  if (value === undefined) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} is ${JSON.stringify(value)}; write one of on, off, true, false, 1, 0`);
}

/** A port number, or a thrown error. Zero is allowed: it means "any free port". */
function port(): number {
  // `MANAK_PORT` wins over `PORT` when both are set, because `PORT` is injected by hosts
  // that do not know what this program is and the prefixed name is the one an operator typed
  // on purpose.
  const raw = text("MANAK_PORT") ?? text("PORT");
  if (raw === undefined) return 8080;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`the port is ${JSON.stringify(raw)}; write a whole number from 0 to 65535`);
  }
  return value;
}

/** The externally reachable origin for links sent by the application. */
function publicOrigin(listenPort: number): string {
  const value = text("MANAK_PUBLIC_ORIGIN") ?? `http://localhost:${listenPort}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`MANAK_PUBLIC_ORIGIN is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("MANAK_PUBLIC_ORIGIN must be an http(s) origin without a path");
  }
  return parsed.origin;
}

/**
 * The founder addresses, split on anything an operator might have separated them with.
 *
 * Commas, semicolons and whitespace all work, because this value is typed into a compose
 * file by hand and a list that only accepted one of the three would be a support question.
 * Normalizing the addresses is `makeApp`'s job and it does it at boot, so `Ada@Example.COM`
 * here matches `ada@example.com` in the database.
 */
function founders(): readonly string[] {
  const raw = text("MANAK_FOUNDERS");
  return raw === undefined ? [] : raw.split(/[\s,;]+/).filter((part) => part !== "");
}

/**
 * One request, one line, on stdout.
 *
 * Key-and-value rather than JSON, because the first reader of this log is a person running
 * `docker logs` in the first five minutes of trying the product, and a wall of
 * `{"at":1759...}` is worse for them than it is better for an aggregator that can still
 * `grep status=403`. The timestamp is ISO so it sorts, the status comes before the path so a
 * column of them can be skimmed, and the method is padded for the same reason.
 *
 * Nothing submitted appears here. `LogRecord` carries no body and its `path` already has any
 * secret segment replaced by the field's name, which is what keeps a sign-in URL — a
 * credential in a path — out of the operator's log. `tests/http.test.ts` asserts that.
 */
function logLine(record: LogRecord): void {
  const parts = [
    new Date(record.at).toISOString(),
    String(record.status),
    record.method.padEnd(4, " "),
    record.path,
    `${record.ms}ms`,
    `command=${record.command ?? "-"}`,
    `account=${record.account ?? "-"}`,
  ];
  if (record.code !== null) parts.push(`code=${record.code}`);
  process.stdout.write(`${parts.join(" ")}\n`);
}

/**
 * A bug, with its stack, on stderr.
 *
 * Only reached for something that is not a declared refusal — `isUnexpected` in the
 * dispatcher makes that call — so this stream stays empty on a healthy deployment and an
 * operator watching it is watching something worth watching.
 */
function reportBug(error: unknown): void {
  const shown = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[bug] an operation threw something undeclared\n${shown}\n`);
}

/** What `--help` prints. The only documentation that is guaranteed to be in date. */
const HELP = `manak — a self-hostable hackathon submission and judging portal

  node --experimental-strip-types bin/manak.ts        (or: npm start)

Environment:
  MANAK_DEMO          true enables disposable demo login and global clock controls; default false
  MANAK_DATABASE      path to the SQLite file, or :memory:   ${DEFAULT_DATABASE}
  MANAK_PORT / PORT   port to listen on, 0 for any free one  8080
  MANAK_HOST          address to bind                        0.0.0.0
  MANAK_PUBLIC_ORIGIN absolute origin used in sign-in links   http://localhost:<port>
  MANAK_FOUNDERS      addresses allowed to create an event   (nobody)
  MANAK_TRUST_PROXY   read X-Forwarded-For and -Proto        off
  MANAK_SECURE_COOKIE force Secure on the session cookie     off (derived per request)

Webhooks. Optional HTTPS receiver; signed event notifications replay from the audit ledger.
  MANAK_KEY_DIR         persistent certificate keys; defaults beside database
  MANAK_WEBHOOK_URL     trusted operator-configured receiver
  MANAK_WEBHOOK_EVENT   event ID to deliver
  MANAK_WEBHOOK_SECRET  shared signing secret, at least 32 characters
  MANAK_WEBHOOK_CHECKPOINT durable cursor path, defaults beside database

Mail. Set MANAK_SMTP_HOST (or MANAK_RESEND_API_KEY) and sign-in links are sent instead of printed;
leave it unset and nothing in this list is read.
  MANAK_RESEND_API_KEY  deliver via Resend HTTPS REST API (for cloud hosts blocking SMTP)
  MANAK_SMTP_HOST     the relay to submit through            (none: links go to stdout)
  MANAK_SMTP_FROM     the sender, "Name <a@b>" or an address required once HOST is set
  MANAK_SMTP_PORT     port on the relay                      465 with tls, else 587
  MANAK_SMTP_ENCRYPTION  tls, starttls or none               starttls
  MANAK_SMTP_USER     account on the relay                   (no authentication)
  MANAK_SMTP_PASSWORD its password, or an app password       (no authentication)

With no MANAK_FOUNDERS nobody can create an event over HTTP, which is the safe default
rather than the convenient one: sign-in is a link to any address given, so an open create
would let the first passer-by fill this server with hackathons.

Sign-in links are printed to stdout unless MANAK_SMTP_HOST is set. Anybody who can read this
log can then sign in as anybody who has asked for a link. See docs/THREAT-MODEL.md.
`;

/** An outbox and the one line that says what it will do, so nothing reads the environment twice. */
type Mail = { readonly outbox: Outbox; readonly banner: string };

/**
 * The outbox, or `null` for a deployment that has not been given a relay.
 *
 * Every refusal in here is a setting that would otherwise fail once per message, in a log an
 * operator is not yet watching, on the first sign-in of an event rather than at boot. The two
 * that are security rather than typing are worth naming: a password with no user is silently
 * unused, and a password on an unencrypted connection is readable by every hop to the relay.
 * `openSession` refuses the second one too — it has to, because it is a public function — and
 * this check exists so the answer arrives before the socket opens instead of afterwards.
 *
 * `log` is left at its default, which is one line on stdout. Mail failures are not bugs, and
 * putting them on stderr would mean a healthy deployment whose relay is briefly down writes
 * to the stream this product otherwise keeps empty.
 */
function mailer(): Mail | null {
  const resendApiKey = text("MANAK_RESEND_API_KEY") ?? text("RESEND_API_KEY");
  if (resendApiKey !== undefined) {
    const from = text("MANAK_SMTP_FROM") ?? "onboarding@resend.dev";
    return {
      outbox: {
        deliver: (message: Delivery): void => {
          const bodyText = message.link === undefined ? message.body : `${message.body}\n\n${message.link}\n`;
          void fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from,
              to: message.to,
              subject: message.subject,
              text: bodyText,
            }),
          }).then(async (res) => {
            if (!res.ok) {
              const err = await res.text();
              process.stderr.write(`[mail] resend api returned ${res.status}: ${err}\n`);
            } else {
              process.stdout.write(`[mail] sent sign-in link via Resend API to ${message.to}\n`);
            }
          }).catch((err) => {
            process.stderr.write(`[mail] resend api delivery failed: ${String(err)}\n`);
          });
        },
        pending: () => 0,
        idle: async () => {},
        close: async () => {},
      },
      banner: `[boot] sending mail via Resend REST API as ${from}`,
    };
  }

  const host = text("MANAK_SMTP_HOST");
  if (host === undefined) return null;

  const named = text("MANAK_SMTP_ENCRYPTION")?.toLowerCase() ?? "starttls";
  if (named !== "tls" && named !== "starttls" && named !== "none") {
    throw new Error(`MANAK_SMTP_ENCRYPTION is ${JSON.stringify(named)}; write one of tls, starttls, none`);
  }
  const encryption: Encryption = named;

  const from = text("MANAK_SMTP_FROM");
  if (from === undefined) {
    throw new Error(
      "MANAK_SMTP_HOST is set but MANAK_SMTP_FROM is not. There is no default worth guessing: " +
        "a relay rejects a sender it does not own, so a guess would fail at the first message",
    );
  }
  // Throws naming the setting, which is the same sentence the outbox would log per message.
  const sender = mailbox(from, "MANAK_SMTP_FROM");

  const raw = text("MANAK_SMTP_PORT");
  // Derived from the encryption rather than fixed at one number: 465 is submission that is
  // encrypted from the first byte, 587 is submission that negotiates. An operator who sets
  // one of these two settings has usually told us the other by implication.
  const relayPort = raw === undefined ? (encryption === "tls" ? 465 : 587) : Number(raw);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`MANAK_SMTP_PORT is ${JSON.stringify(raw)}; write a whole number from 1 to 65535`);
  }

  const user = text("MANAK_SMTP_USER");
  const password = text("MANAK_SMTP_PASSWORD");
  if (user === undefined && password !== undefined) {
    throw new Error(
      "MANAK_SMTP_PASSWORD is set but MANAK_SMTP_USER is not, so nothing would be sent with it. " +
        "Set the user, or remove the password if this relay wants no authentication",
    );
  }
  if (user !== undefined && encryption === "none") {
    throw new Error(
      "MANAK_SMTP_USER is set with MANAK_SMTP_ENCRYPTION=none. A password sent that way is " +
        "readable by every hop between here and the relay; use tls or starttls",
    );
  }

  return {
    outbox: makeOutbox({
      smtp: {
        host,
        port: relayPort,
        encryption,
        from,
        ...(user === undefined ? {} : { user }),
        ...(password === undefined ? {} : { password }),
      },
      clock: systemClock,
    }),
    // The port and the encryption are in the line because they are what a relay refusing this
    // deployment is usually about, and the user because an operator who set a password wants
    // to see that it was read. The password itself is never printed anywhere.
    banner:
      `[boot] sending mail as ${sender} through ${host}:${relayPort} over ${encryption}` +
      `${user === undefined ? ", unauthenticated" : `, as ${user}`}`,
  };
}

/**
 * Open the database, bring it up to date, and refuse to serve a broken one.
 *
 * The order is the argument. Integrity first, because `pragma integrity_check` on a file a
 * volume mangled is the difference between a message an operator can act on and a stream of
 * 500s an hour later. Migrations second, before anything reads a table that may not exist
 * yet. The chain walk last, because it is the only one of the three whose finding is a
 * warning rather than a refusal.
 */
function database(): Db {
  const path = text("MANAK_DATABASE") ?? DEFAULT_DATABASE;
  // A fresh `./data/manak.db` on a host with no `data/` is otherwise SQLITE_CANTOPEN, which
  // is a stack trace as somebody's first impression of the product. `:memory:` has no parent.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // Printed before the open rather than after it, because SQLite's refusal of a file that is
  // not a database is the words "file is not a database" and nothing else. Named first, the
  // pair of lines tells an operator which path to go and look at.
  process.stdout.write(`[boot] database ${path}\n`);
  const db = openDatabase(path);

  const corrupt = checkIntegrity(db);
  if (corrupt.length > 0) {
    throw new Error(`this database is not sound; refusing to serve it:\n  - ${corrupt.join("\n  - ")}`);
  }

  const applied = migrate(db);
  process.stdout.write(
    applied.alreadyCurrent
      ? "[boot] schema already current\n"
      : `[boot] applied ${applied.applied.length} migration(s): ${applied.applied.join(", ")}\n`,
  );

  const breaks = verifyLedger(db);
  const entries = ledgerLength(db);
  if (breaks.length === 0) {
    process.stdout.write(`[boot] ledger sound, ${entries} entr${entries === 1 ? "y" : "ies"}, head ${headHash(db)}\n`);
  } else {
    // Starting anyway. The pages that would let somebody work out what happened are served
    // by this process, and `/api/healthz` publishes the head hash, so refusing to boot would
    // hide the evidence and remove the only tool for reading it.
    process.stderr.write(
      `[warn] this ledger does not verify. Serving anyway; the audit trail cannot be trusted ` +
        `until this is explained:\n  - ${breaks
          .map((b) => `seq ${b.seq}: ${b.reason} — ${b.detail}`)
          .join("\n  - ")}\n`,
    );
  }
  return db;
}

/**
 * The periodic sweep, wrapped so a failure cannot take the server with it.
 *
 * An interval whose callback throws is an unhandled rejection and a dead process, and losing
 * a portal mid-event because a bookkeeping delete hit a busy database would be an absurd way
 * to fail. Nothing here is required for correctness — an unswept expired row is already
 * inert, because `resolveSession` reads `expires_at` — so a lost sweep costs disk and not
 * safety, and the right response to one is a line on stderr.
 */
function sweeper(db: Db): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      const ctx = makeContext(db, { clock: systemClock });
      const expired = sweepExpired(ctx);
      const buckets = sweepRateLimits(ctx);
      const total = expired.sessions + expired.links + buckets;
      if (total > 0) {
        process.stdout.write(
          `[sweep] removed ${expired.sessions} session(s), ${expired.links} link(s), ` +
            `${buckets} rate-limit row(s)\n`,
        );
      }
    } catch (error) {
      reportBug(error);
    }
  }, SWEEP_EVERY);
  timer.unref();
  return timer;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(HELP);
    return;
  }

  // Every setting is read before the database is opened, so a mistyped one fails in the first
  // millisecond rather than after a migration has been applied to somebody's data.
  const trustProxy = flag("MANAK_TRUST_PROXY");
  const secure = flag("MANAK_SECURE_COOKIE");
  const listed = founders();
  const host = text("MANAK_HOST") ?? "0.0.0.0";
  const listenPort = port();
  const externalOrigin = publicOrigin(listenPort);
  const mail = mailer();
  const db = database();

  const keys = getOrCreateKeypair(text("MANAK_KEY_DIR") ?? dirname(text("MANAK_DATABASE") ?? DEFAULT_DATABASE));
  const webhookUrl = text("MANAK_WEBHOOK_URL");
  const hook = webhookUrl ? ledgerWebhook({ db, url: webhookUrl,
    eventId: text("MANAK_WEBHOOK_EVENT") ?? "", secret: text("MANAK_WEBHOOK_SECRET") ?? "",
    checkpoint: text("MANAK_WEBHOOK_CHECKPOINT") ?? `${text("MANAK_DATABASE") ?? DEFAULT_DATABASE}.webhook.json`,
  }) : null;
  let webhookDelay = 2000;
  let webhookTimer: ReturnType<typeof setTimeout> | undefined;
  let webhookStopped = false;
  let webhookFlight: Promise<void> = Promise.resolve();
  const pump = (): void => {
    if (!hook || webhookStopped) return;
    webhookFlight = hook.flush().then(() => { webhookDelay = 2000; }).catch((error: unknown) => {
      webhookDelay = Math.min(60000, webhookDelay * 2);
      process.stderr.write(`[webhook] ${error instanceof Error ? error.message : "delivery failed"}; retrying in ${webhookDelay / 1000}s\n`);
    }).finally(() => {
      if (!webhookStopped) { webhookTimer = setTimeout(pump, webhookDelay); webhookTimer.unref(); }
    });
  };

  const listening = await listen({
    db,
    publicKey: keys.publicKeyPem,
    demoMode: process.env.MANAK_DEMO === "true",
    registry: makeRegistry(ALL_COMMANDS),
    publicOrigin: externalOrigin,
    views: VIEWS,
    clock: systemClock,
    log: logLine,
    report: reportBug,
    trustProxy,
    // Spread rather than passed, because `secure` is read as `options.secure ?? derived` and
    // an explicit `false` would *force* a cookie without `Secure` on an HTTPS deployment —
    // the opposite of what turning the setting off should mean.
    ...(secure ? { secure: true } : {}),
    // Spread for the plainer reason: with no relay this key is absent, so `app.ts` falls back
    // to the delivery that prints. That fallback is the documented default rather than a
    // safety net, and it is the reason this whole package can be optional.
    ...(mail === null ? {} : { deliver: mail.outbox.deliver }),
    founders: listed,
    host,
    port: listenPort,
  });

  const sweep = sweeper(db);
  pump();

  process.stdout.write(
    listed.length === 0
      ? "[boot] no founders configured, so nobody can create an event over HTTP; " +
          "set MANAK_FOUNDERS to your own address\n"
      : `[boot] ${listed.length} address(es) may create an event\n`,
  );
  if (trustProxy) {
    process.stdout.write("[boot] trusting X-Forwarded-For and X-Forwarded-Proto\n");
  }
  // Always a line, either way. The unconfigured case is the one that matters most to print:
  // somebody trying this product for the first time cannot sign in at all until they know
  // their link is in this stream, and nobody reads `--help` before `docker compose up`.
  process.stdout.write(
    mail === null
      ? "[boot] no mail relay configured, so sign-in links are printed to this log; " +
          "set MANAK_SMTP_HOST and MANAK_SMTP_FROM to send them instead\n"
      : `${mail.banner}\n`,
  );
  process.stdout.write(`[boot] listening on ${listening.url}\n`);

  let stopping = false;
  const stop = (signal: string): void => {
    // A second signal is somebody out of patience, and the honest answer is to go at once
    // rather than to explain that a graceful stop is already under way.
    if (stopping) {
      process.stderr.write(`[stop] ${signal} again, exiting now\n`);
      process.exit(1);
    }
    stopping = true;
    clearInterval(sweep);
    webhookStopped = true;
    clearTimeout(webhookTimer);
    process.stdout.write(`[stop] ${signal}, finishing what is in flight\n`);
    listening
      .close(SHUTDOWN_GRACE)
      // The socket first, the outbox second, and in that order for a reason: a request still
      // being served may be the one that queues a sign-in link, so draining the queue before
      // the responses have finished would drop a message that had not been accepted yet.
      // `close` waits its own grace period and then says how many it abandoned.
      .then(() => (mail === null ? undefined : mail.outbox.close()))
      .then(() => webhookFlight)
      .then(() => {
        // Closing the database checkpoints the write-ahead log, so the next boot opens a
        // single file rather than recovering one. Nothing is exited explicitly: with the
        // socket shut and the sweep cleared there is no handle left, so the process ends on
        // its own and stdout is flushed on the way out.
        db.close();
        process.stdout.write("[stop] closed\n");
      })
      .catch((error: unknown) => {
        reportBug(error);
        process.exitCode = 1;
      });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stop(signal));
  }
}

try {
  await main();
} catch (error) {
  // A boot failure is a message, not a stack. Every throw reachable from here is one this
  // file raised on purpose — a mistyped setting, a corrupt file, a divergent migration
  // history — and printing forty frames of Node internals above it would bury the sentence
  // that says what to change.
  process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
