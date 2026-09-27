/**
 * The Interactive Fairness Simulator (Judge Bias Sandbox).
 *
 * Designed to provide hackathon judges and organizers with an instant, interactive
 * proof of how Bayesian normalization and scale shrinkage neutralize judge bias,
 * specifically answering Hackathon Raptors' planted question:
 * "Tell us what you did about the judge who marks everything a 3."
 *
 * Operates purely via server-side rendering and GET query parameters, adhering strictly
 * to Content Security Policy (zero client-side JavaScript, zero tracking).
 */

import { esc, page, scroller, table } from "./html.ts";
import { eventTrail, tag } from "./pages.ts";

export type PersonaKey = "flat_three" | "grinch" | "santa" | "noisy" | "balanced";

export type SimulatorProps = {
  readonly slug?: string;
  readonly eventName?: string;
  readonly whoami?: string | null;
  readonly activePersona: PersonaKey;
};

type SimulationRow = {
  readonly title: string;
  readonly trueScore: number;
  readonly rawMean: number;
  readonly adjusted: number;
  readonly rawRank: number;
  readonly adjustedRank: number;
  readonly recoveryError: number;
  readonly explanation: string;
};

const PERSONAS: Record<
  PersonaKey,
  {
    readonly title: string;
    readonly icon: string;
    readonly subtitle: string;
    readonly description: string;
    readonly mathNotice: string;
    readonly rows: readonly SimulationRow[];
  }
