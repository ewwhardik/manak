/**
 * Submissions: tracks, teams, and the projects that go in them.
 *
 * Ten operations, and two rules set the shape of all of them.
 *
 * **Row-level ownership answers 404, never 403.** A participant who names a project that
 * exists in this event but belongs to another team is told there is no such project. The
 * rule in `capability.ts` — that 403 becomes the honest answer once a caller holds a role —
 * is about the *event*, whose existence is already public. A draft project's existence is
 * not, and answering 403 for a real draft and 404 for a typo would hand anybody with a
 * participant role an oracle for enumerating the drafts in the room. One answer for the
 * whole class costs a legitimate caller nothing: they arrive from a link to their own
 * project, never by guessing.
 *
 * **Editing is a whole-resource replace, in both renderings.** A partial patch cannot be
 * expressed by an HTML form at all — `parseInput` decides absence after trimming, so a
 * cleared box and an omitted key are the same request, and a participant deleting a stale
 * demo link would find it silently preserved. So `projects.update` requires the title and
 * the summary and reads an absent link or track as "clear it", the form arrives prefilled
 * with every field, and a JSON client sends the whole object. `updateProject` still writes
 * only the columns that differ, so the ledger entry names the real change rather than all
 * five fields every time.
 *
 * Two things the schema already enforces are checked here as well, because a CHECK violation
 * surfaces as a 500 and a form saying "is already taken" under the box is the whole
 * difference between a portal and a stack trace: team names are unique per event, and both
 * links must be `https:`. The `url` field kind accepts `http:` — the right rule for a field
 * kind in general, since a self-hosted portal on a private network is a real deployment —
 * and the `project` table does not.
 *
 * The cut line: a team may enter more than one project. The schema declines to forbid it,
 * the organizer's dashboard shows the count, and a validator here would be the second
 * opinion nobody asked for.
 */

import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { InputError } from "../schema.ts";
import type { Field, Fields, Parsed, Problem } from "../schema.ts";
import { notFound, forbidden } from "../errors.ts";
import { EVENT_REF } from "./events.ts";
import {
  addTeamMember,
  createProject,
  projectComments, addProjectComment, hideProjectComment,
  createTeam,
  createTrack,
  disqualifyProject,
  duplicateCases,
  findAccount,
  findProjectIn,
  findTeamIn,
  listProjects,
  listTeams,
  listTracks,
  removeTeamMember,
  rotateTeamInvite,
  submitProject,
  isQuarantined,
  teamMembers,
  teamOf,
  triageDuplicate,
  updateProject,
  withdrawProject,
} from "../../db/index.ts";
import type { Ctx, EventRow, ProjectRow, TeamRow } from "../../db/index.ts";

/** The project a route names. An `id`, not a slug: a project has no human-facing name. */
export const PROJECT_REF: Field = {
  kind: "id",
  label: "Project",
  help: "The project's identifier, as it appears in the URL.",
};

export const TEAM_REF: Field = {
  kind: "id",
  label: "Team",
  help: "The team's identifier, from the team list or from an invitation.",
};

/**
 * A track key, with the table's own CHECK restated as a pattern.
 *
 * Duplicating a constraint is usually how two rules drift apart, and it earns its place
 * here: the alternative is a 500 on a capital letter. The pattern is the one the schema
 * writes as `substr(key,1,1) glob '[a-z0-9]' and key not glob '*[^a-z0-9_-]*'`, and a test
 * in `tests/api.test.ts` sends a key each of them should refuse.
 */
const TRACK_KEY: Field = {
  kind: "text",
  min: 1,
  max: 40,
  pattern: /^[a-z0-9][a-z0-9_-]*$/,
  label: "Track key",
  help: "Lower case, digits, hyphens and underscores. It appears in URLs and in the results table.",
};

