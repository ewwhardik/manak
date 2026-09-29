/** Standalone verifier: the operator must pin the issuer key outside the certificate. */
export function verifyPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Offline Certificate Verifier · Manak</title>
  <link rel="stylesheet" href="/assets/manak.css">
  <style>
    main { max-width: 52rem; margin: 2rem auto; padding: 1rem; }
    textarea { width: 100%; min-height: 8rem; box-sizing: border-box; font-family: monospace; }
    label { display: block; margin-top: 1.25rem; font-weight: bold; }
    #result { margin-top: 1.5rem; padding: 1rem; border: 1px solid currentColor; white-space: pre-wrap; }
    :focus-visible { outline: 3px solid #f0a43a; outline-offset: 3px; }
    .key-load-row { display: flex; align-items: center; gap: 0.75rem; margin: 0.75rem 0; flex-wrap: wrap; }
    .helper-text { font-size: 0.85rem; opacity: 0.75; }
  </style>
</head>
<body>
<main>
  <nav class="nav"><a href="/">← Return to Portal</a></nav>
  <h1>Offline Certificate Verifier</h1>
  <p>Paste a public key that you obtained from the organizer through a trusted channel. A key copied from a certificate or the same unverified server cannot establish organizer identity. This page uses local WebCrypto; save the key and this page for offline use.</p>
  <p><a href="/.well-known/manak-key.pub">Download this server's current public key</a> and compare its SHA-256 key ID with an independently shared fingerprint. Keep older keys to verify records issued before rotation.</p>
  <div class="key-load-row">
    <button type="button" id="btnLoadKey">Auto-load server public key</button>
    <button type="button" id="btnDemoCert" style="background:#0284c7;color:#fff;border:none;padding:0.4rem 0.85rem;border-radius:4px;cursor:pointer;font-weight:500;">Auto-load demo certificate</button>
    <button type="button" id="btnTamper" style="background:#dc2626;color:#fff;border:none;padding:0.4rem 0.85rem;border-radius:4px;cursor:pointer;font-weight:500;">Demonstrate tamper test</button>
  </div>
  <label for="pubkey">Trusted issuer public key (Ed25519 SPKI PEM)</label>
  <textarea id="pubkey" spellcheck="false"></textarea>
  <label for="certJson">Signed certificate JSON</label>
  <textarea id="certJson" spellcheck="false"></textarea>
  <label for="correctionKey">Trusted correction key (leave blank if it is the issuer key above)</label>
  <textarea id="correctionKey" spellcheck="false"></textarea>
  <label for="bundle">Optional signed correction bundle JSON</label>
  <textarea id="bundle" spellcheck="false"></textarea>
  <p>The bundle can prove a listed revocation or supersession. An absent entry does not prove that no correction exists; get a current bundle from the organizer.</p>
  <button type="button" id="btnCheck">Verify certificate</button>
  <p id="result" role="status" aria-live="polite">Awaiting certificate and trusted key.</p>
  <div id="inspector"></div>
</main>
<script>
  const result = document.getElementById('result');
  const inspector = document.getElementById('inspector');
  const btnLoadKey = document.getElementById('btnLoadKey');
  if (btnLoadKey) {
    btnLoadKey.addEventListener('click', async () => {
      try {
        const res = await fetch('/.well-known/manak-key.pub');
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching public key');
        document.getElementById('pubkey').value = await res.text();
        result.textContent = 'Server public key loaded into field. Paste signed certificate JSON to verify.';
      } catch (err) {
        result.textContent = 'Failed to load server key: ' + (err instanceof Error ? err.message : String(err));
      }
    });
  }

  const btnDemoCert = document.getElementById('btnDemoCert');
  if (btnDemoCert) {
    btnDemoCert.addEventListener('click', async () => {
      try {
        result.textContent = 'Loading demo key and certificate...';
        const keyRes = await fetch('/.well-known/manak-key.pub');
        if (!keyRes.ok) throw new Error('HTTP ' + keyRes.status + ' fetching public key');
        document.getElementById('pubkey').value = await keyRes.text();
        const certRes = await fetch('/api/events/sample-hack-2026/certificates');
        if (!certRes.ok) throw new Error('HTTP ' + certRes.status + ' fetching demo certificates');
        const certData = await certRes.json();
        const list = certData.certificates || [];
        if (!list.length) throw new Error('No certificates found in sample-hack-2026');
        document.getElementById('certJson').value = JSON.stringify(list[0], null, 2);
        document.getElementById('btnCheck').click();
      } catch (err) {
        result.textContent = 'Failed to load demo certificate: ' + (err instanceof Error ? err.message : String(err));
      }
    });
  }

  const btnTamper = document.getElementById('btnTamper');
  if (btnTamper) {
    btnTamper.addEventListener('click', async () => {
      try {
        let val = document.getElementById('certJson').value.trim();
        if (!val) {
          const keyRes = await fetch('/.well-known/manak-key.pub');
          if (keyRes.ok) document.getElementById('pubkey').value = await keyRes.text();
          const certRes = await fetch('/api/events/sample-hack-2026/certificates');
          if (certRes.ok) {
            const certData = await certRes.json();
            if ((certData.certificates || []).length > 0) {
              val = JSON.stringify(certData.certificates[0], null, 2);
            }
          }
        }
        if (!val) throw new Error('Load a certificate first.');
        const cert = JSON.parse(val);
        cert.recipientName = (cert.recipientName || 'Participant') + ' (Tampered)';
        document.getElementById('certJson').value = JSON.stringify(cert, null, 2);
        document.getElementById('btnCheck').click();
      } catch (err) {
        result.textContent = 'Tamper test error: ' + (err instanceof Error ? err.message : String(err));
      }
    });
  }

  function bytesFromHex(hex) {
    if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error('Invalid hexadecimal signature.');
    return Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
  }
  function bytesFromPem(pem) {
    const value = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, '').replace(/\\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid public key PEM.');
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  }
  function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
  document.getElementById('btnCheck').addEventListener('click', async () => {
    try {
      const pem = document.getElementById('pubkey').value.trim();
      if (!pem) throw new Error('Paste an independently trusted public key.');
      const cert = JSON.parse(document.getElementById('certJson').value.trim());
      const names = ['serial', 'eventId', 'eventName', 'recipientName', 'recipientEmail', 'category', 'detail', 'issuedAt', 'issuerOrigin'];
      if (!names.every(name => Object.hasOwn(cert, name)) || typeof cert.signature !== 'string') throw new Error('Invalid certificate fields.');
      const fields = names.map(name => cert[name]);
      const der = bytesFromPem(pem);
      if (der.length < 32) throw new Error('Invalid Ed25519 public key.');
      const rawKey = der.slice(-32);
      const keyId = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', rawKey)));
      if (cert.certificateVersion === 2 || cert.certificateVersion === 3) {
        if (cert.issuerKeyId !== keyId) throw new Error('The certificate key ID does not match the trusted key.');
        fields.push(cert.certificateVersion, cert.issuerKeyId, cert.publicationRevision ?? null, cert.publicationDigest ?? null);
        if (cert.certificateVersion === 3) {
          const p = cert.presentation;
          if (!p || typeof p.heading !== 'string' || typeof p.body !== 'string' ||
            typeof p.footer !== 'string' || typeof p.signatory !== 'string' ||
            (p.logoSha256 !== null && !/^[0-9a-f]{64}$/.test(p.logoSha256))) throw new Error('Invalid signed certificate design.');
          fields.push(p.heading, p.body, p.footer, p.signatory, p.logoSha256);
        }
      } else if (cert.certificateVersion !== undefined) throw new Error('Unsupported certificate version.');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)));
      const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
      const signature = bytesFromHex(cert.signature);
      if (signature.length !== 64 || !await crypto.subtle.verify('Ed25519', key, signature, digest)) {
        throw new Error('Signature invalid for this certificate and key.');
      }
      let status = 'No correction bundle supplied; current status is unknown.';
      const bundleText = document.getElementById('bundle').value.trim();
      if (bundleText) {
        const bundle = JSON.parse(bundleText);
        if (!Array.isArray(bundle.records)) throw new Error('Correction bundle must contain records.');
        const correctionDer = document.getElementById('correctionKey').value.trim()
          ? bytesFromPem(document.getElementById('correctionKey').value.trim()) : der;
        const correctionKeyId = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', correctionDer.slice(-32))));
        const correctionKey = await crypto.subtle.importKey('spki', correctionDer, { name: 'Ed25519' }, false, ['verify']);
        const matches = bundle.records.filter(item => item.serial === cert.serial && item.eventId === cert.eventId);
        for (const item of matches) {
          if (item.issuerKeyId !== correctionKeyId) throw new Error('Correction key ID does not match the trusted correction key.');
          const values = ['manak-certificate-correction-v1', item.id, item.eventId, item.serial,
            item.action, item.replacementSerial, item.publicationRevision, item.publicationDigest,
            item.reason, item.issuedAt, item.issuerKeyId];
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
          if (!await crypto.subtle.verify('Ed25519', correctionKey, bytesFromHex(item.signature), bytes)) {
            throw new Error('A correction signature is invalid.');
          }
        }
        if (matches.length) {
          const latest = matches.sort((a, b) => b.issuedAt - a.issuedAt || b.id.localeCompare(a.id))[0];
          status = latest.action === 'revoke' ? 'REVOKED: ' + latest.reason :
            'SUPERSEDED by ' + latest.replacementSerial + ': ' + latest.reason;
        } else status = 'No matching correction in this bundle; completeness is unverified.';
      }
      result.textContent = 'Signature valid. Issuer key ID: ' + keyId + '\\nSerial: ' + cert.serial +
        '\\nRecipient: ' + cert.recipientName + '\\nEvent: ' + cert.eventName +
        '\\nPublication revision: ' + (cert.publicationRevision ?? 'legacy / unbound') +
        '\\nStatus: ' + status;
      if (inspector) {
        inspector.innerHTML = '<div style="margin-top:1rem;padding:1rem;border-radius:6px;background:rgba(16,185,129,0.1);border:1px solid #10b981;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">' +
            '<span style="font-weight:700;color:#10b981;font-size:1.05rem;">✔ Cryptographic Verification Passed</span>' +
            '<span style="background:#10b981;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;">GENUINE ED25519</span>' +
          '</div>' +
          '<table style="width:100%;font-size:0.85rem;border-collapse:collapse;">' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Algorithm</td><td><strong>Ed25519 (RFC 8032) + SHA-256 (FIPS 180-4)</strong></td></tr>' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Issuer Key ID</td><td><code>' + keyId + '</code></td></tr>' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Certificate Serial</td><td><code>' + cert.serial + '</code></td></tr>' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Recipient</td><td><strong>' + cert.recipientName + '</strong> &lt;' + cert.recipientEmail + '&gt;</td></tr>' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Event</td><td>' + cert.eventName + '</td></tr>' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Publication</td><td>Revision ' + (cert.publicationRevision ?? 'legacy') + '</td></tr>' +
            '<tr><td style="padding:4px 0;opacity:0.7;">Correction Status</td><td>' + status + '</td></tr>' +
          '</table>' +
          '<div style="margin-top:0.75rem;">' +
            '<a href="/events/' + encodeURIComponent(cert.eventId || 'sample-hack-2026') + '/certificates/' + encodeURIComponent(cert.serial) + '.svg" download style="display:inline-block;padding:0.4rem 0.85rem;background:#10b981;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;font-size:0.85rem;">Download Recipient SVG Certificate</a>' +
          '</div>' +
        '</div>';
      }
    } catch (error) {
      result.textContent = 'Verification failed: ' + (error instanceof Error ? error.message : String(error));
      if (inspector) {
        inspector.innerHTML = '<div style="margin-top:1rem;padding:1rem;border-radius:6px;background:rgba(239,68,68,0.1);border:1px solid #ef4444;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">' +
            '<span style="font-weight:700;color:#ef4444;font-size:1.05rem;">✖ Verification Failed / Tamper Detected</span>' +
            '<span style="background:#ef4444;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;">TAMPERED / INVALID</span>' +
          '</div>' +
          '<p style="margin:0;font-size:0.85rem;color:#fca5a5;line-height:1.4;">' + (error instanceof Error ? error.message : String(error)) + '</p>' +
          '<p style="margin:0.5rem 0 0 0;font-size:0.8rem;opacity:0.8;">The Ed25519 digital signature does not match the computed SHA-256 payload digest. Any alteration to recipient details, scores, or presentation breaks cryptographic verification.</p>' +
        '</div>';
      }
    }
  });
</script>
</body>
</html>`;
}
