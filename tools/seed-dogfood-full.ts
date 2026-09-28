import { openDatabase, makeContext, systemClock, findEventBySlug, storePublication, persistEventCertificates } from "../src/db/index.ts";
import { liveShow } from "../src/api/commands/results.ts";

export function seedDogfoodFull(dbPath = "./data/demo.db"): void {
  const db = openDatabase(dbPath);
  try {
    const ctx = makeContext(db, { clock: systemClock });
    const event = findEventBySlug(db, "dogfood");
    if (!event) throw new Error("Dogfood event not found.");

    // Clear old publication / certificates for dogfood if any
    db.run("delete from certificate_batch where event_id = :e", { e: event.id });
    db.run("delete from award_decision where event_id = :e", { e: event.id });
    db.run("delete from result_publication where event_id = :e", { e: event.id });

    // 1. Generate live report
    const live = (liveShow.handler as (call: unknown) => unknown)({
      ctx,
      event,
      input: { event: "dogfood" },
      roles: ["organizer"],
    }) as Record<string, unknown>;

    // 2. Store publication rev 1
    const pub = storePublication(ctx, event.id, live, "Initial official publication", "Official Standings & Ceremony Results");
    process.stdout.write(`[dogfood] Stored publication revision ${pub.revision}\n`);

    // 3. Record awards for revision 1
    const projects = live.projects as Array<{ project: string; title: string }>;
    const readback = projects.find(p => p.title === "Readback")!;
    const lintwright = projects.find(p => p.title === "Lintwright")!;
    const highcontrast = projects.find(p => p.title === "Highcontrast")!;
    const portmatic = projects.find(p => p.title === "Portmatic")!;

    const awards = [
      { p: readback.project, key: "1st Place: Grand Prize", type: "placement", place: 1, summary: "Top scoring project with highest overall calibrated index.", reason: "Unanimous top ranking across all evaluation criteria." },
      { p: lintwright.project, key: "2nd Place: Runner Up", type: "placement", place: 2, summary: "Exceptional developer tooling and static analysis implementation.", reason: "Runner up with strong technical marks." },
      { p: highcontrast.project, key: "3rd Place: Bronze Award", type: "placement", place: 3, summary: "Outstanding accessibility adherence and high-contrast styling.", reason: "Top rated in accessibility dimension." },
      { p: portmatic.project, key: "Best Developer Tool", type: "special", place: null, summary: "Innovative multi-platform porting and developer experience.", reason: "Special jury commendation." }
    ];

    const organizer = db.get<{ id: string }>("select id from account where email = 'rosa@example.com'")!;

    for (const a of awards) {
      const id = ctx.newId();
      db.run(`insert into award_decision (id, event_id, publication_revision, award_key,
        project_id, decision_type, place, public_summary, internal_reason, actor_id, decided_at)
        values (:id, :e, :r, :key, :p, :type, :place, :summary, :reason, :actor, :at)`,
        { id, e: event.id, r: pub.revision, key: a.key, p: a.p, type: a.type, place: a.place,
          summary: a.summary, reason: a.reason, actor: organizer.id, at: Date.now() });
      process.stdout.write(`[dogfood] Recorded award: ${a.key}\n`);
    }

    // 4. Persist certificates
    const certReport = persistEventCertificates(db, "dogfood", Date.now(), "./data", "http://localhost:8080");
    process.stdout.write(`[dogfood] Issued certificates: ${certReport.totalIssued} (Winners: ${certReport.winners}, Participants: ${certReport.participants}, Judges: ${certReport.judges})\n`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  seedDogfoodFull();
}
