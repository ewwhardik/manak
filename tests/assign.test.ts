import test from "node:test";
import assert from "node:assert/strict";

import { JudgingError } from "../src/judging/types.ts";
import { assignReviews } from "../src/judging/assign.ts";
import type { AssignJudge, AssignProject } from "../src/judging/assign.ts";

const projects = (n: number, track?: (i: number) => string): AssignProject[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${String(i + 1).padStart(2, "0")}`,
    ...(track ? { track: track(i) } : {}),
  }));

const judges = (n: number): AssignJudge[] =>
  Array.from({ length: n }, (_, i) => ({ id: `j${String(i + 1).padStart(2, "0")}` }));

test("every project gets the requested number of distinct reviews", () => {
  const result = assignReviews(projects(12), judges(4), 3, "seed");
  assert.equal(result.complete, true);
  assert.deepEqual(result.shortfalls, []);
  assert.equal(result.assignments.length, 36);
  for (const [project, list] of result.byProject) {
    assert.equal(list.length, 3, `${project} got ${list.length} reviews`);
    assert.equal(new Set(list).size, 3, `${project} was reviewed twice by one judge`);
  }
});

test("judge load is level when nothing prevents it", () => {
  const result = assignReviews(projects(12), judges(4), 3, "seed");
  assert.equal(result.loadMin, 9);
  assert.equal(result.loadMax, 9);
  assert.equal(result.balanced, true);
  assert.equal(result.warnings.length, 0);
});

test("load stays within one review when the count does not divide evenly", () => {
  const result = assignReviews(projects(10), judges(4), 3, "seed");
  assert.equal(result.assignments.length, 30);
  assert.ok(result.loadMax - result.loadMin <= 1, `spread was ${result.loadMin}..${result.loadMax}`);
  assert.equal(result.balanced, true);
});

test("conflicts of interest are absolute", () => {
  const conflicted: AssignJudge[] = [
    { id: "j01", conflicts: ["p01", "p02", "p03"] },
    { id: "j02" },
    { id: "j03" },
    { id: "j04", conflicts: ["p01"] },
    { id: "j05" },
    { id: "j06" },
  ];
  const result = assignReviews(projects(12), conflicted, 3, "conflicts");
  assert.equal(result.complete, true);
  assert.ok(!(result.byJudge.get("j01") as string[]).some((p) => ["p01", "p02", "p03"].includes(p)));
  assert.ok(!(result.byJudge.get("j04") as string[]).includes("p01"));
  assert.ok(result.loadMax - result.loadMin <= 1);
});

test("conflicts that make the target unreachable surface as a shortfall", () => {
  // p01 can only be seen by j02 and j03, so a third review does not exist. The
  // right answer is to say so, not to quietly hand it to a conflicted judge.
  const conflicted: AssignJudge[] = [
    { id: "j01", conflicts: ["p01", "p02", "p03"] },
    { id: "j02" },
    { id: "j03" },
    { id: "j04", conflicts: ["p01"] },
  ];
  const result = assignReviews(projects(12), conflicted, 3, "conflicts");
  assert.equal(result.complete, false);
  assert.deepEqual(result.shortfalls.map((s) => s.project), ["p01"]);
  assert.equal(result.shortfalls[0]?.assigned, 2);
  assert.equal(result.shortfalls[0]?.eligibleJudges, 2);
  assert.ok(!(result.byJudge.get("j01") as string[]).includes("p01"));
  assert.ok(!(result.byJudge.get("j04") as string[]).includes("p01"));
});

test("track restrictions are honoured on both sides", () => {
  const tracked = projects(12, (i) => (i % 2 === 0 ? "ai" : "tools"));
  const panel: AssignJudge[] = [
    { id: "j01", tracks: ["ai"] },
    { id: "j02", tracks: ["ai"] },
    { id: "j03", tracks: ["tools"] },
    { id: "j04", tracks: ["tools"] },
    { id: "j05" },
  ];
  const result = assignReviews(tracked, panel, 2, "tracks");
  assert.equal(result.complete, true);
  const trackOf = new Map(tracked.map((p) => [p.id, p.track]));
  for (const j of ["j01", "j02"]) {
    for (const p of result.byJudge.get(j) as string[]) assert.equal(trackOf.get(p), "ai");
  }
  for (const j of ["j03", "j04"]) {
    for (const p of result.byJudge.get(j) as string[]) assert.equal(trackOf.get(p), "tools");
  }
});

test("a judge restricted to tracks is not handed an untracked project", () => {
  const result = assignReviews(projects(4), [{ id: "j01", tracks: ["ai"] }, { id: "j02" }], 1, "s");
  assert.equal((result.byJudge.get("j01") as string[]).length, 0);
  assert.equal((result.byJudge.get("j02") as string[]).length, 4);
  assert.ok(result.warnings.some((w) => w.includes("assigned nothing")));
});

test("the same seed produces the same draw, a different seed does not", () => {
  const a = assignReviews(projects(15), judges(5), 3, "alpha");
  const b = assignReviews(projects(15), judges(5), 3, "alpha");
  const c = assignReviews(projects(15), judges(5), 3, "beta");
  assert.deepEqual(a.assignments, b.assignments);
  assert.notDeepEqual(a.assignments, c.assignments);
});

test("an impossible target is reported, not silently rounded down", () => {
  const result = assignReviews(projects(5), judges(2), 3, "short");
  assert.equal(result.complete, false);
  assert.equal(result.shortfalls.length, 5);
  for (const s of result.shortfalls) {
    assert.equal(s.assigned, 2);
    assert.equal(s.wanted, 3);
    assert.equal(s.eligibleJudges, 2);
    assert.match(s.reason, /only 2 judges are eligible/);
  }
  assert.ok(result.warnings.some((w) => w.includes("fewer than 3 reviews")));
  // One eligible judge is the case the sentence gets wrong the moment the agreement helpers
  // are dropped for a template literal. "only 1 judges are eligible" reads as a defect in the
  // product rather than a shortfall in the panel, and an organizer who sees it stops trusting
  // the numbers printed next to it.
  const alone = assignReviews(projects(5), judges(1), 3, "short");
  assert.match(alone.shortfalls[0]?.reason ?? "", /only 1 judge is eligible/);
});

test("a project no judge may see is called out by name", () => {
  const panel: AssignJudge[] = [
    { id: "j01", conflicts: ["p01"] },
    { id: "j02", conflicts: ["p01"] },
  ];
  const result = assignReviews(projects(3), panel, 2, "orphan");
  const orphan = result.shortfalls.find((s) => s.project === "p01");
  assert.ok(orphan, "the unreviewable project must appear in the shortfall list");
  assert.equal(orphan?.assigned, 0);
  assert.equal(orphan?.eligibleJudges, 0);
  assert.match(orphan?.reason as string, /no judge is eligible/);
});

test("capacity limits produce a shortfall with the capacity reason", () => {
  const panel: AssignJudge[] = [
    { id: "j01", capacity: 2 },
    { id: "j02", capacity: 2 },
    { id: "j03", capacity: 2 },
  ];
  const result = assignReviews(projects(6), panel, 2, "capacity");
  assert.equal(result.complete, false);
  assert.equal(result.assignments.length, 6);
  assert.ok(result.shortfalls.some((s) => /capacity/.test(s.reason)));
});

test("bad input is refused with a code, not a stack trace", () => {
  assert.throws(() => assignReviews([], judges(2), 1, "s"), (e: unknown) =>
    e instanceof JudgingError && e.code === "assign.noProjects");
  assert.throws(() => assignReviews(projects(2), [], 1, "s"), (e: unknown) =>
    e instanceof JudgingError && e.code === "assign.noJudges");
  assert.throws(() => assignReviews(projects(2), judges(2), 0, "s"), (e: unknown) =>
    e instanceof JudgingError && e.code === "assign.reviews");
  assert.throws(() => assignReviews(projects(2), judges(2), 1.5, "s"), (e: unknown) =>
    e instanceof JudgingError && e.code === "assign.reviews");
  assert.throws(
    () => assignReviews([{ id: "p1" }, { id: "p1" }], judges(2), 1, "s"),
    (e: unknown) => e instanceof JudgingError && e.code === "assign.duplicateProject",
  );
  assert.throws(
    () => assignReviews(projects(2), [{ id: "j1" }, { id: "j1" }], 1, "s"),
    (e: unknown) => e instanceof JudgingError && e.code === "assign.duplicateJudge",
  );
});

test("a large draw stays balanced and complete", () => {
  const result = assignReviews(projects(200), judges(24), 4, "scale");
  assert.equal(result.complete, true);
  assert.equal(result.assignments.length, 800);
  assert.ok(result.loadMax - result.loadMin <= 1, `spread was ${result.loadMin}..${result.loadMax}`);
  assert.ok(Math.abs(result.loadMean - 800 / 24) < 1e-9);
});
