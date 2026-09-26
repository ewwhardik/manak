/**
 * Synthetic events with a known ground truth.
 *
 * This is the only honest way to make a claim like "normalization improves the
 * ranking". On a real event nobody knows the true ordering, so no amount of
 * plausible-looking output proves anything. Here the true quality of every
 * project and the true leniency and scale of every judge are planted, ballots
 * are generated through them, and the engine is asked to recover what it was
 * never shown. Kendall's tau against the planted truth is then a number that
 * means something.
 *
 * Two details keep the exercise from being rigged in the engine's favour:
 *
 *   - Scores are quantised to the integers a judge can actually click and
 *     clamped to the ends of the scale, so the generative process violates the
 *     model's continuity and homoscedasticity assumptions exactly the way real
 *     ballots do. Censoring at 1 and 5 hurts the harshest and most generous
 *     judges most, which is precisely where a naive fit would look best.
 *   - Assignment runs through the real scheduler, so the design is as unbalanced
 *     as a real event's — which is the whole reason a raw mean misleads.
 *
 * This module ships rather than living in the test folder: the demo seeds a
 * browsable synthetic event from it, and an organizer evaluating the product can
 * rerun the proof on their own hardware from a seed printed in the report.
 */

import type { Ballot, Comparison, JudgeId, ProjectId, Rubric } from "./types.ts";
import { makeRng } from "./rng.ts";
import { clamp } from "./stats.ts";
import { assignReviews } from "./assign.ts";
import type { AssignmentResult } from "./assign.ts";
import { fitBradleyTerry } from "./bradleyterry.ts";
import { nextPair } from "./pairing.ts";

export const DEMO_RUBRIC: Rubric = {
  id: "demo",
  version: 1,
  criteria: [
    { key: "technical", label: "Technical execution", weight: 3, min: 1, max: 5 },
    { key: "design", label: "Design and craft", weight: 2, min: 1, max: 5 },
    { key: "impact", label: "Impact", weight: 3, min: 1, max: 5 },
    { key: "presentation", label: "Presentation", weight: 2, min: 1, max: 5 },
  ],
};

export type JudgeProfile = {
  id: JudgeId;
  /** Additive offset in rubric points: positive is a generous judge. */
  leniency: number;
  /** Multiplier on project quality: 1 is calibrated, 0 is no discrimination. */
  scale: number;
  /** Per-criterion noise, in rubric points. */
  noise: number;
  /** A judge who marks everything the same regardless of what they saw. */
  flat: boolean;
  /**
   * The project this judge is trying to get onto the podium, or `null`.
   *
   * A strategic judge is not a noisy judge with a wide error bar. Their ballots are
   * *coherent* — high where they want it and low where the competition is — which is
   * exactly the shape a fit reads as a confident, discriminating panellist. The
   * planted favourite is kept here so a harness can ask the two questions that matter
   * about them: did the ranking move, and was the judge named.
   */
  favourite?: ProjectId | null;
};

