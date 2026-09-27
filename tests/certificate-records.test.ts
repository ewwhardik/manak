import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { world } from "./support/world.ts";
import { certificateCorrections, correctCertificate, getOrCreateKeypair, issuedEventCertificates,
  persistEventCertificates, verifyCertificate, verifyCertificateCorrection } from "../src/db/cert.ts";
import type { IssueCertsReport } from "../src/db/cert.ts";
import { exportArchive, importArchive } from "../src/db/archive.ts";
import { freshDb } from "./support/world.ts";
import { judged } from "./support/judged.ts";
import { setResultsPublic, storePublication } from "../src/db/index.ts";

test("certificate API has read-only downloads, private records and one audited issuance", async () => {
  const rig = judged();
  const dir = mkdtempSync(join(tmpdir(), "manak-cert-api-"));
  const previous = process.env.MANAK_KEY_DIR;
  process.env.MANAK_KEY_DIR = dir;
  try {
    const endpoint = `/api/events/${rig.world.event.slug}/certificates`;
    const organizer = rig.principals.find((p) => p.label === "organizer")!;
    const published = await rig.serve(new Request(`https://portal.test/api/events/${rig.world.event.slug}/results/publish`, {
      method: "POST", headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" }, body: "{}",
    }), "203.0.113.9");
    assert.equal(published.status, 200, await published.text());
    const auditCount = () => rig.world.db.one<{ n: number }>("select count(*) as n from ledger").n;
    const before = auditCount();
    const empty = await rig.json(endpoint, organizer);
    assert.equal(empty.totalIssued, 0);
    assert.equal(auditCount(), before);
    for (const principal of rig.principals.filter((p) => p !== organizer)) {
      assert.ok([401, 403].includes((await rig.get(endpoint, principal)).status));
    }
    const issue = () => rig.serve(new Request(`https://portal.test${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" }, body: "{}",
    }), "203.0.113.9");
    const response = await issue();
    assert.equal(response.status, 200, await response.clone().text());
    const first = await response.json() as IssueCertsReport;
    assert.ok(first.totalIssued > 0);
    assert.deepEqual(await rig.json(endpoint, organizer), first);
    assert.deepEqual(await (await issue()).json(), first);
    assert.equal(rig.world.db.one<{ n: number }>("select count(*) as n from ledger where action = 'certificate.issued'").n, 1);
    const key = getOrCreateKeypair(dir);
    assert.equal(first.publicKeyPem, key.publicKeyPem);
    for (const cert of first.certificates) assert.ok(verifyCertificate(cert, key.publicKey));
  } finally {
    if (previous === undefined) delete process.env.MANAK_KEY_DIR; else process.env.MANAK_KEY_DIR = previous;
    rig.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("certificate records are immutable, verifiable and survive archive roundtrip", () => {
  const w = world();
  const target = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "manak-records-"));
  try {
    assert.equal(issuedEventCertificates(w.db, w.event.id), undefined);
    assert.throws(() => persistEventCertificates(w.db, w.event.slug, w.clock.now(), dir), /Publish results/);
    setResultsPublic(w.asOrganizer, w.event, true);
    storePublication(w.asOrganizer, w.event.id, { method: "none", rubricVersion: 1, projects: [] }, "Initial publication");
    const first = persistEventCertificates(w.db, w.event.slug, w.clock.now(), dir, "http://localhost:8080");
    assert.ok(first.totalIssued > 0);
    const again = persistEventCertificates(w.db, w.event.slug, w.clock.now() + 10000, dir, "http://other.test");
    assert.deepEqual(again, first);
    for (const cert of first.certificates) assert.ok(verifyCertificate(cert, first.publicKeyPem));
    exportArchive(w.db, join(dir, "archive"));
    importArchive(target.db, join(dir, "archive"));
    assert.deepEqual(issuedEventCertificates(target.db, w.event.id), first);
  } finally { w.close(); target.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a missing public key is recovered without rotating identity; missing private or mismatched keys fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "manak-key-test-"));
  try {
    const original = getOrCreateKeypair(dir);
    unlinkSync(join(dir, "manak_ed25519.pub"));
    assert.equal(getOrCreateKeypair(dir).publicKeyPem, original.publicKeyPem);
    writeFileSync(join(dir, "manak_ed25519.pub"), "wrong");
    assert.throws(() => getOrCreateKeypair(dir), /does not match/);
    writeFileSync(join(dir, "manak_ed25519.pub"), original.publicKeyHex);
    const pem = readFileSync(join(dir, "manak_ed25519.key"), "utf8");
    assert.ok(pem.includes("PRIVATE KEY"));
    unlinkSync(join(dir, "manak_ed25519.key"));
    assert.throws(() => getOrCreateKeypair(dir), /private key is missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("signed certificate corrections survive archive restore and old records verify with their original key", () => {
  const w = world();
  const target = freshDb();
  const oldDir = mkdtempSync(join(tmpdir(), "manak-old-key-"));
  const newDir = mkdtempSync(join(tmpdir(), "manak-new-key-"));
  try {
    setResultsPublic(w.asOrganizer, w.event, true);
    storePublication(w.asOrganizer, w.event.id, { method: "none", rubricVersion: 1, projects: [] }, "Initial publication");
    const report = persistEventCertificates(w.db, w.event.slug, w.clock.now(), oldDir);
    const original = report.certificates[0]!;
    assert.equal(original.certificateVersion, 2);
    assert.equal(original.publicationRevision, 1);
    const changed = correctCertificate(w.asOrganizer, w.event.id, original.serial, "supersede",
      "Corrected the recipient display name", { recipientName: "Corrected Recipient",
        recipientEmail: "corrected@example.test", category: original.category, detail: original.detail }, oldDir);
    assert.ok(changed.replacement);
    assert.equal(changed.record.replacementSerial, changed.replacement!.serial);
    assert.ok(verifyCertificateCorrection(changed.record, report.publicKeyPem));
    assert.ok(verifyCertificate(changed.replacement!, report.publicKeyPem));
    assert.equal(certificateCorrections(w.db, w.event.id).records.length, 1);
    const rotated = getOrCreateKeypair(newDir);
    assert.notEqual(rotated.keyId, original.issuerKeyId);
    assert.ok(verifyCertificate(original, report.publicKeyPem));
    assert.equal(verifyCertificate(original, rotated.publicKeyPem), false);
    exportArchive(w.db, join(oldDir, "archive"));
    importArchive(target.db, join(oldDir, "archive"));
    assert.deepEqual(certificateCorrections(target.db, w.event.id), certificateCorrections(w.db, w.event.id));
    assert.ok(verifyCertificateCorrection(certificateCorrections(target.db, w.event.id).records[0]!, report.publicKeyPem));
  } finally { w.close(); target.close(); rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true }); }
});
