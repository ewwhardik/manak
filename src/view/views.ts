import { comparePage } from "./compare.ts";
import { duplicatesPage } from "./duplicates.ts";
import { explainPage, sandboxPage } from "./explain.ts";
import { textLines } from "./media.ts";
/**
 * The pages that are worth writing by hand.
 *
 * Nineteen of forty-two operations have one. That ratio is the point: `genericPage` renders any
 * result as a table or a definition list, so every command is usable in a browser the day it
 * is declared, and a bespoke view is only written where the generic rendering would make
 * somebody read a JSON blob to find a link. The twenty-three without one split cleanly: three
 * GETs are documents a person reads once - the health probe, the capability matrix, the OpenAPI
 * file - and the other twenty are writes, whose whole answer to a browser is a 303 back to the
 * page that offered the form. So the generic renderer is reached by three routes in practice,
 * and it exists for the fourth one nobody has written yet.
 *
 * **A view is given a result, not a database.** `ViewContext` is read-only and holds no
 * connection, which is why these functions can be tested by calling them with a literal and
 * why no page can grow its own query when a field turns out to be missing. If something is
 * not in the result, the command has to publish it, and then the JSON caller gets it too.
 *
 * **Every command a view names is looked up in the registry rather than imported.** A view
 * lives in `src/view` and the commands live in `src/api/commands`; importing one would point
 * an arrow the layer test forbids, and looking it up by name means the form is built from the
 * same declaration the dispatcher will parse the submission with. `commandNamed` throws on a
 * miss, at render time, which is the one weakness of the approach - mitigated by the boot
 * check in `makeApp` that already refuses a view keyed on a command that does not exist.
 *
 * The cut line: no page shows a number about judging in progress except the organizer's
 * dashboard, which is role-scoped and refuses everybody else. A participant reloading the event
 * page during scoring learns nothing about how it is going.
 */

import { arenaArt, eventJourney, phaseLabel } from "./arena.ts";
import { bodyFields } from "../api/index.ts";
import { aboutPage } from "./about.ts";
import { votingPage } from "./voting.ts";
import { definitions, demoLoginForm, esc, form, page, scroller, table } from "./html.ts";
import { assignmentPreviewPage, duelPage, queuePage } from "./judge.ts";
import {
  at,
  browserPath,
  commandNamed,
  docsPage,
  eventTrail,
  formPage,
  gatesNotice,
  humanDuration,
  rows,
  actionForm,
  tag,
  when,
} from "./pages.ts";
import type { ViewContext, Views } from "./pages.ts";
import { confidencePage, dashboardPage, resultsPage, rubricPage } from "./results.ts";
import { projectPage, projectsPage, teamsPage } from "./submit.ts";
import { certificateStudioPage, publicCertificatePage } from "./certificates.ts";
import { goldenPathBanner } from "./guide.ts";

/**
 * One event, as a row in a list of them.
 *
 * Only the first cell is markup, and it is the only one the caller declares raw. Everything
 * else goes in as text and `table` escapes it - the rule this whole layer follows, and the
 * one that is easy to get backwards, because escaping twice looks fine until an event is
 * called "Cats & Dogs".
 */
function eventRow(event: Record<string, unknown>): readonly string[] {
  const slug = String(event.slug ?? "");
  return [
    `<a href="/events/${encodeURIComponent(slug)}">${esc(String(event.name ?? slug))}</a>`,
    String(event.phase ?? ""),
    event.archived === true ? "archived" : "-",
  ];
}

