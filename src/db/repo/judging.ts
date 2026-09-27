/**
 * Assignments, ballots, comparisons — and the one function that hands all of it to
 * the judging engine.
 *
 * `loadJudgingInput` is the seam this whole layer exists to serve. Everything above
 * it is storage and everything below it is arithmetic, and the arithmetic is pure:
 * `src/judging` cannot see a database, so the only way a storage bug can corrupt a
 * ranking is by producing wrong ballots here, where it is one function to read.
 *
 * Two invariants are worth pointing at because the schema, not this file, holds
 * them. A judge cannot have two ballots on one project — `unique (event_id,
 * judge_id, project_id)` — which is the precondition the engine would otherwise have
 * to check on data it did not choose. And a ballot cannot exist for someone who is
 * not a judge of that event, through the pinned-role foreign key, which means
 * revoking a role retains their ballots while disabling further access.
 */

import type { Ballot, Comparison, PairReason } from "../../judging/types.ts";
import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import type { EventRow } from "./events.ts";
import { assertGate } from "./events.ts";
import { assertScoreInRange, criteriaOf, loadRubric, publishedVersion } from "./rubrics.ts";
import { findProjectIn, teamOf } from "./projects.ts";
import { assertJudgeCapacity, assertJudgeEligible } from "./judge-roster.ts";

export type AssignmentRow = {
  event_id: string;
  judge_id: string;
  project_id: string;
  reason: "schedule" | "manual" | "backfill";
  created_at: number;
};

export type BallotRow = {
  id: string;
  event_id: string;
  judge_id: string;
  project_id: string;
  rubric_version: number;
  comment: string;
  created_at: number;
  submitted_at: number | null;
};

export type ComparisonRow = {
  id: string;
  event_id: string;
  judge_id: string;
  left_id: string;
  right_id: string;
  outcome: "left" | "right" | "skip";
  winner_id: string | null;
  reason: PairReason | "manual";
  decided_at: number;
};

const BALLOT_COLUMNS = `id, event_id, judge_id, project_id, rubric_version, comment,
  created_at, submitted_at`;

export function assignmentsOf(db: Db, eventId: string, judgeId: string): AssignmentRow[] {
  return db.all<AssignmentRow>(
    `select event_id, judge_id, project_id, reason, created_at from assignment
      where event_id = :e and judge_id = :j order by created_at, project_id`,
    { e: eventId, j: judgeId },
  );
}

export function assignProject(
  ctx: Ctx,
  eventId: string,
  judgeId: string,
  projectId: string,
  reason: AssignmentRow["reason"] = "schedule",
): void {
  const existing = ctx.db.get<{ one: number }>(
    "select 1 as one from assignment where event_id = :e and judge_id = :j and project_id = :p",
    { e: eventId, j: judgeId, p: projectId },
  );
  if (existing) return;
  assertJudgeEligible(ctx.db, eventId, judgeId, projectId);
  assertJudgeCapacity(ctx.db, eventId, judgeId);
  ctx.recorded(
    { action: "assignment.created", eventId, subject: projectId, payload: { judge: judgeId, reason } },
    () => {
      ctx.write(
        `insert into assignment (event_id, judge_id, project_id, reason, created_at)
         values (:e, :j, :p, :reason, :at)`,
        { e: eventId, j: judgeId, p: projectId, reason, at: ctx.now() },
      );
    },
  );
}

export function unassignProject(ctx: Ctx, eventId: string, judgeId: string, projectId: string): void {
  ctx.recorded(
    { action: "assignment.removed", eventId, subject: projectId, payload: { judge: judgeId } },
    () => {
      ctx.write(
        "delete from assignment where event_id = :e and judge_id = :j and project_id = :p",
        { e: eventId, j: judgeId, p: projectId },
      );
    },
  );
}

export function findBallot(
  db: Db,
  eventId: string,
  judgeId: string,
  projectId: string,
): BallotRow | undefined {
  return db.get<BallotRow>(
    `select ${BALLOT_COLUMNS} from ballot
      where event_id = :e and judge_id = :j and project_id = :p`,
    { e: eventId, j: judgeId, p: projectId },
  );
}

