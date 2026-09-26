import test from "node:test";
import assert from "node:assert/strict";

import type { Ballot, Rubric } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import { NORMALIZE_DEFAULTS, normalizeScores, rawMeanRanking, zScoreRanking } from "../src/judging/normalize.ts";
import { weightedTotal } from "../src/judging/weighted.ts";
import { correlation, kendallTau, mean } from "../src/judging/stats.ts";
import { simulateEvent } from "../src/judging/simulate.ts";

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

const tauAgainstTruth = (
  projects: readonly string[],
  truth: Map<string, number>,
  scores: Map<string, number>,
): number => kendallTau(projects.map((p) => truth.get(p) as number), projects.map((p) => scores.get(p) as number));

test("the fitted parameters reconstruct the fitted scores", () => {
  const result = normalizeScores(rubric, [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 3),
    ballot("b3", "j2", "p1", 3),
    ballot("b4", "j2", "p2", 1),
  ]);
  for (const p of result.projects) {
    assert.ok(
      Math.abs(p.adjusted - (result.grandMean + p.theta)) < 1e-12,
      "adjusted must be exactly mu + theta, or the reported number is not the fitted one",
    );
  }
  assert.ok(Math.abs(mean(result.judges.map((j) => j.leniency))) < 1e-9, "leniency must average zero");
});

test("a harsh judge and a generous judge disagree on absolutes but not on order", () => {
  // j2 marks two points below j1 on everything. The raw mean puts p1 and p2 in
  // the right order only because both judges saw both projects; the point here is
  // that leniency is recovered with the right sign and size.
  const result = normalizeScores(rubric, [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 4),
    ballot("b3", "j2", "p1", 3),
    ballot("b4", "j2", "p2", 2),
  ]);
  const j1 = result.judges.find((j) => j.judge === "j1");
  const j2 = result.judges.find((j) => j.judge === "j2");
  assert.ok((j1?.leniency as number) > 0.9, `expected j1 generous, got ${j1?.leniency}`);
  assert.ok((j2?.leniency as number) < -0.9, `expected j2 harsh, got ${j2?.leniency}`);
  assert.equal(result.projects[0]?.project, "p1");
});

test("duplicate and mis-versioned ballots are refused", () => {
  assert.throws(
    () => normalizeScores(rubric, [ballot("b1", "j1", "p1", 4), ballot("b2", "j1", "p1", 2)]),
    (e: unknown) => e instanceof JudgingError && e.code === "normalize.duplicate",
  );
  assert.throws(
    () => normalizeScores(rubric, [{ ...ballot("b1", "j1", "p1", 4), rubricVersion: 2 }]),
    (e: unknown) => e instanceof JudgingError && e.code === "ballot.rubricVersion",
  );
  assert.throws(() => normalizeScores(rubric, []), (e: unknown) =>
    e instanceof JudgingError && e.code === "normalize.empty");
});

test("a design that splits into disjoint panels is called out, not quietly fitted", () => {
  const result = normalizeScores(rubric, [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 4),
    ballot("b3", "j2", "p3", 2),
    ballot("b4", "j2", "p4", 1),
  ]);
  assert.ok(
    result.warnings.some((w) => w.includes("disconnected")),
    "two panels sharing no project have no common reference point and the report must say so",
  );
});

test("a project with a single ballot is flagged as thin evidence", () => {
  const result = normalizeScores(rubric, [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 4),
    ballot("b3", "j2", "p1", 4),
    ballot("b4", "j2", "p3", 2),
  ]);
  assert.ok(result.warnings.some((w) => w.includes("single ballot")));
});

test("planted judge leniency is recovered on a correlated design", () => {
  const event = simulateEvent({
    projects: 60,
    judges: 12,
    reviewsPerProject: 4,
    seed: "leniency",
    leniencySd: 0.6,
    imbalance: 0.5,
  });
  const result = normalizeScores(event.rubric, event.ballots);
  const planted = event.judges.map((j) => j.leniency);
  const fitted = event.judges.map(
    (j) => result.judges.find((x) => x.judge === j.id)?.leniency as number,
  );
  const r = correlation(planted, fitted);
  assert.ok(r > 0.95, `leniency recovery correlation was only ${r.toFixed(3)}`);
});

