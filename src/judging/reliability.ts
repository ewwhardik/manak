/**
 * How much the ranking can carry.
 *
 * The fit in `normalize.ts` answers "what is the order". This module answers the
 * question an organizer is actually about to be asked, which is "how sure are
 * you", and it answers it in the two forms that survive an appeal: an interval
 * around each project's score, and a division of the field into tiers that the
 * evidence can tell apart. A ranking of forty projects where the panel can only
 * resolve four distinct levels is not a ranking of forty projects, and printing
 * it as one is the most common way a judging system misleads the people using it.
 *
 * Three numbers do most of the work.
 *
 * *Variance shares* say where the spread in the ballots came from. If the judge
 * share is larger than the project share, the panel disagreed about the judges
 * more than it disagreed about the projects, and normalizing was not a nicety.
 *
 * *Separation* is the ratio of true spread between projects to the uncertainty in
 * a single project's score. It converts directly into the number of tiers the
 * evidence supports, by the Wright and Masters strata formula `(4G + 1) / 3`.
 *
 * *Reliability* is that same quantity expressed as `G^2 / (1 + G^2)`, which is the
 * proportion of the observed spread that is real rather than noise. It is the
 * number to quote when someone asks whether running the event again with a
 * different panel would produce the same ranking.
 *
 * Everything here is derived from what the fit already published — project
 * effects, judge offsets and scales, the residual spread and its degrees of
 * freedom — plus the ballots. It fits nothing of its own, which is why it cannot
 * disagree with the ranking it describes.
 */

import type { Ballot, Diagnostic, JudgeId, ProjectId, Rubric } from "./types.ts";
import { JudgingError } from "./types.ts";
import { DiagnosticCollector } from "./diagnostic.ts";
import { weightedTotal } from "./weighted.ts";
import { mean, sd, tCritical95, variance } from "./stats.ts";
import { agree, plural } from "./words.ts";
import type { NormalizationResult } from "./normalize.ts";

export type ReliabilityOptions = {
  /** Standardised residual beyond which one ballot is worth a second look. */
  outlierZ?: number;
  /** At most this many outliers are listed, worst first. */
  maxOutliers?: number;
  /** A judge whose residual spread exceeds this multiple of the panel's is flagged. */
  judgeSpreadRatio?: number;
  /** Below this many ballots a judge's own residual spread is not judged. */
  minBallotsForSpread?: number;
  /** Reliability below this earns a warning rather than a note. */
  lowReliability?: number;
};

/**
 * Exported for the same reason `NORMALIZE_DEFAULTS` is: the API layer documents
 * these and the pages print them, and a duplicated default is a default that
 * silently stops matching.
 */
export const RELIABILITY_DEFAULTS = {
  outlierZ: 2.5,
  maxOutliers: 12,
  judgeSpreadRatio: 1.6,
  minBallotsForSpread: 4,
  lowReliability: 0.7,
} as const;

const DEFAULTS = RELIABILITY_DEFAULTS;

/**
 * Shares of the spread in the ballots, summing to one.
 *
 * The three parts are near-orthogonal by construction rather than exactly so, in
 * the way that any fit on an incomplete design is, so these are shares of the sum
 * of the parts and not an exact partition of the total. The distinction matters
 * for a statistician and not for the decision the number informs, and stating it
 * is cheaper than being caught not stating it.
 */
export type VarianceShare = {
  project: number;
  judge: number;
  residual: number;
};

export type ProjectInterval = {
  project: ProjectId;
  adjusted: number;
  standardError: number;
  low: number;
  high: number;
  halfWidth: number;
  /**
   * 1-based. A tier is formed around its leading project: every member is inside the interval of
   * the difference against that one project, which is not the same as every member being inside
   * every other's. Two projects can share a tier and still be separated from each other, and the
   * `pairs`/`decisive` figures are where a boundary is established.
   */
  tier: number;
  /** How many other projects share its tier. */
  sharesTier: number;
};

export type BallotOutlier = {
  judge: JudgeId;
  project: ProjectId;
  /** The weighted total the judge actually filed. */
  observed: number;
  /** What the fit expects from this judge on this project. */
  expected: number;
  residual: number;
  /** The residual in units of the panel's residual spread. */
  z: number;
};

