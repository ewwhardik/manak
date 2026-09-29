/**
 * Two-Factor Authentication (TOTP / RFC 6238) and inline SVG QR code engine.
 *
 * Implements:
 *   - Pure node:crypto HMAC-SHA1 time-based one-time password generation and verification.
 *   - Crockford/RFC 4648 Base32 secret encoder and decoder.
 *   - Replay protection and drift tolerance (+/- 1 step).
 *   - Single-use cryptographically random backup recovery codes.
 *   - Zero-dependency inline SVG QR code matrix generator for mobile authenticator apps
 *     (Google Authenticator, Microsoft Authenticator, 1Password, etc.).
 */

import { createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encodes a buffer into RFC 4648 base32 (without padding).
 */
export function encodeBase32(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes an RFC 4648 base32 string into a Uint8Array.
 */
export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s=-]+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!;
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Generates a random 20-byte base32 TOTP secret key (160 bits).
 */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  return encodeBase32(bytes);
}

/**
 * Calculates RFC 6238 TOTP 6-digit code for a given timestamp.
 */
export function calculateTotp(
  secretBase32: string,
  timestampMs: number,
  timeStepSec: number = 30,
): { readonly code: string; readonly step: number } {
  const step = Math.floor(timestampMs / 1000 / timeStepSec);
  const key = decodeBase32(secretBase32);

  const counterBuf = Buffer.alloc(8);
  // Write 64-bit integer big-endian
  counterBuf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counterBuf.writeUInt32BE(step >>> 0, 4);

  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const codeInt =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = (codeInt % 1000000).toString().padStart(6, "0");
  return { code: otp, step };
}

/**
 * Verifies a 6-digit TOTP code with time-step drift tolerance.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  timestampMs: number,
  lastUsedStep: number = 0,
  window: number = 1,
): { readonly valid: boolean; readonly step: number } {
  const cleanToken = token.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleanToken)) {
    return { valid: false, step: 0 };
  }

  const currentStep = Math.floor(timestampMs / 1000 / 30);

  for (let offset = -window; offset <= window; offset++) {
    const step = currentStep + offset;
    if (step <= lastUsedStep) continue; // Replay protection

    const expected = calculateTotp(secretBase32, step * 30 * 1000);
    if (expected.code === cleanToken) {
      return { valid: true, step };
    }
  }

  return { valid: false, step: 0 };
}

/**
 * Generates 8 random single-use backup recovery codes.
 */
export function generateBackupCodes(count: number = 8): readonly string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = randomBytes(4).toString("hex").toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  }
  return codes;
}

/**
 * Builds the standard otpauth URI.
 */
export function buildOtpauthUri(
  accountEmail: string,
  secretBase32: string,
  issuer: string = "Manak",
): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const encIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

// ============================================================================
// Zero-Dependency Pure TypeScript QR Code Generator
// ============================================================================

// GF(256) math with primitive polynomial 0x11D (285)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j] ?? 0;
      const exp = GF_EXP[i] ?? 0;
      next[j] = (next[j] ?? 0) ^ gfMul(p, exp);
      next[j + 1] = (next[j + 1] ?? 0) ^ p;
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ res[0]!;
    for (let j = 0; j < ecCount - 1; j++) {
      res[j] = res[j + 1]! ^ gfMul(gen[j]!, factor);
    }
    res[ecCount - 1] = gfMul(gen[ecCount - 1]!, factor);
  }
  return res;
}

/**
 * QR Code Version 4-M (33x33 modules, capacity: 64 data codewords, 36 EC codewords).
 * Sufficient for standard otpauth URIs up to ~80 chars.
 */
