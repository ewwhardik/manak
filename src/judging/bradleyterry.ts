/**
 * Bradley-Terry ranking from pairwise comparisons.
 *
 * Asking a judge "which of these two is better?" sidesteps cross-judge
 * calibration entirely, because nobody is ever asked for an absolute number
 * there is no shared scale for. This is the approach Gavel brought into judging
 * from mathematical psychology, and it has been producing fairer rankings at
 * HackMIT for years.
 *
 * The model is
 *
 *     P(i beats j) = exp(beta_i) / (exp(beta_i) + exp(beta_j))
 *
 * fitted by the MM iteration from Hunter (2004), which is monotonic and needs no
 * step size. One subtlety sinks naive implementations: the maximum likelihood
 * estimate **does not exist** unless the win digraph is strongly connected. An
 * undefeated project has an unbounded strength, and the iteration marches off to
 * infinity. This is guarded twice over — a weak prior here turns the fit into a
 * MAP estimate that always converges, and the pair scheduler in `pairing.ts`
 * keeps the graph connected by construction rather than by luck.
 */

import type { Comparison, ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";
import { components, mean, rankDescending } from "./stats.ts";
import { agree, plural } from "./words.ts";

export type BradleyTerryOptions = {
  /**
   * Virtual comparisons against a phantom opponent of strength 1, split evenly
   * between a win and a loss. This is what guarantees a finite answer.
   */
  prior?: number;
  iterations?: number;
  tolerance?: number;
  /**
   * Where the iteration starts, as strengths on the multiplicative scale — that is,
   * `exp(beta)` and not `beta`. Missing, non-finite and non-positive entries start at
   * 1 as usual, so a partial map is a legal hint rather than a broken one.
   *
   * This changes how long the fit takes and not what it returns. With the prior in
   * place the objective is strictly concave in the log-strengths, so the fixed point is
   * unique and the starting point only decides how far the iteration has to walk to
   * reach it. It exists for `bootstrap.ts`, which fits the same model a few hundred
   * times on slightly different data: each replicate's answer is close to the published
   * one, so starting there rather than at unit strengths cuts the sweeps needed by
   * roughly an order of magnitude. `tests/bradleyterry.test.ts` pins the claim that a
   * warm start and a cold one agree.
   */
  start?: ReadonlyMap<ProjectId, number>;
};

export type Strength = {
  project: ProjectId;
  /** Log-strength, centred so the field averages zero. */
  beta: number;
  wins: number;
  losses: number;
  comparisons: number;
  rank: number;
};

export type BradleyTerryResult = {
  method: string;
  strengths: Strength[];
  iterations: number;
  converged: boolean;
  /** Undirected components of the comparison graph. One means comparable. */
  componentCount: number;
  connected: boolean;
  logLikelihood: number;
  warnings: string[];
};

/**
 * MM converges linearly, and the rate degrades as the comparison graph thins, so
 * the sweep budget has to be generous rather than tidy: a 120-project field with
 * five comparisons each needs a few thousand sweeps, which costs milliseconds.
 * `converged` is reported either way — a fit that ran out of budget says so
 * instead of quietly presenting a half-finished answer as final.
 */
/**
 * The settings used when the caller says nothing. Exported for the reason
 * `NORMALIZE_DEFAULTS` is: the pages print them and the tests pin them, and a
 * default that exists in two places is a default that silently stops matching.
 */
export const BRADLEY_TERRY_DEFAULTS = { prior: 1, iterations: 20000, tolerance: 1e-10 } as const;

const DEFAULTS = BRADLEY_TERRY_DEFAULTS;

export function winProbability(betaA: number, betaB: number): number {
  return 1 / (1 + Math.exp(betaB - betaA));
}

export function fitBradleyTerry(
  comparisons: readonly Comparison[],
  projects?: readonly ProjectId[],
  options: BradleyTerryOptions = {},
): BradleyTerryResult {
  const opt = { ...DEFAULTS, ...options };
  const ids = new Set<ProjectId>(projects ?? []);
  const wins = new Map<string, number>();
  const winTotal = new Map<ProjectId, number>();
  const lossTotal = new Map<ProjectId, number>();
  const pairCount = new Map<string, number>();

  const key = (a: ProjectId, b: ProjectId): string => `${a}\u0000${b}`;
  const pairKey = (a: ProjectId, b: ProjectId): string => (a < b ? key(a, b) : key(b, a));

  for (const c of comparisons) {
    if (c.left === c.right) {
      throw new JudgingError("comparison.self", `Comparison ${c.id} pits ${c.left} against itself.`);
    }
    if (c.winner !== c.left && c.winner !== c.right) {
      throw new JudgingError(
        "comparison.winner",
        `Comparison ${c.id} has winner ${c.winner}, which is neither side.`,
      );
    }
    const loser = c.winner === c.left ? c.right : c.left;
    ids.add(c.left);
    ids.add(c.right);
    wins.set(key(c.winner, loser), (wins.get(key(c.winner, loser)) ?? 0) + 1);
    winTotal.set(c.winner, (winTotal.get(c.winner) ?? 0) + 1);
    lossTotal.set(loser, (lossTotal.get(loser) ?? 0) + 1);
    const pk = pairKey(c.left, c.right);
    pairCount.set(pk, (pairCount.get(pk) ?? 0) + 1);
  }

  const items = [...ids].sort();
  if (items.length === 0) {
    throw new JudgingError("comparison.empty", "There are no comparisons to fit.");
  }

  // Opponent lists, so each update touches only projects actually faced.
  //
  // Indices rather than ids, and each pair's count carried alongside. The readable
  // version of the sweep below looked up `pairCount.get(pairKey(p, q))` for every
  // opponent of every project on every iteration, which builds a string and hashes two
  // maps per opponent visit — on a 120-project field that is tens of millions of string
  // allocations, and it was most of the cost of the engine. The arithmetic is unchanged
  // deliberately: neighbours are pushed in the order the readable version visited them,
  // so the additions into `denominator` happen in the same sequence and the doubles that
  // come out are bit-identical. Two proofs in `docs/proof` compare output byte for byte,
  // which makes that a requirement rather than a nicety.
  const idx = new Map<ProjectId, number>(items.map((p, i) => [p, i]));
  const nbr: number[][] = items.map(() => []);
  const nbrCount: number[][] = items.map(() => []);
  for (const [pk, n] of pairCount) {
    const [a, b] = pk.split("\u0000") as [ProjectId, ProjectId];
    const ia = idx.get(a) as number;
    const ib = idx.get(b) as number;
    (nbr[ia] as number[]).push(ib);
    (nbrCount[ia] as number[]).push(n);
    (nbr[ib] as number[]).push(ia);
    (nbrCount[ib] as number[]).push(n);
  }

  // Strengths in a Float64Array, indexed like `items`, updated in place. A double in a
  // typed array is the same double it was in the Map, so this is a storage change and not
  // an arithmetic one: the sweep still reads its own partial results as it goes, which is
  // what makes the iteration Gauss-Seidel rather than Jacobi and is load-bearing for the
  // convergence rate. The numerators are constant across sweeps, so they are computed once.
  const strength = new Float64Array(items.length);
  const numer = new Float64Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const p = items[i] as ProjectId;
    const hint = opt.start?.get(p);
    strength[i] = typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? hint : 1;
    numer[i] = (winTotal.get(p) ?? 0) + opt.prior / 2;
  }
  let converged = false;
  let used = 0;
  for (let iter = 0; iter < opt.iterations; iter++) {
    used = iter + 1;
    let movement = 0;
    for (let i = 0; i < items.length; i++) {
      const current = strength[i] as number;
      const qs = nbr[i] as number[];
      const ns = nbrCount[i] as number[];
      let denominator = opt.prior / (current + 1);
      for (let k = 0; k < qs.length; k++) {
        denominator += (ns[k] as number) / (current + (strength[qs[k] as number] as number));
      }
      const next = denominator > 0 ? (numer[i] as number) / denominator : current;
      movement = Math.max(movement, Math.abs(Math.log(next) - Math.log(current)));
      strength[i] = next;
    }
    if (movement < opt.tolerance) { converged = true; break; }
  }
  const pi = new Map<ProjectId, number>(items.map((p, i) => [p, strength[i] as number]));

  // The scale is pinned during iteration by the phantom opponent, so the sweep is
  // left alone and the result is centred once, here. Rescaling *inside* the loop
  // is the tempting mistake: the prior makes the objective scale-dependent, so
  // renormalizing every sweep fights the update and the iteration never settles —
  // it plateaus at the size of the correction instead of converging. Centring at
  // the end is free, because every quantity that matters (ranking, win
  // probabilities, log-likelihood) depends on differences of betas only.
  const logMean = mean(items.map((p) => Math.log(pi.get(p) as number)));
  const beta = new Map<ProjectId, number>(items.map((p) => [p, Math.log(pi.get(p) as number) - logMean]));
  const ranks = rankDescending(items.map((p) => ({ key: p, score: beta.get(p) as number })));

  let logLikelihood = 0;
  for (const [k, count] of wins) {
    const [winner, loser] = k.split("\u0000") as [ProjectId, ProjectId];
    const p = winProbability(beta.get(winner) as number, beta.get(loser) as number);
    logLikelihood += count * Math.log(Math.max(p, 1e-12));
  }

  const edges: [string, string][] = [...pairCount.keys()].map((pk) => {
    const [a, b] = pk.split("\u0000") as [string, string];
    return [a, b];
  });
  const parts = components(items, edges);

  const warnings: string[] = [];
  if (parts.length > 1) {
    warnings.push(
      `The comparison graph has ${parts.length} disconnected groups, so strengths are ` +
        `only comparable within a group. The prior keeps the fit finite, but the pair ` +
        `scheduler should be allowed to bridge them before these ranks are published.`,
    );
  }
  const undefeated = items.filter((p) => (lossTotal.get(p) ?? 0) === 0 && (winTotal.get(p) ?? 0) > 0);
  const winless = items.filter((p) => (winTotal.get(p) ?? 0) === 0 && (lossTotal.get(p) ?? 0) > 0);
  if (undefeated.length > 0 || winless.length > 0) {
    warnings.push(
      `Unbounded likelihood without the prior: ${plural(undefeated.length, "project")} ` +
        `${agree(undefeated.length, "has", "have")} no losses and ${winless.length} ` +
        `${agree(winless.length, "has", "have")} no wins. Their strengths are held finite by the ` +
        `prior (${opt.prior}) and should be read as provisional.`,
    );
  }
  const thin = items.filter((_p, i) => (nbr[i] as number[]).length < 2);
  if (thin.length > 0) {
    warnings.push(
      `${plural(thin.length, "project")} ${agree(thin.length, "has", "have")} been compared against ` +
        `fewer than two opponents.`,
    );
  }

  const strengths: Strength[] = items.map((p) => ({
    project: p,
    beta: beta.get(p) as number,
    wins: winTotal.get(p) ?? 0,
    losses: lossTotal.get(p) ?? 0,
    comparisons: (winTotal.get(p) ?? 0) + (lossTotal.get(p) ?? 0),
    rank: ranks.get(p) as number,
  }));
  strengths.sort((a, b) => a.rank - b.rank);

  return {
    method: `bradley-terry-mm(prior=${opt.prior})`,
    strengths,
    iterations: used,
    converged,
    componentCount: parts.length,
    connected: parts.length === 1,
    logLikelihood,
    warnings,
  };
}
