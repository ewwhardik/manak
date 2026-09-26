/**
 * Sign in, sign out, and the two-step that makes a single-use link survive an inbox.
 *
 * There are no passwords here, and the reason is narrower than a preference. A password
 * means a hash to choose, a reset flow, a strength policy and a breach-notification story,
 * and a three-day hackathon portal that gets any of those wrong is worse off than one that
 * never had them. A link to an address the organizer already has is the whole
 * authentication story, and the address is a fact they were going to collect anyway.
 *
 * **The link is confirmed, not consumed, by clicking it.** `GET /signin/:token` reads
 * nothing and writes nothing; it renders a button that posts the token. That is not
 * ceremony. A single-use credential in a URL is fetched by things that are not the
 * recipient — corporate link scanners, chat unfurlers, antivirus proxies, the browser's own
 * prefetcher — and every one of those would burn the link before the person clicked it, and
 * present them with "that link is not usable" for a link they had not used. The second step
 * costs one click and removes an entire class of support conversation.
 *
 * **A refused sign-in never says whether the address is known.** `auth.request` answers the
 * same way for an address with an account, an address without one, and an address that will
 * never have one. The limiter is keyed on the address rather than the caller for the same
 * reason: ten links to one inbox is the abuse worth stopping, and ten links to ten inboxes
 * from one browser is an organizer setting up a room.
 */

import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import type { Field } from "../schema.ts";
import {
  consumeMagicLink,
  findAccount,
  issueMagicLink,
  MAGIC_LINK_TTL,
  MS,
  RuleError,
  sessionsOf,
} from "../../db/index.ts";

/**
 * The shape `mintToken` produces: 32 random bytes, base64url, so 43 characters.
 *
 * Declared as a field pattern so a malformed token is a 422 from the parser rather than a
 * database read. The length is not a secret and checking it is not a leak — an attacker
 * who can count already knows how long the tokens are.
 */
const TOKEN: Field = {
  kind: "text",
  min: 43,
  max: 43,
  pattern: /^[A-Za-z0-9_-]{43}$/,
  label: "Sign-in token",
  help: "The token from the link that was sent to you.",
  secret: true,
};

/** Where a link points. One function, so the mail and the confirm page cannot disagree. */
export function linkUrl(origin: string, token: string): string {
  return `${origin}/signin/${encodeURIComponent(token)}`;
}

/**
 * The page that asks for an address, and the JSON answer that says how.
 *
 * A GET whose only purpose is to present a write. It exists because a browser needs
 * somewhere to be sent when it is refused for want of a session, and because the JSON
 * rendering of "how do I sign in" should be an answer rather than a 404.
 */
export const signinForm = defineCommand({
  name: "auth.signin",
  summary: "Show how to sign in.",
  method: "GET",
  path: "/api/signin",
  capability: { audience: "public" },
  input: {
    sent: {
      kind: "bool",
      fallback: false,
      label: "Link sent",
      help: "Set by the redirect after a link has been requested. Nothing reads it but the page.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        request: { type: "string", description: "The operation that sends a link." },
        route: { type: "string" },
        field: { type: "string" },
        expiresInMinutes: { type: "integer" },
        sent: { type: "boolean" },
      },
      required: ["request", "route", "field", "expiresInMinutes"],
    },
  },
  handler: ({ input }) => ({
    request: "auth.request",
    route: "POST /api/signin",
    field: "email",
    expiresInMinutes: Math.round(MAGIC_LINK_TTL / MS.minute),
    sent: input.sent === true,
  }),
});

/**
 * Send a link, and say nothing about whether the address was known.
 *
 * The token is not in the response. That is the one thing this command must never do: an
 * API that returns the credential it just mailed is an API where knowing an address is
 * enough to become its owner, and it would be a plausible-looking convenience — the tests
 * need the link, after all. They get it the same way a mail server would, through
 * `deliver`, which is why that port exists.
 */
