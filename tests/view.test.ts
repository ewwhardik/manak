/**
 * The view layer's primitives, tested directly rather than through a socket.
 *
 * Everything else about these functions is already exercised by `tests/http.test.ts`,
 * which asks a running server for pages and reads the bytes it gets back. That is the
 * right test for "does the results page render", and the wrong one for the details below:
 * a skip link, a `scope` attribute and a hidden column header are invisible to a test that
 * asserts on visible text, so they regress without failing anything. They are the parts of
 * this product only a screen reader and a keyboard ever see, which is precisely why they
 * need a test that looks at them on purpose.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { esc, attrs, definitions, meter, page, scroller, table } from "../src/view/html.ts";
import { markdownish } from "../src/view/pages.ts";
import { dashboardPage } from "../src/view/results.ts";
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/registry.ts";
import { STYLESHEET } from "../src/view/style.ts";

/** The layer this suite reads back as text, for the two tests that count what it emits. */
const VIEW = fileURLToPath(new URL("../src/view/", import.meta.url));

/**
 * A file's lines with its comments blanked out, for the scans below.
 *
 * This layer's comments talk *about* the calls the scans look for — the sentence explaining why
 * a table is wrapped where it is built contains the words `table(` and `scroller(` — so a scan
 * that reads them counts prose as code and reports the explanation as the violation. Block
 * comments are blanked rather than deleted so that a line number still means a line.
 */
