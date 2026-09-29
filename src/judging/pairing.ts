/**
 * Pair scheduling for pairwise judging.
 *
 * A Bradley-Terry fit is only as good as the comparison graph it is given, and
 * the graph is something we choose. Three obligations pull against each other:
 *
 *   1. **Connectivity.** Strengths in two disconnected groups are not comparable
 *      at all. Every project must be reachable from every other through a chain
 *      of comparisons, or the ranking is really several rankings printed in one
 *      table. So a pair that joins two groups is always taken first.
 *   2. **Information.** Once connected, the comparison that teaches us most is
 *      the one we can least predict — Fisher information for a Bradley-Terry
 *      observation is p(1 - p), maximal at a coin flip. Asking a judge to
 *      compare the best project against the worst wastes a judge's minute.
 *   3. **Exposure.** Nobody's project should go unseen because the scheduler got
 *      greedy. A deficit term keeps under-compared projects in contention.
 *
 * Every pick reports which of those three drove it, and the reason is written to
 * the audit ledger. "Why did I get these two?" is a question an organizer should
 * be able to answer from the record.
 *
 * The scheduler is stateless. It derives its randomness from
 * `seed | judge | comparisons-filed-by-that-judge`, so the same event replays
 * identically without persisting an RNG cursor anywhere.
 */

import type { Comparison, JudgeId, PairReason, ProjectId } from "./types.ts";
import { makeRng, hashString } from "./rng.ts";
import { components } from "./stats.ts";
import { winProbability } from "./bradleyterry.ts";

export type PairingOptions = {
  /** Probability of taking a uniformly random eligible pair instead of the best. */
  epsilon?: number;
  /** Comparisons per project we are aiming for; drives the deficit term. */
  exposureTarget?: number;
  /** Weight on exposure relative to information. 0 is pure information. */
  exposureWeight?: number;
  /** Target podium cutoff rank (e.g. 3 for top-3 podium). Prioritizes border duels. */
  podiumCutoff?: number;
  /** Weight on podium border bonus relative to information and exposure. Default 0.75 when cutoff is set. */
  podiumWeight?: number;
};

/**
 * The part of a comparison the scheduler actually reads.
 *
 * Narrower than `Comparison` on purpose: scheduling needs to know which pairs a judge has been
 * shown, and a skipped pair was shown. A skip has no winner, so demanding one here would force the
 * caller either to drop skips — and re-offer the same duel to the same judge forever — or to invent
 * a winner for the type's benefit. A `Comparison` still satisfies this, so nothing else changes.
 */
export type PairInfo = Pick<Comparison, "judge" | "left" | "right">;


export type PairingInput = {
  judge: JudgeId;
  /** The eligible pool, usually one track. */
  projects: readonly ProjectId[];
  /** Every comparison filed so far, by any judge. Skips included: a skipped pair was seen. */
  comparisons: readonly PairInfo[];
  /** Projects this judge may not see: their own team, declared conflicts. */
  conflicts?: readonly ProjectId[];
  /** Current log-strengths. Missing entries are treated as zero. */
  strengths?: ReadonlyMap<ProjectId, number>;
  seed: number | string;
};

export type PairPick = {
  left: ProjectId;
  right: ProjectId;
  reason: PairReason;
  /** The score the winning pair achieved, for the ledger. */
  score: number;
  information: number;
  deficit: number;
  /** Components in the pool at pick time. One means the field is comparable. */
  componentCount: number;
};

export type PairingProgress = {
  exposure: Map<ProjectId, number>;
  leastSeen: ProjectId[];
  componentCount: number;
  connected: boolean;
  /** Pairs already compared, as `a b` with a < b. */
  seenPairs: Set<string>;
};

/** The scheduler's settings when the caller says nothing. */
export const PAIRING_DEFAULTS = { epsilon: 0.1, exposureTarget: 6, exposureWeight: 0.5 } as const;

const DEFAULTS = PAIRING_DEFAULTS;

const pairKey = (a: ProjectId, b: ProjectId): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Exposure counts and connectivity for a pool. Drives dashboards as well as picks. */
export function pairingProgress(
  projects: readonly ProjectId[],
  comparisons: readonly PairInfo[],
): PairingProgress {
  const exposure = new Map<ProjectId, number>(projects.map((p) => [p, 0]));
  const seenPairs = new Set<string>();
  const edges: [string, string][] = [];
  for (const c of comparisons) {
    exposure.set(c.left, (exposure.get(c.left) ?? 0) + 1);
    exposure.set(c.right, (exposure.get(c.right) ?? 0) + 1);
    const pk = pairKey(c.left, c.right);
    if (!seenPairs.has(pk)) {
      seenPairs.add(pk);
      edges.push([c.left, c.right]);
    }
  }
  const parts = components(projects, edges);
  const min = Math.min(...[...exposure.values()]);
  const leastSeen = projects.filter((p) => (exposure.get(p) ?? 0) === min).slice().sort();
  return {
    exposure,
    leastSeen,
    componentCount: parts.length,
    connected: parts.length === 1,
    seenPairs,
  };
}

/**
 * The next pair this judge should see, or `null` when nothing is left that they
 * are allowed to compare. Returning null is a legitimate answer — the console
 * shows "you have seen everything we can show you" rather than inventing work.
 */
