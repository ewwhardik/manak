/**
 * The judge's console: the queue, the ballot, the duel, and the draw that fills the queue.
 *
 * Every rule about what a valid ballot is already lives in `saveBallot`, and every rule about
 * what a valid comparison is already lives in `recordComparison`. So the handlers here are thin
 * on purpose. Two places that both know a ballot needs one score per criterion of the *published*
 * rubric is one place too many: the repository owns the transaction, so it has to own the check,
 * and a second copy up here would drift the first time a criterion grew a bound.
 *
 * Three shapes are decided in this file rather than inherited, and each one closes a hole.
 *
 * **A judge id is never an input.** Every command takes the judge from the session and nowhere
 * else. `saveBallot` can attribute a ballot to somebody other than the caller — it appends
 * `ballot.entered_on_behalf` when asked to — and no route here can reach that branch. That makes
 * "no HTTP request can file a ballot in another judge's name" a claim THREAT-MODEL.md can make
 * and a test can hold, instead of a promise about how the handlers are written today.
 *
 * **A verdict is a side, not a project id.** `duels.decide` takes `left`, `right` and
 * `verdict: left | right | skip`, and resolves the winner against the two ids already in the
 * payload. A winner sent as a third id is a third chance to disagree with the first two, and
 * `comparison.winner` — the error for a winner that is in neither slot — becomes unreachable over
 * HTTP for the same reason. A skip is a verdict and is recorded; a judge who skips two thirds of
 * their duels is something an organizer has to be able to see.
 *
 * **The reads carry no gate.** `judging.queue` and `duels.next` answer before judging opens, and
 * publish `judging.open` with the window, so a judge who arrives early is told when they can start
 * rather than handed a 409 for reading. The writes gate, because that is where it matters.
 *
 * The cut line: **the draw takes no review count.** It uses `event.reviews_per_project` and
 * nothing else. An override here would let an organizer draw three reviews apiece while
 * `projectCoverage` still measures shortfall against five, and a dashboard whose "short by two" is
 * answering a different question from the draw is worse than no dashboard. Changing the number is
 * `events.update`, one place, and the draw and the coverage report move together.
 */

import { defineCommand } from "../registry.ts";
import type { Command, Invocation } from "../registry.ts";
import { RuleError } from "../../db/index.ts";
import type { Field } from "../schema.ts";
import { EVENT_REF } from "./events.ts";
import { PROJECT_SUMMARY, projectJson } from "./projects.ts";
import {
  allComparisons,
  assignmentsOf,
  assignProject,
  comparisonsOf,
  coverageGaps,
  criteriaOf,
  findBallot,
  headHash,
  findProjectIn,
  gatesFor,
  judgeablePool,
  judgeProgress,
  judgeRestrictions,
  configureJudge,
  setJudgeRecusal,
  membersOf,
  publishedVersion,
  recordComparison,
  saveBallot,
  scoresOf,
  teamOf,
  unassignProject,
} from "../../db/index.ts";
import type { Ctx, EventRow, ProjectRow } from "../../db/index.ts";
import { assignReviews, fitBradleyTerry, JudgingError, nextPair } from "../../judging/index.ts";
import type { AssignJudge, AssignProject, PairReason } from "../../judging/index.ts";

const PROJECT_REF: Field = {
  kind: "id",
  label: "Project",
  help: "The project's id, as it appears in the URL.",
};

const SCORES: Field = {
  kind: "scores",
  optional: true,
  label: "Scores",
  help:
    "One whole number per criterion of the published rubric, keyed by criterion. From a form, " +
    "send them as scores.<key> — a JSON client sends an object.",
};

const COMMENT: Field = {
  kind: "text",
  min: 0,
  max: 4000,
  multiline: true,
  optional: true,
  label: "Comment",
  help: "What the team should hear. Organizers see this; whether the team does is their call.",
};

/**
 * Draft or final, expressed as a checkbox rather than a `status` enum.
 *
 * A draft is a ballot with `submitted_at` null, and the only two things a judge ever wants are
 * "save this, I am not finished" and "file it". An enum with two members is a dropdown with two
 * members, and the browser has a control for exactly this.
 */
const DRAFT: Field = {
  kind: "bool",
  fallback: false,
  label: "Save as draft",
  help: "A draft is not counted anywhere. Leave this off to file the ballot.",
};

/**
 * Which side won, or neither.
 *
 * `skip` is a first-class answer. Two projects a judge cannot separate is information — it is
 * what a coin-flip probability looks like from the inside — and forcing a winner would put noise
 * into the Bradley-Terry fit and call it signal.
 */
const VERDICT: Field = {
  kind: "enum",
  values: ["left", "right", "skip"],
  label: "Verdict",
  help: "Which of the two shown projects is stronger, or skip if you cannot separate them.",
};

/**
 * Why the scheduler offered this pair, carried back so the ledger can say.
 *
 * Unverified: it comes from the client, and a client that lies about it corrupts nothing but its
 * own annotation. The ledger entry means "what the console said it was offering", not "what the
 * scheduler computed" — worth having, because the alternative is recomputing `nextPair` on the
 * decision and refusing the judge's verdict when the strengths moved underneath them.
 */
const REASON: Field = {
  kind: "enum",
  values: ["bridge", "informative", "explore", "exposure", "manual"],
  fallback: "manual",
  label: "Offered because",
  help: "The reason the pairing scheduler gave for this pair. Recorded, not trusted.",
};

