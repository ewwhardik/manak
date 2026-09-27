/**
 * What the engine publishes, and to whom.
 *
 * The judging engine now says considerably more than a ranking: an interval around every
 * adjusted score, the tiers those intervals resolve into, how much of the spread came from
 * the panel rather than from the work, which ballots sit far from their own fit, how noisy
 * each judge is, and what each line of the rubric is doing. Some of that is for everybody
 * and some of it names people, and the difference is not a matter of taste — a per-judge
 * residual spread on a three-judge panel identifies a judge, and `results.show` is a page
 * strangers read.
 *
 * So this suite is about the boundary rather than the numbers. `tests/reliability.test.ts`
 * and `tests/criteria.test.ts` check that the passes compute the right things;
 * `docs/proof/normalization.md` re-derives them from a seed. What is checked here is that
 * the public surface carries the anonymous half and nothing else, that the organizer
 * surface carries all of it, and that both pages actually render what their JSON claims —
 * because a field on a response that no page reads is a field nobody will notice is wrong.
 *
 * The roster check is by substring over the whole serialised body, not by walking known
 * fields. A leak arrives in the place nobody thought to look: a warning sentence that
 * names a judge, a diagnostic's `subjects` array, an id echoed into an error. Searching
 * the bytes catches the ones a field list would not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { setResultsPublic } from "../src/db/index.ts";
import { esc } from "../src/view/html.ts";
import { judged } from "./support/judged.ts";

/** Anything numeric, insisted on rather than coerced — `undefined` fails here. */
function finite(value: unknown, what: string): number {
  assert.equal(typeof value, "number", `${what} should be a number, got ${typeof value}`);
  assert.ok(Number.isFinite(value as number), `${what} should be finite, got ${String(value)}`);
  return value as number;
}

function rowsOf(value: unknown, key: string): Record<string, unknown>[] {
  const holder = value as Record<string, unknown>;
  const found = holder[key];
  assert.ok(Array.isArray(found), `${key} should be an array, got ${typeof found}`);
  return found as Record<string, unknown>[];
}

test("the public results carry the panel's reliability without naming the panel", async () => {
  const rig = judged();
  try {
    const path = `/api/events/${rig.fill.event}/results`;
    const response = await rig.get(path);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    const text = JSON.stringify(body);

    const panel = body.panel as Record<string, unknown>;
    assert.ok(panel !== null && typeof panel === "object", "there should be a panel block");
    assert.match(String(panel.method), /wright-masters/, "the method names itself and its settings");
    assert.ok(Number.isInteger(panel.tiers), "tiers is a count of levels, not a list");
    assert.ok((panel.tiers as number) >= 1);
    assert.equal(typeof panel.decisive, "boolean");
    finite(panel.separation, "panel.separation");
    finite(panel.reliability, "panel.reliability");
    finite(panel.strata, "panel.strata");
    const share = panel.varianceShare as Record<string, unknown>;
    const parts =
      finite(share.project, "share.project") +
      finite(share.judge, "share.judge") +
      finite(share.residual, "share.residual");
    assert.ok(Math.abs(parts - 1) < 1e-9, `the three shares should sum to 1, got ${parts}`);

    const projects = rowsOf(body, "projects");
    assert.ok(projects.length >= 4);
    for (const row of projects) {
      const adjusted = finite(row.adjusted, "adjusted");
      const low = finite(row.low, "low");
      const high = finite(row.high, "high");
      assert.ok(low <= adjusted && adjusted <= high, `${low} <= ${adjusted} <= ${high}`);
      assert.ok(Number.isInteger(row.tier), "every row carries the tier it fell in");
      assert.ok(Number.isInteger(row.sharesTier), "and how many share it");
      // The half-width the interval was built from stays on the response. A client that
      // wants the quantity rather than the range should not have to subtract.
      finite(row.standardError, "standardError");
      finite(row.halfWidth, "halfWidth");
    }

    // The organizer-only half is absent, not empty. An empty array reads as "we looked and
    // found nothing", which is a different claim from "this is not yours to see".
    assert.equal("reliability" in body, false, "the named reliability block is not public");
    assert.equal("criteria" in body, false, "per-criterion analysis is not public");
    assert.equal("outliers" in body, false);
    assert.equal("notes" in body, false, "a diagnostic's subjects carry raw ids");

    for (const secret of rig.secrets) {
      assert.equal(text.includes(secret), false, `the public results named ${secret}`);
    }
    // The caveats survive the redaction rather than being dropped with it: a public results
    // page that quietly withholds "this panel cannot separate the field" is worse than one
    // that never computed it.
    assert.ok(Array.isArray(body.warnings));
  } finally {
    rig.close();
  }
});