function mediaProblems(input: Parsed): Problem[] {
  const problems: Problem[] = [];
  for (const key of ["thumbnailUrl", "videoUrl", "imageUrls"]) {
    const links = String(input[key] ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (key === "imageUrls" && links.length > 8) problems.push({ field: key, message: "Use at most eight screenshots." });
    for (const link of links) {
      try { const url = new URL(link); if (url.protocol !== "https:" || url.username || url.password) throw new Error("url"); }
      catch { problems.push({ field: key, message: "Use HTTPS links without embedded credentials." }); break; }
    }
  }
  return problems;
}

const PROJECT_FIELDS: Fields = {
  tagline: { kind: "text", max: 200, optional: true, label: "One-line pitch" },
  description: { kind: "text", max: 20000, multiline: true, optional: true, label: "The full story", help: "Explain the problem, your approach, what works, and what you learned." },
  thumbnailUrl: { kind: "url", optional: true, label: "Cover image URL", help: "Optional HTTPS image. The portal also works without external images." },
  videoUrl: { kind: "url", optional: true, label: "Demo video URL" },
  imageUrls: { kind: "text", max: 16000, multiline: true, optional: true, label: "Screenshot URLs", help: "Up to eight HTTPS image links, one per line." },
  techTags: { kind: "text", max: 1000, optional: true, label: "Technologies", help: "Comma-separated tags, for example TypeScript, SQLite, WebCrypto." },
  answers: { kind: "text", max: 12000, multiline: true, optional: true, label: "Answers to event questions", help: "Answer the organizer’s questions in order. These answers appear on your public project page." },

  title: {
    kind: "text",
    min: 1,
    max: 200,
    label: "Project title",
    help: "What the judges will see at the top of the page.",
  },
  summary: {
    kind: "text",
    min: 1,
    max: 4000,
    multiline: true,
    label: "What it does",
    help: "What you built and what it is for. This is the first thing a judge reads.",
  },
  repoUrl: {
    kind: "url",
    optional: true,
    label: "Source code",
    help: "An https link to the repository. Judges will open it.",
  },
  demoUrl: {
    kind: "url",
    optional: true,
    label: "Demo",
    help: "An https link to something running, or to a recording. Optional.",
  },
  // `text` and not `enum`, deliberately. The choices live in the `track` table and vary per
  // event, and a field declaration is a static thing that the published document and the
  // form controls are both generated from — an `enum` here could only carry the tracks of
  // whichever event was being looked at, which is a declaration that lies for every other
  // one. So the shape is checked by the field and the membership by the handler, which is
  // where the event is known, and the refusal names the tracks that do exist.
  trackKey: { ...TRACK_KEY, optional: true, label: "Track", help: "Which track to enter. Leave empty if the event has none." },
};

/** A stated reason, for the two operations an organizer performs on somebody else's work. */
const REASON: Field = {
  kind: "text",
  min: 3,
  max: 1000,
  multiline: true,
  label: "Reason",
  help: "The team will be shown this. It goes on the record either way.",
};

/**
 * One project, as JSON. Exported because the dashboard and the results tier publish the
 * same shape, and two mappings of one row drift by a field the first time somebody adds one.
 */
export const PROJECT_SUMMARY: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    teamId: { type: "string" },
    teamName: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    tagline: { type: "string" },
    description: { type: "string" },
    thumbnailUrl: { type: "string" },
    videoUrl: { type: "string" },
    imageUrls: { type: "string" },
    techTags: { type: "string" },
    answers: { type: "string" },

    repoUrl: { type: ["string", "null"] },
    demoUrl: { type: ["string", "null"] },
    trackKey: { type: ["string", "null"] },
    status: { type: "string", enum: ["draft", "submitted", "withdrawn", "disqualified"] },
    createdAt: { type: "integer" },
    savedAt: { type: ["integer", "null"] },
    submittedAt: { type: ["integer", "null"] },
    withdrawnAt: { type: ["integer", "null"] },
    quarantined: { type: "boolean" },
  },
  required: ["id", "teamId", "title", "summary", "status", "createdAt"],
};

export function projectJson(
  project: ProjectRow,
  teamName?: string,
): Record<string, unknown> {
  return {
    id: project.id,
    teamId: project.team_id,
    ...(teamName === undefined ? {} : { teamName }),
    title: project.title,
    summary: project.summary,
    tagline: project.tagline ?? "",
    description: project.description ?? "",
    thumbnailUrl: project.thumbnail_url ?? "",
    videoUrl: project.video_url ?? "",
    imageUrls: project.image_urls ?? "",
    techTags: project.tech_tags ?? "",
    answers: project.answers ?? "",

    repoUrl: project.repo_url,
    demoUrl: project.demo_url,
    trackKey: project.track_key,
    status: project.status,
    createdAt: project.created_at,
    savedAt: project.saved_at,
    submittedAt: project.submitted_at,
    withdrawnAt: project.withdrawn_at,
    quarantined: isQuarantined(project),
  };
}

/** The project a route names, or a 404 that does not admit whether it exists. */
function projectIn(ctx: Ctx, eventId: string, id: string): ProjectRow {
  const project = findProjectIn(ctx.db, eventId, id);
  if (project === undefined) throw notFound("project", id);
  return project;
}

/**
 * The same, refusing anything that is not the caller's own. See the file header for why the
 * refusal is a 404.
 *
 * This is the row-level half of `capability.owner`, which is declaration-only: `decide` has
 * established that the caller is a participant of this event and nothing more. Every command
 * declaring `owner: "team"` calls this, and `tests/api.test.ts` asserts that correspondence
 * rather than trusting it.
 */
function ownProject(ctx: Ctx, eventId: string, id: string, accountId: string | null): ProjectRow {
  const project = projectIn(ctx, eventId, id);
  const team = accountId === null ? undefined : teamOf(ctx.db, eventId, accountId);
  if (team === undefined || team.id !== project.team_id) throw notFound("project", id);
  return project;
}

/**
 * The two link fields, against the table's CHECK rather than the field kind's rule.
 *
 * Returned as problems rather than thrown, so a submission with a bad repo link *and* an
 * unknown track comes back with both marked. Answering one problem per request is how a form
 * takes four attempts to fill in.
 */
