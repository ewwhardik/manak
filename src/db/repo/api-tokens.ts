import type { Db } from "../open.ts";
import type { Ctx } from "../context.ts";
import { RuleError } from "../context.ts";
import { findAccount, hashToken, mintToken, rolesIn } from "./accounts.ts";

export const API_TOKEN_SCOPES = ['read:projects', 'read:results', 'write:projects', 'write:judging'] as const;
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number];
export type ApiTokenRow = { id: string; account_id: string; event_id: string; label: string;
  scope: ApiTokenScope; created_at: number; expires_at: number; revoked_at: number | null };
const COLUMNS = 'id, account_id, event_id, label, scope, created_at, expires_at, revoked_at';
const ALLOWED: Record<ApiTokenScope, readonly string[]> = {
  'read:projects': ['events.show', 'projects.list', 'projects.show', 'rubrics.show'],
  'read:results': ['results.show', 'results.history', 'results.evidence_packet'],
  'write:projects': ['projects.list', 'projects.show', 'projects.create', 'projects.update', 'projects.submit'],
  'write:judging': ['judging.queue', 'ballots.save', 'duels.next', 'duels.decide', 'rubrics.show'],
};
export function apiTokenAllows(token: ApiTokenRow, command: string, eventId: string | null): boolean {
  return token.event_id === eventId && ALLOWED[token.scope].includes(command);
}
export function apiTokensOf(db: Db, accountId: string): ApiTokenRow[] {
  return db.all<ApiTokenRow>(`select ${COLUMNS} from api_token where account_id = :account order by created_at desc, id`, { account: accountId });
}
export function createApiToken(ctx: Ctx, accountId: string, eventId: string, label: string, scope: ApiTokenScope, days = 30) {
  if (!rolesIn(ctx.db, eventId, accountId).length) throw new RuleError('token.membership', 'Choose an event you belong to.');
  if (!API_TOKEN_SCOPES.includes(scope) || !label.trim() || label.length > 80 || !Number.isInteger(days) || days < 1 || days > 90) {
    throw new RuleError('token.invalid', 'Choose a scope, label and expiry between 1 and 90 days.');
  }
  const active = apiTokensOf(ctx.db, accountId).filter(t => t.revoked_at === null && t.expires_at > ctx.now());
  if (active.length >= 20) throw new RuleError('token.limit', 'Revoke a token before creating another; at most 20 may be active.');
  const id = ctx.newId(), token = `manak_${mintToken()}`, at = ctx.now(), expiresAt = at + days * 86400000;
  ctx.recorded({ action: 'token.created', eventId, subject: id, payload: { label, scope, expiresAt } }, () => {
    ctx.write(`insert into api_token(id, account_id, event_id, label, scope, token_hash, created_at, expires_at)
      values (:id, :account, :event, :label, :scope, :hash, :at, :expires)`,
    { id, account: accountId, event: eventId, label: label.trim(), scope, hash: hashToken(token), at, expires: expiresAt });
  });
  return { id, token, expiresAt, scope, eventId };
}
export function revokeApiToken(ctx: Ctx, accountId: string, id: string): void {
  const row = ctx.db.get<ApiTokenRow>(`select ${COLUMNS} from api_token where id = :id and account_id = :account`, { id, account: accountId });
  if (!row) throw new RuleError('token.missing', 'That token does not belong to your account.');
  if (row.revoked_at !== null) return;
  ctx.recorded({ action: 'token.revoked', eventId: row.event_id, subject: id }, () => {
    ctx.write('update api_token set revoked_at = :at where id = :id and account_id = :account', { at: ctx.now(), id, account: accountId });
  });
}
export function resolveApiToken(db: Db, token: string, now: number) {
  if (!/^manak_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const row = db.get<ApiTokenRow>(`select ${COLUMNS} from api_token where token_hash = :hash and revoked_at is null and expires_at > :now`, { hash: hashToken(token), now });
  if (!row) return undefined;
  const account = findAccount(db, row.account_id);
  if (!account || account.disabled_at !== null || !rolesIn(db, row.event_id, account.id).length) return undefined;
  return { token: row, account };
}