export type SimulationOptions = {
  projects?: number;
  judges?: number;
  reviewsPerProject?: number;
  seed?: number | string;
  rubric?: Rubric;
  /** Spread of true project quality, in rubric points. */
  qualitySd?: number;
  /** Spread of judge leniency, in rubric points. */
  leniencySd?: number;
  /** Log-normal spread of judge scale. 0 makes every judge calibrated. */
  scaleSpread?: number;
  noise?: number;
  /** How many judges mark everything identically. */
  flatJudges?: number;
  /** Score every criterion the same way a flat judge would. */
  flatScore?: number;
  /** Quantise to the integers a judge can click. On by default. */
  round?: boolean;
  /** Tracks to spread projects across. Judges are restricted to one each. */
  tracks?: readonly string[];
  /**
   * How strongly a project's reviewers are drawn from one cohort of judges,
   * from 0 (the balanced scheduler decides) to 1 (cohorts never mix).
   *
   * This is the knob that matters. A perfectly balanced design barely needs
   * normalizing — every project's mean is contaminated by roughly the same
   * average judge, so the contamination cancels. Real events are not balanced:
   * judges drop out, a track's specialists are systematically harsher than the
   * generalists, late submissions are seen by whoever is still awake. Then a
   * project's mean carries the leniency of *its* reviewers, and comparing means
   * across projects compares judges as much as projects.
   *
   * Cohorts are formed by sorting judges on leniency, so cohort membership is
   * strongly correlated with harshness — the pathology, not a random shuffle.
   * True project quality stays independent of the blocks, so any recovered
   * ranking accuracy is real signal and not an artefact of the setup. At 1.0 the
   * design disconnects and leniency stops being identifiable at all, which is
   * the case the engine is supposed to refuse to guess at rather than fudge.
   */
  imbalance?: number;
  /**
   * Spread in how much work judges do, from 0 (everyone files the same number)
   * to 1 (the busiest judge files several times what the quietest does).
   */
  activitySkew?: number;
  /**
   * How many judges are marking to get a particular project onto the podium.
   *
   * Every other knob here models a judge who is *wrong* — harsh, generous, noisy,
   * asleep. This one models a judge who is dishonest, and the difference matters
   * because the corrections in this engine are all built on the assumption that a
   * judge's error is unrelated to which project they are looking at. A strategic
   * judge breaks that assumption on purpose: they mark their favourite at the top of
   * the scale and the projects it is competing with at the bottom, so their offset is
   * zero on average, their scale looks wide, and their ballots look decisive.
   *
   * These judges are taken from the end of the bench so they do not overlap the flat
   * judges, which are taken from the start.
   */
  strategicJudges?: number;
  /** Rubric points added to a strategic judge's favourite. */
  boost?: number;
  /** Rubric points taken off everything else a strategic judge sees. */
  suppress?: number;
  /**
   * Whether the strategic judges are pushing the *same* project.
   *
   * Independent cheats partly cancel: two judges inflating two different projects
   * damage each other's candidate. A pair working together does not, and it is the
   * harder case for any detector, because agreement between them is indistinguishable
   * from two people who simply recognised the same good project.
   */
  collude?: boolean;
};

export type SimulatedEvent = {
  rubric: Rubric;
  projects: ProjectId[];
  judges: JudgeProfile[];
  /** Planted quality, on the rubric scale, centred on zero. */
  truth: Map<ProjectId, number>;
  ballots: Ballot[];
  /** Who reviewed what. */
  design: { judge: JudgeId; project: ProjectId }[];
  /** Present only when the balanced scheduler produced the design. */
  assignment: AssignmentResult | null;
  /** Ballots per judge, min to max — the visible face of activity skew. */
  loadMin: number;
  loadMax: number;
  seed: number | string;
};

const DEFAULTS = {
  projects: 60,
  judges: 12,
  reviewsPerProject: 4,
  seed: "manak",
  qualitySd: 0.7,
  leniencySd: 0.5,
  scaleSpread: 0.35,
  noise: 0.35,
  flatJudges: 0,
  flatScore: 3,
  round: true,
  imbalance: 0,
  activitySkew: 0,
  strategicJudges: 0,
  boost: 1.5,
  suppress: 0.6,
  collude: false,
};

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/**
 * A cohort-correlated design: each project prefers reviewers from the cohort its
 * index falls into, and cohorts are ordered by judge leniency. Within those
 * preferences the least-loaded eligible judge is taken, so the result is skewed
 * but not degenerate, and the activity skew is applied as a per-judge quota.
 *
 * Track restrictions are applied before the cohort preference, not after. A judge
 * confined to one track is ineligible for everything else however unbalanced the
 * design is being asked to be, which is the same rule the real scheduler follows —
 * an imbalance knob that could quietly reassign a hardware judge to a web project
 * would be measuring a design no event could actually run.
 */
