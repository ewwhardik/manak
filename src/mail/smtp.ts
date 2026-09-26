/**
 * An SMTP client, in the only two modules this product is willing to spend on one.
 *
 * There is no mail library here because there are no libraries here at all, and that
 * constraint turns out to be a smaller problem than it sounds: submission is a line protocol
 * with about nine commands, and the whole of it fits in one file that can be read in an
 * afternoon. What it will not do is pretend to be more than that, so the cut lines come first.
 *
 * **No DKIM, no SPF, no DMARC.** Signing is the relay's job. This client hands a message to a
 * server the operator already runs or already pays for, and that server signs it with a key
 * this process should never hold.
 *
 * **No pipelining, no CHUNKING, no 8BITMIME.** One command, one reply, and a
 * quoted-printable body that is legal on a server from 1982. Pipelining would buy round trips
 * on a burst of invitations, which is exactly the case where the connection is already open and
 * the round trips are already cheap.
 *
 * **No XOAUTH2.** A refresh-token flow means storing a client secret and renewing a credential
 * on a schedule, which is a subsystem, not a feature. Providers that require it also issue
 * app passwords, and an app password works with `AUTH PLAIN`.
 *
 * Two things it is strict about, both security rather than protocol.
 *
 * **`starttls` will not fall back.** A server that does not advertise STARTTLS gets an error,
 * not a plaintext session. Downgrade-on-absence is how a mailer that looks encrypted in
 * configuration sends credentials in the clear on the day a relay is misconfigured.
 *
 * **Nothing already buffered may survive the upgrade.** If the server sends anything after its
 * `220` to STARTTLS and before the handshake, this refuses the connection. Those octets were
 * injected before encryption began and would be read as though they arrived inside it — the
 * flaw catalogued as CVE-2011-0411 across a generation of mail clients, and it costs one
 * comparison to be immune to.
 *
 * Authentication over an unencrypted connection is refused outright. There is no override flag,
 * because an override flag is a thing people set once while debugging.
 */

import { once } from "node:events";
import { connect as connectPlain } from "node:net";
import type { Socket } from "node:net";
import { connect as connectTls } from "node:tls";

import { addressOf, CRLF, dotStuff } from "./message.ts";

/** How the connection is protected. `none` is legal and refuses to carry a password. */
export type Encryption = "tls" | "starttls" | "none";

/** How long one exchange may go without a byte before the connection is abandoned. */
export const DEFAULT_TIMEOUT = 20_000;

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  readonly encryption: Encryption;
  /** The `From` header and the envelope sender. May carry a display name. */
  readonly from: string;
  readonly user?: string;
  readonly password?: string;
  /** What to announce in `EHLO`. Defaults to the sender's own domain. */
  readonly helo?: string;
  readonly timeout?: number;
};

/** One reply: its code, and the text of every line that carried it. */
export type Reply = { readonly code: number; readonly lines: readonly string[] };

/**
 * A failed exchange, with the one bit of judgement the outbox needs.
 *
 * `permanent` decides whether the message is retried or reported and dropped, and the rule is
 * the protocol's own: a 4xx is the server asking for later, a 5xx is the server saying never.
 * Everything that is not a reply code — a refused connection, a socket that fell silent — is
 * transient, because a relay being restarted looks exactly like that. The exception is a
 * certificate that will not verify, which is a configuration fact rather than a moment: it is
 * marked permanent so an operator gets one clear line instead of the same line three times.
 */
export class SmtpError extends Error {
  readonly code: number;
  readonly stage: string;
  readonly permanent: boolean;

  constructor(code: number, message: string, stage: string, permanent: boolean) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.stage = stage;
    this.permanent = permanent;
  }
}

