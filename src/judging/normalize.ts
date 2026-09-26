/**
 * Cross-judge score normalization.
 *
 * The problem is that judging is an incomplete block design: each judge sees a
 * subset of projects, so a raw mean is contaminated by two separate judge
 * artefacts. *Leniency* is a judge who marks a point high across the board.
 * *Scale* is a judge who uses the whole range while another lives between 3 and
 * 4. Averaging treats a 4 from a harsh judge and a 4 from a generous one as the
 * same evidence, and they are not.
 *
 * The model is additive with a per-judge scale:
 *
 *     y_ij = mu + theta_i + b_j + eps,   eps ~ N(0, sigma^2 / s_j^2)
 *
 * fitted by weighted backfitting. `mu` is pinned to the grand mean and the judge
 * effects are constrained to average zero; those two constraints are what make
 * the parameters identifiable. Scale is estimated as the slope of a judge's
 * leniency-removed scores against current project quality, then shrunk toward 1
 * in proportion to how many ballots that judge actually filed.
 *
 * Shrinkage is the load-bearing part. A judge with four ballots should not be
 * modelled as confidently as one with thirty, and — the case the brief asks
 * about by name — a judge who marks everything a 3 has a scale estimate near
 * zero, which would explode when divided out. Four things stop that: shrinkage
 * bounds the estimate, a hard floor clamps it, the ballot's information weight
 * (s_j^2) collapses so it barely influences the *ordering* while its leniency
 * term still absorbs the offset, and the judge is flagged in the diagnostics so
 * an organizer can add a review. The last one matters most: the correct fix for
 * a judge who is not discriminating is a human one, not a statistical one.
 *
 * The loop is two deep. The inner one backfits project and judge effects at a
 * fixed set of scales; the outer one re-estimates the scales and goes round again,
 * stopping early once no leniency or scale estimate moves. Then one final inner
 * fit runs at the settled parameters, so that every number in the published table
 * was produced by the same parameter set — see `leniencyResidual` for how far
 * short of that ideal a given run fell.
 */

import type { Ballot, Diagnostic, JudgeId, ProjectId, Rubric } from "./types.ts";
import { JudgingError } from "./types.ts";
import { DiagnosticCollector } from "./diagnostic.ts";
import { weightedTotal } from "./weighted.ts";
import { clamp, components, mean, rankDescending, variance } from "./stats.ts";
import { agree, names, plural } from "./words.ts";

export type NormalizeOptions = {
  /** Shrinkage strength for the scale estimate. Higher trusts the pool more. */
  kappa?: number;
  /** Hard bounds on a judge's fitted scale, as a multiple of the pool's. */
  scaleFloor?: number;
  scaleCeiling?: number;
  /** Outer iterations of (fit additive -> re-estimate scale). */
  rounds?: number;
  /** Inner backfitting iterations per round. */
  backfitIterations?: number;
  /** Convergence tolerance on the largest parameter movement. */
  tolerance?: number;
  /**
   * Movement of the largest leniency or scale estimate below which the outer loop
   * stops early. Separate from `tolerance`, which governs the inner backfit.
   *
   * This is on the rubric's own scale. The default of 0.01 matches the last
   * displayed score digit; a smaller movement is still reported numerically.
   */
  outerTolerance?: number;
  /** Below this many ballots a judge's scale is not estimated at all. */
  minBallotsForScale?: number;
  /** A fitted slope below this flags the judge as low-discrimination. */
  lowDiscriminationSlope?: number;
};

export type Discrimination = "ok" | "low" | "insufficient";

export type JudgeEffect = {
  judge: JudgeId;
  ballots: number;
  /** b_j, on the rubric scale, centred so the panel averages zero. */
  leniency: number;
  /**
   * The extra leniency the final fit still wanted to charge this judge, on the
   * rubric scale, and did not get. Zero at convergence.
   *
   * Published because without it the parameter set does not close: `theta` is
   * reconstructible from the ballots, `grandMean`, `scale` and `leniency` only once
   * this is subtracted too. It is deliberately not centred — a constant shift in
   * leniency is unidentifiable against a pinned grand mean, so centring it would
   * hide part of the number the reconstruction needs.
   */
  leniencyPending: number;
  /** The unshrunk fitted slope, kept for transparency. */
  scaleRaw: number;
  /**
   * Whether `scaleRaw` was estimated at all. When false it is the held value of
   * 1, not a measurement, and reading it as one would be reading a default as a
   * finding.
   */
  slopeFitted: boolean;
  /** The slope actually applied, after shrinkage and clamping. */
  scale: number;
  /** n / (n + kappa) — how far the raw estimate was trusted. */
  shrinkage: number;
  /** s_j^2: how much this judge's ballots move the ranking. */
  informationWeight: number;
  clamped: boolean;
  discrimination: Discrimination;
};

