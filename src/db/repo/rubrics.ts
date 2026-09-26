/**
 * Rubrics and their criteria.
 *
 * Rubrics are immutable once published, and a new version is the only way to change
 * one. That is not fussiness: a ballot stores the version it was scored against, so
 * editing a published criterion would retroactively change what a judge meant by a 4
 * — and the normalization model would then be fitting scores from two different
 * scales as though they were one.
 *
 * The rule is enforced here rather than by a trigger. A trigger would be a second
 * place to look for why a write failed, and the schema already carries the parts of
 * this it can express: a rubric version with ballots against it cannot be deleted.
 */

import type { Criterion, Rubric } from "../../judging/types.ts";
import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";

export type RubricRow = {
  event_id: string;
  version: number;
  published_at: number | null;
  created_at: number;
};

export type CriterionRow = {
  event_id: string;
  rubric_version: number;
  key: string;
  label: string;
  weight: number;
  min_score: number;
  max_score: number;
  ordering: number;
};

export type CriterionInput = {
  key: string;
  label: string;
  weight?: number;
  min?: number;
  max?: number;
};

export function listRubrics(db: Db, eventId: string): RubricRow[] {
  return db.all<RubricRow>(
    `select event_id, version, published_at, created_at from rubric
      where event_id = :e order by version`,
    { e: eventId },
  );
}

export function findRubric(db: Db, eventId: string, version: number): RubricRow | undefined {
  return db.get<RubricRow>(
    `select event_id, version, published_at, created_at from rubric
      where event_id = :e and version = :v`,
    { e: eventId, v: version },
  );
}

export function criteriaOf(db: Db, eventId: string, version: number): CriterionRow[] {
  return db.all<CriterionRow>(
    `select event_id, rubric_version, key, label, weight, min_score, max_score, ordering
       from criterion where event_id = :e and rubric_version = :v order by ordering, key`,
    { e: eventId, v: version },
  );
}

/** The version judges are scoring against, or nothing if none has been published. */
export function publishedVersion(db: Db, eventId: string): number | undefined {
  return db.get<{ version: number }>(
    `select version from rubric where event_id = :e and published_at is not null
      order by version desc limit 1`,
    { e: eventId },
  )?.version;
}

/**
 * The engine's view of a rubric.
 *
 * `src/judging` knows nothing about this database, so the shapes are converted here.
 * The conversion is the only place the two vocabularies meet, which is why it is one
 * function rather than an inline map at each call site.
 */
export function loadRubric(db: Db, eventId: string, version: number): Rubric {
  const rows = criteriaOf(db, eventId, version);
  if (rows.length === 0) {
    throw new RuleError(
      "rubric.missing",
      `Event ${eventId} has no criteria for rubric version ${version}.`,
      { event: eventId, version },
    );
  }
  const criteria: Criterion[] = rows.map((row) => ({
    key: row.key,
    label: row.label,
    weight: row.weight,
    min: row.min_score,
    max: row.max_score,
  }));
  return { id: `${eventId}/v${version}`, version, criteria };
}

/**
 * Create the next version of an event's rubric.
 *
 * Always a new version, never an edit. The version number is read inside the
 * transaction, so two organizers saving at once produce versions 3 and 4 rather than
 * two rows claiming to be 3 — the second one fails the primary key and retries.
 */
