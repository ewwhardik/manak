/**
 * Weighted rubric totals.
 *
 * The market leader in this category cannot weight its criteria at all and tells
 * organizers who need weights to judge offline in a spreadsheet. Weighting is
 * therefore table stakes here, and getting the scale right matters: weights are
 * normalized to sum to one so a weighted total stays on the same 1-5 scale a
 * judge actually saw. Nobody has to reason about what a 17.4 means.
 */

import type { Ballot, Criterion, Rubric } from "./types.ts";
import { JudgingError } from "./types.ts";

export function normalizedWeights(criteria: readonly Criterion[]): Map<string, number> {
  if (criteria.length === 0) {
    throw new JudgingError("rubric.empty", "A rubric needs at least one criterion.");
  }
  let total = 0;
  const keys = new Set<string>();
  for (const c of criteria) {
    if (!c.key || keys.has(c.key)) {
      throw new JudgingError("rubric.key", "Criterion keys must be non-empty and unique.");
    }
    keys.add(c.key);
    if (!Number.isFinite(c.weight) || !(c.weight > 0)) {
      throw new JudgingError("rubric.weight", `Criterion "${c.key}" has a non-positive weight.`);
    }
    if (!Number.isFinite(c.min) || !Number.isFinite(c.max) || !(c.max > c.min)) {
      throw new JudgingError("rubric.scale", `Criterion "${c.key}" has an empty scale.`);
    }
    total += c.weight;
  }
  if (!Number.isFinite(total)) throw new JudgingError("rubric.weight", "The total weight must be finite.");
  const out = new Map<string, number>();
  for (const c of criteria) out.set(c.key, c.weight / total);
  return out;
}

/**
 * The weighted total for one ballot, on the rubric's own scale.
 *
 * Missing and out-of-range scores throw rather than defaulting. A ballot that
 * silently scores zero for a criterion the judge never saw is a data integrity
 * bug that would surface as an unexplained ranking six weeks later.
 */
export function weightedTotal(rubric: Rubric, scores: Record<string, number>): number {
  const weights = normalizedWeights(rubric.criteria);
  let total = 0;
  for (const c of rubric.criteria) {
    const raw = scores[c.key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new JudgingError("ballot.missing", `Ballot is missing a score for "${c.key}".`);
    }
    if (raw < c.min || raw > c.max) {
      throw new JudgingError(
        "ballot.range",
        `Score ${raw} for "${c.key}" is outside [${c.min}, ${c.max}].`,
      );
    }
    total += (weights.get(c.key) as number) * raw;
  }
  return total;
}

/** Convenience: total every ballot once, keyed by ballot id. */
export function weightedTotals(rubric: Rubric, ballots: readonly Ballot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of ballots) {
    if (b.rubricVersion !== rubric.version) {
      throw new JudgingError(
        "ballot.rubricVersion",
        `Ballot ${b.id} was scored against rubric version ${b.rubricVersion}, not ${rubric.version}. ` +
          `Normalize each version separately, or migrate the ballots deliberately.`,
      );
    }
    out.set(b.id, weightedTotal(rubric, b.scores));
  }
  return out;
}

/** The midpoint of a rubric's scale, used as the reporting anchor. */
export function scaleMidpoint(rubric: Rubric): number {
  const weights = normalizedWeights(rubric.criteria);
  let mid = 0;
  for (const c of rubric.criteria) {
    mid += (weights.get(c.key) as number) * ((c.min + c.max) / 2);
  }
  return mid;
}
