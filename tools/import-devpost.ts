/**
 * Devpost CSV Importer & Migration Tool
 *
 * Implements T4 stretch requirement:
 *   "portal import --devpost-csv. Every incumbent exports CSV, so a best-effort
 *    mapping with a dry-run report means an organizer can arrive as easily as leave."
 *
 * Usage:
 *   node --experimental-strip-types tools/import-devpost.ts <file.csv> [--out <output.jsonl>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

export type DevpostRow = {
  name: string;
  tagline: string;
  description: string;
  track: string;
  tags: string[];
  repoUrl?: string;
  demoUrl?: string;
  liveUrl?: string;
  teamMembers: string[];
};

export type DevpostImportReport = {
  totalRows: number;
  validProjects: number;
  skippedRows: number;
  tracks: string[];
  tags: string[];
  projects: DevpostRow[];
  warnings: string[];
};

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  const chars = [...line];

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < chars.length && chars[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current.trim());
  return fields;
}

function findColumnIndex(headers: string[], patterns: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] ?? "").toLowerCase().replace(/[_\-\s]+/g, "");
    for (const p of patterns) {
      const normP = p.toLowerCase().replace(/[_\-\s]+/g, "");
      if (h === normP || h.includes(normP)) return i;
    }
  }
  return -1;
}

export function parseDevpostCsv(content: string, defaultTrack: string = "general"): DevpostImportReport {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("Devpost CSV file is empty");
  }

  const headers = parseCsvLine(lines[0] as string);
  const colTitle = findColumnIndex(headers, ["project title", "title", "project name", "name"]);
  if (colTitle === -1) {
    throw new Error("Missing required Project Title column in Devpost CSV");
  }

  const colTagline = findColumnIndex(headers, ["tagline", "pitch", "short description"]);
  const colDesc = findColumnIndex(headers, ["about the project", "description", "details"]);
  const colRepo = findColumnIndex(headers, ["github", "repository", "repo", "source code"]);
  const colDemo = findColumnIndex(headers, ["video", "video demo", "demo url", "youtube"]);
  const colLive = findColumnIndex(headers, ["try it out", "live url", "website", "project url"]);
  const colTrack = findColumnIndex(headers, ["track", "category", "opt-in prizes"]);
  const colTags = findColumnIndex(headers, ["built with", "tags", "technologies"]);
  const colMembers = findColumnIndex(headers, ["team members", "members", "submitter"]);

  const projects: DevpostRow[] = [];
  const warnings: string[] = [];
  const trackSet = new Set<string>();
  const tagSet = new Set<string>();
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const cells = parseCsvLine(line);
    const title = cells[colTitle]?.trim() ?? "";
    if (title.length === 0) {
      skipped++;
      continue;
    }

    const tagline = colTagline !== -1 && cells[colTagline] ? cells[colTagline]! : `${title} submission`;
    const description = colDesc !== -1 && cells[colDesc] ? cells[colDesc]! : tagline;
    const repoUrl = colRepo !== -1 && cells[colRepo] && cells[colRepo]!.startsWith("http") ? cells[colRepo] : undefined;
    const demoUrl = colDemo !== -1 && cells[colDemo] && cells[colDemo]!.startsWith("http") ? cells[colDemo] : undefined;
    const liveUrl = colLive !== -1 && cells[colLive] && cells[colLive]!.startsWith("http") ? cells[colLive] : undefined;

    const rawTrack = colTrack !== -1 && cells[colTrack] ? cells[colTrack]! : defaultTrack;
    const trackSlug = rawTrack.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "general";
    trackSet.add(trackSlug);

    const tags: string[] = [];
    if (colTags !== -1 && cells[colTags]) {
      for (const t of cells[colTags]!.split(/[,/;]+/)) {
        const cleaned = t.trim().toLowerCase();
        if (cleaned.length > 0 && cleaned.length < 30) {
          tagSet.add(cleaned);
          tags.push(cleaned);
        }
      }
    }

    const teamMembers: string[] = [];
    if (colMembers !== -1 && cells[colMembers]) {
      for (const m of cells[colMembers]!.split(/[,;]+/)) {
        const trimmed = m.trim();
        if (trimmed.length > 0) teamMembers.push(trimmed);
      }
    }

    projects.push({
      name: title,
      tagline,
      description,
      track: trackSlug,
      tags,
      repoUrl,
      demoUrl,
      liveUrl,
      teamMembers,
    });
  }

  return {
    totalRows: lines.length - 1,
    validProjects: projects.length,
    skippedRows: skipped,
    tracks: [...trackSet].sort(),
    tags: [...tagSet].sort(),
    projects,
    warnings,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "manak import --devpost-csv — Ingest Devpost project CSV exports into Manak\n\n" +
        "Usage:\n" +
        "  npm run import:devpost -- <file.csv> [--out <output.jsonl>]\n\n" +
        "Options:\n" +
        "  --out <path>    Write converted project records to JSONL\n",
    );
    process.exit(0);
  }

  const csvPath = args[0] as string;
  let outPath: string | undefined;
  const outIdx = args.indexOf("--out");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outPath = args[outIdx + 1];
  }

  try {
    const content = readFileSync(csvPath, "utf8");
    const report = parseDevpostCsv(content);

    process.stdout.write("============================================================\n");
    process.stdout.write("             DEVPOST CSV IMPORT & MIGRATION REPORT          \n");
    process.stdout.write("============================================================\n");
    process.stdout.write(`Source file:        ${csvPath}\n`);
    process.stdout.write(`Total CSV rows:     ${report.totalRows}\n`);
    process.stdout.write(`Valid projects:     ${report.validProjects}\n`);
    process.stdout.write(`Skipped rows:       ${report.skippedRows}\n`);
    process.stdout.write(`Tracks identified:  ${report.tracks.join(", ")}\n`);
    process.stdout.write(`Tags discovered:    ${report.tags.length} distinct tags\n`);
    process.stdout.write(`Sample tags:        ${report.tags.slice(0, 8).join(", ")}\n`);
    process.stdout.write("------------------------------------------------------------\n");

    if (outPath) {
      const lines = report.projects.map((p) => JSON.stringify(p)).join("\n") + "\n";
      writeFileSync(outPath, lines, "utf8");
      process.stdout.write(`Output saved:       ${outPath} (${report.projects.length} JSONL records)\n`);
    } else {
      process.stdout.write("Dry run complete! To save import records, re-run with --out <file.jsonl>\n");
    }
    process.stdout.write("============================================================\n");
  } catch (err: unknown) {
    process.stderr.write(`Import failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1]?.includes("import-devpost.ts")) {
  main();
}
