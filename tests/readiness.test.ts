import test from "node:test";
import assert from "node:assert/strict";
import { fitBradleyTerry, judgingReadiness, normalizeScores } from "../src/judging/index.ts";
import type { Ballot, Rubric } from "../src/judging/index.ts";
import { judged } from "./support/judged.ts";
import { saveBallot, setResultsPublic, updateProject } from "../src/db/index.ts";

const rubric: Rubric = { id: "r", version: 1, criteria: [{ key: "quality", label: "Quality", min: 1, max: 5, weight: 1 }] };
const ballot = (id: string, judge: string, project: string, quality: number): Ballot => ({ id, judge, project, rubricVersion: 1, scores: { quality } });

test("readiness rejects disconnected rubric cohorts even with full review counts", () => {
  const ballots = [ballot("1", "a", "x", 5), ballot("2", "b", "y", 2)];
  const report = judgingReadiness({ projects: ["x", "y"], ballots, reviewsPerProject: 1,
    rubric: normalizeScores(rubric, ballots), pairwise: null, pairwiseEnabled: false });
  assert.equal(report.checks.find((c) => c.code === "coverage")!.status, "pass");
  assert.equal(report.checks.find((c) => c.code === "rubric.overlap")!.status, "missing");
  assert.equal(report.status, "needs-evidence");
});

test("readiness counts distinct reviewers and includes projects with no ballots", () => {
  const ballots = [ballot("1", "a", "x", 5), ballot("2", "a", "x", 5)];
  const report = judgingReadiness({ projects: ["x", "y"], ballots, reviewsPerProject: 2,
    rubric: null, pairwise: null, pairwiseEnabled: false });
  assert.match(report.checks.find((c) => c.code === "coverage")!.detail, /^2 projects/);
  assert.equal(report.passed + report.missing + report.review, report.total);
});

test("readiness flags a sole bridging reviewer and clears after independent overlap", () => {
  const ballots = [ballot("1", "bridge", "x", 5), ballot("2", "bridge", "y", 2),
    ballot("3", "local-x", "x", 4), ballot("4", "local-y", "y", 3)];
  const report = () => judgingReadiness({ projects: ["x", "y"], ballots, reviewsPerProject: 2,
    rubric: normalizeScores(rubric, ballots), pairwise: null, pairwiseEnabled: false });
  assert.equal(report().checks.find((c) => c.code === "rubric.resilience")?.status, "review");
  ballots.push(ballot("5", "independent", "x", 4), ballot("6", "independent", "y", 3));
  assert.equal(report().checks.find((c) => c.code === "rubric.resilience")?.status, "pass");
});

test("pure pairwise readiness does not mistake a finite prior for observed evidence", () => {
  const pairwise = fitBradleyTerry([{ id: "1", judge: "j", left: "a", right: "b", winner: "a" }], ["a", "b", "c"]);
  const report = judgingReadiness({ projects: ["a", "b", "c"], ballots: [], reviewsPerProject: 3,
    rubric: null, pairwise, pairwiseEnabled: true });
  assert.equal(report.checks.some((c) => c.code.startsWith("rubric")), false);
  assert.equal(report.checks.find((c) => c.code === "pairwise.fit")!.status, "pass");
  assert.equal(report.checks.find((c) => c.code === "pairwise.connected")!.status, "missing");
  assert.match(report.checks.find((c) => c.code === "pairwise.coverage")!.detail, /^1 projects/);
});

test("live ranking invalidates on ballot revision while frozen publication and role gates hold", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    const path = `/api/events/${rig.world.event.slug}/results`;
    const before = await rig.json(path, organizer);
    assert.deepEqual(await rig.json(path, organizer), before);
    const dashboardBefore = await rig.json(`/api/events/${rig.world.event.slug}/dashboard`, organizer);
    const stored = rig.world.asOrganizer.db.one<{ project_id: string; judge_id: string; rubric_version: number }>("select project_id, judge_id, rubric_version from ballot where submitted_at is not null limit 1");
    saveBallot(rig.world.asOrganizer.as(stored.judge_id), rig.world.event, {
      projectId: stored.project_id, judgeId: stored.judge_id,
      scores: { impact: 1, craft: 1, novelty: 1 },
    });
    const after = await rig.json(path, organizer);
    assert.deepEqual(after, before, "a published revision stays byte-stable after a ballot edit");
    const dashboardAfter = await rig.json(`/api/events/${rig.world.event.slug}/dashboard`, organizer);
    assert.notDeepEqual(dashboardAfter, dashboardBefore, "the organizer's live fit updates");
    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    assert.notEqual((await rig.get(path)).status, 200);
    for (const principal of rig.principals.filter((p) => p.label !== "organizer")) {
      assert.notEqual((await rig.get(`/api/events/${rig.world.event.slug}/dashboard`, principal)).status, 200);
    }
    assert.equal("readiness" in after, false);
  } finally { rig.close(); }
});

