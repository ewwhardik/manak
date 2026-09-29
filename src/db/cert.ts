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
import { latestPublication } from "./publication.ts";
import { certificateTemplate, verifyCertificateLogo } from "./certificate-template.ts";
import type { CertificatePresentation } from "./certificate-template.ts";

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
  presentation?: CertificatePresentation;
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
  if (payload.certificateVersion === 3) fields.push(3, payload.issuerKeyId,
    payload.publicationRevision ?? null, payload.publicationDigest ?? null,
    payload.presentation?.heading, payload.presentation?.body, payload.presentation?.footer,
    payload.presentation?.signatory, payload.presentation?.logoSha256);
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
  if (cert.certificateVersion !== undefined && cert.certificateVersion !== 2 && cert.certificateVersion !== 3) return false;
  if (cert.certificateVersion === 3 && !cert.presentation) return false;
  if ((cert.certificateVersion === 2 || cert.certificateVersion === 3) && cert.issuerKeyId) {
    const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
    const der = key.export({ type: "spki", format: "der" });
    if (issuerKeyId(der.subarray(der.length - 32).toString("hex")) !== cert.issuerKeyId) return false;
  }
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

export type PublicCertificate = {
  serial: string; eventName: string; recipientName: string; category: CertificateCategory;
  detail: string; issuedAt: number; issuerOrigin: string; issuerKeyId: string | null;
  publicationRevision: number | null; presentation: CertificatePresentation | null;
  logoDataUrl: string | null; status: "active" | "revoked" | "superseded";
  correctionReason: string | null; replacementSerial: string | null;
};

