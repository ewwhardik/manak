/** Demo-only composition root. Seed once, never reconcile an existing deployment. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, migrate, makeContext, systemClock, findEvent, saveCertificateTemplate, hashToken, findAccountByEmail, MS } from "../src/db/index.ts";
import { seed } from "./seed-demo.ts";
import { seedFixtures, FIXTURE_AUTH } from "./seed-fixtures.ts";

process.env.MANAK_DEMO ??= "true";
if (process.env.MANAK_DEMO === "true") {
  process.env.MANAK_FOUNDERS ??= "rosa@example.com,organizer@example.org";
  process.env.MANAK_DATABASE ??= "./data/demo.db";
}
const path = process.env.MANAK_DATABASE || "./data/manak.db";
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
if (process.env.MANAK_DEMO === "true") {
  if (path === ":memory:") throw new Error("The seeded demo requires a persistent database path.");
  const db = openDatabase(path);
  try {
    migrate(db);
    // Seed fixtures if evt_01 does not exist
    if (!findEvent(db, "evt_01")) {
      db.tx(() => seedFixtures(makeContext(db), systemClock.now()));
      process.stdout.write("[demo] Seeded official Dogfood fixtures (evt_01 / Sample Hack 2026).\n");
      process.stdout.write("[demo] Acceptance credentials:\n");
      process.stdout.write(`       organizer   = "Cookie: manak_session=${FIXTURE_AUTH.organizer}"\n`);
      process.stdout.write(`       judge_a     = "Cookie: manak_session=${FIXTURE_AUTH.judge_a}"\n`);
      process.stdout.write(`       judge_b     = "Cookie: manak_session=${FIXTURE_AUTH.judge_b}"\n`);
      process.stdout.write(`       participant = "Cookie: manak_session=${FIXTURE_AUTH.participant}"\n`);
    } else {
      // Reconcile acceptance sessions on existing demo deployments
      const organizer = findAccountByEmail(db, "organizer@example.org");
      if (organizer) {
        db.run(
          `insert into session (token_hash, account_id, created_at, expires_at, last_seen_at, user_agent)
           values (:hash, :account, :at, :expires, :at, 'DogFood Acceptance')
           on conflict (token_hash) do update set expires_at = :expires, revoked_at = null`,
          { hash: hashToken(FIXTURE_AUTH.organizer), account: organizer.id, at: systemClock.now(), expires: systemClock.now() + 30 * MS.day },
        );
      }
      const judgeA = findAccountByEmail(db, "tomas.varga@example.org");
      if (judgeA) {
        db.run(
          `insert into session (token_hash, account_id, created_at, expires_at, last_seen_at, user_agent)
           values (:hash, :account, :at, :expires, :at, 'DogFood Acceptance')
           on conflict (token_hash) do update set expires_at = :expires, revoked_at = null`,
          { hash: hashToken(FIXTURE_AUTH.judge_a), account: judgeA.id, at: systemClock.now(), expires: systemClock.now() + 30 * MS.day },
        );
      }
      const judgeB = findAccountByEmail(db, "wei.lindqvist@example.org");
      if (judgeB) {
        db.run(
          `insert into session (token_hash, account_id, created_at, expires_at, last_seen_at, user_agent)
           values (:hash, :account, :at, :expires, :at, 'DogFood Acceptance')
           on conflict (token_hash) do update set expires_at = :expires, revoked_at = null`,
          { hash: hashToken(FIXTURE_AUTH.judge_b), account: judgeB.id, at: systemClock.now(), expires: systemClock.now() + 30 * MS.day },
        );
      }
      const participant = findAccountByEmail(db, "priya1@example.org");
      if (participant) {
        db.run(
          `insert into session (token_hash, account_id, created_at, expires_at, last_seen_at, user_agent)
           values (:hash, :account, :at, :expires, :at, 'DogFood Acceptance')
           on conflict (token_hash) do update set expires_at = :expires, revoked_at = null`,
          { hash: hashToken(FIXTURE_AUTH.participant), account: participant.id, at: systemClock.now(), expires: systemClock.now() + 30 * MS.day },
        );
      }
    }
    // Seed original demo if not present
    const existing = db.get<{ total: number }>("select count(*) as total from event where slug = 'dogfood'");
    if (existing?.total === 0) {
      db.tx(() => seed(makeContext(db), systemClock.now()));
      process.stdout.write("[demo] Seeded Dogfood Invitational. Organizer: rosa@example.com.\n");
    }
    // Seed Certificate Studio demo template if not present
    const targetEvent = db.get<{ id: string; slug: string }>("select id, slug from event where slug in ('dogfood', 'sample-hack-2026') order by id desc limit 1");
    if (targetEvent) {
      const existingTemplate = db.get("select 1 from certificate_template where event_id = :event", { event: targetEvent.id });
      if (!existingTemplate) {
        saveCertificateTemplate(db, targetEvent.id, {
          heading: "Certificate of Achievement",
          body: "In recognition of outstanding dedication, creativity, and engineering craft.",
          footer: "Issued by the Organizing Committee",
          signatory: "Organizing Committee & Jury",
        }, systemClock.now());
        process.stdout.write(`[demo] Seeded Certificate Studio demo template for /events/${targetEvent.slug}/certificates/studio\n`);
      }
    }
    // Seed publication, awards, and certificates for dogfood and sample-hack-2026 if not present
    const { seedDogfoodFull, seedSampleHackFull } = await import("./seed-dogfood-full.ts");
    const dogfoodEvent = db.get<{ id: string }>("select id from event where slug = 'dogfood'");
    if (dogfoodEvent) {
      const existingCert = db.get("select 1 from certificate_batch where event_id = :event", { event: dogfoodEvent.id });
      if (!existingCert) {
        seedDogfoodFull(path);
      }
    }
    const sampleEvent = db.get<{ id: string; voting_close_at: number | null }>(
      "select id, voting_close_at from event where slug = 'sample-hack-2026'",
    );
    if (sampleEvent) {
      const existingCert = db.get("select 1 from certificate_batch where event_id = :event", { event: sampleEvent.id });
      const pub = db.get<{ report: string }>(
        "select report from result_publication where event_id = :e order by revision desc limit 1",
        { e: sampleEvent.id },
      );
      const hasExplanation = pub && pub.report.includes("reviews");
      const votingClosed = sampleEvent.voting_close_at != null && sampleEvent.voting_close_at < systemClock.now();
      if (!existingCert || !hasExplanation || !votingClosed) {
        seedSampleHackFull(path);
      }
    }
  } finally { db.close(); }
}
await import("../bin/manak.ts");
