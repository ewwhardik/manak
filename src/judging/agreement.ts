/**
 * Do the rubric and the pairwise ranking agree?
 *
 * Running both modes is only worth the judges' time if the two answers are
 * reconciled. Two rankings printed side by side with no comment is a way of
 * making the organizer's decision harder, not easier.
 *
 * Three things are reported, in increasing order of how much an organizer
 * actually cares:
 *
 *   1. **Kendall's tau** between the two orderings. A single number for "these
 *      methods broadly agree". High tau is genuinely good news: it means the
 *      cheap rubric ranking was already sound and the pairwise round was
 *      corroboration rather than correction.
 *   2. **Top-k overlap.** Prizes are awarded at the top, not in the middle, and
 *      tau is dominated by the middle. "Both methods pick the same three
 *      winners" is the claim that matters at a ceremony.
 *   3. **A shortlist of projects the two methods disagree about**, largest gap
 *      first. This is the deliverable: a short, ordered list of the places where
 *      a human should look before the results are frozen.
 *
 * "Disagree" needs a threshold, and a fixed number of places will not do. Measured
 * on synthetic events, the median absolute gap between the two methods runs to
 * about 2 places in a field of 30 and about 14 in a field of 120 at the same
 * comparison volume — so a fixed five-place rule flags a sixth of a small field
 * and three quarters of a large one. The threshold therefore scales with the
 * field, the shortlist is capped at a length somebody will actually work through,
 * and the median gap is published alongside it as a noise floor. When the
 * threshold falls at or below that floor the report says so plainly: the pairwise
 * round is too thin to arbitrate individual placings, whatever the ranking looks
 * like.
 *
 * A blended score is offered too, and deliberately not made the default. Rubric
 * points and Bradley-Terry log-strengths live on incomparable scales, so any
 * blend has to standardise first, and the weight is then a judgement call rather
 * than something the data implies. A blend is a presentational device. Pick one
 * method as the ranking of record, publish it, and use the disagreement list to
 * decide the handful of cases where the other method should overrule it.
 */

