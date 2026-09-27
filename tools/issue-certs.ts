import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  persistEventCertificates,
  issuedEventCertificates,
  findEventBySlug,
  makeContext,
  openDatabase,
} from "../src/db/index.ts";
import type { IssueCertsReport, SignedCertificate } from "../src/db/index.ts";

export type { IssueCertsReport };

export function issueAllCertificates(
  dbPath: string,
  eventSlug: string,
  keyDir = "./data",
  issuerOrigin = "https://manak.local",
): IssueCertsReport {
  const db = openDatabase(dbPath);
  try {
    const event = findEventBySlug(db, eventSlug);
    if (!event) throw new Error("Certificate event does not exist.");
    const existing = issuedEventCertificates(db, event.id);
    if (existing) return existing;
    const ctx = makeContext(db);
    return ctx.recorded({ action: "certificate.issued", eventId: event.id, payload: { source: "cli" } },
      () => persistEventCertificates(db, eventSlug, ctx.now(), keyDir, issuerOrigin));
  } finally {
    db.close();
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("issue-certs.ts")) {
  const { values, positionals } = parseArgs({
    options: {
      db: { type: "string", default: "./data/manak.db" },
      out: { type: "string", default: "./data/certificates.json" },
      keyDir: { type: "string", default: "./data" },
      origin: { type: "string", default: process.env.MANAK_PUBLIC_ORIGIN ?? "https://manak.local" },
    },
    allowPositionals: true,
  });

  const slug = positionals[0];
  if (!slug) {
    process.stderr.write("Usage: node --experimental-strip-types tools/issue-certs.ts <event-slug> [--db ./data/manak.db] [--out ./data/certificates.json]\n");
    process.exit(1);
  }

  try {
    const report = issueAllCertificates(values.db!, slug, values.keyDir, values.origin);
    mkdirSync(dirname(values.out!), { recursive: true });
    writeFileSync(values.out!, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(
      `Successfully issued ${report.totalIssued} Ed25519 verifiable certificates for "${report.event}":\n` +
      `  - ${report.participants} participant certificates\n` +
      `  - ${report.judges} judge certificates\n` +
      `  - ${report.winners} winner certificates\n` +
      `Output written to ${values.out}\n`,
    );
  } catch (err) {
    process.stderr.write(`Error issuing certificates: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