export type JudgeConsistency = {
  judge: JudgeId;
  ballots: number;
  /** Spread of this judge's residuals around the fit, on the rubric scale. */
  residualSd: number;
  /** `residualSd` over the panel's. Above one is noisier than the panel. */
  relative: number;
  /** Mean signed residual. Near zero by construction once leniency is removed. */
  bias: number;
  flagged: boolean;
  /**
   * Their single furthest ballot from the fit, signed, in units of the panel's residual
   * spread — the same units as `BallotOutlier.z`.
   *
   * A spread and an extreme are different facts about the same residuals, and only the
   * second of them is a statement about one project. A judge who marks everything a little
   * unevenly has a high `relative` and no extreme; a judge who agrees with the panel about
   * every project but one has an ordinary `relative` and an extreme, and it is the second
   * shape that a judge scoring their own team produces.
   *
   * Carried here as well as in `outliers` because that list is capped at `maxOutliers` and
   * sorted by magnitude, so on a panel with several extremes the smaller ones fall off the
   * end. A per-judge figure cannot be crowded out, which matters for anything that reads
   * this to decide whether to say something about a judge.
   */
  worstZ: number;
  /** The project that residual is on, or `null` when the judge filed nothing. */
  worstProject: ProjectId | null;
};

export type ReliabilityResult = {
  method: string;
  varianceShare: VarianceShare;
  /** The three spreads the shares came from, on the rubric's own scale. */
  projectSd: number;
  judgeSd: number;
  residualSd: number;
  /** Spread attributable to real differences between projects. */
  trueSd: number;
  /** Root mean square standard error: the uncertainty in one project's score. */
  errorSd: number;
  /** trueSd / errorSd. How far apart the field is in units of its own noise. */
  separation: number;
  /** Distinguishable strata implied by `separation`, by (4G + 1) / 3. */
  strata: number;
  /** G^2 / (1 + G^2): the share of the observed spread that is real. */
  reliability: number;
  ballotsPerProject: number;
  /** The interval's coverage and the multiplier used to reach it. */
  confidence: number;
  tMultiplier: number;
  df: number;
  intervals: ProjectInterval[];
  /** How many tiers the field divides into. Fewer than places, always. */
  tiers: number;
  /** Whether first place is separated from second. */
  decisive: boolean;
  outliers: BallotOutlier[];
  judges: JudgeConsistency[];
  warnings: string[];
  notes: Diagnostic[];
};

type Row = { judge: JudgeId; project: ProjectId; y: number };

