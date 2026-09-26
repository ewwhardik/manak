/**
 * Accounts, roles, sessions and magic links.
 *
 * Two decisions here are security decisions rather than storage ones.
 *
 * **Tokens are stored as SHA-256, never as themselves.** A session cookie and a
 * magic-link token are bearer credentials: whoever holds one is the account. If the
 * database held them in plaintext, a leaked backup — or a stray `select * from
 * session` in a log — would hand over live sessions and unexpired invitations. The
 * plaintext exists exactly once, in the return value of the function that mints it,
 * and is never written down. The lookup path hashes the incoming token and matches
 * on that, so the read side never needs the original either.
 *
 * **Roles are event-scoped and additive.** There is no global admin. An organizer
 * of one event has no standing in another, which is the property `prove:isolation`
 * will be asked to demonstrate, and it is cheaper to have it be true from the start
 * than to retrofit it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import type { Db } from "../open.ts";
import { MS } from "../clock.ts";

export type Role = "organizer" | "judge" | "participant";
export const ROLES: readonly Role[] = ["organizer", "judge", "participant"];

export type AccountRow = {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
  disabled_at: number | null;
};

export type MembershipRow = {
  event_id: string;
  account_id: string;
  role: Role;
  created_at: number;
  active: number;
  revoked_at: number | null;
};

export type SessionRow = {
  token_hash: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  user_agent: string;
};

/** How long a signed-in session lasts, and how long an emailed link stays usable. */
export const SESSION_TTL = 14 * MS.day;
export const MAGIC_LINK_TTL = 30 * MS.minute;

/** 256 bits, URL-safe. Long enough that guessing is not a threat model. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex hashes without leaking their prefix through timing.
 *
 * Only used where a candidate is compared against a value already in hand; the
 * lookups below index on the hash, which SQLite compares in its own time. Included
 * because the alternative is that the one place that does need it uses `===`.
 */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * What counts as an address, in one place.
 *
 * Exported because the API layer validates the same field before this function ever
 * runs, and two regular expressions for one rule is how a form starts accepting
 * addresses the domain then refuses. Deliberately permissive: the authoritative test
 * of an address is whether the sign-in link arrives.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** RFC 5321's limit on a forward path, which no real address approaches. */
export const EMAIL_MAX = 254;

/** Lower-cased and trimmed, because the schema requires it and uniqueness needs it. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized) || normalized.length > EMAIL_MAX) {
    throw new RuleError("account.email", `${JSON.stringify(email)} is not an email address.`);
  }
  return normalized;
}

/**
 * Offline disposable email domain set.
 * Used for anti-abuse reputation scoring and fraud detection.
 */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "dispostable.com",
  "getairmail.com",
  "guerrillamail.com",
  "mailinator.com",
  "sharklasers.com",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
]);

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return DISPOSABLE_DOMAINS.has(domain);
}

export function findAccount(db: Db, id: string): AccountRow | undefined {
  return db.get<AccountRow>(
    "select id, email, display_name, created_at, disabled_at from account where id = :id",
    { id },
  );
}

export function findAccountByEmail(db: Db, email: string): AccountRow | undefined {
  return db.get<AccountRow>(
    "select id, email, display_name, created_at, disabled_at from account where email = :email",
    { email: normalizeEmail(email) },
  );
}

/**
 * Find the account for an address, or make one.
 *
 * Sign-in and invitation both land here, which is why it is one function: an
 * organizer inviting a judge who has never used the deployment before must not have
 * to care whether the account exists, and two code paths that both create accounts
 * eventually disagree about normalization.
 */
export function upsertAccount(ctx: Ctx, email: string, displayName?: string, id?: string): AccountRow {
  const normalized = normalizeEmail(email);
  const existing = findAccountByEmail(ctx.db, normalized);
  if (existing) return existing;
  const accountId = id ?? ctx.newId();
  return ctx.recorded(
    { action: "account.created", subject: accountId, payload: { email: normalized } },
    () => {
      ctx.write(
        `insert into account (id, email, display_name, created_at)
         values (:id, :email, :name, :at)`,
        {
          id: accountId,
          email: normalized,
          // The local part is a placeholder, not a guess at a real name: it is
          // shown until the person edits it, and an empty string fails the CHECK.
          name: displayName?.trim() || (normalized.split("@")[0] as string),
          at: ctx.now(),
        },
      );
      return ctx.db.one<AccountRow>(
        "select id, email, display_name, created_at, disabled_at from account where id = :id",
        { id: accountId },
      );
    },
  );
}

export function rolesIn(db: Db, eventId: string, accountId: string): Role[] {
  return db
    .all<{ role: Role }>(
      "select role from membership where event_id = :e and account_id = :a and active = 1 order by role",
      { e: eventId, a: accountId },
    )
    .map((row) => row.role);
}

export function hasRole(db: Db, eventId: string, accountId: string, role: Role): boolean {
  return (
    db.get<{ one: number }>(
      "select 1 as one from membership where event_id = :e and account_id = :a and role = :r and active = 1",
      { e: eventId, a: accountId, r: role },
    ) !== undefined
  );
}