test("normalization beats the raw mean by a wide margin when the design is correlated", () => {
  // This is the headline claim, so it is asserted on every seed rather than on an
  // average: an event organizer does not get to rerun their event twenty times.
  for (let s = 0; s < 8; s++) {
    const event = simulateEvent({
      projects: 60,
      judges: 12,
      reviewsPerProject: 4,
      seed: `claim-${s}`,
      leniencySd: 0.6,
      scaleSpread: 0.4,
      imbalance: 0.6,
    });
    const result = normalizeScores(event.rubric, event.ballots);
    const adjusted = new Map(result.projects.map((p) => [p.project, p.adjusted]));
    const tauAdjusted = tauAgainstTruth(event.projects, event.truth, adjusted);
    const tauRaw = tauAgainstTruth(event.projects, event.truth, rawMeanRanking(event.rubric, event.ballots));
    assert.ok(
      tauAdjusted > tauRaw + 0.05,
      `seed ${s}: normalized tau ${tauAdjusted.toFixed(3)} did not clear raw ${tauRaw.toFixed(3)} by 0.05`,
    );
  }
});

test("normalization also beats per-judge z-scoring on a correlated design", () => {
  let wins = 0;
  const trials = 8;
  for (let s = 0; s < trials; s++) {
    const event = simulateEvent({
      projects: 60,
      judges: 12,
      reviewsPerProject: 4,
      seed: `zclaim-${s}`,
      leniencySd: 0.6,
      scaleSpread: 0.4,
      imbalance: 0.6,
    });
    const result = normalizeScores(event.rubric, event.ballots);
    const adjusted = new Map(result.projects.map((p) => [p.project, p.adjusted]));
    const tauAdjusted = tauAgainstTruth(event.projects, event.truth, adjusted);
    const tauZ = tauAgainstTruth(event.projects, event.truth, zScoreRanking(event.rubric, event.ballots));
    if (tauAdjusted > tauZ) wins++;
  }
  assert.ok(wins >= 7, `normalization beat z-scoring on only ${wins} of ${trials} seeds`);
});

test("on a balanced design normalization is neutral, and does not make things worse", () => {
  // The honest boundary of the claim. With a balanced design every project's mean
  // is contaminated by roughly the same average judge, so there is little to
  // remove — and a correction with nothing to correct must not do damage.
  for (let s = 0; s < 6; s++) {
    const event = simulateEvent({
      projects: 60,
      judges: 12,
      reviewsPerProject: 4,
      seed: `balanced-${s}`,
      leniencySd: 0.6,
      scaleSpread: 0.4,
    });
    const result = normalizeScores(event.rubric, event.ballots);
    const adjusted = new Map(result.projects.map((p) => [p.project, p.adjusted]));
    const tauAdjusted = tauAgainstTruth(event.projects, event.truth, adjusted);
    const tauRaw = tauAgainstTruth(event.projects, event.truth, rawMeanRanking(event.rubric, event.ballots));
    assert.ok(
      tauAdjusted > tauRaw - 0.03,
      `seed ${s}: normalization lost ground on a balanced design (${tauAdjusted.toFixed(3)} vs ${tauRaw.toFixed(3)})`,
    );
  }
});

test("the judge who marks everything a 3 is floored, discounted, and named", () => {
  const event = simulateEvent({
    projects: 40,
    judges: 8,
    reviewsPerProject: 4,
    seed: "flat",
    flatJudges: 2,
    imbalance: 0.5,
  });
  const result = normalizeScores(event.rubric, event.ballots);
  const flatIds = event.judges.filter((j) => j.flat).map((j) => j.id);
  assert.equal(flatIds.length, 2);
  for (const id of flatIds) {
    const fitted = result.judges.find((j) => j.judge === id);
    assert.ok(fitted, `judge ${id} is missing from the report`);
    assert.ok(Math.abs((fitted?.scaleRaw as number)) < 0.05, "an all-3s judge has no slope");
    assert.equal(fitted?.scale, 0.35, "the scale floor must hold, or dividing by it explodes");
    assert.equal(fitted?.clamped, true);
    assert.notEqual(fitted?.discrimination, "ok");
    assert.ok(
      (fitted?.informationWeight as number) < 0.2,
      `an undiscriminating judge must barely move the ranking, weight was ${fitted?.informationWeight}`,
    );
    assert.ok(
      result.warnings.some((w) => w.includes(id)),
      `the organizer must be told about ${id} by name`,
    );
  }
  // And the calibrated judges are not dragged down with them. The claim is a
  // separation, not an absolute floor: one of these judges genuinely marks with
  // about 0.6 of the panel's spread, and the fit is right to say so. What must not
  // happen is a real judge landing anywhere near the discounted weight of a judge
  // who marked everything the same.
  const flatWeight = result.judges.find((j) => flatIds.includes(j.judge))
    ?.informationWeight as number;
  for (const j of result.judges.filter((x) => !flatIds.includes(x.judge))) {
    assert.equal(j.discrimination, "ok");
    assert.ok(
      j.informationWeight > 2 * flatWeight,
      `judge ${j.judge} carries weight ${j.informationWeight.toFixed(3)}, too close to the ` +
        `${flatWeight.toFixed(3)} of a judge who marked everything a 3`,
    );
  }
});