import type { ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";
import type { NormalizationResult } from "./normalize.ts";
import type { BradleyTerryResult } from "./bradleyterry.ts";
import { kendallTau, mean, rankDescending, sd } from "./stats.ts";
import { agree, names, plural } from "./words.ts";

export type AgreementOptions = {
  /**
   * Rank positions apart before a project earns a human second look. Overrides
   * the field-relative default below; give it only if you have a reason.
   */
  disagreementThreshold?: number;
  /**
   * Default threshold as a fraction of the field. A gap of five places means
   * something very different in a field of ten than in a field of five hundred,
   * so the default scales; measured gap distributions put 0.15 at roughly the
   * 80th percentile on a well-fed pairwise round.
   */
  disagreementFraction?: number;
  /** Floor under the derived threshold, for small fields. */
  minThreshold?: number;
  /**
   * Longest shortlist to hand back. Everything over the threshold is still
   * marked `flagged` and counted in `flaggedCount`; this caps the queue a human
   * is asked to work through before a ceremony.
   */
  maxDisagreements?: number;
  /** Weight on pairwise in the optional blend. 0.5 is an even split. */
  pairwiseWeight?: number;
  /** Cut-offs for the top-k overlap report. */
  topK?: readonly number[];
  /** Below this many comparisons a project's pairwise rank is called thin. */
  minComparisons?: number;
};

export type ProjectAgreement = {
  project: ProjectId;
  rubricRank: number;
  pairwiseRank: number;
  /** Positive means pairwise likes it better than the rubric did. */
  rankGap: number;
  rubricScore: number;
  pairwiseScore: number;
  rubricZ: number;
  pairwiseZ: number;
  /** Standardised blend. Presentational — see the note at the top of the file. */
  blended: number;
  blendedRank: number;
  ballots: number;
  comparisons: number;
  flagged: boolean;
};

export type AgreementResult = {
  method: string;
  /** Kendall tau-b between the two orderings over the shared projects. */
  tau: number;
  /** Fraction of the top k shared by both methods, keyed by k. */
  topOverlap: Map<number, number>;
  /** The resolved gap, in rank positions, at which a project was flagged. */
  threshold: number;
  /**
   * Median absolute rank gap across the field: the noise floor. A threshold at
   * or below this means the two estimates differ by about this much everywhere,
   * so an individual gap carries little information.
   */
  medianGap: number;
  projects: ProjectAgreement[];
  /** How many projects cleared the threshold, before the shortlist was capped. */
  flaggedCount: number;
  /** Worst disagreements first, capped. The list a human should work through. */
  disagreements: ProjectAgreement[];
  /** Projects only one method could rank. */
  rubricOnly: ProjectId[];
  pairwiseOnly: ProjectId[];
  warnings: string[];
};

/** The thresholds this comparison uses when the caller says nothing. */
export const AGREEMENT_DEFAULTS = {
  disagreementFraction: 0.15,
  minThreshold: 3,
  maxDisagreements: 10,
  pairwiseWeight: 0.5,
  topK: [1, 3, 5, 10] as readonly number[],
  minComparisons: 4,
} as const;

const DEFAULTS = AGREEMENT_DEFAULTS;

export function compareRankings(
  rubric: NormalizationResult,
  pairwise: BradleyTerryResult,
  options: AgreementOptions = {},
): AgreementResult {
  const opt = { ...DEFAULTS, ...options };
  if (!(opt.pairwiseWeight >= 0 && opt.pairwiseWeight <= 1)) {
    throw new JudgingError(
      "agreement.weight",
      `pairwiseWeight must sit in [0, 1], received ${opt.pairwiseWeight}.`,
    );
  }

  const rubricScore = new Map<ProjectId, number>(rubric.projects.map((p) => [p.project, p.adjusted]));
  const ballotsOf = new Map<ProjectId, number>(rubric.projects.map((p) => [p.project, p.ballots]));
  const pairwiseScore = new Map<ProjectId, number>(pairwise.strengths.map((s) => [s.project, s.beta]));
  const comparisonsOf = new Map<ProjectId, number>(
    pairwise.strengths.map((s) => [s.project, s.comparisons]),
  );

  const shared = [...rubricScore.keys()].filter((p) => pairwiseScore.has(p)).sort();
  const rubricOnly = [...rubricScore.keys()].filter((p) => !pairwiseScore.has(p)).sort();
  const pairwiseOnly = [...pairwiseScore.keys()].filter((p) => !rubricScore.has(p)).sort();
  if (shared.length === 0) {
    throw new JudgingError(
      "agreement.disjoint",
      "The rubric and pairwise rankings have no projects in common, so there is nothing to compare.",
    );
  }

  // Ranks are recomputed over the shared set. Reusing the ranks from each result
  // would compare position 4-of-60 against position 4-of-55 as though they meant
  // the same thing.
  const rubricRanks = rankDescending(shared.map((p) => ({ key: p, score: rubricScore.get(p) as number })));
  const pairwiseRanks = rankDescending(shared.map((p) => ({ key: p, score: pairwiseScore.get(p) as number })));

  const rubricValues = shared.map((p) => rubricScore.get(p) as number);
  const pairwiseValues = shared.map((p) => pairwiseScore.get(p) as number);
  const tau = kendallTau(rubricValues, pairwiseValues);

  const rubricMean = mean(rubricValues);
  const rubricSd = sd(rubricValues);
  const pairwiseMean = mean(pairwiseValues);
  const pairwiseSd = sd(pairwiseValues);
  const z = (x: number, m: number, s: number): number => (s > 1e-12 ? (x - m) / s : 0);

  const blend = new Map<ProjectId, number>();
  for (const p of shared) {
    const zr = z(rubricScore.get(p) as number, rubricMean, rubricSd);
    const zp = z(pairwiseScore.get(p) as number, pairwiseMean, pairwiseSd);
    blend.set(p, (1 - opt.pairwiseWeight) * zr + opt.pairwiseWeight * zp);
  }
  const blendedRanks = rankDescending(shared.map((p) => ({ key: p, score: blend.get(p) as number })));

  // A gap is only interpretable against the number of positions available, so
  // the threshold is derived from the field unless the caller overrides it.
  const threshold =
    options.disagreementThreshold ??
    Math.max(opt.minThreshold, Math.round(opt.disagreementFraction * shared.length));

  const projects: ProjectAgreement[] = shared.map((p) => {
    const rubricRank = rubricRanks.get(p) as number;
    const pairwiseRank = pairwiseRanks.get(p) as number;
    const rankGap = rubricRank - pairwiseRank;
    return {
      project: p,
      rubricRank,
      pairwiseRank,
      rankGap,
      rubricScore: rubricScore.get(p) as number,
      pairwiseScore: pairwiseScore.get(p) as number,
      rubricZ: z(rubricScore.get(p) as number, rubricMean, rubricSd),
      pairwiseZ: z(pairwiseScore.get(p) as number, pairwiseMean, pairwiseSd),
      blended: blend.get(p) as number,
      blendedRank: blendedRanks.get(p) as number,
      ballots: ballotsOf.get(p) ?? 0,
      comparisons: comparisonsOf.get(p) ?? 0,
      flagged: Math.abs(rankGap) >= threshold,
    };
  });
  projects.sort((a, b) => a.rubricRank - b.rubricRank);

  const sortedGaps = projects.map((p) => Math.abs(p.rankGap)).sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] as number;

  const ranked = projects
    .filter((p) => p.flagged)
    .slice()
    .sort((a, b) => Math.abs(b.rankGap) - Math.abs(a.rankGap) || a.project.localeCompare(b.project));
  const flaggedCount = ranked.length;
  const disagreements = ranked.slice(0, opt.maxDisagreements);

  const topOverlap = new Map<number, number>();
  for (const k of opt.topK) {
    if (k > shared.length) continue;
    const topRubric = new Set(projects.filter((p) => p.rubricRank <= k).map((p) => p.project));
    let hits = 0;
    for (const p of projects) if (p.pairwiseRank <= k && topRubric.has(p.project)) hits++;
    topOverlap.set(k, hits / k);
  }

  const warnings: string[] = [];
  if (rubricOnly.length > 0) {
    warnings.push(
      `${plural(rubricOnly.length, "project")} ${agree(rubricOnly.length, "has", "have")} ballots ` +
        `but no comparisons, so ${agree(rubricOnly.length, "it is", "they are")} absent from the ` +
        `pairwise ranking and excluded from this agreement report: ${names(rubricOnly)}.`,
    );
  }
  if (pairwiseOnly.length > 0) {
    warnings.push(
      `${plural(pairwiseOnly.length, "project")} ${agree(pairwiseOnly.length, "was", "were")} ` +
        `compared but never scored on the rubric: ${names(pairwiseOnly)}.`,
    );
  }
  if (!pairwise.connected) {
    warnings.push(
      `The comparison graph is in ${pairwise.componentCount} pieces, so pairwise ranks are ` +
        `not comparable across the whole field and this agreement figure overstates ` +
        `how much the two methods really disagree.`,
    );
  }
  const thin = projects.filter((p) => p.comparisons < opt.minComparisons).map((p) => p.project);
  if (thin.length > 0) {
    warnings.push(
      `${plural(thin.length, "project")} ${agree(thin.length, "has", "have")} fewer than ` +
        `${opt.minComparisons} comparisons; ${agree(thin.length, "its", "their")} pairwise position ` +
        `is provisional and should not be used to overrule a rubric rank.`,
    );
  }
  if (flaggedCount > disagreements.length) {
    warnings.push(
      `${plural(flaggedCount, "project")} cleared the ${threshold}-place disagreement threshold; the ` +
        `shortlist shows the ${disagreements.length} widest. Raise maxDisagreements to see ` +
        `the rest, or read flagged on each row.`,
    );
  }
  if (threshold <= medianGap) {
    warnings.push(
      `Half the field moves at least ${plural(medianGap, "place")} between the two methods, which is ` +
        `at or above the ${threshold}-place threshold. That is a precision problem, not a ` +
        `disagreement: the pairwise round is too thin to arbitrate individual placings. Use ` +
        `the top-k overlap as the usable signal and collect more comparisons before ` +
        `treating any single gap as meaningful.`,
    );
  }
  if (tau < 0.5) {
    warnings.push(
      `The two methods agree only weakly (tau ${tau.toFixed(3)}). Before treating this as a ` +
        `finding, check comparison volume — a thin pairwise round disagrees with everything. ` +
        `If volume is adequate, the disagreement is real and the rubric may be measuring ` +
        `something the judges do not actually use when choosing between two projects.`,
    );
  }

  return {
    method:
      `kendall-tau+top-k-overlap(threshold=${threshold}, ` +
      `pairwiseWeight=${opt.pairwiseWeight})`,
    tau,
    topOverlap,
    threshold,
    medianGap,
    projects,
    flaggedCount,
    disagreements,
    rubricOnly,
    pairwiseOnly,
    warnings,
  };
}
