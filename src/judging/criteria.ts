/**
 * What each line of the rubric is actually doing.
 *
 * A rubric is a hypothesis: that these five things, weighted like this, are what
 * separates a good entry from a mediocre one. Nothing in a judging system usually
 * checks the hypothesis, so a criterion that every judge scores 4 on — because it
 * is vague, or because it is true of every submission — keeps its weight forever
 * and contributes nothing but noise to the total. Two criteria that are really the
 * same question asked twice quietly count that question twice.
 *
 * This module reads the same ballots the fit read and reports four things per
 * criterion: how much of the scale the panel used, how much of its spread is
 * between projects rather than between judges scoring the same project, how much
 * the judges disagreed on it, and how closely it tracks the total. Then the
 * inter-criterion correlations, because redundancy is the failure a single-column
 * view cannot show.
 *
 * It is deliberately additive. It fits nothing, changes nothing, and is not
 * consulted by the ranking — so an organizer can read it, disagree with it, and
 * carry on. The right response to "nobody discriminates on originality" is to
 * rewrite the criterion before the next event, not to reweight this one midway
 * through and invalidate the ballots already filed.
 */

import type { Ballot, Criterion, Diagnostic, JudgeId, ProjectId, Rubric } from "./types.ts";
import { JudgingError } from "./types.ts";
import { DiagnosticCollector } from "./diagnostic.ts";
import { normalizedWeights, weightedTotal } from "./weighted.ts";
import { clamp, correlation, mean, sd, variance } from "./stats.ts";
import type { NormalizationResult } from "./normalize.ts";

export type CriteriaOptions = {
  /** Between-project variance share below which a criterion is called weak. */
  weakDiscrimination?: number;
  /** Absolute correlation at or above which two criteria are called redundant. */
  redundantAbove?: number;
  /** Scale usage below which the panel is said to be ignoring most of the scale. */
  narrowRange?: number;
  /**
   * Judge divergence, as a share of the criterion's scale, above which a criterion
   * is called contested. Read against `judgeDivergence`, not `judgeSpread`.
   */
  contestedSpread?: number;
};

export const CRITERIA_DEFAULTS = {
  weakDiscrimination: 0.2,
  redundantAbove: 0.9,
  narrowRange: 0.4,
  // On the divergence footing this is a judge sitting 8% of the scale away from
  // where their own general strictness would put them — four fifths of a point on
  // a 1-10 criterion, which is a real difference of opinion about what the words
  // mean rather than a strict judge being strict.
  contestedSpread: 0.08,
} as const;

const DEFAULTS = CRITERIA_DEFAULTS;

export type CriterionVerdict = "discriminating" | "weak" | "flat";

export type CriterionInsight = {
  key: string;
  label: string;
  /** Share of the weighted total this criterion carries, after normalization. */
  weight: number;
  /** The declared scale, repeated so a reader does not have to hold the rubric. */
  scaleMin: number;
  scaleMax: number;
  ballots: number;
  observedMean: number;
  observedSd: number;
  observedMin: number;
  observedMax: number;
  /** Fraction of the declared range the panel actually used. */
  rangeUsed: number;
  /**
   * Share of this criterion's spread that is between projects rather than within
   * one. One minus the mean within-project variance over the total, floored at
   * zero. Not an ICC: it makes no correction for how many ballots each project
   * drew, so on two ballots per project it reads high. Compare criteria against
   * each other with it, not against an absolute standard.
   */
  discrimination: number;
  /** Spread of per-judge means, on the criterion's own scale. */
  judgeSpread: number;
  /**
   * Judge disagreement about *this criterion specifically*, as a share of its
   * declared range.
   *
   * `judgeSpread` cannot answer that question. A judge who marks everything two
   * points low inflates it on every criterion at once, so the criterion the panel
   * genuinely reads differently is buried under general strictness. This subtracts
   * each judge's own overall position first: express their mean on this criterion
   * as a fraction of its range, subtract the mean of that fraction across all
   * criteria, and take the spread of what is left. A uniformly harsh judge
   * contributes nothing to it, which is the point.
   *
   * The centring has one artifact worth knowing, and it is exact rather than
   * approximate: subtracting a judge's rubric-wide mean leaks a fixed fraction of a
   * real quarrel into the baseline of every other criterion, so on a rubric of `k`
   * criteria the disputed one reads exactly `k - 1` times the innocent ones instead
   * of infinitely more. The ordering is unaffected and `contested` reports the
   * largest — but read this as "which criterion, and how much more than the rest",
   * not as an absolute quantity.
   */
  judgeDivergence: number;
  /** Correlation with the weighted total, ballot by ballot. */
  withTotal: number;
  /** Correlation of per-project means with the fitted ranking, when there is one. */
  withRanking: number;
  verdict: CriterionVerdict;
};

