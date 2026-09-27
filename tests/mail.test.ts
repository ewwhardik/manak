/**
 * The mailer, from a `Delivery` to the octets a relay receives.
 *
 * Two halves, tested two ways. The composer is a pure function, so it is asserted against fixed
 * text with a fixed clock and a fixed `Message-ID` — every header, in order, byte for byte. The
 * client is a socket, so it is run against a relay this file starts on a loopback port: a real
 * `net` server that speaks the parts of SMTP this product uses and records what it was told.
 * There are no mocks of `node:net` anywhere here. A test that asserts on a transcript the real
 * socket produced is worth several that assert a function was called.
 *
 * **The cut line, stated because it is the one gap a reader will look for: the TLS handshake
 * itself is not exercised.** A `tls` server needs a private key, and a private key committed to
 * a repository strangers are invited to fork is a worse thing to own than three untested lines
 * that hand a socket to `node:tls`. What *is* tested is every decision `smtp.ts` makes about
 * TLS, which is where the bugs of this kind live: that `starttls` refuses to downgrade when the
 * server does not offer it, that octets arriving across the handshake are refused even when they
 * are a well-formed reply, and that a password is never offered on an unencrypted connection.
 *
 * The outbox is driven both ways — through the real client against the relay, and through a
 * scripted `open` that fails on demand, because a 421 on the fourth message is not something a
 * cooperative server will do on request.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addressOf,
  composeMessage,
  CRLF,
  displayOf,
  dotStuff,
  encodeHeaderValue,
  mailbox,
  makeOutbox,
  makeResendOutbox,
  messageDate,
  newMessageId,
  openSession,
  phrase,
  quotedPrintable,
  SmtpError,
  wrap,
} from "../src/mail/index.ts";
import type { Session, SmtpConfig } from "../src/mail/index.ts";
import type { Delivery } from "../src/api/index.ts";

/** A fixed instant, so every `Date` header in this file is a constant. */
const T0 = Date.parse("2026-09-05T12:34:56Z");
const FROM = "Manak <portal@example.test>";

const signin = (to = "someone@example.test"): Delivery => ({
  to,
  subject: "Your sign-in link",
  body: "Open the link below to sign in. It works once and expires in fifteen minutes.",
  link: "https://portal.example.test/s/PZ9m4Kx",
  reason: "signin",
});

/** Quoted-printable, backwards. Soft breaks vanish; `=XX` becomes the octet it names. */
const unqp = (text: string): string =>
  Buffer.from(
    text
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex as string, 16))),
    "binary",
  ).toString("utf8");

/** Encoded words, backwards. Whitespace between two of them is not part of the text. */
const unword = (text: string): string =>
  text
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, base) => Buffer.from(base as string, "base64").toString("utf8"));

/** The value of one header out of a composed message, unfolded onto a single line. */
const header = (text: string, name: string): string | undefined =>
  (text.split(`${CRLF}${CRLF}`)[0] ?? "")
    .replace(/\r\n[ \t]+/g, " ")
    .split(CRLF)
    .find((line) => line.startsWith(`${name}: `))
    ?.slice(name.length + 2);

/** Every header name, in the order they were written. */
const headerNames = (text: string): string[] =>
  (text.split(`${CRLF}${CRLF}`)[0] ?? "")
    .split(CRLF)
    .filter((line) => /^[A-Za-z]/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));

/** The body of a composed message, decoded back to the text that went in. */
const body = (text: string): string => unqp(text.split(`${CRLF}${CRLF}`).slice(1).join(`${CRLF}${CRLF}`));

type RelayOptions = {
  /** The lines after the first in the `EHLO` reply. Each becomes a `250-` continuation. */
  readonly extensions?: readonly string[];
  /** What to say on connect. `""` says nothing at all, which is how a stall is tested. */
  readonly greeting?: string;
  /**
   * Answer a command instead of the default. Returning `undefined` falls through.
   *
   * The whole failure surface of the protocol is reachable from here, which is why the relay
   * has no `failAt` option: a test that needs a 452 on the third `RCPT TO` writes that.
   */
  readonly reply?: (line: string, nth: number) => string | undefined;
  /** A command the relay drops the connection on instead of answering. Both halves matter. */
  readonly hangUpOn?: string;
  /** Write every reply one byte at a time, so no reader can assume a chunk is a line. */
  readonly dribble?: boolean;
};

type Relay = {
  readonly config: (extra?: Partial<SmtpConfig>) => SmtpConfig;
  /** Every command line received, across every connection, in order. */
  readonly said: () => readonly string[];
  /** Each accepted `DATA` payload, un-stuffed, exactly as the server received it. */
  readonly bodies: () => readonly string[];
  readonly connections: () => number;
  readonly close: () => Promise<void>;
};

