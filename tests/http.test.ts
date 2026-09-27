/**
 * The transport layer, end to end, through the real registry and the real views.
 *
 * These tests construct a `Request` and read a `Response`. There is no socket, because
 * `makeApp` returns a plain function of type `Serve` — which is the reason the seam exists,
 * and the reason this file can assert on a `Set-Cookie` header and a 303 target without
 * binding a port or sleeping.
 *
 * Organised by claim, like `tests/db.test.ts`, and four of the claims are the ones the
 * product's pitch rests on:
 *
 *   - **A sign-in link is not spent by fetching it.** Asserted by fetching it and then
 *     checking the ledger did not grow, which is a stronger statement than checking the
 *     response body, because a scanner does not read bodies either.
 *   - **Not yours means not found.** The same request is sent as a stranger, a participant
 *     and an organizer, and the three answers are 404, 403 and 200. The stranger's 404 is
 *     the load-bearing one: 403 would confirm the event exists.
 *   - **Founding is configuration, not achievement.** An organizer of an existing event is
 *     refused `POST /api/events`; the same account is allowed once its address is in the
 *     `founders` option, and nothing in the database changed between the two.
 *   - **Every refusal is one of the declared shapes.** A problem document, with a `code`
 *     the error table knows, and `Retry-After` present exactly when the refusal is a limit.
 *
 * The same request is sent twice throughout, once with `Accept: application/json` and once
 * as a browser would, because the whole claim of the command layer is that those are two
 * renderings of one declaration rather than two implementations.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/registry.ts";
import { SESSION_COOKIE } from "../src/api/capability.ts";
import { createEvent, createSession, ledgerLength, LIMITS, MS, upsertAccount } from "../src/db/index.ts";
import type { Delivery } from "../src/api/index.ts";
import { makeApp } from "../src/http/app.ts";
import type { LogRecord, Serve } from "../src/http/app.ts";
import { MAX_BODY } from "../src/http/wire.ts";
import { eventStream, SECURITY_HEADERS } from "../src/http/respond.ts";
import { VIEWS } from "../src/view/views.ts";
import { STYLESHEET_PATH } from "../src/view/html.ts";
import { T0, world } from "./support/world.ts";
import type { World } from "./support/world.ts";

const REGISTRY = makeRegistry(ALL_COMMANDS);
const ORIGIN = "https://portal.test";

type Rig = {
  world: World;
  serve: Serve;
  sent: Delivery[];
  logs: LogRecord[];
  /** GET or POST, with an optional bearer token and an optional form or JSON body. */
  get: (path: string, options?: Options) => Promise<Response>;
  post: (path: string, body: Record<string, string>, options?: Options) => Promise<Response>;
  close: () => void;
};

type Options = { token?: string; wants?: "json" | "html"; json?: boolean };

/** The one place a request is built, so every test sends the same shape of one. */
function rig(options: { founders?: readonly string[] } = {}): Rig {
  const w = world();
  const sent: Delivery[] = [];
  const logs: LogRecord[] = [];
  const serve = makeApp({
    db: w.db,
    registry: REGISTRY,
    publicOrigin: ORIGIN,
    views: VIEWS,
    clock: w.clock,
    deliver: (message) => sent.push(message),
    log: (record) => logs.push(record),
    report: () => {},
    secure: true,
    ...(options.founders === undefined ? {} : { founders: options.founders }),
  });
  const headers = (o: Options = {}): Record<string, string> => ({
    accept: o.wants === "html" ? "text/html" : "application/json",
    ...(o.token === undefined ? {} : { authorization: `Bearer ${o.token}` }),
  });
  return {
    world: w,
    serve,
    sent,
    logs,
    get: (path, o = {}) => serve(new Request(`${ORIGIN}${path}`, { headers: headers(o) }), "203.0.113.9"),
    post: (path, body, o = {}) =>
      serve(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            ...headers(o),
            "content-type": o.json === true ? "application/json" : "application/x-www-form-urlencoded",
          },
          body: o.json === true ? JSON.stringify(body) : new URLSearchParams(body).toString(),
        }),
        "203.0.113.9",
      ),
    close: () => w.close(),
  };
}

/** A bearer token for an account, minted the way the repository does it. */
function tokenFor(w: World, accountId: string): string {
  return createSession(w.system.as(accountId), accountId, { userAgent: "test" }).token;
}

/** The token out of a delivered link, which is the only place a caller can get one. */
function tokenIn(message: Delivery): string {
  const link = message.link ?? "";
  const token = link.slice(link.lastIndexOf("/") + 1);
  assert.equal(token.length, 43, `expected a 43-character token in ${link}`);
  return token;
}

/** A body as JSON, having first insisted it is the media type it claims to be. */
async function problemOf(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  return (await response.json()) as Record<string, unknown>;
}

