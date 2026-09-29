import { openDatabase, makeContext, systemClock, findEventBySlug, persistEventCertificates, certificateKeyDirectory, latestPublication } from "../src/db/index.ts";
import { publish } from "../src/api/commands/results.ts";

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

    // Use the production publication path, including frozen participant explanations.
    (publish.handler as (call: unknown) => unknown)({
      ctx,
      event,
      input: { event: "dogfood", reason: "Initial official publication",
        publicSummary: "Official Standings & Ceremony Results" },
      roles: ["organizer"],
    });

    // 2. Store publication rev 1
    const pub = latestPublication(db, event.id)!;
    const live = JSON.parse(pub.report) as Record<string, unknown>;
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
    const certReport = persistEventCertificates(db, "dogfood", Date.now(), certificateKeyDirectory(), "http://localhost:8080");
    process.stdout.write(`[dogfood] Issued certificates: ${certReport.totalIssued} (Winners: ${certReport.winners}, Participants: ${certReport.participants}, Judges: ${certReport.judges})\n`);
  } finally {
    db.close();
  }
}

export function seedSampleHackFull(dbPath = "./data/demo.db"): void {
  const db = openDatabase(dbPath);
  try {
    const ctx = makeContext(db, { clock: systemClock });
    const event = findEventBySlug(db, "sample-hack-2026");
    if (!event) return;

    // This is a completed fixture showcase, so its published explanation and
    // certificates must remain available. Preserve the imported submission
    // deadline and close voting before publishing; never reopen a published
    // event just to demonstrate an active voting window.
    const now = systemClock.now();
    db.run(
      `update event set results_public = 1, voting_mode = 'open',
       voting_open_at = :o, voting_close_at = :c, voting_credits = 100 where id = :e`,
      { e: event.id, o: now - 48 * 3600000, c: now - 3600000 },
    );

    // 2. Seed quarantined duplicate project if not present
    const existingDup = db.get("select 1 from project where id = 'prj_dup_01'");
    if (!existingDup) {
      const p1 = db.get<{ id: string; team_id: string }>(
        "select id, team_id from project where event_id = :e order by id limit 1",
        { e: event.id },
      );
      if (p1) {
        db.run(
          `insert into project (id, event_id, team_id, title, summary, tagline, description, tech_tags, status, submitted_at, created_at, duplicate_of, duplicate_reason, duplicate_decision)
           values ('prj_dup_01', :e, :t, 'Voice Assistant Duplicate', 'Quarantined duplicate entry for triage', '', '', '', 'submitted', :at, :at, :prior, 'title', 'pending')`,
          {
            e: event.id,
            t: p1.team_id,
            at: systemClock.now() - 7200000,
            prior: p1.id,
          },
        );
        process.stdout.write("[sample-hack-2026] Seeded quarantined duplicate project prj_dup_01\n");
      }
    }

    // 3. Seed team invite if not present
    const teamRow = db.get<{ id: string }>("select id from team where event_id = :e limit 1", { e: event.id });
    if (teamRow) {
      db.run(
        `insert into team_invite (event_id, team_id, code, generation, updated_at)
         values (:e, :t, 'manak_demo_invite_token_sample_team_0001234', 1, :at)
         on conflict (event_id, team_id) do nothing`,
        { e: event.id, t: teamRow.id, at: systemClock.now() },
      );
    }

    // 4. Clear and publish official revision 1
    db.run("delete from certificate_batch where event_id = :e", { e: event.id });
    db.run("delete from award_decision where event_id = :e", { e: event.id });
    db.run("delete from result_publication where event_id = :e", { e: event.id });

    (publish.handler as (call: unknown) => unknown)({
      ctx,
      event: findEventBySlug(db, event.slug)!,
      input: { event: event.slug, reason: "Official Fixture Results",
        publicSummary: "Final Verified Standings" },
      roles: ["organizer"],
    });

    const pub = latestPublication(db, event.id)!;
    const live = JSON.parse(pub.report) as Record<string, unknown>;
    process.stdout.write(`[sample-hack-2026] Stored publication revision ${pub.revision}\n`);

    // 5. Seed Grand Prize award if not present
    const projects = live.projects as Array<{ project: string; title: string }>;
    const existingAward = db.get("select 1 from award_decision where event_id = :e and award_key = :k", {
      e: event.id,
      k: "1st Place: Grand Prize",
    });
    if (!existingAward && projects.length > 0) {
      const p1 = projects[0]!;
      const organizer = db.get<{ id: string }>("select id from account where email = 'organizer@example.org'");
      if (organizer) {
        const id = ctx.newId();
        db.run(
          `insert into award_decision (id, event_id, publication_revision, award_key,
           project_id, decision_type, place, public_summary, internal_reason, actor_id, decided_at)
           values (:id, :e, :r, :key, :p, 'placement', 1, 'Top scoring project with highest overall calibrated index.', 'Winner of Sample Hack 2026.', :actor, :at)`,
          {
            id,
            e: event.id,
            r: pub.revision,
            key: "1st Place: Grand Prize",
            p: p1.project,
            actor: organizer.id,
            at: Date.now(),
          },
        );
        process.stdout.write("[sample-hack-2026] Recorded award: 1st Place: Grand Prize\n");
      }
    }

    // 6. Issue certificates after voting has closed and results are public
    const existingCerts = db.get("select 1 from certificate_batch where event_id = :e", { e: event.id });
    if (!existingCerts) {
      const certReport = persistEventCertificates(db, "sample-hack-2026", Date.now(), certificateKeyDirectory(), "http://localhost:8080");
      process.stdout.write(`[sample-hack-2026] Issued certificates: ${certReport.totalIssued}\n`);
    }

  } finally {
    db.close();
  }
}

if (import.meta.main) {
  seedDogfoodFull();
  seedSampleHackFull();
}