test("the dashboard carries the whole of both passes, names attached", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals[3] as { label: string; token?: string };
    const body = await rig.json(`/api/events/${rig.fill.event}/dashboard`, organizer);

    const reliability = body.reliability as Record<string, unknown>;
    assert.ok(reliability !== null && typeof reliability === "object");
    const intervals = rowsOf(reliability, "intervals");
    assert.equal(intervals.length, 4, "one interval per project in the fit");
    for (const interval of intervals) {
      assert.equal(typeof interval.title, "string", "a project id is not a name");
      assert.ok((interval.title as string).length > 0);
      finite(interval.halfWidth, "halfWidth");
    }

    const judges = rowsOf(reliability, "judges");
    assert.equal(judges.length, 3, "one row per judge who filed a ballot");
    for (const judge of judges) {
      assert.equal(typeof judge.name, "string");
      finite(judge.relative, "relative");
      finite(judge.bias, "bias");
      assert.equal(typeof judge.flagged, "boolean");
      // Near zero by construction: the fit removed each judge's leniency before the
      // residuals were taken, so a mean residual that is *not* near zero would mean the
      // two-way fit had stopped subtracting judge effects. That makes this the cheapest
      // regression test in the suite for the thing normalization is for.
      assert.ok(
        Math.abs(judge.bias as number) < 0.25,
        `${String(judge.name)} has a mean residual of ${String(judge.bias)}, so leniency survived the fit`,
      );
    }

    // The leniency itself is on the effects table, which is the same fit read the other
    // way, and the fixture's third judge marks everything up — so it had better be there.
    const effects = rowsOf(body, "effects");
    assert.equal(effects.length, 3);
    const spread = Math.max(...effects.map((effect) => Math.abs(effect.leniency as number)));
    assert.ok(spread > 0.05, `a panel with a lenient member should show leniency, saw ${spread}`);

    rowsOf(reliability, "outliers");
    rowsOf(reliability, "notes");
    rowsOf(reliability, "warnings");

    const criteria = body.criteria as Record<string, unknown>;
    assert.ok(criteria !== null && typeof criteria === "object");
    const lines = rowsOf(criteria, "criteria");
    assert.deepEqual(
      lines.map((line) => line.key),
      ["impact", "craft", "novelty"],
      "every line of the rubric is reported, in the rubric's own order",
    );
    for (const line of lines) {
      assert.ok(["discriminating", "weak", "flat"].includes(String(line.verdict)));
      const used = finite(line.rangeUsed, "rangeUsed");
      assert.ok(used >= 0 && used <= 1);
      finite(line.discrimination, "discrimination");
      finite(line.judgeDivergence, "judgeDivergence");
      finite(line.withTotal, "withTotal");
    }
    finite(criteria.meanCorrelation, "meanCorrelation");
    rowsOf(criteria, "redundant");

    // The pre-publish read. One row per judge on the roster rather than per judge who filed, a
    // verdict on each, and a sentence saying what to do — including for the judges there is
    // nothing to do about, because a report that omits the clean rows makes the reader work out
    // whether a missing judge is fine or forgotten.
    const calibration = body.calibration as Record<string, unknown>;
    assert.ok(calibration !== null && typeof calibration === "object");
    const panel = rowsOf(calibration, "judges");
    assert.equal(panel.length, rowsOf(body, "judges").length, "one row per roster judge");
    for (const judge of panel) {
      assert.equal(typeof judge.name, "string", "a judge id is not a name");
      assert.ok((judge.name as string).length > 0);
      assert.ok(["ok", "thin", "behind", "check"].includes(String(judge.verdict)));
      assert.ok(String(judge.action).length > 0, `${String(judge.name)} has a verdict and no action`);
      assert.ok(Array.isArray(judge.findings));
    }
    // Every judge is measured against a consensus that excludes their own decisions, or is
    // counted as one who could not be: the two add up to the panel, so neither can be quietly
    // dropped when the field stops being connected without somebody.
    assert.equal(
      finite(calibration.heldOut, "heldOut") + finite(calibration.inSample, "inSample"),
      panel.length,
    );
    for (const pair of rowsOf(calibration, "blocs")) {
      assert.equal(typeof pair.aName, "string");
      assert.equal(typeof pair.bName, "string");
      assert.equal(typeof pair.asked, "boolean");
    }
    // The sentences are the engine's, with the names put back by this projection: the engine is
    // never told who anybody is, so an id surviving into the prose an organizer reads is this
    // layer forgetting to finish the job.
    for (const note of rowsOf(calibration, "notes")) {
      const message = String(note.message);
      for (const secret of rig.secrets) {
        assert.equal(message.includes(secret), false, `a calibration note printed ${secret} raw`);
      }
    }

    // With a calibration table on the page, the fit's own warning list is panel-level: a sentence
    // about one judge belongs in that judge's row, with the action beside it, and not twice.
    const fit = body.rubric as Record<string, unknown>;
    for (const warning of rowsOf(fit, "warnings")) {
      for (const secret of rig.secrets) {
        assert.equal(
          String(warning).includes(secret),
          false,
          `the fit's warning list still names ${secret}, which calibration is now saying`,
        );
      }
    }
  } finally {
    rig.close();
  }
});

