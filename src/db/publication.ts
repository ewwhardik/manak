import type { Ctx } from "./context.ts";
import type { Db } from "./open.ts";
import { sha256 } from "./migrate.ts";
import { headHash } from "./ledger.ts";
import { NORMALIZE_DEFAULTS } from "../judging/normalize.ts";
import { BRADLEY_TERRY_DEFAULTS } from "../judging/bradleyterry.ts";

export type ResultPublication = {
  event_id: string;
  revision: number;
  issued_at: number;
  rubric_version: number | null;
  algorithm: string;
  options: string;
  evidence_digest: string;
  ledger_head: string;
  report: string;
  reason: string;
  superseded_at: number | null;
};

export function latestPublication(db: Db, eventId: string): ResultPublication | undefined {
  return db.get<ResultPublication>(
    "select * from result_publication where event_id = :e order by revision desc limit 1",
    { e: eventId },
  );
}

export function publicationHistory(db: Db, eventId: string): ResultPublication[] {
  return db.all<ResultPublication>(
    "select * from result_publication where event_id = :e order by revision desc",
    { e: eventId },
  );
}

/** Hash the complete result inputs in stable primary-key order while the write lock is held. */
export function evidenceDigest(db: Db, eventId: string): string {
  const tables: readonly [string, string, string][] = [
    ["event", "id", "id"], ["track", "event_id", "event_id, key"],
    ["team", "event_id", "id"], ["team_member", "event_id", "event_id, team_id, account_id"],
    ["project", "event_id", "id"], ["rubric", "event_id", "event_id, version"],
    ["criterion", "event_id", "event_id, rubric_version, key"], ["ballot", "event_id", "id"],
    ["score", "event_id", "ballot_id, criterion_key"], ["comparison", "event_id", "id"],
    ["voter", "event_id", "event_id, token_hash"],
    ["vote", "event_id", "event_id, voter_hash, project_id"],
    ["vote_discount", "event_id", "event_id, voter_hash"],
    ["abuse_policy", "event_id", "event_id"],
    ["abuse_review", "event_id", "event_id, signal_key"],
    ["membership", "event_id", "event_id, account_id, role"],
    ["judge_track", "event_id", "event_id, judge_id, track_key"],
    ["judge_capacity", "event_id", "event_id, judge_id"],
    ["judge_recusal", "event_id", "event_id, judge_id, project_id"],
  ];
  const snapshot = tables.map(([table, filter, order]) => [table,
    db.all<Record<string, unknown>>(`select * from ${table} where ${filter} = :e order by ${order}`, { e: eventId }),
  ]);
  return sha256(JSON.stringify(snapshot));
}

export function storePublication(ctx: Ctx, eventId: string, report: Record<string, unknown>, reason: string): ResultPublication {
  const previous = latestPublication(ctx.db, eventId);
  const revision = (previous?.revision ?? 0) + 1;
  const at = ctx.now();
  const digest = evidenceDigest(ctx.db, eventId);
  const ledger = headHash(ctx.db);
  const frozen = JSON.stringify({ ...report, published: true, mayPublish: undefined,
    revision, evidenceCutoffAt: at, evidenceDigest: digest });
  ctx.recorded({ action: previous ? "result.corrected" : "result.published", eventId,
    subject: eventId, payload: { revision, reason, evidence_digest: digest } }, () => {
    if (previous) ctx.write(
      "update result_publication set superseded_at = :at where event_id = :e and revision = :r",
      { at, e: eventId, r: previous.revision },
    );
    ctx.write(`insert into result_publication (event_id, revision, issued_at, rubric_version,
      algorithm, options, evidence_digest, ledger_head, report, reason)
      values (:e, :r, :at, :rubric, :algorithm, :options, :digest, :head, :report, :reason)`, {
      e: eventId, r: revision, at, rubric: report.rubricVersion as number | null,
      algorithm: String(report.method), options: JSON.stringify({
        rubric: { version: "normalize-v1", ...NORMALIZE_DEFAULTS },
        pairwise: { version: "bradley-terry-v1", ...BRADLEY_TERRY_DEFAULTS },
      }), digest, head: ledger,
      report: frozen, reason,
    });
  });
  return latestPublication(ctx.db, eventId)!;
}