/** Uncertainty, tiers and per-ballot outliers for a fit that already happened. */
export function panelReliability(
  rubric: Rubric,
  ballots: readonly Ballot[],
  fit: NormalizationResult,
  options: ReliabilityOptions = {},
): ReliabilityResult {
  const opt = { ...DEFAULTS, ...options };
  if (ballots.length === 0) {
    throw new JudgingError("reliability.empty", "There are no ballots to describe.");
  }
  if (fit.projects.length === 0) {
    throw new JudgingError("reliability.unfitted", "The fit contains no projects.");
  }

  const theta = new Map<ProjectId, number>(fit.projects.map((p) => [p.project, p.theta]));
  const judgeById = new Map<JudgeId, { leniency: number; leniencyPending: number; scale: number }>(
    fit.judges.map((j) => [
      j.judge,
      { leniency: j.leniency, leniencyPending: j.leniencyPending, scale: j.scale },
    ]),
  );

  const rows: Row[] = [];
  for (const b of ballots) {
    if (b.rubricVersion !== rubric.version) {
      throw new JudgingError(
        "ballot.rubricVersion",
        `Ballot ${b.id} targets rubric version ${b.rubricVersion}, not ${rubric.version}.`,
      );
    }
    if (!theta.has(b.project) || !judgeById.has(b.judge)) {
      throw new JudgingError(
        "reliability.mismatch",
        `Ballot ${b.id} is for a judge or project the fit does not contain. ` +
          `Describe the same ballots that were normalized.`,
      );
    }
    rows.push({ judge: b.judge, project: b.project, y: weightedTotal(rubric, b.scores) });
  }

  // The model on the rubric's own scale, which is where a residual is readable:
  // y = leniency_j + leniencyPending_j + grandMean + scale_j * theta_i. Multiplying
  // theta by the judge's scale is what makes the raw residual the homoscedastic
  // one, so a standardised residual is a division rather than a weighted division.
  //
  // `leniencyPending` belongs in the expectation, not in the residual. It is the
  // offset the fit wanted and the published parameters do not carry; leaving it out
  // would charge every one of that judge's ballots for a panel-level bookkeeping
  // difference and quietly inflate their outlier count.
  const expectedFor = (r: Row): number => {
    const j = judgeById.get(r.judge) as {
      leniency: number;
      leniencyPending: number;
      scale: number;
    };
    return (
      j.leniency + j.leniencyPending + fit.grandMean + j.scale * (theta.get(r.project) as number)
    );
  };

  const residuals = rows.map((r) => r.y - expectedFor(r));
  const panelResidualSd = fit.residualSd > 0 ? fit.residualSd : sd(residuals);

  const projectComponent = rows.map((r) => {
    const j = judgeById.get(r.judge) as { scale: number };
    return j.scale * (theta.get(r.project) as number);
  });
  const judgeComponent = rows.map((r) => {
    const j = judgeById.get(r.judge) as { leniency: number; leniencyPending: number };
    return j.leniency + j.leniencyPending;
  });
  const varProject = variance(projectComponent);
  const varJudge = variance(judgeComponent);
  const varResidual = variance(residuals);
  const varSum = varProject + varJudge + varResidual;
  const share = (v: number): number => (varSum > 0 ? v / varSum : 0);
  const varianceShare: VarianceShare = {
    project: share(varProject),
    judge: share(varJudge),
    residual: share(varResidual),
  };

  const adjusted = fit.projects.map((p) => p.adjusted);
  const errors = fit.projects.map((p) => (Number.isFinite(p.standardError) ? p.standardError : 0));
  const observedVar = variance(adjusted);
  const meanSquareError = mean(errors.map((e) => e * e));
  const trueVar = Math.max(0, observedVar - meanSquareError);
  const trueSd = Math.sqrt(trueVar);
  const errorSd = Math.sqrt(meanSquareError);
  const separation = errorSd > 0 ? trueSd / errorSd : 0;
  const strata = (4 * separation + 1) / 3;
  const reliability = observedVar > 0 ? trueVar / observedVar : 0;
  const ballotsPerProject = mean(fit.projects.map((p) => p.ballots));

  const tMultiplier = tCritical95(fit.df);
  const ranked = fit.projects.slice().sort((a, b) => b.adjusted - a.adjusted);

  // Tiers. A project joins the current tier while it is inside the interval of
  // that tier's leader, tested on the standard error of the *difference* rather
  // than on whether two intervals happen to overlap — overlapping intervals is
  // the test people reach for and it is the wrong one, too conservative by about
  // a factor of the square root of two.
  const tierOf = new Map<ProjectId, number>();
  let tier = 0;
  let leader = ranked[0];
  for (const p of ranked) {
    if (leader === undefined || p === leader) {
      tier += 1;
      leader = p;
      tierOf.set(p.project, tier);
      continue;
    }
    const seLeader = Number.isFinite(leader.standardError) ? leader.standardError : 0;
    const seHere = Number.isFinite(p.standardError) ? p.standardError : 0;
    const seDiff = Math.sqrt(seLeader * seLeader + seHere * seHere);
    if (Math.abs(leader.adjusted - p.adjusted) <= tMultiplier * seDiff) {
      tierOf.set(p.project, tier);
    } else {
      tier += 1;
      leader = p;
      tierOf.set(p.project, tier);
    }
  }
  const perTier = new Map<number, number>();
  for (const t of tierOf.values()) perTier.set(t, (perTier.get(t) ?? 0) + 1);

  const intervals: ProjectInterval[] = ranked.map((p) => {
    const se = Number.isFinite(p.standardError) ? p.standardError : Number.NaN;
    const half = Number.isFinite(se) ? tMultiplier * se : Number.NaN;
    const t = tierOf.get(p.project) as number;
    return {
      project: p.project,
      adjusted: p.adjusted,
      standardError: se,
      low: p.adjusted - half,
      high: p.adjusted + half,
      halfWidth: half,
      tier: t,
      sharesTier: (perTier.get(t) as number) - 1,
    };
  });

  const first = intervals[0];
  const second = intervals[1];
  const decisive = second === undefined || (first !== undefined && first.tier !== second.tier);

  const outliers: BallotOutlier[] = rows
    .map((r, i) => {
      const residual = residuals[i] as number;
      return {
        judge: r.judge,
        project: r.project,
        observed: r.y,
        expected: expectedFor(r),
        residual,
        z: panelResidualSd > 0 ? residual / panelResidualSd : 0,
      };
    })
    .filter((o) => Math.abs(o.z) >= opt.outlierZ)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || a.judge.localeCompare(b.judge))
    .slice(0, opt.maxOutliers);

  const byJudge = new Map<JudgeId, { project: ProjectId; residual: number }[]>();
  rows.forEach((r, i) => {
    const cell = { project: r.project, residual: residuals[i] as number };
    const bucket = byJudge.get(r.judge);
    if (bucket) bucket.push(cell);
    else byJudge.set(r.judge, [cell]);
  });
  const judges: JudgeConsistency[] = [...byJudge.keys()].sort().map((id) => {
    const own = byJudge.get(id) as { project: ProjectId; residual: number }[];
    const spread = sd(own.map((c) => c.residual));
    const relative = panelResidualSd > 0 ? spread / panelResidualSd : 0;
    // Ties broken by project id rather than left to the sort, so the project named beside a
    // judge is the same one on every machine. Two residuals equal to the last bit is not a
    // case worth engineering for on its own; a report whose figures are reproducible and
    // whose labels are not is.
    const furthest = own.reduce(
      (best, cell) =>
        Math.abs(cell.residual) > Math.abs(best.residual) ||
        (Math.abs(cell.residual) === Math.abs(best.residual) && cell.project < best.project)
          ? cell
          : best,
      own[0] as { project: ProjectId; residual: number },
    );
    return {
      judge: id,
      ballots: own.length,
      residualSd: spread,
      relative,
      bias: mean(own.map((c) => c.residual)),
      flagged: own.length >= opt.minBallotsForSpread && relative > opt.judgeSpreadRatio,
      worstZ: panelResidualSd > 0 ? furthest.residual / panelResidualSd : 0,
      worstProject: furthest.project,
    };
  });

  const diag = new DiagnosticCollector();

  const tiers = tier;
  if (tiers < fit.projects.length) {
    diag.report(
      "panel.tiers",
      "info",
      `The evidence separates ${plural(fit.projects.length, "project")} into ` +
        `${plural(tiers, "tier")}, not ${fit.projects.length} places. Each tier holds the ` +
        `projects that are not separated from the one at the top of it, so awarding on the tier ` +
        `leader is defensible where awarding on the printed place is not.`,
    );
  }
  if (!decisive && first !== undefined && second !== undefined) {
    diag.report(
      "panel.topNotDecisive",
      "warn",
      `First and second place are not separated: ${first.project} at ` +
        `${first.adjusted.toFixed(2)} and ${second.project} at ${second.adjusted.toFixed(2)}, ` +
        `against a 95% interval of plus or minus ${first.halfWidth.toFixed(2)}. Another ` +
        `review of both is worth more than a tie-break rule.`,
      [first.project, second.project],
    );
  }
  if (reliability < opt.lowReliability) {
    diag.report(
      "panel.lowReliability",
      "warn",
      `Panel reliability is ${reliability.toFixed(2)} and separation ` +
        `${separation.toFixed(2)}, so this ranking supports about ` +
        `${plural(Math.max(1, Math.round(strata)), "distinguishable level")}. More reviews per ` +
        `project is the only fix; no amount of arithmetic manufactures evidence.`,
    );
  }
  if (varianceShare.judge > varianceShare.project) {
    diag.report(
      "panel.judgeDominated",
      "warn",
      `Judge leniency accounts for ${(varianceShare.judge * 100).toFixed(0)}% of the ` +
        `spread in the ballots against ${(varianceShare.project * 100).toFixed(0)}% for ` +
        `real differences between projects. A plain average of these ballots would have ` +
        `ranked the judges.`,
    );
  }
  const noisy = judges.filter((j) => j.flagged);
  for (const j of noisy) {
    diag.report(
      "judge.noisy",
      "info",
      `Judge ${j.judge}'s scores sit ${j.relative.toFixed(2)} times as far from the fit ` +
        `as the panel's do. That is inconsistency rather than harshness — leniency is ` +
        `already removed from this number.`,
      [j.judge],
    );
  }
  if (outliers.length > 0) {
    diag.report(
      "ballot.outliers",
      "info",
      `${plural(outliers.length, "ballot")} ${agree(outliers.length, "sits", "sit")} more than ` +
        `${opt.outlierZ} residual spreads from ` +
        `what the fit expects. The worst is judge ${(outliers[0] as BallotOutlier).judge} ` +
        `on ${(outliers[0] as BallotOutlier).project}. A ballot being unusual is not a ` +
        `ballot being wrong.`,
      outliers.map((o) => o.project),
    );
  }

  return {
    method: `variance-shares+wright-masters-separation(confidence=0.95, df=${fit.df})`,
    varianceShare,
    projectSd: Math.sqrt(varProject),
    judgeSd: Math.sqrt(varJudge),
    residualSd: panelResidualSd,
    trueSd,
    errorSd,
    separation,
    strata,
    reliability,
    ballotsPerProject,
    confidence: 0.95,
    tMultiplier,
    df: fit.df,
    intervals,
    tiers,
    decisive,
    outliers,
    judges,
    warnings: diag.warnings,
    notes: diag.notes,
  };
}
