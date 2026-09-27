/**
 * The wire: bytes arriving on a socket, turned into values a command can be given.
 *
 * Nothing here knows what any command does. It answers four questions — which rendering
 * the caller wants, who they claim to be, what they sent, and how large — and refuses
 * anything it cannot answer, in the same problem-document shape the rest of the layer
 * uses so a client has one error format to parse.
 *
 * **The `/api` prefix is the negotiation.** A request to `/api/events/x` gets JSON; the
 * same route without the prefix renders HTML. The obvious alternative is to read `Accept`
 * on one path, and it was rejected for three reasons: a response that varies by header
 * needs `Vary: Accept` and is then a cache bug waiting for a proxy to forget it; a route
 * that behaves differently in curl than in a browser is a route nobody can debug over
 * chat; and a form's `action` is a fixed string anyway, so the browser gains nothing from
 * negotiation it cannot express. The cost is that every route has two spellings, which is
 * also the benefit: `POST /events/x/projects` from a form and `POST /api/events/x/projects`
 * from a script reach one handler, one capability check and one ledger entry.
 *
 * There is no CORS header anywhere in this layer, deliberately. A self-hosted portal is
 * reached by its own pages; permitting cross-origin reads would make every judge's browser
 * a confused deputy for any page they happen to have open, and the feature nobody asked
 * for is not worth that.
 */

import { RuleError } from "../db/index.ts";
import type { RawInput } from "../api/index.ts";

/** The JSON API lives under this prefix; the same routes without it answer HTML. */
export const API_PREFIX = "/api";

/** Bodies larger than this are refused unread. A ballot is a few hundred bytes. */
export const MAX_BODY = 256 * 1024;

export type Wants = "json" | "html";

export type Target = {
  /** Which rendering to produce. */
  readonly wants: Wants;
  /** The path as the registry declares it, prefix included. */
  readonly canonical: string;
  /** The path as the caller wrote it, normalized. */
  readonly pathname: string;
};

/** A trailing slash is the same resource. Everything else is left alone. */
export function normalizePath(pathname: string): string {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed === "" ? "/" : trimmed;
}

export function negotiate(pathname: string): Target {
  const path = normalizePath(pathname);
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
    return { wants: "json", canonical: path, pathname: path };
  }
  return {
    wants: "html",
    canonical: path === "/" ? API_PREFIX : `${API_PREFIX}${path}`,
    pathname: path,
  };
}

/** The browser-facing spelling of a declared route, for a form's `action`. */
export function browserPath(canonical: string): string {
  if (canonical === API_PREFIX) return "/";
  return canonical.startsWith(`${API_PREFIX}/`) ? canonical.slice(API_PREFIX.length) : canonical;
}

/**
 * The cookies on a request, by name.
 *
 * Tolerant of the shapes browsers actually send — a stray space, a value containing `=`,
 * an empty pair from a trailing semicolon — because a malformed `Cookie` header is not
 * worth failing a request over. The session token is checked against the database
 * regardless of how well-formed its wrapper was.
 */
export function parseCookies(header: string | null): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    if (name === "") continue;
    out[name] = decodeCookieValue(pair.slice(at + 1).trim());
  }
  return out;
}

function decodeCookieValue(value: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  try {
    return decodeURIComponent(unquoted);
  } catch {
    return unquoted;
  }
}

export type CookieOptions = {
  /** Seconds. Zero clears the cookie, which is how signing out is expressed. */
  readonly maxAge: number;
  /** Set only when the request arrived over TLS. See `SESSION_COOKIE`'s own note. */
  readonly secure: boolean;
  readonly path?: string;
};

/**
 * A `Set-Cookie` value.
 *
 * `SameSite=Lax` rather than `Strict`: a magic link arrives from a mail client, which is
 * a cross-site navigation, and under `Strict` the cookie set by following that link would
 * not be sent on the redirect that follows it — so signing in would appear to fail. `Lax`
 * still withholds the cookie from cross-site POSTs, which is the case that matters.
 */
export function setCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The session token the caller presented, or null.
 *
 * `Authorization` wins over the cookie. A caller who sends a bearer token is being
 * explicit, and a stale cookie left in a shared browser silently overriding it is a
 * confusing way to act as the wrong person.
 */
export function credentialFrom(request: Request, cookieName: string): string | null {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer" && rest.length > 0) return rest.join(" ");
  }
  const cookie = parseCookies(request.headers.get("cookie"))[cookieName];
  return cookie === undefined || cookie === "" ? null : cookie;
}

/**
 * Keys that must never be set on an object assembled from a request.
 *
 * `parseInput` reads with `Object.hasOwn`, so a `__proto__` key would be inert there — but
 * "inert in the one reader we have today" is not a property worth relying on, and a
 * submission that names one of these is not a submission anybody made by accident.
 */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

function assertUsableKey(key: string): void {
  if (FORBIDDEN_KEYS.includes(key)) {
    throw new RuleError("request.malformed", `${key} is not a field name.`, { field: key });
  }
}

