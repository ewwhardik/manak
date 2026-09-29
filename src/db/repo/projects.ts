/**
 * Teams and their submissions.
 *
 * The deadline lives here, in `submitProject` and `updateProject`, and it is the
 * same `assertGate` the rest of the system uses — there is no second implementation
 * of "is it too late". Both functions take the decision from the event row rather
 * than from a flag on the project, so an organizer who extends a deadline extends it
 * for work already in progress, which is what extending a deadline means.
 *
 * A withdrawn project keeps its `submitted_at`. The fact that it was in before the
 * cutoff is exactly what a dispute is about, and a schema CHECK holds the two
 * columns consistent so no code path can lose it.
 */

import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import type { EventRow } from "./events.ts";
import { assertGate } from "./events.ts";

/** Comments are append-only ledger records; moderation adds a separate tombstone. */
export function projectComments(db: Db, eventId: string, projectId: string) {
  return db.all<{ id: string; body: string; author: string; at: number }>(
    `select cast(l.seq as text) as id, json_extract(l.payload, '$.body') as body,
      coalesce(a.display_name, 'Former member') as author, l.at
      from ledger l left join account a on a.id = l.actor_id
      where l.event_id = :event and l.subject = :project and l.action = 'comment.created'
      and not exists (select 1 from ledger h where h.event_id = l.event_id
        and h.action = 'comment.hidden' and h.subject = cast(l.seq as text))
      order by l.seq desc limit 100`, { event: eventId, project: projectId });
}

export function addProjectComment(ctx: Ctx, event: EventRow, projectId: string, body: string): void {
  const project = findProjectIn(ctx.db, event.id, projectId);
  if (!project || project.status !== "submitted" || isQuarantined(project)) throw new RuleError("comment.unavailable", "Comments require an active submitted project.");
  if (event.archived_at !== null) throw new RuleError("event.archived", "This event is archived.");
  if (!ctx.actorId || !body.trim() || body.length > 2000) throw new RuleError("comment.invalid", "Sign in and write a comment of 1–2000 characters.");
  ctx.recorded({ action: "comment.created", eventId: event.id, subject: projectId,
    payload: { body: body.trim() } }, () => {});
}

export function hideProjectComment(ctx: Ctx, event: EventRow, projectId: string, comment: string, reason: string): void {
  const row = ctx.db.get<{ seq: number }>(`select seq from ledger where event_id = :event
    and subject = :project and action = 'comment.created' and cast(seq as text) = :comment`,
  { event: event.id, project: projectId, comment });
  if (!row) throw new RuleError("comment.unavailable", "No comment on this project has that identifier.");
  if (reason.trim().length < 3) throw new RuleError("comment.reason", "Explain why this comment is being hidden.");
  ctx.recorded({ action: "comment.hidden", eventId: event.id, subject: comment,
    payload: { reason: reason.trim(), project: projectId } }, () => {});
}

export type TeamRow = { id: string; event_id: string; name: string; created_at: number };

export type ProjectStatus = "draft" | "submitted" | "withdrawn" | "disqualified";

export type ProjectRow = {
  id: string;
  event_id: string;
  team_id: string;
  title: string;
  tagline?: string;
  description?: string;
  thumbnail_url?: string;
  video_url?: string;
  image_urls?: string;
  tech_tags?: string;
  answers?: string;
  summary: string;
  repo_url: string | null;
  demo_url: string | null;
  track_key: string | null;
  status: ProjectStatus;
  created_at: number;
  saved_at: number | null;
  submitted_at: number | null;
  withdrawn_at: number | null;
  duplicate_of: string | null;
  duplicate_reason: string | null;
  duplicate_decision: "pending" | "confirmed" | "cleared" | null;
};

const PROJECT_COLUMNS = `id, event_id, team_id, title, summary, repo_url, demo_url,
  track_key, status, created_at, saved_at, submitted_at, withdrawn_at, tagline, description, thumbnail_url, video_url, image_urls, tech_tags, answers,
  duplicate_of, duplicate_reason, duplicate_decision`;

export function isQuarantined(project: ProjectRow): boolean {
  return project.duplicate_of !== null && project.duplicate_decision !== "cleared";
}

function duplicateKey(project: Pick<ProjectRow, "title" | "repo_url">): { title: string; repo: string | null } {
  const title = project.title.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  let repo: string | null = null;
  if (project.repo_url) {
    try {
      const url = new URL(project.repo_url);
      repo = `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname
        .replace(/\.git\/?$/i, "").replace(/\/+$/, "").toLowerCase()}`;
    } catch { /* URL validity is enforced separately; keep title matching. */ }
  }
  return { title, repo };
}