/** A relay on a loopback port. Speaks the nine commands this client sends and nothing else. */
async function relay(options: RelayOptions = {}): Promise<Relay> {
  const said: string[] = [];
  const bodies: string[] = [];
  const live = new Set<Socket>();
  let connections = 0;

  const server: Server = createServer((socket) => {
    connections += 1;
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    socket.on("error", () => socket.destroy());
    let unread = "";
    let collecting = false;
    let message = "";
    let credentials = 0;
    const say = (text: string): void => {
      if (options.dribble !== true) socket.write(text);
      else for (const octet of Buffer.from(text, "utf8")) socket.write(Buffer.from([octet]));
    };
    say(options.greeting ?? `220 relay.test ESMTP ready${CRLF}`);
    socket.on("data", (chunk: Buffer) => {
      unread += chunk.toString("utf8");
      for (;;) {
        const end = unread.indexOf("\n");
        if (end < 0) return;
        const line = unread.slice(0, end).replace(/\r$/, "");
        unread = unread.slice(end + 1);
        if (collecting) {
          if (line === ".") {
            collecting = false;
            bodies.push(message);
            message = "";
            say(`250 2.0.0 queued as 7F3A${CRLF}`);
          } else {
            message += `${line.startsWith("..") ? line.slice(1) : line}${CRLF}`;
          }
          continue;
        }
        said.push(line);
        if (options.hangUpOn !== undefined && line.toUpperCase().startsWith(options.hangUpOn)) {
          socket.destroy();
          return;
        }
        if (credentials > 0) {
          credentials -= 1;
          say(credentials > 0 ? `334 UGFzc3dvcmQ6${CRLF}` : `235 2.7.0 authenticated${CRLF}`);
          continue;
        }
        const scripted = options.reply?.(line, said.length);
        if (scripted !== undefined) {
          say(scripted);
          continue;
        }
        const verb = (line.split(/\s+/)[0] ?? "").toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          const lines = ["relay.test greets you", ...(options.extensions ?? [])];
          say(lines.map((text, at) => `250${at === lines.length - 1 ? " " : "-"}${text}${CRLF}`).join(""));
        } else if (verb === "AUTH" && /^AUTH\s+LOGIN\s*$/i.test(line)) {
          credentials = 2;
          say(`334 VXNlcm5hbWU6${CRLF}`);
        } else if (verb === "AUTH") {
          say(`235 2.7.0 authenticated${CRLF}`);
        } else if (verb === "MAIL" || verb === "RCPT" || verb === "RSET" || verb === "NOOP") {
          say(`250 2.1.0 ok${CRLF}`);
        } else if (verb === "DATA") {
          collecting = true;
          say(`354 go ahead, end with a dot${CRLF}`);
        } else if (verb === "QUIT") {
          say(`221 2.0.0 goodbye${CRLF}`);
          socket.end();
        } else {
          say(`502 5.5.1 not implemented${CRLF}`);
        }
      }
    });
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return {
    config: (extra = {}) => ({ host: "127.0.0.1", port, encryption: "none", from: FROM, timeout: 2_000, ...extra }),
    said: () => said,
    bodies: () => bodies,
    connections: () => connections,
    close: async () => {
      for (const socket of live) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** The error a call threw, insisted upon. Assertions read better than a try/catch per test. */
async function refused(run: () => Promise<unknown>): Promise<SmtpError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof SmtpError, `expected an SmtpError, got ${String(error)}`);
    return error;
  }
  throw new Error("that was supposed to fail");
}

test("a composed message carries the nine headers, in order, and nothing else", () => {
  const composed = composeMessage(signin(), { from: FROM, now: T0, id: "fixed@example.test" });
  assert.deepEqual(headerNames(composed.text), [
    "From",
    "To",
    "Subject",
    "Date",
    "Message-ID",
    "MIME-Version",
    "Content-Type",
    "Content-Transfer-Encoding",
    "Auto-Submitted",
  ]);
  assert.equal(header(composed.text, "From"), "Manak <portal@example.test>");
  assert.equal(header(composed.text, "Date"), "Sat, 05 Sep 2026 12:34:56 +0000");
  assert.equal(header(composed.text, "Message-ID"), "<fixed@example.test>");
  assert.equal(header(composed.text, "Content-Transfer-Encoding"), "quoted-printable");
  // Not a formality: an out-of-office responder that replies to a sign-in link puts a live
  // credential in a mailbox nobody chose to involve.
  assert.equal(header(composed.text, "Auto-Submitted"), "auto-generated");
  assert.equal(composed.from, "portal@example.test");
  assert.equal(composed.to, "someone@example.test");
});

test("the envelope and the To header are the address, never the display name around it", () => {
  const composed = composeMessage(
    { ...signin("Someone Else <else@example.test>"), reason: "invite" },
    { from: FROM, now: T0 },
  );
  assert.equal(composed.to, "else@example.test");
  assert.equal(header(composed.text, "To"), "else@example.test");
  assert.equal(addressOf("Someone Else <else@example.test>"), "else@example.test");
  assert.equal(displayOf("Someone Else <else@example.test>"), "Someone Else");
  assert.equal(displayOf("else@example.test"), "");
});

test("a recipient carrying a newline is refused rather than escaped", () => {
  // The oldest bug in mail-sending code: the injected line ends `To:` and whatever follows
  // becomes a header of its own. Every one of these is a real shape somebody has tried.
  for (const attempt of [
    "victim@example.test\r\nBcc: everyone@example.test",
    "victim@example.test\nBcc: everyone@example.test",
    "victim@example.test, second@example.test",
    "victim@example.test>\r\nSubject: not this",
    "two addresses@example.test",
    "",
    `${"a".repeat(250)}@example.test`,
  ]) {
    assert.throws(
      () => composeMessage({ ...signin(attempt) }, { from: FROM, now: T0 }),
      /is not an address this can send to/,
      `accepted ${JSON.stringify(attempt)}`,
    );
  }
});

test("a single-label domain is accepted, because that is what a sidecar relay is called", () => {
  assert.equal(mailbox("manak@relay", "the recipient address"), "manak@relay");
  const composed = composeMessage(signin("someone@relay"), { from: "portal@relay", now: T0 });
  assert.equal(header(composed.text, "To"), "someone@relay");
  // The EHLO name and the Message-ID domain both come out of the sender, and neither may be
  // empty: a bare `@` in a Message-ID is refused by some filters outright.
  assert.match(newMessageId("portal@relay"), /^[0-9a-f-]{36}@relay$/);
});

test("a display name is quoted when it has to be and encoded when quoting would not help", () => {
  assert.equal(phrase("Manak"), "Manak");
  assert.equal(phrase("Manak Portal"), "Manak Portal");
  // A comma would otherwise read as the end of one address and the start of another.
  assert.equal(phrase("Manak, the portal"), '"Manak, the portal"');
  assert.equal(phrase('He said "hi"'), '"He said \\"hi\\""');
  // An encoded word may not be quoted; quoting one is how `=?UTF-8?B?` reaches an inbox.
  assert.equal(unword(phrase("मानक")), "मानक");
  assert.ok(!phrase("मानक").includes('"'));
  const composed = composeMessage(signin(), { from: "Manak, the portal <portal@example.test>", now: T0 });
  assert.equal(header(composed.text, "From"), '"Manak, the portal" <portal@example.test>');
});

test("a subject in another script survives, split on characters rather than on bytes", () => {
  // A word cut through a multi-byte sequence decodes to a replacement character, which is how
  // an event named in Devanagari arrives with a box in the middle of it.
  const name = "आपको मानक हैकाथॉन 2026 में आमंत्रित किया गया है — कृपया आएँ";
  const composed = composeMessage(
    { to: "someone@example.test", subject: `You have been invited to ${name}`, body: "b", reason: "invite" },
    { from: FROM, now: T0 },
  );
  const raw = header(composed.text, "Subject") as string;
  assert.equal(unword(raw), `You have been invited to ${name}`);
  assert.ok(!raw.includes("�"), "an encoded word was split through a character");
  for (const word of raw.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) {
    assert.ok(word.length <= 75, `an encoded word is ${word.length} characters, the limit is 75`);
  }
  for (const line of composed.text.split(CRLF)) {
    assert.ok(line.length <= 78, `a header line is ${line.length} characters: ${line}`);
  }

});

test("a subject that is already ASCII is left readable in the transcript", () => {
  const composed = composeMessage(signin(), { from: FROM, now: T0 });
  assert.equal(header(composed.text, "Subject"), "Your sign-in link");
  // The one ASCII case that still has to be encoded: a decoder would otherwise read it.
  assert.notEqual(encodeHeaderValue("a =?UTF-8?B?x?= b"), "a =?UTF-8?B?x?= b");
  assert.equal(unword(encodeHeaderValue("a =?UTF-8?B?x?= b")), "a =?UTF-8?B?x?= b");
  // A newline in a subject folds the header; it is collapsed rather than carried.
  assert.equal(encodeHeaderValue("two\r\nlines"), "two lines");
});

test("quoted-printable protects a space that a relay is allowed to strip", () => {
  // A relay may trim trailing whitespace, and a trimmed space is a changed message rather
  // than a tidied one — which matters most for the one thing that must survive byte for byte.
  assert.equal(quotedPrintable("trailing space \nnext"), `trailing space=20${CRLF}next`);
  assert.equal(quotedPrintable("tab\t\nnext"), `tab=09${CRLF}next`);
  assert.equal(quotedPrintable("a space in the middle"), "a space in the middle");
  assert.equal(quotedPrintable("ends with a space "), "ends with a space=20");
  assert.equal(quotedPrintable("an = sign"), "an =3D sign");
  assert.equal(quotedPrintable("मानक"), "=E0=A4=AE=E0=A4=BE=E0=A4=A8=E0=A4=95");
});

test("no quoted-printable line exceeds 76 characters and no soft break splits a triplet", () => {
  for (const text of [
    "x".repeat(500),
    "मानक".repeat(200),
    `${"y".repeat(74)}=${"z".repeat(74)}`,
    Array.from({ length: 40 }, (_, at) => `line ${at} ${"w".repeat(at)}`).join("\n"),
  ]) {
    const encoded = quotedPrintable(text);
    for (const line of encoded.split(CRLF)) {
      assert.ok(line.length <= 76, `a line is ${line.length} characters long`);
      // A soft break is a `=` at the end of a line; a split triplet would leave `=E` or `=`
      // followed by one hex digit, and the decoder would read the next line's first octet
      // as part of it. Anything ending in `=XX` is a whole triplet and is fine.
      assert.ok(!/=[0-9A-F]$/.test(line), `a triplet was split: ${line}`);
    }
    // A decoder's output is CRLF, because that is the canonical form on the wire; the text
    // that went in used bare newlines. Everything else must be identical.
    assert.equal(unqp(encoded).replace(/\r\n/g, "\n"), text.replace(/\r\n?/g, "\n"));

  }
});

test("a line that begins with a period is stuffed for the wire and not for the message", () => {
  assert.equal(dotStuff(`.hidden${CRLF}ok${CRLF}`), `..hidden${CRLF}ok${CRLF}`);
  assert.equal(dotStuff(`ok${CRLF}.${CRLF}`), `ok${CRLF}..${CRLF}`);
  assert.equal(dotStuff("no periods here"), "no periods here");
  // The composed message does not carry the extra period. An archived copy must not either.
  const composed = composeMessage({ ...signin(), body: ".hidden" }, { from: FROM, now: T0 });
  assert.ok(composed.text.includes(`${CRLF}${CRLF}.hidden`));
});

test("the wrapper breaks a paragraph and leaves a link whole", () => {
  const long = `https://portal.example.test/s/${"k".repeat(120)}`;
  assert.equal(wrap(long), long);
  const wrapped = wrap("word ".repeat(60).trim());
  for (const line of wrapped.split("\n")) assert.ok(line.length <= 72, `${line.length} columns`);
  assert.equal(wrapped.replace(/\n/g, " "), "word ".repeat(60).trim());
  // A blank line between paragraphs is a paragraph break and survives as one.
  assert.equal(wrap("one\n\ntwo"), "one\n\ntwo");
});

test("a body reaches the recipient as the words that went in, link on its own line", () => {
  const message = signin();
  const composed = composeMessage(message, { from: FROM, now: T0 });
  const decoded = body(composed.text);
  assert.equal(decoded.replace(/\r\n/g, "\n"), `${wrap(message.body)}\n\n${message.link as string}\n`);
  assert.ok(decoded.includes(message.link as string), "the link was mangled by the encoder");
  // No link, no trailing blank paragraph.
  const plain = composeMessage({ ...message, link: undefined }, { from: FROM, now: T0 });
  assert.equal(body(plain.text).replace(/\r\n/g, "\n"), wrap(message.body));
});

test("the date is UTC in the one spelling RFC 5322 fixes, whatever the machine thinks", () => {
  assert.equal(messageDate(Date.parse("2026-01-04T00:00:00Z")), "Sun, 04 Jan 2026 00:00:00 +0000");
  assert.equal(messageDate(Date.parse("2026-12-31T23:59:59Z")), "Thu, 31 Dec 2026 23:59:59 +0000");
  assert.equal(messageDate(0), "Thu, 01 Jan 1970 00:00:00 +0000");
  assert.throws(() => messageDate(Number.NaN), /not an instant/);
});

test("no two messages share a Message-ID", () => {
  // A counter would restart at one in a second container, and a duplicate Message-ID is how a
  // threading client hides the second copy of a message somebody is waiting for.
  const seen = new Set<string>();
  for (let n = 0; n < 500; n++) seen.add(newMessageId(FROM));
  assert.equal(seen.size, 500);
  for (const id of seen) assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]+@example\.test$/);
  assert.throws(
    () => composeMessage(signin(), { from: FROM, now: T0, id: "has<brackets>@example.test" }),
    /cannot contain brackets/,
  );
});

