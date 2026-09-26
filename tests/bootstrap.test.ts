import test from "node:test";
import assert from "node:assert/strict";

import type { Comparison, ProjectId } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import { fitBradleyTerry } from "../src/judging/bradleyterry.ts";
import { bootstrapStrengths, BOOTSTRAP_DEFAULTS } from "../src/judging/bootstrap.ts";
import type { BootstrapResult } from "../src/judging/bootstrap.ts";
import { mean } from "../src/judging/stats.ts";
import { simulateComparisons, simulateEvent } from "../src/judging/simulate.ts";

const cmp = (id: string, judge: string, left: ProjectId, right: ProjectId, winner: ProjectId): Comparison =>
  ({ id, judge, left, right, winner });

/** A chain of judges who all agree that lower-numbered projects are better. */
function agreeing(projects: number, judges: number, perJudge: number): Comparison[] {
  const out: Comparison[] = [];
  for (let j = 0; j < judges; j++) {
    for (let k = 0; k < perJudge; k++) {
      const a = (j + k) % projects;
      const b = (a + 1 + (k % (projects - 1))) % projects;
      if (a === b) continue;
      const left = `p${a}` as ProjectId;
      const right = `p${b}` as ProjectId;
      out.push(cmp(`c${j}-${k}`, `j${j}`, left, right, a < b ? left : right));
    }
  }
  return out;
}

const fitOf = (comparisons: readonly Comparison[], projects?: readonly ProjectId[]) =>
  fitBradleyTerry(comparisons, projects);

const quick = { replicates: 60 } as const;

test("the defaults are the documented ones", () => {
  assert.equal(BOOTSTRAP_DEFAULTS.replicates, 400);
  assert.equal(BOOTSTRAP_DEFAULTS.unit, "judge");
  assert.equal(BOOTSTRAP_DEFAULTS.confidence, 0.95);
  assert.equal(BOOTSTRAP_DEFAULTS.iterations, 2000);
  assert.equal(BOOTSTRAP_DEFAULTS.minReplicates, 40);
});

test("a tier can hold a separated pair, and nothing claims otherwise", () => {
  // The demo event's own duels, because this is the shape a reader will meet first: three judges
  // who each walk a path across the whole field, and a middle of the table that comes out as one
  // tier containing a pair the resample does separate. Highcontrast opens tier 2 and Lintwright
  // stays with it; Lintwright over Portmatic is then established at 0% reversal while Portmatic is
  // still held with Highcontrast. That is what a leader-formed tier means, and the engine used to
  // print "places within a tier are an artefact of sorting" underneath it — a sentence its own
  // pair table contradicted on the flagship page.
  const duels: readonly (readonly [string, string, string])[] = [
    ["nils", "Readback", "Lintwright"],
    ["nils", "Lintwright", "Highcontrast"],
    ["nils", "Highcontrast", "Stackless"],
    ["nils", "Portmatic", "Stackless"],
    ["amara", "Readback", "Highcontrast"],
    ["amara", "Highcontrast", "Lintwright"],
    ["amara", "Lintwright", "Portmatic"],
    ["amara", "Portmatic", "Stackless"],
    ["kenji", "Readback", "Lintwright"],
    ["kenji", "Lintwright", "Portmatic"],
    ["kenji", "Highcontrast", "Portmatic"],
    ["kenji", "Highcontrast", "Stackless"],
  ];
  const comparisons: Comparison[] = duels.map(([judge, winner, loser], i) =>
    cmp(`d${i}`, judge, winner as ProjectId, loser as ProjectId, winner as ProjectId),
  );
  const boot = bootstrapStrengths(comparisons, fitOf(comparisons), { replicates: 400 });

  const tierOf = new Map(boot.intervals.map((iv) => [iv.project, iv.tier]));
  const inside = boot.pairs.filter((p) => tierOf.get(p.above) === tierOf.get(p.below));
  assert.ok(
    inside.some((p) => p.ordered),
    `no tier held a separated pair, so this test proves nothing: ${JSON.stringify(boot.pairs)}`,
  );

  // Tiers are still contiguous blocks of the published order — a tier that skipped a place and
  // resumed lower down would make the grouping unreadable however it was worded.
  const placed = boot.intervals.filter((iv) => iv.placed).sort((a, b) => a.rank - b.rank);
  let seen = 0;
  for (const iv of placed) {
    assert.ok(iv.tier === seen || iv.tier === seen + 1, `tier ${iv.tier} follows ${seen}`);
    seen = iv.tier;
  }
  assert.equal(seen, boot.tiers);

  const tiers = boot.notes.find((n) => n.code === "bootstrap.tiers")?.message ?? "";
  assert.ok(tiers.includes("not separated from the one at the top of it"), tiers);
  assert.ok(!/artefact of|not a finding|ties with every other\./.test(tiers), tiers);
});

