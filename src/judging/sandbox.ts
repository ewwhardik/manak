/** Read-only alternatives and anonymous, reconstructible review explanations. */
import type { Ballot, Comparison, Rubric } from "./types.ts";
import { normalizeScores } from "./normalize.ts";
import type { NormalizationResult } from "./normalize.ts";
import { weightedTotal } from "./weighted.ts";
import { fitBradleyTerry } from "./bradleyterry.ts";
import { rankDescending } from "./stats.ts";

export function reviewExplanations(rubric: Rubric, ballots: readonly Ballot[], fit: NormalizationResult) {
  const judges = new Map(fit.judges.map(j => [j.judge, j]));
  return fit.projects.map(project => {
    const reviews = ballots.filter(b => b.project === project.project).map(ballot => {
      const judge = judges.get(ballot.judge)!;
      const raw = weightedTotal(rubric, ballot.scores);
      const baseline = fit.grandMean + judge.leniency + judge.leniencyPending;
      return { raw, baseline, scale: judge.scale, weight: judge.informationWeight,
        shrinkage: judge.shrinkage, slopeFitted: judge.slopeFitted,
        calibrated: fit.grandMean + (raw - baseline) / judge.scale };
    }).sort((a, b) => a.raw - b.raw || a.calibrated - b.calibrated)
      .map((review, i) => ({ label: `Review ${i + 1}`, ...review }));
    return { project: project.project, grandMean: fit.grandMean, rawMean: project.rawMean,
      adjusted: project.adjusted, rankRaw: project.rankRaw, rank: project.rankAdjusted,
      rankMove: project.rankMove, reviews };
  });
}

export type SandboxMethod = { name: string; available: boolean; caveat: string;
  scores: { project: string; score: number; rank: number }[] };

export function normalizationSandbox(rubric: Rubric | null, ballots: readonly Ballot[], comparisons: readonly Comparison[]): SandboxMethod[] {
  const output: SandboxMethod[] = [];
  const add = (name: string, scores: { project: string; score: number }[], caveat: string) => {
    const ranks = rankDescending(scores.map(s => ({ key: s.project, score: s.score })));
    output.push({ name, available: scores.length > 0, caveat,
      scores: scores.map(s => ({ ...s, rank: ranks.get(s.project)! })).sort((a, b) => a.rank - b.rank || a.project.localeCompare(b.project)) });
  };
  const implied: Comparison[] = [];
  if (rubric && ballots.length) {
    const fit = normalizeScores(rubric, ballots);
    add('Raw mean', fit.projects.map(p => ({ project: p.project, score: p.rawMean })), 'Weighted rubric totals averaged per project; judge severity is unadjusted.');
    add('Calibrated', fit.projects.map(p => ({ project: p.project, score: p.adjusted })), `Production additive and scale model. Converged: ${fit.converged}; settled: ${fit.settled}.`);
    const additive = normalizeScores(rubric, ballots, { scaleFloor: 1, scaleCeiling: 1 });
    add('Additive only', additive.projects.map(p => ({ project: p.project, score: p.adjusted })), `Scale fixed to 1; removes fitted leniency. Converged: ${additive.converged}.`);
    const groups = new Map<string, { project: string; y: number }[]>();
    for (const ballot of ballots) {
      const group = groups.get(ballot.judge) ?? [];
      group.push({ project: ballot.project, y: weightedTotal(rubric, ballot.scores) });
      groups.set(ballot.judge, group);
    }
    const z = new Map<string, number[]>();
    let omitted = 0;
    let pairCount = 0;
    for (const group of groups.values()) pairCount += group.length * (group.length - 1) / 2;
    for (const [judge, group] of groups) {
      const mean = group.reduce((s, p) => s + p.y, 0) / group.length;
      const sd = Math.sqrt(group.reduce((s, p) => s + (p.y - mean) ** 2, 0) / group.length);
      if (group.length < 2 || sd < 1e-12) omitted++;
      else for (const p of group) { const values = z.get(p.project) ?? []; values.push((p.y - mean) / sd); z.set(p.project, values); }
      if (pairCount <= 10000) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!;
        if (a.y !== b.y && a.project !== b.project) implied.push({ id: String(implied.length), judge, left: a.project, right: b.project, winner: a.y > b.y ? a.project : b.project });
      }
    }
    add('Within-reviewer z-score', [...z].map(([project, values]) => ({ project, score: values.reduce((s, v) => s + v, 0) / values.length })),
      `Population standard deviation per reviewer; ${omitted} constant or single-review reviewer(s) omitted. Projects without supported observations are absent. Units differ from rubric points.`);
    if (pairCount > 10000) output.push({ name: 'Implied Bradley–Terry', available: false, scores: [], caveat: 'More than 10,000 candidate pairs; this bounded interactive sandbox does not expand them.' });
  } else for (const name of ['Raw mean', 'Calibrated', 'Additive only', 'Within-reviewer z-score']) add(name, [], 'No submitted rubric ballots.');
  const bt = (name: string, data: readonly Comparison[], caveat: string) => {
    if (!data.length) { add(name, [], 'No supported non-tied comparisons.'); return; }
    const fit = fitBradleyTerry(data);
    if (!fit.connected || !fit.converged) { add(name, [], 'A comparable ranking needs a connected comparison graph and a converged fit.'); return; }
    add(name, fit.strengths.map(p => ({ project: p.project, score: p.beta })), caveat + ' Log-strength units; no score for projects without comparisons.');
  };
  if (!output.some(m => m.name === 'Implied Bradley–Terry')) bt('Implied Bradley–Terry', implied, 'Within-reviewer rubric ordering converted to comparisons; ties omitted. These derived comparisons are not independent duel evidence.');
  bt('Head-to-head Bradley–Terry', comparisons, 'Actual decided duels only.');
  return output;
}