const TRACK_FILTER: Field = {
  kind: "text",
  min: 1,
  max: 40,
  optional: true,
  label: "Track",
  help: "Draw within one track only. Leave blank to draw the whole event.",
};

const DRY_RUN: Field = {
  kind: "bool",
  fallback: false,
  label: "Preview only",
  help: "Compute the plan and report shortfalls without writing any assignments.",
};

const CRITERION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    weight: { type: "number" },
    min: { type: "integer" },
    max: { type: "integer" },
  },
  required: ["key", "label", "weight", "min", "max"],
};

const WINDOW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    open: { type: "boolean" },
    opensAt: { type: "integer" },
    closesAt: { type: "integer" },
    phase: { type: "string" },
  },
  required: ["open", "opensAt", "closesAt", "phase"],
};

/**
 * The judging window, on every read in this file.
 *
 * A console that renders a ballot form and then discovers on submit that judging closed four
 * minutes ago has wasted the judge's paragraph. `gatesFor` is the single definition of open, so it
 * is called rather than re-derived — the strict `now < close` comparison lives in one place and a
 * test pins it at the millisecond.
 */
function judgingWindow(event: EventRow, now: number): Record<string, unknown> {
  const gates = gatesFor(event, now);
  return {
    open: gates.judgingOpen,
    opensAt: event.judging_open_at,
    closesAt: event.judging_close_at,
    phase: gates.phase,
  };
}

/** The criteria as a ballot needs them: enough to draw one labelled control per score. */
function criteriaJson(ctx: Ctx, eventId: string, version: number): Record<string, unknown>[] {
  return criteriaOf(ctx.db, eventId, version).map((row) => ({
    key: row.key,
    label: row.label,
    weight: row.weight,
    min: row.min_score,
    max: row.max_score,
  }));
}

/**
 * One row of a judge's queue: the project, and how far they got with it.
 *
 * `scores` comes back on a draft so the form can be redrawn with the numbers still in the boxes.
 * On a filed ballot it comes back too, because a judge is allowed to see what they said and
 * `saveBallot` lets them revise it.
 */
function queueRow(ctx: Ctx, event: EventRow, judgeId: string, project: ProjectRow): Record<string, unknown> {
  const ballot = findBallot(ctx.db, event.id, judgeId, project.id);
  return {
    ...projectJson(project),
    recused: judgeRestrictions(ctx.db, event.id, judgeId).recusals.includes(project.id),
    ballot:
      ballot === undefined
        ? null
        : {
            id: ballot.id,
            rubricVersion: ballot.rubric_version,
            comment: ballot.comment,
            submitted: ballot.submitted_at !== null,
            submittedAt: ballot.submitted_at,
            scores: scoresOf(ctx.db, ballot.id),
          },
  };
}

/**
 * The projects a judge must never be shown: their own team's.
 *
 * Read off the pool the draw is already holding rather than with a second query, which also means
 * the conflict set and the assignable set cannot disagree about what is in the event. A judge with
 * no team in this event has no conflicts, which is the ordinary case for an invited outsider.
 */
function conflictsIn(ctx: Ctx, eventId: string, pool: readonly ProjectRow[], judgeId: string): string[] {
  const team = teamOf(ctx.db, eventId, judgeId);
  const restrictions = judgeRestrictions(ctx.db, eventId, judgeId);
  const recusals = new Set(restrictions.recusals);
  return pool.filter((project) =>
    (team !== undefined && project.team_id === team.id) || recusals.has(project.id) ||
    (restrictions.tracks !== null &&
      (project.track_key === null || !restrictions.tracks.includes(project.track_key))),
  ).map((project) => project.id);
}

/**
 * Everything a judge needs to start work, in one request.
 *
 * The criteria travel with the queue rather than behind a second call to `rubrics.show`. A judge
 * console that has to fetch twice to draw one page will, on a venue's wifi, sometimes draw half of
 * it — and the two responses can disagree about the rubric version if an organizer publishes
 * between them, which is the one disagreement that silently changes what a 4 means.
 *
 * No gate. A judge who opens this an hour early gets their queue and a window telling them when
 * they can file, which is strictly more useful than a 409 for reading. `rubric.version` is null
 * when nothing is published yet: not an error either, because the organizer has work to do and the
 * judge has done nothing wrong.
 */
const JUDGE_QUERY: Field = {
  kind: "text",
  min: 1,
  max: 64,
  optional: true,
  label: "Judge id",
  help: "The judge whose queue or scores to inspect. Non-organizers may only inspect their own.",
};

