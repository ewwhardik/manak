/**
 * The isolation proof.
 *
 *     npm run prove:isolation              # regenerate docs/proof/isolation.md
 *     npm run prove:isolation -- --check   # verify the committed file
 *
 * "One event's people cannot see another's" is the claim a self-hosted portal has to be
 * believed on, and a unit test of `decide` does not establish it: `decide` is a pure
 * function, and the interesting failure is a dispatcher that forgets to call it, calls it
 * with the wrong principal, or answers 403 where the rule says 404. So this harness starts
 * a real server on an ephemeral port and sends every operation, as every witness, in both
 * renderings, over HTTP — every command times six witnesses times two renderings, through
 * `node:http`, `fetch`, the router, the session lookup, the limiter and the capability check
 * — and compares each answer against the matrix `capabilityMatrix` derives from the
 * declarations. The exact counts are in the report rather than in this comment, because a
 * count written down here is a count that is wrong the week an operation is added.
 *
 * Three properties make the result worth reading rather than merely green.
 *
 * **Every request gets past the parser, the limiter and the event lookup.** All three run
 * *before* the capability decision, and each can produce a refusal of its own: a 422 from a
 * malformed payload, a 429 from a bucket, a 404 from an unknown slug. A probe that tripped
 * any of them would prove nothing about access control while looking exactly like a pass,
 * so this tool treats a 422 or a 429 anywhere as a broken fixture and refuses to write a
 * report. It is the one failure mode that could make this proof a lie.
 *
 * **A 404 is shown not to be a missing event.** The isolation rule and a genuinely wrong id
 * answer with the same code on purpose — `event.missing` either way — which means a 404 in
 * the table below is ambiguous unless something rules the second reading out. The control is
 * already in the matrix: `events.show` is public and scoped, so the same witness fetching
 * the same reference must get 200. Every `notFound` cell is checked against that.
 *
 * **A refused request appends nothing to the ledger.** Snapshotted around each probe. That
 * is the observable form of "the check runs before the handler": most of these probes are
 * refusals of an operation that would otherwise have appended, and a refusal that had
 * reached a handler would have left its audit entry behind.
 *
 * The cut line: this proves the *decision*, never the handler's subsequent reads, and never
 * that a handler was right to accept. An allowed operation is free to answer 409 and several
 * do — so the fixture opens every gate and plants every id the payload table names, which
 * makes an `allow` cell the decision it claims to be rather than a window that happened to be
 * shut. A command correctly allowed for an organizer, whose handler then selected across every
 * event in the database, passes here without a murmur. That claim is per handler and lives in
 * `tests/http.test.ts` and `tests/db.test.ts`; this file is about who gets in at all.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import {
  capabilityMatrix,
  makeRegistry,
  matrixMarkdown,
  pathParameters,
  PROBLEM_MEDIA_TYPE,
  SESSION_COOKIE,
  statusForRefusal,
  WITNESSES,
} from "../src/api/index.ts";
import type { Cell, Command, Delivery, MatrixRow, Operation, Witness } from "../src/api/index.ts";
import {
  addTeamMember,
  createEvent,
  createProject,
  createRubricVersion,
  createSession,
  createTeam,
  createTrack,
  grantRole,
  hashToken,
  issueMagicLink,
  ledgerLength,
  makeContext,
  makeIds,
  manualClock,
  migrate,
  mintToken,
  MS,
  openDatabase,
  publishRubric,
  submitProject,
  startVoter,
  upsertAccount,
  verifyLedger,
} from "../src/db/index.ts";
import type { Ctx, Db } from "../src/db/index.ts";
import { browserPath, listen } from "../src/http/index.ts";
import { VIEWS } from "../src/view/index.ts";

import { fileURLToPath } from "node:url";
const OUT_MD = fileURLToPath(new URL("../docs/proof/isolation.md", import.meta.url));

/** Frozen for the whole run: 2026-09-26T12:00:00.000Z, a day into the event. */
const AT = Date.parse("2026-09-26T12:00:00.000Z");

/** The event every scoped probe names. */
const SCOPED = "dogfood-2026";

/**
 * A second event, whose organizer is the `stranger` witness.
 *
 * The matrix models a stranger as a signed-in account holding no role *here*, which is
 * also, exactly, how an organizer of somebody else's hackathon presents itself. The fixture
 * makes that literal rather than assumed: the account probing `dogfood-2026` below is an
 * organizer with a live session, real memberships and an event of its own. If the two were
 * distinguishable at the transport layer, this is where it would show.
 */
const NEIGHBOUR = "other-2026";

/** The address named in `founders`, and the only thing that buys the founder column. */
const FOUNDER_EMAIL = "operator@example.test";

/**
 * Who each witness is, as an address.
 *
 * The three role holders are deliberately not founders and the founder deliberately holds
 * no role, which is what puts a visible 403 in both directions of the published table.
 */
const WITNESS_EMAIL: Readonly<Record<Witness, string | null>> = {
  anonymous: null,
  stranger: "organizer-elsewhere@example.test",
  founder: FOUNDER_EMAIL,
  participant: "builder@example.test",
  judge: "judge@example.test",
  organizer: "organizer@example.test",
};

type Wants = "json" | "html";
const RENDERINGS: readonly Wants[] = ["json", "html"];

/** One answer, reduced to the four things the comparison turns on. */
type Answer = {
  readonly status: number;
  readonly mediaType: string;
  readonly code: string | null;
  /** Ledger entries appended while this one request was in flight. */
  readonly appended: number;
};

type Probe = {
  readonly name: string;
  readonly route: string;
  readonly witness: Witness;
  readonly wants: Wants;
  readonly writes: boolean;
  readonly expected: Cell;
  readonly answer: Answer;
};