function httpsProblems(input: Parsed): Problem[] {
  const problems: Problem[] = [];
  for (const field of ["repoUrl", "demoUrl"]) {
    const value = input[field];
    if (typeof value === "string" && !value.startsWith("https://")) {
      problems.push({
        field,
        message: "has to be an https link. Judges open these from a browser, and this one is not encrypted.",
      });
    }
  }
  return problems;
}

/**
 * The named track, if the event has it.
 *
 * A foreign key stands behind this (`references track (event_id, key) on delete restrict`),
 * so the only thing being bought here is the wording: SQLite would answer with a constraint
 * failure and a 500, and this answers with the list of tracks that do exist.
 */
function trackProblem(ctx: Ctx, eventId: string, value: unknown): Problem | null {
  if (typeof value !== "string" || value === "") return null;
  const tracks = listTracks(ctx.db, eventId);
  if (tracks.some((track) => track.key === value)) return null;
  return {
    field: "trackKey",
    message:
      tracks.length === 0
        ? "was given, but this event has no tracks. Leave it empty."
        : `is not a track in this event. The choices are ${tracks.map((t) => t.key).join(", ")}.`,
  };
}

/** Every team in the event by id, for lists that would otherwise read one row per project. */
function teamNames(ctx: Ctx, eventId: string): Map<string, string> {
  return new Map(listTeams(ctx.db, eventId).map((team) => [team.id, team.name]));
}

/** The browser path of a page in this tier, for the redirects. */
function at(input: Parsed, ...rest: string[]): string {
  const event = encodeURIComponent(String(input.event));
  return [`/events/${event}`, ...rest.map((part) => encodeURIComponent(part))].join("/");
}

/**
 * Declare a track.
 *
 * Tracks are additive and there is no `tracks.remove`, which is the one decision in this
 * command worth defending. The foreign key from `project` is `on delete restrict`, so a
 * removal would either fail once anything had entered — the common case, and a refusal an
 * organizer cannot act on — or need a rehoming step that is a different operation with a
 * different shape. An organizer who mistypes a key adds the right one and leaves the wrong
 * one empty; an empty track costs a row and a line on the dashboard.
 */
export const trackCreate = defineCommand({
  name: "tracks.create",
  summary: "Add a track to an event.",
  method: "POST",
  path: "/api/events/:event/tracks",
  capability: { audience: "organizer", scope: "event" },
  input: {
    event: EVENT_REF,
    key: TRACK_KEY,
    label: {
      kind: "text",
      min: 1,
      max: 120,
      label: "Track name",
      help: "What participants will see. “Best use of local models”, not “local-models”.",
    },
    ordering: {
      kind: "int",
      min: 0,
      max: 999,
      fallback: 0,
      label: "Position",
      help: "Lower numbers come first. Ties are broken by key, so leaving this alone lists them alphabetically.",
    },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        track: {
          type: "object",
          properties: { key: { type: "string" }, label: { type: "string" }, ordering: { type: "integer" } },
          required: ["key", "label", "ordering"],
        },
      },
      required: ["track"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["track.created"],
  form: { title: "Add a track", submit: "Add track", redirect: ({ input }) => at(input, "dashboard") },
  handler: ({ ctx, input, event }) => {
    const row = event as EventRow;
    const key = String(input.key);
    if (listTracks(ctx.db, row.id).some((track) => track.key === key)) {
      // A primary key stands behind this. The 422 is for the wording: a duplicate key is
      // fixed by choosing another one, which is this product's test for 422 against 409.
      throw new InputError([{ field: "key", message: "is already a track in this event." }]);
    }
    const track = createTrack(ctx, row.id, {
      key,
      label: String(input.label),
      ordering: Number(input.ordering),
    });
    return { track: { key: track.key, label: track.label, ordering: track.ordering } };
  },
});

/**
 * The teams in an event, so somebody arriving second can find the one they belong to.
 *
 * `participant` and not `public`, for the reason `events.judges` is organizer-only: a roster
 * is a list of people. Team *names* are shouted across the room at a hackathon and are not
 * the sensitive part, so what is published is the name, the size, and which one is yours —
 * never who is on somebody else's.
 */
export const teamList = defineCommand({
  name: "teams.list",
  summary: "List the teams in an event.",
  method: "GET",
  path: "/api/events/:event/teams",
  capability: { audience: "participant", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        teams: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              size: { type: "integer" },
              yours: { type: "boolean" },
            },
            required: ["id", "name", "size", "yours"],
          },
        },
        yours: { type: ["string", "null"], description: "The id of the caller's team, if they are on one." },
      },
      required: ["teams", "yours"],
    },
  },
  handler: ({ ctx, event, accountId }) => {
    const row = event as EventRow;
    const own = accountId === null ? undefined : teamOf(ctx.db, row.id, accountId);
    return {
      teams: listTeams(ctx.db, row.id).map((team) => ({
        id: team.id,
        name: team.name,
        size: team.members.length,
        yours: team.id === own?.id,
      })),
      yours: own?.id ?? null,
    };
  },
});