function correlatedDesign(
  projects: readonly ProjectId[],
  judges: readonly JudgeProfile[],
  reviewsPerProject: number,
  imbalance: number,
  activitySkew: number,
  seed: number | string,
  projectTrack: Map<ProjectId, string | undefined>,
  judgeTrack: Map<JudgeId, string | undefined>,
): { judge: JudgeId; project: ProjectId }[] {
  const rng = makeRng(`${seed}|correlated`);
  const byLeniency = judges.slice().sort((a, b) => a.leniency - b.leniency);
  const cohorts = Math.max(2, Math.min(judges.length, Math.round(judges.length / 3)));
  const cohortOf = new Map<JudgeId, number>();
  byLeniency.forEach((j, index) => {
    cohortOf.set(j.id, Math.floor((index * cohorts) / byLeniency.length));
  });

  const eligible = (judge: JudgeId, project: ProjectId): boolean => {
    const restriction = judgeTrack.get(judge);
    return restriction === undefined || restriction === projectTrack.get(project);
  };

  // Activity quota: a weight of 1 means average, and the skew stretches the
  // spread multiplicatively so the busiest judge does several times the work.
  const totalSlots = projects.length * reviewsPerProject;
  const weight = new Map<JudgeId, number>();
  judges.forEach((j, index) => {
    const t = judges.length === 1 ? 0 : index / (judges.length - 1);
    weight.set(j.id, 1 + activitySkew * (3 * t - 1.5));
  });
  let weightSum = 0;
  for (const w of weight.values()) weightSum += Math.max(0.1, w);
  const quota = new Map<JudgeId, number>();
  for (const j of judges) {
    quota.set(j.id, (Math.max(0.1, weight.get(j.id) as number) / weightSum) * totalSlots);
  }

  const load = new Map<JudgeId, number>(judges.map((j) => [j.id, 0]));
  const design: { judge: JudgeId; project: ProjectId }[] = [];
  projects.forEach((project, index) => {
    const block = Math.floor((index * cohorts) / projects.length);
    const taken = new Set<JudgeId>();
    for (let slot = 0; slot < reviewsPerProject; slot++) {
      const allowed = judges.filter((j) => !taken.has(j.id) && eligible(j.id, project));
      if (allowed.length === 0) break;
      const preferCohort = rng.next() < imbalance;
      const pool = preferCohort ? allowed.filter((j) => cohortOf.get(j.id) === block) : allowed;
      const candidates = pool.length > 0 ? pool : allowed;
      // Least-loaded relative to quota, so skew is respected without starving.
      candidates.sort(
        (a, b) =>
          (load.get(a.id) as number) / (quota.get(a.id) as number) -
            (load.get(b.id) as number) / (quota.get(b.id) as number) ||
          a.id.localeCompare(b.id),
      );
      const pick = candidates[0] as JudgeProfile;
      taken.add(pick.id);
      load.set(pick.id, (load.get(pick.id) as number) + 1);
      design.push({ judge: pick.id, project });
    }
  });
  return design;
}

