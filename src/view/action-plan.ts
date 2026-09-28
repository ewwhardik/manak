import { esc } from "./html.ts";

type Check = { code: string; status: string; title: string; detail: string };

/** Shared destinations keep the short queue and every evidence check in sync. */
export function readinessDestination(code: string, slug: string): [string, string] {
  const event = `/events/${encodeURIComponent(slug)}`;
  const destinations: Record<string, [string, string]> = {
    field: ["Review submissions", `${event}/projects`],
    "submissions.duplicates": ["Inspect repeated titles", `${event}/projects`],
    coverage: ["Fill review gaps", "#coverage"],
    "rubric.overlap": ["Plan shared reviews", "#operations"],
    "rubric.resilience": ["Strengthen panel overlap", "#operations"],
    "rubric.fit": ["Review rubric and scores", `${event}/rubric`],
    "rubric.discrimination": ["Review judge progress", "#judges"],
    "pairwise.coverage": ["Inspect comparison coverage", "#coverage"],
    "pairwise.connected": ["Find bridge comparisons", "?lab=true#evidence-lab"],
    "pairwise.fit": ["Inspect comparison evidence", "?lab=true#evidence-lab"],
  };
  return destinations[code] ?? ["Review this finding", `#readiness-${encodeURIComponent(code)}`];
}

/** Private diagnostics become a short, navigable work queue. No mutations. */
export function actionPlan(checks: readonly Check[], slug: string): string {
  const event = `/events/${encodeURIComponent(slug)}`;
  const pending = checks.filter((c) => c.status !== "pass")
    .sort((a, b) => Number(b.status === "missing") - Number(a.status === "missing"));
  return `<section class="action-plan" aria-labelledby="action-plan-title"><div class="section-heading"><div><p class="eyebrow">Your next steps</p><h2 id="action-plan-title">${pending.length ? "Focus on what needs attention." : "Ready for a final review."}</h2></div><a href="#readiness">All evidence checks ↓</a></div>${pending.length
    ? `<ol class="action-queue">${pending.slice(0, 3).map((c, index) => {
      const [label, href] = readinessDestination(c.code, slug);
      return `<li><span class="action-step" aria-hidden="true">0${index + 1}</span><div><span class="detail">${c.status === "missing" ? "Evidence needed" : "Organizer review"}</span><h3>${esc(c.title)}</h3><p>${esc(c.detail)}</p></div><a class="action-link" href="${esc(href)}">${esc(label)} ↗</a></li>`;
    }).join("")}</ol>`
    : `<p>The configured checks passed. Review close calls, confirm voting has closed, and preview the public standings before publishing.</p><a class="action-link" href="${event}/results">Preview results ↗</a>`}</section>`;
}
