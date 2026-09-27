/**
 * The two pages a judge works from.
 *
 * These are the pages that decide whether the judging integrity in `src/judging` is worth
 * anything, because a rubric nobody can fill in on a phone at a venue produces the same
 * ranking as no rubric at all. Both are one screen, both work with scripting off, and neither
 * needs a second request to do the thing it exists for.
 *
 * **The ballot lives on the console, not on a page of its own.** There is no `GET
 * /events/:e/projects/:p/ballot` route and adding one would have been a forty-first operation
 * whose entire content is a form. Instead the console renders one collapsed `<details>` per
 * assigned project holding that project's ballot, prefilled from the `ballot` object the queue
 * already returns - so a judge sees six projects, opens one, scores it, and lands back on the
 * list with the count moved. The cost is one large page; the benefit is that revising a filed
 * ballot is a click rather than navigation, which is what a judge does most in the last hour.
 *
 * **The score controls are built here rather than by `form`.** `formControls` renders a
 * `kind: "scores"` field as a JSON textarea, and its comment says as much: the criteria are
 * data, so only a page that has been handed the rubric can spell them as one input per
 * criterion. The comment box and the draft checkbox still come from the declaration through
 * `actionForm`, so the two fields the parser and the OpenAPI document agree about are not
 * transcribed by hand here - only the one that cannot be.
 *
 * The cut line: neither page shows a judge how their scores compare to anybody else's. The
 * normalization report exists and the organizer can read it, but a console that told a judge
 * "you are 0.4 harsher than the median" would change the scores it is measuring, and then the
 * leniency estimate would be a fact about the interface rather than about the judge.
 */

