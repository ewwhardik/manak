/**
 * The storage layer.
 *
 * One direction of dependency: this package imports `src/judging`, and
 * `src/judging` cannot import this one — a rule `tests/source.test.ts` enforces by
 * reading the imports rather than by trusting anyone to remember it. So the engine
 * stays testable without a database, and the only place a storage bug can turn into
 * a wrong ranking is `loadJudgingInput`.
 *
 * Everything above this layer imports from here rather than by deep path. The reason
 * is not tidiness: `ctx.write` refuses to run outside a `recorded()` scope, and a
 * handler that reached past the barrel for a raw `Db` would be able to write without
 * an audit entry. Keeping the surface in one file makes that reach visible in review.
 */

export {
  fromIso,
  getClockOffset,
  manualClock,
  MS,
  realNow,
  resetClockOffset,
  setClockOffset,
  systemClock,
  toIso,
} from "./clock.ts";
export type { Clock } from "./clock.ts";

export { ID_ALPHABET, ID_LENGTH, idTime, isId, makeIds, MAX_ID_TIME } from "./ids.ts";
export type { Random } from "./ids.ts";

export { checkIntegrity, DatabaseError, openDatabase, openReadOnly } from "./open.ts";
export type { Db, OpenOptions, Param, Params } from "./open.ts";

export {
  ARCHIVE_FORMAT,
  ARCHIVE_TABLES,
  exportArchive,
  importArchive,
  MANIFEST,
  NOT_EXPORTED,
  readManifest,
} from "./archive.ts";
export type { ArchiveFile, ImportResult, Manifest } from "./archive.ts";

export {
  appliedMigrations,
  migrate,
  migrationStatus,
  MIGRATIONS_DIR,
  planMigrations,
  readMigrations,
  sha256,
} from "./migrate.ts";
export type {
  AppliedMigration,
  MigrationFile,
  MigrationPlan,
  MigrationResult,
} from "./migrate.ts";

export {
  appendLedger,
  canonicalJson,
  entryHash,
  GENESIS,
  headHash,
  ledgerLength,
  readLedger,
  verifyLedger,
} from "./ledger.ts";
export type { LedgerAppend, LedgerBreak, LedgerEntry } from "./ledger.ts";

export { makeContext, RuleError, UNAUDITED_REASONS } from "./context.ts";
export type { ContextOptions, Ctx, UnauditedReason } from "./context.ts";

export {
  assertGate,
  createEvent,
  createTrack,
  eventsFor,
  findEvent,
  findEventBySlug,
  gatesFor,
  listEvents,
  listTracks,
  setResultsPublic,
  updateEvent,
} from "./repo/events.ts";
export type { EventGates, EventInput, EventRow, TrackRow } from "./repo/events.ts";

export {
  castVote,
  fingerprint,
  shuffleProjectsForVoter,
  startVoter,
  voterStatus,
  voteTotals,
} from "./repo/voting.ts";
export type { VoteRow, VoterRow, VoterToken } from "./repo/voting.ts";

export {
  consumeMagicLink,
  createSession,
  DISPOSABLE_DOMAINS,
  EMAIL_MAX,
  EMAIL_PATTERN,
  findAccount,
  findAccountByEmail,
  grantRole,
  hashToken,
  hasRole,
  isDisposableEmail,
  issueMagicLink,
  MAGIC_LINK_TTL,
  membersOf,
  mintToken,
  normalizeEmail,
  resolveSession,
  revokeRole,
  revokeSession,
  ROLES,
  rolesIn,
  sameToken,
  SESSION_TTL,
  sessionsOf,
  sweepExpired,
  touchSession,
  upsertAccount,
} from "./repo/accounts.ts";
export type {
  AccountRow,
  MagicLinkRow,
  MembershipRow,
  Minted,
  Role,
  SessionRow,
} from "./repo/accounts.ts";

export { consume, enforce, LIMITS, peek, RATE_RESET_KEY, sweepRateLimits } from "./repo/rate.ts";
export type { Limit, LimitName, Verdict } from "./repo/rate.ts";