test("a sender that is not an address is refused by name, so the log names the setting", () => {
  assert.throws(() => composeMessage(signin(), { from: "not an address", now: T0 }), /MANAK_SMTP_FROM/);
  assert.throws(() => composeMessage(signin("bad"), { from: FROM, now: T0 }), /the recipient address/);
});

test("a message reaches a relay as the commands a submission actually is", async () => {
  const server = await relay();
  const session = await openSession(server.config());
  const composed = composeMessage(signin(), { from: FROM, now: T0, id: "fixed@example.test" });
  await session.send(composed);
  await session.quit();
  await server.close();
  assert.deepEqual(server.said(), [
    // The EHLO name comes out of the sender's own domain, not the host being dialled.
    "EHLO example.test",
    "MAIL FROM:<portal@example.test>",
    "RCPT TO:<someone@example.test>",
    "DATA",
    "QUIT",
  ]);
  assert.equal(session.delivered(), 1);
  assert.equal(session.encrypted, false);
});

test("the octets the relay receives are the message that was composed", async () => {
  const server = await relay();
  const session = await openSession(server.config());
  // A body line beginning with a period is the case dot-stuffing exists for: without it the
  // relay would end the message there and read the rest of it as commands.
  const stuffed = composeMessage(
    { ...signin(), body: ".hidden line\nand a normal one" },
    { from: FROM, now: T0, id: "a@example.test" },
  );
  const bare = composeMessage(
    { ...signin(), link: undefined, body: "no link here" },
    { from: FROM, now: T0, id: "b@example.test" },
  );
  await session.send(stuffed);
  await session.send(bare);
  await session.quit();
  await server.close();
  // Exactly one terminating CRLF either way. A message that gained a second would arrive with
  // an extra blank line in somebody's reading pane; one that lost it would not end at all.
  assert.equal(server.bodies()[0], stuffed.text);
  assert.equal(server.bodies()[1], `${bare.text}${CRLF}`);
  assert.ok((server.bodies()[0] as string).includes(`${CRLF}${CRLF}.hidden line`), "un-stuffed wrong");
});