export const queue = defineCommand({
  name: "judging.queue",
  summary: "The projects assigned to you, and how far you got with each.",
  method: "GET",
  path: "/api/events/:event/judging",
  capability: { audience: "judge", scope: "event" },
  input: { event: EVENT_REF, judge: JUDGE_QUERY,
    focus: { kind: "text", min: 1, max: 64, optional: true, label: "Review to keep open" } },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        window: WINDOW_SCHEMA,
        rubric: {
          type: "object",
          properties: {
            version: { type: ["integer", "null"] },
            criteria: { type: "array", items: CRITERION_SCHEMA },
          },
          required: ["version", "criteria"],
        },
        pairwise: { type: "boolean" },
        assigned: { type: "integer" },
        submitted: { type: "integer" },
        drafts: { type: "integer" },
        comparisons: { type: "integer" },
        projects: { type: "array", items: { type: "object" } },
      },
      required: ["window", "rubric", "pairwise", "assigned", "submitted", "drafts", "projects"],
    },
  },
  handler: ({ ctx, event, accountId, roles, input }) => {
    const row = event as EventRow;
    const caller = accountId ?? "";
    const requestedJudge =
      typeof input.judge === "string" && input.judge.trim() !== ""
        ? input.judge.trim()
        : caller;
    if (requestedJudge !== caller && !roles.includes("organizer")) {
      throw new RuleError("access.forbidden", "Judges cannot inspect scores filed by peer judges.", {
        judge: requestedJudge,
      });
    }
    const judge = requestedJudge;
    const version = publishedVersion(ctx.db, row.id);
    const assignedRows = assignmentsOf(ctx.db, row.id, judge);
    const projectIds = new Set(assignedRows.map((a) => a.project_id));
    const ballotRows = ctx.db.all<{ project_id: string }>(
      "select distinct project_id from ballot where event_id = :e and judge_id = :j",
      { e: row.id, j: judge },
    );
    for (const b of ballotRows) {
      projectIds.add(b.project_id);
    }
  const projects = Array.from(projectIds)
      .map((pid) => findProjectIn(ctx.db, row.id, pid))
      .filter((project): project is ProjectRow => project !== undefined)
      .filter((project) => !judgeRestrictions(ctx.db, row.id, judge).recusals.includes(project.id) ||
        findBallot(ctx.db, row.id, judge, project.id)?.submitted_at != null)
      .map((project) => queueRow(ctx, row, judge, project));
    const filed = projects.filter((p) => {
      const ballot = p.ballot as { submitted: boolean } | null;
      return ballot !== null && ballot.submitted;
    }).length;
    const drafts = projects.filter((p) => {
      const ballot = p.ballot as { submitted: boolean } | null;
      return ballot !== null && !ballot.submitted;
    }).length;
    return {
      window: judgingWindow(row, ctx.now()),
      rubric: {
        version: version ?? null,
        criteria: version === undefined ? [] : criteriaJson(ctx, row.id, version),
      },
      pairwise: row.pairwise_enabled === 1,
      assigned: projects.length,
      submitted: filed,
      drafts,
      comparisons: comparisonsOf(ctx.db, row.id, judge).length,
      projects,
    };
  },
});

/**
 * File or revise a ballot.
 *
 * The judge is the session and only the session. `saveBallot` will attribute a ballot to somebody
 * else if asked — it appends `ballot.entered_on_behalf` when the judge id differs from the actor —
 * and this route cannot ask, so that ledger action is deliberately **not** declared here. Under the
 * superset check declaring it would cost nothing, but a `records` list is published documentation,
 * and listing an action no request can trigger would put a capability in the reference page that
 * the code does not have.
 *
 * `assignment.created` is declared because it happens: a judge scoring a project nobody assigned
 * them gets the assignment written as `manual`, so the coverage report counts the review it is
 * about to receive. An organizer's shortfall number that ignores volunteered work would understate
 * how judged the field actually is.
 */
export const saveBallotCommand = defineCommand({
  name: "ballots.save",
  summary: "Score a project against the published rubric.",
  method: "POST",
  path: "/api/events/:event/projects/:project/ballot",
  capability: { audience: "judge", scope: "event", owner: "judge", gate: "judging" },
  input: { event: EVENT_REF, project: PROJECT_REF, scores: SCORES, comment: COMMENT, draft: DRAFT },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        project: { type: "string" },
        rubricVersion: { type: "integer" },
        submitted: { type: "boolean" },
        submittedAt: { type: ["integer", "null"] },
        comment: { type: ["string", "null"] },
        scores: { type: "object", additionalProperties: { type: "integer" } },
        assigned: { type: "integer" },
        filed: { type: "integer" },
      },
      required: ["id", "project", "rubricVersion", "submitted", "scores"],
    },
  },
  limit: "ballot",
  records: ["assignment.created", "ballot.submitted", "ballot.revised"],
  form: {
    title: "Score this project",
    submit: "File ballot",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/judging?focus=${encodeURIComponent(String(input.project))}#review-${encodeURIComponent(String(input.project))}`,
  },
  notes:
    "The ballot is always filed as the signed-in judge; there is no way to enter one on another " +
    "judge's behalf over HTTP. Saving again replaces the earlier ballot and records the revision. " +
    "Scoring an unassigned project assigns it to you.",
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const judge = accountId ?? "";
    const ballot = saveBallot(ctx, row, {
      judgeId: judge,
      projectId: String(input.project),
      scores: (input.scores ?? {}) as Record<string, number>,
      ...(typeof input.comment === "string" ? { comment: input.comment } : {}),
      submit: input.draft !== true,
    });
    // Counted the way the organizer's dashboard counts, so a judge's "4 of 6" and the dashboard's
    // cannot disagree about what filed means.
    const mine = judgeProgress(ctx.db, row.id).find((p) => p.judgeId === judge);
    return {
      id: ballot.id,
      project: ballot.project_id,
      rubricVersion: ballot.rubric_version,
      submitted: ballot.submitted_at !== null,
      submittedAt: ballot.submitted_at,
      comment: ballot.comment,
      scores: scoresOf(ctx.db, ballot.id),
      assigned: mine?.assigned ?? 0,
      filed: mine?.submitted ?? 0,
    };
  },
});