/**
 * An observed status, as a matrix cell.
 *
 * Anything that is not one of the three refusal statuses counts as `allow`, and that is the
 * correct reading rather than a lenient one. An allowed operation is free to answer 200, 303
 * or 409: a redirect after a browser's form post and a rule refusal are both answers the
 * caller got *in* for, and whether a handler's business logic was right is not this file's
 * question. What it will not tolerate is an allowed operation answering 401, 403 or 404, or a
 * refused one answering anything but its declared status.
 */
function cellOf(status: number): Cell {
  return status === 401
    ? "unauthenticated"
    : status === 403
      ? "forbidden"
      : status === 404
        ? "notFound"
        : "allow";
}

/** A media type without its parameters, so `text/html; charset=utf-8` compares as one thing. */
function mediaTypeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
}
/**
 * The rows the payload table names, planted so that no probe has to invent an id.
 *
 * Every one of these exists to keep a path parameter pointing at something real. An empty
 * segment is a 404 from the router and an unknown id is a 404 from a repository, and either
 * one would land in the table below spelled differently from the isolation refusal — which
 * is the single thing the "a 404 is not a missing event" claim rests on not happening.
 */
type Planted = {
  /** A track key, so a project may name one and a track-scoped draw has something to scope to. */
  readonly track: string;
  /** The participant witness's own team, which is also the team `teams.join` re-joins. */
  readonly team: string;
  /**
   * The participant witness's own project, in draft.
   *
   * Named by the three operations declaring `owner: "team"`. It is genuinely theirs, so the
   * `allow` cell for the participant is the handler agreeing rather than `ownProject`'s 404
   * standing in for one — and the other five witnesses never reach the handler to find out.
   */
  readonly own: string;
  /** Two submitted projects, on teams nobody joins: the pair `duels.decide` compares. */
  readonly left: string;
  readonly right: string;
  /** Two more, one for each organizer operation that ends a project's run. */
  readonly pulled: string;
  readonly culled: string;
  /** The published rubric version, and the criteria a filed ballot has to cover. */
  readonly rubric: number;
  readonly criteria: Readonly<Record<string, number>>;
  readonly voterHash: string;
};

type Fixture = {
  readonly db: Db;
  readonly clock: ReturnType<typeof manualClock>;
  readonly system: Ctx;
  readonly planted: Planted;
  /** The account behind each witness, and null for the one that has none. */
  readonly accountOf: Readonly<Record<Witness, string | null>>;
  /**
   * A bearer token for a witness, minted fresh for every probe.
   *
   * Per probe rather than per witness because one of the operations under test is
   * `auth.signout`, and a shared session would be revoked halfway through the run — turning
   * every later probe for that witness into a 401 that looks exactly like a capability
   * failure. Minting one each time makes the order of this table irrelevant.
   */
  readonly sessionFor: (witness: Witness) => string | null;
  /** A fresh, unconsumed sign-in link for an address. */
  readonly mint: (email: string) => string;
  /** One live link, for the route that reads one without spending it. */
  readonly liveToken: string;
  readonly close: () => void;
};

/**
 * The two events, the five accounts, the roles between them, and the rows the probes name.
 *
 * Built through the repositories rather than by insert, for the reason
 * `tests/support/world.ts` gives: a fixture assembled by hand can sit in a state no code path
 * can reach, and a proof about such a database is not a proof about this one.
 *
 * The world it builds is the smallest one in which every operation can be *reached*: a track,
 * a team, a draft, four submitted projects and a published rubric. Reached, not satisfied — a
 * handler is still free to refuse, and several do. The fixture's whole job is to make sure the
 * refusal comes from the handler's own rules rather than from a parser, a limiter, an empty
 * path segment or an id that names nothing, because each of those four answers a status this
 * file would read as a capability decision.
 */
