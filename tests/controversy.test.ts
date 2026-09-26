import test from "node:test";
import assert from "node:assert/strict";

import { detectControversy } from "../src/judging/index.ts";
import type { Ballot, Rubric } from "../src/judging/index.ts";

const TEST_RUBRIC: Rubric = {
  id: "r1",
  version: 1,
  criteria: [
    { key: "impact", label: "Impact", weight: 0.5, min: 1, max: 10 },
    { key: "code", label: "Code Quality", weight: 0.5, min: 1, max: 10 },
  ],
};

test("detectControversy identifies polarized vs consensus projects", () => {
  const ballots: Ballot[] = [
    // Project 1 (p1): Polarized! One judge gave 10, 10; another gave 2, 2.
    { id: "b1", judge: "j1", project: "p1", rubricVersion: 1, scores: { impact: 10, code: 10 } },
    { id: "b2", judge: "j2", project: "p1", rubricVersion: 1, scores: { impact: 2, code: 2 } },

    // Project 2 (p2): Consensus! Both judges scored near 7-8.
    { id: "b3", judge: "j1", project: "p2", rubricVersion: 1, scores: { impact: 7, code: 8 } },
    { id: "b4", judge: "j2", project: "p2", rubricVersion: 1, scores: { impact: 8, code: 7 } },

    // Project 3 (p3): Sparse! Only 1 review.
    { id: "b5", judge: "j3", project: "p3", rubricVersion: 1, scores: { impact: 9, code: 9 } },
  ];

  const report = detectControversy(TEST_RUBRIC, ballots);

  assert.equal(report.polarizedCount, 1);
  assert.equal(report.consensusCount, 1);
  assert.equal(report.sparseCount, 1);

  const p1 = report.projects.find((p) => p.project === "p1")!;
  assert.equal(p1.verdict, "polarized");
  assert.equal(p1.spread, 8); // 10 - 2
  assert.ok(p1.controversyIndex > 0.8);
  assert.ok(p1.tieBreakerPriority > 0);

  const p2 = report.projects.find((p) => p.project === "p2")!;
  assert.equal(p2.verdict, "consensus");
  assert.equal(p2.spread, 0); // both weighted totals are 7.5

  const p3 = report.projects.find((p) => p.project === "p3")!;
  assert.equal(p3.verdict, "sparse");

  // Priority queue should prioritize p1
  assert.deepEqual(report.priorityQueue, ["p1"]);
});
