/**
 * Events: the container everything else in this product hangs off.
 *
 * Six operations, and the interesting thing about them is where the line between public
 * and private falls. An event's existence, its name, its clock and its phase are public,
 * because a participant needs to know when submissions close without holding an account
 * and a link in somebody's write-up should still resolve a year later. Its *people* are
 * not: the judge roster is organizer-only, because a published list of judges is a
 * published list of people to approach, and blind judging that anybody can un-blind by
 * reading `/api/events/x/judges` was never blind.
 *
 * **Creating an event is not something an account can do.** It is the `founder` audience,
 * held by addresses the operator named at boot. The reasoning is in `capability.ts`: a
 * magic link to an arbitrary address is the whole sign-up here, so `account` would mean
 * the first stranger who found a self-hosted portal could fill it with hackathons.
 *
 * **The event summary is defined once, in this file, and `system.ts` imports it.** The
 * landing document and the collection would otherwise be two mappings of the same row that
 * drift by one field the first time somebody adds one.
 *
 * The cut line: tracks are not created here. They are declared per event and they matter
 * to submission and to scoring, so they arrive with the submission commands rather than
 * being a seventh operation in a file about the container.
 */

import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { InputError } from "../schema.ts";
import type { Field, Fields } from "../schema.ts";
import { linkUrl } from "./auth.ts";
import {
  createEvent,
  updateEvent,
  eventsFor,
  findAccountByEmail,
  gatesFor,
  getClockOffset,
  grantRole,
  issueMagicLink,
  listEvents,
  listTracks,
  MAGIC_LINK_TTL,
  membersOf,
  MS,
  realNow,
  resetClockOffset,
  ROLES,
  findEventBySlug,
  rolesIn,
  revokeRole,
  RuleError,
  setClockOffset,
  signWebhookPayload,
} from "../../db/index.ts";
import type { AccountRow, EventGates, EventRow, Role } from "../../db/index.ts";

/**
 * The event a route names, as a field.
 *
 * `text` rather than `id`, because every one of these routes accepts a slug as readily as
 * an identifier and the dispatcher resolves either. Declaring it as an `id` would make
 * `/events/dogfood-2026` a 422 about the shape of a parameter, which is a worse answer than
 * the 404 an unknown reference deserves — and a 422 would also be a different answer for a
 * well-formed unknown id than for a malformed one, which is exactly the oracle
 * "not yours means not found" exists to close.
 */
export const EVENT_REF: Field = {
  kind: "text",
  min: 2,
  max: 64,
  label: "Event",
  help: "The event's slug or id, as it appears in the URL.",
};

/** The shape `eventSummary` produces, for the documents that publish it. */
export const EVENT_SUMMARY: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    timezone: { type: "string" },
    prizes: { type: "string" }, questions: { type: "string" },
    phase: {
      type: "string",
      enum: ["upcoming", "submissions", "overlap", "judging", "between", "finished"],
    },
    submissionsOpen: { type: "boolean" },
    judgingOpen: { type: "boolean" },
    resultsPublic: { type: "boolean" },
    archived: { type: "boolean" },
    votingMode: { type: "string", enum: ["off", "open", "account"] },
    votingOpenAt: { type: ["integer", "null"] },
    votingCloseAt: { type: ["integer", "null"] },
    votingCredits: { type: "integer" },
  },
  required: ["id", "slug", "name", "phase", "votingMode", "votingOpenAt", "votingCloseAt", "votingCredits"],
};

/**
 * One event, as much of it as anybody may see.
 *
 * `phase` is a label and the two booleans are the truth — submissions and judging may
 * overlap, and when they do the label is a summary. Anything deciding what a caller may do
 * reads the booleans, or better, reads the gate the dispatcher already checked.
 */
export function eventSummary(event: EventRow, gates: EventGates): Record<string, unknown> {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    timezone: event.timezone,
    prizes: event.prizes ?? "", questions: event.questions ?? "",
    phase: gates.phase,
    submissionsOpen: gates.submissionsOpen,
    judgingOpen: gates.judgingOpen,
    resultsPublic: gates.resultsPublic,
    archived: gates.archived,
    votingMode: event.voting_mode,
    votingOpenAt: event.voting_open_at,
    votingCloseAt: event.voting_close_at,
    votingCredits: event.voting_credits,
  };
}