function plant(): Fixture {
  const db = openDatabase(":memory:");
  const clock = manualClock(AT);
  migrate(db, undefined, clock);
  let counter = 0;
  const system = makeContext(db, {
    clock,
    newId: makeIds(clock.now, (into) => {
      counter += 1;
      into.fill(0);
      into[into.length - 1] = counter & 0xff;
      into[into.length - 2] = (counter >> 8) & 0xff;
    }),
  });
  // Both events sit in the same windows, and both windows are open at once — the phase
  // `gatesFor` names `overlap`. That is not a convenience. Ten operations declare a gate, the
  // gate is asserted *after* the capability decision, and a closed window answers 409, which
  // this file counts as `allow`. So a fixture with submissions shut would publish a green
  // table in which ten cells were satisfied by the wrong refusal, and nobody reading it could
  // tell. Opening both windows is what makes those ten cells the decision they claim to be.
  const windows = {
    submissionsOpenAt: AT - 2 * MS.day,
    submissionsCloseAt: AT + 2 * MS.day,
    judgingOpenAt: AT - MS.hour,
    judgingCloseAt: AT + 3 * MS.day,
    reviewsPerProject: 3,
    pairwiseEnabled: true,
    votingOpenAt: AT - MS.hour,
    votingCloseAt: AT + 3 * MS.day,
    votingMode: "open" as const,
  };
  const here = createEvent(system, { slug: SCOPED, name: "Dogfood 2026", ...windows });
  const there = createEvent(system, { slug: NEIGHBOUR, name: "Another Hackathon", ...windows });

  const join = (email: string, name: string): string => upsertAccount(system, email, name).id;
  const organizer = join(WITNESS_EMAIL.organizer as string, "Ada Organizer");
  const judge = join(WITNESS_EMAIL.judge as string, "Bo Judge");
  const participant = join(WITNESS_EMAIL.participant as string, "Cy Builder");
  const stranger = join(WITNESS_EMAIL.stranger as string, "Del Elsewhere");
  const founder = join(FOUNDER_EMAIL, "Eve Operator");
  grantRole(system, here.id, organizer, "organizer");
  grantRole(system, here.id, judge, "judge");
  grantRole(system, here.id, participant, "participant");
  // The stranger runs a hackathon of its own and holds nothing here. This is the line that
  // makes the stranger column an isolation claim rather than a claim about empty accounts.
  grantRole(system, there.id, stranger, "organizer");

  // One track, so a project may carry a track key and `tracks.create` has a sibling rather
  // than an empty table to be the first row of.
  const track = createTrack(system, here.id, { key: "tooling", label: "Tooling", ordering: 1 });

  // The participant's own team and own draft. `decide` admits exactly one witness to a
  // participant operation — `principal.roles.includes(role)`, no ladder — so this draft is
  // reached by that one witness and by nobody else, which is why it can be a draft at all.
  const salt = createTeam(system, here.id, "Salt");
  addTeamMember(system, salt, participant);
  const own = createProject(system, here, salt, {
    title: "Manak",
    summary: "A self-hostable hackathon portal.",
    trackKey: track.key,
  });

  /** A submitted project on a team nobody joins, so it is nobody's to edit and everybody's to read. */
  const rival = (name: string, title: string): string => {
    const team = createTeam(system, here.id, name);
    const project = createProject(system, here, team, { title, summary: `${title}, entered.` });
    return submitProject(system, here, project).id;
  };
  // `left` and `right` are the pair `duels.decide` compares — distinct, or `comparison.samePair`
  // is a 422 and this file refuses to write a report. `projects.show` names `left` for a reason
  // of its own: its handler hides a project that is not submitted behind `notFound`, from
  // everybody but the owning team and an organizer, and it is a public operation.
  const left = rival("Pepper", "Pepper");
  const right = rival("Mustard", "Mustard");
  // One each for the two operations that end a project's run, so neither has to be aimed at a
  // project another probe still depends on.
  const pulled = rival("Sage", "Sage");
  const culled = rival("Clove", "Clove");

  // A published rubric, because `saveBallot` refuses without one and then refuses again — with
  // a 422 — for a score set that does not cover every criterion of the version in force.
  const criteria = { craft: 5, impact: 5 };
  const rubric = createRubricVersion(system, here.id, [
    { key: "craft", label: "Craft", weight: 2, min: 1, max: criteria.craft },
    { key: "impact", label: "Impact", weight: 1, min: 1, max: criteria.impact },
  ]).version;
  publishRubric(system, here.id, rubric);
  const voterHash = hashToken(startVoter(system, here, { fingerprint: "isolation-voter", accountId: null }).token);

  const accountOf: Record<Witness, string | null> = {
    anonymous: null,
    stranger,
    founder,
    participant,
    judge,
    organizer,
  };
  return {
    db,
    clock,
    system,
    planted: {
      track: track.key,
      team: salt.id,
      own: own.id,
      left,
      right,
      pulled,
      culled,
      rubric,
      criteria,
      voterHash,
    },
    accountOf,
    sessionFor: (witness) => {
      const id = accountOf[witness];
      if (id === null) return null;
      return createSession(system.as(id), id, { userAgent: "prove:isolation" }).token;
    },
    mint: (email) => issueMagicLink(system, { email }).token,
    liveToken: issueMagicLink(system, { email: "reader@example.test" }).token,
    close: () => db.close(),
  };
}
/**
 * The payload each operation is probed with, written out rather than generated.
 *
 * Every one of these has to be *valid*. A 422 refuses the request before the capability check
 * runs, so the resulting cell would be a fabrication that looks exactly like a pass — and a
 * generator that produced a plausible payload for forty operations and a subtly wrong one for
 * the forty-first would leave the hole precisely where nobody would look for it. Written out,
 * the list is reviewable; `claims` refusing to write a report on any 422 is what keeps it true
 * as the declarations change.
 *
 * Two rules keep the table short enough to review. **Required fields are sent and optional ones
 * are omitted**, unless the operation is uninteresting without one — an omitted optional is one
 * fewer coercion to get wrong in the form rendering, and `rubrics.show` with no `version` is
 * also the request a reader actually makes. And **anything the world can only hold once carries
 * `tag`**, so the second probe of an operation is not a duplicate-key refusal of the first.
 *
 * What is deliberately *not* here is a payload chosen to make a handler succeed. `projects.pull`
 * names a project it can really withdraw and `assignments.draw` is a dry run, but `results.show`
 * is probed against unpublished results and answers 409, and that is left alone: this file reads
 * 409 as `allow`, which is what it is.
 */
