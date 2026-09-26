import test from "node:test";
import assert from "node:assert/strict";

import { JudgingError } from "../src/judging/types.ts";
import type { NormalizationResult } from "../src/judging/normalize.ts";
import { normalizeScores } from "../src/judging/normalize.ts";
import type { BradleyTerryResult } from "../src/judging/bradleyterry.ts";
import { fitBradleyTerry } from "../src/judging/bradleyterry.ts";
import { compareRankings } from "../src/judging/agreement.ts";
import { simulateComparisons, simulateEvent } from "../src/judging/simulate.ts";

// Only the fields the agreement report reads are supplied. Building whole
// fitted results by hand would obscure what each case is actually testing; the
// integration test at the bottom runs the real fitters end to end.
const rubricSide = (scores: Record<string, number>, ballots = 4): NormalizationResult =>
  ({
    projects: Object.entries(scores).map(([project, adjusted]) => ({ project, adjusted, ballots })),
  }) as unknown as NormalizationResult;

const pairwiseSide = (
  scores: Record<string, number>,
  extra: { comparisons?: number; connected?: boolean; componentCount?: number } = {},
): BradleyTerryResult =>
  ({
    strengths: Object.entries(scores).map(([project, beta]) => ({
      project,
      beta,
      comparisons: extra.comparisons ?? 8,
    })),
    connected: extra.connected ?? true,
    componentCount: extra.componentCount ?? 1,
  }) as unknown as BradleyTerryResult;

const five = { a: 5, b: 4, c: 3, d: 2, e: 1 };

test("two methods in perfect agreement report tau 1 and nothing to review", () => {
  const result = compareRankings(rubricSide(five), pairwiseSide({ a: 2, b: 1, c: 0, d: -1, e: -2 }));
  assert.equal(result.tau, 1);
  assert.equal(result.disagreements.length, 0);
  assert.equal(result.topOverlap.get(1), 1);
  assert.equal(result.topOverlap.get(3), 1);
  assert.equal(result.topOverlap.get(5), 1);
  assert.equal(result.topOverlap.has(10), false, "k above the field size is not a meaningful overlap");
  for (const p of result.projects) assert.equal(p.rankGap, 0);
  assert.equal(result.warnings.length, 0);
});

test("a reversed pairwise ranking is reported as total disagreement, not smoothed over", () => {
  const result = compareRankings(rubricSide(five), pairwiseSide({ a: -2, b: -1, c: 0, d: 1, e: 2 }));
  assert.equal(result.tau, -1);
  assert.equal(result.topOverlap.get(1), 0);
  assert.equal(result.topOverlap.get(5), 1, "the whole field is the whole field, whatever the order");
  assert.ok(result.warnings.some((w) => w.includes("agree only weakly")));
  // A five-project field cannot produce a gap larger than four, so the derived
  // three-place threshold catches the two ends and nothing else.
  assert.equal(result.threshold, 3);
  assert.deepEqual(result.disagreements.map((p) => p.project), ["a", "e"]);
  assert.equal(result.flaggedCount, 2);
});

test("the gap is signed so that positive means pairwise rates it higher", () => {
  // The rubric has e last; the pairwise round puts it first.
  const result = compareRankings(rubricSide(five), pairwiseSide({ a: 0, b: -1, c: -2, d: -3, e: 9 }));
  const e = result.projects.find((p) => p.project === "e");
  assert.equal(e?.rubricRank, 5);
  assert.equal(e?.pairwiseRank, 1);
  assert.equal(e?.rankGap, 4);
  const a = result.projects.find((p) => p.project === "a");
  assert.equal(a?.rankGap, -1, "a slipped one place, so its gap is negative");
});

test("the disagreement shortlist is ordered worst first", () => {
  const result = compareRankings(
    rubricSide({ a: 5, b: 4, c: 3, d: 2, e: 1, f: 0 }),
    pairwiseSide({ a: 3, b: -9, c: 2, d: 1, e: 0, f: 4 }),
    { disagreementThreshold: 2 },
  );
  const gaps = result.disagreements.map((p) => Math.abs(p.rankGap));
  assert.deepEqual(gaps, [...gaps].sort((x, y) => y - x));
  // f went from last to first, five places; b fell from second to last, four.
  assert.deepEqual(result.disagreements.map((p) => p.project), ["f", "b"]);
  assert.ok(result.disagreements.every((p) => p.flagged));
});

test("the threshold decides the length of the list a human has to work through", () => {
  const rubric = rubricSide({ a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 });
  const pairwise = pairwiseSide({ a: 1, b: -3, c: 0.5, d: 0, e: -1, f: 2 });
  const strict = compareRankings(rubric, pairwise, { disagreementThreshold: 2 });
  const loose = compareRankings(rubric, pairwise, { disagreementThreshold: 5 });
  assert.ok(strict.disagreements.length > loose.disagreements.length);
  assert.match(strict.method, /threshold=2/);
});

