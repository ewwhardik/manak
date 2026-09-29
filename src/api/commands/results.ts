/**
 * Results: the ranking, who may see it, and the organizer's view of work in progress.
 *
 * Five operations, and the interesting decisions are all about what a number is allowed to say.
 *
 * **The judge-effect table is organizer-only.** `normalizeScores` fits a leniency and a scale per
 * judge, and publishing that to the world would name a volunteer as the harsh one on a page their
 * colleagues can read. The mechanism exists to *remove* judge effects from the ranking, not to
 * publish an appraisal of the panel. What the public gets instead is per-project `rankMove` — how
 * far a project moved once leniency was removed — which is the honest evidence that normalization
 * happened and needs nobody's name. Organizers see the full table, because somebody has to be able
 * to spot the judge who scored everything a 3.
 *
 * **`converged` and `warnings` are always published.** A fit that ran out of sweeps, a project with
 * one ballot, a comparison graph in two pieces: each of those makes the ranking mean less, and each
 * is on the response whether or not it flatters the event. A leaderboard that hides its own caveats
 * is the failure mode this product exists to avoid. The engine writes some of those warnings *about a
 * judge*, though, so public warnings carry positional labels — "Judge B" — in place of account ids,
 * and every project a warning names is named by its title rather than by the id the engine was given.
 * `forPublic` does both substitutions and is the only spelling any public surface uses. The judge half
 * works against the event's judge roster rather than against the fit's own judge list, so it is a
 * superset and the claim "no public response names a judge" is one a test can hold rather than a habit
 * reviewers have to police.
 *
 * **Intervals and tiers are public, and they are the most important thing on the page.** A ranking
 * of forty projects the panel can only resolve into four levels is not a ranking of forty projects,
 * and printing it as one is how a judging system misleads the people trusting it. So `results.show`
 * publishes `panel` — separation, strata, reliability, the variance shares, the tier count and
 * whether first is separated from second — and every project row carries `low`, `high`, `tier` and
 * `sharesTier`. None of it names a judge: `varianceShare.judge` says how much of the spread came from
 * the panel without saying which member of it, which is the same trade `rankMove` makes.
 *
 * **Per-criterion analysis is organizer-only, and that is the cut line here.** `criterionInsights`
 * reports `judgeDivergence` per criterion, which is a measure of how far apart the panel read the
 * words — and on a three-judge panel a reader who knows the roster can back out who differed. It is
 * also a critique of the rubric's design, which an organizer should act on before the next event and
 * a public results page has no use for. So `events.dashboard` carries the whole `CriteriaResult`,
 * `results.show` carries none of it, and the same rule sends `outliers` and per-judge consistency to
 * the dashboard alone.
 *
 * **Calibration is organizer-only for a stronger reason than that.** `judgeCalibration` prints a
 * verdict about a person — `check`, `thin`, `behind` — and pairs of judges whose agreement these
 * comparisons do not predict. Every other per-judge quantity in this file describes a coefficient;
 * these describe a panel member, and the honest use of them is a private question rather than a
 * public assertion. So `calibration` is on `events.dashboard` and on no other operation at any role,
 * which `tests/publish.test.ts` holds by sweeping every public body for its field names as well as
 * for the roster.
 *
 * **The two surfaces count comparisons differently, and say so in the field name.** `results.show`
 * publishes `comparisonsDecided`, because a skipped duel contributes nothing to the fit;
 * `events.dashboard` publishes `comparisons` with `skipped` beside it, because an organizer chasing a
 * panel needs to know work happened. They were both called `comparisons` until a smoke run had the
 * two pages reporting 20 and 24 for the same event, which is the "two screens disagreeing" failure
 * `events.dashboard`'s own doc warns about.
 *
 * **`results.show` carries no declared gate.** A gate is applied by the dispatcher before the
 * handler and knows nothing about roles, so `gate: "results"` would also refuse the organizer who
 * needs to read the ranking *before* deciding to publish it. The gate is therefore enforced inside
 * the handler, where the caller's role is known: organizers always, everybody else only once
 * `results_public` is set. `assertGate` is still what throws, so `results.notPublic` has one
 * definition rather than two. `results.confidence` follows the same rule for the same reason.
 *
 * **The expensive question lives on its own operation.** `results.confidence` resamples the panel a
 * few hundred times to say which parts of the duel order the comparisons establish, which costs
 * about a second; it is the answer to "are these two projects actually separated", and it is public
 * because a ranking that hides how much of itself is a tie is the failure this product exists to
 * avoid. It is not on `results.show` because the leaderboard is the page everybody loads and this is
 * the page somebody asks a question on, and it spends from its own rate-limit bucket rather than from
 * `read` because a second of uninterruptible arithmetic is a second nobody else is served.
 *
 * The cut line: **there is no per-track ranking.** Tracks partition submissions, and a track-scoped
 * normalization would fit judge leniency from a handful of ballots per track and call the result a
 * ranking. The fit is over the whole event, which is where the ballots are, and a track winner is
 * read off the full ranking by filtering it. `results.show` publishes `trackKey` on every project so
 * a page can do exactly that.
 */

import { reviewExplanations } from "../../judging/index.ts";
import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { EVENT_REF } from "./events.ts";
import {
  allComparisons,
  certificateKeyDirectory,
  certificateCorrections,
  correctCertificate,
  issuedEventCertificates,
  persistEventCertificates,
  certificateTemplate,
  saveCertificateTemplate,
  publicCertificate,
  assertGate,
  coverageGaps,
  findProjectIn,
  judgeablePool,
  judgeProgress,
  listProjects,
  loadJudgingInput,
  membersOf,
  projectCoverage,
  publishedVersion,
  setResultsPublic,
  readLedger,
  headHash,
  assertVotingClosed,
  abusePolicy,
  abuseSignalKey,
  abuseReview,
  duplicateTitles,
  RuleError,
  latestPublication,
  publicationHistory,
  storePublication,
} from "../../db/index.ts";
import type { Ctx, EventGates, EventRow, JudgeProgress, ProjectCoverage } from "../../db/index.ts";
import {
  compareRankings,
  criterionInsights,
  fitBradleyTerry,
  judgeCalibration,
  normalizeScores,
  pairingProgress,
  panelReliability,
  bootstrapStrengths,
  BOOTSTRAP_DEFAULTS,
  triageFinalists,
  detectControversy,
  rankingSensitivity,
  judgingReadiness,
  decomposeTournament, distributionCalibration, detectVoteAbuse, comparisonInformation,
} from "../../judging/index.ts";
import { RevisionCache } from "../cache.ts";
import type {
  Ballot,
  BootstrapResult,
  BradleyTerryResult,
  CalibrationResult,
  Comparison,
  CriteriaResult,
  Diagnostic,
  NormalizationResult,
  ProjectInterval,
  ReliabilityResult,
  Rubric,
} from "../../judging/index.ts";

import {
  DIAGNOSTIC_SCHEMA, PANEL_SCHEMA, RELIABILITY_SCHEMA, CRITERIA_SCHEMA, CALIBRATION_SCHEMA,
  panelJson, reliabilityJson, calibrationJson,
} from "./results-reports.ts";

const PROJECT_SCORE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project: { type: "string" },
    title: { type: "string" },
    trackKey: { type: ["string", "null"] },
    ballots: { type: "integer" },
    // Both absent on a pure-pairwise ranking, for the same reason the interval fields are: a
    // Bradley-Terry strength is not a mean of anything and carries no error estimate, so there
    // is no number to report. `ballots` stays required because zero rubric ballots is a true
    // count rather than a missing quantity.
    rawMean: { type: "number" },
    standardError: { type: "number" },
    adjusted: { type: "number" },
    rank: { type: "integer" },
    rankRaw: { type: "integer" },
    rankMove: { type: "integer" },
    // Present only when the reliability pass ran, which needs a rubric fit with at least one
    // project in it. A pure-pairwise ranking has no interval, and inventing a zero-width one
    // would read as certainty rather than as an unanswered question.
    low: { type: "number" },
    high: { type: "number" },
    halfWidth: { type: "number" },
    tier: { type: "integer" },
    sharesTier: { type: "integer" },
  },
  required: ["project", "title", "ballots", "adjusted", "rank", "rankRaw", "rankMove"],
};

/**
 * The duel fit, and the comparisons it was fitted from.
 *
 * Extracted from `ranked` because a second surface needs it: `results.confidence` resamples these
 * comparisons and prints intervals beside these strengths, and `bootstrapStrengths` refuses — by
 * design — a fit of comparisons other than the ones handed to it. Two copies of "which comparisons
 * feed the fit" is exactly the way that refusal turns from a guarantee into a 500 nobody predicted,
 * so there is one copy.
 *
 * Comparisons are read here rather than taken from `loadJudgingInput`, which drops skips: the counts
 * on the results response should agree with the dashboard's, and the dashboard needs skips. Filtering
 * to the decided ones happens once, here, in view of the fit that consumes them.
 *
 * The Bradley-Terry fit is attempted only when the event enabled duels and somebody decided one.
 * Fitting an empty comparison graph would produce a table of zeros indistinguishable from a real
 * tie, so absence is `null` and every consumer has to notice.
 */
function duels(ctx: Ctx, event: EventRow): {
  /** Every project a judge could be shown, which is the field the fit ranks. */
  pool: string[];
  decided: Comparison[];
  pairwise: BradleyTerryResult | null;
} {
  const pool = judgeablePool(ctx.db, event.id).map((project) => project.id);
  const decided = allComparisons(ctx.db, event.id)
    .filter((row) => row.outcome !== "skip" && row.winner_id !== null)
    .filter((row) => ctx.db.get<{ excluded: number | null }>(
      "select evidence_excluded_at as excluded from membership where event_id = :e and account_id = :a and role = 'judge'",
      { e: event.id, a: row.judge_id },
    )?.excluded == null)
    .map((row) => ({
      id: row.id,
      judge: row.judge_id,
      left: row.left_id,
      right: row.right_id,
      winner: row.winner_id as string,
    }));
  return {
    pool,
    decided,
    pairwise:
      event.pairwise_enabled === 1 && decided.length > 0 ? fitBradleyTerry(decided, pool) : null,
  };
}