import { attrs, definitions, esc, meter, page } from "./html.ts";
import type { Prefill } from "./html.ts";
import {
  actionForm,
  at,
  commandNamed,
  eventTrail,
  gatesNotice,
  humanDuration,
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
 * The judging window, said plainly, above everything else.
 *
 * A judge who cannot save a ballot needs to know that before they have typed one, and the
 * `notice` strip says "Open: judging" in general terms. This says which window and when, in
 * the event's own zone, because "judging closed" with no time attached reads as a fault.
 */
function windowNote(result: unknown, timezone: string, now: number): string {
  const win = at(result, "window");
  const open = at(win, "open") === true;
  const closesAt = at(win, "closesAt");
  const opensAt = at(win, "opensAt");
  if (open) {
    const left = typeof closesAt === "number" ? closesAt - now : null;
    return `<p>${tag("Judging open", "open")} Closes ${esc(when(closesAt, timezone))}${
      left === null ? "" : ` - ${esc(humanDuration(left))} from now`
    }.</p>`;
  }
  const opens = typeof opensAt === "number" && opensAt > now;
  return `<p>${tag("Judging closed", "shut")} ${
    opens
      ? `Opens ${esc(when(opensAt, timezone))}.`
      : `It closed ${esc(when(closesAt, timezone))}. Nothing on this page can be saved.`
  }</p>`;
}

/** What a judge has already done with one project, as a pill. */
function ballotTag(ballot: unknown): string {
  if (ballot === null || ballot === undefined) return tag("not started");
  return at(ballot, "submitted") === true ? tag("filed", "open") : tag("draft");
}

/**
 * One numeric input per criterion, named for the dotted key a form body un-dots.
 *
 * `scores.impact=4` arrives at the parser as `{scores: {impact: 4}}` - one level of dotting is
 * un-dotted by `src/http/wire.ts` and a second level is refused - so the control name is the
 * contract between this markup and that function, and it is the reason a judge's browser and a
 * JSON client reach the same handler with the same shape.
 *
 * `min` and `max` come from the criterion rather than from the field declaration, which is the
 * whole reason this cannot be generated: the rubric is data, and a rubric with a 0–10 criterion
 * next to a 1–5 one is a rubric this product is supposed to support.
 */
function scoreControls(criteria: readonly Record<string, unknown>[], prefill: Prefill, projectId: string): string {
  if (criteria.length === 0) {
    return `<p class="muted">The published rubric has no criteria. Nothing can be scored.</p>`;
  }
  const controls = criteria.map((criterion) => {
    const key = String(criterion.key ?? "");
    const name = `scores.${key}`;
    const id = `f-${projectId}-${name}`;
    const min = criterion.min;
    const max = criterion.max;
    const range =
      typeof min === "number" && typeof max === "number" ? `${min}–${max}` : "a whole number";
    const weight = typeof criterion.weight === "number" ? criterion.weight : null;
    const given = prefill[name];
    if (typeof min === "number" && typeof max === "number" && Number.isInteger(min) && Number.isInteger(max) && max - min <= 10) {
      const options = Array.from({ length: max - min + 1 }, (_, index) => min + index);
      return `<fieldset class="score-field"><legend>${esc(String(criterion.label ?? key))}${weight === null ? "" : ` <span class="detail">· weight ${weight}</span>`}</legend><div class="score-options">${options.map((score) => `<label class="score-choice"><input type="radio" id="${esc(id)}-${score}" name="${esc(name)}" value="${score}" required${given === String(score) ? " checked" : ""}><span>${score}</span></label>`).join("")}</div><div class="score-anchors"><span>${min} · Lowest</span><span>${max} · Highest</span></div></fieldset>`;
    }
    return `<div class="field">
<label for="${esc(id)}">${esc(String(criterion.label ?? key))}</label>
<input${attrs({
      id,
      name,
      type: "number",
      step: 1,
      min: typeof min === "number" ? min : undefined,
      max: typeof max === "number" ? max : undefined,
      required: true,
      inputmode: "numeric",
      value: given,
      "aria-describedby": `${id}-note`,
    })}>
<p class="note" id="${esc(`${id}-note`)}">${esc(range)}${
      weight === null ? "" : ` · weight ${weight}`
    }</p>
</div>`;
  });
  return `<div class="scores">\n${controls.join("\n")}\n</div>`;
}

/**
 * The values a saved ballot puts back into the form.
 *
 * Built from the ballot the queue returned rather than from a submission, which is the one
 * place in this layer where a prefill is not "what the caller just sent". A judge who filed a
 * ballot and comes back to change one score should see the other eight, and the alternative -
 * an empty form over stored values - is how a 5 becomes a blank.
 */
function ballotPrefill(ballot: unknown): Prefill {
  const out: Record<string, string> = {};
  if (ballot === null || ballot === undefined) return out;
  const scores = at(ballot, "scores");
  if (scores !== null && typeof scores === "object") {
    for (const [key, value] of Object.entries(scores as Record<string, unknown>)) {
      if (value !== null && value !== undefined) out[`scores.${key}`] = String(value);
    }
  }
  const comment = at(ballot, "comment");
  if (typeof comment === "string") out.comment = comment;
  // Deliberately not prefilled from `submitted`: the checkbox says "save as draft", and a
  // filed ballot re-rendered with that box ticked would invite a judge to unfile it by
  // pressing the button that says File.
  return out;
}

/** One project, folded, with its ballot inside. */
function projectBlock(
  context: ViewContext,
  project: Record<string, unknown>,
  criteria: readonly Record<string, unknown>[],
  timezone: string,
  open: boolean,
  expanded = false,
): string {
  const slug = slugOf(context);
  const id = String(project.id ?? "");
  const ballot = project.ballot ?? null;
  const title = String(project.title ?? "Untitled");
  const prefill = ballotPrefill(ballot);
  const meta = definitions(
    [
      ["Track", String(project.trackKey ?? "one track")],
      ["Repository", link(project.repoUrl)],
      ["Demo", link(project.demoUrl)],
      ["Submitted", when(project.submittedAt, timezone)],
      ["Status", String(project.status ?? "")],
    ],
    ["Repository", "Demo"],
  );
  const summary = String(project.summary ?? "");
  const body = open
    ? actionForm(
        context,
        "ballots.save",
        { event: slug, project: id },
        { prefill, without: ["scores", "draft"],
        idPrefix: `review-${String(project.id)}-`, before: scoreControls(criteria, prefill, id),
          submit: "Submit review", submitName: "draft", submitValue: "false",
          secondarySubmit: { name: "draft", value: "true", label: "Save draft", skipValidation: true } },
      )
    : `<p class="muted">Judging is closed, so this ballot cannot be changed.</p>`;
  return `<details class="review-project" id="review-${esc(id)}"${expanded ? " open" : ""}>
<summary>${esc(title)} ${ballotTag(ballot)}</summary>
<p><a href="${esc(
    routeFor(commandNamed(context.registry, "projects.show"), { event: slug, project: id }),
  )}">Open the project page</a></p>
${meta}
${summary === "" ? "" : `<p>${esc(summary)}</p>\n`}${body}
</details>`;
}

/**
 * Everything assigned to this judge, and the state of each ballot.
 *
 * The counts are the top of the page because they are the only question a judge asks twice:
 * how many are left. Drafts are counted separately from filed ones and the doc for
 * `ballots.save` explains why the distinction is not cosmetic - a draft is counted nowhere,
 * so a console that showed six of six "done" while three were drafts would be lying about
 * coverage to the one person who could fix it.
 */
export function queuePage(context: ViewContext): string {
  const result = context.result;
  const slug = slugOf(context);
  const timezone = zoneOf(context.event);
  const name = context.event === null ? "Judging" : context.event.name;
  const open = at(at(result, "window"), "open") === true;
  const pairwise = at(result, "pairwise") === true;
  const rubric = at(result, "rubric");
  const version = at(rubric, "version");
  const criteria = rows(rubric, "criteria");
  const priority = (project: Record<string, unknown>): number =>
    at(project.ballot, "submitted") === true ? 2 : project.ballot == null ? 1 : 0;
  const projects = [...rows(result, "projects")].sort((a,b) => priority(a)-priority(b));
  const nextReview = projects.find((project) => priority(project) < 2);
  const reviewAction = nextReview && open
    ? `<a class="button" href="#review-${esc(nextReview.id)}">${priority(nextReview) === 0 ? "Continue your draft" : "Start your next review"} →</a>` : "";
  const counts: (readonly [string, string | number])[] = [
    ["assigned to you", Number(at(result, "assigned") ?? 0)],
    ["ballots filed", Number(at(result, "submitted") ?? 0)],
    ["drafts", Number(at(result, "drafts") ?? 0)],
  ];
  if (pairwise) counts.push(["comparisons you made", Number(at(result, "comparisons") ?? 0)]);
  const duel = pairwise
    ? `<p><a href="${esc(routeFor(commandNamed(context.registry, "duels.next"), { event: slug }))}">Compare
two projects</a> - pairwise comparisons are collected for this event, and they are scored
separately from the rubric.</p>`
    : "";
  const list = ((): string => {
    if (version === null || version === undefined) {
      return `<p class="muted">No rubric has been published for this event yet. Scoring opens
when an organizer publishes one; nothing you type before then could be stored against a
version, so the form is not shown.</p>`;
    }
    if (projects.length === 0) {
      return `<p class="muted">Nothing is assigned to you yet. An organizer draws assignments
once submissions close. You can still compare projects if pairwise is on.</p>`;
    }
    return projects
      .map((project) => projectBlock(context, project, criteria, timezone, open,
        project === nextReview || String(context.input.focus ?? "") === String(project.id)))
      .join("\n");
  })();
  return page({
    title: `${name}`,
    trail: eventTrail(context, { label: "Judging" }),
    whoami: context.whoami, demoMode: context.demoMode,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `<section class="judge-mission"><div><p class="eyebrow">Your review mission</p><h2>${Number(at(result, "assigned") ?? 0) - Number(at(result, "submitted") ?? 0) > 0 ? "Great work deserves a closer look." : "You’re all caught up."}</h2><p>Read the evidence. Score independently. Save each review when you’re ready.</p></div><div class="mission-progress"><b>${Number(at(result, "submitted") ?? 0)}<span> / ${Number(at(result, "assigned") ?? 0)}</span></b><span>reviews filed</span>${meter(Number(at(result, "assigned") ?? 0) > 0 ? Number(at(result, "submitted") ?? 0) / Number(at(result, "assigned")) : 0, "Your filed review progress")}</div></section>${windowNote(result, timezone, context.now)}
${reviewAction}
<p class="detail">Drafts come first, followed by unstarted reviews and filed ballots. Use “Save draft” at any point; incomplete reviews stay private and do not count toward coverage. “Submit review” requires every criterion. Changes are not autosaved.</p>
${stats(counts)}
${
      version === null || version === undefined
        ? ""
        : `<p class="muted">Rubric version ${esc(String(version))}, ${esc(
            String(criteria.length),
          )} criteria. A ballot is stored against the version it was filed under, so publishing
a new rubric does not silently rescore your work.</p>\n`
    }${duel}<h2>Your projects</h2>
${list}`,
  });
}

/**
 * Two projects, side by side, and three buttons.
 *
 * Three separate forms rather than one form with a `verdict` select, because the act is a
 * judgement and not a form-filling exercise: a judge reads both, presses the stronger one, and
 * the next pair loads. A select plus a submit is two interactions for one decision, and on a
 * phone it is two interactions with a scroll between them.
 *
 * `skip` is a button of equal weight, not a link out. Two projects a judge cannot separate is
 * information - `VERDICT`'s doc in `src/api/commands/judging.ts` says why - and a console that
 * made skipping feel like giving up would convert honest ties into noise in the fit.
 *
 * The reason the scheduler gave for the pair is shown and also posted back in a hidden field.
 * Shown because a judge comparing two projects from different tracks deserves to know it was
 * deliberate; posted because the ledger entry means "what the console offered", which is a
 * claim only the console can make.
 */
export function duelPage(context: ViewContext): string {
  const result = context.result;
  const slug = slugOf(context);
  const timezone = zoneOf(context.event);
  const name = context.event === null ? "Compare" : context.event.name;
  const open = at(at(result, "window"), "open") === true;
  const pair = at(result, "pair");
  const left = at(pair, "left");
  const right = at(pair, "right");
  const reason = String(at(pair, "reason") ?? "manual");
  const counts: (readonly [string, string | number])[] = [
    ["comparisons you filed", Number(at(result, "filed") ?? 0)],
    ["projects in the pool", Number(at(result, "pool") ?? 0)],
  ];
  const components = at(result, "componentCount");
  if (typeof components === "number") counts.push(["comparison groups", components]);
  const side = (project: unknown, which: "left" | "right"): string => {
    const id = String(at(project, "id") ?? "");
    return `<div class="panel">
<h2>${esc(String(at(project, "title") ?? "Untitled"))}</h2>
<p>${esc(String(at(project, "summary") ?? ""))}</p>
${definitions(
      [
        ["Track", String(at(project, "trackKey") ?? "one track")],
        ["Repository", link(at(project, "repoUrl"))],
        ["Demo", link(at(project, "demoUrl"))],
        [
          "Project page",
          `<a href="${esc(
            routeFor(commandNamed(context.registry, "projects.show"), { event: slug, project: id }),
          )}">Open</a>`,
        ],
      ],
      ["Repository", "Demo", "Project page"],
    )}