test("a reply is one reply however the network chops it into chunks", async () => {
  // A reader that assumes one chunk per reply works perfectly against a fast local server and
  // fails against a real one. `dribble` writes a byte at a time, which is the worst case.
  const server = await relay({ dribble: true, extensions: ["SIZE 35882577", "PIPELINING"] });
  const session = await openSession(server.config());
  assert.deepEqual(session.extensions.get("SIZE"), ["35882577"]);
  assert.ok(session.extensions.has("PIPELINING"));
  await session.send(composeMessage(signin(), { from: FROM, now: T0 }));
  await session.quit();
  await server.close();
  assert.equal(server.bodies().length, 1);
});

test("both spellings of the AUTH line are read, including the one from the nineties", async () => {
  // `AUTH=PLAIN LOGIN` was a workaround for a client that got the syntax wrong and is still in
  // the wild. Reading only `AUTH PLAIN LOGIN` disables authentication against those servers,
  // and the symptom is a 530 nobody can explain.
  for (const line of ["AUTH PLAIN LOGIN", "AUTH=PLAIN LOGIN"]) {
    const server = await relay({ extensions: [line, "STARTTLS"] });
    const session = await openSession(server.config());
    assert.deepEqual(session.extensions.get("AUTH"), ["PLAIN", "LOGIN"], line);
    assert.ok(session.extensions.has("STARTTLS"));
    session.destroy();
    await server.close();
  }
});

