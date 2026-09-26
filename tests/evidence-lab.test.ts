import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decomposeTournament, wasserstein2, distributionCalibration } from "../src/judging/index.ts";
import type { Comparison, Rubric } from "../src/judging/index.ts";
import { ledgerWebhook, signWebhookPayload } from "../src/db/index.ts";
import { judged, ORIGIN } from "./support/judged.ts";
import { world } from "./support/world.ts";

const edge = (left: string, right: string): Comparison => ({ id: left + right, judge: "j", left, right, winner: left });

test("Hodge distinguishes triangle cycles, larger cycles and a tree with exact energy accounting", () => {
  const triangle = decomposeTournament([edge("a", "b"), edge("b", "c"), edge("c", "a")], ["a", "b", "c"]);
  assert.ok(triangle.curlShare > 0.999999);
  assert.ok(triangle.harmonicShare < 1e-10);
  const ring = decomposeTournament([edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "a")], ["a", "b", "c", "d"]);
  assert.ok(ring.harmonicShare > 0.999999);
  assert.equal(ring.triangles, 0);
  const tree = decomposeTournament([edge("a", "b"), edge("b", "c")], ["a", "b", "c"]);
  assert.ok(tree.gradientShare > 0.999999);
  for (const fit of [triangle, ring, tree]) {
    assert.equal(fit.converged, true);
    assert.ok(fit.reconstructionError < 1e-9);
    assert.ok(fit.divergenceError < 1e-9);
  }
  assert.throws(() => decomposeTournament([edge("a", "b"), edge("a", "b")], ["a", "b"]));
});

test("exact W2 handles unequal sample sizes and calibration declines unsupported cohorts", () => {
  assert.ok(Math.abs(wasserstein2([0, 2], [0, 1, 2]) - Math.sqrt(1 / 3)) < 1e-12);
  assert.equal(wasserstein2([0, 2], [0]), Math.sqrt(2));
  assert.equal(wasserstein2([0], [0, 2]), Math.sqrt(2));
  assert.throws(() => wasserstein2([], [1]));
  const rubric: Rubric = { id: "r", version: 1, criteria: [{ key: "q", label: "Quality", min: 0, max: 5, weight: 1 }] };
  const result = distributionCalibration(rubric, [{ id: "1", judge: "j", project: "p", rubricVersion: 1, scores: { q: 4 } }]);
  assert.equal(result.profiles[0]!.distance, null);
  assert.equal(result.profiles[0]!.status, "insufficient-overlap");
});

test("project comments escape text, enforce moderation roles and retain audited reasons", async () => {
  const rig = judged();
  try {
    const base = `/api/events/${rig.world.event.slug}/projects/${rig.world.projects[0]!.id}`;
    const post = (suffix: string, label: string, data: unknown) => rig.serve(new Request(`${ORIGIN}${base}${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${rig.principals.find((p) => p.label === label)!.token}` }, body: JSON.stringify(data),
    }), "203.0.113.61");
    assert.equal((await post("/comments", "participant", { body: "<script>alert(1)</script>" })).status, 200);
    const comments = (await rig.json(base)).comments as { id: string }[];
    assert.equal(comments.length, 1);
    assert.match(await rig.html(base.replace("/api", "")), /&lt;script&gt;alert/);
    const data = { comment: comments[0]!.id, reason: "Removed during moderation review" };
    assert.equal((await post("/comments/hide", "participant", data)).status, 403);
    assert.equal((await post("/comments/hide", "organizer", data)).status, 200);
    assert.deepEqual((await rig.json(base)).comments, []);
    assert.ok(rig.world.db.get("select seq from ledger where action = 'comment.hidden' and payload like '%moderation review%'"));
  } finally { rig.close(); }
});

test("voting windows hide previously published results and the evidence lab is organizer-only", async () => {
  const rig = judged();
  try {
    const ctx = rig.world.asOrganizer;
    ctx.recorded({ action: "event.updated", eventId: rig.world.event.id }, () => {
      ctx.write("update event set voting_mode = 'open', voting_open_at = :start, voting_close_at = :end where id = :id", { start: ctx.now() - 100, end: ctx.now() + 10000, id: rig.world.event.id });
    });
    const base = `/api/events/${rig.world.event.slug}`;
    assert.notEqual((await rig.get(`${base}/results`)).status, 200);
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    assert.equal((await rig.get(`${base}/results`, organizer)).status, 200);
    assert.notEqual((await rig.get(`${base}/dashboard?lab=true`)).status, 200);
    const report = await rig.json(`${base}/dashboard?lab=true`, organizer);
    assert.ok(report.evidenceLab);
    const published = await rig.serve(new Request(`${ORIGIN}${base}/results/publish`, { method: "POST", headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" }, body: "{}" }), "203.0.113.62");
    assert.equal(published.status, 409);
  } finally { rig.close(); }
});

test("ledger webhook retries without loss, signs notifications and resumes from a durable cursor", async () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), "manak-hooks-"));
  try {
    let reject = true;
    const deliveries: string[] = [];
    const options = { db: w.db, eventId: w.event.id, url: "https://receiver.example/hook", secret: "s".repeat(32), checkpoint: join(dir, "cursor.json"),
      send: (async (_url: unknown, init: RequestInit | undefined) => {
        const body = String(init!.body);
        const headers = init!.headers as Record<string, string>;
        assert.equal(headers["X-Manak-Signature"], `sha256=${signWebhookPayload(body, "s".repeat(32))}`);
        assert.equal("payload" in JSON.parse(body), false);
        deliveries.push(headers["X-Manak-Delivery"]!);
        return new Response(null, { status: reject ? 503 : 204 });
      }) as typeof fetch };
    const hook = ledgerWebhook(options);
    await assert.rejects(hook.flush());
    assert.equal(hook.position(), 0);
    assert.equal(hook.status().consecutiveFailures, 1);
    assert.match(hook.status().lastError ?? "", /HTTP 503/);
    reject = false;
    assert.ok(await hook.flush() > 0);
    assert.equal(hook.status().consecutiveFailures, 0);
    assert.equal(deliveries[0], deliveries[1]);
    const restored = ledgerWebhook(options);
    assert.equal(restored.position(), hook.position());
    assert.equal(restored.status().cursor, hook.position());
    while (await restored.flush() > 0) { /* drain the bounded batches */ }
    assert.equal(await restored.flush(), 0);
    assert.throws(() => ledgerWebhook({ ...options, eventId: "missing" }));
  } finally { w.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