export function generateQrCodeSvg(text: string): string {
  const utf8 = Buffer.from(text, "utf8");

  // QR Version 4-M specifications:
  // Total codewords = 100, EC codewords = 36, Data codewords = 64
  const DATA_CAPACITY = 64;
  const EC_COUNT = 36;
  const SIZE = 33; // Version 4 size = 17 + 4*4 = 33

  // Bit buffer for byte mode (0100) + 8-bit character count indicator
  const bitBuf: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bitBuf.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(utf8.length, 8); // Char count
  for (let i = 0; i < utf8.length; i++) {
    pushBits(utf8[i]!, 8);
  }

  // Terminator (up to 4 zeroes)
  const remCapBits = DATA_CAPACITY * 8 - bitBuf.length;
  const termLen = Math.min(4, remCapBits);
  pushBits(0, termLen);

  // Pad to multiple of 8
  while (bitBuf.length % 8 !== 0) {
    bitBuf.push(0);
  }

  // Convert bits to data codewords
  const dataCodewords = new Uint8Array(DATA_CAPACITY);
  for (let i = 0; i < bitBuf.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bitBuf[i * 8 + j]!;
    }
    dataCodewords[i] = b;
  }

  // Pad with alternating 0xEC and 0x11
  let padIdx = bitBuf.length / 8;
  let padByte = 0xec;
  while (padIdx < DATA_CAPACITY) {
    dataCodewords[padIdx++] = padByte;
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  // Compute Reed-Solomon error correction
  const ecCodewords = rsCompute(dataCodewords, EC_COUNT);

  // All codewords combined
  const allCodewords = new Uint8Array(DATA_CAPACITY + EC_COUNT);
  allCodewords.set(dataCodewords, 0);
  allCodewords.set(ecCodewords, DATA_CAPACITY);

  // Initialize module matrix (null = unassigned, false = light, true = dark)
  const matrix: (boolean | null)[][] = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => null),
  );
  const isFunction: boolean[][] = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => false),
  );

  const setModule = (r: number, c: number, dark: boolean, func: boolean = true) => {
    if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
      matrix[r]![c] = dark;
      if (func) isFunction[r]![c] = true;
    }
  };

  // 1. Finder patterns (7x7) + separators
  const drawFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row >= 0 && row < SIZE && col >= 0 && col < SIZE) {
          if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
            const isDark =
              r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
            setModule(row, col, isDark);
          } else {
            setModule(row, col, false); // separator
          }
        }
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, SIZE - 7);
  drawFinder(SIZE - 7, 0);

  // 2. Alignment pattern at (26, 26) for Version 4
  const alignR = 26;
  const alignC = 26;
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isDark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      setModule(alignR + r, alignC + c, isDark);
    }
  }

  // 3. Timing patterns
  for (let i = 8; i < SIZE - 8; i++) {
    const isDark = i % 2 === 0;
    const row6 = matrix[6];
    const rowI = matrix[i];
    if (row6 && row6[i] === null) setModule(6, i, isDark);
    if (rowI && rowI[6] === null) setModule(i, 6, isDark);
  }

  // 4. Dark module
  setModule(4 * 4 + 9, 8, true);

  // 5. Reserve format info areas around finders
  for (let i = 0; i <= 8; i++) {
    if (matrix[8]![i] === null) setModule(8, i, false);
    if (matrix[i]![8] === null) setModule(i, 8, false);
    if (matrix[8]![SIZE - 1 - i] === null) setModule(8, SIZE - 1 - i, false);
    if (matrix[SIZE - 1 - i]![8] === null) setModule(SIZE - 1 - i, 8, false);
  }

  // 6. Data placement (zigzag 2-columns right to left)
  let codewordIdx = 0;
  let bitIdx = 7;
  let upwards = true;

  for (let right = SIZE - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Skip vertical timing pattern
    const rows = upwards
      ? Array.from({ length: SIZE }, (_, i) => SIZE - 1 - i)
      : Array.from({ length: SIZE }, (_, i) => i);

    for (const r of rows) {
      for (const c of [right, right - 1]) {
        if (!isFunction[r]![c]) {
          let dark = false;
          if (codewordIdx < allCodewords.length) {
            dark = ((allCodewords[codewordIdx]! >>> bitIdx) & 1) === 1;
            bitIdx--;
            if (bitIdx < 0) {
              bitIdx = 7;
              codewordIdx++;
            }
          }
          // Mask 0: (row + col) % 2 == 0
          const mask = (r + c) % 2 === 0;
          matrix[r]![c] = mask ? !dark : dark;
        }
      }
    }
    upwards = !upwards;
  }

  // 7. Format information for M (00) and Mask 0 (000): Format bits = 0b00000 -> BCH code = 0b0000000000 -> XOR 0x5412 = 0x5412 = 101010000010010
  const formatBits = 0b101010000010010;
  const getFBit = (idx: number) => ((formatBits >>> (14 - idx)) & 1) === 1;

  for (let i = 0; i <= 5; i++) setModule(8, i, getFBit(i), true);
  setModule(8, 7, getFBit(6), true);
  setModule(8, 8, getFBit(7), true);
  setModule(7, 8, getFBit(8), true);
  for (let i = 9; i <= 14; i++) setModule(14 - i, 8, getFBit(i), true);

  for (let i = 0; i <= 7; i++) setModule(SIZE - 1 - i, 8, getFBit(i), true);
  for (let i = 8; i <= 14; i++) setModule(8, SIZE - 15 + i, getFBit(i), true);

  // 8. Render as SVG
  const border = 4;
  const totalSize = SIZE + border * 2;
  const rects: string[] = [];

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (matrix[r]![c] === true) {
        rects.push(`<rect x="${c + border}" y="${r + border}" width="1" height="1"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges" aria-label="QR Code for TOTP Setup">
  <rect width="${totalSize}" height="${totalSize}" fill="#ffffff"/>
  <g fill="#000000">
    ${rects.join("")}
  </g>
</svg>`;
}
