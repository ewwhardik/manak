/** Leave-one-reviewer-out influence analysis. Diagnostic only; never changes published scores. */
import type { Ballot, Rubric } from "./types.ts";
import { JudgingError } from "./types.ts";
import { normalizeScores } from "./normalize.ts";
import { rankDescending } from "./stats.ts";

export type SensitivityProject = {
  project: string;
  rank: number;
  maxRankShift: number;
  minScore: number;
  maxScore: number;
  missingWithoutJudge: number;
};

export function rankingSensitivity(rubric: Rubric, ballots: readonly Ballot[], maxRefits = 32): {
  method: string;
  judgesTested: number;
  judgesTotal: number;
  limited: boolean;
  unstableRefits: number;
  projects: SensitivityProject[];
} {
  if (!Number.isInteger(maxRefits) || maxRefits < 1 || maxRefits > 100) {
    throw new JudgingError("sensitivity.limit", "Refits must be bounded between 1 and 100.");
  }
  const baseline = normalizeScores(rubric, ballots);
  const judges = [...new Set(ballots.map((b) => b.judge))].sort();
  const projects = baseline.projects.map((p) => ({
    project: p.project, rank: p.rankAdjusted, maxRankShift: 0,
    minScore: p.adjusted, maxScore: p.adjusted, missingWithoutJudge: 0,
  }));
  let unstableRefits = 0;
  for (const judge of judges.slice(0, maxRefits)) {
    const remaining = ballots.filter((b) => b.judge !== judge);
    const fit = remaining.length === 0 ? null : normalizeScores(rubric, remaining);
    if (fit !== null && (!fit.converged || !fit.settled)) unstableRefits++;
    const fitted = new Map((fit?.projects ?? []).map((p) => [p.project, p]));
    // Compare order on the same surviving field, so missing projects don't cause fake movement.
    const commonRanks = rankDescending(baseline.projects.filter((p) => fitted.has(p.project))
      .map((p) => ({ key: p.project, score: p.adjusted })));
    for (const p of projects) {
      const after = fitted.get(p.project);
      if (after === undefined) { p.missingWithoutJudge++; continue; }
      p.maxRankShift = Math.max(p.maxRankShift, Math.abs((commonRanks.get(p.project) ?? p.rank) - after.rankAdjusted));
      p.minScore = Math.min(p.minScore, after.adjusted);
      p.maxScore = Math.max(p.maxScore, after.adjusted);
    }
  }
  return {
    method: "leave-one-judge-out; common-field rank movement; score ranges are sensitivity, not confidence intervals",
    judgesTested: Math.min(judges.length, maxRefits), judgesTotal: judges.length,
    limited: judges.length > maxRefits, unstableRefits,
    projects: projects.sort((a, b) => b.missingWithoutJudge - a.missingWithoutJudge || b.maxRankShift - a.maxRankShift || a.rank - b.rank),
  };
}
