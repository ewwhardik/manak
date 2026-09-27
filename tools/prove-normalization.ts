/**
 * The normalization proof.
 *
 *     npm run prove:normalization           # regenerate docs/proof/
 *     npm run prove:normalization -- --check  # verify the committed numbers
 *
 * "Our normalization improves the ranking" is a claim, and on a real event it is
 * an unfalsifiable one: nobody knows the true ordering, so any output looks
 * plausible. This harness plants a truth, generates ballots through it, and asks
 * three methods to recover what none of them was shown — the raw mean, per-judge
 * z-scoring, and the engine's fitted judge effects — scoring each by Kendall's
 * tau against the planted ordering.
 *
 * The result is not a uniform win, and the report says so. On a balanced design
 * the three methods finish within a few points of each other and z-scoring edges
 * ahead; normalization earns its place as the design becomes correlated, which is
 * what real events look like once judges drop out, specialists cluster on a track,
 * and late submissions go to whoever is still awake. Publishing the regime where
 * the method is merely neutral is the point: a proof that only reports the
 * favourable half of its own sweep is advertising.
 *
 * `--check` re-runs every sweep and compares against the committed CSV with a
 * numeric tolerance rather than byte for byte. Simulation runs through `Math.exp`
 * and `Math.log`, which are not bit-identical across platforms, so demanding
 * identical bytes would fail for reasons that have nothing to do with the engine.
 * The claim has to reproduce; the last decimal does not.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { NormalizeOptions } from "../src/judging/normalize.ts";
import {
  NORMALIZE_DEFAULTS,
  normalizeScores,
  rawMeanRanking,
  zScoreRanking,
} from "../src/judging/normalize.ts";
import { CALIBRATION_DEFAULTS, judgeCalibration } from "../src/judging/calibration.ts";
import { panelReliability } from "../src/judging/reliability.ts";
import { correlation, kendallTau, mean, median, rmse } from "../src/judging/stats.ts";
import type { SimulationOptions } from "../src/judging/simulate.ts";
import { simulateEvent } from "../src/judging/simulate.ts";

import { fileURLToPath } from "node:url";
const OUT_MD = fileURLToPath(new URL("../docs/proof/normalization.md", import.meta.url));
const OUT_CSV = fileURLToPath(new URL("../docs/proof/normalization.csv", import.meta.url));

/** Absolute tolerance when checking a committed number. */
const TOLERANCE = 0.02;

/** Seeds per configuration. Every scenario sees the same seed list. */
const SEEDS = 20;

/** Read from the engine, not restated, so an ablation label cannot go stale. */
const DEFAULT_KAPPA = NORMALIZE_DEFAULTS.kappa;
const DEFAULT_BACKFIT = NORMALIZE_DEFAULTS.backfitIterations;
const DEFAULT_ROUNDS = NORMALIZE_DEFAULTS.rounds;

/** The design every sweep varies from. */
const BASE: SimulationOptions = {
  projects: 60,
  judges: 12,
  reviewsPerProject: 4,
  leniencySd: 0.6,
  scaleSpread: 0.4,
  noise: 0.35,
};

/**
 * The one finding the strategic sweep scores itself against, quoted from the engine
 * rather than typed here twice. Renaming the code in `calibration.ts` should turn this
 * sweep's detection column to zero and fail `claims()`, not silently keep passing.
 */
const EXTREME = "judge.extremeBallot";

/** The threshold that finding fires at, printed in the report so the two cannot drift. */
const EXTREME_Z = CALIBRATION_DEFAULTS.extremeZ;

/**
 * The push a strategic judge applies, in points of the rubric's own scale, and how far
 * they mark down everything else they were given.
 *
 * Stated here rather than left to the simulator's defaults because the report quotes both
 * numbers in prose. A default that is quoted somewhere else is a default that can drift
 * from the sentence describing it.
 */
const PUSH = 1.5;
const SUPPRESS = 0.6;

/** Half the push, to find the floor of what the check reaches. */
const HALF_PUSH = 0.8;
const HALF_SUPPRESS = 0.3;

type Scenario = {
  sweep: string;
  label: string;
  event: SimulationOptions;
  normalize?: NormalizeOptions;
  seeds?: number;
  /**
   * Also fit reliability and run the calibration pass, and fill the four strategic
   * columns from them.
   *
   * Off by default because it is the expensive path and forty of the scenarios below
   * have nothing to put in those columns: they plant no favourite, so the rank lift is
   * undefined and the detection rate is a division by zero. Gating it also keeps the
   * cost of the sweep proportional to what is being claimed rather than to how many
   * rows there are.
   */
  strategic?: boolean;
};

type Row = {
  sweep: string;
  label: string;
  seeds: number;
  tauRaw: number;
  tauZ: number;
  tauNorm: number;
  /** Seeds where the fitted ranking beat the raw mean, and per-judge z-scoring. */
  winsVsRaw: number;
  winsVsZ: number;
  /** Correlation between planted and fitted judge leniency, and judge scale. */
  leniencyR: number;
  scaleR: number;
  /**
   * Error in the judge estimates themselves, not in the ranking they produce.
   * Correlation says the fit got the ordering of judges right; RMSE says whether
   * the number printed next to a judge's name is close. Shrinkage is supposed to
   * trade a little of the former for the latter, and this is where that shows.
   */
  leniencyRmse: number;
  scaleRmse: number;
  /** Mean reported standard error, on the rubric's own scale. */
  standardError: number;
  /** Worst single-seed tau for the fitted ranking: the floor, not the average. */
  tauNormWorst: number;
  /** Ballots filed by the quietest and the busiest judge, averaged over seeds. */
  loadMin: number;
  loadMax: number;
  /** Seeds where the fit warned that the design splits into disconnected groups. */
  disconnected: number;
  /**
   * Planted favourites summed over every seed, and the mean number of places one of
   * them gained.
   *
   * A count rather than a rate because a colluding pair shares one favourite and two
   * independent judges have two, so this is also how the two configurations are told
   * apart from the CSV alone. `NaN` where nothing was planted.
   */
  favourites: number;
  rankLift: number;
  /** Planted favourites that finished inside the top ten from outside it. */
  intoTopTen: number;
  /**
   * Cheating judges summed over every seed — the denominator of `namedShare`, carried
   * so the detection rate can be read back as a count of judges. The honest pool is the
   * rest: judges times seeds, less this.
   */
  planted: number;
  /**
   * Share of the planted judges the calibration pass raised `judge.extremeBallot`
   * against, and the share of the honest judges in the same runs it raised it against.
   *
   * The specific finding rather than the verdict, because the verdict is reachable
   * from a dozen unrelated directions — a judge who is merely behind on their queue
   * earns one — and a detection rate that counted those would be measuring the
   * organizer's inbox rather than the detector.
   */
  namedShare: number;
  falseShare: number;
  /**
   * The two figures the threshold itself rests on: the furthest any *honest* judge's
   * worst ballot landed from the fit, and the median for a planted one, both as absolute
   * standardised residuals.
   *
   * Carried because `calibration.ts` cites this report for them. A threshold chosen from
   * a measurement is only as good as the measurement remaining reproducible, and the two
   * numbers either side of it are more informative than the number itself: what makes 4
   * defensible is not that it is 4, it is that the honest maximum is well below it and
   * the planted median well above.
   */
  honestMaxZ: number;
  plantedMedianZ: number;
};