test("one connection carries many messages", async () => {
  const server = await relay();
  const session = await openSession(server.config());
  for (const to of ["one@example.test", "two@example.test", "three@example.test"]) {
    await session.send(composeMessage(signin(to), { from: FROM, now: T0 }));
  }
  await session.quit();
  await server.close();
  assert.equal(session.delivered(), 3);
  assert.equal(server.connections(), 1);
  assert.deepEqual(
    server.said().filter((line) => line.startsWith("RCPT")),
    ["RCPT TO:<one@example.test>", "RCPT TO:<two@example.test>", "RCPT TO:<three@example.test>"],
  );
});

test("a 5xx is permanent and a 4xx is not, and both name the stage and quote the server", async () => {
  const cases: [string, number, boolean][] = [
    ["RCPT", 550, true],
    ["RCPT", 452, false],
    ["MAIL", 550, true],
    ["MAIL", 421, false],
    ["DATA", 554, true],
  ];
  for (const [verb, code, permanent] of cases) {
    const server = await relay({
      reply: (line) => (line.startsWith(verb) ? `${code} 5.1.1 the server says no${CRLF}` : undefined),
    });
    const session = await openSession(server.config());
    const fault = await refused(() => session.send(composeMessage(signin(), { from: FROM, now: T0 })));
    assert.equal(fault.code, code, `${verb} ${code}`);
    assert.equal(fault.permanent, permanent, `${verb} ${code} should ${permanent ? "" : "not "}be permanent`);
    assert.equal(fault.stage, verb === "RCPT" ? "rcpt to" : verb === "MAIL" ? "mail from" : "data");
    assert.match(fault.message, /the server says no/);
    session.destroy();
    await server.close();
  }
});

test("a greeting that is not an SMTP reply at all ends the connection", async () => {
  const server = await relay({ greeting: `relay.test here, how can I help${CRLF}` });
  const fault = await refused(() => openSession(server.config()));
  await server.close();
  assert.match(fault.message, /this is not an SMTP reply/);
  // Permanent: a server speaking something else will speak it again in four seconds.
  assert.equal(fault.permanent, true);
});

test("a server that says nothing is abandoned rather than waited on", async () => {
  const server = await relay({ greeting: "" });
  const fault = await refused(() => openSession(server.config({ timeout: 60 })));
  await server.close();
  assert.match(fault.message, /sent nothing for 60ms/);
  // Transient: a relay being restarted looks exactly like this.
  assert.equal(fault.permanent, false);
});