export function membersOf(db: Db, eventId: string, role: Role): AccountRow[] {
  return db.all<AccountRow>(
    `select a.id, a.email, a.display_name, a.created_at, a.disabled_at
       from membership m join account a on a.id = m.account_id
      where m.event_id = :e and m.role = :r and m.active = 1
      order by a.display_name, a.id`,
    { e: eventId, r: role },
  );
}

export function grantRole(ctx: Ctx, eventId: string, accountId: string, role: Role): void {
  if (!ROLES.includes(role)) throw new RuleError("membership.role", `unknown role: ${role}`);
  ctx.db.tx(() => {
    if (hasRole(ctx.db, eventId, accountId, role)) return;
    const prior = ctx.db.get<{ active: number }>(
      "select active from membership where event_id = :e and account_id = :a and role = :r",
      { e: eventId, a: accountId, r: role },
    );
    ctx.recorded(
      { action: "membership.granted", eventId, subject: accountId, payload: { role, reactivated: !!prior } },
      () => {
        if (prior) ctx.write(
          "update membership set active = 1, revoked_at = null where event_id = :e and account_id = :a and role = :r",
          { e: eventId, a: accountId, r: role },
        );
        else ctx.write(
          `insert into membership (event_id, account_id, role, created_at)
           values (:e, :a, :r, :at)`,
          { e: eventId, a: accountId, r: role, at: ctx.now() },
        );
      },
    );
  });
}

/** Remove access while retaining assignments, ballots and comparisons as evidence. */
export function revokeRole(ctx: Ctx, eventId: string, accountId: string, role: Role): void {
  ctx.db.tx(() => {
    if (!hasRole(ctx.db, eventId, accountId, role)) return;
    const ballots =
      role === "judge"
        ? ctx.db.one<{ n: number }>(
            "select count(*) as n from ballot where event_id = :e and judge_id = :a",
            { e: eventId, a: accountId },
          ).n
        : 0;
    ctx.recorded(
      {
        action: "membership.revoked",
        eventId,
        subject: accountId,
        payload: { role, retained_ballots: ballots },
      },
      () => {
        ctx.write(
          "update membership set active = 0, revoked_at = :at where event_id = :e and account_id = :a and role = :r",
          { e: eventId, a: accountId, r: role, at: ctx.now() },
        );
      },
    );
  });
}

/** A minted credential: the plaintext, which is never stored, and when it dies. */
export type Minted = { token: string; expiresAt: number };

export function createSession(
  ctx: Ctx,
  accountId: string,
  options: { userAgent?: string; ttl?: number; token?: string } = {},
): Minted {
  const token = options.token ?? mintToken();
  const at = ctx.now();
  const expiresAt = at + (options.ttl ?? SESSION_TTL);
  ctx.recorded(
    // The hash prefix, not the token, and not the whole hash: enough to correlate
    // a session with a later revocation in the feed, useless as a credential.
    {
      action: "session.created",
      actorId: accountId,
      subject: accountId,
      payload: { token_prefix: hashToken(token).slice(0, 8), expires_at: expiresAt },
    },
    () => {
      ctx.write(
        `insert into session (token_hash, account_id, created_at, expires_at, last_seen_at, user_agent)
         values (:hash, :account, :at, :expires, :at, :agent)`,
        {
          hash: hashToken(token),
          account: accountId,
          at,
          expires: expiresAt,
          // Truncated because a user agent is attacker-controlled text that ends up
          // on an organizer's screen; the length cap is the cheap half of that fix.
          agent: (options.userAgent ?? "").slice(0, 200),
        },
      );
    },
  );
  return { token, expiresAt };
}

/**
 * Resolve a bearer token to an account, or nothing.
 *
 * Returns `undefined` for expired, revoked, unknown and disabled alike. The caller
 * cannot tell which, and that is intentional: distinguishing "no such session" from
 * "that session was revoked" tells whoever is holding a stolen token which of their
 * guesses was once real.
 */
export function resolveSession(
  db: Db,
  token: string,
  now: number,
): { session: SessionRow; account: AccountRow } | undefined {
  const session = db.get<SessionRow>(
    `select token_hash, account_id, created_at, expires_at, last_seen_at, revoked_at, user_agent
       from session where token_hash = :hash`,
    { hash: hashToken(token) },
  );
  if (!session) return undefined;
  if (session.revoked_at !== null || session.expires_at <= now) return undefined;
  const account = findAccount(db, session.account_id);
  if (!account || account.disabled_at !== null) return undefined;
  return { session, account };
}

/**
 * Record that a session was used.
 *
 * Unaudited, and this is the clearest case for the escape hatch: one entry per
 * request would make the ledger a web server log with a hash chain attached, and
 * bury the forty entries an organizer actually needs to read.
 */
export function touchSession(ctx: Ctx, tokenHash: string): void {
  ctx.unaudited("session liveness", () => {
    ctx.write("update session set last_seen_at = :at where token_hash = :hash", {
      at: ctx.now(),
      hash: tokenHash,
    });
  });
}