/** Anything thrown by a socket, as an `SmtpError` the outbox can reason about. */
function asSmtpError(error: unknown, stage: string): SmtpError {
  if (error instanceof SmtpError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const named = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
  const certificate = /cert|self.signed|altname|_verify_|unable to (get|verify)/i.test(`${named} ${text}`);
  return new SmtpError(0, `${stage}: ${text}`, stage, certificate);
}

/** A socket, read as a sequence of replies rather than as a stream of bytes. */
type Wire = {
  write: (text: string) => void;
  /** The next complete reply. Rejects if the connection broke or fell silent first. */
  read: () => Promise<Reply>;
  /**
   * Anything received and not yet asked for, as text, or `""`.
   *
   * Four kinds, and every one of them is a fault across a STARTTLS handshake. An unparsed tail
   * is the obvious one and the only one a naive check looks at. The others are the reason this
   * returns a string rather than testing a buffer: a *complete* reply already parsed would be
   * handed over as the answer to the `EHLO` after the upgrade, an unfinished multi-line reply
   * would have its continuation lines believed, and a connection already broken means the
   * server sent something that was not a reply at all. That is the whole of CVE-2011-0411, and
   * only the first of the four is visible in a buffer length.
   */
  residue: () => string;

  /** Stop listening, so the socket can be handed to TLS or closed. */
  detach: () => void;
};


/**
 * Turn one socket into a reply reader.
 *
 * A reply is one or more lines: `250-FIRST`, `250-SECOND`, `250 LAST`, where the space in place
 * of the hyphen is the only thing marking the end. Lines are assembled from whatever the socket
 * hands over, because a multi-line reply arrives in as many chunks as the network feels like and
 * a reader that assumed one chunk per reply works perfectly against a fast local server and
 * fails against a real one.
 *
 * The timeout is the socket's own idle timer rather than a `setTimeout` per exchange: it resets
 * on every byte in either direction, which is the right shape for `DATA` — a slow but progressing
 * transfer of a long message is not a stall — and it needs no clearing on the happy path, so
 * there is no timer left holding the process open.
 */
function wire(socket: Socket, timeout: number): Wire {
  let unread = "";
  let partial: string[] = [];
  const ready: Reply[] = [];
  let waiter: { ok: (reply: Reply) => void; no: (error: Error) => void } | null = null;
  let broken: Error | null = null;

  const hand = (reply: Reply): void => {
    const waiting = waiter;
    waiter = null;
    if (waiting === null) ready.push(reply);
    else waiting.ok(reply);
  };
  const fail = (error: Error): void => {
    broken ??= error;
    const waiting = waiter;
    waiter = null;
    if (waiting !== null) waiting.no(broken);
  };
  const onData = (chunk: Buffer): void => {
    unread += chunk.toString("utf8");
    for (;;) {
      const end = unread.indexOf("\n");
      if (end < 0) return;
      const line = unread.slice(0, end).replace(/\r$/, "");
      unread = unread.slice(end + 1);
      const parsed = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (parsed === null) {
        socket.destroy();
        fail(new SmtpError(0, `this is not an SMTP reply: ${JSON.stringify(line)}`, "read", true));
        return;
      }
      partial.push(parsed[3] as string);
      if (parsed[2] !== "-") {
        const reply: Reply = { code: Number(parsed[1]), lines: partial };
        partial = [];
        hand(reply);
      }
    }
  };
  const onError = (error: Error): void => fail(asSmtpError(error, "connection"));
  const onClose = (): void => fail(new SmtpError(0, "the server closed the connection", "connection", false));
  const onTimeout = (): void => {
    socket.destroy();
    fail(new SmtpError(0, `the server sent nothing for ${timeout}ms`, "connection", false));
  };

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.setTimeout(timeout, onTimeout);

  return {
    write: (text) => {
      socket.write(text);
    },
    read: () =>
      new Promise<Reply>((ok, no) => {
        const next = ready.shift();
        if (next !== undefined) ok(next);
        else if (broken !== null) no(broken);
        else waiter = { ok, no };
      }),
    residue: () =>
      [
        ...ready.map((reply) => `${reply.code} ${reply.lines.join(" ")}`),
        partial.length === 0 ? "" : `an unfinished reply: ${partial.join(" ")}`,
        unread,
        broken === null ? "" : broken.message,
      ]
        .filter((piece) => piece !== "")
        .join(" | "),

    detach: () => {
      socket.setTimeout(0);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("timeout", onTimeout);
    },
  };
}

/** Read one reply and insist on a code. Anything else becomes an `SmtpError` naming the stage. */
async function expect(link: Wire, allowed: readonly number[], stage: string): Promise<Reply> {
  let reply: Reply;
  try {
    reply = await link.read();
  } catch (error) {
    throw asSmtpError(error, stage);
  }
  if (!allowed.includes(reply.code)) {
    throw new SmtpError(
      reply.code,
      `${stage}: the server answered ${reply.code} ${reply.lines.join(" / ")}`,
      stage,
      reply.code >= 500,
    );
  }
  return reply;
}

/**
 * The extensions in an `EHLO` reply, keyword to parameters.
 *
 * Both spellings of the AUTH line are handled. `AUTH PLAIN LOGIN` is the current one; some
 * servers still send `AUTH=PLAIN LOGIN`, which was a workaround for a client that got the syntax
 * wrong in the nineties and is still in the wild. Reading only the first would silently disable
 * authentication against those servers, and the symptom would be a 530 nobody could explain.
 */
function capabilities(reply: Reply): Map<string, readonly string[]> {
  const found = new Map<string, readonly string[]>();
  for (const line of reply.lines.slice(1)) {
    const words = line.trim().split(/\s+/).filter((word) => word !== "");
    const head = (words[0] ?? "").toUpperCase();
    if (head === "") continue;
    const [keyword, inlineParam] = head.startsWith("AUTH=") ? ["AUTH", head.slice(5)] : [head, undefined];
    const params = [...(inlineParam === undefined ? [] : [inlineParam]), ...words.slice(1).map((w) => w.toUpperCase())];
    found.set(keyword, [...(found.get(keyword) ?? []), ...params]);
  }
  return found;
}

/** One open, authenticated connection. Carries as many messages as the outbox hands it. */
export type Session = {
  /** What the server said it could do, after the last `EHLO`. */
  readonly extensions: Map<string, readonly string[]>;
  /** Whether the bytes are encrypted. False only when the operator asked for `none`. */
  readonly encrypted: boolean;
  /** How many messages this connection has had accepted. */
  readonly delivered: () => number;
  send: (envelope: { readonly from: string; readonly to: string; readonly text: string }) => Promise<void>;
  /** `QUIT`, politely, then close. Never throws: the messages are already accepted. */
  quit: () => Promise<void>;
  /** Drop the connection without ceremony. For a failed transaction, and for shutdown. */
  destroy: () => void;
};

/** The base64 of NUL, the user, NUL and the password, which is all `AUTH PLAIN` is. */
function plainCredential(user: string, password: string): string {
  // Written as an escape rather than as the octet. `tests/source.test.ts` refuses a literal
  // control character anywhere in this repository, and that rule exists because five NULs were
  // once used here as map-key separators and turned the files binary to every tool that read
  // them. The wire wants the octet; the source may not contain it.
  const nul = "\u0000";
  return Buffer.from(`${nul}${user}${nul}${password}`, "utf8").toString("base64");
}

/**
 * Connect, greet, encrypt, authenticate — and hand back something that can send.
 *
 * Every step in here can fail, and the shape of the failure is the whole value of this
 * function: an `SmtpError` that says which stage, what the server answered, and whether trying
 * again in four seconds could possibly help. The outbox makes no protocol decisions of its own.
 */
export async function openSession(config: SmtpConfig): Promise<Session> {
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;
  const sender = addressOf(config.from);
  const greeting = config.helo ?? sender.split("@")[1] ?? "localhost";
  const implicit = config.encryption === "tls";
  let encrypted = implicit;
  let delivered = 0;

  const socket: Socket = implicit
    ? connectTls({ host: config.host, port: config.port, servername: config.host })
    : connectPlain({ host: config.host, port: config.port });
  socket.setNoDelay(true);
  try {
    await once(socket, implicit ? "secureConnect" : "connect");
  } catch (error) {
    socket.destroy();
    throw asSmtpError(error, "connect");
  }

  let link = wire(socket, timeout);
  const hello = async (): Promise<Map<string, readonly string[]>> => {
    link.write(`EHLO ${greeting}${CRLF}`);
    return capabilities(await expect(link, [250], "ehlo"));
  };

  let extensions: Map<string, readonly string[]>;
  try {
    await expect(link, [220], "greeting");
    extensions = await hello();

    if (config.encryption === "starttls") {
      if (!extensions.has("STARTTLS")) {
        throw new SmtpError(
          0,
          `${config.host}:${config.port} does not offer STARTTLS. Set MANAK_SMTP_ENCRYPTION to ` +
            `tls for a port that is encrypted from the first byte, or to none if this relay is ` +
            `reached over a network you already trust — this will not downgrade on its own`,
          "starttls",
          true,
        );
      }
      link.write(`STARTTLS${CRLF}`);
      await expect(link, [220], "starttls");
      // See the header. Anything unconsumed here arrived before encryption began and would be
      // read as though it had not — including a reply already parsed, which is the dangerous
      // half: it would be handed over as the answer to the `EHLO` after the handshake.
      const early = link.residue();
      if (early !== "") {
        throw new SmtpError(
          0,
          `the server sent ${JSON.stringify(early)} between agreeing to STARTTLS and the ` +
            `handshake; those octets are not encrypted and this connection is refused`,
          "starttls",
          true,
        );
      }

      link.detach();
      const secure = connectTls({ socket, servername: config.host });
      try {
        await once(secure, "secureConnect");
      } catch (error) {
        secure.destroy();
        throw asSmtpError(error, "starttls");
      }
      encrypted = true;
      link = wire(secure, timeout);
      // EHLO again, and not as a formality: the extension list before TLS is a different list,
      // and AUTH is normally absent from it on purpose.
      extensions = await hello();
    }

    if (config.user !== undefined) {
      const password = config.password ?? "";
      if (!encrypted) {
        throw new SmtpError(
          0,
          "MANAK_SMTP_USER is set on an unencrypted connection. A password sent that way is " +
            "readable by every hop between here and the relay; use tls or starttls",
          "auth",
          true,
        );
      }
      const offered = extensions.get("AUTH") ?? [];
      if (offered.includes("PLAIN")) {
        link.write(`AUTH PLAIN ${plainCredential(config.user, password)}${CRLF}`);
        await expect(link, [235], "auth");
      } else if (offered.includes("LOGIN")) {
        link.write(`AUTH LOGIN${CRLF}`);
        await expect(link, [334], "auth");
        link.write(`${Buffer.from(config.user, "utf8").toString("base64")}${CRLF}`);
        await expect(link, [334], "auth");
        link.write(`${Buffer.from(password, "utf8").toString("base64")}${CRLF}`);
        await expect(link, [235], "auth");
      } else {
        throw new SmtpError(
          0,
          `this server offers no authentication mechanism this can use${offered.length === 0 ? "" : `; it offers ${offered.join(", ")}`}. PLAIN or LOGIN is needed`,
          "auth",
          true,
        );
      }
    }
  } catch (error) {
    socket.destroy();
    throw asSmtpError(error, "open");
  }

  return {
    extensions,
    encrypted,
    delivered: () => delivered,
    send: async ({ from, to, text }) => {
      // Nothing here recovers. A transaction that fails halfway leaves the server holding a
      // partial one, and `RSET` to clear it is one more exchange that can also fail; the outbox
      // drops the connection instead and opens a clean one, which costs a handshake on a path
      // that is already going wrong.
      link.write(`MAIL FROM:<${from}>${CRLF}`);
      await expect(link, [250], "mail from");
      link.write(`RCPT TO:<${to}>${CRLF}`);
      // 251 is "we will forward it on", which is an acceptance. Anything else is not.
      await expect(link, [250, 251], "rcpt to");
      link.write(`DATA${CRLF}`);
      await expect(link, [354], "data");
      const body = text.endsWith(CRLF) ? text : `${text}${CRLF}`;
      link.write(`${dotStuff(body)}.${CRLF}`);
      await expect(link, [250], "message");
      delivered += 1;
    },
    quit: async () => {
      // Deliberately swallowing everything. By the time this runs the server has already
      // answered 250 to every message on this connection, so a relay that hangs up rudely at
      // `QUIT` has still delivered them, and an error line here would name a failure that did
      // not happen.
      try {
        link.write(`QUIT${CRLF}`);
        await expect(link, [221], "quit");
      } catch {
        // Nothing. See above.
      } finally {
        link.detach();
        socket.destroy();
      }
    },
    destroy: () => {
      link.detach();
      socket.destroy();
    },
  };
}
