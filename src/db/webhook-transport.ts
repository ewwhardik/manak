import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';

/** Conservative public-unicast policy. IPv6 transition ranges are rejected too. */
export function publicWebhookAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Only ordinary global unicast, excluding special-purpose 2001::/23,
  // documentation and 6to4 (which can encode private IPv4 destinations).
  const groups = address.toLowerCase().split(':');
  const first = parseInt(groups[0]!, 16);
  const second = parseInt(groups[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    !(first === 0x3fff && second < 0x1000);
}

export async function resolveWebhookAddress(host: string): Promise<{ address: string; family: number }> {
  const literal = host.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Webhook DNS lookup timed out.')), 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some(({ address }) => !publicWebhookAddress(address))) {
    throw new Error('Webhook destination must resolve only to public unicast addresses.');
  }
  return addresses[0]!;
}

/** Resolves once; the socket lookup returns that exact validated IP. HTTPS still
 * verifies the original hostname, redirects are never followed, and no agent is reused. */
export async function sendPinnedWebhook(url: URL, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number }> {
  const pinned = await resolveWebhookAddress(url.hostname);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', agent: false, family: pinned.family, headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, res => {
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve({ status, ok: status >= 200 && status < 300 });
    });
    const timer = setTimeout(() => req.destroy(new Error('Webhook request timed out.')), 5000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', () => reject(new Error('Webhook HTTPS delivery failed.')));
    req.end(body);
  });
}
