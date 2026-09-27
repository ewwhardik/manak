/**
 * Publicly verifiable Ed25519 certificates and judge records.
 *
 * Implements T4 requirement:
 *   "Signed, publicly verifiable judge participation records: Ed25519 keypair on
 *    first boot, public key at a well-known path, browser verification page
 *    working offline via WebCrypto."
 *
 * Uses Node 24's native `node:crypto` Ed25519 support with zero dependencies.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "./context.ts";

import type { Db } from "./open.ts";
import { RuleError } from "./context.ts";
import { assertVotingClosed, findEventBySlug } from "./repo/events.ts";
import { loadJudgingInput } from "./repo/judging.ts";
import { publishedVersion } from "./repo/rubrics.ts";
import { normalizeScores } from "../judging/index.ts";
import { latestPublication } from "./publication.ts";

export type CertificateCategory = "participation" | "judge" | "placement";

export type CertificatePayload = {
  serial: string;
  eventId: string;
  eventName: string;
  recipientName: string;
  recipientEmail: string;
  category: CertificateCategory;
  detail: string;
  issuedAt: number;
  issuerOrigin: string;
  certificateVersion?: number;
  issuerKeyId?: string;
  publicationRevision?: number;
  publicationDigest?: string;
};

export type SignedCertificate = CertificatePayload & {
  signature: string; // Hex-encoded 64-byte Ed25519 signature
};

export type KeypairConfig = {
  publicKeyHex: string;
  publicKeyPem: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
  keyId: string;
};

/**
 * Computes canonical SHA-256 digest of certificate payload for signing/verification.
 */
export function certDigest(payload: CertificatePayload): Buffer {
  const fields: unknown[] = [
    payload.serial,
    payload.eventId,
    payload.eventName,
    payload.recipientName,
    payload.recipientEmail,
    payload.category,
    payload.detail,
    payload.issuedAt,
    payload.issuerOrigin,
  ];
  if (payload.certificateVersion === 2) fields.push(2, payload.issuerKeyId,
    payload.publicationRevision ?? null, payload.publicationDigest ?? null);
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest();
}

export function issuerKeyId(publicKeyHex: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex");
}

/**
 * Loads or initializes an Ed25519 keypair from the storage directory.
 */
export function getOrCreateKeypair(dir: string): KeypairConfig {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const pubPath = join(dir, "manak_ed25519.pub");
  const keyPath = join(dir, "manak_ed25519.key");

  if (existsSync(keyPath)) {
    const rawKey = readFileSync(keyPath, "utf8");
    const privateKey = createPrivateKey(rawKey);
    const publicKey = createPublicKey(privateKey);
    const der = publicKey.export({ type: "spki", format: "der" });
    const pubHex = der.subarray(der.length - 32).toString("hex");
    if (existsSync(pubPath) && readFileSync(pubPath, "utf8").trim() !== pubHex) {
      throw new Error("Certificate public key does not match the private key. Restore the matching keypair.");
    }
    if (!existsSync(pubPath)) writeFileSync(pubPath, pubHex, "utf8");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    return { publicKeyHex: pubHex, publicKeyPem, publicKey, privateKey, keyId: issuerKeyId(pubHex) };
  }

  if (existsSync(pubPath)) throw new Error("Certificate private key is missing. Restore it; refusing to replace the signing identity.");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Extract raw 32-byte public key
  const exported = publicKey.export({ type: "spki", format: "der" });
  // The last 32 bytes of an Ed25519 SPKI DER are the raw public key
  const rawPub = exported.subarray(exported.length - 32);
  const pubHex = rawPub.toString("hex");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  writeFileSync(pubPath, pubHex, "utf8");
  // Save key
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(keyPath, pem, { encoding: "utf8", mode: 0o600 });

  return { publicKeyHex: pubHex, publicKeyPem, publicKey, privateKey, keyId: issuerKeyId(pubHex) };
}

/**
 * Signs a certificate payload with an Ed25519 private key.
 */
export function issueCertificate(payload: CertificatePayload, privateKey: KeyObject): SignedCertificate {
  const digest = certDigest(payload);
  const signature = sign(null, digest, privateKey);
  return {
    ...payload,
    signature: signature.toString("hex"),
  };
}

/**
 * Verifies an Ed25519 certificate against a public key.
 */
