/**
 * Whether the panel is ready to be published, judge by judge.
 *
 * Every other pass in this engine reads the panel as one instrument and asks how much the
 * ranking can carry. This one reads the instrument's parts. It is the pass an organizer wants
 * at the moment before publishing, when the question is not "how wide are the intervals" but
 * "is there a judge here whose ballots I should look at before I stand behind this".
 *
 * The audience is the organizer and only the organizer. A leniency estimate published next to a
 * volunteer's name is an appraisal nobody consented to, and a bloc question published next to
 * two names is an accusation the evidence does not support. So nothing here is redacted — the
 * rows name judges deliberately, because a report that says "one judge is not separating the
 * field" without saying which one cannot be acted on — and it is the caller's job to keep this
 * off the public projection. `results.show` redacts judge ids out of its own warnings for the
 * same reason, and `tests/publish.test.ts` holds the boundary with a roster sweep over every
 * public body.
 *
 * Two rules shape the prose, and both were learned the hard way in the passes above.
 *
 * The first is that a finding must carry what to do about it. "Judge 3's scale slope is 0.31"
 * is a measurement; "their ballots are nearly flat, so the fit is leaning on the rest of the
 * panel for this project's placement" is a finding; "look at their ballots, or ask whether they
 * had time to do the work" is the only one of the three an organizer can act on. Every finding
 * here has an `advice` line, and the row's `action` is the advice of the first one that matters.
 *
 * The second is that a pairwise anomaly is a question and never an accusation. This pass can
 * measure that two judges agreed with each other far more often than these comparisons predict.
 * It cannot distinguish collusion from two people who share a taste the rubric does not name,
 * or from two people who happened to be handed the same easy slice of the field. Saying which
 * of those it is requires knowing things a database does not hold, so the prose asks the
 * question and stops. An organizer who reads "check whether they judged together" can act; one
 * who reads "these judges colluded" has been handed a conclusion the numbers do not support.
 *
 * One thing to know before reading a row against its neighbours, because it surfaced while
 * testing this pass against a planted bloc and it changes what the other warnings mean. A bloc
 * large enough to matter is also large enough to move the fit it is being measured against: two
 * judges filing a quarter of the event's duels on a shared rule drag the consensus towards that
 * rule, and the honest judges then read as off-consensus. So a `calibration.bloc` warning is
 * partly an explanation of the `judge.offConsensus` warnings around it, and the bloc is the row
 * to resolve first. The direction of the error is at least the safe one — the bloc's own surprise
 * falls, so this pass understates blocs rather than inventing them.
 */

import type { Ballot, Comparison, Criterion, Diagnostic, JudgeId, ProjectId, Rubric } from "./types.ts";
import { JudgingError } from "./types.ts";
import type { BradleyTerryResult } from "./bradleyterry.ts";
import { fitBradleyTerry, winProbability } from "./bradleyterry.ts";
import type { Discrimination, NormalizationResult } from "./normalize.ts";
import type { ReliabilityResult } from "./reliability.ts";
import { clamp, mean, median } from "./stats.ts";
import { normalizedWeights } from "./weighted.ts";
import { agree, names, plural, share } from "./words.ts";

export type CalibrationOptions = {
  /** Ballots below which a judge's rubric figures are called thin rather than read. */
  minBallots?: number;
  /** Decided comparisons below which their pairwise figures are called thin. */
  minComparisons?: number;
  /** Share of the rubric's span a judge's own scores must cover to be using the scale. */
  narrowSpan?: number;
  /** Offset from the panel, as a share of the rubric's span, worth naming as handled. */
  offsetShare?: number;
  /** Own mean surprise over the panel's, above which their duels sit off the consensus. */
  surpriseRatio?: number;
  /** Share of a judge's closed triples that may contradict themselves. */
  cycleRate?: number;
  /** Closed triples below which `cycleRate` is not read as a rate at all. */
  minTriples?: number;
  /** Agreement above what these comparisons predict, for a pair of judges to be asked about. */
  blocExcess?: number;
  /**
   * The false-positive rate the whole bloc table is allowed, before it is divided by the number
   * of judge pairs in it.
   */
  blocLevel?: number;
  /** Pairs two judges must both have decided before their agreement is quoted at all. */
  minShared?: number;
  /** Cap on the reported judge pairs, strongest excess first. */
  maxBlocs?: number;
  /** Share of offered duels a judge may skip before it is worth naming. */
  skipShare?: number;
  /**
   * How far one ballot may sit from the rest of the panel's view of that project, in units of
   * the panel's residual spread, before the judge who filed it is asked about.
   */
  extremeZ?: number;
};

/**
 * The settings used when the caller says nothing.
 *
 * Exported for the reason `NORMALIZE_DEFAULTS` is: the dashboard prints them beside the figures
 * they decided, and a threshold that lives in two places is a threshold that silently stops
 * matching the sentence explaining it.
 */
export const CALIBRATION_DEFAULTS = {
  // The same floor `normalize.ts` puts on fitting a judge's slope at all. Below it there is
  // nothing to calibrate, and a verdict drawn from two ballots is a verdict about two projects.
  minBallots: 3,
  // A judge's surprise on two duels is one coin flip reported to three decimals.
  minComparisons: 5,
  // A third of the card. `criteria.ts` calls the *panel* narrow below 0.4, and one judge is
  // allowed to be narrower than the panel: the panel's range is the union of everybody's, so
  // holding an individual to the panel's threshold flags judges who are behaving normally.
  narrowSpan: 0.3,
  // 15% of the span — 1.35 points on a 1-10 card. Below that the fit's own centring is the
  // whole story and naming it costs an organizer a paragraph for nothing.
  offsetShare: 0.15,
  // Half again as surprising as the panel. Read against the panel's own held-out figure, not
  // against an absolute: a field of near-equal entries is surprising to everybody at once.
  surpriseRatio: 1.5,
  // A judge consistent with any total order produces exactly zero cycles, so any cycle is a
  // literal self-contradiction and every one of them is reported. This is where the report
  // stops calling it a close call and starts calling it a pattern: a judge deciding at random
  // cycles on a quarter of their closed triples, so 0.15 is over halfway to a coin.
  cycleRate: 0.15,
  // And it needs eight closed triples before it is willing to call anything a rate. A judge
  // with three closed triples cannot register a cycle at all without registering 33% of them,
  // so on small denominators the threshold above is met by the minimum possible evidence. At
  // eight, tripping 0.15 takes two cycles, and two is past coincidence.
  minTriples: 8,
  // Twenty points of agreement above what these comparisons already predict for the pairs the
  // two of them both saw. Below that, ordinary sampling on a handful of shared pairs gets there
  // without any help.
  blocExcess: 0.2,
  // One clean panel in twenty may raise a bloc question, for the whole table rather than for each
  // pair in it. Per pair this was 5%, which on the fifteen pairs a six-judge panel offers put a
  // spurious question on two clean events in five — measured, not assumed. A warning that fires on
  // two clean panels in five is a warning organizers learn to scroll past, and the cost of that is
  // paid by the real bloc it was built to catch.
  blocLevel: 0.05,
  minShared: 4,
  maxBlocs: 8,
  // A third of what they were offered. Skipping is a legitimate answer to a pair a judge cannot
  // separate, and a scheduler that keeps offering unskippable pairs is the likelier fault.
  skipShare: 0.3,
  // Four times the panel's residual spread, on one ballot. `reliability.ts` puts a ballot in its
  // second-look table at 2.5, which is the right line for "read this", and this is the line for
  // "ask the judge about this" — a different sentence, and it needs a threshold no honest judge
  // reaches. Measured rather than chosen: on the control panel of `docs/proof/normalization.md`'s
  // strategic sweep, 240 simulated judges who all scored honestly, the furthest any single ballot
  // landed from the panel was 3.37 — while a judge inflating one project by 1.5 points of a
  // five-point card has a median worst ballot of 4.27, because marking the rest of the field down
  // makes them look harsh and the fit adds that harshness back to the inflated ballot too. The gap
  // between those two numbers is the whole finding, 4 sits in it, and that sweep's own claim gate
  // fails if either of them crosses it.
  extremeZ: 4,
} as const;