test("bad input is refused rather than answered", () => {
  const comparisons = agreeing(6, 4, 8);
  const fit = fitOf(comparisons);
  assert.throws(() => bootstrapStrengths([], fit), (e: unknown) =>
    e instanceof JudgingError && e.code === "bootstrap.empty");
  assert.throws(
    () => bootstrapStrengths(comparisons, { ...fit, strengths: [] }),
    (e: unknown) => e instanceof JudgingError && e.code === "bootstrap.unfitted",
  );
  for (const confidence of [0, 1, -0.5, 1.5, Number.NaN]) {
    assert.throws(() => bootstrapStrengths(comparisons, fit, { confidence }), (e: unknown) =>
      e instanceof JudgingError && e.code === "bootstrap.confidence");
  }
  for (const replicates of [0, 1, -3]) {
    assert.throws(() => bootstrapStrengths(comparisons, fit, { replicates }), (e: unknown) =>
      e instanceof JudgingError && e.code === "bootstrap.replicates");
  }
});

// The one mistake that would produce a plausible and wrong answer: intervals resampled
// from one set of comparisons printed beside strengths fitted from another.
test("a fit of different comparisons is refused", () => {
  const fit = fitOf(agreeing(6, 4, 8));
  const other = [...agreeing(6, 4, 8), cmp("x", "j9", "q1", "q2", "q1")];
  assert.throws(() => bootstrapStrengths(other, fit, quick), (e: unknown) =>
    e instanceof JudgingError && e.code === "bootstrap.mismatch");
});

// The published table has to survive this module untouched. An interval is an account of
// a number's precision and never a correction to it, so a bootstrap that quietly replaced
// a strength with a replicate average would be reporting a ranking nobody fitted.
test("the point estimates are the caller's, exactly", () => {
  const comparisons = agreeing(10, 6, 12);
  const fit = fitOf(comparisons);
  const boot = bootstrapStrengths(comparisons, fit, quick);
  assert.equal(boot.intervals.length, fit.strengths.length);
  for (const iv of boot.intervals) {
    const was = fit.strengths.find((s) => s.project === iv.project);
    assert.equal(iv.beta, was?.beta);
    assert.equal(iv.rank, was?.rank);
  }
  assert.deepEqual(
    boot.intervals.map((iv) => iv.rank),
    boot.intervals.map((_iv, i) => i + 1),
    "intervals come back in published order",
  );
});

test("the same comparisons produce the same intervals, every time", () => {
  const event = simulateEvent({ projects: 12, judges: 6, seed: "boot.det" });
  const comparisons = simulateComparisons(event, { perJudge: 10, seed: "boot.det" });
  const fit = fitOf(comparisons, event.projects);
  const once = bootstrapStrengths(comparisons, fit, quick);
  const twice = bootstrapStrengths(comparisons, fit, quick);
  assert.deepEqual(once, twice);
  const elsewhere = bootstrapStrengths(comparisons, fit, { ...quick, seed: "other" });
  assert.notDeepEqual(
    once.intervals.map((iv) => iv.standardError),
    elsewhere.intervals.map((iv) => iv.standardError),
    "a different seed should draw different resamples",
  );
  assert.deepEqual(
    once.intervals.map((iv) => iv.beta),
    elsewhere.intervals.map((iv) => iv.beta),
    "but never different strengths",
  );
});

