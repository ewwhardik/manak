/**
 * The mailer's public surface.
 *
 * A leaf, and the only layer in this repository that is not part of `db → api → view → http`.
 * It sits beside them: it imports one type from the command layer and is imported by nothing but
 * `bin/manak.ts`, which is what makes it optional in the way the product needs. A deployment
 * with no `MANAK_SMTP_HOST` never constructs an outbox, never opens a socket, and behaves exactly
 * as it did before this package existed — the sign-in link goes to stdout and the log says so.
 *
 * Three files, in the order a message passes through them: `message.ts` turns a `Delivery` into
 * the octets of an RFC 5322 message, `smtp.ts` carries octets to a relay, and `outbox.ts` stands
 * between them and the request that asked, so no handler ever waits on a mail server.
 *
 * Everything below is exported because a test asserts on it. `composeMessage` is checked against
 * fixed text with a fixed clock and a fixed `Message-ID`, `quotedPrintable` and `encodeHeaderValue`
 * are checked against the examples in their RFCs, and `makeOutbox` is driven through a fake
 * `open` that answers with scripted failures — which is why `OutboxOptions` has seams for the
 * connection and the wait, and why neither has a production caller that sets them.
 */

export {
  addressOf,
  composeMessage,
  CRLF,
  displayOf,
  dotStuff,
  encodeHeaderValue,
  mailbox,
  messageDate,
  newMessageId,
  phrase,
  quotedPrintable,
  wrap,
} from "./message.ts";
export type { Composed } from "./message.ts";

export {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF,
  DEFAULT_CAPACITY,
  DEFAULT_GRACE,
  DEFAULT_PER_CONNECTION,
  makeOutbox,
} from "./outbox.ts";
export type { Outbox, OutboxOptions } from "./outbox.ts";

export { DEFAULT_TIMEOUT, openSession, SmtpError } from "./smtp.ts";
export type { Encryption, Reply, Session, SmtpConfig } from "./smtp.ts";

export { makeResendOutbox } from "./resend.ts";
