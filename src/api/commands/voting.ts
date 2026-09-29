import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { InputError } from "../schema.ts";
import type { Field } from "../schema.ts";
import { EVENT_REF } from "./events.ts";
import { PROJECT_REF } from "./projects.ts";
import {
  assertVotingClosed,
  assertGate,
  castVote,
  fingerprint,
  hashToken,
  startVoter,
  voteTotals,
  voterStatus,
  shuffleProjectsForVoter,
  listProjects,
  isQuarantined,
  abusePolicy,
  setAbusePolicy,
  abuseSignalKey,
  abuseReview,
  setAbuseReview,
} from "../../db/index.ts";
import type { EventRow, VoteRow } from "../../db/index.ts";
import { detectVoteAbuse } from "../../judging/index.ts";

const TOKEN: Field = {
  kind: "text",
  min: 43,
  max: 43,
  pattern: /^[A-Za-z0-9_-]{43}$/,
  label: "Voter token",
  help: "The token returned when voting started.",
  secret: true,
};

const INFLUENCE: Field = {
  kind: "int",
  min: 1,
  max: 10,
  fallback: 1,
  label: "Influence",
  help: "A vote of n influence costs n squared credits.",
};

export const start = defineCommand({
  name: "votes.start",
  summary: "Start a voting session for this event.",
  method: "POST",
  path: "/api/events/:event/votes/start",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The voter credential. Keep it private." },
        credits: { type: "integer" },
        expiresAt: { type: "integer" },
      },
      required: ["token", "credits", "expiresAt"],
    },
  },
  limit: "vote",
  records: ["voter.created"],
  form: { title: "Start voting", submit: "Start voting", redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/voting` },
  handler: ({ ctx, event, accountId, address, userAgent }) => {
    const voter = startVoter(ctx, event as EventRow, {
      fingerprint: fingerprint(address, userAgent),
      accountId,
    });
    return voter;
  },
});

export const cast = defineCommand({
  name: "votes.cast",
  summary: "Spend voting credits on a submitted project.",
  method: "POST",
  path: "/api/events/:event/votes",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF, token: { ...TOKEN, optional: true }, project: PROJECT_REF, influence: INFLUENCE },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: { project: { type: "string" }, influence: { type: "integer" }, credits: { type: "integer" } },
      required: ["project", "influence", "credits"],
    },
  },
  limit: "vote",
  records: ["vote.cast"],
  form: { title: "Vote for a project", submit: "Cast vote", redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/voting` },
  handler: ({ ctx, event, input, voterToken }) => {
    const result = castVote(ctx, event as EventRow, String(input.token ?? voterToken ?? ""), String(input.project), Number(input.influence));
    return { project: result.projectId, influence: result.influence, credits: result.credits };
  },
});

export const results = defineCommand({
  name: "votes.results",
  summary: "List the current public voting totals.",
  method: "GET",
  path: "/api/events/:event/votes",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        projects: {
          type: "array",
          items: {
            type: "object",
            properties: { project: { type: "string" }, votes: { type: "number" }, credits: { type: "integer" } },
            required: ["project", "votes", "credits"],
          },
        },
      },
      required: ["projects"],
    },
  },
  handler: ({ ctx, event, roles }) => {
    const row = event as EventRow;
    if (!roles.includes("organizer")) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const totals = voteTotals(ctx.db, row.id);
    return { projects: totals.map((total) => ({ project: total.projectId, votes: total.votes, credits: total.credits })) };
  },
});