test("the shape of every interval holds together", () => {
  const event = simulateEvent({ projects: 16, judges: 8, seed: "boot.shape" });
  const comparisons = simulateComparisons(event, { perJudge: 12, seed: "boot.shape" });
  const boot = bootstrapStrengths(comparisons, fitOf(comparisons, event.projects), quick);
  let firstPlace = 0;
  for (const iv of boot.intervals) {
    assert.ok(iv.low <= iv.high, `${iv.project} has an inverted interval`);
    assert.ok(Number.isFinite(iv.standardError) && iv.standardError >= 0);
    assert.ok(iv.rankLow <= iv.rankMean && iv.rankMean <= iv.rankHigh, `${iv.project} rank mean is outside`);
    assert.ok(iv.rankLow >= 1 && iv.rankHigh <= boot.intervals.length);
    assert.ok(iv.rankStability >= 0 && iv.rankStability <= 1);
    assert.ok(iv.firstPlaceShare >= 0 && iv.firstPlaceShare <= 1);
    assert.ok(iv.tier >= 1 && iv.tier <= boot.intervals.length);
    firstPlace += iv.firstPlaceShare;
  }
  // Every replicate produces exactly one first place, so the shares are a distribution.
  assert.ok(Math.abs(firstPlace - 1) < 1e-9, `first-place shares summed to ${firstPlace}`);
  const tiers = boot.intervals.map((iv) => iv.tier);
  assert.equal(tiers[0], 1, "the top project is in the top tier");
  for (let i = 1; i < tiers.length; i++) {
    const step = (tiers[i] as number) - (tiers[i - 1] as number);
    assert.ok(step === 0 || step === 1, `tiers jumped by ${step} at rank ${i + 1}`);
  }
  assert.equal(boot.tiers, Math.max(...tiers));
  for (const iv of boot.intervals) {
    const sharing = boot.intervals.filter((o) => o.tier === iv.tier).length;
    assert.equal(iv.sharesTier, sharing - 1, `${iv.project} miscounts its tier`);
  }
});

test("the pair table walks adjacent places in published order", () => {
  const event = simulateEvent({ projects: 14, judges: 7, seed: "boot.pairs" });
  const comparisons = simulateComparisons(event, { perJudge: 12, seed: "boot.pairs" });
  const boot = bootstrapStrengths(comparisons, fitOf(comparisons, event.projects), quick);
  assert.equal(boot.pairs.length, boot.intervals.length - 1);
  for (let i = 0; i < boot.pairs.length; i++) {
    const pair = boot.pairs[i] as BootstrapResult["pairs"][number];
    assert.equal(pair.above, boot.intervals[i]?.project);
    assert.equal(pair.below, boot.intervals[i + 1]?.project);
    assert.ok(pair.betaGap >= 0, "a lower rank cannot have a higher strength");
    assert.ok(pair.reversalShare >= 0 && pair.reversalShare <= 1);
    assert.equal(pair.ordered, pair.reversalShare <= boot.threshold);
    const count = pair.reversalShare * boot.replicates;
    assert.ok(Math.abs(count - Math.round(count)) < 1e-9, "a share has to be a count over replicates");
  }
  assert.equal(boot.decisive, (boot.pairs[0] as { ordered: boolean }).ordered);
});

// The float-noise pin. `(1 - 0.95) / 2` is 0.025000000000000022 in binary floating point,
// which is not only ugly on a page: `quantile` turns a tail into `ceil(p * n)`, so the
// leftover 2e-17 moved both interval endpoints by a whole order statistic.
test("the published threshold is the exact tail, not a float artefact", () => {
  const comparisons = agreeing(8, 5, 10);
  const fit = fitOf(comparisons);
  assert.equal(bootstrapStrengths(comparisons, fit, quick).threshold, 0.025);
  assert.equal(bootstrapStrengths(comparisons, fit, { ...quick, confidence: 0.9 }).threshold, 0.05);
  assert.equal(bootstrapStrengths(comparisons, fit, { ...quick, confidence: 0.8 }).threshold, 0.1);
  assert.equal(bootstrapStrengths(comparisons, fit, { ...quick, confidence: 0.99 }).threshold, 0.005);
  const wide = bootstrapStrengths(comparisons, fit, { ...quick, confidence: 0.99 });
  const narrow = bootstrapStrengths(comparisons, fit, { ...quick, confidence: 0.8 });
  for (let i = 0; i < wide.intervals.length; i++) {
    const w = wide.intervals[i] as { low: number; high: number };
    const n = narrow.intervals[i] as { low: number; high: number };
    assert.ok(w.low <= n.low && w.high >= n.high, "more confidence has to mean a wider interval");
  }
  assert.equal(bootstrapStrengths(comparisons, fit, quick).resolution, 1 / 60);
});

