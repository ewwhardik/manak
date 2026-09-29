/**
 * Side-by-side rival comparison view.
 *
 * Compares two projects along three rigorous dimensions:
 *   1. Content overlap: TF-IDF cosine similarity and shared topical keywords.
 *   2. Evaluated standing: Bayesian normalized ranks, adjusted scores, and confidence intervals.
 *   3. Direct competition: Head-to-head pairwise duel records and Bradley-Terry win probabilities.
 *
 * Adheres strictly to repository invariants: semantic HTML, no client JS, pure server render.
 */

import { esc, meter, page, scroller, table } from "./html.ts";
import { at, eventTrail, rows, tag } from "./pages.ts";
import type { ViewContext } from "./pages.ts";

export function comparePage(context: ViewContext): string {
  const result = context.result as Record<string, unknown>;
  const eventSlug = String(context.event?.slug ?? at(result, "eventSlug") ?? "");
  const left = (at(result, "left") ?? {}) as Record<string, unknown>;
  const right = (at(result, "right") ?? {}) as Record<string, unknown>;
  const similarity = (at(result, "similarity") ?? {}) as Record<string, unknown>;
  const headToHead = (at(result, "headToHead") ?? {}) as Record<string, unknown>;
  const criteria = rows(result, "criteriaComparison");
  const allProjects = rows(result, "allProjects");

  const leftId = String(at(left, "id") ?? "");
  const rightId = String(at(right, "id") ?? "");
  const leftTitle = String(at(left, "title") ?? "Project A");
  const rightTitle = String(at(right, "title") ?? "Project B");

  const simScore = typeof similarity.score === "number" ? similarity.score : 0;
  const simPct = Math.round(simScore * 100);
  const sharedKeywords = (Array.isArray(similarity.sharedKeywords)
    ? similarity.sharedKeywords
    : []) as string[];

  // Selector form
  const selectorForm = `<form method="GET" action="/events/${encodeURIComponent(eventSlug)}/compare" class="filter-bar">
  <div class="field">
    <label for="f-left">First Project</label>
    <select id="f-left" name="left">
      ${allProjects
        .map((p) => {
          const id = String(at(p, "id") ?? "");
          const title = String(at(p, "title") ?? id);
          return `<option value="${esc(id)}"${id === leftId ? " selected" : ""}>${esc(title)}</option>`;
        })
        .join("")}
    </select>
  </div>
  <div class="field">
    <label for="f-right">Second Project (Rival)</label>
    <select id="f-right" name="right">
      ${allProjects
        .map((p) => {
          const id = String(at(p, "id") ?? "");
          const title = String(at(p, "title") ?? id);
          return `<option value="${esc(id)}"${id === rightId ? " selected" : ""}>${esc(title)}</option>`;
        })
        .join("")}
    </select>
  </div>
  <div class="field" style="align-self: flex-end;">
    <button type="submit">Compare Rivals</button>
  </div>
</form>`;

  // Thematic similarity card
  const keywordTags =
    sharedKeywords.length > 0
      ? `<div style="margin-top: 0.5rem;"><strong>Common themes:</strong> ${sharedKeywords.map((k) => tag(k, "open")).join(" ")}</div>`
      : "";

  const similarityCard = `<div class="panel">
  <div class="section-heading">
    <div>
      <p class="eyebrow">THEMATIC OVERLAP</p>
      <h2>TF-IDF Vector Cosine Similarity: ${simPct}%</h2>
    </div>
  </div>
  <p>Vector angle between project descriptions derived from domain TF-IDF vocabulary weights.</p>
  ${meter(simScore, `Semantic similarity: ${simPct}%`)}
  ${keywordTags}
</div>`;

  // Side-by-side project overview
  const sideCard = (proj: Record<string, unknown>, sideLabel: string): string => {
    const title = String(at(proj, "title") ?? "Untitled");
    const summary = String(at(proj, "summary") ?? at(proj, "description") ?? "");
    const track = String(at(proj, "track") ?? "General");
    const team = String(at(proj, "teamName") ?? "Individual");
    const rank = at(proj, "rank");
    const adjusted = at(proj, "adjusted");
    const low = at(proj, "low");
    const high = at(proj, "high");

    return `<div class="panel">
  <p class="eyebrow">${sideLabel.toUpperCase()} CONTENDER</p>
  <h3>${esc(title)}</h3>
  <p class="detail">Team: ${esc(team)} · Track: ${esc(track)}</p>
  <p>${esc(summary)}</p>
  <div class="grid panel" style="margin-top: 1rem;">
    <div class="stat">
      <span class="value">${rank !== null && rank !== undefined ? `#${rank}` : "—"}</span>
      <span class="label">Bayesian Rank</span>
    </div>
    <div class="stat">
      <span class="value">${typeof adjusted === "number" ? adjusted.toFixed(2) : "—"}</span>
      <span class="label">Adjusted Score</span>
    </div>
    <div class="stat">
      <span class="value">${typeof low === "number" && typeof high === "number" ? `[${low.toFixed(1)}, ${high.toFixed(1)}]` : "—"}</span>
      <span class="label">95% Uncertainty</span>
    </div>
  </div>
</div>`;
  };

  const projectPair = `<div class="pair">
  ${sideCard(left, "Left")}
  ${sideCard(right, "Right")}
</div>`;

  // Rubric Criterion Breakdown
  const criteriaTable =
    criteria.length > 0
      ? `<section class="panel" style="margin-top: 1.5rem;">
  <h3>Rubric Criteria Breakdown</h3>
  <p class="detail">Average rubric scores across independent judge evaluations.</p>
  ${scroller(table(
    ["Criterion", "Weight", esc(leftTitle), esc(rightTitle), "Differential"],
    criteria.map((c) => {
      const label = String(at(c, "label") ?? at(c, "key") ?? "");
      const weight = at(c, "weight");
      const leftAvg = typeof c.leftAvg === "number" ? c.leftAvg.toFixed(2) : "—";
      const rightAvg = typeof c.rightAvg === "number" ? c.rightAvg.toFixed(2) : "—";
      let diff = "Equal";
      if (typeof c.leftAvg === "number" && typeof c.rightAvg === "number") {
        const delta = c.leftAvg - c.rightAvg;
        if (Math.abs(delta) < 0.05) diff = "Tie (±0.05)";
        else if (delta > 0) diff = `+${delta.toFixed(2)} (${esc(leftTitle.slice(0, 16))})`;
        else diff = `+${(-delta).toFixed(2)} (${esc(rightTitle.slice(0, 16))})`;
      }
      return [label, String(weight ?? 1), leftAvg, rightAvg, diff];
    }),
    [0, 4],
    [1, 2, 3],
  ), "Rubric Criteria Breakdown")}
</section>`
      : "";

  // Head-to-Head Duel Records
  const leftWins = Number(at(headToHead, "leftWins") ?? 0);
  const rightWins = Number(at(headToHead, "rightWins") ?? 0);
  const totalDuels = Number(at(headToHead, "totalDuels") ?? 0);
  const leftProb = typeof headToHead.leftWinProbability === "number" ? Math.round(headToHead.leftWinProbability * 100) : 50;

  const duelSection = `<section class="panel" style="margin-top: 1.5rem;">
  <h3>Direct Head-to-Head Duels</h3>
  <p class="detail">Empirical paired comparison records and Bradley-Terry MLE win expectancy.</p>
  <div class="grid panel">
    <div class="stat">
      <span class="value">${leftWins} vs ${rightWins}</span>
      <span class="label">Direct Duels Won (${totalDuels} total)</span>
    </div>
    <div class="stat">
      <span class="value">${leftProb}%</span>
      <span class="label">${esc(leftTitle.slice(0, 18))} Win Probability</span>
    </div>
    <div class="stat">
      <span class="value">${100 - leftProb}%</span>
      <span class="label">${esc(rightTitle.slice(0, 18))} Win Probability</span>
    </div>
  </div>
</section>`;

  return page({
    title: `Compare Rivals: ${leftTitle} vs ${rightTitle}`,
    trail: eventTrail(context, { label: "Rival Comparison" }),
    whoami: context.whoami,
    demoMode: context.demoMode,
    body: `${selectorForm}
${similarityCard}
${projectPair}
${criteriaTable}
${duelSection}`,
  });
}