test("the blend collapses onto each method at the ends of the weight", () => {
  const rubric = rubricSide(five);
  const pairwise = pairwiseSide({ a: 0, b: 1, c: 2, d: 3, e: 4 });
  const allRubric = compareRankings(rubric, pairwise, { pairwiseWeight: 0 });
  const allPairwise = compareRankings(rubric, pairwise, { pairwiseWeight: 1 });
  for (const p of allRubric.projects) assert.equal(p.blendedRank, p.rubricRank);
  for (const p of allPairwise.projects) assert.equal(p.blendedRank, p.pairwiseRank);
});

test("an even blend of two opposed rankings is flat rather than arbitrary", () => {
  // Equal spacing on both sides, exactly reversed: standardising makes the two
  // z-scores cancel. A blend that produced a confident ordering here would be
  // inventing a winner out of a tie.
  const result = compareRankings(rubricSide(five), pairwiseSide({ a: -2, b: -1, c: 0, d: 1, e: 2 }), {
    pairwiseWeight: 0.5,
  });
  for (const p of result.projects) {
    assert.ok(Math.abs(p.blended) < 1e-12, `expected a flat blend, got ${p.blended} for ${p.project}`);
    assert.ok(Math.abs(p.rubricZ + p.pairwiseZ) < 1e-12);
  }
});

test("top-k overlap counts the projects both methods put in the top k", () => {
  // Rubric top 3 is a, b, c. Pairwise top 3 is a, b, f. Two of three shared.
  const result = compareRankings(
    rubricSide({ a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 }),
    pairwiseSide({ a: 3, b: 2, c: -2, d: -3, e: -4, f: 1 }),
  );
  assert.equal(result.topOverlap.get(1), 1);
  assert.equal(result.topOverlap.get(3), 2 / 3);
  assert.equal(result.topOverlap.get(5), 4 / 5);
  assert.equal(result.topOverlap.has(6), false, "6 is not in the default cut-offs");
});

test("custom cut-offs are honoured", () => {
  const result = compareRankings(rubricSide(five), pairwiseSide({ a: 2, b: 1, c: 0, d: -1, e: -2 }), {
    topK: [2, 4],
  });
  assert.deepEqual([...result.topOverlap.keys()], [2, 4]);
});

test("projects only one method could rank are named, not silently dropped", () => {
  const result = compareRankings(
    rubricSide({ a: 5, b: 4, onlyRubric: 3 }),
    pairwiseSide({ a: 1, b: 0, onlyPairwise: -1 }),
  );
  assert.deepEqual(result.projects.map((p) => p.project), ["a", "b"]);
  assert.deepEqual(result.rubricOnly, ["onlyRubric"]);
  assert.deepEqual(result.pairwiseOnly, ["onlyPairwise"]);
  assert.ok(result.warnings.some((w) => w.includes("onlyRubric") && w.includes("no comparisons")));
  assert.ok(result.warnings.some((w) => w.includes("onlyPairwise") && w.includes("never scored")));
});

test("ranks are recomputed over the shared set rather than carried across", () => {
  // b is second of three on the rubric side but the pairwise side never saw a,
  // so over the two projects they share, b is second of two — and comparing
  // "second of three" with "first of two" would invent a disagreement.
  const result = compareRankings(
    rubricSide({ a: 9, b: 5, c: 4 }),
    pairwiseSide({ b: 1, c: 0 }),
  );
  const b = result.projects.find((p) => p.project === "b");
  assert.equal(b?.rubricRank, 1);
  assert.equal(b?.pairwiseRank, 1);
  assert.equal(b?.rankGap, 0);
});

test("a disconnected comparison graph is disclosed as a caveat on the whole report", () => {
  const result = compareRankings(
    rubricSide(five),
    pairwiseSide({ a: 2, b: 1, c: 0, d: -1, e: -2 }, { connected: false, componentCount: 3 }),
  );
  assert.ok(result.warnings.some((w) => w.includes("3 pieces")));
});

test("thin pairwise coverage is not allowed to overrule a rubric rank quietly", () => {
  const result = compareRankings(
    rubricSide(five),
    pairwiseSide({ a: 2, b: 1, c: 0, d: -1, e: -2 }, { comparisons: 1 }),
  );
  assert.ok(result.warnings.some((w) => w.includes("fewer than 4 comparisons")));
  assert.ok(result.warnings.some((w) => w.includes("provisional")));
  for (const p of result.projects) assert.equal(p.comparisons, 1);
});

test("bad inputs are refused with a code", () => {
  assert.throws(
    () => compareRankings(rubricSide(five), pairwiseSide(five), { pairwiseWeight: 1.5 }),
    (e: unknown) => e instanceof JudgingError && e.code === "agreement.weight",
  );
  assert.throws(
    () => compareRankings(rubricSide({ a: 1 }), pairwiseSide({ z: 1 })),
    (e: unknown) => e instanceof JudgingError && e.code === "agreement.disjoint",
  );
});