test("a judge with too few ballots has their scale held at one rather than guessed", () => {
  const result = normalizeScores(rubric, [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 4),
    ballot("b3", "j1", "p3", 3),
    ballot("b4", "j1", "p4", 2),
    ballot("b5", "j2", "p1", 4),
    ballot("b6", "j2", "p2", 3),
    ballot("b7", "j3", "p3", 2),
  ]);
  const j3 = result.judges.find((j) => j.judge === "j3");
  assert.equal(j3?.ballots, 1);
  assert.equal(j3?.scale, 1);
  assert.equal(j3?.discrimination, "insufficient");
  assert.ok(result.warnings.some((w) => w.includes("j3") && w.includes("held at 1.0")));
});

test("the same ballots always produce the same table", () => {
  const event = simulateEvent({ projects: 30, judges: 6, reviewsPerProject: 3, seed: "determinism" });
  const once = normalizeScores(event.rubric, event.ballots);
  const twice = normalizeScores(event.rubric, [...event.ballots].reverse());
  assert.deepEqual(
    once.projects.map((p) => [p.project, p.rankAdjusted]),
    twice.projects.map((p) => [p.project, p.rankAdjusted]),
    "ballot insertion order must not change the ranking",
  );
  assert.ok(Math.abs(once.grandMean - twice.grandMean) < 1e-12);
});

test("standard errors shrink as evidence accumulates", () => {
  const thin = simulateEvent({ projects: 30, judges: 6, reviewsPerProject: 2, seed: "se" });
  const thick = simulateEvent({ projects: 30, judges: 6, reviewsPerProject: 5, seed: "se" });
  const seThin = mean(normalizeScores(thin.rubric, thin.ballots).projects.map((p) => p.standardError));
  const seThick = mean(normalizeScores(thick.rubric, thick.ballots).projects.map((p) => p.standardError));
  assert.ok(seThick < seThin, `more ballots must narrow the interval: ${seThick} vs ${seThin}`);
});

test("rank movement is reported with a consistent sign", () => {
  const event = simulateEvent({
    projects: 40,
    judges: 8,
    reviewsPerProject: 3,
    seed: "moves",
    imbalance: 0.7,
  });
  const result = normalizeScores(event.rubric, event.ballots);
  for (const p of result.projects) {
    assert.equal(p.rankMove, p.rankRaw - p.rankAdjusted);
  }
  assert.ok(
    result.projects.some((p) => p.rankMove !== 0),
    "on a correlated design, removing judge effects has to move somebody",
  );
  let sum = 0;
  for (const p of result.projects) sum += p.rankMove;
  assert.equal(sum, 0, "rank movements are a permutation and must net to zero");
});

// The defect this guards against was real and invisible: the published `scale` used
// to be estimated *after* the fit that produced the published `theta`, so the table
// showed three parameter sets and claimed they were one. Nothing detected it,
// because every individual number was plausible. The engine now ends with one
// additional fit at the settled parameters, and the property that makes that
// worthwhile is exactly this one: the ranking is recomputable from the numbers
// printed beside it, with no unpublished intermediate.
test("the published parameters reproduce the published ranking exactly", () => {
  for (const seed of ["closure-a", "closure-b", "closure-c"]) {
    const event = simulateEvent({
      projects: 25,
      judges: 7,
      reviewsPerProject: 3,
      seed,
      imbalance: 0.8,
      leniencySd: 0.8,
      scaleSpread: 0.4,
    });
    const fit = normalizeScores(event.rubric, event.ballots);
    const judge = new Map(fit.judges.map((j) => [j.judge, j]));

    // theta_i = sum_j s_j (y_ij - mu - leniency_j - pending_j) / sum_j s_j^2
    const numerator = new Map<string, number>();
    const denominator = new Map<string, number>();
    for (const b of event.ballots) {
      const j = judge.get(b.judge);
      assert.ok(j, `every judge in the ballots must appear in the fit: ${b.judge}`);
      const y = weightedTotal(event.rubric, b.scores);
      const term = j.scale * (y - fit.grandMean - j.leniency - j.leniencyPending);
      numerator.set(b.project, (numerator.get(b.project) ?? 0) + term);
      denominator.set(b.project, (denominator.get(b.project) ?? 0) + j.scale ** 2);
    }

    for (const p of fit.projects) {
      const rebuilt = (numerator.get(p.project) as number) / (denominator.get(p.project) as number);
      assert.ok(
        Math.abs(rebuilt - p.theta) < 1e-9,
        `theta for ${p.project} on seed ${seed} must be reproducible from the published ` +
          `parameters: got ${rebuilt}, published ${p.theta}`,
      );
      assert.ok(Math.abs(fit.grandMean + p.theta - p.adjusted) < 1e-12);
    }
  }
});