test("nothing the calibration pass says reaches a surface a stranger can read", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals[3] as { label: string; token?: string };
    const dashboard = await rig.json(`/api/events/${rig.fill.event}/dashboard`, organizer);
    const calibration = dashboard.calibration as Record<string, unknown>;

    // Taken from the organizer's own response rather than written out here, so the sweep covers
    // whatever the pass decided to say on this fixture instead of the sentences I expected it to.
    const said = [
      ...rowsOf(calibration, "judges").map((judge) => String(judge.action)),
      ...rowsOf(calibration, "notes").map((note) => String(note.message)),
      String(calibration.method),
    ];
    assert.ok(said.length > 3, "the fixture should give the pass something to say");

    const publicJson = JSON.stringify(await rig.json(`/api/events/${rig.fill.event}/results`));
    const publicPage = await rig.html(`/events/${rig.fill.slug}/results`);
    // The same page read with a judge's session, which is the leak that would matter: a judge who
    // reads a verdict about themselves starts judging the report instead of the work, and the
    // published page is the one organizer-adjacent surface they are meant to be able to open.
    // (That they cannot open the dashboard itself is asserted below, over every principal.)
    const judgePage = await rig.html(
      `/events/${rig.fill.slug}/results`,
      rig.principals[2] as { label: string; token?: string },
    );
    for (const sentence of said) {
      assert.equal(publicJson.includes(sentence), false, `the public results carried "${sentence}"`);
      // Through `esc`, not a hand-rolled substitute for it: the pass writes apostrophes and the
      // thresholds in `method` are spelled with `>=`, both of which arrive on a page transformed.
      // Comparing against the raw sentence would pass by failing to look.
      assert.equal(publicPage.includes(esc(sentence)), false, `the public page carried "${sentence}"`);
      assert.equal(judgePage.includes(esc(sentence)), false, `a judge's own page carried "${sentence}"`);
    }
    // And the field itself is absent rather than empty, for the reason the first test in this file
    // gives: an empty object reads as "we looked and found nothing".
    assert.equal("calibration" in (await rig.json(`/api/events/${rig.fill.event}/results`)), false);
  } finally {
    rig.close();
  }
});