/**
 * The two fits, and the honest empty answer when there is nothing to fit.
 *
 * Which readers run is decided by what is published, not by hope. `loadJudgingInput` insists on a
 * published rubric and would throw `rubric.unpublished` — right for a *rubric* ranking, wrong as
 * the answer to "show me the results", because an event running pure pairwise never publishes one
 * and still has a ranking. So the rubric side is skipped when no version is published and
 * `rubricVersion` comes back `null`, which is the honest way to say a ranking names no rubric.
 *
 * Zero submitted ballots is not an error either: it is an event that has not been judged yet, and
 * the caller gets an empty ranking rather than a refusal for a state nobody did anything wrong to
 * reach.
 *
 * The two read-only passes over the fit — `panelReliability` and `criterionInsights` — run here for
 * the same reason the fit does: three callers need them and none of them should pay for a second
 * normalization. Both are guarded on the fit having produced projects, because both throw when it
 * has not (`reliability.unfitted`, `criteria.empty`) and a 500 is the wrong answer to "this event
 * has one draft ballot". They are computed even for the public surface, because the intervals are
 * public; what differs by audience is which fields the response carries, and that is decided at the
 * boundary rather than here.
 *
 * `input` and `decided` are the raw materials rather than fits of them, and they are returned for one
 * caller: the dashboard's calibration pass reads the ballots themselves and refits the duels once per
 * judge. Handing it these two rather than letting it load its own is not a saving, it is a
 * correctness property — `judgeCalibration` measures each judge against a consensus built from the
 * same comparisons the published ranking came from, and a second read that filtered skips slightly
 * differently would make the two disagree about what the panel decided.
 */
function computeRanking(ctx: Ctx, event: EventRow): {
  rubricVersion: number | null;
  /** The rubric and the submitted ballots, as the engine sees them. `null` when none is published. */
  input: { rubric: Rubric; ballots: Ballot[] } | null;
  rubric: NormalizationResult | null;
  pairwise: BradleyTerryResult | null;
  /** Uncertainty, tiers and outliers for the rubric fit. `null` whenever `rubric` is. */
  reliability: ReliabilityResult | null;
  /** Per-criterion behaviour. Organizer-only at every boundary; see the file header. */
  criteria: CriteriaResult | null;
  ballots: number;
  /** Comparisons that fed the fit: decided ones. The dashboard's `comparisons` counts skips too. */
  decided: Comparison[];
} {
  const duel = duels(ctx, event);
  const input =
    publishedVersion(ctx.db, event.id) === undefined ? null : loadJudgingInput(ctx.db, event.id);
  const rubric =
    input === null || input.ballots.length === 0
      ? null
      : normalizeScores(input.rubric, input.ballots);
  const described = input !== null && rubric !== null && rubric.projects.length > 0;
  return {
    rubricVersion: input?.rubricVersion ?? null,
    input: input === null ? null : { rubric: input.rubric, ballots: input.ballots },
    rubric,
    pairwise: duel.pairwise,
    reliability: described
      ? panelReliability(
          (input as NonNullable<typeof input>).rubric,
          (input as NonNullable<typeof input>).ballots,
          rubric as NormalizationResult,
        )
      : null,
    criteria: described
      ? criterionInsights(
          (input as NonNullable<typeof input>).rubric,
          (input as NonNullable<typeof input>).ballots,
          rubric,
        )
      : null,
    ballots: input?.ballots.length ?? 0,
    decided: duel.decided,
  };
}

// Cache model inputs and fits only. Authorization and audience redaction run on every request.
// Every ranking-affecting repository mutation advances the ledger, including rubric edits.
// Weak ownership releases closed databases; a bounded map limits multi-event memory usage.
const rankingCache = new WeakMap<Ctx["db"], Map<string, { revision: string; fit: ReturnType<typeof computeRanking> }>>();
const diagnosticCache = new RevisionCache();
function ranked(ctx: Ctx, event: EventRow): ReturnType<typeof computeRanking> {
  let cache = rankingCache.get(ctx.db);
  if (!cache) { cache = new Map(); rankingCache.set(ctx.db, cache); }
  const revision = headHash(ctx.db);
  const cached = cache.get(event.id);
  if (cached?.revision === revision) return cached.fit;
  const fit = computeRanking(ctx, event);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(event.id, { revision, fit });
  return fit;
}

/**
 * The ranking as rows a page can print, titles included.
 *
 * The engine speaks in project ids because it knows nothing about this database. Joining the titles
 * back on happens here, once, rather than in each of the two callers — and a project the engine
 * scored but the pool no longer contains (withdrawn mid-judging) keeps its row with the title it had,
 * because dropping it would make the ranks skip a number with no explanation.
 *
 * The interval fields are spread in from the reliability pass rather than recomputed, and they are
 * spread *conditionally*: a project with no interval gets no `low` key rather than a `low` of its own
 * score. An absent field is a question a client knows it has not been given an answer to; a zero-width
 * interval is a claim of certainty nothing in this system supports.
 *
 * The pairwise-only branch follows the same rule one level down. A Bradley-Terry strength is the
 * parameter that best explains who beat whom; it is not the mean of a set of scores and it has no
 * standard error here, so those two keys are omitted rather than sent as zeros. `ballots: 0` stays,
 * because that one really is a count: nobody filed a rubric ballot for this project.
 */
function rows(
  ctx: Ctx,
  event: EventRow,
  fit: NormalizationResult | null,
  pairwise: BradleyTerryResult | null,
  reliability: ReliabilityResult | null = null,
): Record<string, unknown>[] {
  const titleOf = titles(ctx, event);
  const spans = new Map<string, ProjectInterval>(
    (reliability?.intervals ?? []).map((interval) => [interval.project, interval]),
  );
  const span = (id: string): Record<string, number> => {
    const found = spans.get(id);
    if (found === undefined) return {};
    return {
      low: found.low,
      high: found.high,
      halfWidth: found.halfWidth,
      tier: found.tier,
      sharesTier: found.sharesTier,
    };
  };
  if (fit !== null) {
    return fit.projects
      .slice()
      .sort((a, b) => a.rankAdjusted - b.rankAdjusted)
      .map((score) => ({
        project: score.project,
        ...titleOf(score.project),
        ballots: score.ballots,
        rawMean: score.rawMean,
        adjusted: score.adjusted,
        standardError: score.standardError,
        rank: score.rankAdjusted,
        rankRaw: score.rankRaw,
        rankMove: score.rankMove,
        ...span(score.project),
      }));
  }
  // No rubric ballots at all. An event running pure pairwise still has a ranking, and reporting
  // nothing because one of the two methods is unused would be a blank page for a judged event.
  if (pairwise === null) return [];
  return pairwise.strengths
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((strength) => ({
      project: strength.project,
      ...titleOf(strength.project),
      ballots: 0,
      adjusted: strength.beta,
      rank: strength.rank,
      rankRaw: strength.rank,
      rankMove: 0,
    }));
}

/**
 * Project ids to titles, for the four places that need it.
 *
 * A closure over the event rather than a free function because every caller is already inside one
 * event and the alternative is passing `ctx` and `event` through four map callbacks. A project the
 * engine scored but this event no longer lists comes back as its own id, which is ugly on a page and
 * correct: the number is real, and inventing a title for it would be worse than showing the key.
 */
function titles(ctx: Ctx, event: EventRow): (id: string) => { title: string; trackKey: string | null } {
  const projects = new Map(listProjects(ctx.db, event.id).map((project) => [project.id, project]));
  return (id: string) => {
    const project = projects.get(id);
    return { title: project?.title ?? id, trackKey: project?.track_key ?? null };
  };
}

const STRENGTH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project: { type: "string" },
    title: { type: "string" },
    trackKey: { type: ["string", "null"] },
    beta: { type: "number" },
    wins: { type: "integer" },
    losses: { type: "integer" },
    comparisons: { type: "integer" },
    rank: { type: "integer" },
  },
  required: ["project", "title", "beta", "wins", "losses", "comparisons", "rank"],
};

const PAIRWISE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    method: { type: "string" },
    converged: { type: "boolean" },
    iterations: { type: "integer" },
    connected: { type: "boolean" },
    componentCount: { type: "integer" },
    warnings: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: STRENGTH_SCHEMA },
  },
  required: ["method", "converged", "connected", "componentCount", "strengths"],
};

const JUDGE_PROGRESS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    judge: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    assigned: { type: "integer" },
    submitted: { type: "integer" },
    drafts: { type: "integer" },
    comparisons: { type: "integer" },
    skipped: { type: "integer" },
    lastActiveAt: { type: ["integer", "null"] },
  },
  required: ["judge", "name", "assigned", "submitted", "drafts", "comparisons", "skipped"],
};

const JUDGE_EFFECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    judge: { type: "string" },
    name: { type: "string" },
    ballots: { type: "integer" },
    leniency: { type: "number" },
    scale: { type: "number" },
    scaleRaw: { type: "number" },
    shrinkage: { type: "number" },
    informationWeight: { type: "number" },
    clamped: { type: "boolean" },
    discrimination: { type: "string", enum: ["ok", "low", "insufficient"] },
  },
  required: ["judge", "name", "ballots", "leniency", "scale", "shrinkage", "discrimination"],
};

const COVERAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project: { type: "string" },
    title: { type: "string" },
    trackKey: { type: ["string", "null"] },
    assigned: { type: "integer" },
    submitted: { type: "integer" },
    drafts: { type: "integer" },
    target: { type: "integer" },
    short: { type: "integer" },
    comparisons: { type: "integer" },
  },
  required: ["project", "title", "assigned", "submitted", "target", "short"],
};

/** The duel fit as rows, best first. Published wherever the rubric ranking is. */
function pairwiseJson(
  ctx: Ctx,
  event: EventRow,
  fit: BradleyTerryResult,
): Record<string, unknown> {
  const titleOf = titles(ctx, event);
  return {
    method: fit.method,
    converged: fit.converged,
    iterations: fit.iterations,
    connected: fit.connected,
    componentCount: fit.componentCount,
    warnings: forPublic(ctx, event, fit.warnings),
    strengths: fit.strengths
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((strength) => ({
        project: strength.project,
        ...titleOf(strength.project),
        beta: strength.beta,
        wins: strength.wins,
        losses: strength.losses,
        comparisons: strength.comparisons,
        rank: strength.rank,
      })),
  };
}

const AGREEMENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    tau: { type: "number" },
    threshold: { type: "integer" },
    medianGap: { type: "number" },
    flaggedCount: { type: "integer" },
    topOverlap: {
      type: "array",
      items: {
        type: "object",
        properties: { k: { type: "integer" }, overlap: { type: "number" } },
        required: ["k", "overlap"],
      },
    },
    disagreements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          project: { type: "string" },
          title: { type: "string" },
          rubricRank: { type: "integer" },
          pairwiseRank: { type: "integer" },
          rankGap: { type: "integer" },
          ballots: { type: "integer" },
          comparisons: { type: "integer" },
        },
        required: ["project", "title", "rubricRank", "pairwiseRank", "rankGap"],
      },
    },
    rubricOnly: { type: "array", items: { type: "string" } },
    pairwiseOnly: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["tau", "threshold", "medianGap", "flaggedCount", "topOverlap", "disagreements"],
};