const code = (file: string): string[] =>
  readFileSync(join(VIEW, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (line.includes("//") ? line.slice(0, line.indexOf("//")) : line));

const shell = (body: string, extra: Record<string, unknown> = {}): string =>
  page({ title: "T", body, ...extra } as Parameters<typeof page>[0]);

test("the skip link is the first focusable element and points at the main region", () => {
  const html = shell("<p>x</p>");
  const skip = html.indexOf('<a class="skip" href="#main">');
  assert.ok(skip > 0, "there must be a skip link");
  assert.ok(
    skip < html.indexOf('class="mark"'),
    "it has to come before the masthead link, or it is one tab too late to be useful",
  );
  assert.match(html, /<main id="main" tabindex="-1">/);
  // Several browsers move focus to a fragment target only if it can hold focus, so the
  // negative tabindex is the difference between scrolling and actually moving the cursor.
  assert.ok(!html.includes('tabindex="0"'), "nothing is inserted into the tab order");
});

test("both navigation regions are named, and the breadcrumb marks the current page", () => {
  const html = shell("<p>x</p>", {
    trail: [
      { label: "Events", href: "/events" },
      { label: "Dogfood", href: "/events/dogfood" },
      { label: "Results" },
    ],
  });
  assert.match(html, /<nav class="who" aria-label="Account">/);
  assert.match(html, /<nav class="trail" aria-label="Breadcrumb">/);
  // The last crumb is the page itself: a link to where you already are is a link nobody
  // wants, and without it the trail used to end in a slash pointing at nothing.
  assert.match(html, /<span aria-current="page">Results<\/span><\/nav>/);
  assert.ok(!html.includes("/</nav>"), "the dangling separator is gone");
  assert.match(html, /<h1>Results<\/h1>/, "and the heading still names the page");
  const trail = html.slice(html.indexOf('class="trail"'), html.indexOf("</nav>", html.indexOf('class="trail"')));
  assert.equal((trail.match(/ \/ /g) ?? []).length, 2, "three crumbs, two separators");
});

test("a page with no trail has no breadcrumb at all", () => {
  const html = shell("<p>x</p>");
  assert.ok(!html.includes('class="trail"'), "one crumb is not a trail");
  assert.match(html, /<h1>T<\/h1>/);
});

test("the trail escapes a label, and a crumb without an href is not a link", () => {
  const html = shell("", {
    trail: [{ label: '<script>&"' }, { label: "Here" }],
  });
  assert.ok(html.includes("&lt;script&gt;&amp;&quot;"), "labels are escaped");
  assert.ok(!html.includes("<script>"), "and never emitted raw");
  assert.ok(!html.includes('<a href="undefined"'), "a crumb with no href is plain text");
});

test("a numeric column is right-aligned in both the header and the body", () => {
  const html = table(["Project", "Score"], [["A", "0.71"], ["B", "0.9"]], [], [1]);
  assert.match(html, /<th scope="col" class="num">Score<\/th>/);
  assert.match(html, /<th scope="col">Project<\/th>/, "and a text column is not");
  assert.equal((html.match(/<td class="num">/g) ?? []).length, 2);
  assert.match(html, /<td>A<\/td><td class="num">0\.71<\/td>/);
  // Alignment alone would not make a column comparable: proportional digits put the
  // decimal points of 0.71 and 0.9 in different places. The stylesheet is where the
  // tabular figures come from, so the class has to reach it.
  assert.match(STYLESHEET, /td\.num, th\.num \{[^}]*tabular-nums/);
});

test("a column with no name is refused, and a hidden name is the caller's word", () => {
  const html = table(["Version", "vh:Action"], [["3", "<button>Publish</button>"]], [1]);
  assert.match(html, /<th scope="col"><span class="vh">Action<\/span><\/th>/);
  assert.ok(!html.includes("<th scope=\"col\"></th>"), "an empty header names no column");
  // The primitive used to supply the word "Action" for any blank header, which was true of the
  // one action column that existed and wrong for the severity column added beside it — that one
  // announced "Action" over a row of warning pills. Guessing is now a refusal, and the caller
  // says the word. A non-breaking space is in the list because it was the previous way to make
  // a header non-empty, and it reads as a column with a blank name rather than as one with none.
  for (const nameless of ["", " ", "\t", " ", "vh:"]) {
    assert.throws(
      () => table(["A", nameless], [["x", "y"]]),
      /nameless column at index 1/,
      `${JSON.stringify(nameless)} was accepted as a column name`,
    );
  }
  assert.ok(
    table(["A", "B"], [["x", ""]]).includes("<td></td>"),
    "an empty cell is a value and stays legal — the refusal is on the header only",
  );
  assert.match(STYLESHEET, /\.vh \{[^}]*clip-path: inset\(50%\)/);
});

test("raw and numeric column sets are independent, and both are per column", () => {
  const html = table(
    ["Name", "Link", "N"],
    [["<b>", '<a href="/x">x</a>', "<i>"]],
    [1],
    [2],
  );
  assert.ok(html.includes("<td>&lt;b&gt;</td>"), "column 0 is escaped");
  assert.ok(html.includes('<td><a href="/x">x</a></td>'), "column 1 is markup");
  assert.ok(html.includes("<td class=\"num\">&lt;i&gt;</td>"), "column 2 is escaped and aligned");
});

test("a meter snaps to a rung the stylesheet actually defines", () => {
  for (const [fraction, expected] of [
    [0, 0],
    [0.004, 0],
    [0.011, 2],
    [0.5, 50],
    [0.507, 50],
    [0.51, 52],
    [1, 100],
  ] as const) {
    const html = meter(fraction, `${fraction}`);
    assert.match(html, new RegExp(`class="meter p${expected}"`), `${fraction} snaps to ${expected}`);
    assert.match(
      STYLESHEET,
      new RegExp(`\\.meter\\.p${expected} > i \\{ width: ${expected}%; \\}`),
      `and .p${expected} exists in the stylesheet`,
    );
  }
});

test("a meter is out of the reading order but carries its own label, and the number is separate", () => {
  const html = meter(0.34, "34% of the spread is between projects");
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="34% of the spread is between projects"/);
  assert.match(html, /<i><\/i>/, "the fill is an element, not a background");
  // The bar is a 2% approximation and the label is not. A reader who wants the exact
  // figure reads the text beside it, which is why nothing here prints a rounded number.
  assert.ok(!html.includes("34%<"), "the meter prints no number of its own");
  assert.equal(meter(0.34, "x", "good").includes("meter good p34"), true);
  assert.equal(meter(0.34, "x", "bad").includes("meter bad p34"), true);
});

test("a meter refuses to be wider than its track, or narrower than empty", () => {
  // A share above one is a caller bug; a bar 340% wide is a broken page an organizer is
  // reading during an appeal, so it is clamped rather than asserted.
  assert.match(meter(3.4, "x"), /class="meter p100"/);
  assert.match(meter(-2, "x"), /class="meter p0"/);
  assert.match(meter(Number.NaN, "x"), /class="meter p0"/);
  assert.match(meter(Number.POSITIVE_INFINITY, "x"), /class="meter p100"/);
  assert.match(meter(0.5, '"><script>'), /aria-label="&quot;&gt;&lt;script&gt;"/);
});