export const ballot = defineCommand({
  name: "votes.ballot", summary: "View your voting budget and shuffled project ballot.",
  method: "GET", path: "/api/events/:event/voting",
  capability: { audience: "public", scope: "event" }, input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    mode: { type: "string" }, open: { type: "boolean" }, requiresSignIn: { type: "boolean" },
    budget: { type: "integer" }, credits: { type: ["integer", "null"] },
    projects: { type: "array", items: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, influence: { type: "integer" },
    } } },
  }, required: ["mode","open","requiresSignIn","budget","credits","projects"] } },
  notes: "Uses the event-scoped HttpOnly cookie set by votes.start. API clients retain the Set-Cookie header. Projects are shuffled for that credential; only your own allocations are shown. No aggregate standings appear here.",
  handler: ({ ctx, event, accountId, voterToken }) => {
    const row = event as EventRow;
    const now = ctx.now();
    const voter = voterStatus(ctx.db, row.id, voterToken ?? null, now);
    const projects = voter === null ? [] : shuffleProjectsForVoter(listProjects(ctx.db, row.id).filter((p) => p.status === "submitted" && !isQuarantined(p)), voterToken!, row.id);
    return {
      mode: row.voting_mode,
      open: row.voting_mode !== "off" && row.voting_open_at !== null && row.voting_close_at !== null && now >= row.voting_open_at && now < row.voting_close_at,
      requiresSignIn: row.voting_mode === "account" && accountId === null,
      budget: row.voting_credits, credits: voter?.credits ?? null,
      projects: projects.map((p) => ({ id:p.id, title:p.title, summary:p.summary, influence:voter?.allocations.find((a) => a.project === p.id)?.influence ?? 0 })),
    };
  },
});

export const abuse = defineCommand({
  name: "votes.abuse",
  summary: "Detect and analyze suspicious voting rings and Sybil attacks.",
  method: "GET",
  path: "/api/events/:event/voting/abuse",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        totalVotes: { type: "integer" },
        uniqueVoters: { type: "integer" },
        uniqueProjects: { type: "integer" },
        highRiskCount: { type: "integer" },
        policy: { type: "object" },
        clusters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              clusterId: { type: "integer" },
              riskScore: { type: "number" },
              voterTokens: { type: "array", items: { type: "string" } },
              targetProjects: { type: "array", items: { type: "string" } },
              sharedIpHash: { type: ["string", "null"] },
              timeSpanSeconds: { type: "number" },
              primaryReason: { type: "string" },
              details: { type: "array", items: { type: "string" } },
              recommendedDiscount: { type: "number" },
              review: { type: ["object", "null"] },
            },
            required: [
              "clusterId",
              "riskScore",
              "voterTokens",
              "targetProjects",
              "timeSpanSeconds",
              "primaryReason",
              "details",
              "recommendedDiscount",
            ],
          },
        },
      },
      required: ["eventId", "totalVotes", "uniqueVoters", "uniqueProjects", "highRiskCount", "clusters"],
    },
  },
  notes: "Organizer-only. Surfaces collusive voting rings, burst timings, and recommendation factors.",
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const rows = ctx.db.all<{
      voter_hash: string;
      project_id: string;
      credits_spent: number;
      weight: number;
      created_at: number;
      fingerprint: string;
    }>(
      `select v.voter_hash, v.project_id, v.credits_spent, v.weight, v.created_at, vt.fingerprint
         from vote v
         join voter vt on vt.token_hash = v.voter_hash and vt.event_id = v.event_id
        where v.event_id = :event
        order by v.created_at`,
      { event: row.id },
    );
    const rawVotes = rows.map((r) => ({
      voterToken: r.voter_hash,
      projectId: r.project_id,
      creditsSpent: r.credits_spent,
      ipHash: r.fingerprint,
      createdAt: r.created_at,
    }));
    const report = detectVoteAbuse(rawVotes, abusePolicy(ctx.db, row.id));
    return {
      eventId: row.id,
      totalVotes: report.totalVotes,
      uniqueVoters: report.uniqueVoters,
      uniqueProjects: report.uniqueProjects,
      highRiskCount: report.highRiskCount,
      policy: abusePolicy(ctx.db, row.id),
      clusters: report.clusters.map((cluster) => ({ ...cluster,
        review: abuseReview(ctx.db, row.id, abuseSignalKey(cluster.voterTokens)) })),
    };
  },
});

