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
  </style>
</head>
<body>
<main>
  <nav class="nav"><a href="/">← Return to Portal</a></nav>
  <h1>Offline Certificate Verifier</h1>
  <p>Paste a public key that you obtained from the organizer through a trusted channel. A key copied from a certificate or the same unverified server cannot establish organizer identity. This page uses local WebCrypto; save the key and this page for offline use.</p>
  <p><a href="/.well-known/manak-key.pub">Download this server's current public key</a> and compare its SHA-256 key ID with an independently shared fingerprint. Keep older keys to verify records issued before rotation.</p>
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
</main>
<script>
  const result = document.getElementById('result');
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
      if (cert.certificateVersion === 2) {
        if (cert.issuerKeyId !== keyId) throw new Error('The certificate key ID does not match the trusted key.');
        fields.push(2, cert.issuerKeyId, cert.publicationRevision ?? null, cert.publicationDigest ?? null);
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
    } catch (error) { result.textContent = 'Verification failed: ' + (error instanceof Error ? error.message : String(error)); }
  });
</script>
</body>
</html>`;
}
