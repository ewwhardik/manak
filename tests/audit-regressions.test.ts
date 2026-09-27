import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessFinalists } from "../src/judging/index.ts";
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/index.ts";
import { createSession, rolesIn, findAccountByEmail, setResultsPublic, saveBallot, createEvent, getClockOffset, mintEventCertificates } from "../src/db/index.ts";
import { makeApp } from "../src/http/index.ts";
import { VIEWS } from "../src/view/index.ts";
import { world } from "./support/world.ts";
import { judged } from "./support/judged.ts";
const registry = makeRegistry(ALL_COMMANDS);

function harness(demoMode = false) {
  const w = world();
  const token = createSession(w.system, w.organizer.id).token;
  const serve = makeApp({ db: w.db, registry, views: VIEWS, clock: w.clock,
    publicOrigin: "https://portal.test", demoMode, log: () => {}, report: () => {} });
  const get = (path: string, auth = false) => serve(new Request(`https://portal.test${path}`,
    { headers: auth ? { authorization: `Bearer ${token}` } : {} }), "203.0.113.9");
  const postDemo = (as: string, event?: string) => serve(new Request("https://portal.test/fast-login", {
    method: "POST", body: new URLSearchParams({ as, ...(event === undefined ? {} : { event }) }),
  }), "203.0.113.9");
  return { w, token, serve, get, postDemo };
}

test("close-call support never fabricates probabilities or treats rubric units as BT strengths", () => {
  const f = [{ id: "a", adjusted: 4.9, low: 4, high: 5 }, { id: "b", adjusted: 4.8, low: 4.2, high: 5.1 }];
  assert.equal(assessFinalists([]).state, "insufficient");
  assert.equal(assessFinalists(f).winProbabilityA, null);
  assert.equal(assessFinalists(f).state, "overlap");
  const pairs = { connected: true, converged: true, strengths: [
    { project: "a", beta: -1, comparisons: 5 }, { project: "b", beta: 1, comparisons: 5 } ] };
  assert.ok(assessFinalists(f, pairs).winProbabilityA! < 0.12);
  assert.equal(assessFinalists(f, { ...pairs, connected: false }).winProbabilityA, null);
  assert.equal(assessFinalists(f, { ...pairs, converged: false }).winProbabilityA, null);
  assert.equal(assessFinalists(f.map(p => ({ id: p.id, adjusted: p.adjusted }))).state, "uncertainty-unavailable");
});

test("finalist route refuses anonymous and judge callers and renders empty evidence honestly", async () => {
  const h = harness();
  try {
    const route = `/api/events/${h.w.event.slug}/tie-breaker`;
    assert.equal((await h.get(route)).status, 401);
    const judge = createSession(h.w.system, h.w.judges[0]!.id).token;
    assert.equal((await h.serve(new Request(`https://portal.test${route}`, { headers: { authorization: `Bearer ${judge}` } }))).status, 403);
    const result = await (await h.get(route, true)).json() as any;
    assert.equal(result.state, "insufficient");
    assert.equal(result.finalists.length, 0);
    assert.equal(result.winProbabilityA, null);
    const html = await (await h.get(route.replace("/api", ""), true)).text();
    assert.match(html, /Not enough evidence/);
    assert.doesNotMatch(html, /Dry Relay|Salt Ledger|52%|0.06|\/simulator/);
  } finally { h.w.close(); }
});