export type ProjectScore = {
  project: ProjectId;
  ballots: number;
  rawMean: number;
  /** mu + theta_i, back on the rubric's own scale. */
  adjusted: number;
  theta: number;
  standardError: number;
  rankRaw: number;
  rankAdjusted: number;
  /** Positive means the project moved up once judge effects were removed. */
  rankMove: number;
};

export type NormalizationResult = {
  method: string;
  grandMean: number;
  residualSd: number;
  projects: ProjectScore[];
  judges: JudgeEffect[];
  /** Outer rounds actually run, which is fewer than requested if it settled. */
  rounds: number;
  /** Inner backfitting sweeps summed across every round, including the final fit. */
  sweeps: number;
  /** Whether the final backfit reached its tolerance rather than its iteration cap. */
  converged: boolean;
  /** Whether the outer leniency/scale loop stopped moving rather than running out. */
  settled: boolean;
  /** Largest leniency or scale movement in the last outer round. */
  outerMovement: number;
  /**
   * How much leniency the final fit still wanted to move, on the rubric scale:
   * the largest `leniencyPending` on the panel. Zero at convergence; a number here
   * means the fit and the offsets printed beside it disagree by this much, and the
   * per-judge column says which judge.
   */
  leniencyResidual: number;
  /** Ballots that entered the fit, and the residual degrees of freedom. */
  observations: number;
  df: number;
  warnings: string[];
  /** The same findings as `warnings`, coded so callers can branch on them. */
  notes: Diagnostic[];
};

type Obs = { project: ProjectId; judge: JudgeId; y: number };

/**
 * The settings the engine uses when the caller says nothing. Exported because two
 * other places need to state them without restating them: the proof harness
 * compares ablations against the default and would otherwise carry its own copy of
 * these numbers, and the API layer documents them. A duplicated default is a
 * default that silently stops matching.
 *
 * `kappa` was 8 until the proof harness was pointed at it. Shrinking a judge's
 * slope toward 1 by `n / (n + kappa)` costs ranking accuracy in every regime
 * measured and only improves the printed scale estimate once a judge is down to
 * about five ballots, so a strength that discounted a twenty-ballot judge by 30%
 * was paying for insurance nobody had claimed on. At 2 a twenty-ballot judge is
 * trusted 0.91 and a two-ballot judge 0.5, which is the intended reading of the
 * knob; see `docs/proof/normalization.md`, sweep 4.
 */
export const NORMALIZE_DEFAULTS = {
  kappa: 2,
  scaleFloor: 0.35,
  scaleCeiling: 2.5,
  rounds: 12,
  backfitIterations: 1000,
  tolerance: 1e-9,
  outerTolerance: 0.01,
  minBallotsForScale: 3,
  lowDiscriminationSlope: 0.25,
} as const;

const DEFAULTS = NORMALIZE_DEFAULTS;

/**
 * Weighted two-way backfitting with `mu` pinned and mean(b) = 0.
 * Returns project effects, judge residual effects, and whether it converged.
 */
