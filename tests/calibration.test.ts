import test from "node:test";
import assert from "node:assert/strict";

import type { Ballot, Comparison, ProjectId, Rubric } from "../src/judging/types.ts";
import { JudgingError } from "../src/judging/types.ts";
import { fitBradleyTerry } from "../src/judging/bradleyterry.ts";
import { normalizeScores } from "../src/judging/normalize.ts";
import { panelReliability } from "../src/judging/reliability.ts";
import { judgeCalibration, CALIBRATION_DEFAULTS } from "../src/judging/calibration.ts";
import type { CalibrationInput, CalibrationResult, JudgeWorkload } from "../src/judging/calibration.ts";
import { simulateComparisons, simulateEvent } from "../src/judging/simulate.ts";

/** A two-line rubric on a 1-5 scale, so a span is 8 and a fraction of it is easy to read. */
const RUBRIC: Rubric = {
  id: "r",
  version: 1,
  criteria: [
    { key: "craft", label: "Craft", weight: 1, min: 1, max: 5 },
    { key: "idea", label: "Idea", weight: 1, min: 1, max: 5 },
  ],
};

const ballot = (judge: string, project: string, craft: number, idea: number): Ballot =>
  ({ id: `${judge}-${project}`, judge, project, rubricVersion: 1, scores: { craft, idea } });

const cmp = (id: string, judge: string, left: ProjectId, right: ProjectId, winner: ProjectId): Comparison =>
  ({ id, judge, left, right, winner });

const work = (judge: string, over: Partial<JudgeWorkload> = {}): JudgeWorkload =>
  ({ judge, assigned: 0, submitted: 0, drafts: 0, skipped: 0, ...over });

/** Everything optional off, so a test says which half of the report it is exercising. */
const input = (over: Partial<CalibrationInput>): CalibrationInput => ({
  rubric: RUBRIC,
  ballots: [],
  comparisons: [],
  workload: [],
  rubricFit: null,
  pairwiseFit: null,
  reliability: null,
  ...over,
});

const row = (out: CalibrationResult, judge: string) =>
  out.judges.find((r) => r.judge === judge) as CalibrationResult["judges"][number];

const codes = (out: CalibrationResult): string[] => out.notes.map((n) => n.code);

test("the defaults are the documented ones", () => {
  assert.equal(CALIBRATION_DEFAULTS.minBallots, 3);
  assert.equal(CALIBRATION_DEFAULTS.minComparisons, 5);
  assert.equal(CALIBRATION_DEFAULTS.narrowSpan, 0.3);
  assert.equal(CALIBRATION_DEFAULTS.offsetShare, 0.15);
  assert.equal(CALIBRATION_DEFAULTS.surpriseRatio, 1.5);
  assert.equal(CALIBRATION_DEFAULTS.cycleRate, 0.15);
  assert.equal(CALIBRATION_DEFAULTS.minTriples, 8);
  assert.equal(CALIBRATION_DEFAULTS.blocExcess, 0.2);
  assert.equal(CALIBRATION_DEFAULTS.blocLevel, 0.05);
  assert.equal(CALIBRATION_DEFAULTS.minShared, 4);
  assert.equal(CALIBRATION_DEFAULTS.maxBlocs, 8);
  assert.equal(CALIBRATION_DEFAULTS.skipShare, 0.3);
});

test("an empty roster is refused, because a report about nobody is a bug in the caller", () => {
  assert.throws(() => judgeCalibration(input({})), (e: unknown) => {
    assert.ok(e instanceof JudgingError);
    assert.equal(e.code, "calibration.empty");
    return true;
  });
});

test("a judge listed twice is refused", () => {
  assert.throws(
    () => judgeCalibration(input({ workload: [work("j1"), work("j1")] })),
    (e: unknown) => {
      assert.ok(e instanceof JudgingError);
      assert.equal(e.code, "calibration.duplicateJudge");
      return true;
    },
  );
});

