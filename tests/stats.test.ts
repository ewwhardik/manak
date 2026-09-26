import test from "node:test";
import assert from "node:assert/strict";

import {
  clamp,
  components,
  correlation,
  kendallTau,
  mean,
  rankDescending,
  rmse,
  sd,
  variance,
} from "../src/judging/stats.ts";

test("mean and variance are the population forms", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean([]), 0);
  // Population variance of [1,2,3,4] is 1.25; the sample form would be 1.6667.
  assert.equal(variance([1, 2, 3, 4]), 1.25);
  assert.equal(variance([7, 7, 7]), 0);
  assert.equal(sd([2, 4]), 1);
});

test("clamp holds both ends", () => {
  assert.equal(clamp(5, 1, 3), 3);
  assert.equal(clamp(-5, 1, 3), 1);
  assert.equal(clamp(2, 1, 3), 2);
});

test("rankDescending is 1-based, highest first, and breaks ties on the key", () => {
  const ranks = rankDescending([
    { key: "c", score: 1 },
    { key: "a", score: 3 },
    { key: "b", score: 3 },
    { key: "d", score: 2 },
  ]);
  assert.equal(ranks.get("a"), 1);
  assert.equal(ranks.get("b"), 2);
  assert.equal(ranks.get("d"), 3);
  assert.equal(ranks.get("c"), 4);
});

test("rankDescending is stable across input order", () => {
  const entries = [
    { key: "x", score: 2 },
    { key: "y", score: 2 },
    { key: "z", score: 2 },
  ];
  const a = rankDescending(entries);
  const b = rankDescending(entries.slice().reverse());
  for (const k of ["x", "y", "z"]) assert.equal(a.get(k), b.get(k));
});

test("kendallTau spans identical to reversed", () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(kendallTau(a, a), 1);
  assert.equal(kendallTau(a, a.slice().reverse()), -1);
  // Every pair tied on one side: no information, so zero rather than NaN.
  assert.equal(kendallTau(a, [1, 1, 1, 1, 1]), 0);
});

test("kendallTau handles partial ties without dividing by zero", () => {
  const tau = kendallTau([1, 2, 3, 4], [1, 1, 2, 2]);
  assert.ok(tau > 0 && tau < 1, `expected a positive partial agreement, got ${tau}`);
  assert.ok(Number.isFinite(tau));
});

test("correlation is signed and safe on constants", () => {
  assert.ok(Math.abs(correlation([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.ok(Math.abs(correlation([1, 2, 3], [-2, -4, -6]) + 1) < 1e-12);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), 0);
  assert.equal(correlation([], []), 0);
});

test("rmse is zero only for identical vectors", () => {
  assert.equal(rmse([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(rmse([0, 0], [3, 4]), Math.sqrt((9 + 16) / 2));
});

test("components finds singletons, chains, and groups", () => {
  assert.equal(components(["a", "b", "c"], []).length, 3);
  assert.equal(components(["a", "b", "c"], [["a", "b"], ["b", "c"]]).length, 1);
  const two = components(["a", "b", "c", "d"], [["a", "b"], ["c", "d"]]);
  assert.equal(two.length, 2);
  // Each group is sorted, and the groups partition the node set exactly.
  assert.deepEqual(two.map((g) => g.slice()).sort((x, y) => (x[0] as string).localeCompare(y[0] as string)), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("components ignores edges naming unknown nodes", () => {
  const parts = components(["a", "b"], [["a", "ghost"], ["ghost", "b"]]);
  assert.equal(parts.length, 2, "a phantom node must not merge two real ones");
});
