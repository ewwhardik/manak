/**
 * The queue between a request and a relay.
 *
 * `deliver` is synchronous by declaration — `(message: Delivery) => void` — and that is not an
 * accident of the type: a handler that awaited a mail server would make somebody's sign-in
 * request take as long as the slowest hop between this container and a mailbox provider, and
 * would turn a relay that is briefly down into a portal that appears broken. So this file exists
 * to break that coupling. `deliver` validates, appends, returns, and the sending happens after
 * the response has already gone out.
 *
 * What that costs, stated plainly: a message accepted here is a promise this process may not
 * keep. The queue is in memory, so a container restarted between the click and the connection
 * loses whatever was still in it. Making that durable means a table, a poller, a lease and a
 * story about two containers sharing one — a subsystem, for a message whose remedy is a button
 * marked "email me a link" that the person is still looking at. **The cut line: a lost message
 * is a message the person asks for again, and every one of them is a line in this log.**
 *
 * Three decisions worth naming, because each has a plausible opposite.
 *
 * **A full queue refuses the newest, not the oldest.** Both lose somebody. The oldest are
 * nearest the front of a queue that is still draining, so evicting one converts a backlog that
 * would have cleared into a message that certainly never arrives.
 *
 * **A failure never prints the link.** Falling back to the log looks like helpfulness and is the
 * exact exposure the operator configured a relay to remove — on the worst possible day, when
 * something is already wrong and somebody is reading the logs. The line names the recipient, the
 * reason and the server's own words, and stops there.
 *
 * **A permanent failure outside a transaction abandons the whole queue.** A 535 on `AUTH` is not
 * a fact about one message. Retrying it per message would mean one handshake per queued sign-in
 * against a relay that is refusing all of them, and would bury the one line the operator needs
 * to read under fifty copies of itself.
 */


import { composeMessage } from "./message.ts";
import { openSession, SmtpError } from "./smtp.ts";
import type { Session, SmtpConfig } from "./smtp.ts";
import type { Delivery } from "../api/index.ts";

/** How many messages may wait. A room of two hundred signing in at once is the design case. */
export const DEFAULT_CAPACITY = 500;
/** How many times one message is offered before it is reported and dropped. */
export const DEFAULT_ATTEMPTS = 3;
/** The first wait after a transient failure, doubled on each consecutive one. */
export const DEFAULT_BACKOFF = 2_000;
/** How many messages one connection carries before it is retired. Relays cap this; so do we. */
export const DEFAULT_PER_CONNECTION = 100;
/** How long `close` waits for the queue before abandoning it. */
export const DEFAULT_GRACE = 5_000;

/**
 * The stages that are inside one transaction, and so cost one message.
 *
 * Everything else — a refused connection, a greeting that is not SMTP, a 535 on `AUTH` — is a
 * fact about the relay, and nothing queued behind it can succeed either. Written as the short
 * list rather than the long one because the short list is the closed one: these five are the
 * exchanges between `MAIL FROM` and the final dot, plus the compose step that precedes them.
 */
const TRANSACTION = new Set(["compose", "mail from", "rcpt to", "data", "message"]);


export type OutboxOptions = {
  readonly smtp: SmtpConfig;
  /**
   * The current instant, for the `Date` header.
   *
   * Structural rather than the storage layer's `Clock`, so this package imports nothing but
   * `node:*` and one type. `src/` may not read the wall clock — `tests/source.test.ts` enforces
   * that — and a `Date` header is a claim about when a message was written.
   */
  readonly clock: { readonly now: () => number };
  /** One line, operator-facing, already prefixed. Defaults to stdout. */
  readonly log?: (line: string) => void;
  readonly attempts?: number;
  readonly backoff?: number;
  readonly capacity?: number;
  readonly perConnection?: number;
  /** How a connection is opened. The seam the tests replace; production leaves it alone. */
  readonly open?: (config: SmtpConfig) => Promise<Session>;
  /** How a wait happens. Replaced by the tests so a backoff does not cost real seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type Outbox = {
  /** Accept a message for sending, or refuse it with a line. Never throws, never blocks. */
  readonly deliver: (message: Delivery) => void;
  /** How many messages are waiting, including one being attempted. */
  readonly pending: () => number;
  /** Resolves when the queue is empty and no connection is open. */
  readonly idle: () => Promise<void>;
  /** Stop accepting, wait `grace` for the queue, then abandon the rest with one line. */
  readonly close: (grace?: number) => Promise<void>;
};

type Queued = { readonly message: Delivery; attempts: number };

/**
 * Any throw, as an `SmtpError` with a stage and a verdict.
 *
 * A throw that is not one already came from `composeMessage`, which refuses octets rather than
 * escaping them. The same octets fail the same way on every retry, so it is permanent, and its
 * stage is not a setup stage: one unsendable address must not abandon the queue behind it.
 */
function asFault(error: unknown): SmtpError {
  if (error instanceof SmtpError) return error;
  return new SmtpError(0, `compose: ${error instanceof Error ? error.message : String(error)}`, "compose", true);
}

