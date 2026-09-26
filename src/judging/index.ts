/**
 * The judging engine.
 *
 * Deliberately free of any dependency, any database call, and any I/O. Every
 * function here takes plain data and returns plain data, which is why the
 * hardest part of the product to get right is also the easiest part to test and
 * the easiest to hand to a sceptic: `npm run prove:normalization` re-derives the
 * published numbers from a seed, on any machine, in about a second.
 */

export type {
  Ballot,
  Comparison,
  Criterion,
  Diagnostic,
  JudgeId,
  PairReason,
  ProjectId,
  Rubric,
} from "./types.ts";
export { JudgingError } from "./types.ts";
export { DiagnosticCollector } from "./diagnostic.ts";

export { makeRng, hashString } from "./rng.ts";
export type { Rng } from "./rng.ts";

// The prose helpers. Exported rather than kept private to the engine because the command layer
// writes sentences of its own beside these ones — a note that says "1 projects" next to one that
// says "1 project" is the same defect a layer further out.
export { agree, names, plural, share } from "./words.ts";

export {
  clamp,
  components,
  correlation,
  get,
  kendallTau,
  mean,
  median,
  rankDescending,
  rmse,
  sampleSd,
  sampleVariance,
  sd,
  tCritical95,
  variance,
} from "./stats.ts";

export { normalizedWeights, scaleMidpoint, weightedTotal, weightedTotals } from "./weighted.ts";

export { normalizeScores, NORMALIZE_DEFAULTS, rawMeanRanking, zScoreRanking } from "./normalize.ts";
export type {
  Discrimination,
  JudgeEffect,
  NormalizationResult,
  NormalizeOptions,
  ProjectScore,
} from "./normalize.ts";

// What the ranking can carry, and what each line of the rubric is doing. Both are
// read-only passes over a fit that already happened: they cannot move a ranking,
// which is what makes them safe to print beside one.
export { panelReliability, RELIABILITY_DEFAULTS } from "./reliability.ts";
export type {
  BallotOutlier,
  JudgeConsistency,
  ProjectInterval,
  ReliabilityOptions,
  ReliabilityResult,
  VarianceShare,
} from "./reliability.ts";

export { criterionInsights, CRITERIA_DEFAULTS } from "./criteria.ts";
export type {
  CriteriaOptions,
  CriteriaResult,
  CriterionInsight,
  CriterionPair,
  CriterionVerdict,
} from "./criteria.ts";

// Whether the panel is ready to be published, judge by judge. Organizer-only by construction:
// the rows name judges, because a report that cannot say which judge is not separating the field
// cannot be acted on. Keeping it off the public projection is the command layer's job.
export { judgeCalibration, CALIBRATION_DEFAULTS } from "./calibration.ts";
export type {
  CalibrationInput,
  CalibrationOptions,
  CalibrationResult,
  CalibrationVerdict,
  JudgeCalibration,
  JudgePair,
  JudgeWorkload,
} from "./calibration.ts";

export { fitBradleyTerry, winProbability, BRADLEY_TERRY_DEFAULTS } from "./bradleyterry.ts";
export type { BradleyTerryOptions, BradleyTerryResult, Strength } from "./bradleyterry.ts";

// What a pairwise ranking establishes, as distinct from what it asserts. A read-only
// pass over a fit that already happened, like `reliability.ts`: it can widen the
// account of a ranking but it cannot move one.
export { bootstrapStrengths, BOOTSTRAP_DEFAULTS } from "./bootstrap.ts";
export type {
  BootstrapOptions,
  BootstrapPair,
  BootstrapResult,
  BootstrapUnit,
  StrengthInterval,
} from "./bootstrap.ts";

export { nextPair, pairingProgress, PAIRING_DEFAULTS } from "./pairing.ts";
export type { PairPick, PairingInput, PairingOptions, PairingProgress, PairInfo } from "./pairing.ts";

export { assignReviews, ASSIGN_DEFAULTS } from "./assign.ts";
export type {
  Assignment,
  AssignJudge,
  AssignmentOptions,
  AssignmentResult,
  AssignProject,
  Shortfall,
} from "./assign.ts";

export { compareRankings, AGREEMENT_DEFAULTS } from "./agreement.ts";
export type { AgreementOptions, AgreementResult, ProjectAgreement } from "./agreement.ts";

// The synthetic-event generator ships with the engine rather than sitting in the
// test folder: the demo seeds a browsable event from it, and anyone evaluating
// the product can re-derive the published normalization numbers on their own
// hardware from a seed printed in the report.
export { DEMO_RUBRIC, simulateComparisons, simulateEvent } from "./simulate.ts";
export type {
  ComparisonSimulationOptions,
  JudgeProfile,
  SimulatedEvent,
  SimulationOptions,
} from "./simulate.ts";

export { detectVoteAbuse, ABUSE_DEFAULTS } from "./abuse.ts";
export type { AbuseReport, AbuseThresholds, RawVote, SuspiciousCluster } from "./abuse.ts";

export { hybridConsensus, kendallW } from "./consensus.ts";
export type { ConsensusOptions, HybridConsensusResult, HybridProject } from "./consensus.ts";

export { detectControversy, CONTROVERSY_DEFAULTS } from "./controversy.ts";
export type { ControversyOptions, ControversyReport, ProjectControversy } from "./controversy.ts";

export { analyzeTournament } from "./condorcet.ts";
export type { ProjectTournamentStanding, TournamentReport } from "./condorcet.ts";

export { triageFinalists } from "./finalists.ts";
export type {
  FinalistCandidate,
  FinalistTriageReport,
  RecommendedDuel,
  TriageOptions,
  TriagedProject,
} from "./finalists.ts";

export { allocateBooths, optimizeJudgeRoutes } from "./expo.ts";
export type { BoothAllocation, BoothOptions, JudgeStop, JudgeTour } from "./expo.ts";
export * from "./sensitivity.ts";
export { judgingReadiness } from "./readiness.ts";
export { decomposeTournament } from "./hodge.ts";
export { wasserstein2, distributionCalibration } from "./distribution.ts";
export { comparisonInformation } from "./information.ts";
export type { InformationPair } from "./information.ts";
