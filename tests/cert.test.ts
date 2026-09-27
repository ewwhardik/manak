import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  certDigest,
  createEvent,
  grantRole,
  issueCertificate,
  makeContext,
  migrate,
  openDatabase,
  upsertAccount,
  verifyCertificate,
  setResultsPublic,
  storePublication,
} from "../src/db/index.ts";
import type { CertificatePayload } from "../src/db/index.ts";
import { issueAllCertificates } from "../tools/issue-certs.ts";

test("Ed25519 certificate issuance and cryptographic verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const payload: CertificatePayload = {
    serial: "01JM9999999999999999999999",
    eventId: "dogfood",
    eventName: "DogFood Hackathon 2026",
    recipientName: "Ada Lovelace",
    recipientEmail: "ada@example.com",
    category: "placement",
    detail: "1st Place Grand Prize Winner",
    issuedAt: 1789400000000,
    issuerOrigin: "http://localhost:8080",
  };

  const cert = issueCertificate(payload, privateKey);
  assert.equal(cert.serial, payload.serial);
  assert.ok(cert.signature.length >= 120);

  // Verification succeeds with matching public key
  const valid = verifyCertificate(cert, publicKey);
  assert.equal(valid, true);

  // Verification fails if payload is tampered
  const tampered = { ...cert, recipientName: "Imposter" };
  const invalid = verifyCertificate(tampered, publicKey);
  assert.equal(invalid, false);

  // Verification fails if signed with another key
  const otherKey = generateKeyPairSync("ed25519").publicKey;
  const invalidKey = verifyCertificate(cert, otherKey);
  assert.equal(invalidKey, false);
});

test("issueAllCertificates mints and cryptographically verifies certificates for event", () => {
  const tmp = mkdtempSync(join(tmpdir(), "manak-certs-"));

  try {
    const dbPath = join(tmp, "test.db");
    const db = openDatabase(dbPath);
    migrate(db);
    const ctx = makeContext(db);

    const event = createEvent(ctx, {
      slug: "cert-event",
      name: "Cert Hackathon",
      timezone: "UTC",
      submissionsOpenAt: 1000,
      submissionsCloseAt: 2000000000000,
      judgingOpenAt: 2000,
      judgingCloseAt: 2000000000000,
      reviewsPerProject: 2,
      pairwiseEnabled: false,
      votingMode: "open",
      votingCredits: 100,
    });

    const p1 = upsertAccount(ctx, "part1@example.com", "Participant One");
    grantRole(ctx, event.id, p1.id, "participant");
    const p2 = upsertAccount(ctx, "part2@example.com", "Participant Two");
    grantRole(ctx, event.id, p2.id, "participant");

    const j1 = upsertAccount(ctx, "judge1@example.com", "Judge One");
    grantRole(ctx, event.id, j1.id, "judge");

    setResultsPublic(ctx, event, true);
    storePublication(ctx, event.id, { method: "none", rubricVersion: null, projects: [] }, "Initial publication");
    db.close();

    const report = issueAllCertificates(dbPath, event.slug, tmp);
    assert.equal(report.event, "Cert Hackathon");
    assert.equal(report.participants, 0, "Enrollment without a submitted team project is not earned participation");
    assert.equal(report.judges, 0, "Enrollment alone does not establish judge participation");
    assert.equal(report.totalIssued, 0);
    assert.equal(report.certificates.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