/** The phrase every line about a message shares, so a log can be read by recipient. */
const naming = (message: Delivery): string => `${message.reason} for ${message.to}`;

export function makeOutbox(options: OutboxOptions): Outbox {
  const log = options.log ?? ((line: string): void => {
    process.stdout.write(`${line}\n`);
  });
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const backoff = Math.max(0, options.backoff ?? DEFAULT_BACKOFF);
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  const perConnection = Math.max(1, options.perConnection ?? DEFAULT_PER_CONNECTION);
  const connect = options.open ?? openSession;
  // `unref` so a pending backoff cannot be the reason the process refuses to exit. The queue is
  // already understood to be lossy at shutdown; holding the event loop open to prove otherwise
  // would trade a lost message for a container that will not stop.
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((done) => {
      setTimeout(done, ms).unref();
    }));

  const queue: Queued[] = [];
  let session: Session | null = null;
  let draining: Promise<void> | null = null;
  let closed = false;
  const waiting: (() => void)[] = [];

  const wake = (): void => {
    for (const done of waiting.splice(0)) done();
  };

  /**
   * Send everything queued, one connection for as long as it lasts.
   *
   * The head stays at the front until it is either accepted or given up on, so a message never
   * loses its place to one that arrived later. One connection carries up to `perConnection`
   * messages and is then retired politely, because relays cap this and a server that closes the
   * connection mid-transaction is indistinguishable from a network fault.
   */
  async function drain(): Promise<void> {
    let consecutive = 0;
    while (queue.length > 0 && !closed) {
      const head = queue[0] as Queued;
      try {
        if (session !== null && session.delivered() >= perConnection) {
          await session.quit();
          session = null;
        }
        if (session === null) session = await connect(options.smtp);
        const link = session;
        const composed = composeMessage(head.message, { from: options.smtp.from, now: options.clock.now() });
        await link.send(composed);
        queue.shift();
        consecutive = 0;
        log(`[mail] sent the ${naming(head.message)} <${composed.id}>`);
      } catch (error) {
        const fault = asFault(error);
        // Nothing is reused across a failure. A transaction that broke halfway leaves the server
        // holding a partial one, and the cheapest correct answer is a new connection.
        session?.destroy();
        session = null;
        if (fault.permanent && !TRANSACTION.has(fault.stage)) {
          const lost = queue.splice(0).length;
          log(
            `[mail] this relay cannot be used and retrying will not change that: ${fault.message}` +
              ` — ${lost} message(s) dropped unsent`,
          );
          break;
        }
        head.attempts += 1;
        if (fault.permanent || head.attempts >= attempts) {
          queue.shift();
          log(`[mail] gave up on the ${naming(head.message)} after ${head.attempts} attempt(s): ${fault.message}`);
        } else if (!closed) {
          await sleep(backoff * 2 ** consecutive);
          consecutive += 1;
        }
      }
    }
    if (session !== null) {
      await session.quit();
      session = null;
    }
  }

  /**
   * Start the drain if it is not already running, and restart it if work arrived as it ended.
   *
   * One loop at a time is the whole concurrency model. Two would mean two connections, two
   * authentications and two claims on the same head of the queue, for a workload whose peak is a
   * few hundred sign-ins that a single connection sends in a couple of seconds.
   */
  const kick = (): void => {
    if (draining !== null) return;
    draining = drain()
      .catch((error: unknown) => {
        // `drain` names every failure it can. This is the line for the one it could not.
        log(`[mail] the outbox stopped on an unexpected error: ${String(error)}`);
        session?.destroy();
        session = null;
      })
      .then(() => {
        draining = null;
        if (queue.length > 0 && !closed) kick();
        else wake();
      });
  };

  return {
    deliver: (message) => {
      if (closed) {
        log(`[mail] refused the ${naming(message)}: the outbox is closed`);
        return;
      }
      if (queue.length >= capacity) {
        // The link is deliberately absent from this line. See the header.
        log(
          `[mail] refused the ${naming(message)}: ${capacity} messages are already waiting,` +
            ` so the relay is not keeping up and this one would only wait behind them`,
        );
        return;
      }
      queue.push({ message, attempts: 0 });
      kick();
    },
    pending: () => queue.length,
    idle: () =>
      new Promise<void>((done) => {
        if (queue.length === 0 && draining === null) done();
        else waiting.push(done);
      }),
    close: async (grace = DEFAULT_GRACE) => {
      if (draining !== null || queue.length > 0) {
        await Promise.race([new Promise<void>((done) => waiting.push(done)), sleep(grace)]);
      }
      closed = true;
      const lost = queue.splice(0).length;
      if (lost > 0) {
        log(
          `[mail] ${lost} message(s) were still queued after ${grace}ms and were dropped;` +
            ` whoever was waiting for one will have to ask again`,
        );
      }
      session?.destroy();
      session = null;
      wake();
    },
  };
}