export function simulateEvent(options: SimulationOptions = {}): SimulatedEvent {
  const opt = { ...DEFAULTS, ...options };
  const rubric = options.rubric ?? DEMO_RUBRIC;
  const rng = makeRng(opt.seed);
  const tracks = options.tracks;

  const projects: ProjectId[] = [];
  const truth = new Map<ProjectId, number>();
  const projectTrack = new Map<ProjectId, string | undefined>();
  for (let i = 0; i < opt.projects; i++) {
    const id = `p${pad(i + 1, 3)}`;
    projects.push(id);
    truth.set(id, rng.gauss(0, opt.qualitySd));
    projectTrack.set(id, tracks ? (tracks[i % tracks.length] as string) : undefined);
  }

  const judges: JudgeProfile[] = [];
  for (let j = 0; j < opt.judges; j++) {
    const id = `j${pad(j + 1, 2)}`;
    const flat = j < opt.flatJudges;
    judges.push({
      id,
      leniency: flat ? 0 : rng.gauss(0, opt.leniencySd),
      scale: flat ? 0 : Math.exp(rng.gauss(0, opt.scaleSpread)),
      noise: flat ? 0 : opt.noise,
      flat,
    });
  }

  // One track per judge, cycled, so every track has roughly the same bench. Both
  // designs read the restriction from here, which is what makes the balanced and
  // the correlated design comparable: they differ in who gets picked, not in who
  // was allowed to be picked.
  const judgeTrack = new Map<JudgeId, string | undefined>();
  judges.forEach((j, index) => {
    judgeTrack.set(j.id, tracks ? (tracks[index % tracks.length] as string) : undefined);
  });

  const assignment =
    opt.imbalance > 0
      ? null
      : assignReviews(
          projects.map((id) => ({ id, track: projectTrack.get(id) })),
          judges.map((j) => {
            const t = judgeTrack.get(j.id);
            return { id: j.id, tracks: t === undefined ? undefined : [t] };
          }),
          opt.reviewsPerProject,
          `${opt.seed}|assign`,
        );
  const design =
    assignment !== null
      ? assignment.assignments.map((a) => ({ judge: a.judge, project: a.project }))
      : correlatedDesign(
          projects,
          judges,
          opt.reviewsPerProject,
          opt.imbalance,
          opt.activitySkew,
          opt.seed,
          projectTrack,
          judgeTrack,
        );

  // Per-criterion bias, so criteria are not carbon copies of one another.
  const bias = new Map<string, number>();
  for (const c of rubric.criteria) bias.set(c.key, rng.gauss(0, 0.2));

  // Who is cheating, and for whom.
  //
  // Decided after the design rather than with the profiles, because a judge can only push a
  // project they were actually given. The favourite is the *weakest* project on their own
  // list, which is the worst case for the engine and the likelier case in life: a judge who
  // needs to cheat for a project is rarely cheating for the one that would have won anyway.
  //
  // Ties are broken by id so the choice does not depend on map iteration order. Nothing here
  // consumes `rng`, which keeps every other planted quantity identical between a run with
  // strategic judges and the same seed without them — the two runs differ in the ballots and
  // in nothing else, so the tau between them is attributable.
  const seen = new Map<JudgeId, ProjectId[]>(judges.map((j) => [j.id, []]));
  for (const a of design) (seen.get(a.judge) as ProjectId[]).push(a.project);
  // A flat judge cannot also be a strategic one: their branch below ignores what they saw
  // entirely, so a planted favourite would be a cheat that never reaches a ballot and a
  // detection rate measured against it would be measuring nothing.
  const strategic = judges
    .slice(Math.max(0, judges.length - opt.strategicJudges))
    .filter((judge) => !judge.flat);
  const weakest = (list: readonly ProjectId[]): ProjectId | null => {
    let best: ProjectId | null = null;
    for (const p of list) {
      if (best === null) best = p;
      else {
        const here = truth.get(p) as number;
        const there = truth.get(best) as number;
        if (here < there || (here === there && p < best)) best = p;
      }
    }
    return best;
  };
  const favourites = new Map<JudgeId, ProjectId>();
  if (strategic.length > 0) {
    if (opt.collude) {
      // The project the most of them can reach. A pair cannot conspire about a project only
      // one of them was given, and pretending otherwise would measure one cheat under a label
      // that says two — so a judge who cannot reach the shared favourite is left honest, and
      // the harness reads who actually cheated off the profiles rather than off the count.
      const reach = new Map<ProjectId, number>();
      for (const judge of strategic) {
        for (const p of new Set(seen.get(judge.id) as ProjectId[])) {
          reach.set(p, (reach.get(p) ?? 0) + 1);
        }
      }
      const most = Math.max(0, ...reach.values());
      const shared = weakest([...reach].filter(([, n]) => n === most).map(([p]) => p));
      for (const judge of strategic) {
        if (shared !== null && (seen.get(judge.id) as ProjectId[]).includes(shared)) {
          favourites.set(judge.id, shared);
        }
      }
    } else {
      // Each of them takes a different project, and the reason is the label: two independent
      // cheats pushing the same project *is* a colluding pair, so letting the picks collide
      // would measure the colluding row twice and print one of the readings under a heading
      // that says the pairwise machinery had nothing to find. They collide readily on a small
      // field — "the weakest project I was given" is the same project for everybody who was
      // given it — so the exclusion is not a corner case.
      const taken = new Set<ProjectId>();
      for (const judge of strategic) {
        const pick = weakest((seen.get(judge.id) as ProjectId[]).filter((p) => !taken.has(p)));
        if (pick !== null) {
          taken.add(pick);
          favourites.set(judge.id, pick);
        }
      }
    }
  }
  for (const judge of judges) judge.favourite = favourites.get(judge.id) ?? null;

  const byId = new Map<JudgeId, JudgeProfile>(judges.map((j) => [j.id, j]));
  const ballots: Ballot[] = [];
  const load = new Map<JudgeId, number>(judges.map((j) => [j.id, 0]));
  let n = 0;
  for (const a of design) {
    const judge = byId.get(a.judge) as JudgeProfile;
    const quality = truth.get(a.project) as number;
    load.set(a.judge, (load.get(a.judge) as number) + 1);
    // Applied in rubric points after the scale, not to the latent quality before it, because
    // a strategic judge is choosing a mark rather than misperceiving a project. Going through
    // `scale` would make a narrow-scaled judge a weaker cheat, which is backwards.
    const push =
      judge.favourite === null || judge.favourite === undefined
        ? 0
        : a.project === judge.favourite
          ? opt.boost
          : -opt.suppress;
    const scores: Record<string, number> = {};
    for (const c of rubric.criteria) {
      const mid = (c.min + c.max) / 2;
      let value: number;
      if (judge.flat) {
        value = opt.flatScore;
      } else {
        const latent = quality + (bias.get(c.key) as number);
        value = mid + judge.scale * latent + judge.leniency + push + rng.gauss(0, judge.noise);
      }
      if (opt.round) value = Math.round(value);
      scores[c.key] = clamp(value, c.min, c.max);
    }
    ballots.push({
      id: `b${pad(++n, 4)}`,
      judge: a.judge,
      project: a.project,
      rubricVersion: rubric.version,
      scores,
    });
  }

  const loads = [...load.values()];
  return {
    rubric,
    projects,
    judges,
    truth,
    ballots,
    design,
    assignment,
    loadMin: Math.min(...loads),
    loadMax: Math.max(...loads),
    seed: opt.seed,
  };
}

