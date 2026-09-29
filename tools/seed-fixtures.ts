/**
 * Seed the portal from the official DOGFOOD fixtures.json.
 *
 * Populates event evt_01, tracks, judges, teams, projects, published rubric,
 * judge ballots, and deterministic test sessions for acceptance checking.
 */

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addTeamMember,
  createEvent,
  createProject,
  createRubricVersion,
  createTeam,
  createTrack,
  findEvent,
  findEventBySlug,
  findTeamIn,
  grantRole,
  makeContext,
  MS,
  openDatabase,
  publishRubric,
  saveBallot,
  submitProject,
  systemClock,
  upsertAccount,
  createSession,
} from "../src/db/index.ts";
import type { Ctx, EventRow, ProjectRow } from "../src/db/index.ts";

// This public key is deliberately scoped to disposable fixture sessions. These
// credentials are only seeded by the demo tooling; never use this key for sessions
// in a non-demo deployment.
const DEMO_FIXTURE_SESSION_KEY = "manak-dogfood-demo-only-session-key-v1";

function demoFixtureSession(role: string, email: string): string {
  return createHmac("sha256", DEMO_FIXTURE_SESSION_KEY)
    .update(`demo-session:${role}:${email.toLowerCase()}`, "utf8")
    .digest("hex");
}

export const FIXTURE_AUTH = {
  organizer: demoFixtureSession("organizer", "organizer@example.org"),
  judge_a: demoFixtureSession("judge", "tomas.varga@example.org"),
  judge_b: demoFixtureSession("judge", "wei.lindqvist@example.org"),
  participant: demoFixtureSession("participant", "priya1@example.org"),
} as const;

type FixtureData = {
  event: {
    id: string;
    name: string;
    submissions_close: string;
  };
  tracks: { id: string; name: string }[];
  judges: { id: string; name: string; email: string; tracks: string[] }[];
  teams: { id: string; name: string; members: string[] }[];
  projects: {
    id: string;
    team: string;
    track: string;
    title: string;
    summary: string;
    repo_url: string;
    submitted_at: string;
  }[];
  scores: {
    judge: string;
    project: string;
    criteria: Record<string, number>;
    comment: string;
  }[];
};

function loadFixtureJson(): FixtureData {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../fixtures.json"),
    join(here, "fixtures.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return JSON.parse(readFileSync(c, "utf8"));
  }
  throw new Error("fixtures.json not found in candidate paths.");
}