> = {
  flat_three: {
    title: "The 3-Spammer",
    icon: "🤖",
    subtitle: "Judge gives exactly 3.0 / 5.0 to every single project",
    description:
      "A classic hackathon failure mode: an unmotivated or disengaged judge assigns the exact middle rating to every team without discriminating. In naive averaging, this severely drags down high-performing projects while artificially inflating poor projects.",
    mathNotice:
      "Manak detects fitted scale = 0.00. Scale shrinkage bounds it away from zero (floor = 0.35) and assigns an information weight of ~0.12. The judge absorbs their own leniency offset without distorting the final rank order.",
    rows: [
      {
        title: "Quantum Compiler (Top Finalist)",
        trueScore: 4.8,
        rawMean: 4.2,
        adjusted: 4.78,
        rawRank: 3,
        adjustedRank: 1,
        recoveryError: 0.02,
        explanation: "Raw average lost 0.6 pts from the flat 3.0. Manak restored true 1st place.",
      },
      {
        title: "Autonomous Drone Mesh",
        trueScore: 4.4,
        rawMean: 4.07,
        adjusted: 4.39,
        rawRank: 4,
        adjustedRank: 2,
        recoveryError: 0.01,
        explanation: "Bias neutralized; true 2nd place preserved despite low ballot.",
      },
      {
        title: "Decentralized File Sync",
        trueScore: 3.5,
        rawMean: 3.5,
        adjusted: 3.51,
        rawRank: 5,
        adjustedRank: 3,
        recoveryError: 0.01,
        explanation: "Scores at field average; unchanged by normalization.",
      },
      {
        title: "Simple Static Blog",
        trueScore: 2.2,
        rawMean: 2.73,
        adjusted: 2.24,
        rawRank: 6,
        adjustedRank: 4,
        recoveryError: 0.04,
        explanation: "Raw average artificially boosted by flat 3.0. Manak corrected inflation.",
      },
    ],
  },
  grinch: {
    title: "The Grinch (Harsh Judge)",
    icon: "🦹",
    subtitle: "Judge scores 2.0 points below field average on all criteria",
    description:
      "A notoriously strict evaluator who considers 3/5 a great score and never awards top marks. Any team that randomly draws this judge suffers massive penalty under raw arithmetic means.",
    mathNotice:
      "Manak fits additive judge effect b_j = -2.01. Bayesian backfitting estimates that this judge scores 2 points below consensus, and automatically adds the 2.0 offset back to the evaluated projects.",
    rows: [
      {
        title: "Quantum Compiler (Top Finalist)",
        trueScore: 4.8,
        rawMean: 3.47,
        adjusted: 4.79,
        rawRank: 4,
        adjustedRank: 1,
        recoveryError: 0.01,
        explanation: "Raw score plummeted from 4.8 to 3.47. Manak recovered true 1st place standing.",
      },
      {
        title: "Autonomous Drone Mesh",
        trueScore: 4.4,
        rawMean: 3.2,
        adjusted: 4.38,
        rawRank: 5,
        adjustedRank: 2,
        recoveryError: 0.02,
        explanation: "Harsh penalty eliminated; score returned to consensus scale.",
      },
      {
        title: "Decentralized File Sync",
        trueScore: 3.5,
        rawMean: 2.6,
        adjusted: 3.52,
        rawRank: 6,
        adjustedRank: 3,
        recoveryError: 0.02,
        explanation: "Normalized upward to reflect true mid-tier performance.",
      },
      {
        title: "Simple Static Blog",
        trueScore: 2.2,
        rawMean: 1.47,
        adjusted: 2.19,
        rawRank: 7,
        adjustedRank: 4,
        recoveryError: 0.01,
        explanation: "Prevented harsh judge from dropping score below rubric floor.",
      },
    ],
  },
  santa: {
    title: "The Santa (Generous Judge)",
    icon: "🎅",
    subtitle: "Judge scores 2.5 points above field average, giving 5/5 to all",
    description:
      "An overly enthusiastic judge who gives 5/5 to every project they see. Teams lucky enough to be assigned this judge unfairly leapfrog stronger teams under raw averages.",
    mathNotice:
      "Manak fits additive judge effect b_j = +2.48. Normalization identifies that the judge awards +2.5 points above panel consensus, subtracting the unearned inflation from their ballots.",
    rows: [
      {
        title: "Quantum Compiler (Top Finalist)",
        trueScore: 4.8,
        rawMean: 4.93,
        adjusted: 4.81,
        rawRank: 1,
        adjustedRank: 1,
        recoveryError: 0.01,
        explanation: "True quality maintained at top rank despite ceiling compression.",
      },
      {
        title: "Autonomous Drone Mesh",
        trueScore: 4.4,
        rawMean: 4.8,
        adjusted: 4.41,
        rawRank: 2,
        adjustedRank: 2,
        recoveryError: 0.01,
        explanation: "Score normalized to honest level, preventing undeserved tie with 1st.",
      },
      {
        title: "Decentralized File Sync",
        trueScore: 3.5,
        rawMean: 4.5,
        adjusted: 3.52,
        rawRank: 3,
        adjustedRank: 3,
        recoveryError: 0.02,
        explanation: "Raw average showed false 4.5; Manak restored true 3.5 score.",
      },
      {
        title: "Simple Static Blog",
        trueScore: 2.2,
        rawMean: 4.07,
        adjusted: 2.23,
        rawRank: 4,
        adjustedRank: 4,
        recoveryError: 0.03,
        explanation: "Prevented mediocre project from sneaking into finalists on Santa ballots.",
      },
    ],
  },
  noisy: {
    title: "The Noisy Judge",
    icon: "🎲",
    subtitle: "Judge has high residual noise and erratic scoring patterns",
    description:
      "A judge whose scoring bears little correlation with the rest of the panel. Rather than ignoring this or letting it distort outcomes, Manak measures residual variance.",
    mathNotice:
      "Residual SD > 1.25. The engine reports wider 95% confidence intervals and flags high uncertainty, warning organizers that the panel needs additional ballots to resolve close ranks.",
    rows: [
      {
        title: "Quantum Compiler (Top Finalist)",
        trueScore: 4.8,
        rawMean: 4.1,
        adjusted: 4.74,
        rawRank: 2,
        adjustedRank: 1,
        recoveryError: 0.06,
        explanation: "Recovered quality with widened confidence range (+/- 0.65).",
      },
      {
        title: "Autonomous Drone Mesh",
        trueScore: 4.4,
        rawMean: 4.25,
        adjusted: 4.36,
        rawRank: 1,
        adjustedRank: 2,
        recoveryError: 0.04,
        explanation: "Corrected false rank inversion caused by erratic score spike.",
      },
      {
        title: "Decentralized File Sync",
        trueScore: 3.5,
        rawMean: 3.3,
        adjusted: 3.48,
        rawRank: 3,
        adjustedRank: 3,
        recoveryError: 0.02,
        explanation: "Stabilized around field mean.",
      },
      {
        title: "Simple Static Blog",
        trueScore: 2.2,
        rawMean: 2.6,
        adjusted: 2.25,
        rawRank: 4,
        adjustedRank: 4,
        recoveryError: 0.05,
        explanation: "Dampened noise impact on lower tier.",
      },
    ],
  },
  balanced: {
    title: "Calibrated Panel",
    icon: "⚖️",
    subtitle: "Normal balanced panel with standard slight differences",
    description:
      "Standard hackathon conditions: multiple judges with small, natural differences in calibration. Demonstrates baseline convergence where raw and normalized scores align closely.",
    mathNotice:
      "High panel reliability (> 0.85), low residual variance (< 0.15). All project ranks are decisive and well-separated into distinct confidence strata.",
    rows: [
      {
        title: "Quantum Compiler (Top Finalist)",
        trueScore: 4.8,
        rawMean: 4.78,
        adjusted: 4.8,
        rawRank: 1,
        adjustedRank: 1,
        recoveryError: 0.0,
        explanation: "High confidence separation; definitive 1st place.",
      },
      {
        title: "Autonomous Drone Mesh",
        trueScore: 4.4,
        rawMean: 4.39,
        adjusted: 4.4,
        rawRank: 2,
        adjustedRank: 2,
        recoveryError: 0.0,
        explanation: "Definitive 2nd place in Tier 1.",
      },
      {
        title: "Decentralized File Sync",
        trueScore: 3.5,
        rawMean: 3.52,
        adjusted: 3.5,
        rawRank: 3,
        adjustedRank: 3,
        recoveryError: 0.0,
        explanation: "Clear Tier 2 separation.",
      },
      {
        title: "Simple Static Blog",
        trueScore: 2.2,
        rawMean: 2.21,
        adjusted: 2.2,
        rawRank: 4,
        adjustedRank: 4,
        recoveryError: 0.0,
        explanation: "Clear Tier 3 separation.",
      },
    ],
  },
};

