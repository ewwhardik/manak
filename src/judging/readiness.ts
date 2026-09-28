/** Evidence checks, not a claim that a ranking is objectively correct. */
import type { Ballot } from "./types.ts";
import type { NormalizationResult } from "./normalize.ts";
import type { BradleyTerryResult } from "./bradleyterry.ts";
import { components } from "./stats.ts";

export type ReadinessCheck = {
  code: string;
  status: "pass" | "review" | "missing";
  title: string;
  detail: string;
  projects?: readonly { id: string; title: string; status: "draft" | "submitted" }[];
};

export function judgingReadiness(input: {
  projects: readonly string[];
  ballots: readonly Ballot[];
  reviewsPerProject: number;
  rubric: NormalizationResult | null;
  pairwise: BradleyTerryResult | null;
  pairwiseEnabled: boolean;
  duplicates?: readonly { title: string; ids: readonly string[];
    projects: readonly { id: string; title: string; status: "draft" | "submitted" }[] }[];
}) {
  const checks: ReadinessCheck[] = [];
  const add = (code: string, status: ReadinessCheck["status"], title: string, detail: string) =>
    checks.push({ code, status, title, detail });
  const pool = new Set(input.projects);
  const reviewers = new Map<string, Set<string>>();
  const byJudge = new Map<string, string[]>();
  for (const ballot of input.ballots) {
    if (!pool.has(ballot.project)) continue;
    if (!reviewers.has(ballot.project)) reviewers.set(ballot.project, new Set());
    reviewers.get(ballot.project)!.add(ballot.judge);
    if (!byJudge.has(ballot.judge)) byJudge.set(ballot.judge, []);
    byJudge.get(ballot.judge)!.push(ballot.project);
  }
  add("field", pool.size ? "pass" : "missing", "Eligible project field",
    `${pool.size} eligible projects. Withdrawn and disqualified entries are excluded.`);
  if (input.duplicates) {
    if (input.duplicates.length > 0) {
      const count = input.duplicates.reduce((acc, d) => acc + d.projects.length, 0);
      checks.push({ code: "submissions.duplicates", status: "review", title: "Repeated project titles",
        detail: `${count} draft or submitted projects share titles after case and whitespace normalization. A title match does not prove duplicate work. Review each project before finalizing awards; drafts are not eligible submissions.`,
        projects: input.duplicates.flatMap((group) => group.projects),
      });
    } else {
      add("submissions.duplicates", "pass", "Repeated project titles",
        "No repeated titles detected among draft or submitted projects.");
    }
  }
  const rubricMode = input.rubric !== null || !input.pairwiseEnabled;
  if (rubricMode) {
    const short = [...pool].filter((id) => (reviewers.get(id)?.size ?? 0) < input.reviewsPerProject);
    add("coverage", short.length || !pool.size ? "missing" : "pass", "Independent review coverage",
      `${short.length} projects below the target of ${input.reviewsPerProject} distinct reviewers. Drafts do not count.`);
    const edges: [string, string][] = [];
    for (const projects of byJudge.values()) {
      for (const project of projects.slice(1)) edges.push([projects[0]!, project]);
    }
    const groups = components([...pool], edges);
    add("rubric.overlap", groups.length === 1 && pool.size > 0 ? "pass" : "missing", "Shared rubric evidence",
      `${groups.length} review groups. Separate groups cannot distinguish project quality from panel generosity; assign a shared reviewer across groups.`);
    if (groups.length === 1 && pool.size > 1) {
      const bridges = [...byJudge.keys()].filter((excluded) => {
        const remaining: [string, string][] = [];
        for (const [judge, projects] of byJudge) {
          if (judge === excluded) continue;
          for (const project of projects.slice(1)) remaining.push([projects[0]!, project]);
        }
        return components([...pool], remaining).length > 1;
      });
      add("rubric.resilience", bridges.length ? "review" : "pass", "Independent panel connections",
        bridges.length
          ? `${bridges.length} reviewers individually hold the review network together. Add overlapping independent reviews before relying on cross-panel adjustments. This is a structural risk, not evidence of misconduct.`
          : "The review network stays connected after removing any one reviewer. This checks overlap resilience, not statistical certainty.");
    }
    add("rubric.fit", input.rubric === null ? "missing" : input.rubric.converged && input.rubric.settled ? "pass" : "review",
      "Normalization stability", input.rubric === null ? "No submitted rubric scores yet." :
        `Inner fit ${input.rubric.converged ? "converged" : "unfinished"}; scale estimates ${input.rubric.settled ? "settled" : "still moving"}. Inspect model warnings before publishing.`);
    const flat = input.rubric?.judges.filter((judge) => judge.discrimination !== "ok").length ?? 0;
    add("rubric.discrimination", flat ? "review" : input.rubric === null ? "missing" : "pass",
      "Useful scoring range", `${flat} reviewers have low discrimination or insufficient scoring history. Seek more evidence; never silently discard their votes.`);
  }
  if (input.pairwiseEnabled) {
    const fit = input.pairwise;
    const seen = new Set(fit?.strengths.filter((p) => p.comparisons > 0).map((p) => p.project) ?? []);
    const unobserved = [...pool].filter((p) => !seen.has(p)).length;
    add("pairwise.coverage", unobserved || !pool.size ? "missing" : "pass", "Decided pairwise coverage",
      `${unobserved} projects have no decided comparisons. Skips and prior-only strengths provide no evidence.`);
    add("pairwise.connected", fit?.connected && !unobserved ? "pass" : "missing", "Connected comparison graph",
      `${fit?.componentCount ?? pool.size} comparison groups. Add bridge comparisons; a finite prior cannot establish an order between disconnected groups.`);
    add("pairwise.fit", fit === null ? "missing" : fit.converged ? "pass" : "review",
      "Bradley–Terry stability", fit === null ? "No decided comparisons yet." : `Estimator ${fit.converged ? "converged" : "reached its iteration limit"}. Convergence alone does not prove fairness.`);
  }
  const missing = checks.filter((c) => c.status === "missing").length;
  const review = checks.filter((c) => c.status === "review").length;
  return {
    status: missing ? "needs-evidence" : review ? "review-needed" : "checks-passed",
    passed: checks.length - missing - review, total: checks.length, missing, review, checks,
    note: "Advisory checks. The organizer owns publication; passing checks is not a guarantee of fairness or statistical certainty.",
  };
}