/**
 * The next duel, or an honest empty state.
 *
 * `nextPair` returning null is a legitimate answer — this judge has seen every pair they are
 * allowed to see — and it comes back as `pair: null` rather than a 404, because nothing is missing.
 * The console renders "you have seen everything we can show you", which is a better end to a
 * judge's shift than an error page.
 *
 * The strengths handed to the scheduler are fitted here on the decided comparisons only, and only
 * when there are any: `fitBradleyTerry` on an empty graph is a fit of nothing, and the scheduler
 * already treats absent strengths as zero, which makes every pair equally informative and lets the
 * exposure term drive the first round. That is the correct behaviour for a cold start, so the guard
 * is not defensive — it is the model.
 *
 * `reason` and `componentCount` travel with the pair so the console can explain itself and so the
 * decision can carry the reason into the ledger.
 */
export const duelNext = defineCommand({
  name: "duels.next",
  summary: "The next pair of projects for you to compare.",
  method: "GET",
  path: "/api/events/:event/duel",
  capability: { audience: "judge", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        window: WINDOW_SCHEMA,
        pairwise: { type: "boolean" },
        filed: { type: "integer" },
        pool: { type: "integer" },
        connected: { type: "boolean" },
        componentCount: { type: "integer" },
        pair: {
          type: ["object", "null"],
          properties: {
            left: PROJECT_SUMMARY,
            right: PROJECT_SUMMARY,
            reason: { type: "string" },
            information: { type: "number" },
            deficit: { type: "number" },
          },
        },
      },
      required: ["window", "pairwise", "filed", "pool", "pair"],
    },
  },
  handler: ({ ctx, event, accountId }) => {
    const row = event as EventRow;
    const judge = accountId ?? "";
    const pool = judgeablePool(ctx.db, row.id);
    const rows = allComparisons(ctx.db, row.id);
    const mine = rows.filter((c) => c.judge_id === judge);
    const base = {
      window: judgingWindow(row, ctx.now()),
      pairwise: row.pairwise_enabled === 1,
      filed: mine.length,
      pool: pool.length,
    };
    if (row.pairwise_enabled !== 1) {
      // Not an error to ask: the console links here from the queue, and a judge who follows the
      // link in an event that never enabled duels should be told so, not refused.
      return { ...base, connected: true, componentCount: 0, pair: null };
    }
    const decided = rows
      .filter((c) => c.outcome !== "skip" && c.winner_id !== null)
      .map((c) => ({
        id: c.id,
        judge: c.judge_id,
        left: c.left_id,
        right: c.right_id,
        winner: c.winner_id as string,
      }));
    const ids = pool.map((p) => p.id);
    const strengths = new Map<string, number>();
    if (decided.length > 0) {
      for (const s of fitBradleyTerry(decided, ids).strengths) strengths.set(s.project, s.beta);
    }
    const scheduled = rows.map((c) => ({ judge: c.judge_id, left: c.left_id, right: c.right_id }));
    const pick = nextPair({
      judge,
      projects: ids,
      comparisons: scheduled,
      conflicts: conflictsIn(ctx, row.id, pool, judge),
      strengths,
      seed: `${row.id}|duel`,
    });
    const byId = new Map(pool.map((p) => [p.id, p]));
    return {
      ...base,
      connected: pick === null ? true : pick.componentCount <= 1,
      componentCount: pick?.componentCount ?? 0,
      pair:
        pick === null
          ? null
          : {
              left: projectJson(byId.get(pick.left) as ProjectRow),
              right: projectJson(byId.get(pick.right) as ProjectRow),
              reason: pick.reason,
              information: pick.information,
              deficit: pick.deficit,
            },
    };
  },
});

/**
 * Record one duel.
 *
 * The winner is resolved from `verdict` against the two ids in this same request, which is why
 * `comparison.winner` — the repository's error for a winner that is neither project — cannot be
 * reached from here. Both facts arrive together or neither does.
 *
 * The pair is canonicalised by `recordComparison`, so `left` and `right` in the response are the
 * stored order and may be the other way round from the order they were shown in. That is deliberate:
 * one pair is one row per judge, whichever way round the console drew it, so a judge cannot file two
 * contradictory verdicts on the same two projects by refreshing.
 */