export function scoresOf(db: Db, ballotId: string): Record<string, number> {
  const rows = db.all<{ criterion_key: string; value: number }>(
    "select criterion_key, value from score where ballot_id = :b order by criterion_key",
    { b: ballotId },
  );
  return Object.fromEntries(rows.map((row) => [row.criterion_key, row.value]));
}

/** A judge must never score or compare a project owned by their own team. */
function assertNoConflict(db: Db, eventId: string, judgeId: string, teamId: string): void {
  const team = teamOf(db, eventId, judgeId);
  if (team?.id === teamId) {
    throw new RuleError(
      "judging.conflict",
      "You cannot judge a project owned by your own team.",
      { projectTeam: teamId },
    );
  }
}

export type BallotInput = {
  judgeId: string;
  projectId: string;
  scores: Readonly<Record<string, number>>;
  comment?: string;
  /** False writes a draft: visible to its judge, invisible to the engine. */
  submit?: boolean;
};

/**
 * Write or replace a judge's ballot on one project.
 *
 * Idempotent by (judge, project): saving twice edits the same row rather than adding
 * a second, which is both what a judge expects from a form and what the engine
 * requires. Scores are replaced wholesale rather than merged, so a criterion removed
 * from the submission is removed from the ballot instead of keeping a stale value
 * from an earlier save.
 *
 * An unassigned judge scoring a project in the pool gets the assignment created for
 * them, recorded as `manual`. The alternative — refusing — makes the dashboard's
 * project list a trap, and the assignment table needs the row anyway for coverage
 * counts to mean anything.
 */
export function saveBallot(ctx: Ctx, event: EventRow, input: BallotInput): BallotRow {
  assertGate(event, ctx.now(), "judging");
  const version = publishedVersion(ctx.db, event.id);
  if (version === undefined) {
    throw new RuleError(
      "rubric.unpublished",
      "This event has no published rubric, so there is nothing to score against.",
    );
  }
  const project = findProjectIn(ctx.db, event.id, input.projectId);
  if (!project) {
    throw new RuleError("project.missing", "No such project in this event.");
  }
  if (project.status !== "submitted") {
    throw new RuleError(
      "project.notJudgeable",
      `${project.title} is ${project.status} and is not being judged.`,
      { project: project.id, status: project.status },
    );
  }
  assertNoConflict(ctx.db, event.id, input.judgeId, project.team_id);
  assertJudgeEligible(ctx.db, event.id, input.judgeId, project.id);
  const criteria = criteriaOf(ctx.db, event.id, version);
  const byKey = new Map(criteria.map((c) => [c.key, c]));
  const missing = criteria.filter((c) => input.scores[c.key] === undefined).map((c) => c.key);
  if (input.submit !== false && missing.length > 0) {
    throw new RuleError(
      "ballot.incomplete",
      `A submitted ballot needs every criterion scored. Missing: ${missing.join(", ")}.`,
      { missing },
    );
  }
  for (const [key, value] of Object.entries(input.scores)) {
    const criterion = byKey.get(key);
    if (!criterion) {
      throw new RuleError("score.unknownCriterion", `${key} is not on rubric version ${version}.`);
    }
    assertScoreInRange(criterion, value);
  }

  return ctx.db.tx(() => {
    if (input.judgeId !== ctx.actorId) {
      // Recorded rather than refused: an organizer entering a paper ballot is a real
      // workflow, and the ledger is where "who typed this" belongs.
      ctx.recorded(
        {
          action: "ballot.entered_on_behalf",
          eventId: event.id,
          subject: project.id,
          payload: { judge: input.judgeId },
        },
        () => {},
      );
    }
    assignProject(ctx, event.id, input.judgeId, project.id, "manual");
    const existing = findBallot(ctx.db, event.id, input.judgeId, project.id);
    const id = existing?.id ?? ctx.newId();
    const at = ctx.now();
    const submitted = input.submit === false ? null : at;
    return ctx.recorded(
      {
        action: existing ? "ballot.revised" : "ballot.submitted",
        eventId: event.id,
        subject: id,
        payload: {
          judge: input.judgeId,
          project: project.id,
          rubric_version: version,
          draft: submitted === null,
          // The scores themselves, in the ledger. This is the one payload where
          // duplication is the point: an appeal about a score is settled by what was
          // recorded at the time, and the ballot row only holds the latest revision.
          scores: { ...input.scores },
        },
      },
      () => {
        if (existing) {
          if (existing.rubric_version !== version) {
            throw new RuleError(
              "ballot.staleRubric",
              `That ballot was scored against rubric version ${existing.rubric_version} and the ` +
                `event now publishes version ${version}. Start a new ballot rather than mixing ` +
                `two scales.`,
              { was: existing.rubric_version, now: version },
            );
          }
          ctx.write(
            `update ballot set comment = :comment, submitted_at = :submitted where id = :id`,
            { comment: input.comment ?? existing.comment, submitted, id },
          );
          ctx.write("delete from score where ballot_id = :id", { id });
        } else {
          ctx.write(
            `insert into ballot (id, event_id, judge_id, project_id, rubric_version, comment,
               created_at, submitted_at)
             values (:id, :e, :j, :p, :v, :comment, :at, :submitted)`,
            {
              id,
              e: event.id,
              j: input.judgeId,
              p: project.id,
              v: version,
              comment: input.comment ?? "",
              at,
              submitted,
            },
          );
        }
        for (const [key, value] of Object.entries(input.scores)) {
          ctx.write(
            `insert into score (event_id, ballot_id, rubric_version, criterion_key, value)
             values (:e, :b, :v, :key, :value)`,
            { e: event.id, b: id, v: version, key, value },
          );
        }
        return ctx.db.one<BallotRow>(`select ${BALLOT_COLUMNS} from ballot where id = :id`, { id });
      },
    );
  });
}