export type CriterionPair = {
  a: string;
  b: string;
  correlation: number;
};

export type CriteriaResult = {
  method: string;
  criteria: CriterionInsight[];
  /** Pairs at or above the redundancy threshold, strongest first. */
  redundant: CriterionPair[];
  /** Mean absolute correlation across every pair: how much the rubric repeats. */
  meanCorrelation: number;
  /** The criterion with the largest judge divergence, if any clears the threshold. */
  contested: string | null;
  warnings: string[];
  notes: Diagnostic[];
};

type Cell = { judge: JudgeId; project: ProjectId; value: number };

/** Per-criterion behaviour, plus the redundancy the single-column view hides. */
export function criterionInsights(
  rubric: Rubric,
  ballots: readonly Ballot[],
  fit: NormalizationResult | null = null,
  options: CriteriaOptions = {},
): CriteriaResult {
  const opt = { ...DEFAULTS, ...options };
  if (ballots.length === 0) {
    throw new JudgingError("criteria.empty", "There are no ballots to read.");
  }
  const weights = normalizedWeights(rubric.criteria);

  for (const b of ballots) {
    if (b.rubricVersion !== rubric.version) {
      throw new JudgingError(
        "ballot.rubricVersion",
        `Ballot ${b.id} targets rubric version ${b.rubricVersion}, not ${rubric.version}.`,
      );
    }
  }
  const totals = ballots.map((b) => weightedTotal(rubric, b.scores));

  const cells = new Map<string, Cell[]>();
  for (const c of rubric.criteria) cells.set(c.key, []);
  for (const b of ballots) {
    for (const c of rubric.criteria) {
      (cells.get(c.key) as Cell[]).push({
        judge: b.judge,
        project: b.project,
        value: b.scores[c.key] as number,
      });
    }
  }

  const adjusted = fit
    ? new Map<ProjectId, number>(fit.projects.map((p) => [p.project, p.adjusted]))
    : null;

  // Every judge's mean on every criterion, expressed as a fraction of that
  // criterion's declared range, plus each judge's average across the whole rubric.
  // Criteria are allowed different scales, so fractions are the only footing on
  // which a judge's position on one is comparable with their position on another.
  const fractionOf = new Map<JudgeId, Map<string, number>>();
  for (const c of rubric.criteria) {
    const span = c.max - c.min;
    const byJudge = new Map<JudgeId, number[]>();
    for (const r of cells.get(c.key) as Cell[]) {
      const seen = byJudge.get(r.judge);
      if (seen) seen.push(r.value);
      else byJudge.set(r.judge, [r.value]);
    }
    for (const [judge, values] of byJudge) {
      let row = fractionOf.get(judge);
      if (row === undefined) {
        row = new Map<string, number>();
        fractionOf.set(judge, row);
      }
      row.set(c.key, span > 0 ? (mean(values) - c.min) / span : 0);
    }
  }
  const overallFraction = new Map<JudgeId, number>();
  for (const [judge, row] of fractionOf) overallFraction.set(judge, mean([...row.values()]));

  const insights: CriterionInsight[] = rubric.criteria.map((c: Criterion) => {
    const rows = cells.get(c.key) as Cell[];
    const values = rows.map((r) => r.value);
    const spread = sd(values);
    const total = variance(values);

    const byProject = new Map<ProjectId, number[]>();
    const byJudge = new Map<JudgeId, number[]>();
    for (const r of rows) {
      const p = byProject.get(r.project);
      if (p) p.push(r.value);
      else byProject.set(r.project, [r.value]);
      const j = byJudge.get(r.judge);
      if (j) j.push(r.value);
      else byJudge.set(r.judge, [r.value]);
    }
    const within = mean(
      [...byProject.values()].filter((v) => v.length > 1).map((v) => variance(v)),
    );
    const discrimination = total > 0 ? clamp(1 - within / total, 0, 1) : 0;

    let withRanking = 0;
    if (adjusted) {
      const keys = [...byProject.keys()].filter((p) => adjusted.has(p)).sort();
      if (keys.length > 2) {
        withRanking = correlation(
          keys.map((p) => mean(byProject.get(p) as number[])),
          keys.map((p) => adjusted.get(p) as number),
        );
      }
    }

    const verdict: CriterionVerdict =
      spread < 1e-9 ? "flat" : discrimination < opt.weakDiscrimination ? "weak" : "discriminating";

    const divergences: number[] = [];
    for (const judge of byJudge.keys()) {
      const here = fractionOf.get(judge)?.get(c.key);
      const overall = overallFraction.get(judge);
      if (here !== undefined && overall !== undefined) divergences.push(here - overall);
    }

    return {
      key: c.key,
      label: c.label,
      weight: weights.get(c.key) as number,
      scaleMin: c.min,
      scaleMax: c.max,
      ballots: rows.length,
      observedMean: mean(values),
      observedSd: spread,
      observedMin: Math.min(...values),
      observedMax: Math.max(...values),
      rangeUsed: c.max > c.min ? (Math.max(...values) - Math.min(...values)) / (c.max - c.min) : 0,
      discrimination,
      judgeSpread: sd([...byJudge.values()].map((v) => mean(v))),
      judgeDivergence: divergences.length > 1 ? sd(divergences) : 0,
      withTotal: correlation(values, totals),
      withRanking,
      verdict,
    };
  });

  const redundant: CriterionPair[] = [];
  const magnitudes: number[] = [];
  for (let i = 0; i < rubric.criteria.length; i++) {
    for (let k = i + 1; k < rubric.criteria.length; k++) {
      const a = rubric.criteria[i] as Criterion;
      const b = rubric.criteria[k] as Criterion;
      const r = correlation(
        (cells.get(a.key) as Cell[]).map((c) => c.value),
        (cells.get(b.key) as Cell[]).map((c) => c.value),
      );
      magnitudes.push(Math.abs(r));
      if (Math.abs(r) >= opt.redundantAbove) redundant.push({ a: a.key, b: b.key, correlation: r });
    }
  }
  redundant.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation) || x.a.localeCompare(y.a));

  const diag = new DiagnosticCollector();

  for (const c of insights) {
    if (c.verdict === "flat") {
      diag.report(
        "criterion.flat",
        "warn",
        `Every ballot scored "${c.label}" the same. It carries ` +
          `${(c.weight * 100).toFixed(0)}% of the weighted total and contributes nothing ` +
          `to the ranking — the weight is being spent on a constant.`,
        [c.key],
      );
    } else if (c.verdict === "weak") {
      diag.report(
        "criterion.weak",
        "warn",
        `Only ${(c.discrimination * 100).toFixed(0)}% of the spread on "${c.label}" is ` +
          `between projects; the rest is judges disagreeing about the same project. It ` +
          `carries ${(c.weight * 100).toFixed(0)}% of the total, so most of that weight is ` +
          `moving noise around.`,
        [c.key],
      );
    }
    if (c.rangeUsed < opt.narrowRange && c.verdict !== "flat") {
      diag.report(
        "criterion.narrowRange",
        "info",
        `"${c.label}" is scored between ${c.observedMin} and ${c.observedMax} on a ` +
          `${c.scaleMin}-${c.scaleMax} scale. A scale nobody uses the ends of is a shorter ` +
          `scale with extra steps.`,
        [c.key],
      );
    }
  }

  for (const pair of redundant) {
    const a = insights.find((c) => c.key === pair.a) as CriterionInsight;
    const b = insights.find((c) => c.key === pair.b) as CriterionInsight;
    diag.report(
      "criterion.redundant",
      "info",
      `"${a.label}" and "${b.label}" correlate ${pair.correlation.toFixed(2)}. They may be ` +
        `one question asked twice, in which case their combined ` +
        `${((a.weight + b.weight) * 100).toFixed(0)}% is really the weight of one criterion.`,
      [pair.a, pair.b],
    );
  }

  // Contested is decided on divergence rather than raw spread, so that a panel
  // containing one generous judge does not get told every criterion is contested.
  const ordered = insights
    .slice()
    .sort((x, y) => y.judgeDivergence - x.judgeDivergence || x.key.localeCompare(y.key));
  const worst = ordered[0];
  const contested =
    worst !== undefined && worst.judgeDivergence >= opt.contestedSpread ? worst.key : null;
  if (worst !== undefined && contested !== null) {
    diag.report(
      "criterion.contested",
      "info",
      `Judges read "${worst.label}" differently from each other: after allowing for how ` +
        `strict each of them is in general, their positions on it still differ by ` +
        `${(worst.judgeDivergence * 100).toFixed(0)}% of its ` +
        `${worst.scaleMin}-${worst.scaleMax} scale. Their raw averages span ` +
        `${worst.judgeSpread.toFixed(2)} points. That is usually a criterion that means ` +
        `different things to different people, and it is fixed by rewording it before ` +
        `the next event, not by adjusting the scores already filed under it.`,
      [worst.key],
    );
  }

  return {
    method:
      `per-criterion-spread+redundancy` +
      `(weak<${opt.weakDiscrimination}, redundant>=${opt.redundantAbove})`,
    criteria: insights,
    redundant,
    meanCorrelation: magnitudes.length > 0 ? mean(magnitudes) : 0,
    contested,
    warnings: diag.warnings,
    notes: diag.notes,
  };
}