/** Read an issued record only from its frozen batch or signed replacement log. */
export function publicCertificate(db: Db, eventId: string, serial: string): PublicCertificate | undefined {
  const batch = issuedEventCertificates(db, eventId);
  if (!batch) return undefined;
  const rows = db.all<CorrectionRow>("select * from certificate_correction where event_id = :event order by issued_at, id", { event: eventId });
  const cert = batch.certificates.find((item) => item.serial === serial) ?? rows.flatMap((row) =>
    row.replacement_certificate ? [JSON.parse(row.replacement_certificate) as SignedCertificate] : []).find((item) => item.serial === serial);
  if (!cert) return undefined;
  const keyPem = batch.certificates.some((item) => item.serial === serial) ? batch.publicKeyPem :
    rows.find((row) => row.replacement_serial === serial)?.public_key_pem;
  if (!keyPem || !verifyCertificate(cert, keyPem)) throw new Error("Stored certificate signature is invalid.");
  for (const row of rows) {
    if (!verifyCertificateCorrection(publicCorrection(row), row.public_key_pem)) throw new Error("Stored certificate correction signature is invalid.");
    const der = createPublicKey(row.public_key_pem).export({ type: "spki", format: "der" });
    if (issuerKeyId(der.subarray(der.length - 32).toString("hex")) !== row.issuer_key_id) throw new Error("Stored certificate correction key ID is invalid.");
  }
  const latest = rows.filter((row) => row.serial === serial).at(-1);
  const logoDataUrl = cert.presentation?.logoSha256 ? batch.logoDataUrl ?? null : null;
  if (cert.presentation && !verifyCertificateLogo(logoDataUrl, cert.presentation.logoSha256)) throw new Error("Stored certificate logo is invalid.");
  return {
    serial: cert.serial, eventName: cert.eventName, recipientName: cert.recipientName,
    category: cert.category, detail: cert.detail, issuedAt: cert.issuedAt,
    issuerOrigin: cert.issuerOrigin, issuerKeyId: cert.issuerKeyId ?? null,
    publicationRevision: cert.publicationRevision ?? null, presentation: cert.presentation ?? null,
    logoDataUrl, status: latest?.action === "revoke" ? "revoked" : latest?.action === "supersede" ? "superseded" : "active",
    correctionReason: latest?.reason ?? null, replacementSerial: latest?.replacement_serial ?? null,
  };
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
    issuerOrigin: prior.issuerOrigin, certificateVersion: prior.certificateVersion === 3 ? 3 : 2, issuerKeyId: key.keyId,
    publicationRevision: publication.revision, publicationDigest: publication.evidence_digest,
    ...(prior.certificateVersion === 3 ? { presentation: prior.presentation } : {}),
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
  logoDataUrl?: string | null;
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
  const template = certificateTemplate(db, event.id);
  if (!verifyCertificateLogo(template.logoDataUrl, template.presentation.logoSha256)) throw new Error("Certificate logo digest does not match the saved image.");
  const binding = { certificateVersion: 3, issuerKeyId: keyId,
    publicationRevision: boundPublication?.revision,
    publicationDigest: boundPublication?.evidence_digest,
    presentation: template.presentation };

  const certificates: SignedCertificate[] = [];
  let participantsCount = 0;
  let judgesCount = 0;
  let winnersCount = 0;

  // Participation is earned by membership on a team with a submitted project.
  const participants = db.all<{ accountId: string; email: string; name: string }>(
    `select a.id as accountId, a.email, a.display_name as name
       from membership m
       join account a on a.id = m.account_id
      where m.event_id = :event and m.role = 'participant'
        and exists (select 1 from team_member tm join project p
          on p.event_id = tm.event_id and p.team_id = tm.team_id
          where tm.event_id = :event and tm.account_id = a.id and p.status = 'submitted'
            and (p.duplicate_of is null or p.duplicate_decision = 'cleared'))
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

  // A judge must have evidence and no unfinished assigned rubric reviews.
  const judges = db.all<{ accountId: string; email: string; name: string }>(
    `select a.id as accountId, a.email, a.display_name as name
       from membership m
       join account a on a.id = m.account_id
      where m.event_id = :event and m.role = 'judge'
        and m.evidence_excluded_at is null
        and (exists (select 1 from ballot b where b.event_id = :event and b.judge_id = a.id and b.submitted_at is not null)
          or exists (select 1 from comparison c where c.event_id = :event and c.judge_id = a.id and c.outcome <> 'skip'))
        and not exists (select 1 from assignment x where x.event_id = :event and x.judge_id = a.id
          and not exists (select 1 from ballot b where b.event_id = x.event_id
            and b.judge_id = x.judge_id and b.project_id = x.project_id and b.submitted_at is not null))
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

  // Awards are decisions on the exact frozen revision, across judging modes.
  if (event.results_public) assertVotingClosed(event, now);
  const awards = boundPublication ? db.all<{ id: string; award_key: string; place: number | null;
      decision_type: string; project_id: string; title: string; team_id: string }>(
    `select a.id, a.award_key, a.place, a.decision_type, a.project_id, p.title, p.team_id
       from award_decision a join project p on p.event_id = a.event_id and p.id = a.project_id
      where a.event_id = :event and a.publication_revision = :revision
      order by a.place is null, a.place, a.award_key, a.id`,
    { event: event.id, revision: boundPublication.revision }) : [];
  for (const award of awards) {
    const members = db.all<{ id: string; email: string; name: string }>(
      `select a.id, a.email, a.display_name as name from team_member tm
       join account a on a.id = tm.account_id
       where tm.event_id = :event and tm.team_id = :team order by a.email`,
      { event: event.id, team: award.team_id });
    for (const member of members) {
      const payload: CertificatePayload = {
        serial: `CERT-W-${event.id}-${award.id}-${member.id}`,
        eventId: event.id, eventName: event.name,
        recipientName: member.name, recipientEmail: member.email,
        category: "placement",
        detail: award.decision_type === "placement"
          ? `Place ${award.place}: ${award.award_key} — ${award.title}`
          : `${award.award_key} — ${award.title}`,
        issuedAt: now, issuerOrigin: origin.origin, ...binding,
      };
      certificates.push(issueCertificate(payload, privateKey));
      winnersCount++;
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
    logoDataUrl: template.logoDataUrl,
    certificates,
  };
}