/**
 * The panel's warnings with the judges taken out of them, for the public page.
 *
 * The engine writes warnings like "Judge 01J… filed 5 ballots with a fitted scale of -0.30 — they
 * are barely separating projects", which is an appraisal of a volunteer and exactly what the header
 * of this file promises never to publish. Filtering those warnings out was the other option and it
 * is worse: `converged` and `warnings` are published whether or not they flatter the event, and
 * silently dropping the ones that are inconvenient is the same failure with better manners.
 *
 * So the caveat survives and the name does not. Every judge id is replaced by a positional label,
 * and the substitution is **total rather than best-effort**: the ids come from the event's judge
 * roster, which is a superset of the judges any fit could have mentioned, so there is no phrasing
 * a future warning could use that would leak one. `tests/api.test.ts` holds that by asserting no
 * public response contains a roster id.
 *
 * Two passes per judge, and the first one is only for grammar: `normalize.ts` writes "Judge <id>",
 * so replacing the bare id alone yields "Judge Judge C". The `Judge <id>` form is collapsed first and
 * the bare id second, which keeps the guarantee — the second pass catches any phrasing at all — while
 * the sentence still reads like English.
 *
 * Applied at every public boundary rather than only at the one that currently needs it — through
 * `forPublic`, which is what the surfaces actually call. Today `normalize.ts` and `bootstrap.ts` name
 * judges; `bradleyterry.ts`, `agreement.ts` and `bootstrap.ts` name projects. Routing every warning
 * array through one function costs nothing when there is nothing to replace and means a warning added
 * to any of those files later cannot quietly become a leak.
 *
 * Labels run A, B, C… in roster order — display name, then id, which is `membersOf`'s ordering. That
 * is stable within an event and means nothing outside it, so two events' "Judge B" are unrelated.
 */
function withoutJudges(ctx: Ctx, event: EventRow, warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  const label = (index: number): string => {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const first = letters[index % 26] as string;
    return index < 26 ? `Judge ${first}` : `Judge ${first}${Math.floor(index / 26)}`;
  };
  const roster = ctx.db.all<{ id: string }>(
    `select a.id from membership m join account a on a.id = m.account_id
      where m.event_id = :e and m.role = 'judge' order by a.display_name, a.id`,
    { e: event.id },
  );
  return warnings.map((warning) => {
    let text = warning;
    for (const [index, judge] of roster.entries()) {
      const name = label(index);
      text = text.split(`Judge ${judge.id}`).join(name);
      text = text.split(judge.id).join(name);
    }
    return text;
  });
}

/**
 * The other half of the same problem: a warning that names a project names it by id.
 *
 * `bradleyterry.ts`, `agreement.ts` and `bootstrap.ts` all write sentences with a project id in
 * them, because the engine is given ids and has no titles to write. Published unchanged, the
 * result is a caveat like "01M1RSG9TT68SSRR4YVKS2Z2JK moves across at least half the field", which
 * is a true statement nobody can act on — the reader would have to find the ULID in a table that
 * prints titles. It is the same class of defect as publishing a judge id, with the opposite fix:
 * a project's name is exactly what should be there.
 *
 * Every project in the event rather than only the judgeable pool, because a warning can outlive a
 * project's eligibility — a fit runs on the ballots that exist, and a project disqualified after
 * being scored is still named in the sentence that qualifies the score.
 *
 * Longest id first, which costs a sort and buys the guarantee that no substitution can be a prefix
 * of another. Ids are all the same length today; that is a property of the generator, not of this
 * function, and the sort means changing the generator cannot silently corrupt a sentence.
 */
function withTitles(ctx: Ctx, event: EventRow, texts: readonly string[]): string[] {
  if (texts.length === 0) return [];
  const projects = listProjects(ctx.db, event.id)
    .slice()
    .sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id));
  return texts.map((text) => {
    let out = text;
    for (const project of projects) out = out.split(project.id).join(project.title);
    return out;
  });
}

/**
 * The public spelling of anything the engine wrote: no judge named, every project named.
 *
 * One entry point rather than two calls at five sites, so a surface added later cannot get half of
 * the treatment. The order matters in one direction only — a project title could in principle
 * contain the text "Judge <id>", and running the judge pass first means a title is never rewritten
 * by it.
 */
function forPublic(ctx: Ctx, event: EventRow, texts: readonly string[]): string[] {
  return withTitles(ctx, event, withoutJudges(ctx, event, texts));
}

/**
 * How far the two methods agree, and which projects they disagree about.
 *
 * This is the single most useful thing on the page for anybody deciding whether to believe the
 * ranking, which is why it is public: a tau of 0.9 and an empty disagreement list is evidence, and a
 * tau of 0.2 is a warning the organizer should have to publish rather than discover. It names
 * projects, never judges, so it says nothing about a person.
 *
 * **`blended` and `blendedRank` are dropped on the way out.** `compareRankings` computes them, and
 * `src/judging/agreement.ts` says in its own header that they are presentational. Publishing one
 * would put a third ranking on the page at a weight nobody chose — 0.5, because that is the
 * library default — and a field that looks like a verdict will be read as one. The two rankings and
 * the distance between them are the honest content.
 *
 * `null` when there is nothing to compare. `compareRankings` throws when the two fits share no
 * project, which happens for real — a rubric round on the whole field and a duel round that never
 * started — and a thrown `JudgingError` there would turn a legitimately half-judged event into a
 * 500. Checked rather than caught, because the condition is cheap to test and a `catch` around a
 * whole call cannot tell that failure from any other.
 */
function agreementJson(
  ctx: Ctx,
  event: EventRow,
  rubric: NormalizationResult,
  pairwise: BradleyTerryResult,
): Record<string, unknown> | null {
  const scored = new Set(rubric.projects.map((score) => score.project));
  if (!pairwise.strengths.some((strength) => scored.has(strength.project))) return null;
  const result = compareRankings(rubric, pairwise);
  const titleOf = titles(ctx, event);
  return {
    tau: result.tau,
    threshold: result.threshold,
    medianGap: result.medianGap,
    flaggedCount: result.flaggedCount,
    topOverlap: [...result.topOverlap.entries()].map(([k, overlap]) => ({ k, overlap })),
    disagreements: result.disagreements.map((project) => ({
      project: project.project,
      ...titleOf(project.project),
      rubricRank: project.rubricRank,
      pairwiseRank: project.pairwiseRank,
      rankGap: project.rankGap,
      ballots: project.ballots,
      comparisons: project.comparisons,
    })),
    rubricOnly: result.rubricOnly,
    pairwiseOnly: result.pairwiseOnly,
    warnings: forPublic(ctx, event, result.warnings),
  };
}

/**
 * The ranking, to whoever is allowed to see it.
 *
 * The gate is in the handler and not in `capability`, for the reason the file header gives: the
 * dispatcher applies a declared gate before it knows the caller's role, so `gate: "results"` would
 * lock the organizer out of the page they need in order to decide whether to publish. `assertGate`
 * is still what throws, so there is one definition of `results.notPublic` and one message.
 *
 * `published` is on the response even though an unpublished ranking is only ever visible to an
 * organizer, because the page that renders it has to be able to say "this is a preview" in a banner.
 * A preview that looks identical to the published page is how an organizer announces a winner from a
 * ranking the world cannot see.
 *
 * `converged` with no fit at all is `true`: nothing ran, so nothing failed to converge. That reads
 * oddly on its own, which is why `warnings` carries a sentence saying the event has not been judged.
 */
export const liveShow = defineCommand({
  name: "results.show",
  summary: "Show the ranking, once an organizer has published it.",
  method: "GET",
  path: "/api/events/:event/results",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF, revision: { kind: "int", min: 1, optional: true,
    label: "Publication revision", help: "Leave blank for the latest frozen publication." } },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        event: {
          type: "object",
          properties: { slug: { type: "string" }, name: { type: "string" } },
          required: ["slug", "name"],
        },
        published: { type: "boolean" },
        revision: { type: "integer" },
        evidenceCutoffAt: { type: "integer" },
        evidenceDigest: { type: "string" },
        mayPublish: { type: "boolean" },
        method: { type: "string" },
        rubricVersion: { type: ["integer", "null"] },
        ballots: { type: "integer" },
        comparisonsDecided: { type: "integer" },
        converged: { type: "boolean" },
        grandMean: { type: ["number", "null"] },
        residualSd: { type: ["number", "null"] },
        warnings: { type: "array", items: { type: "string" } },
        projects: { type: "array", items: PROJECT_SCORE_SCHEMA },
        panel: { ...PANEL_SCHEMA, type: ["object", "null"] },
        pairwise: { ...PAIRWISE_SCHEMA, type: ["object", "null"] },
        agreement: { ...AGREEMENT_SCHEMA, type: ["object", "null"] },
      },
      required: [
        "event",
        "published",
        "method",
        "ballots",
        "comparisonsDecided",
        "converged",
        "warnings",
        "projects",
      ],
    },
  },
  notes:
    "Organizers can read this before publishing, as a preview. Everybody else gets " +
    "`results.notPublic` until `results.publish` has been called. Judge leniency and scale are not " +
    "on this response at any role: see `events.dashboard`. `panel` and the per-project `tier` say " +
    "how much of the order the evidence supports: a tier holds the projects that are not separated " +
    "from the one at the top of it.",
  handler: ({ ctx, event, roles }) => {
    const row = event as EventRow;
    const organizer = roles.includes("organizer");
    if (!organizer) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const fit = ranked(ctx, row);
    const warnings = [...(fit.rubric?.warnings ?? []), ...(fit.pairwise?.warnings ?? [])];
    if (fit.ballots === 0 && fit.decided.length === 0) {
      warnings.push("Nothing has been judged yet, so this ranking is empty.");
    } else if (fit.rubric === null) {
      warnings.push("Ranked from duels alone: no rubric ballots have been submitted.");
    } else if (fit.pairwise === null && row.pairwise_enabled === 1) {
      warnings.push(
        "Duels are enabled but none have been decided, so there is nothing to check this ranking against.",
      );
    }
    // The reliability pass writes its own caveats — a panel that cannot separate the field, a
    // reliability below the threshold — and they belong in the same list as the fit's. A caveat
    // filed under a heading the reader has to go looking for is a caveat that was not published.
    warnings.push(...(fit.reliability?.warnings ?? []));
    const fits = [fit.rubric?.converged, fit.pairwise?.converged].filter(
      (converged) => converged !== undefined,
    );
    return {
      event: { slug: row.slug, name: row.name },
      published: row.results_public !== 0,
      // Which of the two switches the page should offer, and the answer to "am I looking at a
      // preview" for a JSON client. It draws a form and protects nothing: `results.publish`
      // refuses a non-organizer either way.
      mayPublish: organizer,
      method: fit.rubric?.method ?? fit.pairwise?.method ?? "none",
      rubricVersion: fit.rubricVersion,
      ballots: fit.ballots,
      comparisonsDecided: fit.decided.length,
      converged: fits.every((converged) => converged === true),
      grandMean: fit.rubric?.grandMean ?? null,
      residualSd: fit.rubric?.residualSd ?? null,
      warnings: forPublic(ctx, row, warnings),
      projects: rows(ctx, row, fit.rubric, fit.pairwise, fit.reliability),
      panel: fit.reliability === null ? null : panelJson(fit.reliability),
      pairwise: fit.pairwise === null ? null : pairwiseJson(ctx, row, fit.pairwise),
      agreement:
        fit.rubric === null || fit.pairwise === null
          ? null
          : agreementJson(ctx, row, fit.rubric, fit.pairwise),
    };
  },
});

