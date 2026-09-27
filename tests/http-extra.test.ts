import test from "node:test";
import assert from "node:assert/strict";

import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/index.ts";
import {
  createEvent,
  createSession,
  grantRole,
  createProject,
  createTeam,
  makeContext,
  migrate,
  openDatabase,
  submitProject,
  upsertAccount,
} from "../src/db/index.ts";
import { makeApp } from "../src/http/index.ts";

test("widget.js, well-known public key, verify view and CSV export routes work over HTTP", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const ctx = makeContext(db);

  const event = createEvent(ctx, {
    slug: "http-extra-event",
    name: "HTTP Extra Hackathon",
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

  const creator = upsertAccount(ctx, "dev@example.com", "Dev User");
  grantRole(ctx, event.id, creator.id, "organizer");
  const session = createSession(ctx, creator.id);
  const auth = { headers: { authorization: `Bearer ${session.token}` } };
  const team = createTeam(ctx, event.id, "Dev Team");
  const project = createProject(ctx, event, team, {
    title: "Awesome Platform",
    summary: "Built for speed",
  });
  submitProject(ctx, event, project);

  const registry = makeRegistry(ALL_COMMANDS);
  const serve = makeApp({
    db,
    registry,
    publicOrigin: "http://localhost:8080",
    publicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtestfakekey\n-----END PUBLIC KEY-----\n",
  });

  // 1. widget.js
  const widgetRes = await serve(new Request("http://localhost:8080/widget.js"));
  assert.equal(widgetRes.status, 200);
  assert.ok(widgetRes.headers.get("content-type")?.includes("javascript"));
  const widgetText = await widgetRes.text();
  assert.ok(widgetText.includes("data-manak-event"));

  // 2. .well-known/manak-key.pub
  const keyRes = await serve(new Request("http://localhost:8080/.well-known/manak-key.pub"));
  assert.equal(keyRes.status, 200);
  const keyText = await keyRes.text();
  assert.ok(keyText.includes("BEGIN PUBLIC KEY"));

  // 3. /verify
  const verifyRes = await serve(new Request("http://localhost:8080/verify"));
  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.headers.get("content-type")?.includes("text/html"));
  const verifyText = await verifyRes.text();
  assert.ok(verifyText.includes("Offline Certificate Verifier"));
  assert.ok(verifyText.includes("WebCrypto"));

  // 4. CSV export: projects
  const deniedCsv = await serve(new Request("http://localhost:8080/events/http-extra-event/csv/projects"));
  assert.equal(deniedCsv.status, 401);
  const csvRes = await serve(new Request("http://localhost:8080/events/http-extra-event/csv/projects", auth));
  assert.equal(csvRes.status, 200);
  assert.ok(csvRes.headers.get("content-type")?.includes("text/csv"));
  assert.ok(csvRes.headers.get("content-disposition")?.includes("http-extra-event-projects.csv"));
  const csvText = await csvRes.text();
  assert.ok(csvText.includes("Awesome Platform"));

  // 5. CSV export: unknown stage 404
  const unknownCsvRes = await serve(new Request("http://localhost:8080/events/http-extra-event/csv/nonexistent", auth));
  assert.equal(unknownCsvRes.status, 422);
  db.close();
});