/**
 * Text pairs, with one level of dotted nesting.
 *
 * `scores.design=4` becomes `{ scores: { design: "4" } }`, because that is how a rubric
 * ballot has to arrive from an HTML form and the `scores` field kind expects an object.
 * One level and no arrays-by-index: anything deeper is a shape no field kind accepts, so
 * supporting it would only mean building objects nothing reads.
 */
function collect(pairs: Iterable<[string, string]>): RawInput {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of pairs) {
    assertUsableKey(key);
    const at = key.indexOf(".");
    if (at < 0) {
      // A repeated key becomes an array, which is how a multi-select arrives.
      const existing = out[key];
      if (existing === undefined) out[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else out[key] = [existing, value];
      continue;
    }
    const [head, tail] = [key.slice(0, at), key.slice(at + 1)];
    assertUsableKey(head);
    assertUsableKey(tail);
    if (tail.includes(".")) {
      throw new RuleError("request.malformed", `${key} nests deeper than any field accepts.`);
    }
    const nested = (out[head] ??= Object.create(null) as Record<string, unknown>);
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
      throw new RuleError("request.malformed", `${head} was sent both as a value and as a group.`);
    }
    (nested as Record<string, unknown>)[tail] = value;
  }
  return out as RawInput;
}

/** A GET's input is its query string, and a query string is all text. */
export function queryInput(url: URL): RawInput {
  return collect(url.searchParams);
}

export type Submission = {
  readonly raw: RawInput;
  /**
   * Whether `"3"` may become `3`. True for a form and a query string, which carry no
   * types; false for a JSON body, where a string was a deliberate choice by whoever
   * wrote the client and pretending otherwise hides their bug.
   */
  readonly coerce: boolean;
};

/** The media types a write may arrive as. Everything else is refused before parsing. */
export const FORM_TYPE = "application/x-www-form-urlencoded";
export const JSON_TYPE = "application/json";

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The body, capped.
 *
 * The declared length is checked first so an oversized upload is refused before it is
 * read, and the actual byte count is checked as it arrives because `Content-Length` is a
 * claim by the sender. `TextDecoder` with `fatal` rejects invalid UTF-8 rather than
 * substituting replacement characters, which would otherwise turn broken bytes into a
 * plausible-looking string that fails a pattern check for the wrong reason.
 */
async function readText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RuleError("request.malformed", "the body is not valid UTF-8.");
  }
}

function tooLarge(limit: number): RuleError {
  return new RuleError(
    "request.tooLarge",
    `the body is larger than the ${limit}-byte limit.`,
    { limit },
  );
}

/**
 * Everything the caller sent, in one record, with the path parameters merged over it.
 *
 * The path wins on a collision. A route that names `:event` and a body that also carries
 * `event` is a caller trying two answers to one question, and the URL is the one the
 * capability check already used — so it is the one that has to be true.
 */
export async function readSubmission(
  request: Request,
  url: URL,
  params: Readonly<Record<string, string>> = {},
  limit = MAX_BODY,
): Promise<Submission> {
  const body = await readBody(request, url, limit);
  const raw = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body.raw)) {
    assertUsableKey(key);
    raw[key] = value;
  }
  for (const [key, value] of Object.entries(params)) {
    assertUsableKey(key);
    raw[key] = value;
  }
  return { raw: raw as RawInput, coerce: body.coerce };
}

async function readBody(request: Request, url: URL, limit: number): Promise<Submission> {
  if (request.method !== "POST") return { raw: queryInput(url), coerce: true };
  const type = mediaType(request);
  const text = await readText(request, limit);
  if (type === FORM_TYPE) return { raw: collect(new URLSearchParams(text)), coerce: true };
  if (type === JSON_TYPE) return { raw: jsonBody(text), coerce: false };
  // A write with no body at all is legitimate: `POST /events/:event/results/publish` takes
  // its whole input from the path, and a browser form with no fields sends nothing.
  if (type === "" && text.trim() === "") return { raw: Object.create(null) as RawInput, coerce: true };
  throw new RuleError(
    "request.mediaType",
    `${type === "" ? "a body with no content type" : type} cannot be read. Send ${JSON_TYPE} ` +
      `or ${FORM_TYPE}.`,
    { received: type },
  );
}

function jsonBody(text: string): RawInput {
  if (text.trim() === "") return Object.create(null) as RawInput;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // `JSON.parse`'s own message is deliberately dropped. It names a character offset in a
    // body the caller already holds, so it tells them nothing they cannot see, and it is a
    // V8 string that changes between Node versions — which would make a problem document
    // this product publishes depend on the runtime it happens to be built against.
    throw new RuleError("request.malformed", "the body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RuleError("request.malformed", "a JSON body must be an object of fields.");
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    assertUsableKey(key);
    out[key] = value;
  }
  return out as RawInput;
}