export function revokeSession(ctx: Ctx, tokenHash: string): void {
  ctx.recorded(
    {
      action: "session.revoked",
      subject: ctx.actorId ?? "",
      payload: { token_prefix: tokenHash.slice(0, 8) },
    },
    () => {
      ctx.write(
        "update session set revoked_at = :at where token_hash = :hash and revoked_at is null",
        { at: ctx.now(), hash: tokenHash },
      );
    },
  );
}

/** Every live session for an account. The "sign out everywhere" screen reads this. */
export function sessionsOf(db: Db, accountId: string, now: number): SessionRow[] {
  return db.all<SessionRow>(
    `select token_hash, account_id, created_at, expires_at, last_seen_at, revoked_at, user_agent
       from session
      where account_id = :a and revoked_at is null and expires_at > :now
      order by last_seen_at desc`,
    { a: accountId, now },
  );
}

export type MagicLinkRow = {
  token_hash: string;
  email: string;
  event_id: string | null;
  invited_role: Role | null;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
};

/**
 * Issue a sign-in link, optionally carrying an invitation to an event.
 *
 * The account is *not* created here. An organizer who mistypes an address should not
 * leave a phantom account behind, and creating one on issue would also let anyone
 * who can trigger a link populate the account table with addresses they chose.
 */
export function issueMagicLink(
  ctx: Ctx,
  input: { email: string; eventId?: string | null; role?: Role | null; ttl?: number },
): Minted {
  const email = normalizeEmail(input.email);
  const token = mintToken();
  const issuedAt = ctx.now();
  const expiresAt = issuedAt + (input.ttl ?? MAGIC_LINK_TTL);
  ctx.recorded(
    {
      action: input.role ? "invite.issued" : "signin.requested",
      eventId: input.eventId ?? null,
      subject: email,
      payload: { role: input.role ?? null, expires_at: expiresAt },
    },
    () => {
      ctx.write(
        `insert into magic_link (token_hash, email, event_id, invited_role, issued_at, expires_at)
         values (:hash, :email, :event, :role, :issued, :expires)`,
        {
          hash: hashToken(token),
          email,
          event: input.eventId ?? null,
          role: input.role ?? null,
          issued: issuedAt,
          expires: expiresAt,
        },
      );
    },
  );
  return { token, expiresAt };
}

/**
 * Redeem a link: create or find the account, grant any invited role, sign in.
 *
 * Single-use. Marking it consumed inside the same transaction as the session it
 * creates is what makes it single-use under concurrency: two simultaneous redeems
 * of one token cannot both find `consumed_at` null, because the first holds the
 * write lock until it has set it.
 */
export function consumeMagicLink(
  ctx: Ctx,
  token: string,
  options: { userAgent?: string; displayName?: string } = {},
): { account: AccountRow; session: Minted; eventId: string | null; role: Role | null } {
  const now = ctx.now();
  const hash = hashToken(token);
  return ctx.db.tx(() => {
    const link = ctx.db.get<MagicLinkRow>(
      `select token_hash, email, event_id, invited_role, issued_at, expires_at, consumed_at
         from magic_link where token_hash = :hash`,
      { hash },
    );
    // One error for every failure mode. A link that is unknown, spent or stale is
    // equally unusable, and telling them apart is a probe oracle.
    if (!link || link.consumed_at !== null || link.expires_at <= now) {
      throw new RuleError(
        "link.invalid",
        "That sign-in link is not usable. Request a new one — links are single-use and " +
          "expire after 30 minutes.",
      );
    }
    const account = upsertAccount(ctx, link.email, options.displayName);
    if (account.disabled_at !== null) {
      throw new RuleError("account.disabled", "That account has been disabled.");
    }
    const signedIn = ctx.as(account.id);
    signedIn.recorded(
      { action: "link.consumed", eventId: link.event_id, subject: account.id, payload: {} },
      () => {
        signedIn.write("update magic_link set consumed_at = :at where token_hash = :hash", {
          at: now,
          hash,
        });
      },
    );
    if (link.event_id && link.invited_role) {
      grantRole(signedIn, link.event_id, account.id, link.invited_role);
    }
    return {
      account,
      session: createSession(signedIn, account.id, { userAgent: options.userAgent }),
      eventId: link.event_id,
      role: link.invited_role,
    };
  });
}

/**
 * Delete credentials that can no longer be used.
 *
 * Unaudited: a sweep records nothing an organizer needs, and the rows it removes
 * were already inert. Run on boot and hourly.
 */
export function sweepExpired(ctx: Ctx): { sessions: number; links: number } {
  return ctx.unaudited("expiry sweep", () => {
    const now = ctx.now();
    const sessions = ctx.write("delete from session where expires_at <= :now", { now }).changes;
    const links = ctx.write(
      "delete from magic_link where expires_at <= :now or consumed_at is not null",
      { now },
    ).changes;
    return { sessions, links };
  });
}
