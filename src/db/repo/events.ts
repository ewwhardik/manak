/**
 * Events, their clock, and their tracks.
 *
 * The interesting part of this module is not the CRUD, it is `gatesFor`: the single
 * place that answers "is this event accepting submissions right now". Every handler
 * that could accept late work asks it, and it takes the current instant as an
 * argument rather than reading a clock, so the boundary is testable to the
 * millisecond and there is exactly one implementation of the rule.
 */

import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import { toIso } from "../clock.ts";
// Type-only, and deliberately so: `eventsFor` groups membership rows and needs the name of
// a role, not any of the code that manages one. A type import is erased entirely, so this
// costs no runtime coupling between two repositories that are otherwise independent.
import type { Role } from "./accounts.ts";

export type EventRow = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  prizes?: string;
  questions?: string;
  submissions_open_at: number;
  submissions_close_at: number;
  judging_open_at: number;
  judging_close_at: number;
  results_public: number;
  pairwise_enabled: number;
  reviews_per_project: number;
  voting_open_at: number | null;
  voting_close_at: number | null;
  voting_mode: "off" | "open" | "account";
  voting_credits: number;
  created_at: number;
  archived_at: number | null;
};

export type TrackRow = { event_id: string; key: string; label: string; ordering: number };

const COLUMNS = `id, slug, name, timezone, submissions_open_at, submissions_close_at,
  judging_open_at, judging_close_at, results_public, pairwise_enabled,
  reviews_per_project, voting_open_at, voting_close_at, voting_mode, voting_credits,
  created_at, archived_at, prizes, questions`;

export function findEvent(db: Db, id: string): EventRow | undefined {
  return db.get<EventRow>(`select ${COLUMNS} from event where id = :id`, { id });
}

export function findEventBySlug(db: Db, slug: string): EventRow | undefined {
  return db.get<EventRow>(`select ${COLUMNS} from event where slug = :slug`, { slug });
}

export function listEvents(db: Db, includeArchived = false): EventRow[] {
  return db.all<EventRow>(
    `select ${COLUMNS} from event ${includeArchived ? "" : "where archived_at is null"}
     order by submissions_open_at desc, id`,
  );
}

/**
 * Every event this account has a role in, with the roles.
 *
 * Archived events are included, and the difference from `listEvents` is the whole reason
 * this is a separate query: the public list drops archived events because a portal that
 * opens on three years of finished hackathons buries the one happening today, while a
 * judge looking for the event they scored last year is looking for exactly that.
 *
 * The roles arrive as one grouped read rather than a `rolesIn` per event. That is not
 * micro-optimisation — the loop version is a query count that grows with how much of the
 * product a person has ever been involved in, and the person it grows fastest for is the
 * organizer running every event on the deployment.
 */
export function eventsFor(db: Db, accountId: string): { event: EventRow; roles: Role[] }[] {
  const rows = db.all<EventRow & { role: Role }>(
    `select ${COLUMNS.split(",")
      .map((column) => `e.${column.trim()}`)
      .join(", ")}, m.role as role
       from membership m join event e on e.id = m.event_id
      where m.account_id = :a and m.active = 1
      order by e.submissions_open_at desc, e.id, m.role`,
    { a: accountId },
  );
  const out: { event: EventRow; roles: Role[] }[] = [];
  for (const row of rows) {
    const { role, ...event } = row;
    const last = out[out.length - 1];
    if (last !== undefined && last.event.id === event.id) last.roles.push(role);
    else out.push({ event: event as EventRow, roles: [role] });
  }
  return out;
}

export type EventInput = {
  id?: string;
  prizes?: string;
  questions?: string;
  slug: string;
  name: string;
  timezone?: string;
  submissionsOpenAt: number;
  submissionsCloseAt: number;
  judgingOpenAt: number;
  judgingCloseAt: number;
  reviewsPerProject?: number;
  pairwiseEnabled?: boolean;
  votingOpenAt?: number;
  votingCloseAt?: number;
  votingMode?: "off" | "open" | "account";
  votingCredits?: number;
};

