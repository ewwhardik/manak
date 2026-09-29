import { createHash } from "node:crypto";
import type { Db } from "./open.ts";
import { RuleError } from "./context.ts";

export type CertificatePresentation = {
  heading: string;
  body: string;
  footer: string;
  signatory: string;
  logoSha256: string | null;
};

export type CertificateTemplate = { presentation: CertificatePresentation; logoDataUrl: string | null };

export const DEFAULT_CERTIFICATE_PRESENTATION: CertificatePresentation = {
  heading: "Certificate of Achievement",
  body: "In recognition of dedication, creativity, and contribution to this event.",
  footer: "Hackathon Raptors Organizing Committee",
  signatory: "Hackathon Raptors Jury",
  logoSha256: null,
};

type TemplateRow = { presentation: string; logo_data_url: string | null };

export function certificateTemplate(db: Db, eventId: string): CertificateTemplate {
  const row = db.get<TemplateRow>("select presentation, logo_data_url from certificate_template where event_id = :event", { event: eventId });
  return row ? { presentation: JSON.parse(row.presentation) as CertificatePresentation, logoDataUrl: row.logo_data_url }
    : { presentation: { ...DEFAULT_CERTIFICATE_PRESENTATION }, logoDataUrl: null };
}

function assertUnissued(db: Db, eventId: string): void {
  if (db.get("select 1 from certificate_batch where event_id = :event", { event: eventId })) {
    throw new RuleError("certificate.alreadyIssued", "The issued certificate design is frozen. Corrections preserve that design.");
  }
}

export function saveCertificateTemplate(db: Db, eventId: string, presentation: Omit<CertificatePresentation, "logoSha256">, now: number): CertificateTemplate {
  assertUnissued(db, eventId);
  const prior = certificateTemplate(db, eventId);
  const next = { ...presentation, logoSha256: prior.presentation.logoSha256 };
  db.run(`insert into certificate_template (event_id, presentation, logo_data_url, updated_at)
    values (:event, :presentation, :logo, :at)
    on conflict(event_id) do update set presentation = excluded.presentation, updated_at = excluded.updated_at`,
  { event: eventId, presentation: JSON.stringify(next), logo: prior.logoDataUrl, at: now });
  return { presentation: next, logoDataUrl: prior.logoDataUrl };
}

export function validateCertificateLogo(bytes: Uint8Array, declaredType: string): { dataUrl: string; sha256: string } {
  if (declaredType !== "image/png" && declaredType !== "image/jpeg") throw new RuleError("request.mediaType", "Logo must be a PNG or JPEG file.");
  if (bytes.byteLength < 24 || bytes.byteLength > 96 * 1024) throw new RuleError("request.tooLarge", "Logo must be a PNG or JPEG under 96 KiB.");
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if ((!png && !jpeg) || (png && declaredType !== "image/png") || (jpeg && declaredType !== "image/jpeg")) {
    throw new RuleError("request.mediaType", "Logo must contain valid PNG or JPEG bytes matching its file type.");
  }
  if (png) {
    const b = Buffer.from(bytes);
    if (b.toString("ascii", 12, 16) !== "IHDR" || b.readUInt32BE(16) > 4000 || b.readUInt32BE(20) > 4000 || b.readUInt32BE(16) === 0 || b.readUInt32BE(20) === 0) {
      throw new RuleError("request.malformed", "PNG logo dimensions must be between 1 and 4000 pixels.");
    }
    let offset = 8;
    let ended = false;
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset);
      if (length > b.length - offset - 12) break;
      const chunk = b.toString("ascii", offset + 4, offset + 8);
      offset += length + 12;
      if (chunk === "IEND") { ended = length === 0 && offset === b.length; break; }
    }
    if (!ended) throw new RuleError("request.malformed", "PNG logo must have a complete IEND chunk.");
  } else {
    // Require a JPEG frame header with bounded dimensions; SOI/EOI alone is not an image.
    let offset = 2;
    let framed = false;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 255) break;
      let marker = bytes[offset + 1] as number;
      while (marker === 255) marker = bytes[++offset + 1] as number;
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        const height = ((bytes[offset + 3] as number) << 8) | (bytes[offset + 4] as number);
        const width = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
        framed = width > 0 && height > 0 && width <= 4000 && height <= 4000;
      }
      offset += length;
    }
    if (!framed) throw new RuleError("request.malformed", "JPEG logo needs a frame between 1 and 4000 pixels.");
  }
  const type = png ? "image/png" : "image/jpeg";
  return { dataUrl: `data:${type};base64,${Buffer.from(bytes).toString("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function saveCertificateLogo(db: Db, eventId: string, bytes: Uint8Array, type: string, now: number): CertificateTemplate {
  assertUnissued(db, eventId);
  const { dataUrl, sha256 } = validateCertificateLogo(bytes, type);
  const prior = certificateTemplate(db, eventId);
  const presentation = { ...prior.presentation, logoSha256: sha256 };
  db.run(`insert into certificate_template (event_id, presentation, logo_data_url, updated_at)
    values (:event, :presentation, :logo, :at)
    on conflict(event_id) do update set presentation = excluded.presentation,
      logo_data_url = excluded.logo_data_url, updated_at = excluded.updated_at`,
    { event: eventId, presentation: JSON.stringify(presentation), logo: dataUrl, at: now });
  return { presentation, logoDataUrl: dataUrl };
}

export function clearCertificateLogo(db: Db, eventId: string, now: number): CertificateTemplate {
  assertUnissued(db, eventId);
  const prior = certificateTemplate(db, eventId);
  const presentation = { ...prior.presentation, logoSha256: null };
  db.run(`insert into certificate_template (event_id, presentation, logo_data_url, updated_at)
    values (:event, :presentation, null, :at)
    on conflict(event_id) do update set presentation = excluded.presentation,
      logo_data_url = null, updated_at = excluded.updated_at`,
    { event: eventId, presentation: JSON.stringify(presentation), at: now });
  return { presentation, logoDataUrl: null };
}

export function verifyCertificateLogo(dataUrl: string | null, sha256: string | null): boolean {
  if (sha256 === null) return dataUrl === null;
  if (!dataUrl || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) return false;
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return bytes.length <= 96 * 1024 && createHash("sha256").update(bytes).digest("hex") === sha256;
}
