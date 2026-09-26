import test from "node:test";
import assert from "node:assert/strict";
import { assignReviews } from "../src/judging/assign.ts";

test("assignment matches an exhaustive oracle for every three-by-three eligibility graph", () => {
  const projects = ["p0", "p1", "p2"].map((id) => ({ id }));
  for (let graph = 0; graph < 512; graph++) {
    const eligible = (p: number, j: number) => (graph & (1 << (p * 3 + j))) !== 0;
    for (const target of [1, 2]) {
      const capacities = [1, 2, 1];
      let optimum = 0;
      // Enumerate every edge subset independently of the production algorithm.
      for (let subset = 0; subset < 512; subset++) {
        if ((subset & graph) !== subset) continue;
        const loads = [0, 0, 0], counts = [0, 0, 0];
        let total = 0;
        for (let p = 0; p < 3; p++) for (let j = 0; j < 3; j++) {
          if (subset & (1 << (p * 3 + j))) { loads[j]!++; counts[p]!++; total++; }
        }
        if (loads.every((n, j) => n <= capacities[j]!) && counts.every((n) => n <= target)) optimum = Math.max(optimum, total);
      }
      const judges = capacities.map((capacity, j) => ({ id: `j${j}`, capacity,
        conflicts: projects.filter((_, p) => !eligible(p, j)).map((p) => p.id) }));
      const result = assignReviews(projects, judges, target, `graph-${graph}`);
      assert.equal(result.assignments.length, optimum, `graph=${graph}, target=${target}`);
      for (const pair of result.assignments) assert.ok(eligible(Number(pair.project.slice(1)), Number(pair.judge.slice(1))));
      assert.equal(new Set(result.assignments.map((a) => JSON.stringify(a))).size, result.assignments.length);
    }
  }
});

test("assignment refuses invalid capacities instead of silently producing misleading workloads", () => {
  for (const capacity of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => assignReviews([{ id: "p" }], [{ id: "j", capacity }], 1, 1), /capacity/);
  }
  assert.equal(assignReviews([{ id: "p" }], [{ id: "j", capacity: 0 }], 1, 1).complete, false);
});