export const requestLink = defineCommand({
  name: "auth.request",
  summary: "Send a sign-in link to an email address.",
  method: "POST",
  path: "/api/signin",
  capability: { audience: "public" },
  input: {
    email: {
      kind: "email",
      label: "Email address",
      help: "Where to send the link. It is the address an organizer invited, if you were invited.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        sent: { type: "boolean", description: "Always true. It does not mean an account exists." },
        expiresAt: { type: "integer" },
      },
      required: ["sent", "expiresAt"],
    },
  },
  limit: "signin",
  // Per address, not per caller. See the header: the abuse is one inbox flooded, and the
  // legitimate burst is one organizer signing a room in.
  limitKey: ({ input }) => String(input.email ?? ""),
  records: ["signin.requested"],
  form: {
    title: "Sign in",
    submit: "Email me a link",
    redirect: () => "/signin?sent=1",
  },
  notes:
    "Answers identically for a known and an unknown address, so this cannot be used to " +
    "find out who has an account here.",
  handler: ({ ctx, input, deliver, origin }) => {
    const email = String(input.email);
    const minted = issueMagicLink(ctx, { email });
    const minutes = Math.round(MAGIC_LINK_TTL / MS.minute);
    deliver({
      to: email,
      reason: "signin",
      subject: "Your sign-in link",
      body:
        `Open the link below to sign in. It works once and stops working after ${minutes} ` +
        "minutes. If you did not ask for it, nothing has been created and you can ignore it.",
      link: linkUrl(origin, minted.token),
    });
    return { sent: true, expiresAt: minted.expiresAt };
  },
});

/**
 * The confirm page: what a clicked link lands on, and the reason it is not the sign-in.
 *
 * This handler reads nothing and writes nothing. Its whole output is an instruction, and
 * the browser rendering of it is one button. That is the second half of the decision in
 * the header — the link is confirmed, not consumed — and it is what makes the credential
 * survive a corporate mail gateway that fetches every URL it forwards.
 *
 * The token is not echoed in the JSON. A caller holding a token does not need it read
 * back, and a machine does not need this operation at all: it can post to `/api/session`
 * directly, which is what the body says. The only consumer that needs the page is a
 * browser, and the browser gets the token from the path it was already sent to.
 */
export const confirmLink = defineCommand({
  name: "auth.link",
  summary: "Show the button that completes a sign-in.",
  method: "GET",
  path: "/api/signin/:token",
  capability: { audience: "public" },
  input: { token: TOKEN },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "The route that turns this token into a session." },
        field: { type: "string" },
        expiresInMinutes: { type: "integer" },
      },
      required: ["confirm", "field", "expiresInMinutes"],
    },
  },
  notes:
    "Deliberately inert. It does not consume the link, so a scanner or prefetcher that " +
    "opens the URL cannot spend it before the person does.",
  handler: () => ({
    confirm: "POST /api/session",
    field: "token",
    expiresInMinutes: Math.round(MAGIC_LINK_TTL / MS.minute),
  }),
});

/**
 * Turn a link into a session, and — unlike the request — hand the credential back.
 *
 * The two commands differ on exactly one point and it is the important one. `auth.request`
 * must never return its token, because its caller has proved nothing but the ability to
 * type an address. This caller has proved they hold a single-use secret that was sent to
 * that address, so returning a session token is not a leak; it is the exchange. Without it
 * there is no command-line client, because `credentialFrom` reads a bearer header and
 * nothing else would ever produce one.
 *
 * The cookie is set as well, by `signIn`. A browser needs the cookie and cannot read the
 * body; a script needs the body and will not keep a cookie jar. One operation serves both
 * because the alternative is two sign-in flows that drift.
 *
 * Four actions are declared and at most four are appended: an address signing in for the
 * first time creates an account, an invited link grants a role, and a returning
 * participant does neither. `assertRecordsDeclared` objects to an action that was appended
 * without being declared, never to one declared without being appended, so the honest
 * declaration here is the union of what can happen.
 */
export const openSession = defineCommand({
  name: "auth.session",
  summary: "Exchange a sign-in link for a session.",
  method: "POST",
  path: "/api/session",
  capability: { audience: "public" },
  input: { token: TOKEN },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        account: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string" },
            displayName: { type: "string" },
          },
          required: ["id", "email", "displayName"],
        },
        token: {
          type: "string",
          description:
            "The session credential. Send it as `Authorization: Bearer <token>`. It is also " +
            "set as a cookie, so a browser can ignore this field.",
        },
        expiresAt: { type: "integer" },
        eventId: {
          type: ["string", "null"],
          description: "The event this link was an invitation to, if it was one.",
        },
        role: { type: ["string", "null"], enum: ["organizer", "judge", "participant", null] },
      },
      required: ["account", "token", "expiresAt"],
    },
  },
  limit: "signin",
  // Redemption attempts are keyed by the client address. A token-keyed bucket lets an
  // attacker create an unbounded SQLite row for every random token they submit.
  limitKey: ({ address }) => address,
  records: ["link.consumed", "account.created", "membership.granted", "session.created"],
  form: {
    title: "Confirm sign-in",
    submit: "Sign in",
    redirect: ({ result }) => {
      const eventId = (result as { eventId: string | null }).eventId;
      // `resolveEvent` takes an id or a slug, so the id is a working link without a
      // second read here to turn it into the prettier one.
      return eventId === null ? "/" : `/events/${encodeURIComponent(eventId)}`;
    },
  },
  handler: ({ ctx, input, signIn, userAgent }) => {
    const out = consumeMagicLink(ctx, String(input.token), { userAgent });
    signIn(out.session.token, out.session.expiresAt);
    return {
      account: { id: out.account.id, email: out.account.email, displayName: out.account.display_name },
      token: out.session.token,
      expiresAt: out.session.expiresAt,
      eventId: out.eventId,
      role: out.role,
    };
  },
});

