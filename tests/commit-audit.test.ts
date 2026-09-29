import test from "node:test";
import assert from "node:assert/strict";

import { auditCommitWindow } from "../src/judging/index.ts";
import type { CommitRecord } from "../src/judging/index.ts";

test("empty commit list is classified as DISQUALIFIED", () => {
  const report = auditCommitWindow([], {
    startsAt: "2026-09-25T18:00:00.000Z",
    closesAt: "2026-09-29T18:00:00.000Z",
  });
  assert.equal(report.status, "DISQUALIFIED");
  assert.equal(report.totalCommits, 0);
  assert.equal(report.commitsInWindow, 0);
  assert.equal(report.firstCommitAt, null);
  assert.equal(report.lastCommitAt, null);
});

test("all commits inside submission window produces VERIFIED", () => {
  const commits: CommitRecord[] = [
    { sha: "c1", authorDate: "2026-09-26T10:00:00.000Z", author: "Alice", message: "initial" },
    { sha: "c2", authorDate: "2026-09-27T12:00:00.000Z", author: "Bob", message: "feature" },
    { sha: "c3", authorDate: "2026-09-28T22:00:00.000Z", author: "Alice", message: "final polish" },
  ];
  const report = auditCommitWindow(commits, {
    startsAt: "2026-09-25T18:00:00.000Z",
    closesAt: "2026-09-29T18:00:00.000Z",
  });
  assert.equal(report.status, "VERIFIED");
  assert.equal(report.totalCommits, 3);
  assert.equal(report.commitsInWindow, 3);
  assert.equal(report.outsideWindowCommits.length, 0);
  assert.equal(report.firstCommitAt, "2026-09-26T10:00:00.000Z");
  assert.equal(report.lastCommitAt, "2026-09-28T22:00:00.000Z");
});

test("commits with pre-existing base or late pushes produce SUSPICIOUS", () => {
  const commits: CommitRecord[] = [
    { sha: "c0", authorDate: "2026-08-01T00:00:00.000Z", author: "Alice", message: "pre-existing template" },
    { sha: "c1", authorDate: "2026-09-26T10:00:00.000Z", author: "Alice", message: "hackathon start" },
    { sha: "c2", authorDate: "2026-09-30T01:00:00.000Z", author: "Bob", message: "late fix" },
  ];
  const report = auditCommitWindow(commits, {
    startsAt: "2026-09-25T18:00:00.000Z",
    closesAt: "2026-09-29T18:00:00.000Z",
  });
  assert.equal(report.status, "SUSPICIOUS");
  assert.equal(report.totalCommits, 3);
  assert.equal(report.commitsInWindow, 1);
  assert.equal(report.outsideWindowCommits.length, 2);
  assert.equal(report.outsideWindowCommits[0]?.relativePosition, "before_start");
  assert.equal(report.outsideWindowCommits[1]?.relativePosition, "after_close");
});

test("non-UTC offset timestamps normalize correctly against UTC window", () => {
  const commits: CommitRecord[] = [
    // 2026-09-25T23:30:00+05:30 is 2026-09-25T18:00:00.000Z (exactly on startsAt)
    { sha: "c1", authorDate: "2026-09-25T23:30:00+05:30", author: "Charlie", message: "start in IST" },
    // 2026-09-29T23:25:00+05:30 is 2026-09-29T17:55:00.000Z (5 min before 18:00:00 UTC close)
    { sha: "c2", authorDate: "2026-09-29T23:25:00+05:30", author: "Charlie", message: "finish in IST" },
  ];
  const report = auditCommitWindow(commits, {
    startsAt: "2026-09-25T18:00:00.000Z",
    closesAt: "2026-09-29T18:00:00.000Z",
  });
  assert.equal(report.status, "VERIFIED");
  assert.equal(report.commitsInWindow, 2);
});
