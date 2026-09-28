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
<div class="study-stage globe-stage"><div class="globe-scene" aria-hidden="true"><div class="globe-halo"></div><div class="globe-axis"><div class="globe-core"><div class="globe-land-track"><svg class="globe-land" viewBox="0 0 400 200" focusable="false" aria-hidden="true"><path d="M40 70 Q60 50 90 60 Q120 70 140 50 Q160 30 180 40 Q190 60 170 80 Q150 95 130 90 Q110 110 80 100 Q50 90 40 70 Z M220 50 Q260 35 290 55 Q330 40 360 65 Q370 95 340 105 Q310 115 280 95 Q250 85 230 100 Q210 80 220 50 Z M80 125 Q110 115 130 135 Q140 165 110 185 Q85 170 75 145 Z M240 115 Q270 105 300 120 Q315 150 285 175 Q255 165 240 140 Z"/></svg><svg class="globe-land" viewBox="0 0 400 200" focusable="false" aria-hidden="true"><path d="M40 70 Q60 50 90 60 Q120 70 140 50 Q160 30 180 40 Q190 60 170 80 Q150 95 130 90 Q110 110 80 100 Q50 90 40 70 Z M220 50 Q260 35 290 55 Q330 40 360 65 Q370 95 340 105 Q310 115 280 95 Q250 85 230 100 Q210 80 220 50 Z M80 125 Q110 115 130 135 Q140 165 110 185 Q85 170 75 145 Z M240 115 Q270 105 300 120 Q315 150 285 175 Q255 165 240 140 Z"/></svg></div><div class="globe-shading"></div></div><div class="globe-sphere"><div class="globe-meridian globe-meridian-a"></div><div class="globe-meridian globe-meridian-b"></div><div class="globe-meridian globe-meridian-c"></div><div class="globe-meridian globe-meridian-d"></div><div class="globe-equator"></div><div class="globe-latitude globe-latitude-north"></div><div class="globe-latitude globe-latitude-south"></div></div><div class="globe-orbit globe-orbit-a"></div><div class="globe-orbit globe-orbit-b"></div><span class="globe-point globe-point-a"></span><span class="globe-point globe-point-b"></span><span class="globe-point globe-point-c"></span></div></div>
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
