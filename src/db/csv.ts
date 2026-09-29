import type { Db } from "./open.ts";
import { normalizeScores } from "../judging/index.ts";
import { loadJudgingInput } from "./repo/judging.ts";
import { publishedVersion } from "./repo/rubrics.ts";
import { latestPublication } from "./publication.ts";

/** Format a cell following RFC 4180 rules. */
export function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Spreadsheet programs can execute formula-like text even when correctly CSV-quoted.
  // Preserve actual numeric cells; prefix untrusted text. JSONL archives remain lossless.
  const raw = String(value);
  const str = typeof value === "string" && /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

/** Format a row of cells into a single CSV line. */
export function formatCsvRow(cells: readonly unknown[]): string {
  return cells.map(formatCsvCell).join(",");
}

export type CsvStage =
  | "registrations"
  | "teams"
  | "projects"
  | "assignments"
  | "ballots"
  | "results"
  | "votes"
  | "audit";

export const CSV_STAGES: readonly CsvStage[] = [
  "registrations",
  "teams",
  "projects",
  "assignments",
  "ballots",
  "results",
  "votes",
  "audit",
];

export function exportCsv(db: Db, eventId: string, stage: CsvStage): string {
  switch (stage) {
    case "registrations": {
      const rows = db.all<{
        accountId: string;
        email: string;
        name: string;
        role: string;
        joinedAt: number;
      }>(
        `select a.id as accountId, a.email, a.display_name as name, m.role, m.created_at as joinedAt
           from membership m
           join account a on a.id = m.account_id
          where m.event_id = :event
          order by m.role, a.email`,
        { event: eventId },
      );
      const lines = [formatCsvRow(["account_id", "email", "name", "role", "joined_at"])];
      for (const r of rows) {
        lines.push(formatCsvRow([r.accountId, r.email, r.name, r.role, new Date(r.joinedAt).toISOString()]));
      }
      return lines.join("\r\n");
    }

    case "teams": {
      const teams = db.all<{ id: string; name: string; createdAt: number }>(
        `select id, name, created_at as createdAt
           from team where event_id = :event order by name`,
        { event: eventId },
      );
      const lines = [formatCsvRow(["team_id", "team_name", "members_count", "created_at"])];
      for (const t of teams) {
        const count = db.get<{ count: number }>(
          `select count(*) as count from team_member where team_id = :t`,
          { t: t.id },
        )?.count ?? 0;
        lines.push(formatCsvRow([t.id, t.name, count, new Date(t.createdAt).toISOString()]));
      }
      return lines.join("\r\n");
    }

    case "projects": {
      const projects = db.all<{
        id: string;
        title: string;
        summary: string;
        tagline: string;
        description: string;
        thumbnail_url: string;
        video_url: string;
        image_urls: string;
        tech_tags: string;
        answers: string;

        teamName: string;
        trackKey: string | null;
        status: string;
        repoUrl: string | null;
        demoUrl: string | null;
        submittedAt: number | null;
        duplicateOf: string | null;
        duplicateDecision: string | null;
      }>(
        `select p.id, p.title, p.summary, p.tagline, p.description, p.thumbnail_url, p.video_url, p.image_urls, p.tech_tags, p.answers, t.name as teamName, p.track_key as trackKey,
                p.status, p.repo_url as repoUrl, p.demo_url as demoUrl, p.submitted_at as submittedAt,
                p.duplicate_of as duplicateOf, p.duplicate_decision as duplicateDecision
           from project p
           join team t on t.id = p.team_id
          where p.event_id = :event
          order by p.title`,
        { event: eventId },
      );
      const lines = [formatCsvRow(["project_id", "title", "team", "track", "status", "repo_url", "demo_url", "submitted_at", "duplicate_of", "duplicate_decision", "summary", "tagline", "description", "thumbnail_url", "video_url", "image_urls", "tech_tags", "answers"])];
      for (const p of projects) {
        lines.push(formatCsvRow([
          p.id,
          p.title,
          p.teamName,
          p.trackKey ?? "",
          p.status,
          p.repoUrl ?? "",
          p.demoUrl ?? "",
          p.submittedAt ? new Date(p.submittedAt).toISOString() : "",
          p.duplicateOf ?? "",
          p.duplicateDecision ?? "",
          p.summary,
          p.tagline,
          p.description,
          p.thumbnail_url,
          p.video_url,
          p.image_urls,
          p.tech_tags,
          p.answers,

        ]));
      }
      return lines.join("\r\n");
    }

    case "assignments": {
      const assignments = db.all<{
        judgeId: string;
        email: string;
        name: string;
        projectId: string;
        projectTitle: string;
      }>(
        `select a.judge_id as judgeId, acc.email, acc.display_name as name,
                p.id as projectId, p.title as projectTitle
           from assignment a
           join account acc on acc.id = a.judge_id
           join project p on p.id = a.project_id
          where a.event_id = :event
          order by acc.email, p.title`,
        { event: eventId },
      );
      const lines = [formatCsvRow(["judge_id", "judge_email", "judge_name", "project_id", "project_title"])];
      for (const a of assignments) {
        lines.push(formatCsvRow([a.judgeId, a.email, a.name, a.projectId, a.projectTitle]));
      }
      return lines.join("\r\n");
    }

    case "ballots": {
      const ballots = db.all<{
        ballotId: string;
        judgeId: string;
        judgeEmail: string;
        projectId: string;
        projectTitle: string;
        criterionKey: string;
        score: number;
        feedback: string | null;
        submittedAt: number;
      }>(
        `select b.id as ballotId, b.judge_id as judgeId, acc.email as judgeEmail,
                p.id as projectId, p.title as projectTitle,
                s.criterion_key as criterionKey, s.value as score, b.comment as feedback,
                coalesce(b.submitted_at, b.created_at) as submittedAt
           from ballot b
           join account acc on acc.id = b.judge_id
           join project p on p.id = b.project_id
           join score s on s.ballot_id = b.id
          where b.event_id = :event
          order by p.title, acc.email, s.criterion_key`,
        { event: eventId },
      );
      const lines = [formatCsvRow([
        "ballot_id", "judge_id", "judge_email", "project_id", "project_title",
        "criterion_key", "score", "feedback", "submitted_at"
      ])];
      for (const b of ballots) {
        lines.push(formatCsvRow([
          b.ballotId, b.judgeId, b.judgeEmail, b.projectId, b.projectTitle,
          b.criterionKey, b.score, b.feedback ?? "", new Date(b.submittedAt).toISOString()
        ]));
      }
      return lines.join("\r\n");
    }

    case "results": {
      const publication = latestPublication(db, eventId);
      if (publication) {
        const report = JSON.parse(publication.report) as { projects?: Record<string, unknown>[] };
        const lines = [formatCsvRow(["revision", "rank", "project_id", "project_title", "fitted_score", "raw_score", "error_margin", "tier", "evidence_digest"])];
        for (const project of report.projects ?? []) lines.push(formatCsvRow([
          publication.revision, project.rank, project.project, project.title,
          project.adjusted, project.rawMean, project.standardError, project.tier,
          publication.evidence_digest,
        ]));
        return lines.join("\r\n");
      }
      const projectRows = db.all<{ id: string; title: string; trackKey: string | null }>(
        `select id, title, track_key as trackKey from project where event_id = :event and status = 'submitted'
          and (duplicate_of is null or duplicate_decision = 'cleared')`,
        { event: eventId },
      );
      const lines = [formatCsvRow(["rank", "project_id", "project_title", "fitted_score", "raw_score", "error_margin", "tier"])];
      const pubVer = publishedVersion(db, eventId);
      if (pubVer === undefined) {
        return lines.join("\r\n");
      }
      const input = loadJudgingInput(db, eventId, pubVer);
      if (input.ballots.length === 0) {
        return lines.join("\r\n");
      }
      const fit = normalizeScores(input.rubric, input.ballots);
      const titles = new Map(projectRows.map((p) => [p.id, p.title]));
      const sorted = [...fit.projects].sort((a, b) => a.rankAdjusted - b.rankAdjusted);
      for (const r of sorted) {
        lines.push(formatCsvRow([
          r.rankAdjusted,
          r.project,
          titles.get(r.project) ?? r.project,
          r.adjusted.toFixed(4),
          r.rawMean.toFixed(4),
          r.standardError.toFixed(4),
          1,
        ]));
      }
      return lines.join("\r\n");
    }

    case "votes": {
      const votes = db.all<{
        voterHash: string;
        projectId: string;
        projectTitle: string;
        influence: number;
        creditsSpent: number;
        createdAt: number;
      }>(
        `select v.voter_hash as voterHash, v.project_id as projectId, p.title as projectTitle,
                v.weight as influence, v.credits_spent as creditsSpent, v.created_at as createdAt
           from vote v
           join project p on p.id = v.project_id
          where v.event_id = :event
          order by v.created_at desc`,
        { event: eventId },
      );
      const lines = [formatCsvRow(["voter_hash", "project_id", "project_title", "influence", "credits_spent", "created_at"])];
      for (const v of votes) {
        lines.push(formatCsvRow([
          v.voterHash,
          v.projectId,
          v.projectTitle,
          v.influence,
          v.creditsSpent,
          new Date(v.createdAt).toISOString(),
        ]));
      }
      return lines.join("\r\n");
    }

    case "audit": {
      const ledger = db.all<{
        seq: number;
        timestamp: number;
        action: string;
        eventId: string | null;
        actorId: string | null;
        subject: string | null;
        payload: string;
        prevHash: string;
        entryHash: string;
      }>(
        `select seq, at as timestamp, action, event_id as eventId, actor_id as actorId,
                subject, payload, prev_hash as prevHash, hash as entryHash
           from ledger
          order by seq`,
      );
      const lines = [formatCsvRow(["seq", "timestamp", "action", "event_id", "actor_id", "subject", "payload", "prev_hash", "hash"])];
      for (const l of ledger) {
        lines.push(formatCsvRow([
          l.seq,
          new Date(l.timestamp).toISOString(),
          l.action,
          l.eventId ?? "",
          l.actorId ?? "",
          l.subject ?? "",
          l.payload,
          l.prevHash,
          l.entryHash,
        ]));
      }
      return lines.join("\r\n");
    }
  }
}