/**
 * Remove a ballot. Organizer-only in practice, and the scores go into the ledger
 * entry first — a deletion whose payload does not say what was deleted is a hole in
 * the audit trail rather than a record of one.
 */
export function deleteBallot(ctx: Ctx, event: EventRow, ballot: BallotRow): void {
  const scores = scoresOf(ctx.db, ballot.id);
  ctx.recorded(
    {
      action: "ballot.deleted",
      eventId: event.id,
      subject: ballot.id,
      payload: { judge: ballot.judge_id, project: ballot.project_id, scores },
    },
    () => {
      ctx.write("delete from ballot where id = :id and event_id = :e", {
        id: ballot.id,
        e: event.id,
      });
    },
  );
}

/** The canonical form of a pair: smaller id on the left, so one pair is one row. */
export function canonicalPair(a: string, b: string): { left: string; right: string } {
  if (a === b) throw new RuleError("comparison.samePair", "A project cannot be compared to itself.");
  return a < b ? { left: a, right: b } : { left: b, right: a };
}

export type ComparisonInput = {
  judgeId: string;
  a: string;
  b: string;
  /** The id of the winner, or null for a skip — which is recorded, not discarded. */
  winner: string | null;
  reason?: PairReason | "manual";
};

/**
 * Record one pairwise decision.
 *
 * A skip is stored. The engine ignores it, but a judge who skips two thirds of their
 * duels is something an organizer needs to see, and that is only possible if the skip
 * was written down. Re-deciding a pair replaces the earlier verdict and says so in
 * the ledger, so a change of mind is visible rather than silent.
 */