test("a broken connection mid-transaction is transient, not a lost message", async () => {
  const server = await relay({ hangUpOn: "DATA" });
  const session = await openSession(server.config());
  const fault = await refused(() => session.send(composeMessage(signin(), { from: FROM, now: T0 })));
  await server.close();
  assert.equal(fault.permanent, false);
  assert.equal(session.delivered(), 0);
});

test("starttls does not fall back to plaintext when the server does not offer it", async () => {
  // Downgrade-on-absence is how a mailer that looks encrypted in configuration sends
  // credentials in the clear on the day a relay is misconfigured.
  const server = await relay({ extensions: ["SIZE 1000"] });
  const fault = await refused(() => openSession(server.config({ encryption: "starttls" })));
  await server.close();
  assert.equal(fault.stage, "starttls");
  assert.equal(fault.permanent, true);
  // The message has to say what to change, because the operator's next move is a config edit.
  assert.match(fault.message, /MANAK_SMTP_ENCRYPTION/);
  assert.match(fault.message, /will not downgrade on its own/);
  assert.ok(!server.said().includes("STARTTLS"), "it asked anyway");
});

test("octets arriving across the STARTTLS handshake are refused, even a well-formed reply", async () => {
  // CVE-2011-0411, across a generation of mail clients. The dangerous half is the second case:
  // an injected `250` is a complete reply, so a check that only inspects the unparsed tail
  // finds nothing, and the reply is then handed over as the answer to the EHLO after the
  // handshake — which is where the attacker's capability list ends up being believed.
  for (const injected of ["NOOP not a reply", "250-AUTH PLAIN", "250 injected"]) {
    const server = await relay({
      extensions: ["STARTTLS"],
      reply: (line) => (line === "STARTTLS" ? `220 2.0.0 ready${CRLF}${injected}${CRLF}` : undefined),
    });
    const fault = await refused(() => openSession(server.config({ encryption: "starttls" })));
    await server.close();
    assert.equal(fault.stage, "starttls", injected);
    assert.equal(fault.permanent, true, injected);
    assert.match(fault.message, /between agreeing to STARTTLS and the handshake|not an SMTP reply/);
  }
});

test("a password is never offered on an unencrypted connection, and there is no override", async () => {
  const server = await relay({ extensions: ["AUTH PLAIN LOGIN"] });
  const fault = await refused(() => openSession(server.config({ user: "portal", password: "hunter2" })));
  await server.close();
  assert.equal(fault.stage, "auth");
  assert.equal(fault.permanent, true);
  assert.match(fault.message, /MANAK_SMTP_USER/);
  assert.match(fault.message, /readable by every hop/);
  assert.ok(
    server.said().every((line) => !line.toUpperCase().startsWith("AUTH")),
    "it tried to authenticate anyway",
  );
  // And the password is not in the message either, which is the other way this leaks.
  assert.ok(!fault.message.includes("hunter2"));
});

test("a rude hangup at QUIT is not a failure, because the messages are already accepted", async () => {
  const server = await relay({ hangUpOn: "QUIT" });
  const session = await openSession(server.config());
  await session.send(composeMessage(signin(), { from: FROM, now: T0 }));
  // No rejection. The relay answered 250 to the message; an error line here would name a
  // failure that did not happen.
  await session.quit();
  await server.close();
  assert.equal(session.delivered(), 1);
  assert.equal(server.bodies().length, 1);
});

test("a refused connection is transient, because a relay being restarted looks like this", async () => {
  const server = await relay();
  const config = server.config();
  await server.close();
  const fault = await refused(() => openSession(config));
  assert.equal(fault.permanent, false);
  assert.equal(fault.stage, "connect");
});

type Stub = {
  readonly open: (config: SmtpConfig) => Promise<Session>;
  readonly sent: { to: string; text: string }[];
  readonly opened: () => number;
  readonly quits: () => number;
  readonly destroys: () => number;
  /** Let a held `open` finish. Nothing is held unless `hold` was passed. */
  readonly release: () => void;
};

/**
 * A session that answers from a script.
 *
 * A cooperative relay will not give a 421 on the fourth message on request, and the outbox's
 * whole job is what it does when one does. `onOpen[n]` and `onSend[n]` are consulted for the
 * nth call; a hole or the end of the list means success.
 */
function stub(
  script: {
    readonly onOpen?: readonly (SmtpError | undefined)[];
    readonly onSend?: readonly (SmtpError | undefined)[];
    readonly hold?: boolean;
  } = {},
): Stub {
  const sent: { to: string; text: string }[] = [];
  let opened = 0;
  let sends = 0;
  let quits = 0;
  let destroys = 0;
  let release = (): void => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  return {
    sent,
    opened: () => opened,
    quits: () => quits,
    destroys: () => destroys,
    release: () => release(),
    open: async () => {
      const fault = script.onOpen?.[opened];
      opened += 1;
      if (script.hold === true) await held;
      if (fault !== undefined) throw fault;
      let delivered = 0;
      return {
        extensions: new Map<string, readonly string[]>(),
        encrypted: true,
        delivered: () => delivered,
        send: async ({ to, text }) => {
          const failure = script.onSend?.[sends];
          sends += 1;
          if (failure !== undefined) throw failure;
          sent.push({ to, text });
          delivered += 1;
        },
        quit: async () => {
          quits += 1;
        },
        destroy: () => {
          destroys += 1;
        },
      };
    },
  };
}

