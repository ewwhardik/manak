import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTournament, detectControversy, fitBradleyTerry, hybridConsensus, kendallW,
  normalizeScores, normalizedWeights, rankingSensitivity, triageFinalists, weightedTotal,
} from "../src/judging/index.ts";
import type { Ballot, Rubric } from "../src/judging/index.ts";
import { CSV_STAGES, formatCsvCell, setResultsPublic } from "../src/db/index.ts";
import { judged } from "./support/judged.ts";

const rubric: Rubric = { id: "r", version: 1, criteria: [{ key: "quality", label: "Quality", weight: 40, min: 1, max: 5 }] };
const ballots: Ballot[] = [
  { id: "1", judge: "a", project: "x", rubricVersion: 1, scores: { quality: 5 } },
  { id: "2", judge: "a", project: "y", rubricVersion: 1, scores: { quality: 2 } },
  { id: "3", judge: "b", project: "x", rubricVersion: 1, scores: { quality: 4 } },
  { id: "4", judge: "b", project: "y", rubricVersion: 1, scores: { quality: 1 } },
];

test("every CSV stage rejects visitors and peers in both route spellings", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    for (const stage of CSV_STAGES) for (const prefix of ["", "/api"]) {
      const path = `${prefix}/events/${rig.world.event.slug}/csv/${stage}`;
      for (const principal of rig.principals.filter((p) => p.label !== "organizer")) {
        const response = await rig.get(path, principal);
        assert.ok([401,403,404].includes(response.status), `${principal.label} read ${stage}: ${response.status}`);
      }
      const allowed = await rig.get(path, organizer);
      assert.equal(allowed.status, 200);
      assert.match(allowed.headers.get("content-type") ?? "", /text\/csv/);
    }
  } finally { rig.close(); }
});

test("community totals honor publication for visitors and judges, organizer can preview", async () => {
  const rig = judged();
  try {
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const path = `/api/events/${rig.world.event.slug}/votes`;
    for (const principal of rig.principals) {
      const response = await rig.get(path, principal);
      assert.equal(response.status, principal.label === "organizer" ? 200 : 409);
    }
  } finally { rig.close(); }
});

test("project search filters on the backend and combines with track filtering", async () => {
  const rig = judged();
  try {
    const base = `/api/events/${rig.world.event.slug}/projects`;
    const existing = await rig.json(base);
    const projects = existing.projects as { id: string; title: string }[];
    assert.ok(projects.length > 0);
    const match = await rig.json(`${base}?q=${encodeURIComponent(projects[0]!.title)}`);
    assert.ok((match.projects as { id: string }[]).some((p) => p.id === projects[0]!.id));
    const absent = await rig.json(`${base}?q=no-such-project-unique`);
    assert.deepEqual(absent.projects, []);
  } finally { rig.close(); }
});

test("dashboard exposes decision support and event-only audit without changing the ranking", async () => {
  const rig = judged();
  try {
    const principal = rig.principals.find((p) => p.label === "organizer")!;
    const base = `/api/events/${rig.world.event.slug}`;
    const before = await rig.json(`${base}/results`, principal);
    const report = await rig.json(`${base}/dashboard?finalists=2&sensitivity=true`, principal);
    assert.equal((report.decisionSupport as { target: number }).target, 2);
    assert.ok(((report.audit as { entries: unknown[] }).entries).length > 0);
    assert.ok(((report.decisionSupport as { sensitivity: { judgesTested: number } }).sensitivity).judgesTested > 0);
    const after = await rig.json(`${base}/results`, principal);
    assert.deepEqual(after, before);
    assert.equal("decisionSupport" in before, false);
    assert.equal("audit" in before, false);
  } finally { rig.close(); }
});

test("a wide interval far below the cut still prevents false finalist certainty", () => {
  const report = triageFinalists([
    { project: "leader", fitted: 10, standardError: 0, rank: 1 },
    { project: "second", fitted: 8, standardError: 0, rank: 2 },
    { project: "uncertain", fitted: 1, standardError: 9, rank: 3 },
  ], 1);
  assert.equal(report.guaranteed.length, 0);
  assert.ok(report.bubble.some((p) => p.project === "leader"));
  assert.ok(report.bubble.some((p) => p.project === "uncertain"));
});

