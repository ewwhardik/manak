/**
 * Two-Factor Authentication (TOTP / MFA) persistence layer.
 *
 * Stores account secrets, recovery backup codes, and replay verification step cursors.
 * Adheres strictly to repository invariants: audit gate on every mutation, strict table.
 */

import type { Ctx } from "../context.ts";
import type { Db } from "../open.ts";

export type MfaTotpRow = {
  readonly account_id: string;
  readonly secret: string;
  readonly backup_codes: string;
  readonly enabled_at: number;
  readonly last_used_step: number;
};

export function getMfaTotp(db: Db, accountId: string): MfaTotpRow | null {
  return (
    db.get<MfaTotpRow>(
      `select account_id, secret, backup_codes, enabled_at, last_used_step
       from mfa_totp where account_id = :id`,
      { id: accountId },
    ) ?? null
  );
}

export function enableMfaTotp(
  ctx: Ctx,
  accountId: string,
  secret: string,
  backupCodes: readonly string[],
): void {
  const now = ctx.now();
  const codesJson = JSON.stringify(backupCodes);

  ctx.recorded(
    {
      action: "mfa.enabled",
      subject: accountId,
      payload: { enabledAt: now },
    },
    () => {
      ctx.write(
        `insert into mfa_totp (account_id, secret, backup_codes, enabled_at, last_used_step)
         values (:accountId, :secret, :backupCodes, :now, 0)
         on conflict (account_id) do update set
           secret = excluded.secret,
           backup_codes = excluded.backup_codes,
           enabled_at = excluded.enabled_at,
           last_used_step = 0`,
        {
          accountId,
          secret,
          backupCodes: codesJson,
          now,
        },
      );
    },
  );
}

export function disableMfaTotp(ctx: Ctx, accountId: string): void {
  ctx.recorded(
    {
      action: "mfa.disabled",
      subject: accountId,
      payload: {},
    },
    () => {
      ctx.write(`delete from mfa_totp where account_id = :accountId`, {
        accountId,
      });
    },
  );
}

export function updateMfaLastUsedStep(
  ctx: Ctx,
  accountId: string,
  step: number,
): void {
  ctx.recorded(
    {
      action: "mfa.verified",
      subject: accountId,
      payload: { step },
    },
    () => {
      ctx.write(
        `update mfa_totp set last_used_step = :step where account_id = :accountId`,
        { accountId, step },
      );
    },
  );
}

export function consumeBackupCode(
  ctx: Ctx,
  accountId: string,
  providedCode: string,
): boolean {
  const row = getMfaTotp(ctx.db, accountId);
  if (!row) return false;

  const normalized = providedCode.trim().toUpperCase();
  let codes: string[] = [];
  try {
    codes = JSON.parse(row.backup_codes) as string[];
  } catch {
    return false;
  }

  const idx = codes.findIndex((c) => c.toUpperCase() === normalized);
  if (idx === -1) return false;

  codes.splice(idx, 1);
  const updatedJson = JSON.stringify(codes);

  ctx.recorded(
    {
      action: "mfa.backup_used",
      subject: accountId,
      payload: { remaining: codes.length },
    },
    () => {
      ctx.write(
        `update mfa_totp set backup_codes = :codes where account_id = :accountId`,
        { accountId, codes: updatedJson },
      );
    },
  );

  return true;
}
