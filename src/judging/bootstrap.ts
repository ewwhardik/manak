/**
 * How much of a pairwise ranking the comparisons actually establish.
 *
 * `fitBradleyTerry` returns a point estimate and nothing about its precision. On a
 * three-day event that estimate rests on a few hundred snap judgements, and the gap
 * between first and second is routinely smaller than the noise in either number. A
 * table of strengths printed without that fact is a ranking that claims more than it
 * knows, and the claim is always strongest exactly where it matters most.
 *
 * There is no closed-form standard error to reach for. The likelihood is not
 * quadratic, the design is whatever pairs the scheduler happened to serve, and the
 * MAP estimate is pulled toward the prior by an amount that depends on how thin each
 * project's record is. So this resamples instead: refit the same estimator on data
 * drawn with replacement from the data at hand, and read the spread of the answers.
 *
 * **The resampling unit is the judge, not the comparison.** This is the decision that
 * matters. Resampling comparisons treats each decision as an independent draw, which
 * they are not — one judge's twenty comparisons share one judge's taste, and a panel
 * of six people gives six independent opinions rather than a hundred and twenty. The
 * question an organizer is actually asking is "would a different panel have ranked
 * these the same way", and the cluster bootstrap is the one that answers it.
 * `unit: "comparison"` is available for the narrower question of whether *these* judges'
 * decisions were internally decisive, and is used automatically when there is only one
 * judge, because between-judge variation cannot be estimated from one judge.
 *
 * What the cluster version is *not* is a way to be safe by being pessimistic. The
 * received wisdom is that clustering widens intervals, and on simulated panels — with
 * and without private per-judge taste planted in the generator — the two units came out
 * within a few percent of each other, sometimes one way and sometimes the other. The
 * reason is that clustering trades two variance components against each other rather
 * than only adding one. It carries between-judge disagreement into the spread, which
 * widens; it also stops the resample thinning any one project's record, which narrows,
 * because a project's five comparisons come from five different judges and dropping a
 * judge costs it one of them while drawing comparisons independently can cost it three.
 * The unit is chosen for what the interval *means*, and a justification of the form
 * "wider is safer" would be a justification of something that does not reliably happen.
 * Where it does show plainly is the case it exists for: when a panel is split, half
 * preferring one project and half the other, the panel resample reports a strength that
 * swings across the whole gap and the comparison resample reports a near-certain tie.
 * `tests/bootstrap.test.ts` builds exactly that panel and pins the difference.
 *
 * The prior in `fitBradleyTerry` is what makes any of this possible. A resample
 * routinely leaves some project undefeated or absent, which has no maximum-likelihood
 * answer at all; the prior gives every replicate a finite one. A project that falls
 * out of a replicate entirely lands at the prior's own position, in the middle of the
 * field, which widens its interval — correctly, since a project nobody compared is a
 * project whose rank is not known.
 *
 * Everything here is seeded and therefore reproducible: the same comparisons produce
 * the same intervals on any machine, and a results page does not change its mind when
 * somebody refreshes it. The seed is published in the result so the number can be
 * re-derived rather than trusted.
 *
 * This covers the pairwise fit only. The ballot fit has an analytic standard error
 * already, computed in `reliability.ts` from its own residuals, and bootstrapping a
 * model that can tell you its own precision would be work spent to reach the same
 * answer less exactly.
 */