export function verifyCertificate(
  cert: SignedCertificate,
  publicKey: KeyObject | string,
): boolean {
  const digest = certDigest(cert);
  const sigBuffer = Buffer.from(cert.signature, "hex");
  return verify(null, digest, publicKey, sigBuffer);
}

export type SignedCertificateCorrection = {
  id: string;
  eventId: string;
  serial: string;
  action: "revoke" | "supersede";
  replacementSerial: string | null;
  publicationRevision: number;
  publicationDigest: string;
  reason: string;
  issuedAt: number;
  issuerKeyId: string;
  signature: string;
};

function correctionDigest(correction: Omit<SignedCertificateCorrection, "signature">): Buffer {
  return createHash("sha256").update(JSON.stringify([
    "manak-certificate-correction-v1", correction.id, correction.eventId,
    correction.serial, correction.action, correction.replacementSerial,
    correction.publicationRevision, correction.publicationDigest,
    correction.reason, correction.issuedAt, correction.issuerKeyId,
  ]), "utf8").digest();
}

export function verifyCertificateCorrection(record: SignedCertificateCorrection, publicKey: KeyObject | string): boolean {
  const { signature, ...payload } = record;
  if (!/^[a-f0-9]{128}$/.test(signature)) return false;
  return verify(null, correctionDigest(payload), publicKey, Buffer.from(signature, "hex"));
}

type CorrectionRow = {
  id: string; event_id: string; serial: string; action: "revoke" | "supersede";
  replacement_serial: string | null; replacement_certificate: string | null;
  publication_revision: number; publication_digest: string; reason: string;
  issued_at: number; issuer_key_id: string; public_key_pem: string; signature: string;
};

function publicCorrection(row: CorrectionRow): SignedCertificateCorrection {
  return { id: row.id, eventId: row.event_id, serial: row.serial, action: row.action,
    replacementSerial: row.replacement_serial, publicationRevision: row.publication_revision,
    publicationDigest: row.publication_digest, reason: row.reason,
    issuedAt: row.issued_at, issuerKeyId: row.issuer_key_id, signature: row.signature };
}

export function certificateCorrections(db: Db, eventId: string): {
  records: SignedCertificateCorrection[]; replacements: SignedCertificate[];
} {
  const rows = db.all<CorrectionRow>(
    "select * from certificate_correction where event_id = :e order by issued_at, id", { e: eventId });
  return { records: rows.map(publicCorrection), replacements: rows.flatMap((row) =>
    row.replacement_certificate ? [JSON.parse(row.replacement_certificate) as SignedCertificate] : []) };
}

export function correctCertificate(ctx: Ctx, eventId: string, serial: string,
  action: "revoke" | "supersede", reason: string,
  replacement?: Pick<CertificatePayload, "recipientName" | "recipientEmail" | "category" | "detail">,
  keyDir = certificateKeyDirectory()): { record: SignedCertificateCorrection; replacement?: SignedCertificate } {
  const batch = issuedEventCertificates(ctx.db, eventId);
  if (!batch) throw new RuleError("certificate.notIssued", "Issue the original certificate batch first.");
  const prior = batch.certificates.find((cert) => cert.serial === serial) ??
    certificateCorrections(ctx.db, eventId).replacements.find((cert) => cert.serial === serial);
  if (!prior) throw new RuleError("certificate.unknown", "The certificate serial is not in this event.");
  if (action === "supersede" && !replacement) throw new RuleError("certificate.replacement", "Supply the corrected recipient and detail.");
  if (action === "revoke" && replacement) throw new RuleError("certificate.replacement", "A revocation cannot include a replacement.");
  const publication = latestPublication(ctx.db, eventId);
  if (!publication) throw new RuleError("results.noSnapshot", "Publish a result revision before correcting certificates.");
  const key = getOrCreateKeypair(keyDir);
  const id = ctx.newId();
  const at = ctx.now();
  const newCert = replacement ? issueCertificate({
    serial: `CERT-R-${eventId}-${id}`, eventId, eventName: prior.eventName,
    recipientName: replacement.recipientName, recipientEmail: replacement.recipientEmail,
    category: replacement.category, detail: replacement.detail, issuedAt: at,
    issuerOrigin: prior.issuerOrigin, certificateVersion: 2, issuerKeyId: key.keyId,
    publicationRevision: publication.revision, publicationDigest: publication.evidence_digest,
  }, key.privateKey) : undefined;
  const payload = { id, eventId, serial, action, replacementSerial: newCert?.serial ?? null,
    publicationRevision: publication.revision, publicationDigest: publication.evidence_digest,
    reason, issuedAt: at, issuerKeyId: key.keyId };
  const record: SignedCertificateCorrection = { ...payload,
    signature: sign(null, correctionDigest(payload), key.privateKey).toString("hex") };
  ctx.recorded({ action: `certificate.${action}`, eventId, subject: serial,
    payload: { id, reason, replacementSerial: record.replacementSerial,
      publicationRevision: publication.revision } }, () => {
    ctx.write(`insert into certificate_correction (id, event_id, serial, action, replacement_serial,
      replacement_certificate, publication_revision, publication_digest, reason, issued_at,
      issuer_key_id, public_key_pem, signature) values (:id, :event, :serial, :action, :replacementSerial,
      :replacementCertificate, :revision, :digest, :reason, :at, :keyId, :pem, :signature)`, {
      id, event: eventId, serial, action, replacementSerial: record.replacementSerial,
      replacementCertificate: newCert ? JSON.stringify(newCert) : null,
      revision: publication.revision, digest: publication.evidence_digest, reason, at,
      keyId: key.keyId, pem: key.publicKeyPem, signature: record.signature,
    });
  });
  return { record, replacement: newCert };
}

