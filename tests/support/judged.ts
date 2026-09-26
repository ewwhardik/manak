/**
 * An event that has been judged, served over HTTP.
 *
 * `world()` builds an event mid-judging with nobody having filed anything, which is the
 * right starting point for the tests about gates and refusals and the wrong one for the
 * tests about output: an engine with no ballots has no leniency to report, no variance to
 * decompose and no tiers to separate, so a suite that asserted against it would pass while
 * checking nothing. This adds the ballots, the duels and the publication, and hands back a
 * `serve` with tokens for each of the four audiences.
 *
 * Two suites read it — the schema sweep and the publication boundary — which is why it
 * lives here rather than in either of them. Everything is written through the real
 * repositories, so the fixture cannot be in a state the product could not reach.
 *
 * `judged({ rubric: false })` is the other event this product has to answer for: no rubric
 * published, no ballots filed, and a ranking that exists anyway because the panel ran duels.
 * It is an option here rather than a second fixture because the only difference is whether
 * the ballot loop runs, and two fixtures that drift apart would make the comparison between
 * the two branches worthless.
 */

import { createSession, gatesFor, grantRole, upsertAccount } from "../../src/db/index.ts";
import { recordComparison, saveBallot } from "../../src/db/repo/judging.ts";
import { ALL_COMMANDS } from "../../src/api/commands/index.ts";
import { publish } from "../../src/api/commands/results.ts";
import { makeRegistry } from "../../src/api/registry.ts";
import type { Command, Invocation } from "../../src/api/registry.ts";
import { makeApp } from "../../src/http/app.ts";
import type { Serve } from "../../src/http/app.ts";
import { VIEWS } from "../../src/view/views.ts";
import { world } from "./world.ts";
import type { World } from "./world.ts";

const REGISTRY = makeRegistry(ALL_COMMANDS);
export const ORIGIN = "https://portal.test";

export type Principal = { label: string; token?: string };

export type Judged = {
  world: World;
  serve: Serve;
  /** Anonymous, participant, judge, organizer — in that order, weakest first. */
  principals: Principal[];
  /** Path-parameter values, so a route can be filled without knowing the fixture. */
  fill: Record<string, string>;
  get: (path: string, principal?: Principal, wants?: "json" | "html") => Promise<Response>;
  json: (path: string, principal?: Principal) => Promise<Record<string, unknown>>;
  html: (path: string, principal?: Principal) => Promise<string>;
  /** Roster ids: the strings that must not appear in anything a stranger can read. */
  secrets: string[];
  close: () => void;
};

/** The per-project score profile, before each judge's own lean is applied. */
const PROFILE = [
  { impact: 5, craft: 5, novelty: 9 },
  { impact: 3, craft: 4, novelty: 5 },
  { impact: 2, craft: 2, novelty: 3 },
  { impact: 4, craft: 3, novelty: 7 },
];

export type JudgedOptions = {
  /** Publish a rubric and file ballots against it. `false` leaves the event pairwise-only. */
  rubric?: boolean;
};

