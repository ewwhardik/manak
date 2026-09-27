/**
 * The rubric: what judges score against, and the one thing in this product that is versioned.
 *
 * Three operations, and the shape of the input is the decision worth defending. **Criteria
 * arrive as one multiline field, one criterion per line, `key | Label | weight | min | max`.**
 *
 * The alternative was a field kind for an array of records. That would have meant a
 * nested-collection parser living in `src/api/schema.ts`, whose entire safety argument is that
 * it has none — nine flat kinds, each a few lines, every one of them auditable in a sitting —
 * and it would have rippled into `fieldSchema`, `formControls`, `jsonSchema`, the OpenAPI
 * document and the form renderer for the benefit of exactly one table. The second alternative
 * was reusing `kind: "scores"` as a key-to-weight map, which forfeits the label and the
 * per-criterion bounds, and a rubric whose criteria have no labels is a rubric judges cannot
 * read.
 *
 * The reason a text field is not merely the cheap answer is the browser. There is no client-side
 * JavaScript in this product by policy, so an HTML form cannot grow a row on demand; a fixed
 * grid of five criteria × five boxes would be twenty-five controls, most of them empty, and an
 * event wanting six criteria would be stuck. A textarea is the one control that holds a list of
 * unknown length without scripting. A JSON client sends the same newline-delimited string, which
 * is the honest cost: this is the one place where the dialect is shaped by the browser's limits,
 * and it is named here rather than hidden.
 *
 * Per-line failures come back as `InputError` problems naming the line, so an organizer fixing a
 * six-criterion rubric sees all six complaints at once instead of finding them one submission at
 * a time.
 *
 * The cut line: there is no `rubrics.update`. `createRubricVersion` always writes a new version
 * and `publishRubric` is one-way, because a ballot records the version it was scored against and
 * an edited rubric would silently redefine ballots already cast. An organizer who wants a
 * different rubric makes version 4 and publishes it; the ballots against version 3 stay
 * readable, and `ballot.staleRubric` tells a judge their console is out of date.
 */

import { defineCommand } from "../registry.ts";
import type { Command } from "../registry.ts";
import { InputError } from "../schema.ts";
import type { Field, Problem } from "../schema.ts";
import { notFound } from "../errors.ts";
import { EVENT_REF } from "./events.ts";
import {
  createRubricVersion,
  criteriaOf,
  findRubric,
  listRubrics,
  publishedVersion,
  publishRubric,
} from "../../db/index.ts";
import type { CriterionInput, CriterionRow, EventRow } from "../../db/index.ts";

/** Above this, the field is being used as a spreadsheet and the ballot becomes unreadable. */
const MAX_CRITERIA = 30;

/** The `criterion` table's own key rule, restated so a capital letter is a 422 and not a 500. */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const CRITERIA: Field = {
  kind: "text",
  min: 1,
  max: 8000,
  multiline: true,
  label: "Criteria",
  help:
    "One per line: key | Label | weight | min | max. The last three are optional and default to " +
    "1 | 1 | 5. Example: craft | Technical craft | 2 | 1 | 5",
};

const VERSION: Field = {
  kind: "int",
  min: 1,
  max: 10000,
  label: "Version",
  help: "Which version to publish. Rubrics are never edited, only superseded.",
};

const CRITERION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    weight: { type: "number" },
    min: { type: "integer" },
    max: { type: "integer" },
  },
  required: ["key", "label", "weight", "min", "max"],
};

function criterionJson(row: CriterionRow): Record<string, unknown> {
  return {
    key: row.key,
    label: row.label,
    weight: row.weight,
    min: row.min_score,
    max: row.max_score,
  };
}

/**
 * The criteria field, as records, and every complaint about it.
 *
 * Exported and pure, so `tests/api.test.ts` can hold it to a table of good and bad input without
 * a database. Problems are collected rather than thrown on the first one for the reason given in
 * the header: an organizer typing six criteria wants six complaints, not six submissions.
 *
 * Blank lines are skipped and a line starting with `#` is a comment. The second one is not
 * decoration — an organizer trimming a rubric down comments a criterion out and keeps it where
 * they can see it, and the cost is one clause.
 */
