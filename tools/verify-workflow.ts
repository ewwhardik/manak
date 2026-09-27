import assert from "node:assert/strict";
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { makeRegistry } from "../src/api/registry.ts";
import type { Delivery } from "../src/api/index.ts";
import { makeApp } from "../src/http/app.ts";
import { VIEWS } from "../src/view/views.ts";
import { world } from "../tests/support/world.ts";

const REGISTRY = makeRegistry(ALL_COMMANDS);
const ORIGIN = "https://portal.test";

async function runVerification() {
  console.log("=== Starting Complete API Workflow Verification ===");
  const w = world({ judges: 0, projects: 0 }); // clean slate
  const sent: Delivery[] = [];
  const logs: any[] = [];
  const founderEmail = "founder@portal.test";

  const serve = makeApp({
    db: w.db,
    registry: REGISTRY,
    publicOrigin: ORIGIN,
    views: VIEWS,
    clock: w.clock,
    deliver: (message) => sent.push(message),
    log: (record) => logs.push(record),
    report: (err) => console.error("Reported error:", err),
    secure: true,
    founders: [founderEmail],
  });

  async function api(path: string, options: { method?: string; body?: any; token?: string; cookie?: string } = {}) {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (options.token) headers["authorization"] = `Bearer ${options.token}`;
    if (options.cookie) headers["cookie"] = options.cookie;
    let bodyStr: string | undefined = undefined;
    if (options.body) {
      headers["content-type"] = "application/json";
      bodyStr = JSON.stringify(options.body);
    }
    const req = new Request(`${ORIGIN}${path}`, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers,
      body: bodyStr,
    });
    const res = await serve(req, "127.0.0.1");
    let json: any = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, headers: res.headers, body: json };
  }

  // 1. Health & Discovery API
  console.log("1. Checking System APIs...");
  const healthRes = await api("/api/healthz");
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.body.status, "ok");

  const openapiRes = await api("/api/openapi.json");
  assert.equal(openapiRes.status, 200);
  assert.ok(openapiRes.body.openapi);

  // 2. Auth Flow for Founder
  console.log("2. Testing Auth Flow for Founder...");
  const signinReq = await api("/api/signin", { body: { email: founderEmail } });
  assert.equal(signinReq.status, 200);
  const founderDelivery = sent.find((m) => m.to === founderEmail && m.reason === "signin");
  const signinToken = founderDelivery?.link?.split("/signin/")[1];
  assert.ok(signinToken, "Token must be extracted from link");

  const linkRes = await api(`/api/signin/${signinToken}`);
  assert.equal(linkRes.status, 200);

  const sessionRes = await api("/api/session", { body: { token: signinToken } });
  assert.equal(sessionRes.status, 200);
  const founderSession = sessionRes.body.token;
  assert.ok(founderSession);

  const whoamiRes = await api("/api/whoami", { token: founderSession });
  assert.equal(whoamiRes.status, 200);
  assert.equal(whoamiRes.body.account.email, founderEmail);
  assert.equal(whoamiRes.body.founder, true);

  // 3. Create Event
  console.log("3. Creating Event via API...");
  const t0 = w.clock.now();
  const createEventRes = await api("/api/events", {
    token: founderSession,
    body: {
      slug: "hack-math",
      name: "Mathematical Grand Prix",
      timezone: "UTC",
      prizes: "Grand Prize: $10,000",
      questions: "What is your secret weapon?",
      submissionsOpenAt: t0 - 10_000,
      submissionsCloseAt: t0 + 3600_000,
      judgingOpenAt: t0 + 3600_000,
      judgingCloseAt: t0 + 7200_000,
      pairwiseEnabled: true,
      votingMode: "open",
      votingOpenAt: t0 + 3600_000,
      votingCloseAt: t0 + 7200_000,
      votingCredits: 100,
    },
  });
  assert.equal(createEventRes.status, 200);
  const eventId = createEventRes.body.event.id;
  assert.ok(eventId);

  // 4. Create Track
  console.log("4. Creating Tracks via API...");
  const createTrackRes = await api("/api/events/hack-math/tracks", {
    token: founderSession,
    body: {
      key: "algo",
      label: "Algorithmic Wonders",
    },
  });
  assert.equal(createTrackRes.status, 200);

  // 5. Create and Publish Rubric
  console.log("5. Creating & Publishing Rubric via API...");
  const createRubricRes = await api("/api/events/hack-math/rubric", {
    token: founderSession,
    body: {
      criteria: [
        "math_rigor | Mathematical Rigor | 4 | 1 | 10",
        "novelty | Novelty & Complexity | 3 | 1 | 10",
        "execution | Execution Quality | 3 | 1 | 10",
      ].join("\n"),
    },
  });
  assert.equal(createRubricRes.status, 200);

  const publishRubricRes = await api("/api/events/hack-math/rubric/publish", {
    token: founderSession,
    body: { version: createRubricRes.body.version },
  });
  assert.equal(publishRubricRes.status, 200);

  // 6. Invite Participants & Submit Projects
  console.log("6. Inviting Participants & Submitting Projects...");
  const participantTokens: string[] = [];
  const projectIds: string[] = [];

  for (let i = 1; i <= 4; i++) {
    const pEmail = `coder${i}@example.com`;
    // Organizer invites participant
    const invRes = await api("/api/events/hack-math/invitations", {
      token: founderSession,
      body: {
        email: pEmail,
        role: "participant",
      },
    });
    assert.equal(invRes.status, 200);
    const pTok = invRes.body.link.split("/signin/")[1];

    const sRes = await api("/api/session", { body: { token: pTok } });
    assert.equal(sRes.status, 200);
    const pSession = sRes.body.token;
    participantTokens.push(pSession);

    // Create project
    const projRes = await api("/api/events/hack-math/projects", {
      token: pSession,
      body: {
        title: `Project ${i} - Math Engine`,
        tagline: `Math engine for problem ${i}`,
        summary: `Deep theoretical and practical implementation of system ${i}`,
        trackKey: "algo",
      },
    });
    assert.equal(projRes.status, 200);
    const pid = projRes.body.project.id;
    projectIds.push(pid);

    // Submit project
    const submitRes = await api(`/api/events/hack-math/projects/${pid}/submit`, {
      token: pSession,
      body: {},
    });
    assert.equal(submitRes.status, 200);
  }

  // 7. Advance Phase to Judging & Invite Judges
  console.log("7. Advancing Phase to Judging & Registering Judges...");
  const now = w.clock.now();
  // Open judging and voting window
  const updateEventRes = await api("/api/events/hack-math", {
    token: founderSession,
    body: {
      name: "Mathematical Grand Prix",
      timezone: "UTC",
      submissionsOpenAt: now - 3600_000,
      submissionsCloseAt: now - 60_000, // closed
      judgingOpenAt: now - 30_000, // open now
      judgingCloseAt: now + 3600_000,
      votingMode: "open",
      votingOpenAt: now - 30_000,
      votingCloseAt: now + 3600_000,
      votingCredits: 100,
    },
  });
  assert.equal(updateEventRes.status, 200);

  // Invite 3 judges
  const judgeTokens: string[] = [];
  for (let j = 1; j <= 3; j++) {
    const jEmail = `judge${j}@example.com`;
    const invRes = await api("/api/events/hack-math/invitations", {
      token: founderSession,
      body: {
        email: jEmail,
        role: "judge",
      },
    });
    assert.equal(invRes.status, 200);
    const jTok = invRes.body.link.split("/signin/")[1];

    const sRes = await api("/api/session", { body: { token: jTok } });
    assert.equal(sRes.status, 200);
    judgeTokens.push(sRes.body.token);
  }

  // 8. Draw Assignments
  console.log("8. Drawing Assignments via API...");
  const drawRes = await api("/api/events/hack-math/assignments", {
    token: founderSession,
    body: {},
  });
  assert.equal(drawRes.status, 200);

  // 9. Judges Submit Ballots via API
  console.log("9. Judges Submitting Ballots via API...");
  const profiles = [
    { math_rigor: 9, novelty: 8, execution: 9 }, // Project 1
    { math_rigor: 7, novelty: 6, execution: 8 }, // Project 2
    { math_rigor: 5, novelty: 6, execution: 5 }, // Project 3
    { math_rigor: 4, novelty: 4, execution: 4 }, // Project 4
  ];

  for (let j = 0; j < 3; j++) {
    const jTok = judgeTokens[j];
    const lean = j === 0 ? 1 : j === 1 ? 0 : -1;
    for (let p = 0; p < projectIds.length; p++) {
      const pid = projectIds[p];
      const base = profiles[p];
      assert.ok(base, "Every fixture project needs a score profile");
      const ballotRes = await api(`/api/events/hack-math/projects/${pid}/ballot`, {
        token: jTok,
        body: {
          scores: {
            math_rigor: Math.min(10, Math.max(1, base.math_rigor + lean)),
            novelty: Math.min(10, Math.max(1, base.novelty + lean)),
            execution: Math.min(10, Math.max(1, base.execution + lean)),
          },
          comment: `Judge ${j + 1} thorough mathematical evaluation of Project ${p + 1}`,
          draft: false,
        },
      });
      assert.equal(ballotRes.status, 200);
    }
  }

  // 10. Pairwise Comparison Duels
  console.log("10. Deciding Pairwise Duels via API...");
  for (let j = 0; j < 3; j++) {
    const jTok = judgeTokens[j];
    const duelNext = await api("/api/events/hack-math/duel", { token: jTok });
    assert.equal(duelNext.status, 200);
    if (duelNext.body && duelNext.body.pair) {
      const decideRes = await api("/api/events/hack-math/duel", {
        token: jTok,
        body: {
          left: duelNext.body.pair.left.id,
          right: duelNext.body.pair.right.id,
          verdict: "left",
          reason: duelNext.body.pair.reason,
        },
      });
      assert.equal(decideRes.status, 200);
    }
  }

  // 11. Quadratic Community Voting via API
  console.log("11. Casting Quadratic Votes via API...");
  const voterStart = await api("/api/events/hack-math/votes/start", {
    token: participantTokens[0],
    body: {},
  });
  assert.equal(voterStart.status, 200);
  const voterToken = voterStart.body.token;
  assert.ok(voterToken);

  const castVoteRes1 = await api("/api/events/hack-math/votes", {
    token: participantTokens[0],
    body: {
      token: voterToken,
      project: projectIds[0],
      influence: 4,
    },
  });
  assert.equal(castVoteRes1.status, 200);

  const castVoteRes2 = await api("/api/events/hack-math/votes", {
    token: participantTokens[0],
    body: {
      token: voterToken,
      project: projectIds[1],
      influence: 3,
    },
  });
  assert.equal(castVoteRes2.status, 200);

  const voteTotalsRes = await api("/api/events/hack-math/votes", { token: founderSession });
  assert.equal(voteTotalsRes.status, 200);

  // 12. Check Organizer Dashboard & Engine Outputs
  console.log("12. Inspecting Full Organizer Dashboard & Math Engines via API...");
  const dashboardRes = await api("/api/events/hack-math/dashboard", { token: founderSession });
  assert.equal(dashboardRes.status, 200);
  const d = dashboardRes.body;
  assert.ok(d.rubric, "Rubric normalization fit must be present in dashboard");
  assert.ok(d.effects.length > 0, "Judge effects must be present in dashboard");
  assert.ok(d.reliability, "Reliability engine must be present in dashboard");
  assert.ok(d.calibration, "Calibration engine must be present in dashboard");
  assert.ok(d.decisionSupport.candidates.length > 0, "Finalist triage candidates must be present");
  assert.ok(d.readiness, "Readiness engine must be present in dashboard");
  console.log("✓ Dashboard mathematical engines verified successfully!");

  // 13. Publish Results
  console.log("13. Publishing Results via API...");
  const premature = await api("/api/events/hack-math/results/publish", {
    token: founderSession, body: {},
  });
  assert.equal(premature.status, 409, "Publication must be refused while voting is open");
  const hiddenResults = await api("/api/events/hack-math/results");
  assert.equal(hiddenResults.status, 409);
  assert.equal(hiddenResults.body.code, "results.votingOpen");
  w.clock.set(t0 + 7200_000);
  const pubRes = await api("/api/events/hack-math/results/publish", {
    token: founderSession,
    body: {},
  });
  assert.equal(pubRes.status, 200);

  // 14. Public Results API
  console.log("14. Fetching Public Results (Unauthenticated)...");
  const pubResults = await api("/api/events/hack-math/results");
  assert.equal(pubResults.status, 200);
  assert.ok(pubResults.body.projects.length >= 4);
  assert.ok(pubResults.body.panel.reliability !== undefined);
  console.log(`✓ Top project in published results: "${pubResults.body.projects[0].title}", Adjusted score: ${pubResults.body.projects[0].adjusted}`);

  // 15. Export CSV
  console.log("15. Exporting Results CSV via API...");
  const csvRes = await api("/api/events/hack-math/csv/results", { token: founderSession });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.body, /Project/);

  console.log("\n==================================================================");
  console.log("PASS: 15-stage local API lifecycle, including voting-window refusal and publication after close.");
  console.log("==================================================================");
  w.close();
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
