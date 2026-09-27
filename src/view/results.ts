/**
 * The rubric, the organizer's dashboard, and the standings.
 *
 * These three pages are where the judging engine becomes visible, and the rule they share is
 * that a number is printed with the thing that qualifies it or not at all. An adjusted score
 * without a standard error is a false precision; a Kendall tau without the count of comparisons
 * it was computed from is a statistic nobody can weigh. Every table here carries its own
 * denominator.
 *
 * **The dashboard names judges and the public page does not.** That difference is the point of
 * both pages. `events.dashboard` is organizer-only and its whole purpose is to show who has
 * filed what, so its judge effects table names people; `results.show` redacts every judge id
 * out of its warnings - see `withoutJudges` in `src/api/commands/results.ts` - because a
 * leniency estimate published next to a volunteer's name is an appraisal nobody consented to.
 *
 * **Bars, but no charts.** A proportional bar used to be impossible here: its width had to travel
 * in an inline `style` attribute, and the Content Security Policy in `src/http/respond.ts` permits
 * stylesheets from this origin only. `meter()` solves it by snapping the width to one of fifty-one
 * classes the stylesheet defines, so a share of the variance can be drawn as well as printed. What
 * is still absent is a chart with an axis - a line, a scatter, anything whose meaning depends on
 * scale - because those mislead by construction and a table with its own denominator does not.
 * Every meter on these pages has the exact number beside it and carries an `aria-label`, so the bar
 * is the redundant half.
 *
 * The cut line: nothing here is exportable from the page. There is no CSV button and no
 * per-judge drill-down, because the JSON route beside every one of these pages is the export -
 * `/api/events/:e/results` is the same data - and a second serialization would be a second
 * thing to keep true.
 */

import { definitions, esc, meter, page, scroller, table } from "./html.ts";
import { actionPlan } from "./action-plan.ts";
import { informationPanel, evidenceGlossary } from "./information.ts";
import {
  actionForm,
  at,
  commandNamed,
  eventTrail,
  gatesNotice,
  link,
  routeFor,
  rows,
  stats,
  tag,
  when,
  zoneOf,
} from "./pages.ts";
import type { ViewContext } from "./pages.ts";

/** The event slug, as the path segment every form on these pages posts to. */
function slugOf(context: ViewContext): string {
  return String(context.input.event ?? context.event?.slug ?? "");
}

/**
 * A number, rounded for reading, with its absence spelled rather than printed as zero.
 *
 * Three decimals for anything derived - an adjusted mean, a leniency, a tau - because two hides
 * a difference in rank order and four is noise from a fit that ran to a tolerance of 1e-9. A
 * missing value is "-" and never 0: a project with no ballots has no mean, and printing 0.000
 * would put it last in a table a person sorts by eye.
 *
 * Negative zero is printed as zero. A Bradley-Terry fit centres its strengths on their own mean,
 * so the project in the middle of the field lands a rounding error below it and `toFixed` prints
 * "-0.00" - a value that appears to be negative, sorts as though it were, and is in fact zero to
 * every digit shown. The fix is on the string rather than on the number, because it is a
 * presentation defect: `-0.004` and `-0.0000001` are different quantities and only one of them
 * has any business being drawn as a signed nothing.
 */
function num(value: unknown, places = 3): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const text = value.toFixed(places);
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

/** An integer, or a dash. Same rule as `num`, without the decimals. */
function count(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "-";
}

/**
 * A share of one as a percentage, with the same absence rule as `num`.
 *
 * One decimal by default. These are shares of a resample - `12 / 400` and nothing finer - so a
 * second decimal would print a precision the replicate count does not have, and the page that
 * shows them also prints the resolution the count affords so a reader can see the grid.
 */
