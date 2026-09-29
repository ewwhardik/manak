import { defineCommand } from "../registry.ts";
import { ARCHIVE_FORMAT, ARCHIVE_TABLES, CSV_STAGES, exportCsv, headHash } from "../../db/index.ts";
import type { CsvStage, EventRow } from "../../db/index.ts";
import { EVENT_REF } from "./events.ts";

export const download = defineCommand({
  name: "exports.download",
  summary: "Download event records as CSV.",
  method: "GET",
  path: "/api/events/:event/csv/:stage",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, stage: { kind: "enum", values: CSV_STAGES, label: "Export stage" } },
  returns: { kind: "csv" },
  notes: "Includes private event data. Requires the event organizer role for every stage, including results and projects. Use the JSONL archive for lossless backups; spreadsheet exports neutralize formula-like text.",
  handler: ({ ctx, event, input }) => ({
    csv: exportCsv(ctx.db, (event as EventRow).id, input.stage as CsvStage),
    filename: `${(event as EventRow).slug}-${String(input.stage)}.csv`,
  }),
});

export const archiveManifest = defineCommand({
  name: "exports.archive_manifest",
  summary: "Export the full lossless archive manifest and schema metadata.",
  method: "GET",
  path: "/api/events/:event/archive",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        format: { type: "integer" },
        head: { type: "string" },
        tables: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, rows: { type: "integer" } },
            required: ["name", "rows"],
          },
        },
      },
      required: ["format", "head", "tables"],
    },
  },
  notes: "Organizer-only. Exposes archive structure and verified row counts across all strict tables.",
  handler: ({ ctx }) => ({
    format: ARCHIVE_FORMAT,
    head: headHash(ctx.db),
    tables: ARCHIVE_TABLES.map((name) => ({
      name,
      rows: ctx.db.get<{ count: number }>(`select count(*) as count from "${name}"`)?.count ?? 0,
    })),
  }),
});

const DEDICATED_EXPORTS = [
  ["registrations", "registrations"],
  ["teams", "teams"],
  ["projects", "projects"],
  ["scores", "ballots"],
  ["results", "results"],
  ["audit", "audit"],
] as const;

/** Stable, discoverable CSV URLs for tools that do not use the generic stage API. */
export const dedicatedDownloads = DEDICATED_EXPORTS.map(([kind, stage]) => defineCommand({
  name: `exports.${kind}_csv`,
  summary: `Download ${kind} as CSV.`,
  method: "GET",
  path: `/api/events/:event/export/${kind}.csv`,
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF },
  returns: { kind: "csv" },
  notes: "Organizer-only event data. Text cells are escaped against spreadsheet formulas. Use the JSONL archive for a lossless backup.",
  handler: ({ ctx, event }) => ({
    csv: exportCsv(ctx.db, (event as EventRow).id, stage),
    filename: `${(event as EventRow).slug}-${kind}.csv`,
  }),
}));

export const EXPORT_COMMANDS = [download, archiveManifest, ...dedicatedDownloads];
