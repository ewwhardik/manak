import test from "node:test";
import assert from "node:assert/strict";

import { triageFinalists } from "../src/judging/index.ts";
import type { FinalistCandidate } from "../src/judging/index.ts";

test("triageFinalists partitions field into guaranteed, bubble, and eliminated", () => {
  const candidates: FinalistCandidate[] = [
    // Top 2: clearly above everyone else
    { project: "p1", fitted: 9.5, standardError: 0.1, rank: 1 }, // [9.3, 9.7]
    { project: "p2", fitted: 9.2, standardError: 0.1, rank: 2 }, // [9.0, 9.4]

    // Bubble zone around targetK = 3
    { project: "p3", fitted: 7.6, standardError: 0.3, rank: 3 }, // [7.0, 8.2]
    { project: "p4", fitted: 7.4, standardError: 0.3, rank: 4 }, // [6.8, 8.0]

    // Clearly eliminated
    { project: "p5", fitted: 5.0, standardError: 0.2, rank: 5 }, // [4.6, 5.4]
    { project: "p6", fitted: 4.0, standardError: 0.2, rank: 6 }, // [3.6, 4.4]
  ];

  const report = triageFinalists(candidates, 3);

  assert.equal(report.targetK, 3);
  // p1 and p2 should be guaranteed finalists (lower bound > upper bound of p4)
  assert.ok(report.guaranteed.some((p) => p.project === "p1"));
  assert.ok(report.guaranteed.some((p) => p.project === "p2"));

  // p3 and p4 are overlapping across cutoff -> bubble
  assert.ok(report.bubble.some((p) => p.project === "p3"));
  assert.ok(report.bubble.some((p) => p.project === "p4"));

  // p5 and p6 are eliminated
  assert.ok(report.eliminated.some((p) => p.project === "p5"));
  assert.ok(report.eliminated.some((p) => p.project === "p6"));

  // Should recommend tie-breaker duel between p3 and p4
  assert.ok(report.recommendedDuels.length >= 1);
  const duel = report.recommendedDuels[0]!;
  assert.ok(
    (duel.left === "p3" && duel.right === "p4") ||
    (duel.left === "p4" && duel.right === "p3")
  );
});