function percent(value: unknown, places = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${num(value * 100, places)}%`;
}

/** Which way a project moved when judge effects were removed. */
function move(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return "-";
  // Positive means the project climbed once its judges' leniency was accounted for. The arrow
  // is the character rather than a class, because the direction has to survive being copied
  // into a message, and colour alone is not a way to say it.
  return value > 0 ? `▲ ${value}` : `▼ ${Math.abs(value)}`;
}

/** The free-text caveats a fit produced, or the sentence that says there were none. */
function warningList(warnings: readonly unknown[], none: string): string {
  if (warnings.length === 0) return `<p class="muted">${esc(none)}</p>`;
  return `<ul>${warnings.map((warning) => `<li>${esc(String(warning))}</li>`).join("")}</ul>`;
}

/**
 * A share of one, printed as a percentage and drawn as a bar.
 *
 * The number comes first and the bar second, which is the order that matters. The figure is printed
 * to one decimal and the bar snaps to the nearest two percent, so the text is twenty times finer
 * than the graphic and a reader comparing 31.4% with 31.6% is reading the text either way. One
 * decimal rather than three because these are shares of a fit's own sum on an incomplete design;
 * the fourth significant figure of such a share is not a quantity anybody should be acting on.
 * `meter` carries the same string in its `aria-label`, so nothing is bar-only.
 *
 * A missing or non-numeric share draws an empty bar rather than no bar. The row exists because the
 * fit reported the quantity; a gap in the layout where one of three shares should be is harder to
 * read than a zero.
 */
function shareRow(label: string, value: unknown, tone: "" | "good" | "bad" = ""): string {
  const fraction = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const percent = `${(fraction * 100).toFixed(1)}%`;
  return `<p class="detail">${esc(label)} - ${esc(percent)}</p>
${meter(fraction, `${label}: ${percent}`, tone)}`;
}

/**
 * The rubric, its history, and the two forms that change it.
 *
 * Publishing is a separate act from writing and this page keeps them separate - one button per
 * unpublished version in the history table, rather than a `publish` checkbox on the create form.
 * `rubrics.create`'s own doc explains the reason: publishing is a one-way door, judges begin
 * scoring against whatever is published, and a ballot records the version it was cast under.
 * Two steps means an organizer reads their own rubric back before anybody is scored against it.
 *
 * Weights are shown as a share of the total as well as their raw value, because a weight is
 * meaningless alone - 3 out of 10 and 3 out of 30 are different criteria - and the arithmetic
 * is what an organizer checks before publishing.
 */
export function rubricPage(context: ViewContext): string {
  const slug = slugOf(context);
  const criteria = rows(context.result, "criteria");
  const versions = rows(context.result, "versions");
  const version = at(context.result, "version");
  const published = at(context.result, "published") === true;
  const mayEdit = at(context.result, "mayEdit") === true;
  const total = Number(at(context.result, "totalWeight") ?? 0);
  const body = ((): string => {
    if (version === null || version === undefined) {
      return `<p class="muted">No rubric has been published for this event. Judges cannot file a
ballot until there is one, because a ballot is stored against the version it was cast
under.</p>`;
    }
    return `${definitions(
      [
        ["Version", String(version)],
        ["State", published ? tag("published", "open") : tag("draft")],
        ["Criteria", String(criteria.length)],
        ["Total weight", num(total, 2)],
      ],
      ["State"],
    )}
${scroller(table(
      ["Criterion", "Key", "Range", "Weight", "Share"],
      criteria.map((criterion) => [
        String(criterion.label ?? ""),
        `<code>${esc(String(criterion.key ?? ""))}</code>`,
        `${count(criterion.min)}–${count(criterion.max)}`,
        num(criterion.weight, 2),
        total === 0 ? "-" : `${((Number(criterion.weight ?? 0) / total) * 100).toFixed(1)}%`,
      ]),
      [1],
      [3, 4],
    ), "The rubric's criteria and their weights")}`;
  })();
  const history =
    versions.length === 0
      ? ""
      : `<h2>Versions</h2>
${scroller(table(
          // The publish column exists only for someone who can publish. Rendered empty
          // for everybody else it is a column a screen reader announces and a reader
          // wonders about, holding a button that is never going to be there.
          mayEdit
            ? ["Version", "State", "Written", "vh:Publish"]
            : ["Version", "State", "Written"],
          versions.map((entry) => {
            const cells = [
              String(entry.version ?? ""),
              entry.published === true ? tag("published", "open") : tag("draft"),
              when(entry.createdAt, zoneOf(context.event)),
            ];
            if (!mayEdit) return cells;
            return [
              ...cells,
              entry.published === true
                ? ""
                : actionForm(
                    context,
                    "rubrics.publish",
                    { event: slug },
                    {
                      inline: true,
                      submit: "Publish",
                      hidden: { version: String(entry.version ?? "") },
                    },
                  ),
            ];
          }),
          mayEdit ? [1, 3] : [1],
          [0],
        ), "Rubric versions")}`;
  const write = mayEdit
    ? `<details>
<summary>Write a new version</summary>
<p>This writes a version. It does not publish one - publishing is the button in the table
above, and it is separate because it cannot be undone.</p>
${actionForm(context, "rubrics.create", { event: slug })}
</details>`
    : "";
  return page({
    title: `${context.event === null ? "Event" : context.event.name}`,
    trail: eventTrail(context, { label: "Rubric" }),
    whoami: context.whoami,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `${body}
${history}
${write}`,
  });
}

/**
 * Everything an organizer needs while judging is happening.
 *
 * It reloads itself every thirty seconds, which is the one page in this product that does. The
 * mechanism is `<meta http-equiv="refresh">` rather than an EventSource because there is no
 * client-side JavaScript here and the Content Security Policy forbids adding any; thirty seconds
 * is chosen so an organizer watching coverage fill in during the last hour sees movement without
 * the page jumping under a cursor mid-read.
 *
 * The order of the sections is the order of the questions actually asked, which is not the order
 * of the result object: who has not filed, which projects are short of reviews, whether the two
 * rankings agree, how much the ranking can carry, what each line of the rubric is doing, and only
 * then the judge effects. Effects are last because they are the section that invites the wrong
 * action - an organizer who reads a leniency of +0.6 and goes to talk to that judge has changed the
 * measurement - and the note above the table says so.
 *
 * **Per-judge noise is a column of the effects table rather than a table of its own.** It comes
 * from a different pass than leniency does, but it is a fact about the same person, and two tables
 * keyed by one judge is two places to look for one answer. The join is by account id, not by name.
 *
 * The cut line: **no per-project intervals here.** The reliability pass computes one for every
 * project and the standings page prints them all; repeating that table on the dashboard would be a
 * second copy of the ranking, on the page most likely to be read while the first copy is still
 * changing. What this page carries is the panel-level reading - tiers, separation, where the spread
 * came from - plus the ballots that reading flagged.
 */
export function dashboardPage(context: ViewContext): string {
  const slug = slugOf(context);
  const result = context.result;
  const timezone = zoneOf(context.event);
  const counts = at(result, "counts");
  const rubric = at(result, "rubric");
  const pairwise = at(result, "pairwise");
  const agreement = at(result, "agreement");
  const judges = rows(result, "judges");
  const gaps = rows(result, "gaps");
  const coverage = rows(result, "coverage");
  const effects = rows(result, "effects");
  const reliability = at(result, "reliability");
  const criteria = at(result, "criteria");
  const calibration = at(result, "calibration");
  const decision = at(result, "decisionSupport");
  const candidates = rows(decision, "candidates");
  const candidateTitle = new Map(candidates.map((p) => [String(p.project), String(p.title)]));
  const lab = at(result, "evidenceLab");
  const hodge = at(lab, "hodge");
  const distributions = at(lab, "distributions");
  const votingLab = at(lab, "voting");
  const labBlock = `<section class="evidence-lab" id="evidence-lab"><div class="section-heading"><div><p class="eyebrow">Go beyond the average</p><h2>The evidence lab</h2></div><a class="text-link" href="?lab=true#evidence-lab">Run diagnostics ↗</a></div><p class="muted">Explore preference cycles, reviewer distributions, and community voting signals. These checks never change a score.</p>${lab ? `${informationPanel(at(lab, "information"), candidateTitle)}${hodge ? `<div class="lab-energy">${shareRow("Global ranking", at(hodge, "gradientShare"))}${shareRow("Local triangle cycles", at(hodge, "curlShare"))}${shareRow("Long cycles / residual", at(hodge, "harmonicShare"))}</div><p class="detail">${esc(at(hodge, "componentCount"))} comparison groups · ${esc(at(hodge, "trianglesUsed"))} triangles · Solver ${at(hodge, "converged") ? "converged" : "needs review"}${at(hodge, "limited") ? " · Triangle basis limited" : ""}</p><p class="detail">${esc(at(hodge, "note"))}</p>${scroller(table(["Pair to review", "Observed log odds", "Fitted", "Residual"], rows(hodge, "reviewPairs").map((p) => [ `${candidateTitle.get(String(p.left)) ?? p.left} / ${candidateTitle.get(String(p.right)) ?? p.right}`, num(p.observed), num(p.fitted), num(p.residual) ]), [], [1,2,3]), "Pairwise cycle diagnostics")}` : '<p class="muted">Tournament diagnostics exceeded the bounded analysis size.</p>'}${distributions ? `<h3>How reviewers use the scale</h3>${scroller(table(["Reviewer", "Shared projects", "W2 distance", "Median residual", "Evidence"], rows(distributions, "profiles").map((p) => [String(judges.find((j) => j.judge === p.judge)?.name ?? p.judge), count(p.overlapProjects), p.distance === null ? "—" : num(p.distance), p.medianResidual === null ? "—" : num(p.medianResidual), String(p.status)]), [], [1,2,3]), "Reviewer distribution diagnostics")}<p class="detail">${esc(at(distributions, "note"))}</p>` : ""}<h3>Community voting signals</h3><p>${at(votingLab, "limited") ? "This event exceeds the interactive analysis budget. Export the voting data for an offline review." : `${esc(at(at(votingLab, "report"), "highRiskCount") ?? 0)} high-risk clusters flagged for organizer review.`}</p>${rows(at(votingLab, "report"), "clusters").map((c) => `<details><summary>Cluster ${esc(c.clusterId)} · Risk ${esc(c.riskScore)} / 100</summary><p>${esc(c.primaryReason)}</p><ul>${(Array.isArray(c.details) ? c.details : []).map((d) => `<li>${esc(d)}</li>`).join("")}</ul><p>Review state: ${esc(at(c.review, "state") ?? "unreviewed")}. Similarity alone is not evidence of wrongdoing.</p>${actionForm(context, "votes.review_abuse", { event: slug }, { inline: true, hidden: { clusterTokens: (Array.isArray(c.voterTokens) ? c.voterTokens : []).join(",") }, submit: "Record human review" })}${at(c.review, "state") === "confirmed" ? actionForm(context, "votes.discount_cluster", { event: slug }, { inline: true, hidden: { clusterTokens: (Array.isArray(c.voterTokens) ? c.voterTokens : []).join(","), discountPercent: String(Math.round((Number(c.recommendedDiscount ?? 1.0)) * 100)) }, submit: `Apply Audited Discount (${Math.round((Number(c.recommendedDiscount ?? 1.0)) * 100)}%)` }) : "<p>Confirm this exact signal before an audited discount is available.</p>"}</details>`).join("")}<p class="detail">${esc(at(votingLab, "note"))}</p>` : '<div class="lab-preview"><span>01 / Preference cycles</span><span>02 / Distribution distance</span><span>03 / Voting patterns</span></div>'}</section>`;
  const readiness = at(result, "readiness");
  const readinessBlock = `<section class="readiness" id="readiness"><div class="section-heading"><div><p class="eyebrow">Evidence checkpoint</p><h2>${esc(String(at(readiness, "status") ?? "Review evidence").replaceAll("-", " "))}</h2></div><span class="readiness-count">${esc(at(readiness, "passed") ?? 0)} / ${esc(at(readiness, "total") ?? 0)} checks passed</span></div><div class="readiness-grid">${rows(readiness, "checks").map((check) => `<article class="readiness-check ${esc(check.status)}"><span class="check-icon" aria-hidden="true">${check.status === "pass" ? "✓" : check.status === "missing" ? "!" : "↗"}</span><div><h3>${esc(check.title)}</h3><p>${esc(check.detail)}</p><span class="detail">${esc(check.status)}</span></div></article>`).join("")}</div><p class="detail">${esc(at(readiness, "note"))}</p></section>`;
  const sensitivity = at(decision, "sensitivity");
  const target = count(at(counts, "reviewsPerProject"));
  const shortCount = Number(at(counts, "shortProjects") ?? 0);
  const urgencyAlert = shortCount > 0
    ? `<div class="coverage-alert" role="alert"><span class="alert-icon" aria-hidden="true">&#9888;</span><div><strong>Review Shortfall Warning:</strong> <b>${shortCount}</b> project${shortCount === 1 ? "" : "s"} lack the required target of ${esc(target)} reviews. <a href="#coverage">Review the ${shortCount} short project${shortCount === 1 ? "" : "s"} below &darr;</a></div></div>`
    : "";
  const notStarted = judges.filter((j) => Number(j.submitted ?? 0) === 0 && Number(j.comparisons ?? 0) === 0);
  const completion = Number(at(counts, "assignments") ?? 0) === 0 ? 0 : Number(at(counts, "ballots") ?? 0) / Number(at(counts, "assignments"));
  const briefing = `<section class="briefing"><p class="eyebrow">The organizer’s briefing</p><h2>${gaps.length > 0 ? `${gaps.length} projects need more evidence.` : candidates.length > 0 ? "Coverage is complete. Review the close calls." : "Your judging room is ready."}</h2>${meter(completion, `${percent(completion)} of assigned rubric reviews filed`)}<p class="detail">${percent(completion)} of assigned rubric reviews filed. Drafts do not count.</p><ul>${notStarted.length > 0 ? `<li><b>${notStarted.length} judges have not started:</b> ${notStarted.map((j) => esc(j.name)).join(", ")}. Check their invitations and workload.</li>` : ""}${gaps.length > 0 ? `<li><a href="#coverage">Review coverage shortfalls</a> before publishing.</li>` : ""}<li>${candidates.length === 0 ? "No rubric evidence yet. Publish a rubric and collect reviews." : at(decision, "decisive") === true ? "The current intervals separate the finalist cut. Check the model warnings before making the final decision." : "The finalist cut is contested. Collect an independent review of the overlapping candidates."}</li></ul><nav class="section-index" aria-label="Dashboard sections"><a href="#decision-support">Finalist review ↓</a><a href="#judges">Judge progress ↓</a><a href="#coverage">Coverage ↓</a><a href="#audit">Audit trail ↓</a><a href="#operations">Operations ↓</a><a href="/events/${encodeURIComponent(slug)}/results">Preview results ↗</a></nav></section>`;
  const decisionBlock = `<section id="decision-support"><h2>A closer look at the cut</h2><p class="muted">Explore finalist places without changing scores or publishing results. “Within cut” means under the displayed interval scenarios; these are individual intervals, not a simultaneous guarantee.</p><form method="get" class="filter-bar"><div class="field"><label for="finalist-count">Finalist places</label><input id="finalist-count" type="number" name="finalists" min="1" max="100" value="${esc(context.input.finalists ?? 3)}"></div><label><input type="checkbox" name="sensitivity" value="true"${context.input.sensitivity === true ? " checked" : ""}> Analyze reviewer influence (up to 32 refits)</label><button type="submit">Review the evidence</button></form>${candidates.length === 0 ? '<p class="muted">Collect rubric ballots to see the finalist scenarios.</p>' : scroller(table(["Project", "Rank", "Adjusted", "Interval", "Cut assessment", "Review spread"], candidates.map((p) => [
    `<a href="/events/${encodeURIComponent(slug)}/projects/${encodeURIComponent(String(p.project))}">${esc(p.title)}</a>`, count(p.rank), num(p.fitted), `${num(p.low)} – ${num(p.high)}`,
    tag(p.status === "guaranteed" ? "within cut" : p.status === "eliminated" ? "outside cut" : "contested", p.status === "guaranteed" ? "open" : "plain"),
    `${num(p.spread, 2)} · ${esc(p.verdict)} · ${count(p.reviews)} reviews`,
  ]), [0,4,5], [1,2]), "Finalist interval scenarios")}
${rows(decision, "duels").length === 0 ? "" : `<h3>Suggested additional comparisons</h3><p class="detail">Suggestions cross the provisional cut. Assignment and track checks still apply; these do not bypass the scheduler.</p><ul>${rows(decision, "duels").map((d) => `<li>${esc(candidateTitle.get(String(d.left)) ?? d.left)} ↔ ${esc(candidateTitle.get(String(d.right)) ?? d.right)}</li>`).join("")}</ul>`}
${sensitivity == null ? "" : `<h3>How much does one reviewer change?</h3><p class="detail">${count(at(sensitivity,"judgesTested"))} of ${count(at(sensitivity,"judgesTotal"))} judges tested. ${at(sensitivity,"limited") === true ? "Bounded analysis: this is only a subset of the panel." : "Every judge was held out once."} ${count(at(sensitivity,"unstableRefits"))} refits did not fully settle. Score ranges show sensitivity, not confidence. Movement compares the same surviving projects.</p>${scroller(table(["Project", "Largest rank change", "Score range", "Lost evidence"], rows(sensitivity,"projects").map((p) => [candidateTitle.get(String(p.project)) ?? String(p.project), num(p.maxRankShift,1), `${num(p.minScore)} – ${num(p.maxScore)}`, count(p.missingWithoutJudge)]), [], [1,3]), "Reviewer influence on the ranking")}`}</section>`;
  // One row per judge with everything the two passes know about them, rather than two tables keyed
  // by the same person. Both arrays are derived from one fit, so their membership is identical; the
  // lookup is by id anyway, because a name is not a key.
  const noiseOf = new Map(
    rows(reliability, "judges").map((judge) => [String(judge.judge ?? ""), judge]),
  );
  const outliers = rows(reliability, "outliers");
  const reliabilityBlock =
    reliability === null || reliability === undefined
      ? `<p class="muted">No ballots have been fitted yet, so there is no uncertainty to
report. This section fills in as soon as the first ballot is filed against the published
rubric.</p>`
      : `<div class="pair">
<div>
<h3>What the ranking can carry</h3>
${definitions([
          ["Tiers", count(at(reliability, "tiers"))],
          [
            "First vs second",
            at(reliability, "decisive") === true ? "separated" : "not separated by this evidence",
          ],
          ["Separation", num(at(reliability, "separation"), 2)],
          ["Strata", num(at(reliability, "strata"), 2)],
          ["Reliability", num(at(reliability, "reliability"), 2)],
          ["One score's error", num(at(reliability, "errorSd"))],
          ["Ballots per project", num(at(reliability, "ballotsPerProject"), 1)],
          ["t multiplier", `${num(at(reliability, "tMultiplier"), 2)} on ${num(at(reliability, "df"), 1)} df`],
        ])}
<p class="detail">Read the tier count before the ranking. A field the panel can resolve into three
levels is a field with three levels in it, and awarding four places out of it is a decision
somebody makes rather than a result these ballots produced.</p>
</div>
<div>
<h3>Where the spread came from</h3>
${shareRow("Between projects", at(at(reliability, "varianceShare"), "project"), "good")}
${shareRow("Between judges", at(at(reliability, "varianceShare"), "judge"), "bad")}
${shareRow("Unexplained", at(at(reliability, "varianceShare"), "residual"))}
<p class="detail">A judge share larger than the project share means the panel disagreed about its
own members more than about the work, and the adjusted column on the standings is carrying the
ranking. That is the case normalization was built for, and it is also the case where another round
of reviews is worth more than another decimal place.</p>
${definitions([
          ["Between projects", num(at(reliability, "projectSd"))],
          ["Between judges", num(at(reliability, "judgeSd"))],
          ["Residual", num(at(reliability, "residualSd"))],
          ["True spread", num(at(reliability, "trueSd"))],
        ])}
</div>
</div>
${warningList(
          Array.isArray(at(reliability, "warnings"))
            ? (at(reliability, "warnings") as unknown[])
            : [],
          "The reliability pass reported nothing worth qualifying.",
        )}`;
  const outlierBlock =
    reliability === null || reliability === undefined
      ? ""
      : outliers.length === 0
        ? `<h2>Ballots worth a second look</h2>
<p class="muted">No ballot sits far enough from what the fit expects to be worth asking
about.</p>\n`
        : `<h2>Ballots worth a second look</h2>
<p class="muted">These are the ballots the fit did not expect, standardised against the panel's own
residual spread. A row here is a question and not a finding: a judge who watched a demo fail, a
project that changed between two reviews, a score typed into the wrong box. It is listed because an
organizer who cannot see it has no way to answer an appeal about it, and the answer is usually a
conversation rather than an edit.</p>
${scroller(table(
            ["Judge", "Project", "Filed", "Expected", "Difference", "z"],
            outliers.map((row) => [
              String(row.name ?? row.judge ?? "-"),
              String(row.title ?? row.project ?? "-"),
              num(row.observed, 2),
              num(row.expected, 2),
              num(row.residual, 2),
              num(row.z, 1),
            ]),
            [],
            [2, 3, 4, 5],
          ), "Ballots worth a second look")}\n`;
  /** A proportion inside a table cell: the figure, then the bar under it. One decimal, as above. */
  const cellShare = (value: unknown, tone: "" | "good" | "bad" = ""): string => {
    const fraction = typeof value === "number" && Number.isFinite(value) ? value : 0;
    const percent = `${(fraction * 100).toFixed(1)}%`;
    return `${esc(percent)}${meter(fraction, percent, tone)}`;
  };
  const verdictTag = (verdict: unknown): string => {
    const value = String(verdict ?? "");
    if (value === "discriminating") return tag(value, "open");
    if (value === "flat") return tag(value, "shut");
    return tag(value === "" ? "unknown" : value);
  };
  const criteriaRows = rows(criteria, "criteria");
  const redundant = rows(criteria, "redundant");
  const criteriaBlock =
    criteria === null || criteria === undefined || criteriaRows.length === 0
      ? `<p class="muted">No ballots have been filed against the published rubric yet, so there is
nothing to say about how its criteria are behaving.</p>`
      : `${scroller(table(
          ["Criterion", "Weight", "Scale used", "Separates", "Disputed", "With total", "Verdict"],
          criteriaRows.map((row) => [
            `${esc(String(row.label ?? ""))} <code>${esc(String(row.key ?? ""))}</code>`,
            `${num(Number(row.weight ?? 0) * 100, 1)}%`,
            cellShare(row.rangeUsed),
            cellShare(row.discrimination, "good"),
            cellShare(row.judgeDivergence, "bad"),
            num(row.withTotal, 2),
            verdictTag(row.verdict),
          ]),
          [0, 2, 3, 4, 6],
          [1, 5],
        ), "What each line of the rubric is doing")}
${definitions(
          [
            ["Mean correlation", num(at(criteria, "meanCorrelation"), 2)],
            ["Most disputed", String(at(criteria, "contested") ?? "none clears the threshold")],
            [
              "Redundant pairs",
              redundant.length === 0
                ? "none"
                : redundant
                    .map(
                      (pair) =>
                        `${esc(String(pair.a ?? ""))} + ${esc(String(pair.b ?? ""))} (${num(
                          pair.correlation,
                          2,
                        )})`,
                    )
                    .join(", "),
            ],
          ],
          ["Redundant pairs"],
        )}
${warningList(
          Array.isArray(at(criteria, "warnings")) ? (at(criteria, "warnings") as unknown[]) : [],
          "Every criterion is doing work and none of them repeat each other.",
        )}`;
  const judgeTable =
    judges.length === 0
      ? `<p class="muted">No judges have accepted an invitation yet.</p>`
      : scroller(table(
          ["Judge", "Assigned", "Filed", "Drafts", "Comparisons", "Skipped", "Last active"],
          judges.map((judge) => [
            String(judge.name ?? judge.email ?? "-"),
            count(judge.assigned),
            count(judge.submitted),
            count(judge.drafts),
            count(judge.comparisons),
            count(judge.skipped),
            when(judge.lastActiveAt, timezone),
          ]),
          [],
          [1, 2, 3, 4, 5],
        ), "The panel, and what each judge has filed");
  const coverageTable = ((): string => {
    const shown = gaps.length > 0 ? gaps : coverage;
    if (shown.length === 0) return `<p class="muted">No projects to cover yet.</p>`;
    return `${
      gaps.length > 0
        ? `<p>${esc(String(gaps.length))} of ${esc(String(coverage.length))} projects are short of
the ${esc(target)} reviews this event asks for. Only those are listed.</p>`
        : `<p>Every project has its ${esc(target)} reviews. The whole field is listed.</p>`
    }
${scroller(table(
      ["Project", "Track", "Assigned", "Filed", "Drafts", "Short by", "Comparisons"],
      shown.map((row) => [
        String(row.title ?? ""),
        String(row.trackKey ?? "-"),
        count(row.assigned),
        count(row.submitted),
        count(row.drafts),
        count(row.short),
        count(row.comparisons),
      ]),
      [],
      [2, 3, 4, 5, 6],
    ), "Review coverage, project by project")}`;
  })();
  const agreementBlock =
    agreement === null || agreement === undefined
      ? `<p class="muted">Not enough comparisons yet to compare the two rankings.</p>`
      : `${definitions([
          ["Kendall tau", num(at(agreement, "tau"))],
          ["Median gap in rank", num(at(agreement, "medianGap"), 1)],
          ["Projects flagged", count(at(agreement, "flaggedCount"))],
          ["Top-N overlap", String(rows(agreement, "topOverlap").length)],
        ])}
<p class="muted">Tau is agreement between the rubric ranking and the pairwise one, from −1 to 1.
A high tau does not mean either is right; it means they are not telling you different things.
A low one is worth reading the disagreements for.</p>
${
        rows(agreement, "disagreements").length === 0
          ? `<p class="muted">No project is ranked far apart by the two methods.</p>`
          : scroller(table(
              ["Project", "Rubric rank", "Pairwise rank", "Gap"],
              rows(agreement, "disagreements").map((row) => [
                String(row.title ?? row.project ?? ""),
                count(row.rubricRank),
                count(row.pairwiseRank),
                count(row.rankGap),
              ]),
              [],
              [1, 2, 3],
            ), "Projects the two methods rank differently")
      }`;
  const effectsBlock =
    effects.length === 0
      ? `<p class="muted">No ballots yet, so there is nothing to estimate.</p>`
      : scroller(table(
          ["Judge", "Ballots", "Leniency", "Scale", "Shrunk by", "Weight", "Noise", "Clamped"],
          effects.map((row) => {
            const noise = noiseOf.get(String(row.judge ?? ""));
            return [
              String(row.name ?? "-"),
              count(row.ballots),
              num(row.leniency),
              num(row.scale),
              num(row.shrinkage, 2),
              num(row.informationWeight, 2),
              noise === undefined
                ? "-"
                : noise.flagged === true
                  ? `${num(noise.relative, 2)} ${tag("noisy", "shut")}`
                  : num(noise.relative, 2),
              row.clamped === true ? "yes" : "no",
            ];
          }),
          [6],
          [1, 2, 3, 4, 5, 6],
        ), "Judge leniency, scale and noise");
  /**
   * The pre-publish read on the panel: one row per judge, worst first, with the sentence that says
   * what to do about it.
   *
   * Three rules hold this section together, and they are the reason it is a section rather than more
   * columns on the roster table above. It leads with a verdict, because an organizer with twenty
   * judges and an hour before the ceremony needs to know which three rows to read. Every figure in
   * it is one nothing else on the page shows - leniency, scale and noise are in Judge effects and are
   * deliberately not repeated here. And each sentence the pass produced is printed exactly once, in
   * the list below the table, which is also why this is the one block on the page that does not call
   * `warningList`: `notes` already contains every warning, tagged, so printing both lists would ask
   * the same question twice and leave the reader deciding whether it was asked about two things.
   *
   * The cut line: a verdict is never shown to the judge it is about. There is no per-judge view of
   * this, no email, and no route that renders it under a judge's session - `results.show` publishes
   * per-project movement instead, and `tests/publish.test.ts` sweeps every public body for the words
   * in it. A calibration report a judge can read is a calibration report that changes the ballots it
   * was computed from.
   */
  const readyTag = (verdict: unknown): string => {
    const value = String(verdict ?? "");
    if (value === "ok") return tag("ready", "open");
    if (value === "check" || value === "behind") return tag(value, "shut");
    return tag(value === "" ? "unknown" : value);
  };
  const calibrationRows = rows(calibration, "judges");
  const blocs = rows(calibration, "blocs");
  const calibrationNotes = rows(calibration, "notes");
  const calibrationBlock =
    calibration === null || calibration === undefined || calibrationRows.length === 0
      ? `<p class="muted">No judges on the roster yet, so there is nothing to calibrate. This
section fills in as soon as the first invitation is accepted.</p>`
      : `${scroller(table(
          ["Judge", "Ready", "Outstanding", "Duels", "Agreed / expected", "Off consensus", "Cycles", "What to do"],
          calibrationRows.map((row) => [
            String(row.name ?? row.judge ?? "-"),
            readyTag(row.verdict),
            count(row.outstanding),
            count(row.comparisons),
            row.agreement === null || row.agreement === undefined
              ? "-"
              : `${num(row.agreement, 2)} / ${num(row.expectedAgreement, 2)}`,
            row.surpriseRatio === null || row.surpriseRatio === undefined
              ? "-"
              : `${num(row.surpriseRatio, 2)}${
                  Array.isArray(row.findings) && row.findings.includes("judge.offConsensus")
                    ? ` ${tag("read these", "shut")}`
                    : ""
                }`,
            Number(row.closedTriples ?? 0) === 0
              ? "-"
              : `${count(row.cycles)} / ${count(row.closedTriples)}`,
            String(row.action ?? ""),
          ]),
          [1, 4, 5, 6],
          [2, 3, 4, 5, 6],
        ), "Is each judge's part of the panel ready to publish")}
${definitions([
          ["Method", String(at(calibration, "method") ?? "-")],
          ["Panel surprise", num(at(calibration, "panelSurprise"), 3)],
          [
            "Measured out of their own fit",
            `${count(at(calibration, "heldOut"))} of ${count(
              Number(at(calibration, "heldOut") ?? 0) + Number(at(calibration, "inSample") ?? 0),
            )} judges`,
          ],
          // Both of these describe the bloc test, so they are printed only when it ran. A level
          // quoted beside an empty table reads as a threshold nothing crossed, when the truth is
          // that no pair of judges shared enough comparisons to be tested at all.
          ...(blocs.length === 0
            ? []
            : ([
                ["Typical pair, above chance", num(at(calibration, "panelExcess"), 3)],
                ["Level, after correcting for the table", num(at(calibration, "blocLevel"), 4)],
              ] as [string, string][])),
        ])}
<p class="detail">Surprise is how unlikely this judge's duels are under a model fitted without them,
per duel, so it is comparable across judges who decided different numbers. A judge measured in
sample rather than held out is one whose removal disconnects the field: their own decisions are in
the model they are being scored against, which flatters them, and the row says so.</p>
${
          blocs.length === 0
            ? `<p class="muted">No pair of judges shares enough comparisons to test for agreement
beyond what this panel predicts.</p>`
            : `${scroller(table(
                ["Pair", "Shared", "Agreed", "Share", "Expected", "Excess", "Chance of it", "Level", "Asked"],
                blocs.map((row) => [
                  `${esc(String(row.aName ?? row.a ?? ""))} + ${esc(String(row.bName ?? row.b ?? ""))}`,
                  count(row.shared),
                  count(row.agreed),
                  cellShare(row.share),
                  cellShare(row.expected),
                  num(row.excess, 3),
                  num(row.pValue, 4),
                  num(row.level, 4),
                  row.asked === true ? tag("yes", "shut") : "no",
                ]),
                [0, 3, 4, 8],
                [1, 2, 5, 6, 7],
              ), "Judge pairs who agree more than this panel predicts")}
<p class="detail">Expected is what these two would agree on by the fitted strengths of the pairs they
actually shared, so a pair handed only obvious comparisons is not accused of anything. Excess is
share minus expected, corrected for the shrinkage the fit applies to every pair. "Chance of it" is
the probability of agreeing at least this often if both were deciding independently, and the level
beside it is already divided by the number of pairs tested - a longer table therefore buys a
stricter threshold rather than a laxer one. Only a row asked about is a question, and the question is
whether they judged together, not whether they cheated.</p>`
        }
${
          calibrationNotes.length === 0
            ? `<p class="muted">The pass found nothing to say about any judge.</p>`
            : `<h3>Everything the pass said</h3>
<p class="detail">Each of these is said once here and nowhere else on the page. The tagged ones are
what the verdicts above are made of; the rest are printed so that noticing them in the raw ballots
does not look like a discovery.</p>
<ul>${calibrationNotes
                .map(
                  (note) =>
                    `<li>${
                      note.severity === "warn" ? `${tag("act on this", "shut")} ` : ""
                    }${esc(String(note.message ?? ""))}</li>`,
                )
                .join("")}</ul>`
        }`;
  return page({
    title: `${context.event === null ? "Event" : context.event.name}`,
    trail: eventTrail(context, { label: "Dashboard" }),
    whoami: context.whoami,
    lead: "Understand the evidence. Support your panel. Publish with context.",
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `${urgencyAlert}${briefing}${actionPlan(rows(readiness, "checks").map((c) => ({ code: String(c.code), status: String(c.status), title: String(c.title), detail: String(c.detail) })), slug)}${stats([
      ["projects", count(at(counts, "projects"))],
      ["judges", count(at(counts, "judges"))],
      ["ballots filed", count(at(counts, "ballots"))],
      ["drafts", count(at(counts, "drafts"))],
      ["comparisons", count(at(counts, "comparisons"))],
      ["skipped", count(at(counts, "skipped"))],
      ["projects short", count(at(counts, "shortProjects"))],
    ])}
<p class="muted">Snapshot ${esc(when(context.now, timezone))}. <a href="/events/${encodeURIComponent(slug)}/dashboard">Refresh progress</a>. Comparisons include skips; results count decided comparisons.</p>
${readinessBlock}
${evidenceGlossary()}
${decisionBlock}
<h2 id="judges">Judges</h2>
${judgeTable}
<h2>Is this panel ready to publish?</h2>
<p class="muted">A verdict per judge, worst first, and the one thing to do about it. This is the
section to read before the standings: everything below is about the field and the fit, and this is
about whether the panel that produced them is finished. Nothing here can move a ranking - the pass
refits the pairwise model once per judge, to measure each of them against a consensus that excludes
their own decisions, and throws every refit away. It is also organizer-only in a stronger sense than
the rest of this page: a verdict is never shown to the judge it is about, because a judge who reads
one starts judging the report instead of the work.</p>
${calibrationBlock}
<h2 id="coverage">Coverage</h2>
${coverageTable}
<details class="advanced-analysis"><summary>Inspect model diagnostics, uncertainty, and judge effects</summary>
<h2>Do the two rankings agree?</h2>
${agreementBlock}
<h2>How much the ranking can carry</h2>
${reliabilityBlock}
${outlierBlock}<h2>What each line of the rubric is doing</h2>
<p class="muted">A rubric is a hypothesis: that these criteria, weighted like this, are what
separates a good entry from a mediocre one. This is the check on it. "Separates" is how much of a
criterion's spread is between projects rather than between judges scoring the same one; "Disputed"
is how far apart the panel read the words, with each judge's general strictness taken out first.
Nothing here can move a ranking - it fits nothing and the fit never consults it - and the right
response to a flat criterion is to rewrite it before the next event, not to reweight it midway
through and invalidate the ballots already filed.</p>
${criteriaBlock}
<h2>Judge effects</h2>
<p class="muted">What the normalization removed, per judge. Leniency is how much higher than
the field this judge scores; scale is how spread out their scores are. Both are shrunk toward
neutral in proportion to how few ballots they filed - a judge with two ballots is not evidence
of a tendency. Noise is this judge's residual spread over the panel's: above one is a judge the
fit predicts less well than average, which is information about how much their ballots pin down
and not a verdict on their judgement. This is diagnostic, not a performance review: mentioning a
number here to the judge it describes changes the scores it was computed from.</p>
${effectsBlock}
${
      rubric === null || rubric === undefined
        ? ""
        : `${definitions([
            ["Method", String(at(rubric, "method") ?? "-")],
            ["Rounds", count(at(rubric, "rounds"))],
            ["Converged", at(rubric, "converged") === true ? "yes" : "no"],
            ["Grand mean", num(at(rubric, "grandMean"))],
            ["Residual SD", num(at(rubric, "residualSd"))],
          ])}
${warningList(
            Array.isArray(at(rubric, "warnings")) ? (at(rubric, "warnings") as unknown[]) : [],
            "The fit reported nothing worth qualifying.",
          )}\n`
    }${
      pairwise === null || pairwise === undefined
        ? ""
        : `<h2>Pairwise fit</h2>
${definitions([
            ["Method", String(at(pairwise, "method") ?? "-")],
            ["Iterations", count(at(pairwise, "iterations"))],
            ["Converged", at(pairwise, "converged") === true ? "yes" : "no"],
            [
              "Connected",
              at(pairwise, "connected") === true
                ? "yes"
                : `no - ${count(at(pairwise, "componentCount"))} groups with no comparisons between them`,
            ],
          ])}
${warningList(
            Array.isArray(at(pairwise, "warnings")) ? (at(pairwise, "warnings") as unknown[]) : [],
            "The fit reported nothing worth qualifying.",
          )}\n`
    }</details>${labBlock}<section id="audit"><h2>Decision trail</h2><p class="muted">The latest 30 changes in this event. Export the audit CSV for the full record. A published head hash can serve as an external checkpoint; the chain alone does not prevent an administrator rewriting it.</p><details><summary>Current ledger checkpoint</summary><p class="code">${esc(at(at(result,"audit"),"head") ?? "Unavailable")}</p></details>${scroller(table(["When", "Action", "Actor", "Details"], rows(at(result,"audit"),"entries").map((entry) => [when(entry.at, timezone), String(entry.action), String(entry.actor), `<details><summary>Record ${esc(entry.seq)}</summary><p class="code">${esc(entry.subject)}</p><p class="code">${esc(entry.payload)}</p><p class="code">${esc(entry.hash)}</p></details>`]), [3]), "Recent event audit trail")}</section><h2 id="operations">Draw assignments</h2>
<p>Assigning judges to projects is idempotent in effect but not in cost: drawing again after
ballots exist adds assignments rather than replacing them. Preview first.</p>
${actionForm(context, "assignments.preview", { event: slug }, { method: "get", submit: "Preview assignments" })}
<details><summary>Judge eligibility, capacity, and recusals</summary>
<p>Use judge IDs from the progress table. Track keys must belong to this event. A preview shows coverage shortfalls before you apply the draw. Existing submitted ballots remain preserved.</p>
<p><a href="/api/events/${encodeURIComponent(slug)}/judges/roster">Inspect the current roster rules</a></p>
${actionForm(context, "judges.configure", { event: slug })}
${actionForm(context, "judges.recusal", { event: slug })}
</details>
<details><summary>Voting anomaly thresholds</summary>
<p>Set these for this event. A flag opens an investigation; it never changes a vote by itself. Inspect benign shared-network and coordinated outreach patterns before confirming a signal.</p>
<p><a href="/api/events/${encodeURIComponent(slug)}/voting/abuse">Inspect voting signals and review states</a></p>
${actionForm(context, "votes.configure_abuse", { event: slug })}
</details>
<h2>Add a track</h2>
${actionForm(context, "tracks.create", { event: slug })}
<h2>Exports &amp; Integrations</h2>
<p>Full RFC 4180 CSV export at every stage:</p>
<p class="export-links">
  <a href="/events/${esc(slug)}/csv/registrations">Registrations</a> ·
  <a href="/events/${esc(slug)}/csv/teams">Teams</a> ·
  <a href="/events/${esc(slug)}/csv/projects">Projects</a> ·
  <a href="/events/${esc(slug)}/csv/assignments">Assignments</a> ·
  <a href="/events/${esc(slug)}/csv/ballots">Ballots</a> ·
  <a href="/events/${esc(slug)}/csv/results">Results</a> ·
  <a href="/events/${esc(slug)}/csv/votes">Votes</a> ·
  <a href="/events/${esc(slug)}/csv/audit">Audit</a>
</p>
<p>
  <a href="/verify">Offline Certificate Verifier</a> ·
  <a href="/.well-known/manak-key.pub">Server Ed25519 Public Key</a> ·
  <a href="/widget.js">Embeddable Gallery Widget</a>
</p>
<p><a href="${esc(
      routeFor(commandNamed(context.registry, "results.show"), { event: slug }),
    )}">Standings</a> · <a href="${esc(
      routeFor(commandNamed(context.registry, "rubrics.show"), { event: slug }),
    )}">Rubric</a> · <a href="${esc(
      routeFor(commandNamed(context.registry, "projects.list"), { event: slug }),
    )}">Projects</a></p>`,
  });
}

