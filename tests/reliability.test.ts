import test from "node:test";
import assert from "node:assert/strict";

import type { Ballot, Rubric } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import { normalizeScores } from "../src/judging/normalize.ts";
import { panelReliability, RELIABILITY_DEFAULTS } from "../src/judging/reliability.ts";
import { simulateEvent } from "../src/judging/simulate.ts";
import { tCritical95 } from "../src/judging/stats.ts";

const rubric: Rubric = {
  id: "r",
  version: 1,
  criteria: [{ key: "overall", label: "Overall", weight: 1, min: 1, max: 5 }],
};

const ballot = (id: string, judge: string, project: string, score: number): Ballot => ({
  id,
  judge,
  project,
  rubricVersion: 1,
  scores: { overall: score },
});

const fitOf = (options: Parameters<typeof simulateEvent>[0]) => {
  const event = simulateEvent(options);
  return { event, fit: normalizeScores(event.rubric, event.ballots) };
};

test("the report describes the fit it was given and does not re-rank it", () => {
  const { event, fit } = fitOf({ projects: 24, judges: 6, reviewsPerProject: 3, seed: "describe" });
  const result = panelReliability(event.rubric, event.ballots, fit);

  assert.equal(result.intervals.length, fit.projects.length);
  // Intervals arrive in adjusted-score order, which must be the fit's own order.
  const byRank = fit.projects.slice().sort((a, b) => a.rankAdjusted - b.rankAdjusted);
  assert.deepEqual(
    result.intervals.map((i) => i.project),
    byRank.map((p) => p.project),
    "reliability must not invent an ordering of its own",
  );
  for (const interval of result.intervals) {
    const p = fit.projects.find((x) => x.project === interval.project);
    assert.equal(interval.adjusted, p?.adjusted, "scores are copied, never recomputed");
    assert.equal(interval.standardError, p?.standardError);
  }
});

test("an interval is the fitted score plus or minus t times its standard error", () => {
  const { event, fit } = fitOf({ projects: 20, judges: 5, reviewsPerProject: 3, seed: "interval" });
  const result = panelReliability(event.rubric, event.ballots, fit);
  assert.equal(result.df, fit.df);
  assert.equal(result.tMultiplier, tCritical95(fit.df));
  assert.equal(result.confidence, 0.95);
  for (const i of result.intervals) {
    assert.ok(Math.abs(i.halfWidth - result.tMultiplier * i.standardError) < 1e-12);
    assert.ok(Math.abs(i.high - i.low - 2 * i.halfWidth) < 1e-12);
    assert.ok(i.low < i.adjusted && i.adjusted < i.high);
  }
});

test("variance shares are shares: three non-negative numbers that sum to one", () => {
  const { event, fit } = fitOf({
    projects: 30,
    judges: 8,
    reviewsPerProject: 3,
    seed: "shares",
    imbalance: 0.7,
  });
  const { varianceShare } = panelReliability(event.rubric, event.ballots, fit);
  for (const v of [varianceShare.project, varianceShare.judge, varianceShare.residual]) {
    assert.ok(v >= 0 && v <= 1, `a share must sit in [0, 1], got ${v}`);
  }
  const total = varianceShare.project + varianceShare.judge + varianceShare.residual;
  assert.ok(Math.abs(total - 1) < 1e-12, `shares must sum to one, got ${total}`);
});

test("reliability, separation and strata agree with each other", () => {
  for (const seed of ["triple-a", "triple-b"]) {
    const { event, fit } = fitOf({ projects: 26, judges: 7, reviewsPerProject: 4, seed });
    const r = panelReliability(event.rubric, event.ballots, fit);
    assert.ok(r.reliability >= 0 && r.reliability <= 1);
    assert.ok(r.separation >= 0);
    // Wright and Masters: strata = (4G + 1) / 3, and reliability = G^2 / (1 + G^2).
    assert.ok(Math.abs(r.strata - (4 * r.separation + 1) / 3) < 1e-12);
    const fromSeparation = r.separation ** 2 / (1 + r.separation ** 2);
    assert.ok(
      Math.abs(fromSeparation - r.reliability) < 1e-9,
      `reliability ${r.reliability} and separation ${r.separation} must be the same statement`,
    );
    assert.ok(Math.abs(r.separation * r.errorSd - r.trueSd) < 1e-12);
  }
});

test("more evidence buys more distinguishable levels", () => {
  const thin = fitOf({ projects: 30, judges: 6, reviewsPerProject: 2, seed: "levels" });
  const thick = fitOf({ projects: 30, judges: 6, reviewsPerProject: 6, seed: "levels" });
  const a = panelReliability(thin.event.rubric, thin.event.ballots, thin.fit);
  const b = panelReliability(thick.event.rubric, thick.event.ballots, thick.fit);
  assert.ok(
    b.separation > a.separation,
    `six reviews must separate better than two: ${b.separation} vs ${a.separation}`,
  );
  assert.ok(b.tiers >= a.tiers, `and resolve at least as many tiers: ${b.tiers} vs ${a.tiers}`);
  assert.ok(b.ballotsPerProject > a.ballotsPerProject);
});