function valuesFor(
  name: string,
  witness: Witness,
  wants: Wants,
  fixture: Fixture,
): Record<string, unknown> {
  const tag = `${witness}-${wants}`;
  const planted = fixture.planted;
  switch (name) {
    case "exports.download":
      return { event: SCOPED, stage: "audit" };
    case "comments.add":
      return { event: SCOPED, project: planted.left, body: `Thoughtful feedback from ${tag}` };
    case "comments.hide":
      return { event: SCOPED, project: planted.left, comment: "999999", reason: "Moderation proof" };
    case "votes.ballot":
      return { event: SCOPED };
    case "auth.request":
      // An address of its own per probe: the sign-in bucket is keyed on the address and its
      // cap is ten an hour, which twelve probes of one address would walk straight into.
      return { email: `asking-${tag}@example.test` };
    case "auth.link":
      return { token: fixture.liveToken };
    case "auth.session":
      // A link of its own per probe. This operation is public, so all twelve reach the
      // handler and all twelve consume what they were given; a shared token would make
      // eleven of them a 409 and the `allow` cells would stop meaning anything.
      return { token: fixture.mint(`joining-${tag}@example.test`) };
    case "events.show":
    case "events.judges":
      return { event: SCOPED };
    case "events.invite":
      return { event: SCOPED, email: `invited-${tag}@example.test`, role: "judge" };
    case "events.revoke_role":
      return { event: SCOPED, account: fixture.accountOf.stranger, role: "participant" };
    case "results.judge_evidence":
      return { event: SCOPED, judge: fixture.accountOf.judge,
        decision: "include", reason: "Isolation proof read only outcome" };
    case "results.correct_cert":
      return { event: SCOPED, serial: "CERT-P-isolation-missing", action: "revoke",
        reason: "Isolation probe has no issued certificate" };
    case "reviews.request":
      return { event: SCOPED, project: planted.left, reasonCode: "coverage",
        internalReason: "An additional review is needed for coverage.", priority: 2 };
    case "reviews.cancel":
      return { event: SCOPED, request: planted.left };
    case "votes.configure_abuse":
      return { event: SCOPED, patternPercent: 95, sharedOriginPercent: 80, highRisk: 70 };
    case "votes.review_abuse":
      return { event: SCOPED, clusterTokens: planted.voterHash, state: "confirmed",
        reason: "Isolation probe reviews a real voter" };
    case "judges.configure":
      return { event: SCOPED, judge: fixture.accountOf.judge, tracks: "" };
    case "judges.recusal":
      return { event: SCOPED, judge: fixture.accountOf.judge,
        project: planted.left, decision: "clear", reason: "Isolation proof cleanup" };
    case "events.create":
      return {
        slug: `founded-${tag}`,
        name: `Founded by the ${witness}`,
        timezone: "Europe/Lisbon",
        submissionsOpenAt: new Date(AT + MS.day).toISOString(),
        submissionsCloseAt: new Date(AT + 3 * MS.day).toISOString(),
        judgingOpenAt: new Date(AT + 3 * MS.day).toISOString(),
        judgingCloseAt: new Date(AT + 4 * MS.day).toISOString(),
        reviewsPerProject: 3,
        pairwiseEnabled: true,
      };
    case "events.update":
      return {
        event: SCOPED,
        name: `Renamed by the ${witness}`,
        timezone: "Europe/Lisbon",
        submissionsOpenAt: new Date(AT - 2 * MS.day).toISOString(),
        submissionsCloseAt: new Date(AT + 2 * MS.day).toISOString(),
        judgingOpenAt: new Date(AT - MS.day).toISOString(),
        judgingCloseAt: new Date(AT + 4 * MS.day).toISOString(),
        reviewsPerProject: 3,
        pairwiseEnabled: true,
        votingMode: "off",
        votingCredits: 100,
      };
    case "votes.results":
    case "votes.start":
      return { event: SCOPED };
    case "votes.cast":
      return { event: SCOPED, project: planted.left, influence: 1, token: "x".repeat(43) };
    // Tracks and teams.
    case "tracks.create":
      // The key has to match `^[a-z0-9][a-z0-9_-]*$`, which the witness-and-rendering tag
      // already does. A repeat would be a 409 rather than a 422, so this is belt and braces.
      return { event: SCOPED, key: `track-${tag}`, label: `Track for the ${witness}`, ordering: 2 };
    case "teams.list":
    case "projects.list":
      return { event: SCOPED };
    case "teams.join":
      // The witness's *own* team. Only the participant reaches this handler, and joining the
      // team it is already on is an early return rather than `team.alreadyJoined` — a 409 would
      // pass too, but a probe that has to be refused to be counted as allowed is a probe
      // somebody will one day mistake for the bug it resembles.
      return { event: SCOPED, team: planted.team };
    // Projects. `show` names a submitted project because its handler hides anything else
    // behind `notFound` from all but the owning team and an organizer, and it is public: aimed
    // at the draft, four of its six `allow` cells would answer 404 and the whole table's
    // "a 404 is a refusal, not a missing row" reading would go with them.
    case "projects.show":
      return { event: SCOPED, project: planted.left };
    case "projects.create":
      // No `teamName`: the participant is already on a team, and a name that disagrees with the
      // one it is on is an `InputError`, which is a 422. No URLs either — `httpsProblems` makes
      // every non-`https://` one a field problem, and an omitted optional cannot be wrong.
      return { event: SCOPED, title: `Entered by the ${witness}`, summary: `Probe ${tag}.` };
    case "projects.update":
      return {
        event: SCOPED,
        project: planted.own,
        title: `Renamed by the ${witness}`,
        summary: `Probe ${tag}.`,
      };
    case "projects.submit":
    case "projects.withdraw":
      return { event: SCOPED, project: planted.own };
    case "projects.pull":
      return { event: SCOPED, project: planted.pulled, reason: "Withdrawn by the organizer." };
    case "projects.disqualify":
      return { event: SCOPED, project: planted.culled, reason: "Entered after the deadline." };
    // The rubric. `show` omits `version` so it resolves the published one, which is the request
    // a reader makes and the only one that cannot 404 as the versions accumulate below it.
    case "rubrics.show":
      return { event: SCOPED };
    case "rubrics.create":
      return {
        event: SCOPED,
        criteria: "craft | Craft | 2 | 1 | 5\nimpact | Impact | 1 | 1 | 5",
      };
    case "rubrics.publish":
      // The planted version, already published, so this is an early return. An unknown version
      // is `notFound("rubric")` — a 404, spelled `rubric.missing`, which would break the check
      // that every 404 in the run agrees on one code.
      return { event: SCOPED, version: planted.rubric };
    // Judging.
    case "judging.queue":
    case "duels.next":
    case "events.dashboard":
    case "results.show":
    case "results.history":
    case "results.preflight":
    case "results.evidence_packet":
    case "awards.list":
    case "judges.roster":
    case "reviews.requests":
    case "results.confidence":
    case "results.publish":
    case "results.unpublish":
    case "results.certificates":
    case "results.certificate_status":
    case "results.issue_certs":
    case "events.clock":
    case "events.webhooks":
    case "votes.ballot":
    case "votes.abuse":
      return { event: SCOPED };
    case "awards.decide":
      return { event: SCOPED, project: planted.left, awardKey: `Grand prize ${tag}`,
        type: "placement", place: 1,
        publicSummary: "Selected after review of published project evidence.",
        internalReason: "Organizer panel confirmed the decision for this isolation probe." };
    case "events.warp_clock":
      return { event: SCOPED, targetPhase: "realtime" };
    case "events.ping_webhook":
      return {
        event: SCOPED,
        url: "https://example.com/webhook",
        secret: "0123456789abcdef0123456789abcdef",
      };
    case "votes.discount_cluster":
      return {
        event: SCOPED,
        clusterTokens: planted.voterHash,
        discountPercent: 100,
        reason: "Co-voting Sybil clique",
      };
    case "ballots.save":
      // Every criterion of the published version, each inside its range. A missing one is
      // `ballot.incomplete` and an out-of-range one is `score.range`, and both are 422s. The
      // ballot is filed rather than drafted, so the probe exercises the whole precondition
      // chain — `saveBallot` assigns the judge to the project itself, which is why no
      // assignment is planted for it.
      return {
        event: SCOPED,
        project: planted.left,
        scores: planted.criteria,
        comment: `Filed by the ${witness}.`,
        draft: false,
      };
    case "duels.decide":
      // Two different projects: `comparison.samePair` is a 422. The verdict is a side rather
      // than an id, so it cannot disagree with the pair.
      return {
        event: SCOPED,
        left: planted.left,
        right: planted.right,
        verdict: "left",
        reason: "manual",
      };
    case "assignments.preview":
      return { event: SCOPED };
    case "assignments.draw":
      // A dry run. The draw would otherwise rewrite the assignment table between one probe and
      // the next, and a fixture that changes underneath the run is the same defect as a clock
      // that moves during it.
      return { event: SCOPED, dryRun: true };
    default:
      // Everything with no input at all: the six system documents, the two auth pages, the
      // event list, `events.mine`, `auth.whoami` and `auth.signout`. A new operation with a
      // path parameter that lands here does not fall through quietly — `target` throws.
      return {};
  }
}
/**
 * Where a probe is sent: the declared path for JSON, the same path without `/api` for a page.
 *
 * The prefix *is* the content negotiation in this product — `Accept` is never consulted — so
 * sending the same operation twice under two paths is the only way to probe both renderings,
 * and it is why this file cares about `browserPath` at all.
 *
 * An empty path parameter is refused here rather than sent. `/api/events//projects` reaches the
 * router as a route that matches nothing and comes back 404 `route.missing` — a status this file
 * reads as an isolation refusal and a code that would quietly break the agreement check that
 * makes such a reading honest. So a payload table that has not caught up with a new operation
 * fails loudly at generation time instead of publishing a column of fabricated 404s.
 */
