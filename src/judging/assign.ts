/**
 * Judge assignment for rubric mode.
 *
 * The requirement is easy to state and easy to get subtly wrong: every project
 * gets N independent reviews, no judge reviews a project twice, conflicts of
 * interest are respected absolutely, tracks are honoured, and no judge is handed
 * twice the work of the judge sitting next to them.
 *
 * This is a bipartite degree-constrained assignment. Rather than reach for a flow
 * solver, it is filled greedily in **most-constrained-first** order: the project
 * with the fewest eligible judges is served first, because that is the project a
 * naive pass leaves stranded after every judge who could have taken it is full.
 * Each slot goes to the eligible judge carrying the lightest load. Residual
 * augmenting paths then maximize filled slots without relaxing eligibility or
 * capacity. A bounded repair pass moves work off the heaviest judges until the spread is one
 * review or the moves run out.
 *
 * Two properties matter more than optimality:
 *
 *   - **Determinism.** Same seed, same roster, same assignment. An organizer who
 *     reruns the draw and gets a different answer cannot explain either one.
 *   - **Honest shortfall.** If conflicts and capacities make N reviews
 *     impossible, the result says which projects came up short and why. It does
 *     not silently assign fewer and let the leaderboard imply otherwise. A
 *     project judged twice when its neighbours were judged four times is a
 *     fairness problem, and it has to be visible before the ceremony, not after.
 */

import type { JudgeId, ProjectId } from "./types.ts";
import { JudgingError } from "./types.ts";
import { makeRng } from "./rng.ts";
import { agree, names, plural } from "./words.ts";

export type AssignProject = {
  id: ProjectId;
  /** Optional track. Judges restricted to tracks only see matching projects. */
  track?: string;
};

export type AssignJudge = {
  id: JudgeId;
  /** Empty or absent means this judge can take any track. */
  tracks?: readonly string[];
  /** Maximum reviews this judge accepts. Absent means no explicit ceiling. */
  capacity?: number;
  /** Projects this judge must never be shown: own team, employer, mentee. */
  conflicts?: readonly ProjectId[];
};

export type AssignmentOptions = {
  /** Cap on repair moves, so a pathological roster cannot spin. */
  repairPasses?: number;
  /** Existing reviewed assignments that must survive a redraw. */
  lockedAssignments?: readonly Assignment[];
  /** Work outside the project pool, which still consumes judge capacity. */
  outsideLoads?: ReadonlyMap<JudgeId, number>;
};

export type Assignment = { judge: JudgeId; project: ProjectId };

export type Shortfall = {
  project: ProjectId;
  wanted: number;
  assigned: number;
  eligibleJudges: number;
  reason: string;
};

export type AssignmentResult = {
  method: string;
  assignments: Assignment[];
  byJudge: Map<JudgeId, ProjectId[]>;
  byProject: Map<ProjectId, JudgeId[]>;
  reviewsPerProject: number;
  loadMin: number;
  loadMax: number;
  loadMean: number;
  /** True when the busiest and quietest judge differ by at most one review. */
  balanced: boolean;
  shortfalls: Shortfall[];
  complete: boolean;
  warnings: string[];
};

/** How many repair passes the assignment scheduler makes by default. */
export const ASSIGN_DEFAULTS = { repairPasses: 4 } as const;

const DEFAULTS = ASSIGN_DEFAULTS;

