import type { ViewContext } from "./pages.ts";
import type { CertificatePresentation, PublicCertificate } from "../db/index.ts";
import { DEFAULT_CERTIFICATE_PRESENTATION } from "../db/index.ts";
import { esc, page } from "./html.ts";

type StudioResult = {
  event: string; eventSlug: string; totalIssued: number; participants: number; judges: number;
  winners: number; resultsPublic: boolean;
  certificates: { serial: string; recipientName: string; category: string; detail: string }[];
  template: { presentation: CertificatePresentation; logoDataUrl: string | null };
};

function certPath(slug: string, serial: string): string {
  return `/events/${encodeURIComponent(slug)}/certificates/${encodeURIComponent(serial)}`;
}

function previewSheet(name: string, eventName: string, detail: string,
  presentation: CertificatePresentation, logoDataUrl: string | null,
  serial: string, verificationUrl: string): string {
  return `<article class="certificate-sheet" aria-label="Certificate preview">
  <div class="certificate-sheet-inner">
    <div class="certificate-sheet-top">${logoDataUrl ? `<img class="certificate-logo" src="${esc(logoDataUrl)}" alt="Event logo">` : `<span class="certificate-monogram" aria-hidden="true">M</span>`}<span class="certificate-overline">${esc(eventName)}</span></div>
    <p class="certificate-kicker">Official event record</p>
    <h2>${esc(presentation.heading)}</h2>
    <p class="certificate-presented">Presented to</p>
    <p class="certificate-recipient">${esc(name)}</p>
    <p class="certificate-detail">${esc(detail)}</p>
    <p class="certificate-body">${esc(presentation.body)}</p>
    <div class="certificate-signature"><div><span class="certificate-signature-name">${esc(presentation.signatory)}</span><span class="certificate-signature-label">${esc(presentation.footer)}</span></div><div class="certificate-seal" aria-hidden="true">✦</div></div>
    <div class="certificate-proof"><span>Serial <strong>${esc(serial)}</strong></span><span>Verify <strong>${esc(verificationUrl)}</strong></span></div>
  </div></article>`;
}