test("a ballot against another rubric version is refused", () => {
  const stale: Ballot = { ...ballot("j1", "p1", 3, 3), rubricVersion: 2 };
  assert.throws(
    () => judgeCalibration(input({ workload: [work("j1")], ballots: [stale] })),
    (e: unknown) => {
      assert.ok(e instanceof JudgingError);
      assert.equal(e.code, "ballot.rubricVersion");
      return true;
    },
  );
});

test("a judge off the roster is named rather than thrown at", () => {
  // This pass is read during an appeal. A stray row means the caller assembled the input by
  // hand and got it wrong, and a 500 at that moment is worse for the organizer than a sentence
  // saying the two halves disagree about who judged.
  const out = judgeCalibration(
    input({
      workload: [work("j1", { assigned: 1, submitted: 1 })],
      ballots: [ballot("j1", "p1", 3, 3), ballot("ghost", "p1", 5, 5)],
    }),
  );
  assert.equal(out.judges.length, 1);
  const note = out.notes.find((n) => n.code === "calibration.strays");
  assert.ok(note);
  assert.equal(note.severity, "warn");
  assert.deepEqual(note.subjects, ["ghost"]);
});

test("a judge with nothing assigned and nothing filed is a roster question, not a calibration one", () => {
  const out = judgeCalibration(input({ workload: [work("idle")] }));
  const r = row(out, "idle");
  assert.equal(r.verdict, "check");
  assert.equal(r.ballots, 0);
  assert.equal(r.centre, null);
  assert.equal(r.scale, null);
  assert.equal(r.surprise, null);
  assert.ok(codes(out).includes("judge.noWork"));
  assert.match(r.action, /take them off the roster/);
});

test("outstanding work outranks everything else, because the figures under it are a draft", () => {
  // j1's ballots are flat, which is a finding on its own. It is still not the first thing to do
  // about j1: four of their seven projects are unscored, so every figure in the row will move.
  const ballots = [1, 2, 3].map((n) => ballot("j1", `p${n}`, 3, 3));
  const out = judgeCalibration(
    input({
      workload: [work("j1", { assigned: 7, submitted: 3 })],
      ballots,
      rubricFit: normalizeScores(RUBRIC, ballots),
    }),
  );
  const r = row(out, "j1");
  assert.equal(r.outstanding, 4);
  assert.equal(r.verdict, "behind");
  assert.match(r.action, /Chase the 4 ballots/);
  // The rest was still noticed. A verdict decides the action column, never the findings.
  assert.ok(r.findings.some((f) => f === "judge.narrowSpan"));
});

test("a judge who filed more than they were assigned is at zero outstanding, not below it", () => {
  const out = judgeCalibration(
    input({
      workload: [work("j1", { assigned: 1, submitted: 3 })],
      ballots: [1, 2, 3].map((n) => ballot("j1", `p${n}`, n, n)),
    }),
  );
  assert.equal(row(out, "j1").outstanding, 0);
  assert.equal(row(out, "j1").verdict, "ok");
});

test("thin is not ok: too little on file is its own state", () => {
  const out = judgeCalibration(
    input({ workload: [work("j1", { assigned: 2, submitted: 2 })], ballots: [ballot("j1", "p1", 2, 2), ballot("j1", "p2", 4, 4)] }),
  );
  const r = row(out, "j1");
  assert.equal(r.verdict, "thin");
  assert.match(r.action, /Too little on file/);
  assert.ok(codes(out).includes("calibration.thin"));
});

test("centre, span and leniency are fractions of the weighted span", () => {
  // Two criteria weighted equally on 1-5 means a total between 1 and 5, and a span of 4. A judge
  // scoring 2 and 4 sits at 3 — the middle — and uses half the card.
  const ballots = [ballot("j1", "p1", 2, 2), ballot("j1", "p2", 4, 4), ballot("j1", "p3", 3, 3)];
  const out = judgeCalibration(input({ workload: [work("j1", { assigned: 3, submitted: 3 })], ballots }));
  const r = row(out, "j1");
  assert.equal(out.span, 4);
  assert.equal(r.centre, 0.5);
  assert.equal(r.spanUsed, 0.5);
  // One judge is the whole panel, so there is nothing for them to be lenient against. Null rather
  // than zero: zero would say the offset was measured and found neutral.
  assert.equal(r.leniency, null);
  assert.equal(r.leniencyShare, null);
});