test("the dashboard page prints a verdict per judge and the action beside it", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals[3] as { label: string; token?: string };
    const page = await rig.html(`/events/${rig.fill.slug}/dashboard`, organizer);
    const body = await rig.json(`/api/events/${rig.fill.event}/dashboard`, organizer);
    const calibration = body.calibration as Record<string, unknown>;

    assert.match(page, /Is this panel ready to publish\?/);
    assert.match(page, /Everything the pass said/);
    for (const judge of rowsOf(calibration, "judges")) {
      // The action is on the page, not merely in the JSON. A verdict with the sentence that
      // resolves it left in the response body is a verdict nobody acts on.
      assert.ok(
        page.includes(esc(judge.action)),
        `the page dropped the action for ${String(judge.name)}`,
      );
    }
    // Said once. The action sentences repeat across judges by design — several judges can need the
    // same thing — but a note is about particular people and appears exactly one time.
    for (const note of rowsOf(calibration, "notes")) {
      const seen = page.split(esc(note.message)).length - 1;
      assert.equal(seen, 1, `"${String(note.message)}" is on the dashboard ${seen} times`);
    }
  } finally {
    rig.close();
  }
});

test("a stranger cannot read the dashboard at all", async () => {
  const rig = judged();
  try {
    for (const principal of rig.principals.slice(0, 3)) {
      const response = await rig.get(`/api/events/${rig.fill.event}/dashboard`, principal);
      assert.ok(
        response.status === 401 || response.status === 403 || response.status === 404,
        `${principal.label} got ${response.status} out of the dashboard`,
      );
    }
  } finally {
    rig.close();
  }
});

