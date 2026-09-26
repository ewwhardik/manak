import test from "node:test";
import assert from "node:assert/strict";
import { comparisonInformation } from "../src/judging/index.ts";
import type { Comparison } from "../src/judging/index.ts";
import { RevisionCache } from "../src/api/index.ts";
import { bundledAsset } from "../src/http/index.ts";
import { recordComparison, saveBallot } from "../src/db/index.ts";
import { judged } from "./support/judged.ts";

const edge = (left: string, right: string, id = left + right): Comparison => ({ id, left, right, judge: "j", winner: left });
const equal = (ids: string[]) => new Map(ids.map((id) => [id, 0]));
const near = (a: number, b: number) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);

test("Fisher information agrees with the analytic two-item logistic variance", () => {
  const fit = comparisonInformation([edge("a","b"),edge("a","b","2")], ["a","b"], equal(["a","b"]));
  near(fit.pairs[0]!.resistance!, 2);
  near(fit.pairs[0]!.relativeSE!, Math.sqrt(2));
  near(fit.pairs[0]!.informationGain!, Math.log(1.5));
  near(fit.leverageSum, 1);
  assert.equal(fit.numericallySound, true);
});

test("grounded solves recover series resistance and the edge leverage identity", () => {
  const fit = comparisonInformation([edge("a","b"),edge("b","c")], ["a","b","c"], equal(["a","b","c"]));
  near(fit.pairs.find((p) => p.left === "a" && p.right === "c")!.resistance!, 8);
  near(fit.leverageSum, 2);
  assert.ok(fit.bottlenecks.every((p) => Math.abs(p.leverage!-1) < 1e-9));
  assert.equal(fit.recommendations[0]!.right, "c");
});

test("closing a cycle reduces contrast variance and distributes edge leverage", () => {
  const fit = comparisonInformation([edge("a","b"),edge("b","c"),edge("a","c")], ["a","b","c"], equal(["a","b","c"]));
  for (const pair of fit.pairs) { near(pair.resistance!, 8/3); near(pair.leverage!, 2/3); }
  near(fit.leverageSum, 2);
});

test("disconnected groups and isolates retain unidentifiable contrasts without a prior", () => {
  const ids = ["a","b","c","d"];
  const fit = comparisonInformation([edge("a","b")], ids, equal(ids));
  assert.equal(fit.componentCount, 3);
  assert.equal(fit.identifiableContrasts, 1);
  assert.equal(fit.recommendations[0]!.reason, "bridge");
  for (const pair of fit.pairs.filter((p) => p.reason === "bridge")) {
    assert.equal(pair.relativeSE, null); assert.equal(pair.informationGain, null);
  }
  assert.equal(comparisonInformation([], [], new Map()).pairs.length, 0);
});

test("geometry is invariant to input ordering, winner direction and additive strength shifts", () => {
  const ids = ["a","b","c"];
  const edges = [edge("a","b"),edge("b","c"),edge("a","c")];
  const strengths = new Map([["a",1],["b",0],["c",-1]]);
  const first = comparisonInformation(edges, ids, strengths);
  const second = comparisonInformation(edges.reverse().map((c) => ({...c,winner:c.right})), ids.reverse(), new Map([...strengths].map(([k,v]) => [k,v+10])));
  assert.deepEqual(first, second);
});

test("repeating every comparison halves resistance and retains leverage sum", () => {
  const ids = ["a","b","c"];
  const edges = [edge("a","b"),edge("b","c")];
  const first = comparisonInformation(edges, ids, equal(ids));
  const second = comparisonInformation([...edges,...edges.map((c) => ({...c,id:c.id+"2"}))],ids,equal(ids));
  first.pairs.forEach((p,i) => near(p.resistance!/2,second.pairs[i]!.resistance!));
  near(first.leverageSum,second.leverageSum);
});

test("invalid, duplicated, oversized and numerically singular inputs are explicit failures", () => {
  assert.throws(() => comparisonInformation([edge("a","a")],["a"],equal(["a"])), /distinct IDs/);
  assert.throws(() => comparisonInformation([edge("a","b"),edge("a","b")],["a","b"],equal(["a","b"])), /distinct IDs/);
  assert.throws(() => comparisonInformation([], ["a"],new Map()), /finite/);
  assert.throws(() => comparisonInformation([],Array.from({length:121},(_,i)=>String(i)),new Map()), /120 projects/);
  assert.throws(() => comparisonInformation([edge("a","b")],["a","b"],new Map([["a",1000],["b",-1000]])), /singular/);
});

test("diagnostic cache separates databases, events, variants and ledger revisions", () => {
  const cache = new RevisionCache(), db = {}, otherDb = {};
  let calls = 0;
  const read = (owner = db, event = "e", revision = "r", variant = "lab") => cache.get(owner,event,revision,variant,()=>++calls);
  assert.equal(read(),1); assert.equal(read(),1);
  assert.equal(read(otherDb),2); assert.equal(read(db,"other"),3);
  assert.equal(read(db,"e","r","influence"),4);
  assert.equal(read(db,"e","r2"),5); assert.equal(read(db,"e","r2","influence"),6);
});

