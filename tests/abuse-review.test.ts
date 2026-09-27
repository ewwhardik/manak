import test from "node:test";
import assert from "node:assert/strict";
import { judged } from "./support/judged.ts";
import { abusePolicy, voteTotals } from "../src/db/index.ts";

test("event thresholds and human review gate a reversible discount while raw votes remain intact", async () => {
  const rig = judged();
  try {
    const event = rig.world.event.id;
    const slug = rig.world.event.slug;
    const token = "a".repeat(64);
    const project = rig.world.projects[0]!.id;
    const now = rig.world.clock.now();
    rig.world.db.run(`insert into voter (token_hash, event_id, fingerprint, credits, created_at, expires_at)
      values (:token, :event, 'venue', 84, :now, :expires)`, { token, event, now, expires: now + 3600000 });
    rig.world.db.run(`insert into vote (event_id, voter_hash, project_id, credits_spent, weight, created_at)
      values (:event, :token, :project, 16, 4, :now)`, { event, token, project, now });
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    const post = async (suffix: string, body: Record<string, unknown>) => rig.serve(
      new Request(`https://portal.test/api/events/${slug}/voting/${suffix}`, {
        method: "POST", headers: { authorization: `Bearer ${organizer.token}`,
          "content-type": "application/json" }, body: JSON.stringify(body),
      }), "203.0.113.73");
    const base = { clusterTokens: token, discountPercent: 100, reason: "Investigated duplicate registration" };
    assert.equal((await post("discount", base)).status, 422);
    assert.equal(voteTotals(rig.world.db, event).find((p) => p.projectId === project)?.votes, 4);
    assert.equal((await post("abuse/policy", { patternPercent: 98,
      sharedOriginPercent: 90, highRisk: 85 })).status, 200);
    assert.equal(abusePolicy(rig.world.db, event).highRisk, 85);
    assert.equal((await post("abuse/review", { clusterTokens: token, state: "benign",
      reason: "Shared venue network with independent attendees" })).status, 200);
    assert.equal((await post("discount", base)).status, 422);
    assert.equal((await post("abuse/review", { clusterTokens: token, state: "confirmed",
      reason: "Manual registration audit found one operator" })).status, 200);
    assert.equal((await post("discount", base)).status, 200);
    assert.equal(voteTotals(rig.world.db, event).find((p) => p.projectId === project)?.votes, 0);
    assert.equal(rig.world.db.one<{ weight: number }>(
      "select weight from vote where event_id = :event and voter_hash = :token and project_id = :project",
      { event, token, project }).weight, 4);
  } finally { rig.close(); }
});