test("tiers partition the field, run downward, and are decided on the difference", () => {
  const { event, fit } = fitOf({ projects: 22, judges: 6, reviewsPerProject: 3, seed: "tiers" });
  const r = panelReliability(event.rubric, event.ballots, fit);

  assert.ok(r.tiers >= 1 && r.tiers <= r.intervals.length);
  const seen = new Set(r.intervals.map((i) => i.tier));
  assert.equal(seen.size, r.tiers, "every tier number must be used");
  for (let t = 1; t <= r.tiers; t++) assert.ok(seen.has(t), `tier ${t} must exist`);

  let previous = 0;
  for (const i of r.intervals) {
    assert.ok(i.tier === previous || i.tier === previous + 1, "tiers advance by one, in order");
    previous = i.tier;
  }
  const size = new Map<number, number>();
  for (const i of r.intervals) size.set(i.tier, (size.get(i.tier) ?? 0) + 1);
  for (const i of r.intervals) {
    assert.equal(i.sharesTier, (size.get(i.tier) as number) - 1);
  }

  // Every project sharing a leader's tier is within t standard errors of the
  // difference from that leader, and the first project to break away is not.
  for (let t = 1; t <= r.tiers; t++) {
    const members = r.intervals.filter((i) => i.tier === t);
    const leader = members[0] as (typeof members)[number];
    for (const m of members) {
      const seDiff = Math.hypot(leader.standardError, m.standardError);
      assert.ok(
        Math.abs(leader.adjusted - m.adjusted) <= r.tMultiplier * seDiff + 1e-12,
        `${m.project} is in ${leader.project}'s tier so it must be inside the interval`,
      );
    }
  }
  assert.equal(r.decisive, r.intervals[0]?.tier !== r.intervals[1]?.tier);
});

test("a judge's residuals stay centred once their pending offset is accounted for", () => {
  // The fit pins mean(b) = 0, which leaves a single common constant in every
  // judge's residual mean, scaled by that judge's slope. So bias divided by scale
  // must be the same number for everybody: if it is not, the residual is being
  // built from a model the fit did not solve.
  const { event, fit } = fitOf({
    projects: 28,
    judges: 7,
    reviewsPerProject: 3,
    seed: "centred",
    imbalance: 0.6,
    scaleSpread: 0.5,
  });
  const r = panelReliability(event.rubric, event.ballots, fit);
  const scaleOf = new Map(fit.judges.map((j) => [j.judge, j.scale]));
  const ratios = r.judges.map((j) => j.bias / (scaleOf.get(j.judge) as number));
  const first = ratios[0] as number;
  for (const ratio of ratios) {
    assert.ok(
      Math.abs(ratio - first) < 1e-9,
      `bias/scale must be constant across judges: ${ratio} against ${first}`,
    );
  }
});

test("a wild ballot is flagged, and being unusual is reported as a z-score not a verdict", () => {
  // A single deviant score is only detectable when the rest of the panel pins the
  // project down. On three judges the fit can — correctly — absorb one low score as
  // a judge who uses a wider scale, so the design here gives the project eight
  // reviewers and moves exactly one of them to the floor.
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const judges = ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8"];
  const quality = new Map(projects.map((p, i) => [p, 5 - i * 0.6]));
  const ballots: Ballot[] = [];
  let n = 0;
  for (const p of projects) {
    for (const j of judges) {
      const score = Math.max(1, Math.min(5, Math.round(quality.get(p) as number)));
      ballots.push(ballot(`b${n++}`, j, p, score));
    }
  }
  const wild = ballots.find((b) => b.judge === "j5" && b.project === "p1") as Ballot;
  wild.scores = { overall: 1 };

  const fit = normalizeScores(rubric, ballots);
  const r = panelReliability(rubric, ballots, fit);
  assert.ok(r.outliers.length > 0, "one floor score against seven top scores must surface");
  const worst = r.outliers[0] as (typeof r.outliers)[number];
  assert.equal(worst.judge, "j5");
  assert.equal(worst.project, "p1");
  assert.equal(worst.observed, 1);
  assert.ok(Math.abs(worst.residual - (worst.observed - worst.expected)) < 1e-12);
  assert.ok(worst.residual < 0, "scoring below expectation is a negative residual");
  assert.ok(Math.abs(worst.z) >= RELIABILITY_DEFAULTS.outlierZ);
  const note = r.notes.find((n) => n.code === "ballot.outliers");
  assert.equal(note?.severity, "info", "an unusual ballot is information, not a fault");
  assert.ok(
    note?.message.includes("not a ballot being wrong"),
    "the note must decline to call the judge wrong",
  );
});

