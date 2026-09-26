import test from "node:test";
import assert from "node:assert/strict";

import type { Comparison, ProjectId } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import { fitBradleyTerry, winProbability } from "../src/judging/bradleyterry.ts";
import { kendallTau, mean, sd } from "../src/judging/stats.ts";
import { simulateComparisons, simulateEvent } from "../src/judging/simulate.ts";

const cmp = (id: string, judge: string, left: ProjectId, right: ProjectId, winner: ProjectId): Comparison =>
  ({ id, judge, left, right, winner });

const betaOf = (result: { strengths: { project: ProjectId; beta: number }[] }, p: ProjectId): number =>
  result.strengths.find((s) => s.project === p)?.beta as number;

test("win probability is a logistic on the strength difference", () => {
  assert.equal(winProbability(0, 0), 0.5);
  assert.equal(winProbability(1, 1), 0.5);
  assert.ok(Math.abs(winProbability(1, 0) + winProbability(0, 1) - 1) < 1e-15);
  assert.ok(winProbability(2, 0) > winProbability(1, 0));
  assert.ok(winProbability(0, 2) < 0.5);
  assert.ok(Math.abs(winProbability(1, 0) - 1 / (1 + Math.exp(-1))) < 1e-15);
});

test("a transitive chain comes out in the right order", () => {
  const result = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "a", "b", "a"),
    cmp("c3", "j3", "b", "c", "b"),
    cmp("c4", "j4", "b", "c", "b"),
    cmp("c5", "j5", "a", "c", "a"),
  ]);
  assert.equal(result.converged, true);
  assert.deepEqual(result.strengths.map((s) => s.project), ["a", "b", "c"]);
  assert.ok(betaOf(result, "a") > betaOf(result, "b"));
  assert.ok(betaOf(result, "b") > betaOf(result, "c"));
  assert.deepEqual(result.strengths.map((s) => s.rank), [1, 2, 3]);
});

test("strengths are centred, so the numbers are comparable across events", () => {
  const result = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "b", "c", "b"),
    cmp("c3", "j3", "c", "a", "c"),
  ]);
  assert.ok(Math.abs(mean(result.strengths.map((s) => s.beta))) < 1e-12);
});

test("wins and losses are counted per project", () => {
  const result = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "a", "c", "a"),
    cmp("c3", "j3", "b", "c", "c"),
  ]);
  const a = result.strengths.find((s) => s.project === "a");
  assert.equal(a?.wins, 2);
  assert.equal(a?.losses, 0);
  assert.equal(a?.comparisons, 2);
  const b = result.strengths.find((s) => s.project === "b");
  assert.equal(b?.wins, 0);
  assert.equal(b?.losses, 2);
});

test("a rock-paper-scissors cycle produces a flat, finite fit", () => {
  const result = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "b", "c", "b"),
    cmp("c3", "j3", "c", "a", "c"),
  ]);
  assert.equal(result.converged, true);
  for (const s of result.strengths) {
    assert.ok(Number.isFinite(s.beta));
    assert.ok(Math.abs(s.beta) < 1e-9, `a perfect cycle has no ordering, got ${s.beta}`);
  }
});

test("an undefeated project gets a finite strength and an honest warning", () => {
  // Without the prior the likelihood is unbounded here and the iteration diverges.
  const result = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "a", "c", "a"),
    cmp("c3", "j3", "b", "c", "b"),
  ]);
  const a = result.strengths.find((s) => s.project === "a");
  assert.equal(a?.rank, 1);
  assert.ok(Number.isFinite(a?.beta as number), "an undefeated project must not run off to infinity");
  assert.ok((a?.beta as number) < 10, `the prior should keep this modest, got ${a?.beta}`);
  assert.ok(result.warnings.some((w) => w.includes("Unbounded likelihood without the prior")));
  assert.equal(result.converged, true);
});

test("a heavier prior pulls the field together", () => {
  const comparisons = [
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "a", "b", "a"),
    cmp("c3", "j3", "a", "b", "a"),
  ];
  const weak = fitBradleyTerry(comparisons, undefined, { prior: 0.5 });
  const strong = fitBradleyTerry(comparisons, undefined, { prior: 8 });
  const spread = (r: { strengths: { beta: number }[] }): number =>
    Math.abs((r.strengths[0]?.beta as number) - (r.strengths[1]?.beta as number));
  assert.ok(spread(weak) > spread(strong), "a stronger prior must shrink the gap");
  assert.match(strong.method, /prior=8/);
});