const DEFAULTS = CALIBRATION_DEFAULTS;

/**
 * What to do about this judge first.
 *
 * Precedence, not severity: `behind` outranks `check` because a judge with ballots outstanding
 * has figures that are going to move, so reading their calibration before the rest arrives is
 * reading a draft. The findings list keeps everything that was noticed either way — the verdict
 * decides which sentence goes in the `action` column, and it never decides what gets reported.
 *
 * `thin` is deliberately not `ok`. "There is not enough here to say anything about this judge"
 * and "this judge is fine" are different states, and collapsing them is how a panel of
 * one-ballot judges reads as a clean bill of health.
 */
export type CalibrationVerdict = "ok" | "thin" | "behind" | "check";

/** One judge's row. Every field is either measured here or carried across so the row is whole. */
export type JudgeCalibration = {
  judge: JudgeId;

  /** Projects on their plate, from the roster rather than from the ballots. */
  assigned: number;
  submitted: number;
  /** Started and not submitted. A draft is not a ballot and no fit has ever seen one. */
  drafts: number;
  /** `assigned - submitted`, floored: a judge may file on a project nobody assigned them. */
  outstanding: number;

  /** Submitted ballots that reached the fit. */
  ballots: number;
  /**
   * Where on the card they sit: the mean of their per-criterion means, each expressed as a
   * fraction of that criterion's declared range. Model-free, so it survives a fit that did not
   * converge, and it is the figure an organizer can check against a ballot by eye.
   */
  centre: number | null;
  /**
   * How much of the card they used: the mean per-criterion share of the declared range between
   * their own lowest and highest score. `null` below two ballots, because one ballot cannot
   * show a range and reporting 0 there flags every judge who has started.
   */
  spanUsed: number | null;
  /** `JudgeEffect.leniency` — their offset on the weighted total, panel-centred to mean zero. */
  leniency: number | null;
  /** The same offset as a share of the weighted total's span, which is the comparable form. */
  leniencyShare: number | null;
  /** `JudgeEffect.scale` — their fitted slope after shrinkage and clamping. */
  scale: number | null;
  /** `JudgeEffect.discrimination`, carried across rather than recomputed. */
  discrimination: Discrimination | null;
  /** `JudgeConsistency.relative` — their residual spread over the panel's. Above 1 is noisier. */
  spreadRelative: number | null;
  /** Whether `reliability.ts` flagged that spread as worth naming. */
  noisy: boolean;
  /** How many of their ballots are in the outlier table. */
  outliers: number;

  /** Decided duels. Skips are counted but never fitted. */
  comparisons: number;
  skipped: number;
  /** Their decisions that agree with the reference fit's order. */
  agreed: number;
  /** Their decisions that go the other way. A tie in the fit counts as neither. */
  against: number;
  /** `agreed / (agreed + against)`, or `null` when nothing was decided. */
  agreement: number | null;
  /**
   * What the reference fit predicts agreement would be for exactly the pairs they were shown.
   *
   * Without it, `agreement` is not comparable between judges: a judge handed lopsided pairs
   * should agree with the consensus more often than one handed close ones, and the difference
   * is the scheduler's doing rather than theirs.
   */
  expectedAgreement: number | null;
  /** Mean surprise, `-ln p`, of their decisions under the reference fit. Lower is tamer. */
  surprise: number | null;
  /** Their surprise over the panel's. Around 1 is ordinary; the threshold is `surpriseRatio`. */
  surpriseRatio: number | null;
  /**
   * Whether the reference fit for this judge excluded this judge.
   *
   * A judge's own duels are in the consensus they are being scored against, which flatters
   * them — the more they judged, the more the consensus is theirs. So the fit is refitted
   * without them where the remaining comparisons still hold the field together, and says so
   * here where they do not.
   */
  heldOut: boolean;
  /** Triples of projects where they decided all three pairs. */
  closedTriples: number;
  /** Those triples where they contradicted themselves: a beat b, b beat c, c beat a. */
  cycles: number;
  /** `cycles / closedTriples`, or `null` when no triple closed. */
  cycleRate: number | null;

  /** The codes of everything noticed about them, in the order the pass looks. */
  findings: string[];
  verdict: CalibrationVerdict;
  /** The one sentence to act on. The advice of the first finding, or the verdict's own. */
  action: string;
};

/**
 * Two judges, and how often they agreed where they overlapped.
 *
 * Ordered `a` before `b` by id so a pair appears once, and reported only above `minShared`.
 */
export type JudgePair = {
  a: JudgeId;
  b: JudgeId;
  /** Pairs of projects both of them decided. */
  shared: number;
  /** Of those, how many they gave to the same project. */
  agreed: number;
  share: number;
  /**
   * What agreement these comparisons predict for those pairs: the chance two independent draws
   * from the fitted model land the same way, averaged over the shared pairs.
   *
   * This is the baseline the naive version gets wrong. Comparing agreement against the panel
   * mean flags every pair of judges who were handed lopsided duels, because a lopsided duel is
   * one that almost everybody calls the same way.
   */
  expected: number;
  /**
   * `share - expected - panelExcess`. The part of their agreement neither these comparisons nor
   * the rest of the panel accounts for.
   *
   * Two corrections, and both were forced by watching this measure on a simulated panel where no
   * collusion existed at all. `expected` handles which pairs the two of them saw. `panelExcess`
   * handles the rest: a model fitted from a few hundred sparse duels shrinks the strengths
   * towards each other, so the agreement it predicts sits below the agreement real judges reach,
   * for every pair at once. Subtracting the panel's own median puts the measure where its name
   * says it is — more than *these* judges agree, not more than a shrunken model expected.
   */
  excess: number;
  /**
   * How often two judges predicted to agree this often would agree at least this much anyway: the
   * exact upper tail over the individual pairs they shared, taken under the panel-corrected
   * prediction rather than under a single averaged one.
   */
  pValue: number;
  /**
   * The level `pValue` had to clear, which is the table's own level divided by the number of judge
   * pairs in it.
   *
   * Carried on every row rather than kept once, because the number that decided a finding belongs
   * beside the finding: a reader who can see that fifteen pairs bought a level of 0.0033 can see
   * why a pair at 0.01 is in the table and not in the warnings.
   */
  level: number;
  /** Whether the excess cleared both lines, and so is a question the report actually asks. */
  asked: boolean;
};