export function recordComparison(ctx: Ctx, event: EventRow, input: ComparisonInput): ComparisonRow {
  assertGate(event, ctx.now(), "judging");
  if (event.pairwise_enabled !== 1) {
    throw new RuleError("pairwise.disabled", "Pairwise judging is not enabled for this event.");
  }
  const { left, right } = canonicalPair(input.a, input.b);
  for (const id of [left, right]) {
    const project = findProjectIn(ctx.db, event.id, id);
    if (!project || project.status !== "submitted") {
      throw new RuleError(
        "project.notJudgeable",
        "One of those projects is not in this event's judging pool.",
        { project: id },
      );
    }
  }
  const leftProject = findProjectIn(ctx.db, event.id, left);
  assertNoConflict(ctx.db, event.id, input.judgeId, (leftProject as { team_id: string }).team_id);
  assertJudgeEligible(ctx.db, event.id, input.judgeId, left);
  const rightProject = findProjectIn(ctx.db, event.id, right);
  assertNoConflict(ctx.db, event.id, input.judgeId, (rightProject as { team_id: string }).team_id);
  assertJudgeEligible(ctx.db, event.id, input.judgeId, right);
  if (input.winner !== null && input.winner !== left && input.winner !== right) {
    throw new RuleError("comparison.winner", "The winner has to be one of the two projects.");
  }
  const outcome: ComparisonRow["outcome"] =
    input.winner === null ? "skip" : input.winner === left ? "left" : "right";
  const existing = ctx.db.get<ComparisonRow>(
    `select id, event_id, judge_id, left_id, right_id, outcome, winner_id, reason, decided_at
       from comparison where event_id = :e and judge_id = :j and left_id = :l and right_id = :r`,
    { e: event.id, j: input.judgeId, l: left, r: right },
  );
  const id = existing?.id ?? ctx.newId();
  const at = ctx.now();
  return ctx.recorded(
    {
      action: existing ? "comparison.revised" : "comparison.recorded",
      eventId: event.id,
      subject: id,
      payload: {
        judge: input.judgeId,
        left,
        right,
        outcome,
        reason: input.reason ?? "manual",
        ...(existing ? { previous_outcome: existing.outcome } : {}),
      },
    },
    () => {
      if (existing) {
        ctx.write(
          `update comparison set outcome = :outcome, winner_id = :winner, reason = :reason,
             decided_at = :at where id = :id`,
          { outcome, winner: input.winner, reason: input.reason ?? "manual", at, id },
        );
      } else {
        ctx.write(
          `insert into comparison (id, event_id, judge_id, left_id, right_id, outcome,
             winner_id, reason, decided_at)
           values (:id, :e, :j, :l, :r, :outcome, :winner, :reason, :at)`,
          {
            id,
            e: event.id,
            j: input.judgeId,
            l: left,
            r: right,
            outcome,
            winner: input.winner,
            reason: input.reason ?? "manual",
            at,
          },
        );
      }
      return ctx.db.one<ComparisonRow>(
        `select id, event_id, judge_id, left_id, right_id, outcome, winner_id, reason, decided_at
           from comparison where id = :id`,
        { id },
      );
    },
  );
}

/**
 * Everything the engine needs for one event, and nothing else.
 *
 * Drafts are excluded: an unsubmitted ballot is a judge's working state, and letting
 * it into the fit would mean a half-filled form moved the ranking. Skipped
 * comparisons are excluded for the same kind of reason — a skip is evidence about the
 * judge, not about the pair.
 */
