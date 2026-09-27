/**
 * The evaluation guide and platform sitemap.
 *
 * Explains Manak's evaluation model and provides a direct-jump directory for hackathon
 * judges, organizers, and participants.
 */

import { definitions, esc, page, scroller, table } from "./html.ts";

export type GuideEvent = {
  readonly slug: string;
  readonly name: string;
};

export type GuideProps = {
  readonly whoami?: string | null;
  readonly events?: readonly GuideEvent[];
};

export function guidePage(props: GuideProps): string {
  const events = props.events ?? [];
  const sampleEvent = events.find((e) => e.slug === "sample-hack-2026") ?? events[0] ?? { slug: "sample-hack-2026", name: "Sample Hack 2026" };
  const dogfoodEvent = events.find((e) => e.slug === "dogfood") ?? events[1] ?? { slug: "dogfood", name: "Dogfood" };

  const sitemapRows: readonly (readonly [string, string, string, string])[] = [
    ["/events", "Public", "Browse all active hackathon events on this deployment", '<a href="/events">Explore events</a>'],
    [`/events/${esc(sampleEvent.slug)}`, "All roles", "Event overview, phase timelines, tracks, prizes, and next action", `<a href="/events/${esc(sampleEvent.slug)}">Open ${esc(sampleEvent.name)}</a>`],
    [`/events/${esc(sampleEvent.slug)}/projects`, "All roles", "Browse submitted projects, descriptions, repositories, and demo videos", `<a href="/events/${esc(sampleEvent.slug)}/projects">Project gallery</a>`],
    [`/events/${esc(sampleEvent.slug)}/judging`, "Judges", "Rubric scoring queue with criteria ratings and private draft saves", `<a href="/events/${esc(sampleEvent.slug)}/judging">Judging queue</a>`],
    [`/events/${esc(sampleEvent.slug)}/duel`, "Judges", "Pairwise head-to-head project comparisons with active learning", `<a href="/events/${esc(sampleEvent.slug)}/duel">Pairwise duels</a>`],
    [`/events/${esc(sampleEvent.slug)}/voting`, "Voters", "Community choice quadratic voting distributing credits across projects", `<a href="/events/${esc(sampleEvent.slug)}/voting">Community choice</a>`],
    [`/events/${esc(sampleEvent.slug)}/teams`, "Builders", "Team formation, teammate invitations, and roster management", `<a href="/events/${esc(sampleEvent.slug)}/teams">Team workspace</a>`],
    [`/events/${esc(sampleEvent.slug)}/dashboard`, "Organizers", "Live review coverage, judge calibration, and bottleneck diagnostics", `<a href="/events/${esc(sampleEvent.slug)}/dashboard">Organizer dashboard</a>`],
    [`/events/${esc(sampleEvent.slug)}/rubric`, "Organizers", "Configure evaluation criteria, scale ranges, and relative weights", `<a href="/events/${esc(sampleEvent.slug)}/rubric">Rubric editor</a>`],
    [`/events/${esc(sampleEvent.slug)}/judges`, "Organizers", "Judge roster management and single-use magic invitation links", `<a href="/events/${esc(sampleEvent.slug)}/judges">Judges roster</a>`],
    [`/events/${esc(sampleEvent.slug)}/results`, "Organizers & Public", "Final standings, 95% Bayesian confidence intervals, and certificates", `<a href="/events/${esc(sampleEvent.slug)}/results">Results & certificates</a>`],
    [`/events/${esc(sampleEvent.slug)}/results/confidence`, "Organizers", "In-depth statistical evidence, judge bias, and outlier analysis", `<a href="/events/${esc(sampleEvent.slug)}/results/confidence">Confidence analysis</a>`],
    [`/api/events/${esc(sampleEvent.slug)}/results/audit.csv`, "Organizers & Auditors", "Download immutable hash-chained event ledger as CSV", `<a href="/api/events/${esc(sampleEvent.slug)}/results/audit.csv">Download audit CSV</a>`],
    ["/verify", "Public", "Offline Ed25519 cryptographic certificate verifier using local WebCrypto", '<a href="/verify">Certificate verifier</a>'],
    ["/fast-login", "Testers & Judges", "Instant role session provisioning without email delivery", '<a href="/fast-login?as=judge_sample">Fast login (Judge)</a>'],
    ["/signin", "All users", "Passwordless magic-link authentication via email", '<a href="/signin">Sign in</a>'],
    ["/mine", "Authenticated", "Personal workspace listing all joined events and assigned roles", '<a href="/mine">My workspace</a>'],
    ["/about", "Public", "Architectural claims, 0-dependency design, and 3D motion study", '<a href="/about">About Manak</a>'],
    ["/docs", "Developers", "OpenAPI operation specifications, parameters, and access controls", '<a href="/docs">API documentation</a>'],
    ["/api/openapi.json", "Developers", "Raw OpenAPI 3.1 specification for code generation", '<a href="/api/openapi.json">OpenAPI JSON</a>'],
    ["/api/capabilities", "Auditors", "Live access control matrix verified across all roles and gates", '<a href="/api/capabilities">Access matrix</a>'],
    ["/api/healthz", "Auditors & DevOps", "Deployment health, migration status, and Merkle ledger head hash", '<a href="/api/healthz">Health check</a>'],
  ];

  return page({
    title: "Platform Guide & Evaluation Sitemap",
    trail: [{ label: "Events", href: "/" }, { label: "Evaluation Guide & Sitemap" }],
    whoami: props.whoami,
    eyebrow: "Operational Guide & Platform Sitemap",
    lead: "A comprehensive reference and direct-jump directory for hackathon judges, organizers, and builders. Understand Manak's evaluation model, access every feature with one click, and explore the complete platform architecture.",
    headingActions: `<div class="hero-actions"><a class="button" href="#sitemap">Explore platform sitemap <span aria-hidden="true">&darr;</span></a><a class="text-link" href="#judges">Judge evaluation hub <span aria-hidden="true">&rarr;</span></a><a class="text-link" href="#organizers">Organizer control room <span aria-hidden="true">&rarr;</span></a></div>`,
    body: `<nav class="workspace-nav" aria-label="Guide sections"><a href="#judges">Judges' Hub</a><a href="#organizers">Organizers' Control Room</a><a href="#builders">Builders' Workspace</a><a href="#verification">Cryptographic Trust &amp; Certificates</a><a href="#sitemap">Complete Platform Sitemap</a></nav>

<section class="guide-hub" id="judges">
<div class="section-heading">
<div>
<p class="eyebrow">Evaluation Workflow</p>
<h2>Judges' Evaluation Hub</h2>
</div>
<span class="tag">Dual-Mode Judging</span>
</div>
<p>Manak removes evaluation friction. Reviewers need no passwords or registration forms: sign in via magic link or use <b>Fast login</b> in the top navigation bar to assume an invited judge persona instantly.</p>

<div class="guide-grid">
<div class="guide-card">
<span class="role-badge">Mode 1</span>
<h3>Pairwise Head-to-Head Duels</h3>
<p>Compare two randomized projects side-by-side. Rather than guessing numerical scores on an arbitrary scale, judges simply pick the stronger project or declare a tie. Active learning selects comparisons that resolve ambiguous placements.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/duel">Sample Hack: Start Duels ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/duel">Dogfood: Start Duels ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Mode 2</span>
<h3>Rubric Scoring Queue</h3>
<p>Score assigned projects criterion-by-criterion across defined scales (e.g. Technical Execution, Innovation, Polish). Evaluators can save private drafts safely before final submission.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/judging">Sample Hack: Scoring Queue ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/judging">Dogfood: Scoring Queue ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Discovery</span>
<h3>Project Gallery &amp; Showcase</h3>
<p>Browse all submissions across tracks, inspect repository links, architecture summaries, and embedded demonstration videos.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/projects">Sample Hack: Gallery ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/projects">Dogfood: Gallery ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Community</span>
<h3>Community Choice Voting</h3>
<p>Cast quadratic voting tokens for projects during public voting periods. Token weighting prevents ballot stuffing and measures genuine community enthusiasm.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/voting">Sample Hack: Cast Votes ↗</a>
</div>
</div>
</div>

<div class="briefing">
<h2>Judge-effect normalization: Why scores are fair</h2>
<ul>
<li><b>Leniency &amp; severity correction:</b> Judges naturally calibrate differently. Manak's Bayesian Bradley-Terry and shrinkage models estimate each reviewer's bias parameter and adjust project scores accordingly.</li>
<li><b>No reviewer luck:</b> A team assigned to a harsh panel is mathematically compensated, while a team assigned to an easy panel receives no unearned advantage.</li>
<li><b>Anonymized public presentation:</b> Public results pages name no individual judges or private ballots, preserving reviewer independence and candor.</li>
</ul>
</div>
</section>

<section class="guide-hub" id="organizers">
<div class="section-heading">
<div>
<p class="eyebrow">Event Operations</p>
<h2>Organizers' Control Room</h2>
</div>
<span class="tag">Auditable Operations</span>
</div>
<p>Organizers have access to a real-time command center, live review coverage heatmaps, rubric configuration, and cryptographically signed results publication.</p>

<div class="guide-grid">
<div class="guide-card">
<span class="role-badge">Real-Time Operations</span>
<h3>Organizer Dashboard</h3>
<p>Monitor live review coverage, projects needing additional reviews, panel overlap, and judge participation rates. Visual warnings flag information bottlenecks before judging closes.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/dashboard">Sample Hack: Dashboard ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/dashboard">Dogfood: Dashboard ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Scoring Calibration</span>
<h3>Rubric Management</h3>
<p>Define evaluation criteria, descriptions, minimum/maximum scale values, and relative weights. Changes are audited and versioned in the immutable ledger.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/rubric">Sample Hack: Rubric Editor ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/rubric">Dogfood: Rubric Editor ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Reviewer Roster</span>
<h3>Judges &amp; Invitations</h3>
<p>Invite reviewers via single-use magic links without requiring password setup. Track invitation acceptance and active session timestamps.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/judges">Sample Hack: Judges Roster ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/judges">Dogfood: Judges Roster ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Certification</span>
<h3>Results &amp; Ed25519 Certificates</h3>
<p>Preview Bayesian normalized standings, 95% confidence intervals, and tiered rankings. Publish results and generate tamper-proof offline-verifiable digital certificates.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/results">Sample Hack: Results ↗</a>
<a href="/events/${esc(dogfoodEvent.slug)}/results">Dogfood: Results ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Deep Analytics</span>
<h3>Confidence &amp; Evidence Diagnostics</h3>
<p>Inspect residual variance, reviewer leverage, and numerical stability diagnostics to identify and resolve outlier judgements.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/results/confidence">Confidence Analysis ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Audit Chain</span>
<h3>Tamper-Evident CSV Ledger</h3>
<p>Export the full cryptographic audit ledger as CSV. Every vote, score, draft, and configuration change forms an append-only SHA-256 Merkle chain.</p>
<div class="guide-actions">
<a href="/api/events/${esc(sampleEvent.slug)}/results/audit.csv">Download Audit CSV ↗</a>
</div>
</div>
</div>
</section>

<section class="guide-hub" id="builders">
<div class="section-heading">
<div>
<p class="eyebrow">Participant Experience</p>
<h2>Builders' Workspace</h2>
</div>
<span class="tag">Zero Friction</span>
</div>
<p>Builders register, form teams, and submit project details before the deadline. Submissions support markdown narratives, architecture diagrams, demo video embeds, and source repository links.</p>

<div class="guide-grid">
<div class="guide-card">
<span class="role-badge">Collaboration</span>
<h3>Team Formation &amp; Roster</h3>
<p>Create a team, invite collaborators by email or direct link, and manage member permissions.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/teams">Sample Hack: Team Workspace ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Submission</span>
<h3>Project Drafts &amp; Publishing</h3>
<p>Draft project title, tagline, problem statement, demo video, and code repository. Edits remain continuously available until the submission deadline passes.</p>
<div class="guide-actions">
<a href="/events/${esc(sampleEvent.slug)}/projects">Sample Hack: Project Gallery ↗</a>
</div>
</div>
</div>
</section>

<section class="guide-hub" id="verification">
<div class="section-heading">
<div>
<p class="eyebrow">Cryptographic Integrity</p>
<h2>Trust, Verification &amp; Ed25519 Certificates</h2>
</div>
<span class="tag">Offline Verifiable</span>
</div>
<p>Every certificate issued by Manak is cryptographically signed using the organizer's Ed25519 private key. Anyone can verify the validity of an award offline without querying or trusting the server.</p>

<div class="guide-grid">
<div class="guide-card">
<span class="role-badge">Verification Tool</span>
<h3>Offline Certificate Verifier</h3>
<p>Paste the organizer's public key and certificate JSON to verify signatures locally using the browser's built-in WebCrypto API.</p>
<div class="guide-actions">
<a href="/verify">Open Offline Verifier ↗</a>
<a href="/.well-known/manak-key.pub">Download Server Public Key ↗</a>
</div>
</div>

<div class="guide-card">
<span class="role-badge">Audit Ledger</span>
<h3>Hash-Chained Audit Ledger</h3>
<p>All database mutations append to an immutable hash chain. The current ledger length and SHA-256 head hash are published live on every health probe.</p>
<div class="guide-actions">
<a href="/api/healthz">Inspect Ledger Head Hash ↗</a>
</div>
</div>
</div>
</section>

<section class="guide-hub" id="sitemap">
<div class="section-heading">
<div>
<p class="eyebrow">Platform Directory</p>
<h2>Complete Platform Sitemap</h2>
</div>
<span class="count-label">${sitemapRows.length} routes</span>
</div>
<p>The exhaustive catalog of every public, evaluation, administrative, and developer route available on this deployment:</p>
<div class="sitemap-table">
${scroller(table(
  ["Route path", "Access role", "Purpose & capabilities", "Direct action"],
  sitemapRows.map((r) => [r[0], r[1], r[2], r[3]]),
  [3],
), "Complete platform sitemap directory")}
</div>
</section>`,
  });
}