export function parseCriteria(text: string): { criteria: CriterionInput[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const criteria: CriterionInput[] = [];
  const seen = new Set<string>();
  const say = (line: number, message: string): number =>
    problems.push({ field: "criteria", message: `line ${line}: ${message}` });

  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ at: index + 1, text: raw.trim() }))
    .filter((line) => line.text !== "" && !line.text.startsWith("#"));

  if (lines.length === 0) problems.push({ field: "criteria", message: "has no criteria in it." });
  if (lines.length > MAX_CRITERIA) {
    problems.push({
      field: "criteria",
      message: `has ${lines.length} criteria. The ceiling is ${MAX_CRITERIA}: past that a ballot is a form nobody finishes.`,
    });
    return { criteria, problems };
  }

  for (const line of lines) {
    const parts = line.text.split("|").map((part) => part.trim());
    const [key = "", label = "", weight, min, max] = parts;
    if (parts.length > 5) {
      say(line.at, "has more than five fields. The shape is key | Label | weight | min | max.");
      continue;
    }
    if (!KEY_PATTERN.test(key) || key.length > 40) {
      say(
        line.at,
        `“${key}” is not a usable key. Start with a lower-case letter, then letters, digits or underscores, up to 40.`,
      );
      continue;
    }
    if (seen.has(key)) {
      say(line.at, `“${key}” is already a criterion above.`);
      continue;
    }
    if (label === "") {
      say(line.at, `“${key}” has no label. Judges read the label, not the key.`);
      continue;
    }
    if (label.length > 160) {
      say(line.at, `the label for “${key}” is longer than 160 characters.`);
      continue;
    }
    const numbers = readNumbers(line.at, key, { weight, min, max }, say);
    if (numbers === null) continue;
    seen.add(key);
    criteria.push({ key, label, ...numbers });
  }
  return { criteria, problems };
}

/**
 * The three optional numbers on a criterion line.
 *
 * Split out because the alternative is nine more lines inside a loop that is already the longest
 * function in this file, and because the defaults belong in one place: `1 | 1 | 5` is stated here
 * and in the field's help text and nowhere else. `createRubricVersion` defaults the same way, so
 * an omitted number is defaulted twice to the same value rather than once by accident.
 */
function readNumbers(
  at: number,
  key: string,
  parts: { weight?: string; min?: string; max?: string },
  say: (line: number, message: string) => number,
): { weight: number; min: number; max: number } | null {
  const weight = parts.weight === undefined || parts.weight === "" ? 1 : Number(parts.weight);
  const min = parts.min === undefined || parts.min === "" ? 1 : Number(parts.min);
  const max = parts.max === undefined || parts.max === "" ? 5 : Number(parts.max);
  if (!Number.isFinite(weight) || weight <= 0) {
    say(at, `the weight for “${key}” has to be a number above zero. Remove the criterion instead of weighting it nothing.`);
    return null;
  }
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    say(at, `the score range for “${key}” has to be whole numbers.`);
    return null;
  }
  if (max <= min) {
    say(at, `the score range for “${key}” is ${min} to ${max}, which is no range at all.`);
    return null;
  }
  return { weight, min, max };
}

/**
 * The rubric, to anybody.
 *
 * Public because a participant deciding what to spend the last hour on is entitled to know what
 * they are being scored on, and because a rubric published after judging starts is how an event
 * gets accused of writing the criteria around a winner. Unpublished drafts are organizer-only,
 * and asking for one by number answers `rubric.missing` rather than 403 — the same rule as
 * everywhere else here, for the same reason: a 403 would confirm that version 4 exists.
 *
 * An event with no published rubric is not an error. It is `version: null`, which is what a page
 * needs in order to say "not published yet" rather than showing a problem document to somebody
 * who did nothing wrong.
 */