export function certificateStudioPage(context: ViewContext): string {
  const result = context.result as StudioResult;
  const slug = result.eventSlug;
  const base = `/events/${encodeURIComponent(slug)}/certificates`;
  const presentation = result.template.presentation;
  const issued = result.totalIssued > 0;
  const example = result.certificates[0];
  const roster = issued ? `<section class="certificate-roster"><div class="certificate-section-head"><div><p class="eyebrow">Issued records</p><h2>Recipient certificates</h2><p>${result.totalIssued} signed records · ${result.participants} participants · ${result.judges} judges · ${result.winners} award recipients</p></div><a class="button" href="/api${base}">Download signed JSON</a></div>
    <div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Category</th><th>Serial</th><th>Open</th></tr></thead><tbody>${result.certificates.map((cert) => `<tr><td>${esc(cert.recipientName)}</td><td>${esc(cert.category)}</td><td><code>${esc(cert.serial)}</code></td><td><a href="${certPath(slug, cert.serial)}">Certificate &amp; verification</a></td></tr>`).join("")}</tbody></table></div></section>` : "";
  return page({ title: "Certificate studio", whoami: context.whoami,
    trail: [{ label: result.event, href: `/events/${encodeURIComponent(slug)}` }, { label: "Certificate studio" }],
    eyebrow: "Organizer workspace", lead: "Design, issue, and share signed certificates for this event.",
    body: `<div class="certificate-studio"><section class="certificate-controls"><p class="eyebrow">01 / Design</p><h2>Make it yours</h2>
      <p>${issued ? "This design was frozen when certificates were issued. Corrections keep the same design." : "Save the wording and logo, preview the result, then issue one permanent signed batch."}</p>
      <form method="post" action="${base}/template"><label for="cert-heading">Heading</label><input id="cert-heading" name="heading" maxlength="90" minlength="3" required value="${esc(presentation.heading)}" ${issued ? "disabled" : ""}>
      <label for="cert-body">Message</label><textarea id="cert-body" name="body" maxlength="350" required ${issued ? "disabled" : ""}>${esc(presentation.body)}</textarea>
      <label for="cert-footer">Footer</label><input id="cert-footer" name="footer" maxlength="120" value="${esc(presentation.footer)}" ${issued ? "disabled" : ""}>
      <label for="cert-signatory">Signatory</label><input id="cert-signatory" name="signatory" maxlength="100" minlength="2" required value="${esc(presentation.signatory)}" ${issued ? "disabled" : ""}>
      ${issued ? "" : '<button type="submit">Save wording</button>'}</form>
      ${issued ? "" : `<form method="post" enctype="multipart/form-data" action="${base}/logo"><label for="cert-logo">Event logo (PNG or JPEG, up to 96 KiB)</label><input id="cert-logo" type="file" name="logo" accept="image/png,image/jpeg" required><button type="submit">Upload logo</button></form>${result.template.logoDataUrl ? `<form method="post" action="${base}/logo/remove"><button type="submit">Remove logo</button></form>` : ""}`}
      <div class="certificate-issue"><p class="eyebrow">02 / Issue</p><h2>Sign the final batch</h2><p>${issued ? "Issued once. Each recipient record carries the saved wording and logo hash in its Ed25519 signature." : result.resultsPublic ? "Results are published. Issuance freezes the saved design and eligible recipients." : "Publish results before issuing certificates."}</p>${issued || !result.resultsPublic ? "" : `<form method="post" action="${base}"><button type="submit">Issue and sign certificates</button></form>`}</div>
    </section><section class="certificate-preview"><div class="certificate-section-head"><div><p class="eyebrow">Preview</p><h2>${issued ? "Issued design" : "Saved design"}</h2></div></div>${previewSheet(example?.recipientName ?? "Recipient Name", result.event, example?.detail ?? `Participant in ${result.event}`, presentation, result.template.logoDataUrl, example?.serial ?? "CERT-PREVIEW", example ? `${base}/${encodeURIComponent(example.serial)}` : `${base}/SERIAL`)}<p class="certificate-help">For each issued record, use the print button to save a PDF or download the standalone SVG. The serial links to the current public verification status.</p></section></div>${roster}` });
}

export function publicCertificatePage(context: ViewContext): string {
  const cert = context.result as PublicCertificate & { eventSlug: string };
  const path = certPath(cert.eventSlug, cert.serial);
  const verifyUrl = new URL(path, cert.issuerOrigin).href;
  const status = cert.status === "active" ? "Signature verified · Active" : cert.status === "revoked" ? "Revoked" : "Superseded";
  const explanation = cert.status === "active" ? "This record's signature and stored design verify against its issuer key. Check the organizer's independently shared key fingerprint to establish issuer identity." :
    cert.status === "revoked" ? `This certificate was revoked. ${cert.correctionReason ?? ""}` :
      `This certificate was superseded. ${cert.correctionReason ?? ""}`;
  const presentation = cert.presentation ?? DEFAULT_CERTIFICATE_PRESENTATION;
  return page({ title: "Certificate verification", whoami: context.whoami,
    trail: [{ label: cert.eventName, href: `/events/${encodeURIComponent(cert.eventSlug)}/results` }, { label: "Certificate" }],
    eyebrow: "Public verification", lead: "A signed event record with its current correction status.",
    body: `<div class="certificate-public"><div class="certificate-status certificate-status-${esc(cert.status)}" role="status"><strong>${esc(status)}</strong><p>${esc(explanation)}</p>${cert.replacementSerial ? `<p><a href="${certPath(cert.eventSlug, cert.replacementSerial)}">View replacement certificate →</a></p>` : ""}</div>
      ${cert.status === "active" ? previewSheet(cert.recipientName, cert.eventName, cert.detail, presentation, cert.logoDataUrl, cert.serial, verifyUrl) : ""}
      <div class="certificate-actions">${cert.status === "active" ? `<a class="button" href="${path}.svg" download="${esc(cert.serial)}.svg">Download SVG</a><span>Use your browser’s Print command to save as PDF.</span>` : ""}<a href="/verify">Offline signature verifier</a></div>
      <dl class="certificate-facts"><dt>Serial</dt><dd><code>${esc(cert.serial)}</code></dd><dt>Recipient</dt><dd>${esc(cert.recipientName)}</dd><dt>Category</dt><dd>${esc(cert.category)}</dd><dt>Issued</dt><dd>${esc(new Date(cert.issuedAt).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" }))}</dd><dt>Issuer key ID</dt><dd><code>${esc(cert.issuerKeyId ?? "Legacy certificate")}</code></dd><dt>Publication revision</dt><dd>${esc(cert.publicationRevision ?? "Legacy")}</dd></dl>
      <p class="certificate-help">A page on this server reports the current status. For independent cryptographic verification, obtain the signed JSON from the organizer and compare its public key fingerprint through a trusted channel.</p></div>` });
}