test("an undisputed winner is called, and a coin toss is not", () => {
  const clear = [
    ...Array.from({ length: 12 }, (_x, i) => cmp(`w${i}`, `j${i % 6}`, "a", "b", "a")),
    ...Array.from({ length: 12 }, (_x, i) => cmp(`v${i}`, `j${i % 6}`, "b", "c", "b")),
    ...Array.from({ length: 12 }, (_x, i) => cmp(`u${i}`, `j${i % 6}`, "a", "c", "a")),
  ];
  const boot = bootstrapStrengths(clear, fitOf(clear), quick);
  assert.equal(boot.intervals[0]?.project, "a");
  assert.equal(boot.intervals[0]?.firstPlaceShare, 1);
  assert.equal(boot.intervals[0]?.rankStability, 1);
  assert.equal(boot.intervals[0]?.sharesTier, 0);
  assert.equal(boot.decisive, true);
  assert.equal(boot.tiers, 3);
  assert.equal(boot.orderAgreement, 1);
  assert.equal(boot.orderStability, 1);

  // Six judges who split every pair down the middle establish nothing at all.
  const split = Array.from({ length: 24 }, (_x, i) =>
    cmp(`s${i}`, `j${i % 6}`, "a", "b", i % 2 === 0 ? "a" : "b"));
  const tossup = bootstrapStrengths(split, fitOf(split), quick);
  assert.equal(tossup.decisive, false);
  assert.equal(tossup.tiers, 1);
  assert.equal(tossup.intervals[0]?.sharesTier, 1);
  assert.ok(tossup.notes.some((n) => n.code === "bootstrap.tiedTop"));
  assert.ok(
    (tossup.warnings.join(" ") + "").includes("statistically indistinguishable"),
    "the tied-top warning is the sentence a results page quotes",
  );
});

// The case the cluster bootstrap exists for. Four judges are certain a is better than b
// and four are equally certain of the opposite, and the two units answer two different
// questions about that panel: resampling decisions says the pair is a dead heat, because
// forty wins each is a very stable forty wins each. Resampling judges says the gap could
// be anything, because a panel drawn from this pool might contain six of one camp.
test("a split panel is seen by the judge resample and missed by the comparison one", () => {
  const split: Comparison[] = [];
  for (let j = 0; j < 8; j++) {
    const winner = (j < 4 ? "a" : "b") as ProjectId;
    for (let k = 0; k < 10; k++) split.push(cmp(`d${j}-${k}`, `j${j}`, "a", "b", winner));
  }
  const fit = fitOf(split);
  const panel = bootstrapStrengths(split, fit, { replicates: 200, unit: "judge" });
  const decisions = bootstrapStrengths(split, fit, { replicates: 200, unit: "comparison" });
  const spread = (b: BootstrapResult): number => mean(b.intervals.map((iv) => iv.standardError));
  assert.ok(
    spread(panel) > spread(decisions) * 2,
    `panel ${spread(panel).toFixed(3)} should dwarf decisions ${spread(decisions).toFixed(3)}`,
  );
  // Neither unit is allowed to call this pair, and for the same reason from both sides.
  assert.equal(panel.decisive, false);
  assert.equal(decisions.decisive, false);
  assert.equal(panel.tiers, 1);
  assert.ok(panel.intervals[0]?.firstPlaceShare as number < 0.75, "first place is a coin toss here");
});

// On an ordinary panel the two units land within a few percent of each other, in either
// direction: clustering carries between-judge disagreement in and keeps the per-project
// thinning out, and which effect wins depends on the design. The property worth pinning
// is therefore that the unit reaches the resample at all, not that it widens it.
test("the resampling unit changes the intervals and is reported", () => {
  const event = simulateEvent({ projects: 20, judges: 8, seed: "boot.unit" });
  const comparisons = simulateComparisons(event, { perJudge: 15, seed: "boot.unit", taste: 0.5 });
  const fit = fitOf(comparisons, event.projects);
  const panel = bootstrapStrengths(comparisons, fit, { ...quick, unit: "judge" });
  const decisions = bootstrapStrengths(comparisons, fit, { ...quick, unit: "comparison" });
  assert.equal(panel.unit, "judge");
  assert.equal(panel.unitRequested, "judge");
  assert.equal(decisions.unit, "comparison");
  assert.ok(panel.method.includes("judge"));
  assert.ok(decisions.method.includes("comparison"));
  assert.notDeepEqual(
    panel.intervals.map((iv) => iv.standardError),
    decisions.intervals.map((iv) => iv.standardError),
  );
  const ratio = mean(panel.intervals.map((iv) => iv.standardError)) /
    mean(decisions.intervals.map((iv) => iv.standardError));
  assert.ok(ratio > 0.75 && ratio < 1.35, `the two units diverged by more than measured: ${ratio.toFixed(3)}`);
});

