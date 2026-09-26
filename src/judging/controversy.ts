/**
 * Reviewer Controversy & Polarization Detector.
 *
 * Prevents the silent failure mode of hackathon judging where polarized evaluations
 * (e.g., one judge giving 10/10 and another giving 2/10) get averaged into mediocrity (6/10)
 * without organizer intervention.
 *
 * Implements:
 * 1. Project-level polarization score and score-spread calculations.
 * 2. Categorization: 'polarized', 'consensus', or 'sparse'.
 * 3. Organizer Tie-Breaker Queue: prioritizes controversial projects where at least
 *    one judge scored them near the top.
 */

import type { Ballot, ProjectId, Rubric } from "./types.ts";
import { sd, mean } from "./stats.ts";
import { normalizedWeights, weightedTotals } from "./weighted.ts";

export type ControversyOptions = {
  /** Relative spread threshold (fraction of scale span) to flag as polarized (default: 0.35). */
  polarizationFraction?: number;
  /** Minimum reviews needed to evaluate controversy (default: 2). */
  minReviews?: number;
};

export type ProjectControversy = {
  project: ProjectId;
  reviewCount: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
  spread: number;
  scoreSd: number;
  controversyIndex: number;
  verdict: "polarized" | "consensus" | "sparse";
  tieBreakerPriority: number;
};

export type ControversyReport = {
  projects: ProjectControversy[];
  polarizedCount: number;
  consensusCount: number;
  sparseCount: number;
  panelControversyRate: number;
  priorityQueue: ProjectId[];
};

export const CONTROVERSY_DEFAULTS = {
  polarizationFraction: 0.35,
  minReviews: 2,
} as const;

/**
 * Evaluates inter-judge spread and polarization across all submitted project ballots.
 */
export function detectControversy(
  rubric: Rubric,
  ballots: readonly Ballot[],
  options: ControversyOptions = {},
): ControversyReport {
  const minReviews = options.minReviews ?? CONTROVERSY_DEFAULTS.minReviews;
  const fraction = options.polarizationFraction ?? CONTROVERSY_DEFAULTS.polarizationFraction;

  // Compute scale span across rubric criteria
  let minPossible = 0;
  let maxPossible = 0;
  const weights = normalizedWeights(rubric.criteria);
  const totals = weightedTotals(rubric, ballots);
  for (const c of rubric.criteria) {
    minPossible += (weights.get(c.key) as number) * c.min;
    maxPossible += (weights.get(c.key) as number) * c.max;
  }
  const scaleSpan = maxPossible - minPossible;
  const criticalSpread = scaleSpan * fraction;

  // Group ballots by project
  const byProject = new Map<ProjectId, number[]>();
  for (const b of ballots) {
    const total = totals.get(b.id) as number;
    const list = byProject.get(b.project) ?? [];
    list.push(total);
    byProject.set(b.project, list);
  }

  const reports: ProjectControversy[] = [];
  let polarizedCount = 0;
  let consensusCount = 0;
  let sparseCount = 0;

  for (const [project, scores] of byProject.entries()) {
    const count = scores.length;
    if (count < minReviews) {
      sparseCount++;
      reports.push({
        project,
        reviewCount: count,
        meanScore: mean(scores),
        minScore: scores[0] ?? 0,
        maxScore: scores[0] ?? 0,
        spread: 0,
        scoreSd: 0,
        controversyIndex: 0,
        verdict: "sparse",
        tieBreakerPriority: 0,
      });
      continue;
    }

    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const spread = max - min;
    const scoreSd = sd(scores);
    const avg = mean(scores);

    const isPolarized = spread >= criticalSpread || scoreSd >= criticalSpread * 0.6;
    const verdict = isPolarized ? "polarized" : "consensus";

    if (isPolarized) polarizedCount++;
    else consensusCount++;

    const controversyIndex = (spread / scaleSpan) * (1 + scoreSd / scaleSpan);

    // Tie-breaker priority: highest for polarized projects that received at least one stellar score
    // (meaning they might be a top contender that got penalized by an unfair outlier)
    const upperReachBonus = (max - minPossible) / scaleSpan;
    const tieBreakerPriority = isPolarized ? controversyIndex * (1 + upperReachBonus) : 0;

    reports.push({
      project,
      reviewCount: count,
      meanScore: avg,
      minScore: min,
      maxScore: max,
      spread,
      scoreSd,
      controversyIndex,
      verdict,
      tieBreakerPriority,
    });
  }

  // Sort reports: polarized first, then by priority descending
  reports.sort((a, b) => b.tieBreakerPriority - a.tieBreakerPriority || b.controversyIndex - a.controversyIndex);

  const priorityQueue = reports
    .filter((r) => r.verdict === "polarized")
    .map((r) => r.project);

  const totalAssessed = polarizedCount + consensusCount;
  const panelControversyRate = totalAssessed > 0 ? polarizedCount / totalAssessed : 0;

  return {
    projects: reports,
    polarizedCount,
    consensusCount,
    sparseCount,
    panelControversyRate,
    priorityQueue,
  };
}
