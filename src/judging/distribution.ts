/** Exact one-dimensional empirical W2 distance; no Sinkhorn approximation is needed. */
import { JudgingError } from "./types.ts";
import type { Ballot, Rubric } from "./types.ts";
import { weightedTotals } from "./weighted.ts";
import { mean, median } from "./stats.ts";

export function wasserstein2(a: readonly number[], b: readonly number[]): number {
  if (!a.length || !b.length || [...a, ...b].some((x) => !Number.isFinite(x))) {
    throw new JudgingError("distribution.sample", "Wasserstein distance requires two nonempty finite samples.");
  }
  const x = [...a].sort((u, v) => u - v), y = [...b].sort((u, v) => u - v);
  let i = 0, j = 0, previous = 0, sum = 0;
  while (i < x.length && j < y.length) {
    const nextX = (i + 1) / x.length, nextY = (j + 1) / y.length;
    const next = Math.min(nextX, nextY);
    sum += (next - previous) * (x[i]! - y[j]!) ** 2;
    previous = next;
    if (nextX <= nextY) i++;
    if (nextY <= nextX) j++;
  }
  return Math.sqrt(sum);
}

export function distributionCalibration(rubric: Rubric, ballots: readonly Ballot[]) {
  const totals = weightedTotals(rubric, ballots);
  const byProject = new Map<string, Ballot[]>();
  for (const ballot of ballots) {
    if (!byProject.has(ballot.project)) byProject.set(ballot.project, []);
    byProject.get(ballot.project)!.push(ballot);
  }
  const judges = [...new Set(ballots.map((b) => b.judge))].sort();
  const profiles = judges.map((judge) => {
    const residuals: number[] = [], reference: number[] = [];
    for (const group of byProject.values()) {
      const own = group.filter((b) => b.judge === judge), peers = group.filter((b) => b.judge !== judge);
      if (!own.length || !peers.length) continue;
      const peerMean = mean(peers.map((b) => totals.get(b.id)!));
      residuals.push(mean(own.map((b) => totals.get(b.id)!)) - peerMean);
      // Require two peers for a reference residual that excludes the scored reviewer.
      if (peers.length > 1) {
        const sum = peers.reduce((s, b) => s + totals.get(b.id)!, 0);
        for (const peer of peers) reference.push(totals.get(peer.id)! - (sum - totals.get(peer.id)!) / (peers.length - 1));
      }
    }
    const usable = residuals.length >= 3 && reference.length >= 3;
    return { judge, overlapProjects: residuals.length, referenceSamples: reference.length,
      status: usable ? "measured" : "insufficient-overlap",
      distance: usable ? wasserstein2(residuals, reference) : null,
      medianResidual: residuals.length ? median(residuals) : null,
      meanResidual: residuals.length ? mean(residuals) : null };
  });
  return { method: "exact empirical W2 on shared-project residuals against leave-reviewer-out peers",
    profiles: profiles.sort((a, b) => (b.distance ?? -1) - (a.distance ?? -1)),
    note: "Diagnostic distance in normalized rubric units. Shared projects reduce assignment confounding but do not establish causality. Samples are dependent and small; no significance threshold, automatic quantile warp, or ballot discount is applied.",
  };
}