export const configureAbuse = defineCommand({
  name: "votes.configure_abuse",
  summary: "Set this event's voting anomaly thresholds.",
  method: "POST",
  path: "/api/events/:event/voting/abuse/policy",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    patternPercent: { kind: "int", min: 50, max: 100, label: "Pattern similarity percent" },
    sharedOriginPercent: { kind: "int", min: 50, max: 100, label: "Shared-origin similarity percent" },
    highRisk: { kind: "int", min: 0, max: 100, label: "High-risk score threshold" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    patternCosine: { type: "number" }, sharedOriginCosine: { type: "number" }, highRisk: { type: "integer" },
  }, required: ["patternCosine", "sharedOriginCosine", "highRisk"] } },
  limit: "organize", limitKey: ({ input }) => String(input.event ?? ""),
  records: ["abuse.policy_updated"],
  form: { title: "Set voting signal thresholds", submit: "Save thresholds",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/dashboard?lab=true#evidence-lab` },
  handler: ({ ctx, event, input }) => setAbusePolicy(ctx, (event as EventRow).id, {
    patternCosine: Number(input.patternPercent) / 100,
    sharedOriginCosine: Number(input.sharedOriginPercent) / 100,
    highRisk: Number(input.highRisk),
  }),
});

export const reviewAbuse = defineCommand({
  name: "votes.review_abuse",
  summary: "Record an investigator's assessment of one voting signal.",
  method: "POST",
  path: "/api/events/:event/voting/abuse/review",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    clusterTokens: { kind: "text", min: 64, max: 4096, label: "Voter token hashes" },
    state: { kind: "enum", values: ["investigating", "benign", "confirmed"], label: "Review state" },
    reason: { kind: "text", min: 8, max: 1000, label: "Evidence and reason" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    signalKey: { type: "string" }, state: { type: "string" }, reason: { type: "string" },
    updatedAt: { type: "integer" },
  }, required: ["signalKey", "state", "reason", "updatedAt"] } },
  limit: "organize", limitKey: ({ input }) => String(input.event ?? ""),
  records: ["abuse.reviewed"],
  form: { title: "Review voting signal", submit: "Record review",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/dashboard?lab=true#evidence-lab` },
  handler: ({ ctx, event, input }) => setAbuseReview(ctx, (event as EventRow).id,
    String(input.clusterTokens).split(",").map((token) => token.trim()).filter(Boolean),
    String(input.state) as "investigating" | "benign" | "confirmed", String(input.reason)),
});

