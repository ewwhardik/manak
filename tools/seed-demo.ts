/**
 * The demo event, built through the repositories.
 *
 * Two files in this repository promised this one existed. `.gitignore` says the database is
 * not source because `npm run seed:demo` rebuilds a browsable event from a seed, and
 * `src/http/app.ts` says the seed creates the demo event through the repository so that a
 * fresh deployment is populated without `MANAK_FOUNDERS` being set. Both sentences were
 * true of the intention and false of the tree until this file existed — which is the exact
 * failure the rest of the product spends tests on, because a claim with nothing behind it
 * reads precisely like a claim with something behind it.
 *
 * **Every write goes through `src/db`, never through SQL.** So the seed cannot produce a row
 * the product could not have produced: each write lands in the audit ledger with an actor,
 * `createProject` still refuses a closed submissions window, `saveBallot` still refuses a
 * score outside the rubric's range, and the chain `verifyLedger` walks afterwards is the same
 * chain a running server appends to. A seed written as `insert into` would be a fixture that
 * proves nothing about the product and rots the first time a column moves.
 *
 * **The panel is deliberately uneven, and that is the demonstration.** Two of the five
 * entries were seen by all three judges; one was seen only by the two most generous, one only
 * by the two most severe, and one by a single judge. That is what an unbalanced rubric round
 * actually looks like, and it is the only shape in which the normalization engine has anything
 * to say — a fixture where every judge scores every project makes the ranking page and
 * `docs/proof/normalization.md` both look like arithmetic nobody needed.
 *
 * The cut line: this refuses to run twice rather than reconciling. There is no `--force`, no
 * upsert and no archive-the-old-one, because every one of those is a destructive operation
 * dressed as a convenience, and the operator who wants a clean demo can delete the file the
 * first line of output names. What the seed will not do is decide on their behalf that the
 * event they have been collecting real submissions in was the demo.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import {
  addTeamMember,
  assignProject,
  createEvent,
  createProject,
  createRubricVersion,
  createTeam,
  createTrack,
  findEventBySlug,
  grantRole,
  headHash,
  ledgerLength,
  makeContext,
  migrate,
  MS,
  openDatabase,
  publishRubric,
  recordComparison,
  saveBallot,
  setResultsPublic,
  submitProject,
  systemClock,
  upsertAccount,
  verifyLedger,
} from "../src/db/index.ts";
import type { Ctx, EventRow, ProjectRow } from "../src/db/index.ts";

/** The slug the demo takes, and the one this refuses to overwrite. */
const SLUG = "dogfood";

const NAME = "The Dogfood Invitational";

/**
 * The zone the event displays in, if this runtime knows it.
 *
 * `events.create` validates a zone by building a formatter with it, because `when()` in the
 * view layer hands the name to `Intl` and a name Node does not recognise throws at render
 * time rather than at entry. The seed writes through the repository and so skips that
 * validator, which means it has to run the same check itself: a Node compiled with a trimmed
 * ICU would otherwise turn this line into an event page that answers 500, and a demo whose
 * front door is a stack trace is worse than a demo that prints UTC.
 */
const ZONE = "Asia/Kolkata";

type Person = { readonly email: string; readonly name: string };

const ORGANIZER: Person = { email: "rosa@example.com", name: "Rosa Iyer" };

/**
 * Three judges who disagree about what 4 means.
 *
 * Nils marks low, Amara marks high, Kenji sits between them, and none of them is wrong —
 * that is the premise the whole judging engine is built on. The keys are used by the ballot
 * table below so a reader can see the severity of a row without doing the arithmetic.
 */
const JUDGES = {
  nils: { email: "nils@example.com", name: "Nils Berg" },
  amara: { email: "amara@example.com", name: "Amara Osei" },
  kenji: { email: "kenji@example.com", name: "Kenji Sato" },
} as const satisfies Readonly<Record<string, Person>>;

type JudgeKey = keyof typeof JUDGES;

const TRACKS = [
  { key: "tooling", label: "Developer tooling", ordering: 1 },
  { key: "access", label: "Accessibility", ordering: 2 },
] as const;

type Entry = {
  readonly team: string;
  readonly member: Person;
  readonly title: string;
  readonly summary: string;
  readonly track: string | null;
  /** False leaves it a draft — the only row a stranger cannot see, and the point of having one. */
  readonly submitted: boolean;
};