export const duelDecide = defineCommand({
  name: "duels.decide",
  summary: "Record which of two projects is stronger.",
  method: "POST",
  path: "/api/events/:event/duel",
  capability: { audience: "judge", scope: "event", gate: "judging" },
  input: { event: EVENT_REF, left: PROJECT_REF, right: PROJECT_REF, verdict: VERDICT, reason: REASON },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        left: { type: "string" },
        right: { type: "string" },
        outcome: { type: "string", enum: ["left", "right", "skip"] },
        winner: { type: ["string", "null"] },
        filed: { type: "integer" },
      },
      required: ["id", "left", "right", "outcome", "winner", "filed"],
    },
  },
  limit: "ballot",
  records: ["comparison.recorded", "comparison.revised"],
  form: {
    title: "Which is stronger?",
    submit: "Record",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/duel`,
  },
  notes:
    "A skip is recorded rather than discarded: it does not move the ranking, but a judge skipping " +
    "most of their duels is something an organizer needs to see. Deciding the same pair again " +
    "replaces the earlier verdict and records the change.",
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const judge = accountId ?? "";
    const left = String(input.left);
    const right = String(input.right);
    const verdict = String(input.verdict);
    const comparison = recordComparison(ctx, row, {
      judgeId: judge,
      a: left,
      b: right,
      winner: verdict === "skip" ? null : verdict === "left" ? left : right,
      reason: String(input.reason) as PairReason | "manual",
    });
    return {
      id: comparison.id,
      left: comparison.left_id,
      right: comparison.right_id,
      outcome: comparison.outcome,
      winner: comparison.winner_id,
      filed: comparisonsOf(ctx.db, row.id, judge).length,
    };
  },
});

/**
 * Compute the assignment, translating the engine's refusals into one HTTP answer.
 *
 * `assignReviews` throws five distinct `JudgingError` codes — no projects, no judges, a bad review
 * count, a duplicate project, a duplicate judge — and all five mean the same thing to a caller: the
 * world is not ready for a draw, and no payload change fixes it. So they land on one
 * `assignment.impossible`, which the error table maps to 409, with the engine's own code and message
 * in the detail so the page can say which of the five it was. Flattening them into 422 would be a
 * lie: an organizer with no judges yet has not sent a bad request.
 *
 * A judge's track restriction is not modelled — there is no column for it — so every judge is
 * eligible for every track and an organizer who wants a track-by-track draw runs one per track.
 * `assignReviews` supports per-judge tracks and this is the only reason it goes unused.
 */
function drawPlan(ctx: Ctx, event: EventRow, trackKey?: string) {
  const pool = judgeablePool(ctx.db, event.id, trackKey);
  const judges = membersOf(ctx.db, event.id, "judge");
  const projects: AssignProject[] = pool.map((project) => ({
    id: project.id,
    ...(project.track_key === null ? {} : { track: project.track_key }),
  }));
  const roster: AssignJudge[] = judges.map((judge) => {
    const restriction = judgeRestrictions(ctx.db, event.id, judge.id);
    return { id: judge.id, conflicts: conflictsIn(ctx, event.id, pool, judge.id),
      ...(restriction.tracks === null ? {} : { tracks: restriction.tracks }),
      ...(restriction.capacity === null ? {} : { capacity: restriction.capacity }) };
  });
  const inactive = ctx.db.all<{ id: string }>(`select distinct a.judge_id as id from assignment a
    where a.event_id = :e and not exists (select 1 from membership m where m.event_id = a.event_id
      and m.account_id = a.judge_id and m.role = 'judge' and m.active = 1)`, { e: event.id });
  for (const judge of inactive) roster.push({ id: judge.id, capacity: 0, conflicts: pool.map((project) => project.id) });
  const inPool = new Set(projects.map((project) => project.id));
  const locked: { judge: string; project: string }[] = [];
  const outsideLoads = new Map<string, number>();
  for (const judge of roster) {
    const existing = assignmentsOf(ctx.db, event.id, judge.id);
    outsideLoads.set(judge.id, existing.filter((assignment) => !inPool.has(assignment.project_id)).length);
    for (const assignment of existing) {
      if (inPool.has(assignment.project_id) && (inactive.some((other) => other.id === judge.id) ||
          findBallot(ctx.db, event.id, judge.id, assignment.project_id) ||
          ctx.db.get(`select 1 from review_request where event_id = :e and judge_id = :j
            and project_id = :p and state = 'open'`,
            { e: event.id, j: judge.id, p: assignment.project_id }))) {
        locked.push({ judge: judge.id, project: assignment.project_id });
      }
    }
  }
  try {
    const seed = `${event.id}|assign`;
    const result = assignReviews(
      projects,
      roster,
      event.reviews_per_project,
      seed,
      { lockedAssignments: locked, outsideLoads },
    );
    return { pool, judges, roster, result, seed };
  } catch (error) {
    if (error instanceof JudgingError) {
      throw new RuleError("assignment.impossible", error.message, { reason: error.code });
    }
    throw error;
  }
}

/**
 * Draw the assignments, or preview them.
 *
 * Deterministic and re-runnable. The plan is recomputed from scratch and applied as a difference, so
 * running the draw twice writes nothing the second time — the seed is `event|assign`, so the same
 * roster and the same pool give the same plan.
 *
 * One rule shapes the removal half: **an assignment with a ballot against it is never removed.** A
 * judge who has already scored a project has done work, and dropping the assignment would leave the
 * ballot attached to nothing an organizer's coverage report counts. Those come back as `kept`, which
 * is how an organizer learns that a re-draw after judging started is partly advisory.
 *
 * The difference is also scoped to the pool being drawn. Drawing one track only compares against
 * assignments for projects in that track, because otherwise a track-scoped draw would unassign every
 * other track's work as "not in the plan" — a bug that would be quiet, catastrophic and only visible
 * as judges finding their queues emptied.
 */
export const draw = defineCommand({
  name: "assignments.draw",
  summary: "Assign judges to projects, honouring conflicts and balancing the load.",
  method: "POST",
  path: "/api/events/:event/assignments",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, track: TRACK_FILTER, dryRun: DRY_RUN,
    expectedRevision: { kind: "text", min: 64, max: 64, optional: true,
      label: "Preview revision", help: "Prevents applying a plan after event evidence changes." } },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        method: { type: "string" },
        planRevision: { type: "string" },
        applied: { type: "boolean" },
        reviewsPerProject: { type: "integer" },
        projects: { type: "integer" },
        judges: { type: "integer" },
        assignments: { type: "integer" },
        added: { type: "integer" },
        removed: { type: "integer" },
        kept: { type: "integer" },
        loadMin: { type: "integer" },
        loadMax: { type: "integer" },
        loadMean: { type: "number" },
        balanced: { type: "boolean" },
        complete: { type: "boolean" },
        shortfalls: { type: "array", items: { type: "object" } },
        warnings: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "object" } },
      },
      required: [
        "method",
        "applied",
        "reviewsPerProject",
        "projects",
        "judges",
        "assignments",
        "balanced",
        "complete",
        "shortfalls",
      ],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["assignment.run", "assignment.created", "assignment.removed"],
  form: {
    title: "Draw judge assignments",
    submit: "Draw",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/dashboard`,
  },
  notes:
    "Uses the event's own reviews-per-project setting. Safe to run twice: the plan is applied as a " +
    "difference. An assignment that already has a ballot against it is never removed.",
  handler: ({ ctx, input, event }) => {
    // DRAW_BODY
    const row = event as EventRow;
    const track = typeof input.track === "string" ? input.track : undefined;
    const planRevision = headHash(ctx.db);
    if (typeof input.expectedRevision === "string" && input.expectedRevision !== planRevision) {
      throw new RuleError("assignment.stale", "The event changed since this preview. Refresh before applying assignments.");
    }
    const { pool, judges, roster, result, seed } = drawPlan(ctx, row, track);
    const apply = input.dryRun !== true;
    const inPool = new Set(pool.map((project) => project.id));
    const planned = new Set(result.assignments.map((a) => `${a.judge}|${a.project}`));

    const existingPairs = new Set(roster.flatMap((judge) => assignmentsOf(ctx.db, row.id, judge.id)
      .filter((assignment) => inPool.has(assignment.project_id))
      .map((assignment) => `${judge.id}|${assignment.project_id}`)));
    const added = [...planned].filter((pair) => !existingPairs.has(pair)).length;
    const removed = [...existingPairs].filter((pair) => !planned.has(pair)).length;
    const kept = [...planned].filter((pair) => existingPairs.has(pair)).length;
    if (apply) {
      ctx.db.tx(() => {
        if (headHash(ctx.db) !== planRevision) throw new RuleError("assignment.stale", "The event changed while the assignment plan was prepared.");
        ctx.recorded(
          {
            action: "assignment.run",
            eventId: row.id,
            subject: track ?? "all",
            payload: {
              seed,
              track: track ?? null,
              projects: pool.length,
              judges: roster.length,
              target: row.reviews_per_project,
              planned: result.assignments.length,
              shortfalls: result.shortfalls,
              warnings: result.warnings,
            },
          },
          () => {},
        );
        for (const judge of roster) {
          for (const existing of assignmentsOf(ctx.db, row.id, judge.id)) {
            // Only the pool under consideration. See the note above about track-scoped draws.
            if (!inPool.has(existing.project_id)) continue;
            if (planned.has(`${judge.id}|${existing.project_id}`)) continue;
            if (findBallot(ctx.db, row.id, judge.id, existing.project_id) !== undefined) {
              throw new RuleError("assignment.impossible", "The plan tried to remove a submitted review. Retry the preview.");
            }
            unassignProject(ctx, row.id, judge.id, existing.project_id);
          }
        }
        for (const assignment of result.assignments) {
          const before = assignmentsOf(ctx.db, row.id, assignment.judge).some(
            (a) => a.project_id === assignment.project,
          );
          if (before) continue;
          assignProject(ctx, row.id, assignment.judge, assignment.project, "schedule");
        }
      });
    }
    const actualGaps = coverageGaps(ctx.db, row);
    return {
      method: result.method,
      planRevision,
      applied: apply,
      reviewsPerProject: result.reviewsPerProject,
      projects: pool.length,
      judges: roster.length,
      assignments: result.assignments.length,
      added,
      removed,
      kept,
      loadMin: result.loadMin,
      loadMax: result.loadMax,
      loadMean: result.loadMean,
      balanced: result.balanced,
      complete: result.complete,
      shortfalls: result.shortfalls,
      warnings: result.warnings,
      gaps: actualGaps,
    };
  },
});

