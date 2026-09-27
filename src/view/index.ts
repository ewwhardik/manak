/**
 * The view layer's public surface.
 *
 * Everything that turns a value into markup, and nothing that knows a request exists.
 * `src/http` imports from here; nothing here imports from there, which is what keeps a
 * page from growing its own access check or reading a cookie.
 *
 * The layer order is `db → api → view → http`, and this file is the reason the third
 * arrow points one way.
 */

export {
  attrs,
  definitions,
  esc,
  form,
  meter,
  page,
  prefillFrom,
  prefillFromRaw,
  scroller,
  STYLESHEET_PATH,
  table,
} from "./html.ts";
export type { Breadcrumb, FormOptions, PageOptions, Prefill } from "./html.ts";

export {
  actionForm,
  apiRoute,
  at,
  browserPath,
  commandNamed,
  docsPage,
  eventTrail,
  formPage,
  gatesNotice,
  genericPage,
  humanDuration,
  link,
  markdownish,
  routeFor,
  rows,
  stats,
  tag,
  when,
  zoneOf,
} from "./pages.ts";
export type { View, ViewContext, Views } from "./pages.ts";

export { ADVICE, problemPage } from "./problem.ts";

/**
 * The three page modules Part G added, grouped by who reads them rather than by command.
 *
 * A participant lives on `submit.ts`, a judge on `judge.ts`, and an organizer on `results.ts`;
 * the split is by reader because that is what decides whether a page may name a judge. Nothing
 * outside `views.ts` calls these, and they are still listed here because the rule this file
 * exists to keep is that the whole layer is reachable by reading one file - a page composed
 * somewhere else out of `esc` imported by deep path is the failure it guards against.
 */
export { projectPage, projectsPage, teamsPage } from "./submit.ts";
export { assignmentPreviewPage, duelPage, queuePage } from "./judge.ts";
export { dashboardPage, resultsPage, rubricPage } from "./results.ts";
export { aboutPage } from "./about.ts";
export { verifyPage } from "./verify.ts";
export { guidePage } from "./guide.ts";
export { liveLeaderboardPage } from "./live.ts";
export type { LiveLeaderboardProps, LiveProject } from "./live.ts";
export { tieBreakerPage } from "./tie-breaker.ts";
export type { TieBreakerFinalist, TieBreakerProps } from "./tie-breaker.ts";

export { VIEWS } from "./views.ts";

export { STYLESHEET } from "./style.ts";
export * from "./voting.ts";
export { arenaArt, eventJourney, phaseLabel } from "./arena.ts";
export { mediaImage, textLines } from "./media.ts";
export { informationPanel, evidenceGlossary } from "./information.ts";
export { actionPlan } from "./action-plan.ts";