export function loadJudgingInput(
  db: Db,
  eventId: string,
  version?: number,
): { rubricVersion: number; rubric: ReturnType<typeof loadRubric>; ballots: Ballot[]; comparisons: Comparison[] } {
  const resolved = version ?? publishedVersion(db, eventId);
  if (resolved === undefined) {
    throw new RuleError("rubric.unpublished", "This event has no published rubric.");
  }
  const rubric = loadRubric(db, eventId, resolved);
  const rows = db.all<BallotRow>(
    `select ${BALLOT_COLUMNS} from ballot
      where event_id = :e and rubric_version = :v and submitted_at is not null
        and not exists (select 1 from membership m where m.event_id = ballot.event_id
          and m.account_id = ballot.judge_id and m.role = 'judge' and m.evidence_excluded_at is not null)
      order by id`,
    { e: eventId, v: resolved },
  );
  // One query for every score rather than one per ballot: sixty projects times four
  // reviews is 240 ballots, and 240 round trips to build one ranking is the kind of
  // thing that only shows up as "the dashboard is slow" much later.
  const scores = db.all<{ ballot_id: string; criterion_key: string; value: number }>(
    `select s.ballot_id, s.criterion_key, s.value
       from score s join ballot b on b.id = s.ballot_id
      where s.event_id = :e and s.rubric_version = :v and b.submitted_at is not null
        and not exists (select 1 from membership m where m.event_id = b.event_id
          and m.account_id = b.judge_id and m.role = 'judge' and m.evidence_excluded_at is not null)
      order by s.ballot_id, s.criterion_key`,
    { e: eventId, v: resolved },
  );
  const byBallot = new Map<string, Record<string, number>>();
  for (const row of scores) {
    const bucket = byBallot.get(row.ballot_id) ?? {};
    bucket[row.criterion_key] = row.value;
    byBallot.set(row.ballot_id, bucket);
  }
  const ballots: Ballot[] = rows.map((row) => ({
    id: row.id,
    judge: row.judge_id,
    project: row.project_id,
    rubricVersion: row.rubric_version,
    scores: byBallot.get(row.id) ?? {},
  }));
  const comparisons: Comparison[] = db
    .all<ComparisonRow>(
      `select id, event_id, judge_id, left_id, right_id, outcome, winner_id, reason, decided_at
         from comparison where event_id = :e and outcome <> 'skip'
           and not exists (select 1 from membership m where m.event_id = comparison.event_id
             and m.account_id = comparison.judge_id and m.role = 'judge' and m.evidence_excluded_at is not null)
         order by id`,
      { e: eventId },
    )
    .map((row) => ({
      id: row.id,
      judge: row.judge_id,
      left: row.left_id,
      right: row.right_id,
      winner: row.winner_id as string,
    }));
  return { rubricVersion: resolved, rubric, ballots, comparisons };
}

export function ballotsOf(db: Db, eventId: string, judgeId: string): BallotRow[] {
  return db.all<BallotRow>(
    `select ${BALLOT_COLUMNS} from ballot where event_id = :e and judge_id = :j
      order by created_at, id`,
    { e: eventId, j: judgeId },
  );
}

export function comparisonsOf(db: Db, eventId: string, judgeId: string): ComparisonRow[] {
  return db.all<ComparisonRow>(
    `select id, event_id, judge_id, left_id, right_id, outcome, winner_id, reason, decided_at
       from comparison where event_id = :e and judge_id = :j order by decided_at, id`,
    { e: eventId, j: judgeId },
  );
}

/**
 * Every comparison in an event, skips included.
 *
 * `loadJudgingInput` is the reader for *ranking*, and it drops skips — a skip is evidence about the
 * judge, not about the pair — and it insists on a published rubric, because a ranking has to say
 * which rubric it ranked. The pair scheduler needs the opposite of both. It has to know which pairs
 * a judge has already been shown, and a skipped pair was shown; and an event running pure pairwise
 * may legitimately have no rubric at all, so requiring one would make every duel a 409.
 *
 * Hence two readers rather than one with a flag. The two callers want genuinely different sets, and
 * a boolean parameter would leave the decision at the call site, which is where it gets forgotten.
 */
export function allComparisons(db: Db, eventId: string): ComparisonRow[] {
  return db.all<ComparisonRow>(
    `select id, event_id, judge_id, left_id, right_id, outcome, winner_id, reason, decided_at
       from comparison where event_id = :e order by decided_at, id`,
    { e: eventId },
  );
}

/**
 * What each judge has actually done.
 *
 * Drafts are counted separately from submissions because the difference is the whole
 * point: a judge with eleven drafts and no submissions looks idle on any dashboard
 * that adds them together, and is in fact the person to go and talk to. Skips are
 * counted for the same reason — a high skip rate is a signal about the pairs being
 * offered, not noise to be hidden.
 *
 * The counts are scalar subqueries rather than five left joins, because a left join
 * across four one-to-many tables multiplies rows and the `count(distinct ...)` needed
 * to undo that is both slower and easier to get wrong.
 */
export type JudgeProgress = {
  judgeId: string;
  name: string;
  email: string;
  assigned: number;
  submitted: number;
  drafts: number;
  comparisons: number;
  skipped: number;
  /** Last ballot or comparison, whichever is later; null if they have done nothing. */
  lastActiveAt: number | null;
};