import type { Comparison, Diagnostic, JudgeId, ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";
import { makeRng } from "./rng.ts";
import { kendallTau, mean, rankDescending, sd } from "./stats.ts";
import { agree, names, plural, share } from "./words.ts";
import { fitBradleyTerry } from "./bradleyterry.ts";
import { BRADLEY_TERRY_DEFAULTS } from "./bradleyterry.ts";
import type { BradleyTerryResult } from "./bradleyterry.ts";

/** Which draw is treated as independent. See the note above; the default is `judge`. */
export type BootstrapUnit = "judge" | "comparison";

export type BootstrapOptions = {
  replicates?: number;
  unit?: BootstrapUnit;
  /** Coverage of the reported interval, and the threshold the pair test uses. */
  confidence?: number;
  seed?: string | number;
  /** Iteration cap for a replicate fit, which needs less precision than the estimate. */
  iterations?: number;
  tolerance?: number;
  /**
   * The phantom-opponent prior for the replicate fits. Left alone it is read off the
   * fit being described, so the replicates use the estimator that produced the
   * published number even when the caller fitted with a non-default prior.
   */
  prior?: number;
  /**
   * Replicates are cut to keep `replicates * (comparisons + projects)` under this.
   * A deterministic proxy for time rather than a measurement of it: a budget that
   * watched the clock would produce a different number of replicates on a different
   * machine, and therefore different intervals for the same event.
   *
   * The unit costs about 3 microseconds at the shipped iteration cap — measured across
   * 40, 120 and 240-project fields, where it stayed between 2.5 and 3.1 — so the default
   * of 600,000 is a ceiling of roughly two seconds on the machine it was measured on. It
   * does not bite on any plausible hackathon: 240 projects with 1,200 comparisons still
   * affords the full 400 replicates. It exists for the event that is ten times larger
   * than that, where the honest answer is a coarser interval rather than a page that
   * takes a minute to load.
   */
  workBudget?: number;
  /** The cut above never goes below this, however large the event. */
  minReplicates?: number;
};

/**
 * Exported for the reason every other default block in this engine is: the pages
 * print these and the tests pin them, and a default that exists twice is a default
 * that silently stops matching.
 *
 * 400 replicates puts the resolution of a tail share at 0.25 percentage points, which
 * is finer than the 2.5% threshold the pair test compares against and coarse enough to
 * stay near a second on the events this product is for.
 *
 * The replicate cap is 2,000 sweeps at a tolerance of 1e-6, against the estimate's
 * 20,000 at 1e-10. Both numbers were measured rather than guessed. A cap of 400 was
 * tried first, on the reasoning that the spread of a set of fits cannot care about the
 * last digits of any one of them, and it is true that it does not: the standard errors
 * agreed with a fully converged reference to three decimals. It was dropped anyway,
 * because at 400 sweeps between a sixth and three quarters of the replicates hit the
 * cap depending on field size, and a result that has to explain away most of its own
 * replicates is worse than a result that costs 50% more. At 2,000 every replicate on
 * every field tested settled, and the whole bootstrap runs in about 0.8s for 120
 * projects and 1.7s for 240. `replicatesConverged` is reported either way, so the
 * assumption stays checkable rather than becoming folklore.
 */
export const BOOTSTRAP_DEFAULTS = {
  replicates: 400,
  unit: "judge",
  confidence: 0.95,
  seed: "manak.bootstrap",
  iterations: 2000,
  tolerance: 1e-6,
  workBudget: 600_000,
  minReplicates: 40,
} as const;

const DEFAULTS = BOOTSTRAP_DEFAULTS;

export type StrengthInterval = {
  project: ProjectId;
  /** From the caller's full-precision fit. Never a replicate average. */
  beta: number;
  /** The rank that fit gave it, which is the rank being tested. */
  rank: number;
  /** Comparisons that mention it, counted from the data handed in. */
  comparisons: number;
  /**
   * Whether any evidence places it at all. A project nobody compared is fitted to the
   * prior's own position, in the middle of the field, and every number on this row then
   * describes where the middle of the field is rather than where the project stands.
   */
  placed: boolean;
  /** Spread of the replicate estimates: the bootstrap standard error. */
  standardError: number;
  low: number;
  high: number;
  /** Mean rank across replicates. Drifts toward the middle for thin records. */
  rankMean: number;
  rankLow: number;
  rankHigh: number;
  /** Share of replicates in which it held `rank`. */
  rankStability: number;
  /** Share of replicates in which it came first. */
  firstPlaceShare: number;
  /** 1-based, and 0 for an unplaced project, which belongs to no tier. */
  tier: number;
  /**
   * How many other projects share its tier, or its unplaced status.
   *
   * Sharing a tier means not being separated from the project that opened it, and that relation
   * does not compose: A and C can both be held with the leader B while a resample orders A above C
   * every time. `pairs` is the only place a boundary is established.
   */
  sharesTier: number;
};

export type BootstrapPair = {
  above: ProjectId;
  below: ProjectId;
  /** The published gap in log-strength, which the reversal share is testing. */
  betaGap: number;
  /** Share of replicates that put `below` above `above`. Ties count as reversals. */
  reversalShare: number;
  /** Whether the evidence orders the pair at the stated confidence. */
  ordered: boolean;
};

export type BootstrapResult = {
  method: string;
  unit: BootstrapUnit;
  /** The unit asked for, which differs from `unit` when there was one judge. */
  unitRequested: BootstrapUnit;
  seed: string;
  confidence: number;
  replicates: number;
  replicatesRequested: number;
  /** Replicate fits that reached their tolerance rather than their cap. */
  replicatesConverged: number;
  /** Replicates whose resampled comparison graph was not one component. */
  replicatesDisconnected: number;
  /** The finest share the replicate count can resolve: 1 / replicates. */
  resolution: number;
  /** The share a reversal has to stay under for a pair to count as ordered. */
  threshold: number;
  intervals: StrengthInterval[];
  /** Adjacent pairs of compared projects, worst-established first in the walk. */
  pairs: BootstrapPair[];
  /** Tiers the compared field divides into. Never more than places, usually fewer. */
  tiers: number;
  /** Projects no comparison mentions, which belong to no tier and no pair. */
  unplaced: number;
  /** Whether first place is separated from second. */
  decisive: boolean;
  /**
   * Mean Kendall tau-b between a replicate's ranking and the published one. This is the
   * headline number for "would another panel have produced this table": 1 is every
   * replicate agreeing on every pair, 0 is a coin toss. Measured over the compared
   * projects, so a row nobody judged cannot pad it by holding still.
   */
  orderAgreement: number;
  /**
   * Share of replicates that reproduced the published order *exactly*. A deliberately
   * strict reading, and one that is 0 on any field of more than a handful of projects —
   * a hundred-place table has a hundred places to get wrong. Reported because when it is
   * not 0 it is the strongest thing this module can say, and read beside
   * `orderAgreement` rather than instead of it.
   */
  orderStability: number;
  /**
   * The messages from `notes` whose severity is `warn`, and only those.
   *
   * Informational notes stay in `notes`. See `say`: a list that mixes "this is what happened" into
   * "this is what is wrong with what happened" reads as noise and gets skipped, and it is read at
   * the moment somebody publishes.
   */
  warnings: string[];
  notes: Diagnostic[];
};

/**
 * The `p`-quantile of a sorted sample by nearest rank, without interpolation.
 *
 * An interval endpoint is therefore always a value some replicate actually produced,
 * rather than a number between two of them. On 400 replicates the difference is in
 * the fourth decimal place and the property is worth more than the precision: every
 * number this module prints can be pointed at in the sample it came from.
 */
function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = Math.ceil(p * sorted.length) - 1;
  return sorted[at < 0 ? 0 : at > sorted.length - 1 ? sorted.length - 1 : at] as number;
}