test("the sign-out button is the quiet variant, so the masthead has one loud control", () => {
  const html = shell("", { whoami: "Rosa" });
  assert.match(html, /<button class="quiet" type="submit">Sign out<\/button>/);
  assert.match(STYLESHEET, /button\.quiet \{/, "and the variant is styled rather than dead");
  assert.ok(!shell("", { whoami: null }).includes("Sign out"));
});

test("every selector the stylesheet defines for the new primitives is one a view emits", () => {
  // The pair of dead selectors this sheet used to carry — `.mono` and `.quiet` — were
  // styled for markup nobody wrote. Both directions are worth checking, and this is the
  // cheap half: everything the primitives above claim must exist in the sheet.
  for (const selector of [".skip", ".vh", ".meter", ".pair", ".scores", ".num", ".scroll"]) {
    assert.ok(
      STYLESHEET.includes(selector),
      `${selector} is emitted by this layer and must be styled`,
    );
  }
});

test("every keyframe the sheet defines is played, and every animation it plays is defined", () => {
  // The other direction of the check above, and it caught a real one: `sheen` was declared
  // as a fade and then never referenced by anything, so the sheet carried an animation the
  // product did not have. CSS has no way to complain about either half — an unplayed
  // keyframe is silent, and `animation: sheeen` is silent in exactly the same way, which
  // makes a typo here indistinguishable from a design decision.
  const defined = [...STYLESHEET.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)].map((m) => m[1]);
  const played = new Set(
    [...STYLESHEET.matchAll(/animation:\s*([A-Za-z][\w-]*)/g)].map((m) => m[1] as string),
  );
  assert.ok(defined.length >= 3, `expected the motion block to exist, found ${defined.length}`);
  assert.deepEqual(
    defined.filter((name) => !played.has(name as string)),
    [],
    "these keyframes are defined and never played",
  );
  assert.deepEqual(
    [...played].filter((name) => !defined.includes(name)),
    [],
    "these animations name a keyframe that does not exist",
  );
});