test("readiness flags duplicate project submissions for organizer review", () => {
  const reportWithDupes = judgingReadiness({
    projects: ["p1", "p2"],
    ballots: [],
    reviewsPerProject: 2,
    rubric: null,
    pairwise: null,
    pairwiseEnabled: false,
    duplicates: [{ title: "Dry Harbour", ids: ["p1", "p2"], projects: [
      { id: "p1", title: "Dry Harbour", status: "submitted" },
      { id: "p2", title: "dry  harbour", status: "draft" },
    ] }],
  });
  const dupeCheck = reportWithDupes.checks.find((c) => c.code === "submissions.duplicates");
  assert.equal(dupeCheck?.status, "review");
  assert.match(dupeCheck?.detail ?? "", /draft or submitted/);
  assert.match(dupeCheck?.detail ?? "", /does not prove duplicate work/);
  assert.deepEqual(dupeCheck?.projects?.map((p) => p.status), ["submitted", "draft"]);

  const reportClean = judgingReadiness({
    projects: ["p1", "p2"],
    ballots: [],
    reviewsPerProject: 2,
    rubric: null,
    pairwise: null,
    pairwiseEnabled: false,
    duplicates: [],
  });
  assert.equal(reportClean.checks.find((c) => c.code === "submissions.duplicates")?.status, "pass");
});

test("organizer dashboard renders real repeated-title findings with safe project links and actions", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    const { world: w } = rig;
    const now = w.clock.now();
    // The judged fixture is already at the judging stage. Replay permitted title
    // edits at the submission stage, then inspect the live organizer dashboard.
    w.clock.set(w.event.submissions_close_at - 1);
    const title = '<img src=x onerror=alert(1)>';
    updateProject(w.system, w.event, w.projects[0]!, { title });
    updateProject(w.system, w.event, w.projects[1]!, { title: `  ${title}  ` });
    w.clock.set(now);

    const data = await rig.json(`/api/events/${w.event.slug}/dashboard`, organizer);
    const checks = (data.readiness as { checks: { code: string; status: string;
      projects?: { id: string; title: string; status: string }[] }[] }).checks;
    const duplicate = checks.find((c) => c.code === "submissions.duplicates");
    assert.equal(duplicate?.status, "review");
    assert.deepEqual(duplicate?.projects?.map((p) => p.id), [w.projects[0]!.id, w.projects[1]!.id]);
    const html = await rig.html(`/events/${w.event.slug}/dashboard`, organizer);
    const cardStart = html.indexOf('id="readiness-submissions.duplicates"');
    assert.ok(cardStart > 0);
    const card = html.slice(cardStart, html.indexOf("</article>", cardStart));
    for (const project of w.projects.slice(0, 2)) {
      const href = `/events/${w.event.slug}/projects/${encodeURIComponent(project.id)}`;
      assert.ok(card.includes(href));
      assert.equal((await rig.get(href, organizer)).status, 200);
    }
    assert.match(card, /Open project 1: &lt;img src=x onerror=alert\(1\)&gt; \(submitted\)/);
    assert.ok(!html.includes(title), "the title must never become executable markup");
    for (const check of checks.filter((c) => c.status !== "pass")) {
      const start = html.indexOf(`id="readiness-${encodeURIComponent(check.code)}"`);
      assert.ok(start > 0, `${check.code} has a card`);
      const finding = html.slice(start, html.indexOf("</article>", start));
      assert.match(finding, /<a class="action-link" href="[^"]+">[^<]+ ↗<\/a>/,
        `${check.code} has a named action`);
      assert.ok(!finding.includes("Review this finding"), `${check.code} has a specific destination`);
    }
  } finally { rig.close(); }
});
