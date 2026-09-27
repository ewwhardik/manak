/**
 * Fixed-window rate limiting.
 *
 * A fixed window rather than a sliding one or a token bucket, because the property
 * that matters here is that an operator can explain it. "Ten sign-in links per email
 * per hour" is a sentence a participant can be told when they hit it; the same
 * limit expressed as a leaky bucket is a sentence nobody can act on. The known cost
 * is burstiness at a boundary — twenty links in two minutes across a window edge —
 * which for the actions being limited is not a threat.
 *
 * The window start is part of the primary key, so expiry is a delete of old rows
 * rather than a timer, and a limit that is never hit costs one insert per window.
 *
 * These counters are the clearest case for `ctx.unaudited`: they change on requests
 * that were refused, hundreds of times, and an audit trail of refusals is a log.
 */

import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import { MS } from "../clock.ts";

export type Limit = { readonly window: number; readonly max: number; readonly label: string };

/**
 * Every limit in the deployment, in one place so they can be read as a policy
 * rather than found by grepping handlers.
 */
export const LIMITS = {
  signin: { window: MS.hour, max: 10, label: "sign-in links for one address" },
  invite: { window: MS.hour, max: 200, label: "invitations from one event" },
  ballot: { window: MS.minute, max: 60, label: "ballot writes by one judge" },
  vote: { window: MS.minute, max: 30, label: "public vote writes by one voter" },
  submission: { window: MS.minute, max: 30, label: "submission edits by one team" },
  read: { window: MS.minute, max: 600, label: "requests from one session" },
  // Tighter than anything else here by two orders of magnitude, and it can afford to be:
  // creating an event is a thing a person does once and then spends three days running.
  // The bucket is not really about rate — founding is already restricted to addresses the
  // operator named — it is about a founder whose credential has been taken, which is the
  // one way this deployment could be filled with rows nobody wanted.
  event: { window: MS.hour, max: 20, label: "events created by one founder" },
  // Every organizer write that is not a ballot: tracks, rubrics, assignment draws,
  // disqualifications, publishing results. Generous, because the one time an organizer
  // touches this ceiling is the hour before judging opens when they are fixing the rubric
  // and redrawing assignments, and a portal that refuses an organizer mid-repair is worse
  // than whatever it was protecting. Keyed on the event, not the account: two co-organizers
  // working the same event share a budget, which is the thing being protected.
  organize: { window: MS.minute, max: 120, label: "organizer changes to one event" },
  // The one bucket here that protects the server rather than the data. A resampled
  // analysis is a second or so of arithmetic that cannot be interrupted, and this process
  // is single-threaded: twenty of them in a minute is already ten seconds during which
  // every other request in the deployment is waiting. `read` allows six hundred, which for
  // a page that costs a millisecond is right and for this one would be a way to stop the
  // event portal from a browser tab. Keyed on the event, because the cost is a property of
  // the field being resampled and not of who asked.
  analyse: { window: MS.minute, max: 20, label: "resampled analyses of one event" },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

export type Verdict = {
  allowed: boolean;
  used: number;
  max: number;
  /** When the current window ends, so a response can carry `Retry-After`. */
  resetAt: number;
};

/**
 * Count one attempt against a bucket and say whether it is allowed.
 *
 * The increment happens whether or not the attempt is allowed. That is deliberate:
 * a limiter that stops counting once it starts refusing lets a caller hammer the
 * boundary, and the window would then reopen for a full quota immediately.
 */
export function consume(ctx: Ctx, name: LimitName, key: string, cost = 1): Verdict {
  const limit = LIMITS[name];
  const now = ctx.now();
  const windowAt = Math.floor(now / limit.window) * limit.window;
  const bucket = `${name}:${key}`;
  return ctx.unaudited("rate-limit counter", () =>
    ctx.db.tx(() => {
      ctx.write(
        `insert into rate_limit (bucket, window_at, hits) values (:bucket, :window, :cost)
         on conflict (bucket, window_at) do update set hits = hits + :cost`,
        { bucket, window: windowAt, cost },
      );
      const used = ctx.db.one<{ hits: number }>(
        "select hits from rate_limit where bucket = :bucket and window_at = :window",
        { bucket, window: windowAt },
      ).hits;
      return {
        allowed: used <= limit.max,
        used,
        max: limit.max,
        resetAt: windowAt + limit.window,
      };
    }),
  );
}

/**
 * The detail key a refused call carries its window end under.
 *
 * A bare `"reset_at"` written here and read again in `src/api/errors.ts` is two string
 * literals in two layers that have to agree for a `Retry-After` header to ever be sent
 * — and the failure is silent, because a missing header looks exactly like a limit that
 * declined to say. Exported so there is one spelling. Snake case because the whole
 * `detail` object is JSON somebody reads in a log next to the ledger's own columns.
 */
export const RATE_RESET_KEY = "reset_at";

/** Consume, and throw if refused. The form handlers use. */
export function enforce(ctx: Ctx, name: LimitName, key: string, cost = 1): Verdict {
  const verdict = consume(ctx, name, key, cost);
  if (!verdict.allowed) {
    const limit = LIMITS[name];
    throw new RuleError(
      `rate.${name}`,
      `Too many ${limit.label}: the limit is ${limit.max} per ${
        limit.window / MS.minute
      } minutes. Try again after ${new Date(verdict.resetAt).toISOString()}.`,
      { limit: name, used: verdict.used, max: limit.max, [RATE_RESET_KEY]: verdict.resetAt },
    );
  }
  return verdict;
}

/** What a bucket stands at, without spending anything. For the diagnostics page. */
export function peek(db: Db, name: LimitName, key: string, now: number): Verdict {
  const limit = LIMITS[name];
  const windowAt = Math.floor(now / limit.window) * limit.window;
  const row = db.get<{ hits: number }>(
    "select hits from rate_limit where bucket = :bucket and window_at = :window",
    { bucket: `${name}:${key}`, window: windowAt },
  );
  const used = row?.hits ?? 0;
  return { allowed: used < limit.max, used, max: limit.max, resetAt: windowAt + limit.window };
}

/** Drop windows that have closed. Called by the same sweep that clears sessions. */
export function sweepRateLimits(ctx: Ctx): number {
  return ctx.unaudited("expiry sweep", () => {
    // The widest window in use, so a row is only removed once no limit could still
    // be counting against it.
    const widest = Math.max(...Object.values(LIMITS).map((l) => l.window));
    return ctx.write("delete from rate_limit where window_at < :cutoff", {
      cutoff: Math.floor(ctx.now() / widest) * widest - widest,
    }).changes;
  });
}