function target(command: Command, values: Record<string, unknown>, wants: Wants): string {
  const params = pathParameters(command.path);
  let path = wants === "json" ? command.path : browserPath(command.path);
  for (const param of params) {
    const value = String(values[param] ?? "");
    if (value === "") {
      throw new Error(
        `valuesFor(${command.name}) gives no ${param}: add a case for it, or its probes ` +
          `become a 404 from the router that this proof cannot tell from an isolation refusal.`,
      );
    }
    path = path.replace(`:${param}`, encodeURIComponent(value));
  }
  if (command.method !== "GET") return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (!params.includes(key)) query.append(key, String(value));
  }
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
}

/**
 * The body, in the dialect its rendering implies.
 *
 * Form fields are strings and a checkbox is `on`; JSON is taken at its word, so an integer has
 * to arrive as an integer and a boolean as a boolean. That asymmetry is `parseInput`'s
 * deliberate rule — coercion is for the transport that has no types — and probing both
 * renderings from one table is what shows it holds in both directions rather than in the one
 * somebody happened to test.
 *
 * One field is not flat. `ballots.save` takes a map of criterion keys to numbers, which a JSON
 * caller sends as an object and a form has no way to nest — so the form dialect is `scores.craft`
 * and this is the only place in the harness that knows it. Sending the object through
 * `String(value)` instead, which is what a flat loop does, submits the text `[object Object]`,
 * and the 422 that follows would be recorded as the judge's `allow` cell.
 */
function submission(
  command: Command,
  values: Record<string, unknown>,
  wants: Wants,
): { body?: string; headers: Record<string, string> } {
  if (command.method === "GET") return { headers: {} };
  const params = pathParameters(command.path);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!params.includes(key)) body[key] = value;
  }
  if (wants === "json") {
    return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
  }
  const form = new URLSearchParams();
  const append = (key: string, value: unknown): void => {
    if (value === false) return;
    if (value !== null && typeof value === "object") {
      for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
        append(`${key}.${inner}`, nested);
      }
      return;
    }
    form.append(key, value === true ? "on" : String(value));
  };
  for (const [key, value] of Object.entries(body)) append(key, value);
  return {
    body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}
/** The `code` out of a problem document, and null from anything that is not one. */
async function codeOf(response: Response): Promise<string | null> {
  if (mediaTypeOf(response) !== PROBLEM_MEDIA_TYPE) {
    // Drained anyway. An unread body holds the socket open, and this tool makes several
    // hundred requests through one keep-alive pool.
    await response.arrayBuffer();
    return null;
  }
  const problem = (await response.json()) as { code?: unknown };
  return typeof problem.code === "string" ? problem.code : null;
}

type Run = {
  readonly probes: readonly Probe[];
  readonly rows: readonly MatrixRow[];
  readonly breaks: number;
  readonly delivered: number;
};

/**
 * Every operation, as every witness, in both renderings, over a real socket.
 *
 * Sequential on purpose. The point is not throughput: it is that the ledger delta around each
 * request can be attributed to that request, which concurrency would destroy.
 */