/** Private frozen review details are served only through the participant's team scope. */
function publicReport(serialized: string): Record<string, unknown> {
  const { _explanations, ...report } = JSON.parse(serialized) as Record<string, unknown>;
  return report;
}

/** Public reads use the persisted revision; the organizer dashboard remains live. */
export const show: Command = {
  ...liveShow,
  handler: (call) => {
    const row = call.event as EventRow;
    const organizer = call.roles.includes("organizer");
    if (!organizer) { assertVotingClosed(row, call.ctx.now()); assertGate(row, call.ctx.now(), "results"); }
    const selected = typeof call.input.revision === "number" ? call.input.revision : null;
    if (selected !== null) {
      const historical = call.ctx.db.get<{ report: string }>(
        "select report from result_publication where event_id = :e and revision = :r",
        { e: row.id, r: selected });
      if (!historical) throw new RuleError("publication.missing", "That publication revision does not exist.");
      return { ...publicReport(historical.report), mayPublish: organizer };
    }
    if (row.results_public !== 0) {
      const publication = latestPublication(call.ctx.db, row.id);
      if (publication) return { ...publicReport(publication.report),
        mayPublish: organizer };
      if (!organizer) throw new RuleError("results.noSnapshot",
        "This upgraded event needs an organizer to publish a frozen result revision.");
    }
    return liveShow.handler(call);
  },
};

const CONFIDENCE_INTERVAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project: { type: "string" },
    title: { type: "string" },
    trackKey: { type: ["string", "null"] },
    rank: { type: "integer" },
    beta: { type: "number" },
    comparisons: { type: "integer" },
    placed: {
      type: "boolean",
      description:
        "Whether any comparison mentions this project. When false every other number on the " +
        "row describes where the middle of the field is, not where the project stands.",
    },
    standardError: { type: "number" },
    low: { type: "number" },
    high: { type: "number" },
    rankMean: { type: "number" },
    rankLow: { type: "integer" },
    rankHigh: { type: "integer" },
    rankStability: { type: "number" },
    firstPlaceShare: { type: "number" },
    tier: { type: "integer", description: "1-based, and 0 for a project no comparison mentions." },
    sharesTier: {
      type: "integer",
      description:
        "How many other projects share its tier. Sharing a tier means not being separated from " +
        "the project that opened it, which does not compose: read `pairs` for a boundary.",
    },
  },
  required: [
    "project",
    "title",
    "rank",
    "beta",
    "comparisons",
    "placed",
    "standardError",
    "low",
    "high",
    "rankStability",
    "tier",
    "sharesTier",
  ],
};

const CONFIDENCE_PAIR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    above: { type: "string" },
    aboveTitle: { type: "string" },
    below: { type: "string" },
    belowTitle: { type: "string" },
    betaGap: { type: "number" },
    reversalShare: {
      type: "number",
      description: "Share of resamples that put the lower project above the higher one.",
    },
    ordered: { type: "boolean", description: "Whether the evidence separates the pair at all." },
  },
  required: ["above", "aboveTitle", "below", "belowTitle", "betaGap", "reversalShare", "ordered"],
};

const RESAMPLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    method: { type: "string" },
    unit: { type: "string", enum: ["judge", "comparison"] },
    unitRequested: { type: "string", enum: ["judge", "comparison"] },
    seed: { type: "string", description: "Published so the intervals can be re-derived." },
    confidence: { type: "number" },
    replicates: { type: "integer" },
    replicatesRequested: { type: "integer" },
    replicatesConverged: { type: "integer" },
    replicatesDisconnected: { type: "integer" },
    resolution: { type: "number", description: "The finest share this many replicates resolve." },
    threshold: { type: "number", description: "The share a reversal must stay under to be ordered." },
    tiers: { type: "integer" },
    unplaced: { type: "integer" },
    decisive: { type: "boolean", description: "Whether first place is separated from second." },
    orderAgreement: { type: "number" },
    orderStability: { type: "number" },
    projects: { type: "array", items: CONFIDENCE_INTERVAL_SCHEMA },
    pairs: { type: "array", items: CONFIDENCE_PAIR_SCHEMA },
    notes: { type: "array", items: DIAGNOSTIC_SCHEMA },
  },
  required: [
    "method",
    "unit",
    "seed",
    "confidence",
    "replicates",
    "resolution",
    "threshold",
    "tiers",
    "unplaced",
    "decisive",
    "orderAgreement",
    "projects",
    "pairs",
    "notes",
  ],
};

/**
 * The resample as rows, with titles joined on and judges taken out.
 *
 * `bootstrapStrengths` has one note that carries judge ids in `subjects` — the single-judge fallback
 * — and this is a public surface, so the ids go through `withoutJudges` exactly as the messages do.
 * One flat array rather than a call per note, because `withoutJudges` reads the roster each time and
 * a page of eight notes should not cost nine queries to say the same thing.
 */
function resampleJson(
  ctx: Ctx,
  event: EventRow,
  fit: BootstrapResult,
): Record<string, unknown> {
  const titleOf = titles(ctx, event);
  return {
    method: fit.method,
    unit: fit.unit,
    unitRequested: fit.unitRequested,
    seed: fit.seed,
    confidence: fit.confidence,
    replicates: fit.replicates,
    replicatesRequested: fit.replicatesRequested,
    replicatesConverged: fit.replicatesConverged,
    replicatesDisconnected: fit.replicatesDisconnected,
    resolution: fit.resolution,
    threshold: fit.threshold,
    tiers: fit.tiers,
    unplaced: fit.unplaced,
    decisive: fit.decisive,
    orderAgreement: fit.orderAgreement,
    orderStability: fit.orderStability,
    projects: fit.intervals.map((interval) => ({
      project: interval.project,
      ...titleOf(interval.project),
      rank: interval.rank,
      beta: interval.beta,
      comparisons: interval.comparisons,
      placed: interval.placed,
      standardError: interval.standardError,
      low: interval.low,
      high: interval.high,
      rankMean: interval.rankMean,
      rankLow: interval.rankLow,
      rankHigh: interval.rankHigh,
      rankStability: interval.rankStability,
      firstPlaceShare: interval.firstPlaceShare,
      tier: interval.tier,
      sharesTier: interval.sharesTier,
    })),
    pairs: fit.pairs.map((pair) => ({
      above: pair.above,
      aboveTitle: titleOf(pair.above).title,
      below: pair.below,
      belowTitle: titleOf(pair.below).title,
      betaGap: pair.betaGap,
      reversalShare: pair.reversalShare,
      ordered: pair.ordered,
    })),
    notes: publicNotes(ctx, event, fit.notes),
  };
}

/**
 * Coded notes, with judges out of everything and titles into the prose.
 *
 * The two halves of a note are treated differently on purpose. `message` is for a person, so a
 * project appears in it by title; `subjects` is for a client that wants to highlight the rows a
 * note is about, so a project stays an id there. Judge ids are replaced in both, because there is
 * no reader this deployment publishes those to.
 *
 * One flat array for the judge pass rather than a call per note, because it reads the roster each
 * time and a page of eight notes should not cost nine queries to say the same thing. The title pass
 * then runs over the message slots alone.
 */
function publicNotes(
  ctx: Ctx,
  event: EventRow,
  notes: readonly Diagnostic[],
): Record<string, unknown>[] {
  const flat = withoutJudges(ctx, event, notes.flatMap((note) => [note.message, ...note.subjects]));
  // Where each note's message landed in the flat array: one slot for the message plus one per
  // subject, accumulated.
  const offset: number[] = [];
  let cursor = 0;
  for (const note of notes) {
    offset.push(cursor);
    cursor += 1 + note.subjects.length;
  }
  const readable = withTitles(ctx, event, offset.map((at) => flat[at] as string));
  return notes.map((note, index) => ({
    code: note.code,
    severity: note.severity,
    message: readable[index] as string,
    subjects: flat.slice((offset[index] as number) + 1, (offset[index] as number) + 1 + note.subjects.length),
  }));
}

/**
 * How much of the pairwise order the comparisons actually establish.
 *
 * A separate operation from `results.show` rather than another block on it, for one reason: this is
 * the expensive question. `bootstrapStrengths` refits the whole ranking a few hundred times, which is
 * around a second of arithmetic that cannot be interrupted, and putting it on the page every visitor
 * loads would make the leaderboard the slowest thing in the deployment. `results.show` keeps the
 * cheap analytic intervals from the ballot fit and links here for the duel side.
 *
 * **`confidence` is an enum and not a number.** A caller who asks for 0.999 from 60 replicates gets
 * an interval whose stated coverage the resample cannot deliver — the tail lands finer than
 * `1 / replicates` and both the endpoints and the pair test silently harden. The engine reports that
 * as `bootstrap.coarse` rather than hiding it, but a three-value enum stops most of it happening at
 * all, and 90/95/99 are the three a reader can interpret without being told what a tail is.
 *
 * **It spends from `analyse`, not from `read`.** Twenty a minute per event against six hundred, for
 * the reason the bucket's own comment gives: this process is single-threaded and a second of
 * uninterruptible arithmetic is a second nobody else is served. The key is the event rather than the
 * caller, because the cost is a property of the field being resampled.
 *
 * **The gate is in the handler, as it is for `results.show`.** A declared `gate: "results"` is applied
 * before the dispatcher knows the caller's role and would lock the organizer out of the preview they
 * need in order to decide whether to publish. `assertGate` is still what throws, so `results.notPublic`
 * has one definition.
 *
 * Nothing here names a judge. The intervals and the pair table are about projects; `panelSize` says
 * how many people filed comparisons without saying who; and the one engine note that carries judge
 * ids goes through `publicNotes`.
 *
 * The cut line: **there is no per-track resample.** The fit is over the whole field, so the intervals
 * are too, and a track winner is read off this table by filtering it on `trackKey`. Resampling a
 * track alone would estimate a panel's disagreement from the handful of judges who happened to see
 * that track, and report a narrower interval than the evidence supports.
 */
