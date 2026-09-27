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
<div class="study-meta"><span>THE SHAPE OF COLLECTIVE JUDGMENT</span><span>STUDY 001</span></div>
<input class="motion-switch" type="checkbox" id="pause-orbit"><label class="motion-control" for="pause-orbit"><span class="pause-label">Pause motion</span><span class="play-label">Play motion</span></label>
<div class="study-stage"><img class="study-still" src="/assets/judging-orbit.webp" width="800" height="680" alt="" fetchpriority="high"><picture class="study-motion"><source media="(prefers-reduced-motion: reduce)" srcset="/assets/judging-orbit.webp"><img src="/assets/judging-orbit.gif" width="800" height="680" alt="" decoding="async"></picture></div>
<div class="study-coordinate" aria-hidden="true">Independent perspectives.<br><b>One considered outcome.</b></div>
<figcaption><span class="study-cross" aria-hidden="true">✳</span><span>A stronger result starts<br>with connected perspectives.</span><span class="study-number" aria-hidden="true">m / 01</span></figcaption>
</figure>`;
}

export function eventJourney(event: unknown, now: number): string {
  const e = event as Record<string, unknown> | null;
  const stages = [
    ["01", "Build & submit", Number(e?.submissionsOpenAt), Number(e?.submissionsCloseAt)],
    ["02", "Review & compare", Number(e?.judgingOpenAt), Number(e?.judgingCloseAt)],
  ] as const;
  return `<ol class="event-journey" aria-label="Event journey">${stages.map(([n, label, open, close]) => {
    const state = now < open ? "Upcoming" : now < close ? "Open now" : "Window closed";
    return `<li${state === "Open now" ? ' class="is-active"' : ""}><span class="journey-number">${n}</span><div><b>${label}</b><span>${esc(state)}</span></div></li>`;
  }).join("")}<li><span class="journey-number">03</span><div><b>Celebrate the work</b><span>Results & recognition</span></div></li></ol>`;
}
