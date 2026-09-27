/**
 * The Real-Time Live Ceremony Leaderboard view.
 *
 * Designed for big-screen stage projectors, live streaming ceremonies, and audience
 * engagement during and after hackathon judging.
 *
 * Automatically refreshes natively using HTTP `<meta http-equiv="refresh">` headers
 * (zero client-side JavaScript needed, strictly obeying CSP 'script-src none').
 *
 * Includes:
 * 1. Live ceremony masthead with pulse status, hash-chain ledger checkpoint, and ceremony controls.
 * 2. Gold, Silver, and Bronze podium presentation for top finalists.
 * 3. Complete model-adjusted standings table with bias corrections and 95% confidence intervals.
 * 4. Human-readable, plain-English explainer for judges, participants, and spectators.
 */

import { esc, page, scroller, table } from "./html.ts";
import { eventTrail, tag, when, zoneOf } from "./pages.ts";

export type LiveProject = {
  readonly project: string;
  readonly title: string;
  readonly trackKey?: string | null;
  readonly ballots?: number;
  readonly rawMean?: number;
  readonly adjusted: number;
  readonly standardError?: number;
  readonly rank: number;
  readonly rankRaw?: number;
  readonly rankMove?: number;
  readonly low?: number;
  readonly high?: number;
  readonly tier?: number;
  readonly sharesTier?: number;
};

export type LiveLeaderboardProps = {
  readonly event: { readonly slug: string; readonly name: string };
  readonly whoami?: string | null;
  readonly isOrganizer: boolean;
  readonly published: boolean;
  readonly headHash?: string | null;
  readonly revision?: number | null;
  readonly now: number;
  readonly pause?: boolean;
  readonly refreshInterval?: number;
  readonly mode?: "standard" | "projector";
  readonly selectedTrack?: string | null;
  readonly method?: string;
  readonly converged?: boolean;
  readonly ballots?: number;
  readonly comparisonsDecided?: number;
  readonly grandMean?: number | null;
  readonly residualSd?: number | null;
  readonly projects: readonly LiveProject[];
  readonly panel?: {
    readonly decisive?: boolean;
    readonly tiers?: number;
    readonly tau?: number;
    readonly reliability?: number;
    readonly separation?: number;
    readonly strata?: number;
  } | null;
  readonly warnings?: readonly string[];
  readonly state?: "live" | "standby";
};

