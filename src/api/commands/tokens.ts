import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { API_TOKEN_SCOPES, apiTokensOf, createApiToken, revokeApiToken } from "../../db/index.ts";
import type { ApiTokenScope, EventRow } from "../../db/index.ts";
import { EVENT_REF } from "./events.ts";

const list = defineCommand({ name: 'tokens.list', summary: 'Manage your scoped API tokens.', method: 'GET', path: '/api/me/tokens',
  capability: { audience: 'account' }, input: {},
  returns: { kind: 'json', schema: { type: 'object', properties: { tokens: { type: 'array', items: { type: 'object' } } }, required: ['tokens'] } },
  handler: ({ ctx, accountId }) => ({ tokens: apiTokensOf(ctx.db, accountId!) }),
});
const create = defineCommand({ name: 'tokens.create', summary: 'Create an expiring API token for one event and scope.', method: 'POST', path: '/api/me/tokens',
  capability: { audience: 'account', scope: 'event' }, input: { event: EVENT_REF,
    label: { kind: 'text', min: 1, max: 80, label: 'Token label' },
    scope: { kind: 'enum', values: API_TOKEN_SCOPES, label: 'Scope', fallback: 'read:projects' },
    days: { kind: 'int', min: 1, max: 90, fallback: 30, label: 'Expires in days' } },
  limit: 'organize', records: ['token.created'], form: { title: 'Create API token', submit: 'Create token' },
  returns: { kind: 'json', schema: { type: 'object', properties: {
    id: { type: 'string' }, token: { type: 'string' }, scope: { type: 'string' }, expiresAt: { type: 'integer' }, eventId: { type: 'string' },
  }, required: ['id', 'token', 'scope', 'expiresAt', 'eventId'] } },
  handler: ({ ctx, accountId, event, input }) => createApiToken(ctx, accountId!, (event as EventRow).id, String(input.label), input.scope as ApiTokenScope, Number(input.days)),
});
const revoke = defineCommand({ name: 'tokens.revoke', summary: 'Immediately revoke one of your API tokens.', method: 'POST', path: '/api/me/tokens/:tokenId/revoke',
  capability: { audience: 'account' }, input: { tokenId: { kind: 'id', label: 'Token ID' } },
  limit: 'organize', records: ['token.revoked'],
  form: { title: 'Revoke API token', submit: 'Revoke token', redirect: () => '/me/tokens' },
  returns: { kind: 'json', schema: { type: 'object', properties: { revoked: { type: 'boolean' } }, required: ['revoked'] } },
  handler: ({ ctx, accountId, input }) => { revokeApiToken(ctx, accountId!, String(input.tokenId)); return { revoked: true }; },
});
export const TOKEN_COMMANDS: readonly Command[] = [list, create, revoke];
