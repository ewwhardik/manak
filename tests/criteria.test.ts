import test from "node:test";
import assert from "node:assert/strict";

import type { Ballot, Rubric } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import { criterionInsights, CRITERIA_DEFAULTS } from "../src/judging/criteria.ts";
import { normalizeScores } from "../src/judging/normalize.ts";
import { normalizedWeights } from "../src/judging/weighted.ts";
import { DEMO_RUBRIC, simulateEvent } from "../src/judging/simulate.ts";

const rubric: Rubric = {
  id: "r",
  version: 3,
  criteria: [
    { key: "tech", label: "Technical depth", weight: 2, min: 1, max: 5 },
    { key: "craft", label: "Craft", weight: 1, min: 1, max: 5 },
    { key: "impact", label: "Impact", weight: 1, min: 1, max: 5 },
  ],
};

const judges = ["j1", "j2", "j3", "j4"];
const projects = ["p1", "p2", "p3", "p4", "p5", "p6"];

/** Build a full crossed design from a score function, so every cell is filled. */
const design = (score: (judge: string, project: string, key: string) => number): Ballot[] => {
  const out: Ballot[] = [];
  let n = 0;
  for (const project of projects) {
    for (const judge of judges) {
      const scores: Record<string, number> = {};
      for (const c of rubric.criteria) {
        scores[c.key] = Math.max(c.min, Math.min(c.max, Math.round(score(judge, project, c.key))));
      }
      out.push({ id: `b${n++}`, judge, project, rubricVersion: rubric.version, scores });
    }
  }
  return out;
};

/** A clean quality gradient: project index decides the score, nobody disagrees. */
const gradient = (_judge: string, project: string): number => 5 - projects.indexOf(project) * 0.8;

test("a criterion nobody varies is called flat and its wasted weight is quantified", () => {
  const result = criterionInsights(
    rubric,
    design((j, p, key) => (key === "craft" ? 3 : gradient(j, p))),
  );
  const craft = result.criteria.find((c) => c.key === "craft");
  assert.equal(craft?.verdict, "flat");
  assert.equal(craft?.observedSd, 0);
  assert.equal(craft?.rangeUsed, 0);
  assert.equal(craft?.discrimination, 0);

  const note = result.notes.find((n) => n.code === "criterion.flat");
  assert.equal(note?.severity, "warn");
  assert.deepEqual(note?.subjects, ["craft"]);
  // 1 of 4 weight units, so 25% of the total is being spent on a constant.
  assert.ok(note?.message.includes("25%"), `the wasted weight must be named: ${note?.message}`);
  assert.ok(result.warnings.includes(note?.message as string));

  for (const other of result.criteria.filter((c) => c.key !== "craft")) {
    assert.equal(other.verdict, "discriminating");
  }
});

test("a criterion that only records judge disagreement is called weak", () => {
  // Project quality is identical everywhere on `impact`; the only variation is a
  // per-judge offset, which is exactly the spread this verdict is meant to catch.
  const offsets = new Map(judges.map((j, i) => [j, [0, 1, -1, 2][i] as number]));
  const result = criterionInsights(
    rubric,
    design((j, p, key) => (key === "impact" ? 3 + (offsets.get(j) as number) : gradient(j, p))),
  );
  const impact = result.criteria.find((c) => c.key === "impact");
  assert.equal(impact?.verdict, "weak");
  assert.ok(
    (impact?.discrimination as number) < CRITERIA_DEFAULTS.weakDiscrimination,
    `between-project share should be near zero, got ${impact?.discrimination}`,
  );
  const note = result.notes.find((n) => n.code === "criterion.weak");
  assert.equal(note?.severity, "warn");
  assert.deepEqual(note?.subjects, ["impact"]);
});

test("weights are reported as shares of the total, not as the numbers in the rubric", () => {
  const result = criterionInsights(rubric, design(gradient));
  const expected = normalizedWeights(rubric.criteria);
  let sum = 0;
  for (const c of result.criteria) {
    assert.equal(c.weight, expected.get(c.key));
    sum += c.weight;
  }
  assert.ok(Math.abs(sum - 1) < 1e-12, "shares must sum to one");
  assert.equal(result.criteria.find((c) => c.key === "tech")?.weight, 0.5);
  // The declared scale is echoed so a reader does not need the rubric in hand.
  for (const c of result.criteria) {
    assert.equal(c.scaleMin, 1);
    assert.equal(c.scaleMax, 5);
    assert.equal(c.ballots, projects.length * judges.length);
  }
  assert.equal(
    result.criteria.map((c) => c.key).join(","),
    rubric.criteria.map((c) => c.key).join(","),
    "criteria are reported in rubric order, not sorted behind the organizer's back",
  );
});