export const confidence = defineCommand({
  name: "results.confidence",
  summary: "Say which parts of the duel ranking the comparisons establish, and which are a tie.",
  method: "GET",
  path: "/api/events/:event/results/confidence",
  capability: { audience: "public", scope: "event" },
  input: {
    event: EVENT_REF,
    replicates: {
      kind: "int",
      min: 50,
      max: 2000,
      fallback: BOOTSTRAP_DEFAULTS.replicates,
      label: "Resamples",
      help: "How many times to refit the ranking on resampled data. More is finer and slower; the default resolves a quarter of a percentage point.",
    },
    confidence: {
      kind: "enum",
      values: ["0.9", "0.95", "0.99"],
      fallback: String(BOOTSTRAP_DEFAULTS.confidence),
      label: "Confidence",
      help: "How much of the resampled spread each interval should cover. A higher level separates fewer pairs, because it demands more evidence to call one project ahead of another.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        event: {
          type: "object",
          properties: { slug: { type: "string" }, name: { type: "string" } },
          required: ["slug", "name"],
        },
        published: { type: "boolean" },
        comparisonsDecided: { type: "integer" },
        projects: { type: "integer", description: "Projects in the field the fit ranks." },
        panelSize: {
          type: "integer",
          description: "Judges who decided at least one duel. The unit the resample draws from.",
        },
        resample: { ...RESAMPLE_SCHEMA, type: ["object", "null"] },
        warnings: { type: "array", items: { type: "string" } },
      },
      required: [
        "event",
        "published",
        "comparisonsDecided",
        "projects",
        "panelSize",
        "warnings",
      ],
    },
  },
  limit: "analyse",
  limitKey: ({ input }) => String(input.event ?? ""),
  notes:
    "Resamples the panel to ask whether another panel would have produced this order. `pairs` is " +
    "the answer to \"is first place real\": a pair with `ordered: false` is two projects the " +
    "comparisons cannot separate, however far apart they sit in the table. A `tier` holds the " +
    "projects that are not separated from the one at the top of it, which is the unit to award on; " +
    "two projects can share a tier and still be separated from each other, so `pairs` is where a " +
    "boundary is established. Organizers can read this before publishing; everybody else " +
    "gets `results.notPublic` until then. Costs about a second and is limited to 20 a minute per " +
    "event.",
  handler: ({ ctx, input, event, roles }) => {
    const row = event as EventRow;
    if (!roles.includes("organizer")) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const duel = duels(ctx, row);
    const panel = new Set(duel.decided.map((comparison) => comparison.judge)).size;
    const warnings: string[] = [];
    if (row.pairwise_enabled !== 1) {
      warnings.push(
        "This event does not collect duels, so there is no pairwise ranking to resample. The " +
          "ballot ranking carries its own intervals on the results page.",
      );
    } else if (duel.pairwise === null) {
      warnings.push(
        "No duels have been decided yet, so there is nothing to resample. This page becomes " +
          "useful once judges start comparing projects.",
      );
    }
    const fit =
      duel.pairwise === null
        ? null
        : bootstrapStrengths(duel.decided, duel.pairwise, {
            replicates: Number(input.replicates),
            confidence: Number(input.confidence),
            // Half the engine default. A web request holding the only thread for two seconds is
            // worse for everybody than an interval that admits it was coarsened, and the engine
            // says so through `bootstrap.replicatesReduced` when the budget bites.
            workBudget: 300_000,
            // Seeded on the event, so two organizers looking at the same event see the same
            // intervals and a refresh does not move a tier boundary. Not on the comparison set:
            // an interval that changed seed every time a judge filed a duel would be a different
            // number for a different reason each time somebody asked.
            seed: `${BOOTSTRAP_DEFAULTS.seed}|${row.id}`,
          });
    return {
      event: { slug: row.slug, name: row.name },
      published: row.results_public !== 0,
      comparisonsDecided: duel.decided.length,
      projects: duel.pool.length,
      panelSize: panel,
      resample: fit === null ? null : resampleJson(ctx, row, fit),
      warnings: [...warnings, ...(fit === null ? [] : forPublic(ctx, row, fit.warnings))],
    };
  },
});

/**
 * Everything an organizer needs while judging is running, on one page.
 *
 * This is the only place the judge-effect table is published, and it is published in full —
 * leniency, both scales, the shrinkage weight, whether the estimate was clamped, and whether the
 * judge discriminated between projects at all. An organizer chasing a panel needs to be able to see
 * that one judge scored everything a 3 (`discrimination: "insufficient"`), because that judge's
 * ballots carry almost no information and the fix is a conversation, not a coefficient. Names are
 * joined on for the same reason: a table of account ids is a table nobody acts on.
 *
 * Progress and coverage come from SQL rather than from the fit, because they have to be right before
 * anybody has submitted anything and a fit over zero ballots does not exist. `assigned`, `submitted`
 * and `short` therefore agree with what the judge console shows, which is the whole point of a
 * dashboard: two screens disagreeing about "short by two" is worse than one screen.
 *
 * Coverage is whole-event. A track view is a filter of these rows, and a `track` parameter here
 * would produce a page whose judge progress spans the event while its coverage spans one track —
 * two different questions under one heading.
 *
 * This is also the one surface whose `rubric.warnings` keep judge ids rather than positional labels.
 * That is not an oversight: the effect table two fields down already names every judge, so redacting
 * the sentence that explains *why* a judge appears in it would hide the reasoning and keep the name.
 * `results.show` and both publish switches redact; this one does not, and the difference is the
 * audience.
 *
 * `calibration` is the pre-publish read, and it is the field to look at before the ranking. It answers
 * one question per judge — is this judge's part of the panel ready — and it is deliberately the only
 * place in the product where a per-judge *finding* is printed. The effect table beside it says what
 * the fit removed; the calibration table says what somebody should do about it, and each finding is
 * said once, in one place, with the sentence that says what to do beside it.
 */