const round = (x: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

type ShrinkCondition = { condition: string; event: SimulationOptions };

/**
 * How much evidence each judge supplies, from comfortable to thin. `kappa` is
 * crossed against these rather than measured once, because shrinkage is insurance
 * and insurance looks like a waste of money in every year the house stands. The
 * sweep and the report both read this list, so a condition cannot be renamed in
 * one place and quoted from the other.
 */
const SHRINK_CONDITIONS: readonly ShrinkCondition[] = [
  { condition: "even workload, ~20 ballots each", event: { imbalance: 0.5 } },
  { condition: "uneven workload", event: { imbalance: 0.5, activitySkew: 1 } },
  { condition: "thin panel, ~10 ballots each", event: { imbalance: 0.5, reviewsPerProject: 2 } },
  {
    condition: "thin and uneven",
    event: { imbalance: 0.5, reviewsPerProject: 2, activitySkew: 1 },
  },
  {
    condition: "very thin, ~5 ballots each",
    event: { imbalance: 0.5, projects: 30, reviewsPerProject: 2 },
  },
  {
    condition: "very thin and uneven",
    event: { imbalance: 0.5, projects: 30, reviewsPerProject: 2, activitySkew: 1 },
  },
];

const LAST_CONDITION = SHRINK_CONDITIONS[SHRINK_CONDITIONS.length - 1] as ShrinkCondition;
const THINNEST = LAST_CONDITION.condition;

const KAPPAS: readonly number[] = [0, DEFAULT_KAPPA, 8, 64];

const shrinkLabel = (condition: string, kappa: number): string =>
  `${condition} · kappa=${kappa}${kappa === DEFAULT_KAPPA ? " (default)" : ""}`;

function measure(scenario: Scenario): Row {
  const seeds = scenario.seeds ?? SEEDS;
  const raw: number[] = [];
  const z: number[] = [];
  const norm: number[] = [];
  const leniency: number[] = [];
  const scale: number[] = [];
  const leniencyErr: number[] = [];
  const scaleErr: number[] = [];
  const se: number[] = [];
  const loadMin: number[] = [];
  const loadMax: number[] = [];
  let winsVsRaw = 0;
  let winsVsZ = 0;
  let disconnected = 0;
  // Sums rather than per-seed means: a seed with no planted favourite would otherwise
  // contribute a mean of nothing, and the clean control is entirely made of those.
  let favourites = 0;
  let lift = 0;
  let intoTopTen = 0;
  let cheats = 0;
  let cheatsNamed = 0;
  let honest = 0;
  let honestNamed = 0;
  const honestZ: number[] = [];
  const plantedZ: number[] = [];

  for (let s = 0; s < seeds; s++) {
    const event = simulateEvent({ ...scenario.event, seed: `proof-${s}` });
    const truth = event.projects.map((p) => event.truth.get(p) as number);
    const against = (scores: Map<string, number>): number =>
      kendallTau(truth, event.projects.map((p) => scores.get(p) as number));

    const fitted = normalizeScores(event.rubric, event.ballots, scenario.normalize);
    const adjusted = new Map(fitted.projects.map((p) => [p.project, p.adjusted]));
    const tauNorm = against(adjusted);
    const tauRaw = against(rawMeanRanking(event.rubric, event.ballots));
    const tauZ = against(zScoreRanking(event.rubric, event.ballots));

    norm.push(tauNorm);
    raw.push(tauRaw);
    z.push(tauZ);
    if (tauNorm > tauRaw) winsVsRaw++;
    if (tauNorm > tauZ) winsVsZ++;

    const byJudge = new Map(fitted.judges.map((j) => [j.judge, j]));
    const active = event.judges.filter((j) => byJudge.has(j.id));
    // A flat judge has no planted leniency or scale to recover, so including
    // them would credit the fit for matching a constant.
    const real = active.filter((j) => !j.flat);
    if (real.length > 2) {
      const plantedLeniency = real.map((j) => j.leniency);
      // The offset the fit attributes to a judge is `leniency + leniencyPending`,
      // not `leniency` alone. The published `leniency` is deliberately one step
      // behind the final fit so that the ranking is reconstructible from printed
      // numbers, and the leftover rides in `leniencyPending`. Recovering against
      // the partial number would measure a parameter no consumer of this fit uses:
      // `reliability.ts` puts the sum in its expectation, and the closure identity
      // in `tests/normalize.test.ts` subtracts both terms.
      const fittedLeniency = real.map((j) => {
        const fit = byJudge.get(j.id) as { leniency: number; leniencyPending: number };
        return fit.leniency + fit.leniencyPending;
      });
      const plantedScale = real.map((j) => j.scale);
      const fittedScale = real.map((j) => byJudge.get(j.id)?.scale as number);
      leniency.push(correlation(plantedLeniency, fittedLeniency));
      scale.push(correlation(plantedScale, fittedScale));
      leniencyErr.push(rmse(plantedLeniency, fittedLeniency));
      scaleErr.push(rmse(plantedScale, fittedScale));
    }
    se.push(mean(fitted.projects.map((p) => p.standardError)));
    loadMin.push(event.loadMin);
    loadMax.push(event.loadMax);
    if (fitted.warnings.some((w) => w.includes("disconnected"))) disconnected++;

    if (scenario.strategic === true) {
      // Rank lift is measured against where the project belonged, not against a second
      // fit of the same event with the cheat removed. The counterfactual fit is the
      // tempting comparison and it is the wrong one: removing a judge changes the
      // design, and the difference would then be part scheme and part rebalancing.
      const truthOrder = [...event.projects].sort(
        (a, b) => (event.truth.get(b) as number) - (event.truth.get(a) as number),
      );
      const deserved = new Map(truthOrder.map((p, i) => [p, i + 1]));
      const placed = new Map(fitted.projects.map((p, i) => [p.project, i + 1]));
      const planted = new Set(
        event.judges
          .map((j) => j.favourite)
          .filter((p): p is string => p !== null && p !== undefined),
      );
      for (const project of planted) {
        favourites++;
        lift += (deserved.get(project) as number) - (placed.get(project) as number);
        if ((placed.get(project) as number) <= 10 && (deserved.get(project) as number) > 10) {
          intoTopTen++;
        }
      }

      // The calibration pass, given exactly what the organizer's page gives it. No
      // comparisons, because this sweep plants the scheme on the cards; the duel-side
      // machinery is measured in `docs/proof/pairwise.md` and mixing the two here would
      // leave it unclear which instrument found the judge.
      const assigned = new Map<string, number>();
      for (const a of event.design) assigned.set(a.judge, (assigned.get(a.judge) ?? 0) + 1);
      const submitted = new Map<string, number>();
      for (const b of event.ballots) submitted.set(b.judge, (submitted.get(b.judge) ?? 0) + 1);
      const reliability = panelReliability(event.rubric, event.ballots, fitted);
      const calibration = judgeCalibration({
        rubric: event.rubric,
        ballots: event.ballots,
        comparisons: [],
        workload: event.judges.map((j) => ({
          judge: j.id,
          assigned: assigned.get(j.id) ?? 0,
          submitted: submitted.get(j.id) ?? 0,
          drafts: 0,
          skipped: 0,
        })),
        rubricFit: fitted,
        pairwiseFit: null,
        reliability,
      });
      const named = new Set(
        calibration.judges.filter((r) => r.findings.includes(EXTREME)).map((r) => r.judge),
      );
      const worst = new Map(reliability.judges.map((j) => [j.judge, Math.abs(j.worstZ)]));
      for (const judge of event.judges) {
        const cheat = judge.favourite !== null && judge.favourite !== undefined;
        const z = worst.get(judge.id);
        if (cheat) cheats++;
        else honest++;
        // Flat judges have no residual worth reading — they mark everything a 3, so their
        // spread is the panel's view of the field rather than their own — but none of the
        // scenarios in this sweep plants one, so no exclusion is needed and pretending
        // otherwise would be dead code.
        if (z !== undefined) (cheat ? plantedZ : honestZ).push(z);
        if (!named.has(judge.id)) continue;
        if (cheat) cheatsNamed++;
        else honestNamed++;
      }
    }
  }

  return {
    sweep: scenario.sweep,
    label: scenario.label,
    seeds,
    tauRaw: round(mean(raw)),
    tauZ: round(mean(z)),
    tauNorm: round(mean(norm)),
    winsVsRaw,
    winsVsZ,
    leniencyR: leniency.length > 0 ? round(mean(leniency)) : Number.NaN,
    scaleR: scale.length > 0 ? round(mean(scale)) : Number.NaN,
    leniencyRmse: leniencyErr.length > 0 ? round(mean(leniencyErr)) : Number.NaN,
    scaleRmse: scaleErr.length > 0 ? round(mean(scaleErr)) : Number.NaN,
    standardError: round(mean(se)),
    tauNormWorst: round(Math.min(...norm)),
    loadMin: round(mean(loadMin), 1),
    loadMax: round(mean(loadMax), 1),
    disconnected,
    // `NaN` prints as an empty cell and reads as "not measured", which is the honest
    // entry for a scenario that planted nothing: a detection rate of zero out of zero
    // is not a zero.
    favourites: scenario.strategic === true ? favourites : Number.NaN,
    rankLift: favourites > 0 ? round(lift / favourites, 2) : Number.NaN,
    intoTopTen: scenario.strategic === true ? intoTopTen : Number.NaN,
    planted: scenario.strategic === true ? cheats : Number.NaN,
    namedShare: cheats > 0 ? round(cheatsNamed / cheats, 3) : Number.NaN,
    falseShare: honest > 0 ? round(honestNamed / honest, 4) : Number.NaN,
    honestMaxZ: honestZ.length > 0 ? round(Math.max(...honestZ), 2) : Number.NaN,
    plantedMedianZ: plantedZ.length > 0 ? round(median(plantedZ), 2) : Number.NaN,
  };
}

/**
 * The sweeps.
 *
 * `imbalance` is the one that matters, and it is first for that reason: it moves
 * the design from "the balanced scheduler decided who judges what" to "a
 * project's reviewers all come from one cohort of judges, and the cohorts differ
 * in harshness". Everything after it holds a design fixed and varies something
 * else, either to find where the method breaks or to show that a piece of it is
 * load-bearing rather than decorative.
 */
const SCENARIOS: Scenario[] = [
  ...[0, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95].map((imbalance) => ({
    sweep: "design imbalance",
    label: imbalance.toFixed(2),
    event: { ...BASE, imbalance },
  })),

  // How large the judge artefacts have to be before removing them pays.
  {
    sweep: "judge effects",
    label: "none (calibrated panel)",
    event: { ...BASE, imbalance: 0.5, leniencySd: 0, scaleSpread: 0 },
  },
  {
    sweep: "judge effects",
    label: "leniency only",
    event: { ...BASE, imbalance: 0.5, leniencySd: 0.6, scaleSpread: 0 },
  },
  {
    sweep: "judge effects",
    label: "scale only",
    event: { ...BASE, imbalance: 0.5, leniencySd: 0, scaleSpread: 0.4 },
  },
  {
    sweep: "judge effects",
    label: "both (the default)",
    event: { ...BASE, imbalance: 0.5 },
  },
  {
    sweep: "judge effects",
    label: "severe",
    event: { ...BASE, imbalance: 0.5, leniencySd: 1, scaleSpread: 0.7 },
  },

  // Which parts of the correction are doing the work.
  { sweep: "ablation", label: "full model", event: { ...BASE, imbalance: 0.5 } },
  {
    sweep: "ablation",
    label: "leniency only, scale pinned to 1",
    event: { ...BASE, imbalance: 0.5 },
    normalize: { scaleFloor: 1, scaleCeiling: 1 },
  },
  {
    sweep: "ablation",
    label: "inner backfit cut to 2 iterations",
    event: { ...BASE, imbalance: 0.5 },
    normalize: { backfitIterations: 2 },
  },
  {
    sweep: "ablation",
    label: "one backfit round",
    event: { ...BASE, imbalance: 0.5 },
    normalize: { rounds: 1 },
  },

  // Shrinkage crossed with how much evidence each judge actually supplies. A
  // single row cannot settle `kappa`: shrinkage is insurance, and insurance looks
  // like a waste of money in every year the house does not burn down.
  ...SHRINK_CONDITIONS.flatMap(({ condition, event }) =>
    KAPPAS.map((kappa) => ({
      sweep: "shrinkage",
      label: shrinkLabel(condition, kappa),
      event: { ...BASE, ...event },
      normalize: { kappa } as NormalizeOptions,
    })),
  ),
  {
    // The other defence against thin evidence: below `minBallotsForScale` a
    // judge's scale is not estimated at all. Dropping the guard to 1 asks the fit
    // to read a slope off a single ballot, in the design where that happens.
    sweep: "shrinkage",
    label: `${THINNEST} · scale from a single ballot`,
    event: { ...BASE, ...LAST_CONDITION.event },
    normalize: { minBallotsForScale: 1 },
  },

  // Where it holds up, and where it should not be trusted.
  { sweep: "robustness", label: "2 ballots per project", event: { ...BASE, imbalance: 0.5, reviewsPerProject: 2 } },
  { sweep: "robustness", label: "3 ballots per project", event: { ...BASE, imbalance: 0.5, reviewsPerProject: 3 } },
  { sweep: "robustness", label: "6 ballots per project", event: { ...BASE, imbalance: 0.5, reviewsPerProject: 6 } },
  { sweep: "robustness", label: "1 judge marks everything a 3", event: { ...BASE, imbalance: 0.5, flatJudges: 1 } },
  { sweep: "robustness", label: "3 judges mark everything a 3", event: { ...BASE, imbalance: 0.5, flatJudges: 3 } },
  { sweep: "robustness", label: "uneven judge workload", event: { ...BASE, imbalance: 0.5, activitySkew: 1 } },
  { sweep: "robustness", label: "24 projects, 6 judges", event: { ...BASE, imbalance: 0.5, projects: 24, judges: 6 } },
  { sweep: "robustness", label: "240 projects, 30 judges", event: { ...BASE, imbalance: 0.5, projects: 240, judges: 30 } },
  {
    // 24 judges over 3 tracks leaves 8 eligible per project for 4 slots, so the
    // cohort preference still has room to skew the design. With the base 12
    // judges every eligible judge would review every project in their track and
    // the design would be perfectly balanced within track by construction —
    // a row that measured nothing.
    sweep: "robustness",
    label: "three tracks, judges confined to one",
    event: { ...BASE, imbalance: 0.5, projects: 120, judges: 24, tracks: ["web", "ml", "hardware"] },
  },
  {
    sweep: "robustness",
    label: "continuous scores (no rounding)",
    event: { ...BASE, imbalance: 0.5, round: false },
  },

  // A judge who is dishonest rather than miscalibrated. Every other sweep above rests
  // on the assumption the whole method rests on — that a judge's error does not depend
  // on which project they are looking at — and this one breaks it deliberately, in the
  // shape a hackathon actually produces: a judge scoring a team they have a stake in.
  //
  // The control comes first and plants nothing, because a detection rate is only worth
  // reading beside the rate at which the same check fires on a panel with nothing to
  // find.
  {
    sweep: "strategic judges",
    label: "none (control)",
    event: { ...BASE, imbalance: 0.5 },
    strategic: true,
  },
  {
    sweep: "strategic judges",
    label: "1 judge, one project",
    event: { ...BASE, imbalance: 0.5, strategicJudges: 1, boost: PUSH, suppress: SUPPRESS },
    strategic: true,
  },
  {
    sweep: "strategic judges",
    label: "2 judges, different projects",
    event: { ...BASE, imbalance: 0.5, strategicJudges: 2, boost: PUSH, suppress: SUPPRESS },
    strategic: true,
  },
  {
    sweep: "strategic judges",
    label: "2 judges, same project",
    event: {
      ...BASE,
      imbalance: 0.5,
      strategicJudges: 2,
      collude: true,
      boost: PUSH,
      suppress: SUPPRESS,
    },
    strategic: true,
  },
  {
    sweep: "strategic judges",
    label: "3 judges, harder push",
    event: { ...BASE, imbalance: 0.5, strategicJudges: 3, boost: 2.5, suppress: 1 },
    strategic: true,
  },
  {
    // The two halves of the scheme work against each other, and this row is where that
    // shows. Marking everything else down makes the judge look harsh, the fit adds the
    // harshness back to every ballot they filed, and the favourite's ballot is then
    // further from the panel than the push alone would put it. A judge who only inflates
    // and never suppresses is the quieter cheat for exactly that reason, so the row has
    // to be here whatever it says.
    sweep: "strategic judges",
    label: "1 judge, no suppression",
    event: { ...BASE, imbalance: 0.5, strategicJudges: 1, boost: PUSH, suppress: 0 },
    strategic: true,
  },
  {
    // The floor. Half the push is still enough to move a project, and it is the row
    // that decides what the report is allowed to claim.
    sweep: "strategic judges",
    label: "1 judge, half the push",
    event: {
      ...BASE,
      imbalance: 0.5,
      strategicJudges: 1,
      boost: HALF_PUSH,
      suppress: HALF_SUPPRESS,
    },
    strategic: true,
  },
  {
    sweep: "strategic judges",
    label: "2 judges, same project, half the push",
    event: {
      ...BASE,
      imbalance: 0.5,
      strategicJudges: 2,
      collude: true,
      boost: HALF_PUSH,
      suppress: HALF_SUPPRESS,
    },
    strategic: true,
  },
];

const CSV_HEADER =
  "sweep,label,seeds,tau_raw,tau_z,tau_norm,tau_norm_worst," +
  "wins_vs_raw,wins_vs_z,leniency_r,scale_r,leniency_rmse,scale_rmse," +
  "standard_error,load_min,load_max,disconnected_seeds," +
  "favourites,rank_lift,into_top_ten,planted,named_share,false_share," +
  "honest_max_z,planted_median_z";

const csvCell = (x: number): string => (Number.isNaN(x) ? "" : String(x));

/** How many fields a row must have to be read. Derived, so adding a column cannot forget it. */
const CSV_WIDTH = CSV_HEADER.split(",").length;

function toCsv(rows: readonly Row[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.sweep,
        `"${r.label}"`,
        r.seeds,
        r.tauRaw,
        r.tauZ,
        r.tauNorm,
        r.tauNormWorst,
        r.winsVsRaw,
        r.winsVsZ,
        csvCell(r.leniencyR),
        csvCell(r.scaleR),
        csvCell(r.leniencyRmse),
        csvCell(r.scaleRmse),
        r.standardError,
        r.loadMin,
        r.loadMax,
        r.disconnected,
        csvCell(r.favourites),
        csvCell(r.rankLift),
        csvCell(r.intoTopTen),
        csvCell(r.planted),
        csvCell(r.namedShare),
        csvCell(r.falseShare),
        csvCell(r.honestMaxZ),
        csvCell(r.plantedMedianZ),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Split one line of the committed CSV into its fields, quotes removed.
 *
 * Written as a character scan because both of the shorter ways to do it are wrong here in
 * ways that pass on almost every row. `split(",")` cuts a quoted label in half — half the
 * strategic scenarios are named "2 judges, same project" and the like. Matching an
 * alternation globally and keeping the even-indexed matches, which is the trick this
 * function used to use, loses its alignment the moment two commas sit next to each other,
 * and two commas next to each other is exactly how this file writes a column a sweep did
 * not measure. Fifty-two rows round-tripped correctly and the one row with a gap in the
 * middle of its trailing columns silently read four neighbours out of position.
 */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (quoted) {
      if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text: string): Map<string, Row> {
  const out = new Map<string, Row>();
  const lines = text.trim().split("\n");
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line.trimEnd());
    // A row of the wrong width would otherwise parse into a Row full of plausible numbers
    // read one column out of position, and `drift` would report a moved measurement rather
    // than a broken file. Say which it is.
    if (cells.length !== CSV_WIDTH) {
      throw new Error(
        `docs/proof/normalization.csv: expected ${CSV_WIDTH} fields, found ${cells.length} ` +
          `in "${line.slice(0, 48)}…". Rerun \`npm run prove:normalization\`.`,
      );
    }
    const at = (i: number): string => cells[i] ?? "";
    const num = (i: number): number => (at(i) === "" ? Number.NaN : Number(at(i)));
    const row: Row = {
      sweep: at(0),
      label: at(1),
      seeds: num(2),
      tauRaw: num(3),
      tauZ: num(4),
      tauNorm: num(5),
      tauNormWorst: num(6),
      winsVsRaw: num(7),
      winsVsZ: num(8),
      leniencyR: num(9),
      scaleR: num(10),
      leniencyRmse: num(11),
      scaleRmse: num(12),
      standardError: num(13),
      loadMin: num(14),
      loadMax: num(15),
      disconnected: num(16),
      favourites: num(17),
      rankLift: num(18),
      intoTopTen: num(19),
      planted: num(20),
      namedShare: num(21),
      falseShare: num(22),
      honestMaxZ: num(23),
      plantedMedianZ: num(24),
    };
    out.set(`${row.sweep}|${row.label}`, row);
  }
  return out;
}

const fmt = (x: number, places = 3): string => (Number.isNaN(x) ? "—" : x.toFixed(places));

/**
 * Format a number that a sentence claims something is *within*, or *at most*.
 *
 * `fmt` rounds to nearest, which is right for a measurement and wrong for a bound: a
 * spread of 0.0504 prints as "0.050", and "the three methods sit within 0.050 of one
 * another" is then a sentence this report's own CSV contradicts in the fourth decimal.
 * The error is half a display unit and nobody would ever notice, which is exactly why it
 * is worth removing — the argument for this file is that its prose is derived from its
 * numbers, and a bound that rounds the wrong way is prose that rounds in its own favour.
 *
 * So bounds round away from zero and measurements keep `fmt`. That is the whole rule, and
 * it is the reason both functions exist: "is 0.050" wants nearest, "within 0.050" wants
 * this. The sign is preserved rather than assumed positive, because a bound on a quantity
 * that turned out negative ("-0.003 at best") wants the same conservative direction.
 *
 * The nearest rendering is read back and compared rather than the magnitude being scaled
 * and ceilinged, which is the obvious implementation and is wrong in the fourth decimal of
 * its own right: `8.165 * 1000` is `8164.999999999999`, so a scaled ceiling would round
 * some exact values up by a whole display unit. Asking whether the printed number still
 * covers the true one is both the honest question and the one floats answer correctly.
 */
const bound = (x: number, places = 3): string => {
  if (Number.isNaN(x)) return "—";
  const magnitude = Math.abs(x);
  const nearest = Number(magnitude.toFixed(places));
  const covered = nearest >= magnitude ? nearest : nearest + 10 ** -places;
  return (Math.sign(x) * covered).toFixed(places);
};

/**
 * Reflow the generated prose to a fixed width.
 *
 * The paragraphs above are assembled from measured numbers, so their line breaks
 * fall wherever a template literal happened to end — which renders fine and reads
 * badly in a diff. Since this file is committed, a reviewer sees the raw text, and
 * a paragraph whose wrapping shifts because one number gained a digit produces a
 * diff that hides the change it is supposed to show. Reflowing at a fixed width
 * makes the diff track the words.
 *
 * Tables, headings and indented code blocks are passed through untouched: a
 * wrapped table row is not a table row.
 */
function reflow(text: string, width = 88): string {
  const paragraphs = text.split(/\n{2,}/);
  const wrapped = paragraphs.map((para) => {
    const lines = para.split("\n");
    const verbatim = lines.some((l) => l.startsWith("|") || l.startsWith("    ") || l.startsWith("#"));
    if (verbatim) return lines.join("\n");
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    const out: string[] = [];
    let line = "";
    for (const word of words) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
    return out.join("\n");
  });
  return wrapped.join("\n\n");
}

function table(headers: readonly string[], rows: readonly string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function sweepTable(rows: readonly Row[], sweep: string, firstColumn: string): string {
  return table(
    [firstColumn, "raw mean", "per-judge z", "**fitted**", "worst seed", "beat raw", "beat z", "leniency r"],
    rows
      .filter((r) => r.sweep === sweep)
      .map((r) => [
        r.label,
        fmt(r.tauRaw),
        fmt(r.tauZ),
        `**${fmt(r.tauNorm)}**`,
        fmt(r.tauNormWorst),
        `${r.winsVsRaw}/${r.seeds}`,
        `${r.winsVsZ}/${r.seeds}`,
        fmt(r.leniencyR),
      ]),
  );
}

const pick = (rows: readonly Row[], sweep: string, label: string): Row =>
  rows.find((r) => r.sweep === sweep && r.label === label) as Row;

const strategic = (rows: readonly Row[], label: string): Row =>
  pick(rows, "strategic judges", label);

/**
 * One row per scheme, and deliberately not the same columns as the other sweeps.
 *
 * Tau is here because leaving it out would look like hiding it, but it is the least
 * informative number in the table and the prose says so. What an organizer needs to know
 * about a dishonest judge is how far the project moved and whether anything said so, so
 * those are the columns that carry weight: places gained by the pushed project, how often
 * it reached a prize position it did not deserve, how often the judge was named, and how
 * often the same check named somebody innocent.
 */
function strategicTable(rows: readonly Row[]): string {
  const pct = (x: number): string => (Number.isNaN(x) ? "—" : `${(100 * x).toFixed(0)}%`);
  return table(
    [
      "scheme",
      "fitted tau",
      "places gained",
      "into top 10",
      `named by \`${EXTREME}\``,
      "same check on honest judges",
    ],
    rows
      .filter((r) => r.sweep === "strategic judges")
      .map((r) => [
        r.label,
        fmt(r.tauNorm),
        Number.isNaN(r.rankLift) ? "—" : `**+${fmt(r.rankLift, 1)}**`,
        Number.isNaN(r.favourites) || r.favourites === 0
          ? "—"
          : `${fmt(r.intoTopTen, 0)}/${fmt(r.favourites, 0)}`,
        Number.isNaN(r.namedShare)
          ? "—"
          : `${pct(r.namedShare)} of ${fmt(r.planted, 0)}`,
        `${(100 * r.falseShare).toFixed(1)}%`,
      ]),
  );
}

const shrinkRow = (rows: readonly Row[], condition: string, kappa: number): Row =>
  pick(rows, "shrinkage", shrinkLabel(condition, kappa));

/**
 * One row per evidence condition, one column per `kappa`, reporting both the
 * ranking and the judge estimate. Two columns because the two disagree: ranking
 * tau prefers no shrinkage, and the error in the number printed beside a judge's
 * name prefers some. The load span is included because it is what `kappa` is
 * reacting to — a judge with four ballots has a slope estimated from four ballots.
 */
function shrinkageTable(rows: readonly Row[]): string {
  const at = KAPPAS.indexOf(DEFAULT_KAPPA);
  const head = (metric: string): string[] =>
    KAPPAS.map((k, i) => `${metric} k=${i === at ? `**${k}**` : k}`);
  const cell = (value: number, best: boolean, bold: boolean): string => {
    const body = bold ? `**${fmt(value)}**` : fmt(value);
    return best ? `${body} ◀` : body;
  };
  return table(
    ["evidence condition", "ballots/judge", ...head("tau"), ...head("scale error")],
    SHRINK_CONDITIONS.map(({ condition }) => {
      const cells = KAPPAS.map((k) => shrinkRow(rows, condition, k));
      const bestTau = Math.max(...cells.map((c) => c.tauNorm));
      const bestErr = Math.min(...cells.map((c) => c.scaleRmse));
      const span = cells[at] as Row;
      return [
        condition,
        `${fmt(span.loadMin, 0)}–${fmt(span.loadMax, 0)}`,
        ...cells.map((c, i) => cell(c.tauNorm, c.tauNorm === bestTau, i === at)),
        ...cells.map((c, i) => cell(c.scaleRmse, c.scaleRmse === bestErr, i === at)),
      ];
    }),
  );
}

/**
 * The shrinkage verdict, derived from the rows rather than asserted. An earlier
 * draft of this report claimed both kappa ablations were worse than the default
 * when the measured numbers said otherwise, which is exactly the failure a
 * generated report is supposed to make impossible. Every direction word below is
 * chosen by comparing numbers, so the paragraph cannot drift from the table.
 */
function shrinkageVerdict(rows: readonly Row[]): string {
  const tauCost = (condition: string): number =>
    shrinkRow(rows, condition, 0).tauNorm - shrinkRow(rows, condition, DEFAULT_KAPPA).tauNorm;
  const errGain = (condition: string): number =>
    shrinkRow(rows, condition, 0).scaleRmse - shrinkRow(rows, condition, DEFAULT_KAPPA).scaleRmse;

  const every = SHRINK_CONDITIONS.map((c) => c.condition);
  const errGains = every.map(errGain);
  const worstTauCost = Math.max(...every.map(tauCost));
  const bestErrGain = Math.max(...errGains);
  const errGainThin = errGain(THINNEST);
  const errWins = errGains.filter((d) => d > 0).length;
  const heavy = shrinkRow(rows, THINNEST, 64);
  const guard = pick(rows, "shrinkage", `${THINNEST} · scale from a single ballot`);
  const guarded = shrinkRow(rows, THINNEST, DEFAULT_KAPPA);
  const rejected = KAPPAS.filter((k) => k !== 0 && k !== DEFAULT_KAPPA);
  const rejectedWorst = rejected.map((k) => ({
    kappa: k,
    tau: Math.max(
      ...every.map((c) => shrinkRow(rows, c, DEFAULT_KAPPA).tauNorm - shrinkRow(rows, c, k).tauNorm),
    ),
  }));
  const firstRejected = rejectedWorst[0] as { kappa: number; tau: number };

  // A gap this small is noise across 20 seeds, so it is reported as a tie rather
  // than dressed up as a win in either direction. The band is stated in the prose
  // below so a reader can disagree with it against the table.
  const TIE = 0.005;
  const spread = every.map(tauCost);
  const bestTauCost = Math.min(...spread);
  const zeroAhead = spread.filter((d) => d > TIE).length;
  const defaultAhead = spread.filter((d) => d < -TIE).length;
  const tauTied = zeroAhead === 0 && defaultAhead === 0;

  const tauSentence = tauTied
    ? `On ranking tau the two are indistinguishable: across these ${every.length} conditions ` +
      `the largest gap either way is ${fmt(Math.max(worstTauCost, -bestTauCost), 4)}, under the ` +
      `${fmt(TIE)} this report treats as a tie. Tau is not what decides this knob.`
    : zeroAhead > 0 && defaultAhead === 0
      ? `On ranking tau, no shrinkage at all is ahead in ${zeroAhead} of ${every.length} ` +
        `conditions, by at most ${bound(worstTauCost)}. That is the finding, and it is not the ` +
        `one the knob was invented for.`
      : defaultAhead > 0 && zeroAhead === 0
        ? `On ranking tau the default is ahead in ${defaultAhead} of ${every.length} ` +
          `conditions and never behind by more than ${bound(worstTauCost)}.`
        : `On ranking tau the two split: no shrinkage is ahead in ${zeroAhead} of ` +
          `${every.length} conditions by at most ${bound(worstTauCost)}, the default in ` +
          `${defaultAhead} by at most ${bound(-bestTauCost)}. Neither margin is large.`;

  // The interesting asymmetry: shrinkage costs a little scale accuracy on panels
  // with enough ballots to fit a slope properly, and buys it back on the panels
  // that do not. Reporting only the win would be the same omission the tau
  // sentence above was written to avoid.
  const errSentence =
    bestErrGain > 0
      ? `On the error in the scale actually printed beside a judge's name it does something ` +
        `measurable, and the direction depends on how much evidence there is: shrinkage is ` +
        `worse on ${every.length - errWins} of ${every.length} conditions by up to ` +
        `${bound(-Math.min(...errGains))}, and better on ${errWins}${
          errGainThin === bestErrGain
            ? `: the thinnest panel here, by ${fmt(bestErrGain)}`
            : `, by up to ${bound(bestErrGain)} and by ${fmt(errGainThin)} on the thinnest panel`
        }. That is the trade in one line: give up a little accuracy where a slope can be ` +
        `fitted honestly from twenty ballots, to get it back where the same slope is being ` +
        `read off five.`
      : `The scale error does not favour shrinkage in any condition here (${bound(bestErrGain)} ` +
        `at best), which means the default is doing no measurable work.`;

  const verdict =
    bestErrGain > 0
      ? `The knob is therefore settled on the second measure, not the first: tau ` +
        `${tauTied ? `cannot tell the two apart` : `costs at most ${bound(worstTauCost)}`}, so the ` +
        `only thing \`kappa\` changes materially is the number printed next to a judge's name. ` +
        `Manak shrinks a little because those numbers are published rather than internal — a ` +
        `judge told they marked with 1.8× the panel's spread will ask why, and "five ballots ` +
        `and a slope" is not an answer — and because the panels where the slope is least ` +
        `trustworthy are the ones shrinkage helps. A reader who runs large, evenly loaded ` +
        `panels should set \`kappa: 0\`; the top rows of this table are the argument for it, ` +
        `and it stays a documented option rather than the setting nobody thought about.`
      : `The scale error does not favour shrinkage either, so on this evidence \`kappa\` is ` +
        `doing no measurable work and belongs at 0 until a condition is found where it does. ` +
        `The numbers, not the argument, decide the default; if this paragraph and the table ` +
        `ever disagree, the table is right and the tool refuses to publish.`;

  return `${shrinkageTable(rows)}

Shrinkage pulls each judge's fitted slope toward 1 by \`n / (n + kappa)\`, so at the
default of \`kappa=${DEFAULT_KAPPA}\` a judge with twenty ballots is trusted 0.91 and one
with two is trusted 0.5. ${tauSentence} ${errSentence}

${verdict}

The reason to read this table rather than take the default on faith is that \`kappa\` used
to be ${firstRejected.kappa}, and that column is still here because the harness is what
changed it: at ${firstRejected.kappa} the fit is ${
    firstRejected.tau > 0
      ? `behind the current default by up to ${bound(firstRejected.tau)} tau`
      : `no longer behind the current default, which this report's claim gate is set to catch`
  }. The cause is that the slope is *already* biased toward zero — \`theta\` is an estimate,
so the regressor carries error, and an errors-in-variables fit attenuates the slope before
any shrinkage is applied. Pulling it further toward 1 compounds that bias rather than
trading it for variance, which was the assumption the original default rested on and the
reason it did not survive being measured.

Both directions are bounded, which is why the trade is small enough to argue about at
all: the floor at 0.35 and the ceiling at 2.5 cap what any \`kappa\` can do to a single
judge, and heavy shrinkage (\`kappa=64\`) is ${
    heavy.tauNorm < guarded.tauNorm && heavy.scaleRmse > guarded.scaleRmse
      ? `worse than the default on both measures at once`
      : heavy.tauNorm < guarded.tauNorm
        ? `worse than the default on tau`
        : `no better than the default on tau`
  } (tau ${fmt(heavy.tauNorm)} against ${fmt(guarded.tauNorm)}, scale error
${fmt(heavy.scaleRmse)} against ${fmt(guarded.scaleRmse)}) — an estimate worth discounting
is not an estimate worth discarding. The neighbouring guard is the minimum ballot count
below which no scale is estimated at all: dropping it to 1 on the same thin, uneven
panel, whose judges file ${fmt(guarded.loadMin, 0)} to ${fmt(guarded.loadMax, 0)} ballots
each, gives tau ${fmt(guard.tauNorm)} and scale error ${fmt(guard.scaleRmse)}, against
${fmt(guarded.tauNorm)} and ${fmt(guarded.scaleRmse)} with the guard in place.`;
}

function headline(rows: readonly Row[]): string {
  const balanced = pick(rows, "design imbalance", "0.00");
  const mild = pick(rows, "design imbalance", "0.30");
  const strong = pick(rows, "design imbalance", "0.85");
  const gain = (r: Row): string => `+${fmt(r.tauNorm - r.tauRaw)}`;
  return [
    table(
      ["regime", "raw mean", "per-judge z", "**fitted judge effects**", "gain over raw", "beat raw on"],
      [
        ["balanced design", fmt(balanced.tauRaw), fmt(balanced.tauZ), `**${fmt(balanced.tauNorm)}**`, gain(balanced), `${balanced.winsVsRaw}/${balanced.seeds} seeds`],
        ["mildly correlated", fmt(mild.tauRaw), fmt(mild.tauZ), `**${fmt(mild.tauNorm)}**`, gain(mild), `${mild.winsVsRaw}/${mild.seeds} seeds`],
        ["strongly correlated", fmt(strong.tauRaw), fmt(strong.tauZ), `**${fmt(strong.tauNorm)}**`, gain(strong), `${strong.winsVsRaw}/${strong.seeds} seeds`],
      ],
    ),
    "",
    `Read the rows, not the average of them. As the design becomes correlated the raw ` +
      `mean falls from ${fmt(balanced.tauRaw)} to ${fmt(strong.tauRaw)} while the fitted ` +
      `ranking holds near ${fmt(strong.tauNorm)}: the useful property is not that ` +
      `normalization scores higher, it is that it is *insensitive to who happened to judge ` +
      `what*. On a balanced design there is nothing to remove, and the three methods sit ` +
      `within ${bound(
        Math.max(balanced.tauRaw, balanced.tauZ, balanced.tauNorm) -
          Math.min(balanced.tauRaw, balanced.tauZ, balanced.tauNorm),
      )} of one another. That is the row a sceptic should read first, and it is here rather ` +
      `than left out.`,
  ].join("\n");
}

function toMarkdown(rows: readonly Row[]): string {
  const balanced = pick(rows, "design imbalance", "0.00");
  const full = pick(rows, "ablation", "full model");
  const leniencyOnly = pick(rows, "ablation", "leniency only, scale pinned to 1");
  const oneRound = pick(rows, "ablation", "one backfit round");
  const shortBackfit = pick(rows, "ablation", "inner backfit cut to 2 iterations");
  const thin = pick(rows, "robustness", "2 ballots per project");
  const flat3 = pick(rows, "robustness", "3 judges mark everything a 3");
  const control = strategic(rows, "none (control)");
  const one = strategic(rows, "1 judge, one project");
  const apart = strategic(rows, "2 judges, different projects");
  const together = strategic(rows, "2 judges, same project");
  const harder = strategic(rows, "3 judges, harder push");
  const quiet = strategic(rows, "1 judge, no suppression");
  const half = strategic(rows, "1 judge, half the push");
  const halfTogether = strategic(rows, "2 judges, same project, half the push");
  const schemes = rows.filter((r) => r.sweep === "strategic judges");
  const tauSpread =
    Math.max(...schemes.map((r) => r.tauNorm)) - Math.min(...schemes.map((r) => r.tauNorm));
  const worstLift = Math.max(...schemes.map((r) => (Number.isNaN(r.rankLift) ? 0 : r.rankLift)));
  // Every judge on the control is honest, so its honest pool is the whole panel over
  // every seed. Derived rather than typed, because the panel size is `BASE`'s to decide.
  const honestOnControl = (BASE.judges ?? 12) * control.seeds;
  const parts: string[] = [];

  parts.push(`# Does normalization improve the ranking?

Generated by \`npm run prove:normalization\`. Every number here is derived from a
seed, so this file can be regenerated on any machine and checked against the
committed copy with \`npm run prove:normalization -- --check\`. Nothing in it was
typed by hand.

## The answer

${headline(rows)}

## How the question is made answerable

On a real event nobody knows the true ordering, so a ranking cannot be scored. So
a truth is planted instead: each project is given a quality drawn from a normal
distribution, each judge a leniency offset and a scale multiplier, and ballots are
generated through them. Three methods are then asked to recover an ordering none of
them was shown, and each is scored by **Kendall's tau** against the planted one —
+1 for a perfect match, 0 for a coin flip, −1 for exactly reversed.

The three methods are the raw mean of a project's scores, per-judge z-scoring
(standardise each judge's own scores before averaging, the usual quick fix), and
the engine's fitted model: \`y_ij = mu + theta_i + b_j\` with a per-judge scale,
fitted by weighted backfitting. Two details keep the exercise from being rigged.
Scores are **quantised to the integers a judge can actually click** and clamped at
the ends of the scale, so the generative process violates the model's continuity
assumption exactly the way real ballots do — and censoring at 1 and 5 hurts the
harshest and most generous judges most, which is where a naive fit would otherwise
look best. And assignment runs through the **real scheduler**, not a convenient
one.

Each configuration is run over ${balanced.seeds} seeds. Averages are reported
alongside the **worst single seed** and a **per-seed win count**, because an
organizer does not get to rerun their event twenty times; a method that wins on
average and loses on a third of seeds is not usable for awarding prizes.

The **leniency r** column is the correlation between each judge's planted offset and
the offset the fit attributes to them, which is \`leniency + leniencyPending\` rather
than \`leniency\` alone. The engine publishes those two separately on purpose — the
first is the offset the ranking was computed from, the second is the leftover the
final fit wanted and did not get, and keeping them apart is what makes the ranking
reconstructible from printed numbers. Their sum is the estimate, so the sum is what
gets scored here. Flat judges are excluded: they have no planted offset to recover,
and including them would credit the fit for matching a constant.`);

  parts.push(`## Sweep 1: how unbalanced the design is

This is the knob that decides whether normalization matters. At 0 the balanced
scheduler decides who judges what, so every project's mean is contaminated by
roughly the same average judge and the contamination cancels. As it rises, a
project's reviewers are increasingly drawn from a single cohort of judges — and
cohorts are formed by sorting judges on leniency, so cohort membership is
correlated with harshness. That is the real pathology: judges drop out, a track's
specialists are systematically harder markers than the generalists, late
submissions are seen by whoever is still awake. Planted project quality stays
independent of the cohorts, so any recovered accuracy is signal rather than an
artefact of the setup.

${sweepTable(rows, "design imbalance", "imbalance")}

## Sweep 2: how large the judge artefacts are

${sweepTable(rows, "judge effects", "judge effects")}

With a perfectly calibrated panel there is nothing to correct, and the row shows
what a correction with nothing to correct costs — which is the number that matters
for deciding whether to leave it switched on by default.

## Sweep 3: which parts of the model earn their place

${sweepTable(rows, "ablation", "variant")}

Pinning every judge's scale to 1 and correcting leniency alone reaches
${fmt(leniencyOnly.tauNorm)} against ${fmt(full.tauNorm)} for the full model, so
the scale machinery is worth roughly
${fmt(full.tauNorm - leniencyOnly.tauNorm)} tau — small, but consistent, and it is
also what keeps a judge who marks everything a 3 from being taken at face value.

${
    full.tauNorm - oneRound.tauNorm < 0.01
      ? `The outer loop earns the least of the three. One round instead of ` +
        `${DEFAULT_ROUNDS} reaches ${fmt(oneRound.tauNorm)} against ` +
        `${fmt(full.tauNorm)}, a gap of ${fmt(full.tauNorm - oneRound.tauNorm)}. The ` +
        `reason it is this small is that the engine ends with one additive fit at the ` +
        `latest scales, so even a single round has its scale estimate applied to the ` +
        `ranking rather than only to the round that never comes. ${DEFAULT_ROUNDS} is ` +
        `kept because the gap is in the same direction on every design measured here ` +
        `and the bounded work closes parameter disagreement, not because this accuracy gap is large. A knob ` +
        `whose ablation is nearly free is worth saying so about.`
      : `The outer loop earns its place: one round instead of ${DEFAULT_ROUNDS} reaches ` +
        `${fmt(oneRound.tauNorm)} against ${fmt(full.tauNorm)}, because the scale ` +
        `estimate is a slope against a \`theta\` the first round has only roughly ` +
        `located, and re-fitting the additive part against a corrected scale is what ` +
        `closes the gap.`
  }

${
    Math.abs(full.tauNorm - shortBackfit.tauNorm) < 0.002
      ? `The inner loop is not load-bearing at all: cutting it from ${DEFAULT_BACKFIT} ` +
        `passes to 2 changes ` +
        `the result by ${fmt(Math.abs(full.tauNorm - shortBackfit.tauNorm))}, which is to ` +
        `say not at all. Weighted backfitting on a two-factor model converges in a handful ` +
        `of passes, and the generous default is a cheap guard for a badly conditioned ` +
        `design rather than something the ordinary case needs. Reporting that is more ` +
        `useful than implying every knob here is load-bearing.`
      : `Cutting the inner loop from ${DEFAULT_BACKFIT} passes to 2 reaches ` +
        `${fmt(shortBackfit.tauNorm)}, so the convergence tolerance is doing real work too.`
  }

## Sweep 4: how far to trust one judge's slope

${shrinkageVerdict(rows)}

## Sweep 5: where it holds, and where it should not be trusted

${sweepTable(rows, "robustness", "condition")}

The thin-evidence row is the honest warning: at ${thin.label.replace(" per project", "")}
the fitted ranking reaches only ${fmt(thin.tauNorm)}, and its worst seed
${fmt(thin.tauNormWorst)}. No amount of modelling recovers an ordering that the
ballots do not contain, and the engine reports a standard error of
${fmt(thin.standardError)} rubric points per project so that an organizer can see
that for themselves rather than being told a rank they should not rely on. With
three of twelve judges marking everything a 3, the fitted ranking still reaches
${fmt(flat3.tauNorm)}: those judges' information weight collapses, their leniency
term still absorbs their offset, and each of them is named in the report.`);

  parts.push(`## Sweep 6: a judge who is dishonest rather than miscalibrated

Every sweep above rests on the assumption the whole method rests on: that a judge's
error does not depend on which project they are looking at. Leniency, scale and noise
are properties of the judge, which is what makes them estimable from that judge's other
ballots and removable from this one. A judge scoring a team they have a stake in breaks
that assumption deliberately, and no amount of fitting removes an effect the model has
no term for. So this sweep does not ask whether the correction survives a dishonest
judge. It asks how far one gets, and whether anything says so.

The scheme is the one a hackathon actually produces. A strategic judge marks their
favourite ${PUSH} points higher on every criterion and everything else they were
assigned ${SUPPRESS} points lower, applied in rubric points after their own scale —
they are choosing a mark, not misperceiving a project — and the result is quantised and
clamped like any other ballot. \`2 judges, same project\` is the colluding pair: two
judges pushing one project, which plants one favourite per seed where two independent
judges plant two. Rank lift is measured against where the project belonged, not against
a second fit with the cheat removed, because removing a judge changes the design and the
difference would then be part scheme and part rebalancing.

${strategicTable(rows)}

**Tau barely notices, and that is a fact about tau.** Across every scheme here the
fitted ranking moves within ${bound(tauSpread)} — from ${fmt(control.tauNorm)} on the
control to ${fmt(harder.tauNorm)} at the hardest push — while a pushed project gains as
many as ${fmt(worstLift, 1)} places and reaches the top ten from outside it in
${fmt(together.intoTopTen, 0)} of ${fmt(together.favourites, 0)} attempts. A metric that
counts every swap in a field of ${BASE.projects ?? 60} equally is nearly silent about a
scheme aimed at one project, because a scheme aimed at one project changes very few
swaps. Every other sweep in this report is scored on tau; this one is the reason the
report does not stop there.

**A pair working together does more damage than twice one judge, and is harder to
catch.** Two judges pushing different projects lift each by ${fmt(apart.rankLift, 1)}
places — less than the ${fmt(one.rankLift, 1)} a single judge manages, because each of
them is marking the other's candidate down. The same two judges pushing the *same*
project lift it ${fmt(together.rankLift, 1)} places, and it is the only configuration
that reaches a prize position it did not earn. Detection moves the opposite way:
${(100 * apart.namedShare).toFixed(0)}% of the independent cheats are named against
${(100 * together.namedShare).toFixed(0)}% of the colluding ones, at an identical push.
The mechanism is the fit doing its job — two high ballots on one project raise that
project's estimate, so each of the two ballots sits closer to it, while two cheats
working apart each push the other's estimate down and strand their own ballot further
above it.

**Suppressing the field is what gives the cheat away.** Marking the other nineteen
projects down makes the judge look harsh; the fit reads that as leniency and adds it
back to every ballot they filed, including the inflated one, which lands the favourite's
ballot further from the panel than the push alone would put it. Dropping the suppression
costs the cheat ${fmt(one.rankLift - quiet.rankLift, 1)} places of lift
(${fmt(quiet.rankLift, 1)} against ${fmt(one.rankLift, 1)}) and cuts the chance of being
named from ${(100 * one.namedShare).toFixed(0)}% to
${(100 * quiet.namedShare).toFixed(0)}%. Both halves of the scheme cannot be maximised
at once, and that is a property of the estimator rather than a rule anyone imposed.

**The check names the loud cheat and misses the quiet one.** At the default push
\`judge.extremeBallot\` names between
${(100 * Math.min(one.namedShare, together.namedShare)).toFixed(0)}% and
${(100 * harder.namedShare).toFixed(0)}% of the judges who cheated, against
${(100 * control.falseShare).toFixed(1)}% of the ${honestOnControl} honest judges on the
control. At half the push it names ${(100 * half.namedShare).toFixed(0)}% of a single
cheat and ${(100 * halfTogether.namedShare).toFixed(0)}% of a colluding pair — and half
the push still moves a project ${fmt(half.rankLift, 1)} to
${fmt(halfTogether.rankLift, 1)} places. That is the floor of what this check reaches, it
is published here rather than left for someone to find, and it is the reason the finding
is worded as a question to ask a judge rather than a verdict about one.

The threshold behind it is ${EXTREME_Z} times the panel's residual spread on a single
ballot, and the two numbers either side of it are what make it defensible rather than
chosen. On the control, where every judge is honest, the furthest any single ballot
landed from the fit was ${fmt(control.honestMaxZ, 2)}. With the default push the planted
judges' median is ${fmt(one.plantedMedianZ, 2)} — the push, plus the offset the fit adds
back once the judge's marking-down makes them look harsh, in units of the panel's own
residual spread. ${EXTREME_Z} sits in the gap between those two, and it is in this report
rather than in a comment because a threshold picked from a measurement is only as good as
the measurement staying reproducible.

**Almost nobody innocent is named, and the exception is instructive.** The highest
false-positive rate in the sweep is ${(100 * together.falseShare).toFixed(1)}%, on the
colluding row. A pair inflating one project pulls that project's estimate up, so an
honest judge who reviewed it and scored it accurately is now the one disagreeing with
the panel. Collusion does not only hide itself; it makes an honest reviewer of the same
project look like the outlier. Nothing in the engine repairs that, and an organizer
reading a flagged judge should read the project's other ballots before drawing a
conclusion about the judge.`);

  parts.push(`## The boundary of the claim

Five things this proof does **not** show.

**It measures detection, not repair.** Sweep 6 plants dishonest judges and reports how
far they get and how often something says so. Manak does not claim to remove a strategic
judge's influence from the ranking, and the numbers in that sweep are not an argument
that it does: the fitted ranking still carries a ${fmt(together.rankLift, 1)}-place lift
on the colluding row after every correction in the engine has run. Removing it would mean
discounting or dropping a judge's ballots on a statistical suspicion, which is a decision
about a person and belongs to the organizer, with the evidence in front of them. What the
engine owes them is the evidence, in time to act on it — which is why the check runs
before publish and reads as a question rather than a verdict.

**On a balanced design, per-judge z-scoring is competitive and sometimes better.**
At imbalance 0 it reaches ${fmt(balanced.tauZ)} against the fitted
${fmt(balanced.tauNorm)}. That is within noise, and it is reported rather than
buried. The reason to prefer the fitted model anyway is not the third decimal of
tau: z-scoring cannot produce a leniency estimate, a scale estimate, a standard
error, or a named diagnostic, so it can tell an organizer *what* the ranking is but
never *why* a project moved or *which judge* to add a review from. Where the two
disagree by less than their own uncertainty, either is defensible; only one of them
can be explained to a team that came fourth.

**The scale estimate is attenuated.** It is a slope against \`theta\`, which is
itself estimated, so the classic errors-in-variables bias applies and the measured
attenuation is around −0.08. Shrinkage toward 1 and the floor at 0.35 both push in
the same direction, which makes the correction *conservative* — it under-corrects
rather than over-corrects — but it does mean a strongly discriminating judge is
modelled as slightly less discriminating than they are.

**Inverse-variance weighting was tried and rejected.** Weighting each judge by the
inverse of their residual variance closes roughly 0.02 tau in the regime that
matters least. It also hands enormous weight to a judge who marks everything a 3,
because their residual variance is near zero — precisely inverting the defence the
design depends on. It is not in the engine, and this is why.

**Kendall's tau is the wrong metric for prize-giving.** It weights a swap in the
middle of the field the same as a swap at the top, and nobody awards a prize for
27th place. Tau is used here because it is the standard, comparable measure and
because it is what a sceptic will ask for; the top-k overlap in the agreement
report is the number an organizer should actually read on the night.

## Reproducing this

    npm run prove:normalization           # regenerate this file and the CSV
    npm run prove:normalization -- --check # re-run and verify the committed numbers

\`--check\` compares numerically, with a tolerance of ${TOLERANCE}, rather than byte
for byte. The simulator calls \`Math.exp\` and \`Math.log\`, which are not
bit-identical across platforms and libm versions, so byte comparison would fail for
reasons that have nothing to do with the engine. The per-configuration numbers live
in \`normalization.csv\` next to this file, one row per configuration, for anyone
who would rather plot them than read them.`);

  return `${reflow(parts.join("\n\n"))}\n`;
}

