/** Deliberate awards bound to a frozen publication revision. */
import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { EVENT_REF } from "./events.ts";
import { assertGate, assertVotingClosed, findProjectIn, issuedEventCertificates,
  latestPublication, RuleError } from "../../db/index.ts";
import type { EventRow } from "../../db/index.ts";

const list = defineCommand({
  name: "awards.list",
  summary: "List explicit award decisions for the current results revision.",
  method: "GET",
  path: "/api/events/:event/awards",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    revision: { type: ["integer", "null"] }, decisions: { type: "array", items: { type: "object" } },
  }, required: ["revision", "decisions"] } },
  handler: ({ ctx, event, roles }) => {
    const row = event as EventRow;
    const organizer = roles.includes("organizer");
    if (!organizer) { assertVotingClosed(row, ctx.now()); assertGate(row, ctx.now(), "results"); }
    const publication = latestPublication(ctx.db, row.id);
    if (!publication) return { revision: null, decisions: [] };
    const decisions = ctx.db.all<{ id: string; award_key: string; project_id: string;
      title: string; track_key: string | null; decision_type: string; place: number | null;
      public_summary: string; internal_reason: string; decided_at: number }>(
      `select a.id, a.award_key, a.project_id, p.title, p.track_key, a.decision_type,
        a.place, a.public_summary, a.internal_reason, a.decided_at
       from award_decision a join project p on p.event_id = a.event_id and p.id = a.project_id
       where a.event_id = :e and a.publication_revision = :r
       order by a.place is null, a.place, a.award_key, a.decided_at, a.id`,
      { e: row.id, r: publication.revision });
    return { revision: publication.revision, decisions: decisions.map((decision) => ({
      id: decision.id, awardKey: decision.award_key, project: decision.project_id,
      projectTitle: decision.title, track: decision.track_key,
      type: decision.decision_type, place: decision.place,
      publicSummary: decision.public_summary, decidedAt: decision.decided_at,
      ...(organizer ? { internalReason: decision.internal_reason } : {}),
    })) };
  },
});

const decide = defineCommand({
  name: "awards.decide",
  summary: "Record an organizer award decision against the published revision.",
  method: "POST",
  path: "/api/events/:event/awards",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF,
    project: { kind: "id", label: "Submitted project" },
    awardKey: { kind: "text", min: 3, max: 80, label: "Award name/key" },
    type: { kind: "enum", values: ["placement", "special"], label: "Award type" },
    place: { kind: "int", min: 1, max: 100, optional: true, label: "Place" },
    publicSummary: { kind: "text", min: 8, max: 500, label: "Public explanation" },
    internalReason: { kind: "text", min: 8, max: 1000, label: "Private decision record" },
  },
  returns: { kind: "json", schema: { type: "object", properties: {
    id: { type: "string" }, revision: { type: "integer" }, project: { type: "string" },
    awardKey: { type: "string" },
  }, required: ["id", "revision", "project", "awardKey"] } },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["award.decided"],
  form: { title: "Record an award", submit: "Record award",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/results` },
  notes: "Repeated award keys in one revision explicitly represent shared awards. A corrected publication requires new decisions.",
  handler: ({ ctx, event, input, accountId }) => {
    const row = event as EventRow;
    if (row.results_public === 0) throw new RuleError("results.notPublic", "Publish results before deciding awards.");
    const publication = latestPublication(ctx.db, row.id);
    if (!publication) throw new RuleError("results.noSnapshot", "Publish a frozen results revision first.");
    if (issuedEventCertificates(ctx.db, row.id)) throw new RuleError("certificate.alreadyIssued", "Certificates were issued. Create a corrected publication and certificate correction record.");
    const project = findProjectIn(ctx.db, row.id, String(input.project));
    if (!project || project.status !== "submitted") throw new RuleError("project.notSubmitted", "Choose a submitted project in this event.");
    const type = String(input.type);
    const place = typeof input.place === "number" ? input.place : null;
    if ((type === "placement") !== (place !== null)) throw new RuleError("award.place", "Placement awards need a place; special awards must omit it.");
    const id = ctx.newId();
    const awardKey = String(input.awardKey).trim();
    if (ctx.db.get(`select 1 from award_decision where event_id = :e and publication_revision = :r
      and award_key = :key and project_id = :p`, { e: row.id, r: publication.revision,
      key: awardKey, p: project.id })) {
      throw new RuleError("award.alreadyDecided", "That project already holds this award in the current revision.");
    }
    const result = { id, revision: publication.revision, project: project.id, awardKey };
    return ctx.recorded({ action: "award.decided", eventId: row.id, subject: project.id,
      payload: { id, revision: publication.revision, awardKey, type, place,
        publicSummary: String(input.publicSummary), internalReason: String(input.internalReason) } }, () => {
      ctx.write(`insert into award_decision (id, event_id, publication_revision, award_key,
        project_id, decision_type, place, public_summary, internal_reason, actor_id, decided_at)
        values (:id, :e, :r, :key, :p, :type, :place, :summary, :reason, :actor, :at)`, {
        id, e: row.id, r: publication.revision, key: awardKey, p: project.id, type, place,
        summary: String(input.publicSummary), reason: String(input.internalReason),
        actor: accountId, at: ctx.now(),
      });
      return result;
    });
  },
});

export const AWARD_COMMANDS: readonly Command[] = [list, decide];
