/**
 * What each refusal means over HTTP, decided once instead of at every handler.
 *
 * Three error types reach this layer and they mean different things. An `InputError`
 * says the submission was malformed — a 422, and the form is redisplayed with every
 * problem marked. A `RuleError` says the submission was well formed and the domain
 * refused it, which is usually a 409 but is sometimes a 404, a 403 or a 429, and
 * getting that wrong is not cosmetic: a 403 where a 404 belongs tells a stranger the
 * event exists. A `DatabaseError` says this code has a bug, which is a 500 and an
 * operator's problem rather than the caller's.
 *
 * So the mapping is a table, not a chain of `if`s in a dispatcher, and it is ordered
 * and total: `classify` reports which rule matched, and a test in `tests/api.test.ts`
 * scans `src/` for every `RuleError` code the product can throw and fails if any of
 * them reached the fallback. Adding a domain refusal therefore forces a decision about
 * what it means to a client, at the moment the refusal is written rather than the
 * first time somebody's generated client mishandles it.
 *
 * The line between 422 and 409 is worth stating because it is not the obvious one. It
 * is not "input versus domain": it is whether the caller can fix this by changing the
 * payload or only by changing the world. A score of 11 against a rubric that stops at
 * 10 is payload-fixable, so 422, even though only the rubric knows the bound. A closed
 * deadline is not fixable by resending anything, so 409.
 */

import { DatabaseError, RATE_RESET_KEY, RuleError } from "../db/index.ts";
import { InputError } from "./schema.ts";
import type { Problem } from "./schema.ts";
import type { Refusal } from "./capability.ts";

/** The document a failing request answers with, per RFC 9457. */
export type ProblemDocument = {
  /** A URI reference identifying the problem type, relative to the deployment. */
  type: string;
  /** A short summary of the *type*, stable across occurrences. */
  title: string;
  status: number;
  /** What went wrong this time. Safe to show a caller; never an internal message. */
  detail: string;
  /** The machine-readable code, which is also the last segment of `type`. */
  code: string;
  /** Present on a 422: every field that needs attention, not just the first. */
  problems?: readonly Problem[];
  /** The refusal's own structured detail, such as how late a submission was. */
  meta?: Readonly<Record<string, unknown>>;
};

export const PROBLEM_MEDIA_TYPE = "application/problem+json";

/** Statuses this layer can produce, and the reason phrase each carries. */
export const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  204: "No Content",
  303: "See Other",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/**
 * Refusals the caller can fix by sending something different. See the header for why
 * these are 422 rather than 409 despite being thrown by the domain.
 */
const PAYLOAD_FIXABLE: readonly string[] = [
  "abuse.threshold",
  "award.place",
  "appeal.decision",
  "abuse.tokens",
  "abuse.unknownVoter",
  "account.email",
  "ballot.incomplete",
  "comment.invalid",
  "comment.reason",
  "comparison.samePair",
  "comparison.winner",
  "certificate.replacement",
  "certificate.unknown",
  "membership.role",
  "judge.unknown",
  "judge.capacityValue",
  "judge.unknownTrack",
  "project.incomplete",
  "project.reasonRequired",
  "rubric.duplicateKey",
  "rubric.empty",
  "rubric.range",
  "rubric.weight",
  "score.range",
  "score.unknownCriterion",
  "voting.influence",
];

