/**
 * The command layer.
 *
 * One list of operations, four renderings: a JSON API, HTML forms, an OpenAPI document
 * and a capability matrix. Nothing above this layer builds a route by hand, and nothing
 * below it knows an HTTP request exists — `src/db` refuses to import from here, checked
 * by `tests/source.test.ts` rather than remembered.
 *
 * Imports from the storage layer go through `src/db/index.ts` and never a deep path.
 * That rule is also checked, and it is not tidiness: `ctx.write` is what makes every
 * mutation appear in the audit trail, and a handler holding a raw `Db` from
 * `src/db/open.ts` could write around it.
 */

export {
  ANONYMOUS,
  AUDIENCES,
  capabilityMatrix,
  cellsFor,
  decide,
  isRoleAudience,
  matrixMarkdown,
  OWNERSHIPS,
  principalFor,
  requiredRole,
  SESSION_COOKIE,
  WITNESSES,
} from "./capability.ts";
export type {
  Audience,
  Capability,
  Cell,
  Decision,
  Gate,
  MatrixRow,
  Operation,
  Ownership,
  Principal,
  Refusal,
  Witness,
} from "./capability.ts";

export {
  ALLOW_KEY,
  allowedMethods,
  classify,
  describeForLog,
  FALLBACK,
  forbidden,
  httpStatus,
  notFound,
  PROBLEM_MEDIA_TYPE,
  retryAfterSeconds,
  STATUS_TEXT,
  statusForRefusal,
  titleFor,
  toProblem,
  unauthenticated,
} from "./errors.ts";
export type { Classification, ProblemDocument } from "./errors.ts";

export {
  describeField,
  fieldSchema,
  formControls,
  InputError,
  jsonSchema,
  labelFor,
  parseInput,
  redact,
} from "./schema.ts";
export type {
  Control,
  Field,
  FieldKind,
  FieldMeta,
  Fields,
  Parsed,
  Problem,
  RawInput,
} from "./schema.ts";

export {
  assertRegistryComplete,
  bodyFields,
  checkCommand,
  commandDoc,
  defineCommand,
  locationOf,
  makeRegistry,
  METHODS,
  NAME_PATTERN,
  pathFields,
  pathParameters,
  RegistryError,
  requirementSentence,
} from "./registry.ts";
export type { Command, Delivery, FormSpec, Handler, Invocation, LimitContext, Match, Method, Registry, Returns } from "./registry.ts";

export { errorStatuses, openapiDocument, openapiJson, operationId, templatePath } from "./openapi.ts";
export type { DocumentInfo } from "./openapi.ts";

export { buildCsv, escapeCsvCell } from "./csv.ts";
export { RevisionCache } from "./cache.ts";
export { liveShow } from "./commands/index.ts";
export {
  calculateTotp,
  verifyTotp,
  generateTotpSecret,
  generateBackupCodes,
  buildOtpauthUri,
  generateQrCodeSvg,
  encodeBase32,
  decodeBase32,
} from "./totp.ts";