${
      open
        ? actionForm(
            context,
            "duels.decide",
            { event: slug },
            {
              hidden: {
                left: String(at(left, "id") ?? ""),
                right: String(at(right, "id") ?? ""),
                verdict: which,
                reason,
              },
              submit: `This one is stronger`,
              submitAccessKey: which === "left" ? "1" : "2",
              submitHtml: `<kbd>${which === "left" ? "1" : "2"}</kbd> This one is stronger`,
            },
          )
        : ""
    }
</div>`;
  };
  const body = ((): string => {
    if (at(result, "pairwise") !== true) {
      return `<p class="muted">Pairwise comparisons are not collected for this event. The
ranking comes from rubric scores alone.</p>`;
    }
    if (pair === null || pair === undefined) {
      return `<p class="muted">There is nothing left to compare. Either fewer than two
projects are in the pool, or you have seen every pair the scheduler considers worth your
time.</p>`;
    }
    return `<div class="pair">
${side(left, "left")}
${side(right, "right")}
</div>
${
      open
        ? actionForm(
            context,
            "duels.decide",
            { event: slug },
            {
              hidden: {
                left: String(at(left, "id") ?? ""),
                right: String(at(right, "id") ?? ""),
                verdict: "skip",
                reason,
              },
              submit: "I cannot separate them",
              submitAccessKey: "s",
              submitHtml: "<kbd>S</kbd> I cannot separate them",
            },
          )
        : `<p class="muted">Judging is closed. Nothing can be recorded.</p>`
    }
