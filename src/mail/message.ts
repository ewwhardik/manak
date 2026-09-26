/**
 * A `Delivery`, turned into the octets a mail server will accept.
 *
 * This module knows nothing about sockets and nothing about queues. It is a function from a
 * message the product wants sent to the text of an RFC 5322 message, which is what makes
 * every rule below assertable without a server anywhere. There are more of those rules than
 * "send an email" suggests, and each one is a way a message that looks right in a test
 * arrives wrong in somebody's inbox.
 *
 * **Header injection is refused rather than escaped.** `Delivery.to` reaches this file from a
 * form field. A carriage return inside it would end the `To:` header and let whatever came
 * after it become a `Bcc:` — the oldest bug in mail-sending code. The command layer already
 * validates that field as an address; it is validated again here, because the layer that
 * writes the bytes is the layer that has to be right about them, and because `Delivery` is a
 * public type that something else may one day construct.
 *
 * **The body is quoted-printable, always.** Not because the text needs it — a sign-in message
 * is ASCII — but because a subject names an event and an event is named by whoever typed it,
 * and because SMTP has a 1000-octet line limit that a long link inside a long paragraph can
 * approach. Encoding unconditionally means there is one path through this code rather than a
 * common one and a rare one, and the rare one is the one that ships broken.
 *
 * **A line that begins with a period ends the message.** That is the transmission layer's
 * rule rather than the format's, so `dotStuff` lives here beside the encoder that can produce
 * such a line and is called by `smtp.ts` at the moment it writes `DATA`.
 *
 * The cut line, stated plainly: plain text only. No `multipart/alternative`, no HTML part, no
 * attachments, no inline images. Every message this product sends is one paragraph and one
 * URL; mail clients linkify a bare URL; and a second copy of the same words in HTML is a
 * second thing that has to be kept in agreement with the first.
 */

import { randomUUID } from "node:crypto";

import type { Delivery } from "../api/index.ts";

/** The line ending SMTP requires, as escapes. A literal CR in a source file is banned. */
export const CRLF = "\r\n";

/** The longest line quoted-printable may emit, counting the soft break's own `=`. */
const QP_LIMIT = 76;

/**
 * What this module will accept as an address.
 *
 * Permissive on the domain and strict on everything that could break a header: no spaces, no
 * angle brackets, no comma, semicolon, colon, quote or backslash, and exactly one `@`. It is
 * not a test of whether an address exists — only the receiving server can answer that, and it
 * does, with a 5xx this product logs. It is a test of whether these octets can be written
 * into a header without changing the shape of the message.
 *
 * A single-label domain passes. `manak@relay` is what a sidecar mail container is actually
 * called, and rejecting it here would refuse a valid deployment in order to catch a typo the
 * relay catches better.
 */
const ADDRESS = /^[^\s<>@,;:"\\]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** Days and months in the two spellings RFC 5322 fixes, so no locale can reach a header. */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/**
 * The bare address out of a `From` that may carry a display name.
 *
 * `Manak <portal@example.com>` and `portal@example.com` are both things an operator writes in
 * a compose file, and the envelope needs the second form in either case.
 */
export function addressOf(mailbox: string): string {
  const angled = /<([^<>]*)>\s*$/.exec(mailbox.trim());
  return (angled === null ? mailbox : (angled[1] as string)).trim();
}

/** The display name in front of an angle-addressed mailbox, or an empty string. */
export function displayOf(mailbox: string): string {
  const trimmed = mailbox.trim();
  const at = trimmed.lastIndexOf("<");
  return at <= 0 ? "" : trimmed.slice(0, at).trim().replace(/^"(.*)"$/, "$1");
}

/**
 * The address, or a thrown error naming the field it came from.
 *
 * Throws rather than returning a result, and the outbox treats a throw from this file as
 * permanent: the same octets will fail the same way on every retry, so a message this refuses
 * is a message to report and drop rather than one to send again in four seconds.
 */
export function mailbox(value: string, field: string): string {
  const address = addressOf(value);
  if (address.length === 0 || address.length > 254 || !ADDRESS.test(address)) {
    throw new Error(`${field} is not an address this can send to: ${JSON.stringify(value)}`);
  }
  return address;
}

/** An instant as RFC 5322 spells one. Always UTC: a portal has no timezone of its own. */
export function messageDate(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(at)) throw new RangeError(`not an instant: ${String(at)}`);
  return (
    `${DAYS[d.getUTCDay()] as string}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] as string} ` +
    `${pad(d.getUTCFullYear(), 4)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())} +0000`
  );
}