export type ComparisonSimulationOptions = {
  /** Comparisons each judge is asked for. */
  perJudge?: number;
  /**
   * How sharply a judge's choice follows true quality. Higher is a more reliable
   * judge; 2 means a 0.5-point quality gap is called correctly about 73% of the
   * time.
   */
  discrimination?: number;
  /**
   * Spread of a judge's private opinion, in rubric points.
   *
   * Drawn once per judge and project and then applied to every comparison that judge is
   * asked for, so it is a taste and not noise: this judge thinks that project is half a
   * point better than it is, consistently, all weekend. Zero by default, which makes
   * every simulated judge a clone drawing from one shared law — kind to the fit, and
   * fine for asking whether the estimator recovers a planted order.
   *
   * It is the only mechanism here by which two panels of the same size, judging the same
   * projects honestly, produce different rankings, which makes it the thing a
   * judge-clustered bootstrap exists to measure. An interval that does not widen when
   * this is turned up is an interval that is not measuring the panel.
   */
  taste?: number;
  /**
   * Honour the planted judge profiles: a judge's `scale` multiplies their
   * discrimination, and a `flat` judge tosses a coin.
   *
   * Off by default, which is a deliberate asymmetry with the ballot generator and worth
   * being explicit about. `leniency` has no meaning in a comparison — there is no
   * absolute scale to be generous on, which is the entire argument for pairwise judging —
   * but `scale` and `flat` do, and ignoring them models a panel where nobody is having a
   * bad day. Turning it on makes the recovery numbers the tests pin materially harder,
   * so it belongs to the proof that reports adversarial and strategic panels rather than
   * to the default the ordinary tests measure against.
   */
  useProfiles?: boolean;
  /**
   * How hard a judge with a planted `favourite` pushes it in a duel, in the same latent
   * units as quality.
   *
   * The favourite itself is decided by `simulateEvent` through `strategicJudges`, and read
   * from the profile here rather than re-drawn, which is the point: the same judge cheats on
   * the card and in the duels, about the same project. A proof that plants one cheat and then
   * asks two instruments to find it is comparing the instruments; one that plants a separate
   * cheat per instrument is comparing two experiments.
   *
   * Applied to the latent strength rather than to the probability, because a strategic judge
   * in a duel is not misreading a coin — they are answering as though the project were better
   * than it is. At the default a favourite two places below its opponent still wins most of
   * the time, and one far below it still loses, which is what keeps a single cheat from being
   * trivially visible as a judge who always votes one way.
   *
   * Non-zero by default, so a panel that cheats on the card cheats in the duels unless a
   * caller says otherwise. Setting it to 0 is the interesting control — a judge who inflates
   * a score but calls the duels honestly — and it costs nothing, since a run with no
   * strategic judges has no favourite to push and is unaffected either way.
   */
  favouritism?: number;
  /** Refit strengths every this many comparisons, to feed the scheduler. */
  refitEvery?: number;
  seed?: number | string;
};

