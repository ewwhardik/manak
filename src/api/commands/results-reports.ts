/** Stable JSON projections for public panel evidence and organizer diagnostics. */
import type { CalibrationResult, ReliabilityResult } from "../../judging/index.ts";

export const DIAGNOSTIC_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    code: { type: "string" },
    severity: { type: "string", enum: ["info", "warn"] },
    message: { type: "string" },
    subjects: {
      type: "array",
      items: { type: "string" },
      description:
        "The ids the note is about, for a client that wants to highlight rows. Project ids stay " +
        "ids here while the message names titles, because these are the machine-readable half; " +
        "judge ids are replaced on both, on every public surface.",
    },
  },
  required: ["code", "severity", "message", "subjects"],
};

const VARIANCE_SHARE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project: { type: "number" },
    judge: { type: "number" },
    residual: { type: "number" },
  },
  required: ["project", "judge", "residual"],
};

/**
 * How much the ranking can carry, panel-level and anonymous — the public half.
 *
 * Every field here is a property of the panel rather than of a person, which is what makes it
 * publishable under this file's first rule. `varianceShare.judge` of 0.4 says two fifths of the
 * spread in the ballots came from who was marking rather than what was marked; it does not say who,
 * and the organizer's dashboard is where that question is answered.
 *
 * `tiers` and `decisive` are the two numbers a reader should look at first. `separation` and
 * `reliability` are the statistics behind them, kept because an appeal is answered with the
 * quantity and not with the summary.
 */
export const PANEL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    method: { type: "string" },
    varianceShare: VARIANCE_SHARE_SCHEMA,
    projectSd: { type: "number" },
    judgeSd: { type: "number" },
    residualSd: { type: "number" },
    trueSd: { type: "number" },
    errorSd: { type: "number" },
    separation: { type: "number" },
    strata: { type: "number" },
    reliability: { type: "number" },
    ballotsPerProject: { type: "number" },
    confidence: { type: "number" },
    tMultiplier: { type: "number" },
    df: { type: "number" },
    tiers: { type: "integer" },
    decisive: { type: "boolean" },
  },
  required: ["method", "varianceShare", "separation", "strata", "reliability", "tiers", "decisive"],
};

/** The panel-level scalars, with nothing per-judge, per-ballot or per-note attached. */
export function panelJson(fit: ReliabilityResult): Record<string, unknown> {
  return {
    method: fit.method,
    varianceShare: fit.varianceShare,
    projectSd: fit.projectSd,
    judgeSd: fit.judgeSd,
    residualSd: fit.residualSd,
    trueSd: fit.trueSd,
    errorSd: fit.errorSd,
    separation: fit.separation,
    strata: fit.strata,
    reliability: fit.reliability,
    ballotsPerProject: fit.ballotsPerProject,
    confidence: fit.confidence,
    tMultiplier: fit.tMultiplier,
    df: fit.df,
    tiers: fit.tiers,
    decisive: fit.decisive,
  };
}

const INTERVAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    project: { type: "string" },
    title: { type: "string" },
    trackKey: { type: ["string", "null"] },
    adjusted: { type: "number" },
    standardError: { type: "number" },
    low: { type: "number" },
    high: { type: "number" },
    halfWidth: { type: "number" },
    tier: { type: "integer" },
    sharesTier: { type: "integer" },
  },
  required: ["project", "title", "adjusted", "low", "high", "tier", "sharesTier"],
};

const OUTLIER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    judge: { type: "string" },
    name: { type: "string" },
    project: { type: "string" },
    title: { type: "string" },
    observed: { type: "number" },
    expected: { type: "number" },
    residual: { type: "number" },
    z: { type: "number" },
  },
  required: ["judge", "name", "project", "title", "observed", "expected", "residual", "z"],
};

const CONSISTENCY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    judge: { type: "string" },
    name: { type: "string" },
    ballots: { type: "integer" },
    residualSd: { type: "number" },
    relative: { type: "number" },
    bias: { type: "number" },
    flagged: { type: "boolean" },
  },
  required: ["judge", "name", "ballots", "residualSd", "relative", "bias", "flagged"],
};

/**
 * Everything the reliability pass found, names attached. Organizer-only.
 *
 * This is `PANEL_SCHEMA` plus the three things that identify somebody: the per-ballot outliers, the
 * per-judge residual spreads, and the `notes`, whose `subjects` array carries raw ids by design.
 * `warnings` here keep their judge ids for the reason the dashboard's `rubric.warnings` do — the
 * table two fields down already names every judge, so redacting the sentence that explains why one
 * appears in it would hide the reasoning and keep the name.
 *
 * An outlier is not an accusation. It is one ballot the fit did not expect, and the honest reading
 * is "ask about this one" — a judge who saw a demo fail, a project that changed between reviews, a
 * typo in a score box. It is listed because an organizer who cannot see it has no way to answer an
 * appeal about it.
 */
