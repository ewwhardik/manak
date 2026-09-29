/**
 * Two-Factor Authentication (TOTP / RFC 6238) command suite.
 *
 * Provides endpoints for setting up, enabling, verifying, and disabling TOTP MFA.
 * Includes inline SVG QR codes and recovery backup codes.
 */

import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { forbidden } from "../errors.ts";
import {
  buildOtpauthUri,
  generateBackupCodes,
  generateQrCodeSvg,
  generateTotpSecret,
  verifyTotp,
} from "../totp.ts";
import {
  consumeBackupCode,
  disableMfaTotp,
  enableMfaTotp,
  findAccount,
  getMfaTotp,
  updateMfaLastUsedStep,
  RuleError,
} from "../../db/index.ts";

export const totpStatus = defineCommand({
  name: "auth.totp_status",
  summary: "Check whether Two-Factor Authentication (TOTP) is active for the current account.",
  method: "GET",
  path: "/api/me/totp",
  capability: { audience: "account" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        enabledAt: { type: ["integer", "null"] },
      },
      required: ["enabled", "enabledAt"],
    },
  },
  handler: ({ ctx, accountId }) => {
    if (accountId === null) throw forbidden("Sign in to check MFA status.");
    const mfa = getMfaTotp(ctx.db, accountId);
    return {
      enabled: mfa !== null,
      enabledAt: mfa?.enabled_at ?? null,
    };
  },
});

export const totpSetup = defineCommand({
  name: "auth.totp_setup",
  summary: "Generate a new TOTP secret, backup codes, and QR code SVG for 2FA enrollment.",
  method: "POST",
  path: "/api/me/totp/setup",
  capability: { audience: "account" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        secret: { type: "string" },
        uri: { type: "string" },
        qrSvg: { type: "string" },
        backupCodes: { type: "array", items: { type: "string" } },
      },
      required: ["secret", "uri", "qrSvg", "backupCodes"],
    },
  },
  limit: "signin",
  records: ["mfa.setup_initiated"],
  handler: ({ ctx, accountId }) => {
    if (accountId === null) throw forbidden("Sign in to configure 2FA.");
    const account = findAccount(ctx.db, accountId);
    const email = account?.email ?? "organizer@manak.local";

    const secret = generateTotpSecret();
    const uri = buildOtpauthUri(email, secret, "Manak");
    const qrSvg = generateQrCodeSvg(uri);
    const backupCodes = generateBackupCodes(8);

    return ctx.recorded({ action: "mfa.setup_initiated", subject: accountId }, () => ({
      secret,
      uri,
      qrSvg,
      backupCodes: [...backupCodes],
    }));
  },
});

export const totpEnable = defineCommand({
  name: "auth.totp_enable",
  summary: "Verify and enable Two-Factor Authentication using a 6-digit TOTP code.",
  method: "POST",
  path: "/api/me/totp/enable",
  capability: { audience: "account" },
  input: {
    secret: { kind: "text", label: "Secret Key" },
    code: { kind: "text", label: "Verification Code" },
    backupCodes: { kind: "text", optional: true, label: "Backup Codes (comma-separated or JSON)" },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    },
  },
  limit: "signin",
  records: ["mfa.enabled"],
  handler: ({ ctx, accountId, input }) => {
    if (accountId === null) throw forbidden("Sign in to enable 2FA.");
    const secret = String(input.secret ?? "").trim();
    const code = String(input.code ?? "").trim();

    const verification = verifyTotp(secret, code, ctx.now());
    if (!verification.valid) {
      throw new RuleError("mfa.invalidCode", "The 6-digit verification code is invalid or expired.");
    }

    let backupCodes: readonly string[] = [];
    if (input.backupCodes) {
      try {
        const parsed = JSON.parse(String(input.backupCodes)) as unknown;
        if (Array.isArray(parsed)) {
          backupCodes = parsed.map(String);
        }
      } catch {
        backupCodes = String(input.backupCodes).split(/[,\s]+/).filter(Boolean);
      }
    }
    if (backupCodes.length === 0) {
      backupCodes = generateBackupCodes(8);
    }

    enableMfaTotp(ctx, accountId, secret, backupCodes);
    return { enabled: true };
  },
});

export const totpVerify = defineCommand({
  name: "auth.totp_verify",
  summary: "Verify an active 2FA challenge using a 6-digit code or single-use recovery code.",
  method: "POST",
  path: "/api/me/totp/verify",
  capability: { audience: "account" },
  input: {
    code: { kind: "text", label: "Verification code or recovery code" },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        verified: { type: "boolean" },
      },
      required: ["verified"],
    },
  },
  limit: "signin",
  records: ["mfa.verified", "mfa.backup_used"],
  handler: ({ ctx, accountId, input }) => {
    if (accountId === null) throw forbidden("Sign in required.");
    const mfa = getMfaTotp(ctx.db, accountId);
    if (!mfa) {
      return { verified: true };
    }

    const raw = String(input.code ?? "").trim();

    // Check 6-digit TOTP
    if (/^\d{6}$/.test(raw)) {
      const res = verifyTotp(mfa.secret, raw, ctx.now(), mfa.last_used_step);
      if (res.valid) {
        updateMfaLastUsedStep(ctx, accountId, res.step);
        return { verified: true };
      }
    }

    // Check backup recovery code
    const usedBackup = consumeBackupCode(ctx, accountId, raw);
    if (usedBackup) {
      return { verified: true };
    }

    throw new RuleError("mfa.invalidCode", "The supplied two-factor authentication code is invalid.");
  },
});

export const totpDisable = defineCommand({
  name: "auth.totp_disable",
  summary: "Disable Two-Factor Authentication after code verification.",
  method: "POST",
  path: "/api/me/totp/disable",
  capability: { audience: "account" },
  input: {
    code: { kind: "text", label: "Current 6-digit code" },
  },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        disabled: { type: "boolean" },
      },
      required: ["disabled"],
    },
  },
  limit: "signin",
  records: ["mfa.disabled"],
  handler: ({ ctx, accountId, input }) => {
    if (accountId === null) throw forbidden("Sign in required.");
    const mfa = getMfaTotp(ctx.db, accountId);
    if (!mfa) {
      return { disabled: true };
    }

    const code = String(input.code ?? "").trim();
    const res = verifyTotp(mfa.secret, code, ctx.now(), mfa.last_used_step);
    const backupUsed = !res.valid && consumeBackupCode(ctx, accountId, code);

    if (!res.valid && !backupUsed) {
      throw new RuleError("mfa.invalidCode", "Current 6-digit code required to disable 2FA.");
    }

    disableMfaTotp(ctx, accountId);
    return { disabled: true };
  },
});

export const TOTP_COMMANDS: readonly Command[] = [
  totpStatus,
  totpSetup,
  totpEnable,
  totpVerify,
  totpDisable,
];