/**
 * A globally unique `Message-ID`, in the domain the mail claims to come from.
 *
 * A UUID rather than a counter, because two containers behind one relay would otherwise both
 * start at one, and a duplicate `Message-ID` is how a threading mail client hides the second
 * copy of a message somebody is waiting for. `randomUUID` and not `Math.random`, which the
 * source scan forbids across `src/` and which is the wrong tool for an identity anyway.
 */
export function newMessageId(from: string): string {
  const domain = addressOf(from).split("@")[1] ?? "manak.invalid";
  return `${randomUUID()}@${domain}`;
}

/** True for text a header can hold verbatim: printable ASCII, and nothing that folds. */
const plainAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text) && !text.includes("=?");

/**
 * A header value, encoded if it has to be.
 *
 * RFC 2047 `=?UTF-8?B?...?=` words, split so that no encoded word exceeds 75 characters, and
 * split on *character* boundaries rather than on bytes: a word cut through the middle of a
 * multi-byte sequence decodes to a replacement character, which is how an event named in
 * Devanagari or with an em dash in it arrives with a box in the middle of it.
 *
 * Pure ASCII passes through untouched, which keeps `Subject: Your sign-in link` readable in a
 * transcript. The `=?` guard is the one case where ASCII still has to be encoded: a subject
 * that happened to contain that sequence would otherwise be decoded by the recipient.
 */
