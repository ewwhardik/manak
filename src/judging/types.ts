/**
 * Judging engine — shared types.
 *
 * This module is deliberately free of database, HTTP and framework concerns.
 * It takes ballots and comparisons in, and produces rankings and diagnostics
 * out. That keeps the part of the system that is hardest to get right also the
 * part that is easiest to test.
 */

export type ProjectId = string;
export type JudgeId = string;

/** One line of a rubric. `weight` is relative; weights are normalized internally. */
export type Criterion = {
  key: string;
  label: string;
  weight: number;
  min: number;
  max: number;
};

/**
 * Rubrics are versioned. A ballot binds to the version it was scored against,
 * so an organizer editing criteria mid-judging cannot silently rewrite history.
 */
export type Rubric = {
  id: string;
  version: number;
  criteria: Criterion[];
};

/** A judge's scores for one project against one rubric version. */
export type Ballot = {
  id: string;
  judge: JudgeId;
  project: ProjectId;
  rubricVersion: number;
  /** criterion key -> raw score, within that criterion's [min, max] */
  scores: Record<string, number>;
};

/** One pairwise decision. `winner` must be `left` or `right`. */
export type Comparison = {
  id: string;
  judge: JudgeId;
  left: ProjectId;
  right: ProjectId;
  winner: ProjectId;
};

/** Why the pair scheduler chose a given pair — recorded for the audit trail. */
export type PairReason = "bridge" | "informative" | "explore" | "exposure" | "podium";

/**
 * A machine-readable finding, carried alongside the prose warnings rather than
 * instead of them.
 *
 * The engine has always explained itself in sentences, which is right for the
 * organizer reading the results page and useless for anything that wants to
 * branch on a finding — a page that wants to badge one judge, a script that wants
 * to exit non-zero, a test that wants to assert a specific condition without
 * pinning the wording of a sentence. `code` is stable and may be depended on;
 * `message` is prose and may be reworded.
 */
export type Diagnostic = {
  /** Stable dotted identifier, e.g. `judge.lowDiscrimination`. */
  code: string;
  severity: "info" | "warn";
  /** The same sentence that appears in `warnings`, when there is one. */
  message: string;
  /** Judge or project ids the finding is about, if it is about specific ones. */
  subjects: string[];
};

export class JudgingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JudgingError";
    this.code = code;
  }
}
