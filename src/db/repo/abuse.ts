import { createHash } from "node:crypto";
import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import { ABUSE_DEFAULTS } from "../../judging/abuse.ts";
import type { AbuseThresholds } from "../../judging/abuse.ts";

export function abusePolicy(db: Db, eventId: string): AbuseThresholds {
  const row = db.get<{ pattern_cosine: number; shared_origin_cosine: number; high_risk_threshold: number }>(
    "select * from abuse_policy where event_id = :event", { event: eventId });
  return row ? { patternCosine: row.pattern_cosine, sharedOriginCosine: row.shared_origin_cosine,
    highRisk: row.high_risk_threshold } : ABUSE_DEFAULTS;
}

export function setAbusePolicy(ctx: Ctx, eventId: string, policy: AbuseThresholds): AbuseThresholds {
  if (![policy.patternCosine, policy.sharedOriginCosine].every((value) =>
    Number.isFinite(value) && value >= 0.5 && value <= 1) ||
    !Number.isSafeInteger(policy.highRisk) || policy.highRisk < 0 || policy.highRisk > 100)
    throw new RuleError("abuse.threshold", "Set similarity between 0.5 and 1 and risk between 0 and 100.");
  ctx.recorded({ action: "abuse.policy_updated", eventId, payload: policy }, () => {
    ctx.write(`insert into abuse_policy (event_id, pattern_cosine, shared_origin_cosine,
      high_risk_threshold, updated_at) values (:event, :pattern, :origin, :risk, :at)
      on conflict(event_id) do update set pattern_cosine = excluded.pattern_cosine,
      shared_origin_cosine = excluded.shared_origin_cosine,
      high_risk_threshold = excluded.high_risk_threshold, updated_at = excluded.updated_at`, {
      event: eventId, pattern: policy.patternCosine, origin: policy.sharedOriginCosine,
      risk: policy.highRisk, at: ctx.now(),
    });
  });
  return abusePolicy(ctx.db, eventId);
}

export function abuseSignalKey(tokens: readonly string[]): string {
  const distinct = [...new Set(tokens)].sort();
  if (distinct.length === 0 || distinct.some((token) => !/^[a-f0-9]{64}$/.test(token)))
    throw new RuleError("abuse.tokens", "Provide event voter hashes as comma-separated 64-character hex strings.");
  return createHash("sha256").update(JSON.stringify(distinct)).digest("hex");
}

export type AbuseReviewState = "investigating" | "benign" | "confirmed";
export function abuseReview(db: Db, eventId: string, signalKey: string): {
  state: AbuseReviewState; reason: string; updatedAt: number;
} | null {
  const row = db.get<{ state: AbuseReviewState; reason: string; updated_at: number }>(
    "select state, reason, updated_at from abuse_review where event_id = :event and signal_key = :key",
    { event: eventId, key: signalKey });
  return row ? { state: row.state, reason: row.reason, updatedAt: row.updated_at } : null;
}

export function setAbuseReview(ctx: Ctx, eventId: string, tokens: readonly string[],
  state: AbuseReviewState, reason: string) {
  const key = abuseSignalKey(tokens);
  for (const token of new Set(tokens)) {
    if (!ctx.db.get("select 1 from voter where event_id = :event and token_hash = :token", { event: eventId, token }))
      throw new RuleError("abuse.unknownVoter", "A voter hash is not in this event.");
  }
  ctx.recorded({ action: "abuse.reviewed", eventId, subject: key,
    payload: { state, reason } }, () => {
    ctx.write(`insert into abuse_review (event_id, signal_key, state, reason, actor_id, updated_at)
      values (:event, :key, :state, :reason, :actor, :at)
      on conflict(event_id, signal_key) do update set state = excluded.state,
      reason = excluded.reason, actor_id = excluded.actor_id, updated_at = excluded.updated_at`, {
      event: eventId, key, state, reason, actor: ctx.actorId, at: ctx.now(),
    });
  });
  return { signalKey: key, ...abuseReview(ctx.db, eventId, key)! };
}
