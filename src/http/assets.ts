/** Only explicitly bundled media can be read. No user-controlled filesystem paths. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SECURITY_HEADERS } from "./respond.ts";

const manifest = new Map([
  ["/assets/judging-orbit.webp", "image/webp"],
  ["/assets/judging-orbit.gif", "image/gif"],
  ["/assets/judging-orbit.webm", "video/webm"],
  ["/assets/favicon.svg", "image/svg+xml"],
]);
const loaded = new Map<string, { bytes: Uint8Array; etag: string }>();

export function bundledAsset(request: Request, pathname: string): Response | null {
  const type = manifest.get(pathname);
  if (!type) return null;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("allow", "GET, HEAD");
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers });
  let asset = loaded.get(pathname);
  if (!asset) {
    const bytes = new Uint8Array(readFileSync(new URL(`../view/assets/${pathname.slice(8)}`, import.meta.url)));
    asset = { bytes, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
    loaded.set(pathname, asset);
  }
  headers.set("content-type", type);
  headers.set("cache-control", "public, max-age=3600, must-revalidate");
  headers.set("etag", asset.etag);
  headers.set("accept-ranges", "bytes");
  const matches = (request.headers.get("if-none-match") ?? "").split(",").map((s) => s.trim().replace(/^W\//, ""));
  if (matches.includes(asset.etag) || matches.includes("*")) return new Response(null, { status: 304, headers });
  const length = asset.bytes.byteLength;
  let start = 0, end = length - 1, status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (range && request.method === "GET" && (!ifRange || ifRange === asset.etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end;
      } else { start = Math.max(0, length - Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length) {
        headers.set("content-range", `bytes */${length}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${length}`);
    }
    // Unsupported multipart or malformed ranges are ignored per HTTP semantics.
  }
  headers.set("content-length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : asset.bytes.slice(start, end + 1), { status, headers });
}