function fitAdditive(
  obs: readonly Obs[],
  judgeWeight: Map<JudgeId, number>,
  mu: number,
  iterations: number,
  tolerance: number,
): { theta: Map<ProjectId, number>; b: Map<JudgeId, number>; converged: boolean; used: number; fallback: boolean } {
  const byProject = new Map<ProjectId, Obs[]>();
  const byJudge = new Map<JudgeId, Obs[]>();
  for (const o of obs) {
    let p = byProject.get(o.project);
    if (!p) { p = []; byProject.set(o.project, p); }
    p.push(o);
    let j = byJudge.get(o.judge);
    if (!j) { j = []; byJudge.set(o.judge, j); }
    j.push(o);
  }
  const theta = new Map<ProjectId, number>();
  const b = new Map<JudgeId, number>();
  // The starting point is a finite raw project mean, also the fallback if a
  // later sweep becomes non-finite on an ill-conditioned panel.
  for (const [p, rows] of byProject) theta.set(p, mean(rows.map((o) => o.y)) - mu);
  for (const j of byJudge.keys()) b.set(j, 0);

  let converged = false;
  let used = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const priorTheta = new Map(theta);
    const priorB = new Map(b);
    used = iter + 1;
    let movement = 0;
    for (const [project, rows] of byProject) {
      let num = 0;
      let den = 0;
      for (const o of rows) {
        const w = judgeWeight.get(o.judge) ?? 1;
        num += w * (o.y - (b.get(o.judge) as number) - mu);
        den += w;
      }
      const next = den > 0 ? num / den : 0;
      movement = Math.max(movement, Math.abs(next - (theta.get(project) as number)));
      theta.set(project, next);
    }
    for (const [judge, rows] of byJudge) {
      let s = 0;
      for (const o of rows) s += o.y - mu - (theta.get(o.project) as number);
      const next = s / rows.length;
      movement = Math.max(movement, Math.abs(next - (b.get(judge) as number)));
      b.set(judge, next);
    }
    const offset = mean([...b.values()]);
    for (const [judge, value] of b) b.set(judge, value - offset);
    if (![...theta.values(), ...b.values()].every(Number.isFinite)) {
      return { theta: priorTheta, b: priorB, converged: false, used, fallback: true };
    }
    if (movement < tolerance) { converged = true; break; }
  }
  return { theta, b, converged, used, fallback: false };
}

function groupBy<K, T>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    let bucket = out.get(k);
    if (!bucket) { bucket = []; out.set(k, bucket); }
    bucket.push(item);
  }
  return out;
}