export function duplicateMatch(db: Db, project: ProjectRow): { prior: ProjectRow; reason: "title" | "repository" } | null {
  const key = duplicateKey(project);
  const earlier = listProjects(db, project.event_id, { status: "submitted" })
    .filter((other) => other.id !== project.id && !isQuarantined(other) &&
      (other.submitted_at ?? other.created_at) <= (project.submitted_at ?? Number.MAX_SAFE_INTEGER));
  for (const other of earlier) {
    const otherKey = duplicateKey(other);
    if (key.repo && key.repo === otherKey.repo) return { prior: other, reason: "repository" };
    if (key.title && key.title === otherKey.title) return { prior: other, reason: "title" };
  }
  return null;
}

export function createTeam(ctx: Ctx, eventId: string, name: string, id?: string): TeamRow {
  const teamId = id ?? ctx.newId();
  return ctx.recorded(
    { action: "team.created", eventId, subject: teamId, payload: { name } },
    () => {
      ctx.write(
        "insert into team (id, event_id, name, created_at) values (:id, :e, :name, :at)",
        { id: teamId, e: eventId, name: name.trim(), at: ctx.now() },
      );
      return ctx.db.one<TeamRow>(
        "select id, event_id, name, created_at from team where id = :id",
        { id: teamId },
      );
    },
  );
}

/**
 * Read a team inside an event, by id.
 *
 * The same both-ids rule as `findProjectIn`, for the same reason: `teams.join` takes a
 * team id from a URL a participant can edit, and a lookup by id alone would let a
 * member of one event add themselves to a team in another.
 */
export function findTeamIn(db: Db, eventId: string, id: string): TeamRow | undefined {
  return db.get<TeamRow>(
    "select id, event_id, name, created_at from team where event_id = :e and id = :id",
    { e: eventId, id },
  );
}

/** Every team in an event, with its members, for the join page and the organizer's view. */
export function listTeams(db: Db, eventId: string): (TeamRow & { members: string[] })[] {
  const teams = db.all<TeamRow>(
    "select id, event_id, name, created_at from team where event_id = :e order by created_at, id",
    { e: eventId },
  );
  // One read for the memberships rather than one per team. The shape this replaces —
  // `teams.map((t) => teamMembers(db, event, t.id))` — is a query count that grows with
  // the size of the event, on the page most likely to be open when the event is largest.
  const rows = db.all<{ team_id: string; account_id: string }>(
    `select team_id, account_id from team_member
      where event_id = :e order by team_id, created_at, account_id`,
    { e: eventId },
  );
  const members = new Map<string, string[]>();
  for (const row of rows) {
    const list = members.get(row.team_id);
    if (list === undefined) members.set(row.team_id, [row.account_id]);
    else list.push(row.account_id);
  }
  return teams.map((team) => ({ ...team, members: members.get(team.id) ?? [] }));
}

export function teamOf(db: Db, eventId: string, accountId: string): TeamRow | undefined {
  return db.get<TeamRow>(
    `select t.id, t.event_id, t.name, t.created_at
       from team_member m join team t on t.id = m.team_id and t.event_id = m.event_id
      where m.event_id = :e and m.account_id = :a`,
    { e: eventId, a: accountId },
  );
}

export function teamMembers(db: Db, eventId: string, teamId: string): string[] {
  return db
    .all<{ account_id: string }>(
      `select account_id from team_member
        where event_id = :e and team_id = :t order by created_at, account_id`,
      { e: eventId, t: teamId },
    )
    .map((row) => row.account_id);
}

/**
 * Put somebody on a team.
 *
 * The schema allows one team per account per event, so joining a second team is a
 * uniqueness failure rather than a silent move. That is checked here so the error
 * says which team they are already on, which is the thing the person needs to know.
 */
export function addTeamMember(ctx: Ctx, team: TeamRow, accountId: string): void {
  ctx.db.tx(() => {
      const existing = teamOf(ctx.db, team.event_id, accountId);
      if (existing) {
        if (existing.id === team.id) return;
        throw new RuleError(
          "team.alreadyJoined",
          `That account is already on ${existing.name} for this event. Leave that team first.`,
          { team: existing.id },
        );
      }
      ctx.recorded(
        { action: "team.joined", eventId: team.event_id, subject: team.id, payload: { account: accountId } },
        () => {
          ctx.write(
            `insert into team_member (event_id, team_id, account_id, created_at)
             values (:e, :t, :a, :at)`,
            { e: team.event_id, t: team.id, a: accountId, at: ctx.now() },
          );
        },
      );
  });
}