/**
 * The collection, which is what a client looks for and what the front page shows.
 *
 * Archived events are excluded and reachable by slug, which is the one editorial decision
 * here: a portal that opens on three years of finished hackathons buries the one happening
 * today, and a link in somebody's write-up should not rot to make that point.
 */
export const list = defineCommand({
  name: "events.list",
  summary: "List the events this deployment is running.",
  method: "GET",
  path: "/api/events",
  capability: { audience: "public" },
  input: {
    archived: {
      kind: "bool",
      fallback: false,
      label: "Include finished events",
      help: "Include events that have been archived. They stay reachable by slug either way.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: { events: { type: "array", items: EVENT_SUMMARY } },
      required: ["events"],
    },
  },
  handler: ({ ctx, input, now }) => ({
    events: listEvents(ctx.db, input.archived === true).map((event) =>
      eventSummary(event, gatesFor(event, now)),
    ),
  }),
});

/**
 * One event, in full, to anybody.
 *
 * `yourRoles` is here rather than in a separate call because the dispatcher has already
 * read it — a scoped command resolves the caller's memberships before deciding anything —
 * so publishing it costs nothing and saves every client a second request to work out which
 * navigation to draw. For an anonymous caller it is empty, which is not a refusal: this
 * operation is public and says so.
 *
 * The four boundary instants are published as epoch milliseconds, and the timezone beside
 * them is for rendering only. Nothing in this product compares times in a zone; a deadline
 * is an instant, and an organizer in Lisbon and a participant in Manila are held to the
 * same one.
 */
export const show = defineCommand({
  name: "events.show",
  summary: "Describe one event, its clock and its tracks.",
  method: "GET",
  path: "/api/events/:event",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        event: EVENT_SUMMARY,
        clock: {
          type: "object",
          description: "Epoch milliseconds. The timezone is for display and nothing else.",
          properties: {
            submissionsOpenAt: { type: "integer" },
            submissionsCloseAt: { type: "integer" },
            judgingOpenAt: { type: "integer" },
            judgingCloseAt: { type: "integer" },
            nextBoundaryIn: { type: ["integer", "null"] },
          },
        },
        judging: {
          type: "object",
          properties: {
            reviewsPerProject: { type: "integer" },
            pairwiseEnabled: { type: "boolean" },
          },
        },
        tracks: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, label: { type: "string" } },
          },
        },
        yourRoles: {
          type: "array",
          description: "Roles the caller holds here. Empty for a visitor, and not a refusal.",
          items: { type: "string", enum: [...ROLES] },
        },
      },
      required: ["event", "clock", "judging", "tracks", "yourRoles"],
    },
  },
  handler: ({ ctx, event, gates, roles, now }) => {
    const row = event as EventRow;
    return {
      event: eventSummary(row, gates ?? gatesFor(row, now)),
      clock: {
        submissionsOpenAt: row.submissions_open_at,
        submissionsCloseAt: row.submissions_close_at,
        judgingOpenAt: row.judging_open_at,
        judgingCloseAt: row.judging_close_at,
        nextBoundaryIn: (gates ?? gatesFor(row, now)).nextBoundaryIn,
      },
      judging: {
        reviewsPerProject: row.reviews_per_project,
        pairwiseEnabled: row.pairwise_enabled === 1,
      },
      tracks: listTracks(ctx.db, row.id).map((track) => ({ key: track.key, label: track.label })),
      yourRoles: [...roles],
    };
  },
});

/** The declaration for the four boundary instants, which differ only in their words. */
function boundary(label: string, help: string): Field {
  return { kind: "instant", label, help };
}

