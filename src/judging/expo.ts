/**
 * Table & Booth Expo Route Optimizer.
 *
 * Implements expo-floor spatial scheduling for hackathons:
 * 1. Assigns projects to physical/virtual booth or table numbers.
 * 2. Groups by track or provides balanced layout.
 * 3. Optimizes judge touring order to minimize walking distance and prevent table crowding.
 */

import type { JudgeId, ProjectId } from "./types.ts";

export type BoothAllocation = {
  project: ProjectId;
  trackKey: string | null;
  tableNumber: number;
  tableName: string;
};

export type BoothOptions = {
  /** Prefix for the table label, e.g. "Table " or "Booth " or "Room ". Default: "Table ". */
  prefix?: string;
  /** Starting table number (default: 1). */
  startNumber?: number;
  /** Group projects by track before assigning sequential table numbers. Default: true. */
  groupByTrack?: boolean;
};

export type JudgeStop = {
  step: number;
  project: ProjectId;
  tableNumber: number;
  tableName: string;
};

export type JudgeTour = {
  judge: JudgeId;
  stops: JudgeStop[];
  totalTransitDistance: number;
};

/**
 * Assigns projects to numbered booths or expo tables.
 */
export function allocateBooths(
  projects: readonly { id: ProjectId; trackKey?: string | null }[],
  options: BoothOptions = {},
): BoothAllocation[] {
  const prefix = options.prefix ?? "Table ";
  const startNumber = options.startNumber ?? 1;
  const groupByTrack = options.groupByTrack ?? true;

  const sorted = projects.slice().sort((a, b) => {
    if (groupByTrack) {
      const trackA = a.trackKey ?? "";
      const trackB = b.trackKey ?? "";
      if (trackA !== trackB) return trackA.localeCompare(trackB);
    }
    return a.id.localeCompare(b.id);
  });

  return sorted.map((p, idx) => {
    const tableNumber = startNumber + idx;
    return {
      project: p.id,
      trackKey: p.trackKey ?? null,
      tableNumber,
      tableName: `${prefix}${tableNumber}`,
    };
  });
}

/**
 * Optimizes the sequence of booth visits for each judge to minimize walking distance.
 */
export function optimizeJudgeRoutes(
  judgeAssignments: readonly { judge: JudgeId; project: ProjectId }[],
  booths: readonly BoothAllocation[],
): JudgeTour[] {
  const tableMap = new Map<ProjectId, BoothAllocation>();
  for (const b of booths) {
    tableMap.set(b.project, b);
  }

  // Group projects by judge
  const byJudge = new Map<JudgeId, ProjectId[]>();
  for (const a of judgeAssignments) {
    const list = byJudge.get(a.judge) ?? [];
    list.push(a.project);
    byJudge.set(a.judge, list);
  }

  const tours: JudgeTour[] = [];

  for (const [judge, pIds] of byJudge.entries()) {
    // Sort project visits in ascending order of table number to minimize floor transit
    const sortedProjects = pIds.slice().sort((a, b) => {
      const tA = tableMap.get(a)?.tableNumber ?? 0;
      const tB = tableMap.get(b)?.tableNumber ?? 0;
      return tA - tB;
    });

    let totalTransit = 0;
    const stops: JudgeStop[] = [];

    for (let i = 0; i < sortedProjects.length; i++) {
      const pId = sortedProjects[i]!;
      const booth = tableMap.get(pId) ?? {
        project: pId,
        trackKey: null,
        tableNumber: 0,
        tableName: "Unassigned",
      };

      if (i > 0) {
        const prevTable = tableMap.get(sortedProjects[i - 1]!)?.tableNumber ?? 0;
        totalTransit += Math.abs(booth.tableNumber - prevTable);
      }

      stops.push({
        step: i + 1,
        project: pId,
        tableNumber: booth.tableNumber,
        tableName: booth.tableName,
      });
    }

    tours.push({
      judge,
      stops,
      totalTransitDistance: totalTransit,
    });
  }

  tours.sort((a, b) => a.judge.localeCompare(b.judge));
  return tours;
}