export function findProject(db: Db, id: string): ProjectRow | undefined {
  return db.get<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, { id });
}

/**
 * Read a project inside an event.
 *
 * Both ids in the predicate, always. A handler that has an event from the URL and a
 * project id from a form must not be able to load the second without the first, or
 * cross-event access becomes a missing `where` clause away — which is the whole
 * mechanism `prove:isolation` exists to rule out.
 */
export function findProjectIn(db: Db, eventId: string, id: string): ProjectRow | undefined {
  return db.get<ProjectRow>(
    `select ${PROJECT_COLUMNS} from project where event_id = :e and id = :id`,
    { e: eventId, id },
  );
}

export function listProjects(
  db: Db,
  eventId: string,
  options: { status?: ProjectStatus | readonly ProjectStatus[]; trackKey?: string } = {},
): ProjectRow[] {
  const statuses =
    options.status === undefined
      ? undefined
      : typeof options.status === "string"
        ? [options.status]
        : [...options.status];
  const where = ["event_id = :e"];
  const params: Record<string, string> = { e: eventId };
  if (statuses) {
    // Named parameters cannot bind a list, and interpolating the values would be
    // an injection. The keys are generated, the values are still bound.
    where.push(`status in (${statuses.map((_, i) => `:s${i}`).join(", ")})`);
    statuses.forEach((status, i) => {
      params[`s${i}`] = status;
    });
  }
  if (options.trackKey !== undefined) {
    where.push("track_key = :track");
    params.track = options.trackKey;
  }
  return db.all<ProjectRow>(
    `select ${PROJECT_COLUMNS} from project where ${where.join(" and ")}
     order by submitted_at, created_at, id`,
    params,
  );
}

/** The pool a judge is scored against: submitted, not withdrawn, not disqualified. */
export function judgeablePool(db: Db, eventId: string, trackKey?: string): ProjectRow[] {
  return listProjects(db, eventId, { status: "submitted", ...(trackKey ? { trackKey } : {}) });
}

export type ProjectInput = {
  id?: string;
  tagline?: string;
  description?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  imageUrls?: string;
  techTags?: string;
  answers?: string;

  title: string;
  summary?: string;
  repoUrl?: string | null;
  demoUrl?: string | null;
  trackKey?: string | null;
};

export function createProject(
  ctx: Ctx,
  event: EventRow,
  team: TeamRow,
  input: ProjectInput,
): ProjectRow {
  assertGate(event, ctx.now(), "submissions");
  const id = input.id ?? ctx.newId();
  return ctx.recorded(
    { action: "project.created", eventId: event.id, subject: id, payload: { title: input.title } },
    () => {
      ctx.write(
        `insert into project (id, event_id, team_id, title, summary, repo_url, demo_url,
           track_key, status, created_at, saved_at, tagline, description, thumbnail_url, video_url, image_urls, tech_tags, answers)
         values (:id, :e, :t, :title, :summary, :repo, :demo, :track, 'draft', :at, :at, :tagline, :description, :thumbnailUrl, :videoUrl, :imageUrls, :techTags, :answers)`,
        {
          id,
          e: event.id,
          t: team.id,
          title: input.title.trim(),
          tagline: input.tagline?.trim() ?? "",
          description: input.description?.trim() ?? "",
          thumbnailUrl: input.thumbnailUrl?.trim() ?? "",
          videoUrl: input.videoUrl?.trim() ?? "",
          imageUrls: input.imageUrls?.trim() ?? "",
          techTags: input.techTags?.trim() ?? "",
          answers: input.answers?.trim() ?? "",

          summary: input.summary?.trim() ?? "",
          repo: input.repoUrl ?? null,
          demo: input.demoUrl ?? null,
          track: input.trackKey ?? null,
          at: ctx.now(),
        },
      );
      return ctx.db.one<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, { id });
    },
  );
}

/**
 * Edit a project. Refused once submissions close, draft or not.
 *
 * The ledger entry names the fields that changed and keeps the previous title when
 * the title moved, because "which project was this" is the question an appeal starts
 * with. Values are not otherwise duplicated into the payload: the row holds the
 * current state, the export holds the whole row, and a ledger that mirrored every
 * field would double the database to no end.
 */