const CREATE = {
  slug: {
    kind: "text",
    min: 2,
    max: 64,
    pattern: /^[a-z0-9][a-z0-9-]*$/,
    label: "URL name",
    help: "Lower-case letters, digits and hyphens. It appears in every link to this event and cannot be changed.",
  },
  name: {
    kind: "text",
    min: 1,
    max: 200,
    label: "Event name",
    help: "What people call it. “Dogfood Hackathon 2026”, not “dogfood-2026”.",
  },
  prizes: { kind: "text", max: 4000, multiline: true, optional: true, label: "Prizes and recognition", help: "One prize per line, including its amount and eligibility." },
  questions: { kind: "text", max: 4000, multiline: true, optional: true, label: "Submission questions", help: "One question per line. Teams answer these publicly on their project page." },
  timezone: {
    kind: "text",
    min: 1,
    max: 64,
    fallback: "UTC",
    label: "Timezone",
    help: "An IANA zone such as Europe/Lisbon, used for displaying times. Every deadline is still one instant for everybody.",
  },
  submissionsOpenAt: boundary("Submissions open", "When teams may start submitting."),
  submissionsCloseAt: boundary("Submissions close", "The deadline. It is enforced to the millisecond."),
  judgingOpenAt: boundary("Judging opens", "When judges may start scoring. It may be before submissions close."),
  judgingCloseAt: boundary("Judging closes", "When scoring stops."),
  reviewsPerProject: {
    kind: "int",
    min: 1,
    max: 20,
    fallback: 3,
    label: "Reviews per project",
    help: "How many judges should see each project. Three is the usual answer; below three there is nothing to cross-check a lenient judge against.",
  },
  pairwiseEnabled: {
    kind: "bool",
    fallback: false,
    label: "Collect pairwise comparisons",
    help: "Ask judges which of two projects is better, as well as scoring each. It sharpens the top of the leaderboard and costs judges time.",
  },
  votingOpenAt: { kind: "instant", optional: true, label: "Voting opens", help: "When community voting begins." },
  votingCloseAt: { kind: "instant", optional: true, label: "Voting closes", help: "When community voting ends." },
  votingMode: {
    kind: "enum",
    values: ["off", "open", "account"],
    fallback: "off",
    label: "Voting access",
    help: "Choose off, open to a voter token, or signed-in accounts only.",
  },
  votingCredits: { kind: "int", min: 1, max: 100000, fallback: 100, label: "Voting credits", help: "The quadratic voting budget per voter." },
} satisfies Fields;

/**
 * Bring an event into existence, and make its creator its organizer.
 *
 * The second half is not a convenience. Founding and organizing are different powers — see
 * `capability.ts` — and a founder who created an event without being granted a role in it
 * would have made something they cannot invite anybody to. So the grant is part of the
 * operation, and both actions are declared.
 *
 * Three things are checked here that no field declaration can express, and all three are
 * raised as `InputError` rather than `RuleError`, which puts the complaint next to the box
 * that caused it instead of on a problem page:
 *
 * - the two orderings the schema also enforces, so a mistyped date is a 422 with the
 *   mistake marked rather than a 500 from a constraint violation;
 * - that the timezone is a zone this runtime knows, because a name that is merely
 *   plausible renders wrong for three days and nobody reads it until then;
 * - that the slug is free. That last one conventionally answers 409, and does not here on
 *   purpose: this product's line is whether the caller can fix it by changing the payload,
 *   and a taken name is fixed by picking another one. A form that comes back with
 *   "is already taken" under the box beats a conflict document that does not say which
 *   field conflicted.
 *
 * Deliberately not checked: that judging starts after submissions close. Rolling judging is
 * a real format, the schema declines to forbid it, and a validator that overruled the
 * schema would be the second opinion nobody asked for.
 */