/**
 * The claims the report is allowed to make, asserted independently of the
 * committed numbers. A drift check catches a change; these catch a regression
 * that happens to land inside the tolerance of every individual row.
 */
function claims(rows: readonly Row[]): string[] {
  const failures: string[] = [];
  const correlated = rows.filter(
    (r) => r.sweep === "design imbalance" && Number(r.label) >= 0.3,
  );
  for (const r of correlated) {
    if (r.winsVsRaw < r.seeds) {
      failures.push(
        `imbalance ${r.label}: the fitted ranking beat the raw mean on only ` +
          `${r.winsVsRaw}/${r.seeds} seeds, and the report claims every seed.`,
      );
    }
    if (r.tauNorm - r.tauRaw < 0.05) {
      failures.push(
        `imbalance ${r.label}: gain over raw is only ${fmt(r.tauNorm - r.tauRaw)}, ` +
          `below the 0.05 the report claims.`,
      );
    }
    if (r.leniencyR < 0.9) {
      failures.push(`imbalance ${r.label}: leniency recovery fell to ${fmt(r.leniencyR)}.`);
    }
  }
  const balanced = pick(rows, "design imbalance", "0.00");
  if (balanced.tauNorm < balanced.tauRaw - 0.03) {
    failures.push(
      `on a balanced design the correction lost ${fmt(balanced.tauRaw - balanced.tauNorm)} tau; ` +
        `a correction with nothing to correct must not do damage.`,
    );
  }
  for (const r of rows) {
    if (r.tauNorm < 0.4) {
      failures.push(`${r.sweep} / ${r.label}: tau collapsed to ${fmt(r.tauNorm)}.`);
    }
  }
  // The shrinkage default has to be defensible against both of its neighbours in
  // every evidence condition, not on average. Tau alone is not the test: the
  // report defends `kappa` on the accuracy of the published per-judge estimate,
  // so the claim is that the default is never badly beaten on tau *and* that it
  // buys something measurable on scale error where the evidence is thinnest.
  for (const { condition } of SHRINK_CONDITIONS) {
    const here = shrinkRow(rows, condition, DEFAULT_KAPPA).tauNorm;
    for (const kappa of KAPPAS) {
      if (kappa === DEFAULT_KAPPA) continue;
      const other = shrinkRow(rows, condition, kappa).tauNorm;
      if (other - here > 0.02) {
        failures.push(
          `shrinkage / ${condition}: kappa=${kappa} reaches tau ${fmt(other)} against the ` +
            `default's ${fmt(here)}. Change the default or widen the tolerance on purpose; ` +
            `do not ship a setting the sweep beats by ${fmt(other - here)}.`,
        );
      }
    }
  }
  const shrunk = shrinkRow(rows, THINNEST, DEFAULT_KAPPA);
  const unshrunk = shrinkRow(rows, THINNEST, 0);
  if (shrunk.scaleRmse >= unshrunk.scaleRmse && shrunk.tauNorm <= unshrunk.tauNorm) {
    failures.push(
      `shrinkage / ${THINNEST}: the default loses on tau (${fmt(shrunk.tauNorm)} against ` +
        `${fmt(unshrunk.tauNorm)}) and on scale error (${fmt(shrunk.scaleRmse)} against ` +
        `${fmt(unshrunk.scaleRmse)}). It is then indefensible on the ground the report ` +
        `defends it on; set kappa to 0 rather than publishing an argument for it.`,
    );
  }
  // The report tells the story of a default that changed, and names the setting it
  // changed from. If that setting stops being behind, the story is stale even
  // though every individual number still reproduces.
  const wasDefault = 8;
  if (KAPPAS.includes(wasDefault)) {
    const behind = SHRINK_CONDITIONS.map(
      ({ condition }) =>
        shrinkRow(rows, condition, DEFAULT_KAPPA).tauNorm - shrinkRow(rows, condition, wasDefault).tauNorm,
    );
    if (Math.max(...behind) <= 0) {
      failures.push(
        `shrinkage: the report says kappa=${wasDefault} was rejected because it trails the ` +
          `current default, but it now leads or ties in every condition (best margin ` +
          `${fmt(Math.max(...behind))}). Rewrite that paragraph or reconsider the default.`,
      );
    }
  }
  // A sweep that varies workload has to actually vary it, or the row measures the
  // base design under a misleading label.
  if (shrunk.loadMax - shrunk.loadMin < 4) {
    failures.push(
      `shrinkage / ${THINNEST}: judge load spans only ${fmt(shrunk.loadMin, 1)}–` +
        `${fmt(shrunk.loadMax, 1)} ballots, so the condition is not uneven and the label lies.`,
    );
  }
  // The tracks row exists to show the engine refusing to guess, so the warning
  // has to be there. A silent disconnected design is the failure mode.
  const tracked = pick(rows, "robustness", "three tracks, judges confined to one");
  if (tracked.disconnected < tracked.seeds) {
    failures.push(
      `robustness / three tracks: the design split warning fired on only ` +
        `${tracked.disconnected}/${tracked.seeds} seeds. Either the judges are not ` +
        `confined to their track or the connectivity check has stopped working.`,
    );
  }
  failures.push(...strategicClaims(rows));
  return failures;
}