const transient = (stage = "mail from"): SmtpError => new SmtpError(451, `${stage}: 451 try later`, stage, false);
const permanent = (stage: string, code = 550): SmtpError =>
  new SmtpError(code, `${stage}: ${code} the server says never`, stage, true);

test("deliver returns before anything is sent, and returns for a message it refuses too", async () => {
  // The reason this package exists. A handler that awaited a mail server would make somebody's
  // sign-in take as long as the slowest hop to a mailbox provider.
  const lines: string[] = [];
  const fake = stub({ hold: true });
  const box = makeOutbox({
    smtp: { host: "relay.test", port: 25, encryption: "none", from: FROM },
    clock: { now: () => T0 },
    log: (line) => lines.push(line),
    capacity: 2,
    open: fake.open,
    sleep: async () => {},
  });
  box.deliver(signin("one@example.test"));
  box.deliver(signin("two@example.test"));
  // Full. The newest is refused, because the oldest are nearest the front of a queue that is
  // still draining and evicting one turns a backlog that would have cleared into a lost message.
  box.deliver(signin("three@example.test"));
  assert.equal(box.pending(), 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /refused the signin for three@example\.test/);
  assert.match(lines[0] as string, /2 messages are already waiting/);
  fake.release();
  await box.idle();
  assert.deepEqual(fake.sent.map((message) => message.to), ["one@example.test", "two@example.test"]);
  await box.close(0);
});

test("a queued message reaches a real relay, and the line that says so carries no link", async () => {
  const server = await relay();
  const lines: string[] = [];
  const box = makeOutbox({ smtp: server.config(), clock: { now: () => T0 }, log: (line) => lines.push(line) });
  box.deliver(signin());
  await box.idle();
  await box.close(0);
  await server.close();
  assert.equal(server.bodies().length, 1);
  assert.ok((server.bodies()[0] as string).includes("Subject: Your sign-in link"));
  // The connection was closed politely rather than dropped: a relay that is hung up on counts
  // it against the sender, and reputation is the one thing this product cannot repair.
  assert.equal(server.said().at(-1), "QUIT");
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /^\[mail\] sent the signin for someone@example\.test <[0-9a-f-]+@example\.test>$/);
  assert.ok(!(lines[0] as string).includes("/s/"), "the log line carries the sign-in link");
});

test("the Date header is the injected clock, not the wall clock", async () => {
  const fake = stub();
  const box = makeOutbox({
    smtp: { host: "relay.test", port: 25, encryption: "none", from: FROM },
    clock: { now: () => T0 },
    log: () => {},
    open: fake.open,
  });
  box.deliver(signin());
  await box.idle();
  await box.close(0);
  assert.match(fake.sent[0]?.text as string, /^Date: Sat, 05 Sep 2026 12:34:56 \+0000$/m);
});

/** An outbox over a scripted session, with the two seams closed so a test costs no seconds. */
function boxed(script: Parameters<typeof stub>[0], options: Partial<Parameters<typeof makeOutbox>[0]> = {}): {
  readonly box: ReturnType<typeof makeOutbox>;
  readonly fake: Stub;
  readonly lines: string[];
  readonly waited: number[];
} {
  const fake = stub(script);
  const lines: string[] = [];
  const waited: number[] = [];
  const box = makeOutbox({
    smtp: { host: "relay.test", port: 25, encryption: "none", from: FROM },
    clock: { now: () => T0 },
    log: (line) => lines.push(line),
    open: fake.open,
    sleep: async (ms) => {
      waited.push(ms);
    },
    ...options,
  });
  return { box, fake, lines, waited };
}

test("a transient failure is retried, the message still arrives, and the waits double", async () => {
  const { box, fake, lines, waited } = boxed({ onSend: [transient(), transient()] });
  box.deliver(signin());
  await box.idle();
  await box.close(0);
  assert.deepEqual(fake.sent.map((message) => message.to), ["someone@example.test"]);
  // Doubling from the configured first wait, and counted per consecutive failure rather than per
  // message: the thing being backed off is the relay, not this particular sign-in.
  assert.deepEqual(waited, [2_000, 4_000]);
  // Nothing is reused across a failure, so each attempt is a fresh connection.
  assert.equal(fake.opened(), 3);
  assert.equal(fake.destroys(), 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /^\[mail\] sent the signin for/);
});