export const RELIABILITY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ...(PANEL_SCHEMA.properties as Record<string, unknown>),
    intervals: { type: "array", items: INTERVAL_SCHEMA },
    outliers: { type: "array", items: OUTLIER_SCHEMA },
    judges: { type: "array", items: CONSISTENCY_SCHEMA },
    warnings: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: DIAGNOSTIC_SCHEMA },
  },
  required: [...(PANEL_SCHEMA.required as string[]), "intervals", "outliers", "judges", "warnings"],
};

/** The whole reliability result with titles and judge names joined on, for one organizer. */
export function reliabilityJson(
  fit: ReliabilityResult,
  nameOf: Map<string, string>,
  titleOf: (id: string) => { title: string; trackKey: string | null },
): Record<string, unknown> {
  return {
    ...panelJson(fit),
    intervals: fit.intervals.map((interval) => ({
      project: interval.project,
      ...titleOf(interval.project),
      adjusted: interval.adjusted,
      standardError: interval.standardError,
      low: interval.low,
      high: interval.high,
      halfWidth: interval.halfWidth,
      tier: interval.tier,
      sharesTier: interval.sharesTier,
    })),
    outliers: fit.outliers.map((outlier) => ({
      judge: outlier.judge,
      name: nameOf.get(outlier.judge) ?? outlier.judge,
      project: outlier.project,
      ...titleOf(outlier.project),
      observed: outlier.observed,
      expected: outlier.expected,
      residual: outlier.residual,
      z: outlier.z,
    })),
    judges: fit.judges.map((judge) => ({
      judge: judge.judge,
      name: nameOf.get(judge.judge) ?? judge.judge,
      ballots: judge.ballots,
      residualSd: judge.residualSd,
      relative: judge.relative,
      bias: judge.bias,
      flagged: judge.flagged,
    })),
    warnings: fit.warnings,
    notes: fit.notes,
  };
}

const CRITERION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    weight: { type: "number" },
    scaleMin: { type: "number" },
    scaleMax: { type: "number" },
    ballots: { type: "integer" },
    observedMean: { type: "number" },
    observedSd: { type: "number" },
    observedMin: { type: "number" },
    observedMax: { type: "number" },
    rangeUsed: { type: "number" },
    discrimination: { type: "number" },
    judgeSpread: { type: "number" },
    judgeDivergence: { type: "number" },
    withTotal: { type: "number" },
    withRanking: { type: "number" },
    verdict: { type: "string", enum: ["discriminating", "weak", "flat"] },
  },
  required: ["key", "label", "weight", "ballots", "rangeUsed", "discrimination", "verdict"],
};

/**
 * What each line of the rubric is doing. Organizer-only, and the cut line of this file.
 *
 * `judgeDivergence` is the reason: it measures how far apart the panel read one criterion's words,
 * and on a small panel a reader who knows the roster can work backwards from it. The rest is a
 * critique of the rubric's design — a criterion every judge scores 4 on is carrying weight and
 * contributing noise — which an organizer should act on before the next event and a public results
 * page has no use for.
 *
 * Nothing here can move a ranking. `criterionInsights` fits nothing and the ranking never consults
 * it, which is exactly what makes it safe to print beside one: the right answer to "nobody
 * discriminates on originality" is to rewrite the criterion for next time, not to reweight this one
 * midway through and invalidate ballots already filed.
 */
export const CRITERIA_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    method: { type: "string" },
    criteria: { type: "array", items: CRITERION_SCHEMA },
    redundant: {
      type: "array",
      items: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" }, correlation: { type: "number" } },
        required: ["a", "b", "correlation"],
      },
    },
    meanCorrelation: { type: "number" },
    contested: { type: ["string", "null"] },
    warnings: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: DIAGNOSTIC_SCHEMA },
  },
  required: ["method", "criteria", "redundant", "meanCorrelation", "contested", "warnings"],
};

const CALIBRATION_JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    judge: { type: "string" },
    name: { type: "string" },
    assigned: { type: "integer" },
    submitted: { type: "integer" },
    drafts: { type: "integer" },
    outstanding: { type: "integer" },
    ballots: { type: "integer" },
    // Every fitted column is nullable, and each null means a different thing the report is careful
    // about: no ballots to place them on the card, one ballot so no range, no panel to be lenient
    // against, no duels to be surprised by. A zero in any of these slots would be a measurement.
    centre: { type: ["number", "null"] },
    spanUsed: { type: ["number", "null"] },
    leniency: { type: ["number", "null"] },
    leniencyShare: { type: ["number", "null"] },
    scale: { type: ["number", "null"] },
    discrimination: { type: ["string", "null"], enum: ["ok", "low", "insufficient", null] },
    spreadRelative: { type: ["number", "null"] },
    noisy: { type: "boolean" },
    outliers: { type: "integer" },
    comparisons: { type: "integer" },
    skipped: { type: "integer" },
    agreed: { type: "integer" },
    against: { type: "integer" },
    agreement: { type: ["number", "null"] },
    expectedAgreement: { type: ["number", "null"] },
    surprise: { type: ["number", "null"] },
    surpriseRatio: { type: ["number", "null"] },
    heldOut: { type: "boolean" },
    closedTriples: { type: "integer" },
    cycles: { type: "integer" },
    cycleRate: { type: ["number", "null"] },
    findings: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["ok", "thin", "behind", "check"] },
    action: { type: "string" },
  },
  required: [
    "judge",
    "name",
    "assigned",
    "submitted",
    "outstanding",
    "ballots",
    "comparisons",
    "skipped",
    "heldOut",
    "findings",
    "verdict",
    "action",
  ],
};

