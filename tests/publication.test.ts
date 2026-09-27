import test from "node:test";
import assert from "node:assert/strict";

import { latestPublication, revokeRole, setResultsPublic, exportArchive, importArchive,
  createRubricVersion, publishRubric } from "../src/db/index.ts";
import { saveBallot } from "../src/db/repo/judging.ts";
import { disqualifyProject } from "../src/db/repo/projects.ts";
import { judged } from "./support/judged.ts";
import { freshDb } from "./support/world.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function post(rig: ReturnType<typeof judged>, path: string, body: Record<string, unknown>) {
  const organizer = rig.principals[3]!;
  return rig.serve(new Request(`https://portal.test${path}`, { method: "POST", headers: {
    accept: "application/json", authorization: `Bearer ${organizer.token}`,
    "content-type": "application/json",
  }, body: JSON.stringify(body) }), "203.0.113.81");
}

test("publication freezes public standings while the organizer can revise with a reason", async () => {
  const rig = judged();
  try {
    const path = `/api/events/${rig.fill.event}/results`;
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const first = await post(rig, `${path}/publish`, {});
    assert.equal(first.status, 200, await first.text());
    const publication = latestPublication(rig.world.db, rig.world.event.id)!;
    assert.equal(publication.revision, 1);
    const frozen = publication.report;
    const before = await rig.json(path);
    assert.equal(before.revision, 1);
    assert.match(String(before.evidenceDigest), /^[0-9a-f]{64}$/);

    const judge = rig.world.judges[0]!;
    const project = rig.world.projects[0]!;
    saveBallot(rig.world.asJudge(0), rig.world.event, {
      judgeId: judge.id, projectId: project.id,
      scores: { impact: 1, craft: 1, novelty: 0 }, submit: true,
    });
    assert.deepEqual(await rig.json(path), before);
    assert.equal(latestPublication(rig.world.db, rig.world.event.id)!.report, frozen);

    const corrected = await post(rig, `${path}/publish`, { reason: "Corrected a transcribed ballot" });
    assert.equal(corrected.status, 200, await corrected.text());
    assert.equal((await rig.json(path)).revision, 2);
    assert.equal((await rig.json(`${path}?revision=1`)).revision, 1);
    assert.equal((await rig.get(`${path}?revision=999`)).status, 404);
    const old = rig.world.db.one<{ report: string }>(
      "select report from result_publication where event_id = :e and revision = 1",
      { e: rig.world.event.id },
    );
    assert.equal(old.report, frozen);
    const history = await rig.json(`${path}/history`);
    assert.equal((history.revisions as unknown[]).length, 2);
  } finally { rig.close(); }
});

test("revoked judges lose access but their evidence remains until expressly excluded", async () => {
  const rig = judged();
  try {
    const judge = rig.world.judges[0]!;
    const path = `/api/events/${rig.fill.event}/results`;
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    assert.equal((await post(rig, `${path}/publish`, {})).status, 200);
    const original = latestPublication(rig.world.db, rig.world.event.id)!.report;
    revokeRole(rig.world.asOrganizer, rig.world.event.id, judge.id, "judge");
    assert.equal((await rig.get(`/api/events/${rig.fill.event}/judging`, rig.principals[2])).status, 404);
    assert.ok(rig.world.db.one<{ n: number }>(
      "select count(*) as n from ballot where event_id = :e and judge_id = :j",
      { e: rig.world.event.id, j: judge.id },
    ).n > 0);
    assert.equal(latestPublication(rig.world.db, rig.world.event.id)!.report, original);
    const excluded = await post(rig, `${path}/judge-evidence`, {
      judge: judge.id, decision: "exclude", reason: "Verified conflict of interest",
    });
    assert.equal(excluded.status, 200, await excluded.text());
    assert.equal(latestPublication(rig.world.db, rig.world.event.id)!.revision, 2);
    assert.equal(rig.world.db.one<{ n: number }>(
      "select count(*) as n from ballot where event_id = :e and judge_id = :j",
      { e: rig.world.event.id, j: judge.id },
    ).n, 4);
  } finally { rig.close(); }
});

test("a frozen revision survives disqualification, rubric replacement, archive restore, and concurrent publish requests", async () => {
  const rig = judged();
  const restored = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "manak-publication-"));
  try {
    const path = `/api/events/${rig.fill.event}/results`;
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const responses = await Promise.all([
      post(rig, `${path}/publish`, {}), post(rig, `${path}/publish`, {}),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    const first = latestPublication(rig.world.db, rig.world.event.id)!;
    assert.equal(first.revision, 1);
    const old = first.report;
    disqualifyProject(rig.world.asOrganizer, rig.world.event, rig.world.projects[0]!, "Verified eligibility error");
    const created = createRubricVersion(rig.world.asOrganizer, rig.world.event.id, [
      { key: "new", label: "New criterion", weight: 1, min: 1, max: 5 },
    ]);
    publishRubric(rig.world.asOrganizer, rig.world.event.id, created.version);
    assert.equal(latestPublication(rig.world.db, rig.world.event.id)!.report, old);
    assert.equal((await rig.json(path)).revision, 1);
    exportArchive(rig.world.db, join(dir, "archive"));
    importArchive(restored.db, join(dir, "archive"));
    assert.equal(latestPublication(restored.db, rig.world.event.id)!.report, old);
  } finally { rig.close(); restored.close(); rmSync(dir, { recursive: true, force: true }); }
});