test("the results page prints every interval it was given, and no judge", async () => {
  const rig = judged();
  try {
    const page = await rig.html(`/events/${rig.fill.slug}/results`);
    assert.match(page, /95% range/, "the standings table publishes the interval, not the error");
    assert.match(page, /Tiers the evidence supports/);
    assert.match(page, /Where the spread came from/);
    assert.match(page, /class="meter/, "the variance shares are drawn, not just numbered");
    // Every meter says its own number in text beside the bar, because a bar with no figure
    // is unreadable to a screen reader and unquotable to everybody else.
    const meters = page.match(/class="meter/g) ?? [];
    assert.ok(meters.length >= 3, `expected at least three meters, found ${meters.length}`);
    assert.match(page, /aria-label="/);
    // One decimal on the figure against two-percent steps on the bar. The text has to be the
    // finer of the two or the bar becomes the only place a close comparison can be made.
    assert.match(page, /\d+\.\d%/, "the shares print a decimal the bar cannot show");
    assert.match(page, /aria-label="[^"]*\d+\.\d%"/, "and the label carries the same string");

    for (const secret of rig.secrets) {
      assert.equal(page.includes(secret), false, `the results page named ${secret}`);
    }
    // The two claims the whole design rests on, asserted on the page a stranger lands on.
    assert.equal(/<script/i.test(page), false, "there is no client-side JavaScript");
    assert.equal(/ style="/.test(page), false, "and no inline style for the CSP to have to allow");
  } finally {
    rig.close();
  }
});

test("the dashboard page renders both passes in place of a second ranking", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals[3] as { label: string; token?: string };
    const page = await rig.html(`/events/${rig.fill.slug}/dashboard`, organizer);
    assert.match(page, /How much the ranking can carry/);
    assert.match(page, /What each line of the rubric is doing/);
    assert.match(page, /Noise/, "judge noise is a column on the effects table");
    assert.match(page, /Separates/, "and discrimination is a column on the criteria table");
    // The organizer page may name judges — that is the point of it — but it still may not
    // ask a browser to run anything.
    assert.equal(/<script/i.test(page), false);
    assert.equal(/ style="/.test(page), false);
  } finally {
    rig.close();
  }
});

test("publishing tells the organizer what the evidence resolves before they commit", async () => {
  const rig = judged();
  try {
    const organizer = rig.principals[3] as { label: string; token?: string };
    const response = await rig.serve(
      new Request(`https://portal.test/api/events/${rig.fill.event}/results/unpublish`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${organizer.token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
      "203.0.113.9",
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.published, false);
    assert.equal(body.changed, true);
    assert.ok(Number.isInteger(body.tiers), "the toggle reports how many levels there are");
    assert.equal(typeof body.decisive, "boolean");
    finite(body.reliability, "reliability");
    // Redacted here for the same reason as on the public page: this response is the one an
    // organizer screen-shares while deciding.
    for (const secret of rig.secrets) {
      assert.equal(JSON.stringify(body).includes(secret), false, `the toggle named ${secret}`);
    }
  } finally {
    rig.close();
  }
});

test("the confidence pass is a preview for the organizer and a refusal for everybody else", async () => {
  const rig = judged();
  try {
    const path = `/api/events/${rig.fill.event}/results/confidence`;
    // Published, as the fixture leaves it: everybody can read the resample, because a ranking
    // that is public and an honesty check that is not is the wrong way round.
    for (const principal of rig.principals) {
      const response = await rig.get(path, principal);
      assert.equal(response.status, 200, `${principal.label} was refused a published resample`);
    }

    setResultsPublic(rig.world.asOrganizer, rig.world.event, false);
    const organizer = rig.principals[3] as { label: string };
    assert.equal((await rig.get(path, organizer)).status, 200, "the organizer keeps the preview");
    for (const principal of rig.principals.slice(0, 3)) {
      const response = await rig.get(path, principal);
      // 409, not 403: the resample is not a permission they lack, it is a state the event is
      // not in yet. `tests/api.test.ts` owns that classification for all three gates.
      assert.equal(response.status, 409, `${principal.label} read an unpublished resample`);
      const problem = (await response.json()) as { code?: string };
      assert.equal(problem.code, "results.notPublic");
    }
  } finally {
    rig.close();
  }
});

test("the resample answers the same way twice and names no judge", async () => {
  const rig = judged();
  try {
    const path = `/api/events/${rig.fill.event}/results/confidence`;
    const first = await rig.json(path);
    const second = await rig.json(path);
    // Byte-identical, because the seed is derived from the event id rather than drawn: an
    // interval that moves when a page is reloaded is an interval nobody can quote in an appeal.
    assert.equal(JSON.stringify(first), JSON.stringify(second));

    const resample = first.resample as Record<string, unknown>;
    assert.equal(resample.unit, "judge");
    assert.equal(resample.replicates, 400);
    assert.equal(resample.confidence, 0.95);
    assert.match(String(resample.seed), /^manak\.bootstrap\|/);
    const projects = rowsOf(resample, "projects");
    assert.equal(projects.length, finite(first.projects, "projects"));
    const pairs = rowsOf(resample, "pairs");
    assert.equal(
      pairs.length,
      projects.filter((row) => row.placed === true).length - 1,
      "the pair table walks the compared field and nothing else",
    );
    for (const row of projects) {
      finite(row.beta, `${String(row.title)} beta`);
      finite(row.low, `${String(row.title)} low`);
      assert.ok((row.low as number) <= (row.high as number));
      assert.ok(Number.isInteger(row.tier), `${String(row.title)} tier`);
      assert.ok(Number.isInteger(row.sharesTier), `${String(row.title)} sharesTier`);
      assert.ok((row.rankStability as number) >= 0 && (row.rankStability as number) <= 1);
    }
    // The audience rule, on the surface that carries the most engine output of any public one.
    const body = JSON.stringify(first);
    for (const secret of rig.secrets) {
      assert.equal(body.includes(secret), false, `the resample leaked ${secret}`);
    }
  } finally {
    rig.close();
  }
});

test("a submitted setting is applied and quoted, and a blank one takes the default", async () => {
  const rig = judged();
  try {
    const base = `/api/events/${rig.fill.event}/results/confidence`;
    const tuned = (await rig.json(`${base}?replicates=80&confidence=0.9`))
      .resample as Record<string, unknown>;
    assert.equal(tuned.replicatesRequested, 80, "the request is echoed");
    assert.equal(tuned.confidence, 0.9);
    assert.match(String(tuned.method), /pairwise-bootstrap\(judge, 80/);

    // A blank is not a zero. The query string is the input to a GET, and an empty value in it
    // is what a browser sends for a control the reader did not touch.
    const blank = (await rig.json(`${base}?replicates=&confidence=`))
      .resample as Record<string, unknown>;
    assert.equal(blank.replicates, 400);
    assert.equal(blank.confidence, 0.95);

    const strict = (await rig.json(`${base}?confidence=0.99`)).resample as Record<string, unknown>;
    const loose = (await rig.json(`${base}?confidence=0.9`)).resample as Record<string, unknown>;
    const width = (r: Record<string, unknown>): number => {
      const rows = rowsOf(r, "projects");
      const first = rows[0] as Record<string, number>;
      return first.high! - first.low!;
    };
    assert.ok(width(strict) >= width(loose), "more confidence has to mean a wider interval");
    assert.ok(
      (strict.threshold as number) < (loose.threshold as number),
      "and a stricter reversal threshold, so it separates fewer pairs",
    );
  } finally {
    rig.close();
  }
});

test("the confidence page states what a level is and what it is not", async () => {
  const rig = judged();
  try {
    const page = await rig.html(`/events/${rig.fill.slug}/results/confidence`);
    assert.match(page, /A level is formed around one project/, "the invariant is named");
    assert.match(
      page,
      /Two projects\s+sharing a level can still be separated from each other/,
      "and the thing it is not is named beside it",
    );
    assert.equal(
      /Projects on one level are not separated from each other/.test(page),
      false,
      "the old overclaim is gone: its own pair table contradicted it",
    );
    // The header that used to read "Wins" over a column of resample shares. There is a real
    // win count on the standings page, and printing 0% over a project with four duel wins is
    // the kind of mistake a reader only catches by cross-checking two pages.
    assert.match(page, /<th scope="col"[^>]*>Comes first<\/th>/);
    assert.equal(/<th scope="col"[^>]*>Wins<\/th>/.test(page), false);
    // Every level names a leader, so the group is something a prize can be awarded on.
    assert.match(page, /<dt>Level 1<\/dt>/);
    assert.match(page, /method="get"/, "the settings form re-reads the page rather than writing");
    assert.equal(/<script/i.test(page), false);
    assert.equal(/-0\.00/.test(page), false, "negative zero is zero");
    for (const secret of rig.secrets) {
      assert.equal(page.includes(secret), false, `the page leaked ${secret}`);
    }
  } finally {
    rig.close();
  }
});

test("a pairwise-only event reports a ranking and no certainty it does not have", async () => {
  const rig = judged({ rubric: false });
  try {
    const body = await rig.json(`/api/events/${rig.fill.event}/results`);
    assert.equal(body.rubricVersion, null, "no rubric was published, and the response says so");
    assert.equal(body.ballots, 0);
    assert.equal(body.panel, null, "no fit means no reliability pass and no panel block");
    const projects = rowsOf(body, "projects");
    assert.ok(projects.length > 0, "a duelled event still has a ranking");
    for (const row of projects) {
      // The whole point of the branch: a Bradley-Terry strength is not a mean and has no error
      // bar, so both keys are absent rather than zero. A zero here would print as `0.00` and
      // `± 0.000`, which is a claim of certainty nothing in this system supports.
      assert.equal("rawMean" in row, false, `${String(row.title)} sent a rawMean it cannot have`);
      assert.equal("standardError" in row, false, `${String(row.title)} sent a standardError`);
      assert.equal("low" in row, false);
      assert.equal("tier" in row, false);
      assert.equal(row.ballots, 0, "zero rubric ballots is a count, and stays");
      finite(row.adjusted, "adjusted");
      assert.ok(Number.isInteger(row.rank));
    }
    const ranks = projects.map((row) => row.rank as number);
    assert.deepEqual(ranks.slice().sort((a, b) => a - b), ranks, "and it arrives in rank order");

    const page = await rig.html(`/events/${rig.fill.slug}/results`);
    assert.match(page, /Strength/, "the column is named for what it holds");
    assert.equal(/95% range/.test(page), false, "no interval column on a fit that never ran");
    assert.equal(/± error/.test(page), false, "and no error column either");
    assert.equal(/Raw mean/.test(page), false);
    assert.equal(/0\.000/.test(page), false, "nothing prints a fabricated zero");
    assert.match(page, /Nobody filed a rubric ballot/, "the page says why the table is narrow");
    assert.match(page, /Pairwise standing/, "the win-loss detail is still published below");
    assert.equal(/<script/i.test(page), false);
  } finally {
    rig.close();
  }
});