export function createEvent(ctx: Ctx, input: EventInput): EventRow {
  const id = input.id ?? ctx.newId();
  return ctx.recorded(
    {
      action: "event.created",
      eventId: id,
      subject: id,
      payload: {
        slug: input.slug,
        name: input.name,
        submissions_close_at: input.submissionsCloseAt,
        judging_close_at: input.judgingCloseAt,
      },
    },
    () => {
      ctx.write(
        `insert into event (id, slug, name, timezone, submissions_open_at,
           submissions_close_at, judging_open_at, judging_close_at,
           reviews_per_project, pairwise_enabled, voting_open_at, voting_close_at,
           voting_mode, voting_credits, created_at, prizes, questions)
         values (:id, :slug, :name, :timezone, :s_open, :s_close, :j_open, :j_close,
           :reviews, :pairwise, :v_open, :v_close, :v_mode, :v_credits, :created_at, :prizes, :questions)`,
        {
          id,
          slug: input.slug,
          name: input.name,
          timezone: input.timezone ?? "UTC",
          s_open: input.submissionsOpenAt,
          s_close: input.submissionsCloseAt,
          j_open: input.judgingOpenAt,
          j_close: input.judgingCloseAt,
          reviews: input.reviewsPerProject ?? 3,
          pairwise: input.pairwiseEnabled ? 1 : 0,
          v_open: input.votingOpenAt ?? null,
          v_close: input.votingCloseAt ?? null,
          v_mode: input.votingMode ?? "off",
          v_credits: input.votingCredits ?? 100,
          created_at: ctx.now(),
          prizes: input.prizes ?? "", questions: input.questions ?? "",
        },
      );
      return ctx.db.one<EventRow>(`select ${COLUMNS} from event where id = :id`, { id });
    },
  );
}

export function updateEvent(
  ctx: Ctx,
  event: EventRow,
  input: Omit<EventInput, "slug">,
): EventRow {
  return ctx.recorded(
    {
      action: "event.updated",
      eventId: event.id,
      subject: event.id,
      payload: {
        name: input.name,
        timezone: input.timezone ?? "UTC",
        submissions_open_at: input.submissionsOpenAt,
        submissions_close_at: input.submissionsCloseAt,
        judging_open_at: input.judgingOpenAt,
        judging_close_at: input.judgingCloseAt,
        reviews_per_project: input.reviewsPerProject ?? 3,
        pairwise_enabled: input.pairwiseEnabled === true,
        voting_open_at: input.votingOpenAt ?? null,
        voting_close_at: input.votingCloseAt ?? null,
        voting_mode: input.votingMode ?? "off",
        voting_credits: input.votingCredits ?? 100,
      },
    },
    () => {
      ctx.write(
        `update event set name = :name, timezone = :timezone,
           submissions_open_at = :s_open, submissions_close_at = :s_close,
           judging_open_at = :j_open, judging_close_at = :j_close,
           reviews_per_project = :reviews, pairwise_enabled = :pairwise,
           voting_open_at = :v_open, voting_close_at = :v_close,
           voting_mode = :v_mode, voting_credits = :v_credits, prizes = :prizes, questions = :questions
         where id = :id`,
        {
          id: event.id,
          prizes: input.prizes ?? event.prizes ?? "", questions: input.questions ?? event.questions ?? "",
          name: input.name,
          timezone: input.timezone ?? "UTC",
          s_open: input.submissionsOpenAt,
          s_close: input.submissionsCloseAt,
          j_open: input.judgingOpenAt,
          j_close: input.judgingCloseAt,
          reviews: input.reviewsPerProject ?? 3,
          pairwise: input.pairwiseEnabled === true ? 1 : 0,
          v_open: input.votingOpenAt ?? null,
          v_close: input.votingCloseAt ?? null,
          v_mode: input.votingMode ?? "off",
          v_credits: input.votingCredits ?? 100,
        },
      );
      return findEvent(ctx.db, event.id) as EventRow;
    },
  );
}

/**
 * What is open, right now, for one event.
 *
 * `phase` is for display and is deliberately lossy: submissions and judging may
 * overlap, and when they do the two booleans are the truth and the label is a
 * summary. Handlers must branch on the booleans.
 */
export type EventGates = {
  submissionsOpen: boolean;
  judgingOpen: boolean;
  resultsPublic: boolean;
  archived: boolean;
  phase: "upcoming" | "submissions" | "overlap" | "judging" | "between" | "finished";
  /** Milliseconds until the next boundary, or null once everything has closed. */
  nextBoundaryIn: number | null;
};