/** Refusals about the state of the world, which resending cannot change. */
const WORLD_FIXABLE: readonly string[] = [
  // Thrown when there is no legal assignment to make: fewer judges than an event asks to
  // review each project, or a track with one project in it. Resending the draw cannot fix
  // it — the organizer has to invite a judge or lower `reviews_per_project` — so 409, not
  // 422, even though the request that provoked it had a body.
  "assignment.impossible",
  "assignment.stale",
  "award.alreadyDecided",
  "appeal.closed",
  "appeal.duplicate",
  "appeal.unavailable",
  "appeal.stale",
  "appeal.certificateCorrectionRequired",
  "review.unavailable",
  "review.alreadyFiled",
  "ballot.staleRubric",
  "certificate.notIssued",
  "certificate.alreadyIssued",
  "comment.unavailable",
  "event.archived",
  "judging.closed",
  "judging.conflict",
  "judging.notOpen",
  "judge.inactive",
  "judge.capacity",
  "judge.trackRestricted",
  "judge.recused",
  "organizer.last",
  "voting.alreadyStarted",
  "voting.credits",
  "voting.disabled",
  "pairwise.disabled",
  "project.disqualified",
  "project.duplicateMissing",
  "project.notJudgeable",
  "project.notMember",
  "project.notSubmitted",
  // The third gate, listed before anything throws it, and deliberately not spelled
  // `results.notOpen`. The other two gates are time windows that open and close, so
  // `${gate}.notOpen` reads correctly for them; results are a flag an organizer sets,
  // and `results.closed` would be a code describing a state that cannot exist. Naming it
  // for what is actually true keeps the table free of entries nothing can throw.
  "results.notPublic",
  "results.noSnapshot",
  "results.votingOpen",
  "rubric.unpublished",
  "submissions.closed",
  "submissions.notOpen",
  "team.alreadyJoined",
];

/**
 * Refusals about the request itself rather than about anything it asked for.
 *
 * These are the one group whose status is not a judgement call — each has exactly one
 * correct code — so they are a lookup consulted before the ordered rules rather than
 * entries in `PAYLOAD_FIXABLE` or `WORLD_FIXABLE`. They live in this table rather than in
 * the HTTP layer that throws them because `classify` has to be total: a code the product
 * can throw and this file has not heard of answers 409, which is plausible enough to
 * survive review and wrong enough to make a client retry a body it should have shortened.
 */
const TRANSPORT: Readonly<Record<string, number>> = {
  "request.malformed": 400,
  "request.method": 405,
  "request.tooLarge": 413,
  "request.mediaType": 415,
};

export type Classification = { status: number; rule: string };

type Rule = { name: string; status: number; matches: (code: string) => boolean };

/**
 * Ordered, first match wins. Only three rules generalize by shape; the rest are lists,
 * because a suffix rule that guessed would have classified `pairwise.disabled` and
 * `account.disabled` the same way and one of those is a 403.
 */
const RULES: readonly Rule[] = [
  { name: "rate", status: 429, matches: (code) => code.startsWith("rate.") },
  { name: "missing", status: 404, matches: (code) => code.endsWith(".missing") },
  {
    name: "credential",
    status: 401,
    matches: (code) =>
      code === "access.unauthenticated" || code === "link.invalid" || code === "voting.tokenInvalid",
  },
  {
    name: "role",
    status: 403,
    matches: (code) => code === "access.forbidden" || code === "account.disabled",
  },
  {
    name: "payload",
    status: 422,
    matches: (code) => PAYLOAD_FIXABLE.includes(code),
  },
  {
    name: "world",
    status: 409,
    matches: (code) =>
      WORLD_FIXABLE.includes(code) ||
      code.endsWith(".notOpen") ||
      code.endsWith(".closed") ||
      code.endsWith(".notPublic"),
  },
];

/** The fallback. A code that lands here is a code nobody has decided the meaning of. */
export const FALLBACK: Classification = { status: 409, rule: "default" };

export function classify(code: string): Classification {
  const transport = TRANSPORT[code];
  if (transport !== undefined) return { status: transport, rule: "transport" };
  for (const rule of RULES) {
    if (rule.matches(code)) return { status: rule.status, rule: rule.name };
  }
  return FALLBACK;
}

export function statusForRefusal(refusal: Refusal): number {
  return refusal === "unauthenticated" ? 401 : refusal === "forbidden" ? 403 : 404;
}

/**
 * The refusal a dispatcher raises when a capability check says no.
 *
 * `notFound` takes the kind of thing that is missing rather than a fixed code, so the
 * refusal an isolation check produces is spelled exactly like the one the repository
 * produces for a genuinely wrong id — `project.missing` either way. That is the point:
 * the two are meant to be indistinguishable from outside.
 */