export const create = defineCommand({
  name: "events.create",
  summary: "Create an event and become its organizer.",
  method: "POST",
  path: "/api/events",
  capability: { audience: "founder" },
  input: CREATE,
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: { event: EVENT_SUMMARY, role: { type: "string", enum: ["organizer"] } },
      required: ["event", "role"],
    },
  },
  limit: "event",
  records: ["event.created", "membership.granted"],
  form: {
    title: "Create an event",
    submit: "Create event",
    redirect: ({ result }) => {
      const slug = (result as { event: { slug: string } }).event.slug;
      return `/events/${encodeURIComponent(slug)}`;
    },
  },
  notes:
    "Limited to the addresses this deployment's operator named as founders. Holding any " +
    "role in an existing event, including organizer, does not grant it.",
  handler: ({ ctx, input, accountId, now }) => {
    const problems: { field: string; message: string }[] = [];
    const at = (name: string): number => Number(input[name]);
    if (at("submissionsCloseAt") <= at("submissionsOpenAt")) {
      problems.push({ field: "submissionsCloseAt", message: "has to be after submissions open." });
    }
    if (at("judgingCloseAt") <= at("judgingOpenAt")) {
      problems.push({ field: "judgingCloseAt", message: "has to be after judging opens." });
    }
    const timezone = String(input.timezone);
    try {
      // The only validator for a zone name is a formatter that refuses to be built with a
      // bad one. Cheap, exact, and it uses the same table the rendering will.
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      problems.push({ field: "timezone", message: "is not a timezone this server knows." });
    }
    const slug = String(input.slug);
    if (findEventBySlug(ctx.db, slug) !== undefined) {
      problems.push({ field: "slug", message: "is already taken by another event." });
    }
    const votingMode = String(input.votingMode) as "off" | "open" | "account";
    const votingOpenAt = typeof input.votingOpenAt === "number" ? input.votingOpenAt : undefined;
    const votingCloseAt = typeof input.votingCloseAt === "number" ? input.votingCloseAt : undefined;
    if (votingMode !== "off" && (votingOpenAt === undefined || votingCloseAt === undefined || votingCloseAt <= votingOpenAt)) {
      problems.push({ field: "votingCloseAt", message: "is required after voting opens when voting is enabled." });
    }
    if (problems.length > 0) throw new InputError(problems);

    const event = createEvent(ctx, {
      slug,
      name: String(input.name),
      ...(typeof input.prizes === "string" ? { prizes: input.prizes } : {}),
      ...(typeof input.questions === "string" ? { questions: input.questions } : {}),
      timezone,
      submissionsOpenAt: at("submissionsOpenAt"),
      submissionsCloseAt: at("submissionsCloseAt"),
      judgingOpenAt: at("judgingOpenAt"),
      judgingCloseAt: at("judgingCloseAt"),
      reviewsPerProject: Number(input.reviewsPerProject),
      pairwiseEnabled: input.pairwiseEnabled === true,
      ...(votingOpenAt === undefined ? {} : { votingOpenAt }),
      ...(votingCloseAt === undefined ? {} : { votingCloseAt }),
      votingMode,
      votingCredits: Number(input.votingCredits),
    });
    grantRole(ctx, event.id, accountId ?? "", "organizer");
    return { event: eventSummary(event, gatesFor(event, now)), role: "organizer" };
  },
});

const UPDATE: Fields = {
  event: EVENT_REF,
  name: CREATE.name,
  timezone: CREATE.timezone,
  prizes: CREATE.prizes,
  questions: CREATE.questions,
  submissionsOpenAt: CREATE.submissionsOpenAt,
  submissionsCloseAt: CREATE.submissionsCloseAt,
  judgingOpenAt: CREATE.judgingOpenAt,
  judgingCloseAt: CREATE.judgingCloseAt,
  reviewsPerProject: CREATE.reviewsPerProject,
  pairwiseEnabled: CREATE.pairwiseEnabled,
  votingOpenAt: CREATE.votingOpenAt,
  votingCloseAt: CREATE.votingCloseAt,
  votingMode: CREATE.votingMode,
  votingCredits: CREATE.votingCredits,
};