<h2>Why this pair</h2>
${definitions([
      ["Offered because", reason],
      ["Information it adds", String(at(pair, "information") ?? "-")],
      ["Comparisons short", String(at(pair, "deficit") ?? "-")],
      ["Pool connected", at(result, "connected") === true ? "yes" : "no - some projects have no path of comparisons to the rest"],
    ])}`;
  })();
  return page({
    title: `${name}`,
    trail: eventTrail(context, { label: "Compare" }),
    whoami: context.whoami, demoMode: context.demoMode,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `<section class="judge-mission"><div><p class="eyebrow">Your review mission</p><h2>${Number(at(result, "assigned") ?? 0) - Number(at(result, "submitted") ?? 0) > 0 ? "Great work deserves a closer look." : "You’re all caught up."}</h2><p>Read the evidence. Score independently. Save each review when you’re ready.</p></div><div class="mission-progress"><b>${Number(at(result, "submitted") ?? 0)}<span> / ${Number(at(result, "assigned") ?? 0)}</span></b><span>reviews filed</span>${meter(Number(at(result, "assigned") ?? 0) > 0 ? Number(at(result, "submitted") ?? 0) / Number(at(result, "assigned")) : 0, "Your filed review progress")}</div></section>${windowNote(result, timezone, context.now)}