/**
 * Sweep 6's claims, which are the ones most able to go quietly wrong.
 *
 * Every other sweep in this file claims a method is *better* than an alternative, and a
 * regression there shows up as a number moving. This sweep claims a detector reaches some
 * cheats and misses others, and both halves of that can rot without any single number
 * leaving its tolerance: raise the threshold and the misses become the rule while the
 * report still calls them the floor; lower it and the report's honest false-positive
 * figure becomes a lie. So the gates below are written as the sentences the report is
 * allowed to say, and each one names the paragraph it protects.
 */
function strategicClaims(rows: readonly Row[]): string[] {
  const failures: string[] = [];
  const schemes = rows.filter((r) => r.sweep === "strategic judges");
  if (schemes.length === 0) return failures;
  const control = strategic(rows, "none (control)");
  const one = strategic(rows, "1 judge, one project");
  const apart = strategic(rows, "2 judges, different projects");
  const together = strategic(rows, "2 judges, same project");
  const harder = strategic(rows, "3 judges, harder push");
  const quiet = strategic(rows, "1 judge, no suppression");
  const half = strategic(rows, "1 judge, half the push");
  const halfTogether = strategic(rows, "2 judges, same project, half the push");

  // "Almost nobody innocent is named." A check an organizer is asked to act on before
  // publishing has to be quiet on a panel with nothing to find, and 2% of a twelve-judge
  // panel is already a coin flip on whether one honest judge is questioned.
  for (const r of schemes) {
    if (r.falseShare > 0.02) {
      failures.push(
        `strategic / ${r.label}: ${EXTREME} named ${(100 * r.falseShare).toFixed(1)}% of the ` +
          `honest judges, above the 2% the report calls almost nobody. Raise \`extremeZ\` or ` +
          `rewrite that paragraph.`,
      );
    }
  }
  if (control.falseShare > 0.01) {
    failures.push(
      `strategic / control: ${EXTREME} named ${(100 * control.falseShare).toFixed(1)}% of an ` +
        `entirely honest panel. The report quotes this figure as the price of the check and ` +
        `1% is the most it can be quoted at.`,
    );
  }
  // "The check names the loud cheat." Half of them, at the push the sweep calls default.
  for (const r of [one, apart, together]) {
    if (r.namedShare < 0.5) {
      failures.push(
        `strategic / ${r.label}: only ${(100 * r.namedShare).toFixed(0)}% of the planted ` +
          `judges were named, and the report claims at least half at the default push.`,
      );
    }
  }
  if (harder.namedShare < 0.6) {
    failures.push(
      `strategic / ${harder.label}: ${(100 * harder.namedShare).toFixed(0)}% named. The ` +
        `hardest push in the sweep is the row the report leans on; below 60% it cannot.`,
    );
  }
  // "...and misses the quiet one." The published limit. If the check starts reaching the
  // half-push rows the limitation paragraph is stale, which is a better problem to have
  // and still a problem: the report would be admitting a weakness it no longer has.
  for (const r of [half, halfTogether]) {
    if (r.namedShare > 0.4) {
      failures.push(
        `strategic / ${r.label}: ${(100 * r.namedShare).toFixed(0)}% named, so the check now ` +
          `reaches the push the report publishes as its floor. Rewrite the paragraph that ` +
          `says it misses this one — the sweep has outgrown it.`,
      );
    }
    if (r.rankLift < 2) {
      failures.push(
        `strategic / ${r.label}: the half push only moved the project ${fmt(r.rankLift, 1)} ` +
          `places, so it is no longer a cheat worth catching and the floor it establishes ` +
          `is not interesting.`,
      );
    }
  }
  // "A pair working together does more damage than twice one judge, and is harder to
  // catch." Two rows, one push, opposite directions — the best pair of numbers in the
  // sweep and the easiest to lose to a change in the simulator.
  if (together.rankLift <= apart.rankLift) {
    failures.push(
      `strategic: the colluding pair lifted its project ${fmt(together.rankLift, 1)} places ` +
        `against ${fmt(apart.rankLift, 1)} for two independent cheats, so collusion is no ` +
        `longer the worse case the report says it is.`,
    );
  }
  if (together.namedShare >= apart.namedShare) {
    failures.push(
      `strategic: the colluding pair was named ${(100 * together.namedShare).toFixed(0)}% of ` +
        `the time against ${(100 * apart.namedShare).toFixed(0)}% for two independent cheats, ` +
        `so collusion is no longer harder to catch and that paragraph is wrong.`,
    );
  }
  if (together.favourites >= apart.favourites) {
    failures.push(
      `strategic: the colluding pair planted ${fmt(together.favourites, 0)} favourites and ` +
        `the independent pair ${fmt(apart.favourites, 0)}. Colluding judges are supposed to ` +
        `share one project; if the counts match, \`collude\` has stopped meaning anything.`,
    );
  }
  // "Suppressing the field is what gives the cheat away." Both halves, because the
  // sentence claims a trade-off and a trade-off needs two directions.
  if (quiet.namedShare >= one.namedShare) {
    failures.push(
      `strategic: dropping the suppression did not make the cheat quieter ` +
        `(${(100 * quiet.namedShare).toFixed(0)}% named against ` +
        `${(100 * one.namedShare).toFixed(0)}%), so the trade-off paragraph is wrong.`,
    );
  }
  if (quiet.rankLift >= one.rankLift) {
    failures.push(
      `strategic: dropping the suppression did not cost the cheat any lift ` +
        `(${fmt(quiet.rankLift, 1)} places against ${fmt(one.rankLift, 1)}), so there is no ` +
        `trade-off to describe.`,
    );
  }
  // "Tau barely notices, and that is a fact about tau." The claim that justifies the whole
  // sweep reporting different columns from the other five.
  const taus = schemes.map((r) => r.tauNorm);
  const spread = Math.max(...taus) - Math.min(...taus);
  const lift = Math.max(...schemes.map((r) => (Number.isNaN(r.rankLift) ? 0 : r.rankLift)));
  if (spread > 0.08) {
    failures.push(
      `strategic: tau moved ${fmt(spread)} across the sweep, which is enough that an ` +
        `organizer watching tau would notice a strategic judge. The report says they would ` +
        `not, and that is the reason it reports rank lift instead.`,
    );
  }
  if (lift < 5) {
    failures.push(
      `strategic: the best a planted cheat managed was ${fmt(lift, 1)} places, so the sweep ` +
        `is no longer demonstrating that a strategic judge can move a ranking at all.`,
    );
  }
  // The threshold's own justification: the honest maximum below it, the planted median
  // above it. `calibration.ts` cites this report for exactly these two numbers.
  if (control.honestMaxZ >= EXTREME_Z) {
    failures.push(
      `strategic / control: an honest judge's worst ballot reached ` +
        `${fmt(control.honestMaxZ, 2)} standardised residuals, at or past the ${EXTREME_Z} ` +
        `\`extremeZ\` fires at. The threshold is no longer above what honest variation ` +
        `reaches, and the comment in calibration.ts that says so is stale.`,
    );
  }
  if (one.plantedMedianZ <= EXTREME_Z) {
    failures.push(
      `strategic / ${one.label}: the planted judges' median worst ballot is ` +
        `${fmt(one.plantedMedianZ, 2)}, at or below the ${EXTREME_Z} threshold, so the ` +
        `typical cheat is now below the line rather than above it.`,
    );
  }
  return failures;
}