export const update = defineCommand({
  name: "events.update",
  summary: "Update this event's dates and judging settings.",
  method: "POST",
  path: "/api/events/:event",
  capability: { audience: "organizer", scope: "event" },
  input: UPDATE,
  returns: {
    kind: "json",
    schema: { type: "object", properties: { event: EVENT_SUMMARY }, required: ["event"] },
  },
  limit: "organize",
  records: ["event.updated"],
  form: {
    title: "Update event",
    submit: "Save event settings",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}`,
  },
  handler: ({ ctx, event, input, now }) => {
    const row = event as EventRow;
    const at = (name: string): number => Number(input[name]);
    const problems: { field: string; message: string }[] = [];
    if (at("submissionsCloseAt") <= at("submissionsOpenAt")) {
      problems.push({ field: "submissionsCloseAt", message: "has to be after submissions open." });
    }
    if (at("judgingCloseAt") <= at("judgingOpenAt")) {
      problems.push({ field: "judgingCloseAt", message: "has to be after judging opens." });
    }
    const timezone = String(input.timezone);
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      problems.push({ field: "timezone", message: "is not a timezone this server knows." });
    }
    if (problems.length > 0) throw new InputError(problems);
    const votingMode = String(input.votingMode) as "off" | "open" | "account";
    const votingOpenAt = typeof input.votingOpenAt === "number" ? input.votingOpenAt : undefined;
    const votingCloseAt = typeof input.votingCloseAt === "number" ? input.votingCloseAt : undefined;
    if (votingMode !== "off" && (votingOpenAt === undefined || votingCloseAt === undefined || votingCloseAt <= votingOpenAt)) {
      throw new InputError([{ field: "votingCloseAt", message: "is required after voting opens when voting is enabled." }]);
    }
    const updated = updateEvent(ctx, row, {
      name: String(input.name),
      ...(typeof input.prizes === "string" ? { prizes: input.prizes } : {}),
      ...(typeof input.questions === "string" ? { questions: input.questions } : {}),
      timezone,
      submissionsOpenAt: at("submissionsOpenAt"),
      submissionsCloseAt: at("submissionsCloseAt"),
      judgingOpenAt: at("judgingOpenAt"),
      judgingCloseAt: at("judgingCloseAt"),
      reviewsPerProject: Number(input.reviewsPerProject),
      pairwiseEnabled: input.pairwiseEnabled === true,
      votingOpenAt,
      votingCloseAt,
      votingMode,
      votingCredits: Number(input.votingCredits),
    });
    return { event: eventSummary(updated, gatesFor(updated, now)) };
  },
});

/**
 * The events this caller has a role in, which is the only personalised list here.
 *
 * `/api/mine` rather than `/api/events/mine`. A literal segment beats a parameter in the
 * matcher, so the nested spelling would work — and would quietly reserve the slug "mine"
 * for the life of the deployment, so the first organizer who wanted an event called that
 * would get somebody else's list instead of a 404. A word that cannot be a slug is worth
 * more than a tidier URL.
 *
 * Archived events are included, unlike `events.list`. The reason the collection hides them
 * is that a stranger arriving at the portal wants the event happening now; somebody asking
 * what they are part of wants all of it, including the one they judged last year.
 *
 * The roles come back grouped rather than as one row per membership, because a person can
 * be both an organizer and a judge of the same event and a client drawing navigation needs
 * that as one entry with two roles, not two entries.
 */
export const mine = defineCommand({
  name: "events.mine",
  summary: "List the events the caller holds a role in.",
  method: "GET",
  path: "/api/mine",
  capability: { audience: "account" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              event: EVENT_SUMMARY,
              roles: { type: "array", items: { type: "string", enum: [...ROLES] } },
            },
            required: ["event", "roles"],
          },
        },
      },
      required: ["events"],
    },
  },
  handler: ({ ctx, accountId, now }) => ({
    events: eventsFor(ctx.db, accountId ?? "").map((entry) => ({
      event: eventSummary(entry.event, gatesFor(entry.event, now)),
      roles: entry.roles,
    })),
  }),
});

/**
 * Invite somebody into an event, and hand the organizer the link.
 *
 * **This command returns the token, and `auth.request` must not.** The difference is what
 * the caller has proved. A self-service sign-in is asked for by whoever typed the address,
 * so returning the link would make knowing an address enough to become its owner. An
 * invitation is issued by an organizer of this event, about somebody they chose, and the
 * organizer is entitled to deliver it themselves — over the venue's chat, on a slip of
 * paper, or by reading it out. A portal that could only mail invitations would be unusable
 * on a deployment whose operator has not configured a mail server, which is the default.
 *
 * The role is granted when the link is consumed, not now. Nothing is created for an address
 * that never turns up: no account, no membership, no row to clean up. `invite.issued` is
 * the only action this command appends, and `membership.granted` appears in the ledger later
 * under `auth.session`, which is where it actually happened.
 *
 * An address that already holds the role still gets a link, and consuming it is a no-op on
 * the membership — `grantRole` returns early. That makes this the resend button as well as
 * the invite button, which is the operation an organizer actually reaches for on day two.
 *
 * The limit is keyed on the event reference as the caller spelled it, so an organizer who
 * alternates the slug and the id gets two buckets of two hundred. That is a real hole and it
 * is the cheaper side of a trade: limits are enforced *before* the event is resolved, on
 * purpose, so that inviting into an event that does not exist is metered too and this route
 * cannot be used to probe for events at an unlimited rate.
 */
export const invite = defineCommand({
  name: "events.invite",
  summary: "Send somebody a link that joins them to this event in a role.",
  method: "POST",
  path: "/api/events/:event/invitations",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    email: {
      kind: "email",
      label: "Email address",
      help: "The address to invite. It does not need an account here yet.",
    },
    role: {
      kind: "enum",
      values: [...ROLES],
      label: "Role",
      help: "What they will be able to do. A judge scores projects; a participant submits one; an organizer can do everything here, including inviting more organizers.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        invited: { type: "string" },
        role: { type: "string", enum: [...ROLES] },
        link: {
          type: "string",
          description:
            "The invitation URL. Deliberately returned, unlike a sign-in link: an " +
            "organizer may pass this on themselves. It works once.",
        },
        expiresAt: { type: "integer" },
        alreadyHeld: {
          type: "boolean",
          description: "Whether this address already holds this role, making the link a resend.",
        },
      },
      required: ["invited", "role", "link", "expiresAt"],
    },
  },
  limit: "invite",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["invite.issued"],
  form: {
    title: "Invite somebody",
    submit: "Send invitation",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/judges`,
  },
  notes:
    "The response contains the invitation link. Organizer-only, and the ledger records who " +
    "issued it, to which address and in which role.",
  handler: ({ ctx, input, event, deliver, origin }) => {
    const row = event as EventRow;
    const email = String(input.email);
    const role = String(input.role) as Role;
    const account = findAccountByEmail(ctx.db, email);
    const alreadyHeld = account !== undefined && rolesIn(ctx.db, row.id, account.id).includes(role);
    const minted = issueMagicLink(ctx, { email, eventId: row.id, role });
    const link = linkUrl(origin, minted.token);
    deliver({
      to: email,
      reason: "invite",
      subject: `You have been invited to ${row.name}`,
      body:
        `You have been invited to ${row.name} as a ${role}. Open the link below to accept ` +
        `it. The link works once and stops working after ` +
        `${Math.round(MAGIC_LINK_TTL / MS.minute)} minutes; ask the organizer for another ` +
        "if it lapses.",
      link,
    });
    return { invited: email, role, link, expiresAt: minted.expiresAt, alreadyHeld };
  },
});