/**
 * The prior the fit being described was computed with.
 *
 * `fitBradleyTerry` publishes it in `method` — `bradley-terry-mm(prior=1)` — which is
 * the only channel through which a result carries its own settings. Reading it back is
 * less elegant than being handed the options object and considerably safer than the
 * alternative of assuming the default: a replicate fitted under a different prior than
 * the estimate would produce an interval that does not belong to the number it is
 * printed beside. An unreadable method string falls back to the engine default, which
 * is what the estimate used if it was fitted without options.
 */
function priorOf(method: string, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) return override;
  const found = /prior=(-?\d+(?:\.\d+)?)/.exec(method);
  if (found === null) return BRADLEY_TERRY_DEFAULTS.prior;
  const value = Number(found[1]);
  return Number.isFinite(value) ? value : BRADLEY_TERRY_DEFAULTS.prior;
}

/**
 * Intervals, rank stability and indistinguishable pairs for a pairwise fit.
 *
 * `fit` is the published estimate and is never recomputed here: the point estimates
 * this reports are the ones the ranking was drawn from, and only their precision is
 * measured. Passing a fit of different comparisons than the ones handed in is the one
 * mistake that would produce a plausible and wrong answer, so it is refused.
 */
export function bootstrapStrengths(
  comparisons: readonly Comparison[],
  fit: BradleyTerryResult,
  options: BootstrapOptions = {},
): BootstrapResult {
  const opt = { ...DEFAULTS, ...options };
  if (comparisons.length === 0) {
    throw new JudgingError("bootstrap.empty", "There are no comparisons to resample.");
  }
  if (fit.strengths.length === 0) {
    throw new JudgingError("bootstrap.unfitted", "The fit contains no projects.");
  }
  if (!(opt.confidence > 0 && opt.confidence < 1)) {
    throw new JudgingError(
      "bootstrap.confidence",
      `Confidence must be strictly between 0 and 1; received ${opt.confidence}.`,
    );
  }
  if (!(opt.replicates >= 2)) {
    throw new JudgingError(
      "bootstrap.replicates",
      `A bootstrap needs at least 2 replicates; received ${opt.replicates}.`,
    );
  }

  const ranked = fit.strengths.slice().sort((a, b) => a.rank - b.rank);
  const ids = ranked.map((s) => s.project);
  const known = new Set<ProjectId>(ids);
  const beta = new Map<ProjectId, number>(ranked.map((s) => [s.project, s.beta]));
  const publishedRank = new Map<ProjectId, number>(ranked.map((s) => [s.project, s.rank]));
  // Counted from the comparisons handed in rather than read off `fit.strengths`, which
  // would report whatever the fit was given. If a caller resamples a subset of what was
  // fitted, this notices and the fit's own tallies would not.
  const mentions = new Map<ProjectId, number>(ids.map((p) => [p, 0]));
  for (const c of comparisons) {
    if (!known.has(c.left) || !known.has(c.right)) {
      throw new JudgingError(
        "bootstrap.mismatch",
        `Comparison ${c.id} names a project the fit does not contain. Resample the same ` +
          `comparisons that were fitted.`,
      );
    }
    mentions.set(c.left, (mentions.get(c.left) as number) + 1);
    mentions.set(c.right, (mentions.get(c.right) as number) + 1);
  }

  const notes: Diagnostic[] = [];
  const warnings: string[] = [];
  /**
   * A note, and a warning only if it is one.
   *
   * `warnings` is what the confidence page prints under "what qualifies these numbers" and what
   * `results.publish` echoes at the moment somebody commits; `notes` is the full table with codes
   * beside it. This used to push every message into both, which put "the comparisons resolve 3
   * tiers" — an `info` describing normal operation — in front of a publisher as though it were an
   * objection, and printed every single diagnostic twice on the page. A warning list that includes
   * the routine is a warning list nobody reads, which costs exactly the notes that were worth
   * reading. `reliability.ts` had the rule right; this is the same rule.
   */
  const say = (code: string, severity: "info" | "warn", message: string, subjects: string[] = []): void => {
    if (severity === "warn") warnings.push(message);
    notes.push({ code, severity, message, subjects });
  };

  /**
   * Projects no comparison mentions are set aside from every ordering question here.
   *
   * They are not dropped — they keep their row, their beta and their rank, because a
   * results table that silently omits a project is worse than one that admits it knows
   * nothing about it. But they are excluded from the tier walk, the adjacent-pair table
   * and the order-agreement statistic, for a reason that took a failing test to see: an
   * uncompared project is pinned at the prior's position, in the middle of the field, and
   * so it is the *most* stable row in the table. Its standard error came out at 0.059
   * against a field median of 0.364, its rank never moved, and it sat alone in its own
   * tier — which reads as "distinguishable from everybody" and is the exact opposite of
   * the truth. Worse, leaving it in the walk let a project with no evidence certify a
   * tier boundary between two projects that had some.
   *
   * The numbers on its row are left exactly as the resample produced them. What they
   * measure is how much the centre of the field moved, since centring is the only thing
   * that can move a project the prior is holding still.
   */
  const placedIds = ids.filter((p) => (mentions.get(p) as number) > 0);
  const unplacedIds = ids.filter((p) => (mentions.get(p) as number) === 0);
  if (unplacedIds.length > 0) {
    say(
      "bootstrap.unplaced",
      "warn",
      `${plural(unplacedIds.length, "project")} ${agree(unplacedIds.length, "appears", "appear")} ` +
        `in no comparison: ${names(unplacedIds)}. A project with no comparisons is held at the ` +
        `middle of the field by the prior, so its interval describes where that middle is and not ` +
        `where the project stands; such projects are shown without a tier and left out of the pair ` +
        `table and the order-agreement figure. The only fix is comparisons.`,
      unplacedIds,
    );
  }

  const byJudge = new Map<JudgeId, Comparison[]>();
  for (const c of comparisons) {
    const list = byJudge.get(c.judge);
    if (list) list.push(c);
    else byJudge.set(c.judge, [c]);
  }
  const judges = [...byJudge.keys()].sort();

  let unit: BootstrapUnit = opt.unit;
  if (unit === "judge" && judges.length < 2) {
    unit = "comparison";
    say(
      "bootstrap.singleJudge",
      "warn",
      `Only one judge has filed comparisons, so the panel-level resample was replaced by a ` +
        `comparison-level one. The intervals below describe how decisive this judge's own ` +
        `decisions were and say nothing about whether another judge would agree.`,
      judges,
    );
  }

  // The budget is applied before any fitting, so a large event is slow once rather
  // than partway through. Requesting fewer replicates than `minReplicates` is honoured:
  // the floor exists to stop the budget cutting too deep, not to override the caller.
  const perReplicate = comparisons.length + ids.length;
  const affordable = Math.max(opt.minReplicates, Math.floor(opt.workBudget / perReplicate));
  const replicates = Math.min(opt.replicates, Math.max(2, affordable));
  if (replicates < opt.replicates) {
    say(
      "bootstrap.replicatesReduced",
      "info",
      `${opt.replicates} replicates would exceed the work budget for ${comparisons.length} ` +
        `comparisons over ${ids.length} projects, so ${replicates} were run. The intervals are ` +
        `coarser than the defaults describe: the finest share resolvable is ` +
        `${(100 / replicates).toFixed(2)}%.`,
    );
  }

  const rng = makeRng(opt.seed);
  const prior = priorOf(fit.method, options.prior);
  // Every replicate starts from the published strengths rather than from unit ones. The
  // fixed point is unique, so this changes the number of sweeps and not the answer, and
  // a replicate of slightly different data lands close to where the estimate already is.
  const start = new Map<ProjectId, number>(ranked.map((s) => [s.project, Math.exp(s.beta)]));
  const betaSamples: number[][] = [];
  const rankSamples: number[][] = [];
  // Order agreement is measured over the placed projects only, at their positions in the
  // full-field rows. Relative order is all tau reads, so slicing columns out is safe, and
  // a pinned uncompared project would otherwise contribute a column that always agrees.
  const placedAt = ids.map((_p, i) => i).filter((i) => (mentions.get(ids[i] as ProjectId) as number) > 0);
  const publishedOrder = ids.map((p) => publishedRank.get(p) as number);
  const publishedPlaced = placedAt.map((i) => publishedOrder[i] as number);
  let converged = 0;
  let disconnected = 0;
  let exactOrder = 0;
  let tauTotal = 0;

  for (let r = 0; r < replicates; r++) {
    const draw: Comparison[] = [];
    if (unit === "judge") {
      for (let k = 0; k < judges.length; k++) {
        const pick = judges[rng.int(judges.length)] as JudgeId;
        for (const c of byJudge.get(pick) as Comparison[]) draw.push(c);
      }
    } else {
      for (let k = 0; k < comparisons.length; k++) {
        draw.push(comparisons[rng.int(comparisons.length)] as Comparison);
      }
    }

    // Every replicate is fitted over the full project list, so a project that no
    // surviving comparison mentions still receives a strength — the prior's, in the
    // middle of the field — rather than dropping out of the table and out of the
    // ranking. Dropping it would quietly narrow its interval to nothing.
    const replicate = fitBradleyTerry(draw, ids, {
      prior: prior,
      iterations: opt.iterations,
      tolerance: opt.tolerance,
      start,
    });
    if (replicate.converged) converged += 1;
    if (!replicate.connected) disconnected += 1;

    const b = new Map<ProjectId, number>(replicate.strengths.map((s) => [s.project, s.beta]));
    const row = ids.map((p) => b.get(p) as number);
    betaSamples.push(row);
    const ranks = rankDescending(ids.map((p, i) => ({ key: p, score: row[i] as number })));
    const rankRow = ids.map((p) => ranks.get(p) as number);
    rankSamples.push(rankRow);
    const rankPlaced = placedAt.map((i) => rankRow[i] as number);
    tauTotal += kendallTau(publishedPlaced, rankPlaced);
    if (rankPlaced.every((r, i) => r === publishedPlaced[i])) exactOrder += 1;
  }

  // One tail, rounded, and then used for everything: the interval endpoints and the pair
  // test both read this number, so there is no way for the published threshold to differ
  // from the one the code applied.
  //
  // The rounding is not cosmetic. `(1 - 0.95) / 2` is 0.025000000000000022 in binary
  // floating point, and `quantile` turns a tail into an index with `ceil(p * n)`: at 400
  // replicates the exact value gives `ceil(10) = 10` and the noisy one `ceil(10.000000000000009)
  // = 11`, so the leftover 2e-17 silently moved both interval endpoints by one order
  // statistic. Rounding at 1e-12 cannot change a pair verdict, because every reversal
  // share is a ratio of integers `k / replicates`: either it is exactly equal to the tail,
  // in which case both the rounded and unrounded comparisons agree, or it differs from it
  // by at least `1 / (replicates * 40)`, which is nine orders of magnitude larger than the
  // correction.
  const alpha = 1 - opt.confidence;
  const tail = Math.round((alpha / 2) * 1e12) / 1e12;
  const threshold = tail;
  const index = new Map<ProjectId, number>(ids.map((p, i) => [p, i]));

  /**
   * When the tail is finer than one replicate, both of the things this module reports
   * quietly change meaning, so it says so.
   *
   * A reversal share is `k / replicates` and can therefore only take values on that grid.
   * If the threshold falls below `1 / replicates` the only share that clears it is zero,
   * and `ordered` stops meaning "reversed in under 0.5% of resamples" and starts meaning
   * "never reversed once" — a stricter test than the one the confidence level names, which
   * will read as an unusually undecided field rather than as a resolution limit. The
   * interval endpoints degenerate the same way: `quantile` clamps to index 0 and to the
   * last, so `low` and `high` become the extremes of the sample rather than percentiles of
   * it, which is wider than the stated coverage and not the coverage stated.
   *
   * Both are honest outcomes of asking for a 99% interval from 60 draws, and neither is
   * visible in the numbers themselves. The fix is more replicates, and the arithmetic for
   * how many is on the note rather than left to the reader.
   */
  if (threshold < 1 / replicates) {
    say(
      "bootstrap.coarse",
      "warn",
      `${replicates} replicates cannot resolve the ${(threshold * 100).toFixed(2)}% tail that ` +
        `${(opt.confidence * 100).toFixed(0)}% confidence asks for: the finest share measurable is ` +
        `${((1 / replicates) * 100).toFixed(2)}%. A pair therefore counts as ordered only if it ` +
        `never reversed in any resample, and each interval spans its whole sample rather than ` +
        `${(opt.confidence * 100).toFixed(0)}% of it. Both read as stricter than the stated ` +
        `confidence. Use at least ${Math.ceil(1 / threshold)} replicates, or a wider interval.`,
    );
  }

  /**
   * Share of replicates that put `below` at or above `above`.
   *
   * An exact tie counts as a reversal, which happens only when neither project was
   * mentioned in the replicate and both sit at the prior. Counting it as a reversal
   * claims less, which is the right direction for a number whose whole job is to stop
   * a ranking overclaiming.
   */
  const reversalShare = (above: ProjectId, below: ProjectId): number => {
    const a = index.get(above) as number;
    const b = index.get(below) as number;
    let reversed = 0;
    for (const row of betaSamples) {
      if ((row[b] as number) >= (row[a] as number)) reversed += 1;
    }
    return reversed / betaSamples.length;
  };

  // Tiers, by the same walk `reliability.ts` uses on the ballot fit: a project joins
  // the tier of the highest project it cannot be ordered against. The test differs —
  // there it is the standard error of a difference, here it is the share of replicates
  // that reverse the pair — but the reading is identical, and two different tests
  // producing two different words for the same idea would be the worse outcome.
  const tierOf = new Map<ProjectId, number>();
  let tier = 0;
  let leader: ProjectId | undefined;
  for (const p of placedIds) {
    if (leader === undefined) {
      tier = 1;
      leader = p;
      tierOf.set(p, tier);
      continue;
    }
    if (reversalShare(leader, p) > threshold) {
      tierOf.set(p, tier);
    } else {
      tier += 1;
      leader = p;
      tierOf.set(p, tier);
    }
  }
  const perTier = new Map<number, number>();
  for (const t of tierOf.values()) perTier.set(t, (perTier.get(t) ?? 0) + 1);

  const intervals: StrengthInterval[] = ids.map((p, i) => {
    const draws = betaSamples.map((row) => row[i] as number);
    const sorted = draws.slice().sort((a, b) => a - b);
    const ranks = rankSamples.map((row) => row[i] as number);
    const sortedRanks = ranks.slice().sort((a, b) => a - b);
    const mine = publishedRank.get(p) as number;
    const seen = mentions.get(p) as number;
    const t = tierOf.get(p) ?? 0;
    return {
      project: p,
      beta: beta.get(p) as number,
      rank: mine,
      comparisons: seen,
      placed: seen > 0,
      standardError: sd(draws),
      low: quantile(sorted, tail),
      high: quantile(sorted, 1 - tail),
      rankMean: mean(ranks),
      rankLow: quantile(sortedRanks, tail),
      rankHigh: quantile(sortedRanks, 1 - tail),
      rankStability: ranks.filter((r) => r === mine).length / ranks.length,
      firstPlaceShare: ranks.filter((r) => r === 1).length / ranks.length,
      tier: t,
      sharesTier: t === 0 ? unplacedIds.length - 1 : (perTier.get(t) as number) - 1,
    };
  });

  // Adjacent among the projects there is evidence about, which is not the same as
  // adjacent in the published table when an unplaced project is sitting between two of
  // them. Walking the table itself would ask whether a project with no comparisons
  // outranks one with a hundred, and answer confidently.
  const pairs: BootstrapPair[] = [];
  for (let i = 0; i + 1 < placedIds.length; i++) {
    const above = placedIds[i] as ProjectId;
    const below = placedIds[i + 1] as ProjectId;
    const share = reversalShare(above, below);
    pairs.push({
      above,
      below,
      betaGap: (beta.get(above) as number) - (beta.get(below) as number),
      reversalShare: share,
      ordered: share <= threshold,
    });
  }

  const tiers = perTier.size;
  const decisive = pairs.length === 0 ? placedIds.length === 1 : (pairs[0] as BootstrapPair).ordered;

  if (!decisive && pairs.length > 0) {
    const top = pairs[0] as BootstrapPair;
    say(
      "bootstrap.tiedTop",
      "warn",
      `First place is not established: ${top.below} finishes above ${top.above} in ` +
        `${share(top.reversalShare)} of resamples, against a threshold of ` +
        `${share(threshold)}. These two are statistically indistinguishable on the ` +
        `comparisons filed so far, and more comparisons between them is the only fix.`,
      [top.above, top.below],
    );
  }
  if (tiers < placedIds.length) {
    say(
      "bootstrap.tiers",
      "info",
      `The comparisons resolve ${tiers} ${tiers === 1 ? "tier" : "tiers"} among ` +
        `${placedIds.length} compared projects. A tier holds the projects that are not separated ` +
        `from the one at the top of it, so the tier leader is the defensible unit to award on. It ` +
        `is not a claim that every project in a tier ties with every other — read \`pairs\` for ` +
        `that.`,
    );
  }
  const unstable = intervals.filter((iv) => iv.rankHigh - iv.rankLow >= Math.max(2, ids.length / 2));
  if (unstable.length > 0) {
    say(
      "bootstrap.wideRank",
      "warn",
      `${plural(unstable.length, "project")} ${agree(unstable.length, "moves", "move")} across at ` +
        `least half the field between resamples, so ` +
        `${agree(unstable.length, "its", "their")} published place is close to arbitrary: ` +
        `${names(unstable.map((iv) => `${iv.project} (places ${iv.rankLow} to ${iv.rankHigh})`))}.`,
      unstable.map((iv) => iv.project),
    );
  }
  if (disconnected > 0) {
    say(
      "bootstrap.disconnectedReplicates",
      disconnected > replicates / 2 ? "warn" : "info",
      `${disconnected} of ${replicates} resamples produced a comparison graph in more than one ` +
        `piece, where strengths across pieces are held apart by the prior rather than by ` +
        `evidence. This widens the intervals below, which is the honest consequence of a ` +
        `comparison set that is only just connected.`,
    );
  }
  if (converged < replicates) {
    say(
      "bootstrap.notConverged",
      converged < replicates * 0.9 ? "warn" : "info",
      `${replicates - converged} of ${replicates} replicate fits reached the ${opt.iterations}-` +
        `sweep cap instead of settling. Their strengths are approximate, which widens the ` +
        `intervals slightly rather than biasing them.`,
    );
  }

  return {
    method: `pairwise-bootstrap(${unit}, ${replicates}, prior=${prior})`,
    unit,
    unitRequested: opt.unit,
    seed: String(opt.seed),
    confidence: opt.confidence,
    replicates,
    replicatesRequested: opt.replicates,
    replicatesConverged: converged,
    replicatesDisconnected: disconnected,
    resolution: 1 / replicates,
    threshold,
    intervals,
    pairs,
    tiers,
    unplaced: unplacedIds.length,
    decisive,
    orderAgreement: tauTotal / replicates,
    orderStability: exactOrder / replicates,
    warnings,
    notes,
  };
}
