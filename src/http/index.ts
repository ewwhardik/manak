/**
 * The transport layer's public surface.
 *
 * The top of the stack: `db → api → view → http`, and nothing imports from here except an
 * entry point and the tests. What that buys is stated plainly — the whole server is one
 * function of type `Serve`, so a test constructs a `Request`, calls it, and reads a
 * `Response`, and the socket in `server.ts` is a detail rather than a prerequisite.
 */

export { makeApp } from "./app.ts";
export type { AppOptions, LogRecord, Serve } from "./app.ts";

export {
  clearedCookie,
  CSS_TYPE,
  CSV_TYPE,
  csvResponse,
  empty,
  eventStream,
  html,
  HTML_TYPE,
  json,
  JSON_TYPE_OUT,
  JS_TYPE,
  jsResponse,
  problemJson,
  refusal,
  refusalHeaders,
  SECURITY_HEADERS,
  seeOther,
  sessionCookie,
  stylesheet,
  textResponse,
} from "./respond.ts";
export type { Extra, StreamEvent } from "./respond.ts";

export {
  DEFAULT_PORT,
  handler,
  HEADERS_TIMEOUT,
  KEEP_ALIVE_TIMEOUT,
  listen,
  MAX_HEADERS,
  REQUEST_TIMEOUT,
  send,
  toRequest,
} from "./server.ts";
export type { Listening, ListenOptions } from "./server.ts";

export {
  API_PREFIX,
  browserPath,
  credentialFrom,
  FORM_TYPE,
  JSON_TYPE,
  MAX_BODY,
  negotiate,
  normalizePath,
  parseCookies,
  queryInput,
  readSubmission,
  setCookie,
} from "./wire.ts";
export type { CookieOptions, Submission, Target, Wants } from "./wire.ts";
export { bundledAsset } from "./assets.ts";
export { HttpMetrics } from "./metrics.ts";