/**
 * Join a team.
 *
 * A POST to a *members* collection rather than a `join` verb, because a membership is a thing
 * that comes into existence and the URL says so. There is no invitation and no approval step:
 * a team id is not a secret, everybody who can read it already holds a role in this event, and
 * a hackathon settles who is on which team by talking. The schema's one-team-per-event rule
 * does the rest — `addTeamMember` raises `team.alreadyJoined` naming the team the caller is
 * already on, which is the fact they need to act on.
 *
 * Gated on submissions, so a team cannot gain a member after the deadline. The reason is the
 * ledger rather than fairness: `team.joined` after the close would put somebody's name on work
 * they had no hand in, and the roster is what a prize is awarded against.
 */
export const teamJoin = defineCommand({
  name: "teams.join",
  summary: "Join a team in an event.",
  method: "POST",
  path: "/api/events/:event/teams/:team/members",
  capability: { audience: "participant", scope: "event", gate: "submissions" },
  input: { event: EVENT_REF, team: TEAM_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        team: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
          required: ["id", "name", "size"],
        },
      },
      required: ["team"],
    },
  },
  limit: "submission",
  records: ["team.joined"],
  form: { title: "Join this team", submit: "Join", redirect: ({ input }) => at(input, "teams") },
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const team = findTeamIn(ctx.db, row.id, String(input.team));
    if (team === undefined) throw notFound("team", String(input.team));
    addTeamMember(ctx, team, accountId ?? "");
    return {
      team: { id: team.id, name: team.name, size: teamMembers(ctx.db, row.id, team.id).length },
    };
  },
});

export const teamLeave = defineCommand({
  name: "teams.leave",
  summary: "Leave a team in an event.",
  method: "POST",
  path: "/api/events/:event/teams/:team/leave",
  capability: { audience: "participant", scope: "event", gate: "submissions" },
  input: { event: EVENT_REF, team: TEAM_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        team: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
          required: ["id", "name", "size"],
        },
      },
      required: ["ok", "team"],
    },
  },
  limit: "submission",
  records: ["team.left"],
  form: { title: "Leave this team", submit: "Leave team", redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/teams` },
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const team = findTeamIn(ctx.db, row.id, String(input.team));
    if (team === undefined) throw notFound("team", String(input.team));
    removeTeamMember(ctx, team, accountId ?? "");
    return {
      ok: true,
      team: { id: team.id, name: team.name, size: teamMembers(ctx.db, row.id, team.id).length },
    };
  },
});

export const teamInviteRotate = defineCommand({
  name: "teams.invite_rotate",
  summary: "Rotate the private invitation link for this team.",
  method: "POST",
  path: "/api/events/:event/teams/:team/invites/rotate",
  capability: { audience: "participant", scope: "event", gate: "submissions" },
  input: { event: EVENT_REF, team: TEAM_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        teamId: { type: "string" },
        code: { type: "string" },
        generation: { type: "integer" },
      },
      required: ["teamId", "code", "generation"],
    },
  },
  limit: "submission",
  records: ["team.invite_rotated"],
  form: { title: "Rotate team invite", submit: "Rotate invite", redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/teams` },
  handler: ({ ctx, input, event, accountId, roles }) => {
    const row = event as EventRow;
    const team = findTeamIn(ctx.db, row.id, String(input.team));
    if (team === undefined) throw notFound("team", String(input.team));
    const members = teamMembers(ctx.db, row.id, team.id);
    if (!roles.includes("organizer") && !members.includes(accountId ?? "")) {
      throw forbidden("Only team members or organizers may rotate team invites.");
    }
    const result = rotateTeamInvite(ctx, row.id, team.id);
    return {
      teamId: team.id,
      code: result.code,
      generation: result.generation,
    };
  },
});

/**
 * The projects in an event, as much of them as this caller may see.
 *
 * Public, and the answer differs by who is asking: a stranger and a judge see submitted work,
 * a participant additionally sees their own team's drafts, and an organizer sees everything
 * including the disqualified. So the result publishes `visibility` — a client that got three
 * rows learns whether that is the whole event or the public slice of it, and a page can say
 * "drafts are only visible to your team" instead of looking broken.
 *
 * One query, narrowed in memory, rather than three queries with different predicates. It reads
 * every project in the event to show a stranger a subset, which is the honest cost: at
 * hackathon scale that is hundreds of rows, and the alternative is a second predicate that has
 * to be kept in step with this one.
 */