test("a disconnected comparison graph still converges, and says it is disconnected", () => {
  const result = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "c", "d", "c"),
  ]);
  assert.equal(result.componentCount, 2);
  assert.equal(result.connected, false);
  assert.equal(result.converged, true);
  assert.ok(result.warnings.some((w) => w.includes("disconnected groups")));
  for (const s of result.strengths) assert.ok(Number.isFinite(s.beta));
});

test("projects with no comparisons at all are carried, not dropped", () => {
  const result = fitBradleyTerry([cmp("c1", "j1", "a", "b", "a")], ["a", "b", "z"]);
  assert.equal(result.strengths.length, 3);
  const z = result.strengths.find((s) => s.project === "z");
  assert.equal(z?.comparisons, 0);
  assert.ok(Number.isFinite(z?.beta as number));
  assert.ok(result.warnings.some((w) => w.includes("fewer than two opponents")));
});

test("malformed comparisons are refused with a code", () => {
  assert.throws(() => fitBradleyTerry([cmp("c1", "j1", "a", "a", "a")]), (e: unknown) =>
    e instanceof JudgingError && e.code === "comparison.self");
  assert.throws(() => fitBradleyTerry([cmp("c1", "j1", "a", "b", "c")]), (e: unknown) =>
    e instanceof JudgingError && e.code === "comparison.winner");
  assert.throws(() => fitBradleyTerry([]), (e: unknown) =>
    e instanceof JudgingError && e.code === "comparison.empty");
});

test("repeated comparisons of the same pair accumulate rather than overwrite", () => {
  const one = fitBradleyTerry([cmp("c1", "j1", "a", "b", "a")]);
  const five = fitBradleyTerry([
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "a", "b", "a"),
    cmp("c3", "j3", "a", "b", "a"),
    cmp("c4", "j4", "a", "b", "a"),
    cmp("c5", "j5", "a", "b", "a"),
  ]);
  assert.ok(
    betaOf(five, "a") > betaOf(one, "a"),
    "five judges agreeing is stronger evidence than one",
  );
});

test("the planted ordering is recovered from simulated comparisons", () => {
  const event = simulateEvent({ projects: 120, judges: 20, reviewsPerProject: 4, seed: "bt" });
  const comparisons = simulateComparisons(event, { perJudge: 30 });
  const result = fitBradleyTerry(comparisons, event.projects);
  assert.equal(result.connected, true, "the scheduler is supposed to keep the field connected");
  assert.equal(result.converged, true);
  const truth = event.projects.map((p) => event.truth.get(p) as number);
  const fitted = event.projects.map((p) => betaOf(result, p));
  const tau = kendallTau(truth, fitted);
  assert.ok(tau > 0.55, `recovered tau was only ${tau.toFixed(3)} from ${comparisons.length} comparisons`);
  assert.ok(sd(fitted) > 0.2, "a fit that flattens everything has recovered nothing");
});

test("more comparisons recover more of the truth", () => {
  const event = simulateEvent({ projects: 80, judges: 16, reviewsPerProject: 4, seed: "growth" });
  const truth = event.projects.map((p) => event.truth.get(p) as number);
  const tauAt = (perJudge: number): number => {
    const result = fitBradleyTerry(simulateComparisons(event, { perJudge }), event.projects);
    return kendallTau(truth, event.projects.map((p) => betaOf(result, p)));
  };
  const few = tauAt(5);
  const many = tauAt(40);
  assert.ok(many > few + 0.1, `tau did not improve with volume: ${few.toFixed(3)} then ${many.toFixed(3)}`);
});

test("the log-likelihood is finite, negative, and improves on a coin flip", () => {
  const event = simulateEvent({ projects: 40, judges: 10, reviewsPerProject: 4, seed: "ll" });
  const comparisons = simulateComparisons(event, { perJudge: 20 });
  const result = fitBradleyTerry(comparisons, event.projects);
  assert.ok(Number.isFinite(result.logLikelihood));
  assert.ok(result.logLikelihood < 0);
  const coinFlip = comparisons.length * Math.log(0.5);
  assert.ok(
    result.logLikelihood > coinFlip,
    `the fit explains less than guessing: ${result.logLikelihood.toFixed(2)} vs ${coinFlip.toFixed(2)}`,
  );
});