const ENTRIES: readonly Entry[] = [
  {
    team: "Saffron",
    member: { email: "beatriz@example.com", name: "Beatriz Lima" },
    title: "Lintwright",
    summary: "A linter that explains its rules in the language of the codebase it is reading.",
    track: "tooling",
    submitted: true,
  },
  {
    team: "Paprika",
    member: { email: "omar@example.com", name: "Omar Haddad" },
    title: "Portmatic",
    summary: "Finds the process holding the port you wanted and tells you what started it.",
    track: "tooling",
    submitted: true,
  },
  {
    team: "Cardamom",
    member: { email: "lena@example.com", name: "Lena Fischer" },
    title: "Readback",
    summary: "Reads a form back to you the way a screen reader will, before you ship it.",
    track: "access",
    submitted: true,
  },
  {
    team: "Turmeric",
    member: { email: "tariq@example.com", name: "Tariq Aziz" },
    title: "Highcontrast",
    summary: "Audits a palette against WCAG contrast ratios and proposes the nearest passing one.",
    track: "access",
    submitted: true,
  },
  {
    team: "Sumac",
    member: { email: "mei@example.com", name: "Mei Chen" },
    title: "Stackless",
    summary: "Turns a stack trace into the three frames that belong to you.",
    track: "tooling",
    submitted: true,
  },
  {
    team: "Nigella",
    member: { email: "dev@example.com", name: "Dev Rao" },
    title: "Sketchbook",
    summary: "Not finished. Left as a draft so the visibility rule has something to hide.",
    track: null,
    submitted: false,
  },
];

/**
 * The rubric, weighted so the weights matter.
 *
 * Craft and impact carry two each against presentation's one, because a rubric whose criteria
 * all weigh the same is a rubric that never exercises the weighting — and the weighting is
 * where a scoring engine is easiest to get quietly wrong.
 */
const CRITERIA = [
  { key: "craft", label: "Craft", weight: 2, min: 1, max: 5 },
  { key: "impact", label: "Impact", weight: 2, min: 1, max: 5 },
  { key: "presentation", label: "Presentation", weight: 1, min: 1, max: 5 },
] as const;

/**
 * Judge, project, one score per criterion in the order `CRITERIA` declares them, and a note.
 *
 * The coverage is the interesting part. Lintwright and Readback were seen by everybody.
 * Portmatic was seen only by Amara and Kenji, the two who mark high; Highcontrast only by
 * Nils and Kenji, the two who mark low. So Portmatic's raw mean is the higher of the pair
 * while every ballot it holds came from a generous hand — which is the disagreement between
 * the raw table and the normalized one that the results page exists to settle. Stackless
 * holds one ballot against a `reviewsPerProject` of three, so the organizer's dashboard has
 * a real gap to report rather than a green tick that means nothing.
 */
const BALLOTS: readonly (readonly [JudgeKey, string, readonly number[], string])[] = [
  ["nils", "Lintwright", [3, 3, 2], "Careful work. The rule explanations repeat themselves."],
  ["amara", "Lintwright", [5, 5, 4], "Delightful. I would install this tomorrow."],
  ["kenji", "Lintwright", [4, 4, 3], "Strong idea, and the demo held up."],
  ["nils", "Readback", [4, 5, 4], "The only entry here that solves a problem I actually have."],
  ["amara", "Readback", [5, 5, 5], "Best in the room."],
  ["kenji", "Readback", [5, 5, 4], "Well judged scope. Ships as-is."],
  ["amara", "Portmatic", [4, 4, 4], "Small and complete. Lovely."],
  ["kenji", "Portmatic", [3, 4, 3], "Useful. The Windows path is untested and they said so."],
  ["nils", "Highcontrast", [4, 3, 3], "Sound arithmetic, thin presentation."],
  ["kenji", "Highcontrast", [3, 4, 3], "The palette suggestions are better than the audit."],
  ["nils", "Stackless", [2, 2, 2], "Two frames of the three were wrong on my project."],
];

/**
 * One assignment nobody filed a ballot against.
 *
 * So the dashboard's per-judge progress reads four of five for Nils rather than a uniform
 * complete, and an organizer looking at this deployment can see what an outstanding
 * assignment looks like without waiting for a judge to go quiet on them.
 */
const OUTSTANDING: readonly (readonly [JudgeKey, string])[] = [["nils", "Portmatic"]];