/** Turn ballots into a normalized ranking plus the diagnostics to defend it. */
export function normalizeScores(
  rubric: Rubric,
  ballots: readonly Ballot[],
  options: NormalizeOptions = {},
): NormalizationResult {
  const opt = { ...DEFAULTS, ...options };
  const bounded = (name: string, value: number, min: number, max: number, integer = false) => {
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new JudgingError("normalize.options", `${name} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}.`);
    }
  };
  bounded("rounds", opt.rounds, 1, 32, true);
  bounded("backfitIterations", opt.backfitIterations, 1, 2000, true);
  if (opt.rounds * opt.backfitIterations > 32000) {
    throw new JudgingError("normalize.options", "The normalization iteration budget may not exceed 32,000 sweeps.");
  }
  bounded("tolerance", opt.tolerance, 1e-12, 0.1);
  bounded("outerTolerance", opt.outerTolerance, 1e-8, 0.1);
  bounded("kappa", opt.kappa, 0, 1000);
  bounded("scaleFloor", opt.scaleFloor, 0.01, 10);
  bounded("scaleCeiling", opt.scaleCeiling, opt.scaleFloor, 10);
  bounded("minBallotsForScale", opt.minBallotsForScale, 0, 1000, true);
  bounded("lowDiscriminationSlope", opt.lowDiscriminationSlope, 0, 10);
  if (ballots.length === 0) {
    throw new JudgingError("normalize.empty", "There are no ballots to normalize.");
  }

  const obs: Obs[] = [];
  const seenPairs = new Set<string>();
  for (const ballot of ballots) {
    if (ballot.rubricVersion !== rubric.version) {
      throw new JudgingError(
        "ballot.rubricVersion",
        `Ballot ${ballot.id} targets rubric version ${ballot.rubricVersion}, not ${rubric.version}.`,
      );
    }
    const pair = `${ballot.judge}\u0000${ballot.project}`;
    if (seenPairs.has(pair)) {
      throw new JudgingError(
        "normalize.duplicate",
        `Judge ${ballot.judge} has more than one ballot for project ${ballot.project}.`,
      );
    }
    seenPairs.add(pair);
    const y = weightedTotal(rubric, ballot.scores);
    if (!Number.isFinite(y) || Math.abs(y) > 1e6) {
      throw new JudgingError("normalize.nonFinite", "A weighted score is outside the supported finite range.");
    }
    obs.push({
      project: ballot.project,
      judge: ballot.judge,
      y,
    });
  }

  const judgeIds = [...new Set(obs.map((o) => o.judge))].sort();
  const projectIds = [...new Set(obs.map((o) => o.project))].sort();
  const obsByJudge = groupBy(obs, (o) => o.judge);
  const obsByProject = groupBy(obs, (o) => o.project);
  const grandMean = mean(obs.map((o) => o.y));

  const leniency = new Map<JudgeId, number>(judgeIds.map((j) => [j, 0]));
  const scale = new Map<JudgeId, number>(judgeIds.map((j) => [j, 1]));
  const scaleRaw = new Map<JudgeId, number>(judgeIds.map((j) => [j, 1]));
  const slopeFitted = new Map<JudgeId, boolean>(judgeIds.map((j) => [j, false]));
  const wasClamped = new Map<JudgeId, boolean>(judgeIds.map((j) => [j, false]));
  const discrimination = new Map<JudgeId, Discrimination>(judgeIds.map((j) => [j, "ok"]));

  let theta = new Map<ProjectId, number>(projectIds.map((p) => [p, 0]));
  let judgeResidual = new Map<JudgeId, number>(judgeIds.map((j) => [j, 0]));
  let corrected: Obs[] = obs.slice();
  let weights = new Map<JudgeId, number>(judgeIds.map((j) => [j, 1]));

  // Apply the current leniency and scale estimates to the *original* scores, so
  // successive rounds refine one correction rather than compounding three.
  const correct = (): Obs[] =>
    obs.map((o) => ({
      project: o.project,
      judge: o.judge,
      y: grandMean + (o.y - (leniency.get(o.judge) as number) - grandMean) / (scale.get(o.judge) as number),
    }));
  const weigh = (): Map<JudgeId, number> =>
    new Map(judgeIds.map((j) => [j, (scale.get(j) as number) ** 2]));

  /**
   * Fold whatever leniency the fit still wanted onto the original scale and
   * re-centre. Returns the largest fold, which is the outer loop's error signal.
   */
  const foldLeniency = (): number => {
    let moved = 0;
    for (const j of judgeIds) {
      const residual = judgeResidual.get(j) ?? 0;
      const delta = (scale.get(j) as number) * residual;
      moved = Math.max(moved, Math.abs(delta));
      leniency.set(j, (leniency.get(j) as number) + delta);
    }
    const offset = mean(judgeIds.map((j) => leniency.get(j) as number));
    for (const j of judgeIds) leniency.set(j, (leniency.get(j) as number) - offset);
    return moved;
  };

  /**
   * Re-estimate every judge's scale as the slope of their leniency-removed scores
   * against current project quality, then shrink it toward the pool. Returns the
   * largest movement so the outer loop can tell whether it is still learning.
   */
  const estimateScales = (): number => {
    let moved = 0;
    for (const j of judgeIds) {
      const rows = obsByJudge.get(j) as Obs[];
      const thetas = rows.map((o) => theta.get(o.project) as number);
      const resid = rows.map((o) => o.y - (leniency.get(j) as number) - grandMean);
      const spread = variance(thetas);
      let slope = 1;
      let fitted = false;
      let verdict: Discrimination = "ok";
      if (rows.length < opt.minBallotsForScale || spread < 1e-6) {
        verdict = "insufficient";
      } else {
        const mt = mean(thetas);
        const mr = mean(resid);
        let cov = 0;
        for (let k = 0; k < rows.length; k++) {
          cov += ((thetas[k] as number) - mt) * ((resid[k] as number) - mr);
        }
        slope = cov / rows.length / spread;
        fitted = true;
        if (slope < opt.lowDiscriminationSlope) verdict = "low";
      }
      const shrinkage = rows.length / (rows.length + opt.kappa);
      const shrunk = 1 + (slope - 1) * shrinkage;
      const bounded = clamp(shrunk, opt.scaleFloor, opt.scaleCeiling);
      moved = Math.max(moved, Math.abs(bounded - (scale.get(j) as number)));
      scaleRaw.set(j, slope);
      slopeFitted.set(j, fitted);
      scale.set(j, bounded);
      wasClamped.set(j, Math.abs(bounded - shrunk) > 1e-12);
      discrimination.set(j, verdict);
    }
    return moved;
  };

  let converged = false;
  let settled = false;
  let roundsUsed = 0;
  let sweeps = 0;
  let outerMovement = Number.POSITIVE_INFINITY;
  let fallback = false;

  for (let round = 0; round < opt.rounds; round++) {
    roundsUsed = round + 1;
    corrected = correct();
    weights = weigh();
    const fit = fitAdditive(corrected, weights, grandMean, opt.backfitIterations, opt.tolerance);
    fallback ||= fit.fallback;
    sweeps += fit.used;
    theta = fit.theta;
    judgeResidual = fit.b;
    converged = fit.converged;
    outerMovement = Math.max(foldLeniency(), estimateScales());
    if (outerMovement < opt.outerTolerance) {
      settled = true;
      break;
    }
  }

  // One final fit, so that the numbers published together were produced together.
  // Before this existed, the last round estimated a scale that nothing then used:
  // `theta` and `adjusted` came from a fit weighted by the *previous* round's
  // scale, while the `scale` and `informationWeight` printed beside them were the
  // newer estimate, and the standard errors were weighted by the older one. Three
  // parameter sets presented as one table. Now the published scale is the scale
  // that produced the published ranking, and `leniencyResidual` says how much the
  // fit still disagreed with the offsets printed next to it.
  corrected = correct();
  weights = weigh();
  const finalFit = fitAdditive(corrected, weights, grandMean, opt.backfitIterations, opt.tolerance);
  fallback ||= finalFit.fallback;
  sweeps += finalFit.used;
  theta = finalFit.theta;
  judgeResidual = finalFit.b;
  converged = finalFit.converged;

  // The final fit is *not* folded back into `leniency`, and that is the whole
  // point. If it were, the published offsets would be one step ahead of the fit
  // that produced the published ranking, and reconstructing `theta` from the
  // published parameters would need a re-centring constant that appears nowhere in
  // the output. Instead the leftover is published per judge as `leniencyPending`,
  // so the identity closes on printed numbers alone:
  //
  //   theta_i = sum_j s_j (y_ij - mu - leniency_j - pending_j) / sum_j s_j^2
  //
  // which `tests/normalize.test.ts` asserts to 1e-9. `leniencyResidual` below is
  // the largest pending value, and it is the same quantity the outer loop watches.
  const pending = new Map<JudgeId, number>(
    judgeIds.map((j) => [j, (scale.get(j) as number) * (judgeResidual.get(j) ?? 0)]),
  );
  let leniencyResidual = 0;
  for (const j of judgeIds) {
    leniencyResidual = Math.max(leniencyResidual, Math.abs(pending.get(j) as number));
  }

  // Residual spread, used for the standard errors. Degrees of freedom are the
  // observation count less the fitted parameters (projects + judges - 1).
  let weightedSse = 0;
  for (const o of corrected) {
    const e =
      o.y - grandMean - (theta.get(o.project) as number) - (judgeResidual.get(o.judge) ?? 0);
    weightedSse += (weights.get(o.judge) as number) * e * e;
  }
  const df = Math.max(1, obs.length - (projectIds.length + judgeIds.length - 1));
  const residualSd = Math.sqrt(weightedSse / df);

  const rawMeans = new Map<ProjectId, number>();
  for (const p of projectIds) {
    rawMeans.set(p, mean((obsByProject.get(p) as Obs[]).map((o) => o.y)));
  }
  const adjusted = new Map<ProjectId, number>();
  for (const p of projectIds) adjusted.set(p, grandMean + (theta.get(p) as number));

  const rawRanks = rankDescending(projectIds.map((p) => ({ key: p, score: rawMeans.get(p) as number })));
  const adjRanks = rankDescending(projectIds.map((p) => ({ key: p, score: adjusted.get(p) as number })));

  const projectScores: ProjectScore[] = projectIds.map((p) => {
    const rows = obsByProject.get(p) as Obs[];
    let information = 0;
    for (const o of rows) information += weights.get(o.judge) as number;
    const rankRaw = rawRanks.get(p) as number;
    const rankAdjusted = adjRanks.get(p) as number;
    return {
      project: p,
      ballots: rows.length,
      rawMean: rawMeans.get(p) as number,
      adjusted: adjusted.get(p) as number,
      theta: theta.get(p) as number,
      standardError: information > 0 ? residualSd / Math.sqrt(information) : Number.NaN,
      rankRaw,
      rankAdjusted,
      rankMove: rankRaw - rankAdjusted,
    };
  });
  projectScores.sort((a, b) => a.rankAdjusted - b.rankAdjusted);

  const judgeEffects: JudgeEffect[] = judgeIds.map((j) => {
    const n = (obsByJudge.get(j) as Obs[]).length;
    const s = scale.get(j) as number;
    return {
      judge: j,
      ballots: n,
      leniency: leniency.get(j) as number,
      leniencyPending: pending.get(j) as number,
      scaleRaw: scaleRaw.get(j) as number,
      slopeFitted: slopeFitted.get(j) as boolean,
      scale: s,
      shrinkage: n / (n + opt.kappa),
      informationWeight: s ** 2,
      clamped: wasClamped.get(j) as boolean,
      discrimination: discrimination.get(j) as Discrimination,
    };
  });

  const diag = new DiagnosticCollector();

  if (fallback) diag.report("fit.finiteFallback", "warn",
    "A backfit sweep became non-finite. The last finite parameters, or raw project means on the first sweep, were retained. Treat close ranks as unresolved and obtain independent reviews.");

  if (!converged) {
    diag.report(
      "fit.notConverged",
      "warn",
      `The backfit ran its full ${opt.backfitIterations} iterations without reaching ` +
        `a movement below ${opt.tolerance}. The ranking is still the best estimate ` +
        `available, but treat close pairs as unresolved.`,
    );
  }
  // The threshold is the last digit this product prints. Scores render to two
  // decimals, so a residual disagreement below 0.01 cannot show up in anything an
  // organizer reads, and warning about it would train them to ignore warnings.
  // Above it, the judge offsets and the project scores in the same table really
  // were produced by parameters that differ by a visible amount, and that is worth
  // one sentence. The number itself is published either way, as `leniencyResidual`.
  if (leniencyResidual > 0.01) {
    diag.report(
      "fit.unsettled",
      "warn",
      `The final fit still wanted to move a judge's leniency by ` +
        `${leniencyResidual.toFixed(4)} on the rubric scale, which is more than the ` +
        `0.01 these scores are printed to, so the judge offsets and the project scores ` +
        `below were not produced by quite the same parameters. Raising rounds above ` +
        `${opt.rounds} would close the gap; the outer loop shrinks this by roughly a ` +
        `factor of three per round.`,
    );
  } else if (!settled) {
    diag.report(
      "fit.roundsExhausted",
      "info",
      `All ${roundsUsed} outer rounds were used; the last one still moved a leniency ` +
        `or scale estimate by ${outerMovement.toExponential(2)}, above the ` +
        `${opt.outerTolerance} early-stop threshold. This is the ordinary case and not ` +
        `a fault: the loop converges linearly, and measured over 20 seeds per regime, ` +
        `ranking accuracy is flat from one round to twenty. What the extra rounds buy ` +
        `is agreement between the published parameters, reported as leniencyResidual ` +
        `${leniencyResidual.toExponential(2)}.`,
    );
  }

  // If the judge-project graph splits, leniency is not comparable across the
  // pieces: two disjoint panels scoring two disjoint sets of projects share no
  // common reference point, and no amount of arithmetic invents one.
  const graphNodes = [...projectIds.map((p) => `P:${p}`), ...judgeIds.map((j) => `J:${j}`)];
  const graphEdges: [string, string][] = obs.map((o) => [`P:${o.project}`, `J:${o.judge}`]);
  const parts = components(graphNodes, graphEdges);
  if (parts.length > 1) {
    diag.report(
      "design.disconnected",
      "warn",
      `The judge-project design splits into ${parts.length} disconnected groups. ` +
        `Leniency cannot be compared across them; normalize each group separately ` +
        `or assign at least one judge who spans them.`,
    );
  }

  const thin = projectScores.filter((p) => p.ballots < 2).map((p) => p.project);
  if (thin.length > 0) {
    diag.report(
      "projects.thin",
      "warn",
      `${plural(thin.length, "project")} ${agree(thin.length, "has", "have")} a single ballot, so ` +
        `${agree(thin.length, "its standard error is", "their standard errors are")} wide and ` +
        `${agree(thin.length, "its rank", "their ranks")} should not be trusted alone: ` +
        `${names(thin)}.`,
      thin,
    );
  }

  for (const j of judgeEffects) {
    if (j.discrimination === "low") {
      diag.report(
        "judge.lowDiscrimination",
        "warn",
        `Judge ${j.judge} filed ${plural(j.ballots, "ballot")} with a fitted scale of ` +
          `${j.scaleRaw.toFixed(2)} — they are barely separating projects. Their ` +
          `information weight is ${j.informationWeight.toFixed(2)}, so they move the ` +
          `ranking very little, but consider adding a review rather than relying on this.`,
        [j.judge],
      );
    } else if (j.discrimination === "insufficient" && j.ballots < opt.minBallotsForScale) {
      diag.report(
        "judge.fewBallots",
        "warn",
        `Judge ${j.judge} filed only ${plural(j.ballots, "ballot")}; their scale was not ` +
          `estimated and is held at 1.0.`,
        [j.judge],
      );
    } else if (j.discrimination === "insufficient") {
      // The path that used to be silent. A judge with plenty of ballots whose
      // assigned projects all fitted to the same quality has nothing to estimate a
      // slope against, and was held at 1.0 with nothing said about it. That is a
      // fact about the assignment, not about the judge, and the difference matters
      // to the organizer deciding whether to intervene.
      diag.report(
        "judge.flatAssignment",
        "warn",
        `Judge ${j.judge} filed ${plural(j.ballots, "ballot")}, but the projects they were ` +
          `assigned all fitted to nearly the same quality, so there was no spread to ` +
          `estimate a scale against. Their scale is held at 1.0. This is a property of ` +
          `the assignment rather than of the judge.`,
        [j.judge],
      );
    }
    if (j.clamped) {
      diag.report(
        "judge.scaleClamped",
        "info",
        `Judge ${j.judge}'s fitted scale was clamped to ${j.scale.toFixed(2)} from ` +
          `${j.scaleRaw.toFixed(2)}, which bounds their influence rather than removing it.`,
        [j.judge],
      );
    }
  }

  const method =
    `additive-judge-effects+shrunk-scale` +
    `(kappa=${opt.kappa}, floor=${opt.scaleFloor}, ceiling=${opt.scaleCeiling}, rounds=${opt.rounds})`;

  return {
    method,
    grandMean,
    residualSd,
    projects: projectScores,
    judges: judgeEffects,
    rounds: roundsUsed,
    sweeps,
    converged,
    settled,
    outerMovement,
    leniencyResidual,
    observations: obs.length,
    df,
    warnings: diag.warnings,
    notes: diag.notes,
  };
}