export type IssueCertsReport = {
  event: string;
  totalIssued: number;
  participants: number;
  judges: number;
  winners: number;
  publicKeyPem: string;
  issuerKeyId?: string;
  publicationRevision?: number;
  publicationDigest?: string;
  certificates: SignedCertificate[];
};

export function certificateKeyDirectory(): string {
  return process.env.MANAK_KEY_DIR || dirname(process.env.MANAK_DATABASE || "./data/manak.db");
}

/** Reads never create keys, signatures, or new timestamps. */
export function issuedEventCertificates(db: Db, eventId: string): IssueCertsReport | undefined {
  const row = db.get<{ report: string }>("select report from certificate_batch where event_id = :event", { event: eventId });
  return row ? JSON.parse(row.report) as IssueCertsReport : undefined;
}

/** First issuance freezes the signed records. Retries return exactly the same bytes. */
export function persistEventCertificates(db: Db, eventSlug: string, now: number,
  keyDir = certificateKeyDirectory(), issuerOrigin = "https://manak.local"): IssueCertsReport {
  return db.tx(() => {
    const event = findEventBySlug(db, eventSlug);
    if (!event) throw new Error("Certificate event does not exist.");
    if (!event.results_public) throw new RuleError("results.notPublic", "Publish results before issuing the permanent certificate snapshot.");
    const existing = issuedEventCertificates(db, event.id);
    if (existing) return existing;
    const publication = latestPublication(db, event.id);
    if (!publication) throw new RuleError("results.noSnapshot", "Publish a frozen result revision before issuing certificates.");
    const report = mintEventCertificates(db, eventSlug, now, keyDir, issuerOrigin);
    db.run(`insert into certificate_batch
      (event_id, issued_at, report, publication_revision, publication_digest)
      values (:event, :at, :report, :revision, :digest)`,
      { event: event.id, at: now, report: JSON.stringify(report),
        revision: publication.revision, digest: publication.evidence_digest });
    return report;
  });
}

/**
 * Mint and cryptographically verify all participation, judging, and winner certificates for an event.
 */