/**
 * Judge, the pair, and the winner — or null for a skip, which is recorded rather than dropped.
 *
 * **Each judge's own duels form a path across the whole field.** Nils walks Readback, Lintwright,
 * Highcontrast, Stackless, Portmatic; Amara and Kenji walk their own orders. That shape is not
 * decoration — it is what makes the confidence page work on this deployment. The bootstrap
 * resamples whole judges, so a replicate that draws the same judge three times holds only that
 * judge's comparisons, and if one judge's edges do not span the field the resampled graph comes
 * apart. The seed used to file five duels spread across three judges, and three quarters of the
 * replicates were then fitting a graph in pieces: every interval on the page was several times
 * too wide, and the page's loudest warning was about the seed rather than about the judging.
 *
 * **The verdicts are chosen so the page has all three of its answers to show.** Readback is
 * separated from second in every resample, which is what a real first place looks like.
 * Highcontrast and Lintwright finish 0.02 apart in log-strength and swap in about a third of
 * resamples, which is the pair the page exists for — an organizer reading this deployment can see
 * "not separated" printed against two projects a leaderboard would have ranked without comment.
 * And Portmatic over Stackless has the largest gap on the table while still failing to separate at
 * 95%, because a gap is not evidence: the pair is thin, and the page says so where a bar chart
 * would have said the opposite.
 *
 * The disagreement with the rubric is kept on purpose. Amara's ballots put Lintwright top of her
 * pile and her duels put Highcontrast above it, which is the row the agreement report is built to
 * surface — two instruments, honestly answered, that do not concur.
 */
const DUELS: readonly (readonly [JudgeKey, string, string, string | null])[] = [
  ["nils", "Readback", "Lintwright", "Readback"],
  ["nils", "Lintwright", "Highcontrast", "Lintwright"],
  ["nils", "Highcontrast", "Stackless", "Highcontrast"],
  ["nils", "Stackless", "Portmatic", "Portmatic"],
  ["nils", "Lintwright", "Portmatic", null],
  ["amara", "Readback", "Highcontrast", "Readback"],
  ["amara", "Highcontrast", "Lintwright", "Highcontrast"],
  ["amara", "Lintwright", "Portmatic", "Lintwright"],
  ["amara", "Portmatic", "Stackless", "Portmatic"],
  ["kenji", "Readback", "Lintwright", "Readback"],
  ["kenji", "Lintwright", "Portmatic", "Lintwright"],
  ["kenji", "Portmatic", "Highcontrast", "Highcontrast"],
  ["kenji", "Highcontrast", "Stackless", "Highcontrast"],
];

/** Where the database is, read exactly the way `bin/manak.ts` reads it. */
function databasePath(): string {
  const configured = process.env.MANAK_DATABASE?.trim();
  return configured === undefined || configured === "" ? "./data/manak.db" : configured;
}

function zone(): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: ZONE });
    return ZONE;
  } catch {
    process.stdout.write(`[seed] this Node does not know ${ZONE}; the event will display in UTC\n`);
    return "UTC";
  }
}

/**
 * The whole demo, in one transaction-free sequence of audited writes.
 *
 * Not wrapped in an outer transaction on purpose: each repository call opens its own where it
 * needs one, and a half-seeded database is both obvious and disposable, while a nested
 * transaction around `ctx.recorded` would be a second opinion about atomicity in the one
 * place this codebase has already decided the question.
 */
