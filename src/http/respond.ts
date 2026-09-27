/**
 * Every response this server can send, built in one place.
 *
 * The reason to centralize it is that the interesting parts of a response are the parts
 * no handler thinks about: the headers that stop a browser guessing a content type, the
 * policy that makes an injected `<script>` inert, and the `Cache-Control` that keeps a
 * signed-in page out of a shared proxy. A handler returns a value; this module decides
 * what a value looks like on the wire, and there is nowhere else that constructs a
 * `Response`.
 *
 * **`no-store` on everything but assets.** A portal has nothing worth caching: every
 * page is either a form, a live dashboard, or a result that an organizer may unpublish.
 * The alternative — per-route cache directives — is a correctness question asked once
 * per route and answered wrong once, and the failure is a judge seeing another judge's
 * page from a proxy. The stylesheet is fingerprint-free and immutable-adjacent, so it
 * gets a short public lifetime and nothing else does.
 *
 * **The Content Security Policy forbids scripting entirely.** Not `script-src 'self'` —
 * `default-src 'none'`, with no `script-src` line at all, because a default that denies
 * everything is the stronger statement: there is no budget to relax later. There is no
 * client-side JavaScript in this product, so the policy describes the truth rather than
 * restricting an allowance, and it means a stored-XSS bug anywhere in the HTML layer
 * degrades to visible garbage instead of executing. It is paired with `form-action 'self'`,
 * which is what stops an injected form posting a judge's session somewhere else.
 *
 * Optional submission images may load over HTTPS. They never carry a referrer and are
 * not fetched by the server. All controls and local illustrations work without images.
 */

import type { ProblemDocument } from "../api/index.ts";
import { allowedMethods, PROBLEM_MEDIA_TYPE, retryAfterSeconds, STATUS_TEXT, toProblem } from "../api/index.ts";
import { problemPage } from "../view/index.ts";
import { setCookie } from "./wire.ts";
import type { CookieOptions } from "./wire.ts";

export const HTML_TYPE = "text/html; charset=utf-8";
export const JSON_TYPE_OUT = "application/json; charset=utf-8";
export const CSS_TYPE = "text/css; charset=utf-8";
export const CSV_TYPE = "text/csv; charset=utf-8";
export const JS_TYPE = "application/javascript; charset=utf-8";

/**
 * Headers on every response, including the failures.
 *
 * `X-Frame-Options` is redundant beside `frame-ancestors` for any browser released this
 * decade and is kept because the cost is 30 bytes and the failure it prevents — a
 * judge's console framed inside a page that overlays its own buttons — is a real one on
 * whatever browser is actually installed on a venue laptop.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' https:",
    "media-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  // No camera, no microphone, no geolocation, no anything: the product asks for none of
  // it, so an injected iframe or a compromised dependency — there are none — cannot ask
  // either. Written out rather than left to the default because the default is "allow".
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export type Extra = {
  /** Cookies to set, already rendered by `setCookie`. */
  readonly cookies?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
};

function headersFor(type: string | null, extra: Extra = {}): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  if (type !== null) headers.set("content-type", type);
  headers.set("cache-control", "no-store");
  for (const [name, value] of Object.entries(extra.headers ?? {})) headers.set(name, value);
  for (const cookie of extra.cookies ?? []) headers.append("set-cookie", cookie);
  return headers;
}

/**
 * A JSON body.
 *
 * Two spaces of indentation, deliberately: this is an API a person reads with `curl`
 * during a three-day event, and the bytes saved by minifying are not worth the round
 * trip through a formatter. `Content-Length` is left to the runtime.
 */
export function json(value: unknown, status = 200, extra: Extra = {}): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: headersFor(JSON_TYPE_OUT, extra),
  });
}

export function html(body: string, status = 200, extra: Extra = {}): Response {
  return new Response(body, {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: headersFor(HTML_TYPE, extra),
  });
}

export function empty(status = 204, extra: Extra = {}): Response {
  return new Response(null, {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: headersFor(null, extra),
  });
}

/**
 * A redirect after a successful write.
 *
 * 303 rather than 302: it tells the browser to follow with GET regardless of what the
 * original request was, which is the whole point of redirecting after a POST. A 302
 * leaves the method up to the browser's history, and a reload that re-posts a ballot is
 * a duplicate ballot.
 */
export function seeOther(location: string, extra: Extra = {}): Response {
  return new Response(null, {
    status: 303,
    statusText: STATUS_TEXT[303] as string,
    headers: headersFor(null, { ...extra, headers: { location, ...extra.headers } }),
  });
}