const METRICS: readonly (keyof Row)[] = [
  "tauRaw",
  "tauZ",
  "tauNorm",
  "tauNormWorst",
  "winsVsRaw",
  "winsVsZ",
  "leniencyR",
  "scaleR",
  "leniencyRmse",
  "scaleRmse",
  "standardError",
  "loadMin",
  "loadMax",
  "disconnected",
  "favourites",
  "rankLift",
  "intoTopTen",
  "planted",
  "namedShare",
  "falseShare",
  "honestMaxZ",
  "plantedMedianZ",
];

function drift(fresh: readonly Row[], committed: Map<string, Row>): string[] {
  const problems: string[] = [];
  for (const row of fresh) {
    const key = `${row.sweep}|${row.label}`;
    const old = committed.get(key);
    if (!old) {
      problems.push(`${key}: not in the committed CSV. Regenerate it.`);
      continue;
    }
    for (const metric of METRICS) {
      const a = row[metric] as number;
      const b = old[metric] as number;
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      // Win counts and ballot counts are integers, not tau: a tolerance in tau
      // units would let a method quietly lose several seeds, or a design quietly
      // reshape itself, so counts are compared as counts.
      const counted =
        metric === "winsVsRaw" ||
        metric === "winsVsZ" ||
        metric === "loadMin" ||
        metric === "loadMax" ||
        metric === "disconnected" ||
        metric === "favourites" ||
        metric === "intoTopTen" ||
        metric === "planted";
      // Rank lift is in places, where a hundredth of a place is not a difference worth
      // a failing check and a whole place is. The two residual extremes are a maximum and
      // a median over a few hundred judges, so they can step to a neighbouring value when
      // libm rounds differently; a quarter of a standardised residual is far inside the gap
      // they are quoted to establish. The detection shares stay on `TOLERANCE`, which on
      // twenty to sixty planted judges is between one and two judges.
      const limit = counted
        ? 1
        : metric === "rankLift"
          ? 0.5
          : metric === "honestMaxZ" || metric === "plantedMedianZ"
            ? 0.25
            : TOLERANCE;
      if (!(Math.abs(a - b) <= limit)) {
        problems.push(`${key}: ${metric} moved from ${fmt(b)} to ${fmt(a)} (limit ${limit}).`);
      }
    }
  }
  for (const key of committed.keys()) {
    if (!fresh.some((r) => `${r.sweep}|${r.label}` === key)) {
      problems.push(`${key}: in the committed CSV but no longer measured.`);
    }
  }
  return problems;
}