/**
 * A person, as an organizer may see one.
 *
 * The address is in here, and it is the reason the roster is organizer-only rather than
 * merely name-only-to-the-public: an organizer needs it to chase a judge who has not
 * scored anything, and it is the address they typed to invite them in the first place.
 * `joinedAt` is when the *account* was created, not when the membership was — a fact worth
 * being exact about, because it is what distinguishes a judge who signed up for this event
 * from one who has been on the deployment for a year.
 */
const PERSON: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    displayName: { type: "string" },
    joinedAt: { type: "integer" },
  },
  required: ["id", "email", "displayName"],
};

/**
 * The judge roster, to organizers only.
 *
 * The one read in this file that is not public, and the reason is in the header: a published
 * list of judges is a published list of people to approach, and blind judging that anybody
 * can un-blind by fetching a URL was never blind. A participant who wants to know whether
 * the room is being judged fairly is answered by the diagnostics table on the results tier,
 * which reports what the judges did without naming who did it.
 *
 * It lists judges and not every member. Organizers are visible to each other in the same
 * breath — a roster that hid them would be a roster an organizer could not audit — but the
 * participant list is a different question with a different shape, and it belongs with the
 * teams rather than here.
 *
 * A caller who holds no role here is told the event does not exist, which is the rule this
 * whole layer is built on and is load-bearing at exactly this route: 403 would confirm that
 * `dogfood-2026` is a real event with a real judge list to somebody with no business
 * knowing either.
 */
export const judges = defineCommand({
  name: "events.judges",
  summary: "List the judges and organizers of this event.",
  method: "GET",
  path: "/api/events/:event/judges",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        judges: { type: "array", items: PERSON },
        organizers: { type: "array", items: PERSON },
        reviewsPerProject: { type: "integer" },
      },
      required: ["judges", "organizers", "reviewsPerProject"],
    },
  },
  notes:
    "Organizer-only on purpose. Publishing a judge roster would let anybody un-blind the " +
    "judging by reading a URL.",
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const person = (account: AccountRow): Record<string, unknown> => ({
      id: account.id,
      email: account.email,
      displayName: account.display_name,
      joinedAt: account.created_at,
    });
    return {
      judges: membersOf(ctx.db, row.id, "judge").map(person),
      organizers: membersOf(ctx.db, row.id, "organizer").map(person),
      reviewsPerProject: row.reviews_per_project,
    };
  },
});