export function stylesheet(css: string, maxAge = 3600): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", CSS_TYPE);
  headers.set("cache-control", `public, max-age=${maxAge}`);
  return new Response(css, { status: 200, statusText: "OK", headers });
}

export function csvResponse(csv: string, filename: string): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", CSV_TYPE);
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("cache-control", "no-store");
  return new Response(csv, { status: 200, statusText: "OK", headers });
}

export function jsResponse(js: string, maxAge = 3600): Response {
  const headers = new Headers();
  headers.set("content-type", JS_TYPE);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", `public, max-age=${maxAge}`);
  return new Response(js, { status: 200, statusText: "OK", headers });
}

export function textResponse(text: string, maxAge = 3600): Response {
  const headers = new Headers();
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", `public, max-age=${maxAge}`);
  return new Response(text, { status: 200, statusText: "OK", headers });
}

/** One frame of a stream: a named event carrying JSON. */
export type StreamEvent = { readonly event?: string; readonly data: unknown; readonly id?: string };

/**
 * An async iterable as `text/event-stream`.
 *
 * Only the JSON API can use this. A browser would need an `EventSource`, which is
 * scripting, which the Content Security Policy forbids — so the HTML spelling of a
 * streaming operation renders its first frame as an ordinary page that asks for itself
 * again in a few seconds. That is a worse mechanism and a better product: it works on a
 * venue network that buffers proxies, and it keeps a judge's session out of a connection
 * held open for three days.
 *
 * `X-Accel-Buffering: no` is for the reverse proxy an operator is likely to put in front,
 * which otherwise holds frames until its own buffer fills and makes a live feed look
 * broken. Harmless everywhere else.
 */
export function eventStream(
  source: AsyncIterable<StreamEvent>,
  extra: Extra = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of source) {
          const lines = [
            ...(frame.id === undefined ? [] : [`id: ${frame.id}`]),
            ...(frame.event === undefined ? [] : [`event: ${frame.event}`]),
            `data: ${JSON.stringify(frame.data)}`,
            "",
            "",
          ];
          controller.enqueue(encoder.encode(lines.join("\n")));
        }
        controller.close();
      } catch (error) {
        // The connection is already open, so there is no status left to change. A
        // terminal frame is the only honest way to say the feed ended badly.
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ detail: "stream failed" })}\n\n`),
        );
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    statusText: STATUS_TEXT[200] ?? "OK",
    headers: headersFor("text/event-stream; charset=utf-8", {
      ...extra,
      headers: { "x-accel-buffering": "no", ...extra.headers },
    }),
  });
}

/**
 * The headers a refusal carries beyond its body.
 *
 * Both are answers the caller cannot work out for themselves: which methods a path does
 * accept, and how long the limiter's window has left. Derived from the error's own
 * detail rather than passed in, because a 429 built without a `Retry-After` looks
 * identical to a server that declined to say.
 */
export function refusalHeaders(error: unknown, now: number): Record<string, string> {
  const headers: Record<string, string> = {};
  const methods = allowedMethods(error);
  if (methods !== null) headers.allow = methods.join(", ");
  const retry = retryAfterSeconds(error, now);
  if (retry !== null) headers["retry-after"] = String(retry);
  return headers;
}

/** A problem document, as `application/problem+json`. */
export function problemJson(problem: ProblemDocument, extra: Extra = {}): Response {
  return new Response(`${JSON.stringify(problem, null, 2)}\n`, {
    status: problem.status,
    statusText: STATUS_TEXT[problem.status] ?? "",
    headers: headersFor(PROBLEM_MEDIA_TYPE, extra),
  });
}

/**
 * Anything thrown, rendered for whichever caller asked.
 *
 * One function so the two renderings cannot disagree about the status, which is the
 * mistake worth preventing: a JSON 404 and an HTML 403 for the same refusal would make
 * the isolation proof pass against one interface and lie about the other. The page
 * itself comes from `src/view`; this decides only which of the two to build.
 */
export function refusal(
  error: unknown,
  options: { wants: "json" | "html"; now: number; whoami?: string | null; extra?: Extra },
): Response {
  const problem = toProblem(error);
  const extra: Extra = {
    ...options.extra,
    headers: { ...refusalHeaders(error, options.now), ...options.extra?.headers },
  };
  return options.wants === "json"
    ? problemJson(problem, extra)
    : html(problemPage(problem, options.whoami ?? null), problem.status, extra);
}

/** The `Set-Cookie` value that grants a session, and the one that clears it. */
export function sessionCookie(
  name: string,
  token: string,
  options: CookieOptions,
): string {
  return setCookie(name, token, options);
}

export function clearedCookie(name: string, secure: boolean): string {
  return setCookie(name, "", { maxAge: 0, secure });
}
