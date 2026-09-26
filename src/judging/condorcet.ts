/**
 * Social Choice, Condorcet & Copeland Tournament Engine.
 *
 * Provides non-parametric tournament graph analysis for pairwise comparisons:
 * 1. Head-to-head win/loss matrix.
 * 2. Condorcet Winner detection (a project that defeats every other opponent head-to-head).
 * 3. Copeland Score: Copeland(i) = Wins - Losses across all opponent matchups.
 * 4. Margin-of-Victory matrix and Borda pairwise total.
 * 5. Condorcet Cycle detection (e.g., A > B > C > A rock-paper-scissors circular preference).
 */

import type { Comparison, ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";

export type ProjectTournamentStanding = {
  project: ProjectId;
  headToHeadWins: number;
  headToHeadLosses: number;
  headToHeadTies: number;
  headToHeadUnplayed: number;
  copelandScore: number;
  netMargin: number;
  rank: number;
  isCondorcetWinner: boolean;
};

export type TournamentReport = {
  standings: ProjectTournamentStanding[];
  condorcetWinner: ProjectId | null;
  hasCycle: boolean;
  cycleNodes: ProjectId[];
  matrix: Record<string, Record<string, number>>; // net margin A over B
};

/**
 * Evaluates the full pairwise comparison tournament graph according to Condorcet and Copeland principles.
 */
export function analyzeTournament(
  projects: readonly ProjectId[],
  comparisons: readonly Comparison[],
): TournamentReport {
  const pList = projects.slice().sort();
  const n = pList.length;
  const known = new Set(pList);
  if (known.size !== n) throw new JudgingError("tournament.duplicate", "Project ids must be unique.");

  // Pairwise win counts: wins[A][B] = count where A beat B
  const wins = new Map<string, Map<string, number>>();
  for (const p of pList) {
    wins.set(p, new Map<string, number>());
  }

  for (const c of comparisons) {
    if (!known.has(c.left) || !known.has(c.right) || c.left === c.right || (c.winner !== c.left && c.winner !== c.right)) {
      throw new JudgingError("tournament.comparison", "Each comparison must name two known projects and one of them as winner.");
    }
    const loser = c.winner === c.left ? c.right : c.left;
    const current = wins.get(c.winner)?.get(loser) ?? 0;
    wins.get(c.winner)?.set(loser, current + 1);
  }

  // Build head-to-head dominance & margin matrix
  const matrix: Record<string, Record<string, number>> = Object.create(null);
  const h2hWins = new Map<ProjectId, number>();
  const h2hLosses = new Map<ProjectId, number>();
  const h2hTies = new Map<ProjectId, number>();
  const netMargins = new Map<ProjectId, number>();
  const unplayed = new Map<ProjectId, number>();

  for (const p of pList) {
    matrix[p] = Object.create(null);
    unplayed.set(p, 0);
    h2hWins.set(p, 0);
    h2hLosses.set(p, 0);
    h2hTies.set(p, 0);
    netMargins.set(p, 0);
  }

  for (let i = 0; i < n; i++) {
    const a = pList[i] as ProjectId;
    for (let j = i + 1; j < n; j++) {
      const b = pList[j] as ProjectId;
      const winsAB = wins.get(a)?.get(b) ?? 0;
      const winsBA = wins.get(b)?.get(a) ?? 0;
      const margin = winsAB - winsBA;

      matrix[a]![b] = margin;
      matrix[b]![a] = -margin;

      netMargins.set(a, (netMargins.get(a) ?? 0) + margin);
      netMargins.set(b, (netMargins.get(b) ?? 0) - margin);

      if (winsAB > winsBA) {
        h2hWins.set(a, (h2hWins.get(a) ?? 0) + 1);
        h2hLosses.set(b, (h2hLosses.get(b) ?? 0) + 1);
      } else if (winsBA > winsAB) {
        h2hWins.set(b, (h2hWins.get(b) ?? 0) + 1);
        h2hLosses.set(a, (h2hLosses.get(a) ?? 0) + 1);
      } else if (winsAB + winsBA > 0) {
        h2hTies.set(a, (h2hTies.get(a) ?? 0) + 1);
        h2hTies.set(b, (h2hTies.get(b) ?? 0) + 1);
      } else {
        unplayed.set(a, (unplayed.get(a) ?? 0) + 1);
        unplayed.set(b, (unplayed.get(b) ?? 0) + 1);
      }
    }
  }

  // Determine Condorcet Winner:
  // A project that beat every opponent it was matched against (or all n-1 other projects if fully connected)
  let condorcetWinner: ProjectId | null = null;
  for (const p of pList) {
    const w = h2hWins.get(p) ?? 0;
    const l = h2hLosses.get(p) ?? 0;
    // A strict Condorcet winner defeats every other opponent (n - 1) without a single loss
    if (n > 1 && w === n - 1 && l === 0) {
      condorcetWinner = p;
      break;
    }
  }

  // Calculate Copeland score: Wins - Losses
  const copelandScores = new Map<ProjectId, number>();
  for (const p of pList) {
    const score = (h2hWins.get(p) ?? 0) - (h2hLosses.get(p) ?? 0);
    copelandScores.set(p, score);
  }

  // Rank by Copeland score descending, tie-break by net margin descending
  const ordered = pList.slice().sort((a, b) => (copelandScores.get(b)! - copelandScores.get(a)!) || (netMargins.get(b)! - netMargins.get(a)!) || a.localeCompare(b));
  const ranks = new Map<string, number>();
  ordered.forEach((p, index) => {
    const previous = ordered[index - 1];
    ranks.set(p, previous !== undefined && copelandScores.get(previous) === copelandScores.get(p) && netMargins.get(previous) === netMargins.get(p) ? ranks.get(previous)! : index + 1);
  });

  const standings: ProjectTournamentStanding[] = pList.map((p) => ({
    project: p,
    headToHeadWins: h2hWins.get(p) ?? 0,
    headToHeadLosses: h2hLosses.get(p) ?? 0,
    headToHeadTies: h2hTies.get(p) ?? 0,
    headToHeadUnplayed: unplayed.get(p) ?? 0,
    copelandScore: copelandScores.get(p) ?? 0,
    netMargin: netMargins.get(p) ?? 0,
    rank: ranks.get(p) ?? 1,
    isCondorcetWinner: p === condorcetWinner,
  }));

  standings.sort((a, b) => a.rank - b.rank);

  // The graph is incomplete: directed cycles may be longer than three edges.
  let hasCycle = false;
  const cycleNodes: ProjectId[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (a: string): boolean => {
    visited.add(a); active.add(a); path.push(a);
    for (const b of pList) {
      if ((matrix[a]?.[b] ?? 0) <= 0) continue;
      if (active.has(b)) { cycleNodes.push(...path.slice(path.indexOf(b))); return true; }
      if (!visited.has(b) && visit(b)) return true;
    }
    path.pop(); active.delete(a); return false;
  };
  for (const p of pList) if (!visited.has(p) && visit(p)) { hasCycle = true; break; }

  return {
    standings,
    condorcetWinner,
    hasCycle,
    cycleNodes,
    matrix,
  };
}
