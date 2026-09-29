import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { issueCertificate, issuerKeyId, verifyCertificateCorrection } from '../src/db/index.ts';

const python = process.platform === 'win32' ? 'python' : 'python3';
test('pure Python verifier passes RFC 8032 vectors and rejects scalar malleability and identity keys', () => {
  const result = spawnSync(python, ['-c', `
from tools.verify_record import verify_ed25519, L
# RFC 8032 section 7.1: https://www.rfc-editor.org/rfc/rfc8032#section-7.1
vectors = [
('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
'92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00')]
for key, msg, sig in vectors:
    key, msg, sig = bytes.fromhex(key), bytes.fromhex(msg), bytes.fromhex(sig)
    assert verify_ed25519(key, msg, sig)
    assert not verify_ed25519(key, msg + b'x', sig)
    bad = sig[:32] + (int.from_bytes(sig[32:], 'little') + L).to_bytes(32, 'little')
    assert not verify_ed25519(key, msg, bad)
assert not verify_ed25519(bytes.fromhex('01'+'00'*31), b'', bytes.fromhex('01'+'00'*63))
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('Python CLI verifies real Manak legacy/v2/v3 certificates with Unicode and detects tampering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manak-python-cert-'));
  try {
    const keys = generateKeyPairSync('ed25519');
    const hex = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const payload = { serial: 'test', eventId: 'event', eventName: 'मानक 🚀', recipientName: 'Zoë',
      recipientEmail: 'zoe@example.com', category: 'judge' as const, detail: 'Judge\nThank you',
      issuedAt: 1700000000000, issuerOrigin: 'https://example.com' };
    const certs = [issueCertificate(payload, keys.privateKey),
      issueCertificate({ ...payload, certificateVersion: 2, issuerKeyId: issuerKeyId(hex), publicationRevision: 1, publicationDigest: 'a'.repeat(64) }, keys.privateKey),
      issueCertificate({ ...payload, certificateVersion: 3, issuerKeyId: issuerKeyId(hex),
        presentation: { heading: 'Hello', body: 'Body', footer: '', signatory: 'Org', logoSha256: null } }, keys.privateKey)];
    const file = join(dir, 'records.json');
    const pem = join(dir, 'public.pem');
    writeFileSync(pem, keys.publicKey.export({ format: 'pem', type: 'spki' }));
    writeFileSync(file, JSON.stringify({ certificates: certs }));
    const verify = (key: string) => spawnSync(python, ['tools/verify_record.py', file, '--public-key', key], { encoding: 'utf8' });
    const valid = verify(pem);
    assert.equal(valid.status, 0, valid.stderr || String(valid.error));
    assert.match(valid.stdout, /VALID: 3/);
    assert.equal(verify(hex).status, 0);
    const correction = { id: 'correction', eventId: 'event', serial: 'test', action: 'revoke' as const,
      replacementSerial: null, publicationRevision: 2, publicationDigest: 'b'.repeat(64), reason: 'Correction',
      issuedAt: payload.issuedAt, issuerKeyId: issuerKeyId(hex), signature: '' };
    const digest = createHash('sha256').update(JSON.stringify(['manak-certificate-correction-v1',
      correction.id, correction.eventId, correction.serial, correction.action, correction.replacementSerial,
      correction.publicationRevision, correction.publicationDigest, correction.reason, correction.issuedAt,
      correction.issuerKeyId])).digest();
    correction.signature = sign(null, digest, keys.privateKey).toString('hex');
    assert.equal(verifyCertificateCorrection(correction, keys.publicKey), true);
    writeFileSync(file, JSON.stringify(correction));
    assert.equal(verify(pem).status, 0);
    certs[2]!.recipientName = 'Altered';
    writeFileSync(file, JSON.stringify(certs));
    assert.equal(verify(pem).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