export function nextPair(input: PairingInput, options: PairingOptions = {}): PairPick | null {
  const opt = { ...DEFAULTS, ...options };
  const conflicts = new Set<ProjectId>(input.conflicts ?? []);
  const pool = input.projects.filter((p) => !conflicts.has(p)).slice().sort();
  if (pool.length < 2) return null;

  const progress = pairingProgress(input.projects, input.comparisons);

  // Which component each project sits in, keyed by the component's first member.
  const componentOf = new Map<ProjectId, number>();
  const componentSize: number[] = [];
  {
    const edges: [string, string][] = [...progress.seenPairs].map((pk) => {
      const [a, b] = pk.split(" ") as [string, string];
      return [a, b];
    });
    const parts = components(input.projects, edges);
    parts.forEach((group, index) => {
      componentSize.push(group.length);
      for (const p of group) componentOf.set(p, index);
    });
  }

  const seenByJudge = new Set<string>();
  let filedByJudge = 0;
  for (const c of input.comparisons) {
    if (c.judge !== input.judge) continue;
    filedByJudge++;
    seenByJudge.add(pairKey(c.left, c.right));
  }

  const strengthOf = (p: ProjectId): number => input.strengths?.get(p) ?? 0;
  const deficitOf = (p: ProjectId): number =>
    Math.max(0, opt.exposureTarget - (progress.exposure.get(p) ?? 0)) / Math.max(1, opt.exposureTarget);

  const rankOf = new Map<ProjectId, number>();
  if (opt.podiumCutoff !== undefined && opt.podiumCutoff > 0) {
    const sortedPool = pool.slice().sort((p1, p2) => strengthOf(p2) - strengthOf(p1) || p1.localeCompare(p2));
    sortedPool.forEach((p, idx) => rankOf.set(p, idx + 1));
  }
  const podiumCutoff = opt.podiumCutoff ?? 0;
  const podiumWeight = opt.podiumWeight ?? (podiumCutoff > 0 ? 0.75 : 0);

  type Candidate = {
    a: ProjectId;
    b: ProjectId;
    bridging: boolean;
    bridgeSpan: number;
    information: number;
    deficit: number;
    podiumBonus: number;
    score: number;
  };

  const candidates: Candidate[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i] as ProjectId;
      const b = pool[j] as ProjectId;
      if (seenByJudge.has(pairKey(a, b))) continue;
      const ca = componentOf.get(a);
      const cb = componentOf.get(b);
      const bridging = ca !== undefined && cb !== undefined && ca !== cb;
      const bridgeSpan = bridging
        ? (componentSize[ca as number] as number) + (componentSize[cb as number] as number)
        : 0;
      const p = winProbability(strengthOf(a), strengthOf(b));
      const information = p * (1 - p) * 4; // scaled to [0, 1]
      const deficit = (deficitOf(a) + deficitOf(b)) / 2;
      let podiumBonus = 0;
      if (podiumCutoff > 0) {
        const ra = rankOf.get(a) ?? pool.length;
        const rb = rankOf.get(b) ?? pool.length;
        const minR = Math.min(ra, rb);
        const maxR = Math.max(ra, rb);
        if (minR <= podiumCutoff && maxR >= podiumCutoff) {
          podiumBonus = 1.0 / (1 + Math.abs(minR - podiumCutoff) + Math.abs(maxR - (podiumCutoff + 1)));
        } else if (Math.abs(ra - podiumCutoff) <= 1 && Math.abs(rb - podiumCutoff) <= 1) {
          podiumBonus = 0.8;
        }
      }
      candidates.push({
        a,
        b,
        bridging,
        bridgeSpan,
        information,
        deficit,
        podiumBonus,
        score: information + opt.exposureWeight * deficit + podiumWeight * podiumBonus,
      });
    }
  }
  if (candidates.length === 0) return null;

  const rng = makeRng(`${input.seed}|${input.judge}|${filedByJudge}`);
  const bridges = candidates.filter((c) => c.bridging);

  let chosen: Candidate;
  let reason: PairReason;
  if (bridges.length > 0) {
    // Join the two biggest groups first: that grows the comparable set fastest.
    // Ties go to the pair carrying the most exposure deficit, then to the seed.
    bridges.sort(
      (x, y) =>
        y.bridgeSpan - x.bridgeSpan ||
        y.deficit - x.deficit ||
        x.a.localeCompare(y.a) ||
        x.b.localeCompare(y.b),
    );
    const best = bridges[0] as Candidate;
    const tied = bridges.filter(
      (c) => c.bridgeSpan === best.bridgeSpan && Math.abs(c.deficit - best.deficit) < 1e-12,
    );
    chosen = (rng.pick(tied) ?? best) as Candidate;
    reason = "bridge";
  } else if (rng.next() < opt.epsilon) {
    chosen = (rng.pick(candidates) as Candidate);
    reason = "explore";
  } else {
    candidates.sort(
      (x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
    );
    const best = candidates[0] as Candidate;
    const tied = candidates.filter((c) => Math.abs(c.score - best.score) < 1e-12);
    chosen = (rng.pick(tied) ?? best) as Candidate;
    // Attribute the pick to whichever term actually decided it.
    let bestInformation = 0;
    for (const c of candidates) bestInformation = Math.max(bestInformation, c.information);
    if (chosen.podiumBonus > 0 && podiumWeight * chosen.podiumBonus >= chosen.information && podiumWeight * chosen.podiumBonus >= opt.exposureWeight * chosen.deficit) {
      reason = "podium";
    } else {
      reason = chosen.information >= bestInformation - 1e-12 ? "informative" : "exposure";
    }
  }

  // Which side a project appears on is decided by the judge and the pair, not by
  // sort order, so position bias cannot systematically favour earlier names.
  const flip = hashString(`${input.seed}|${input.judge}|${chosen.a}|${chosen.b}`) % 2 === 1;
  return {
    left: flip ? chosen.b : chosen.a,
    right: flip ? chosen.a : chosen.b,
    reason,
    score: chosen.score,
    information: chosen.information,
    deficit: chosen.deficit,
    componentCount: progress.componentCount,
  };
}