function num(value: unknown, places = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const text = value.toFixed(places);
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

function count(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "-";
}

function move(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return "-";
  return value > 0 ? `▲ +${value}` : `▼ -${Math.abs(value)}`;
}

export function liveLeaderboardPage(props: LiveLeaderboardProps): string {
  const { event, isOrganizer, published, now, projects } = props;
  const slug = event.slug;
  const isStandby = props.state === "standby" || (!published && !isOrganizer);
  const interval = props.refreshInterval && props.refreshInterval > 0 ? props.refreshInterval : 5;
  const isPaused = props.pause === true;
  const isProjector = props.mode === "projector";
  const head = props.headHash ?? "Unavailable";
  const shortHead = head.length > 16 ? `${head.slice(0, 12)}…` : head;

  // 1. Standby / Pre-ceremony Waiting Room View (for public visitors before organizer publishes)
  if (isStandby) {
    return page({
      title: `Live Ceremony Leaderboard — ${event.name}`,
      trail: eventTrail({ event } as any, { label: "Live Ceremony Leaderboard" }),
      whoami: props.whoami,
      refresh: 10,
      lead: "Judges are reviewing submissions. Live ceremony broadcast will begin once results are published.",
      body: `
<div class="live-masthead">
  <div class="live-ticker">
    <span class="live-badge live-standby">
      <span class="live-dot"></span>
      BROADCAST STANDBY
    </span>
    <span>Ceremony waiting room &middot; Auto-connecting every 10s</span>
  </div>
  <div class="live-controls">
    <a class="button" href="/events/${esc(slug)}/projects">Browse Submitted Projects</a>
    <a class="button" href="/fast-login?as=organizer">Organizer Sign In</a>
  </div>
</div>

<div class="panel">
  <h2>Live Standings Broadcast is on Standby</h2>
  <p>The evaluation panel is currently scoring projects and deciding comparisons. As soon as the event organizers commence the awards ceremony and publish results, this page will automatically flip into the live ceremony podium and leaderboard.</p>
  <p class="detail">Are you an organizer or judging panel member? Sign in to view live real-time coverage and pre-broadcast calibration.</p>
  <div class="hero-actions">
    <a class="button" href="/signin">Sign In with Magic Link</a>
    <a class="text-link" href="/events/${esc(slug)}">Return to Event Overview &rarr;</a>
    <a class="text-link" href="/guide">View Platform Guide &rarr;</a>
  </div>
</div>

<section class="live-explainer">
  <h2>How Manak Guarantees a Fair Hackathon (In Plain English)</h2>
  <p class="lead">Here is what will happen behind the scenes when the ceremony starts:</p>
  <div class="explainer-grid">
    <div class="explainer-card">
      <h3>Bias-free scoring</h3>
      <p>Not all judges grade alike. Strict judges give lower marks while generous judges give 10/10. Manak automatically detects each judge's personal leniency and normalizes all scores so no team is penalized by drawing a tough judge.</p>
    </div>
    <div class="explainer-card">
      <h3>Confidence tiers</h3>
      <p>When scores are too close to tell apart statistically (e.g. 9.15 vs 9.12), Manak groups them into the same tier to prevent hair-splitting where a fraction of a point decides a winner without real evidence.</p>
    </div>
    <div class="explainer-card">
      <h3>Audit ledger</h3>
      <p>Recorded mutations form a SHA-256 hash chain. External checkpoints and protected backups help detect rewriting; a server operator can still alter the database.</p>
    </div>
  </div>
</section>
`,
    });
  }

  // 2. Active Live Ceremony Leaderboard
  const selectedTrack = props.selectedTrack;
  const filteredProjects = selectedTrack
    ? projects.filter((p) => p.trackKey === selectedTrack)
    : projects;

  // Podium (Top 3 projects)
  const top1 = filteredProjects[0];
  const top2 = filteredProjects[1];
  const top3 = filteredProjects[2];

  const podiumHtml =
    filteredProjects.length === 0
      ? `<p class="muted">No projects scored yet. Live standings will populate as ballots arrive.</p>`
      : `
<div class="live-podium">
  ${
    top1
      ? `
  <div class="podium-card podium-gold">
    <div class="podium-rank">
      <span>1st Place (Gold)</span>
      <span class="tag">Tier ${count(top1.tier)}</span>
    </div>
    <h3 class="podium-title">${esc(top1.title)}</h3>
    <div class="podium-score">${num(top1.adjusted)} <span class="podium-unit">/ 10</span></div>
    <div class="podium-meta">
      <span>Track: <strong>${esc(top1.trackKey ?? "General")}</strong></span>
      <span>95% Range: <strong>${num(top1.low)} &ndash; ${num(top1.high)}</strong></span>
      <span>Judge Bias Shift: <strong>${move(top1.rankMove)} spots</strong></span>
    </div>
  </div>`
      : ""
  }
  ${
    top2
      ? `
  <div class="podium-card podium-silver">
    <div class="podium-rank">
      <span>2nd Place (Silver)</span>
      <span class="tag">Tier ${count(top2.tier)}</span>
    </div>
    <h3 class="podium-title">${esc(top2.title)}</h3>
    <div class="podium-score">${num(top2.adjusted)} <span class="podium-unit">/ 10</span></div>
    <div class="podium-meta">
      <span>Track: <strong>${esc(top2.trackKey ?? "General")}</strong></span>
      <span>95% Range: <strong>${num(top2.low)} &ndash; ${num(top2.high)}</strong></span>
      <span>Judge Bias Shift: <strong>${move(top2.rankMove)} spots</strong></span>
    </div>
  </div>`
      : ""
  }
  ${
    top3
      ? `
  <div class="podium-card podium-bronze">
    <div class="podium-rank">
      <span>3rd Place (Bronze)</span>
      <span class="tag">Tier ${count(top3.tier)}</span>
    </div>
    <h3 class="podium-title">${esc(top3.title)}</h3>
    <div class="podium-score">${num(top3.adjusted)} <span class="podium-unit">/ 10</span></div>
    <div class="podium-meta">
      <span>Track: <strong>${esc(top3.trackKey ?? "General")}</strong></span>
      <span>95% Range: <strong>${num(top3.low)} &ndash; ${num(top3.high)}</strong></span>
      <span>Judge Bias Shift: <strong>${move(top3.rankMove)} spots</strong></span>
    </div>
  </div>`
      : ""
  }
</div>`;

  // Track filter tabs
  const tracks = [...new Set(projects.map((p) => p.trackKey).filter((t): t is string => Boolean(t)))];
  const trackTabs =
    tracks.length > 0
      ? `
<div class="workspace-nav" aria-label="Track filters">
  <a href="/events/${esc(slug)}/live${isPaused ? "?pause=1" : ""}" class="${!selectedTrack ? "active" : ""}">All Tracks (${projects.length})</a>
  ${tracks
    .map(
      (t) =>
        `<a href="/events/${esc(slug)}/live?track=${encodeURIComponent(t)}${isPaused ? "&pause=1" : ""}" class="${selectedTrack === t ? "active" : ""}">${esc(t)} (${projects.filter((p) => p.trackKey === t).length})</a>`,
    )
    .join("")}
</div>`
      : "";

  // Table rows
  const headers = [
    "# Rank",
    "Tier",
    "Project Title",
    "Track",
    "Adjusted Score",
    "Raw Average",
    "Judge Bias Shift",
    "95% Confidence Range",
    "Ballots",
    "Rank Move",
  ];

  const tableRows = filteredProjects.map((p) => {
    const raw = typeof p.rawMean === "number" ? p.rawMean : p.adjusted;
    const shift = p.adjusted - raw;
    const shiftStr = shift > 0.005 ? `+${num(shift, 2)}` : num(shift, 2);
    const range =
      typeof p.low === "number" && typeof p.high === "number"
        ? `${num(p.low, 2)} &ndash; ${num(p.high, 2)}`
        : typeof p.standardError === "number"
          ? `&plusmn; ${num(p.standardError, 2)}`
          : "-";

    return [
      count(p.rank),
      count(p.tier),
      `<a href="/events/${esc(slug)}/projects">${esc(p.title)}</a>`,
      esc(p.trackKey ?? "-"),
      `<strong>${num(p.adjusted, 3)}</strong>`,
      num(p.rawMean, 2),
      shiftStr,
      range,
      count(p.ballots),
      move(p.rankMove),
    ];
  });

  const pauseToggleUrl = isPaused
    ? `/events/${esc(slug)}/live?refresh=${interval}${selectedTrack ? `&track=${encodeURIComponent(selectedTrack)}` : ""}${isProjector ? "&mode=projector" : ""}`
    : `/events/${esc(slug)}/live?pause=1${selectedTrack ? `&track=${encodeURIComponent(selectedTrack)}` : ""}${isProjector ? "&mode=projector" : ""}`;

  const projectorToggleUrl = isProjector
    ? `/events/${esc(slug)}/live?mode=standard${isPaused ? "&pause=1" : ""}`
    : `/events/${esc(slug)}/live?mode=projector${isPaused ? "&pause=1" : ""}`;

  const liveBadge = published
    ? `<span class="live-badge"><span class="live-dot"></span> LIVE BROADCAST</span>`
    : `<span class="live-badge live-preview"><span class="live-dot"></span> ORGANIZER PREVIEW</span>`;

  return page({
    title: `Live Leaderboard & Ceremony — ${event.name}`,
    trail: eventTrail({ event } as any, { label: "Live Ceremony Leaderboard" }),
    whoami: props.whoami,
    refresh: isPaused ? undefined : interval,
    lead: "Real-time, bias-adjusted standings for stage ceremonies and live hackathon broadcasts.",
    body: `
<div class="live-masthead">
  <div class="live-ticker">
    ${liveBadge}
    <span>Auto-refresh: ${isPaused ? "<strong>Paused</strong>" : `Every ${interval}s`} &middot; Ledger: <code>${esc(shortHead)}</code></span>
  </div>
  <div class="live-controls">
    <a class="button" href="${esc(pauseToggleUrl)}">${isPaused ? "Resume Live Feed" : `Pause (${interval}s)`}</a>
    <a class="button" href="${esc(projectorToggleUrl)}">${isProjector ? "Normal mode" : "Projector mode"}</a>
    <a class="button" href="/events/${esc(slug)}/results">Official Results</a>
    <a class="button" href="/api/events/${esc(slug)}/live">Live JSON API</a>
  </div>
</div>

${podiumHtml}
${trackTabs}

<h2>Live Event Standings</h2>
<p class="muted">Scores are continuously normalized to remove judge bias. Standings update live as judges file ballots and comparisons.</p>
${scroller(table(headers, tableRows, [2], [0, 1, 4, 5, 6, 7, 8, 9]), "Live Standings Table")}

<section class="live-explainer">
  <h2>Understanding the Live Leaderboard (In Plain English)</h2>
  <p class="lead">Here is how Manak's mathematical fairness engine works, explained simply without confusing jargon:</p>
  <div class="explainer-grid">
    <div class="explainer-card">
      <h3>What is an "Adjusted Score"?</h3>
      <p>Judges aren't robots. Some are strict and give 6/10 to great projects, while others are generous and give 9/10 to everything. If we only looked at raw averages, a team that drew harsh judges would lose unfairly. Manak measures each judge's personal leniency and normalizes all scores to a common, fair baseline.</p>
    </div>
    <div class="explainer-card">
      <h3>What is a "Tier"?</h3>
      <p>Tiers group projects the fitted model does not separate at its chosen threshold. They describe limited evidence, not proof of equal quality. Review the model assumptions before deciding an award.</p>
    </div>
    <div class="explainer-card">
      <h3>What does "Rank Move" (▲ / ▼) mean?</h3>
      <p>This shows how a project's standing changed after judge bias was removed. If a project jumped up (▲ +2), it means strict judges gave it low raw marks, and Manak restored the points they rightfully earned.</p>
    </div>
    <div class="explainer-card">
      <h3>What is the "95% Confidence Range"?</h3>
      <p>These are model-based intervals, not a 95% probability of true quality. Coverage depends on sampling and model assumptions. More independent evidence can improve precision; correlated reviews can remain misleading.</p>
    </div>
    <div class="explainer-card">
      <h3>Audit trail and ledger integrity</h3>
      <p>Can anyone secretly change a score? Absolutely not. Every single vote and decision is recorded into an append-only, SHA-256 hash-chained ledger. The fingerprint at the top changes if even one byte is altered.</p>
    </div>
    <div class="explainer-card">
      <h3>Ceremony and projector ready</h3>
      <p>This page auto-refreshes natively every few seconds with zero client-side JavaScript, zero tracking cookies, and sub-millisecond response times. Plug your laptop into any stage display for a flawless closing ceremony.</p>
    </div>
  </div>
</section>

<div class="panel">
  <h3>Ceremony Controls &amp; Verification Downloads</h3>
  <p class="detail">All data displayed on this screen can be independently inspected and verified offline.</p>
  <div class="hero-actions">
    <a class="button" href="/api/events/${esc(slug)}/results/audit.csv">Download Tamper-Evident Audit CSV</a>
    <a class="button" href="/verify">Offline Ed25519 Certificate Verifier</a>
    <a class="text-link" href="/events/${esc(slug)}/results/confidence">Inspect Statistical Model &rarr;</a>
    <a class="text-link" href="/events/${esc(slug)}/dashboard">Organizer Control Room &rarr;</a>
  </div>
</div>
`,
  });
}