/** A valid `events.create` payload, as form fields. Every value is a string on the wire. */
function eventFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    slug: "second-2027",
    name: "Second Hackathon",
    timezone: "Europe/Lisbon",
    submissionsOpenAt: new Date(T0 + MS.day).toISOString(),
    submissionsCloseAt: new Date(T0 + 3 * MS.day).toISOString(),
    judgingOpenAt: new Date(T0 + 3 * MS.day).toISOString(),
    judgingCloseAt: new Date(T0 + 4 * MS.day).toISOString(),
    reviewsPerProject: "3",
    pairwiseEnabled: "on",
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// Claim: a sign-in link is not spent by fetching it.
// ---------------------------------------------------------------------------------------

test("requesting a link mails one and returns nothing that could be used to sign in", async () => {
  const r = rig();
  try {
    const before = ledgerLength(r.world.db);
    const response = await r.post("/api/signin", { email: "newcomer@example.test" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sent: boolean; expiresAt: number };
    assert.equal(body.sent, true);
    assert.ok(body.expiresAt > T0);
    // The token is in the mail and nowhere else. `sent: true` is the same answer an
    // unknown address gets, which is what stops this route being a membership oracle.
    assert.equal(JSON.stringify(body).includes(tokenIn(r.sent[0] as Delivery)), false);
    assert.equal(r.sent.length, 1);
    assert.equal((r.sent[0] as Delivery).reason, "signin");
    assert.equal(ledgerLength(r.world.db), before + 1);
  } finally {
    r.close();
  }
});

test("delivered links use the configured origin, not the request Host", async () => {
  const r = rig();
  try {
    const response = await r.serve(
      new Request("https://attacker.example/api/signin", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ email: "person@example.test" }).toString(),
      }),
      "203.0.113.9",
    );
    assert.equal(response.status, 200);
    assert.match(r.sent[0]?.link ?? "", /^https:\/\/portal\.test\/signin\//);
  } finally {
    r.close();
  }
});

test("stream failures expose a generic event, not the exception text", async () => {
  const source = (async function* (): AsyncGenerator<{ data: unknown }> {
    throw new Error("database secret");
  })();
  const body = await (await eventStream(source)).text();
  assert.match(body, /stream failed/);
  assert.doesNotMatch(body, /database secret/);
});

test("fetching the link does not spend it, and the ledger is the witness", async () => {
  const r = rig();
  try {
    await r.post("/api/signin", { email: "newcomer@example.test" });
    const token = tokenIn(r.sent[0] as Delivery);
    const before = ledgerLength(r.world.db);

    // Twice, and as both renderings, because the thing being modelled is a mail gateway
    // that fetches every URL it forwards — and it fetches more than once.
    for (const path of [`/api/signin/${token}`, `/signin/${token}`, `/api/signin/${token}`]) {
      const seen = await r.get(path, { wants: path.startsWith("/api") ? "json" : "html" });
      assert.equal(seen.status, 200);
      assert.equal(ledgerLength(r.world.db), before, `${path} wrote to the ledger`);
    }

    // And the credential still works afterwards, which is the half a scanner-proof link
    // would be worthless without.
    const opened = await r.post("/api/session", { token });
    assert.equal(opened.status, 200);
    assert.equal(ledgerLength(r.world.db) > before, true);
  } finally {
    r.close();
  }
});

test("the confirm page does not echo the token into its own markup", async () => {
  const r = rig();
  try {
    await r.post("/api/signin", { email: "newcomer@example.test" });
    const token = tokenIn(r.sent[0] as Delivery);

    const asJson = await (await r.get(`/api/signin/${token}`)).text();
    assert.equal(asJson.includes(token), false);

    // The page is the one place it has to appear: a hidden input is how a person with no
    // scripting completes the exchange in one click. It must not be anywhere else on it,
    // and in particular not in a link a referrer header would carry off-site.
    const asHtml = await (await r.get(`/signin/${token}`, { wants: "html" })).text();
    assert.equal(asHtml.split(token).length - 1, 1);
    assert.match(asHtml, new RegExp(`<input[^>]*type="hidden"[^>]*value="${token}"`));
  } finally {
    r.close();
  }
});

test("consuming a link twice is refused, and refused as a credential problem", async () => {
  const r = rig();
  try {
    await r.post("/api/signin", { email: "newcomer@example.test" });
    const token = tokenIn(r.sent[0] as Delivery);
    assert.equal((await r.post("/api/session", { token })).status, 200);

    const again = await r.post("/api/session", { token });
    assert.equal(again.status, 401);
    const problem = await problemOf(again);
    // 401 and not 404: a spent link, an unknown link and a stale link are one answer,
    // because telling them apart would say whether a token was ever real.
    assert.equal(problem.code, "link.invalid");
  } finally {
    r.close();
  }
});

