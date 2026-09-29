import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FIXTURE_AUTH, seedFixtures } from "../tools/seed-fixtures.ts";
import { hashToken, makeContext, migrate, openDatabase } from "../src/db/index.ts";

test("fresh fixture seeds create the deterministic sessions configured in .dogfood.toml", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const now = Date.parse("2026-09-29T00:00:00Z");
    const ctx = makeContext(db, { clock: { now: () => now } });
    db.tx(() => seedFixtures(ctx, now));

    const config = readFileSync(new URL("../.dogfood.toml", import.meta.url), "utf8");
    for (const [role, token] of Object.entries(FIXTURE_AUTH)) {
      const accountEmail = {
        organizer: "organizer@example.org",
        judge_a: "tomas.varga@example.org",
        judge_b: "wei.lindqvist@example.org",
        participant: "priya1@example.org",
      }[role]!;
      const session = db.get<{ email: string }>(
        `select a.email from session s join account a on a.id = s.account_id
          where s.token_hash = :hash and s.revoked_at is null`,
        { hash: hashToken(token) },
      );
      assert.equal(session?.email, accountEmail, `${role} fixture token did not authenticate`);
      assert.ok(config.includes(`Cookie: manak_session=${token}`), `${role} cookie is missing from .dogfood.toml`);
    }
    assert.equal(new Set(Object.values(FIXTURE_AUTH)).size, 4, "fixture roles must have distinct credentials");
  } finally {
    db.close();
  }
});