test("zero error, all finalists, no finalists, and empty fields are represented honestly", () => {
  const candidates = [{ project: "x", fitted: 2, standardError: 0, rank: 1 }];
  const all = triageFinalists(candidates, 3);
  assert.equal(all.guaranteed.length, 1);
  assert.equal(all.guaranteed[0]!.lowerBound, 2);
  assert.equal(all.isCutDecisive, true);
  assert.equal(triageFinalists(candidates, 0).eliminated.length, 1);
  assert.equal(triageFinalists([], 4).targetK, 0);
  assert.throws(() => triageFinalists(candidates, 1.5));
  assert.throws(() => triageFinalists([{ ...candidates[0]!, standardError: -1 }], 1));
});

test("Kendall concordance handles ties, uninformative panels, and malformed vectors", () => {
  assert.equal(kendallW([[1,1,3],[1,1,3]]), 1);
  assert.equal(kendallW([[1,1,1],[1,1,1]]), 0);
  assert.equal(kendallW([[1,2,3],[3,2,1]]), 0);
  assert.throws(() => kendallW([[1,2],[1]]));
  assert.throws(() => kendallW([[1,NaN],[1,2]]));
});

test("consensus excludes missing modality evidence rather than filling in an average", () => {
  const fit = normalizeScores(rubric, ballots);
  const pairs = fitBradleyTerry([{ id:"c",judge:"a",left:"x",right:"z",winner:"x" }], ["x","y","z"]);
  const combined = hybridConsensus(fit, pairs);
  assert.deepEqual(combined.projects.map((p) => p.project), ["x"]);
  assert.throws(() => hybridConsensus(fit,pairs,{rubricWeight: NaN}));
});

test("controversy is invariant to equivalent rubric weight units", () => {
  const contested = ballots.map((b, i) => ({ ...b, project: "x", scores: { quality: i % 2 === 0 ? 1 : 5 } }));
  const a = detectControversy(rubric, contested);
  const b = detectControversy({ ...rubric, criteria: rubric.criteria.map((c) => ({ ...c, weight: c.weight / 100 })) }, contested);
  assert.deepEqual(a, b);
  assert.equal(a.polarizedCount, 1);
});

test("rubric totals reject duplicate keys, infinite bounds and non-numeric scores", () => {
  assert.throws(() => normalizedWeights([rubric.criteria[0]!, rubric.criteria[0]!]));
  assert.throws(() => normalizedWeights([{ ...rubric.criteria[0]!, weight: Infinity }]));
  assert.throws(() => normalizedWeights([{ ...rubric.criteria[0]!, max: Infinity }]));
  assert.throws(() => weightedTotal(rubric,{quality: "3" as unknown as number}));
});

test("tournament diagnoses four-cycles and keeps missing comparisons distinct from ties", () => {
  const projects = ["a","b","c","d"];
  const comparisons = projects.map((p,i) => ({id:String(i),judge:"j",left:p,right:projects[(i+1)%4]!,winner:p}));
  const report = analyzeTournament(projects, comparisons);
  assert.equal(report.hasCycle, true);
  assert.equal(report.cycleNodes.length, 4);
  assert.equal(report.condorcetWinner, null);
  assert.equal(report.standings[0]!.headToHeadTies, 0);
  assert.equal(report.standings[0]!.headToHeadUnplayed, 1);
  assert.throws(() => analyzeTournament(projects,[{...comparisons[0]!,winner:"outside"}]));
});

test("reviewer sensitivity reports lost sole evidence and is deterministic", () => {
  const a = rankingSensitivity(rubric,ballots);
  assert.deepEqual(a, rankingSensitivity(rubric,ballots.slice().reverse()));
  assert.equal(a.judgesTested,2);
  assert.ok(a.projects.every((p) => p.maxRankShift === 0));
  const single = rankingSensitivity(rubric,ballots.filter((b) => b.judge === "a"));
  assert.ok(single.projects.every((p) => p.missingWithoutJudge === 1));
  assert.equal(rankingSensitivity(rubric,ballots,1).limited,true);
});

test("spreadsheet exports neutralize formulas while preserving numeric negatives", () => {
  assert.equal(formatCsvCell("=1+1"),"'=1+1");
  assert.equal(formatCsvCell(" +danger"),"' +danger");
  assert.equal(formatCsvCell(-2),"-2");
});
