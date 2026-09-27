/** Decision support from measured evidence. Rubric units are never pairwise log-strengths. */
import { winProbability } from "./bradleyterry.ts";

export type FinalistEvidence = { id: string; adjusted: number; low?: number; high?: number };
export type PairwiseEvidence = {
  connected?: boolean; converged?: boolean;
  strengths?: readonly { project: string; beta: number; comparisons: number }[];
};
export type CloseCall = {
  state: "insufficient" | "overlap" | "separated" | "uncertainty-unavailable";
  delta: number | null;
  winProbabilityA: number | null;
  probabilityReason: string;
};
export function assessFinalists(finalists: readonly FinalistEvidence[], pairwise?: PairwiseEvidence | null): CloseCall {
  const [a, b] = finalists;
  const out: CloseCall = { state: "insufficient", delta: null, winProbabilityA: null,
    probabilityReason: "A converged, connected pairwise fit with comparisons for both finalists is required." };
  if (!a || !b || a.id === b.id || !Number.isFinite(a.adjusted) || !Number.isFinite(b.adjusted)) return out;
  out.delta = Math.abs(a.adjusted - b.adjusted);
  const bounded = (p: FinalistEvidence) => typeof p.low === "number" && typeof p.high === "number" &&
    Number.isFinite(p.low) && Number.isFinite(p.high) && p.low <= p.high;
  out.state = bounded(a) && bounded(b)
    ? Math.max(a.low!, b.low!) <= Math.min(a.high!, b.high!) ? "overlap" : "separated"
    : "uncertainty-unavailable";
  if (pairwise?.connected === true && pairwise.converged === true) {
    const left = pairwise.strengths?.find(p => p.project === a.id);
    const right = pairwise.strengths?.find(p => p.project === b.id);
    if (left && right && left.comparisons > 0 && right.comparisons > 0 &&
        Number.isFinite(left.beta) && Number.isFinite(right.beta)) {
      out.winProbabilityA = winProbability(left.beta, right.beta);
      out.probabilityReason = "Bradley–Terry fitted comparison probability, not the probability of deserving the award.";
    }
  }
  return out;
}