export function mintEventCertificates(
  db: Db,
  eventSlug: string,
  now: number,
  keyDir = "./data",
  issuerOrigin = "https://manak.local",
): IssueCertsReport {
  const origin = new URL(issuerOrigin);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Certificate issuer must be an HTTP(S) origin.");
  }
  const event = findEventBySlug(db, eventSlug);
  if (!event) {
    throw new Error(`Event with slug "${eventSlug}" not found in database`);
  }

  const { privateKey, publicKey, publicKeyPem, keyId } = getOrCreateKeypair(keyDir);
  const boundPublication = latestPublication(db, event.id);
  const binding = { certificateVersion: 2, issuerKeyId: keyId,
    publicationRevision: boundPublication?.revision,
    publicationDigest: boundPublication?.evidence_digest };

  const certificates: SignedCertificate[] = [];
  let participantsCount = 0;
  let judgesCount = 0;
  let winnersCount = 0;

  // 1. Participant certificates
  const participants = db.all<{ accountId: string; email: string; name: string }>(
    `select a.id as accountId, a.email, a.display_name as name
       from membership m
       join account a on a.id = m.account_id
      where m.event_id = :event and m.role = 'participant'
      order by a.email`,
    { event: event.id },
  );

  for (const p of participants) {
    const payload: CertificatePayload = {
      serial: `CERT-P-${event.id}-${p.accountId}`,
      eventId: event.id,
      eventName: event.name,
      recipientName: p.name,
      recipientEmail: p.email,
      category: "participation",
      detail: `Participant in ${event.name}`,
      issuedAt: now,
      issuerOrigin: origin.origin,
      ...binding,
    };
    certificates.push(issueCertificate(payload, privateKey));
    participantsCount += 1;
  }

  // 2. Judge certificates
  const judges = db.all<{ accountId: string; email: string; name: string }>(
    `select a.id as accountId, a.email, a.display_name as name
       from membership m
       join account a on a.id = m.account_id
      where m.event_id = :event and m.role = 'judge'
        and (exists (select 1 from ballot b where b.event_id = :event and b.judge_id = a.id and b.submitted_at is not null)
          or exists (select 1 from comparison c where c.event_id = :event and c.judge_id = a.id))
      order by a.email`,
    { event: event.id },
  );

  for (const j of judges) {
    const payload: CertificatePayload = {
      serial: `CERT-J-${event.id}-${j.accountId}`,
      eventId: event.id,
      eventName: event.name,
      recipientName: j.name,
      recipientEmail: j.email,
      category: "judge",
      detail: `Official Judge for ${event.name}`,
      issuedAt: now,
      issuerOrigin: origin.origin,
      ...binding,
    };
    certificates.push(issueCertificate(payload, privateKey));
    judgesCount += 1;
  }

  // 3. Published rubric-only placements
  if (event.results_public) assertVotingClosed(event, now);
  const projectRows = db.all<{ id: string; title: string; teamId: string }>(
    `select id, title, team_id as teamId from project where event_id = :event and status = 'submitted'`,
    { event: event.id },
  );

  const pubVer = publishedVersion(db, event.id);
  if (event.results_public && event.pairwise_enabled === 0 && pubVer !== undefined && projectRows.length > 0) {
    const publication = latestPublication(db, event.id);
    const frozen = publication ? JSON.parse(publication.report) as { projects?: { project: string; rank: number }[] } : null;
    const sorted = frozen ? (frozen.projects ?? []).map((p) => ({ project: p.project, rankAdjusted: p.rank }))
      : (() => { const input = loadJudgingInput(db, event.id, pubVer);
        return input.ballots.length ? normalizeScores(input.rubric, input.ballots).projects : []; })();
    if (sorted.length > 0) {
      const projectMap = new Map(projectRows.map((p) => [p.id, p]));
      const placements = ["1st Place", "2nd Place", "3rd Place"];

      for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const ranked = sorted[i];
        if (!ranked) continue;
        const proj = projectMap.get(ranked.project);
        if (!proj) continue;

        const members = db.all<{ id: string; email: string; name: string }>(
          `select a.id, a.email, a.display_name as name
             from team_member tm
             join account a on a.id = tm.account_id
            where tm.team_id = :t`,
          { t: proj.teamId },
        );

        for (const m of members) {
          const payload: CertificatePayload = {
            serial: `CERT-W-${event.id}-${proj.id}-${m.id}-${i + 1}`,
            eventId: event.id,
            eventName: event.name,
            recipientName: m.name,
            recipientEmail: m.email,
            category: "placement",
            detail: `${placements[i]} - ${proj.title}`,
            issuedAt: now,
            issuerOrigin: origin.origin,
            ...binding,
          };
          certificates.push(issueCertificate(payload, privateKey));
          winnersCount += 1;
        }
      }
    }
  }

  for (const cert of certificates) {
    if (!verifyCertificate(cert, publicKey)) {
      throw new Error(`Integrity fault: Newly minted certificate ${cert.serial} failed verification!`);
    }
  }

  return {
    event: event.name,
    totalIssued: certificates.length,
    participants: participantsCount,
    judges: judgesCount,
    winners: winnersCount,
    publicKeyPem,
    issuerKeyId: keyId,
    publicationRevision: boundPublication?.revision,
    publicationDigest: boundPublication?.evidence_digest,
    certificates,
  };
}