const CALIBRATION_PAIR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    a: { type: "string" },
    b: { type: "string" },
    aName: { type: "string" },
    bName: { type: "string" },
    shared: { type: "integer" },
    agreed: { type: "integer" },
    share: { type: "number" },
    expected: { type: "number" },
    excess: { type: "number" },
    pValue: { type: "number" },
    level: { type: "number" },
    asked: { type: "boolean" },
  },
  required: ["a", "b", "aName", "bName", "shared", "agreed", "share", "expected", "excess", "pValue", "level", "asked"],
};

/**
 * Whether the panel is ready to be published, judge by judge. Organizer-only, and the second cut
 * line of this file.
 *
 * It is on `events.dashboard` and on nothing else, for a reason stronger than the one that keeps
 * `criteria` here. This is the only surface in the product that prints a *verdict* about a person —
 * `check`, `thin`, `behind` — and a verdict is a thing an organizer acts on privately, by asking a
 * question, rather than a thing a results page asserts. Every other per-judge quantity in this file
 * describes a coefficient; these describe a panel member.
 *
 * `blocs` is the sharpest of them and the one that most needs its own sentence. A row there says two
 * judges agreed more often than these comparisons predict, which is a question about a coincidence
 * and not a finding of collusion: two judges who share a taste the rubric never named will produce
 * it without any coordination at all. The row carries the tail probability and the level it had to
 * clear so that the reader can see how surprised to be, and `asked` is false on most of them.
 *
 * Nothing here can move a ranking. `judgeCalibration` refits the pairwise model once per judge — a
 * dashboard on a twenty-judge panel therefore pays for twenty-one fits, which is the cost of holding
 * each judge out of the consensus they are measured against — and then throws every refit away.
 */
export const CALIBRATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    method: { type: "string" },
    judges: { type: "array", items: CALIBRATION_JUDGE_SCHEMA },
    blocs: { type: "array", items: CALIBRATION_PAIR_SCHEMA },
    panelSurprise: { type: ["number", "null"] },
    heldOut: { type: "integer" },
    inSample: { type: "integer" },
    panelExcess: { type: ["number", "null"] },
    blocLevel: { type: "number" },
    span: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: DIAGNOSTIC_SCHEMA },
  },
  required: ["method", "judges", "blocs", "heldOut", "inSample", "blocLevel", "span", "warnings"],
};

/**
 * The calibration report with judge names joined on, both sides of every pair included.
 *
 * Names rather than ids in the display fields and ids kept beside them, which is the same contract
 * the effect and consistency tables use: an organizer reads the name, and a client that wants to
 * join this against `judges` needs the id. A judge on the roster who has never been seen by any fit
 * still gets a row — that is the whole point of taking the roster as the input — so `nameOf` is
 * consulted with a fallback rather than assumed to hold every judge.
 */
export function calibrationJson(fit: CalibrationResult, nameOf: Map<string, string>): Record<string, unknown> {
  const named = (id: string): string => nameOf.get(id) ?? id;
  // The engine writes its sentences about `judge j7f3…`, because the engine has never been told
  // anybody's name and should not be — it takes plain data and returns plain data. Putting the names
  // back is this projection's job, exactly as it is for `effects[].name` above, and it is a plain
  // substring swap rather than anything cleverer: an id is opaque and unique, so replacing it cannot
  // hit the surrounding prose. `subjects` is left alone, because that is the half a caller branches
  // on and it has to stay in ids.
  const readable = (text: string): string => {
    let out = text;
    for (const [id, name] of nameOf) {
      if (!out.includes(id)) continue;
      // The engine writes "Judge <id>" and "judge <id>", so the title comes back with the name
      // attached — except when the roster's own name for somebody already starts with it, which is
      // common enough on a panel of "Judge 1" and "Judge 2" that printing "Judge Judge 1" is a
      // defect a reader would notice before any of the numbers.
      const owns = /^judges?\b/i.test(name);
      out = out.split(`Judge ${id}`).join(owns ? name : `Judge ${name}`);
      out = out.split(`judge ${id}`).join(owns ? name : `judge ${name}`);
      out = out.split(id).join(name);
    }
    return out;
  };
  return {
    method: fit.method,
    judges: fit.judges.map((judge) => ({ ...judge, name: named(judge.judge) })),
    blocs: fit.blocs.map((pair) => ({ ...pair, aName: named(pair.a), bName: named(pair.b) })),
    panelSurprise: fit.panelSurprise,
    heldOut: fit.heldOut,
    inSample: fit.inSample,
    panelExcess: fit.panelExcess,
    blocLevel: fit.blocLevel,
    span: fit.span,
    warnings: fit.warnings.map(readable),
    notes: fit.notes.map((note) => ({ ...note, message: readable(note.message) })),
  };
}