/** Read-only browser/API preview; applying recomputes against the current roster. */
const preview = defineCommand({
  name: "assignments.preview",
  summary: "Preview assignment coverage before applying a draw.",
  method: "GET",
  path: "/api/events/:event/assignments/preview",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, track: TRACK_FILTER },
  returns: draw.returns,

  handler: (context) => draw.handler({ ...context, input: { ...context.input, dryRun: true } }),
});

export const roster = defineCommand({
  name: "judges.roster",
  summary: "List judge track, capacity, and recusal controls.",
  method: "GET",
  path: "/api/events/:event/judges/roster",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    judges: { type: "array", items: { type: "object" } },
  }, required: ["judges"] } },
  handler: ({ ctx, event }) => ({ judges: membersOf(ctx.db, (event as EventRow).id, "judge")
    .map((judge) => ({ id: judge.id, name: judge.display_name,
      ...judgeRestrictions(ctx.db, (event as EventRow).id, judge.id) })) }),
});

export const configureRoster = defineCommand({
  name: "judges.configure",
  summary: "Set one judge's eligible tracks and review capacity.",
  method: "POST",
  path: "/api/events/:event/judges/configure",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    judge: { kind: "text", min: 1, max: 64, label: "Judge account ID" },
    tracks: { kind: "text", min: 0, max: 2000, optional: true, label: "Eligible track keys",
      help: "Comma separated. Leave blank for every track." },
    capacity: { kind: "int", min: 0, max: 1000, optional: true, label: "Maximum reviews",
      help: "Leave blank for no explicit limit. Zero pauses new assignments." },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    tracks: { type: ["array", "null"] }, capacity: { type: ["integer", "null"] },
    recusals: { type: "array", items: { type: "string" } },
  }, required: ["tracks", "capacity", "recusals"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["judge.configured"],
  form: { title: "Configure judge eligibility", submit: "Save eligibility",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/dashboard#operations` },
  handler: ({ ctx, event, input }) => configureJudge(ctx, (event as EventRow).id, String(input.judge),
    typeof input.tracks === "string" ? input.tracks.split(",").map((part) => part.trim()).filter(Boolean) : [],
    typeof input.capacity === "number" ? input.capacity : null),
});

function recuseWithTopUp(call: Invocation, judge: string, project: string,
  reason: string, recused: boolean) {
  const row = call.event as EventRow;
  const restrictions = setJudgeRecusal(call.ctx, row.id, judge, project, reason, recused);
  if (!recused || !gatesFor(row, call.ctx.now()).judgingOpen) return { ...restrictions, topUp: null };
  const assigned = assignmentsOf(call.ctx.db, row.id, judge).some((item) => item.project_id === project);
  const filed = findBallot(call.ctx.db, row.id, judge, project)?.submitted_at != null;
  if (assigned && !filed) unassignProject(call.ctx, row.id, judge, project);
  // Reuse the capacity-aware residual-path planner, including its locked filed
  // reviews. A shortfall stays visible if every eligible judge is exhausted.
  const plan = draw.handler({ ...call, input: { event: row.slug, dryRun: false } }) as {
    added: number; removed: number; complete: boolean; shortfalls: unknown[] };
  return { ...restrictions, topUp: { added: plan.added, removed: plan.removed,
    complete: plan.complete, shortfalls: plan.shortfalls } };
}

export const recusal = defineCommand({
  name: "judges.recusal",
  summary: "Record or clear a project recusal for one judge.",
  method: "POST",
  path: "/api/events/:event/judges/recusal",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    judge: { kind: "text", min: 1, max: 64, label: "Judge account ID" },
    project: { kind: "text", min: 1, max: 64, label: "Project ID" },
    decision: { kind: "enum", values: ["recuse", "clear"], label: "Decision" },
    reason: { kind: "text", min: 3, max: 500, label: "Reason" },
  },
  returns: configureRoster.returns,
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["judge.recused", "judge.recusal_cleared", "assignment.removed",
    "assignment.run", "assignment.created"],
  form: { title: "Judge project recusal", submit: "Record recusal",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/dashboard#operations` },
  handler: (call) => recuseWithTopUp(call, String(call.input.judge),
    String(call.input.project), String(call.input.reason), call.input.decision === "recuse"),
});

export const selfRecusal = defineCommand({
  name: "judges.self_recusal",
  summary: "Leave an assigned project review and request an eligible replacement.",
  method: "POST", path: "/api/events/:event/judging/:project/recuse",
  capability: { audience: "judge", scope: "event", gate: "judging" },
  input: { event: EVENT_REF, project: PROJECT_REF,
    reason: { kind: "text", min: 3, max: 500, label: "Reason for recusal" } },
  returns: { kind: "json", schema: { type: "object", properties: {
    recusals: { type: "array", items: { type: "string" } },
    topUp: { type: ["object", "null"] },
  }, required: ["recusals", "topUp"] } },
  limit: "ballot", records: ["judge.recused", "assignment.removed",
    "assignment.run", "assignment.created"],
  form: { title: "Recuse from this review", submit: "Recuse and find replacement",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/judging` },
  handler: (call) => {
    const row = call.event as EventRow;
    const judge = call.accountId ?? "";
    const project = String(call.input.project);
    if (!assignmentsOf(call.ctx.db, row.id, judge).some((assignment) => assignment.project_id === project)) {
      throw new RuleError("review.unavailable", "This project is not assigned to you.");
    }
    return recuseWithTopUp(call, judge, project, String(call.input.reason), true);
  },
});

type ReviewRequestRow = { id: string; project_id: string; judge_id: string;
  reason_code: string; internal_reason: string; priority: number; due_at: number | null;
  state: string; created_at: number; cancelled_at: number | null };

export const reviewRequests = defineCommand({
  name: "reviews.requests",
  summary: "List targeted additional review requests and completion state.",
  method: "GET",
  path: "/api/events/:event/review-requests",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    requests: { type: "array", items: { type: "object" } },
  }, required: ["requests"] } },
  handler: ({ ctx, event }) => ({ requests: ctx.db.all<ReviewRequestRow>(
    `select id, project_id, judge_id, reason_code, internal_reason, priority, due_at,
      state, created_at, cancelled_at from review_request where event_id = :e
      order by state, priority desc, created_at, id`, { e: (event as EventRow).id })
    .map((request) => ({ id: request.id, project: request.project_id, judge: request.judge_id,
      reasonCode: request.reason_code, internalReason: request.internal_reason,
      priority: request.priority, dueAt: request.due_at, state: request.state,
      createdAt: request.created_at, cancelledAt: request.cancelled_at,
      completed: findBallot(ctx.db, (event as EventRow).id, request.judge_id,
        request.project_id)?.submitted_at !== null &&
        findBallot(ctx.db, (event as EventRow).id, request.judge_id,
          request.project_id) !== undefined })) }),
});

export const requestReview = defineCommand({
  name: "reviews.request",
  summary: "Assign one additional eligible judge to a submitted project.",
  method: "POST",
  path: "/api/events/:event/review-requests",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF,
    reasonCode: { kind: "enum", values: ["coverage", "fragility", "appeal", "other"], label: "Reason code" },
    internalReason: { kind: "text", min: 8, max: 500, label: "Private reason" },
    priority: { kind: "int", min: 1, max: 3, fallback: 2, label: "Priority" },
    dueAt: { kind: "int", min: 1, optional: true, label: "Due time (Unix milliseconds)" } },
  returns: { kind: "json", schema: { type: "object", properties: {
    id: { type: "string" }, project: { type: "string" }, judge: { type: "string" },
  }, required: ["id", "project", "judge"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["review.requested", "assignment.created"],
  form: { title: "Request an additional review", submit: "Assign review",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/dashboard` },
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const project = findProjectIn(ctx.db, row.id, String(input.project));
    if (!project || project.status !== "submitted") {
      throw new RuleError("project.notSubmitted", "Choose a submitted project in this event.");
    }
    const judges = membersOf(ctx.db, row.id, "judge");
    if (judges.length === 0) throw new RuleError("review.unavailable", "No active judges are available.");
    const roster: AssignJudge[] = judges.map((judge) => {
      const restriction = judgeRestrictions(ctx.db, row.id, judge.id);
      return { id: judge.id,
        conflicts: conflictsIn(ctx, row.id, [project], judge.id).concat(
          assignmentsOf(ctx.db, row.id, judge.id).some((a) => a.project_id === project.id)
            ? [project.id] : []),
        ...(restriction.tracks === null ? {} : { tracks: restriction.tracks }),
        ...(restriction.capacity === null ? {} : { capacity: restriction.capacity }),
      };
    });
    const loads = new Map(roster.map((judge) => [judge.id, assignmentsOf(ctx.db, row.id, judge.id).length]));
    const seed = `${row.id}|${project.id}|${headHash(ctx.db)}`;
    const plan = assignReviews([{ id: project.id,
      ...(project.track_key === null ? {} : { track: project.track_key }) }], roster, 1, seed,
      { outsideLoads: loads });
    const selected = plan.assignments[0];
    if (!selected) throw new RuleError("review.unavailable", "No eligible judge has remaining capacity.");
    const id = ctx.newId();
    const result = { id, project: project.id, judge: selected.judge };
    return ctx.db.tx(() => {
      assignProject(ctx, row.id, selected.judge, project.id, "backfill");
      return ctx.recorded({ action: "review.requested", eventId: row.id, subject: project.id,
        payload: { id, judge: selected.judge, reasonCode: input.reasonCode,
          internalReason: input.internalReason, priority: input.priority,
          dueAt: input.dueAt ?? null } }, () => {
        ctx.write(`insert into review_request (id, event_id, project_id, judge_id,
          reason_code, internal_reason, priority, due_at, state, created_at, cancelled_at)
          values (:id, :e, :p, :j, :reason, :detail, :priority, :due, 'open', :at, null)`, {
          id, e: row.id, p: project.id, j: selected.judge, reason: String(input.reasonCode),
          detail: String(input.internalReason), priority: Number(input.priority),
          due: typeof input.dueAt === "number" ? input.dueAt : null,
          at: ctx.now(),
        });
        return result;
      });
    });
  },
});

