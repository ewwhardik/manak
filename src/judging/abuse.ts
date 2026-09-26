/**
 * Anti-abuse analysis for community and quadratic voting.
 *
 * Community voting is notoriously gameable on incumbent platforms: Sybil voter
 * rings coordinate to spend all their quadratic credits on the same pair of
 * projects within seconds of each other, artificially pumping projects into the
 * top tier.
 *
 * This pass detects those rings without ever silently voiding a ballot:
 *   1. Vector cosine similarity and set Jaccard similarity across project allocations.
 *   2. Shared fingerprint (IP/UA) clustering.
 *   3. Burst-submission timing clustering.
 *   4. Connected component analysis to isolate collusive cliques.
 *   5. Formatted organizer suspicion report with risk score and discount advice.
 */

import { components } from "./stats.ts";

export type RawVote = {
  readonly voterToken: string;
  readonly projectId: string;
  readonly creditsSpent: number;
  readonly ipHash?: string | null;
  readonly userAgentHash?: string | null;
  readonly createdAt: number;
};

export type SuspiciousCluster = {
  readonly clusterId: number;
  readonly riskScore: number; // 0 to 100
  readonly voterTokens: readonly string[];
  readonly targetProjects: readonly string[];
  readonly sharedIpHash: string | null;
  readonly timeSpanSeconds: number;
  readonly primaryReason: string;
  readonly details: readonly string[];
  readonly recommendedDiscount: number; // fraction 0.0 to 1.0
};

export type AbuseReport = {
  readonly totalVotes: number;
  readonly uniqueVoters: number;
  readonly uniqueProjects: number;
  readonly clusters: readonly SuspiciousCluster[];
  readonly highRiskCount: number;
};

export type AbuseThresholds = {
  patternCosine: number;
  sharedOriginCosine: number;
  highRisk: number;
};

export const ABUSE_DEFAULTS: AbuseThresholds = {
  patternCosine: 0.95,
  sharedOriginCosine: 0.8,
  highRisk: 70,
};

function cosineSimilarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [k, va] of a) {
    normA += va * va;
    const vb = b.get(k);
    if (vb !== undefined) dot += va * vb;
  }
  for (const vb of b.values()) {
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Scan all quadratic votes in an event and surface coordinated Sybil rings.
 */
export function detectVoteAbuse(votes: readonly RawVote[], thresholds: AbuseThresholds = ABUSE_DEFAULTS): AbuseReport {
  if (!Number.isFinite(thresholds.patternCosine) || thresholds.patternCosine < 0.5 || thresholds.patternCosine > 1 ||
    !Number.isFinite(thresholds.sharedOriginCosine) || thresholds.sharedOriginCosine < 0.5 || thresholds.sharedOriginCosine > 1 ||
    !Number.isSafeInteger(thresholds.highRisk) || thresholds.highRisk < 0 || thresholds.highRisk > 100) {
    throw new Error("Abuse thresholds are outside their supported ranges.");
  }
  const voterAlloc = new Map<string, Map<string, number>>();
  const voterIps = new Map<string, Set<string>>();
  const voterTimes = new Map<string, number[]>();
  const projects = new Set<string>();

  for (const v of votes) {
    projects.add(v.projectId);
    let alloc = voterAlloc.get(v.voterToken);
    if (alloc === undefined) {
      alloc = new Map();
      voterAlloc.set(v.voterToken, alloc);
    }
    alloc.set(v.projectId, (alloc.get(v.projectId) ?? 0) + v.creditsSpent);

    if (v.ipHash) {
      let ips = voterIps.get(v.voterToken);
      if (ips === undefined) {
        ips = new Set();
        voterIps.set(v.voterToken, ips);
      }
      ips.add(v.ipHash);
    }

    let times = voterTimes.get(v.voterToken);
    if (times === undefined) {
      times = [];
      voterTimes.set(v.voterToken, times);
    }
    times.push(v.createdAt);
  }

  const voters = [...voterAlloc.keys()];
  const edges: [string, string][] = [];

  for (let i = 0; i < voters.length; i++) {
    const vi = voters[i] as string;
    const allocI = voterAlloc.get(vi) as Map<string, number>;
    const keysI = new Set(allocI.keys());
    const ipsI = voterIps.get(vi);

    for (let j = i + 1; j < voters.length; j++) {
      const vj = voters[j] as string;
      const allocJ = voterAlloc.get(vj) as Map<string, number>;
      const keysJ = new Set(allocJ.keys());
      const ipsJ = voterIps.get(vj);

      const jaccard = jaccardSimilarity(keysI, keysJ);
      const cosine = cosineSimilarity(allocI, allocJ);

      const sharedIp = ipsI !== undefined && ipsJ !== undefined && [...ipsI].some((ip) => ipsJ.has(ip));

      // Connected when voters target identical subset of 2+ projects with near-identical ratio,
      // or share an IP with high similarity.
      const connected = (keysI.size >= 2 && jaccard >= 0.99 && cosine >= thresholds.patternCosine) ||
        (sharedIp && cosine >= thresholds.sharedOriginCosine);
      if (connected) {
        edges.push([vi, vj]);
      }
    }
  }

  const comps = components(voters, edges).filter((c) => c.length >= 2);
  const clusters: SuspiciousCluster[] = [];
  let highRisk = 0;

  for (let idx = 0; idx < comps.length; idx++) {
    const members = comps[idx] as string[];
    const clusterIps = new Set<string>();
    const clusterTargets = new Set<string>();
    const allTs: number[] = [];

    for (const m of members) {
      const ips = voterIps.get(m);
      if (ips) for (const ip of ips) clusterIps.add(ip);
      const alloc = voterAlloc.get(m);
      if (alloc) for (const p of alloc.keys()) clusterTargets.add(p);
      const times = voterTimes.get(m);
      if (times) for (const t of times) allTs.push(t);
    }

    allTs.sort((a, b) => a - b);
    const spanSeconds = allTs.length >= 2 ? Math.max(0, Math.round(((allTs[allTs.length - 1] as number) - (allTs[0] as number)) / 1000)) : 0;

    let score = 40 + members.length * 10;
    const details: string[] = [`Coordinated cluster of ${members.length} distinct voter tokens`];

    if (clusterIps.size === 1 && members.length >= 2) {
      score += 25;
      details.push("All tokens in cluster share the exact same hashed IP origin");
    }
    if (spanSeconds < 300) {
      score += 20;
      details.push(`Rapid submission burst: all votes cast within ${spanSeconds}s`);
    }

    const riskScore = Math.min(100, score);
    if (riskScore >= thresholds.highRisk) highRisk++;

    const discount = riskScore >= 85 ? 0.9 : riskScore >= 65 ? 0.6 : 0.3;
    const commonIp = clusterIps.size === 1 ? [...clusterIps][0] ?? null : null;

    clusters.push({
      clusterId: idx + 1,
      riskScore,
      voterTokens: members,
      targetProjects: [...clusterTargets].sort(),
      sharedIpHash: commonIp,
      timeSpanSeconds: spanSeconds,
      primaryReason: riskScore >= thresholds.highRisk ? "Strong coordination signal for human review" : "Similar voting pattern for review",
      details,
      recommendedDiscount: discount,
    });
  }

  return {
    totalVotes: votes.length,
    uniqueVoters: voters.length,
    uniqueProjects: projects.size,
    clusters,
    highRiskCount: highRisk,
  };
}
