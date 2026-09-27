import { createHash, randomBytes } from "node:crypto";

import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import { makeRng } from "../../judging/index.ts";
import { hashToken } from "./accounts.ts";
import type { EventRow } from "./events.ts";
import { findProjectIn } from "./projects.ts";

export type VoterRow = {
  token_hash: string;
  event_id: string;
  account_id: string | null;
  fingerprint: string;
  credits: number;
  created_at: number;
  expires_at: number;
};

export type VoteRow = {
  event_id: string;
  voter_hash: string;
  project_id: string;
  credits_spent: number;
  weight: number;
  created_at: number;
};

export type VoterToken = { token: string; credits: number; expiresAt: number };

const VOTER_TTL = 7 * 24 * 60 * 60 * 1000;

export function voterStatus(db: Db, eventId: string, token: string | null, now: number): {
  credits: number; allocations: { project: string; influence: number }[];
} | null {
  if (token === null) return null;
  const hash = hashToken(token);
  const voter = db.get<VoterRow>("select * from voter where event_id = :event and token_hash = :token and expires_at > :now", { event: eventId, token: hash, now });
  if (voter === undefined) return null;
  return { credits: voter.credits, allocations: db.all<{ project: string; influence: number }>(
    "select project_id as project, weight as influence from vote where event_id = :event and voter_hash = :token", { event: eventId, token: hash },
  ) };
}

export function fingerprint(address: string, userAgent: string): string {
  return createHash("sha256").update(`${address}\n${userAgent}`, "utf8").digest("hex");
}

export function startVoter(
  ctx: Ctx,
  event: EventRow,
  identity: { fingerprint: string; accountId: string | null },
): VoterToken {
  if (event.voting_mode === "off") throw new RuleError("voting.disabled", "Voting is not enabled for this event.");
  const now = ctx.now();
  if (event.voting_open_at === null || event.voting_close_at === null || now < event.voting_open_at || now >= event.voting_close_at) {
    throw new RuleError("voting.notOpen", "Voting is not open for this event.");
  }
  if (event.voting_mode === "account" && identity.accountId === null) {
    throw new RuleError("access.unauthenticated", "This event requires a signed-in voter.");
  }
  const existing = ctx.db.get<VoterRow>(
    `select token_hash, event_id, account_id, fingerprint, credits, created_at, expires_at
       from voter where event_id = :event and
       (fingerprint = :fingerprint or (:account is not null and account_id = :account))`,
    { event: event.id, fingerprint: identity.fingerprint, account: identity.accountId },
  );
  if (existing !== undefined) {
    throw new RuleError("voting.alreadyStarted", "This voter identity already has a voting token.");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Math.min(event.voting_close_at, now + VOTER_TTL);
  ctx.recorded(
    {
      action: "voter.created",
      eventId: event.id,
      subject: identity.fingerprint.slice(0, 16),
      payload: { credits: event.voting_credits, expires_at: expiresAt, mode: event.voting_mode },
    },
    () => {
      ctx.write(
        `insert into voter (token_hash, event_id, account_id, fingerprint, credits, created_at, expires_at)
         values (:token, :event, :account, :fingerprint, :credits, :created, :expires)`,
        {
          token: hashToken(token),
          event: event.id,
          account: identity.accountId,
          fingerprint: identity.fingerprint,
          credits: event.voting_credits,
          created: now,
          expires: expiresAt,
        },
      );
    },
  );
  return { token, credits: event.voting_credits, expiresAt };
}

export function castVote(
  ctx: Ctx,
  event: EventRow,
  token: string,
  projectId: string,
  influence: number,
): { projectId: string; influence: number; credits: number } {
  if (event.voting_mode === "off") throw new RuleError("voting.disabled", "Voting is not enabled for this event.");
  const now = ctx.now();
  if (event.voting_open_at === null || event.voting_close_at === null || now < event.voting_open_at || now >= event.voting_close_at) {
    throw new RuleError("voting.notOpen", "Voting is not open for this event.");
  }
  if (!Number.isInteger(influence) || influence < 1 || influence > 10) {
    throw new RuleError("voting.influence", "Influence must be a whole number from 1 to 10.");
  }
  const project = findProjectIn(ctx.db, event.id, projectId);
  if (project === undefined || project.status !== "submitted") {
    throw new RuleError("project.missing", "No submitted project exists in this event.");
  }
  const voterHash = hashToken(token);
  return ctx.db.tx(() => {
    const voter = ctx.db.get<VoterRow>(
      `select token_hash, event_id, account_id, fingerprint, credits, created_at, expires_at
         from voter where event_id = :event and token_hash = :token`,
      { event: event.id, token: voterHash },
    );
    if (voter === undefined || voter.expires_at <= now) throw new RuleError("voting.tokenInvalid", "The voting token is invalid or expired.");
    const previous = ctx.db.get<VoteRow>(
      `select event_id, voter_hash, project_id, credits_spent, weight, created_at
         from vote where event_id = :event and voter_hash = :token and project_id = :project`,
      { event: event.id, token: voterHash, project: projectId },
    );
    const cost = influence * influence;
    const available = voter.credits + (previous?.credits_spent ?? 0);
    if (cost > available) throw new RuleError("voting.credits", "This vote costs more credits than remain in the budget.", { remaining: available });
    const remaining = available - cost;
    ctx.recorded(
      {
        action: "vote.cast",
        eventId: event.id,
        subject: projectId,
        payload: { project: projectId, influence, credits_spent: cost, previous: previous?.weight ?? null },
      },
      () => {
        ctx.write("update voter set credits = :credits where token_hash = :token", { credits: remaining, token: voterHash });
        ctx.write(
          `insert into vote (event_id, voter_hash, project_id, credits_spent, weight, created_at)
           values (:event, :token, :project, :cost, :weight, :created)
           on conflict (event_id, voter_hash, project_id) do update set
             credits_spent = excluded.credits_spent, weight = excluded.weight, created_at = excluded.created_at`,
          { event: event.id, token: voterHash, project: projectId, cost, weight: influence, created: now },
        );
      },
    );
    return { projectId, influence, credits: remaining };
  });
}

export function voteTotals(db: Db, eventId: string): { projectId: string; votes: number; credits: number }[] {
  return db
    .all<{ projectId: string; votes: number; credits: number }>(
      `select v.project_id as projectId,
         sum(v.weight * (100 - coalesce(d.discount_percent, 0)) / 100.0) as votes,
         sum(v.credits_spent) as credits
         from vote v left join vote_discount d on d.event_id = v.event_id and d.voter_hash = v.voter_hash
         where v.event_id = :event group by v.project_id order by votes desc, v.project_id`,
      { event: eventId },
    )
    .map((r) => ({ projectId: r.projectId, votes: r.votes, credits: r.credits }));
}

/**
 * Per-voter deterministic project shuffling.
 *
 * Seeded from hash(voter_token || event_salt): stable within a session,
 * different across voters, reproducible for audit. Eliminates positional ballot bias.
 */
export function shuffleProjectsForVoter<T>(
  projects: readonly T[],
  voterToken: string,
  eventSalt: string,
): T[] {
  const seed = `${voterToken}::${eventSalt}`;
  const rng = makeRng(seed);
  return rng.shuffle(projects);
}
