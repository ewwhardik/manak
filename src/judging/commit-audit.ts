/**
 * Automated commit window auditor for project repositories.
 *
 * Hackathons require projects to be built during the event window.
 * This engine audits git commit author timestamps against the event's
 * start and deadline window [submissionsOpenAt, submissionsCloseAt).
 *
 * Categorization (Raptor Module 06 standard):
 *   - VERIFIED: All commits were authored strictly within the event window.
 *   - SUSPICIOUS: Commits exist both inside and outside the event window (pre-existing base or late pushes).
 *   - DISQUALIFIED: Zero commits in window (entirely pre-existing codebase or empty repository).
 */

export type CommitRecord = {
  readonly sha: string;
  readonly authorDate: string | number;
  readonly message: string;
  readonly author: string;
};

export type WindowBounds = {
  readonly startsAt: number | string;
  readonly closesAt: number | string;
};

export type AuditClassification = "VERIFIED" | "SUSPICIOUS" | "DISQUALIFIED";

export type OutsideCommit = {
  readonly sha: string;
  readonly authorDate: string;
  readonly message: string;
  readonly author: string;
  readonly relativePosition: "before_start" | "after_close";
};

export type CommitAuditReport = {
  readonly totalCommits: number;
  readonly commitsInWindow: number;
  readonly firstCommitAt: string | null;
  readonly lastCommitAt: string | null;
  readonly outsideWindowCommits: readonly OutsideCommit[];
  readonly status: AuditClassification;
  readonly summary: string;
};

function toMillis(value: number | string): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function toIsoString(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Audits a sequence of git commits against the official hackathon submission window.
 */
export function auditCommitWindow(
  commits: readonly CommitRecord[],
  window: WindowBounds,
): CommitAuditReport {
  const startMs = toMillis(window.startsAt);
  const closeMs = toMillis(window.closesAt);

  if (closeMs <= startMs) {
    throw new Error("submissionsCloseAt must be strictly after submissionsOpenAt");
  }

  if (commits.length === 0) {
    return {
      totalCommits: 0,
      commitsInWindow: 0,
      firstCommitAt: null,
      lastCommitAt: null,
      outsideWindowCommits: [],
      status: "DISQUALIFIED",
      summary: "Zero commits found in repository.",
    };
  }

  type ParsedCommit = {
    readonly raw: CommitRecord;
    readonly ms: number;
  };

  const parsedList: ParsedCommit[] = commits.map((c) => ({
    raw: c,
    ms: toMillis(c.authorDate),
  }));

  parsedList.sort((a, b) => a.ms - b.ms || a.raw.sha.localeCompare(b.raw.sha));

  const firstCommitAt = toIsoString(parsedList[0]!.ms);
  const lastCommitAt = toIsoString(parsedList[parsedList.length - 1]!.ms);

  const outside: OutsideCommit[] = [];
  let inWindow = 0;

  for (const item of parsedList) {
    const isBefore = item.ms < startMs;
    const isAfter = item.ms >= closeMs;
    if (isBefore || isAfter) {
      outside.push({
        sha: item.raw.sha,
        authorDate: toIsoString(item.ms),
        message: item.raw.message,
        author: item.raw.author,
        relativePosition: isBefore ? "before_start" : "after_close",
      });
    } else {
      inWindow++;
    }
  }

  let status: AuditClassification;
  let summary: string;

  if (outside.length === 0) {
    status = "VERIFIED";
    summary = `All ${commits.length} commit(s) verified within the event window.`;
  } else if (inWindow > 0) {
    status = "SUSPICIOUS";
    summary = `${outside.length} of ${commits.length} commit(s) authored outside event window (${inWindow} in window). Flagged for organizer review.`;
  } else {
    status = "DISQUALIFIED";
    summary = `All ${commits.length} commit(s) authored outside the official event window.`;
  }

  return {
    totalCommits: commits.length,
    commitsInWindow: inWindow,
    firstCommitAt,
    lastCommitAt,
    outsideWindowCommits: outside,
    status,
    summary,
  };
}
