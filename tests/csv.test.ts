import test from "node:test";
import assert from "node:assert/strict";

import {
  CSV_STAGES,
  exportCsv,
  formatCsvCell,
  formatCsvRow,
  makeContext,
  migrate,
  openDatabase,
  createEvent,
  createProject,
  createTeam,
  createTrack,
  grantRole,
  submitProject,
  upsertAccount,
} from "../src/db/index.ts";

test("CSV cell formatting adheres strictly to RFC 4180", () => {
  assert.equal(formatCsvCell("simple"), "simple");
  assert.equal(formatCsvCell(123), "123");
  assert.equal(formatCsvCell("hello, world"), "\"hello, world\"");
  assert.equal(formatCsvCell("with \"quotes\""), "\"with \"\"quotes\"\"\"");
  assert.equal(formatCsvCell("line 1\nline 2"), "\"line 1\nline 2\"");
  assert.equal(formatCsvCell(null), "");
  assert.equal(formatCsvCell(undefined), "");
});

test("CSV row formatting joins cells with commas", () => {
  assert.equal(formatCsvRow(["a", "b", "c"]), "a,b,c");
  assert.equal(formatCsvRow(["a,b", "c\"d", "e"]), "\"a,b\",\"c\"\"d\",e");
});

test("CSV export covers all 8 stages without throwing", () => {
  const db = openDatabase(":memory:");
  migrate(db);

  const ctx = makeContext(db);
  const alice = upsertAccount(ctx, "alice@example.com", "Alice Organizer");
  const bob = upsertAccount(ctx, "bob@example.com", "Bob Hacker");

  const event = createEvent(ctx, {
    slug: "csv-event",
    name: "CSV Test Event",
    timezone: "UTC",
    submissionsOpenAt: 1000,
    submissionsCloseAt: 2000000000000,
    judgingOpenAt: 2000,
    judgingCloseAt: 2000000000000,
    reviewsPerProject: 2,
    pairwiseEnabled: false,
    votingMode: "open",
    votingCredits: 100,
  });

  grantRole(ctx, event.id, alice.id, "organizer");
  grantRole(ctx, event.id, bob.id, "participant");

  const track = createTrack(ctx, event.id, { key: "ai", label: "AI Track" });
  const team = createTeam(ctx, event.id, "Team Rocket");
  const project = createProject(ctx, event, team, {
    title: "Awesome AI Agent",
    summary: "Builds cool stuff",
    repoUrl: "https://github.com/example/repo",
    trackKey: track.key,
  });
  submitProject(ctx, event, project);

  for (const stage of CSV_STAGES) {
    const csv = exportCsv(db, event.id, stage);
    assert.ok(csv.length > 0, `CSV for stage ${stage} should not be empty`);
    const lines = csv.split("\r\n");
    assert.ok(lines.length >= 1, `CSV for stage ${stage} should have at least a header`);
  }
});
