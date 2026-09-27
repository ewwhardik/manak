/**
 * Every operation this deployment has, in one list.
 *
 * The list is the product. `makeRegistry` builds the router from it, `openapiDocument`
 * builds the reference from it, `capabilityMatrix` builds the access table from it, and
 * `assertRegistryComplete` refuses to boot if any entry is malformed. There is no second
 * place a route can be added, which is the property the isolation proof depends on: a
 * handler that is not in this array is not reachable, and one that is in it appears in the
 * published matrix whether its author wanted it to or not.
 *
 * The order is the order the reference page introduces them, and it is editorial rather
 * than mechanical. A reader arriving at `/api/docs` should meet the deployment, then how to
 * get in, then the thing everything else hangs off. The router does not care — it matches
 * on method and path with literal segments beating parameters — so ordering costs nothing
 * and is worth spending on the person reading.
 *
 * The cut line: this file imports and concatenates, and does nothing else. No filtering by
 * configuration, no feature flags, no conditional registration. A deployment whose route
 * list depends on its environment is a deployment whose published capability matrix is a
 * claim about one instance rather than about the code, and the whole point of generating
 * that matrix is that it is neither.
 */

import type { Command } from "../registry.ts";
import { AUTH_COMMANDS } from "./auth.ts";
import { EVENT_COMMANDS } from "./events.ts";
import { JUDGING_COMMANDS } from "./judging.ts";
import { PROJECT_COMMANDS } from "./projects.ts";
import { RESULTS_COMMANDS } from "./results.ts";
import { RUBRIC_COMMANDS } from "./rubrics.ts";
import { SYSTEM_COMMANDS } from "./system.ts";
import { VOTING_COMMANDS } from "./voting.ts";
import { EXPORT_COMMANDS } from "./exports.ts";

export { AUTH_COMMANDS } from "./auth.ts";
export { EVENT_COMMANDS, EVENT_REF, EVENT_SUMMARY, eventSummary } from "./events.ts";
export { PRODUCT, SYSTEM_COMMANDS } from "./system.ts";
export { linkUrl } from "./auth.ts";
export {
  PROJECT_COMMANDS,
  PROJECT_REF,
  PROJECT_SUMMARY,
  projectJson,
  TEAM_REF,
} from "./projects.ts";
export { parseCriteria, RUBRIC_COMMANDS } from "./rubrics.ts";
export { JUDGING_COMMANDS } from "./judging.ts";
export { RESULTS_COMMANDS, liveShow } from "./results.ts";
export { VOTING_COMMANDS } from "./voting.ts";

export const ALL_COMMANDS: readonly Command[] = [
  ...SYSTEM_COMMANDS,
  ...AUTH_COMMANDS,
  ...EVENT_COMMANDS,
  ...PROJECT_COMMANDS,
  ...RUBRIC_COMMANDS,
  ...JUDGING_COMMANDS,
  ...RESULTS_COMMANDS,
  ...VOTING_COMMANDS,
  ...EXPORT_COMMANDS,
];