export const clock = defineCommand({
  name: "events.clock",
  summary: "Inspect virtual event clock and time offsets.",
  method: "GET",
  path: "/api/events/:event/clock",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        realNow: { type: "integer" },
        virtualNow: { type: "integer" },
        offsetMs: { type: "integer" },
        phase: { type: "string" },
        submissionsOpen: { type: "boolean" },
        judgingOpen: { type: "boolean" },
        resultsPublic: { type: "boolean" },
        submissionsOpenAt: { type: "integer" },
        submissionsCloseAt: { type: "integer" },
        judgingOpenAt: { type: "integer" },
        judgingCloseAt: { type: "integer" },
      },
      required: [
        "eventId",
        "realNow",
        "virtualNow",
        "offsetMs",
        "phase",
        "submissionsOpen",
        "judgingOpen",
        "resultsPublic",
        "submissionsOpenAt",
        "submissionsCloseAt",
        "judgingOpenAt",
        "judgingCloseAt",
      ],
    },
  },
  notes: "Reports real system time vs virtual offset time and current phase gates for demo evaluation.",
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const rNow = realNow();
    const virtualNow = ctx.now();
    const offsetMs = getClockOffset();
    const gates = gatesFor(row, virtualNow);
    return {
      eventId: row.id,
      realNow: rNow,
      virtualNow,
      offsetMs,
      phase: gates.phase,
      submissionsOpen: gates.submissionsOpen,
      judgingOpen: gates.judgingOpen,
      resultsPublic: gates.resultsPublic,
      submissionsOpenAt: row.submissions_open_at,
      submissionsCloseAt: row.submissions_close_at,
      judgingOpenAt: row.judging_open_at,
      judgingCloseAt: row.judging_close_at,
    };
  },
});

