/**
 * Multi-Stage Finalist Triage & Bubble Resolution Engine.
 *
 * Implements statistical qualification boundaries for hackathons selecting Top-K finalists:
 * 1. Uses fitted score and standard error confidence intervals [L_i, U_i].
 * 2. Partitions the field into:
 *    - 'guaranteed': Statistically confident finalists (L_i exceeds non-finalist upper bounds).
 *    - 'bubble': Contested projects whose intervals overlap the cut line.
 *    - 'eliminated': Projects that cannot statistically reach the cut line.
 * 3. Recommends minimal targeted tie-breaker duels between bubble projects.
 */

import type { ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";

export type FinalistCandidate = {
  project: ProjectId;
  fitted: number;
  standardError: number;
  rank: number;
};

export type TriagedProject = FinalistCandidate & {
  lowerBound: number;
  upperBound: number;
  status: "guaranteed" | "bubble" | "eliminated";
};

export type RecommendedDuel = {
  left: ProjectId;
  right: ProjectId;
  reason: string;
};

export type FinalistTriageReport = {
  targetK: number;
  cutoffScore: number;
  guaranteed: TriagedProject[];
  bubble: TriagedProject[];
  eliminated: TriagedProject[];
  isCutDecisive: boolean;
  recommendedDuels: RecommendedDuel[];
};

export type TriageOptions = {
  /** Critical z-score for the confidence interval (default: 1.96 for 95% confidence). */
  zMultiplier?: number;
};

/**
 * Triages projects into guaranteed finalists, contested bubble, and eliminated candidates.
 */
export function triageFinalists(
  candidates: readonly FinalistCandidate[],
  targetK: number,
  options: TriageOptions = {},
): FinalistTriageReport {
  const z = options.zMultiplier ?? 1.96;
  if (!Number.isInteger(targetK) || targetK < 0 || !Number.isFinite(z) || z < 0) {
    throw new JudgingError("finalists.options", "The cut must be a non-negative integer and the interval multiplier finite and non-negative.");
  }
  const ids = new Set<string>();
  for (const c of candidates) {
    if (ids.has(c.project) || !Number.isFinite(c.fitted) || !Number.isFinite(c.standardError) || c.standardError < 0) {
      throw new JudgingError("finalists.candidate", "Candidates need unique ids, finite scores and non-negative finite errors.");
    }
    ids.add(c.project);
  }
  const sorted = candidates.slice().sort((a, b) => b.fitted - a.fitted || a.project.localeCompare(b.project));
  const n = sorted.length;
  const k = Math.min(targetK, n);

  const kProject = sorted[k - 1];
  const nextProject = sorted[k];

  const cutoffScore = kProject ? kProject.fitted : 0;

  // Compute confidence bounds for all projects
  const bounded: TriagedProject[] = sorted.map((c) => {
    const margin = z * c.standardError;
    return {
      ...c,
      lowerBound: c.fitted - margin,
      upperBound: c.fitted + margin,
      status: "bubble" as const, // will be assigned below
    };
  });

  const guaranteed: TriagedProject[] = [];
  const bubble: TriagedProject[] = [];
  const eliminated: TriagedProject[] = [];

  for (let i = 0; i < n; i++) {
    const p = bounded[i]!;
    // Compare with EVERY candidate, including a low-ranked project with a wide interval.
    // Equal endpoints remain contested. These are interval scenarios, not simultaneous
    // confidence guarantees: individual 95% intervals do not give a 95% familywise cut.
    const possiblyAhead = bounded.filter((q) => q !== p && q.upperBound >= p.lowerBound).length;
    const certainlyAhead = bounded.filter((q) => q !== p && q.lowerBound > p.upperBound).length;
    if (k === n || (k > 0 && possiblyAhead < k)) {
      p.status = "guaranteed";
      guaranteed.push(p);
    }
    // Eliminated: upper bound is below the lower bound of the k-th project
    else if (k === 0 || certainlyAhead >= k) {
      p.status = "eliminated";
      eliminated.push(p);
    }
    // Bubble: overlap with the cut zone
    else {
      p.status = "bubble";
      bubble.push(p);
    }
  }

  // A cut is decisive if the bubble has 0 projects (or exactly matches the gap)
  const isCutDecisive = bubble.length === 0;

  // Generate targeted tie-breaker duels between bubble projects closest to the cutoff
  const recommendedDuels: RecommendedDuel[] = [];
  if (bubble.length >= 2) {
    // Cross the provisional cut; adjacent pairs on the same side cannot resolve it.
    const above = bubble.filter((p) => sorted.findIndex((c) => c.project === p.project) < k).reverse();
    const below = bubble.filter((p) => sorted.findIndex((c) => c.project === p.project) >= k);
    for (let i = 0; i < Math.min(above.length, below.length); i++) {
      const a = above[i]!;
      const b = below[i]!;
      recommendedDuels.push({
        left: a.project,
        right: b.project,
        reason: `Bubble boundary duel between rank ${a.rank} and rank ${b.rank} to resolve Finalist Cut ${targetK}`,
      });
    }
  }

  return {
    targetK: k,
    cutoffScore,
    guaranteed,
    bubble,
    eliminated,
    isCutDecisive,
    recommendedDuels,
  };
}