test("two criteria that are one question asked twice are named as redundant", () => {
  const result = criterionInsights(
    rubric,
    // `craft` copies `tech` exactly; `impact` runs the other way.
    design((j, p, key) => (key === "impact" ? 1 + projects.indexOf(p) * 0.8 : gradient(j, p))),
  );
  const pair = result.redundant.find(
    (r) => (r.a === "tech" && r.b === "craft") || (r.a === "craft" && r.b === "tech"),
  );
  assert.ok(pair, "an exact copy has to be flagged");
  assert.ok((pair?.correlation as number) > 0.99);
  const note = result.notes.find(
    (n) => n.code === "criterion.redundant" && n.subjects.includes("tech"),
  );
  assert.equal(note?.severity, "info");
  assert.ok(note?.message.includes("75%"), `combined weight must be named: ${note?.message}`);

  // A perfect inverse is the same redundancy wearing a minus sign, and the
  // threshold is on the magnitude, so it is caught too.
  assert.ok(
    result.redundant.some((r) => r.correlation < -0.99),
    "an inverted duplicate is still a duplicate",
  );
  assert.ok(
    result.redundant.every(
      (r, i) => i === 0 || Math.abs(r.correlation) <= Math.abs(result.redundant[i - 1]?.correlation as number),
    ),
    "strongest first",
  );
  assert.ok(result.meanCorrelation > 0 && result.meanCorrelation <= 1);
});

test("a uniformly harsh judge does not make every criterion look contested", () => {
  // j1 marks two points low on everything. `judgeSpread` sees that on all three
  // criteria; `judgeDivergence` is the number that knows it is one judge, not three
  // disputed criteria, and `contested` is decided on the latter.
  const result = criterionInsights(
    rubric,
    design((j, p) => gradient(j, p) - (j === "j1" ? 2 : 0)),
  );
  assert.equal(result.contested, null, "general strictness is not a contested criterion");
  for (const c of result.criteria) {
    assert.ok(c.judgeSpread > 0.3, `raw spread is inflated by the harsh judge: ${c.judgeSpread}`);
    assert.ok(
      c.judgeDivergence < 1e-9,
      `divergence must subtract that judge's own baseline: ${c.judgeDivergence}`,
    );
  }
  assert.equal(
    result.notes.filter((n) => n.code === "criterion.contested").length,
    0,
    "and no note is raised",
  );
});

test("a genuine quarrel about one criterion is found, and named", () => {
  // Half the panel rates `craft` high and half rates it low, while agreeing about
  // everything else. No judge is harsher overall than any other.
  const result = criterionInsights(
    rubric,
    design((j, p, key) => {
      const base = gradient(j, p);
      if (key !== "craft") return base;
      return base + (j === "j1" || j === "j2" ? 2 : -2);
    }),
  );
  assert.equal(result.contested, "craft");
  const craft = result.criteria.find((c) => c.key === "craft");
  const others = result.criteria.filter((c) => c.key !== "craft");
  // Subtracting each judge's rubric-wide baseline leaks a fixed fraction of a real
  // quarrel into the innocent criteria: with k criteria the guilty one reads exactly
  // (k - 1) times the others. Asserting the law rather than a loose inequality means
  // this test fails if the centring ever changes, which is the point of having it.
  for (const other of others) {
    const ratio = (craft?.judgeDivergence as number) / other.judgeDivergence;
    assert.ok(
      Math.abs(ratio - (rubric.criteria.length - 1)) < 1e-9,
      `expected a ratio of ${rubric.criteria.length - 1}, got ${ratio}`,
    );
  }
  assert.ok(
    (craft?.judgeDivergence as number) >= CRITERIA_DEFAULTS.contestedSpread,
    `and the quarrel must clear the threshold: ${craft?.judgeDivergence}`,
  );
  const note = result.notes.find((n) => n.code === "criterion.contested");
  assert.equal(note?.severity, "info");
  assert.deepEqual(note?.subjects, ["craft"]);
  assert.ok(
    note?.message.includes("rewording it before the next event"),
    "the remedy is the wording, not the scores already filed",
  );
  assert.ok(
    note?.message.includes("not by adjusting the scores already filed"),
    "and the note must say so explicitly",
  );
});