/** The events table, or the sentence a portal with nothing on it should say. */
function eventList(events: readonly Record<string, unknown>[]): string {
  if (events.length === 0) {
    return `<p class="muted">No events yet. If you are the operator, the address you listed
in <code>MANAK_FOUNDERS</code> can create one.</p>`;
  }
  return `<div class="event-grid">${events.map((event, index) => {
    const path = `/events/${encodeURIComponent(String(event.slug ?? ""))}`;
    return `<article class="event-card"><div class="event-art ${["art-0", "art-1", "art-2"][index % 3]}" aria-hidden="true"><span class="art-orbit"></span><span class="art-glyph">${index % 3 === 0 ? "M" : index % 3 === 1 ? "+" : "="}</span><span class="art-caption">BUILD / REVIEW / RECOGNIZE</span></div><div class="event-card-body"><div class="card-meta">${tag(event.archived === true ? "archived" : phaseLabel(event.phase), event.judgingOpen === true ? "open" : "plain")}<span>${esc(String(event.timezone ?? "UTC"))}</span></div><h3><a href="${path}">${esc(event.name)}</a></h3><p>Discover the work. Meet the ideas. Follow the decisions.</p><div class="card-bottom"><a href="${path}">Explore event <span aria-hidden="true">↗</span></a>${event.resultsPublic === true ? `<a href="${path}/results">View results</a>` : '<span class="detail">Results forthcoming</span>'}</div></div></article>`;
  }).join("")}</div>`;
}

/**
 * The create-an-event form, folded away, and only for a founder.
 *
 * A `<details>` element rather than a second page, because nine fields is too much to put
 * above a list somebody came to read and a separate route would have cost a reserved slug -
 * see `events.mine` for the same trade made the same way. `<details>` needs no scripting,
 * which is the constraint that decides most of the markup in this product.
 */
function createForm(context: ViewContext): string {
  if (!context.founder) return "";
  const create = commandNamed(context.registry, "events.create");
  return `<details>
<summary>Create an event</summary>
${form({
    formAction: browserPath(create.path),
    submit: create.form?.submit ?? "Create event",
    fields: bodyFields(create),
    legend: "You are listed as a founder of this deployment.",
  })}
</details>`;
}

/** The landing page and the collection: the same body, reached two ways. */
function eventsPage(context: ViewContext, title: string): string {
  const product = at(context.result, "product");
  const heading = product === undefined ? title : String(at(product, "title") ?? title);
  return page({
    title: "Manak — Make great work count",
    trail: [{ label: "Make great work count." }],
    layout: "home",
    headingArt: arenaArt(),
    eyebrow: "The open hackathon workspace",
    lead: "Run your hackathon from first submission to final results. Bring teams, independent judges, and every decision into one shared workspace.",
    whoami: context.whoami, demoMode: context.demoMode,
    showDemoDisclaimer: context.showDemoDisclaimer,
    headingActions: `<div class="hero-actions"><a class="button" href="#golden-path">3-Min Golden Path <span aria-hidden="true">&darr;</span></a><a class="button" href="#events">Explore the events <span aria-hidden="true">↗</span></a><a class="text-link" href="${context.whoami ? "/mine" : "/signin"}">${context.whoami ? "Open my workspace" : "Enter your workspace"} <span aria-hidden="true">→</span></a></div>`,
    body: `<div class="principles"><span><b>01</b> Built in the open</span><span><b>02</b> Judged with context</span><span><b>03</b> Every decision, traceable</span></div>
${goldenPathBanner(context.demoMode)}
<section id="events"><div class="section-heading"><div><p class="eyebrow">Discover what’s happening</p><h2>The event collection<span class="count-label">${rows(context.result, "events").length}</span></h2></div><a href="/events">All events <span aria-hidden="true">↗</span></a></div>${eventList(rows(context.result, "events"))}</section>
<section class="start-here" id="start-here"><div><p class="eyebrow">Find your starting point</p><h2>Different roles.<br>A clear next step.</h2><p>Choose an event first. Your workspace shows the tools available to you.</p></div><div class="role-routes"><a href="/signin"><span class="route-number">01 / BUILDERS</span><h3>Bring your idea to the arena <span aria-hidden="true">↗</span></h3><p>Sign in as builder. Form your team, and submit your project before the deadline.</p></a><a href="/signin"><span class="route-number">02 / JUDGES</span><h3>Give great work a fair review <span aria-hidden="true">↗</span></h3><p>Sign in as judge. Open your scoring queue, save drafts, or compare duels.</p></a><a href="/signin"><span class="route-number">03 / ORGANIZERS</span><h3>See what needs your attention <span aria-hidden="true">↗</span></h3><p>Sign in as organizer. Track live review coverage, and publish signed Ed25519 certificates.</p></a><a href="/guide"><span class="route-number">04 / SITEMAP</span><h3>Evaluation Guide &amp; Full Sitemap <span aria-hidden="true">↗</span></h3><p>Explore the complete platform guide, access controls, and direct-jump sitemap directory.</p></a></div></section>
${createForm(context)}
<section class="method-strip"><div><p class="eyebrow">Behind every result</p><h2>Fairness is a process.<br>Make yours visible.</h2></div><div><p>Weighted rubrics. Independent reviews. Judge-effect normalization. A record of what changed, and why.</p><a class="text-link" href="/about">Explore the judging method <span aria-hidden="true">→</span></a><details class="motion-film"><summary>Watch the 3D motion study</summary><p class="detail">An original geometric study of connected perspectives. Decorative artwork, not event data.</p><video controls loop muted playsinline preload="none" poster="/assets/judging-orbit.webp" aria-label="Rotating three-dimensional knot"><source src="/assets/judging-orbit.webm" type="video/webm">Your browser does not support this video. <a href="/assets/judging-orbit.gif">View the animated study</a>.</video></details></div></section>`,
  });
}

