/** Appeals keep participant messages private and correct results through a new revision. */
import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { EVENT_REF } from "./events.ts";
import { publish } from "./results.ts";
import { assertGate, assertVotingClosed, findProjectIn, issuedEventCertificates,
  latestPublication, RuleError, teamOf } from "../../db/index.ts";
import type { EventRow } from "../../db/index.ts";

type AppealRow = { id: string; project_id: string; opened_by: string;
  publication_revision: number; private_message: string; public_summary: string;
  state: "open" | "accepted" | "rejected"; opened_at: number;
  deadline_at: number; resolved_at: number | null; internal_reason: string | null;
  resolved_by: string | null; correction_revision: number | null };

const list = defineCommand({
  name: "appeals.list",
  summary: "List public appeal resolutions, or private appeals you may inspect.",
  method: "GET",
  path: "/api/events/:event/appeals",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    appeals: { type: "array", items: { type: "object" } },
  }, required: ["appeals"] } },
  handler: ({ ctx, event, roles, accountId }) => {
    const row = event as EventRow;
    const organizer = roles.includes("organizer");
    if (!organizer) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const appeals = ctx.db.all<AppealRow>(`select id, project_id, opened_by,
      publication_revision, private_message, public_summary, state, opened_at,
      deadline_at, resolved_at, internal_reason, resolved_by, correction_revision
      from appeal where event_id = :e order by opened_at desc, id`, { e: row.id });
    return { appeals: appeals.filter((appeal) => organizer || appeal.state !== "open" ||
      appeal.opened_by === accountId).map((appeal) => ({
      id: appeal.id, project: appeal.project_id, state: appeal.state,
      publicationRevision: appeal.publication_revision,
      publicSummary: appeal.public_summary, openedAt: appeal.opened_at,
      deadlineAt: appeal.deadline_at, resolvedAt: appeal.resolved_at,
      correctionRevision: appeal.correction_revision,
      ...(organizer || appeal.opened_by === accountId ? {
        privateMessage: appeal.private_message, openedBy: appeal.opened_by } : {}),
      ...(organizer ? { internalReason: appeal.internal_reason,
        resolvedBy: appeal.resolved_by } : {}),
    })) };
  },
});