/**
 * The standings, and the switch that makes them public.
 *
 * One page in two states, distinguished by `published` rather than by route. An organizer
 * previewing unpublished results and a visitor reading published ones are looking at the same
 * table, which is the property that matters: a preview that rendered differently from the public
 * page would be a preview of something else.
 *
 * **Both ranks are shown.** `rank` is after normalization and `rankRaw` is before it, with the
 * movement between them in its own column, because a portal that quietly reordered the field and
 * showed only the result is a portal whose organizer cannot answer "why is this project third".
 * The movement column is the honest form of the claim the normalization bonus is about.
 *
 * **Every adjusted score is printed with the interval around it, and its tier.** The interval is
 * the standard error made readable: a project with two ballots and one with six do not have
 * comparably precise means, and a table of means alone invites a tie-break on the third decimal of
 * a number whose error bar is wider than the gap. The tier is the stronger statement - projects
 * sharing one are not separated by this evidence at all - and it is the number an appeal is
 * answered with. `standardError` is still on the JSON for anybody who wants the raw quantity; the
 * page prints the two endpoints because those are what a person can act on.
 *
 * When there is no rubric fit there is no interval either, and the table changes shape rather than
 * filling the same columns with dashes. A pure-pairwise ranking has strengths and nothing else: no
 * ballot means, no error estimate, and no "before normalization" rank to have moved from. Printing
 * those columns empty would read as data that failed to load; the narrow table says instead that
 * this method answers a smaller question. Which table is drawn is decided by the fields the rows
 * actually carry, not by the presence of the panel block, because a fit can run without the
 * reliability pass and those rows do have means to print.
 *
 * The warnings are printed in full and unedited except for one substitution: judge ids have been
 * replaced with positional labels by the command before this page ever sees them. That is done
 * there rather than here so a JSON client gets the same redaction - see `withoutJudges`.
 */
