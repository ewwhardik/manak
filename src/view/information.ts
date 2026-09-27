import { esc, scroller, table } from "./html.ts";
import { at, rows } from "./pages.ts";

export function informationPanel(value: unknown, titles: ReadonlyMap<string, string>): string {
  const report = at(value, "report");
  const status = String(at(value, "status") ?? "needs-converged-fit");
  const named = (id: unknown) => titles.get(String(id)) ?? String(id);
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "Unidentified";
  if (!report) return `<section class="information-panel"><h3>Where another comparison would help</h3><p>${esc(status === "limit" ? "The comparison graph exceeds the interactive analysis budget. Export comparisons for offline analysis." : status === "ill-conditioned" ? "The graph is too poorly conditioned for a reliable information estimate. Collect balanced comparisons and review the fit." : "Collect pairwise decisions first. Information analysis needs a converged pairwise fit.")}</p></section>`;
  return `<section class="information-panel"><div class="section-heading"><div><p class="eyebrow">Make the next review count</p><h3>Where another comparison would help</h3></div><span class="tag">${esc(at(report,"componentCount"))} comparison groups</span></div><p>Disconnected groups need a shared comparison before their relative order can be supported. Within a group, larger information gain identifies a more useful additional comparison under the current model.</p>
${at(report, "numericallySound") === true ? "" : '<p class="problem">Numerical checks need attention. Treat these suggestions as unresolved.</p>'}
${scroller(table(["Compare these projects", "Why this pair", "Information gain", "Relative SE"], rows(report,"recommendations").map((p) => [
  `${named(p.left)} / ${named(p.right)}`, p.reason === "bridge" ? "Connect separate groups" : "Reduce model uncertainty",
  p.reason === "bridge" ? "Not comparable yet" : number(p.informationGain), number(p.relativeSE),
]), [], [2,3]), "Information-based comparison suggestions")}
<details><summary>Understand the mathematics and checks</summary><p>The Fisher information matrix is a weighted graph Laplacian. Effective resistance measures uncertainty in a difference of log-strengths. Relative SE is its square root; it is a local approximation, not a calibrated confidence interval.</p><p>Information gain is the expected increase in log determinant from one additional comparison, holding the current strengths fixed. A bridge receives priority without inventing a finite cross-group uncertainty.</p><dl><dt>Identifiable contrasts</dt><dd>${esc(at(report,"identifiableContrasts"))}</dd><dt>Linear solve residual</dt><dd>${esc(at(report,"solveResidual"))}</dd><dt>Leverage identity error</dt><dd>${esc(at(report,"leverageError"))}</dd></dl>
<h4>Links carrying the most structural weight</h4>${scroller(table(["Pair", "Comparisons", "Edge leverage"], rows(report,"bottlenecks").map((p) => [`${named(p.left)} / ${named(p.right)}`, String(p.comparisons), number(p.leverage)]), [], [1,2]), "Comparison graph bottlenecks")}<p>A leverage near one means this pair carries a critical connection in the observed graph. It says nothing about reviewer honesty.</p></details><p class="detail">${esc(at(report,"note"))}</p></section>`;
}

export function evidenceGlossary(): string {
  return `<details class="evidence-guide"><summary>New to judging statistics? Start with these four ideas.</summary><div class="glossary-grid"><div><h3>Adjusted score</h3><p>A score after the model accounts for how generously or harshly judges use the rubric. Compare it with the raw score.</p></div><div><h3>Uncertainty</h3><p>A range showing how much an estimate could vary under the model. Overlapping ranges mean close places need care.</p></div><div><h3>Coverage</h3><p>How many independent, submitted reviews support each project. Drafts and unfilled assignments are not evidence.</p></div><div><h3>Connected comparisons</h3><p>Projects need shared comparison paths. Separate panels cannot establish a common order without overlap.</p></div></div></details>`;
}
