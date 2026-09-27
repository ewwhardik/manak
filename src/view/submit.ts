import { mediaImage, textLines } from "./media.ts";
/**
 * The three pages a participant lives on.
 *
 * A hackathon submission flow is judged on one thing: whether a team that starts reading at
 * 17:40 has entered their work by 18:00. Everything here follows from that. The projects page
 * carries the create form rather than linking to it, the project page carries every action the
 * caller may take on it rather than scattering them, and `projects.submit` - the one act with a
 * deadline - is a button with its own heading rather than the third item in a row of five.
 *
 * **Visibility is the command's answer, not this layer's.** `projects.list` returns a
 * `visibility` of `public`, `team` or `organizer` and has already filtered the rows; these pages
 * print which slice they are showing and never decide what to hide. A page that filtered would
 * be a second implementation of the rule in `decide`, and the two would disagree the first time
 * somebody added a status.
 *
 * **Which forms appear comes from `yours`, `mayEdit` and `mayModerate`,** all published by
 * `projects.show`. A view cannot ask the database whether the caller is an organizer, and the
 * alternative - putting roles on `ViewContext` - would let any page grow its own access check.
 * None of the three protects anything: `projects.pull` refuses a non-organizer whether or not a
 * button was drawn.
 *
 * The cut line: there is no page for editing a team. A team is a name and a roster, both
 * visible on the teams page, and renaming one mid-event is a request nobody has made. Joining
 * is a button; leaving is a conversation.
 */

import { definitions, esc, page, scroller, table } from "./html.ts";
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

/** A project's status, as a pill that means the same thing on every page. */
function statusTag(status: unknown): string {
  const value = String(status ?? "");
  if (value === "submitted") return tag("submitted", "open");
  if (value === "withdrawn" || value === "disqualified") return tag(value, "shut");
  return tag(value === "" ? "unknown" : value);
}

/** The link to one project, by the route its own command declares. */
function projectLink(context: ViewContext, id: string, label: string): string {
  return `<a href="${esc(
    routeFor(commandNamed(context.registry, "projects.show"), { event: slugOf(context), project: id }),
  )}">${esc(label)}</a>`;
}

/**
 * The teams in an event, and one button per team.
 *
 * A participant page, and it 403s for an organizer - which is deliberate and worth knowing when
 * reading this: `teams.list` declares `audience: "participant"`, so an organizer following a
 * link here is refused by the command. The roster an organizer wants is the projects list, where
 * every row already carries a team name.
 *
 * Joining is a one-button form per row rather than a select-a-team form, because the id is in
 * the row and a dropdown of forty team names is a worse way to pick the one you are looking at.
 * The button disappears once the caller is on a team: the schema allows one team per event and
 * `addTeamMember` raises `team.alreadyJoined` naming the team they are already on, so offering
 * the button would be offering a refusal.
 */
export function teamsPage(context: ViewContext): string {
  const slug = slugOf(context);
  const teams = rows(context.result, "teams");
  const own = at(context.result, "yours");
  const onATeam = typeof own === "string" && own !== "";
  const open = context.gates?.submissionsOpen === true;
  const body = ((): string => {
    if (teams.length === 0) {
      return `<p class="muted">No teams yet. Entering a project creates one, so the usual order
is to enter the project and let your team-mates join afterwards.</p>`;
    }
    return scroller(table(
      // "yours" was its own headerless column and is now a badge on the name: a marker that
      // belongs to the team is not an action anybody can take, and a column drawn with no
      // heading has to be one or the other. The join column keeps a hidden label because the
      // button in it names itself, and a screen reader still needs the column announced.
      ["Team", "Members", "vh:Join"],
      teams.map((team) => {
        const id = String(team.id ?? "");
        const mine = team.yours === true;
        const name = esc(String(team.name ?? ""));
        return [
          mine ? `${name} ${tag("yours", "open")}` : name,
          String(team.size ?? 0),
          mine || onATeam || !open
            ? ""
            : actionForm(
                context,
                "teams.join",
                { event: slug, team: id },
                { inline: true, submit: "Join" },
              ),
        ];
      }),
      [0, 2],
      [1],
    ), "Teams in this event");
  })();
  const note = ((): string => {
    if (onATeam) {
      return `<p class="muted">You are on a team already. One team per event, so joining another
would have to mean leaving this one - which is not something this portal does; ask an
organizer.</p>`;
    }
    if (!open) {
      return `<p class="muted">Submissions are closed, so the roster is fixed. A team cannot gain
a member after the deadline: the ledger entry would put a name on work it had no hand in, and
the roster is what a prize is awarded against.</p>`;
    }
    return `<p class="muted">A team id is not a secret and there is no approval step - everybody
who can read this page already holds a role in this event. Who is on which team is settled by
talking; this page only records it.</p>`;
  })();
  return page({
    title: `${context.event === null ? "Event" : context.event.name}`,
    trail: eventTrail(context, { label: "Teams" }),
    whoami: context.whoami,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    body: `${body}
${note}
<p><a href="${esc(
      routeFor(commandNamed(context.registry, "projects.list"), { event: slug }),
    )}">Projects in this event</a></p>`,
  });
}