/**
 * Baseline 1: the plain mean of weighted ballot totals. This is what "we
 * averaged the scores" means, and it is what the normalized ranking has to beat.
 */
export function rawMeanRanking(rubric: Rubric, ballots: readonly Ballot[]): Map<ProjectId, number> {
  const byProject = new Map<ProjectId, number[]>();
  for (const b of ballots) {
    const y = weightedTotal(rubric, b.scores);
    const bucket = byProject.get(b.project);
    if (bucket) bucket.push(y);
    else byProject.set(b.project, [y]);
  }
  const out = new Map<ProjectId, number>();
  for (const [project, ys] of byProject) out.set(project, mean(ys));
  return out;
}

/**
 * Baseline 2: per-judge z-scoring, then average. This is the method most people
 * reach for first, and it is worth shipping so the proof harness can show what it
 * costs. Standardising within a judge throws away the information that one judge's
 * assigned projects really were better than another's, which on an unbalanced
 * design can make it *worse* than the plain mean it was meant to improve on.
 */
export function zScoreRanking(rubric: Rubric, ballots: readonly Ballot[]): Map<ProjectId, number> {
  const byJudge = new Map<JudgeId, { project: ProjectId; y: number }[]>();
  for (const b of ballots) {
    const row = { project: b.project, y: weightedTotal(rubric, b.scores) };
    const bucket = byJudge.get(b.judge);
    if (bucket) bucket.push(row);
    else byJudge.set(b.judge, [row]);
  }
  const zByProject = new Map<ProjectId, number[]>();
  for (const rows of byJudge.values()) {
    const ys = rows.map((r) => r.y);
    const m = mean(ys);
    const spread = Math.sqrt(variance(ys));
    for (const r of rows) {
      const z = spread > 1e-9 ? (r.y - m) / spread : 0;
      const bucket = zByProject.get(r.project);
      if (bucket) bucket.push(z);
      else zByProject.set(r.project, [z]);
    }
  }
  const out = new Map<ProjectId, number>();
  for (const [project, zs] of zByProject) out.set(project, mean(zs));
  return out;
}
