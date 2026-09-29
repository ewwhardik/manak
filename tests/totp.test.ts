import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeBase32,
  decodeBase32,
  generateTotpSecret,
  calculateTotp,
  verifyTotp,
  generateBackupCodes,
  buildOtpauthUri,
  generateQrCodeSvg,
} from "../src/api/totp.ts";

test("base32 encode and decode roundtrip", () => {
  const original = Buffer.from("Hello Manak World 2026!", "utf8");
  const encoded = encodeBase32(original);
  const decoded = decodeBase32(encoded);
  assert.equal(Buffer.from(decoded).toString("utf8"), "Hello Manak World 2026!");
});

test("RFC 6238 TOTP calculation is deterministic and 6 digits", () => {
  const secret = "JBSWY3DPEHPK3PXP"; // Standard test key
  const t0 = 1759000000000;
  const totp1 = calculateTotp(secret, t0);
  const totp2 = calculateTotp(secret, t0);
  assert.equal(totp1.code, totp2.code);
  assert.equal(totp1.code.length, 6);
  assert.ok(/^\d{6}$/.test(totp1.code));
});

test("verifyTotp succeeds within window and rejects stale/replay steps", () => {
  const secret = generateTotpSecret();
  const now = 1759000000000;
  const { code, step } = calculateTotp(secret, now);

  // Normal verification
  const res = verifyTotp(secret, code, now);
  assert.ok(res.valid);
  assert.equal(res.step, step);

  // Replay rejection with lastUsedStep
  const replayRes = verifyTotp(secret, code, now, step);
  assert.ok(!replayRes.valid, "should reject replaying same step");

  // Incorrect code rejected
  const badRes = verifyTotp(secret, "999999", now);
  assert.ok(!badRes.valid);
});

test("generateBackupCodes generates unique formatted recovery codes", () => {
  const codes = generateBackupCodes(8);
  assert.equal(codes.length, 8);
  for (const c of codes) {
    assert.ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(c));
  }
  const unique = new Set(codes);
  assert.equal(unique.size, 8);
});

test("generateQrCodeSvg emits valid responsive SVG", () => {
  const uri = buildOtpauthUri("organizer@example.com", "JBSWY3DPEHPK3PXP", "Manak");
  const svg = generateQrCodeSvg(uri);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('viewBox="0 0 41 41"'));
  assert.ok(svg.includes("<rect"));
  assert.ok(svg.endsWith("</svg>"));
});