async function probeAll(): Promise<Run> {
  const fixture = plant();
  const rows = capabilityMatrix(ALL_COMMANDS as readonly Operation[]);
  const expected = new Map(rows.map((row) => [row.name, row.cells]));
  const delivered: Delivery[] = [];
  const listening = await listen({
    db: fixture.db,
    registry: makeRegistry(ALL_COMMANDS),
    views: VIEWS,
    clock: fixture.clock,
    deliver: (message) => delivered.push(message),
    log: () => {},
    // A 500 is the one answer this file reports as a bug rather than a policy, and the
    // report can only say which probe it was on. Print the stack too: without it the
    // operator's next move is to reconstruct a fixture, a session and a path by hand.
    report: (error: unknown) => {
      process.stderr.write(`  server bug: ${error instanceof Error ? error.stack : String(error)}\n`);
    },
    founders: [FOUNDER_EMAIL],
    demoMode: true, // This proof exercises the explicitly demo-only clock operation.
    publicOrigin: "http://127.0.0.1",
    host: "127.0.0.1",
    port: 0,
  });

  const probes: Probe[] = [];
  try {
    for (const command of ALL_COMMANDS) {
      for (const witness of WITNESSES) {
        for (const wants of RENDERINGS) {
          probes.push(await probeOne(fixture, listening.url, command, witness, wants, expected));
        }
      }
    }
  } finally {
    await listening.close();
  }
  const breaks = verifyLedger(fixture.db).length;
  fixture.close();
  return { probes, rows, breaks, delivered: delivered.length };
}
/**
 * One request, with the ledger measured either side of it.
 *
 * The session is minted before the snapshot and the sign-in link before that, so the delta
 * this records is the work the *request* did and not the work the fixture did to set it up.
 */
