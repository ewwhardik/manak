/**
 * Automated repository commit window auditor CLI.
 *
 * Verifies that git commits were authored strictly within an event's submission window.
 * Reads author timestamps (RFC 3339 / ISO 8601) and classifies work as:
 *   - VERIFIED: All commits authored within the window.
 *   - SUSPICIOUS: Commits exist outside window (pre-existing base or late activity).
 *   - DISQUALIFIED: Zero commits in window.
 *
 * Usage:
 *   node --experimental-strip-types tools/audit-commits.ts --start 2026-09-25T18:00:00Z --close 2026-09-29T23:30:00+05:30 [--dir .]
 */

import { execFileSync } from "node:child_process";
import { auditCommitWindow } from "../src/judging/index.ts";
import type { CommitRecord } from "../src/judging/index.ts";

function parseArgs(args: readonly string[]): {
  start: string;
  close: string;
  dir: string;
} {
  let start = "";
  let close = "";
  let dir = ".";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--start" && i + 1 < args.length) {
      start = args[++i]!;
    } else if (arg === "--close" && i + 1 < args.length) {
      close = args[++i]!;
    } else if (arg === "--dir" && i + 1 < args.length) {
      dir = args[++i]!;
    }
  }

  // Fallbacks if not provided: default demo hackathon window
  if (!start) start = "2026-09-25T18:00:00.000Z";
  if (!close) close = "2026-09-29T18:00:00.000Z";

  return { start, close, dir };
}

export function readLocalGitCommits(cwd: string): CommitRecord[] {
  try {
    const raw = execFileSync("git", ["log", "--format=%H|%aI|%an|%s"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [sha, authorDate, author, ...msgParts] = line.split("|");
        return {
          sha: sha?.trim() ?? "",
          authorDate: authorDate?.trim() ?? "",
          author: author?.trim() ?? "",
          message: msgParts.join("|").trim(),
        };
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Could not inspect git log in ${cwd}: ${message}\n`);
    return [];
  }
}

const { start, close, dir } = parseArgs(process.argv.slice(2));
const commits = readLocalGitCommits(dir);
const report = auditCommitWindow(commits, { startsAt: start, closesAt: close });

process.stdout.write("==================================================================\n");
process.stdout.write(`GIT COMMIT WINDOW AUDIT REPORT: [${report.status}]\n`);
process.stdout.write("==================================================================\n");
process.stdout.write(`Directory:       ${dir}\n`);
process.stdout.write(`Window Start:    ${start}\n`);
process.stdout.write(`Window Close:    ${close}\n`);
process.stdout.write(`Total Commits:   ${report.totalCommits}\n`);
process.stdout.write(`In Window:       ${report.commitsInWindow}\n`);
process.stdout.write(`First Commit:    ${report.firstCommitAt ?? "—"}\n`);
process.stdout.write(`Last Commit:     ${report.lastCommitAt ?? "—"}\n`);
process.stdout.write(`Outside Window:  ${report.outsideWindowCommits.length}\n`);
process.stdout.write(`Summary:         ${report.summary}\n`);

if (report.outsideWindowCommits.length > 0) {
  process.stdout.write("\nOutside Window Commits:\n");
  for (const c of report.outsideWindowCommits.slice(0, 10)) {
    process.stdout.write(`  • [${c.relativePosition}] ${c.sha.slice(0, 8)} (${c.authorDate}) - ${c.author}: ${c.message.slice(0, 50)}\n`);
  }
  if (report.outsideWindowCommits.length > 10) {
    process.stdout.write(`  ... and ${report.outsideWindowCommits.length - 10} more outside window.\n`);
  }
}
process.stdout.write("==================================================================\n");