const COMPARISON_DEFAULTS = {
  perJudge: 12,
  discrimination: 2,
  taste: 0,
  useProfiles: false,
  favouritism: 1.5,
  refitEvery: 25,
};

/**
 * Run the real pair scheduler against simulated judges. Comparisons are drawn
 * from a Bradley-Terry law over the planted quality, so the fit is being asked to
 * recover a truth that genuinely generated the data.
 *
 * By default every judge draws from the same law, which is a panel of clones: the only
 * disagreement is the coin. `taste` gives each judge a private opinion of each project
 * and `useProfiles` lets the planted panel be as blunt as it was planted to be; between
 * them they are how a panel that would have ranked things differently gets simulated.
 *
 * A judge whom `simulateEvent` planted a `favourite` on carries it into the duels too. That
 * is a different thing from taste and worth keeping separate: taste is a judge who is wrong,
 * a favourite is a judge who is lying, and only the second of them coordinates with another
 * judge.
 */
export function simulateComparisons(
  event: SimulatedEvent,
  options: ComparisonSimulationOptions = {},
): Comparison[] {
  const opt = { ...COMPARISON_DEFAULTS, ...options };
  const seed = options.seed ?? `${event.seed}|pairs`;
  const rng = makeRng(seed);
  const comparisons: Comparison[] = [];
  let strengths = new Map<ProjectId, number>();
  let sinceRefit = 0;
  let n = 0;

  // Private opinions are drawn up front, inside the guard, so that leaving `taste` at
  // zero leaves the random stream exactly where it was and every existing simulation
  // reproduces byte for byte.
  const taste = new Map<JudgeId, Map<ProjectId, number>>();
  if (opt.taste > 0) {
    for (const judge of event.judges) {
      const own = new Map<ProjectId, number>();
      for (const project of event.projects) own.set(project, rng.gauss(0, opt.taste));
      taste.set(judge.id, own);
    }
  }

  const rounds = opt.perJudge;
  for (let round = 0; round < rounds; round++) {
    for (const judge of event.judges) {
      const pick = nextPair({
        judge: judge.id,
        projects: event.projects,
        comparisons,
        strengths,
        seed,
      });
      if (pick === null) continue;
      const own = taste.get(judge.id);
      // The push is added to the favourite's side of this duel and nowhere else. A strategic
      // judge's other duels are called honestly, which is what makes the cheat hard: it is a
      // judge who is right about everything except one project.
      const pushed = (project: ProjectId): number =>
        judge.favourite !== null && judge.favourite !== undefined && project === judge.favourite
          ? opt.favouritism
          : 0;
      const qLeft = (event.truth.get(pick.left) as number) + (own?.get(pick.left) ?? 0) + pushed(pick.left);
      const qRight = (event.truth.get(pick.right) as number) + (own?.get(pick.right) ?? 0) + pushed(pick.right);
      const sharpness = opt.useProfiles
        ? judge.flat ? 0 : opt.discrimination * judge.scale
        : opt.discrimination;
      const pLeft = 1 / (1 + Math.exp(-sharpness * (qLeft - qRight)));
      const winner = rng.next() < pLeft ? pick.left : pick.right;
      comparisons.push({
        id: `c${pad(++n, 4)}`,
        judge: judge.id,
        left: pick.left,
        right: pick.right,
        winner,
      });
      if (++sinceRefit >= opt.refitEvery) {
        sinceRefit = 0;
        const fit = fitBradleyTerry(comparisons, event.projects);
        strengths = new Map(fit.strengths.map((s) => [s.project, s.beta]));
      }
    }
  }
  return comparisons;
}