test("the reported leniency residual is the largest pending offset on the panel", () => {
  const event = simulateEvent({ projects: 18, judges: 5, reviewsPerProject: 3, seed: "pending" });
  const fit = normalizeScores(event.rubric, event.ballots);
  let largest = 0;
  for (const j of fit.judges) largest = Math.max(largest, Math.abs(j.leniencyPending));
  assert.ok(Math.abs(largest - fit.leniencyResidual) < 1e-15);
  assert.ok(fit.leniencyResidual >= 0);
});

test("a slope that was never estimated is reported as held, not as measured", () => {
  // `scaleRaw` is 1 both for a judge whose slope was measured at exactly 1 and for
  // a judge whose slope was never measured at all. Those mean opposite things, and
  // before `slopeFitted` existed the output could not tell them apart.
  const result = normalizeScores(rubric, [
    ballot("b1", "j1", "p1", 5),
    ballot("b2", "j1", "p2", 4),
    ballot("b3", "j1", "p3", 3),
    ballot("b4", "j1", "p4", 2),
    ballot("b5", "j2", "p1", 4),
    ballot("b6", "j2", "p2", 3),
    ballot("b7", "j2", "p3", 2),
    ballot("b8", "j3", "p3", 2),
  ]);
  const j3 = result.judges.find((j) => j.judge === "j3");
  assert.equal(j3?.slopeFitted, false, "one ballot cannot yield a slope");
  assert.equal(j3?.scaleRaw, 1, "an unfitted slope is reported as the held value");
  const j1 = result.judges.find((j) => j.judge === "j1");
  assert.equal(j1?.slopeFitted, true, "four spread-out ballots are enough to fit a slope");

  // And the invariant across an ordinary panel: nobody is ever marked unmeasurable
  // while carrying a measured slope.
  const event = simulateEvent({ projects: 30, judges: 9, reviewsPerProject: 2, seed: "held" });
  for (const j of normalizeScores(event.rubric, event.ballots).judges) {
    if (j.slopeFitted) continue;
    assert.equal(j.scaleRaw, 1, `${j.judge} has no fitted slope, so scaleRaw must be 1`);
    assert.equal(j.discrimination, "insufficient");
  }
});

test("the diagnostic list and the warning list tell the same story", () => {
  const event = simulateEvent({ projects: 12, judges: 4, reviewsPerProject: 2, seed: "notes" });
  const fit = normalizeScores(event.rubric, event.ballots);
  const warned = fit.notes.filter((n) => n.severity === "warn").map((n) => n.message);
  assert.deepEqual(warned, fit.warnings, "every warning must be a coded note and vice versa");
  for (const n of fit.notes) {
    assert.match(n.code, /^[a-z]+\.[a-zA-Z]+$/, `diagnostic codes are dotted: ${n.code}`);
    assert.ok(n.message.length > 20, `a diagnostic has to say something: ${n.code}`);
  }
  const codes = new Set(fit.notes.map((n) => n.code));
  assert.equal(codes.size, fit.notes.length, "a fit should not report the same code twice");
});

test("the fit reports its own effort honestly", () => {
  const event = simulateEvent({ projects: 20, judges: 6, reviewsPerProject: 3, seed: "effort" });
  const fit = normalizeScores(event.rubric, event.ballots);
  assert.equal(fit.observations, event.ballots.length);
  assert.ok(fit.df >= 1);
  assert.ok(fit.rounds >= 1 && fit.rounds <= NORMALIZE_DEFAULTS.rounds);
  assert.ok(
    fit.sweeps > fit.rounds,
    "sweeps count inner backfitting passes across every round plus the final fit",
  );
  assert.equal(fit.settled, fit.outerMovement < NORMALIZE_DEFAULTS.outerTolerance);
  // A run that exhausts its bounded budget reports that fact without claiming convergence.
  if (!fit.settled && fit.leniencyResidual <= 0.01) {
    assert.ok(fit.notes.some((n) => n.code === "fit.roundsExhausted" && n.severity === "info"));
    assert.equal(
      fit.warnings.filter((w) => w.includes("wanted to move")).length,
      0,
      "a residual below the last printed digit must not raise a warning",
    );
  }
});