export const list = defineCommand({
  name: "projects.list",
  summary: "List the projects entered in an event.",
  method: "GET",
  path: "/api/events/:event/projects",
  capability: { audience: "public", scope: "event" },
  input: {
    event: EVENT_REF,
    trackKey: { ...TRACK_KEY, optional: true, label: "Track", help: "Show only this track. Leave empty for all of them." },
    q: { kind: "text", max: 200, optional: true, label: "Search projects" },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        projects: { type: "array", items: PROJECT_SUMMARY },
        visibility: {
          type: "string",
          enum: ["public", "team", "organizer"],
          description: "Which slice of the event this list is. Only `organizer` is all of it.",
        },
        tracks: { type: "array", items: { type: "object" } },
      },
      required: ["projects", "visibility"],
    },
  },
  handler: ({ ctx, input, event, roles, accountId }) => {
    const row = event as EventRow;
    const filter = typeof input.trackKey === "string" ? { trackKey: input.trackKey } : {};
    const organizer = roles.includes("organizer");
    const own = accountId === null || organizer ? undefined : teamOf(ctx.db, row.id, accountId);
    const names = teamNames(ctx, row.id);
    const all = listProjects(ctx.db, row.id, filter);
    const query = String(input.q ?? "").toLocaleLowerCase().trim();
    const visible = organizer
      ? all
      : all.filter((p) => (p.status === "submitted" && !isQuarantined(p)) ||
        (own !== undefined && p.team_id === own.id));
    return {
      projects: visible.filter((p) => {
        return !query || [p.title, p.tagline, p.description, p.tech_tags, p.summary, p.track_key ?? "", names.get(p.team_id) ?? ""]
          .join(" ").toLocaleLowerCase().includes(query);
      }).map((p) => projectJson(p, names.get(p.team_id))),
      visibility: organizer ? "organizer" : own === undefined ? "public" : "team",
      tracks: listTracks(ctx.db, row.id).map((t) => ({ key: t.key, label: t.label })),
    };
  },
});

/**
 * One project.
 *
 * A submitted project is public: a link in somebody's write-up should resolve, and the work is
 * what the event is for. Anything else — a draft, a withdrawal, a disqualification — is a 404
 * to everybody but its own team and an organizer, using the same code and the same words as a
 * project that does not exist. See the file header.
 *
 * `yours` and `mayEdit` are published rather than left for a client to infer, because the
 * inference needs the gate as well as the ownership and a page that guessed would show an edit
 * button that answers 409 after the deadline.
 */
export const show = defineCommand({
  name: "projects.show",
  summary: "Show one project.",
  method: "GET",
  path: "/api/events/:event/projects/:project",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        project: PROJECT_SUMMARY,
        team: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
          required: ["id", "name", "size"],
        },
        comments: { type: "array", items: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, author: { type: "string" }, at: { type: "integer" } }, required: ["id", "body", "author", "at"] } },
        yours: { type: "boolean" },
        mayEdit: { type: "boolean" },
        mayModerate: { type: "boolean" },
      },
      required: ["project", "team", "comments", "yours", "mayEdit", "mayModerate"],
    },
  },
  handler: ({ ctx, input, event, gates, roles, accountId }) => {
    const row = event as EventRow;
    const project = projectIn(ctx, row.id, String(input.project));
    const organizer = roles.includes("organizer");
    const own = accountId === null ? undefined : teamOf(ctx.db, row.id, accountId);
    const yours = own !== undefined && own.id === project.team_id;
    if ((project.status !== "submitted" || isQuarantined(project)) && !organizer && !yours) {
      throw notFound("project", project.id);
    }
    const team = findTeamIn(ctx.db, row.id, project.team_id);
    return {
      project: projectJson(project, team?.name),
      comments: projectComments(ctx.db, row.id, project.id),
      team: {
        id: project.team_id,
        name: team?.name ?? "",
        size: teamMembers(ctx.db, row.id, project.team_id).length,
      },
      yours,
      mayEdit: yours && gates?.submissionsOpen === true && project.status !== "disqualified",
      // Published rather than inferred by the page, for the reason the view layer's header
      // gives: a view is handed a result and cannot ask the database a question. Both of these
      // decide which forms are drawn and neither protects anything — `projects.pull` refuses a
      // non-organizer whether or not a button was rendered.
      mayModerate: organizer,
    };
  },
});

/**
 * Enter a project, creating the team on the way in if there is not one yet.
 *
 * The team is folded into this command rather than being a prerequisite, and that is the one
 * design decision in the tier that a reviewer should push on. Two operations would be the
 * tidier model. It would also mean a solo entrant — the common case at every hackathon I have
 * watched — filling in a form called "create a team" with their own name in it before being
 * allowed near the form they came for, at the hour when the thing they are short of is minutes.
 * So `teamName` is optional and falls back to the account's display name, and somebody working
 * alone answers one form. Somebody who is already on a team never sees the field matter:
 * naming it is refused rather than silently ignored, because a participant who typed a new name
 * meant to change something and this command is not how.
 *
 * Three writes in one transaction. The gate has already been checked by the dispatcher, so
 * `createProject` cannot refuse after the team exists — but a savepoint costs nothing and an
 * orphan team named after somebody who never entered is a row an organizer would have to
 * explain.
 */