const checking = process.argv.slice(2).includes("--check");
const started = Date.now();

const rows: Row[] = [];
for (const scenario of SCENARIOS) {
  rows.push(measure(scenario));
  if (!checking) {
    const r = rows[rows.length - 1] as Row;
    process.stdout.write(
      `  ${r.sweep.padEnd(18)} ${r.label.padEnd(34)} ` +
        `raw ${fmt(r.tauRaw)}  z ${fmt(r.tauZ)}  fitted ${fmt(r.tauNorm)}  ` +
        `(${r.winsVsRaw}/${r.seeds} vs raw)` +
        (Number.isNaN(r.planted)
          ? ""
          : `  lift ${fmt(r.rankLift, 1)}  top10 ${fmt(r.intoTopTen, 0)}  ` +
            `named ${fmt(100 * r.namedShare, 0)}% of ${fmt(r.planted, 0)}  ` +
            `false ${fmt(100 * r.falseShare, 1)}%`) +
        `\n`,
    );
  }
}

const broken = claims(rows);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (checking) {
  const problems = [...drift(rows, parseCsv(readFileSync(OUT_CSV, "utf8"))), ...broken];
  if (problems.length > 0) {
    process.stdout.write(`prove:normalization FAILED (${problems.length} problem(s))\n`);
    for (const p of problems) process.stdout.write(`  - ${p}\n`);
    process.stdout.write(
      `\nIf the engine changed on purpose, rerun \`npm run prove:normalization\` and ` +
        `commit the new docs/proof/ files with the reason in the message.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `prove:normalization OK — ${rows.length} configurations, ` +
      `${rows.reduce((n, r) => n + r.seeds, 0)} simulated events, ` +
      `every committed number reproduced within ${TOLERANCE}, in ${elapsed}s.\n`,
  );
} else {
  if (broken.length > 0) {
    process.stdout.write(`\nThe report's own claims no longer hold:\n`);
    for (const p of broken) process.stdout.write(`  - ${p}\n`);
    process.stdout.write(`\nRefusing to write a report that overstates the result.\n`);
    process.exit(1);
  }
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_CSV, toCsv(rows), "utf8");
  writeFileSync(OUT_MD, toMarkdown(rows).replaceAll(" — ", ", ").replaceAll("—", "-"), "utf8");
  const spread = mean(rows.map((r) => r.tauNorm - r.tauRaw));
  process.stdout.write(
    `\nWrote docs/proof/normalization.md and normalization.csv — ` +
      `${rows.length} configurations, ${rows.reduce((n, r) => n + r.seeds, 0)} events, ` +
      `mean gain over the raw mean ${fmt(spread)}, in ${elapsed}s.\n`,
  );
}
