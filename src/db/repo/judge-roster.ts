import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import { hasRole } from "./accounts.ts";
import { findProjectIn } from "./projects.ts";

export type JudgeRestrictions = {
  tracks: string[] | null;
  capacity: number | null;
  recusals: string[];
};

export function judgeRestrictions(db: Db, eventId: string, judgeId: string): JudgeRestrictions {
  const tracks = db.all<{ track_key: string }>(
    "select track_key from judge_track where event_id = :e and judge_id = :j order by track_key",
    { e: eventId, j: judgeId },
  ).map((row) => row.track_key);
  const capacity = db.get<{ max_reviews: number }>(
    "select max_reviews from judge_capacity where event_id = :e and judge_id = :j",
    { e: eventId, j: judgeId },
  )?.max_reviews ?? null;
  const recusals = db.all<{ project_id: string }>(
    "select project_id from judge_recusal where event_id = :e and judge_id = :j order by project_id",
    { e: eventId, j: judgeId },
  ).map((row) => row.project_id);
  return { tracks: tracks.length > 0 ? tracks : null, capacity, recusals };
}

export function assertJudgeEligible(db: Db, eventId: string, judgeId: string, projectId: string): void {
  if (!hasRole(db, eventId, judgeId, "judge"))
    throw new RuleError("judge.inactive", "This judge no longer has an active role in the event.");
  const project = findProjectIn(db, eventId, projectId);
  if (!project) throw new RuleError("project.missing", "No such project in this event.");
  const restrictions = judgeRestrictions(db, eventId, judgeId);
  if (restrictions.tracks && (project.track_key === null || !restrictions.tracks.includes(project.track_key)))
    throw new RuleError("judge.trackRestricted", "This judge is not eligible for the project's track.");
  if (restrictions.recusals.includes(projectId))
    throw new RuleError("judge.recused", "This judge has recused themselves from this project.");
}

export function configureJudge(ctx: Ctx, eventId: string, judgeId: string,
  tracks: readonly string[], capacity: number | null): JudgeRestrictions {
  if (!hasRole(ctx.db, eventId, judgeId, "judge"))
    throw new RuleError("judge.inactive", "Choose an active judge of this event.");
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 1000))
    throw new RuleError("judge.capacityValue", "Capacity must be between 0 and 1000.");
  const unique = [...new Set(tracks)];
  for (const key of unique) {
    if (!ctx.db.get("select 1 from track where event_id = :e and key = :key", { e: eventId, key }))
      throw new RuleError("judge.unknownTrack", `Track ${key} is not in this event.`);
  }
  ctx.recorded({ action: "judge.configured", eventId, subject: judgeId,
    payload: { tracks: unique, capacity } }, () => {
    ctx.write("delete from judge_track where event_id = :e and judge_id = :j", { e: eventId, j: judgeId });
    for (const key of unique) ctx.write(
      "insert into judge_track (event_id, judge_id, track_key, created_at) values (:e, :j, :key, :at)",
      { e: eventId, j: judgeId, key, at: ctx.now() },
    );
    ctx.write("delete from judge_capacity where event_id = :e and judge_id = :j", { e: eventId, j: judgeId });
    if (capacity !== null) ctx.write(
      "insert into judge_capacity (event_id, judge_id, max_reviews, updated_at) values (:e, :j, :cap, :at)",
      { e: eventId, j: judgeId, cap: capacity, at: ctx.now() },
    );
  });
  return judgeRestrictions(ctx.db, eventId, judgeId);
}

export function setJudgeRecusal(ctx: Ctx, eventId: string, judgeId: string, projectId: string,
  reason: string, recused: boolean): JudgeRestrictions {
  if (!hasRole(ctx.db, eventId, judgeId, "judge"))
    throw new RuleError("judge.inactive", "Choose an active judge of this event.");
  if (!findProjectIn(ctx.db, eventId, projectId))
    throw new RuleError("project.missing", "No such project in this event.");
  if (reason.trim().length < 3 || reason.trim().length > 500)
    throw new RuleError("comment.reason", "Give a reason between 3 and 500 characters.");
  ctx.recorded({ action: recused ? "judge.recused" : "judge.recusal_cleared",
    eventId, subject: projectId, payload: { judge: judgeId, reason } }, () => {
    ctx.write("delete from judge_recusal where event_id = :e and judge_id = :j and project_id = :p",
      { e: eventId, j: judgeId, p: projectId });
    if (recused) ctx.write(`insert into judge_recusal
      (event_id, judge_id, project_id, reason, created_at) values (:e, :j, :p, :reason, :at)`,
      { e: eventId, j: judgeId, p: projectId, reason: reason.trim(), at: ctx.now() });
  });
  return judgeRestrictions(ctx.db, eventId, judgeId);
}

export function assertJudgeCapacity(db: Db, eventId: string, judgeId: string): void {
  const limit = judgeRestrictions(db, eventId, judgeId).capacity;
  if (limit === null) return;
  const assigned = db.one<{ n: number }>(
    "select count(*) as n from assignment where event_id = :e and judge_id = :j",
    { e: eventId, j: judgeId },
  ).n;
  if (assigned >= limit) throw new RuleError("judge.capacity", "This judge has reached their event review capacity.");
}