export function notFound(kind: string, id?: string): RuleError {
  return new RuleError(
    `${kind}.missing`,
    `No such ${kind}.`,
    id === undefined ? {} : { [kind]: id },
  );
}

export function unauthenticated(because = "this operation needs somebody signed in."): RuleError {
  return new RuleError("access.unauthenticated", `Not signed in: ${because}`);
}

export function forbidden(because: string): RuleError {
  return new RuleError("access.forbidden", `Not permitted: ${because}`);
}

/** "ballot.staleRubric" reads as "Ballot: stale rubric". Stable per type, no table. */
export function titleFor(code: string): string {
  const [area, ...rest] = code.split(".");
  const tail = rest
    .join(".")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  const head = (area ?? code).charAt(0).toUpperCase() + (area ?? code).slice(1);
  return tail === "" ? head : `${head}: ${tail}`;
}

/**
 * The problem document for anything thrown.
 *
 * An unrecognised error is deliberately opaque: its message could be a SQL fragment or
 * a file path, and a stack trace rendered into a stranger's browser is how internals
 * leak. Operators get the real thing from `describeForLog`, which is why that function
 * exists rather than a flag on this one.
 */
export function toProblem(error: unknown): ProblemDocument {
  if (error instanceof InputError) {
    return {
      type: "/errors/input.invalid",
      title: titleFor(error.code),
      status: 422,
      detail: error.message,
      code: error.code,
      problems: error.problems,
    };
  }
  if (error instanceof RuleError) {
    const { status } = classify(error.code);
    return {
      type: `/errors/${error.code}`,
      title: titleFor(error.code),
      status,
      detail: error.message,
      code: error.code,
      ...(Object.keys(error.detail).length > 0 ? { meta: error.detail } : {}),
    };
  }
  return {
    type: "/errors/internal",
    title: "Internal error",
    status: 500,
    detail: "Something went wrong on the server. The operator's log has the details.",
    code: "internal",
  };
}

export function httpStatus(error: unknown): number {
  return toProblem(error).status;
}

/** Everything an operator needs and no caller may see. */
export function describeForLog(error: unknown): string {
  if (error instanceof InputError) {
    return `${error.code} ${error.problems.map((p) => `${p.field} ${p.message}`).join(" ")}`;
  }
  if (error instanceof RuleError) {
    return `${error.code} ${error.message} ${JSON.stringify(error.detail)}`;
  }
  if (error instanceof DatabaseError) return `${error.code} ${error.message}`;
  return error instanceof Error ? `${error.name} ${error.message}\n${error.stack ?? ""}` : String(error);
}

/**
 * The detail key a 405 carries the truthful `Allow` list under.
 *
 * Exported for the same reason as `RATE_RESET_KEY`: two layers have to agree on one
 * spelling, and a missing `Allow` header looks exactly like a server that declined to say.
 */
export const ALLOW_KEY = "allow";

/** The methods a 405 should advertise, or null when the error is not a 405. */
export function allowedMethods(error: unknown): string[] | null {
  if (!(error instanceof RuleError) || error.code !== "request.method") return null;
  const allow = error.detail[ALLOW_KEY];
  if (!Array.isArray(allow)) return null;
  const methods = allow.filter((value): value is string => typeof value === "string");
  return methods.length === 0 ? null : methods;
}

/**
 * Seconds a 429 should ask the caller to wait, from the limiter's own window end.
 *
 * Rounded up and floored at one, because `Retry-After: 0` invites an immediate retry
 * that is guaranteed to be refused again.
 */
export function retryAfterSeconds(error: unknown, now: number): number | null {
  if (!(error instanceof RuleError) || !error.code.startsWith("rate.")) return null;
  const resetAt = error.detail[RATE_RESET_KEY];
  if (typeof resetAt !== "number") return null;
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}
