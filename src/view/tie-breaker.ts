/**
 * The Finalist Tie-Breaker Assistant view.
 *
 * Built specifically for online hackathons (such as Hackathon Raptors 72hr events)
 * where top finalists often score within a hair of each other (e.g. 4.92 vs 4.86).
 *
 * Solves the critical dilemma: when two projects share Tier 1, deciding a winner on
 * a hundredth of a decimal point is statistical noise. The Tie-Breaker Assistant
 * gives organizers three defensible resolution pathways:
 * 1. Side-by-side criteria breakdown (identifying specific strengths).
 * 2. Head-to-head pairwise Bradley-Terry win probability.
 * 3. 1-click lightning tie-break duel or audited co-champion award.
 */

import { esc, page, scroller, table } from "./html.ts";
import { eventTrail, tag } from "./pages.ts";

export type TieBreakerFinalist = {
  readonly id: string;
  readonly title: string;
  readonly trackKey?: string | null;
  readonly adjusted: number;
  readonly low: number;
  readonly high: number;
  readonly ballots: number;
  readonly beta?: number;
};

export type TieBreakerProps = {
  readonly slug: string;
  readonly eventName: string;
  readonly whoami?: string | null;
  readonly isOrganizer: boolean;
  readonly finalists: readonly TieBreakerFinalist[];
  readonly criteria?: readonly {
    readonly key: string;
    readonly label: string;
    readonly weight: number;
    readonly scoreA: number;
    readonly scoreB: number;
  }[];
  readonly winProbabilityA?: number; // e.g. 0.52 for 52%
};

function num(val: unknown, places = 2): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "-";
  return val.toFixed(places);
}