test("one judge cannot be resampled as a panel, and the result says so", () => {
  const solo = Array.from({ length: 20 }, (_x, i) =>
    cmp(`o${i}`, "only", `p${i % 5}` as ProjectId, `p${(i + 1) % 5}` as ProjectId, `p${i % 5}` as ProjectId));
  const boot = bootstrapStrengths(solo, fitOf(solo), quick);
  assert.equal(boot.unitRequested, "judge");
  assert.equal(boot.unit, "comparison");
  const note = boot.notes.find((n) => n.code === "bootstrap.singleJudge");
  assert.equal(note?.severity, "warn");
  assert.deepEqual(note?.subjects, ["only"]);
  assert.ok(note?.message.includes("say nothing about whether another judge would agree"));
});

// A replicate has to be fitted by the estimator that produced the published number. The
// prior is the one setting that changes where a thin record lands, and it reaches this
// module only through the fit's `method` string.
test("the replicate fits inherit the prior the estimate was fitted with", () => {
  const comparisons = agreeing(8, 5, 10);
  const strong = fitBradleyTerry(comparisons, undefined, { prior: 5 });
  assert.ok(strong.method.includes("prior=5"));
  const inherited = bootstrapStrengths(comparisons, strong, quick);
  assert.ok(inherited.method.includes("prior=5"), `method was ${inherited.method}`);
  const overridden = bootstrapStrengths(comparisons, strong, { ...quick, prior: 0.25 });
  assert.ok(overridden.method.includes("prior=0.25"));
  const spreadWide = mean(inherited.intervals.map((iv) => iv.standardError));
  const spreadTight = mean(overridden.intervals.map((iv) => iv.standardError));
  assert.notEqual(spreadWide, spreadTight, "the prior has to reach the replicates");
  // An unreadable method string is not a crash; it falls back to the engine default.
  const mangled = bootstrapStrengths(comparisons, { ...strong, method: "who knows" }, quick);
  assert.ok(mangled.method.includes("prior=1"));
});

test("the work budget cuts replicates before fitting, and reports the coarser resolution", () => {
  const event = simulateEvent({ projects: 20, judges: 8, seed: "boot.budget" });
  const comparisons = simulateComparisons(event, { perJudge: 10, seed: "boot.budget" });
  const fit = fitOf(comparisons, event.projects);
  const cut = bootstrapStrengths(comparisons, fit, { replicates: 400, workBudget: 5000 });
  assert.ok(cut.replicates < 400, `budget did not bite: ${cut.replicates}`);
  assert.equal(cut.replicatesRequested, 400);
  assert.ok(cut.replicates >= BOOTSTRAP_DEFAULTS.minReplicates);
  assert.equal(cut.resolution, 1 / cut.replicates);
  const note = cut.notes.find((n) => n.code === "bootstrap.replicatesReduced");
  assert.equal(note?.severity, "info");
  assert.ok(note?.message.includes("finest share resolvable"));
  // Asking for fewer than the floor is honoured: the floor stops the budget cutting too
  // deep, and is not a second opinion about what the caller wanted.
  const tiny = bootstrapStrengths(comparisons, fit, { replicates: 10, workBudget: 1 });
  assert.equal(tiny.replicates, 10);
  assert.equal(tiny.notes.some((n) => n.code === "bootstrap.replicatesReduced"), false);
  // A realistic event is never cut by the default budget.
  const roomy = bootstrapStrengths(comparisons, fit, quick);
  assert.equal(roomy.replicates, 60);
});