test("an invitation link grants the role it was issued for, once", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const path = `/api/events/${r.world.event.slug}/invitations`;
    const issued = await r.post(path, { email: "fourth@example.test", role: "judge" }, { token });
    assert.equal(issued.status, 200);
    const body = (await issued.json()) as { link: string; role: string; alreadyHeld: boolean };
    assert.equal(body.role, "judge");
    assert.equal(body.alreadyHeld, false);
    // Unlike a sign-in link, this one is in the response on purpose: the organizer may
    // hand it over themselves, which is the only way to invite anybody on a deployment
    // with no mail relay configured.
    assert.match(body.link, /^https:\/\/portal\.test\/signin\/[A-Za-z0-9_-]{43}$/);

    const opened = await r.post("/api/session", { token: tokenIn(r.sent.at(-1) as Delivery) });
    const session = (await opened.json()) as { role: string | null; eventId: string | null };
    assert.equal(session.role, "judge");
    assert.equal(session.eventId, r.world.event.id);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------------------
// Claim: not yours means not found.
// ---------------------------------------------------------------------------------------

test("the same request answers 401, 404, 403 and 200 by who is asking", async () => {
  const r = rig();
  try {
    const path = `/api/events/${r.world.event.slug}/judges`;
    const strangerId = upsertAccount(r.world.system, "stranger@example.test", "Sam Stranger").id;
    const participant = r.world.db.one<{ id: string }>(
      "select id from account where email = 'builder0@example.test'",
    ).id;

    const anonymous = await r.get(path);
    assert.equal(anonymous.status, 401);
    assert.equal((await problemOf(anonymous)).code, "access.unauthenticated");

    // The load-bearing one. A stranger holds no role here, so the roster is not merely
    // off limits — as far as this caller is concerned the event has no roster. A 403
    // would confirm that an event by this name exists and that it has judges.
    const outsider = await r.get(path, { token: tokenFor(r.world, strangerId) });
    assert.equal(outsider.status, 404);
    assert.equal((await problemOf(outsider)).code, "event.missing");

    // A participant is inside the event and outside this operation, and the difference is
    // worth telling them: they can fix it by asking an organizer, not by finding a link.
    const inside = await r.get(path, { token: tokenFor(r.world, participant) });
    assert.equal(inside.status, 403);
    assert.equal((await problemOf(inside)).code, "access.forbidden");

    const organizer = await r.get(path, { token: tokenFor(r.world, r.world.organizer.id) });
    assert.equal(organizer.status, 200);
    const roster = (await organizer.json()) as { judges: unknown[]; organizers: unknown[] };
    assert.equal(roster.judges.length, 3);
    assert.equal(roster.organizers.length, 1);
  } finally {
    r.close();
  }
});

test("an event that never existed and one the caller cannot see answer identically", async () => {
  const r = rig();
  try {
    const token = tokenFor(
      r.world,
      upsertAccount(r.world.system, "stranger@example.test", "Sam Stranger").id,
    );
    const hidden = await r.get(`/api/events/${r.world.event.slug}/judges`, { token });
    const absent = await r.get("/api/events/no-such-event/judges", { token });
    assert.equal(hidden.status, absent.status);
    const [a, b] = [await problemOf(hidden), await problemOf(absent)];
    // Same code, same title, same detail. The `meta` differs — one names the reference
    // the caller supplied — so the documents are compared on everything else.
    assert.deepEqual({ ...a, meta: null }, { ...b, meta: null });
  } finally {
    r.close();
  }
});

test("a role in one event is no role in another", async () => {
  const r = rig();
  try {
    const other = createEvent(r.world.system, {
      slug: "other-2026",
      name: "Other Hackathon",
      submissionsOpenAt: T0,
      submissionsCloseAt: T0 + MS.day,
      judgingOpenAt: T0 + MS.day,
      judgingCloseAt: T0 + 2 * MS.day,
      reviewsPerProject: 3,
      pairwiseEnabled: false,
    });
    const token = tokenFor(r.world, r.world.organizer.id);
    assert.equal((await r.get(`/api/events/${r.world.event.slug}/judges`, { token })).status, 200);
    // Roles are per event and not a hierarchy. Organizing one hackathon on a shared
    // deployment must not read another's judge roster.
    assert.equal((await r.get(`/api/events/${other.slug}/judges`, { token })).status, 404);
  } finally {
    r.close();
  }
});

test("the public face of an event is public, and its people are not", async () => {
  const r = rig();
  try {
    const shown = await r.get(`/api/events/${r.world.event.slug}`);
    assert.equal(shown.status, 200);
    const body = (await shown.json()) as {
      event: { slug: string };
      clock: Record<string, number>;
      yourRoles: string[];
    };
    assert.equal(body.event.slug, "dogfood-2026");
    assert.equal(body.yourRoles.length, 0);
    // The clock is the reason this route is public: a deadline nobody can read without an
    // account is a deadline somebody misses.
    assert.equal(typeof body.clock.submissionsCloseAt, "number");
    assert.equal(JSON.stringify(body).includes("@example.test"), false);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------------------
// Claim: founding is configuration, not achievement.
// ---------------------------------------------------------------------------------------

test("an organizer of one event cannot create another, and nothing records the attempt", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const events = (): number =>
      r.world.db.one<{ n: number }>("select count(*) as n from event").n;
    const before = { ledger: ledgerLength(r.world.db), events: events() };

    const refused = await r.post("/api/events", eventFields(), { token });
    assert.equal(refused.status, 403);
    assert.equal((await problemOf(refused)).code, "access.forbidden");
    // 403 and not 404, which is the one deliberate exception to "not yours means not
    // found": the collection is public, so pretending it is absent would contradict the
    // GET on the same address that just listed it.
    assert.deepEqual({ ledger: ledgerLength(r.world.db), events: events() }, before);
  } finally {
    r.close();
  }
});

test("the same account, the same payload, founding turned on: allowed", async () => {
  const r = rig({ founders: ["  ORGANIZER@Example.TEST "] });
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const created = await r.post("/api/events", eventFields(), { token });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { event: { slug: string }; role: string };
    assert.equal(body.event.slug, "second-2027");
    // Founding and organizing are different powers, so the grant is part of the operation
    // rather than a thing a founder has to do to themselves afterwards.
    assert.equal(body.role, "organizer");
    const mine = await r.get("/api/mine", { token });
    assert.equal(((await mine.json()) as { events: unknown[] }).events.length, 2);
  } finally {
    r.close();
  }
});

test("founding is the address, not the session: an unlisted account is still refused", async () => {
  const r = rig({ founders: ["operator@example.test"] });
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    assert.equal((await r.post("/api/events", eventFields(), { token })).status, 403);
    // And an anonymous caller is asked to sign in rather than told they are not a founder,
    // because which of the two is true is not knowable until there is a session.
    const anonymous = await r.post("/api/events", eventFields());
    assert.equal(anonymous.status, 401);
  } finally {
    r.close();
  }
});