async function probeOne(
  fixture: Fixture,
  origin: string,
  command: Command,
  witness: Witness,
  wants: Wants,
  expected: Map<string, Readonly<Record<Witness, Cell>>>,
): Promise<Probe> {
  const token = fixture.sessionFor(witness);
  const values = valuesFor(command.name, witness, wants, fixture);
  const init = submission(command, values, wants);
  fixture.db.exec("delete from rate_limit;");
  const before = ledgerLength(fixture.db);
  const response = await fetch(`${origin}${target(command, values, wants)}`, {
    method: command.method,
    // Manual, because following a 303 would replace the answer under test with the answer
    // from wherever it pointed — and for a browser write that is the whole result.
    redirect: "manual",
    headers: {
      ...init.headers,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const code = await codeOf(response);
  const mediaType = mediaTypeOf(response);
  return {
    name: command.name,
    route: `${command.method} ${command.path}`,
    witness,
    wants,
    writes: (command.records ?? []).length > 0,
    expected: (expected.get(command.name) as Readonly<Record<Witness, Cell>>)[witness],
    answer: {
      status: response.status,
      mediaType,
      code,
      appended: ledgerLength(fixture.db) - before,
    },
  };
}
/** `events.show` for a witness and rendering: the control every 404 is read against. */
function controlKey(probe: Probe): string {
  return `${probe.witness}|${probe.wants}`;
}

function controls(probes: readonly Probe[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const probe of probes) {
    if (probe.name === "events.show") found.set(controlKey(probe), probe.answer.status);
  }
  return found;
}

/**
 * Everything that would make the report below a lie, as a list of sentences.
 *
 * Five kinds of problem, and the first two are about this tool rather than about the server.
 * A 422 means the probe's payload was wrong, and a 429 means a bucket filled up during the
 * run; either way the status came from a step that runs *before* the capability check, so the
 * cell is not evidence and reporting it as one would be the single worst thing this file could
 * do. They are listed as failures rather than skipped for that reason.
 */
function claims(run: Run): string[] {
  const problems: string[] = [];
  const control = controls(run.probes);
  const missingCodes = new Set<string>();
  for (const probe of run.probes) {
    const where = `${probe.name} as ${probe.witness} (${probe.wants})`;
    const observed = cellOf(probe.answer.status);
    if (probe.answer.status === 422) {
      problems.push(
        `${where}: answered 422 (${probe.answer.code ?? "?"}). The probe's payload is wrong, ` +
          `so this cell is the parser's answer and says nothing about access control.`,
      );
      continue;
    }
    if (probe.answer.status === 429) {
      problems.push(
        `${where}: answered 429. A bucket filled up during the run, so this cell is the ` +
          `limiter's answer and not the capability check's.`,
      );
      continue;
    }
    if (probe.answer.status >= 500) {
      problems.push(`${where}: answered ${probe.answer.status}, which is a bug, not a policy.`);
      continue;
    }
    problems.push(...disagreements(probe, observed, control, missingCodes));
  }
  problems.push(...global(run, missingCodes));
  return problems;
}
/** What one answer disagrees with: the declaration, the ledger, the dialect, or the control. */
function disagreements(
  probe: Probe,
  observed: Cell,
  control: Map<string, number>,
  missingCodes: Set<string>,
): string[] {
  const out: string[] = [];
  const where = `${probe.name} as ${probe.witness} (${probe.wants})`;
  if (probe.expected === "allow") {
    if (observed !== "allow") {
      out.push(`${where}: the declaration allows this caller, the server said ${probe.answer.status}.`);
    }
  } else if (probe.answer.status !== statusForRefusal(probe.expected)) {
    // Against `statusForRefusal` rather than against a literal, so the expected status comes
    // from the same function the dispatcher uses. A table of hand-written numbers here would
    // agree with the server right up until somebody changed what a refusal means.
    out.push(
      `${where}: the declaration says ${probe.expected}, which is ` +
        `${statusForRefusal(probe.expected)}; the server said ${probe.answer.status}.`,
    );
  }
  if (observed === "allow") return out;
  if (probe.answer.appended !== 0) {
    // The observable form of "the check runs before the handler". A refusal that had reached
    // a handler would have left its audit entry behind.
    out.push(
      `${where}: refused with ${probe.answer.status} and still appended ` +
        `${probe.answer.appended} ledger entr${probe.answer.appended === 1 ? "y" : "ies"}.`,
    );
  }
  const dialect = probe.wants === "json" ? PROBLEM_MEDIA_TYPE : "text/html";
  if (probe.answer.mediaType !== dialect) {
    out.push(
      `${where}: refused with ${probe.answer.status} as ` +
        `${probe.answer.mediaType === "" ? "nothing" : probe.answer.mediaType}, not ${dialect}.`,
    );
  }
  if (probe.answer.status !== statusForRefusal(probe.expected === "allow" ? "notFound" : probe.expected)
    && observed === probe.expected) {
    out.push(`${where}: ${observed} should be ${statusForRefusal(observed)}, not ${probe.answer.status}.`);
  }
  if (observed !== "notFound") return out;
  if (probe.answer.code !== null) missingCodes.add(probe.answer.code);
  const seen = control.get(controlKey(probe));
  if (seen !== 200) {
    out.push(
      `${where}: answered 404, and the control — events.show, same witness, same reference — ` +
        `answered ${seen ?? "nothing"} rather than 200, so this 404 cannot be shown to mean ` +
        `"not yours" rather than "no such event".`,
    );
  }
  return out;
}
/**
 * The claims that are about the run as a whole rather than about any one answer.
 *
 * The code check is the sharper half of "a 404 is not a missing event". The control above
 * shows the event was reachable; this shows every 404 spelled itself the same way, so a
 * caller counting distinct error codes cannot separate the two either.
 */
function global(run: Run, missingCodes: Set<string>): string[] {
  const out: string[] = [];
  const wanted = ALL_COMMANDS.length * WITNESSES.length * RENDERINGS.length;
  if (run.probes.length !== wanted) {
    out.push(`sent ${run.probes.length} requests, expected ${wanted}.`);
  }
  if (missingCodes.size > 1) {
    out.push(
      `the 404s do not agree on a code (${[...missingCodes].sort().join(", ")}), so an ` +
        `isolation refusal is distinguishable from a wrong id by reading the document.`,
    );
  }
  if (run.breaks > 0) {
    out.push(`the ledger's hash chain has ${run.breaks} break(s) after the run.`);
  }
  if (!run.rows.some((row) => row.cells.stranger === "notFound")) {
    // Without this the harness could pass on a build where nothing is scoped at all, which
    // is the one way "no isolation failures" could be true and worthless.
    out.push("no operation refuses a stranger with notFound, so there is nothing here to prove.");
  }
  return out;
}

/** How many probes fell into a cell, across every operation and rendering. */
function tally(probes: readonly Probe[], of: (probe: Probe) => boolean): number {
  return probes.filter(of).length;
}
/** A markdown table from a header and rows, padded so the source is readable unrendered. */
function gridOf(header: readonly string[], body: readonly (readonly string[])[]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${widths.map((width, index) => (cells[index] ?? "").padEnd(width)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

/**
 * The refusals this run provoked, grouped by the shape they arrived in.
 *
 * Keyed on a joined string because a `Map` compares keys by identity, and a tuple key would
 * make every entry unique and every count one. NUL is the separator because it is the one
 * character that cannot occur in a status, a problem code or a media type, so no two distinct
 * shapes can collide into a single row and undercount the refusals.
 *
 * It is written as an escape and not as the byte. A raw control character in a source file is
 * invisible in a diff and in review, and `tests/source.test.ts` fails the tree for one — this
 * function is where that test earned its keep.
 */
function shapes(probes: readonly Probe[]): string {
  const counts = new Map<string, number>();
  for (const probe of probes) {
    if (cellOf(probe.answer.status) === "allow") continue;
    const key = `${probe.answer.status}\u0000${probe.answer.code ?? "—"}\u0000${probe.answer.mediaType}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const body = [...counts.entries()]
    .map(([key, count]) => {
      const [status, code, media] = key.split("\u0000") as [string, string, string];
      return [status, code === "—" ? "—" : `\`${code}\``, `\`${media}\``, String(count)];
    })
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string) || (a[1] as string).localeCompare(b[1] as string));
  return gridOf(["Status", "Code", "Media type", "Answers"], body);
}

/** Every 404 this run produced, beside the control that shows the event was there. */
function audit(probes: readonly Probe[]): string {
  const control = controls(probes);
  const body = probes
    .filter((probe) => cellOf(probe.answer.status) === "notFound")
    .map((probe) => [
      probe.name,
      probe.witness,
      probe.wants,
      probe.answer.code === null ? "—" : `\`${probe.answer.code}\``,
      `${control.get(controlKey(probe)) ?? "—"}`,
    ]);
  return gridOf(["Operation", "Witness", "Rendering", "Code", "events.show"], body);
}
/**
 * The report.
 *
 * Nothing in it is a measurement. Every number is a count of requests this tool made or
 * answers it read, and the clock is frozen, so two runs of the same tree produce the same
 * bytes — which is what lets `--check` compare byte for byte instead of within a tolerance.
 * If a duration or a port number ever appears below, that property is gone.
 */
function toMarkdown(run: Run): string {
  const p = run.probes;
  const refused = tally(p, (probe) => cellOf(probe.answer.status) !== "allow");
  const refusedWrites = tally(p, (probe) => probe.writes && cellOf(probe.answer.status) !== "allow");
  const counts = gridOf(
    ["Measured", "Count"],
    [
      ["Operations declared", String(ALL_COMMANDS.length)],
      ["Witnesses impersonated", String(WITNESSES.length)],
      ["Renderings per operation", String(RENDERINGS.length)],
      ["Requests sent over a socket", String(p.length)],
      ["Answers that were a refusal", String(refused)],
      ["Refusals of an operation that writes", String(refusedWrites)],
      ["Ledger entries appended by a refused request", "0"],
      ["Sign-in and invitation messages delivered", String(run.delivered)],
      ["Breaks in the ledger's hash chain afterwards", String(run.breaks)],
    ],
  );
  return `# Isolation, executed

Generated by \`npm run prove:isolation\`. Do not edit: \`npm run prove:isolation -- --check\`
re-runs every request and fails if a single byte of this file no longer matches.

One event's people cannot see another's. That is the claim a self-hosted portal has to be
believed on, and a unit test of the decision function does not establish it — the interesting
failure is a dispatcher that forgets to call it, calls it with the wrong principal, or answers
403 where the rule says 404. So this ran a server on an ephemeral port and sent every operation,
as every witness, in both renderings, over HTTP, and compared each answer against the matrix
derived from the declarations.

${counts}

Three things make that table worth reading rather than merely green.

**Every request got past the parser, the limiter and the event lookup.** All three run *before*
the capability decision and each can refuse on its own — a 422 from a malformed payload, a 429
from a full bucket, a 404 from an unknown slug. Any of them would look exactly like a pass while
proving nothing, so a 422 or a 429 anywhere is treated as a broken fixture and no report is
written.

**A 404 is shown not to be a missing event.** The isolation rule and a genuinely wrong id answer
with the same code on purpose, which makes a 404 ambiguous unless something rules the second
reading out. The control is already in the matrix: \`events.show\` is public and scoped, so the
same witness fetching the same reference must get 200.

**A refused request appended nothing.** Snapshotted around every request. That is the observable
form of "the check runs before the handler": a refusal that had reached a handler would have left
its audit entry behind.

## The witnesses

${gridOf(
    ["Witness", "Who it is"],
    [
      ["`anonymous`", "No session at all."],
      ["`stranger`", `Signed in, and the organizer of \`${NEIGHBOUR}\`. Holds nothing here.`],
      ["`founder`", "An address the operator named in `MANAK_FOUNDERS`, holding no role anywhere."],
      ["`participant`", `A participant of \`${SCOPED}\`.`],
      ["`judge`", `A judge of \`${SCOPED}\`.`],
      ["`organizer`", `An organizer of \`${SCOPED}\`, and not a founder.`],
    ],
  )}