function svgText(value: string): string { return esc(value).replace(/\r?\n/g, " "); }

/** Standalone, script-free vector artwork for a verified active certificate. */
export function certificateSvg(cert: PublicCertificate, verificationUrl: string): string {
  if (cert.status !== "active") throw new Error("Only active certificates may be downloaded as artwork.");
  const p = cert.presentation ?? DEFAULT_CERTIFICATE_PRESENTATION;
  const bodyLines = p.body.match(/.{1,76}(?:\s|$)/g)?.slice(0, 5).map((x) => x.trim()) ?? [p.body];
  const logo = cert.logoDataUrl ? `<image href="${esc(cert.logoDataUrl)}" x="652" y="85" width="96" height="72" preserveAspectRatio="xMidYMid meet"/>` : `<text x="700" y="135" text-anchor="middle" font-size="34" fill="#a78040">✦</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="990" viewBox="0 0 1400 990" role="img" aria-labelledby="title desc"><title id="title">${svgText(p.heading)} for ${svgText(cert.recipientName)}</title><desc id="desc">${svgText(cert.detail)}. Serial ${svgText(cert.serial)}.</desc><rect width="1400" height="990" fill="#f8f5eb"/><rect x="34" y="34" width="1332" height="922" fill="none" stroke="#a78040" stroke-width="3"/><rect x="48" y="48" width="1304" height="894" fill="none" stroke="#d8c8a8" stroke-width="1"/>${logo}<text x="700" y="195" text-anchor="middle" font-family="Arial,sans-serif" font-size="21" letter-spacing="5" fill="#876d43">${svgText(cert.eventName.toUpperCase())}</text><text x="700" y="260" text-anchor="middle" font-family="Arial,sans-serif" font-size="19" letter-spacing="4" fill="#876d43">OFFICIAL EVENT RECORD</text><text x="700" y="345" text-anchor="middle" font-family="Georgia,serif" font-size="58" fill="#192a2c">${svgText(p.heading)}</text><text x="700" y="408" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="#746e63">PRESENTED TO</text><text x="700" y="485" text-anchor="middle" font-family="Georgia,serif" font-size="54" fill="#192a2c">${svgText(cert.recipientName)}</text><line x1="405" y1="510" x2="995" y2="510" stroke="#bda06a"/><text x="700" y="563" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" fill="#314347">${svgText(cert.detail)}</text>${bodyLines.map((line, i) => `<text x="700" y="${620 + i * 29}" text-anchor="middle" font-family="Georgia,serif" font-size="20" fill="#596163">${svgText(line)}</text>`).join("")}<text x="185" y="800" font-family="Georgia,serif" font-size="28" fill="#192a2c">${svgText(p.signatory)}</text><text x="185" y="835" font-family="Arial,sans-serif" font-size="17" fill="#746e63">${svgText(p.footer)}</text><text x="185" y="902" font-family="Arial,sans-serif" font-size="16" fill="#465457">Serial: ${svgText(cert.serial)}</text><text x="1215" y="902" text-anchor="end" font-family="Arial,sans-serif" font-size="16" fill="#465457">Verify: ${svgText(verificationUrl)}</text></svg>`;
}