test("a judge who marks everything the same is named for it, and told what it costs", () => {
  const ballots = ["p1", "p2", "p3", "p4"].map((p) => ballot("flat", p, 4, 4));
  const out = judgeCalibration(
    input({ workload: [work("flat", { assigned: 4, submitted: 4 })], ballots, rubricFit: normalizeScores(RUBRIC, ballots) }),
  );
  const r = row(out, "flat");
  assert.equal(r.spanUsed, 0);
  assert.ok(r.findings.includes("judge.narrowSpan"));
  const note = out.notes.find((n) => n.code === "judge.narrowSpan");
  assert.ok(note);
  assert.deepEqual(note.subjects, ["flat"]);
});

test("a strict judge and a generous one are offset in opposite directions by the same amount", () => {
  const ballots = [
    ballot("mean", "p1", 1, 1),
    ballot("mean", "p2", 2, 2),
    ballot("mean", "p3", 3, 3),
    ballot("kind", "p1", 3, 3),
    ballot("kind", "p2", 4, 4),
    ballot("kind", "p3", 5, 5),
  ];
  const out = judgeCalibration(
    input({
      workload: [work("mean", { assigned: 3, submitted: 3 }), work("kind", { assigned: 3, submitted: 3 })],
      ballots,
      rubricFit: normalizeScores(RUBRIC, ballots),
    }),
  );
  const strict = row(out, "mean");
  const kind = row(out, "kind");
  assert.equal(strict.leniency, -1);
  assert.equal(kind.leniency, 1);
  assert.equal(strict.leniencyShare, -0.25);
  assert.equal(kind.leniencyShare, 0.25);
  // Both are handled by the fit's own centring, which is why the finding is an info and its
  // advice says to do nothing.
  for (const judge of ["mean", "kind"]) {
    const r = row(out, judge);
    assert.ok(r.findings.includes("judge.offset"));
    assert.equal(r.verdict, "ok");
    assert.match(r.action, /No action/);
  }
  const note = out.notes.find((n) => n.code === "judge.offset");
  assert.ok(note);
  assert.equal(note.severity, "info");
});

test("an unfitted slope is reported, and the two reasons for one are told apart", () => {
  // `insufficient` covers two facts in the fit: too few ballots to fit a slope, and enough
  // ballots on projects the panel could not separate. Both hold the slope at 1.00, which is
  // indistinguishable from a judge who agrees with the panel exactly, so both have to be said.
  // Only the second is escalated — the first is what `thin` already means.
  const ballots: Ballot[] = [];
  const tiers: Record<string, [number, number]> = {
    p1: [5, 5], p2: [5, 5], p3: [5, 5], p4: [2, 2], p5: [2, 3], p6: [3, 2],
  };
  for (const j of ["a", "b", "c"]) {
    for (const [p, score] of Object.entries(tiers)) ballots.push(ballot(j, p, score[0], score[1]));
  }
  // Three ballots is over the floor, and all three projects fit to the same quality.
  for (const p of ["p1", "p2", "p3"]) ballots.push(ballot("flat", p, 4, 4));
  // Two is under it. Kept off the tied projects so it does not break their tie.
  for (const p of ["p4", "p5"]) ballots.push(ballot("few", p, 4, 3));

  const filed = new Map<string, number>();
  for (const b of ballots) filed.set(b.judge, (filed.get(b.judge) ?? 0) + 1);
  const fit = normalizeScores(RUBRIC, ballots);
  const out = judgeCalibration(
    input({
      ballots,
      rubricFit: fit,
      workload: [...filed].map(([j, n]) => work(j, { assigned: n, submitted: n })),
    }),
  );

  for (const judge of ["flat", "few"]) {
    assert.equal(row(out, judge).discrimination, "insufficient");
    assert.equal(row(out, judge).scale, 1);
    assert.ok(row(out, judge).findings.includes("judge.noSlope"));
  }
  // A flat draw is a finding about the assignment that nothing else on the page shows.
  assert.equal(row(out, "flat").verdict, "check");
  assert.equal(out.warnings.filter((w) => w.includes("judge flat") || w.includes("Judge flat")).length, 1);
  assert.match(row(out, "flat").action, /look at the draw/);
  // Too few ballots is not escalated: the verdict and the ballot count say it already.
  assert.equal(row(out, "few").verdict, "thin");
  assert.equal(out.warnings.filter((w) => w.includes("Judge few")).length, 0);
  assert.match(row(out, "few").action, /No action/);

  // The pairing that lets the dashboard print each judge's findings in one place: every judge the
  // fit warned about by name has a calibration row that says the same thing in its own words.
  const named = fit.notes.filter((n) => n.severity === "warn" && n.subjects.length > 0);
  assert.deepEqual(named.map((n) => n.code).sort(), ["judge.fewBallots", "judge.flatAssignment"]);
  for (const note of named) {
    for (const subject of note.subjects) assert.ok(row(out, subject).findings.length > 0);
  }
});