export const create = defineCommand({
  name: "projects.create",
  summary: "Enter a project into an event.",
  method: "POST",
  path: "/api/events/:event/projects",
  capability: { audience: "participant", scope: "event", gate: "submissions" },
  input: {
    event: EVENT_REF,
    teamName: {
      kind: "text",
      min: 1,
      max: 120,
      optional: true,
      label: "Team name",
      help: "Only needed the first time. Leave it empty to enter under your own name.",
    },
    ...PROJECT_FIELDS,
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        project: PROJECT_SUMMARY,
        team: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, created: { type: "boolean" } },
          required: ["id", "name", "created"],
        },
      },
      required: ["project", "team"],
    },
  },
  limit: "submission",
  records: ["team.created", "team.joined", "project.created"],
  form: {
    title: "Enter a project",
    submit: "Save as draft",
    redirect: ({ input, result }) =>
      at(input, "projects", (result as { project: { id: string } }).project.id),
  },
  notes:
    "Saves a draft. Nothing is entered until `projects.submit`, and the draft is visible only " +
    "to the team and the organizers until then.",
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const account = accountId ?? "";
    const problems: Problem[] = [...httpsProblems(input), ...mediaProblems(input)];
    const trackIssue = trackProblem(ctx, row.id, input.trackKey);
    if (trackIssue !== null) problems.push(trackIssue);

    const existing = teamOf(ctx.db, row.id, account);
    const wanted = typeof input.teamName === "string" ? input.teamName.trim() : "";
    const fallback = (findAccount(ctx.db, account)?.display_name ?? "").trim();
    const name = wanted !== "" ? wanted : fallback;
    if (existing === undefined) {
      if (name === "") {
        problems.push({
          field: "teamName",
          message: "is needed: this account has no display name to enter under.",
        });
      } else if (listTeams(ctx.db, row.id).some((team) => team.name === name)) {
        // `unique (event_id, name)` stands behind this, and a raw constraint failure here is
        // a 500 on the deadline. Same trade as the taken slug in `events.create`.
        problems.push({ field: "teamName", message: "is already taken by another team here." });
      }
    } else if (wanted !== "" && wanted !== existing.name) {
      problems.push({
        field: "teamName",
        message: `cannot be set here: you are already on ${existing.name}, and this form does not rename it.`,
      });
    }
    if (problems.length > 0) throw new InputError(problems);

    return ctx.db.tx(() => {
      let team: TeamRow;
      if (existing === undefined) {
        team = createTeam(ctx, row.id, name);
        addTeamMember(ctx, team, account);
      } else {
        team = existing;
      }
      const project = createProject(ctx, row, team, {
        title: String(input.title),
        summary: String(input.summary),
      tagline: String(input.tagline ?? ""),
      description: String(input.description ?? ""),
      thumbnailUrl: String(input.thumbnailUrl ?? ""),
      videoUrl: String(input.videoUrl ?? ""),
      imageUrls: String(input.imageUrls ?? ""),
      techTags: String(input.techTags ?? ""),
      answers: String(input.answers ?? ""),

        repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : null,
        demoUrl: typeof input.demoUrl === "string" ? input.demoUrl : null,
        trackKey: typeof input.trackKey === "string" ? input.trackKey : null,
      });
      return {
        project: projectJson(project, team.name),
        team: { id: team.id, name: team.name, created: existing === undefined },
      };
    });
  },
});

/**
 * Edit a project. A whole-resource replace — see the file header for why a patch is not on
 * offer — and refused once submissions close, draft or not.
 *
 * `owner: "team"` is a declaration and not a check: `decide` never reads it, so `ownProject`
 * is what actually holds the line. The declaration is what puts the requirement in the
 * published document and in the capability matrix, and `tests/api.test.ts` asserts that every
 * command claiming it calls the function.
 */
export const update = defineCommand({
  name: "projects.update",
  summary: "Replace a project's details.",
  method: "POST",
  path: "/api/events/:event/projects/:project",
  capability: { audience: "participant", scope: "event", owner: "team", gate: "submissions" },
  input: { event: EVENT_REF, project: PROJECT_REF, ...PROJECT_FIELDS },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: { project: PROJECT_SUMMARY, changed: { type: "boolean" } },
      required: ["project", "changed"],
    },
  },
  limit: "submission",
  records: ["project.updated"],
  form: {
    title: "Edit this project",
    submit: "Save changes",
    redirect: ({ input }) => at(input, "projects", String(input.project)),
  },
  notes:
    "Every field is sent, every time. An empty link or track clears it, because a form cannot " +
    "tell the difference between a box somebody cleared and a field they left out.",
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const project = ownProject(ctx, row.id, String(input.project), accountId);
    const problems: Problem[] = [...httpsProblems(input), ...mediaProblems(input)];
    const trackIssue = trackProblem(ctx, row.id, input.trackKey);
    if (trackIssue !== null) problems.push(trackIssue);
    if (problems.length > 0) throw new InputError(problems);
    const next = updateProject(ctx, row, project, {
      title: String(input.title),
      summary: String(input.summary),
      tagline: String(input.tagline ?? ""),
      description: String(input.description ?? ""),
      thumbnailUrl: String(input.thumbnailUrl ?? ""),
      videoUrl: String(input.videoUrl ?? ""),
      imageUrls: String(input.imageUrls ?? ""),
      techTags: String(input.techTags ?? ""),
      answers: String(input.answers ?? ""),

      repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : null,
      demoUrl: typeof input.demoUrl === "string" ? input.demoUrl : null,
      trackKey: typeof input.trackKey === "string" ? input.trackKey : null,
    });
    return { project: projectJson(next), changed: next !== project };
  },
});

