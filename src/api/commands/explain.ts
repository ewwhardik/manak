import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { EVENT_REF } from "./events.ts";
import { assertGate, assertVotingClosed, latestPublication, loadJudgingInput, publishedVersion,
  teamOf, RuleError, allComparisons } from "../../db/index.ts";
import type { EventRow } from "../../db/index.ts";
import { normalizationSandbox } from "../../judging/index.ts";

const explain = defineCommand({
  name: "results.explain", summary: "Explain your team's frozen published ranking with anonymous review contributions.",
  method: "GET", path: "/api/events/:event/results/explain",
  capability: { audience: "participant", scope: "event" }, input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    revision: { type: "integer" }, projects: { type: "array", items: { type: "object" } },
    notice: { type: "string" },
  }, required: ["revision", "projects", "notice"] } },
  handler: ({ ctx, event, accountId }) => {
    const row = event as EventRow;
    assertVotingClosed(row, ctx.now());
    assertGate(row, ctx.now(), "results");
    const publication = latestPublication(ctx.db, row.id);
    if (!publication) throw new RuleError("results.noSnapshot", "An organizer must publish a frozen result revision first.");
    const team = accountId ? teamOf(ctx.db, row.id, accountId) : undefined;
    if (!team) throw new RuleError("project.notMember", "Join the team whose ranking you want to inspect.");
    const own = new Set(ctx.db.all<{ id: string }>("select id from project where event_id = :e and team_id = :t", { e: row.id, t: team.id }).map(p => p.id));
    const frozen = JSON.parse(publication.report) as Record<string, unknown>;
    const explanations = (frozen._explanations ?? []) as Record<string, unknown>[];
    const projects = (frozen.projects as Record<string, unknown>[]).filter(p => own.has(String(p.project))).map(p => {
      const details = explanations.find(x => x.project === p.project);
      return { project: p.project, title: p.title, rawMean: p.rawMean ?? null, adjusted: p.adjusted,
        rankRaw: p.rankRaw ?? null, rank: p.rank, rankMove: p.rankMove ?? null,
        grandMean: details?.grandMean ?? null, reviews: details?.reviews ?? [] };
    });
    return { revision: publication.revision, projects,
      notice: 'This is the frozen published revision. Review labels are local to each project and do not identify judges. Older publications or duel-only rankings may have no rubric review breakdown.' };
  },
});

const sandbox = defineCommand({
  name: "results.sandbox", summary: "Compare normalization methods on current evidence without changing published results.",
  method: "GET", path: "/api/events/:event/results/sandbox",
  capability: { audience: "organizer", scope: "event" }, input: { event: EVENT_REF },
  limit: "analyse", limitKey: ({ input }) => String(input.event ?? ""),
  returns: { kind: "json", schema: { type: "object", properties: {
    methods: { type: "array", items: { type: "object" } }, notice: { type: "string" },
  }, required: ["methods", "notice"] } },
  handler: ({ ctx, event }) => {
    const row = event as EventRow;
    const input = publishedVersion(ctx.db, row.id) === undefined ? null : loadJudgingInput(ctx.db, row.id);
    const excluded = new Set(ctx.db.all<{ account_id: string }>("select account_id from membership where event_id = :e and role = 'judge' and evidence_excluded_at is not null", { e: row.id }).map(j => j.account_id));
    const comparisons = allComparisons(ctx.db, row.id).filter(c => c.winner_id !== null && !excluded.has(c.judge_id))
      .map(c => ({ id: c.id, judge: c.judge_id, left: c.left_id, right: c.right_id, winner: c.winner_id! }));
    const titles = new Map(ctx.db.all<{ id: string; title: string }>("select id, title from project where event_id = :e", { e: row.id }).map(p => [p.id, p.title]));
    return { methods: normalizationSandbox(input?.rubric ?? null, input?.ballots ?? [], comparisons)
      .map(m => ({ ...m, scores: m.scores.map(p => ({ ...p, title: titles.get(p.project) ?? p.project })) })),
      notice: 'Diagnostic preview using current eligible evidence. Methods have different units and may rank different supported subsets. No scores, settings or publications are changed.' };
  },
});

export const EXPLANATION_COMMANDS: readonly Command[] = [explain, sandbox];
