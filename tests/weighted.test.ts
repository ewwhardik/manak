import test from "node:test";
import assert from "node:assert/strict";

import type { Ballot, Rubric } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import {
  normalizedWeights,
  scaleMidpoint,
  weightedTotal,
  weightedTotals,
} from "../src/judging/weighted.ts";

const rubric: Rubric = {
  id: "r",
  version: 2,
  criteria: [
    { key: "tech", label: "Technical", weight: 3, min: 1, max: 5 },
    { key: "design", label: "Design", weight: 1, min: 1, max: 5 },
  ],
};

const ballot = (over: Partial<Ballot> = {}): Ballot => ({
  id: "b1",
  judge: "j1",
  project: "p1",
  rubricVersion: 2,
  scores: { tech: 4, design: 2 },
  ...over,
});

test("weights are normalized to sum to one", () => {
  const w = normalizedWeights(rubric.criteria);
  assert.equal(w.get("tech"), 0.75);
  assert.equal(w.get("design"), 0.25);
  let total = 0;
  for (const v of w.values()) total += v;
  assert.ok(Math.abs(total - 1) < 1e-15);
});

test("a rubric must have criteria, positive weights, and a non-empty scale", () => {
  assert.throws(() => normalizedWeights([]), (e: unknown) =>
    e instanceof JudgingError && e.code === "rubric.empty");
  assert.throws(
    () => normalizedWeights([{ key: "a", label: "A", weight: 0, min: 1, max: 5 }]),
    (e: unknown) => e instanceof JudgingError && e.code === "rubric.weight",
  );
  assert.throws(
    () => normalizedWeights([{ key: "a", label: "A", weight: 1, min: 5, max: 5 }]),
    (e: unknown) => e instanceof JudgingError && e.code === "rubric.scale",
  );
});

test("a weighted total stays on the scale the judge actually saw", () => {
  assert.equal(weightedTotal(rubric, { tech: 5, design: 5 }), 5);
  assert.equal(weightedTotal(rubric, { tech: 1, design: 1 }), 1);
  // 0.75*4 + 0.25*2 = 3.5 — not 14, which is what an unnormalized sum would give.
  assert.equal(weightedTotal(rubric, { tech: 4, design: 2 }), 3.5);
});

test("a missing or out-of-range score is refused, never defaulted", () => {
  assert.throws(() => weightedTotal(rubric, { tech: 4 }), (e: unknown) =>
    e instanceof JudgingError && e.code === "ballot.missing");
  assert.throws(() => weightedTotal(rubric, { tech: 4, design: Number.NaN }), (e: unknown) =>
    e instanceof JudgingError && e.code === "ballot.missing");
  assert.throws(() => weightedTotal(rubric, { tech: 6, design: 2 }), (e: unknown) =>
    e instanceof JudgingError && e.code === "ballot.range");
  assert.throws(() => weightedTotal(rubric, { tech: 0, design: 2 }), (e: unknown) =>
    e instanceof JudgingError && e.code === "ballot.range");
});

test("a ballot scored against another rubric version is refused", () => {
  assert.throws(
    () => weightedTotals(rubric, [ballot({ rubricVersion: 1 })]),
    (e: unknown) => e instanceof JudgingError && e.code === "ballot.rubricVersion",
  );
  const totals = weightedTotals(rubric, [ballot(), ballot({ id: "b2", scores: { tech: 5, design: 1 } })]);
  assert.equal(totals.get("b1"), 3.5);
  assert.equal(totals.get("b2"), 4);
});

test("the midpoint of a rubric is the middle of its scale", () => {
  assert.equal(scaleMidpoint(rubric), 3);
});
