import test from "node:test";
import assert from "node:assert/strict";
import { judged } from "./support/judged.ts";
import { normalizationSandbox, reviewExplanations, normalizeScores } from "../src/judging/index.ts";
import { loadJudgingInput, setResultsPublic } from "../src/db/index.ts";
import { explainPage } from "../src/view/explain.ts";
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/registry.ts";

test("native 1–5 waterfall has readable bars and truthful contribution and interval labels", () => {
  const html = explainPage({ command: ALL_COMMANDS.find(c => c.name === "results.explain")!,
    input: {}, whoami: "Participant", accountId: null, event: null, gates: null,
    now: 0, registry: makeRegistry(ALL_COMMANDS), founder: false,
    result: { revision: 1, notice: "Frozen result", projects: [{ title: "Native rubric",
      grandMean: 3, adjusted: 3.5, low: 3, high: 4, rank: 1, rankRaw: 2, rankMove: 1,
      reviews: [
        { label: "Review A", raw: 2, baseline: 4, calibrated: 5, weight: 1, scale: 1 },
        { label: "Review B", raw: 5, baseline: 2, calibrated: 2, weight: 1, scale: 1 },
      ],
    }] } });
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)![0];
  const heights = [...svg.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.equal(heights.length, 4);
  assert.ok(heights[0]! >= 75 && heights[3]! >= 90, "1–5 totals must occupy meaningful chart height");
  const ticks = [...svg.matchAll(/<text x="52"[^>]*>([^<]+)<\/text>/g)].map(m => Number(m[1]));
  assert.ok(ticks.length >= 3 && Math.max(...ticks) <= 6, "axis must follow native score units");
  assert.match(svg, /Above panel baseline/);
  assert.match(svg, /Below panel baseline/);
  assert.match(svg, /\+1\.00/);
  assert.match(svg, /-0\.50/);
  assert.match(html, /Reported rubric interval/);
  assert.match(html, /<table[\s\S]*Calibrated contribution/);
  assert.doesNotMatch(html, /Bootstrap CI|Harsh judge uplift|Lenient judge discount|Lenient judge offset|Harsh judge offset|αᵢ/);
});

test("anonymous review contributions reconstruct the production adjusted score", () => {
  const rig = judged();
  try {
    const input = loadJudgingInput(rig.world.db, rig.world.event.id);
    const fit = normalizeScores(input.rubric, input.ballots);
    const explanations = reviewExplanations(input.rubric, input.ballots, fit);
    for (const p of explanations) {
      const reconstructed = p.reviews.reduce((sum, r) => sum + r.calibrated * r.weight, 0) / p.reviews.reduce((sum, r) => sum + r.weight, 0);
      assert.ok(Math.abs(reconstructed - p.adjusted) < 1e-8);
      assert.equal(p.rankMove, p.rankRaw - p.rank);
      for (const r of p.reviews) { assert.equal(r.weight, r.scale ** 2); assert.ok(r.shrinkage >= 0 && r.shrinkage <= 1); }
    }
    for (const id of rig.secrets) assert.ok(!JSON.stringify(explanations).includes(id));
  } finally { rig.close(); }
});

test("participant explanation is frozen, own-team scoped, private and hidden when unpublished", async () => {
  const rig = judged();
  const base = `/api/events/${rig.fill.event}/results`;
  try {
    const response = await rig.get(`${base}/explain`, rig.principals[1]);
    assert.equal(response.status, 200);
    const body = await response.json() as { projects: { project: string; reviews: unknown[] }[] };
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0]!.project, rig.world.projects[0]!.id);
    assert.ok(body.projects[0]!.reviews.length > 0);
    for (const id of rig.secrets) assert.ok(!JSON.stringify(body).includes(id));
    for (const principal of [undefined, rig.principals[1], rig.principals[3]]) {
      const publicResult = await rig.json(base, principal);
      assert.ok(!('_explanations' in publicResult));
      const historical = await rig.json(`${base}?revision=1`, principal);
      assert.ok(!('_explanations' in historical));
    }
    const stored = rig.world.db.one<{ report: string }>("select report from result_publication where event_id = :e", { e: rig.world.event.id });
    const frozen = JSON.parse(stored.report);
    assert.deepEqual(body.projects[0]!.reviews, frozen._explanations.find((p: { project: string }) => p.project === rig.fill.project).reviews);
    assert.notEqual((await rig.get(`${base}/explain`)).status, 200);
    const html = await rig.html(`/events/${rig.fill.event}/results/explain`, rig.principals[1]);
    assert.match(html, /Calibrated contribution/);
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    assert.notEqual((await rig.get(`${base}/explain`, rig.principals[1])).status, 200);
  } finally { rig.close(); }
});

test("sandbox distinguishes actual and implied comparisons, omits unsupported scores, and requires organizer", async () => {
  const rig = judged();
  try {
    const path = `/api/events/${rig.fill.event}/results/sandbox`;
    assert.notEqual((await rig.get(path, rig.principals[1])).status, 200);
    const response = await rig.get(path, rig.principals[3]);
    assert.equal(response.status, 200);
    const body = await response.json() as { methods: { name: string }[] };
    assert.equal(body.methods.length, 6);
    const empty = normalizationSandbox(null, [], []);
    assert.equal(empty.every(m => !m.available && !m.scores.length), true);
    const input = loadJudgingInput(rig.world.db, rig.world.event.id);
    const single = normalizationSandbox(input.rubric, [input.ballots[0]!], []);
    assert.equal(single.find(m => m.name === 'Within-reviewer z-score')!.available, false);
    assert.equal(single.find(m => m.name === 'Implied Bradley–Terry')!.available, false);
  } finally { rig.close(); }
});
