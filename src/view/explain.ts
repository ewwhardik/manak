import { esc, page, scroller, table } from "./html.ts";
import { eventTrail, rows } from "./pages.ts";
import type { ViewContext } from "./pages.ts";

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x.toFixed(4) : "Unavailable";

export function explainPage(context: ViewContext): string {
  const result = context.result as Record<string, unknown>;
  return page({ title: "Explain my rank", whoami: context.whoami, demoMode: context.demoMode,
    trail: eventTrail(context, { label: "Explain my rank" }),
    lead: `Published revision ${String(result.revision)}. Your team's result and the evidence behind it.`,
    body: `<p>${esc(result.notice)}</p>${rows(result, "projects").map(project => `<section>
<h2>${esc(project.title)}</h2><p>Raw rank: ${esc(project.rankRaw ?? "Unavailable")} · Calibrated rank: ${esc(project.rank)} · Rank movement: ${esc(project.rankMove ?? "Unavailable")}</p>
<p>Raw mean: ${num(project.rawMean)} · Published score: ${num(project.adjusted)} · Panel grand mean: ${num(project.grandMean)}</p>
${rows(project, "reviews").length ? scroller(table(["Review", "Raw total", "Baseline", "Scale", "Information weight", "Shrinkage trust", "Calibrated contribution"],
rows(project, "reviews").map(r => [String(r.label), num(r.raw), num(r.baseline), num(r.scale), num(r.weight), r.slopeFitted ? num(r.shrinkage) : "Scale held at 1", num(r.calibrated)])), "Anonymous review contributions") : '<p>No frozen rubric breakdown is available for this revision.</p>'}
</section>`).join("") || '<p>Your team has no project in this published ranking.</p>'}
<h2>How the calculation works</h2><p>Each raw total is the rubric's weighted criterion score. Baseline is the panel grand mean plus the fitted reviewer leniency and the final fit's pending leniency correction. Each calibrated contribution is grand mean + (raw total − baseline) / scale.</p>
<p>The published calibrated score is the information-weighted average of these contributions, with information weight = scale². Values are rounded for display. A positive rank movement means the project rose relative to raw ranking.</p>
<p>Shrinkage trust is n / (n + κ): it blends the fitted scale toward 1 before scale bounds apply. When there are too few observations to estimate a slope, the scale stays at 1. This is uncertainty about reviewer scale, not a penalty to your project. Review labels restart within your project; they do not match judge identities or review labels elsewhere.</p>` });
}

export function sandboxPage(context: ViewContext): string {
  const result = context.result as Record<string, unknown>;
  return page({ title: "Normalization sandbox", whoami: context.whoami, demoMode: context.demoMode,
    trail: eventTrail(context, { label: "Normalization sandbox" }),
    lead: "Compare methods against current evidence.", body: `<p>${esc(result.notice)}</p>${rows(result, "methods").map(method => `<section><h2>${esc(method.name)}</h2><p>${esc(method.caveat)}</p>${method.available ? scroller(table(["Rank", "Project", "Score"], rows(method, "scores").map(s => [String(s.rank), String(s.title), num(s.score)])), String(method.name)) : '<p>Unavailable with current evidence.</p>'}</section>`).join("")}` });
}