test("without a rubric fit the ballot columns are still measured and the fitted ones are null", () => {
  const out = judgeCalibration(
    input({
      workload: [work("j1", { assigned: 3, submitted: 3 })],
      ballots: [ballot("j1", "p1", 2, 2), ballot("j1", "p2", 4, 4), ballot("j1", "p3", 3, 3)],
    }),
  );
  const r = row(out, "j1");
  assert.equal(r.centre, 0.5);
  assert.equal(r.scale, null);
  assert.equal(r.discrimination, null);
  assert.equal(r.spreadRelative, null);
  assert.equal(r.outliers, 0);
});

test("with no duels the pairwise half says so once rather than nulling silently", () => {
  const out = judgeCalibration(
    input({ workload: [work("j1", { assigned: 3, submitted: 3 })], ballots: [1, 2, 3].map((n) => ballot("j1", `p${n}`, n, n)) }),
  );
  assert.equal(out.panelSurprise, null);
  assert.equal(out.heldOut, 0);
  assert.equal(out.blocs.length, 0);
  assert.equal(out.panelExcess, null);
  const note = out.notes.find((n) => n.code === "calibration.noPairwise");
  assert.ok(note);
  assert.equal(note.severity, "info");
  assert.match(note.message, /no duels on this event/);
});

test("skipping more than a third of what was offered is named, and blamed on the scheduler first", () => {
  const duels = [
    cmp("c1", "j1", "p1", "p2", "p1"),
    cmp("c2", "j1", "p1", "p3", "p1"),
    cmp("c3", "j1", "p2", "p3", "p2"),
  ];
  const out = judgeCalibration(
    input({
      workload: [work("j1", { assigned: 3, submitted: 3, skipped: 9 })],
      ballots: [1, 2, 3].map((n) => ballot("j1", `p${n}`, n, n)),
      comparisons: duels,
      pairwiseFit: fitBradleyTerry(duels),
    }),
  );
  const r = row(out, "j1");
  assert.equal(r.skipped, 9);
  assert.ok(r.findings.includes("judge.skips"));
  const note = out.notes.find((n) => n.code === "judge.skips");
  assert.ok(note);
  assert.equal(note.severity, "info");
  assert.match(note.message, /skipped 9 of 12/);
  // The blame goes in the advice, which is the sentence an organizer acts on: a scheduler that
  // keeps offering unseparable pairs is the likelier fault, and the judge is not the thing to fix.
  assert.match(r.action, /scheduler/);
});

