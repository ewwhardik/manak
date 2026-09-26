import test from "node:test";
import assert from "node:assert/strict";

import { detectVoteAbuse } from "../src/judging/index.ts";
import type { RawVote } from "../src/judging/index.ts";
import { isDisposableEmail, shuffleProjectsForVoter } from "../src/db/index.ts";

test("independent honest voters produce zero suspicious clusters", () => {
  const votes: RawVote[] = [
    { voterToken: "v1", projectId: "p1", creditsSpent: 4, ipHash: "ip1", createdAt: 1000 },
    { voterToken: "v1", projectId: "p2", creditsSpent: 9, ipHash: "ip1", createdAt: 1050 },
    { voterToken: "v2", projectId: "p2", creditsSpent: 16, ipHash: "ip2", createdAt: 1500 },
    { voterToken: "v2", projectId: "p3", creditsSpent: 4, ipHash: "ip2", createdAt: 1520 },
    { voterToken: "v3", projectId: "p4", creditsSpent: 25, ipHash: "ip3", createdAt: 2000 },
  ];

  const report = detectVoteAbuse(votes);
  assert.equal(report.totalVotes, 5);
  assert.equal(report.uniqueVoters, 3);
  assert.equal(report.uniqueProjects, 4);
  assert.equal(report.clusters.length, 0);
  assert.equal(report.highRiskCount, 0);
});

test("coordinated Sybil ring is isolated and flagged with high risk score", () => {
  const votes: RawVote[] = [
    // Honest voter
    { voterToken: "honest_1", projectId: "p_alpha", creditsSpent: 9, ipHash: "ip_clean", createdAt: 1000 },
    { voterToken: "honest_1", projectId: "p_beta", creditsSpent: 16, ipHash: "ip_clean", createdAt: 1200 },

    // Sybil botnet: 3 tokens, same IP, same 2 projects, identical credit allocations in 10s
    { voterToken: "sybil_1", projectId: "p_pump_1", creditsSpent: 25, ipHash: "ip_botnet", createdAt: 5000 },
    { voterToken: "sybil_1", projectId: "p_pump_2", creditsSpent: 25, ipHash: "ip_botnet", createdAt: 5002 },
    { voterToken: "sybil_2", projectId: "p_pump_1", creditsSpent: 25, ipHash: "ip_botnet", createdAt: 5004 },
    { voterToken: "sybil_2", projectId: "p_pump_2", creditsSpent: 25, ipHash: "ip_botnet", createdAt: 5006 },
    { voterToken: "sybil_3", projectId: "p_pump_1", creditsSpent: 25, ipHash: "ip_botnet", createdAt: 5008 },
    { voterToken: "sybil_3", projectId: "p_pump_2", creditsSpent: 25, ipHash: "ip_botnet", createdAt: 5010 },
  ];

  const report = detectVoteAbuse(votes);
  assert.equal(report.clusters.length, 1);
  assert.equal(report.highRiskCount, 1);

  const cluster = report.clusters[0]!;
  assert.equal(cluster.voterTokens.length, 3);
  assert.ok(cluster.voterTokens.includes("sybil_1"));
  assert.ok(cluster.voterTokens.includes("sybil_2"));
  assert.ok(cluster.voterTokens.includes("sybil_3"));
  assert.equal(cluster.sharedIpHash, "ip_botnet");
  assert.ok(cluster.riskScore >= 80);
  assert.ok(cluster.recommendedDiscount >= 0.8);
  assert.deepEqual(cluster.targetProjects, ["p_pump_1", "p_pump_2"]);
});

test("benign shared-network outreach can look coordinated and remains only a review signal", () => {
  const votes: RawVote[] = ["attendee-a", "attendee-b", "attendee-c"].flatMap((voterToken, index) => [
    { voterToken, projectId: "p1", creditsSpent: 9, ipHash: "venue-wifi", createdAt: 1000 + index * 1000 },
    { voterToken, projectId: "p2", creditsSpent: 4, ipHash: "venue-wifi", createdAt: 1100 + index * 1000 },
  ]);
  const original = structuredClone(votes);
  const report = detectVoteAbuse(votes);
  assert.equal(report.highRiskCount, 1, "the heuristic has a measurable false-positive shape");
  assert.deepEqual(votes, original, "analysis must never change votes or infer guilt");
  assert.match(report.clusters[0]!.primaryReason, /review/);
  assert.equal(detectVoteAbuse(votes, { patternCosine: 1, sharedOriginCosine: 1, highRisk: 100 }).highRiskCount, 1);
});

test("isDisposableEmail flags throwaway domains and passes standard domains", () => {
  assert.equal(isDisposableEmail("attacker@mailinator.com"), true);
  assert.equal(isDisposableEmail("bot@tempmail.com"), true);
  assert.equal(isDisposableEmail("honest@gmail.com"), false);
  assert.equal(isDisposableEmail("judge@university.edu"), false);
});

test("shuffleProjectsForVoter is deterministic for a voter and differs across voters", () => {
  const projects = ["proj-A", "proj-B", "proj-C", "proj-D", "proj-E", "proj-F"];
  const salt = "event-salt-xyz";

  const order1 = shuffleProjectsForVoter(projects, "token-voter-1", salt);
  const order1Repeat = shuffleProjectsForVoter(projects, "token-voter-1", salt);
  assert.deepEqual(order1, order1Repeat, "Must reproduce identically for same voter");

  const order2 = shuffleProjectsForVoter(projects, "token-voter-2", salt);
  assert.notDeepEqual(order1, order2, "Different voters should receive different ballot shuffles");
  assert.deepEqual([...order1].sort(), [...projects].sort(), "Must be a valid permutation");
});