// A project nobody compared is the trap this module has to survive: the prior pins it at
// the middle of the field, so it is the *steadiest* row in the table and a naive report
// would print the narrowest interval in the event next to the one project there is no
// evidence about at all. It keeps its row, and everything that would read as an ordering
// claim is withheld.
test("a project with no comparisons is carried, and never ordered", () => {
  const comparisons = agreeing(8, 5, 10);
  const withGhost = [...new Set(comparisons.flatMap((c) => [c.left, c.right])), "ghost"] as ProjectId[];
  const fit = fitBradleyTerry(comparisons, withGhost);
  const boot = bootstrapStrengths(comparisons, fit, quick);
  const ghost = boot.intervals.find((iv) => iv.project === "ghost");
  assert.ok(ghost, "the ghost dropped out of the table");
  assert.equal(ghost?.comparisons, 0);
  assert.equal(ghost?.placed, false);
  assert.equal(ghost?.beta, fit.strengths.find((s) => s.project === "ghost")?.beta);
  assert.equal(boot.unplaced, 1);
  assert.equal(ghost?.tier, 0, "no evidence means no tier, not a tier of its own");
  assert.equal(ghost?.sharesTier, 0, "it is the only unplaced project here");

  // The pathology, pinned so that a future change that starts trusting this row fails
  // here: its standard error is the smallest in the field by a wide margin, because the
  // only thing that moves it is the centring of everybody else.
  const others = boot.intervals.filter((iv) => iv.placed).map((iv) => iv.standardError);
  assert.ok(
    (ghost?.standardError as number) < Math.min(...others),
    `the ghost was not the steadiest row: ${ghost?.standardError} against ${Math.min(...others)}`,
  );
  assert.equal(ghost?.rankStability, 1, "the prior holds it in one place all weekend");

  // And none of that leaks into the ordering claims.
  assert.equal(boot.pairs.some((p) => p.above === "ghost" || p.below === "ghost"), false);
  assert.equal(
    boot.pairs.length,
    boot.intervals.filter((iv) => iv.placed).length - 1,
    "the pair walk covers the compared field and nothing else",
  );
  const note = boot.notes.find((n) => n.code === "bootstrap.unplaced");
  assert.equal(note?.severity, "warn");
  assert.deepEqual(note?.subjects, ["ghost"]);
  // Substring chosen to start mid-sentence: the note has been reworded twice and the advice is
  // what this test cares about, not whether it lands at the head of a sentence.
  assert.ok(note?.message.includes("only fix is comparisons"), note?.message);

  // Removing the ghost from the field must leave the tiers and pairs of the projects that
  // were compared as they were: an unplaced row cannot certify a boundary. The reversal
  // shares are compared loosely because the two fits start from differently centred
  // strengths and stop at a tolerance, not because the walk is allowed to wander.
  const without = bootstrapStrengths(comparisons, fitBradleyTerry(comparisons), quick);
  assert.equal(without.tiers, boot.tiers);
  assert.equal(without.unplaced, 0);
  assert.deepEqual(
    without.pairs.map((p) => [p.above, p.below]),
    boot.pairs.map((p) => [p.above, p.below]),
  );
  without.pairs.forEach((p, i) => {
    assert.ok(
      Math.abs(p.reversalShare - ((boot.pairs[i] as { reversalShare: number }).reversalShare)) < 0.05,
      `${p.above}/${p.below} moved from ${(boot.pairs[i] as { reversalShare: number }).reversalShare} to ${p.reversalShare}`,
    );
  });
  assert.ok(Math.abs(without.orderAgreement - boot.orderAgreement) < 0.02);
});

test("a thin panel is reported as thin rather than smoothed over", () => {
  const event = simulateEvent({ projects: 30, judges: 6, seed: "boot.thin" });
  const comparisons = simulateComparisons(event, { perJudge: 8, seed: "boot.thin" });
  const boot = bootstrapStrengths(comparisons, fitOf(comparisons, event.projects), quick);
  assert.ok(boot.replicatesDisconnected > 0, "dropping judges from a thin panel should split the graph");
  const note = boot.notes.find((n) => n.code === "bootstrap.disconnectedReplicates");
  assert.ok(note?.message.includes("held apart by the prior rather than by"));
  assert.equal(boot.replicatesConverged, boot.replicates, "the shipped sweep cap should be enough");
  assert.ok(boot.orderAgreement < 1, "eight comparisons a judge cannot settle thirty projects");
  assert.ok(boot.orderAgreement > 0, "nor is it noise");
});

// More evidence has to buy more certainty. This is the property that would break first if
// the resample were wired up wrongly — a bug that draws from the wrong pool still produces
// plausible intervals, but they stop responding to the data.
test("more comparisons narrow the intervals", () => {
  const event = simulateEvent({ projects: 20, judges: 10, seed: "boot.volume" });
  const spread = (perJudge: number): number => {
    const comparisons = simulateComparisons(event, { perJudge, seed: "boot.volume" });
    const boot = bootstrapStrengths(comparisons, fitOf(comparisons, event.projects), quick);
    return mean(boot.intervals.map((iv) => iv.high - iv.low));
  };
  const few = spread(6);
  const many = spread(40);
  assert.ok(many < few, `intervals did not narrow: ${few.toFixed(3)} then ${many.toFixed(3)}`);
});