export function gatesFor(event: EventRow, now: number): EventGates {
  const archived = event.archived_at !== null;
  // A closing time is a deadline: at exactly `submissions_close_at` the window is
  // shut. The strict comparison is the rule, and the test for it asserts on both
  // that millisecond and the one before.
  const submissionsOpen =
    !archived && now >= event.submissions_open_at && now < event.submissions_close_at;
  const judgingOpen = !archived && now >= event.judging_open_at && now < event.judging_close_at;
  // An archived event has no future: reporting a phase of "between" and a countdown
  // to a window that will never open would have every page that renders this say the
  // opposite of what the two booleans say.
  const boundaries = archived ? [] : [
    event.submissions_open_at,
    event.submissions_close_at,
    event.judging_open_at,
    event.judging_close_at,
  ].filter((at) => at > now);
  const phase: EventGates["phase"] = archived
    ? "finished"
    : submissionsOpen && judgingOpen
      ? "overlap"
      : submissionsOpen
        ? "submissions"
        : judgingOpen
          ? "judging"
          : now < event.submissions_open_at
            ? "upcoming"
            : now < event.judging_close_at
              ? "between"
              : "finished";
  return {
    submissionsOpen,
    judgingOpen,
    resultsPublic: event.results_public === 1,
    archived,
    phase,
    nextBoundaryIn: boundaries.length > 0 ? Math.min(...boundaries) - now : null,
  };
}

/**
 * Refuse an action outside its window, and say by how much.
 *
 * The margin is in the error because "you were 4 seconds late" is a message an
 * organizer can adjudicate, and "submissions are closed" is not.
 *
 * Results are a gate too, and the odd one out: not a window but a switch an organizer
 * throws. It is handled here rather than in the caller because the transport layer
 * asking `event.results_public !== 0` for itself would be a second place that decides
 * what a gate means, and the point of a declared gate is that there is one.
 */
export function assertGate(
  event: EventRow,
  now: number,
  gate: "submissions" | "judging" | "results",
): void {
  if (gate === "results") {
    if (event.results_public !== 0) return;
    throw new RuleError(
      "results.notPublic",
      `Results for ${event.name} have not been published.`,
      { event: event.id },
    );
  }
  const gates = gatesFor(event, now);
  if (gate === "submissions" ? gates.submissionsOpen : gates.judgingOpen) return;
  const openAt = gate === "submissions" ? event.submissions_open_at : event.judging_open_at;
  const closeAt = gate === "submissions" ? event.submissions_close_at : event.judging_close_at;
  if (gates.archived) {
    throw new RuleError("event.archived", `${event.name} is archived and accepts no changes.`, {
      event: event.id,
    });
  }
  if (now < openAt) {
    throw new RuleError(
      `${gate}.notOpen`,
      `${gate === "submissions" ? "Submissions" : "Judging"} opens at ${toIso(openAt)}, in ${
        openAt - now
      } ms.`,
      { event: event.id, opens_at: openAt, now },
    );
  }
  throw new RuleError(
    `${gate}.closed`,
    `${gate === "submissions" ? "Submissions" : "Judging"} closed at ${toIso(closeAt)}, ${
      now - closeAt
    } ms ago.`,
    { event: event.id, closed_at: closeAt, now, late_by_ms: now - closeAt },
  );
}

export function setResultsPublic(ctx: Ctx, event: EventRow, published: boolean): void {
  ctx.recorded(
    {
      action: published ? "event.results_published" : "event.results_withdrawn",
      eventId: event.id,
      subject: event.id,
      payload: { results_public: published },
    },
    () => {
      ctx.write("update event set results_public = :value where id = :id", {
        value: published ? 1 : 0,
        id: event.id,
      });
    },
  );
}

export function listTracks(db: Db, eventId: string): TrackRow[] {
  return db.all<TrackRow>(
    "select event_id, key, label, ordering from track where event_id = :e order by ordering, key",
    { e: eventId },
  );
}

export function createTrack(
  ctx: Ctx,
  eventId: string,
  track: { key: string; label: string; ordering?: number },
): TrackRow {
  return ctx.recorded(
    { action: "track.created", eventId, subject: track.key, payload: { label: track.label } },
    () => {
      ctx.write(
        `insert into track (event_id, key, label, ordering)
         values (:e, :key, :label, :ordering)`,
        { e: eventId, key: track.key, label: track.label, ordering: track.ordering ?? 0 },
      );
      return ctx.db.one<TrackRow>(
        "select event_id, key, label, ordering from track where event_id = :e and key = :key",
        { e: eventId, key: track.key },
      );
    },
  );
}

/** Community standings stay hidden during the voting window, even if previously published. */
export function assertVotingClosed(event: EventRow, now: number): void {
  if (event.voting_mode !== "off" && event.voting_open_at !== null && event.voting_close_at !== null
    && now >= event.voting_open_at && now < event.voting_close_at) {
    throw new RuleError("results.votingOpen", "Results remain private while community voting is open.");
  }
}