export {
  addTeamMember,
  createProject,
  createTeam,
  disqualifyProject,
  duplicateCases,
  duplicateMatch,
  duplicateTitles,
  findProject,
  findProjectIn,
  findTeamIn,
  judgeablePool,
  isQuarantined,
  listProjects,
  listTeams,
  submitProject,
  teamMembers,
  teamOf,
  triageDuplicate,
  updateProject,
  withdrawProject,
} from "./repo/projects.ts";
export type { ProjectInput, ProjectRow, ProjectStatus, TeamRow } from "./repo/projects.ts";

export {
  assertScoreInRange,
  createRubricVersion,
  criteriaOf,
  findRubric,
  listRubrics,
  loadRubric,
  publishedVersion,
  publishRubric,
  verifyScoreRanges,
} from "./repo/rubrics.ts";
export type { CriterionInput, CriterionRow, RubricRow } from "./repo/rubrics.ts";

export {
  allComparisons,
  assignProject,
  assignmentsOf,
  ballotsOf,
  canonicalPair,
  comparisonsOf,
  coverageGaps,
  deleteBallot,
  findBallot,
  judgeProgress,
  loadJudgingInput,
  projectCoverage,
  recordComparison,
  saveBallot,
  scoresOf,
  unassignProject,
} from "./repo/judging.ts";
export type {
  AssignmentRow,
  BallotInput,
  BallotRow,
  ComparisonInput,
  ComparisonRow,
  JudgeProgress,
  ProjectCoverage,
} from "./repo/judging.ts";

export {
  certDigest,
  certificateCorrections,
  correctCertificate,
  getOrCreateKeypair,
  issuerKeyId,
  issueCertificate,
  mintEventCertificates,
  certificateKeyDirectory,
  issuedEventCertificates,
  persistEventCertificates,
  publicCertificate,
  verifyCertificate,
  verifyCertificateCorrection,
} from "./cert.ts";
export { abusePolicy, setAbusePolicy, abuseSignalKey, abuseReview, setAbuseReview } from "./repo/abuse.ts";
export type { AbuseReviewState } from "./repo/abuse.ts";
export type {
  CertificateCategory,
  CertificatePayload,
  IssueCertsReport,
  KeypairConfig,
  SignedCertificate,
  SignedCertificateCorrection,
  PublicCertificate,
} from "./cert.ts";
export { certificateTemplate, saveCertificateTemplate, saveCertificateLogo, clearCertificateLogo,
  validateCertificateLogo, verifyCertificateLogo, DEFAULT_CERTIFICATE_PRESENTATION } from "./certificate-template.ts";
export type { CertificatePresentation, CertificateTemplate } from "./certificate-template.ts";

export {
  CSV_STAGES,
  exportCsv,
  formatCsvCell,
  formatCsvRow,
} from "./csv.ts";
export type { CsvStage } from "./csv.ts";
export { assertJudgeCapacity, assertJudgeEligible, configureJudge, judgeRestrictions,
  setJudgeRecusal } from "./repo/judge-roster.ts";
export type { JudgeRestrictions } from "./repo/judge-roster.ts";

export {
  WebhookDispatcher,
  ledgerWebhook,
  signWebhookPayload,
} from "./webhook.ts";
export type {
  WebhookConfig,
  WebhookDelivery,
  WebhookSender,
} from "./webhook.ts";
export { projectComments, addProjectComment, hideProjectComment } from "./repo/projects.ts";
export { assertVotingClosed } from "./repo/events.ts";
export { evidenceDigest, latestPublication, publicationHistory, storePublication } from "./publication.ts";
export type { ResultPublication } from "./publication.ts";

export {
  API_TOKEN_SCOPES,
  apiTokenAllows,
  apiTokensOf,
  createApiToken,
  revokeApiToken,
} from "./repo/api-tokens.ts";
export type { ApiTokenRow, ApiTokenScope } from "./repo/api-tokens.ts";

export {
  publicWebhookAddress,
  resolveWebhookAddress,
  sendPinnedWebhook,
} from "./webhook-transport.ts";