export function judgeProgress(db: Db, eventId: string): JudgeProgress[] {
  const rows = db.all<{
    judgeId: string;
    name: string;
    email: string;
    assigned: number;
    submitted: number;
    drafts: number;
    comparisons: number;
    skipped: number;
    lastBallotAt: number | null;
    lastComparisonAt: number | null;
  }>(
    `select a.id as judgeId, a.display_name as name, a.email as email,
       (select count(*) from assignment s
         where s.event_id = :e and s.judge_id = a.id) as assigned,
       (select count(*) from ballot b
         where b.event_id = :e and b.judge_id = a.id and b.submitted_at is not null) as submitted,
       (select count(*) from ballot b
         where b.event_id = :e and b.judge_id = a.id and b.submitted_at is null) as drafts,
       (select count(*) from comparison c
         where c.event_id = :e and c.judge_id = a.id and c.outcome <> 'skip') as comparisons,
       (select count(*) from comparison c
         where c.event_id = :e and c.judge_id = a.id and c.outcome = 'skip') as skipped,
       (select max(b.submitted_at) from ballot b
         where b.event_id = :e and b.judge_id = a.id) as lastBallotAt,
       (select max(c.decided_at) from comparison c
         where c.event_id = :e and c.judge_id = a.id) as lastComparisonAt
     from membership m join account a on a.id = m.account_id
     where m.event_id = :e and m.role = 'judge' and m.active = 1
     order by a.display_name, a.id`,
    { e: eventId },
  );
  return rows.map((row) => {
    const seen = [row.lastBallotAt, row.lastComparisonAt].filter((at): at is number => at !== null);
    return {
      judgeId: row.judgeId,
      name: row.name,
      email: row.email,
      assigned: row.assigned,
      submitted: row.submitted,
      drafts: row.drafts,
      comparisons: row.comparisons,
      skipped: row.skipped,
      lastActiveAt: seen.length > 0 ? Math.max(...seen) : null,
    };
  });
}

/**
 * How well covered each project is, against the event's own target.
 *
 * `short` is the number the organizer acts on: it is how many more *submitted*
 * reviews the project needs, and it counts drafts as zero. That is the pessimistic
 * reading on purpose — a project sitting on three drafts has been looked at by three
 * judges and scored by none, and treating it as covered is how a project reaches the
 * results page on no evidence.
 */
export type ProjectCoverage = {
  projectId: string;
  title: string;
  trackKey: string | null;
  assigned: number;
  submitted: number;
  drafts: number;
  target: number;
  short: number;
  comparisons: number;
};

export function projectCoverage(db: Db, event: EventRow, trackKey?: string): ProjectCoverage[] {
  const target = event.reviews_per_project;
  const rows = db.all<{
    projectId: string;
    title: string;
    trackKey: string | null;
    assigned: number;
    submitted: number;
    drafts: number;
    comparisons: number;
  }>(
    `select p.id as projectId, p.title as title, p.track_key as trackKey,
       (select count(*) from assignment s
         where s.event_id = :e and s.project_id = p.id) as assigned,
       (select count(*) from ballot b
         where b.event_id = :e and b.project_id = p.id and b.submitted_at is not null) as submitted,
       (select count(*) from ballot b
         where b.event_id = :e and b.project_id = p.id and b.submitted_at is null) as drafts,
       (select count(*) from comparison c
         where c.event_id = :e and c.outcome <> 'skip'
           and (c.left_id = p.id or c.right_id = p.id)) as comparisons
     from project p
     where p.event_id = :e and p.status = 'submitted'
       and (:track is null or p.track_key = :track)
     order by p.title, p.id`,
    { e: event.id, track: trackKey ?? null },
  );
  return rows.map((row) => ({ ...row, target, short: Math.max(0, target - row.submitted) }));
}

/** Projects that would reach the results page under-reviewed. Empty is the goal. */
export function coverageGaps(db: Db, event: EventRow): ProjectCoverage[] {
  return projectCoverage(db, event).filter((row) => row.short > 0);
}