test("the create form is drawn for a founder and for nobody else", async () => {
  const listed = rig({ founders: ["organizer@example.test"] });
  const unlisted = rig();
  try {
    const token = (r: Rig): string => tokenFor(r.world, r.world.organizer.id);
    const shown = await (await listed.get("/", { wants: "html", token: token(listed) })).text();
    assert.match(shown, /<summary>Create an event<\/summary>/);
    const hidden = await (await unlisted.get("/", { wants: "html", token: token(unlisted) })).text();
    assert.equal(hidden.includes("Create an event"), false);
    // The form's absence is a courtesy and the refusal is the control. Posting anyway is
    // refused by the command, which is the only place that decision is made.
    assert.equal((await unlisted.post("/events", eventFields(), { token: token(unlisted) })).status, 403);
  } finally {
    listed.close();
    unlisted.close();
  }
});

// ---------------------------------------------------------------------------------------
// Claim: every refusal is one of the declared shapes.
// ---------------------------------------------------------------------------------------

test("every refusal this server can be provoked into is a declared problem document", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const provocations: readonly {
      readonly what: string;
      readonly status: number;
      readonly code: string;
      readonly send: () => Promise<Response>;
    }[] = [
      {
        what: "a path that names no route",
        status: 404,
        code: "route.missing",
        send: () => r.get("/api/nothing-here"),
      },
      {
        what: "a method the path does not accept",
        status: 405,
        code: "request.method",
        send: () => r.serve(new Request(`${ORIGIN}/api/events`, { method: "DELETE" }), "203.0.113.9"),
      },
      {
        what: "a body in a media type nothing accepts",
        status: 415,
        code: "request.mediaType",
        send: () =>
          r.serve(
            new Request(`${ORIGIN}/api/signin`, {
              method: "POST",
              headers: { "content-type": "text/plain", accept: "application/json" },
              body: "email=someone@example.test",
            }),
            "203.0.113.9",
          ),
      },
      {
        what: "JSON that is not JSON",
        status: 400,
        code: "request.malformed",
        send: () =>
          r.serve(
            new Request(`${ORIGIN}/api/signin`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: "{not json",
            }),
            "203.0.113.9",
          ),
      },
      {
        what: "a body larger than the limit",
        status: 413,
        code: "request.tooLarge",
        send: () => r.post("/api/signin", { email: `a${"b".repeat(MAX_BODY)}@example.test` }),
      },
      {
        what: "a field that cannot be what it says",
        status: 422,
        code: "input.invalid",
        send: () => r.post("/api/signin", { email: "not-an-address" }),
      },
      {
        what: "no credential where one is needed",
        status: 401,
        code: "access.unauthenticated",
        send: () => r.get("/api/whoami"),
      },
      {
        what: "a credential that resolves to nothing",
        status: 401,
        code: "access.unauthenticated",
        send: () => r.get("/api/whoami", { token: "x".repeat(43) }),
      },
      {
        what: "a role the caller does not hold",
        status: 403,
        code: "access.forbidden",
        send: () => r.post("/api/events", eventFields(), { token }),
      },
      {
        what: "an event that is not there",
        status: 404,
        code: "event.missing",
        send: () => r.get("/api/events/no-such-event", { token }),
      },
    ];

    for (const provocation of provocations) {
      const response = await provocation.send();
      const problem = await problemOf(response);
      const where = `${provocation.what}: ${JSON.stringify(problem)}`;
      assert.equal(response.status, provocation.status, where);
      assert.equal(problem.code, provocation.code, where);
      // The four fields RFC 9457 requires, plus the code this product adds. `status` in the
      // document and the status on the wire are asserted to be the same number, because a
      // client that reads one and a proxy that reads the other must not disagree.
      assert.equal(problem.status, response.status, where);
      assert.equal(problem.type, `/errors/${provocation.code}`, where);
      assert.equal(typeof problem.title, "string", where);
      assert.equal(typeof problem.detail, "string", where);
      assert.match(String(problem.detail), /[.?]$/, `${where} — detail is not a sentence`);
      // `Retry-After` exactly when the refusal is a limit. A 429 without one is a server
      // declining to say, and a 403 with one is a promise it cannot keep.
      assert.equal(
        response.headers.get("retry-after") !== null,
        provocation.code.startsWith("rate."),
        where,
      );
      assert.equal(
        response.headers.get("allow") !== null,
        provocation.code === "request.method",
        where,
      );
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(response.headers.get(name), value, `${where} — missing ${name}`);
      }
    }
  } finally {
    r.close();
  }
});