test("a message is given up on after the attempt limit, and the line still carries no link", async () => {
  const { box, lines } = boxed({ onSend: [transient(), transient(), transient()] });
  box.deliver(signin());
  await box.idle();
  await box.close(0);
  assert.equal(box.pending(), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /gave up on the signin for someone@example\.test after 3 attempt\(s\)/);
  assert.match(lines[0] as string, /451 try later/);
  // The whole point of the header comment. Falling back to the log is the exact exposure the
  // operator configured a relay to remove, on the day somebody is already reading the logs.
  assert.ok(!(lines[0] as string).includes("PZ9m4Kx"), "the failure line carries the sign-in link");
});

test("a permanent refusal inside a transaction costs one message and not the queue", async () => {
  // A 550 on `RCPT TO` is a fact about one address. The message behind it is somebody else's.
  const { box, fake, lines } = boxed({ onSend: [permanent("rcpt to")] });
  box.deliver(signin("gone@example.test"));
  box.deliver(signin("here@example.test"));
  await box.idle();
  await box.close(0);
  assert.deepEqual(fake.sent.map((message) => message.to), ["here@example.test"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0] as string, /gave up on the signin for gone@example\.test after 1 attempt\(s\)/);
  assert.match(lines[1] as string, /sent the signin for here@example\.test/);
});

test("a permanent failure outside a transaction abandons the queue with one line", async () => {
  // A 535 on `AUTH` is not a fact about one message. Retrying per message would mean one
  // handshake per queued sign-in against a relay refusing all of them, and would bury the one
  // line the operator needs under fifty copies of itself.
  const { box, fake, lines } = boxed({ onOpen: [permanent("auth", 535)] });
  for (const to of ["a@example.test", "b@example.test", "c@example.test"]) box.deliver(signin(to));
  await box.idle();
  await box.close(0);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.opened(), 1, "the relay was tried once, not once per queued message");
  assert.equal(box.pending(), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /this relay cannot be used and retrying will not change that/);
  assert.match(lines[0] as string, /535 the server says never — 3 message\(s\) dropped unsent/);
});

test("an address the composer refuses is dropped without a connection being opened", async () => {
  const { box, fake, lines } = boxed({});
  box.deliver({ ...signin("nobody@"), to: "nobody@" });
  box.deliver(signin("real@example.test"));
  await box.idle();
  await box.close(0);
  assert.deepEqual(fake.sent.map((message) => message.to), ["real@example.test"]);
  assert.match(lines[0] as string, /gave up on the signin for nobody@ after 1 attempt\(s\)/);
  // Named as compose rather than as a protocol stage, because the same octets fail the same way
  // on every retry and no relay was ever consulted.
  assert.match(lines[0] as string, /compose: the recipient address is not an address this can send to/);
});

test("a connection is retired after the number of messages it was allowed", async () => {
  const { box, fake } = boxed({}, { perConnection: 2 });
  for (const to of ["a@example.test", "b@example.test", "c@example.test"]) box.deliver(signin(to));
  await box.idle();
  await box.close(0);
  assert.equal(fake.sent.length, 3);
  assert.equal(fake.opened(), 2, "a third message on a connection capped at two");
  // Retired politely both times: mid-drain, and again when the queue emptied.
  assert.equal(fake.quits(), 2);
  assert.equal(fake.destroys(), 0);
});

test("close abandons what the grace period did not cover, and says how many", async () => {
  const { box, fake, lines } = boxed({ hold: true });
  box.deliver(signin("a@example.test"));
  box.deliver(signin("b@example.test"));
  await box.close(5_000);
  assert.equal(box.pending(), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /^\[mail\] 2 message\(s\) were still queued after 5000ms and were dropped;/);
  assert.match(lines[0] as string, /whoever was waiting for one will have to ask again$/);
  // Closed means closed: a request that arrives during shutdown is told so rather than queued
  // onto a queue nothing will drain.
  box.deliver(signin("late@example.test"));
  assert.match(lines[1] as string, /refused the signin for late@example\.test: the outbox is closed/);
  fake.release();
});

test("an outbox that was never used closes without a word", async () => {
  const { box, fake, lines } = boxed({});
  await box.idle();
  await box.close();
  assert.deepEqual(lines, []);
  assert.equal(fake.opened(), 0);
});

test("makeResendOutbox queues, sends with idempotency key, and closes cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manak-resend-test-"));
  const path = join(dir, "outbox.json");
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options: any) => {
    calls += 1;
    assert.match(options.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
    if (calls === 1) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ id: "resend-msg-1" }), { status: 200 });
  };
  try {
    let now = 1_000_000;
    const clock = { now: () => { now += 5_000; return now; } };
    const box = makeResendOutbox("test-key", "demo@example.test", path, clock);
    box.deliver({ to: "person@example.test", subject: "Login", body: "Use this link", link: "https://example.test/token", reason: "signin" });
    assert.equal(box.pending(), 1);
    await box.idle();
    assert.equal(calls, 2);
    assert.equal(box.pending(), 0);
    const records = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(records[0].state, "delivered");
    assert.equal(records[0].message, undefined);
    await box.close();
    assert.equal(makeResendOutbox("test-key", "demo@example.test", path, clock).pending(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