test("the same comparisons always produce the same ranking", () => {
  const event = simulateEvent({ projects: 30, judges: 8, reviewsPerProject: 3, seed: "det" });
  const comparisons = simulateComparisons(event, { perJudge: 10 });
  const once = fitBradleyTerry(comparisons, event.projects);
  const twice = fitBradleyTerry([...comparisons].reverse(), event.projects);
  assert.deepEqual(
    once.strengths.map((s) => [s.project, s.rank]),
    twice.strengths.map((s) => [s.project, s.rank]),
  );
});

// The prior makes the objective strictly concave in the log-strengths, so the fixed point
// is unique and a starting point can only change how far the iteration has to walk. That
// is the entire justification for the warm start `bootstrap.ts` relies on to fit four
// hundred replicates, so it is pinned here rather than left as a claim in a comment.
test("a warm start finds the same answer as a cold one, only sooner", () => {
  const event = simulateEvent({ projects: 60, judges: 12, reviewsPerProject: 4, seed: "warm" });
  const comparisons = simulateComparisons(event, { perJudge: 20 });
  const cold = fitBradleyTerry(comparisons, event.projects, { tolerance: 1e-12 });
  const start = new Map(cold.strengths.map((s) => [s.project, Math.exp(s.beta)]));
  const warm = fitBradleyTerry(comparisons, event.projects, { tolerance: 1e-12, start });
  assert.equal(warm.converged, true);
  assert.ok(warm.iterations < cold.iterations, "starting at the answer should take fewer sweeps");
  for (const s of warm.strengths) {
    const was = betaOf(cold, s.project);
    assert.ok(
      Math.abs(s.beta - was) < 1e-8,
      `${s.project} moved from ${was} to ${s.beta} on a warm start`,
    );
  }
  assert.deepEqual(
    warm.strengths.map((s) => [s.project, s.rank]),
    cold.strengths.map((s) => [s.project, s.rank]),
  );
});

test("a deliberately wrong start converges to the same place", () => {
  const event = simulateEvent({ projects: 40, judges: 10, reviewsPerProject: 4, seed: "wrong" });
  const comparisons = simulateComparisons(event, { perJudge: 15 });
  const plain = fitBradleyTerry(comparisons, event.projects, { tolerance: 1e-12 });
  // Reversed strengths: the last project starts where the first one belongs.
  const reversed = new Map(
    plain.strengths.map((s, i) => [
      s.project,
      Math.exp(betaOf(plain, (plain.strengths[plain.strengths.length - 1 - i] as { project: ProjectId }).project)),
    ]),
  );
  const fromWrong = fitBradleyTerry(comparisons, event.projects, { tolerance: 1e-12, start: reversed });
  for (const s of fromWrong.strengths) {
    assert.ok(Math.abs(s.beta - betaOf(plain, s.project)) < 1e-8, `${s.project} landed somewhere else`);
  }
});

test("a partial, empty or nonsensical start map is a hint and not an error", () => {
  const comparisons = [
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "b", "c", "b"),
    cmp("c3", "j3", "a", "c", "a"),
  ];
  const plain = fitBradleyTerry(comparisons, ["a", "b", "c"], { tolerance: 1e-12 });
  const hints: ReadonlyMap<ProjectId, number>[] = [
    new Map(),
    new Map([["a", 4]]),
    new Map([["a", 0], ["b", -3], ["c", Number.NaN]]),
    new Map([["a", 2], ["zz", 9]]),
  ];
  for (const start of hints) {
    const hinted = fitBradleyTerry(comparisons, ["a", "b", "c"], { tolerance: 1e-12, start });
    assert.equal(hinted.strengths.length, 3);
    for (const s of hinted.strengths) {
      assert.ok(
        Math.abs(s.beta - betaOf(plain, s.project)) < 1e-8,
        `${s.project} ended up elsewhere with hint ${JSON.stringify([...start])}`,
      );
    }
  }
});