export const cancelReview = defineCommand({
  name: "reviews.cancel",
  summary: "Cancel an unfinished targeted review request.",
  method: "POST",
  path: "/api/events/:event/review-requests/:request/cancel",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, request: { kind: "id", label: "Review request ID" } },
  returns: { kind: "json", schema: { type: "object", properties: {
    id: { type: "string" }, state: { type: "string" },
  }, required: ["id", "state"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["review.cancelled", "assignment.removed"],
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const request = ctx.db.get<ReviewRequestRow>(`select id, project_id, judge_id, reason_code,
      internal_reason, priority, due_at, state, created_at, cancelled_at from review_request
      where id = :id and event_id = :e`, { id: String(input.request), e: row.id });
    if (!request || request.state !== "open") {
      throw new RuleError("review.unavailable", "That active review request was not found.");
    }
    if (findBallot(ctx.db, row.id, request.judge_id, request.project_id)) {
      throw new RuleError("review.alreadyFiled", "A review has been started; retain its evidence.");
    }
    return ctx.db.tx(() => {
      unassignProject(ctx, row.id, request.judge_id, request.project_id);
      return ctx.recorded({ action: "review.cancelled", eventId: row.id,
        subject: request.project_id, payload: { id: request.id, judge: request.judge_id } }, () => {
        ctx.write(`update review_request set state = 'cancelled', cancelled_at = :at
          where id = :id`, { at: ctx.now(), id: request.id });
        return { id: request.id, state: "cancelled" };
      });
    });
  },
});

export const JUDGING_COMMANDS: readonly Command[] = [
  queue,
  saveBallotCommand,
  duelNext,
  duelDecide,
  draw,
  preview,
  roster,
  configureRoster,
  recusal,
  selfRecusal,
  reviewRequests,
  requestReview,
  cancelReview,
];