/**
 * One event: its clock, its tracks, and what this caller may do with it.
 *
 * The clock is the whole page. Four instants and a countdown, printed absolutely and in the
 * event's own zone, because "closes in 2 hours" on a page a browser cached for ten minutes
 * is a lie that costs somebody their submission. The countdown is there too, from
 * `nextBoundaryIn`, and it is labelled as the derived figure it is.
 *
 * `yourRoles` decides which links appear and nothing else. A participant who edits the URL
 * to the judge console is refused by the console, not by the absence of a link here - the
 * navigation is a convenience and the capability check is the control, and confusing the two
 * is how products end up with an authorization bug behind a hidden button.
 */
function eventPage(context: ViewContext): string {
  const event = at(context.result, "event");
  const name = String(at(event, "name") ?? "Event");
  const slug = encodeURIComponent(String(at(event, "slug") ?? ""));
  const timezone = String(at(event, "timezone") ?? "UTC");
  const clock = at(context.result, "clock");
  const judging = at(context.result, "judging");
  const roles = Array.isArray(at(context.result, "yourRoles"))
    ? (at(context.result, "yourRoles") as readonly string[])
    : [];
  const nextIn = at(clock, "nextBoundaryIn");
  const tracks = rows(context.result, "tracks");
  const links: string[] = [];
  links.push(`<a href="/events/${slug}/projects">Project gallery</a>`);
  if (at(event, "votingMode") !== "off") links.push(`<a href="/events/${slug}/voting">Community choice</a>`);
  if (at(event, "resultsPublic") === true || roles.includes("organizer")) links.push(`<a href="/events/${slug}/results">Results and confidence</a>`);
  if (roles.includes("participant")) links.push(`<a href="/events/${slug}/teams">My team</a>`);
  if (roles.includes("judge")) {
    links.push(`<a href="/events/${slug}/judging">Judging console</a>`);
    if (at(judging, "pairwiseEnabled") === true) links.push(`<a href="/events/${slug}/duel">Compare projects</a>`);
  }
  if (roles.includes("organizer")) {
    links.unshift(`<a href="/events/${slug}/dashboard">Organizer dashboard</a>`);
    links.push(`<a href="/events/${slug}/rubric">Scoring rubric</a>`);
    links.push(`<a href="/events/${slug}/judges">Judges and invitations</a>`);
    links.push(`<a href="/events/${slug}/tie-breaker">Tie-breaker assistant</a>`);
    links.push(`<a href="/events/${slug}/certificates/studio">Certificate studio</a>`);
  }
  links.push(`<a href="/events/${slug}/live">Live leaderboard</a>`);
  links.push(`<a href="/verify">Certificate verifier</a>`);
  const nextStep = roles.includes("organizer")
    ? ["Your event control room", "Check review coverage, resolve missing evidence, and inspect close results before publishing.", "Open organizer dashboard", "dashboard"]
    : roles.includes("judge")
      ? ["Your next review starts here", "Open your assigned projects. Review the evidence, save a draft, then submit when you are ready.", "Open judging console", "judging"]
      : roles.includes("participant")
        ? ["Build with your team", "Open your team to create or edit your submission. Drafts stay editable until the submission deadline.", "Open my team", "teams"]
        : ["Discover what people are building", "Explore the projects and event dates. Sign in to find your team or access an invitation.", "Explore the projects", "projects"];
  const demoEvent = String(at(event, "slug") ?? "");
  const demoSwitcher = context.demoMode === true && ["sample-hack-2026", "dogfood"].includes(demoEvent)
    ? `<div class="role-switcher-bar"><span class="role-switcher-label">Demo role:</span>${demoLoginForm("organizer", "Organizer", "", "role-switch-btn", demoEvent)}${demoLoginForm(demoEvent === "dogfood" ? "judge_a" : "judge_sample", "Judge", "", "role-switch-btn", demoEvent)}${demoLoginForm(demoEvent === "dogfood" ? "participant_dogfood" : "participant_sample", "Builder", "", "role-switch-btn", demoEvent)}</div>`
    : "";
  const announcements = rows(context.result, "announcements");
  const pinnedAlerts = announcements.filter((a) => a.pinned === true);
  const alertCards =
    pinnedAlerts.length === 0
      ? ""
      : `<section class="announcement-alerts" aria-label="Pinned event announcements">${pinnedAlerts
          .map(
            (a) =>
              `<div class="panel notice" style="margin-bottom: 1.5rem;"><div style="display:flex; justify-content:space-between; align-items:center;"><h3>📢 ${esc(String(a.title))}</h3><span class="detail">${esc(when(Number(a.createdAt), timezone))}</span></div><p style="margin-top:0.5rem; white-space:pre-wrap;">${esc(String(a.content))}</p></div>`,
          )
          .join("")}</section>`;

  return page({
    title: name,
    trail: [{ label: "Events", href: "/" }, { label: name }],
    whoami: context.whoami, demoMode: context.demoMode,
    notice: gatesNotice(context.gates),
    lead: "Everything your event needs, from the first idea to the final results.",
    body: `${alertCards}${eventJourney(clock, context.now, { slug: String(at(event, "slug") ?? ""), roles, resultsPublic: at(event, "resultsPublic") === true })}${demoSwitcher}<section class="next-action"><div><p class="eyebrow">Your next step</p><h2>${esc(nextStep[0])}</h2><p>${esc(nextStep[1])}</p></div><a class="button" href="/events/${slug}/${nextStep[3]}">${esc(nextStep[2])} →</a></section><section class="event-tools" aria-labelledby="event-tools-title"><div class="section-heading"><div><p class="eyebrow">Go to</p><h2 id="event-tools-title">Your event tools</h2></div><span class="detail">Links follow your event role</span></div><nav class="workspace-nav" aria-label="Event navigation">${links.join("")}</nav></section><div class="section-heading"><h2>Event at a glance</h2>${tag(phaseLabel(at(event, "phase")), "plain")}</div>${definitions([
      ["Phase", String(at(event, "phase") ?? "-")],
      ["Submissions open", when(at(clock, "submissionsOpenAt"), timezone)],
      ["Submissions close", when(at(clock, "submissionsCloseAt"), timezone)],
      ["Judging opens", when(at(clock, "judgingOpenAt"), timezone)],
      ["Judging closes", when(at(clock, "judgingCloseAt"), timezone)],
      [
        "Next change",
        typeof nextIn === "number" ? `in ${humanDuration(nextIn)}` : "nothing scheduled",
      ],
      ["Reviews per project", String(at(judging, "reviewsPerProject") ?? "-")],
      [
        "Pairwise comparisons",
        at(judging, "pairwiseEnabled") === true ? "collected" : "not collected",
      ],
      ["Your roles", roles.length === 0 ? "none (visitor)" : roles.join(", ")],
    ])}
${at(event, "prizes") ? `<section class="briefing"><p class="eyebrow">Worth building for</p><h2>Prizes & recognition</h2><ul>${textLines(at(event, "prizes"))}</ul></section>` : ""}
<h2>Tracks</h2>
${
      tracks.length === 0
        ? '<p class="muted">One track. Nothing is separated out for judging.</p>'
        : `<ul>${tracks
            .map((track) => `<li><b>${esc(String(track.label ?? ""))}</b> <code>${esc(String(track.key ?? ""))}</code></li>`)
            .join("")}</ul>`
    }
${roles.includes("organizer") ? `<section class="operations"><h2>Manage this event</h2><details><summary>Post an announcement</summary>${actionForm(context, "announcements.create", { event: decodeURIComponent(slug) })}</details><details><summary>Event settings and voting windows</summary>${actionForm(context, "events.update", { event: decodeURIComponent(slug) }, { prefill: Object.fromEntries(Object.entries({ name, timezone, prizes: at(event, "prizes"), questions: at(event, "questions"), submissionsOpenAt: at(clock, "submissionsOpenAt"), submissionsCloseAt: at(clock, "submissionsCloseAt"), judgingOpenAt: at(clock, "judgingOpenAt"), judgingCloseAt: at(clock, "judgingCloseAt"), reviewsPerProject: at(judging, "reviewsPerProject"), pairwiseEnabled: at(judging, "pairwiseEnabled") ? "true" : "", votingMode: at(event, "votingMode"), votingCredits: at(event, "votingCredits"), votingOpenAt: at(event, "votingOpenAt"), votingCloseAt: at(event, "votingCloseAt") }).map(([key, value]) => [key, value == null ? "" : key.endsWith("At") && typeof value === "number" ? new Date(value).toISOString().slice(0,16) : String(value)])) })}</details><details><summary>Add a track</summary>${actionForm(context, "tracks.create", { event: decodeURIComponent(slug) })}</details></section>` : ""}`,
  });
}