test("the travelling highlight is parked off the button until a hover plays it", () => {
  // Parked rather than transparent, because a band at `opacity: 0` still composites on
  // every paint. And clipped, because a skewed band on a rounded button that is not
  // clipped is a corner sticking out — which is what `overflow: hidden` on `button` is for
  // and the only reason that declaration is there.
  assert.match(STYLESHEET, /button \{[^}]*overflow: hidden/);
  assert.match(STYLESHEET, /button::after \{[^}]*transform: translate3d\(-150%/);
  assert.match(STYLESHEET, /button:hover::after \{ animation: sheen /);
  // It plays once. An iteration count above one on a hover state is a control that keeps
  // blinking for as long as the pointer rests on it.
  assert.doesNotMatch(STYLESHEET, /animation: sheen [^;}]*infinite/);
});

test("a scrollable region can be reached by keyboard and says what it holds", () => {
  // `overflow-x: auto` is a mouse, a trackpad and a finger. On a narrow window the columns
  // past the fold of the diagnostics table were unreachable without one, which is a keyboard
  // trap in reverse: not a place you cannot leave, a place you cannot enter. The fix is two
  // attributes, and this test exists because both are the kind of attribute a later edit
  // drops without changing how the page looks to the person editing it.
  const html = scroller("<table><tbody><tr><td>x</td></tr></tbody></table>", "Standings");
  assert.match(html, /^<div class="scroll" role="group" tabindex="0" aria-label="Standings">/);
  assert.ok(html.endsWith("</div>"));
  // `group` rather than `region`: the dashboard renders nine of these, and nine landmarks
  // turn the landmark list from a summary of the page into a walk through every table.
  assert.ok(!html.includes('role="region"'));
  assert.match(scroller("", '"><script>'), /aria-label="&quot;&gt;&lt;script&gt;"/);
});

test("the reference page's generated tables go through the same region as the written ones", () => {
  // This renderer streams its rows, so it used to open the wrapper by hand and close it two
  // branches later. That is how one table on the site ended up without the attributes every
  // other table has — not by disagreement, by being written somewhere else.
  const html = markdownish("## Fields\n\n| Field | Meaning |\n| --- | --- |\n| `id` | which one |", "The fields x accepts");
  assert.match(html, /<div class="scroll" role="group" tabindex="0" aria-label="The fields x accepts"><table>/);
  assert.match(html, /<th scope="col">Field<\/th>/);
  assert.match(html, /<code>id<\/code>/, "inline code survives the escape");
  assert.ok(html.endsWith("</tbody></table></div>"), "and the table is closed inside the region");
  assert.equal((html.match(/<table>/g) ?? []).length, 1);
  // A heading after a table closes it; the old version left the wrapper open across one.
  const two = markdownish("| A |\n| --- |\n| 1 |\n### Next\n| B |\n| --- |\n| 2 |", "Two");
  assert.equal((two.match(/class="scroll"/g) ?? []).length, 2);
  assert.equal((two.match(/<\/table>/g) ?? []).length, 2);
  assert.ok(two.indexOf("</table>") < two.indexOf("<h3>Next</h3>"));
});

test("the entrance stagger reaches the last cell of the widest row, and has something to delay", () => {
  const rungs = [...STYLESHEET.matchAll(/\.grid > :nth-child\((\d+)\)\s*\{\s*animation-delay/g)]
    .map((found) => Number(found[1]));
  assert.ok(rungs.length > 0, "there is a ladder to check");
  // Contiguous from 2: a gap means one cell arrives with no delay and lands out of order.
  assert.deepEqual(rungs, rungs.map((_, index) => index + 2), "the rungs are 2..n with no gap");
  const deepest = Math.max(...rungs);

  // The widest `stats([...])` call in the layer, counted from source rather than assumed. A
  // ladder one rung short of the widest row is invisible in every screenshot and wrong in
  // motion, which is the kind of defect only a count catches.
  let widest = 0;
  for (const file of readdirSync(VIEW).filter((name) => name.endsWith(".ts"))) {
    const source = code(file).join("\n");
    for (let at = source.indexOf("stats(["); at !== -1; at = source.indexOf("stats([", at + 1)) {
      let depth = 1;
      let cells = 0;
      for (let i = at + "stats([".length; i < source.length && depth > 0; i += 1) {
        const ch = source[i];
        if (ch === "[") {
          if (depth === 1) cells += 1;
          depth += 1;
        } else if (ch === "]") depth -= 1;
      }
      widest = Math.max(widest, cells);
    }
  }
  assert.ok(widest > 0, "at least one call site was found to measure");
  assert.equal(
    deepest,
    widest,
    `the ladder is ${deepest} deep and the widest row is ${widest} cells`,
  );

  // And the delay applies to something. `.grid` sits on the same element as `.panel`, which
  // has its own `rise`; the cells inside it need one too or every rung above is dead CSS.
  const stat = STYLESHEET.slice(STYLESHEET.indexOf("\n.stat {"));
  assert.match(
    stat.slice(0, stat.indexOf("}")),
    /animation:\s*rise/,
    ".stat must declare an animation for the ladder to delay",
  );
});

test("every table in the layer is built inside a scroll region, with no exceptions to remember", () => {
  // The About page claims every table on the site is keyboard-reachable. Seventeen call sites
  // were converted by hand, which makes the claim true today and unenforced tomorrow — the
  // eighteenth table is the one that ships without it. So the rule is textual and total: in
  // this layer, `table(` is always the first argument to `scroller(`. One call site had to be
  // restructured to make that literally true rather than nearly true, which is the point.
  const offenders: string[] = [];
  let sites = 0;
  for (const file of readdirSync(VIEW).filter((name) => name.endsWith(".ts"))) {
    // `html.ts` is where both functions are declared, so its own `export function table(`
    // and the body that follows are not call sites.
    if (file === "html.ts") continue;
    for (const [index, line] of code(file).entries()) {
      for (let at = line.indexOf("table("); at !== -1; at = line.indexOf("table(", at + 1)) {
        const before = line.slice(0, at);
        // `rowsTable(` ends in the same six characters. Only a match whose left neighbour
        // cannot continue an identifier is a call to `table` itself.
        if (/[\w$]$/.test(before)) continue;
        sites += 1;
        if (!before.endsWith("scroller(")) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.ok(sites >= 15, `expected the layer's tables to be found, saw ${sites}`);
  assert.deepEqual(offenders, [], `these tables are not inside a scroll region:\n${offenders.join("\n")}`);
});

test("the escaping and attribute helpers are unchanged by any of this", () => {
  assert.equal(esc(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.equal(esc(null), "");
  assert.equal(attrs({ a: "1", b: undefined, c: false, d: true }), ' a="1" d');
  assert.equal(definitions([]), "");
  assert.equal(
    definitions([["K", "<i>"]], ["K"]),
    "<dl>\n<dt>K</dt><dd><i></dd>\n</dl>",
  );
});

/**
 * The dashboard rendered from a result rather than from a server, for the calibration paths a
 * running fixture cannot reach.
 *
 * `tests/publish.test.ts` asks the real server for this page, which is the better test of it, and
 * it can only exercise what its panel produces: three judges deciding three adjacent pairs each,
 * which is below the floor for a bloc test and closes no triple. So the bloc table, the cycles
 * column, the "read these" tag and a warn-tagged note are HTML that no other test has ever
 * rendered — and unrendered HTML in this layer is where a `null` reaches a helper that assumed a
 * number. Feeding the page a result directly costs a synthetic context and buys the one thing the
 * socket test cannot give: a panel with something wrong with it.
 */
const dashboard = (calibration: unknown): string =>
  dashboardPage({
    command: ALL_COMMANDS[0],
    input: { event: "dogfood" },
    result: { counts: { judges: 4 }, judges: [], calibration },
    whoami: "Organizer",
    accountId: "acc",
    event: null,
    gates: null,
    now: 0,
    registry: makeRegistry(ALL_COMMANDS),
    founder: false,
  } as unknown as Parameters<typeof dashboardPage>[0]);

test("a panel with something wrong with it renders every column that says so", () => {
  const out = dashboard({
    method: "per-judge-calibration+leave-one-out",
    panelSurprise: 0.61,
    heldOut: 3,
    inSample: 1,
    panelExcess: 0.042,
    blocLevel: 0.0167,
    judges: [
      {
        judge: "j1",
        name: "Ada",
        verdict: "check",
        outstanding: 0,
        comparisons: 12,
        agreement: 0.83,
        expectedAgreement: 0.61,
        surpriseRatio: 1.9,
        cycles: 3,
        closedTriples: 8,
        findings: ["judge.offConsensus", "judge.cycles"],
        action: "Read Ada's duels against the consensus before publishing.",
      },
      {
        judge: "j2",
        name: "Grace",
        verdict: "ok",
        outstanding: 0,
        comparisons: 9,
        agreement: 0.66,
        expectedAgreement: 0.64,
        surpriseRatio: 0.9,
        cycles: 0,
        closedTriples: 6,
        findings: [],
        action: "Nothing to do.",
      },
      // The in-sample judge, whose pairwise half is null because the field came apart without
      // them. Every numeric column on this row is absent, which is the row most likely to throw.
      {
        judge: "j3",
        name: "Alan",
        verdict: "thin",
        outstanding: 2,
        comparisons: 0,
        agreement: null,
        expectedAgreement: null,
        surpriseRatio: null,
        cycles: null,
        closedTriples: 0,
        findings: ["judge.noComparisons"],
        action: "Wait for the ballots.",
      },
    ],
    blocs: [
      {
        a: "j1",
        b: "j2",
        aName: "Ada",
        bName: "Grace",
        shared: 11,
        agreed: 11,
        share: 1,
        expected: 0.62,
        excess: 0.31,
        pValue: 0.004,
        level: 0.0167,
        asked: true,
      },
      {
        a: "j1",
        b: "j3",
        aName: "Ada",
        bName: "Alan",
        shared: 6,
        agreed: 4,
        share: 0.667,
        expected: 0.64,
        excess: 0.02,
        pValue: 0.51,
        level: 0.0167,
        asked: false,
      },
    ],
    notes: [
      { code: "judge.offConsensus", severity: "warn", message: "Ada's duels are unlikely.", subjects: ["j1"] },
      { code: "judge.offset", severity: "info", message: "Grace marks slightly high.", subjects: ["j2"] },
    ],
  });

  assert.match(out, /Is this panel ready to publish\?/);
  // The verdict column, in both tones: a pill rather than a word, because the point of the
  // column is to be findable by eye in twenty rows.
  assert.ok(out.includes(`<span class="tag shut">check</span>`), "check is a shut pill");
  assert.ok(out.includes(`<span class="tag open">ready</span>`), "ok reads as ready");
  assert.ok(out.includes(`<span class="tag">thin</span>`), "and an unremarkable state is toneless");
  // Agreement is printed against what the fit predicted, never alone: 0.83 is a high number
  // only if the pairs were hard.
  assert.match(out, /0\.83 \/ 0\.61/);
  // Off consensus carries its own flag, and cycles print as a fraction of the triples that
  // could have had one — a count alone is unreadable without its denominator.
  assert.ok(out.includes(`1.90 <span class="tag shut">read these</span>`));
  assert.match(out, />3 \/ 8</);
  // The absent row prints dashes and no zeroes, in the three columns it has no figures for.
  const absent = out.slice(out.indexOf("<td>Alan</td>"), out.indexOf("</tr>", out.indexOf("<td>Alan</td>")));
  assert.equal((absent.match(/-/g) ?? []).length, 3, `the in-sample row reads: ${absent}`);
  assert.equal(absent.includes("0 / 0"), false, "no triples is not zero cycles out of zero");
  assert.equal(absent.includes(">0.00<"), false, "and a missing surprise is not a surprise of zero");
  // The bloc test ran, so its two thresholds are quoted and its table has both kinds of row.
  assert.match(out, /Typical pair, above chance/);
  assert.match(out, /Level, after correcting for the table/);
  assert.match(out, /Ada \+ Grace/);
  assert.match(out, /Ada \+ Alan/);
  assert.ok(out.includes(`<span class="tag shut">yes</span>`), "an asked pair is flagged");
  assert.match(out, /whether they judged together, not whether they cheated/);
  // Every sentence once, and the ones the verdicts are made of tagged.
  assert.equal(out.split("Ada&#39;s duels are unlikely.").length - 1, 1);
  assert.ok(out.includes(`<span class="tag shut">act on this</span> Ada&#39;s duels are unlikely.`));
  assert.ok(!out.includes(`act on this</span> Grace marks`), "an info note is not an action");
  // And the whole of it is still a page this product will serve.
  assert.equal(/<script/i.test(out), false);
  assert.equal(/ style="/.test(out), false);
});

test("a bloc level is not quoted when no pair could be tested", () => {
  // The failure this pins is a reading rather than a crash. `panelExcess` is null when no pair
  // met the shared-comparison floor, and a "—" beside a level of 0.05 reads as a threshold
  // nothing crossed, when the truth is that the test never ran.
  const out = dashboard({
    method: "per-judge-calibration+leave-one-out",
    panelSurprise: 0.5,
    heldOut: 2,
    inSample: 0,
    panelExcess: null,
    blocLevel: 0.05,
    judges: [
      {
        judge: "j1",
        name: "Ada",
        verdict: "ok",
        outstanding: 0,
        comparisons: 3,
        agreement: 0.7,
        expectedAgreement: 0.68,
        surpriseRatio: 1.1,
        cycles: 0,
        closedTriples: 0,
        findings: [],
        action: "Nothing to do.",
      },
    ],
    blocs: [],
    notes: [],
  });

  assert.match(out, /Is this panel ready to publish\?/);
  assert.equal(out.includes("Typical pair, above chance"), false);
  assert.equal(out.includes("Level, after correcting for the table"), false);
  assert.match(out, /No pair of judges shares enough comparisons/);
  assert.match(out, /The pass found nothing to say about any judge\./);
  // Two of two held out is still worth printing: it is the sentence that says the surprise
  // figures mean what the page claims they mean.
  assert.match(out, /2 of 2 judges/);
});

test("no roster means the section says so rather than drawing an empty table", () => {
  const out = dashboard(null);
  assert.match(out, /Is this panel ready to publish\?/);
  assert.match(out, /nothing to calibrate/);
  assert.equal(out.includes("Everything the pass said"), false);
  assert.equal(out.includes("Off consensus"), false, "no table, so no headers from it");
});