test("agreement and tiers move together as the evidence thickens", () => {
  const event = simulateEvent({ projects: 24, judges: 12, seed: "boot.tiers" });
  const at = (perJudge: number): BootstrapResult => {
    const comparisons = simulateComparisons(event, { perJudge, seed: "boot.tiers" });
    return bootstrapStrengths(comparisons, fitOf(comparisons, event.projects), quick);
  };
  const thin = at(6);
  const thick = at(40);
  assert.ok(thick.orderAgreement > thin.orderAgreement, "a bigger sample should agree with itself more");
  assert.ok(thick.tiers >= thin.tiers, "and resolve at least as many tiers");
  assert.ok(thick.tiers <= 24, "never more tiers than places");
  for (const boot of [thin, thick]) {
    assert.ok(boot.orderAgreement >= -1 && boot.orderAgreement <= 1);
    assert.ok(boot.orderStability >= 0 && boot.orderStability <= 1);
  }
});

test("every warning has a coded note behind it, and no note that is not one", () => {
  const event = simulateEvent({ projects: 18, judges: 5, seed: "boot.notes" });
  const comparisons = simulateComparisons(event, { perJudge: 8, seed: "boot.notes" });
  const boot = bootstrapStrengths(comparisons, fitOf(comparisons, event.projects), quick);
  const serious = boot.notes.filter((note) => note.severity === "warn");
  // Not `notes.length`. An earlier version of this assertion said every note was also a warning,
  // which is what the engine did and what made the confidence page print each diagnostic twice —
  // once as an objection and once as a note — with "the comparisons resolve 3 tiers" among the
  // objections. The test agreed with the code and both were wrong.
  assert.equal(boot.warnings.length, serious.length);
  assert.ok(serious.length > 0, "this field is thin enough that something should be flagged");
  for (const note of boot.notes) {
    assert.ok(note.code.startsWith("bootstrap."), `${note.code} is not namespaced`);
    assert.ok(note.severity === "info" || note.severity === "warn");
    assert.ok(note.message.length > 40, `${note.code} says too little to act on`);
    assert.equal(
      boot.warnings.includes(note.message),
      note.severity === "warn",
      `${note.code} is a ${note.severity} and belongs ${note.severity === "warn" ? "in" : "out of"} the warning list`,
    );
    assert.ok(Array.isArray(note.subjects));
  }
});

// A 99% interval from 60 draws is a request the resample cannot fill, and the failure is
// invisible in the numbers: the pair test silently hardens into "never reversed once" and
// the interval silently widens to the whole sample. Both would read as a panel that could
// not make up its mind rather than as a resolution limit, so the note is the fix.
test("a tail finer than one replicate is reported, not silently rounded", () => {
  const comparisons = agreeing(10, 6, 12);
  const fit = fitOf(comparisons);
  const coarse = bootstrapStrengths(comparisons, fit, { replicates: 60, confidence: 0.99 });
  assert.ok(coarse.threshold < coarse.resolution, "0.5% of a tail is finer than 1/60");
  const note = coarse.notes.find((n) => n.code === "bootstrap.coarse");
  assert.equal(note?.severity, "warn");
  assert.ok(note?.message.includes("at least 200 replicates"), note?.message);
  // The degeneracy the note describes, pinned so a future change to `quantile` or to the
  // pair test cannot quietly stop it being true while the note keeps claiming it.
  for (const pair of coarse.pairs) {
    assert.equal(pair.ordered, pair.reversalShare === 0, `${pair.above}/${pair.below} split the grid`);
  }
  const decided = bootstrapStrengths(comparisons, fit, { replicates: 400, confidence: 0.99 });
  assert.equal(decided.notes.some((n) => n.code === "bootstrap.coarse"), false);
  assert.ok(decided.threshold > decided.resolution);
  // Widening the interval instead of adding replicates is the other stated fix.
  const wider = bootstrapStrengths(comparisons, fit, { replicates: 60, confidence: 0.9 });
  assert.equal(wider.notes.some((n) => n.code === "bootstrap.coarse"), false);
});