/**
 * What the caller is part of, with the roles they hold in each.
 *
 * Worth a hand-written page for one reason: the result is an array of objects each holding
 * another object, and the generic renderer prints the inner one as JSON. A person looking for
 * the event they are judging should not have to read `{"id":"ev_...","slug":...}` to find the
 * link.
 */
function minePage(context: ViewContext): string {
  const entries = rows(context.result, "events");
  return page({
    title: "Your events",
    trail: [{ label: "Events", href: "/" }, { label: "Yours" }],
    whoami: context.whoami, demoMode: context.demoMode,
    body:
      entries.length === 0
        ? `<p class="muted">You do not hold a role in any event yet. An organizer invites you
by email; the link in that mail is what joins you.</p>`
        : scroller(table(
            ["Event", "Phase", "Your roles"],
            entries.map((entry) => {
              const event = (entry.event ?? {}) as Record<string, unknown>;
              const held = Array.isArray(entry.roles) ? (entry.roles as string[]) : [];
              return [...eventRow(event).slice(0, 2), held.join(", ")];
            }),
            [0],
          ), "Events you hold a role in"),
  });
}

/**
 * The roster, and the form that adds to it.
 *
 * The invitation form is on this page rather than a page of its own because inviting is the
 * thing an organizer does *while* looking at who is already invited - the question "has she
 * accepted yet" and the action "send it again" are one thought. `events.invite` redirects
 * back here, so a resend lands where it started.
 *
 * The link an invitation returns is not shown here. It is in the JSON response and in the
 * mail, and printing it on a page an organizer might be screen-sharing would undo the
 * single-use protection for the person named on it.
 */