const open = defineCommand({
  name: "appeals.open",
  summary: "Open a private appeal for your submitted team project.",
  method: "POST",
  path: "/api/events/:event/appeals",
  capability: { audience: "participant", scope: "event" },
  input: { event: EVENT_REF, project: { kind: "id", label: "Project ID" },
    privateMessage: { kind: "text", min: 8, max: 2000, multiline: true,
      label: "Private appeal message", help: "Only organizers and you can read this text." } },
  returns: { kind: "json", schema: { type: "object", properties: {
    id: { type: "string" }, state: { type: "string" }, deadlineAt: { type: "integer" },
  }, required: ["id", "state", "deadlineAt"] } },
  limit: "submission",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["appeal.opened"],
  form: { title: "Appeal a result", submit: "Send private appeal",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results` },
  handler: ({ ctx, event, input, accountId }) => {
    const row = event as EventRow;
    const publication = latestPublication(ctx.db, row.id);
    if (row.results_public === 0 || !publication) {
      throw new RuleError("results.notPublic", "Appeals open after a published result.");
    }
    const deadlineAt = publication.issued_at + 7 * 24 * 60 * 60 * 1000;
    if (ctx.now() > deadlineAt) throw new RuleError("appeal.closed", "The appeal window for this revision has closed.");
    const project = findProjectIn(ctx.db, row.id, String(input.project));
    const team = accountId === null ? undefined : teamOf(ctx.db, row.id, accountId);
    if (!project || project.status !== "submitted" || !team || project.team_id !== team.id) {
      throw new RuleError("appeal.unavailable", "Choose a submitted project from your team.");
    }
    if (ctx.db.get(`select 1 from appeal where event_id = :e and project_id = :p
      and opened_by = :a and publication_revision = :r`,
    { e: row.id, p: project.id, a: accountId, r: publication.revision })) {
      throw new RuleError("appeal.duplicate", "You already opened an appeal for this result revision.");
    }
    const id = ctx.newId();
    const result = { id, state: "open", deadlineAt };
    return ctx.recorded({ action: "appeal.opened", eventId: row.id, subject: project.id,
      payload: { id, publicationRevision: publication.revision, openedBy: accountId,
        privateMessage: String(input.privateMessage), deadlineAt } }, () => {
      ctx.write(`insert into appeal (id, event_id, project_id, opened_by,
        publication_revision, private_message, public_summary, state, opened_at,
        deadline_at, resolved_at, internal_reason, resolved_by, correction_revision)
        values (:id, :e, :p, :a, :r, :message, 'An appeal is under review.', 'open',
          :at, :deadline, null, null, null, null)`, {
        id, e: row.id, p: project.id, a: accountId, r: publication.revision,
        message: String(input.privateMessage), at: ctx.now(), deadline: deadlineAt,
      });
      return result;
    });
  },
});

const resolve = defineCommand({
  name: "appeals.resolve",
  summary: "Resolve an appeal and optionally publish a corrected result revision.",
  method: "POST",
  path: "/api/events/:event/appeals/:appeal/resolve",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, appeal: { kind: "id", label: "Appeal ID" },
    decision: { kind: "enum", values: ["accepted", "rejected"], label: "Decision" },
    republish: { kind: "bool", fallback: false, label: "Publish corrected results" },
    expectedRevision: { kind: "int", min: 1, label: "Current publication revision" },
    publicSummary: { kind: "text", min: 8, max: 300, label: "Public explanation" },
    internalReason: { kind: "text", min: 8, max: 1000, label: "Private resolution reason" } },
  returns: { kind: "json", schema: { type: "object", properties: {
    id: { type: "string" }, state: { type: "string" },
    correctionRevision: { type: ["integer", "null"] },
  }, required: ["id", "state", "correctionRevision"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["appeal.resolved", "result.corrected"],
  handler: (call) => {
    const { ctx, event, input, accountId } = call;
    const row = event as EventRow;
    return ctx.db.tx(() => {
      const appeal = ctx.db.get<AppealRow>(`select id, project_id, opened_by,
        publication_revision, private_message, public_summary, state, opened_at,
        deadline_at, resolved_at, internal_reason, resolved_by, correction_revision
        from appeal where id = :id and event_id = :e`,
      { id: String(input.appeal), e: row.id });
      if (!appeal || appeal.state !== "open") {
        throw new RuleError("appeal.unavailable", "That open appeal was not found.");
      }
      const publication = latestPublication(ctx.db, row.id);
      if (!publication || publication.revision !== input.expectedRevision) {
        throw new RuleError("appeal.stale", "Results changed since this appeal review began. Refresh the current revision.");
      }
      const republish = input.republish === true;
      if (republish && input.decision !== "accepted") {
        throw new RuleError("appeal.decision", "Only an accepted appeal can publish a correction.");
      }
      if (republish && issuedEventCertificates(ctx.db, row.id)) {
        throw new RuleError("appeal.certificateCorrectionRequired",
          "Correct affected issued certificates before changing the published outcome.");
      }
      let correctionRevision: number | null = null;
      if (republish) {
        publish.handler({ ...call, input: { ...call.input,
          reason: `Accepted appeal ${appeal.id}: ${String(input.internalReason)}`,
          publicSummary: String(input.publicSummary) } });
        correctionRevision = latestPublication(ctx.db, row.id)?.revision ?? null;
      }
      const result = { id: appeal.id, state: String(input.decision), correctionRevision };
      return ctx.recorded({ action: "appeal.resolved", eventId: row.id,
        subject: appeal.project_id, payload: { id: appeal.id, decision: input.decision,
          internalReason: input.internalReason, publicSummary: input.publicSummary,
          correctionRevision } }, () => {
        ctx.write(`update appeal set state = :state, public_summary = :summary,
          internal_reason = :reason, resolved_at = :at, resolved_by = :actor,
          correction_revision = :correction where id = :id`, {
          state: String(input.decision), summary: String(input.publicSummary),
          reason: String(input.internalReason), at: ctx.now(), actor: accountId,
          correction: correctionRevision, id: appeal.id,
        });
        return result;
      });
    });
  },
});

export const APPEAL_COMMANDS: readonly Command[] = [list, open, resolve];