export const dashboard = defineCommand({
  name: "events.dashboard",
  summary: "Show judging progress, coverage and judge effects for an event.",
  method: "GET",
  path: "/api/events/:event/dashboard",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    lab: { kind: "bool", fallback: false, label: "Run advanced evidence diagnostics" },
    finalists: { kind: "int", min: 1, max: 100, fallback: 3, label: "Finalist places" },
    sensitivity: { kind: "bool", fallback: false, label: "Run reviewer influence analysis" },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        evidenceLab: {
          type: ["object", "null"],
          description: "Opt-in bounded diagnostics: Fisher information geometry, Hodge decomposition, W2 reviewer distributions, and vote signals. Organizer-only; no ranking changes. Cached by ledger revision.",
          properties: {
            information: { type: "object", required: ["status", "report"], properties: {
              status: { type: "string", enum: ["ready", "ill-conditioned", "limit", "needs-converged-fit"] },
              report: { type: ["object", "null"], description: "Likelihood-only Fisher Laplacian. Relative SE is local model curvature, not calibrated confidence; cross-component contrasts are null.", properties: {
                method: { type: "string" }, projectCount: { type: "integer" }, componentCount: { type: "integer" },
                identifiableContrasts: { type: "integer" }, solveResidual: { type: "number" },
                leverageSum: { type: "number" }, leverageError: { type: "number" }, numericallySound: { type: "boolean" },
                pairs: { type: "array", items: { type: "object", properties: {
                  left: { type: "string" }, right: { type: "string" }, comparisons: { type: "integer" },
                  resistance: { type: ["number", "null"] }, relativeSE: { type: ["number", "null"] },
                  informationGain: { type: ["number", "null"] }, leverage: { type: ["number", "null"] },
                  reason: { type: "string", enum: ["bridge", "information"] },
                } } },
                recommendations: { type: "array", items: { type: "object" }, description: "At most eight individual candidate comparisons. Conflicts, track scope and repeat limits must still be enforced by the scheduler." },
                bottlenecks: { type: "array", items: { type: "object" } }, note: { type: "string" },
              } },
            } },
          },
        },
        readiness: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["needs-evidence", "review-needed", "checks-passed"] },
            passed: { type: "integer" }, total: { type: "integer" },
            missing: { type: "integer" }, review: { type: "integer" }, note: { type: "string" },
            checks: { type: "array", items: { type: "object", properties: {
              code: { type: "string" }, status: { type: "string", enum: ["pass", "review", "missing"] },
              title: { type: "string" }, detail: { type: "string" },
            }, required: ["code", "status", "title", "detail"] } },
          }, required: ["status", "passed", "total", "missing", "review", "note", "checks"],
        },
        window: {
          type: "object",
          properties: {
            phase: { type: "string" },
            submissionsOpen: { type: "boolean" },
            judgingOpen: { type: "boolean" },
            resultsPublic: { type: "boolean" },
            archived: { type: "boolean" },
          },
          required: ["phase", "submissionsOpen", "judgingOpen", "resultsPublic"],
        },
        counts: {
          type: "object",
          properties: {
            projects: { type: "integer" },
            judges: { type: "integer" },
            assignments: { type: "integer" },
            ballots: { type: "integer" },
            drafts: { type: "integer" },
            comparisons: { type: "integer" },
            skipped: { type: "integer" },
            reviewsPerProject: { type: "integer" },
            shortProjects: { type: "integer" },
          },
          required: ["projects", "judges", "ballots", "comparisons", "reviewsPerProject"],
        },
        rubric: {
          type: ["object", "null"],
          properties: {
            version: { type: ["integer", "null"] },
            method: { type: "string" },
            rounds: { type: "integer" },
            converged: { type: "boolean" },
            grandMean: { type: "number" },
            residualSd: { type: "number" },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
        judges: { type: "array", items: JUDGE_PROGRESS_SCHEMA },
        effects: { type: "array", items: JUDGE_EFFECT_SCHEMA },
        reliability: { ...RELIABILITY_SCHEMA, type: ["object", "null"] },
        criteria: { ...CRITERIA_SCHEMA, type: ["object", "null"] },
        calibration: { ...CALIBRATION_SCHEMA, type: ["object", "null"] },
        coverage: { type: "array", items: COVERAGE_SCHEMA },
        gaps: { type: "array", items: COVERAGE_SCHEMA },
        pairing: { type: ["object", "null"] },
        pairwise: { ...PAIRWISE_SCHEMA, type: ["object", "null"] },
        agreement: { ...AGREEMENT_SCHEMA, type: ["object", "null"] },
        decisionSupport: { type: "object", properties: {
          target: { type: "integer" },
          decisive: { type: "boolean" },
          candidates: { type: "array", items: { type: "object", properties: {
            project: { type: "string" }, title: { type: "string" }, trackKey: { type: ["string", "null"] },
            status: { type: "string", enum: ["guaranteed", "bubble", "eliminated"] },
            rank: { type: "number" }, fitted: { type: "number" },
            low: { type: "number" }, high: { type: "number" },
            spread: { type: "number" }, reviews: { type: "integer" }, verdict: { type: "string" },
          } } },
          duels: { type: "array", items: { type: "object", properties: {
            left: { type: "string" }, right: { type: "string" }, reason: { type: "string" },
          } } },
          sensitivity: { type: ["object", "null"], description: "Optional bounded leave-one-judge-out refits, diagnostics only." },
        } },
        audit: { type: "object", properties: {
          head: { type: "string" },
          entries: { type: "array", items: { type: "object", properties: {
            seq: { type: "integer" }, at: { type: "integer" }, action: { type: "string" },
            actor: { type: "string" }, subject: { type: "string" }, payload: { type: "string" }, hash: { type: "string" },
          } } },
        } },
      },
      required: ["window", "counts", "judges", "effects", "coverage", "gaps"],
    },
  },
  notes:
    "Organizer-only. The judge-effect table is here and nowhere else: `results.show` publishes " +
    "per-project `rankMove` instead, which shows that normalization happened without naming a judge. " +
    "`reliability` and `criteria` are the read-only passes over the fit — uncertainty and tiers, and " +
    "what each line of the rubric is doing. `results.show` gets the anonymous half of the first and " +
    "none of the second. `calibration` is the pre-publish read on the panel itself: one row per judge " +
    "with a verdict on whether their part of it is ready, and the judge pairs who agreed more than " +
    "these comparisons predict. It is the only place in the product that prints a verdict about a " +
    "person, and it reaches no public surface at any role. Because it exists, `rubric.warnings` is " +
    "panel-level whenever `calibration` is not null: a sentence about one judge belongs in that " +
    "judge's row, with the action beside it, rather than twice on one page.",
  handler: ({ ctx, input, event, gates }) => {
    const row = event as EventRow;
    const titleOf = titles(ctx, row);
    const window = gates as EventGates;
    const pool = judgeablePool(ctx.db, row.id).map((project) => project.id);
    const comparisons = allComparisons(ctx.db, row.id);
    const progress = judgeProgress(ctx.db, row.id);
    const coverage = projectCoverage(ctx.db, row);
    const gaps = coverageGaps(ctx.db, row);
    const fit = ranked(ctx, row);
    const diagnostic = <T>(variant: string, compute: () => T): T =>
      diagnosticCache.get(ctx.db, row.id, headHash(ctx.db), variant, compute);
    const nameOf = new Map(progress.map((judge) => [judge.judgeId, judge.name]));
    const finalistReport = triageFinalists((fit.reliability?.intervals ?? []).map((p) => ({
      project: p.project, fitted: p.adjusted,
      // Preserve the existing t-based intervals instead of silently narrowing them to z intervals.
      standardError: p.halfWidth, rank: fit.rubric?.projects.find((r) => r.project === p.project)?.rankAdjusted ?? 0,
    })), Number(input.finalists), { zMultiplier: 1 });
    const controversy = diagnostic("controversy", () => fit.input === null || fit.input.ballots.length === 0 ? null : detectControversy(fit.input.rubric, fit.input.ballots));
    const controversyOf = new Map((controversy?.projects ?? []).map((p) => [p.project, p]));
    // The roster is the input, not the ballots: a judge who has filed nothing is exactly the judge an
    // organizer needs to see before publishing, and no fit can produce a row for them. Skipped duels
    // arrive as counts here for the same reason — they never reach a fit at all.
    //
    // Guarded on there being a roster because `judgeCalibration` refuses an empty one, and an event
    // whose invitations are still out is not a caller error.
    const calibration =
      progress.length === 0
        ? null
        : diagnostic("calibration", () => judgeCalibration({
            rubric: fit.input?.rubric ?? null,
            ballots: fit.input?.ballots ?? [],
            comparisons: fit.decided,
            workload: progress.map((judge) => ({
              judge: judge.judgeId,
              assigned: judge.assigned,
              submitted: judge.submitted,
              drafts: judge.drafts,
              skipped: judge.skipped,
            })),
            rubricFit: fit.rubric,
            pairwiseFit: fit.pairwise,
            reliability: fit.reliability,
          }));
    // Every per-judge warning the fit produced is said again, and better, in a calibration row: with
    // the judge's name on it, a verdict, and a sentence saying what to do about it. So when there is
    // a calibration table the panel-level list gives up the sentences that name a judge, and when
    // there is not — an event whose invitations are still out has no roster to build one from — it
    // keeps every one of them, because then it is the only place they would be said.
    //
    // Filtered by subject rather than by a list of codes. `notes` carries the subjects of each
    // sentence, so "is this about a person" is a question the data already answers; a code list would
    // quietly start printing twice on the day a new per-judge code is added to the fit.
    const roster = new Set(progress.map((judge) => judge.judgeId));
    const panelWarnings =
      fit.rubric === null
        ? []
        : calibration === null
          ? fit.rubric.warnings
          : fit.rubric.notes
              .filter(
                (note) =>
                  note.severity === "warn" && !note.subjects.some((subject) => roster.has(subject)),
              )
              .map((note) => note.message);
    const sum = (pick: (of: JudgeProgress) => number): number =>
      progress.reduce((total, judge) => total + pick(judge), 0);
    // Nodes are the pool plus anything a duel touched, so a project withdrawn mid-judging still
    // counts as a node of the comparison graph. Otherwise `connected` would report on a graph with
    // edges whose endpoints it never heard of.
    const nodes = [
      ...new Set([...pool, ...comparisons.flatMap((pair) => [pair.left_id, pair.right_id])]),
    ];
    const pairing =
      row.pairwise_enabled !== 1
        ? null
        : pairingProgress(
            nodes,
            comparisons.map((pair) => ({
              judge: pair.judge_id,
              left: pair.left_id,
              right: pair.right_id,
            })),
          );
    const coverageJson = (rows_: readonly ProjectCoverage[]): Record<string, unknown>[] =>
      rows_.map((project) => ({
        project: project.projectId,
        title: project.title,
        trackKey: project.trackKey,
        assigned: project.assigned,
        submitted: project.submitted,
        drafts: project.drafts,
        target: project.target,
        short: project.short,
        comparisons: project.comparisons,
      }));
    return {
      window: {
        phase: window.phase,
        submissionsOpen: window.submissionsOpen,
        judgingOpen: window.judgingOpen,
        resultsPublic: row.results_public !== 0,
        archived: window.archived,
      },
      counts: {
        projects: pool.length,
        judges: progress.length,
        assignments: sum((judge) => judge.assigned),
        ballots: sum((judge) => judge.submitted),
        drafts: sum((judge) => judge.drafts),
        comparisons: comparisons.length,
        skipped: comparisons.filter((pair) => pair.outcome === "skip").length,
        reviewsPerProject: row.reviews_per_project,
        shortProjects: gaps.length,
      },
      evidenceLab: input.lab !== true ? null : diagnostic("lab", () => ({
        information: nodes.length <= 120 && fit.decided.length <= 20000 && fit.pairwise?.converged
          ? (() => {
            try { return { status: "ready", report: comparisonInformation(fit.decided, nodes, new Map(fit.pairwise.strengths.map((p) => [p.project, p.beta]))) }; }
            catch (error) {
              if (error instanceof Error && "code" in error && error.code === "information.singular") return { status: "ill-conditioned", report: null };
              throw error;
            }
          })() : { status: nodes.length > 120 || fit.decided.length > 20000 ? "limit" : "needs-converged-fit", report: null },
        hodge: nodes.length <= 120 && fit.decided.length <= 20000 ? decomposeTournament(fit.decided, nodes) : null,
        hodgeLimit: nodes.length > 120 || fit.decided.length > 20000,
        distributions: fit.input && fit.input.ballots.length <= 10000 ? distributionCalibration(fit.input.rubric, fit.input.ballots) : null,
        distributionLimit: (fit.input?.ballots.length ?? 0) > 10000,
        voting: (() => {
          const votes = ctx.db.all<{ voterToken: string; projectId: string; creditsSpent: number; ipHash: string; createdAt: number }>(
            `select v.voter_hash as voterToken, v.project_id as projectId, v.credits_spent as creditsSpent,
              r.fingerprint as ipHash, v.created_at as createdAt from vote v join voter r
              on r.token_hash = v.voter_hash and r.event_id = v.event_id
              where v.event_id = :event order by v.voter_hash, v.project_id limit 5001`, { event: row.id });
          const limited = votes.length > 5000 || new Set(votes.map((v) => v.voterToken)).size > 500;
          const report = limited ? null : detectVoteAbuse(votes, abusePolicy(ctx.db, row.id));
          return { limited, report: report === null ? null : { ...report,
            clusters: report.clusters.map((cluster) => ({ ...cluster,
              review: abuseReview(ctx.db, row.id, abuseSignalKey(cluster.voterTokens)) })) },
            note: "Read-only signals. Shared fingerprints combine IP and user-agent; they are not proof of shared identity. No votes are removed automatically." };
        })(),
      })),
      readiness: judgingReadiness({ projects: pool, ballots: fit.input?.ballots ?? [],
        reviewsPerProject: row.reviews_per_project, rubric: fit.rubric,
        pairwise: fit.pairwise, pairwiseEnabled: row.pairwise_enabled === 1,
        duplicates: duplicateTitles(ctx.db, row.id) }),
      decisionSupport: {
        target: finalistReport.targetK, decisive: finalistReport.isCutDecisive,
        candidates: [...finalistReport.guaranteed, ...finalistReport.bubble, ...finalistReport.eliminated]
          .sort((a, b) => a.rank - b.rank).map((p) => ({
            project: p.project, ...titleOf(p.project), status: p.status, rank: p.rank,
            fitted: p.fitted, low: p.lowerBound, high: p.upperBound,
            spread: controversyOf.get(p.project)?.spread ?? 0,
            reviews: controversyOf.get(p.project)?.reviewCount ?? 0,
            verdict: controversyOf.get(p.project)?.verdict ?? "sparse",
          })),
        duels: finalistReport.recommendedDuels,
        sensitivity: input.sensitivity === true && fit.input !== null && fit.input.ballots.length > 0
          ? diagnostic("sensitivity", () => rankingSensitivity(fit.input!.rubric, fit.input!.ballots)) : null,
      },
      audit: { head: headHash(ctx.db), entries: readLedger(ctx.db, { eventId: row.id, limit: 30 }).map((entry) => ({
        seq: entry.seq, at: entry.at, action: entry.action, actor: nameOf.get(entry.actor_id ?? "") ?? (entry.actor_id === null ? "System" : entry.actor_id),
        subject: entry.subject, payload: entry.payload, hash: entry.hash,
      })) },
      rubric:
        fit.rubric === null
          ? { version: fit.rubricVersion, method: "none", rounds: 0, converged: true, warnings: [] }
          : {
              version: fit.rubricVersion,
              method: fit.rubric.method,
              rounds: fit.rubric.rounds,
              converged: fit.rubric.converged,
              grandMean: fit.rubric.grandMean,
              residualSd: fit.rubric.residualSd,
              warnings: panelWarnings,
            },
      judges: progress.map((judge) => ({
        judge: judge.judgeId,
        name: judge.name,
        email: judge.email,
        assigned: judge.assigned,
        submitted: judge.submitted,
        drafts: judge.drafts,
        comparisons: judge.comparisons,
        skipped: judge.skipped,
        lastActiveAt: judge.lastActiveAt,
      })),
      effects: (fit.rubric?.judges ?? []).map((effect) => ({
        judge: effect.judge,
        name: nameOf.get(effect.judge) ?? effect.judge,
        ballots: effect.ballots,
        leniency: effect.leniency,
        scale: effect.scale,
        scaleRaw: effect.scaleRaw,
        shrinkage: effect.shrinkage,
        informationWeight: effect.informationWeight,
        clamped: effect.clamped,
        discrimination: effect.discrimination,
      })),
      reliability:
        fit.reliability === null ? null : reliabilityJson(fit.reliability, nameOf, titles(ctx, row)),
      criteria: fit.criteria === null ? null : (fit.criteria as unknown as Record<string, unknown>),
      calibration: calibration === null ? null : calibrationJson(calibration, nameOf),
      coverage: coverageJson(coverage),
      gaps: coverageJson(gaps),
      pairing:
        pairing === null
          ? null
          : {
              componentCount: pairing.componentCount,
              connected: pairing.connected,
              pairsSeen: pairing.seenPairs.size,
              leastSeen: pairing.leastSeen.map((id) => ({ project: id, ...titleOf(id) })),
              exposure: [...pairing.exposure.entries()]
                .map(([id, seen]) => ({ project: id, ...titleOf(id), seen }))
                .sort((a, b) => a.seen - b.seen || a.project.localeCompare(b.project)),
            },
      pairwise: fit.pairwise === null ? null : pairwiseJson(ctx, row, fit.pairwise),
      agreement:
        fit.rubric === null || fit.pairwise === null
          ? null
          : agreementJson(ctx, row, fit.rubric, fit.pairwise),
    };
  },
});

const SWITCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    published: { type: "boolean" },
    revision: { type: ["integer", "null"] },
    changed: { type: "boolean" },
    projects: { type: "integer" },
    ballots: { type: "integer" },
    comparisonsDecided: { type: "integer" },
    converged: { type: "boolean" },
    shortProjects: { type: "integer" },
    // How much of the order the evidence supports, at the moment somebody commits to publishing it.
    // `null` when nothing has been fitted, which is a state an organizer can reach and should see.
    tiers: { type: ["integer", "null"] },
    decisive: { type: ["boolean", "null"] },
    reliability: { type: ["number", "null"] },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["published", "changed", "projects", "warnings"],
};

/**
 * The diagnostics an organizer should see at the moment they publish, and after.
 *
 * The same numbers as `results.show`, deliberately: the confirmation an organizer reads and the page
 * the world reads are computed by one function, so there is no version of this product where the
 * organizer was shown a cleaner ranking than the one they published.
 *
 * That includes the redaction. These warnings go through `withoutJudges` even though the caller is an
 * organizer, because the promise in this command's `notes` is that they are *the warnings the public
 * page carries* — and a confirmation dialog naming a judge the public page does not name would make
 * that sentence false. An organizer who wants the judge-level reading has `events.dashboard`.
 *
 * `tiers` and `decisive` are on it for the opposite reason: the moment somebody publishes is the
 * moment they should be told the evidence resolves four levels rather than forty, and that first
 * place is or is not separated from second. It still does not refuse — see `publish` — but nobody
 * gets to say afterwards that the portal never mentioned it.
 */
function switchJson(
  ctx: Ctx,
  event: EventRow,
  published: boolean,
  changed: boolean,
): Record<string, unknown> {
  const fit = ranked(ctx, event);
  return {
    published,
    changed,
    projects: rows(ctx, event, fit.rubric, fit.pairwise).length,
    ballots: fit.ballots,
    comparisonsDecided: fit.decided.length,
    converged: (fit.rubric?.converged ?? true) && (fit.pairwise?.converged ?? true),
    shortProjects: coverageGaps(ctx.db, event).length,
    tiers: fit.reliability?.tiers ?? null,
    decisive: fit.reliability?.decisive ?? null,
    reliability: fit.reliability?.reliability ?? null,
    warnings: forPublic(ctx, event, [
      ...(fit.rubric?.warnings ?? []),
      ...(fit.pairwise?.warnings ?? []),
      ...(fit.reliability?.warnings ?? []),
    ]),
  };
}

/**
 * Publish the ranking.
 *
 * **It warns; it does not refuse.** A fit that did not converge, a project short of reviews, a
 * comparison graph in two pieces — every one of those is on the response and on the public page, and
 * none of them blocks the button. The alternative was refusing to publish an imperfect ranking,
 * which sounds principled and ends with an organizer announcing a winner off a spreadsheet at a
 * ceremony that started ten minutes ago. A caveated ranking anybody can audit beats a private one
 * nobody can.
 *
 * Idempotent, and quiet about it: publishing an already-published event writes nothing and records
 * nothing, because a ledger entry for a no-op trains its readers to skim. `changed` says which
 * happened.
 */
export const publish = defineCommand({
  name: "results.publish",
  summary: "Publish the ranking for everybody to read.",
  method: "POST",
  path: "/api/events/:event/results/publish",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, reason: { kind: "text", min: 1, max: 500,
    label: "Internal correction reason", optional: true,
    help: "Private organizer note. Give a reason to publish a new revision after correcting evidence." },
    publicSummary: { kind: "text", min: 4, max: 160, optional: true,
      label: "Public revision summary", help: "Visible to everyone in result history. Keep judge and participant details private." } },
  returns: { kind: "json", schema: SWITCH_SCHEMA },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["event.results_published", "result.published", "result.corrected"],
  form: {
    title: "Publish results",
    submit: "Publish",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results`,
  },
  notes:
    "Reversible: `results.unpublish` takes the page down again. The warnings on this response are " +
    "the ones the public page carries, so publishing never looks cleaner than the ranking is.",
  handler: (call) => {
    const { ctx, event, input } = call;
    const row = event as EventRow;
    assertVotingClosed(row, ctx.now());
    return ctx.db.tx(() => {
      const previous = latestPublication(ctx.db, row.id);
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      const changed = row.results_public === 0 || reason.length > 0 || !previous;
      if (!previous || reason.length > 0) {
        const live = liveShow.handler(call) as Record<string, unknown>;
        const fit = ranked(ctx, row);
        live._explanations = fit.input && fit.rubric
          ? reviewExplanations(fit.input.rubric, fit.input.ballots, fit.rubric) : [];
        storePublication(ctx, row.id, live, reason || "Initial publication",
          typeof input.publicSummary === "string" ? input.publicSummary : undefined);
      }
      if (row.results_public === 0) setResultsPublic(ctx, row, true);
      return { ...switchJson(ctx, row, true, changed),
        revision: latestPublication(ctx.db, row.id)?.revision ?? null };
    });
  },
});

/**
 * Take the ranking back down.
 *
 * Publishing is reversible here and rubric publication is not, which looks inconsistent until you
 * ask what each one breaks. A withdrawn rubric would redefine ballots already cast against it. A
 * withdrawn ranking breaks nothing: it is derived, it recomputes from the same ballots, and an
 * organizer who published mid tie-break needs a way back that is not a database edit.
 *
 * What it cannot do is unsee. Both directions are in the ledger, so "results were public for eleven
 * minutes" stays answerable after the page is gone.
 */
export const unpublish = defineCommand({
  name: "results.unpublish",
  summary: "Take the published ranking back down.",
  method: "POST",
  path: "/api/events/:event/results/unpublish",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: SWITCH_SCHEMA },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["event.results_withdrawn"],
  form: {
    title: "Withdraw results",
    submit: "Withdraw",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results`,
  },
  notes:
    "The ledger keeps the publication and the withdrawal, so a ranking that was briefly public " +
    "cannot be made never to have happened.",
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const changed = row.results_public !== 0;
    if (changed) setResultsPublic(ctx, row, false);
    return switchJson(ctx, row, false, changed);
  },
});

export const certificates = defineCommand({
  name: "results.certificates",
  summary: "View issued Ed25519 verifiable certificates for this event.",
  method: "GET",
  path: "/api/events/:event/certificates",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        event: { type: "string" },
        totalIssued: { type: "integer" },
        participants: { type: "integer" },
        judges: { type: "integer" },
        winners: { type: "integer" },
        publicKeyPem: { type: "string" },
        issuerKeyId: { type: "string" },
        publicationRevision: { type: ["integer", "null"] },
        publicationDigest: { type: ["string", "null"] },
        logoDataUrl: { type: ["string", "null"] },
        certificates: { type: "array", items: { type: "object" } },
      },
      required: ["event", "totalIssued", "participants", "judges", "winners", "publicKeyPem", "certificates"],
    },
  },
  notes: "Organizer-only, read-only. Returns the stored signed snapshot, or an empty report before issuance. Never creates keys or signatures.",
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const report = issuedEventCertificates(ctx.db, row.id);
    return report ?? { event: row.name, totalIssued: 0, participants: 0, judges: 0,
      winners: 0, publicKeyPem: "", certificates: [] };
  },
});

export const certificateStudio = defineCommand({
  name: "results.certificate_studio",
  summary: "Design certificates and view the issued recipient roster.",
  method: "GET",
  path: "/api/events/:event/certificates/studio",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    event: { type: "string" },
    eventSlug: { type: "string" },
    totalIssued: { type: "integer" },
    participants: { type: "integer" },
    judges: { type: "integer" },
    winners: { type: "integer" },
    publicKeyPem: { type: "string" },
    issuerKeyId: { type: "string" },
    publicationRevision: { type: ["integer", "null"] },
    publicationDigest: { type: ["string", "null"] },
    logoDataUrl: { type: ["string", "null"] },
    resultsPublic: { type: "boolean" },
    template: { type: "object" },
    certificates: { type: "array", items: { type: "object" } },
  }, required: ["event", "eventSlug", "template", "certificates", "totalIssued"] } },
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const report = issuedEventCertificates(ctx.db, row.id) ?? {
      event: row.name, totalIssued: 0, participants: 0, judges: 0, winners: 0,
      publicKeyPem: "", certificates: [],
    };
    return { ...report, template: certificateTemplate(ctx.db, row.id),
      eventSlug: row.slug, resultsPublic: row.results_public === 1 };
  },
});