test("a scale the panel only uses the middle of is reported", () => {
  const result = criterionInsights(
    rubric,
    design((j, p, key) => (key === "tech" ? 3 + (projects.indexOf(p) % 2) : gradient(j, p))),
  );
  const tech = result.criteria.find((c) => c.key === "tech");
  assert.equal(tech?.observedMin, 3);
  assert.equal(tech?.observedMax, 4);
  assert.ok(Math.abs((tech?.rangeUsed as number) - 0.25) < 1e-12);
  assert.notEqual(tech?.verdict, "flat", "a narrow scale is still being used");
  const note = result.notes.find((n) => n.code === "criterion.narrowRange");
  assert.equal(note?.severity, "info");
  assert.ok(note?.message.includes("a shorter scale with extra steps"));
});

test("the ranking correlation is only reported when a fit was supplied", () => {
  const ballots = design(gradient);
  const without = criterionInsights(rubric, ballots);
  for (const c of without.criteria) {
    assert.equal(c.withRanking, 0, "no fit means no claim about the ranking");
  }
  const fit = normalizeScores(rubric, ballots);
  const withFit = criterionInsights(rubric, ballots, fit);
  for (const c of withFit.criteria) {
    assert.ok(
      c.withRanking > 0.9,
      `on a clean gradient every criterion tracks the ranking: ${c.key} at ${c.withRanking}`,
    );
    assert.ok(c.withTotal > 0.9);
  }
  // Supplying a fit must not change anything else about the report.
  assert.deepEqual(
    without.criteria.map((c) => c.discrimination),
    withFit.criteria.map((c) => c.discrimination),
  );
  assert.equal(without.contested, withFit.contested);
});

test("mis-versioned and missing ballots are refused", () => {
  assert.throws(
    () => criterionInsights(rubric, []),
    (error: unknown) => error instanceof JudgingError && error.code === "criteria.empty",
  );
  const wrong = design(gradient).map((b, i) => (i === 3 ? { ...b, rubricVersion: 9 } : b));
  assert.throws(
    () => criterionInsights(rubric, wrong),
    (error: unknown) => error instanceof JudgingError && error.code === "ballot.rubricVersion",
  );
});

test("the report runs on a simulated event and names its own method", () => {
  const event = simulateEvent({
    projects: 20,
    judges: 6,
    reviewsPerProject: 3,
    seed: "criteria",
    rubric: DEMO_RUBRIC,
  });
  const fit = normalizeScores(event.rubric, event.ballots);
  const result = criterionInsights(event.rubric, event.ballots, fit);
  assert.equal(result.criteria.length, DEMO_RUBRIC.criteria.length);
  assert.ok(result.method.includes("per-criterion-spread"));
  assert.ok(result.method.includes(`weak<${CRITERIA_DEFAULTS.weakDiscrimination}`));
  for (const c of result.criteria) {
    assert.ok(c.discrimination >= 0 && c.discrimination <= 1);
    assert.ok(c.rangeUsed >= 0 && c.rangeUsed <= 1);
    assert.ok(c.judgeDivergence >= 0);
    assert.ok(c.observedMin >= c.scaleMin && c.observedMax <= c.scaleMax);
    assert.ok(c.observedMean >= c.observedMin && c.observedMean <= c.observedMax);
  }
  assert.deepEqual(
    result.notes.filter((n) => n.severity === "warn").map((n) => n.message),
    result.warnings,
  );
  for (const n of result.notes) assert.match(n.code, /^[a-z]+\.[a-zA-Z]+$/);
});

test("the same ballots always produce the same report", () => {
  const ballots = design(gradient);
  const once = criterionInsights(rubric, ballots);
  const twice = criterionInsights(rubric, ballots.slice().reverse());
  assert.deepEqual(once.criteria, twice.criteria, "ballot order must not move a number");
  assert.deepEqual(once.redundant, twice.redundant);
  assert.equal(once.contested, twice.contested);
  assert.deepEqual(once.notes, twice.notes);
});