/**
 * Submit.
 *
 * No confirmation field. A checkbox saying "I really mean it" beside a button labelled "Submit
 * project" is one more thing to misread at the deadline, and the operation is idempotent and
 * reversible: submitting twice is a no-op, and a team who changes their mind edits and submits
 * again while the window is open.
 *
 * `msToSpare` is published because it is the number a dispute is about, and it is computed from
 * the same two values the ledger entry records rather than from a second clock.
 */
export const submit = defineCommand({
  name: "projects.submit",
  summary: "Submit a project for judging.",
  method: "POST",
  path: "/api/events/:event/projects/:project/submit",
  capability: { audience: "participant", scope: "event", owner: "team", gate: "submissions" },
  input: { event: EVENT_REF, project: PROJECT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        project: PROJECT_SUMMARY,
        msToSpare: {
          type: "integer",
          description: "Milliseconds between this submission and the deadline. It is also on the record.",
        },
      },
      required: ["project", "msToSpare"],
    },
  },
  limit: "submission",
  records: ["project.submitted"],
  form: {
    title: "Submit this project",
    submit: "Submit project",
    redirect: ({ input }) => at(input, "projects", String(input.project)),
  },
  handler: ({ ctx, input, event, accountId, now }) => {
    const row = event as EventRow;
    const project = ownProject(ctx, row.id, String(input.project), accountId);
    return {
      project: projectJson(submitProject(ctx, row, project)),
      msToSpare: row.submissions_close_at - now,
    };
  },
});

/**
 * Withdraw, by the team, while the window is open.
 *
 * The gate is the whole rule and the repository holds it: after submissions close a team cannot
 * withdraw, and the reason is judging integrity rather than paperwork. A team who could withdraw
 * during scoring could watch a low ballot arrive and remove the evidence, and every other
 * project's normalized rank would move with it. After the close it takes an organizer, which is
 * `projects.pull`.
 *
 * `submitted_at` survives a withdrawal. That the work was in before the cutoff is exactly what a
 * dispute is about, and a schema CHECK holds the two columns consistent so no path here can lose
 * it.
 */
export const withdraw = defineCommand({
  name: "projects.withdraw",
  summary: "Withdraw a project from an event.",
  method: "POST",
  path: "/api/events/:event/projects/:project/withdraw",
  capability: { audience: "participant", scope: "event", owner: "team", gate: "submissions" },
  input: {
    event: EVENT_REF,
    project: PROJECT_REF,
    reason: { ...REASON, optional: true, help: "Optional, and only the organizers will read it." },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: { project: PROJECT_SUMMARY },
      required: ["project"],
    },
  },
  limit: "submission",
  records: ["project.withdrawn"],
  form: {
    title: "Withdraw this project",
    submit: "Withdraw",
    redirect: ({ input }) => at(input, "projects", String(input.project)),
  },
  notes: "Reversible while submissions are open: submitting again clears the withdrawal.",
  handler: ({ ctx, input, event, accountId }) => {
    const row = event as EventRow;
    const project = ownProject(ctx, row.id, String(input.project), accountId);
    const reason = typeof input.reason === "string" ? input.reason : "";
    return { project: projectJson(withdrawProject(ctx, row, project, { reason })) };
  },
});

/**
 * Withdraw on a team's behalf, after the deadline, as an organizer.
 *
 * This exists because the alternative is worse. "A team emailed to say they are pulling out"
 * happens at every event, it happens after the close more often than before it, and without this
 * command the only route to the same row is `projects.disqualify` — which writes
 * `project.disqualified` into a ledger the team is shown and a results export anybody can read.
 * Recording a withdrawal as misconduct to work around a missing operation is the kind of thing
 * an audit trail exists to prevent, not to perform.
 *
 * No gate, and the reason is required. The ledger entry carries `by_organizer: true` and
 * `after_close`, so the record distinguishes this from a team's own withdrawal without needing a
 * second action name.
 */
export const pull = defineCommand({
  name: "projects.pull",
  summary: "Withdraw a project on a team's behalf.",
  method: "POST",
  path: "/api/events/:event/projects/:project/pull",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF, reason: REASON },
  returns: {
    kind: "json",
    schema: { type: "object", properties: { project: PROJECT_SUMMARY }, required: ["project"] },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["project.withdrawn"],
  form: {
    title: "Withdraw this project",
    submit: "Withdraw it",
    redirect: ({ input }) => at(input, "dashboard"),
  },
  notes:
    "For a team that asked to be pulled. It is not a penalty and it is not recorded as one — " +
    "use `projects.disqualify` when the finding is against the team.",
  handler: ({ ctx, input, event }) => {
    const row = event as EventRow;
    const project = projectIn(ctx, row.id, String(input.project));
    return {
      project: projectJson(
        withdrawProject(ctx, row, project, { byOrganizer: true, reason: String(input.reason) }),
      ),
    };
  },
});