export const configureCertificateTemplate = defineCommand({
  name: "results.configure_certificate_template",
  summary: "Save the event certificate design before issuance.",
  method: "POST",
  path: "/api/events/:event/certificates/template",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    heading: { kind: "text", min: 3, max: 90, label: "Heading" },
    body: { kind: "text", min: 3, max: 350, multiline: true, label: "Message" },
    footer: { kind: "text", min: 0, max: 120, label: "Footer" },
    signatory: { kind: "text", min: 2, max: 100, label: "Signatory" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    presentation: { type: "object" }, logoDataUrl: { type: "string" },
  }, required: ["presentation"] } },
  limit: "organize",
  records: ["certificate.template.updated"],
  form: { title: "Certificate design", submit: "Save certificate design",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/certificates/studio` },
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    return ctx.recorded({ action: "certificate.template.updated", eventId: row.id,
      payload: { heading: input.heading } }, () => saveCertificateTemplate(ctx.db, row.id, {
      heading: String(input.heading), body: String(input.body), footer: String(input.footer),
      signatory: String(input.signatory),
    }, ctx.now()));
  },
});

export const publicIssuedCertificate = defineCommand({
  name: "results.public_certificate",
  summary: "View an issued certificate and its current correction status.",
  method: "GET",
  path: "/api/events/:event/certificates/:serial",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF,
    serial: { kind: "text", min: 8, max: 180, label: "Certificate serial" } },
  returns: { kind: "json", schema: { type: "object", properties: {
    serial: { type: "string" },
    eventName: { type: "string" },
    recipientName: { type: "string" },
    category: { type: "string" },
    detail: { type: "string" },
    issuedAt: { type: "integer" },
    issuerOrigin: { type: "string" },
    issuerKeyId: { type: "string" },
    publicationRevision: { type: ["integer", "null"] },
    presentation: { type: "object" },
    logoDataUrl: { type: ["string", "null"] },
    status: { type: "string" },
    correctionReason: { type: ["string", "null"] },
    replacementSerial: { type: ["string", "null"] },
    eventSlug: { type: "string" },
  }, required: ["serial", "recipientName", "status"] } },
  handler: ({ ctx, event, input, roles }) => {
    const row = event as EventRow;
    if (!roles.includes("organizer")) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const cert = publicCertificate(ctx.db, row.id, String(input.serial));
    if (!cert) throw new RuleError("certificate.unknown", "No issued certificate has this serial for this event.");
    return { ...cert, eventSlug: row.slug };
  },
});

export const issueCertificates = defineCommand({
  name: "results.issue_certs",
  summary: "Issue and sign Ed25519 certificates for participants, judges, and winners.",
  method: "POST",
  path: "/api/events/:event/certificates",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        event: { type: "string" },
        totalIssued: { type: "integer" },
        participants: { type: "integer" },
        judges: { type: "integer" },
        winners: { type: "integer" },
        publicKeyPem: { type: "string" },
        certificates: { type: "array", items: { type: "object" } },
      },
      required: ["event", "totalIssued", "participants", "judges", "winners", "publicKeyPem", "certificates"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["certificate.issued"],
  form: {
    title: "Issue event certificates",
    submit: "Issue and sign certificates",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/certificates/studio`,
  },
  notes: "Issues cryptographic Ed25519 certificates. Refuses before results are published.",
  handler: ({ ctx, event, origin }) => {
    const row = event as EventRow;
    if (row.results_public === 0) {
      throw new RuleError("results.notPublic", "Certificates can only be issued after results are published.");
    }
    const existing = issuedEventCertificates(ctx.db, row.id);
    if (existing) return existing;
    return ctx.recorded(
      {
        action: "certificate.issued",
        eventId: row.id,
        payload: {
          event: row.id,
        },
      },
      () => persistEventCertificates(ctx.db, row.slug, ctx.now(), certificateKeyDirectory(), origin),
    );
  },
});

export const certificateStatus = defineCommand({
  name: "results.certificate_status",
  summary: "Download signed certificate revocations and supersessions without recipient data.",
  method: "GET",
  path: "/api/events/:event/certificates/status",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    records: { type: "array", items: { type: "object" } },
    replacements: { type: "array", items: { type: "object" } },
  }, required: ["records"] } },
  handler: ({ ctx, event, roles }) => {
    const row = event as EventRow;
    if (!roles.includes("organizer")) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const bundle = certificateCorrections(ctx.db, row.id);
    return roles.includes("organizer") ? bundle : { records: bundle.records };
  },
});

export const correctIssuedCertificate = defineCommand({
  name: "results.correct_cert",
  summary: "Sign a revocation or supersession for an issued certificate.",
  method: "POST",
  path: "/api/events/:event/certificates/corrections",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    serial: { kind: "text", min: 8, max: 180, label: "Certificate serial" },
    action: { kind: "enum", values: ["revoke", "supersede"], label: "Correction" },
    reason: { kind: "text", min: 8, max: 1000, label: "Reason" },
    recipientName: { kind: "text", min: 1, max: 120, optional: true, label: "Corrected recipient name" },
    recipientEmail: { kind: "email", optional: true, label: "Corrected recipient email" },
    category: { kind: "enum", values: ["participation", "judge", "placement"], optional: true,
      label: "Corrected category" },
    detail: { kind: "text", min: 1, max: 500, optional: true, label: "Corrected detail" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    record: { type: "object" }, replacement: { type: "object" },
  }, required: ["record"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["certificate.revoke", "certificate.supersede"],
  form: { title: "Correct an issued certificate", submit: "Sign certificate correction",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results` },
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const action = String(input.action) as "revoke" | "supersede";
    const replacement = action === "supersede" && input.recipientName && input.recipientEmail && input.category && input.detail
      ? { recipientName: String(input.recipientName), recipientEmail: String(input.recipientEmail),
        category: String(input.category) as "participation" | "judge" | "placement", detail: String(input.detail) }
      : undefined;
    return correctCertificate(ctx, row.id, String(input.serial), action, String(input.reason),
      replacement, certificateKeyDirectory());
  },
});

export const history = defineCommand({
  name: "results.history",
  summary: "List result publication revisions and correction reasons.",
  method: "GET",
  path: "/api/events/:event/results/history",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    revisions: { type: "array", items: { type: "object" } },
  }, required: ["revisions"] } },
  handler: ({ ctx, event, roles }) => {
    const row = event as EventRow;
    if (!roles.includes("organizer")) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    return { revisions: publicationHistory(ctx.db, row.id).map((revision) => ({
      revision: revision.revision, issuedAt: revision.issued_at,
      rubricVersion: revision.rubric_version, algorithm: revision.algorithm,
      evidenceDigest: revision.evidence_digest, ledgerHead: revision.ledger_head,
      reason: revision.public_summary, supersededAt: revision.superseded_at,
      ...(roles.includes("organizer") ? { internalReason: revision.reason } : {}),
      reportUrl: `/api/events/${encodeURIComponent(row.slug)}/results?revision=${revision.revision}`,
    })) };
  },
});

export const judgeEvidence = defineCommand({
  name: "results.judge_evidence",
  summary: "Exclude or restore one judge's evidence with an audited reason.",
  method: "POST",
  path: "/api/events/:event/results/judge-evidence",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    judge: { kind: "text", min: 1, max: 64, label: "Judge account ID" },
    decision: { kind: "enum", values: ["exclude", "include"], label: "Decision" },
    reason: { kind: "text", min: 3, max: 500, label: "Reason" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    judge: { type: "string" }, excluded: { type: "boolean" },
    revision: { type: ["integer", "null"] },
  }, required: ["judge", "excluded", "revision"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["judge.evidence_excluded", "judge.evidence_restored", "result.corrected"],
  form: { title: "Review judge evidence", submit: "Record evidence decision",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results` },
  handler: (call) => {
    const { ctx, event, input } = call;
    const row = event as EventRow;
    const judge = String(input.judge);
    const excluded = input.decision === "exclude";
    const membership = ctx.db.get<{ active: number }>(
      "select active from membership where event_id = :e and account_id = :j and role = 'judge'",
      { e: row.id, j: judge },
    );
    if (!membership) throw new RuleError("judge.unknown", "That account has no judge history in this event.");
    return ctx.db.tx(() => {
      ctx.recorded({ action: excluded ? "judge.evidence_excluded" : "judge.evidence_restored",
        eventId: row.id, subject: judge, payload: { reason: String(input.reason) } }, () => {
        ctx.write(`update membership set evidence_excluded_at = :at,
          evidence_exclusion_reason = :reason where event_id = :e and account_id = :j and role = 'judge'`, {
          at: excluded ? ctx.now() : null, reason: excluded ? String(input.reason) : null,
          e: row.id, j: judge,
        });
      });
      if (row.results_public !== 0) {
        const live = liveShow.handler(call) as Record<string, unknown>;
        const fit = ranked(ctx, row);
        live._explanations = fit.input && fit.rubric
          ? reviewExplanations(fit.input.rubric, fit.input.ballots, fit.rubric) : [];
        storePublication(ctx, row.id, live, `${excluded ? "Excluded" : "Restored"} judge evidence: ${String(input.reason)}`);
      }
      return { judge, excluded, revision: latestPublication(ctx.db, row.id)?.revision ?? null };
    });
  },
});

export const publicationPreflight = defineCommand({
  name: "results.preflight",
  summary: "Check coverage, model warnings, and publication status before publishing.",
  method: "GET",
  path: "/api/events/:event/results/preflight",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    revision: { type: ["integer", "null"] }, ready: { type: "boolean" },
    checks: { type: "array", items: { type: "object" } },
    warnings: { type: "array", items: { type: "string" } },
    evidenceDigest: { type: ["string", "null"] },
  }, required: ["revision", "ready", "checks", "warnings", "evidenceDigest"] } },
  handler: (call) => {
    const row = call.event as EventRow;
    const dashboardResult = dashboard.handler({ ...call,
      input: { ...call.input, finalists: 3 } }) as Record<string, unknown>;
    const readiness = dashboardResult.readiness as { status: string; checks: unknown[] };
    const preview = liveShow.handler(call) as { warnings: string[] };
    const latest = latestPublication(call.ctx.db, row.id);
    return { revision: latest?.revision ?? null,
      ready: readiness.status === "checks-passed" && preview.warnings.length === 0,
      checks: readiness.checks, warnings: preview.warnings,
      evidenceDigest: latest?.evidence_digest ?? null };
  },
});

export const evidencePacket = defineCommand({
  name: "results.evidence_packet",
  summary: "Download the public method and evidence summary bound to one result revision.",
  method: "GET",
  path: "/api/events/:event/results/evidence",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    revision: { type: "integer" }, issuedAt: { type: "integer" },
    algorithm: { type: "string" }, options: { type: "object" },
    rubricVersion: { type: ["integer", "null"] },
    evidenceDigest: { type: "string" }, ledgerHead: { type: "string" },
    ballots: { type: "integer" }, comparisonsDecided: { type: "integer" },
    warnings: { type: "array", items: { type: "string" } }, publicSummary: { type: "string" },
  }, required: ["revision", "issuedAt", "algorithm", "options", "rubricVersion",
    "evidenceDigest", "ledgerHead", "ballots", "comparisonsDecided", "warnings", "publicSummary"] } },
  handler: ({ ctx, event, roles }) => {
    const row = event as EventRow;
    if (!roles.includes("organizer")) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const publication = latestPublication(ctx.db, row.id);
    if (!publication) throw new RuleError("results.noSnapshot", "No frozen publication exists yet.");
    const report = JSON.parse(publication.report) as { ballots?: number; comparisonsDecided?: number; warnings?: string[] };
    return { revision: publication.revision, issuedAt: publication.issued_at,
      algorithm: publication.algorithm, options: JSON.parse(publication.options),
      rubricVersion: publication.rubric_version, evidenceDigest: publication.evidence_digest,
      ledgerHead: publication.ledger_head, ballots: report.ballots ?? 0,
      comparisonsDecided: report.comparisonsDecided ?? 0, warnings: report.warnings ?? [],
      publicSummary: publication.public_summary };
  },
});

export const RESULTS_COMMANDS: readonly Command[] = [
  dashboard,
  show,
  confidence,
  publish,
  unpublish,
  certificates,
  certificateStudio,
  configureCertificateTemplate,
  publicIssuedCertificate,
  issueCertificates,
  certificateStatus,
  correctIssuedCertificate,
  history,
  judgeEvidence,
  publicationPreflight,
  evidencePacket,
];