export function updateProject(
  ctx: Ctx,
  event: EventRow,
  project: ProjectRow,
  patch: Partial<ProjectInput>,
): ProjectRow {
  assertGate(event, ctx.now(), "submissions");
  if (project.status === "disqualified") {
    throw new RuleError("project.disqualified", "A disqualified project cannot be edited.");
  }
  const sets: string[] = [];
  const params: Record<string, string | null> = { id: project.id, e: event.id };
  const changed: string[] = [];
  const column = {
    tagline: "tagline",
    description: "description",
    thumbnailUrl: "thumbnail_url",
    videoUrl: "video_url",
    imageUrls: "image_urls",
    techTags: "tech_tags",
    answers: "answers",

    title: "title",
    summary: "summary",
    repoUrl: "repo_url",
    demoUrl: "demo_url",
    trackKey: "track_key",
  } as const;
  for (const [key, name] of Object.entries(column) as [keyof typeof column, string][]) {
    const value = patch[key];
    if (value === undefined) continue;
    const next = typeof value === "string" ? value.trim() : value;
    if (next === (project[name as keyof ProjectRow] as string | null)) continue;
    sets.push(`${name} = :${name}`);
    params[name] = next;
    changed.push(name);
  }
  if (sets.length === 0) return project;
  return ctx.recorded(
    {
      action: "project.updated",
      eventId: event.id,
      subject: project.id,
      payload: changed.includes("title")
        ? { fields: changed, previous_title: project.title }
        : { fields: changed },
    },
    () => {
      ctx.write(
        `update project set ${sets.join(", ")}, saved_at = :saved_at where id = :id and event_id = :e`,
        { ...params, saved_at: ctx.now() },
      );
      const revised = ctx.db.one<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, {
        id: project.id,
      });
      if (revised.status === "submitted" && revised.duplicate_decision !== "cleared") {
        const duplicate = duplicateMatch(ctx.db, revised);
        if (duplicate) ctx.write(`update project set duplicate_of = :prior,
          duplicate_reason = :reason, duplicate_decision = 'pending'
          where event_id = :e and id = :id`, {
          prior: duplicate.prior.id, reason: duplicate.reason, e: event.id, id: project.id,
        });
      }
      return ctx.db.one<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, {
        id: project.id,
      });
    },
  );
}

/**
 * Submit. This is the one call in the system with a hard deadline behind it, and the
 * refusal it throws carries how late the attempt was in milliseconds.
 */
export function submitProject(ctx: Ctx, event: EventRow, project: ProjectRow): ProjectRow {
  assertGate(event, ctx.now(), "submissions");
  if (project.status === "submitted") return project;
  if (project.status === "disqualified") {
    throw new RuleError("project.disqualified", "A disqualified project cannot be resubmitted.");
  }
  if (project.title.trim().length === 0 || project.summary.trim().length === 0) {
    throw new RuleError(
      "project.incomplete",
      "A submission needs a title and a summary before it can be entered.",
    );
  }
  const at = ctx.now();
  const duplicate = project.duplicate_decision === "cleared" ? null : duplicateMatch(ctx.db, project);
  return ctx.recorded(
    {
      action: "project.submitted",
      eventId: event.id,
      subject: project.id,
      payload: {
        title: project.title,
        // The margin, on the record. An organizer settling "we were on time" wants
        // the number, and reconstructing it later needs the deadline as it was.
        with_ms_to_spare: event.submissions_close_at - at,
        resubmitted: project.status === "withdrawn",
        duplicate_of: duplicate?.prior.id ?? project.duplicate_of,
      },
    },
    () => {
      ctx.write(
        `update project set status = 'submitted', submitted_at = :at, withdrawn_at = null,
          duplicate_of = :duplicate, duplicate_reason = :reason, duplicate_decision = :decision
          where id = :id and event_id = :e`,
        { at, id: project.id, e: event.id,
          duplicate: duplicate?.prior.id ?? project.duplicate_of,
          reason: duplicate?.reason ?? project.duplicate_reason,
          decision: duplicate ? "pending" : project.duplicate_decision },
      );
      return ctx.db.one<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, {
        id: project.id,
      });
    },
  );
}

/**
 * Withdraw.
 *
 * A team may withdraw while submissions are open. After that it takes an organizer,
 * and the reason is judging integrity rather than paperwork: a team that could
 * withdraw after judging began could watch a low score arrive and remove the
 * evidence, which changes every other project's ranking.
 */