export type CalibrationResult = {
  method: string;
  /** One row per judge on the roster, worst verdict first, then by id. */
  judges: JudgeCalibration[];
  /**
   * The comparison-weighted mean of the per-judge surprises, which is what `surpriseRatio` is
   * against. Deliberately not the in-sample figure: a held-out surprise compared against an
   * in-sample panel mean reads high for every judge at once.
   */
  panelSurprise: number | null;
  /** Judges whose surprise was measured against a fit that excluded them. */
  heldOut: number;
  /** Judges whose was not, because removing their duels broke the field into pieces. */
  inSample: number;
  blocs: JudgePair[];
  /**
   * The median of `share - expected` across every measured pair: how far below the panel's real
   * agreement the fitted model sits, which every pair's `excess` has had removed.
   *
   * Published because it is the correction most likely to be wrong, and a reader who can see it
   * can see whether a pair was let off by a large one. The median rather than the mean so that
   * one genuinely coordinated pair cannot raise the bar that would have caught it.
   */
  panelExcess: number | null;
  /**
   * The level each pair's tail probability had to clear: `blocLevel` divided by the number of pairs
   * measured, or `blocLevel` itself when none were.
   */
  blocLevel: number;
  /** The span of the weighted total, which `leniencyShare` and `centre` are fractions of. */
  span: number;
  warnings: string[];
  notes: Diagnostic[];
};

/** What the roster says a judge was given, which no ballot can tell you. */
export type JudgeWorkload = {
  judge: JudgeId;
  assigned: number;
  submitted: number;
  drafts: number;
  /** Duels they declined to call. Skips never reach a fit, so they arrive as a count. */
  skipped: number;
};

export type CalibrationInput = {
  /** `null` on a pairwise-only event, where there is no card to calibrate against. */
  rubric: Rubric | null;
  ballots: readonly Ballot[];
  /** Decided comparisons only. Skips arrive as counts on `workload`. */
  comparisons: readonly Comparison[];
  /** Every judge on the roster, including the ones who have filed nothing. */
  workload: readonly JudgeWorkload[];
  rubricFit: NormalizationResult | null;
  pairwiseFit: BradleyTerryResult | null;
  reliability: ReliabilityResult | null;
};

/** A finding, its severity, its sentence, and the sentence that says what to do. */
type Finding = { code: string; severity: "info" | "warn"; message: string; advice: string };

/**
 * An unordered pair as one key. Two ids, smaller first, so a pair has one name.
 *
 * The separator is a named constant rather than a literal in three places because the two
 * places that read a key apart have to agree with the one place that puts it together, and
 * a separator that disagrees fails silently: the split returns the whole key as the first
 * id and `undefined` as the second, and every figure derived from the second id quietly
 * becomes a default. A NUL cannot occur in an id that came from the database — ids are
 * generated, and the column is text — which a space cannot promise.
 */
const SEP = "\u0000";

const pairKey = (a: string, b: string): string => (a < b ? a + SEP + b : b + SEP + a);

/** The two ids of a pair key, in the order `pairKey` put them. */
const pairParts = (key: string): [string, string] => key.split(SEP) as [string, string];

/**
 * The chance that at least `hits` of a set of independent yes/no events came out yes, when each
 * one had its own probability of doing so.
 *
 * This is a Poisson-binomial upper tail, and it is computed exactly rather than approximated
 * because of the sizes involved: a pair of judges typically share five to fifteen decisions, which
 * is where a normal approximation to a proportion is at its worst and where the discreteness of
 * the count is a large part of the answer. The recurrence is the obvious one — fold one event in
 * at a time, shifting the distribution — and it costs the square of the number of events, which on
 * these sizes is nothing.
 *
 * Every term is a probability and every operation adds them, so there is no cancellation to lose
 * precision to, which is the property that makes the exact form worth having over a sampled one.
 */
function atLeast(hits: number, probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (hits <= 0) return 1;
  if (hits > n) return 0;
  let dist = [1];
  for (const p of probabilities) {
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k += 1) {
      const mass = dist[k] as number;
      next[k] = (next[k] as number) + mass * (1 - p);
      next[k + 1] = (next[k + 1] as number) + mass * p;
    }
    dist = next;
  }
  let tail = 0;
  for (let k = hits; k <= n; k += 1) tail += dist[k] as number;
  return clamp(tail, 0, 1);
}

/**
 * The span of the weighted total: the distance between the lowest and highest score a ballot
 * could carry, on the scale `leniency` is measured on.
 *
 * The criteria are allowed different ranges and different weights, so this is the only
 * denominator on which an offset of "1.4" means anything. Without it the report prints a
 * leniency of 1.4 next to one of 0.2 from another event and invites the comparison.
 */
function weightedSpan(rubric: Rubric): number {
  const weights = normalizedWeights(rubric.criteria);
  let span = 0;
  for (const c of rubric.criteria as readonly Criterion[]) {
    span += (weights.get(c.key) ?? 0) * (c.max - c.min);
  }
  return span;
}

/**
 * Per-judge calibration, and the pairwise questions a rubric cannot ask.
 *
 * Reads only. It fits the Bradley-Terry model again — once per judge, without that judge — and
 * that is the whole of its arithmetic beyond counting: it cannot move a ranking, which is what
 * makes it safe to run on the same fit that is about to be published.
 */