export function judged(options: JudgedOptions = {}): Judged {
  const withRubric = options.rubric ?? true;
  const w = world({ judges: 3, projects: 4, ...(withRubric ? {} : { publishRubric: false }) });

  // Judge 0 scores straight, judge 1 marks everything down, judge 2 marks everything up
  // and skips a project. That is what makes the fit have something to say: a leniency to
  // subtract, an uneven ballot count to shrink against, and a panel spread to decompose.
  for (const [j, judge] of withRubric ? w.judges.entries() : []) {
    for (const [p, project] of w.projects.entries()) {
      if (j === 2 && p === 3) continue;
      const base = PROFILE[p] as { impact: number; craft: number; novelty: number };
      const lean = j === 0 ? 0 : j === 1 ? -1 : 1;
      saveBallot(w.asJudge(j), w.event, {
        judgeId: judge.id,
        projectId: project.id,
        scores: {
          impact: Math.min(5, Math.max(1, base.impact + lean)),
          craft: Math.min(5, Math.max(1, base.craft + lean)),
          novelty: Math.min(10, Math.max(0, base.novelty + lean * 2)),
        },
        comment: `Judge ${j} on ${project.title}.`,
        submit: true,
      });
    }
  }

  // Every adjacent pair, decided the way the scores lean, with one judge dissenting once
  // so the pairwise fit is not a straight line and the agreement pass has a disagreement.
  for (const [j, judge] of w.judges.entries()) {
    for (let p = 0; p + 1 < w.projects.length; p += 1) {
      const left = w.projects[p] as { id: string };
      const right = w.projects[p + 1] as { id: string };
      recordComparison(w.asJudge(j), w.event, {
        judgeId: judge.id,
        a: left.id,
        b: right.id,
        winner: j === 1 && p === 1 ? right.id : left.id,
        reason: "manual",
      });
    }
  }
  // Go through the publication handler so public reads see an actual frozen revision.
  // This fixture has no active voting window; its clock remains in judging for the
  // dashboard and editor tests that share it.
  const publicationCall: Invocation = {
    ctx: w.asOrganizer, event: w.event, roles: ["organizer"],
    input: { event: w.event.slug }, accountId: w.organizer.id,
    gates: gatesFor(w.event, w.clock.now()), registry: REGISTRY, founder: false,
    now: w.clock.now(), address: "203.0.113.9", userAgent: "fixture",
    signIn: () => {}, signOut: () => {}, deliver: () => {}, origin: ORIGIN,
  };
  publish.handler(publicationCall);

  const member = upsertAccount(w.system, "builder0@example.test");
  const stranger = upsertAccount(w.system, "stranger@example.test", "Sam Stranger");
  grantRole(w.system, w.event.id, stranger.id, "participant");

  const serve = makeApp({
    db: w.db,
    registry: REGISTRY,
    publicOrigin: ORIGIN,
    views: VIEWS,
    clock: w.clock,
    deliver: () => {},
    log: () => {},
    report: () => {},
    secure: true,
  });
  const tokenFor = (id: string): string =>
    createSession(w.system.as(id), id, { userAgent: "fixture" }).token;
  const principals: Principal[] = [
    { label: "anonymous" },
    { label: "participant", token: tokenFor(member.id) },
    { label: "judge", token: tokenFor((w.judges[0] as { id: string }).id) },
    { label: "organizer", token: tokenFor(w.organizer.id) },
  ];
  const get = (
    path: string,
    principal: Principal = { label: "anonymous" },
    wants: "json" | "html" = "json",
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: wants === "html" ? "text/html" : "application/json",
    };
    if (principal.token !== undefined) headers.authorization = `Bearer ${principal.token}`;
    return serve(new Request(`${ORIGIN}${path}`, { headers }), "203.0.113.9");
  };
  return {
    world: w,
    serve,
    principals,
    fill: {
      event: w.event.slug,
      slug: w.event.slug,
      project: (w.projects[0] as { id: string }).id,
      judge: (w.judges[0] as { id: string }).id,
      team: (w.teams[0] as { id: string }).id,
      account: w.organizer.id,
      version: "1",
      token: "x".repeat(43),
    },
    get,
    json: async (path, principal) => {
      const response = await get(path, principal, "json");
      return (await response.json()) as Record<string, unknown>;
    },
    html: async (path, principal) => (await get(path, principal, "html")).text(),
    secrets: [
      w.organizer.id,
      ...w.judges.map((judge) => judge.id),
      ...w.judges.map((judge) => judge.email),
      w.organizer.email,
    ],
    close: () => w.close(),
  };
}

/** Every `:name` in a route replaced from the fixture, or `null` if one is unknown. */
export function route(command: Command, fill: Record<string, string>): string | null {
  const path = command.path.replace(/:([A-Za-z]+)/g, (whole, name: string) => fill[name] ?? whole);
  return path.includes(":") ? null : path;
}

/** The GET commands that answer with JSON — everything the schema sweep can read. */
export function readableCommands(): Command[] {
  return ALL_COMMANDS.filter(
    (command) => command.method === "GET" && command.returns.kind === "json",
  ) as Command[];
}
