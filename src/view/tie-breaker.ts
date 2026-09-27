/** Organizer decision support: existing visual layout, measured evidence only. */
import { esc, page } from "./html.ts";
import type { CloseCall } from "../judging/index.ts";

export type TieBreakerFinalist = {
  readonly id: string; readonly title: string; readonly trackKey?: string | null;
  readonly adjusted: number; readonly low?: number; readonly high?: number; readonly ballots: number;
};
export type TieBreakerProps = {
  readonly slug: string; readonly eventName: string; readonly whoami?: string | null;
  readonly isOrganizer: boolean; readonly finalists: readonly TieBreakerFinalist[];
  readonly assessment: CloseCall;
};
const num = (n: number | null | undefined): string => typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "Unavailable";
export function tieBreakerPage(props: TieBreakerProps): string {
  const { assessment: evidence, finalists } = props;
  const base = `/events/${encodeURIComponent(props.slug)}`;
  const status = { insufficient: "More scored projects needed", overlap: "Reported intervals overlap",
    separated: "Reported intervals are separated", "uncertainty-unavailable": "Uncertainty unavailable" }[evidence.state];
  const probability = evidence.winProbabilityA;
  return page({ title: `Finalist Tie-Breaker Assistant — ${props.eventName}`, whoami: props.whoami,
    trail: [{ label: props.eventName, href: base }, { label: "Finalist decision support" }],
    lead: "Inspect the evidence before deciding how to resolve a close result.",
    body: `<div class="tie-banner"><div class="live-ticker"><span class="live-badge live-preview">${esc(status)}</span>
<span>Score difference: <strong>${num(evidence.delta)}</strong></span></div><div class="live-controls"><a class="button" href="${base}/results">Official standings</a></div></div>
<p>These are the first two projects in the current result report. After publication, the report uses the frozen revision. Overlapping marginal intervals do not prove equality; separated intervals do not establish award eligibility.</p>
${finalists.length < 2 ? '<div class="panel"><h2>Not enough evidence for a matchup</h2><p>Submit reviews for at least two eligible projects. No example competitors or scores are substituted.</p></div>' : `<div class="tie-grid">${finalists.map((p, i) => `${i === 1 ? '<div class="tie-vs"><strong>VS</strong></div>' : ''}<div class="tie-card"><div class="podium-rank">Finalist ${i + 1}</div><h2 class="podium-title">${esc(p.title)}</h2><div class="podium-score">${num(p.adjusted)} <span class="podium-unit">fitted units</span></div><div class="podium-meta"><span>Track: ${esc(p.trackKey ?? "General")}</span><span>Reported interval: ${num(p.low)} – ${num(p.high)}</span><span>Rubric ballots: ${p.ballots}</span></div></div>`).join('')}</div>`}
<div class="panel"><h2>Pairwise evidence</h2><div class="tie-prob-bar"><span class="tie-prob-label">${probability === null ? 'Comparison probability unavailable' : `${esc(finalists[0]!.title)}: ${(100 * probability).toFixed(1)}%`}</span>${probability === null ? '' : `<span class="tie-prob-label">${esc(finalists[1]!.title)}: ${(100 * (1 - probability)).toFixed(1)}%</span>`}</div><p>${esc(evidence.probabilityReason)}</p><p class="detail">A rubric-score difference is not a Bradley–Terry log-strength difference. A single additional vote cannot guarantee a statistically definitive winner.</p></div>
<div class="tie-action-box"><h2>Next steps for the organizer</h2><div class="explainer-grid"><div class="explainer-card"><h3>Collect independent evidence</h3><p>Use the coverage and finalist diagnostics to select further reviews. The ordinary duel queue does not promise a specific finalist matchup.</p><div class="tie-btn-box"><a class="button" href="${base}/dashboard">Review coverage</a></div></div><div class="explainer-card"><h3>Apply the announced tie policy</h3><p>Use the published event rules. Joint awards or qualitative tie-breaking need an explicit recorded decision; this page does not issue either automatically.</p></div></div></div>
<div class="panel"><h2>Inspect the model</h2><a class="text-link" href="${base}/results/confidence">Statistical diagnostics</a> · <a class="text-link" href="${base}/live">Ceremony preview</a></div>` });
}
