#!/usr/bin/env python3
"""Offline Manak certificate verifier; Python 3 standard library only.

Usage: python tools/verify_record.py record.json --public-key manak-public.hex
Accepts one certificate (legacy/v2/v3), a certificate issuance report, a list
of certificates/corrections, or one certificate correction. Supply an independently
trusted raw hex or Ed25519 SPKI PEM key (literal or file). Result publications are
unsigned; their revision/digest may be bound inside signed certificates.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import re
import sys

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
I = pow(2, (P - 1) // 4, P)
IDENTITY = (0, 1)


def decode_point(encoded):
    if len(encoded) != 32:
        raise ValueError('Ed25519 point must contain 32 bytes')
    value = int.from_bytes(encoded, 'little')
    y, sign = value & (2**255 - 1), value >> 255
    if y >= P:
        raise ValueError('Noncanonical Ed25519 point')
    x2 = (y*y - 1) * pow(D*y*y + 1, P - 2, P) % P
    x = pow(x2, (P + 3) // 8, P)
    if x*x % P != x2:
        x = x * I % P
    if x*x % P != x2 or (x == 0 and sign):
        raise ValueError('Invalid Ed25519 point')
    if x % 2 != sign:
        x = P - x
    return x, y


def add(a, b):
    x, y = a
    u, v = b
    product = D*x*u*y*v % P
    return ((x*v + y*u) * pow(1 + product, P - 2, P) % P,
            (y*v + x*u) * pow(1 - product, P - 2, P) % P)


def multiply(point, scalar):
    result = IDENTITY
    while scalar:
        if scalar & 1:
            result = add(result, point)
        point = add(point, point)
        scalar >>= 1
    return result


BASE = decode_point(bytes.fromhex('58' + '66'*31))


def verify_ed25519(public_key, message, signature):
    """RFC 8032 Ed25519 equation with canonical encoding/subgroup checks."""
    try:
        if len(public_key) != 32 or len(signature) != 64:
            return False
        scalar = int.from_bytes(signature[32:], 'little')
        if scalar >= L:
            return False
        a, r = decode_point(public_key), decode_point(signature[:32])
        if a == IDENTITY or multiply(a, L) != IDENTITY or multiply(r, L) != IDENTITY:
            return False
        challenge = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), 'little') % L
        return multiply(BASE, scalar) == add(r, multiply(a, challenge))
    except (ValueError, TypeError):
        return False


def read_key(value):
    if not re.fullmatch(r'[0-9a-fA-F]{64}', value) and '-----BEGIN' not in value:
        value = pathlib.Path(value).read_text(encoding='utf-8').strip()
    if re.fullmatch(r'[0-9a-fA-F]{64}', value):
        return bytes.fromhex(value)
    match = re.fullmatch(r'-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*', value)
    if not match:
        raise ValueError('Expected a raw 32-byte hex key or Ed25519 SPKI PEM')
    der = base64.b64decode(''.join(match[1].split()), validate=True)
    if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100'):
        raise ValueError('Public key is not an Ed25519 SPKI key')
    return der[12:]


def record_digest(record):
    if 'action' in record:
        names = ['id', 'eventId', 'serial', 'action', 'replacementSerial', 'publicationRevision',
                 'publicationDigest', 'reason', 'issuedAt', 'issuerKeyId']
        if record['action'] not in ('revoke', 'supersede'):
            raise ValueError('Unsupported correction action')
        fields = ['manak-certificate-correction-v1'] + [record[name] for name in names]
    else:
        fields = [record[name] for name in ['serial', 'eventId', 'eventName', 'recipientName',
                  'recipientEmail', 'category', 'detail', 'issuedAt', 'issuerOrigin']]
        version = record.get('certificateVersion')
        if version is not None and (type(version) is not int or version not in (2, 3)):
            raise ValueError('Unsupported certificate version')
        if version in (2, 3):
            fields += [version, record['issuerKeyId'], record.get('publicationRevision'), record.get('publicationDigest')]
        if version == 3:
            fields += [record['presentation'].get(name) for name in ['heading', 'body', 'footer', 'signatory', 'logoSha256']]
    # Manak timestamps/revisions are integers; reject ambiguous non-JSON JS values.
    if any(type(x) not in (str, int, type(None)) or (type(x) is int and abs(x) > 2**53 - 1) for x in fields):
        raise ValueError('Record fields must be strings, safe integers or null')
    encoded = json.dumps(fields, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(encoded.encode('utf-8', errors='backslashreplace')).digest()


def verify_record(record, key):
    if not isinstance(record, dict) or not re.fullmatch(r'[a-fA-F0-9]{128}', str(record.get('signature', ''))):
        raise ValueError('Record has no valid hexadecimal signature')
    if record.get('issuerKeyId') is not None and record['issuerKeyId'] != hashlib.sha256(key).hexdigest():
        raise ValueError('Issuer key ID does not match the trusted key')
    if not verify_ed25519(key, record_digest(record), bytes.fromhex(record['signature'])):
        raise ValueError('Signature verification failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('record', help='JSON record, list, or certificate issuance report')
    parser.add_argument('--public-key', required=True, help='Trusted raw hex/SPKI PEM key or key file')
    args = parser.parse_args()
    try:
        key = read_key(args.public_key)
        data = json.loads(pathlib.Path(args.record).read_text(encoding='utf-8-sig'))
        records = data.get('certificates', [data]) if isinstance(data, dict) else data
        if not isinstance(records, list) or not records:
            raise ValueError('Expected at least one signed record')
        for record in records:
            verify_record(record, key)
        print(f'VALID: {len(records)} signed record(s); trusted key {hashlib.sha256(key).hexdigest()}')
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(f'INVALID: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