export const discountCluster = defineCommand({
  name: "votes.discount_cluster",
  summary: "Apply an audited discount after confirming a voting signal through human review.",
  method: "POST",
  path: "/api/events/:event/voting/discount",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    clusterTokens: {
      kind: "text",
      min: 1,
      max: 4096,
      label: "Voter Token Hashes",
      help: "Comma-separated list of voter hashes to discount.",
    },
    discountPercent: {
      kind: "int",
      min: 0,
      max: 100,
      fallback: 100,
      optional: true,
      label: "Discount Percentage",
      help: "Percentage to reduce ballot weights by (default 100% = nullify).",
    },
    reason: {
      kind: "text",
      min: 5,
      max: 256,
      label: "Audit Reason",
      help: "Reason for applying discount (logged permanently to audit trail).",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        discountedVoters: { type: "integer" },
        affectedVotes: { type: "integer" },
        discountPercent: { type: "integer" },
        reason: { type: "string" },
      },
      required: ["ok", "discountedVoters", "affectedVotes", "discountPercent", "reason"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["vote.cluster_discounted"],
  form: {
    title: "Discount Sybil voter cluster",
    submit: "Apply audited discount",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results`,
  },
  notes: "Requires a confirmed review. Raw ballots are preserved; an audited factor is applied in aggregation.",
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const tokens = String(input.clusterTokens)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      throw new InputError([{ field: "clusterTokens", message: "At least one voter token must be provided." }]);
    }
    const signalKey = abuseSignalKey(tokens);
    if (abuseReview(ctx.db, row.id, signalKey)?.state !== "confirmed") {
      throw new InputError([{ field: "clusterTokens", message: "Confirm this exact voter cluster through human review first." }]);
    }
    const percent = Number(input.discountPercent ?? 100);
    let affectedVotes = 0;

    ctx.recorded(
      {
        action: "vote.cluster_discounted",
        eventId: row.id,
        payload: {
          tokens,
          discountPercent: percent,
          reason: String(input.reason),
        },
      },
      () => {
        for (const token of tokens) {
          const voterVotes = ctx.db.all<VoteRow>(
            `select event_id, voter_hash, project_id, credits_spent, weight, created_at
               from vote where event_id = :event and voter_hash = :token`,
            { event: row.id, token },
          );
          if (voterVotes.length === 0) continue;
          ctx.write(`insert into vote_discount (event_id, voter_hash, discount_percent, reason, actor_id, updated_at)
            values (:event, :token, :percent, :reason, :actor, :at)
            on conflict(event_id, voter_hash) do update set discount_percent = excluded.discount_percent,
            reason = excluded.reason, actor_id = excluded.actor_id, updated_at = excluded.updated_at`, {
            event: row.id, token, percent, reason: String(input.reason), actor: ctx.actorId, at: ctx.now(),
          });
          affectedVotes += voterVotes.length;
        }
      },
    );

    return {
      ok: true,
      discountedVoters: tokens.length,
      affectedVotes,
      discountPercent: percent,
      reason: String(input.reason),
    };
  },
});

export const voidVoter = defineCommand({
  name: "votes.void_voter",
  summary: "Void all votes cast by a suspicious voter identity.",
  method: "POST",
  path: "/api/events/:event/voting/void",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    voterToken: {
      kind: "text",
      min: 1,
      max: 4096,
      label: "Voter Token Hash",
      help: "The token hash of the voter to void.",
    },
    reason: {
      kind: "text",
      min: 3,
      max: 256,
      label: "Audit Reason",
      help: "Reason for voiding voter ballots.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        voterToken: { type: "string" },
        voided: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["ok", "voterToken", "voided", "reason"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["vote.voter_voided"],
  form: {
    title: "Void voter ballots",
    submit: "Void voter",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results`,
  },
  notes: "Nullifies voter weight to zero and logs permanent audit record.",
  handler: ({ ctx, event, input }) => {
    const row = event as EventRow;
    const token = String(input.voterToken).trim();
    const reason = String(input.reason).trim();
    const tokenHash = /^[0-9a-f]{64}$/.test(token) ? token : hashToken(token);
    ctx.recorded(
      {
        action: "vote.voter_voided",
        eventId: row.id,
        subject: token.slice(0, 16),
        payload: { voterToken: token, reason },
      },
      () => {
        ctx.write(
          `insert into voter (token_hash, event_id, account_id, fingerprint, credits, created_at, expires_at)
           values (:token, :event, null, :fingerprint, 0, :at, :expires)
           on conflict(token_hash) do nothing`,
          { token: tokenHash, event: row.id, fingerprint: `probe-${tokenHash.slice(0, 16)}`, at: ctx.now(), expires: ctx.now() + 86400000 },
        );
        ctx.write(
          `insert into vote_discount (event_id, voter_hash, discount_percent, reason, actor_id, updated_at)
           values (:event, :token, 100, :reason, :actor, :at)
           on conflict(event_id, voter_hash) do update set discount_percent = 100,
           reason = excluded.reason, actor_id = excluded.actor_id, updated_at = excluded.updated_at`,
          { event: row.id, token: tokenHash, reason, actor: ctx.actorId, at: ctx.now() },
        );
      },
    );
    return { ok: true, voterToken: token, voided: true, reason };
  },
});

export const VOTING_COMMANDS: readonly Command[] = [
  start,
  cast,
  results,
  ballot,
  abuse,
  configureAbuse,
  reviewAbuse,
  discountCluster,
  voidVoter,
];