test("the outlier list is capped and ordered by how far out the ballot sits", () => {
  const { event, fit } = fitOf({
    projects: 40,
    judges: 10,
    reviewsPerProject: 3,
    seed: "capped",
    noise: 1.2,
  });
  const r = panelReliability(event.rubric, event.ballots, fit, { outlierZ: 0.5, maxOutliers: 5 });
  assert.equal(r.outliers.length, 5);
  for (let i = 1; i < r.outliers.length; i++) {
    const before = r.outliers[i - 1] as (typeof r.outliers)[number];
    const here = r.outliers[i] as (typeof r.outliers)[number];
    assert.ok(Math.abs(before.z) >= Math.abs(here.z), "worst first");
  }
});

test("a judge-dominated event is named as one", () => {
  const { event, fit } = fitOf({
    projects: 30,
    judges: 8,
    reviewsPerProject: 2,
    seed: "dominated",
    imbalance: 0.9,
    leniencySd: 2.2,
    qualitySd: 0.12,
    noise: 0.15,
  });
  const r = panelReliability(event.rubric, event.ballots, fit);
  assert.ok(
    r.varianceShare.judge > r.varianceShare.project,
    `this event is built so judges dominate: judge ${r.varianceShare.judge}, ` +
      `project ${r.varianceShare.project}`,
  );
  const note = r.notes.find((n) => n.code === "panel.judgeDominated");
  assert.ok(note, "the dominance has to be said out loud");
  assert.equal(note?.severity, "warn");
  assert.ok(r.warnings.includes(note?.message as string));
});

test("an undecided top two is a warning, not a tie-break", () => {
  const ballots = [
    ballot("b1", "j1", "p1", 4),
    ballot("b2", "j1", "p2", 4),
    ballot("b3", "j2", "p1", 4),
    ballot("b4", "j2", "p2", 4),
    ballot("b5", "j1", "p3", 2),
    ballot("b6", "j2", "p3", 2),
  ];
  const fit = normalizeScores(rubric, ballots);
  const r = panelReliability(rubric, ballots, fit);
  assert.equal(r.decisive, false);
  const note = r.notes.find((n) => n.code === "panel.topNotDecisive");
  assert.ok(note);
  assert.equal(note?.severity, "warn");
  assert.equal(note?.subjects.length, 2);
  assert.ok(
    note?.message.includes("worth more than a tie-break rule"),
    "the recommendation is more evidence, not a rule",
  );
});

test("every warning is a coded note and every note is well formed", () => {
  const { event, fit } = fitOf({
    projects: 18,
    judges: 5,
    reviewsPerProject: 2,
    seed: "coded",
    imbalance: 0.8,
    noise: 0.9,
  });
  const r = panelReliability(event.rubric, event.ballots, fit);
  assert.deepEqual(
    r.notes.filter((n) => n.severity === "warn").map((n) => n.message),
    r.warnings,
  );
  for (const n of r.notes) {
    assert.match(n.code, /^[a-z]+\.[a-zA-Z]+$/);
    assert.ok(n.message.length > 20);
    for (const s of n.subjects) assert.equal(typeof s, "string");
  }
});

test("ballots the fit never saw are refused rather than silently described", () => {
  const ballots = [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 3),
    ballot("b3", "j2", "p1", 4),
    ballot("b4", "j2", "p2", 2),
  ];
  const fit = normalizeScores(rubric, ballots);
  assert.throws(
    () => panelReliability(rubric, [...ballots, ballot("b5", "j9", "p9", 5)], fit),
    (error: unknown) => error instanceof JudgingError && error.code === "reliability.mismatch",
  );
  assert.throws(
    () => panelReliability(rubric, [], fit),
    (error: unknown) => error instanceof JudgingError && error.code === "reliability.empty",
  );
  assert.throws(
    () => panelReliability({ ...rubric, version: 2 }, ballots, fit),
    (error: unknown) => error instanceof JudgingError && error.code === "ballot.rubricVersion",
  );
});

test("the defaults are exported so a caller can quote the thresholds it used", () => {
  assert.equal(RELIABILITY_DEFAULTS.outlierZ, 2.5);
  assert.equal(RELIABILITY_DEFAULTS.lowReliability, 0.7);
  assert.ok(Object.isFrozen(RELIABILITY_DEFAULTS) || typeof RELIABILITY_DEFAULTS === "object");
  const { event, fit } = fitOf({ projects: 12, judges: 4, reviewsPerProject: 3, seed: "method" });
  const r = panelReliability(event.rubric, event.ballots, fit);
  assert.ok(r.method.includes("wright-masters"), `method must name itself: ${r.method}`);
  assert.ok(r.method.includes(`df=${fit.df}`));
});