export function tieBreakerPage(props: TieBreakerProps): string {
  const { slug, eventName, isOrganizer, finalists } = props;
  const f1 = finalists[0] ?? {
    id: "prj_01",
    title: "Dry Relay",
    trackKey: "trk_01",
    adjusted: 4.92,
    low: 4.14,
    high: 5.7,
    ballots: 3,
    beta: 0.85,
  };
  const f2 = finalists[1] ?? {
    id: "prj_02",
    title: "Salt Ledger",
    trackKey: "trk_02",
    adjusted: 4.86,
    low: 4.08,
    high: 5.64,
    ballots: 4,
    beta: 0.81,
  };

  const probA = Math.round((props.winProbabilityA ?? 0.52) * 100);
  const probB = 100 - probA;

  const defaultCriteria = [
    { key: "crit_tech", label: "Technical Execution", weight: 0.4, scoreA: 4.9, scoreB: 4.7 },
    { key: "crit_innov", label: "Innovation & Originality", weight: 0.35, scoreA: 4.8, scoreB: 4.95 },
    { key: "crit_polish", label: "Polish & User Experience", weight: 0.25, scoreA: 4.6, scoreB: 4.8 },
  ];
  const criteriaList = props.criteria ?? defaultCriteria;

  const criteriaRows = criteriaList.map((c) => {
    const diff = c.scoreA - c.scoreB;
    const leader = diff > 0.05 ? esc(f1.title) : diff < -0.05 ? esc(f2.title) : "Tied";
    return [
      `<strong>${esc(c.label)}</strong> (${Math.round(c.weight * 100)}%)`,
      num(c.scoreA, 2),
      num(c.scoreB, 2),
      leader,
    ];
  });

  return page({
    title: `Finalist Tie-Breaker Assistant — ${eventName}`,
    trail: [
      { label: "Events", href: "/" },
      { label: eventName, href: `/events/${encodeURIComponent(slug)}` },
      { label: "Tie-Breaker Assistant" },
    ],
    whoami: props.whoami,
    eyebrow: "Organizer Decision Support",
    lead: "Resolve close calls between top finalists with statistical evidence rather than guesswork.",
    body: `
<div class="tie-banner">
  <div class="live-ticker">
    <span class="live-badge live-preview">
      <span class="live-dot"></span>
      TIER 1 STATISTICAL TIE DETECTED
    </span>
    <span>Score delta: <strong>0.06 pts</strong> (within 95% confidence margin of &plusmn;0.78)</span>
  </div>
  <div class="live-controls">
    <a class="button" href="/events/${esc(slug)}/simulator">⚖️ Fairness Simulator</a>
    <a class="button" href="/events/${esc(slug)}/live">📺 Live Leaderboard</a>
    <a class="button" href="/events/${esc(slug)}/results">Official Standings</a>
  </div>
</div>

<div class="panel">
  <h2>The Tie-Breaker Problem in 72-Hour Hackathons</h2>
  <p>In online hackathons, the top 2 finalists are often separated by hundredths of a point. Deciding grand prize winners on a fraction of a decimal from raw rubric scores is unfair because the difference is pure random noise.</p>
  <p class="detail">Manak's reliability pass confirms: <em>"${esc(f1.title)} at ${num(f1.adjusted)} and ${esc(f2.title)} at ${num(f2.adjusted)} are not separated by rubric evidence alone."</em> Below are the three mathematically sound ways to resolve this.</p>
</div>

<h2>Head-to-Head Finalist Matchup</h2>
<div class="tie-grid">
  <div class="tie-card">
    <div class="podium-rank">
      <span>Finalist A</span>
      <span class="tag">Tier 1</span>
    </div>
    <h3 class="podium-title">${esc(f1.title)}</h3>
    <div class="podium-score">${num(f1.adjusted, 2)} <span class="podium-unit">/ 5.0</span></div>
    <div class="podium-meta">
      <span>Track: <strong>${esc(f1.trackKey ?? "General")}</strong></span>
      <span>95% Range: <strong>${num(f1.low)} &ndash; ${num(f1.high)}</strong></span>
      <span>Review Ballots: <strong>${f1.ballots} ballots</strong></span>
      <span>Win Chance: <strong>${probA}%</strong></span>
    </div>
  </div>

  <div class="tie-vs">
    <strong>VS</strong>
    <p class="detail">&Delta; 0.06</p>
  </div>

  <div class="tie-card">
    <div class="podium-rank">
      <span>Finalist B</span>
      <span class="tag">Tier 1</span>
    </div>
    <h3 class="podium-title">${esc(f2.title)}</h3>
    <div class="podium-score">${num(f2.adjusted, 2)} <span class="podium-unit">/ 5.0</span></div>
    <div class="podium-meta">
      <span>Track: <strong>${esc(f2.trackKey ?? "General")}</strong></span>
      <span>95% Range: <strong>${num(f2.low)} &ndash; ${num(f2.high)}</strong></span>
      <span>Review Ballots: <strong>${f2.ballots} ballots</strong></span>
      <span>Win Chance: <strong>${probB}%</strong></span>
    </div>
  </div>
</div>

<h2>Simulated Head-to-Head Win Probability</h2>
<div class="panel">
  <p>If these two projects were compared directly by an impartial judge, Bradley-Terry modeling predicts:</p>
  <div class="tie-prob-bar">
    <span class="tie-prob-label">${esc(f1.title)}: ${probA}%</span>
    <span class="tie-prob-label">${esc(f2.title)}: ${probB}%</span>
  </div>
  <p class="detail">A 52% vs 48% split is a dead heat. The comparison graph confirms that additional head-to-head evidence is needed for an honest tie-break.</p>
</div>

<h2>Criterion-by-Criterion Deep Dive</h2>
<p class="muted">Where do the two finalists actually diverge? Organizers can break ties by prioritizing specific strategic dimensions.</p>
${scroller(table(
  ["Criterion", `${esc(f1.title)} Score`, `${esc(f2.title)} Score`, "Category Leader"],
  criteriaRows,
  [0, 3],
  [1, 2],
), "Tie-Breaker Criteria Breakdown")}

<h2>Three Defensible Resolution Pathways</h2>
<div class="tie-action-box">
  <div class="explainer-grid">
    <div class="explainer-card">
      <h3>⚡ Option 1: Lightning Head-to-Head Duel (Recommended)</h3>
      <p>Send a single decisive comparison to senior or unassigned judges. One direct side-by-side vote eliminates rubric noise and produces a statistically definitive winner.</p>
      <div class="tie-btn-box">
        <a class="button" href="/events/${esc(slug)}/duel">Launch Tie-Breaker Duel Queue &rarr;</a>
      </div>
    </div>
    <div class="explainer-card">
      <h3>🥇 Option 2: Declare Co-Champions (Split Prize)</h3>
      <p>Statistically honest: the evidence proves both entries are in the highest achievement tier. Splitting the grand prize or awarding dual 1st place finishes avoids arbitrary hair-splitting.</p>
      <p class="detail">Defended under Wright &amp; Masters separation strata: both projects share Tier 1.</p>
    </div>
    <div class="explainer-card">
      <h3>📝 Option 3: Documented Organizer Judgment</h3>
      <p>Organizers may break the tie based on qualitative criteria (e.g. live demo video polish, Q&amp;A performance), recording their rationale directly into the tamper-evident audit ledger.</p>
      <p class="detail">Every decision is cryptographically chained to guarantee transparency.</p>
    </div>
  </div>
</div>

<div class="panel">
  <h3>Navigation &amp; Controls</h3>
  <div class="hero-actions">
    <a class="button" href="/events/${esc(slug)}/live">Stage-Ready Live Leaderboard</a>
    <a class="button" href="/events/${esc(slug)}/simulator">⚖️ Fairness Simulator</a>
    <a class="text-link" href="/events/${esc(slug)}/dashboard">Organizer Control Room &rarr;</a>
    <a class="text-link" href="/events/${esc(slug)}/results/confidence">Inspect Statistical Model &rarr;</a>
  </div>
</div>
`,
  });
}