test("a 422 names the field, and the field it names is one the form has", async () => {
  const r = rig();
  try {
    const response = await r.post("/api/signin", { email: "not-an-address" });
    const problem = await problemOf(response);
    const problems = problem.problems as readonly { field: string; message: string }[];
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.field, "email");
    assert.match(String(problems[0]?.message), /address/);
  } finally {
    r.close();
  }
});

test("the limiter refuses at its declared cap and says when to come back", async () => {
  const r = rig();
  try {
    const body = { email: "keen@example.test" };
    for (let i = 0; i < LIMITS.signin.max; i += 1) {
      assert.equal((await r.post("/api/signin", body)).status, 200, `request ${i + 1}`);
    }
    const refused = await r.post("/api/signin", body);
    assert.equal(refused.status, 429);
    const problem = await problemOf(refused);
    assert.equal(problem.code, "rate.signin");
    const retry = Number(refused.headers.get("retry-after"));
    assert.ok(retry > 0 && retry <= LIMITS.signin.window / 1000, `retry-after was ${retry}`);

    // Keyed on the address, not the caller: a different inbox is a different bucket, which
    // is what keeps one person's flood from locking a room out of signing in.
    assert.equal((await r.post("/api/signin", { email: "other@example.test" })).status, 200);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------------------
// Transport: the mechanics the four claims above are carried by.
// ---------------------------------------------------------------------------------------

test("the /api prefix is the content negotiation, and Accept is not consulted", async () => {
  const r = rig();
  try {
    // The same command, twice, asked for the wrong way round each time. What decides is
    // the path: a link somebody pastes into a chat renders a page, and a link with /api in
    // it returns JSON, and neither changes meaning because a client sent a header.
    const asJson = await r.get("/api/events", { wants: "html" });
    assert.equal(asJson.status, 200);
    assert.equal(asJson.headers.get("content-type"), "application/json; charset=utf-8");

    const asPage = await r.get("/events", { wants: "json" });
    assert.equal(asPage.status, 200);
    assert.equal(asPage.headers.get("content-type"), "text/html; charset=utf-8");
    const page = await asPage.text();
    assert.match(page, /<h1>Make great work count\.<\/h1>/);
    assert.match(page, /Dogfood 2026/);
  } finally {
    r.close();
  }
});

test("a trailing slash is the same resource, and the root is the landing document", async () => {
  const r = rig();
  try {
    assert.equal((await r.get("/api/events/")).status, 200);
    const root = await r.get("/api");
    assert.equal(root.status, 200);
    const body = (await root.json()) as { product: { title: string }; events: unknown[] };
    assert.equal(typeof body.product.title, "string");
    assert.equal(body.events.length, 1);
  } finally {
    r.close();
  }
});

test("HEAD answers exactly what GET would, without the body", async () => {
  const r = rig();
  try {
    const got = await r.get("/api/events");
    const head = await r.serve(
      new Request(`${ORIGIN}/api/events`, { method: "HEAD", headers: { accept: "application/json" } }),
      "203.0.113.9",
    );
    assert.equal(head.status, got.status);
    assert.equal(head.headers.get("content-type"), got.headers.get("content-type"));
    assert.equal(await head.text(), "");
    // Deliberately absent: deriving it would mean rendering the page this request declined.
    assert.equal(head.headers.get("content-length"), null);
  } finally {
    r.close();
  }
});

test("a 405 carries every method the path does accept and no more", async () => {
  const r = rig();
  try {
    const response = await r.serve(new Request(`${ORIGIN}/api/events`, { method: "PUT" }), "203.0.113.9");
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST");
    const readOnly = await r.serve(
      new Request(`${ORIGIN}/api/whoami`, { method: "PUT" }),
      "203.0.113.9",
    );
    assert.equal(readOnly.headers.get("allow"), "GET");
  } finally {
    r.close();
  }
});

test("nothing writes on a GET, which is what stands in for a CSRF token", () => {
  // `docs/THREAT-MODEL.md` argues that no CSRF token is needed because `SameSite=Lax` withholds
  // the cookie from a cross-site POST while still allowing the cross-site top-level GET somebody
  // arrives on from their mail client. That argument is only sound if a GET cannot change
  // anything, so the property it rests on is asserted here rather than reviewed.
  //
  // "Declares no records" is the right thing to check, not "looks read-only": `ctx.write` refuses
  // outside a `ctx.recorded()` scope and `assertRecordsDeclared` objects to an undeclared action,
  // so a command with no `records` cannot append, and a command that cannot append cannot write.
  const methods = new Set(ALL_COMMANDS.map((command) => command.method));
  assert.deepEqual([...methods].sort(), ["GET", "POST"]);

  const writingGets = ALL_COMMANDS.filter(
    (command) => command.method === "GET" && (command.records ?? []).length > 0,
  ).map((command) => command.name);
  assert.deepEqual(writingGets, [], `these GET operations declare a write: ${writingGets.join(", ")}`);
});

test("a browser that writes something is sent somewhere with GET", async () => {
  const r = rig();
  try {
    const response = await r.post("/signin", { email: "newcomer@example.test" }, { wants: "html" });
    // 303 rather than 302, and to the command's own destination. A reload of the result
    // then cannot repeat the write, which is the entire reason this is not a 200.
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/signin?sent=1");
    assert.equal(await response.text(), "");

    // And the place it lands says to go and look in the inbox rather than redisplaying the
    // form, because a form shown again reads as though nothing happened — and the second
    // link it would produce invalidates the first.
    const landed = await (await r.get("/signin?sent=1", { wants: "html" })).text();
    assert.match(landed, /<h1>Check your inbox<\/h1>/);
    assert.equal(landed.includes('name="email"'), false);
    assert.match(landed, /<a href="\/signin">Ask for another link<\/a>/);
    // The address is not echoed back either. It would be a courtesy and it would also put
    // somebody's address in a page that ends up in a screenshot.
    assert.equal(landed.includes("newcomer@example.test"), false);
  } finally {
    r.close();
  }
});

test("signing in grants a cookie a script cannot read and a browser will not send off-site", async () => {
  const r = rig();
  try {
    await r.post("/api/signin", { email: "newcomer@example.test" });
    const token = tokenIn(r.sent[0] as Delivery);
    const response = await r.post("/session", { token }, { wants: "html" });
    assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie()[0] ?? "";
    // The cookie carries a session token, not the link token that was spent to get it —
    // one is single-use and thirty minutes old, the other lasts a fortnight.
    const granted = /^manak_session=([A-Za-z0-9_-]{43});/.exec(cookie)?.[1] ?? "";
    assert.equal(granted.length, 43);
    assert.notEqual(granted, token);
    assert.match(cookie, /HttpOnly/);
    // `SameSite=Lax` is doing the work a CSRF token would do elsewhere in this product:
    // a form on another origin cannot make the browser send this at all.
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d+/);
    // Pinned, because the regex above spells it out and a renamed cookie would otherwise
    // silently stop matching rather than fail here.
    assert.equal(SESSION_COOKIE, "manak_session");
  } finally {
    r.close();
  }
});

test("the cookie is the credential, and it is honoured exactly like a bearer token", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const byCookie = await r.serve(
      new Request(`${ORIGIN}/api/whoami`, {
        headers: { accept: "application/json", cookie: `${SESSION_COOKIE}=${token}` },
      }),
      "203.0.113.9",
    );
    assert.equal(byCookie.status, 200);
    const mine = (await byCookie.json()) as { account: { email: string }; sessions: unknown[] };
    assert.equal(mine.account.email, "organizer@example.test");
    assert.equal(mine.sessions.length, 1);

    // A bearer token beats a cookie when both arrive, so a script driving a browser
    // session cannot be silently answered as the wrong account.
    const other = tokenFor(r.world, (r.world.judges[0] as { id: string }).id);
    const both = await r.serve(
      new Request(`${ORIGIN}/api/whoami`, {
        headers: {
          accept: "application/json",
          cookie: `${SESSION_COOKIE}=${token}`,
          authorization: `Bearer ${other}`,
        },
      }),
      "203.0.113.9",
    );
    assert.equal(((await both.json()) as { account: { email: string } }).account.email, "judge0@example.test");
  } finally {
    r.close();
  }
});