test("a self-contradicting triple is counted as a cycle", () => {
  const duels = [
    cmp("c1", "j1", "p1", "p2", "p1"),
    cmp("c2", "j1", "p2", "p3", "p2"),
    cmp("c3", "j1", "p1", "p3", "p3"),
  ];
  const out = judgeCalibration(
    input({ workload: [work("j1")], comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
  );
  const r = row(out, "j1");
  assert.equal(r.closedTriples, 1);
  assert.equal(r.cycles, 1);
  assert.equal(r.cycleRate, 1);
  assert.ok(r.findings.includes("judge.cycles"));
});

test("one cycle on three closed triples is not a pattern, however the rate reads", () => {
  // The denominator has to earn the word. A judge with three closed triples cannot register a
  // single cycle without registering 33% of them, so the rate alone would escalate the minimum
  // possible evidence — which is how a report starts telling organizers to distrust a volunteer
  // over one close call.
  const duels = [
    cmp("c1", "j1", "p1", "p2", "p1"),
    cmp("c2", "j1", "p2", "p3", "p2"),
    cmp("c3", "j1", "p1", "p3", "p3"),
    cmp("c4", "j1", "p1", "p4", "p1"),
    cmp("c5", "j1", "p2", "p4", "p2"),
    cmp("c6", "j1", "p3", "p4", "p3"),
  ];
  const out = judgeCalibration(
    input({ workload: [work("j1")], comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
  );
  const r = row(out, "j1");
  assert.equal(r.cycles, 1);
  assert.equal(r.closedTriples, 4);
  const note = out.notes.find((n) => n.code === "judge.cycles");
  assert.ok(note);
  assert.equal(note.severity, "info");
  assert.equal(out.warnings.filter((w) => w.includes("contradicted")).length, 0);
  // The same rate over the floor does escalate, so the floor is the only thing holding it.
  const loud = judgeCalibration(
    input({ workload: [work("j1")], comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
    { minTriples: 4 },
  );
  const escalated = loud.notes.find((n) => n.code === "judge.cycles");
  assert.ok(escalated);
  assert.equal(escalated.severity, "warn");
  assert.match(escalated.message, /that is a pattern/);
});

test("a judge consistent with a total order produces no cycles at all", () => {
  const duels: Comparison[] = [];
  const ids = ["p1", "p2", "p3", "p4", "p5"];
  let n = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let k = i + 1; k < ids.length; k += 1) {
      duels.push(cmp(`c${(n += 1)}`, "j1", ids[i] as string, ids[k] as string, ids[i] as string));
    }
  }
  const out = judgeCalibration(
    input({ workload: [work("j1")], comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
  );
  const r = row(out, "j1");
  assert.equal(r.closedTriples, 10);
  assert.equal(r.cycles, 0);
  assert.equal(r.cycleRate, 0);
  assert.ok(!r.findings.includes("judge.cycles"));
});

test("surprise is measured against a fit that excludes the judge being measured", () => {
  // Three judges call the field one way and a fourth calls it the other way. Held out, the
  // fourth is surprising; in sample, their own votes are part of what they are measured against
  // and the figure is softer. The result says which of the two it did.
  const duels: Comparison[] = [];
  const pairs: readonly (readonly [string, string])[] = [
    ["p1", "p2"],
    ["p2", "p3"],
    ["p3", "p4"],
    ["p1", "p3"],
    ["p2", "p4"],
    ["p1", "p4"],
  ];
  let n = 0;
  for (const judge of ["a", "b", "c"]) {
    for (const [left, right] of pairs) duels.push(cmp(`c${(n += 1)}`, judge, left, right, left));
  }
  for (const [left, right] of pairs) duels.push(cmp(`c${(n += 1)}`, "contrarian", left, right, right));
  const out = judgeCalibration(
    input({ workload: ["a", "b", "c", "contrarian"].map((j) => work(j)), comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
  );
  assert.equal(out.heldOut, 4);
  assert.equal(out.inSample, 0);
  const odd = row(out, "contrarian");
  assert.equal(odd.heldOut, true);
  assert.equal(odd.against, 6);
  assert.ok((odd.surpriseRatio as number) > CALIBRATION_DEFAULTS.surpriseRatio);
  assert.ok(odd.findings.includes("judge.offConsensus"));
  assert.equal(row(out, "a").findings.includes("judge.offConsensus"), false);
  const note = out.notes.find((n2) => n2.code === "judge.offConsensus");
  assert.ok(note);
  assert.equal(note.severity, "warn");
  assert.deepEqual(note.subjects, ["contrarian"]);
  assert.ok(out.notes.some((n2) => n2.code === "calibration.heldOut"));
});

test("a judge whose removal breaks the field is measured in sample and says so", () => {
  // Only one judge has decided anything, so there is no fit without them: the leave-one-out
  // refit has nothing to converge on and the row falls back, rather than reporting a surprise
  // against a model built from no evidence.
  const duels = [
    cmp("c1", "solo", "p1", "p2", "p1"),
    cmp("c2", "solo", "p2", "p3", "p2"),
    cmp("c3", "solo", "p1", "p3", "p1"),
  ];
  const out = judgeCalibration(
    input({ workload: [work("solo")], comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
  );
  assert.equal(out.heldOut, 0);
  assert.equal(out.inSample, 1);
  assert.equal(row(out, "solo").heldOut, false);
});

/**
 * An honest simulated panel, and optionally two extra judges who decide every pair by project id.
 *
 * Id order is a rule no rubric names and no consensus can express, which is what a bloc looks
 * like from outside: not two judges who are wrong, two judges who are right together about
 * something the evidence does not contain. Building it on top of a real simulated panel rather
 * than a hand-written one is deliberate — the interaction is the hard part, because a bloc large
 * enough to matter is also large enough to drag the fit it is measured against.
 */
function panel(seed: string, options: { bloc?: number; taste?: number } = {}): CalibrationResult {
  const ev = simulateEvent({ projects: 12, judges: 5, reviewsPerProject: 4, seed, flatJudges: 0 });
  const honest = simulateComparisons(ev, { perJudge: 14, taste: options.taste ?? 0.6, seed: `${seed}|pairs` });
  const bloc: Comparison[] = [];
  const ids = ev.projects.slice().sort();
  let n = 0;
  for (let i = 0; i < ids.length && n < (options.bloc ?? 0); i += 1) {
    for (let k = i + 1; k < ids.length && n < (options.bloc ?? 0); k += 1) {
      for (const judge of ["x", "y"]) {
        bloc.push({ id: `bloc-${judge}-${n}`, judge, left: ids[i] as string, right: ids[k] as string, winner: ids[i] as string });
      }
      n += 1;
    }
  }
  const duels = [...honest, ...bloc];
  const fit = normalizeScores(ev.rubric, ev.ballots);
  const filed = new Map<string, number>();
  for (const b of ev.ballots) filed.set(b.judge, (filed.get(b.judge) ?? 0) + 1);
  const roster = ev.judges.map((j) => work(j.id, { assigned: filed.get(j.id) ?? 0, submitted: filed.get(j.id) ?? 0 }));
  if (n > 0) for (const judge of ["x", "y"]) roster.push(work(judge));
  return judgeCalibration({
    rubric: ev.rubric,
    ballots: ev.ballots,
    comparisons: duels,
    workload: roster,
    rubricFit: fit,
    pairwiseFit: fitBradleyTerry(duels, ev.projects),
    reliability: panelReliability(ev.rubric, ev.ballots, fit),
  });
}

test("a bloc that shares a rule no consensus predicts is asked about", () => {
  const out = panel("planted", { bloc: 24 });
  const asked = out.blocs.filter((p) => p.asked);
  assert.equal(asked.length, 1);
  const pair = asked[0] as (typeof out.blocs)[number];
  assert.deepEqual([pair.a, pair.b], ["x", "y"]);
  assert.equal(pair.shared, 24);
  assert.equal(pair.agreed, 24);
  assert.equal(pair.share, 1);
  assert.ok(pair.pValue <= pair.level);
  assert.ok(pair.excess >= CALIBRATION_DEFAULTS.blocExcess);
  // Said once, from the pair, with both judges as its subjects — not once from each row.
  const notes = out.notes.filter((nn) => nn.code === "calibration.bloc");
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0]?.subjects, ["x", "y"]);
  assert.equal(notes[0]?.severity, "warn");
  assert.match(notes[0]?.message ?? "", /agreed on 24 of them/);
  assert.match(notes[0]?.message ?? "", /once in \d+ panels/);
  // Both rows still carry the finding, so neither reads as clean.
  for (const judge of ["x", "y"]) {
    assert.ok(row(out, judge).findings.includes("calibration.bloc"));
    assert.equal(row(out, judge).verdict, "check");
  }
});

test("a pair of ordinary judges on a handful of shared pairs is not asked about", () => {
  // The measure's real failure mode, and the reason for all three corrections: a simulated panel
  // with no coordination in it at all, where the uncorrected form asked about three pairs of ten.
  // The report should still print the pairs, so an organizer can see what ordinary overlap looks
  // like, and should ask about none of them.
  const out = panel("smoke");
  assert.ok(out.blocs.length >= 5);
  assert.equal(out.blocs.filter((p) => p.asked).length, 0);
  assert.equal(out.notes.filter((n) => n.code === "calibration.bloc").length, 0);
  // Two pairs do clear the fixed threshold on their own, and the tail is what stops them. If this
  // assertion ever fails the test has stopped covering the thing it was written for.
  assert.equal(out.blocs.filter((p) => p.excess >= CALIBRATION_DEFAULTS.blocExcess).length, 2);
  assert.ok(out.panelExcess !== null);
  // The level the table paid for. Five judges offer ten pairs and all ten clear the shared-pair
  // floor, so the divisor is ten even though `maxBlocs` shows eight: the correction is for the
  // number of tests performed, and quoting the number displayed instead would let a longer table
  // buy a laxer threshold for the rows at the top of it.
  assert.equal(out.blocs.length, CALIBRATION_DEFAULTS.maxBlocs);
  assert.equal(out.blocLevel, 0.05 / 10);
});

test("a clean panel is not asked about however many pairs it offers", () => {
  // Thirty events with no private taste at all, which is thirty panels where a bloc question is
  // definitionally a false positive. The per-pair form of this test raised one on twelve of them.
  let asked = 0;
  for (let s = 0; s < 30; s += 1) asked += panel(`fp${s}`, { taste: 0 }).blocs.filter((p) => p.asked).length;
  assert.equal(asked, 0);
});

test("a pair below the shared-pair floor is not quoted at all", () => {
  const duels = [
    cmp("c1", "a", "p1", "p2", "p1"),
    cmp("c2", "a", "p2", "p3", "p2"),
    cmp("c3", "a", "p1", "p3", "p1"),
    cmp("c4", "b", "p1", "p2", "p1"),
    cmp("c5", "b", "p2", "p3", "p2"),
    cmp("c6", "b", "p1", "p3", "p1"),
  ];
  const out = judgeCalibration(
    input({ workload: [work("a"), work("b")], comparisons: duels, pairwiseFit: fitBradleyTerry(duels) }),
  );
  assert.equal(out.blocs.length, 0);
  assert.equal(out.panelExcess, null);
});

test("the rows come out worst first, and a clean panel is said to be clean", () => {
  const ballots = [
    ballot("a", "p1", 2, 2),
    ballot("a", "p2", 4, 4),
    ballot("a", "p3", 3, 3),
    ballot("b", "p1", 2, 3),
    ballot("b", "p2", 4, 5),
    ballot("b", "p3", 3, 3),
  ];
  const out = judgeCalibration(
    input({
      workload: [work("a", { assigned: 3, submitted: 3 }), work("b", { assigned: 3, submitted: 3 })],
      ballots,
      rubricFit: normalizeScores(RUBRIC, ballots),
    }),
  );
  assert.deepEqual(out.judges.map((r) => r.verdict), ["ok", "ok"]);
  assert.equal(out.warnings.length, 0);
  const note = out.notes.find((n) => n.code === "calibration.clean");
  assert.ok(note);
  assert.equal(note.severity, "info");
});

test("verdict order puts behind before check, check before thin, and ok last", () => {
  const ballots = [
    ballot("late", "p1", 3, 3),
    ballot("late", "p2", 2, 4),
    ballot("late", "p3", 4, 2),
    ballot("fine", "p1", 2, 2),
    ballot("fine", "p2", 4, 4),
    ballot("fine", "p3", 3, 3),
    ballot("scant", "p1", 3, 3),
  ];
  const out = judgeCalibration(
    input({
      workload: [
        work("fine", { assigned: 3, submitted: 3 }),
        work("scant", { assigned: 1, submitted: 1 }),
        work("late", { assigned: 6, submitted: 3 }),
        work("empty"),
      ],
      ballots,
      rubricFit: normalizeScores(RUBRIC, ballots),
    }),
  );
  assert.deepEqual(out.judges.map((r) => r.judge), ["late", "empty", "scant", "fine"]);
  assert.deepEqual(out.judges.map((r) => r.verdict), ["behind", "check", "thin", "ok"]);
});

test("every warning is a note, and no info reaches the warning list", () => {
  const ev = simulateEvent({ projects: 10, judges: 4, reviewsPerProject: 3, seed: "warn", flatJudges: 1 });
  const duels = simulateComparisons(ev, { perJudge: 10, taste: 0.4, seed: "warn|pairs" });
  const fit = normalizeScores(ev.rubric, ev.ballots);
  const filed = new Map<string, number>();
  for (const b of ev.ballots) filed.set(b.judge, (filed.get(b.judge) ?? 0) + 1);
  const out = judgeCalibration({
    rubric: ev.rubric,
    ballots: ev.ballots,
    comparisons: duels,
    workload: ev.judges.map((j, i) => work(j.id, {
      assigned: (filed.get(j.id) ?? 0) + (i === 0 ? 2 : 0),
      submitted: filed.get(j.id) ?? 0,
    })),
    rubricFit: fit,
    pairwiseFit: fitBradleyTerry(duels, ev.projects),
    reliability: panelReliability(ev.rubric, ev.ballots, fit),
  });
  const warned = out.notes.filter((n) => n.severity === "warn");
  assert.equal(warned.length, out.warnings.length);
  for (const n of warned) assert.ok(out.warnings.includes(n.message));
  for (const n of out.notes.filter((x) => x.severity === "info")) {
    assert.equal(out.warnings.includes(n.message), false);
  }
  // Every code is dotted and stable, and every subject names somebody on the roster.
  const roster = new Set(ev.judges.map((j) => j.id));
  for (const n of out.notes) {
    assert.match(n.code, /^[a-z]+\.[a-zA-Z]+$/);
    for (const s of n.subjects) assert.ok(roster.has(s), `${n.code} names ${s}`);
  }
});

test("the method string quotes the thresholds that decided the figures", () => {
  const out = judgeCalibration(input({ workload: [work("j1")] }));
  assert.match(out.method, /surprise>=1\.5x/);
  assert.match(out.method, /cycles>=0\.15 over 8 triples/);
  assert.match(out.method, /bloc>=0\.2 at 0\.05 over the table/);
  // Both halves of the bloc rule are in there, because either one alone is a different method:
  // an effect size with no level asks about coincidences, a level with no effect size asks about
  // differences too small to act on.
  assert.ok(out.method.includes(String(CALIBRATION_DEFAULTS.blocExcess)));
  assert.ok(out.method.includes(String(CALIBRATION_DEFAULTS.blocLevel)));
});

test("every row's action is a sentence, and every finding it names is in the notes", () => {
  const ev = simulateEvent({ projects: 12, judges: 5, reviewsPerProject: 4, seed: "action", flatJudges: 1 });
  const duels = simulateComparisons(ev, { perJudge: 12, taste: 0.5, seed: "action|pairs" });
  const fit = normalizeScores(ev.rubric, ev.ballots);
  const filed = new Map<string, number>();
  for (const b of ev.ballots) filed.set(b.judge, (filed.get(b.judge) ?? 0) + 1);
  const out = judgeCalibration({
    rubric: ev.rubric,
    ballots: ev.ballots,
    comparisons: duels,
    workload: ev.judges.map((j) => work(j.id, { assigned: filed.get(j.id) ?? 0, submitted: filed.get(j.id) ?? 0 })),
    rubricFit: fit,
    pairwiseFit: fitBradleyTerry(duels, ev.projects),
    reliability: panelReliability(ev.rubric, ev.ballots, fit),
  });
  const seen = new Set(out.notes.map((n) => n.code));
  for (const r of out.judges) {
    assert.ok(r.action.length > 20, `${r.judge} has no action`);
    assert.match(r.action, /[.?]$/);
    for (const f of r.findings) assert.ok(seen.has(f), `${r.judge} names ${f}, which is in no note`);
  }
});
