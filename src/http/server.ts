/**
 * The socket, and the only file in this repository that knows one exists.
 *
 * Everything above this line is a function from `Request` to `Response`, which is why
 * `tests/http.test.ts` can exercise the whole product — routing, sessions, the limiter,
 * the isolation rule — without binding a port or waiting on a network. This module is the
 * adapter that makes that true: it turns an `IncomingMessage` into a WHATWG `Request`,
 * hands it to `makeApp`'s handler, and writes the answer back. It contains no policy. If a
 * decision looks like it belongs here, it belongs in `app.ts`.
 *
 * Three things it does do, because they have nowhere else to live.
 *
 * **The request target is treated as a path, never as a URL.** `new URL("//evil.com/x",
 * base)` resolves to a different host, and `//evil.com/x` is a legal origin-form target a
 * client can send. Concatenating the target onto a complete origin string instead makes it
 * a path in every case, so the worst a hostile target achieves is a 404.
 *
 * **The `Host` header is checked before it is believed.** Nothing in this product builds an
 * absolute URL from it — a redirect after a form post is a path — but an unparseable
 * authority would throw inside `new URL` and turn a fuzzer's request into a 500 with a
 * stack trace in the operator's log. An implausible host falls back to `localhost`.
 *
 * **The timeouts are Node's, tightened.** A held-open connection that never finishes its
 * headers costs a socket and nothing else, and the defaults are generous enough that a
 * laptop can exhaust a small container. These are the one piece of hardening that cannot
 * be expressed as a command declaration.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RuleError, systemClock } from "../db/index.ts";
import type { AppOptions, Serve } from "./app.ts";
import { makeApp } from "./app.ts";
import { refusal } from "./respond.ts";

/** How long a client may take to finish sending its headers. */
export const HEADERS_TIMEOUT = 15_000;
/** How long a client may take to finish sending the whole request. Not the response. */
export const REQUEST_TIMEOUT = 30_000;
/** How long an idle keep-alive socket is kept. */
export const KEEP_ALIVE_TIMEOUT = 5_000;
/** More headers than this is not a browser. */
export const MAX_HEADERS = 64;

export const DEFAULT_PORT = 8080;

/** A host and optional port, or a bracketed IPv6 literal. Anything else is not believed. */
const AUTHORITY = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * One Node request as a WHATWG `Request`.
 *
 * The body is passed as a stream rather than buffered, so `readSubmission`'s size cap is
 * still enforced as the bytes arrive: a 40 MB upload is cancelled after 256 KB instead of
 * being read into memory and then refused. `duplex: "half"` is what a streamed body
 * requires, and it is spelled through a widened type because the DOM lib this project
 * compiles against does not know about it yet.
 *
 * The scheme is always `http:`. A Node server without TLS is not serving HTTPS, and an
 * operator who terminates TLS in front of this sets `trustProxy` — or `secure` — in
 * `AppOptions`, which is where that decision already lives.
 */
export function toRequest(message: IncomingMessage): Request {
  const host = message.headers.host ?? "";
  const origin = `http://${AUTHORITY.test(host) ? host : "localhost"}`;
  const target = message.url ?? "/";
  const url = `${origin}${target.startsWith("/") ? target : `/${target}`}`;

  const headers = new Headers();
  const raw = message.rawHeaders;
  for (let at = 0; at + 1 < raw.length; at += 2) {
    headers.append(raw[at] as string, raw[at + 1] as string);
  }

  const method = message.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(message) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * The response, written to the socket.
 *
 * `getSetCookie` rather than the header map, because two `Set-Cookie` values are two
 * headers and joining them with a comma produces one cookie with a comma in it — a bug
 * that only appears on the request that both clears a session and grants another.
 *
 * The headers are flushed before the body so a streaming response's 200 arrives with the
 * connection rather than with its first frame, which for a live feed may be seconds later.
 */
export async function send(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;

  res.writeHead(response.status, response.statusText, headers);
  res.flushHeaders();
  if (response.body === null) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } catch {
    // The caller hung up, or the socket died mid-frame. There is no status left to change
    // and nobody to tell; `pipeline` has already destroyed both ends.
    if (!res.writableEnded) res.end();
  }
}

/**
 * A `node:http` listener over one `Serve`.
 *
 * The only error this can see is a request too malformed to become a `Request` at all,
 * because `Serve` catches everything else and answers with a problem document. It is
 * answered as JSON: a target a `new URL` cannot parse is not a target a browser produced.
 */
export function handler(serve: Serve): (message: IncomingMessage, res: ServerResponse) => void {
  return (message, res) => {
    void (async (): Promise<void> => {
      let response: Response;
      try {
        response = await serve(toRequest(message), message.socket.remoteAddress ?? "");
      } catch {
        response = refusal(new RuleError("request.malformed", "the request target is not a path."), {
          wants: "json",
          now: systemClock.now(),
        });
      }
      await send(response, res);
    })();
  };
}

export type ListenOptions = AppOptions & {
  readonly port?: number;
  /** Defaults to every interface, because the usual deployment is a container. */
  readonly host?: string;
};

export type Listening = {
  /** Where to point a browser. `0.0.0.0` is reported as `localhost`, which is usable. */
  readonly url: string;
  readonly port: number;
  readonly server: Server;
  /**
   * Stop listening, then stop waiting.
   *
   * Idle keep-alive sockets are closed at once; anything still open is given `grace`
   * milliseconds and then cut. Without the second half a live dashboard feed — a response
   * that by design never ends — would hold the process open through SIGTERM and the
   * container would be killed rather than stopped.
   */
  close: (grace?: number) => Promise<void>;
};

export async function listen(options: ListenOptions): Promise<Listening> {
  const server = createServer(handler(makeApp(options)));
  server.headersTimeout = HEADERS_TIMEOUT;
  server.requestTimeout = REQUEST_TIMEOUT;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT;
  server.maxHeadersCount = MAX_HEADERS;

  const host = options.host ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => reject(error);
    server.once("error", fail);
    // Port 0 asks the operating system for a free one, which is how a test starts a real
    // server without agreeing a port number with every other test in the file.
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.removeListener("error", fail);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? DEFAULT_PORT);
  return {
    url: `http://${host === "0.0.0.0" || host === "::" ? "localhost" : host}:${port}`,
    port,
    server,
    close: (grace = 1000) =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
        const cut = setTimeout(() => server.closeAllConnections(), Math.max(0, grace));
        cut.unref();
      }),
  };
}
