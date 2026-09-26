/**
 * Accumulates diagnostics during a judging pass.
 *
 * Five modules in this engine define the same closure over the same two arrays,
 * and every one of them got the contract right, which is exactly why extracting
 * it is safe: a single implementation of a thing that was already identical in
 * five places is a single place to get right rather than a sixth copy to keep
 * in step.
 *
 * The split between `warnings` and `notes` is the same one `bootstrap.ts`
 * documents at length: `warnings` is what the results page prints under "what
 * qualifies these numbers", `notes` is the full table with codes beside it.
 * An informational note that appears in `warnings` trains organizers to scroll
 * past warnings, and it is read at the moment somebody publishes.
 */

import type { Diagnostic } from "./types.ts";

export class DiagnosticCollector {
  readonly warnings: string[] = [];
  readonly notes: Diagnostic[] = [];

  report(
    code: string,
    severity: "info" | "warn",
    message: string,
    subjects: string[] = [],
  ): void {
    if (severity === "warn") this.warnings.push(message);
    this.notes.push({ code, severity, message, subjects });
  }
}