export function assignReviews(
  projects: readonly AssignProject[],
  judges: readonly AssignJudge[],
  reviewsPerProject: number,
  seed: number | string,
  options: AssignmentOptions = {},
): AssignmentResult {
  const opt = { ...DEFAULTS, ...options };
  if (!Number.isSafeInteger(opt.repairPasses) || opt.repairPasses < 0) {
    throw new JudgingError("assign.repairPasses", "Repair passes must be a non-negative safe integer.");
  }
  for (const judge of judges) {
    if (judge.capacity !== undefined && (!Number.isSafeInteger(judge.capacity) || judge.capacity < 0)) {
      throw new JudgingError("assign.capacity", "Judge capacity must be a non-negative safe integer.");
    }
  }
  if (projects.length === 0) {
    throw new JudgingError("assign.noProjects", "There are no projects to assign.");
  }
  if (judges.length === 0) {
    throw new JudgingError("assign.noJudges", "There are no judges to assign.");
  }
  if (!Number.isInteger(reviewsPerProject) || reviewsPerProject < 1) {
    throw new JudgingError(
      "assign.reviews",
      `reviewsPerProject must be a positive integer, received ${reviewsPerProject}.`,
    );
  }
  const projectIds = new Set(projects.map((p) => p.id));
  if (projectIds.size !== projects.length) {
    throw new JudgingError("assign.duplicateProject", "The project list contains a duplicate id.");
  }
  const judgeIds = new Set(judges.map((j) => j.id));
  if (judgeIds.size !== judges.length) {
    throw new JudgingError("assign.duplicateJudge", "The judge list contains a duplicate id.");
  }

  const rng = makeRng(seed);
  // A seeded tie-break order, so equal-load judges are not always picked
  // alphabetically — otherwise judge "aisha" reviews every hard case.
  const order = new Map<JudgeId, number>();
  rng.shuffle(judges.map((j) => j.id)).forEach((id, index) => order.set(id, index));

  const conflictSet = new Map<JudgeId, Set<ProjectId>>();
  const trackSet = new Map<JudgeId, Set<string> | null>();
  const capacityOf = new Map<JudgeId, number>();
  for (const j of judges) {
    conflictSet.set(j.id, new Set(j.conflicts ?? []));
    trackSet.set(j.id, j.tracks && j.tracks.length > 0 ? new Set(j.tracks) : null);
    capacityOf.set(j.id, j.capacity ?? Number.POSITIVE_INFINITY);
  }

  const eligible = (judge: AssignJudge, project: AssignProject): boolean => {
    if ((conflictSet.get(judge.id) as Set<ProjectId>).has(project.id)) return false;
    const tracks = trackSet.get(judge.id) ?? null;
    if (tracks !== null && project.track !== undefined && !tracks.has(project.track)) return false;
    if (tracks !== null && project.track === undefined) return false;
    return true;
  };

  const eligibleFor = new Map<ProjectId, JudgeId[]>();
  for (const p of projects) {
    eligibleFor.set(
      p.id,
      judges.filter((j) => eligible(j, p)).map((j) => j.id),
    );
  }

  const load = new Map<JudgeId, number>(judges.map((j) => [j.id, opt.outsideLoads?.get(j.id) ?? 0]));
  const byJudge = new Map<JudgeId, ProjectId[]>(judges.map((j) => [j.id, []]));
  const byProject = new Map<ProjectId, JudgeId[]>(projects.map((p) => [p.id, []]));
  const assignedPairs = new Set<string>();
  const locked = new Set<string>();
  for (const [judge, value] of load) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new JudgingError("assign.outsideLoad", `Outside load for ${judge} must be a non-negative safe integer.`);
    }
  }
  for (const assignment of opt.lockedAssignments ?? []) {
    if (!judgeIds.has(assignment.judge) || !projectIds.has(assignment.project)) {
      throw new JudgingError("assign.locked", "A retained assignment is outside the draw roster or project pool.");
    }
    const key = `${assignment.judge} ${assignment.project}`;
    if (locked.has(key)) throw new JudgingError("assign.locked", "The retained assignment list contains a duplicate.");
    locked.add(key);
    assignedPairs.add(key);
    byJudge.get(assignment.judge)!.push(assignment.project);
    byProject.get(assignment.project)!.push(assignment.judge);
    load.set(assignment.judge, load.get(assignment.judge)! + 1);
  }

  // Most-constrained-first: fewest eligible judges, then seeded order for ties.
  const projectOrder = rng
    .shuffle(projects.map((p) => p.id))
    .slice()
    .sort(
      (a, b) =>
        (eligibleFor.get(a) as JudgeId[]).length - (eligibleFor.get(b) as JudgeId[]).length,
    );

  for (let slot = 0; slot < reviewsPerProject; slot++) {
    for (const projectId of projectOrder) {
      const taken = byProject.get(projectId) as JudgeId[];
      if (taken.length > slot) continue;
      const options_ = (eligibleFor.get(projectId) as JudgeId[]).filter(
        (id) =>
          !assignedPairs.has(`${id} ${projectId}`) &&
          (load.get(id) as number) < (capacityOf.get(id) as number),
      );
      if (options_.length === 0) continue;
      options_.sort(
        (a, b) =>
          (load.get(a) as number) - (load.get(b) as number) ||
          (order.get(a) as number) - (order.get(b) as number),
      );
      const pick = options_[0] as JudgeId;
      assignedPairs.add(`${pick} ${projectId}`);
      taken.push(pick);
      (byJudge.get(pick) as ProjectId[]).push(projectId);
      load.set(pick, (load.get(pick) as number) + 1);
    }
  }

  // Complete the capacitated matching using residual augmenting paths. Greedy
  // placement alone can strand a project even when a full allocation exists.
  // BFS is iterative: roster size cannot overflow the JavaScript call stack.
  const attach = (judge: JudgeId, project: ProjectId) => {
    assignedPairs.add(`${judge} ${project}`);
    byJudge.get(judge)!.push(project);
    byProject.get(project)!.push(judge);
    load.set(judge, load.get(judge)! + 1);
  };
  const detach = (judge: JudgeId, project: ProjectId) => {
    assignedPairs.delete(`${judge} ${project}`);
    const carried = byJudge.get(judge)!;
    carried.splice(carried.indexOf(project), 1);
    const holders = byProject.get(project)!;
    holders.splice(holders.indexOf(judge), 1);
    load.set(judge, load.get(judge)! - 1);
  };
  const augment = (start: ProjectId): boolean => {
    const queue = [start];
    const visitedProjects = new Set(queue);
    const viaJudge = new Map<ProjectId, JudgeId>();
    const viaProject = new Map<JudgeId, ProjectId>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const project = queue[cursor]!;
      const candidates = eligibleFor.get(project)!.slice().sort((a, b) =>
        load.get(a)! - load.get(b)! || order.get(a)! - order.get(b)!);
      for (const judge of candidates) {
        if (viaProject.has(judge) || byProject.get(project)!.includes(judge)) continue;
        viaProject.set(judge, project);
        if (load.get(judge)! < capacityOf.get(judge)!) {
          let nextJudge = judge;
          for (;;) {
            const nextProject = viaProject.get(nextJudge)!;
            attach(nextJudge, nextProject);
            if (nextProject === start) return true;
            const previousJudge = viaJudge.get(nextProject)!;
            detach(previousJudge, nextProject);
            nextJudge = previousJudge;
          }
        }
        for (const carried of byJudge.get(judge)!.slice().sort()) {
          if (visitedProjects.has(carried) || locked.has(`${judge} ${carried}`)) continue;
          visitedProjects.add(carried);
          viaJudge.set(carried, judge);
          queue.push(carried);
        }
      }
    }
    return false;
  };
  for (const project of projectOrder) {
    while (byProject.get(project)!.length < reviewsPerProject && augment(project)) { /* adds one slot */ }
  }

  // Repair pass: move a review off the heaviest judge to a lighter eligible one.
  // Purely local, bounded, and deterministic — it never changes how many reviews
  // a project has, only who files them.
  for (let pass = 0; pass < opt.repairPasses; pass++) {
    let moved = false;
    const ids = judges.map((j) => j.id);
    const heaviest = ids.slice().sort(
      (a, b) =>
        (load.get(b) as number) - (load.get(a) as number) ||
        (order.get(a) as number) - (order.get(b) as number),
    );
    for (const from of heaviest) {
      const lightest = ids
        .filter((id) => (load.get(id) as number) + 1 < (load.get(from) as number))
        .sort(
          (a, b) =>
            (load.get(a) as number) - (load.get(b) as number) ||
            (order.get(a) as number) - (order.get(b) as number),
        );
      if (lightest.length === 0) continue;
      const carried = (byJudge.get(from) as ProjectId[]).slice().sort();
      let done = false;
      for (const projectId of carried) {
        if (locked.has(`${from} ${projectId}`)) continue;
        const project = projects.find((p) => p.id === projectId) as AssignProject;
        for (const to of lightest) {
          const judge = judges.find((j) => j.id === to) as AssignJudge;
          if (!eligible(judge, project)) continue;
          if (assignedPairs.has(`${to} ${projectId}`)) continue;
          if ((load.get(to) as number) >= (capacityOf.get(to) as number)) continue;
          assignedPairs.delete(`${from} ${projectId}`);
          assignedPairs.add(`${to} ${projectId}`);
          const list = byJudge.get(from) as ProjectId[];
          list.splice(list.indexOf(projectId), 1);
          (byJudge.get(to) as ProjectId[]).push(projectId);
          const holders = byProject.get(projectId) as JudgeId[];
          holders[holders.indexOf(from)] = to;
          load.set(from, (load.get(from) as number) - 1);
          load.set(to, (load.get(to) as number) + 1);
          moved = true;
          done = true;
          break;
        }
        if (done) break;
      }
    }
    if (!moved) break;
  }

  for (const list of byJudge.values()) list.sort();
  for (const list of byProject.values()) list.sort();

  const assignments: Assignment[] = [];
  for (const p of projects.map((x) => x.id).slice().sort()) {
    for (const j of byProject.get(p) as JudgeId[]) assignments.push({ judge: j, project: p });
  }

  const loads = judges.map((j) => load.get(j.id) as number);
  const loadMin = Math.min(...loads);
  const loadMax = Math.max(...loads);
  const loadMean = loads.reduce((a, b) => a + b, 0) / loads.length;

  const shortfalls: Shortfall[] = [];
  for (const p of projects) {
    const got = (byProject.get(p.id) as JudgeId[]).length;
    if (got >= reviewsPerProject) continue;
    const pool = (eligibleFor.get(p.id) as JudgeId[]).length;
    const reason =
      pool === 0
        ? `no judge is eligible: every judge is either conflicted out or assigned to other tracks`
        : pool < reviewsPerProject
          ? `only ${plural(pool, "judge")} ${agree(pool, "is", "are")} eligible, fewer than the ` +
            `${reviewsPerProject} reviews requested`
          : `eligible judges reached their capacity before this project could be filled`;
    shortfalls.push({
      project: p.id,
      wanted: reviewsPerProject,
      assigned: got,
      eligibleJudges: pool,
      reason,
    });
  }

  const warnings: string[] = [];
  for (const judge of judges) {
    if (load.get(judge.id)! > capacityOf.get(judge.id)!) {
      warnings.push(`${judge.id} already has retained work above their configured capacity; the draw did not remove submitted reviews.`);
    }
  }
  if (shortfalls.length > 0) {
    warnings.push(
      `${plural(shortfalls.length, "project")} received fewer than ${reviewsPerProject} reviews. ` +
        `Raise judge capacity, relax a track restriction, or lower the review target — ` +
        `but do not publish a ranking where some projects were seen half as often as others.`,
    );
  }
  if (loadMax - loadMin > 1) {
    warnings.push(
      `Judge load ranges from ${loadMin} to ${loadMax} reviews. Conflicts or track ` +
        `restrictions prevented a fully even split; the repair pass moved what it could.`,
    );
  }
  const idle = judges.filter((j) => (load.get(j.id) as number) === 0).map((j) => j.id);
  if (idle.length > 0) {
    warnings.push(
      `${plural(idle.length, "judge")} ${agree(idle.length, "was", "were")} assigned nothing: ` +
        `${names(idle)}.`,
    );
  }

  return {
    method: `most-constrained-first+augmenting-paths+repair(passes=${opt.repairPasses})`,
    assignments,
    byJudge,
    byProject,
    reviewsPerProject,
    loadMin,
    loadMax,
    loadMean,
    balanced: loadMax - loadMin <= 1,
    shortfalls,
    complete: shortfalls.length === 0,
    warnings,
  };
}
