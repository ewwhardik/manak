/** Local rendered geometry; decorative artwork never implies live judging activity. */
import { esc } from "./html.ts";

export function phaseLabel(value: unknown): string {
  const labels: Record<string, string> = {
    upcoming: "Opening soon", submissions: "Submissions open", overlap: "Submit & review",
    judging: "Judging in progress", between: "Reviews opening soon", finished: "Event closed",
  };
  return labels[String(value)] ?? String(value ?? "Opening soon");
}

export function arenaArt(): string {
  return `<figure class="motion-study">
<div class="study-meta"><span>ONE EVENT / MANY PERSPECTIVES</span><span>STUDY 001</span></div>
<input class="motion-switch" type="checkbox" id="pause-orbit"><label class="motion-control" for="pause-orbit"><span class="pause-label">Pause motion</span><span class="play-label">Play motion</span></label>
<div class="study-stage globe-stage"><div class="globe-scene" aria-hidden="true"><div class="globe-halo"></div><div class="globe-axis"><div class="globe-sphere"><div class="globe-core"></div><div class="globe-meridian globe-meridian-a"></div><div class="globe-meridian globe-meridian-b"></div><div class="globe-meridian globe-meridian-c"></div><div class="globe-meridian globe-meridian-d"></div><div class="globe-equator"></div><div class="globe-latitude globe-latitude-north"></div><div class="globe-latitude globe-latitude-south"></div><svg class="globe-land" viewBox="0 0 400 400" focusable="false" aria-hidden="true"><path d="M60 124l30-21 29 8 17-15 33 8 9 24-15 12-1 20-20 5-13 27-21-3-5-24-26-13-17 5zm117 89 23-8 30 10 24 23-8 17 14 19-18 17-15 42-16 15-17-20 2-35-14-17-2-32zm80-113 19-13 26 6 17 19 24-3 18 15-11 22-27 4-10 27-19-6-15 11-9-28-24-3-9-25zm54 116 24 3 17 18-7 19-31-5-17-14z"/></svg></div><div class="globe-orbit globe-orbit-a"></div><div class="globe-orbit globe-orbit-b"></div><span class="globe-point globe-point-a"></span><span class="globe-point globe-point-b"></span><span class="globe-point globe-point-c"></span></div></div>
<div class="study-coordinate" aria-hidden="true">Build worldwide.<br><b>Judge with context.</b></div>
<figcaption><span class="study-cross" aria-hidden="true">✳</span><span>Each perspective adds depth<br>to the final decision.</span><span class="study-number" aria-hidden="true">m / 01</span></figcaption>
</figure>`;
}

export function eventJourney(event: unknown, now: number, scope: { slug: string; roles: readonly string[]; resultsPublic: boolean }): string {
  const e = event as Record<string, unknown> | null;
  const base = `/events/${encodeURIComponent(scope.slug)}`;
  const canOrganize = scope.roles.includes("organizer");
  const canJudge = scope.roles.includes("judge");
  const stages: readonly [string, string, string, string | null][] = [
    ["01", "Set up", now < Number(e?.submissionsOpenAt) ? "Current stage" : "Complete", base],
    ["02", "Submissions", now < Number(e?.submissionsOpenAt) ? "Upcoming" : now < Number(e?.submissionsCloseAt) ? "Open now" : "Closed", `${base}/projects`],
    ["03", "Judging", now < Number(e?.judgingOpenAt) ? "Upcoming" : now < Number(e?.judgingCloseAt) ? "Open now" : "Closed", canJudge ? `${base}/judging` : canOrganize ? `${base}/dashboard` : null],
    ["04", "Results", scope.resultsPublic ? "Published" : "Awaiting publication", scope.resultsPublic || canOrganize ? `${base}/results` : null],
    ["05", "Certificates", scope.resultsPublic ? "Verify or issue" : "After results", canOrganize ? `${base}/certificates` : scope.resultsPublic ? "/verify" : null],
  ];
  return `<nav class="event-flow" aria-label="Event stages"><ol class="event-journey">${stages.map(([n, label, state, href]) => {
    const current = state === "Open now" || state === "Current stage" || state === "Published";
    const content = `<span class="journey-number">${n}</span><span class="journey-copy"><b>${label}</b><span>${esc(state)}</span></span>`;
    return `<li${current ? ' class="is-active"' : ""}>${href ? `<a href="${esc(href)}"${current ? ' aria-current="step"' : ""}>${content}</a>` : `<span class="journey-static">${content}</span>`}</li>`;
  }).join("")}</ol></nav>`;
}