test("signing out clears the cookie, and a cookie that resolves to nothing is cleared too", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const asBrowser = (path: string): Promise<Response> =>
      r.serve(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            accept: "text/html",
            cookie: `${SESSION_COOKIE}=${token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "",
        }),
        "203.0.113.9",
      );

    const out = await asBrowser("/signout");
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/signin");
    const cleared = out.headers.getSetCookie()[0] ?? "";
    assert.match(cleared, new RegExp(`^${SESSION_COOKIE}=(;|$)`));
    assert.match(cleared, /Max-Age=0/);

    // The token is dead now, and the browser does not know that. Signing out again is
    // refused — so the refusal has to be what clears the cookie, or the only operation
    // that could clear it is the one that can no longer be reached.
    const again = await asBrowser("/signout");
    assert.equal(again.status, 401);
    assert.match(again.headers.getSetCookie().join(" "), /Max-Age=0/);

    // Including on a request that succeeds: a public page rendered for a browser holding a
    // dead cookie should send it away without one.
    const public_ = await r.serve(
      new Request(`${ORIGIN}/events`, {
        headers: { accept: "text/html", cookie: `${SESSION_COOKIE}=${token}` },
      }),
      "203.0.113.9",
    );
    assert.equal(public_.status, 200);
    assert.match(public_.headers.getSetCookie().join(" "), /Max-Age=0/);

    // And not on a request that never presented one, or every anonymous visitor would be
    // handed a `Set-Cookie` for a session they never had.
    assert.deepEqual((await r.get("/events", { wants: "html" })).headers.getSetCookie(), []);
  } finally {
    r.close();
  }
});

test("signing out everywhere revokes every session, this one included", async () => {
  const r = rig();
  try {
    const first = tokenFor(r.world, r.world.organizer.id);
    const second = tokenFor(r.world, r.world.organizer.id);
    const response = await r.post("/api/signout", { everywhere: "on" }, { token: first });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { everywhere: boolean; remaining: number };
    assert.equal(body.everywhere, true);
    assert.equal(body.remaining, 0);
    assert.equal((await r.get("/api/whoami", { token: second })).status, 401);
  } finally {
    r.close();
  }
});

test("a browser posting a bad form gets the form back with the mistake marked", async () => {
  const r = rig();
  try {
    const response = await r.post("/signin", { email: "not-an-address" }, { wants: "html" });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await response.text();
    assert.match(body, /<form method="post" action="\/signin">/);
    assert.match(body, /One field needs attention\./);
    assert.match(body, /aria-invalid="true"/);
    // The value comes back, which is the difference between correcting one field and
    // retyping the form. It comes back escaped, and from what the server understood.
    assert.match(body, /value="not-an-address"/);
    assert.match(body, /<strong>[^<]*address[^<]*<\/strong>/);
  } finally {
    r.close();
  }
});

test("a redisplayed form does not carry a secret back into the markup", async () => {
  const r = rig();
  try {
    // A token of the wrong length fails the field's own check, so parsing never finishes
    // and the redisplay is built from the raw submission — the one path where a secret
    // could be written back into a page.
    const response = await r.post("/session", { token: "too-short" }, { wants: "html" });
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.equal(body.includes("too-short"), false);
  } finally {
    r.close();
  }
});

test("a GET whose input is wrong is a problem page, not a form", async () => {
  const r = rig();
  try {
    // Its form posts somewhere else, so redisplaying it here would send the correction to
    // the wrong route. A page that says what is wrong is the honest answer.
    const malformed = await r.get("/events/x", { wants: "html" });
    assert.equal(malformed.status, 422);
    assert.equal(malformed.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await malformed.text();
    assert.match(body, /<h1>[^<]*<\/h1>/);
    assert.equal(body.includes('<form method="post"'), false);

    // A reference that is well formed and names nothing is a 404 instead, which is the
    // whole reason `:event` is declared as text rather than as an id: the answer for an
    // unknown event does not depend on how the caller spelled it.
    assert.equal((await r.get("/events/no-such-event", { wants: "html" })).status, 404);
    assert.equal((await r.get("/api/events/no-such-event")).status, 404);
  } finally {
    r.close();
  }
});

test("the stylesheet is the one thing this server caches and the only asset it serves", async () => {
  const r = rig();
  try {
    const response = await r.get(STYLESHEET_PATH);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
    assert.match(response.headers.get("cache-control") ?? "", /^public, max-age=\d+$/);
    assert.match(await response.text(), /:root/);
    // Not a command, so it is not in the matrix or the OpenAPI document — and not a
    // directory either. There is exactly one file.
    assert.equal((await r.get("/assets/anything-else.css")).status, 404);
    assert.equal(
      (await r.serve(new Request(`${ORIGIN}${STYLESHEET_PATH}`, { method: "POST" }), "203.0.113.9")).status,
      405,
    );
  } finally {
    r.close();
  }
});

test("every successful response carries the same security headers and no-store", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    const responses = [
      await r.get("/api/events"),
      await r.get("/events", { wants: "html" }),
      await r.get("/api/whoami", { token }),
      await r.post("/api/signin", { email: "newcomer@example.test" }),
      await r.get("/api/openapi.json"),
    ];
    for (const response of responses) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(response.headers.get(name), value);
      }
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    // Scripting stays denied; bundled media is local and optional remote images require HTTPS.
    const csp = SECURITY_HEADERS["content-security-policy"] ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.equal(/script-src/.test(csp), false);
    assert.match(csp, /img-src 'self' https:/);
    assert.match(csp, /media-src 'self'/);
    assert.equal(/'unsafe-inline'|'unsafe-eval'|data:/.test(csp), false);
  } finally {
    r.close();
  }
});

// ---------------------------------------------------------------------------------------
// The log line, which is the one output nobody reviews and everybody keeps.
// ---------------------------------------------------------------------------------------

test("one line per request, naming the command and the account and nothing submitted", async () => {
  const r = rig();
  try {
    const token = tokenFor(r.world, r.world.organizer.id);
    await r.get("/api/whoami", { token });
    assert.equal(r.logs.length, 1);
    const line = r.logs[0] as LogRecord;
    assert.equal(line.method, "GET");
    assert.equal(line.path, "/api/whoami");
    assert.equal(line.wants, "json");
    assert.equal(line.status, 200);
    assert.equal(line.command, "auth.whoami");
    assert.equal(line.account, r.world.organizer.id);
    assert.equal(line.code, null);
    assert.equal(line.at, T0);
    assert.equal(typeof line.ms, "number");
    // Nine fields, so a field added without a decision about whether it may hold caller
    // input is a failing test rather than a line in production nobody reads.
    assert.deepEqual(Object.keys(line).sort(), [
      "account",
      "at",
      "code",
      "command",
      "method",
      "ms",
      "path",
      "status",
      "wants",
    ]);
  } finally {
    r.close();
  }
});

test("a refusal is logged with its code, and an unmatched path with no command", async () => {
  const r = rig();
  try {
    await r.get("/api/whoami");
    await r.get("/api/nothing-here");
    assert.deepEqual(
      r.logs.map((line) => [line.status, line.command, line.code]),
      [
        [401, "auth.whoami", "access.unauthenticated"],
        [404, null, "route.missing"],
      ],
    );
  } finally {
    r.close();
  }
});

test("the log does not keep a sign-in token, even though the URL is one", async () => {
  const r = rig();
  try {
    await r.post("/api/signin", { email: "newcomer@example.test" });
    const token = tokenIn(r.sent[0] as Delivery);
    await r.get(`/api/signin/${token}`);
    await r.get(`/signin/${token}`, { wants: "html" });

    // The one route in this product with a credential in its path. A log line outlives the
    // link's single use, so the segment is written back as its parameter name — and the
    // event reference on a different route is not, because that is what makes a log
    // readable.
    assert.deepEqual(
      r.logs.slice(1).map((line) => line.path),
      ["/api/signin/:token", "/signin/:token"],
    );
    assert.equal(JSON.stringify(r.logs).includes(token), false);

    await r.get(`/api/events/${r.world.event.slug}`);
    assert.equal((r.logs.at(-1) as LogRecord).path, "/api/events/dogfood-2026");
  } finally {
    r.close();
  }
});

test("the pages nobody wrote still print a time as a time", async () => {
  const r = rig();
  try {
    // The health check is one of the three GETs with no hand-written view, so this is the
    // generic renderer's output — the place a rule held only by convention goes to die. It
    // used to print `at` as a thirteen-digit integer and an empty `pending` list as `[]`.
    const html = await (await r.get("/healthz", { wants: "html" })).text();
    assert.match(html, /<dt>at<\/dt><dd>\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/dd>/);
    assert.equal(/<dd>1[0-9]{12}<\/dd>/.test(html), false, "no epoch reaches an operator");
    assert.equal(html.includes("<dd>[]</dd>"), false, "and no empty array reaches one either");
    assert.match(html, /<dt>pending<\/dt><dd>[-—]<\/dd>/, "nothing pending is a dash");
    assert.match(html, /<dt>headHash<\/dt><dd>[0-9a-f]{64}<\/dd>/, "the chain head is unchanged");
    assert.match(html, /<dt>current<\/dt><dd>yes<\/dd>/, "and a boolean is still a word");

    // The JSON keeps the integer. This is a rendering decision, not a change to the contract:
    // a monitor parses the number and a person reads the sentence.
    const body = (await (await r.get("/api/healthz")).json()) as Record<string, unknown>;
    assert.equal(body.at, T0);
    assert.deepEqual((body.migrations as Record<string, unknown>).pending, []);
  } finally {
    r.close();
  }
});
