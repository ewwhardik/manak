import test from "node:test";
import assert from "node:assert/strict";

import type { Comparison, ProjectId } from "../src/judging/types.ts";
import { nextPair, pairingProgress } from "../src/judging/pairing.ts";

const cmp = (id: string, judge: string, left: ProjectId, right: ProjectId, winner: ProjectId): Comparison =>
  ({ id, judge, left, right, winner });

const pool = ["a", "b", "c", "d", "e"];

test("progress counts exposure and reports connectivity", () => {
  const progress = pairingProgress(pool, [
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j2", "b", "c", "c"),
  ]);
  assert.equal(progress.exposure.get("a"), 1);
  assert.equal(progress.exposure.get("b"), 2);
  assert.equal(progress.exposure.get("e"), 0);
  assert.deepEqual(progress.leastSeen, ["d", "e"]);
  assert.equal(progress.connected, false);
  // {a,b,c} plus the two untouched singletons.
  assert.equal(progress.componentCount, 3);
});

test("a pair that joins two groups is taken before anything else", () => {
  const history = [cmp("c1", "j1", "a", "b", "a"), cmp("c2", "j1", "c", "d", "c")];
  const pick = nextPair({ judge: "j2", projects: ["a", "b", "c", "d"], comparisons: history, seed: "s" });
  assert.ok(pick);
  assert.equal(pick?.reason, "bridge");
  const left = pick?.left as ProjectId;
  const right = pick?.right as ProjectId;
  const groupOf = (p: ProjectId): string => (["a", "b"].includes(p) ? "ab" : "cd");
  assert.notEqual(groupOf(left), groupOf(right), `${left} vs ${right} does not bridge anything`);
});

test("an unseen project is a group of one, so exposure is bridged first", () => {
  const history = [cmp("c1", "j1", "a", "b", "a"), cmp("c2", "j1", "b", "c", "b")];
  const pick = nextPair({ judge: "j2", projects: ["a", "b", "c", "z"], comparisons: history, seed: "s" });
  assert.equal(pick?.reason, "bridge");
  assert.ok(pick?.left === "z" || pick?.right === "z", "the never-seen project must be pulled in");
});

test("bridging prefers to join the two largest groups", () => {
  // {a,b,c} is a group of three, {d,e} a group of two, f is alone. The fastest
  // way to a comparable field is to fuse the two big groups first.
  const history = [
    cmp("c1", "j1", "a", "b", "a"),
    cmp("c2", "j1", "b", "c", "b"),
    cmp("c3", "j1", "d", "e", "d"),
  ];
  const pick = nextPair({
    judge: "j2",
    projects: ["a", "b", "c", "d", "e", "f"],
    comparisons: history,
    seed: "span",
  });
  assert.equal(pick?.reason, "bridge");
  const chosen = [pick?.left, pick?.right];
  assert.ok(!chosen.includes("f"), `expected the 3+2 join, got ${chosen.join(" vs ")}`);
});

test("a judge is never shown the same pair twice, and eventually runs out", () => {
  const history: Comparison[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const pick = nextPair({ judge: "j1", projects: pool, comparisons: history, seed: "exhaust" });
    assert.ok(pick, `ran out after ${i} of 10 possible pairs`);
    const key = [pick?.left, pick?.right].sort().join(" ");
    assert.ok(!seen.has(key), `pair ${key} was offered twice`);
    seen.add(key);
    history.push(cmp(`c${i}`, "j1", pick?.left as ProjectId, pick?.right as ProjectId, pick?.left as ProjectId));
  }
  assert.equal(seen.size, 10, "five projects make exactly ten distinct pairs");
  assert.equal(
    nextPair({ judge: "j1", projects: pool, comparisons: history, seed: "exhaust" }),
    null,
    "with every pair seen, the honest answer is nothing left to show",
  );
});

test("another judge is unaffected by what the first judge has seen", () => {
  const history = pool
    .flatMap((a, i) => pool.slice(i + 1).map((b) => [a, b] as const))
    .map(([a, b], i) => cmp(`c${i}`, "j1", a, b, a));
  assert.equal(nextPair({ judge: "j1", projects: pool, comparisons: history, seed: "s" }), null);
  assert.ok(nextPair({ judge: "j2", projects: pool, comparisons: history, seed: "s" }));
});

test("conflicts are never offered", () => {
  for (let i = 0; i < 30; i++) {
    const pick = nextPair({
      judge: "j1",
      projects: pool,
      comparisons: [],
      conflicts: ["a", "b"],
      seed: `conflict-${i}`,
    });
    assert.ok(pick);
    assert.ok(!["a", "b"].includes(pick?.left as string));
    assert.ok(!["a", "b"].includes(pick?.right as string));
  }
});

test("a judge with fewer than two allowed projects gets nothing", () => {
  assert.equal(
    nextPair({ judge: "j1", projects: ["a", "b"], comparisons: [], conflicts: ["a"], seed: "s" }),
    null,
  );
});