export function seed(ctx: Ctx, now: number): { event: EventRow; links: readonly string[] } {
  const organizer = upsertAccount(ctx, ORGANIZER.email, ORGANIZER.name);
  // Every subsequent write is attributed to the organizer, because an audit ledger whose
  // actor column says `null` for the entire history of an event is a ledger that answers
  // "who did this" with "the seed", and that is the one answer it must never give a
  // deployment somebody is going to keep using.
  const as = ctx.as(organizer.id);

  const event = createEvent(as, {
    slug: SLUG,
    name: NAME,
    timezone: zone(),
    // Both windows open at once — the phase `gatesFor` calls `overlap`. Rolling judging is a
    // real format, and it is the only setting in which every page of this product is
    // reachable at the moment the seed finishes: a demo whose submission form answers 409
    // sends the evaluator to the schema to find out why.
    submissionsOpenAt: now - 2 * MS.day,
    submissionsCloseAt: now + 2 * MS.day,
    judgingOpenAt: now - MS.hour,
    judgingCloseAt: now + 3 * MS.day,
    reviewsPerProject: 3,
    pairwiseEnabled: true,
  });
  grantRole(as, event.id, organizer.id, "organizer");

  for (const track of TRACKS) createTrack(as, event.id, track);

  const judges = new Map<JudgeKey, string>();
  for (const [key, person] of Object.entries(JUDGES) as [JudgeKey, Person][]) {
    const account = upsertAccount(as, person.email, person.name);
    grantRole(as, event.id, account.id, "judge");
    judges.set(key, account.id);
  }

  const projects = new Map<string, ProjectRow>();
  for (const entry of ENTRIES) {
    const member = upsertAccount(as, entry.member.email, entry.member.name);
    grantRole(as, event.id, member.id, "participant");
    const team = createTeam(as, event.id, entry.team);
    addTeamMember(as, team, member.id);
    // Written as the participant, not as the organizer. The distinction is invisible on the
    // page and permanent in the ledger, and it is the difference between a demo an operator
    // can read the audit trail of and a demo where one account appears to have done everything.
    const mine = as.as(member.id);
    let project = createProject(mine, event, team, {
      title: entry.title,
      summary: entry.summary,
      tagline: entry.summary,
      description: `${entry.summary}\n\nThis seeded project demonstrates the submission, independent review, and results workflow. Explore its rubric scores and comparison history in the organizer workspace.`,
      techTags: entry.track === "tools" ? "TypeScript, CLI, Developer tools" : "Accessibility, Web, Design",
      trackKey: entry.track,
    });
    if (entry.submitted) project = submitProject(mine, event, project);
    projects.set(entry.title, project);
  }

  const rubric = createRubricVersion(as, event.id, CRITERIA);
  publishRubric(as, event.id, rubric.version);

  const projectId = (title: string): string => {
    const project = projects.get(title);
    if (project === undefined) {
      throw new Error(`the seed names a project it never planted: ${title}`);
    }
    return project.id;
  };

  for (const [key, title] of OUTSTANDING) {
    assignProject(as, event.id, judges.get(key) ?? "", projectId(title));
  }

  for (const [key, title, scores, comment] of BALLOTS) {
    const judgeId = judges.get(key) ?? "";
    // Assigned first so the reason recorded is `schedule`. `saveBallot` self-assigns as
    // `manual` if it has to, which is the right default for a judge who picked a project up
    // and the wrong description of a round somebody planned.
    assignProject(as, event.id, judgeId, projectId(title));
    saveBallot(as.as(judgeId), event, {
      judgeId,
      projectId: projectId(title),
      scores: Object.fromEntries(CRITERIA.map((c, index) => [c.key, scores[index] ?? c.min])),
      comment,
      submit: true,
    });
  }

  for (const [key, left, right, winner] of DUELS) {
    const judgeId = judges.get(key) ?? "";
    recordComparison(as.as(judgeId), event, {
      judgeId,
      a: projectId(left),
      b: projectId(right),
      winner: winner === null ? null : projectId(winner),
      reason: "manual",
    });
  }

  // Published, so the ranking is the first thing an evaluator can look at. The dashboard has
  // the button that takes it back down, and seeing the results page refuse an anonymous
  // caller is worth one click of setup rather than a seed that hides its best page.
  setResultsPublic(as, event, true);

  return {
    event,
    links: [ORGANIZER, ...Object.values(JUDGES), ...ENTRIES.map((entry) => entry.member)].map(
      (person) => person.email,
    ),
  };
}

function main(): number {
  const path = databasePath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  process.stdout.write(`[seed] database ${path}\n`);
  const db = openDatabase(path);
  try {
    migrate(db);
    if (findEventBySlug(db, SLUG) !== undefined) {
      process.stderr.write(
        `[seed] ${SLUG} already exists in this database, and this command will not ` +
          `reconcile or replace it.\n` +
          `       Delete ${path} to start over, or point MANAK_DATABASE somewhere else.\n`,
      );
      return 1;
    }

    const clock = systemClock;
    const ctx = makeContext(db, { clock });
    const { event, links } = seed(ctx, clock.now());

    const breaks = verifyLedger(db);
    if (breaks.length > 0) {
      // Reachable only from a bug in this file or in a repository, and worth its own exit
      // code: a seeded deployment whose chain is already broken would make the first thing
      // an evaluator checks on `/api/healthz` a false alarm about their own data.
      process.stderr.write(`[seed] the ledger this seed wrote does not verify:\n`);
      for (const b of breaks) process.stderr.write(`       ${JSON.stringify(b)}\n`);
      return 1;
    }

    process.stdout.write(
      `[seed] ${NAME} is at /events/${event.slug}, in ${event.timezone}\n` +
        `[seed] ${ENTRIES.length} entries (${ENTRIES.filter((e) => e.submitted).length} submitted), ` +
        `${BALLOTS.length} ballots, ${DUELS.length} comparisons, results published\n` +
        `[seed] ledger ${ledgerLength(db)} entries, head ${headHash(db)}\n` +
        `[seed] sign in as any of these; the link is printed to this server's stdout:\n` +
        links.map((email) => `       ${email}\n`).join("") +
        `[seed] ${ORGANIZER.email} organizes it. To let that address create further events,\n` +
        `       start the server with MANAK_FOUNDERS=${ORGANIZER.email}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) process.exit(main());