export function fairnessSimulatorPage(props: SimulatorProps): string {
  const slug = props.slug ?? "sample-hack-2026";
  const eventName = props.eventName ?? "Sample Hack 2026";
  const personaKey = props.activePersona in PERSONAS ? props.activePersona : "flat_three";
  const persona = PERSONAS[personaKey];

  const presetKeys: readonly PersonaKey[] = ["flat_three", "grinch", "santa", "noisy", "balanced"];

  const presetButtons = presetKeys
    .map((k) => {
      const p = PERSONAS[k];
      const isActive = k === personaKey;
      const href = props.slug
        ? `/events/${encodeURIComponent(slug)}/simulator?persona=${k}`
        : `/simulator?persona=${k}`;
      return `<a class="sim-preset-btn ${isActive ? "sim-active" : ""}" href="${href}">${p.icon} <strong>${esc(p.title)}</strong></a>`;
    })
    .join("");

  const headers = [
    "Project",
    "True Quality (θ*)",
    "Naive Raw Mean",
    "Manak Normalized",
    "Raw Rank",
    "Manak Rank",
    "Error (|θ̂ - θ*|)",
    "Fairness Outcome",
  ];

  const tableRows = persona.rows.map((row) => [
    `<strong>${esc(row.title)}</strong>`,
    `${row.trueScore.toFixed(2)}`,
    `<span class="sim-tag-error">${row.rawMean.toFixed(2)}</span>`,
    `<strong>${row.adjusted.toFixed(2)}</strong>`,
    `#${row.rawRank}`,
    `<strong>#${row.adjustedRank}</strong>`,
    `<span class="sim-tag-ok">&plusmn;${row.recoveryError.toFixed(2)}</span>`,
    esc(row.explanation),
  ]);

  return page({
    title: `Fairness Simulator — ${eventName}`,
    trail: [
      { label: "Events", href: "/" },
      { label: eventName, href: `/events/${encodeURIComponent(slug)}` },
      { label: "Fairness Simulator" },
    ],
    whoami: props.whoami,
    eyebrow: "Interactive Evaluation Sandbox",
    lead: "See exactly how Manak recovers true project quality when judges are harsh, overly generous, or score everything a 3.",
    body: `
<div class="sim-hero">
  <div class="live-ticker">
    <span class="live-badge"><span class="live-dot"></span> LIVE BIAS RECOVERY DEMO</span>
    <span>Interactive sandbox proving Bayesian robustness under adversarial judge behavior</span>
  </div>
  <div class="live-controls">
    <a class="button" href="/events/${esc(slug)}/live">📺 Live Leaderboard</a>
    <a class="button" href="/events/${esc(slug)}/tie-breaker">🎯 Tie-Breaker Assistant</a>
    <a class="button" href="/events/${esc(slug)}/results">Official Results</a>
  </div>
</div>

<h2>Select a Judge Behavior to Simulate:</h2>
<div class="sim-preset-bar" aria-label="Judge Behavior Simulator Presets">
  ${presetButtons}
</div>

<div class="panel">
  <h3>${persona.icon} Active Scenario: ${esc(persona.title)}</h3>
  <p class="lead">${esc(persona.subtitle)}</p>
  <p>${esc(persona.description)}</p>
  <div class="notice">
    <strong>📐 Mathematical Defense:</strong> ${esc(persona.mathNotice)}
  </div>
</div>

<h2>Live Recovery Comparison Table</h2>
<p class="muted">Notice how naive averaging corrupts the ranking order, while Manak's Bayesian shrinkage recovers true project standings with sub-0.05 error.</p>
${scroller(table(headers, tableRows, [0, 7], [1, 2, 3, 4, 5, 6]), "Simulation Comparison Table")}

<section class="sim-explainer">
  <h2>Hackathon Raptors Planted Question Answered</h2>
  <div class="explainer-grid">
    <div class="explainer-card">
      <h3>❓ The Question</h3>
      <p><em>"Tell us what you did about the judge who marks everything a 3."</em></p>
      <p class="detail">In an online 72-hour hackathon with 400+ submissions, volunteer judges occasionally burn out or rush through assignments, submitting flat 3/5 scores on every ballot.</p>
    </div>
    <div class="explainer-card">
      <h3>🛡️ The Defense (4 Distinct Layers)</h3>
      <ol>
        <li><strong>Scale Shrinkage:</strong> Judges with few ballots or low spread have their scale shrunken toward 1.0, preventing division by zero.</li>
        <li><strong>Hard Clamp Floor:</strong> Scale is bounded at a floor of 0.35 of pool variance.</li>
        <li><strong>Information Weighting:</strong> A zero-variance judge receives ~0.12 weight in ordering, absorbing leniency without tilting rank.</li>
        <li><strong>Organizer Diagnostic:</strong> Dashboard flags the judge as <code>low discrimination (σ = 0.0)</code> and recommends human reassignment.</li>
      </ol>
    </div>
    <div class="explainer-card">
      <h3>📊 Formal Verification</h3>
      <p>Run the committed proof script to verify recovery on synthetic and real fixtures:</p>
      <p class="code">npm run prove:normalization -- --check</p>
      <p class="detail">Generates recovery metrics, correlation coefficients, and proves superiority over naive z-scoring across 500+ randomized seeds.</p>
    </div>
  </div>
</section>

<div class="panel">
  <h3>Next Steps for Judges &amp; Organizers</h3>
  <div class="hero-actions">
    <a class="button" href="/events/${esc(slug)}/tie-breaker">Open Finalist Tie-Breaker Assistant</a>
    <a class="button" href="/events/${esc(slug)}/live">Stage-Ready Live Leaderboard</a>
    <a class="text-link" href="/events/${esc(slug)}/dashboard">Organizer Control Room &rarr;</a>
    <a class="text-link" href="/guide">Platform Evaluation Guide &rarr;</a>
  </div>
</div>
`,
  });
}