/**
 * Disqualify.
 *
 * No gate, because the reason to disqualify almost always surfaces during judging — a judge
 * opens the repository and finds the commits predate the event. A written reason is required and
 * it is not a formality: the ledger entry is what the team is shown, and "disqualified" with no
 * sentence after it is how an event acquires a story about being arbitrary.
 *
 * A disqualified project cannot be edited or resubmitted by its team, and it stays out of the
 * judgeable pool, but its row and its `submitted_at` remain. Deleting it would remove the thing
 * an appeal is about.
 */
export const disqualify = defineCommand({
  name: "projects.disqualify",
  summary: "Disqualify a project, with a stated reason.",
  method: "POST",
  path: "/api/events/:event/projects/:project/disqualify",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF, reason: REASON },
  returns: {
    kind: "json",
    schema: { type: "object", properties: { project: PROJECT_SUMMARY }, required: ["project"] },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["project.disqualified"],
  form: {
    title: "Disqualify this project",
    submit: "Disqualify",
    redirect: ({ input }) => at(input, "dashboard"),
  },
  notes: "The reason is written to the ledger and shown to the team. There is no way to reverse it.",
  handler: ({ ctx, input, event }) => {
    const row = event as EventRow;
    const project = projectIn(ctx, row.id, String(input.project));
    return { project: projectJson(disqualifyProject(ctx, row, project, String(input.reason))) };
  },
});

export const commentAdd = defineCommand({
  name: "comments.add", summary: "Comment on a submitted project.", method: "POST",
  path: "/api/events/:event/projects/:project/comments", capability: { audience: "account", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF, body: { kind: "text", min: 1, max: 2000, multiline: true, label: "Your comment" } },
  returns: { kind: "json", schema: { type: "object", properties: { saved: { type: "boolean" } }, required: ["saved"] } },
  limit: "vote", records: ["comment.created"],
  form: { title: "Join the conversation", submit: "Post comment", redirect: ({ input }) => at(input, "projects", String(input.project)) },
  handler: ({ ctx, input, event }) => { addProjectComment(ctx, event as EventRow, String(input.project), String(input.body)); return { saved: true }; },
});

export const commentHide = defineCommand({
  name: "comments.hide", summary: "Hide a project comment with an audited reason.", method: "POST",
  path: "/api/events/:event/projects/:project/comments/hide", capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF, comment: { kind: "text", min: 1, max: 20, pattern: /^[0-9]+$/, label: "Comment identifier" }, reason: REASON },
  returns: { kind: "json", schema: { type: "object", properties: { hidden: { type: "boolean" } }, required: ["hidden"] } },
  limit: "organize", records: ["comment.hidden"],
  form: { title: "Moderate comment", submit: "Hide comment", redirect: ({ input }) => at(input, "projects", String(input.project)) },
  handler: ({ ctx, input, event }) => { hideProjectComment(ctx, event as EventRow, String(input.project), String(input.comment), String(input.reason)); return { hidden: true }; },
});

export const duplicateList = defineCommand({
  name: "duplicates.list", summary: "Review quarantined project collisions.", method: "GET",
  path: "/api/events/:event/manage/duplicates",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "json", schema: { type: "object", properties: {
    cases: { type: "array", items: { type: "object" } },
  }, required: ["cases"] } },
  handler: ({ ctx, event }) => ({ cases: duplicateCases(ctx.db, (event as EventRow).id).map(({ project, prior }) => ({
    project: { id: project.id, title: project.title, repoUrl: project.repo_url,
      submittedAt: project.submitted_at, status: project.status },
    prior: { id: prior.id, title: prior.title, repoUrl: prior.repo_url,
      submittedAt: prior.submitted_at, status: prior.status },
    reason: project.duplicate_reason, decision: project.duplicate_decision,
  })) }),
});

export const duplicateTriage = defineCommand({
  name: "duplicates.triage", summary: "Confirm or clear a quarantined project.", method: "POST",
  path: "/api/events/:event/manage/duplicates/triage",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, project: PROJECT_REF,
    decision: { kind: "enum", values: ["confirmed", "cleared"], label: "Decision" },
    reason: REASON },
  returns: { kind: "json", schema: { type: "object", properties: {
    project: PROJECT_SUMMARY }, required: ["project"] } },
  limit: "organize", records: ["project.duplicate_confirmed", "project.duplicate_cleared"],
  form: { title: "Resolve duplicate flag", submit: "Save decision",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/manage/duplicates` },
  handler: ({ ctx, event, input }) => ({
    project: projectJson(triageDuplicate(ctx, (event as EventRow).id, String(input.project),
      input.decision as "confirmed" | "cleared", String(input.reason))),
  }),
});

export const PROJECT_COMMANDS: readonly Command[] = [
  commentAdd, commentHide,
  trackCreate,
  teamList,
  teamJoin,
  teamLeave,
  teamInviteRotate,
  list,
  show,
  create,
  update,
  submit,
  withdraw,
  pull,
  disqualify,
  duplicateList, duplicateTriage,
];