export const warpClock = defineCommand({
  name: "events.warp_clock",
  summary: "Fast-forward or reset the virtual clock for demo and evaluation.",
  method: "POST",
  path: "/api/events/:event/clock/warp",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    targetPhase: {
      kind: "enum",
      values: ["realtime", "submissions", "judging", "results"],
      optional: true,
      label: "Target Competition Phase",
      help: "Jump virtual clock directly into competition milestone.",
    },
    targetAt: {
      kind: "instant",
      optional: true,
      label: "Target Absolute Instant",
      help: "Set virtual clock to an exact timestamp.",
    },
    offsetMs: {
      kind: "int",
      optional: true,
      label: "Relative Offset Milliseconds",
      help: "Apply an explicit millisecond offset to real time.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        offsetMs: { type: "integer" },
        virtualNow: { type: "integer" },
        phase: { type: "string" },
      },
      required: ["ok", "offsetMs", "virtualNow", "phase"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["clock.warped"],
  form: {
    title: "Warp virtual event clock",
    submit: "Apply virtual time change",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}`,
  },
  notes: "Fast-forwards virtual time in-memory. Appends clock.warped audit ledger entry.",
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const rNow = realNow();
    let newOffset = 0;

    if (input.targetPhase === "realtime") {
      newOffset = 0;
    } else if (input.targetPhase === "submissions") {
      newOffset = row.submissions_open_at + 1000 - rNow;
    } else if (input.targetPhase === "judging") {
      newOffset = row.judging_open_at + 1000 - rNow;
    } else if (input.targetPhase === "results") {
      newOffset = row.judging_close_at + 1000 - rNow;
    } else if (typeof input.targetAt === "number") {
      newOffset = input.targetAt - rNow;
    } else if (typeof input.offsetMs === "number") {
      newOffset = input.offsetMs;
    }

    const previousOffset = getClockOffset();
    setClockOffset(newOffset);
    const virtualNow = rNow + newOffset;
    const gates = gatesFor(row, virtualNow);

    ctx.recorded(
      {
        action: "clock.warped",
        eventId: row.id,
        payload: {
          previousOffset,
          newOffset,
          virtualNow,
          phase: gates.phase,
        },
      },
      () => {},
    );

    return {
      ok: true,
      offsetMs: newOffset,
      virtualNow,
      phase: gates.phase,
    };
  },
});

export const webhooks = defineCommand({
  name: "events.webhooks",
  summary: "Inspect webhook dispatch status, receiver configuration and signing specifications.",
  method: "GET",
  path: "/api/events/:event/webhooks",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        signatureAlgorithm: { type: "string" },
        headerSignature: { type: "string" },
        headerEvent: { type: "string" },
        headerDelivery: { type: "string" },
        supportedActions: { type: "array", items: { type: "string" } },
      },
      required: [
        "eventId",
        "signatureAlgorithm",
        "headerSignature",
        "headerEvent",
        "headerDelivery",
        "supportedActions",
      ],
    },
  },
  notes: "Organizer-only. Provides HMAC-SHA256 signature specification and supported event action types.",
  handler: ({ event }) => {
    const row = event as EventRow;
    return {
      eventId: row.id,
      signatureAlgorithm: "HMAC-SHA256",
      headerSignature: "X-Manak-Signature",
      headerEvent: "X-Manak-Event",
      headerDelivery: "X-Manak-Delivery",
      supportedActions: [
        "event.created",
        "event.updated",
        "submission.created",
        "ballot.cast",
        "certificate.issued",
        "vote.cast",
        "clock.warped",
        "webhook.pinged",
      ],
    };
  },
});

export const pingWebhook = defineCommand({
  name: "events.ping_webhook",
  summary: "Generate a signed webhook test payload without sending it.",
  method: "POST",
  path: "/api/events/:event/webhooks/ping",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    url: {
      kind: "url",
      label: "Webhook Receiver URL",
      help: "The HTTPS receiver endpoint.",
    },
    secret: {
      kind: "text",
      min: 32,
      max: 128,
      label: "Webhook Signing Secret",
      help: "Shared secret for HMAC-SHA256 signature verification (minimum 32 characters).",
      secret: true,
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        deliveryId: { type: "string" },
        signature: { type: "string" },
        payload: { type: "string" },
        delivered: { type: "boolean" },
        statusCode: { type: ["integer", "null"] },
        latencyMs: { type: "integer" },
        error: { type: ["string", "null"] },
      },
      required: ["ok", "deliveryId", "signature", "payload", "delivered", "latencyMs"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["webhook.pinged"],
  form: {
    title: "Generate webhook test payload",
    submit: "Generate signed payload",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}`,
  },
  notes: "Generates a signed test payload locally and records it. Does not contact the supplied URL or verify delivery.",
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const deliveryId = `ping-${ctx.newId()}`;
    const payloadObj = {
      id: deliveryId,
      sequence: 0,
      event: row.id,
      action: "webhook.pinged",
      timestamp: ctx.now(),
    };
    const payloadStr = JSON.stringify(payloadObj);
    const signature = `sha256=${signWebhookPayload(payloadStr, String(input.secret))}`;

    ctx.recorded(
      {
        action: "webhook.pinged",
        eventId: row.id,
        payload: {
          deliveryId,
          url: String(input.url),
          signature,
        },
      },
      () => {},
    );

    return {
      ok: true,
      deliveryId,
      signature,
      payload: payloadStr,
      delivered: false,
      statusCode: null,
      latencyMs: 0,
      error: "Signed payload generated locally; no network delivery was attempted. Use the configured durable webhook dispatcher for delivery.",
    };
  },
});

/** Every command in this file, in the order the reference page should introduce them. */
export const revokeMembership = defineCommand({
  name: "events.revoke_role",
  summary: "Remove an event role while retaining its historical records.",
  method: "POST",
  path: "/api/events/:event/roles/revoke",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    account: { kind: "text", min: 1, max: 64, label: "Account ID" },
    role: { kind: "enum", values: [...ROLES], label: "Role" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    revoked: { type: "boolean" }, account: { type: "string" }, role: { type: "string" },
  }, required: ["revoked", "account", "role"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["membership.revoked"],
  form: { title: "Revoke event role", submit: "Revoke role",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/judges` },
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const account = String(input.account);
    const role = input.role as Role;
    const held = rolesIn(ctx.db, row.id, account).includes(role);
    if (role === "organizer" && held && membersOf(ctx.db, row.id, "organizer").length <= 1)
      throw new RuleError("organizer.last", "Grant another organizer before revoking the last one.");
    if (held) revokeRole(ctx, row.id, account, role);
    return { revoked: held, account, role };
  },
});

export const EVENT_COMMANDS: readonly Command[] = [
  list,
  show,
  create,
  update,
  mine,
  invite,
  judges,
  clock,
  warpClock,
  webhooks,
  pingWebhook,
  revokeMembership,
];