export function encodeHeaderValue(value: string): string {
  const collapsed = value.replace(/[\r\n\t]+/g, " ").trim();
  if (plainAscii(collapsed)) return collapsed;
  // Arithmetic, not a guess. `=?UTF-8?B?` and `?=` spend 12 characters, base64 turns three
  // octets into four, and the longest header name this file writes is `Subject: ` at nine —
  // so 42 octets per group gives a 68-character word, a 77-character first line and a
  // 69-character continuation. That is inside the 75 an encoded word is allowed and inside
  // the 78 a line is recommended, which some naive parsers still treat as a hard limit.
  const words: string[] = [];
  let group = "";
  for (const character of collapsed) {
    if (Buffer.byteLength(group + character, "utf8") > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(group, "utf8").toString("base64")}?=`);
      group = "";
    }
    group += character;
  }

  if (group !== "") words.push(`=?UTF-8?B?${Buffer.from(group, "utf8").toString("base64")}?=`);
  // Folded with a space between words: a decoder joins adjacent encoded words without the
  // whitespace, which is exactly what a subject split mid-sentence needs.
  return words.join(`${CRLF} `);
}

/**
 * A display name as a `From` header may carry one.
 *
 * Quoted whenever it holds anything outside RFC 5322's `atext` plus space, because a name like
 * `Manak, the portal` would otherwise read as two addresses and a name containing a bracket
 * would read as a comment. Non-ASCII goes through `encodeHeaderValue` instead: an encoded word
 * may not be quoted, and quoting one is how a display name arrives with `=?UTF-8?B?` in it.
 */
export function phrase(name: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").trim();
  if (clean === "") return "";
  if (!plainAscii(clean)) return encodeHeaderValue(clean);
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~. ]+$/.test(clean)) return clean;
  return `"${clean.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Quoted-printable, per RFC 2045, over the UTF-8 octets of the text.
 *
 * Three rules, and the second and third are the ones a naive encoder gets wrong.
 *
 * Anything that is not printable ASCII becomes `=XX`, and so does `=` itself. A space or tab
 * is literal *except* immediately before a line break, where it becomes `=20` or `=09`: relays
 * are permitted to strip trailing whitespace, and a stripped space is a changed message rather
 * than a tidied one. It is decided by looking ahead at the next octet rather than by fixing the
 * line afterwards, because the fix adds two characters to a line that may already be full.
 *
 * No output line exceeds 76 characters. A line that would is broken with a soft break — a `=`
 * and a CRLF, which the decoder removes — and the break never falls inside a `=XX` triplet,
 * because the triplet is appended as one unit that either fits or moves whole.
 */
export function quotedPrintable(text: string): string {
  const octets = Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
  const lines: string[] = [];
  let line = "";
  const append = (piece: string): void => {
    if (line.length + piece.length > QP_LIMIT - 1) {
      lines.push(`${line}=`);
      line = "";
    }
    line += piece;
  };
  const hex = (byte: number): string => `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  for (let index = 0; index < octets.length; index++) {
    const byte = octets[index] as number;
    if (byte === 0x0a) {
      lines.push(line);
      line = "";
    } else if (byte === 0x20 || byte === 0x09) {
      const next = octets[index + 1];
      append(next === undefined || next === 0x0a ? hex(byte) : String.fromCharCode(byte));
    } else if (byte === 0x3d || byte < 0x20 || byte > 0x7e) {
      append(hex(byte));
    } else {
      append(String.fromCharCode(byte));
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * Escape the one sequence that would end the message early.
 *
 * SMTP ends `DATA` at a line containing a single period, so a body line that begins with one
 * has another prepended and the receiver removes it. Done here rather than in the encoder
 * because it is a fact about the transmission and not about the message: an archived copy of
 * the same message must not carry the extra period.
 */
export function dotStuff(message: string): string {
  return message.replace(/^\./gm, "..");
}

/**
 * Break a paragraph at spaces, so a mail client that does not reflow still reads well.
 *
 * 72 columns rather than 76, leaving room for the `> ` a reply will put in front of every
 * line. A word longer than the width is left whole and overruns: the only such word this
 * product sends is a URL, and a broken URL is worse than a long line by a wide margin.
 */
export function wrap(text: string, width = 72): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** A message ready for the wire, with the envelope the server has to be told separately. */
export type Composed = {
  /** The envelope sender, bare. What goes in `MAIL FROM`. */
  readonly from: string;
  /** The envelope recipient, bare. What goes in `RCPT TO`. */
  readonly to: string;
  /** `Message-ID` without its angle brackets, for a log line that can be traced. */
  readonly id: string;
  /** Headers, a blank line, and the encoded body. CRLF throughout, no terminating dot. */
  readonly text: string;
};

/**
 * The whole message, from a `Delivery` and the operator's `From`.
 *
 * The header set is deliberately short. Every one of these is here because leaving it out has
 * a consequence: no `Date` or `Message-ID` and a spam filter scores the message as machine
 * output from a badly written script, which is what it would then be; no `MIME-Version` and
 * the quoted-printable body is displayed as literal `=20`; and no `Auto-Submitted` and an
 * out-of-office responder replies to a sign-in link, which puts a live credential in a mailbox
 * nobody asked to involve.
 *
 * There is no `Reply-To` and that is a decision rather than an omission: nothing on the other
 * end of this address reads mail, and offering a reply address a person will use is worse than
 * offering none. The body says to ask the organizer.
 */
export function composeMessage(
  message: Delivery,
  options: { readonly from: string; readonly now: number; readonly id?: string },
): Composed {
  const sender = mailbox(options.from, "MANAK_SMTP_FROM");
  const recipient = mailbox(message.to, "the recipient address");
  const id = options.id ?? newMessageId(sender);
  if (/[<>\r\n]/.test(id)) throw new Error(`a Message-ID cannot contain brackets: ${id}`);
  const shown = phrase(displayOf(options.from));
  const body = message.link === undefined
    ? wrap(message.body)
    : `${wrap(message.body)}\n\n${message.link}\n`;
  const headers = [
    ["From", shown === "" ? sender : `${shown} <${sender}>`],
    ["To", recipient],
    ["Subject", encodeHeaderValue(message.subject)],
    ["Date", messageDate(options.now)],
    ["Message-ID", `<${id}>`],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Transfer-Encoding", "quoted-printable"],
    ["Auto-Submitted", "auto-generated"],
  ];
  const text = [
    ...headers.map(([name, value]) => `${name as string}: ${value as string}`),
    "",
    quotedPrintable(body),
  ].join(CRLF);
  return { from: sender, to: recipient, id, text };
}
