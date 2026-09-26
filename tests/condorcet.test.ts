import test from "node:test";
import assert from "node:assert/strict";

import { analyzeTournament } from "../src/judging/index.ts";
import type { Comparison } from "../src/judging/index.ts";

test("analyzeTournament identifies Condorcet winner and Copeland standings", () => {
  const projects = ["pA", "pB", "pC"];
  const comparisons: Comparison[] = [
    // pA beats pB twice
    { id: "c1", judge: "j1", left: "pA", right: "pB", winner: "pA" },
    { id: "c2", judge: "j2", left: "pA", right: "pB", winner: "pA" },
    // pA beats pC once
    { id: "c3", judge: "j1", left: "pA", right: "pC", winner: "pA" },
    // pB beats pC once
    { id: "c4", judge: "j2", left: "pB", right: "pC", winner: "pB" },
  ];

  const report = analyzeTournament(projects, comparisons);

  // pA beat everyone head-to-head (pB and pC) -> Condorcet Winner!
  assert.equal(report.condorcetWinner, "pA");
  assert.equal(report.hasCycle, false);

  const standingA = report.standings.find((s) => s.project === "pA")!;
  assert.equal(standingA.isCondorcetWinner, true);
  assert.equal(standingA.headToHeadWins, 2);
  assert.equal(standingA.headToHeadLosses, 0);
  assert.equal(standingA.copelandScore, 2);
  assert.equal(standingA.rank, 1);

  const standingB = report.standings.find((s) => s.project === "pB")!;
  assert.equal(standingB.headToHeadWins, 1); // beat pC
  assert.equal(standingB.headToHeadLosses, 1); // lost to pA
  assert.equal(standingB.copelandScore, 0);
  assert.equal(standingB.rank, 2);

  const standingC = report.standings.find((s) => s.project === "pC")!;
  assert.equal(standingC.headToHeadWins, 0);
  assert.equal(standingC.headToHeadLosses, 2);
  assert.equal(standingC.copelandScore, -2);
  assert.equal(standingC.rank, 3);
});

test("analyzeTournament detects Condorcet preference cycles", () => {
  const projects = ["p1", "p2", "p3"];
  // Cyclic tournament: p1 beats p2, p2 beats p3, p3 beats p1
  const comparisons: Comparison[] = [
    { id: "c1", judge: "j1", left: "p1", right: "p2", winner: "p1" },
    { id: "c2", judge: "j1", left: "p2", right: "p3", winner: "p2" },
    { id: "c3", judge: "j1", left: "p1", right: "p3", winner: "p3" },
  ];

  const report = analyzeTournament(projects, comparisons);
  assert.equal(report.hasCycle, true);
  assert.equal(report.condorcetWinner, null); // No Condorcet winner in a cycle
  assert.ok(report.cycleNodes.length >= 3);
});
