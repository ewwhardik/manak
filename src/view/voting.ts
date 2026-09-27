import { esc, page } from "./html.ts";
import { actionForm, at, eventTrail, rows, stats } from "./pages.ts";
import type { ViewContext } from "./pages.ts";

export function votingPage(context: ViewContext): string {
  const slug = String(context.input.event ?? context.event?.slug ?? "");
  const result = context.result;
  const credits = at(result,"credits");
  const open = at(result,"open") === true;
  return page({ title: "Community choice", trail: eventTrail(context,{label:"Community choice"}), whoami: context.whoami, demoMode: context.demoMode,
    lead: "Back the ideas you believe in. A little support goes a long way.",
    body: `${stats([["credit budget",String(at(result,"budget") ?? 0)],["credits remaining",credits == null ? "Not started" : String(credits)]])}<section class="briefing"><h2>Make your support count</h2><p>One point of influence costs 1 credit. Two cost 4. Three cost 9. Spread your budget across ideas, or concentrate it on a favorite. Updating a vote replaces your earlier allocation for that project.</p><p class="detail">Project order is shuffled for your ballot. Standings stay hidden until the organizer publishes results.</p></section>${!open ? '<div class="empty-state"><h2>Voting is closed</h2><p>Check the event schedule for the next voting window.</p></div>' : at(result,"requiresSignIn") === true ? '<p><a class="button" href="/signin">Sign in to vote</a></p>' : credits == null ? actionForm(context,"votes.start",{event:slug},{submit:"Start my ballot"}) : `<div class="project-grid">${rows(result,"projects").map((p) => {
      const influence = Number(p.influence ?? 0);
      const available = Number(credits) + influence * influence;
      const maximum = Math.floor(Math.sqrt(Math.max(0, available)));
      return `<article class="project-card"><div class="project-card-body"><h3><a href="/events/${encodeURIComponent(slug)}/projects/${encodeURIComponent(String(p.id))}">${esc(p.title)}</a></h3><p>${esc(p.summary)}</p><p class="detail">Your current influence: ${esc(influence)} · Cost: ${influence ** 2} credits. You can set this project to at most ${maximum} influence with your current credits, including the refund from its current allocation. Set influence to 0 to withdraw support.</p>${actionForm(context,"votes.cast",{event:slug},{idPrefix:`vote-${String(p.id)}-`,without:["token"],hidden:{project:String(p.id)},prefill:{influence:String(influence)},submit:"Save my support"})}</div></article>`;
    }).join("")}</div>`}`,
  });
}