test("diagnostic cache bounds memory and retries failed computations", () => {
  const cache = new RevisionCache(1,1), db = {};
  cache.get(db,"e","1","a",()=>1);
  cache.get(db,"e","1","b",()=>2);
  assert.equal(cache.get(db,"e","1","a",()=>3),3);
  cache.get(db,"f","1","a",()=>4);
  assert.equal(cache.get(db,"e","1","a",()=>5),5);
  assert.throws(()=>cache.get(db,"e","1","bad",()=>{throw new Error("retry");}), /retry/);
  assert.equal(cache.get(db,"e","1","bad",()=>6),6);
  assert.throws(()=>new RevisionCache(0),RangeError);
});

test("bundled media supports conditional, HEAD and byte-range requests", async () => {
  const path = "/assets/judging-orbit.webp";
  const get = (headers: Record<string,string> = {}, method = "GET") => bundledAsset(new Request(`http://localhost${path}`,{headers,method}),path)!;
  const full = get(), bytes = new Uint8Array(await full.arrayBuffer());
  assert.equal(full.headers.get("content-type"),"image/webp");
  const range = get({range:"bytes=2-15"});
  assert.equal(range.status,206); assert.deepEqual(new Uint8Array(await range.arrayBuffer()),bytes.slice(2,16));
  const suffix = get({range:"bytes=-4"});
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()),bytes.slice(-4));
  assert.equal(get({range:`bytes=${bytes.length}-`}).status,416);
  assert.equal(get({"if-none-match":full.headers.get("etag")!}).status,304);
  assert.equal(get({range:"bytes=0-1","if-range":"outdated"}).status,200);
  assert.equal((await get({},"HEAD").arrayBuffer()).byteLength,0);
  assert.equal(get({},"POST").status,405);
});

test("asset allowlist cannot read arbitrary source paths and preserves CSP", () => {
  const req = new Request("http://localhost/assets/favicon.svg");
  assert.equal(bundledAsset(req,"/assets/../../db/open.ts"),null);
  const csp = bundledAsset(req,"/assets/favicon.svg")!.headers.get("content-security-policy")!;
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("media-src 'self'"));
  assert.ok(!csp.includes("unsafe-inline"));
});

test("cached evidence stays organizer-only, read-only, and refreshes after a recorded comparison", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    const base = `/api/events/${rig.world.event.slug}`;
    const before = await rig.json(`${base}/results`,organizer);
    const first = await rig.json(`${base}/dashboard?lab=true`,organizer);
    const lab = first.evidenceLab as { information: { status: string; report: { pairs: { comparisons: number }[] } } };
    assert.equal(lab.information.status,"ready");
    const count = (report: typeof lab) => report.information.report.pairs.reduce((n,p)=>n+p.comparisons,0);
    assert.equal(count(lab),9);
    assert.deepEqual((await rig.json(`${base}/dashboard?lab=true`,organizer)).evidenceLab,lab);
    assert.deepEqual(await rig.json(`${base}/results`,organizer),before);
    for (const principal of rig.principals.filter((p)=>p.label!=="organizer")) {
      assert.notEqual((await rig.get(`${base}/dashboard?lab=true`,principal)).status,200);
    }
    recordComparison(rig.world.asJudge(0),rig.world.event,{
      judgeId:rig.world.judges[0]!.id,a:rig.world.projects[0]!.id,b:rig.world.projects[2]!.id,
      winner:rig.world.projects[0]!.id,reason:"manual",
    });
    const second = await rig.json(`${base}/dashboard?lab=true`,organizer);
    assert.equal(count(second.evidenceLab as typeof lab),10);
    assert.match(await rig.html(`/events/${rig.world.event.slug}/dashboard?lab=true`,organizer),/Where another comparison would help/);
    assert.equal("evidenceLab" in await rig.json(`${base}/results`),false);
  } finally { rig.close(); }
});

test("judge workflow resumes the saved draft before filed reviews without exposing peer ballots", async () => {
  const rig = judged();
  try {
    const project = rig.world.projects[2]!;
    saveBallot(rig.world.asJudge(0), rig.world.event, {
      judgeId: rig.world.judges[0]!.id, projectId: project.id,
      scores: { impact: 3, craft: 3, novelty: 5 }, comment: "Return to this evidence", submit: false,
    });
    const judge = rig.principals.find((p) => p.label === "judge")!;
    const html = await rig.html(`/events/${rig.world.event.slug}/judging`, judge);
    assert.match(html,/Continue your draft/);
    assert.ok(html.includes(`id="review-${project.id}" open`));
    assert.ok(html.indexOf(`id="review-${project.id}"`) < html.indexOf(`id="review-${rig.world.projects[0]!.id}"`));
    assert.ok(html.includes("Return to this evidence"));
    assert.ok(!html.includes("Judge 1 on"));
  } finally { rig.close(); }
});
