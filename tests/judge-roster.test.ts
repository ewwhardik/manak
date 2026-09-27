import test from "node:test";
import assert from "node:assert/strict";

import { assignProject, assignmentsOf, ballotsOf, saveBallot } from "../src/db/repo/judging.ts";
import { assertJudgeEligible, configureJudge, judgeRestrictions, setJudgeRecusal } from "../src/db/repo/judge-roster.ts";
import { revokeRole } from "../src/db/repo/accounts.ts";
import { world } from "./support/world.ts";

test("track, capacity and recusal rules apply to direct writes and retain old ballots", () => {
  const w = world({ judges: 2, projects: 2, tracks: ["ai", "tools"] });
  try {
    const judge = w.judges[0]!.id;
    const first = w.projects[0]!.id;
    const second = w.projects[1]!.id;
    configureJudge(w.asOrganizer, w.event.id, judge, ["ai"], 1);
    assert.deepEqual(judgeRestrictions(w.db, w.event.id, judge).tracks, ["ai"]);
    assert.throws(() => saveBallot(w.asJudge(0), w.event, {
      judgeId: judge, projectId: second,
      scores: { impact: 5, craft: 5, novelty: 10 }, submit: true,
    }), /not eligible/);
    saveBallot(w.asJudge(0), w.event, { judgeId: judge, projectId: first,
      scores: { impact: 5, craft: 5, novelty: 10 }, submit: true });
    assert.equal(assignmentsOf(w.db, w.event.id, judge).length, 1);
    configureJudge(w.asOrganizer, w.event.id, judge, [], 1);
    assert.throws(() => assignProject(w.asOrganizer, w.event.id, judge, second), /capacity/);
    setJudgeRecusal(w.asOrganizer, w.event.id, judge, first, "Declared conflict", true);
    assert.equal(ballotsOf(w.db, w.event.id, judge).length, 1);
    assert.throws(() => assertJudgeEligible(w.db, w.event.id, judge, first), /recused/);
    revokeRole(w.asOrganizer, w.event.id, judge, "judge");
    assert.throws(() => assertJudgeEligible(w.db, w.event.id, judge, second), /active role/);
    assert.equal(ballotsOf(w.db, w.event.id, judge).length, 1);
  } finally { w.close(); }
});

test("roster rules reject cross-event tracks and projects before changing rows", () => {
  const w = world({ judges: 1, projects: 1, tracks: ["ai"] });
  try {
    const judge = w.judges[0]!.id;
    assert.throws(() => configureJudge(w.asOrganizer, w.event.id, judge, ["foreign"], 2), /not in this event/);
    assert.deepEqual(judgeRestrictions(w.db, w.event.id, judge), {
      tracks: null, capacity: null, recusals: [],
    });
    assert.throws(() => setJudgeRecusal(w.asOrganizer, w.event.id, judge,
      "01M00000000000000000000000", "Another event", true), /No such project/);
    assert.deepEqual(judgeRestrictions(w.db, w.event.id, judge).recusals, []);
  } finally { w.close(); }
});