/**
 * Every project this caller may see, and the form that adds one.
 *
 * The create form is on this page and folded away, for the reason `events.list` folds its own:
 * a person arriving to read a list should not have to scroll past six fields, and a separate
 * route would have cost a reserved path segment. It is only drawn while submissions are open -
 * `projects.create` is gated, so a form shown after the close is a form that answers 409.
 *
 * The `visibility` line is printed rather than assumed. A participant sees submitted work plus
 * their own drafts and a stranger sees only submitted work, and a list that did not say which
 * one it was would have somebody counting entries and concluding the portal had lost some.
 */
export function projectsPage(context: ViewContext): string {
  const slug = slugOf(context);
  const projects = rows(context.result, "projects");
  const tracks = rows(context.result, "tracks");
  const trackLabels = new Map(tracks.map((track) => [String(track.key), String(track.label)]));
  const visibility = String(at(context.result, "visibility") ?? "public");
  const open = context.gates?.submissionsOpen === true;
  const timezone = zoneOf(context.event);
  const slice = {
    organizer: "Every project in the event, including drafts, withdrawals and disqualifications.",
    team: "Submitted projects, plus your own team's drafts.",
    public: "Submitted projects. Drafts are visible only to their own team and the organizers.",
  }[visibility];
  const listing =
    projects.length === 0
      ? `<div class="empty-state"><h2>${context.input.q || context.input.trackKey ? "No matching projects" : "The next great idea starts here"}</h2><p class="muted">${context.input.q || context.input.trackKey ? "Try another search or explore all tracks." : "Nothing entered yet. Submitted work will appear in this collection."}</p><a href="/events/${encodeURIComponent(slug)}/projects">Reset filters</a></div>`
      : `<div class="project-grid">${projects.map((project, index) => `<article class="project-card"><div class="project-cover">${mediaImage(project.thumbnailUrl, `${project.title} cover`, true)}<span class="project-monogram" aria-hidden="true">${esc(String(project.title ?? "?").slice(0,2))}</span><span class="detail">PROJECT / ${String(index + 1).padStart(2,"0")}</span></div><div class="project-card-body"><div class="card-meta"><span>${esc(trackLabels.get(String(project.trackKey)) ?? "Open track")}</span>${statusTag(project.status)}</div><h3>${projectLink(context, String(project.id ?? ""), String(project.title ?? "Untitled"))}</h3><p>${esc(String(project.tagline || project.summary || "").slice(0,190))}${String(project.summary ?? "").length > 190 ? "…" : ""}</p><div class="card-bottom"><span>${esc(String(project.teamName ?? "Independent team"))}</span><span class="detail">${esc(when(project.submittedAt, timezone))}</span></div></div></article>`).join("")}</div>`;
  const trackNote =
    tracks.length === 0
      ? ""
      : `<p class="muted">Tracks: ${tracks
          .map((track) => `<code>${esc(String(track.key ?? ""))}</code> ${esc(String(track.label ?? ""))}`)
          .join(", ")}. Send the key, not the label.</p>\n`;
  const create = open && context.accountId !== null
    ? `<details>
<summary>Enter a project</summary>
${actionForm(context, "projects.create", { event: slug }, {
        legend: "A draft. Nothing is entered until you submit it.",
      })}
</details>`
    : `<p class="muted">${open ? `<a href="/signin">Sign in</a> to enter your project.` : "Submissions are closed, so nothing further can be entered."}</p>`;
  const trackPills = tracks.length === 0
    ? ""
    : `<nav class="track-pills" aria-label="Filter projects by track"><span class="track-pill-label">Track:</span><a class="track-pill${!context.input.trackKey ? " track-pill-active" : ""}" href="/events/${encodeURIComponent(slug)}/projects${context.input.q ? `?q=${encodeURIComponent(String(context.input.q))}` : ""}">All tracks</a>${tracks.map((track) => `<a class="track-pill${context.input.trackKey === track.key ? " track-pill-active" : ""}" href="/events/${encodeURIComponent(slug)}/projects?trackKey=${encodeURIComponent(String(track.key))}${context.input.q ? `&q=${encodeURIComponent(String(context.input.q))}` : ""}">${esc(String(track.label))}</a>`).join("")}</nav>`;
  return page({
    title: `${context.event === null ? "Event" : context.event.name}`,
    trail: eventTrail(context, { label: "Projects" }),
    whoami: context.whoami,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    lead: "Ideas worth a closer look. Explore the projects and the people building them.",
    body: `<p class="collection-meta"><strong>${projects.length} projects</strong><span>${tracks.length} tracks</span><span>${esc(slice ?? "")}</span></p>
<form method="get" class="filter-bar" action="/events/${encodeURIComponent(slug)}/projects"><div class="field"><label for="project-search">Search the collection</label><input id="project-search" type="search" name="q" value="${esc(context.input.q ?? "")}" placeholder="Project, team, or idea…" maxlength="200"></div><div class="field"><label for="track-filter">Track</label><select name="trackKey" id="track-filter"><option value="">All tracks</option>${tracks.map((track) => `<option value="${esc(track.key)}"${context.input.trackKey === track.key ? " selected" : ""}>${esc(track.label)}</option>`).join("")}</select></div><button type="submit">Find projects</button></form>
${trackPills}
${context.input.q || context.input.trackKey ? `<p class="muted">Showing ${projects.length} matching projects${context.input.q ? ` for “${esc(context.input.q)}”` : ""}${context.input.trackKey ? ` in ${esc(trackLabels.get(String(context.input.trackKey)) ?? String(context.input.trackKey))}` : ""}. <a href="/events/${encodeURIComponent(slug)}/projects">Reset filters</a></p>` : ""}
${listing}
${context.event?.questions ? `<section class="briefing"><h2>Before you submit</h2><ol>${textLines(context.event.questions)}</ol></section>` : ""}
${create}`,
  });
}

