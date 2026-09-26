/** Weighted graph Hodge decomposition of observed pair preferences. Advisory only. */
import type { Comparison } from "./types.ts";
import { JudgingError } from "./types.ts";
import { components } from "./stats.ts";

type Edge = { left: string; right: string; wins: number; losses: number; weight: number; observed: number };
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

/** Matrix-free conjugate gradients. PSD systems here have consistent right-hand sides. */
function solve(rhs: number[], multiply: (x: number[]) => number[]) {
  const x = rhs.map(() => 0);
  let residual = rhs.slice();
  let direction = residual.slice();
  let norm = dot(residual, residual);
  const threshold = Math.max(1e-20, norm * 1e-18);
  let iterations = 0;
  for (; norm > threshold && iterations < 2000; iterations++) {
    const ad = multiply(direction);
    const denominator = dot(direction, ad);
    if (denominator <= 1e-25) break;
    const alpha = norm / denominator;
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + alpha * direction[i]!;
    const next = residual.map((r, i) => r - alpha * ad[i]!);
    const nextNorm = dot(next, next);
    direction = next.map((r, i) => r + (nextNorm / norm) * direction[i]!);
    residual = next;
    norm = nextNorm;
  }
  return { x, converged: norm <= threshold, iterations, residual: Math.sqrt(norm) };
}

export function decomposeTournament(comparisons: readonly Comparison[], projects: readonly string[]) {
  const ids = [...new Set(projects)].sort();
  if (ids.length > 120 || comparisons.length > 20000) throw new JudgingError("hodge.limit", "The evidence lab supports up to 120 projects and 20,000 decided comparisons.");
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairs = new Map<string, Edge>();
  const seen = new Set<string>();
  for (const c of comparisons) {
    if (seen.has(c.id)) throw new JudgingError("hodge.duplicate", "A comparison cannot be counted twice.");
    seen.add(c.id);
    if (c.left === c.right || !index.has(c.left) || !index.has(c.right) || (c.winner !== c.left && c.winner !== c.right)) {
      throw new JudgingError("hodge.comparison", "Comparisons must name two distinct projects in the supplied field and one of them as winner.");
    }
    const [left, right] = [c.left, c.right].sort() as [string, string];
    const key = JSON.stringify([left, right]);
    let edge = pairs.get(key);
    if (!edge) { edge = { left, right, wins: 0, losses: 0, weight: 0, observed: 0 }; pairs.set(key, edge); }
    if (c.winner === left) edge.wins++; else edge.losses++;
    edge.weight++;
  }
  const edges = [...pairs.values()].sort((a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
  for (const edge of edges) edge.observed = Math.log((edge.wins + 0.5) / (edge.losses + 0.5));
  const endpoints = edges.map((e) => [index.get(e.left)!, index.get(e.right)!] as const);
  const divergence = (flow: number[]) => {
    const out = ids.map(() => 0);
    edges.forEach((e, k) => { const [i, j] = endpoints[k]!; out[i] = out[i]! + e.weight * flow[k]!; out[j] = out[j]! - e.weight * flow[k]!; });
    return out;
  };
  const gradient = (x: number[]) => endpoints.map(([i, j]) => x[i]! - x[j]!);
  const potential = solve(divergence(edges.map((e) => e.observed)), (x) => divergence(gradient(x)));
  const global = gradient(potential.x);
  const residual = edges.map((e, i) => e.observed - global[i]!);
  const edgeIndex = new Map(edges.map((e, i) => [JSON.stringify([e.left, e.right]), i]));
  const triangles: [number, number, number][] = [];
  let triangleTotal = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const ij = edgeIndex.get(JSON.stringify([ids[i], ids[j]]));
    if (ij === undefined) continue;
    for (let k = j + 1; k < ids.length; k++) {
      const jk = edgeIndex.get(JSON.stringify([ids[j], ids[k]]));
      const ik = edgeIndex.get(JSON.stringify([ids[i], ids[k]]));
      if (jk === undefined || ik === undefined) continue;
      triangleTotal++;
      if (triangles.length < 4000) triangles.push([ij, jk, ik]);
    }
  }
  // C is the oriented triangle boundary; W^-1 C lies in the divergence-free subspace.
  const boundary = (x: number[]) => {
    const out = edges.map(() => 0);
    triangles.forEach(([ij, jk, ik], t) => { out[ij] = out[ij]! + x[t]!; out[jk] = out[jk]! + x[t]!; out[ik] = out[ik]! - x[t]!; });
    return out.map((v, k) => v / edges[k]!.weight);
  };
  const circulation = (x: number[]) => triangles.map(([ij, jk, ik]) => x[ij]! + x[jk]! - x[ik]!);
  const curlFit = solve(circulation(residual), (x) => circulation(boundary(x)));
  const curl = boundary(curlFit.x);
  const harmonic = residual.map((x, k) => x - curl[k]!);
  const energy = (flow: number[]) => edges.reduce((sum, e, k) => sum + e.weight * flow[k]! ** 2, 0);
  const total = energy(edges.map((e) => e.observed));
  const share = (flow: number[]) => total > 1e-20 ? energy(flow) / total : 0;
  const groups = components(ids, edges.map((e) => [e.left, e.right]));
  return {
    method: "weighted Hodge projection; half-count log odds; observed edges only",
    projects: ids.length, comparisons: comparisons.length, edges: edges.length,
    componentCount: groups.length, triangles: triangleTotal, trianglesUsed: triangles.length,
    limited: triangleTotal > triangles.length,
    converged: potential.converged && curlFit.converged,
    gradientShare: share(global), curlShare: share(curl), harmonicShare: share(harmonic),
    cyclicShare: share(residual), totalEnergy: total,
    reconstructionError: Math.abs(total - energy(global) - energy(curl) - energy(harmonic)),
    divergenceError: Math.max(0, ...divergence(residual).map(Math.abs)),
    reviewPairs: edges.map((e, k) => ({ ...e, fitted: global[k]!, residual: residual[k]!,
      inconsistency: e.weight * residual[k]! ** 2 })).sort((a, b) => b.inconsistency - a.inconsistency).slice(0, 12),
    note: "Cycles describe collective preferences, not a culpable judge or ballot. Disconnected components have no common ranking. Sparse graphs can hide disagreement; zero cycle energy is not proof of agreement. With a truncated triangle basis, harmonic means unexplained residual, not a full harmonic decomposition.",
  };
}
