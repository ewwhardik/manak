/** Likelihood-only Fisher geometry. Priors must not manufacture comparison evidence. */
import type { Comparison } from "./types.ts";
import { JudgingError } from "./types.ts";
import { components } from "./stats.ts";

export type InformationPair = {
  left: string; right: string; comparisons: number;
  resistance: number | null; relativeSE: number | null;
  informationGain: number | null; leverage: number | null;
  reason: "bridge" | "information";
};

/** Cholesky factorization and triangular solves, never a general matrix inverse. */
function covariance(matrix: number[][]): { inverse: number[][]; residual: number } {
  const n = matrix.length;
  const l = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const scale = Math.max(...matrix.map((row, i) => row[i]!));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= l[i]![k]! * l[j]![k]!;
    if (i === j && (!Number.isFinite(value) || value <= scale * 1e-13)) {
      throw new JudgingError("information.singular", "Comparison information is numerically singular; collect more balanced comparisons.");
    }
    l[i]![j] = i === j ? Math.sqrt(value) : value / l[j]![j]!;
  }
  const inverse = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let col = 0; col < n; col++) {
    const y = Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let v = i === col ? 1 : 0;
      for (let k = 0; k < i; k++) v -= l[i]![k]! * y[k]!;
      y[i] = v / l[i]![i]!;
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = y[i]!;
      for (let k = i + 1; k < n; k++) v -= l[k]![i]! * inverse[k]![col]!;
      inverse[i]![col] = v / l[i]![i]!;
    }
  }
  let residual = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let v = 0;
    for (let k = 0; k < n; k++) v += matrix[i]![k]! * inverse[k]![j]!;
    residual = Math.max(residual, Math.abs(v - (i === j ? 1 : 0)));
  }
  return { inverse, residual };
}

export function comparisonInformation(
  comparisons: readonly Comparison[], projects: readonly string[],
  strengths: ReadonlyMap<string, number>,
) {
  const ids = [...new Set(projects)].sort();
  if (ids.length > 120 || comparisons.length > 20000) {
    throw new JudgingError("information.limit", "Information analysis supports at most 120 projects and 20,000 comparisons.");
  }
  const known = new Set(ids);
  const counts = new Map<string, number>();
  const key = (a: string, b: string) => JSON.stringify([a, b].sort());
  const seen = new Set<string>();
  for (const c of comparisons) {
    if (!known.has(c.left) || !known.has(c.right) || c.left === c.right ||
        (c.winner !== c.left && c.winner !== c.right) || seen.has(c.id)) {
      throw new JudgingError("information.input", "Comparisons need distinct IDs, known endpoints, and a valid winner.");
    }
    seen.add(c.id);
    counts.set(key(c.left, c.right), (counts.get(key(c.left, c.right)) ?? 0) + 1);
  }
  for (const id of ids) if (!Number.isFinite(strengths.get(id))) {
    throw new JudgingError("information.strength", "Every project needs a finite fitted log-strength.");
  }
  // Stable logistic curvature avoids cancellation in p * (1 - p) at extreme odds.
  const weight = (a: string, b: string) => {
    const e = Math.exp(-Math.abs(strengths.get(a)! - strengths.get(b)!));
    return e / (1 + e) ** 2;
  };
  const groups = components(ids, comparisons.map((c) => [c.left, c.right] as [string, string]));
  const membership = new Map<string, number>();
  const resistances = new Map<string, number>();
  let solveResidual = 0;
  for (const [groupIndex, group] of groups.entries()) {
    group.sort();
    group.forEach((id) => membership.set(id, groupIndex));
    if (group.length < 2) continue;
    // Ground one vertex per component. Contrasts do not depend on the grounded vertex.
    const n = group.length - 1;
    const l = Array.from({ length: n }, () => Array<number>(n).fill(0));
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const w = (counts.get(key(group[i]!, group[j]!)) ?? 0) * weight(group[i]!, group[j]!);
      if (i < n) l[i]![i] = l[i]![i]! + w;
      if (j < n) l[j]![j] = l[j]![j]! + w;
      if (i < n && j < n) { l[i]![j] = l[i]![j]! - w; l[j]![i] = l[j]![i]! - w; }
    }
    const solved = covariance(l);
    solveResidual = Math.max(solveResidual, solved.residual);
    const entry = (i: number, j: number) => i < n && j < n ? solved.inverse[i]![j]! : 0;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      resistances.set(key(group[i]!, group[j]!), Math.max(0, entry(i, i) + entry(j, j) - entry(i, j) - entry(j, i)));
    }
  }
  const pairs: InformationPair[] = [];
  let leverageSum = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const left = ids[i]!, right = ids[j]!;
    const connected = membership.get(left) === membership.get(right);
    const resistance = connected ? resistances.get(key(left, right))! : null;
    const count = counts.get(key(left, right)) ?? 0;
    const leverage = resistance === null ? null : count * weight(left, right) * resistance;
    leverageSum += leverage ?? 0;
    pairs.push({ left, right, comparisons: count, resistance,
      relativeSE: resistance === null ? null : Math.sqrt(resistance),
      informationGain: resistance === null ? null : Math.log1p(weight(left, right) * resistance),
      leverage, reason: connected ? "information" : "bridge" });
  }
  const expectedLeverage = ids.length - groups.length;
  const leverageError = Math.abs(leverageSum - expectedLeverage);
  return {
    method: "likelihood Fisher Laplacian; grounded Cholesky; effective resistance; one-step D-optimal design",
    projectCount: ids.length, componentCount: groups.length,
    identifiableContrasts: expectedLeverage, solveResidual, leverageSum, leverageError,
    numericallySound: solveResidual < 1e-7 && leverageError < 1e-7,
    pairs,
    recommendations: [...pairs].sort((a, b) =>
      Number(b.reason === "bridge") - Number(a.reason === "bridge") ||
      (b.informationGain ?? 0) - (a.informationGain ?? 0) || a.comparisons - b.comparisons ||
      a.left.localeCompare(b.left) || a.right.localeCompare(b.right)).slice(0, 8),
    bottlenecks: pairs.filter((p) => p.comparisons > 0).sort((a, b) => (b.leverage ?? 0) - (a.leverage ?? 0)).slice(0, 8),
    note: "Local model information, not calibrated confidence or a winner probability. Repeated decisions may be dependent. Cross-component contrasts are unidentifiable. Suggestions are individual alternatives, not a jointly optimal batch; track, conflict and repeat-review rules still apply. No scores or assignments change.",
  };
}