export function seedFixtures(ctx: Ctx, now: number): { event: EventRow } {
  const data = loadFixtureJson();
  const finalSubmissionsCloseAt = Date.parse(data.event.submissions_close);

  // 1. Upsert Organizer
  const organizer = upsertAccount(ctx, "organizer@example.org", "Sample Organizer", "acc_organizer_01");
  const asOrg = ctx.as(organizer.id);

  // 2. Create Event (temporarily open so createProject/submitProject can execute without gate conflict)
  const event = createEvent(asOrg, {
    id: data.event.id,
    slug: "sample-hack-2026",
    name: data.event.name,
    timezone: "UTC",
    submissionsOpenAt: finalSubmissionsCloseAt - 7 * MS.day,
    submissionsCloseAt: now + MS.day, // temporarily open
    judgingOpenAt: finalSubmissionsCloseAt - 7 * MS.day,
    judgingCloseAt: now + 365 * MS.day,
    reviewsPerProject: 3,
    pairwiseEnabled: true,
  });
  grantRole(asOrg, event.id, organizer.id, "organizer");

  // 3. Tracks
  for (let i = 0; i < data.tracks.length; i++) {
    const t = data.tracks[i]!;
    createTrack(asOrg, event.id, {
      key: t.id,
      label: t.name,
      ordering: i + 1,
    });
  }

  // 4. Judges
  for (const j of data.judges) {
    const judgeAcc = upsertAccount(asOrg, j.email, j.name, j.id);
    grantRole(asOrg, event.id, judgeAcc.id, "judge");
  }

  // 5. Teams and Members
  const teamMap = new Map<string, { id: string; authorId: string }>();
  const seenTeamNames = new Set<string>();
  for (const tm of data.teams) {
    let teamName = tm.name;
    if (seenTeamNames.has(teamName)) {
      teamName = `${tm.name} (${tm.id})`;
    }
    seenTeamNames.add(teamName);
    const teamRow = createTeam(asOrg, event.id, teamName, tm.id);
    let authorId = "";
    for (let m = 0; m < tm.members.length; m++) {
      const email = tm.members[m]!;
      const memberAcc = upsertAccount(asOrg, email, email.split("@")[0]);
      grantRole(asOrg, event.id, memberAcc.id, "participant");
      addTeamMember(asOrg, teamRow, memberAcc.id);
      if (m === 0) authorId = memberAcc.id;
    }
    teamMap.set(tm.id, { id: teamRow.id, authorId });
  }

  // 6. Projects
  const projectMap = new Map<string, ProjectRow>();
  for (const p of data.projects) {
    const teamInfo = teamMap.get(p.team);
    if (!teamInfo) throw new Error(`Fixture project ${p.id} references missing team ${p.team}.`);
    const asMember = ctx.as(teamInfo.authorId);
    const teamRow = findTeamIn(ctx.db, event.id, teamInfo.id);
    if (!teamRow) throw new Error(`Fixture team ${p.team} was not imported.`);
    const project = createProject(asMember, event, teamRow, {
      id: p.id,
      title: p.title,
      summary: p.summary,
      repoUrl: p.repo_url,
      trackKey: p.track,
    });
    submitProject(asMember, event, project);
    const submittedAt = Date.parse(p.submitted_at);
    if (!Number.isFinite(submittedAt) || submittedAt > finalSubmissionsCloseAt) {
      throw new Error(`Fixture project ${p.id} has an invalid or late submission timestamp.`);
    }
    ctx.recorded({ action: "project.fixture_imported", eventId: event.id, subject: p.id,
      payload: { submittedAt } }, () => ctx.write(
      "update project set submitted_at = :at where id = :id", { at: submittedAt, id: p.id }));
    projectMap.set(p.id, project);
  }

  // 7. Rubric & Scores
  const rubricCriteria = [
    { key: "functionality", label: "Functionality", weight: 1, min: 1, max: 5 },
    { key: "quality", label: "Quality", weight: 1, min: 1, max: 5 },
    { key: "innovation", label: "Innovation", weight: 1, min: 1, max: 5 },
  ];
  createRubricVersion(asOrg, event.id, rubricCriteria);
  publishRubric(asOrg, event.id, 1);

  for (const s of data.scores) {
    const asJudge = ctx.as(s.judge);
    saveBallot(asJudge, event, {
        judgeId: s.judge,
        projectId: s.project,
        scores: s.criteria,
        comment: s.comment,
        submit: true,
    });
  }

  // 8. Seal the submissions deadline to the past timestamp from fixtures.json
  ctx.recorded(
    {
      action: "event.updated",
      eventId: event.id,
      subject: event.id,
      payload: { submissions_close_at: finalSubmissionsCloseAt },
    },
    () => {
      ctx.write(
        "update event set submissions_close_at = :close where id = :id",
        { close: finalSubmissionsCloseAt, id: event.id },
      );
    },
  );

  // 9. Deterministic Sessions
  // Organizer
  createSession(asOrg, organizer.id, { token: FIXTURE_AUTH.organizer, ttl: 30 * MS.day });
  // Judge A (jdg_01)
  const judgeA = upsertAccount(asOrg, "tomas.varga@example.org", "Tomas Varga", "jdg_01");
  createSession(ctx.as(judgeA.id), judgeA.id, { token: FIXTURE_AUTH.judge_a, ttl: 30 * MS.day });
  // Judge B (jdg_02)
  const judgeB = upsertAccount(asOrg, "wei.lindqvist@example.org", "Wei Lindqvist", "jdg_02");
  createSession(ctx.as(judgeB.id), judgeB.id, { token: FIXTURE_AUTH.judge_b, ttl: 30 * MS.day });
  // Participant (priya1@example.org - member of tm_01)
  const participant = upsertAccount(asOrg, "priya1@example.org", "priya1");
  createSession(ctx.as(participant.id), participant.id, { token: FIXTURE_AUTH.participant, ttl: 30 * MS.day });

  const updatedEvent = findEvent(ctx.db, event.id)!;
  return { event: updatedEvent };
}