/**
 * One project, and everything the caller may do to it.
 *
 * Four forms can appear here and each one is behind a boolean the command published. `mayEdit`
 * is ownership *and* the gate *and* not-disqualified, computed by `projects.show` in one place,
 * which is why this page does not try to work it out from `yours` - a page that guessed would
 * draw an edit button that answers 409 after the deadline.
 *
 * Submit is separated from the edit form and given its own heading, because it is the only act
 * on this page with a deadline attached and burying it in a row of buttons is how a team ends up
 * with a beautifully edited draft and no entry. `msToSpare` in that command's result exists for
 * the same reason.
 *
 * The two organizer actions sit at the bottom behind `mayModerate` and both take a reason, which
 * is not decoration: the reason goes in the ledger, and a disqualification nobody can account
 * for is the thing that turns a judging dispute into an argument about the portal.
 */
export function projectPage(context: ViewContext): string {
  const slug = slugOf(context);
  const project = at(context.result, "project");
  const team = at(context.result, "team");
  const id = String(at(project, "id") ?? context.input.project ?? "");
  const title = String(at(project, "title") ?? "Project");
  const timezone = zoneOf(context.event);
  const mayEdit = at(context.result, "mayEdit") === true;
  const mayModerate = at(context.result, "mayModerate") === true;
  const yours = at(context.result, "yours") === true;
  const status = String(at(project, "status") ?? "");
  const params = { event: slug, project: id };
  const prefill = {
    title,
    tagline: String(at(project, "tagline") ?? ""),
    description: String(at(project, "description") ?? ""),
    thumbnailUrl: String(at(project, "thumbnailUrl") ?? ""),
    videoUrl: String(at(project, "videoUrl") ?? ""),
    imageUrls: String(at(project, "imageUrls") ?? ""),
    techTags: String(at(project, "techTags") ?? ""),
    answers: String(at(project, "answers") ?? ""),
    summary: String(at(project, "summary") ?? ""),
    repoUrl: String(at(project, "repoUrl") ?? ""),
    demoUrl: String(at(project, "demoUrl") ?? ""),
    trackKey: String(at(project, "trackKey") ?? ""),
  };
  const owner = ((): string => {
    if (!yours) return "";
    if (!mayEdit) {
      return `<p class="muted">This is your team's project and it can no longer be changed -
either submissions have closed or it has been disqualified. The work itself is untouched;
only this portal is done with it.</p>`;
    }
    const submitted = status === "submitted";
    return `<h2>${submitted ? "Revise" : "Finish and enter"}</h2>
<p class="detail">Last saved ${esc(when(at(project, "savedAt") ?? at(project, "createdAt"), timezone))}. Changes are kept when you use the save button.</p>
${
      submitted
        ? `<p>This project is entered. Editing it keeps it entered.</p>`
        : `<p>Saved as a draft. It is not entered until you submit it, and only your team and
the organizers can see it before then.</p>`
    }
${context.event?.questions ? `<section class="briefing"><h3>Questions from the organizer</h3><ol>${textLines(context.event.questions)}</ol></section>` : ""}
<p class="muted">Submission checklist: ${title.trim() ? "✓ Title" : "□ Title"} · ${String(at(project, "summary") ?? "").trim() ? "✓ Summary" : "□ Summary"}. Both are required to enter; other fields can be added later while submissions are open.</p>
${actionForm(context, "projects.update", params, { prefill })}
${
      submitted
        ? ""
        : `<h2>Enter it</h2>
<p>This is the one that counts. After it, the project is visible to everybody and to the
judges.</p>
${actionForm(context, "projects.submit", params)}\n`
    }<details>
<summary>Withdraw this project</summary>
<p>Withdrawing takes it out of judging. It stays in the ledger and it can be resubmitted while
submissions are open.</p>
${actionForm(context, "projects.withdraw", params)}
</details>`;
  })();
  const moderation = mayModerate
    ? `<h2>Organizer actions</h2>
<p class="muted">Both are recorded in the ledger with the reason you give, and the reason is
what an appeal is answered with. Withdrawing is reversible by the team while submissions are
open; disqualification is not reversible from this portal.</p>
<details>
<summary>Withdraw it on the team's behalf</summary>
${actionForm(context, "projects.pull", params)}
</details>
<details>
<summary>Disqualify it</summary>
${actionForm(context, "projects.disqualify", params)}
</details>`
    : "";
  return page({
    title: `${title} - ${context.event === null ? "Project" : context.event.name}`,
    trail: eventTrail(
      context,
      {
        label: "Projects",
        href: routeFor(commandNamed(context.registry, "projects.list"), { event: slug }),
      },
      { label: title },
    ),
    whoami: context.whoami,
    ...(gatesNotice(context.gates) === undefined
      ? {}
      : { notice: gatesNotice(context.gates) as string }),
    lead: String(at(project, "tagline") ?? ""),
    body: `<p>${esc(String(at(project, "summary") ?? ""))}</p>
${at(project, "techTags") ? `<p class="technology-tags">${String(at(project, "techTags")).split(",").map((tag) => `<span>${esc(tag.trim())}</span>`).join("")}</p>` : ""}
${at(project, "description") ? `<section class="project-story"><h2>The full story</h2><p>${esc(at(project, "description"))}</p></section>` : ""}
${at(project, "videoUrl") ? `<section class="video-showcase"><div class="video-showcase-header"><h3>Demonstration Video</h3>${tag("walkthrough", "open")}</div><p class="muted">The team submitted an external demonstration video of their project:</p><a class="video-link-card" href="${esc(String(at(project, "videoUrl")))}" target="_blank" rel="noopener noreferrer"><span class="video-play-symbol" aria-hidden="true">&#9654;</span><span class="video-url-label">${esc(String(at(project, "videoUrl")))}</span><span class="video-external-arrow" aria-hidden="true">&rarr;</span></a></section>` : ""}
<div class="project-media">${mediaImage(at(project, "thumbnailUrl"), `${title} cover`)}${String(at(project, "imageUrls") ?? "").split(/\r?\n/).slice(0,8).map((url, i) => mediaImage(url, `${title} screenshot ${i + 1}`)).join("")}</div>
${at(project, "answers") ? `<section class="project-story"><h2>Event questions</h2><ol>${textLines(context.event?.questions)}</ol><p>${esc(at(project, "answers"))}</p></section>` : ""}
${definitions(
      [
        ["Status", statusTag(status)],
        ["Team", String(at(team, "name") ?? at(project, "teamName") ?? "-")],
        ["Team size", String(at(team, "size") ?? "-")],
        ["Track", String(at(project, "trackKey") ?? "one track")],
        ["Repository", link(at(project, "repoUrl"))],
        ["Demo", link(at(project, "demoUrl"))],
        ["Entered", when(at(project, "createdAt"), timezone)],
        ["Last saved", when(at(project, "savedAt") ?? at(project, "createdAt"), timezone)],
        ["Submitted", when(at(project, "submittedAt"), timezone)],
        ["Withdrawn", when(at(project, "withdrawnAt"), timezone)],
      ],
      ["Status", "Repository", "Demo"],
    )}
<section class="conversation"><h2>Project conversation</h2>${rows(context.result, "comments").map((comment) => `<article class="comment"><header><b>${esc(comment.author)}</b><span class="detail">${esc(when(comment.at, timezone))}</span></header><p>${esc(comment.body)}</p>${mayModerate ? `<details><summary>Moderate this comment</summary>${actionForm(context, "comments.hide", params, { hidden: { comment: String(comment.id) } })}</details>` : ""}</article>`).join("") || '<p class="muted">Ask a thoughtful question or share useful feedback.</p>'}${context.accountId !== null && status === "submitted" && !context.gates?.archived ? actionForm(context, "comments.add", params) : '<p class="muted">Sign in to comment on an active, submitted project.</p>'}</section>
${owner}
${moderation}`,
  });
}