export function resultsPage(context: ViewContext): string {
  const slug = slugOf(context);
  const result = context.result;
  const published = at(result, "published") === true;
  const mayPublish = at(result, "mayPublish") === true;
  const projects = rows(result, "projects");
  const pairwise = at(result, "pairwise");
  const agreement = at(result, "agreement");
  const panel = at(result, "panel");
  // Which table to draw. The interval columns exist exactly when the reliability pass ran, which
  // is exactly when there is a rubric fit with projects in it.
  const spans = panel !== null && panel !== undefined;
  // Whether a rubric fit produced these rows at all. A pure-pairwise row carries no `rawMean` and
  // no `standardError` - the command omits both rather than sending zeros - so asking whether the
  // mean arrived is the honest test. It is asked of the rows rather than of the panel because a fit
  // can produce means without the reliability pass having run, and those rows do have means to show.
  const fitted = projects.some((row) => typeof row.rawMean === "number");
  const warnings = Array.isArray(at(result, "warnings"))
    ? (at(result, "warnings") as unknown[])
    : [];
  const headers = spans
    ? ["#", "Tier", "Project", "Track", "Ballots", "Raw mean", "Adjusted", "95% range", "Was", "Moved"]
    : fitted
      ? ["#", "Project", "Track", "Ballots", "Raw mean", "Adjusted", "± error", "Was", "Moved"]
      : ["#", "Project", "Track", "Strength"];
  const cells = (row: Record<string, unknown>): string[] =>
    fitted
      ? [
          ...(spans ? [count(row.rank), count(row.tier)] : [count(row.rank)]),
          String(row.title ?? ""),
          String(row.trackKey ?? "-"),
          count(row.ballots),
          num(row.rawMean, 2),
          num(row.adjusted),
          spans ? `${num(row.low, 2)} – ${num(row.high, 2)}` : num(row.standardError),
          count(row.rankRaw),
          move(row.rankMove),
        ]
      : [count(row.rank), String(row.title ?? ""), String(row.trackKey ?? "-"), num(row.adjusted)];
  const standings =
    projects.length === 0
      ? `<p class="muted">Nothing has been scored yet.</p>`
      : `${
          fitted
            ? ""
            : `<p class="muted">Nobody filed a rubric ballot, so this order comes from the
head-to-head comparisons alone. A strength is not a score out of anything: it is the number that
best explains who beat whom, and it means nothing except against the others in this table. Wins,
losses and the comparison count behind each one are below.</p>\n`
        }${scroller(table(
          headers,
          projects.map(cells),
          [],
          spans ? [0, 1, 4, 5, 6, 7, 8, 9] : fitted ? [0, 3, 4, 5, 6, 7, 8] : [0, 3],
        ), "Standings")}`;
  const strengths = pairwise === null || pairwise === undefined ? [] : rows(pairwise, "strengths");
  const tiers = Number(at(panel, "tiers") ?? 0);
  const decisive = at(panel, "decisive") === true;
  const panelBlock = !spans
    ? ""
    : `<h2>How much of this order the evidence supports</h2>
<div class="pair">
<div>
<h3>Tiers</h3>
<p class="advice">${esc(count(tiers))} ${tiers === 1 ? "level" : "levels"} across ${esc(
        String(projects.length),
      )} ${projects.length === 1 ? "project" : "projects"}.</p>
<p class="detail">A tier holds the projects that are not separated from the one at the top of it, so
awarding on a tier's leader is defensible where awarding on the printed place is not. That is a
statement about the ballots and not about the work: it means the panel did not give enough
information to tell those entries apart, and a place chosen inside a tier is a judgement somebody
has to make rather than a number this portal produced.</p>
${definitions([
        ["First vs second", decisive ? "separated" : "not separated by this evidence"],
        ["Separation", num(at(panel, "separation"), 2)],
        ["Strata", num(at(panel, "strata"), 2)],
        ["Reliability", num(at(panel, "reliability"), 2)],
        ["Interval", `${num(Number(at(panel, "confidence") ?? 0) * 100, 0)}%`],
        ["Ballots per project", num(at(panel, "ballotsPerProject"), 1)],
      ])}
<p class="detail">Reliability is the share of the spread in these scores that is real rather than
noise: run the event again with a different panel of the same size, and this is roughly how much
of the ranking would survive. Separation is the same quantity as a ratio, and the tier count comes
from it directly by the Wright and Masters strata formula.</p>
</div>
<div>
<h3>Where the spread came from</h3>
${shareRow("Between projects", at(at(panel, "varianceShare"), "project"), "good")}
${shareRow("Between judges", at(at(panel, "varianceShare"), "judge"), "bad")}
${shareRow("Unexplained", at(at(panel, "varianceShare"), "residual"))}
<p class="detail">The first share is the one that should be largest: it is disagreement about the
projects, which is what a judging round is for. The second is disagreement about the judges, and it
is the share normalization exists to remove - a large one means the adjusted column above is doing
real work rather than decorating the raw one. The third is everything neither explains.</p>
${definitions([
        ["Between projects", num(at(panel, "projectSd"))],
        ["Between judges", num(at(panel, "judgeSd"))],
        ["Residual", num(at(panel, "residualSd"))],
        ["One score's error", num(at(panel, "errorSd"))],
      ])}
<p class="detail">The same three quantities as spreads on the rubric's own scale, for anybody
checking the arithmetic. They are shares of their own sum rather than an exact partition, which is
what any fit on an incomplete design can offer.</p>
</div>
</div>`;
  // The pairwise ranking has its own uncertainty, computed differently and on its own page because
  // it costs a second to compute. Offered only where there is a pairwise fit to ask about, and the
  // link says what the page answers rather than naming the statistic - "confidence intervals on the
  // Bradley-Terry strengths" is a phrase that tells the reader who needs it least.
  const confidenceLink =
    strengths.length === 0
      ? ""
      : `<p><a href="${esc(
          routeFor(commandNamed(context.registry, "results.confidence"), { event: slug }),
        )}">Which of these head-to-head places are real, and which are ties</a> - the duel order
resampled a few hundred times, on its own page because it costs a second to work out.</p>`;
  const pairwiseBlock =
    strengths.length === 0
      ? ""
      : `<h2>Pairwise standing</h2>
<p class="muted">A separate ranking from head-to-head comparisons, fitted by Bradley-Terry.
It is published beside the rubric ranking rather than blended into it: two methods that agree
are evidence, and one number that hides a disagreement is not.</p>
${scroller(table(
          ["#", "Project", "Strength", "Won", "Lost", "Comparisons"],
          strengths.map((row) => [
            count(row.rank),
            String(row.title ?? ""),
            num(row.beta),
            count(row.wins),
            count(row.losses),
            count(row.comparisons),
          ]),
          [],
          [0, 2, 3, 4, 5],
        ), "Pairwise standing")}
${confidenceLink}
${
          at(pairwise, "connected") === true
            ? ""
            : `<p class="muted">The comparison graph is in ${count(
                at(pairwise, "componentCount"),
              )} groups with no comparisons between them, so strengths are only comparable within
a group. Treat rank across groups as unfounded.</p>\n`
        }`;
  const switchForm = !mayPublish
    ? ""
    : published
      ? `<h2>Unpublish</h2>
<p>This hides the standings from everybody but the organizers again. It does not change a
single score, and anybody who already read them has already read them.</p>
${actionForm(context, "results.unpublish", { event: slug })}
<details><summary>Publish a correction</summary><p>A correction records a new immutable revision with a reason and the current evidence. Earlier revisions remain in the history.</p>
${actionForm(context, "results.publish", { event: slug })}</details>
<details><summary>Review judge evidence</summary><p>Use a judge account ID from the organizer dashboard. Exclusion retains the original ballots and comparisons and publishes a corrected result revision.</p>
${actionForm(context, "results.judge_evidence", { event: slug })}</details>`
      : `<h2>Publish</h2>
<p>This is what makes the table above visible to participants and to the public. Read the
warnings first; they are published with it.</p>
${actionForm(context, "results.publish", { event: slug })}`;
  const certificatesBlock = !published || !mayPublish
    ? ""
    : `<h2>Verifiable Ed25519 Certificates</h2>
<p class="muted">Issue a permanent snapshot, then download the same signed records at any time. Repeating issuance does not change their dates or signatures. Share individual records with recipients; the full download contains email addresses. Give recipients the public key fingerprint through an independent channel.</p>
<p><a href="/api/events/${encodeURIComponent(slug)}/certificates">Download Issued Certificates (JSON)</a> · <a href="/api/events/${encodeURIComponent(slug)}/certificates/status">Signed correction bundle</a> · <a href="/verify">Offline Certificate Verifier</a></p>${
      mayPublish
        ? actionForm(context, "results.issue_certs", { event: slug }, {
            legend: "Issue certificates once",
            submit: "Issue & Sign All Certificates",
          })
        : ""
    }<details><summary>Revoke or replace a certificate</summary><p>Corrections are signed and append-only. A replacement needs the corrected recipient and detail fields; download the private response and share that single record with its recipient.</p>
${actionForm(context, "results.correct_cert", { event: slug })}</details>`;
  return page({
    title: `${context.event === null ? "Event" : context.event.name}`,
    trail: eventTrail(context, { label: "Results" }),
    whoami: context.whoami,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `<p>${
      published
        ? tag("published", "open")
        : `${tag("not published", "shut")} You are reading a preview. Nobody else can see this
page yet.`
    }</p>
${typeof at(result, "revision") === "number" ? `<p class="muted">Publication revision ${esc(at(result, "revision"))} · Evidence cutoff ${esc(when(at(result, "evidenceCutoffAt"), zoneOf(context)))} · Digest <code>${esc(at(result, "evidenceDigest"))}</code>. <a href="/api/events/${encodeURIComponent(slug)}/results/history">Correction history</a>.</p>` : ""}
${stats([
      ["projects ranked", projects.length],
      ["ballots counted", count(at(result, "ballots"))],
      ["comparisons decided", count(at(result, "comparisonsDecided"))],
      ["rubric version", count(at(result, "rubricVersion"))],
    ])}
${definitions([
      ["Method", String(at(result, "method") ?? "-")],
      ["Converged", at(result, "converged") === true ? "yes" : "no - treat the ordering as provisional"],
      ["Grand mean", num(at(result, "grandMean"))],
      ["Residual SD", num(at(result, "residualSd"))],
      [
        "Rankings agree",
        agreement === null || agreement === undefined
          ? "not enough comparisons to say"
          : `Kendall tau ${num(at(agreement, "tau"))}`,
      ],
      [
        "Tiers the evidence supports",
        spans
          ? `${count(tiers)} - ${decisive ? "first place is separated" : "first and second are not separated"}`
          : "no rubric fit, so no interval",
      ],
    ])}
${standings}
${panelBlock}
<h2>What qualifies these numbers</h2>
${warningList(warnings, "The fit reported nothing worth qualifying.")}
<p class="muted">Judges are named positionally - "Judge B" - and not by account, deliberately:
these caveats are published, and an appraisal of a volunteer is not something this portal
publishes. The organizer's dashboard names them, because that is where the person who can act
on it reads.</p>
${pairwiseBlock}${certificatesBlock}${switchForm}
<p class="muted">The same figures as JSON: <a href="${esc(
      routeFor(commandNamed(context.registry, "results.show"), { event: slug }).replace(
        "/events/",
        "/api/events/",
      ),
    )}">this page's API route</a>. ${esc(link("") === "-" ? "" : "")}</p>`,
  });
}