export function createRubricVersion(
  ctx: Ctx,
  eventId: string,
  criteria: readonly CriterionInput[],
): { version: number; criteria: CriterionRow[] } {
  if (criteria.length === 0) {
    throw new RuleError("rubric.empty", "A rubric needs at least one criterion.");
  }
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (seen.has(criterion.key)) {
      throw new RuleError("rubric.duplicateKey", `Criterion ${criterion.key} appears twice.`);
    }
    seen.add(criterion.key);
    if ((criterion.weight ?? 1) <= 0) {
      throw new RuleError(
        "rubric.weight",
        `Criterion ${criterion.key} has weight ${criterion.weight}. A criterion that counts for ` +
          `nothing should be removed, not weighted zero.`,
      );
    }
    if ((criterion.max ?? 5) <= (criterion.min ?? 1)) {
      throw new RuleError(
        "rubric.range",
        `Criterion ${criterion.key} has an empty score range.`,
      );
    }
  }
  return ctx.db.tx(() => {
    const previous = ctx.db.get<{ version: number }>(
      "select version from rubric where event_id = :e order by version desc limit 1",
      { e: eventId },
    );
    const version = (previous?.version ?? 0) + 1;
    return ctx.recorded(
      {
        action: "rubric.created",
        eventId,
        subject: `v${version}`,
        payload: { version, criteria: criteria.map((c) => c.key) },
      },
      () => {
        ctx.write(
          "insert into rubric (event_id, version, created_at) values (:e, :v, :at)",
          { e: eventId, v: version, at: ctx.now() },
        );
        criteria.forEach((criterion, index) => {
          ctx.write(
            `insert into criterion (event_id, rubric_version, key, label, weight,
               min_score, max_score, ordering)
             values (:e, :v, :key, :label, :weight, :min, :max, :ordering)`,
            {
              e: eventId,
              v: version,
              key: criterion.key,
              label: criterion.label,
              weight: criterion.weight ?? 1,
              min: criterion.min ?? 1,
              max: criterion.max ?? 5,
              ordering: index,
            },
          );
        });
        return { version, criteria: criteriaOf(ctx.db, eventId, version) };
      },
    );
  });
}

/**
 * Publish a version, which is what makes it the one judges score against.
 *
 * Publishing is one-way. Unpublishing would leave ballots pointing at a version that
 * is no longer current, and the only honest thing to do with those ballots is keep
 * them — so the operation an organizer actually wants is a new version.
 */
export function publishRubric(ctx: Ctx, eventId: string, version: number): RubricRow {
  const rubric = findRubric(ctx.db, eventId, version);
  if (!rubric) {
    throw new RuleError("rubric.missing", `No rubric version ${version} for this event.`);
  }
  if (rubric.published_at !== null) return rubric;
  if (criteriaOf(ctx.db, eventId, version).length === 0) {
    throw new RuleError("rubric.empty", "That version has no criteria.");
  }
  const superseded = publishedVersion(ctx.db, eventId);
  return ctx.recorded(
    {
      action: "rubric.published",
      eventId,
      subject: `v${version}`,
      payload: { version, supersedes: superseded ?? null },
    },
    () => {
      ctx.write(
        "update rubric set published_at = :at where event_id = :e and version = :v",
        { at: ctx.now(), e: eventId, v: version },
      );
      return ctx.db.one<RubricRow>(
        `select event_id, version, published_at, created_at from rubric
          where event_id = :e and version = :v`,
        { e: eventId, v: version },
      );
    },
  );
}

/**
 * The check the schema cannot make.
 *
 * A CHECK constraint on `score.value` would need to read the criterion's own bounds,
 * which means a subquery, which SQLite forbids. So the range lives in one function,
 * called on every write, and `verifyScoreRanges` sweeps for anything that got in
 * another way.
 */
export function assertScoreInRange(criterion: CriterionRow, value: number): void {
  if (!Number.isInteger(value) || value < criterion.min_score || value > criterion.max_score) {
    throw new RuleError(
      "score.range",
      `${criterion.label} takes a whole number from ${criterion.min_score} to ` +
        `${criterion.max_score}; got ${value}.`,
      { criterion: criterion.key, min: criterion.min_score, max: criterion.max_score, value },
    );
  }
}

/** Scores outside their criterion's range. Should always be empty; asserted in tests. */
export function verifyScoreRanges(
  db: Db,
): { ballot_id: string; criterion_key: string; value: number; min_score: number; max_score: number }[] {
  return db.all(
    `select s.ballot_id, s.criterion_key, s.value, c.min_score, c.max_score
       from score s
       join criterion c
         on c.event_id = s.event_id
        and c.rubric_version = s.rubric_version
        and c.key = s.criterion_key
      where s.value < c.min_score or s.value > c.max_score
      order by s.ballot_id, s.criterion_key`,
  );
}