test("the same state and seed always produce the same pair", () => {
  const history = [cmp("c1", "j1", "a", "b", "a")];
  const once = nextPair({ judge: "j2", projects: pool, comparisons: history, seed: "fixed" });
  const twice = nextPair({ judge: "j2", projects: pool, comparisons: history, seed: "fixed" });
  assert.deepEqual(once, twice);
});

test("on a connected field the most informative pair wins", () => {
  // A fully compared field, so nothing needs bridging, with a known ordering.
  const history: Comparison[] = [];
  let n = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      history.push(cmp(`c${n++}`, "j-history", pool[i] as string, pool[j] as string, pool[i] as string));
    }
  }
  const strengths = new Map<ProjectId, number>([
    ["a", 2],
    ["b", 0.01],
    ["c", 0],
    ["d", -1],
    ["e", -2],
  ]);
  const pick = nextPair(
    { judge: "fresh", projects: pool, comparisons: history, strengths, seed: "info" },
    { epsilon: 0, exposureWeight: 0 },
  );
  assert.equal(pick?.reason, "informative");
  assert.deepEqual([pick?.left, pick?.right].sort(), ["b", "c"]);
  assert.ok((pick?.information as number) > 0.99, "a coin-flip pair carries full information");
});

test("exposure can outvote information, and says so when it does", () => {
  // a and b are heavily compared and evenly matched — the most informative pair
  // available. d and e are barely seen and lopsided. With exposure weighted up,
  // the scheduler should take the under-seen pair and label the reason honestly.
  const history: Comparison[] = [
    cmp("c1", "h1", "a", "b", "a"),
    cmp("c2", "h2", "a", "b", "b"),
    cmp("c3", "h3", "a", "b", "a"),
    cmp("c4", "h4", "a", "b", "b"),
    cmp("c5", "h1", "b", "c", "b"),
    cmp("c6", "h2", "c", "d", "c"),
    cmp("c7", "h3", "d", "e", "d"),
  ];
  const strengths = new Map<ProjectId, number>([
    ["a", 0],
    ["b", 0],
    ["c", 0],
    ["d", 1.5],
    ["e", -1.5],
  ]);
  const informationOnly = nextPair(
    { judge: "fresh", projects: pool, comparisons: history, strengths, seed: "x" },
    { epsilon: 0, exposureWeight: 0 },
  );
  assert.equal(informationOnly?.reason, "informative");

  const withExposure = nextPair(
    { judge: "fresh", projects: pool, comparisons: history, strengths, seed: "x" },
    { epsilon: 0, exposureWeight: 4, exposureTarget: 4 },
  );
  assert.equal(withExposure?.reason, "exposure");
  assert.ok((withExposure?.deficit as number) > (informationOnly?.deficit as number));
});

test("exploration fires when epsilon is one and never breaks the rules", () => {
  const history = [cmp("c1", "j1", "a", "b", "a"), cmp("c2", "j1", "b", "c", "b"), cmp("c3", "j1", "c", "d", "c"), cmp("c4", "j1", "d", "e", "d")];
  const reasons = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const pick = nextPair(
      { judge: `j${i}`, projects: pool, comparisons: history, seed: "explore" },
      { epsilon: 1 },
    );
    assert.ok(pick);
    assert.notEqual(pick?.left, pick?.right);
    reasons.add(pick?.reason as string);
  }
  assert.deepEqual([...reasons], ["explore"]);
});

test("which project appears on the left is decided by the seed, not by name", () => {
  const sides = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const pick = nextPair({ judge: `judge-${i}`, projects: ["a", "b"], comparisons: [], seed: "sides" });
    sides.add(pick?.left as string);
  }
  assert.equal(sides.size, 2, "position bias: one project always took the left slot");
});

test("podium cutoff prioritizes border duels straddling the prize boundary", () => {
  // Pool of 6 projects, connected history so no bridges needed
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const strengths = new Map([
    ["p1", 2.0], // rank 1
    ["p2", 1.5], // rank 2
    ["p3", 1.0], // rank 3 (podium cutoff border)
    ["p4", 0.9], // rank 4 (podium cutoff border)
    ["p5", 0.1], // rank 5
    ["p6", -0.5], // rank 6
  ]);
  const history = [
    cmp("c1", "j0", "p1", "p2", "p1"),
    cmp("c2", "j0", "p2", "p3", "p2"),
    cmp("c3", "j0", "p3", "p4", "p3"),
    cmp("c4", "j0", "p4", "p5", "p4"),
    cmp("c5", "j0", "p5", "p6", "p5"),
  ];
  // With podiumCutoff: 3, the critical duel to resolve is between rank 3 (p3) and rank 4 (p4)
  const pick = nextPair(
    { judge: "j1", projects, comparisons: history, strengths, seed: "podium-test" },
    { podiumCutoff: 3, podiumWeight: 1.5, exposureWeight: 0, epsilon: 0 },
  );
  assert.ok(pick);
  const pair = [pick.left, pick.right].sort();
  assert.deepEqual(pair, ["p3", "p4"]);
  assert.equal(pick.reason, "podium");
});