test("ballot and comparison counts travel with each row", () => {
  const result = compareRankings(rubricSide(five, 7), pairwiseSide(five, { comparisons: 11 }));
  for (const p of result.projects) {
    assert.equal(p.ballots, 7);
    assert.equal(p.comparisons, 11);
  }
});

test("on a real event the two methods broadly agree, and the shortlist stays short", () => {
  // Both modes are fitted from the same planted truth, so they should mostly
  // agree; where they do not, the organizer gets a list they can actually get
  // through before a ceremony rather than a second full ranking.
  const event = simulateEvent({
    projects: 60,
    judges: 12,
    reviewsPerProject: 4,
    seed: "agree",
    leniencySd: 0.6,
    imbalance: 0.5,
  });
  const rubric = normalizeScores(event.rubric, event.ballots);
  const pairwise = fitBradleyTerry(simulateComparisons(event, { perJudge: 30 }), event.projects);
  const result = compareRankings(rubric, pairwise);

  assert.ok(result.tau > 0.4, `the two methods should broadly agree, tau was ${result.tau.toFixed(3)}`);
  assert.equal(result.rubricOnly.length, 0);
  assert.equal(result.pairwiseOnly.length, 0);
  assert.equal(result.projects.length, 60);
  assert.equal(result.threshold, 9, "0.15 of a 60-project field");
  assert.ok(result.disagreements.length <= 10, "the shortlist is capped so it stays workable");
  assert.ok(
    result.flaggedCount >= result.disagreements.length,
    "the full count must be reported even when the list is trimmed",
  );
  assert.ok(
    result.medianGap < result.threshold,
    `a threshold below the ${result.medianGap}-place noise floor would flag noise`,
  );
  assert.ok((result.topOverlap.get(10) as number) >= 0.5, "the two methods should mostly share a top ten");
  // Every flagged project is genuinely far apart, and no unflagged one is.
  for (const p of result.projects) {
    assert.equal(p.flagged, Math.abs(p.rankGap) >= result.threshold);
  }
});

test("a field too large for its comparison volume is told so instead of being ranked", () => {
  // 120 projects and only ten comparisons per judge. The Bradley-Terry fit is
  // real but imprecise, and the median project moves further between the two
  // methods than the disagreement threshold — so no individual gap means
  // anything, and saying that is more use than a shortlist of noise.
  const event = simulateEvent({ projects: 120, judges: 12, reviewsPerProject: 4, seed: "thin-field" });
  const rubric = normalizeScores(event.rubric, event.ballots);
  const pairwise = fitBradleyTerry(simulateComparisons(event, { perJudge: 10 }), event.projects);
  const result = compareRankings(rubric, pairwise);
  assert.ok(result.medianGap >= result.threshold, `median gap ${result.medianGap} vs ${result.threshold}`);
  assert.ok(result.warnings.some((w) => w.includes("precision problem")));
  assert.ok(result.warnings.some((w) => w.includes("top-k overlap")));
});

test("the shortlist cap can be lifted for an organizer who wants the whole list", () => {
  const event = simulateEvent({ projects: 60, judges: 12, reviewsPerProject: 4, seed: "cap", imbalance: 0.5 });
  const rubric = normalizeScores(event.rubric, event.ballots);
  const pairwise = fitBradleyTerry(simulateComparisons(event, { perJudge: 20 }), event.projects);
  const capped = compareRankings(rubric, pairwise);
  const whole = compareRankings(rubric, pairwise, { maxDisagreements: Number.MAX_SAFE_INTEGER });
  assert.equal(whole.disagreements.length, whole.flaggedCount);
  assert.equal(capped.flaggedCount, whole.flaggedCount, "the cap must not change what counts as flagged");
  assert.ok(capped.disagreements.length <= 10);
  assert.ok(capped.warnings.some((w) => w.includes("widest")));
  assert.ok(!whole.warnings.some((w) => w.includes("widest")));
});

test("the same two rankings always produce the same report", () => {
  const event = simulateEvent({ projects: 30, judges: 8, reviewsPerProject: 3, seed: "agree-det" });
  const rubric = normalizeScores(event.rubric, event.ballots);
  const pairwise = fitBradleyTerry(simulateComparisons(event, { perJudge: 12 }), event.projects);
  const once = compareRankings(rubric, pairwise);
  const twice = compareRankings(rubric, pairwise);
  assert.equal(once.tau, twice.tau);
  assert.deepEqual(
    once.disagreements.map((p) => [p.project, p.rankGap]),
    twice.disagreements.map((p) => [p.project, p.rankGap]),
  );
});
