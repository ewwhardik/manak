import test from "node:test";
import assert from "node:assert/strict";

import { hashString, makeRng } from "../src/judging/rng.ts";
import { mean, sd } from "../src/judging/stats.ts";

test("the same seed replays exactly", () => {
  const a = makeRng("event-42");
  const b = makeRng("event-42");
  for (let i = 0; i < 50; i++) assert.equal(a.next(), b.next());
});

test("different seeds diverge", () => {
  const a = makeRng("event-42");
  const b = makeRng("event-43");
  const left = Array.from({ length: 20 }, () => a.next());
  const right = Array.from({ length: 20 }, () => b.next());
  assert.notDeepEqual(left, right);
});

test("a zero numeric seed is still a usable stream", () => {
  const rng = makeRng(0);
  const draws = Array.from({ length: 10 }, () => rng.next());
  assert.ok(new Set(draws).size > 1, "a degenerate seed must not collapse the stream");
  for (const d of draws) assert.ok(d >= 0 && d < 1);
});

test("next stays in [0, 1)", () => {
  const rng = makeRng("bounds");
  for (let i = 0; i < 5000; i++) {
    const x = rng.next();
    assert.ok(x >= 0 && x < 1, `draw out of range: ${x}`);
  }
});

test("int is bounded and safe at zero", () => {
  const rng = makeRng("ints");
  for (let i = 0; i < 1000; i++) {
    const x = rng.int(7);
    assert.ok(Number.isInteger(x) && x >= 0 && x < 7);
  }
  assert.equal(rng.int(0), 0);
  assert.equal(rng.int(-3), 0);
});

test("shuffle is a permutation and is reproducible", () => {
  const items = Array.from({ length: 25 }, (_, i) => `p${i}`);
  const once = makeRng("shuffle").shuffle(items);
  const twice = makeRng("shuffle").shuffle(items);
  assert.deepEqual(once, twice);
  assert.deepEqual(once.slice().sort(), items.slice().sort());
  assert.notDeepEqual(once, items, "a 25-item shuffle that returns the input is suspicious");
});

test("pick is empty-safe and stays inside the collection", () => {
  const rng = makeRng("pick");
  assert.equal(rng.pick([]), undefined);
  for (let i = 0; i < 200; i++) assert.ok(["a", "b", "c"].includes(rng.pick(["a", "b", "c"]) as string));
});

test("gauss has roughly the requested mean and spread", () => {
  const rng = makeRng("gauss");
  const draws = Array.from({ length: 20000 }, () => rng.gauss(2, 3));
  assert.ok(Math.abs(mean(draws) - 2) < 0.1, `mean drifted: ${mean(draws)}`);
  assert.ok(Math.abs(sd(draws) - 3) < 0.15, `spread drifted: ${sd(draws)}`);
  for (const d of draws) assert.ok(Number.isFinite(d), "log(0) guard failed");
});

test("hashString is deterministic and spreads similar inputs", () => {
  assert.equal(hashString("manak"), hashString("manak"));
  assert.notEqual(hashString("manak"), hashString("manal"));
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(hashString(`judge-${i}`));
  assert.equal(seen.size, 500, "500 nearby keys must not collide");
});