/**
 * Which parts of the duel ranking the comparisons establish, and which parts are a tie.
 *
 * This is the page that answers the question a leaderboard cannot: not "who is third" but "is
 * third a finding". `results.confidence` refits the pairwise ranking a few hundred times on
 * resampled panels, and everything here is read off the spread of those answers.
 *
 * **The pair table comes before the ranking.** Every other page in this product leads with the
 * order and qualifies it afterwards, and on this one that would be backwards: a reader who sees a
 * numbered table first has already formed the belief the rest of the page exists to complicate.
 * So the first thing rendered is the verdict per adjacent pair - separated, or not separated by
 * this evidence - and the ranking follows as the detail behind it.
 *
 * **A tie is stated as a tie and not as a small number.** "Reversed in 29% of resamples" is the
 * evidence; "not separated" is the finding, and it is the finding that goes in a column a person
 * scans. The alternative - printing the share and letting the reader compare it against the
 * threshold - puts the statistical judgement on somebody who came to find out who won.
 *
 * **Both knobs are on the page, as a GET form.** Resolution costs time and confidence costs
 * separations, and an organizer who cannot see either lever will read one setting's answer as the
 * answer. The form submits by `get` so the result is a URL: a co-organizer sent this link sees the
 * same intervals, which is also why the seed is printed at the bottom.
 *
 * The cut line: **no chart, and no per-pair histogram.** The natural graphic here is a caterpillar
 * plot of intervals, and it is genuinely the clearest way to show overlap - but it needs an axis,
 * and an axis on a log-strength scale is a number nobody can interpret without a legend explaining
 * that the units are arbitrary. The tier grouping is the same statement without a scale: projects
 * in one tier are not separated. What is drawn is `meter`, for shares, which have a denominator a
 * reader already knows.
 */