function judgesPage(context: ViewContext): string {
  const name = context.event === null ? "Event" : context.event.name;
  const invite = commandNamed(context.registry, "events.invite");
  const people = (label: string, key: string): string => {
    const list = rows(context.result, key);
    return `<h2>${esc(label)}</h2>\n${
      list.length === 0
        ? '<p class="muted">Nobody yet.</p>'
        : scroller(table(
            ["Name", "Address"],
            list.map((person) => [
              String(person.displayName ?? ""),
              `<code>${esc(String(person.email ?? ""))}</code>`,
            ]),
            [1],
          ), label)
    }`;
  };
  return page({
    title: `${name}`,
    trail: eventTrail(context, { label: "Judges" }),
    whoami: context.whoami, demoMode: context.demoMode,
    notice: gatesNotice(context.gates),
    body: `<p>Each project should be seen by
<b>${esc(String(at(context.result, "reviewsPerProject") ?? "-"))}</b> judges.</p>
${people("Judges", "judges")}
${people("Organizers", "organizers")}
<h2>Invite somebody</h2>
${form({
      formAction: `/events/${encodeURIComponent(String(context.input.event ?? ""))}/invitations`,
      submit: invite.form?.submit ?? "Send invitation",
      fields: bodyFields(invite),
      legend: "They do not need an account here yet. The emailed link is single use and expires after 30 minutes. If it expires or has already been used, send a fresh invitation to the same address. Membership in another event does not grant access here.",
    })}`,
  });
}

