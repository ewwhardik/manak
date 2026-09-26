/**
 * Hybrid Consensus Engine.
 *
 * Combines multi-criterion rubric scores with Bradley-Terry pairwise comparisons
 * into an exploratory weighted standardized ranking. This is not a joint MAP fit.
 *
 * Implements:
 * 1. Dual-modality standardization (z-score scaling with explicit organizer weights)
 * 2. Kendall's W (Coefficient of Concordance) measuring overall rater/modality agreement
 * 3. Individual project consensus metrics: rank shift and relative concordance
 */

import type { ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";
import type { NormalizationResult } from "./normalize.ts";
import type { BradleyTerryResult } from "./bradleyterry.ts";
import { mean, rankDescending, sd } from "./stats.ts";

export type ConsensusOptions = {
  /** Relative weight given to rubric vs pairwise (rubricWeight in [0, 1]). Pairwise gets 1 - rubricWeight. */
  rubricWeight?: number;
};

export type HybridProject = {
  project: ProjectId;
  consensusScore: number;
  rank: number;
  rubricScore: number;
  rubricRank: number;
  pairwiseScore: number;
  pairwiseRank: number;
  rankShift: number;
  concordance: number;
};

export type HybridConsensusResult = {
  projects: HybridProject[];
  kendallW: number;
  rubricWeight: number;
  pairwiseWeight: number;
};

/**
 * Computes Kendall's W (Coefficient of Concordance) across m rankings of n items.
 * W is in [0, 1], where 1 indicates unanimous agreement and 0 indicates complete independence.
 */
export function kendallW(rankings: readonly (readonly number[])[]): number {
  const m = rankings.length;
  const size = rankings[0]?.length ?? 0;
  if (rankings.some((r) => r.length !== size || r.some((v) => !Number.isFinite(v)))) {
    throw new JudgingError("consensus.rankings", "Rankings must be finite and have the same length.");
  }
  if (m <= 1) return 1;
  const n = rankings[0]?.length ?? 0;
  if (n <= 1) return 1;

  const rankSums = new Array<number>(n).fill(0);
  let tieCorrection = 0;
  for (let i = 0; i < m; i++) {
    const r = rankings[i];
    if (!r || r.length !== n) continue;
    // Re-rank to midranks: handles competition ranks, gaps, and ties consistently.
    const ordered = r.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    for (let start = 0; start < n;) {
      let end = start + 1;
      while (end < n && ordered[end]!.value === ordered[start]!.value) end++;
      const count = end - start;
      tieCorrection += count ** 3 - count;
      const midrank = (start + 1 + end) / 2;
      for (let j = start; j < end; j++) rankSums[ordered[j]!.index]! += midrank;
      start = end;
    }
  }

  const meanRankSum = (m * (n + 1)) / 2;
  let S = 0;
  for (let j = 0; j < n; j++) {
    const diff = (rankSums[j] ?? 0) - meanRankSum;
    S += diff * diff;
  }

  const denom = (m * m * (n * n * n - n) - m * tieCorrection) / 12;
  // All raters tied every item: no ordering information, not perfect agreement.
  if (denom === 0) return 0;
  return Math.min(1, Math.max(0, S / denom));
}

/**
 * Merges normalization fit and Bradley-Terry pairwise fit into a single consensus ranking.
 */
export function hybridConsensus(
  rubricFit: NormalizationResult,
  pairwiseFit: BradleyTerryResult,
  options: ConsensusOptions = {},
): HybridConsensusResult {
  const wR = options.rubricWeight ?? 0.5;
  if (!Number.isFinite(wR) || wR < 0 || wR > 1) {
    throw new JudgingError("consensus.weight", "Rubric weight must be between zero and one.");
  }
  const wP = 1 - wR;

  const rubricMap = new Map(rubricFit.projects.map((p) => [p.project, p]));
  const pairwiseMap = new Map(pairwiseFit.strengths.map((p) => [p.project, p]));

  const projectSet = new Set<ProjectId>();
  // Missing evidence is not an average score. Fuse only projects actually measured
  // by every active modality; pure-mode results use that modality's observed field.
  for (const p of rubricFit.projects) {
    if (wR > 0 && p.ballots > 0 && (wP === 0 || (pairwiseMap.get(p.project)?.comparisons ?? 0) > 0)) projectSet.add(p.project);
  }
  if (wR === 0) for (const p of pairwiseFit.strengths) if (p.comparisons > 0) projectSet.add(p.project);

  const projects = Array.from(projectSet).sort();
  const n = projects.length;
  if (n === 0) {
    return { projects: [], kendallW: 1, rubricWeight: wR, pairwiseWeight: wP };
  }

  const rScores = projects.map((id) => rubricMap.get(id)?.adjusted ?? rubricFit.grandMean);
  const rMean = mean(rScores);
  const rSd = sd(rScores) || 1;

  const pScores = projects.map((id) => pairwiseMap.get(id)?.beta ?? 0);
  const pMean = mean(pScores);
  const pSd = sd(pScores) || 1;

  const fusedScores = new Map<ProjectId, number>();
  for (let i = 0; i < n; i++) {
    const id = projects[i] as ProjectId;
    const zR = ((rScores[i] as number) - rMean) / rSd;
    const zP = ((pScores[i] as number) - pMean) / pSd;
    const zFused = wR * zR + wP * zP;
    fusedScores.set(id, rMean + zFused * rSd);
  }

  const ranks = rankDescending(
    projects.map((id) => ({ key: id, score: fusedScores.get(id) ?? 0 })),
  );

  const rubricRanks = rankDescending(
    projects.map((id) => ({ key: id, score: rubricMap.get(id)?.adjusted ?? rubricFit.grandMean })),
  );

  const pairwiseRanks = rankDescending(
    projects.map((id) => ({ key: id, score: pairwiseMap.get(id)?.beta ?? 0 })),
  );

  const hybridProjects: HybridProject[] = projects.map((id) => {
    const cRank = ranks.get(id) ?? 1;
    const rRank = rubricRanks.get(id) ?? 1;
    const pRank = pairwiseRanks.get(id) ?? 1;
    const rankShift = rRank - cRank;
    const concordance = n > 1 ? 1 - Math.abs(rRank - pRank) / (n - 1) : 1;

    return {
      project: id,
      consensusScore: fusedScores.get(id) ?? 0,
      rank: cRank,
      rubricScore: rubricMap.get(id)?.adjusted ?? rMean,
      rubricRank: rRank,
      pairwiseScore: pairwiseMap.get(id)?.beta ?? 0,
      pairwiseRank: pRank,
      rankShift,
      concordance,
    };
  });

  hybridProjects.sort((a, b) => a.rank - b.rank);

  const rRankVec = projects.map((id) => rubricRanks.get(id) ?? 1);
  const pRankVec = projects.map((id) => pairwiseRanks.get(id) ?? 1);
  const kW = kendallW([rRankVec, pRankVec]);

  return {
    projects: hybridProjects,
    kendallW: kW,
    rubricWeight: wR,
    pairwiseWeight: wP,
  };
}