export function confidencePage(context: ViewContext): string {
  const slug = slugOf(context);
  const result = context.result;
  const published = at(result, "published") === true;
  const resample = at(result, "resample");
  const projects = rows(resample, "projects");
  const pairs = rows(resample, "pairs");
  const notes = rows(resample, "notes");
  const warnings = Array.isArray(at(result, "warnings"))
    ? (at(result, "warnings") as unknown[])
    : [];
  const separated = pairs.filter((pair) => pair.ordered === true).length;
  const decisive = at(resample, "decisive") === true;
  const tiers = Number(at(resample, "tiers") ?? 0);
  const unplaced = Number(at(resample, "unplaced") ?? 0);
  const pairTable =
    pairs.length === 0
      ? `<p class="muted">There are no adjacent pairs to test, which needs at least two projects
somebody compared.</p>`
      : scroller(table(
          ["Higher", "Lower", "Gap", "Reversed in", "Verdict"],
          pairs.map((pair) => [
            String(pair.aboveTitle ?? pair.above ?? ""),
            String(pair.belowTitle ?? pair.below ?? ""),
            num(pair.betaGap, 2),
            percent(pair.reversalShare),
            pair.ordered === true
              ? tag("separated", "open")
              : `${tag("not separated", "shut")} indistinguishable on this evidence`,
          ]),
          [4],
          [2, 3],
        ), "Whether each adjacent pair is separated");
  const tierGroups = ((): string => {
    if (projects.length === 0) return "";
    const byTier = new Map<number, string[]>();
    for (const row of projects) {
      const tier = Number(row.tier ?? 0);
      const list = byTier.get(tier);
      const title = String(row.title ?? row.project ?? "");
      if (list === undefined) byTier.set(tier, [title]);
      else list.push(title);
    }
    // Tier 0 is the unplaced projects, which belong to no level and are listed last under their
    // own term rather than folded into the highest one.
    const placed = [...byTier.entries()].filter(([tier]) => tier > 0).sort((a, b) => a[0] - b[0]);
    const loose = byTier.get(0) ?? [];
    // The first title in a level is the project the level was formed around, because `projects` is
    // in rank order and the engine opens a level with whichever project could not be kept in the
    // one above. Naming it is the difference between a group a reader can act on and a group that
    // looks like a claim of mutual ties - see the prose under the heading.
    const level = (titles: readonly string[]): string => {
      const [leader, ...rest] = titles;
      if (rest.length === 0) return leader as string;
      const held =
        rest.length === 1
          ? `${rest[0] as string}, which these duels do not separate from it`
          : `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1] as string}, none of ` +
            `which these duels separate from it`;
      return `${leader as string} - with ${held}`;
    };
    return definitions([
      ...placed.map(([tier, titles]) => [`Level ${tier}`, level(titles)] as const),
      ...(loose.length === 0 ? [] : ([["Not placed", loose.join(", ")]] as const)),
    ]);
  })();
  const controls = `<details>
<summary>Resample with different settings</summary>
<p>More resamples resolve a finer tail and cost more time; a higher confidence level demands more
evidence before it calls one project ahead of another, and therefore separates fewer pairs. Neither
changes a single score - the ranking above is the same fit either way, and what moves is only how
much of it this page is willing to call established.</p>
${actionForm(context, "results.confidence", { event: slug }, {
    method: "get",
    submit: "Resample",
    prefill: {
      replicates: String(context.input.replicates ?? ""),
      confidence: String(context.input.confidence ?? ""),
    },
  })}
</details>`;
  const ranking =
    projects.length === 0
      ? `<p class="muted">No project has been compared yet.</p>`
      : scroller(table(
          [
            "#",
            "Level",
            "Project",
            "Track",
            "Strength",
            `${percent(at(resample, "confidence"), 0)} range`,
            "Could place",
            "Holds this place",
            // `firstPlaceShare`, and the header used to read "Wins" - which is a real quantity on
            // the standings page and not this one. It printed 100% against the leader and 0%
            // against a project with four duel wins to its name, so the one reader who checked the
            // column against the pair table would have found the page contradicting itself.
            "Comes first",
            "Duels",
          ],
          projects.map((row) => [
            row.placed === true ? count(row.rank) : "-",
            row.placed === true ? count(row.tier) : tag("not placed", "shut"),
            String(row.title ?? row.project ?? ""),
            String(row.trackKey ?? "-"),
            num(row.beta, 2),
            `${num(row.low, 2)} – ${num(row.high, 2)}`,
            row.placed === true ? `${count(row.rankLow)} – ${count(row.rankHigh)}` : "-",
            percent(row.rankStability, 0),
            percent(row.firstPlaceShare, 0),
            count(row.comparisons),
          ]),
          [1],
          [0, 4, 5, 6, 7, 8, 9],
        ), "The duel ranking with its resampled intervals");
  const noteTable =
    notes.length === 0
      ? `<p class="muted">The resample reported nothing worth qualifying.</p>`
      : scroller(table(
          ["vh:How serious", "What the resample noticed", "Code"],
          notes.map((note) => [
            note.severity === "warn" ? tag("warn", "shut") : tag("note"),
            String(note.message ?? ""),
            `<code>${esc(String(note.code ?? ""))}</code>`,
          ]),
          [0, 2],
          [],
        ), "What the resample noticed");
  const cut = Number(at(resample, "replicates") ?? 0);
  const asked = Number(at(resample, "replicatesRequested") ?? 0);
  const unit = String(at(resample, "unit") ?? "");
  const unitAsked = String(at(resample, "unitRequested") ?? "");
  const provenance = definitions([
    ["Method", String(at(resample, "method") ?? "-")],
    [
      "Resampling unit",
      unit === unitAsked
        ? unit === "judge"
          ? "the judge - a resample draws whole judges, so the question is whether another panel would agree"
          : "the comparison - the question is whether these judges' own decisions were decisive"
        : `the ${esc(unit)}, though the ${esc(unitAsked)} was asked for: between-judge disagreement cannot be estimated from one judge`,
    ],
    [
      "Resamples",
      cut === asked || asked === 0
        ? count(cut)
        : `${count(cut)} of the ${count(asked)} asked for - cut to keep the page under a couple of seconds`,
    ],
    ["Reached tolerance", `${count(at(resample, "replicatesConverged"))} of ${count(cut)}`],
    [
      "Graph in one piece",
      `${count(cut - Number(at(resample, "replicatesDisconnected") ?? 0))} of ${count(cut)}`,
    ],
    ["Finest share resolved", percent(at(resample, "resolution"), 2)],
    ["Reversal allowed", `up to ${percent(at(resample, "threshold"), 2)}`],
    ["Seed", `<code>${esc(String(at(resample, "seed") ?? "-"))}</code>`],
  ], ["Resampling unit", "Seed"]);
  /* CONFIDENCE_BLOCKS */
  const verdict =
    resample === null || resample === undefined
      ? `<p class="advice">There is nothing to resample yet.</p>`
      : `<p class="advice">${esc(String(separated))} of ${esc(String(pairs.length))} adjacent
${pairs.length === 1 ? "pair is" : "pairs are"} separated by this evidence. First place ${
          decisive ? "is separated from second" : "is not separated from second"
        }.</p>
<p class="detail">An adjacent pair is two projects next to each other in the published order. A pair
counts as separated when fewer than ${esc(percent(at(resample, "threshold"), 2))} of the resampled
panels put them the other way round. Where a pair is not separated, the place between them was
decided by the sort and not by the judging, and awarding a prize across that boundary is a choice
somebody is making rather than a result these duels produced.</p>
${definitions([
          ["Levels the duels support", `${count(tiers)} across ${count(projects.length - unplaced)} compared projects`],
          ["Another panel would agree", `${percent(at(resample, "orderAgreement"), 1)} of pairs, on average`],
          ["Another panel would reproduce this exact order", percent(at(resample, "orderStability"), 1)],
          ...(unplaced === 0
            ? []
            : ([["Not compared at all", `${count(unplaced)} - no duel mentions them`]] as const)),
        ])}
<p class="detail">Agreement is Kendall's tau-b between each resampled panel's ranking and the
published one, averaged: 1 is every resample agreeing about every pair and 0 is a coin toss. The
line under it is the strict reading - the share of resamples that got every place right - and it is
0 on any field of more than a handful of projects, because a long table has a lot of places to get
wrong. Read the first number; the second is there so the first cannot be mistaken for it.</p>`;
  return page({
    title: `${context.event === null ? "Event" : context.event.name}`,
    trail: eventTrail(
      context,
      {
        label: "Results",
        href: routeFor(commandNamed(context.registry, "results.show"), { event: slug }),
      },
      { label: "Confidence" },
    ),
    whoami: context.whoami,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `<p>${
      published
        ? tag("published", "open")
        : `${tag("not published", "shut")} You are reading a preview. Nobody else can see this
page yet.`
    }</p>
${stats([
      ["projects compared", projects.length - unplaced],
      ["duels decided", count(at(result, "comparisonsDecided"))],
      ["judges resampled", count(at(result, "panelSize"))],
      ["resamples", count(at(resample, "replicates"))],
      ["levels", count(tiers)],
      ["pairs separated", `${separated} of ${pairs.length}`],
    ])}
<h2>What these duels establish</h2>
${verdict}
${resample === null || resample === undefined ? "" : `${pairTable}\n${controls}\n`}<h2>What qualifies these numbers</h2>
${warningList(warnings, "The resample reported nothing worth qualifying.")}
${resample === null || resample === undefined ? "" : `${noteTable}
<h2>Levels</h2>
<p class="muted">A level is formed around one project: the one named first below, and then every
project beneath it in the ranking that these duels do not separate from it. Award a prize to the top
of a level and no project on that level can point at these comparisons and say the order between the
two of them was established.</p>
<p class="muted">It is not a claim that everything on a level ties with everything else. Two projects
sharing a level can still be separated from each other - both stay close enough to the project it
was formed around to be held with it, while the evidence between them is clear. The pair table above
is where a boundary is established, and it is the only place on this page that establishes one.</p>
${tierGroups}
<h2>The ranking, with its intervals</h2>
<p class="muted">A strength is not a score out of anything - it is the number that best explains who
beat whom, and it means nothing except against the others in this table. The range beside it is
where the resamples put it; "could place" is the span of places it took across them, "holds this
place" is how often it kept the one printed here, and "comes first" is how often it topped the whole
field. A project no duel mentions has no evidence about it at all and is listed without a place
rather than at the bottom.</p>
${ranking}
<h2>How this was computed</h2>
${provenance}
<p class="muted">The seed is published so the intervals can be re-derived rather than trusted: the
same duels and the same settings give the same numbers on any machine, which is also why this page
does not change its mind when somebody reloads it.</p>
`}<p class="muted"><a href="${esc(
      routeFor(commandNamed(context.registry, "results.show"), { event: slug }),
    )}">Standings</a> · the same figures as JSON: <a href="${esc(
      routeFor(commandNamed(context.registry, "results.confidence"), { event: slug }).replace(
        "/events/",
        "/api/events/",
      ),
    )}">this page's API route</a></p>`,
  });
}