/**
 * The sign-in page, in its two states.
 *
 * The second state is the whole reason this is not the generic form page. After a link is
 * requested the command redirects to `/signin?sent=1`, and what a person needs then is not
 * the form again - it is being told to go and look in their inbox, and being told the link
 * lapses. Redisplaying the form there reads as though nothing happened, and the next thing
 * that happens is a second link that invalidates the first.
 *
 * The address is not echoed back on the sent page. It would be a small courtesy and it would
 * also mean a URL that renders somebody's address into a page, which is a thing that ends up
 * in a screenshot.
 */
function signinPage(context: ViewContext): string {
  const request = commandNamed(context.registry, "auth.request");
  const minutes = String(at(context.result, "expiresInMinutes") ?? "");
  const demoAccounts = context.demoMode === true ? `<section class="fast-login-box"><h2>Demo accounts</h2><p>Disposable, preconfigured accounts for evaluating Manak. This shortcut is disabled unless MANAK_DEMO=true.</p><div class="fast-login-grid">${[
    ["organizer", "Organizer", "Rosa Iyer · event setup and results"],
    ["judge_sample", "Judge · Sample Hack", "Tomas Varga · review queue and comparisons"],
    ["judge_a", "Judge · Dogfood", "Nils Berg · review queue and comparisons"],
    ["participant_sample", "Builder · Sample Hack", "Priya Nair · team and submission"],
    ["participant_dogfood", "Builder · Dogfood", "Beatriz Lima · team and submission"],
  ].map(([as, label, detail]) => demoLoginForm(as!, label!, detail!, "role-card")).join("")}</div></section>` : "";
  if (at(context.result, "sent") === true) {
    return page({
      title: "Check your inbox",
      // The label, not "Sign in": `page` takes the heading from the last crumb, and a page
      // titled one thing in the tab and another at the top of the body is the small
      // inconsistency that makes somebody wonder whether the link was sent.
      trail: [{ label: "Check your inbox" }],
      whoami: context.whoami, demoMode: context.demoMode,
      body: `<div class="panel">
<p>A sign-in link is on its way. It works once and stops working after ${esc(minutes)} minutes.</p>
<p><a href="/signin">Ask for another link</a></p>
</div>${demoAccounts}`,
    });
  }
  const pageHtml = formPage({
    command: request,
    formAction: "/signin",
    title: "Sign in",
    whoami: context.whoami, demoMode: context.demoMode,
    intro: "Enter your email address to receive a single-use sign-in link.",
  });
  return pageHtml.replace("</main>", `${demoAccounts}\n</main>`);
}

/**
 * The button a clicked link lands on.
 *
 * One control and it is hidden, so the page is a sentence and a button. That is the point:
 * `form` filters hidden names out of the rendered fields, so passing the token as `hidden`
 * turns the sign-in command's only field into something a mail scanner cannot submit and a
 * person completes with one click. `auth.link` itself reads and writes nothing, which is what
 * makes a prefetch of this URL harmless.
 */
function confirmPage(context: ViewContext): string {
  const session = commandNamed(context.registry, "auth.session");
  return formPage({
    command: session,
    formAction: "/session",
    title: "Confirm sign-in",
    whoami: context.whoami, demoMode: context.demoMode,
    intro: `Press the button to finish signing in. The link lapses
${esc(String(at(context.result, "expiresInMinutes") ?? ""))} minutes after it was sent, and
works once.`,
    hidden: { token: String(context.input.token ?? "") },
  });
}

