/**
 * A small world, built the same way every test builds it.
 *
 * Every function here goes through the real repositories rather than inserting rows
 * directly. That costs a little speed and buys the thing that matters: a fixture
 * built by `insert into ballot ...` can be in a state no code path can reach, and a
 * test that then asserts on it is asserting about a database that cannot happen.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manualClock, MS } from "../../src/db/clock.ts";
import type { Clock } from "../../src/db/clock.ts";
import { makeIds } from "../../src/db/ids.ts";
import { openDatabase } from "../../src/db/open.ts";
import type { Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrate.ts";
import { makeContext } from "../../src/db/context.ts";
import type { Ctx } from "../../src/db/context.ts";
import { createEvent, createTrack } from "../../src/db/repo/events.ts";
import type { EventRow } from "../../src/db/repo/events.ts";
import { grantRole, upsertAccount } from "../../src/db/repo/accounts.ts";
import type { AccountRow } from "../../src/db/repo/accounts.ts";
import { addTeamMember, createProject, createTeam, submitProject } from "../../src/db/repo/projects.ts";
import type { ProjectRow, TeamRow } from "../../src/db/repo/projects.ts";
import { createRubricVersion, publishRubric } from "../../src/db/repo/rubrics.ts";

/** An arbitrary but fixed instant: 2026-09-25T18:00:00.000Z, the event kickoff. */
export const T0 = Date.parse("2026-09-25T18:00:00.000Z");

/** Deterministic ids, so a failing assertion names the same row on a rerun. */
export function testIds(clock: Clock): () => string {
  let counter = 0;
  return makeIds(clock.now, (into) => {
    counter += 1;
    into.fill(0);
    into[into.length - 1] = counter & 0xff;
    into[into.length - 2] = (counter >> 8) & 0xff;
  });
}

export type Harness = {
  db: Db;
  clock: ReturnType<typeof manualClock>;
  /** A context with no actor, for setup that predates anyone signing in. */
  system: Ctx;
  close: () => void;
};

export function freshDb(at: number = T0): Harness {
  const db = openDatabase(":memory:");
  const clock = manualClock(at);
  migrate(db, undefined, clock);
  const system = makeContext(db, { clock, newId: testIds(clock) });
  return { db, clock, system, close: () => db.close() };
}

/** The same, on disk, for the tests that are about WAL, files and reopening. */
export function tempDb(at: number = T0): Harness & { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "manak-test-"));
  const path = join(dir, "manak.sqlite");
  const db = openDatabase(path);
  const clock = manualClock(at);
  migrate(db, undefined, clock);
  const system = makeContext(db, { clock, newId: testIds(clock) });
  return {
    db,
    clock,
    system,
    dir,
    path,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type World = Harness & {
  event: EventRow;
  organizer: AccountRow;
  judges: AccountRow[];
  teams: TeamRow[];
  projects: ProjectRow[];
  /** A context acting as the organizer. */
  asOrganizer: Ctx;
  /** A context acting as one of the judges. */
  asJudge: (index: number) => Ctx;
};

export type WorldOptions = {
  judges?: number;
  projects?: number;
  reviewsPerProject?: number;
  pairwise?: boolean;
  /** Leave the rubric unpublished, for the tests about that refusal. */
  publishRubric?: boolean;
  tracks?: readonly string[];
};

/**
 * An event mid-judging: submissions closed an hour ago, judging open, a published
 * three-criterion rubric, judges and submitted projects.
 *
 * The clock sits *inside* the judging window rather than at a boundary, because a
 * fixture parked on a deadline makes every unrelated test a deadline test.
 */
export function world(options: WorldOptions = {}): World {
  const harness = freshDb();
  const { clock, system } = harness;
  const judgeCount = options.judges ?? 3;
  const projectCount = options.projects ?? 4;

  const event = createEvent(system, {
    slug: "dogfood-2026",
    name: "Dogfood 2026",
    submissionsOpenAt: T0 - 3 * MS.day,
    submissionsCloseAt: T0 - MS.hour,
    judgingOpenAt: T0 - MS.hour,
    judgingCloseAt: T0 + MS.day,
    reviewsPerProject: options.reviewsPerProject ?? 3,
    pairwiseEnabled: options.pairwise ?? true,
  });
  for (const [index, key] of (options.tracks ?? []).entries()) {
    createTrack(system, event.id, { key, label: key.toUpperCase(), ordering: index });
  }

  const organizer = upsertAccount(system, "organizer@example.test", "Ada Organizer");
  grantRole(system, event.id, organizer.id, "organizer");
  const asOrganizer = system.as(organizer.id);

  const judges: AccountRow[] = [];
  for (let i = 0; i < judgeCount; i += 1) {
    const judge = upsertAccount(system, `judge${i}@example.test`, `Judge ${i}`);
    grantRole(system, event.id, judge.id, "judge");
    judges.push(judge);
  }

  // Projects are created and submitted while submissions were still open, then the
  // clock is moved into judging. Doing it in that order means `submitProject` is
  // exercised against its real gate instead of being handed a state it would refuse.
  clock.set(T0 - 2 * MS.day);
  const teams: TeamRow[] = [];
  const projects: ProjectRow[] = [];
  for (let i = 0; i < projectCount; i += 1) {
    const team = createTeam(system, event.id, `Team ${i}`);
    const member = upsertAccount(system, `builder${i}@example.test`, `Builder ${i}`);
    grantRole(system, event.id, member.id, "participant");
    addTeamMember(system, team, member.id);
    const draft = createProject(system.as(member.id), event, team, {
      title: `Project ${i}`,
      summary: `What project ${i} does, in one sentence.`,
      repoUrl: `https://example.test/repo/${i}`,
      ...((options.tracks?.length ?? 0) > 0
        ? { trackKey: options.tracks?.[i % (options.tracks.length || 1)] ?? null }
        : {}),
    });
    teams.push(team);
    projects.push(submitProject(system.as(member.id), event, draft));
  }
  clock.set(T0);

  createRubricVersion(asOrganizer, event.id, [
    { key: "impact", label: "Impact", weight: 2, min: 1, max: 5 },
    { key: "craft", label: "Craft", weight: 1, min: 1, max: 5 },
    { key: "novelty", label: "Novelty", weight: 1, min: 0, max: 10 },
  ]);
  if (options.publishRubric !== false) publishRubric(asOrganizer, event.id, 1);

  return {
    ...harness,
    event,
    organizer,
    judges,
    teams,
    projects,
    asOrganizer,
    asJudge: (index) => system.as((judges[index] as AccountRow).id),
  };
}

/** Full marks on every criterion, for tests that do not care about the numbers. */
export const FULL_SCORES = { impact: 5, craft: 5, novelty: 10 } as const;