/**
 * Who the caller is, and what else is signed in as them.
 *
 * The session list is the point. A product whose sign-in credential arrives by mail — and,
 * in the default configuration, by container log — owes the person a way to see that
 * something else is holding their identity, and `auth.signout` with `everywhere` is the
 * button next to it. Each entry carries the times and the client's own user agent, which
 * is the only evidence available here about which device is which.
 *
 * It says who, not where. The events this account has a role in are a domain read and
 * belong to `events.mine`; putting them here would make the identity endpoint the place
 * everything eventually gets added to.
 */
export const whoami = defineCommand({
  name: "auth.whoami",
  summary: "Describe the signed-in account and its live sessions.",
  method: "GET",
  path: "/api/whoami",
  capability: { audience: "account" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        account: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string" },
            displayName: { type: "string" },
            createdAt: { type: "integer" },
          },
          required: ["id", "email", "displayName", "createdAt"],
        },
        founder: {
          type: "boolean",
          description:
            "Whether this deployment's operator listed this address as a founder, which is " +
            "what allows an event to be created. It is read from the environment, not stored.",
        },
        sessions: {
          type: "array",
          description: "Every session of this account that has not expired or been revoked.",
          items: {
            type: "object",
            properties: {
              createdAt: { type: "integer" },
              lastSeenAt: { type: "integer" },
              expiresAt: { type: "integer" },
              userAgent: { type: "string" },
            },
          },
        },
      },
      required: ["account", "sessions"],
    },
  },
  handler: ({ ctx, accountId, founder, now }) => {
    // `audience: "account"` is what makes this non-null; the check has already run and
    // refused the request before the handler was reached. The fallback is here because the
    // type cannot know that, and throwing would claim a failure that cannot happen.
    const id = accountId ?? "";
    const account = findAccount(ctx.db, id);
    if (account === undefined) {
      throw new RuleError("account.missing", "That account no longer exists.");
    }
    return {
      account: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
        createdAt: account.created_at,
      },
      founder,
      sessions: sessionsOf(ctx.db, id, now).map((row) => ({
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent,
      })),
    };
  },
});

/**
 * End this session, or all of them.
 *
 * Metered from the `read` bucket rather than a write bucket, which is the one place in this
 * file where the generous limit is the safe one: a refused sign-out leaves a live
 * credential in place because the product was busy, and there is no abuse to weigh against
 * that — the worst a flood of sign-outs achieves is signing somebody out.
 *
 * The remaining count is read after the revocation rather than computed from before it, so
 * the number the person is shown is a fact about the database rather than arithmetic about
 * what was supposed to have happened.
 */
export const closeSession = defineCommand({
  name: "auth.signout",
  summary: "Sign out of this session, or of every session.",
  method: "POST",
  path: "/api/signout",
  capability: { audience: "account" },
  input: {
    everywhere: {
      kind: "bool",
      fallback: false,
      label: "Sign out everywhere",
      help: "Revoke every session for this account, not just this one. Use it if you think a link or a token has been seen by somebody else.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        signedOut: { type: "boolean" },
        everywhere: { type: "boolean" },
        remaining: {
          type: "integer",
          description: "Sessions still live for this account after the revocation.",
        },
      },
      required: ["signedOut", "everywhere", "remaining"],
    },
  },
  limit: "read",
  records: ["session.revoked"],
  form: { title: "Sign out", submit: "Sign out", redirect: () => "/signin" },
  handler: ({ ctx, accountId, input, now, signOut }) => {
    const everywhere = input.everywhere === true;
    signOut({ everywhere });
    return {
      signedOut: true,
      everywhere,
      remaining: sessionsOf(ctx.db, accountId ?? "", now).length,
    };
  },
});

/** Every command in this file, in the order the reference page should introduce them. */
export const AUTH_COMMANDS: readonly Command[] = [
  signinForm,
  requestLink,
  confirmLink,
  openSession,
  whoami,
  closeSession,
];