/**
 * Who you are, and what else is holding your identity.
 *
 * The session table is the reason this page exists rather than deferring to the generic
 * renderer. A product whose credential arrives by mail - and, on a default deployment, by
 * container log - owes the person a place to see that something else is signed in as them and
 * a button that ends it. The user agent is the only evidence available about which row is
 * which, and it is shown verbatim rather than prettified, because a guess at "Chrome on a Mac"
 * that gets it wrong is worse than the raw string.
 *
 * `founder` is stated even when false, so an operator who put an address in
 * `MANAK_FOUNDERS` and cannot create an event finds out here that they are signed in as
 * somebody else - which is the actual mistake, and it is invisible everywhere else.
 */
function whoamiPage(context: ViewContext): string {
  const account = at(context.result, "account");
  const signout = commandNamed(context.registry, "auth.signout");
  const sessions = rows(context.result, "sessions");
  return page({
    title: "Your account",
    trail: [{ label: "Your account" }],
    whoami: context.whoami, demoMode: context.demoMode,
    body: `${definitions(
      [
        ["Name", String(at(account, "displayName") ?? "")],
        ["Address", `<code>${esc(String(at(account, "email") ?? ""))}</code>`],
        [
          "Can create events",
          at(context.result, "founder") === true
            ? "yes - this address is listed as a founder of this deployment"
            : "no - only addresses the operator listed as founders can",
        ],
      ],
      ["Address"],
    )}
<h2>Signed in on ${esc(String(sessions.length))} ${sessions.length === 1 ? "device" : "devices"}</h2>
${scroller(table(
      ["Started", "Last seen", "Expires", "Client"],
      sessions.map((row) => [
        new Date(Number(row.createdAt)).toISOString(),
        new Date(Number(row.lastSeenAt)).toISOString(),
        new Date(Number(row.expiresAt)).toISOString(),
        String(row.userAgent ?? "-"),
      ]),
    ), "Signed-in devices")}
<p class="muted">Times are UTC. If a row here is not you, sign out everywhere - it revokes
every session including this one, and any sign-in link still in flight stays usable, so ask
for a fresh one afterwards.</p>
${form({
      formAction: "/signout",
      submit: signout.form?.submit ?? "Sign out",
      fields: bodyFields(signout),
      legend: "End this session, or all of them.",
    })}`,
  });
}

/**
 * The map the dispatcher reads, keyed by command name.
 *
 * Keyed by name and never by path, because a path is a fact about routing that can change
 * and a name is the operation's identity. `makeApp` refuses to boot if a key here is not a
 * command, which is the check that stops a renamed command silently falling back to the
 * generic page - the failure that is otherwise invisible, because the generic page works.
 *
 * Grouped by who reads the page rather than by which module it lives in, because that is the
 * grouping that decides what a page may say: a participant's project page and a judge's ballot
 * describe the same row and differ on whether it may name the judge.
 */
export const VIEWS: Views = {
  "votes.ballot": votingPage,
  // The deployment describing itself.
  "system.home": (context) => eventsPage(context, "Events"),
  "system.about": aboutPage,
  "system.docs": docsPage,
  // Getting in.
  "auth.signin": signinPage,
  "auth.link": confirmPage,
  "auth.whoami": whoamiPage,
  // The event, and the organizer's view of it.
  "events.list": (context) => eventsPage(context, "Events"),
  "events.show": eventPage,
  "events.mine": minePage,
  "events.judges": judgesPage,
  "events.dashboard": dashboardPage,
  "rubrics.show": rubricPage,
  "results.show": resultsPage,
  "results.explain": explainPage,
  "duplicates.list": duplicatesPage,
  "results.sandbox": sandboxPage,
  "results.certificate_studio": certificateStudioPage,
  "results.public_certificate": publicCertificatePage,
  "results.confidence": confidencePage,
  // Submitting.
  "teams.list": teamsPage,
  "projects.list": projectsPage,
  "projects.show": projectPage,
  "projects.compare": comparePage,
  // Judging.
  "judging.queue": queuePage,
  "assignments.preview": assignmentPreviewPage,
  "duels.next": duelPage,
};