${stats(counts)}
${body}
<p class="muted"><a href="${esc(
      routeFor(commandNamed(context.registry, "judging.queue"), { event: slug }),
    )}">Back to your projects</a></p>`,
  });
}

/** Preview has no writes and makes capacity shortfalls visible before a draw. */
export function assignmentPreviewPage(context: ViewContext): string {
  const result = context.result;
  const slug = slugOf(context);
  const warnings = rows(result, "shortfalls").map((gap) => `<li>${esc(JSON.stringify(gap))}</li>`).join("");
  const notes = at(result, "warnings");
  const warningList = Array.isArray(notes) ? notes.map((note) => `<li>${esc(String(note))}</li>`).join("") : "";
  return page({ title: "Assignment preview", whoami: context.whoami, demoMode: context.demoMode,
    trail: eventTrail(context, { label: "Assignment preview" }),
    body: `<p>No assignments have changed. Applying recomputes this plan against the current roster. Existing ballots are protected.</p>
${stats([["projects", Number(at(result, "projects"))], ["judges", Number(at(result, "judges"))], ["planned reviews", Number(at(result, "assignments"))]])}
<section class="panel"><h2>${at(result, "complete") === true ? "Coverage target met" : "Coverage needs attention"}</h2>
<p>Planned judge load: ${esc(at(result, "loadMin"))}–${esc(at(result, "loadMax"))} reviews. Target: ${esc(at(result, "reviewsPerProject"))} reviews per project.</p>
${warnings || warningList ? `<ul>${warnings}${warningList}</ul>` : "<p>No assignment shortfalls reported.</p>"}
${actionForm(context, "assignments.draw", { event: slug }, { hidden: { dryRun: "false", track: String(context.input.track ?? ""), expectedRevision: String(at(result, "planRevision") ?? "") }, submit: "Apply assignments" })}
<p><a href="/events/${esc(slug)}/dashboard">Return to dashboard</a></p></section>` });
}