export function withdrawProject(
  ctx: Ctx,
  event: EventRow,
  project: ProjectRow,
  options: { byOrganizer?: boolean; reason?: string } = {},
): ProjectRow {
  if (!options.byOrganizer) assertGate(event, ctx.now(), "submissions");
  if (project.status === "draft") {
    throw new RuleError("project.notSubmitted", "That project was never submitted.");
  }
  if (project.status === "withdrawn") return project;
  const at = ctx.now();
  return ctx.recorded(
    {
      action: "project.withdrawn",
      eventId: event.id,
      subject: project.id,
      payload: {
        by_organizer: options.byOrganizer === true,
        reason: options.reason ?? "",
        after_close: at >= event.submissions_close_at,
      },
    },
    () => {
      ctx.write(
        `update project set status = 'withdrawn', withdrawn_at = :at
          where id = :id and event_id = :e`,
        { at, id: project.id, e: event.id },
      );
      return ctx.db.one<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, {
        id: project.id,
      });
    },
  );
}

/**
 * Disqualify. Organizer-only, and no deadline applies — the reason to disqualify
 * usually surfaces during judging. A written reason is required, because the ledger
 * entry is the thing the team will be shown.
 */
export function disqualifyProject(
  ctx: Ctx,
  event: EventRow,
  project: ProjectRow,
  reason: string,
): ProjectRow {
  if (reason.trim().length < 3) {
    throw new RuleError("project.reasonRequired", "Disqualification needs a stated reason.");
  }
  return ctx.recorded(
    {
      action: "project.disqualified",
      eventId: event.id,
      subject: project.id,
      payload: { reason: reason.trim(), previous_status: project.status },
    },
    () => {
      // `submitted_at` is left alone. It records that the work arrived on time,
      // which stays true, and the CHECK on the table requires it to stay set.
      ctx.write(
        `update project set status = 'disqualified', withdrawn_at = null
          where id = :id and event_id = :e`,
        { id: project.id, e: event.id },
      );
      return ctx.db.one<ProjectRow>(`select ${PROJECT_COLUMNS} from project where id = :id`, {
        id: project.id,
      });
    },
  );
}

/**
 * Titles that more than one project in the event is using.
 *
 * The schema deliberately permits duplicates — refusing a submission at the deadline
 * over a title collision is worse than the confusion — so the organizer dashboard
 * shows them instead, before judges have to guess which one they are scoring.
 */
export type DuplicateTitleGroup = {
  title: string;
  ids: string[];
  projects: { id: string; title: string; status: "draft" | "submitted" }[];
};

export function duplicateTitles(db: Db, eventId: string): DuplicateTitleGroup[] {
  const rows = db.all<{ id: string; title: string; status: "draft" | "submitted" }>(
    `select id, title, status from project
      where event_id = :e and status in ('submitted', 'draft')
      order by title, id`,
    { e: eventId },
  );
  // Compare presentation differences without rewriting the names people entered.
  // Punctuation remains significant; SQLite's lower() does not fold Unicode case.
  const groups = new Map<string, DuplicateTitleGroup>();
  for (const row of rows) {
    const key = row.title.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
    const group = groups.get(key) ?? { title: row.title, ids: [], projects: [] };
    group.ids.push(row.id);
    group.projects.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.ids.length > 1);
}

export function duplicateCases(db: Db, eventId: string): { project: ProjectRow; prior: ProjectRow }[] {
  const projects = listProjects(db, eventId);
  const byId = new Map(projects.map((project) => [project.id, project]));
  return projects.flatMap((project) => {
    if (!project.duplicate_of) return [];
    const prior = byId.get(project.duplicate_of);
    return prior ? [{ project, prior }] : [];
  });
}

export function triageDuplicate(ctx: Ctx, eventId: string, projectId: string,
  decision: "confirmed" | "cleared", reason: string): ProjectRow {
  const project = findProjectIn(ctx.db, eventId, projectId);
  if (!project?.duplicate_of) throw new RuleError("project.duplicateMissing", "That project has no duplicate flag to review.");
  if (reason.trim().length < 3) throw new RuleError("project.reasonRequired", "Explain this duplicate decision.");
  if (project.duplicate_decision === decision) return project;
  return ctx.recorded({ action: decision === "cleared" ? "project.duplicate_cleared" : "project.duplicate_confirmed",
    eventId, subject: project.id,
    payload: { duplicate_of: project.duplicate_of, reason: reason.trim() } }, () => {
    ctx.write(`update project set duplicate_decision = :decision where id = :id and event_id = :event`,
      { decision, id: project.id, event: eventId });
    return findProjectIn(ctx.db, eventId, project.id)!;
  });
}
