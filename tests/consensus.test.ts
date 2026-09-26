import test from "node:test";
import assert from "node:assert/strict";

import { hybridConsensus, kendallW } from "../src/judging/index.ts";
import type { NormalizationResult, BradleyTerryResult } from "../src/judging/index.ts";

test("kendallW calculates coefficient of concordance across rankings", () => {
  // Identical rankings: perfect agreement W = 1
  const identical = [
    [1, 2, 3, 4],
    [1, 2, 3, 4],
    [1, 2, 3, 4],
  ];
  assert.equal(kendallW(identical), 1);

  // Single rater or single item degenerate cases
  assert.equal(kendallW([[1, 2]]), 1);
  assert.equal(kendallW([[1], [1]]), 1);

  // Partially agreeing rankings
  const partial = [
    [1, 2, 3, 4],
    [1, 3, 2, 4],
  ];
  const w = kendallW(partial);
  assert.ok(w > 0.8 && w < 1.0);

  // Strongly conflicting rankings
  const conflicting = [
    [1, 2, 3, 4],
    [4, 3, 2, 1],
  ];
  assert.ok(kendallW(conflicting) < 0.2);
});

test("hybridConsensus weights and merges rubric and pairwise results", () => {
  const mockRubric: NormalizationResult = {
    method: "backfit",
    grandMean: 5.0,
    residualSd: 0.8,
    rounds: 2,
    sweeps: 5,
    converged: true,
    settled: true,
    outerMovement: 0.001,
    leniencyResidual: 0, observations: 9, df: 3, warnings: [], notes: [],
    judges: [],
    projects: [
      { project: "p1", ballots: 3, rawMean: 8.0, adjusted: 8.2, theta: 3.2, standardError: 0.2, rankRaw: 1, rankAdjusted: 1, rankMove: 0 },
      { project: "p2", ballots: 3, rawMean: 6.0, adjusted: 6.1, theta: 1.1, standardError: 0.3, rankRaw: 2, rankAdjusted: 2, rankMove: 0 },
      { project: "p3", ballots: 3, rawMean: 4.0, adjusted: 3.9, theta: -1.1, standardError: 0.2, rankRaw: 3, rankAdjusted: 3, rankMove: 0 },
    ],
  };

  const mockPairwise: BradleyTerryResult = {
    iterations: 10,
    converged: true,
    logLikelihood: -12.5,
    method: "test", componentCount: 1, connected: true, warnings: [],
    strengths: [
      { project: "p2", beta: 1.5, wins: 2, losses: 2, comparisons: 4, rank: 1 },
      { project: "p1", beta: 0.8, wins: 2, losses: 2, comparisons: 4, rank: 2 },
      { project: "p3", beta: -1.2, wins: 2, losses: 2, comparisons: 4, rank: 3 },
    ],
  };

  // 1. Pure rubric weight (1.0)
  const pureRubric = hybridConsensus(mockRubric, mockPairwise, { rubricWeight: 1.0 });
  assert.equal(pureRubric.projects[0]?.project, "p1");
  assert.equal(pureRubric.projects[1]?.project, "p2");
  assert.equal(pureRubric.projects[2]?.project, "p3");

  // 2. Pure pairwise weight (0.0)
  const purePairwise = hybridConsensus(mockRubric, mockPairwise, { rubricWeight: 0.0 });
  assert.equal(purePairwise.projects[0]?.project, "p2");
  assert.equal(purePairwise.projects[1]?.project, "p1");
  assert.equal(purePairwise.projects[2]?.project, "p3");

  // 3. Balanced fusion (0.5)
  const balanced = hybridConsensus(mockRubric, mockPairwise, { rubricWeight: 0.5 });
  assert.equal(balanced.projects.length, 3);
  assert.ok(balanced.kendallW > 0.5);
  assert.equal(balanced.rubricWeight, 0.5);
  assert.equal(balanced.pairwiseWeight, 0.5);

  const p1 = balanced.projects.find((p) => p.project === "p1")!;
  assert.equal(p1.rubricRank, 1);
  assert.equal(p1.pairwiseRank, 2);
  assert.ok(p1.concordance >= 0.5);
});