test("ceremony projects remain frozen after a ballot changes", async () => {
  const rig = judged();
  try {
    const org = rig.principals.find(p => p.label === "organizer")!;
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const publish = await rig.serve(new Request(`https://portal.test/api/events/${rig.fill.event}/results/publish`, {
      method: "POST", headers: { authorization: `Bearer ${org.token}`, "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(publish.status, 200);
    const before = await rig.json(`/api/events/${rig.fill.event}/live`);
    saveBallot(rig.world.asJudge(0), rig.world.event, { judgeId: rig.world.judges[0]!.id,
      projectId: rig.world.projects[0]!.id, scores: { impact: 1, craft: 1, novelty: 0 }, comment: "Revision", submit: true });
    const after = await rig.json(`/api/events/${rig.fill.event}/live`);
    assert.deepEqual(after.projects, before.projects);
    assert.equal(after.revision, 1);
    const filtered = await rig.json(`/api/events/${rig.fill.event}/live?track=missing`);
    assert.deepEqual(filtered.projects, []);
  } finally { rig.close(); }
});

test("private judge-exclusion notes never enter public publication history", async () => {
  const rig = judged();
  try {
    const org = rig.principals.find(p => p.label === "organizer")!;
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const base = `https://portal.test/api/events/${rig.fill.event}`;
    const post = (path: string, body: Record<string, unknown>) => rig.serve(new Request(`${base}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${org.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    assert.equal((await post("/results/publish", {})).status, 200);
    const sentinel = "PRIVATE_ALLEGATION_7b92";
    assert.equal((await post("/results/judge-evidence", {
      judge: rig.world.judges[0]!.id, decision: "exclude", reason: sentinel,
    })).status, 200);
    const history = await rig.json(`/api/events/${rig.fill.event}/results/history`);
    assert.doesNotMatch(JSON.stringify(history), /PRIVATE_ALLEGATION_7b92/);
    const publicResults = await rig.json(`/api/events/${rig.fill.event}/results`);
    assert.doesNotMatch(JSON.stringify(publicResults), /PRIVATE_ALLEGATION_7b92/);
    const packet = await rig.json(`/api/events/${rig.fill.event}/results/evidence`);
    assert.equal(packet.revision, 2);
    assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_ALLEGATION_7b92/);
    const internal = await (await rig.serve(new Request(`${base}/results/history`, {
      headers: { authorization: `Bearer ${org.token}` },
    }))).json() as any;
    assert.match(JSON.stringify(internal), /PRIVATE_ALLEGATION_7b92/);
  } finally { rig.close(); }
});

test("awards are explicit publication-bound decisions and only those mint winner certificates", async () => {
  const rig = judged();
  const keys = mkdtempSync(join(tmpdir(), "manak-awards-"));
  try {
    const org = rig.principals.find(p => p.label === "organizer")!;
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const base = `https://portal.test/api/events/${rig.fill.event}`;
    const post = (path: string, body: Record<string, unknown>) => rig.serve(new Request(`${base}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${org.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    assert.equal((await post("/results/publish", {})).status, 200);
    assert.equal(mintEventCertificates(rig.world.db, rig.fill.event!, rig.world.clock.now(), keys).winners, 0);
    const decision = await post("/awards", { project: rig.world.projects[0]!.id,
      awardKey: "Grand prize", type: "placement", place: 1,
      publicSummary: "Selected after review of the published results.",
      internalReason: "Organizer panel confirmed eligibility and submission." });
    assert.equal(decision.status, 200, await decision.clone().text());
    const publicList = await rig.json(`/api/events/${rig.fill.event}/awards`);
    assert.equal((publicList.decisions as unknown[]).length, 1);
    assert.doesNotMatch(JSON.stringify(publicList), /Organizer panel confirmed/);
    const certs = mintEventCertificates(rig.world.db, rig.fill.event!, rig.world.clock.now(), keys);
    assert.ok(certs.winners > 0);
    assert.ok(certs.certificates.some(cert => cert.detail.includes("Grand prize")));
    assert.equal((await post("/results/publish", { reason: "Corrected evidence" })).status, 200);
    assert.deepEqual((await rig.json(`/api/events/${rig.fill.event}/awards`)).decisions, []);
  } finally { rig.close(); rmSync(keys, { recursive: true, force: true }); }
});

test("targeted review requests assign eligible capacity and keep private reasons private", async () => {
  const h = harness();
  try {
    const base = `/api/events/${h.w.event.slug}/review-requests`;
    const post = (path: string, body: Record<string, unknown>) => h.serve(new Request(`https://portal.test${path}`, {
      method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const privateReason = "PRIVATE_REVIEW_REASON_9231";
    const response = await post(base, { project: h.w.projects[0]!.id,
      reasonCode: "fragility", internalReason: privateReason, priority: 3 });
    assert.equal(response.status, 200, await response.clone().text());
    const request = await response.json() as { id: string; project: string; judge: string };
    assert.equal(request.project, h.w.projects[0]!.id);
    assert.ok(h.w.judges.some((judge) => judge.id === request.judge));
    const list = await (await h.get(base, true)).json() as { requests: any[] };
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0].internalReason, privateReason);
    assert.equal((await h.get(base)).status, 401);
    const cancel = await post(`${base}/${request.id}/cancel`, {});
    assert.equal(cancel.status, 200, await cancel.clone().text());
    assert.equal(h.w.db.one<{ n: number }>(`select count(*) as n from assignment
      where event_id = ? and project_id = ? and judge_id = ?`,
      [h.w.event.id, request.project, request.judge]).n, 0);
  } finally { h.w.close(); }
});

test("production fast-login and clock warp cannot grant roles or change time", async () => {
  const h = harness();
  try {
    const before = h.w.db.one<{ n: number }>("select count(*) as n from membership").n;
    assert.equal((await h.get("/fast-login?as=organizer")).status, 404);
    assert.equal((await h.postDemo("organizer")).status, 404);
    const signin = await (await h.get("/signin")).text();
    assert.doesNotMatch(signin, /Demo accounts|\/fast-login|sairamdash17/);
    assert.equal(h.w.db.one<{ n: number }>("select count(*) as n from membership").n, before);
    const offset = getClockOffset();
    const response = await h.serve(new Request(`https://portal.test/api/events/${h.w.event.slug}/clock/warp`, {
      method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, body: JSON.stringify({ offsetMs: 10000 }),
    }));
    assert.equal(response.status, 403);
    assert.equal(getClockOffset(), offset);
  } finally { h.w.close(); }
});

test("demo login grants no membership in unrelated events", async () => {
  const h = harness(true);
  try {
    createEvent(h.w.system, { slug: "dogfood", name: "Demo", timezone: "UTC",
      submissionsOpenAt: 1, submissionsCloseAt: 2, judgingOpenAt: 3, judgingCloseAt: 4,
      reviewsPerProject: 2, pairwiseEnabled: false });
    assert.equal((await h.postDemo("organizer", "dogfood")).status, 303);
    const persona = findAccountByEmail(h.w.db, "rosa@example.com")!;
    assert.deepEqual(rolesIn(h.w.db, h.w.event.id, persona.id), []);
    assert.equal((await h.postDemo("organizer", h.w.event.slug)).status, 404);
    assert.equal((await h.get("/fast-login?as=organizer")).status, 405);
  } finally { h.w.close(); }
});

test("webhook payload generation does not claim network delivery", async () => {
  const h = harness();
  try {
    const response = await h.serve(new Request(`https://portal.test/api/events/${h.w.event.slug}/webhooks/ping`, {
      method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://receiver.test", secret: "s".repeat(32) }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.delivered, false);
    assert.equal(body.statusCode, null);
    assert.match(body.error, /no network delivery/);
  } finally { h.w.close(); }
});

test("embedded gallery escapes attacker-controlled project content", async () => {
  const h = harness();
  try {
    const script = await (await h.get("/widget.js")).text();
    let rendered = "";
    const container = { getAttribute: (key: string) => key === "data-event" ? "demo" : null,
      set innerHTML(value: string) { rendered = value; } };
    runInNewContext(script, { URL, window: { location: { origin: "https://portal.test" } },
      document: { readyState: "complete", querySelectorAll: () => [container] },
      fetch: async () => ({ ok: true, json: async () => ({ projects: [{ id: "a", title: '<img src=x onerror=alert(1)>', summary: '<script>bad()</script>' }] }) }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(rendered, /&lt;img/);
    assert.doesNotMatch(rendered, /<img|<script>/);
  } finally { h.w.close(); }
});