export function judgeCalibration(
  input: CalibrationInput,
  options: CalibrationOptions = {},
): CalibrationResult {
  const opt = { ...DEFAULTS, ...options };
  const { rubric, ballots, comparisons, workload, rubricFit, pairwiseFit, reliability } = input;

  // A report about nobody is a caller bug rather than a clean panel, and the difference matters
  // because the caller is a page: an organizer who is shown an empty calibration table has been
  // told the panel is fine. `criteria.ts` refuses an empty ballot list for the same reason.
  if (workload.length === 0) {
    throw new JudgingError("calibration.empty", "There is no roster to calibrate.");
  }
  // And a ballot scored against a different version of the card is not on the scale this pass
  // divides by. Every other pass that reads raw scores makes the same check, in the same words.
  if (rubric !== null) {
    for (const b of ballots) {
      if (b.rubricVersion !== rubric.version) {
        throw new JudgingError(
          "ballot.rubricVersion",
          `Ballot ${b.id} targets rubric version ${b.rubricVersion}, not ${rubric.version}.`,
        );
      }
    }
  }

  const roster = new Map<JudgeId, JudgeWorkload>();
  for (const w of workload) {
    if (roster.has(w.judge)) {
      throw new JudgingError(
        "calibration.duplicateJudge",
        `Judge ${w.judge} appears twice on the roster handed to the calibration pass.`,
      );
    }
    roster.set(w.judge, w);
  }

  // A ballot or a duel from somebody not on the roster is tolerated and named rather than
  // thrown, and the distinction matters. In this product's storage it cannot happen: both tables
  // hold a composite foreign key into `membership` with `on delete cascade`, so removing a judge
  // removes their work with them. It can happen to a caller assembling the input by hand, and
  // this pass is read at the moment before publishing — a page that returns 500 during an appeal
  // is worse than one that says three ballots came from somebody no longer on the panel.
  const strays = new Set<JudgeId>();
  const known = (judge: JudgeId): boolean => {
    if (roster.has(judge)) return true;
    strays.add(judge);
    return false;
  };

  const span = rubric === null ? 0 : weightedSpan(rubric);
  // Criteria with no range cannot be used narrowly or generously. `criteria.ts` reports the
  // degenerate line itself; here it is dropped so one broken criterion does not drag every
  // judge's `spanUsed` toward zero and flag the entire panel.
  const scored = (rubric?.criteria ?? []).filter((c) => c.max > c.min);

  const own = new Map<JudgeId, Ballot[]>();
  for (const b of ballots) {
    if (!known(b.judge)) continue;
    const seen = own.get(b.judge);
    if (seen) seen.push(b);
    else own.set(b.judge, [b]);
  }

  const centreOf = new Map<JudgeId, number>();
  const spanUsedOf = new Map<JudgeId, number>();
  for (const [judge, filed] of own) {
    const centres: number[] = [];
    const used: number[] = [];
    for (const c of scored) {
      // Non-finite and missing scores are skipped rather than trusted. Every other pass in this
      // engine reads ballots the schema has already validated; this one is read mid-flight, and
      // a single missing criterion turning a judge's centre into NaN would take the whole row
      // with it.
      const values = filed
        .map((b) => b.scores[c.key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (values.length === 0) continue;
      const width = c.max - c.min;
      centres.push((mean(values) - c.min) / width);
      used.push((Math.max(...values) - Math.min(...values)) / width);
    }
    if (centres.length > 0) centreOf.set(judge, mean(centres));
    if (used.length > 0 && filed.length > 1) spanUsedOf.set(judge, mean(used));
  }
  const panelCentre = centreOf.size > 0 ? mean([...centreOf.values()]) : null;

  const effectOf = new Map(rubricFit?.judges.map((j) => [j.judge, j]) ?? []);
  const consistencyOf = new Map(reliability?.judges.map((j) => [j.judge, j]) ?? []);
  const outliersOf = new Map<JudgeId, number>();
  for (const row of reliability?.outliers ?? []) {
    outliersOf.set(row.judge, (outliersOf.get(row.judge) ?? 0) + 1);
  }

  const duels = new Map<JudgeId, Comparison[]>();
  for (const c of comparisons) {
    if (!known(c.judge)) continue;
    const seen = duels.get(c.judge);
    if (seen) seen.push(c);
    else duels.set(c.judge, [c]);
  }

  // The consensus every judge's duels are scored against, and one consensus per judge that
  // excludes them.
  //
  // The in-sample version of this figure flatters exactly the judges it should scrutinise: a
  // judge who decided a third of the duels has written a third of the consensus, so their own
  // decisions look unsurprising to a model they largely are. Refitting without them costs one
  // MM fit per judge, which is cheap here for the same reason `bootstrap.ts` can afford four
  // hundred — the published strengths are a warm start, and every replicate lands near them.
  //
  // Removing a judge can only break the comparison graph, never mend it, so a judge whose duels
  // were holding the field together cannot be held out at all: their row says so rather than
  // quoting a figure measured against a fit that no longer compares the projects they saw.
  const fullBeta = new Map<ProjectId, number>(
    pairwiseFit?.strengths.map((s) => [s.project, s.beta]) ?? [],
  );
  const projects = [...fullBeta.keys()];
  const start = new Map<ProjectId, number>([...fullBeta].map(([p, b]) => [p, Math.exp(b)]));
  const reference = new Map<JudgeId, ReadonlyMap<ProjectId, number>>();
  const heldOut = new Set<JudgeId>();
  if (pairwiseFit !== null) {
    for (const judge of duels.keys()) {
      const rest = comparisons.filter((c) => c.judge !== judge);
      // The only two things `fitBradleyTerry` refuses are an empty list and a malformed
      // comparison, and the published fit accepted every one of these already — so the guard is
      // on the empty case and there is nothing else to catch.
      if (rest.length === 0) continue;
      const loo = fitBradleyTerry(rest, projects, { start });
      if (loo.componentCount > pairwiseFit.componentCount) continue;
      reference.set(judge, new Map(loo.strengths.map((s) => [s.project, s.beta])));
      heldOut.add(judge);
    }
  }

  type Duels = {
    agreed: number;
    against: number;
    scored: number;
    surprise: number | null;
    expected: number | null;
    closedTriples: number;
    cycles: number;
  };
  const readDuels = (judge: JudgeId, decided: readonly Comparison[]): Duels => {
    const beta = reference.get(judge) ?? fullBeta;
    let agreed = 0;
    let against = 0;
    let scored = 0;
    let loss = 0;
    let expected = 0;
    for (const c of decided) {
      const loser = c.winner === c.left ? c.right : c.left;
      const winnerBeta = beta.get(c.winner);
      const loserBeta = beta.get(loser);
      // A project the reference fit has no opinion about is not evidence either way. This is
      // reachable only on the in-sample fallback, where a project can be missing from a fit
      // that never saw it.
      if (winnerBeta === undefined || loserBeta === undefined) continue;
      const p = winProbability(winnerBeta, loserBeta);
      // The same floor `bradleyterry.ts` puts under its own log-likelihood, so a judge's
      // surprise and the fit's fit are measured on one scale.
      loss += -Math.log(Math.max(p, 1e-12));
      // The chance the fit assigns to whichever way it would call the pair itself: the
      // agreement a judge drawn from the model would average, which is what makes `agreement`
      // comparable between two judges shown different pairs.
      expected += Math.max(p, 1 - p);
      if (winnerBeta > loserBeta) agreed += 1;
      else if (loserBeta > winnerBeta) against += 1;
      scored += 1;
    }

    // Self-inconsistency, which in this product can only take one form. The storage layer holds
    // `unique (event_id, judge_id, left_id, right_id)` with `left_id < right_id`, so a judge
    // cannot be asked the same pair twice and cannot contradict themselves on a repeat. What
    // they can do is decide three pairs that no ordering satisfies, and a judge consistent with
    // any ranking at all produces none of those. The net below is what makes the walk
    // independent of the order the duels arrive in, for the caller whose input is hand-built
    // and does hold a repeated pair.
    const net = new Map<string, number>();
    const touched = new Set<ProjectId>();
    for (const c of decided) {
      touched.add(c.left);
      touched.add(c.right);
      const low = c.left < c.right ? c.left : c.right;
      const key = pairKey(c.left, c.right);
      net.set(key, (net.get(key) ?? 0) + (c.winner === low ? 1 : -1));
    }
    const beat = (a: ProjectId, b: ProjectId): number => {
      const decision = net.get(pairKey(a, b)) ?? 0;
      if (decision === 0) return 0;
      // The net is signed towards the smaller id, so reading it for a pair the caller named the
      // other way round means flipping it.
      return (decision > 0) === (a < b) ? 1 : -1;
    };
    const items = [...touched].sort();
    let closedTriples = 0;
    let cycles = 0;
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const ab = beat(items[i] as ProjectId, items[j] as ProjectId);
        if (ab === 0) continue;
        for (let k = j + 1; k < items.length; k += 1) {
          const bc = beat(items[j] as ProjectId, items[k] as ProjectId);
          if (bc === 0) continue;
          const ca = beat(items[k] as ProjectId, items[i] as ProjectId);
          if (ca === 0) continue;
          closedTriples += 1;
          // Three arrows running the same way round the triangle. Either direction is a cycle:
          // all three forward is a beat b beat c beat a, all three back is the same loop read
          // the other way. Any mixture is satisfied by some ordering.
          if (ab === bc && bc === ca) cycles += 1;
        }
      }
    }

    return {
      agreed,
      against,
      scored,
      surprise: scored > 0 ? loss / scored : null,
      expected: scored > 0 ? expected / scored : null,
      closedTriples,
      cycles,
    };
  };

  const read = new Map<JudgeId, Duels>();
  for (const [judge, decided] of duels) read.set(judge, readDuels(judge, decided));

  // The panel figure `surpriseRatio` is against: the comparison-weighted mean of exactly the
  // per-judge numbers being compared, so the ratios average to one by construction. Using the
  // in-sample log-likelihood instead would put every held-out judge above one at once, and a
  // threshold every judge clears is a threshold that reports the panel rather than a judge.
  let weightedLoss = 0;
  let weightedCount = 0;
  for (const row of read.values()) {
    if (row.surprise === null) continue;
    weightedLoss += row.surprise * row.scored;
    weightedCount += row.scored;
  }
  const panelSurprise = weightedCount > 0 ? weightedLoss / weightedCount : null;

  // Who agreed with whom, where they overlapped.
  //
  // The naive form of this measurement compares each pair of judges against the panel's average
  // agreement, and it flags the wrong pairs: two judges handed the same lopsided duels agree
  // because the duels were lopsided. So the baseline is the agreement these comparisons predict
  // for exactly the pairs the two of them both saw — the chance two independent draws from the
  // fitted model land the same way — and the reported quantity is what their agreement has left
  // over after that.
  //
  // It leans the safe way twice. The consensus contains both of their votes, so it is pulled
  // toward whatever they share, which shrinks the excess rather than inflating it. And a bloc of
  // two judges who are simply better than the model — who see a difference the duels they were
  // given cannot express — looks exactly like a bloc of two judges who talked. That is why every
  // sentence this produces is a question.
  //
  // And it needs three corrections that the model baseline alone does not supply, all three found
  // by running this pass over simulated panels with no coordination in them whatsoever and
  // counting how often it asked anyway. Uncorrected it asked about three pairs in ten on one
  // event, and about at least one pair on two events in five across thirty.
  //
  // A fit built from a few hundred sparse duels shrinks the strengths towards each other, so the
  // agreement it predicts sits below what real judges reach, for every pair at once: that bias
  // comes out as the panel's own median. On six shared pairs the sampling error on a proportion is
  // about a fifth, so a fixed threshold of a fifth is one standard error and noise clears it
  // routinely: that becomes an exact tail probability rather than a threshold on the excess. And a
  // panel of six judges offers fifteen pairs to test, so a per-pair 5% test raises a question on
  // half of all clean panels: that becomes a level divided by the number of pairs looked at.
  //
  // What survives all three is a pair that is both implausible and large — implausible because the
  // tail says so at a level the panel's own size has paid for, and large because a difference of
  // two points of agreement over ten thousand duels is not a bloc however small its p-value.
  const decidedBy = new Map<string, Map<JudgeId, ProjectId>>();
  for (const c of comparisons) {
    if (!roster.has(c.judge)) continue;
    const key = pairKey(c.left, c.right);
    const seen = decidedBy.get(key);
    if (seen) seen.set(c.judge, c.winner);
    else decidedBy.set(key, new Map([[c.judge, c.winner]]));
  }
  // The per-shared-pair predicted agreements are kept rather than averaged, because the tail below
  // is computed over exactly these numbers: two judges who shared one coin-flip pair and nine
  // foregone conclusions are not the same as two who shared ten even ones, and an average cannot
  // tell those apart.
  type Overlap = { agreed: number; probs: number[] };
  const overlaps = new Map<string, Overlap>();
  for (const [key, byJudge] of decidedBy) {
    if (byJudge.size < 2) continue;
    const [low, high] = pairParts(key) as [ProjectId, ProjectId];
    const lowBeta = fullBeta.get(low);
    const highBeta = fullBeta.get(high);
    // Half is the honest answer for a pair no fit has an opinion about: two coin flips agree
    // half the time, so such a pair contributes the baseline it deserves and no signal.
    const p = lowBeta !== undefined && highBeta !== undefined ? winProbability(lowBeta, highBeta) : 0.5;
    const together = p * p + (1 - p) * (1 - p);
    const judges = [...byJudge.keys()].sort();
    for (let i = 0; i < judges.length; i += 1) {
      for (let j = i + 1; j < judges.length; j += 1) {
        const a = judges[i] as JudgeId;
        const b = judges[j] as JudgeId;
        const tally = overlaps.get(pairKey(a, b)) ?? { agreed: 0, probs: [] };
        tally.probs.push(together);
        if (byJudge.get(a) === byJudge.get(b)) tally.agreed += 1;
        overlaps.set(pairKey(a, b), tally);
      }
    }
  }
  // Two passes, because the correction each pair needs is a fact about all of them. The first
  // measures raw excess over the model; the second removes the panel's own median and asks
  // whether what is left survives both the number of pairs the two of them saw and the number of
  // judge pairs the report looked at.
  type Raw = {
    a: JudgeId;
    b: JudgeId;
    shared: number;
    agreed: number;
    share: number;
    expected: number;
    probs: number[];
  };
  const raw: Raw[] = [];
  for (const [key, tally] of overlaps) {
    const shared = tally.probs.length;
    if (shared < opt.minShared) continue;
    const [a, b] = pairParts(key) as [JudgeId, JudgeId];
    raw.push({
      a,
      b,
      shared,
      agreed: tally.agreed,
      share: tally.agreed / shared,
      expected: mean(tally.probs),
      probs: tally.probs,
    });
  }
  // Three pairs is the fewest a median means anything on, and below it the correction is skipped
  // rather than guessed: a panel that small gets the uncorrected baseline and a level narrow
  // enough that almost nothing clears it, which is the right answer for a panel that small.
  const panelExcess = raw.length >= 3 ? median(raw.map((r) => r.share - r.expected)) : null;
  // One level for the whole table, paid for by the number of pairs in it. Bonferroni is the
  // conservative choice among the corrections available and the only one that can be explained in
  // a sentence to somebody deciding whether to act on it, which matters more here than the power
  // a sharper correction would buy.
  const level = opt.blocLevel / Math.max(1, raw.length);
  const measured: JudgePair[] = raw.map(({ probs, ...r }) => {
    const excess = r.share - r.expected - (panelExcess ?? 0);
    // The tail is taken under the null the pair was predicted to reach, shifted by the panel's own
    // bias, and computed exactly. `shared` is routinely five to fifteen, where a normal
    // approximation to a proportion is at its worst and the discreteness is most of the answer.
    const pValue = atLeast(
      r.agreed,
      probs.map((p) => clamp(p + (panelExcess ?? 0), 0.01, 0.99)),
    );
    return {
      ...r,
      excess,
      pValue,
      level,
      // Both, and in this order for a reason. Significance without an effect size flags a pair
      // whose thousands of duels make a two-point difference certain; an effect size without
      // significance flags six shared pairs out of a hat.
      asked: pValue <= level && excess >= opt.blocExcess,
    };
  });
  measured.sort((x, y) => y.excess - x.excess || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  // `maxBlocs` is a floor on the context, not a ceiling on the findings. Every pair the tail
  // objects to is reported however many there are — a pair dropped for tidiness is a question
  // nobody gets asked — and the cap only limits how many quieter pairs ride along beneath them
  // to show what ordinary overlap looks like.
  const asked = measured.filter((pair) => pair.asked);
  const blocs = measured.slice(0, Math.max(opt.maxBlocs, asked.length));
  const blocOf = new Map<JudgeId, JudgePair[]>();
  for (const pair of asked) {
    for (const judge of [pair.a, pair.b]) {
      const seen = blocOf.get(judge);
      if (seen) seen.push(pair);
      else blocOf.set(judge, [pair]);
    }
  }

  const notes: Diagnostic[] = [];
  const warnings: string[] = [];
  /**
   * A note, and a warning only if it is one.
   *
   * The same rule the rest of the engine follows: `warnings` is the objection list a publisher
   * reads, `notes` is the full table with codes beside it, and a warning list that includes the
   * routine is a warning list nobody reads.
   */
  const say = (code: string, severity: "info" | "warn", message: string, subjects: string[]): void => {
    if (severity === "warn") warnings.push(message);
    notes.push({ code, severity, message, subjects });
  };

  const rows: JudgeCalibration[] = [];
  for (const [judge, work] of roster) {
    const filed = own.get(judge) ?? [];
    const decided = duels.get(judge) ?? [];
    const effect = effectOf.get(judge) ?? null;
    const consistency = consistencyOf.get(judge) ?? null;
    const duelling = read.get(judge) ?? null;
    const outstanding = Math.max(0, work.assigned - work.submitted);
    const centre = centreOf.get(judge) ?? null;
    const spanUsed = spanUsedOf.get(judge) ?? null;
    const leniency = effect?.leniency ?? null;
    const leniencyShare = leniency !== null && span > 0 ? leniency / span : null;
    const surprise = duelling?.surprise ?? null;
    const surpriseRatio =
      surprise !== null && panelSurprise !== null && panelSurprise > 0 ? surprise / panelSurprise : null;
    const cycleRate =
      duelling !== null && duelling.closedTriples > 0 ? duelling.cycles / duelling.closedTriples : null;
    const offered = decided.length + work.skipped;

    // In the order the pass looks, which is also the order that decides `action`: the work comes
    // before the arithmetic, because a judge with ballots outstanding has figures that will move.
    const findings: Finding[] = [];
    if (work.assigned === 0 && work.submitted === 0 && work.drafts === 0 && decided.length === 0) {
      findings.push({
        code: "judge.noWork",
        severity: "warn",
        message:
          `Judge ${judge} is on the panel with nothing assigned and nothing filed. Their place ` +
          `on the roster is counted in every "how many judges" figure on this page.`,
        advice: "Assign them projects, or take them off the roster so the counts describe the panel that judged.",
      });
    }
    if (outstanding > 0) {
      findings.push({
        code: "judge.behind",
        severity: "warn",
        message:
          `Judge ${judge} has ${plural(outstanding, "assigned project")} still unscored, out of ` +
          `${work.assigned}. Every figure in their row is measured on the ${plural(filed.length, "ballot")} ` +
          `that did arrive.`,
        advice: `Chase the ${plural(outstanding, "ballot")}, or reassign those projects, before reading anything else here.`,
      });
    }
    if (work.drafts > 0) {
      findings.push({
        code: "judge.drafts",
        severity: "info",
        message:
          `Judge ${judge} has ${plural(work.drafts, "ballot")} started and not submitted. A draft is ` +
          `not a ballot: no fit on this page has seen ${agree(work.drafts, "it", "them")}.`,
        advice: "Ask them to submit, or accept that those projects are being scored by everybody else.",
      });
    }
    if (
      consistency !== null &&
      consistency.worstProject !== null &&
      Math.abs(consistency.worstZ) >= opt.extremeZ
    ) {
      // The one finding on this list that describes a single ballot rather than a judge, and the
      // only one whose sentence a reader could mistake for an accusation. So it says what was
      // measured and stops: a number, a project, and a direction. `judge.noisyBallots` below is
      // the same residuals read as a spread and answers a different question — a judge can be
      // uniformly noisy with no extreme, or agree with the panel about everything except one
      // project, and it is the second shape that scoring your own team produces.
      const high = consistency.worstZ > 0;
      findings.push({
        code: "judge.extremeBallot",
        severity: "warn",
        message:
          `Judge ${judge}'s ballot on ${consistency.worstProject} sits ` +
          `${Math.abs(consistency.worstZ).toFixed(1)} times the panel's residual spread ` +
          `${high ? "above" : "below"} what the rest of the panel's scores for that project ` +
          `predict, after their own offset and slope are removed. That is the largest ` +
          `disagreement about one project on this panel from this judge, and it is far enough ` +
          `out that ordinary variation does not reach it.`,
        advice:
          `Read that one ballot and its comments. A score that far from the panel with a reason ` +
          `written on it is the most useful ballot on the event; the same score with nothing ` +
          `written on it is worth asking about before you publish.`,
      });
    }
    if (effect?.discrimination === "low") {
      findings.push({
        code: "judge.notSeparating",
        severity: "warn",
        message:
          `Judge ${judge}'s scores barely move with the field: their fitted slope is ` +
          `${effect.scale.toFixed(2)}, so their ballots separate the projects they saw much less ` +
          `than the panel does. The fit weights them down accordingly, which means the placement of ` +
          `those projects is resting on the other judges who saw them.`,
        advice: "Check how many other judges covered their projects, and read one of their ballots before publishing.",
      });
    }
    if (effect?.discrimination === "insufficient") {
      // Two different facts wear one label in the fit, and the difference decides both who should do
      // something about it and whether anybody should. Too few ballots is a judge who has not
      // finished, which the `thin` verdict and the ballot count already say — so it is reported and
      // left at `info`, because escalating it would put "check" beside every judge on a small panel
      // and a report that says check everywhere says nothing. A flat assignment with enough ballots
      // on file is the opposite: the fit could not weight the judge and nothing else on the page
      // shows it, since a held slope prints as 1.00 and 1.00 looks like agreement with the panel.
      //
      // The ballot floor is `normalize.ts`'s own — see `minBallots` above — so this branch lands on
      // the same side of the line the fit itself used.
      const few = filed.length < opt.minBallots;
      findings.push({
        code: "judge.noSlope",
        severity: few ? "info" : "warn",
        message:
          `Judge ${judge}'s slope was not fitted at all and is held at 1.00, because ` +
          (few
            ? `${plural(filed.length, "ballot")} ${agree(filed.length, "is", "are")} not enough to ` +
              `fit one. Their scores go into the ranking with only their offset removed.`
            : `the ${plural(filed.length, "project")} they scored all fitted to nearly the same ` +
              `quality, so there was no spread to fit a slope against. That is a property of the ` +
              `draw rather than of the judge, and a held slope prints as 1.00 like any other.`),
        advice: few
          ? `No action beyond the ballots themselves; below ${opt.minBallots} there is no slope to read.`
          : "Check that those projects were seen by other judges, and look at the draw: assignments spread across the field rather than within one band give every judge something to separate.",
      });
    }
    if (spanUsed !== null && filed.length >= opt.minBallots && spanUsed < opt.narrowSpan) {
      findings.push({
        code: "judge.narrowSpan",
        severity: "info",
        message:
          `Judge ${judge} used ${share(spanUsed)} of the rubric's range across ` +
          `${plural(filed.length, "ballot")} — the distance between their own lowest and highest ` +
          `score, averaged over the criteria. The fit rescales that, so it costs nothing on its own.`,
        advice: "No action unless it comes with a low slope, which is the same observation with consequences.",
      });
    }
    const offset = leniencyShare ?? (centre !== null && panelCentre !== null ? centre - panelCentre : null);
    if (offset !== null && Math.abs(offset) >= opt.offsetShare) {
      findings.push({
        code: "judge.offset",
        severity: "info",
        message:
          `Judge ${judge} scores ${share(Math.abs(offset))} of the rubric's span ` +
          `${offset > 0 ? "above" : "below"} the panel. This is the difference the fit exists to ` +
          `remove, and it is removed: their offset is subtracted before any project is ranked.`,
        advice: "No action. It is here so that noticing it in the raw ballots does not look like a finding.",
      });
    }
    if (consistency?.flagged === true) {
      findings.push({
        code: "judge.noisyBallots",
        severity: "info",
        message:
          `Judge ${judge}'s scores sit ${consistency.relative.toFixed(2)} times as far from what ` +
          `the fit expects as the panel's do. That is disagreement with the consensus about ` +
          `particular projects rather than about the scale.`,
        advice: "Worth a look only alongside their outliers, which name the projects it came from.",
      });
    }
    const outliers = outliersOf.get(judge) ?? 0;
    if (outliers > 0) {
      findings.push({
        code: "judge.outliers",
        severity: "info",
        message:
          `${plural(outliers, "ballot")} from judge ${judge} ` +
          `${agree(outliers, "is", "are")} in the second-look table above.`,
        advice: "Read those ballots against their comments; an outlier with a reason written on it is evidence, not noise.",
      });
    }
    if (pairwiseFit !== null && decided.length === 0 && work.skipped === 0 && work.assigned > 0) {
      findings.push({
        code: "judge.noComparisons",
        severity: "info",
        message:
          `Judge ${judge} has filed ${plural(filed.length, "ballot")} and decided no duels, on an ` +
          `event where the pairwise ranking is switched on.`,
        advice: "Point them at the duels; a pairwise ranking built without part of the panel is a narrower panel.",
      });
    }
    if (work.skipped >= 2 && offered > 0 && work.skipped / offered >= opt.skipShare) {
      findings.push({
        code: "judge.skips",
        severity: "info",
        message:
          `Judge ${judge} skipped ${work.skipped} of ${plural(offered, "duel")} they were offered. ` +
          `Skipping is a legitimate answer to a pair nobody could separate.`,
        advice: "Check which pairs, and whether the scheduler kept offering the same unseparable ones.",
      });
    }
    if (
      surpriseRatio !== null &&
      decided.length >= opt.minComparisons &&
      surpriseRatio >= opt.surpriseRatio
    ) {
      findings.push({
        code: "judge.offConsensus",
        severity: "warn",
        message:
          `Judge ${judge}'s duels are ${surpriseRatio.toFixed(2)} times as surprising as the ` +
          `panel's, measured against a fit that ${heldOut.has(judge) ? "excludes their own decisions" : "includes their own decisions, which understates this"}. ` +
          `They called ${plural(duelling?.against ?? 0, "duel")} against the order the rest of the ` +
          `evidence gives, out of ${plural(decided.length, "duel")}.`,
        advice: "Read their duels. A judge who consistently disagrees is either seeing something the rubric misses or reading the question differently, and both are worth knowing before you publish.",
      });
    }
    if (duelling !== null && duelling.cycles > 0) {
      // A rate needs a denominator before it is a rate. One cycle in three closed triples is
      // 33% and one cycle in forty is 2.5%, and only the second of those is a measurement: the
      // first is the smallest number of cycles it is possible to have, divided by a number
      // small enough that it lands above any threshold worth setting. So the escalation wants
      // both — a rate over the line and enough triples for the line to mean something — and
      // below that floor the cycles are still reported, still counted, and still not a pattern.
      const serious =
        cycleRate !== null && cycleRate >= opt.cycleRate && duelling.closedTriples >= opt.minTriples;
      findings.push({
        code: "judge.cycles",
        severity: serious ? "warn" : "info",
        message:
          `Judge ${judge} contradicted themselves on ${plural(duelling.cycles, "triple")} of ` +
          `${plural(duelling.closedTriples, "triple")} where they decided all three pairs: they ` +
          `preferred A to B, B to C and C to A. ` +
          (serious
            ? `At ${share(cycleRate as number)} of their closed triples that is a pattern — ` +
              `a judge deciding at random cycles on a quarter of them.`
            : `On a field this close that is what two near-equal entries look like from three angles.`),
        advice: serious
          ? "Ask whether they were reading a consistent question, and consider whether their duels should carry the weight they are carrying."
          : "No action. The Bradley-Terry fit is built for exactly this and resolves it as uncertainty rather than error.",
      });
    }
    for (const pair of blocOf.get(judge) ?? []) {
      const other = pair.a === judge ? pair.b : pair.a;
      findings.push({
        code: "calibration.bloc",
        severity: "warn",
        message: `Judge ${judge} and judge ${other} agree more than these comparisons, and more than the rest of this panel, predict.`,
        advice: `Check whether judge ${judge} and judge ${other} judged together, discussed entries, or were handed the same slice of the field.`,
      });
    }

    const worst = findings.find((f) => f.severity === "warn") ?? null;
    // Every finding becomes a coded note, with one exception: a bloc is a statement about two
    // judges, and a sentence about two judges said once from each of their rows is the same
    // question asked twice. The pair loop below says it, naming both, with both as its subjects —
    // so a row's `calibration.bloc` code still resolves to a note that has this judge in it.
    for (const finding of findings) {
      if (finding.code === "calibration.bloc") continue;
      say(finding.code, finding.severity, finding.message, [judge]);
    }
    const thin = filed.length < opt.minBallots && decided.length < opt.minComparisons;
    const verdict: CalibrationVerdict =
      outstanding > 0 ? "behind" : worst !== null ? "check" : thin ? "thin" : "ok";
    const action =
      (worst ?? findings[0])?.advice ??
      (verdict === "thin"
        ? "Too little on file to calibrate. Read this row again once their work lands."
        : "Nothing to act on before publishing.");

    rows.push({
      judge,
      assigned: work.assigned,
      submitted: work.submitted,
      drafts: work.drafts,
      outstanding,
      ballots: filed.length,
      centre,
      spanUsed,
      leniency,
      leniencyShare,
      scale: effect?.scale ?? null,
      discrimination: effect?.discrimination ?? null,
      spreadRelative: consistency?.relative ?? null,
      noisy: consistency?.flagged ?? false,
      outliers,
      comparisons: decided.length,
      skipped: work.skipped,
      agreed: duelling?.agreed ?? 0,
      against: duelling?.against ?? 0,
      agreement:
        duelling !== null && duelling.agreed + duelling.against > 0
          ? duelling.agreed / (duelling.agreed + duelling.against)
          : null,
      expectedAgreement: duelling?.expected ?? null,
      surprise,
      surpriseRatio,
      heldOut: heldOut.has(judge),
      closedTriples: duelling?.closedTriples ?? 0,
      cycles: duelling?.cycles ?? 0,
      cycleRate,
      findings: findings.map((f) => f.code),
      verdict,
      action,
    });
  }

  if (strays.size > 0) {
    say(
      "calibration.strays",
      "warn",
      `${plural(strays.size, "judge")} filed work on this event and ${agree(strays.size, "is", "are")} ` +
        `not on the roster handed to this pass: ${names([...strays].sort())}. Their ballots and duels ` +
        `are in the fits above and are not in the rows below, so the two disagree about who judged.`,
      [...strays].sort(),
    );
  }

  for (const pair of asked) {
    say(
      "calibration.bloc",
      "warn",
      `Judge ${pair.a} and judge ${pair.b} decided ${plural(pair.shared, "pair")} in common and ` +
        `agreed on ${pair.agreed} of them — ${share(pair.share)}, where these comparisons predict ` +
        `${share(pair.expected)} for exactly those pairs. Allowing for the ${share(panelExcess ?? 0)} ` +
        `by which the model under-predicts every pair on this panel, ${share(pair.excess)} is left ` +
        `over, and two judges predicted to agree that often would agree at least that much by ` +
        `chance about once in ${Math.round(1 / Math.max(pair.pValue, 1e-9))} panels. Two judges who ` +
        `share a taste the rubric does not name will do this without any coordination at all, and ` +
        `so will two who were handed the same easy slice of the field, so this is a question rather ` +
        `than a finding: check whether they judged together, discussed entries, or drew the same ` +
        `projects.`,
      [pair.a, pair.b],
    );
  }

  if (pairwiseFit === null) {
    say(
      "calibration.noPairwise",
      "info",
      comparisons.length === 0
        ? "There are no duels on this event, so the pairwise half of this report — surprise, self-consistency and who agrees with whom — is not measured."
        : "There are duels on this event but no fitted pairwise ranking to score them against, so the pairwise half of this report is not measured.",
      [],
    );
  } else if (heldOut.size > 0 || read.size > 0) {
    const short = read.size - heldOut.size;
    say(
      "calibration.heldOut",
      "info",
      `Surprise is measured against a fit that excludes the judge being measured, for ` +
        `${plural(heldOut.size, "judge")} of ${read.size}. ` +
        (short === 0
          ? "Every judge here is scored against evidence they did not write."
          : `For the other ${short} it could not be: removing their duels breaks the field into ` +
            `pieces that cannot be compared, so ${agree(short, "that judge is", "those judges are")} ` +
            `scored against a consensus containing their own decisions, which understates how far ` +
            `from it they sit.`),
      [],
    );
  }

  const unsettled = rows.filter((row) => row.verdict === "check" || row.verdict === "behind");
  const thinRows = rows.filter((row) => row.verdict === "thin");
  if (thinRows.length > 0) {
    say(
      "calibration.thin",
      "info",
      `${plural(thinRows.length, "judge")} ${agree(thinRows.length, "has", "have")} too little on ` +
        `file to calibrate — under ${plural(opt.minBallots, "ballot")} and under ` +
        `${plural(opt.minComparisons, "duel")}: ${names(thinRows.map((row) => row.judge).sort())}. ` +
        `An empty row is the absence of a clean bill of health rather than one.`,
      thinRows.map((row) => row.judge).sort(),
    );
  }
  if (rows.length > 0 && unsettled.length === 0 && strays.size === 0) {
    say(
      "calibration.clean",
      "info",
      `Nothing about any of the ${plural(rows.length, "judge")} on this panel qualifies these ` +
        `results: no ballots outstanding, no judge failing to separate the field, no single ballot ` +
        `far enough from the panel to ask about, and no pair of judges agreeing more than the ` +
        `evidence accounts for.`,
      [],
    );
  }

  // Worst first, so the row an organizer has to act on is the row they read. `behind` outranks
  // `check` here for the same reason it outranks it in the verdict: the figures under a judge
  // who has not finished are a draft.
  const order: Record<CalibrationVerdict, number> = { behind: 0, check: 1, thin: 2, ok: 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.judge.localeCompare(b.judge));

  return {
    method:
      `per-judge-calibration+leave-one-out` +
      `(surprise>=${opt.surpriseRatio}x, cycles>=${opt.cycleRate} over ${opt.minTriples} triples, ` +
      `one ballot>=${opt.extremeZ}sd, bloc>=${opt.blocExcess} at ${opt.blocLevel} over the table)`,
    judges: rows,
    panelSurprise,
    heldOut: heldOut.size,
    inSample: read.size - heldOut.size,
    blocs,
    panelExcess,
    blocLevel: level,
    span,
    warnings,
    notes,
  };
}