export const show = defineCommand({
  name: "rubrics.show",
  summary: "Show the rubric judges score against.",
  method: "GET",
  path: "/api/events/:event/rubric",
  capability: { audience: "public", scope: "event" },
  input: { event: EVENT_REF, version: { ...VERSION, optional: true, help: "Defaults to the published version." } },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        version: { type: ["integer", "null"] },
        published: { type: "boolean" },
        criteria: { type: "array", items: CRITERION_SCHEMA },
        totalWeight: { type: "number" },
        mayEdit: {
          type: "boolean",
          description: "Whether the caller may write and publish versions. Draws forms; protects nothing.",
        },
        versions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              version: { type: "integer" },
              published: { type: "boolean" },
              createdAt: { type: "integer" },
            },
            required: ["version", "published", "createdAt"],
          },
        },
      },
      required: ["version", "published", "criteria", "versions", "mayEdit"],
    },
  },
  handler: ({ ctx, input, event, roles }) => {
    const row = event as EventRow;
    const organizer = roles.includes("organizer");
    const history = listRubrics(ctx.db, row.id)
      .filter((rubric) => organizer || rubric.published_at !== null)
      .map((rubric) => ({
        version: rubric.version,
        published: rubric.published_at !== null,
        createdAt: rubric.created_at,
      }));
    const asked = typeof input.version === "number" ? input.version : undefined;
    const version = asked ?? publishedVersion(ctx.db, row.id);
    if (version === undefined) {
      return {
        version: null,
        published: false,
        criteria: [],
        totalWeight: 0,
        mayEdit: organizer,
        versions: history,
      };
    }
    const rubric = findRubric(ctx.db, row.id, version);
    if (rubric === undefined || (rubric.published_at === null && !organizer)) {
      throw notFound("rubric", `v${version}`);
    }
    const criteria = criteriaOf(ctx.db, row.id, version);
    return {
      version,
      published: rubric.published_at !== null,
      criteria: criteria.map(criterionJson),
      totalWeight: criteria.reduce((sum, c) => sum + c.weight, 0),
      // Published rather than inferred by the page, for the reason the view layer's header
      // gives: a view is handed a result and cannot ask the database a question. It decides
      // which forms the rubric page draws and protects nothing — `rubrics.create` and
      // `rubrics.publish` refuse a non-organizer whether or not a form was rendered.
      mayEdit: organizer,
      versions: history,
    };
  },
});

/**
 * Write the next version of the rubric.
 *
 * It does not publish. A `publish` checkbox here would save one click and blur a one-way door:
 * publishing is irreversible, judges start scoring against whatever is published, and a ballot
 * records the version it was cast under. Two steps means an organizer reads their own rubric back
 * before anybody is scored against it, which is worth more than the click.
 */
export const create = defineCommand({
  name: "rubrics.create",
  summary: "Write a new version of an event's rubric.",
  method: "POST",
  path: "/api/events/:event/rubric",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, criteria: CRITERIA },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        version: { type: "integer" },
        criteria: { type: "array", items: CRITERION_SCHEMA },
      },
      required: ["version", "criteria"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["rubric.created"],
  form: {
    title: "Write a rubric",
    submit: "Save version",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/rubric`,
  },
  notes:
    "Saves a draft version. Judges score against the published version, so this changes nothing " +
    "until `rubrics.publish`.",
  handler: ({ ctx, input, event }) => {
    const row = event as EventRow;
    const { criteria, problems } = parseCriteria(String(input.criteria));
    if (problems.length > 0) throw new InputError(problems);
    const written = createRubricVersion(ctx, row.id, criteria);
    return { version: written.version, criteria: written.criteria.map(criterionJson) };
  },
});

/**
 * Publish a version, which is what makes judges able to score at all.
 *
 * The version travels in the body rather than the path — `/rubric/publish` and not
 * `/rubric/4/publish` — because a path parameter has to be `id`, `text` or `enum` and a version
 * is an integer. Coercing it in the path would mean the one rule a client author has to remember,
 * that JSON is taken at its word, would acquire an exception.
 *
 * Idempotent, so a double submit is not an error, and one-way: `publishRubric` has no inverse.
 * Superseding is how a rubric changes, and the previous version stays readable because ballots
 * point at it.
 */
export const publish = defineCommand({
  name: "rubrics.publish",
  summary: "Publish a rubric version for judges to score against.",
  method: "POST",
  path: "/api/events/:event/rubric/publish",
  capability: { audience: "organizer", scope: "event" },
  input: { event: EVENT_REF, version: VERSION },
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: { version: { type: "integer" }, criteria: { type: "array", items: CRITERION_SCHEMA } },
      required: ["version", "criteria"],
    },
  },
  limit: "organize",
  limitKey: ({ input }) => String(input.event ?? ""),
  records: ["rubric.published"],
  form: {
    title: "Publish this rubric",
    submit: "Publish",
    redirect: ({ input }) => `/events/${encodeURIComponent(String(input.event))}/rubric`,
  },
  notes: "There is no way to unpublish. Write a new version and publish that instead.",
  handler: ({ ctx, input, event }) => {
    const row = event as EventRow;
    const version = Number(input.version);
    publishRubric(ctx, row.id, version);
    return { version, criteria: criteriaOf(ctx.db, row.id, version).map(criterionJson) };
  },
});

export const RUBRIC_COMMANDS: readonly Command[] = [show, create, publish];