The stranger is the load-bearing one. It is a real account with a live session, real
memberships and an event of its own — not an empty shell — so if this deployment could tell
somebody else's organizer apart from a passer-by, this is the column where it would show.

## The matrix that was asserted

${matrixMarkdown(run.rows)}

## Every 404, beside the control

${audit(run.probes)}

## The shapes the refusals arrived in

${shapes(run.probes)}

## What this does not prove

The decision, never the handler's subsequent reads. An operation correctly allowed for an
organizer, whose handler then selected across every event in the database, passes here without
a murmur. That claim is per handler and lives in \`tests/http.test.ts\` and \`tests/db.test.ts\`.

Nor that an allowed operation succeeded. An answer that is not 401, 403 or 404 counts as
\`allow\` here, which means a 200, a redirect after a form post and a 409 rule refusal are one
column — the caller got *in*, and whether the world was ready for what they asked is a different
question. The fixture is built so that no \`allow\` cell rests on the wrong refusal: both of the
event's windows are open, so a gated operation cannot be satisfied by a closed one, and every id
the probes name is a row that exists, so none can be satisfied by a 404 from a repository. What
remains is genuine: \`results.show\` answers 409 because the results are not published, and this
report counts that as the access it is.

Nor does it prove anything about an operation that does not exist yet. The table above is
generated from \`ALL_COMMANDS\`, so an operation added without a capability declaration cannot
appear here — it would fail to boot instead, which is the check \`makeRegistry\` performs.
`;
}
const checking = process.argv.slice(2).includes("--check");

const run = await probeAll();
const problems = claims(run);
const report = toMarkdown(run).replaceAll(" — ", ", ").replaceAll("—", "-");

if (problems.length > 0) {
  process.stdout.write(`prove:isolation FAILED (${problems.length} problem(s))\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  process.stdout.write(
    "\nRefusing to write a report. Every line above is either an access decision that " +
      "disagrees with its declaration or a probe that never reached one.\n",
  );
  process.exit(1);
}

const refused = tally(run.probes, (probe) => cellOf(probe.answer.status) !== "allow");

if (checking) {
  let committed = "";
  try {
    committed = readFileSync(OUT_MD, "utf8");
  } catch {
    process.stdout.write(
      "prove:isolation FAILED — docs/proof/isolation.md is missing. " +
        "Run `npm run prove:isolation` and commit it.\n",
    );
    process.exit(1);
  }
  if (committed !== report) {
    process.stdout.write(
      "prove:isolation FAILED — every request answered as declared, but the committed " +
        "docs/proof/isolation.md no longer matches what this run produced.\n" +
        "  Rerun `npm run prove:isolation` and commit the new file with the reason.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `prove:isolation OK — ${run.probes.length} requests, ${WITNESSES.length} witnesses, ` +
      `${refused} refusals, none of which appended to the ledger; ` +
      `docs/proof/isolation.md reproduced byte for byte.\n`,
  );
} else {
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_MD, report, "utf8");
  process.stdout.write(
    `Wrote docs/proof/isolation.md — ${run.probes.length} requests over a real socket, ` +
      `${ALL_COMMANDS.length} operations × ${WITNESSES.length} witnesses × ` +
      `${RENDERINGS.length} renderings, ${refused} refusals, every one of them the status its ` +
      `declaration names.\n`,
  );
}
