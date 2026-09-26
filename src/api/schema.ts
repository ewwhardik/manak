/**
 * One description of an operation's input, read by four things.
 *
 * A field declared here is the JSON body validator, the HTML form control, the
 * OpenAPI request schema and the documentation sentence — and the reason it is one
 * declaration rather than four is that four drift. The failure mode is specific and
 * familiar: the form gains a `maxlength` the API does not enforce, or the OpenAPI
 * document keeps describing a field that was renamed a month ago, and the client
 * written against it fails in a way the server's tests cannot see.
 *
 * Two decisions worth stating. Every problem with a submission is reported, not just
 * the first: a form that surfaces one error per round trip is a form people abandon
 * halfway through. And coercion is opt-in per request rather than global, because a
 * URL-encoded body has no types at all — `"3"` must become `3` — while a JSON client
 * that sends `"3"` for an integer has a bug worth telling it about.
 */

import { EMAIL_MAX, EMAIL_PATTERN, ID_ALPHABET, ID_LENGTH, isId } from "../db/index.ts";

/** What a field is called and how it presents, independent of its type. */
export type FieldMeta = {
  /** The label an HTML form shows. Defaults to the field name, title-cased. */
  label?: string;
  /** One sentence under the control, and the OpenAPI description. */
  help?: string;
  /** Absent input is allowed; the parsed record simply has no such key. */
  optional?: true;
  /** Used when the field is absent. Implies `optional` for parsing purposes. */
  fallback?: string | number | boolean | null;
  /** Kept out of ledger payloads and error echoes. */
  secret?: true;
};

export type FieldKind =
  | { kind: "text"; min?: number; max?: number; pattern?: RegExp; multiline?: true }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "bool" }
  | { kind: "id" }
  | { kind: "email" }
  | { kind: "url" }
  | { kind: "instant" }
  | { kind: "scores" };

export type Field = FieldKind & FieldMeta;
export type Fields = Readonly<Record<string, Field>>;

/** One problem with one field, in the words the person who sent it needs. */
export type Problem = { field: string; message: string };

/**
 * A rejected submission, carrying every problem rather than the first.
 *
 * Not a `RuleError`: this is a malformed request, which is a 422 and a form redisplay,
 * while a `RuleError` is a well-formed request the domain refuses and is a 409. Two
 * different conversations with the caller, so two different types.
 */
export class InputError extends Error {
  readonly code = "input.invalid";
  readonly problems: readonly Problem[];

  constructor(problems: readonly Problem[]) {
    super(
      problems.length === 1
        ? `${problems[0]?.field}: ${problems[0]?.message}`
        : `${problems.length} fields need attention: ${problems.map((p) => p.field).join(", ")}.`,
    );
    this.name = "InputError";
    this.problems = problems;
  }
}

export type Parsed = Record<string, string | number | boolean | Record<string, number> | null>;

/** Anything a body parser can hand over: JSON values, or form strings. */
export type RawInput = Readonly<Record<string, unknown>>;

/**
 * The id pattern, built from the generator's own alphabet rather than written out.
 *
 * `isId` is the validator; this exists only because JSON Schema needs the rule as a
 * string, and a hand-copied `[0-9A-HJKMNP-TV-Z]{26}` would be a published document
 * that disagrees with the server the day the id format changes.
 */
const ID = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

/**
 * The longest link the product stores.
 *
 * Chosen for the oldest reason there is: Internet Explorer's 2083-character address
 * bar became everybody's de facto limit, and a repository URL that does not fit in one
 * is not a repository URL. Stated here so the form, the schema and the parser all
 * refuse at the same length.
 */
const URL_MAX = 2000;

/**
 * The label a form shows when the declaration does not say.
 *
 * Sentence case rather than title case, and the two spellings of a multi-word name are
 * made to agree: `teamName` and `team_name` both become "Team name". They did not agree
 * before — one produced "Team Name" and the other "Repo url" — and a form whose labels
 * change style depending on how the field was spelled in a source file is a form nobody
 * can make look deliberate. Anything that needs different words says so with `label`.
 */
export function labelFor(name: string, field?: Field): string {
  if (field?.label) return field.label;
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * One field, one value, or a sentence saying why not.
 *
 * Returned rather than thrown so the caller can collect every problem in one pass.
 * `coerce` is what a form body needs and what a JSON body should not have: telling a
 * JSON client that its `"3"` is not a number is more useful than quietly accepting it
 * and leaving the bug for whoever reads the database later.
 */
function parseField(
  field: Field,
  raw: unknown,
  coerce: boolean,
): { value: Parsed[string] } | { problem: string } {
  const text = typeof raw === "string" ? raw.trim() : raw;
  switch (field.kind) {
    case "text": {
      if (typeof text !== "string") return { problem: "should be text." };
      const min = field.min ?? 1;
      if (text.length < min) {
        return { problem: min === 1 ? "cannot be empty." : `needs at least ${min} characters.` };
      }
      if (field.max !== undefined && text.length > field.max) {
        return { problem: `is limited to ${field.max} characters; got ${text.length}.` };
      }
      if (field.pattern && !field.pattern.test(text)) return { problem: "is not in the expected form." };
      if (!field.multiline && /[\n\r]/.test(text)) return { problem: "should be a single line." };
      return { value: text };
    }
    case "enum": {
      if (typeof text !== "string" || !field.values.includes(text)) {
        return { problem: `should be one of ${field.values.join(", ")}.` };
      }
      return { value: text };
    }
    case "int": {
      const value = coerce && typeof text === "string" && text !== "" ? Number(text) : text;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { problem: "should be a whole number." };
      }
      if (field.min !== undefined && value < field.min) return { problem: `cannot be below ${field.min}.` };
      if (field.max !== undefined && value > field.max) return { problem: `cannot be above ${field.max}.` };
      return { value };
    }
    case "bool": {
      if (typeof text === "boolean") return { value: text };
      // A checkbox sends its value only when ticked, and "on" when it does. Absence is
      // handled by the caller, so what arrives here is a present-but-textual true.
      if (coerce && typeof text === "string") {
        if (["on", "true", "yes", "1"].includes(text.toLowerCase())) return { value: true };
        if (["off", "false", "no", "0", ""].includes(text.toLowerCase())) return { value: false };
      }
      return { problem: "should be true or false." };
    }
    case "id": {
      if (typeof text !== "string" || !isId(text)) return { problem: "is not an identifier." };
      return { value: text };
    }
    case "email": {
      if (typeof text !== "string" || !EMAIL_PATTERN.test(text)) {
        return { problem: "is not an email address." };
      }
      if (text.length > EMAIL_MAX) return { problem: `is longer than ${EMAIL_MAX} characters.` };
      return { value: text.toLowerCase() };
    }
    case "url": {
      if (typeof text !== "string") return { problem: "should be a link." };
      // Parsed rather than pattern-matched, and restricted to two schemes on purpose:
      // a `javascript:` URL rendered into an organizer's dashboard is the whole attack.
      let parsed: URL;
      try {
        parsed = new URL(text);
      } catch {
        return { problem: "should be a full link, including https://." };
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { problem: `has to be an http or https link, not ${parsed.protocol}` };
      }
      if (text.length > URL_MAX) return { problem: "is too long to store." };
      return { value: parsed.toString() };
    }
    case "instant": {
      // Both forms are accepted because both callers are real: a form sends
      // `2026-09-25T18:00`, and an API client that already has epoch milliseconds
      // should not have to format them into a string for us to parse them back.
      if (typeof text === "number") {
        return Number.isInteger(text) ? { value: text } : { problem: "should be a whole number of milliseconds." };
      }
      if (typeof text !== "string") return { problem: "should be a date and time." };
      const at = Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`);
      if (!Number.isFinite(at)) return { problem: "is not a date and time we can read." };
      return { value: at };
    }
    case "scores": {
      // A record of criterion key to whole number. The keys are checked against the
      // rubric by the domain, not here: this layer knows the shape, and only the
      // event's own published rubric knows the vocabulary.
      const source = coerce && typeof text === "string" ? safeJson(text) : text;
      if (source === null || typeof source !== "object" || Array.isArray(source)) {
        return { problem: "should be an object of criterion keys to scores." };
      }
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        const parsed = coerce && typeof value === "string" && value !== "" ? Number(value) : value;
        if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
          return { problem: `has a score for ${key} that is not a whole number.` };
        }
        out[key] = parsed;
      }
      if (Object.keys(out).length === 0) return { problem: "has no scores in it." };
      return { value: out };
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Validate a whole submission, reporting everything wrong with it.
 *
 * Unknown fields are refused rather than ignored. Ignoring them is the friendlier
 * behaviour right up to the moment somebody sends `summry` and cannot work out why
 * their edit does nothing, and on a write path a silently dropped field is a silently
 * lost intention.
 */
export function parseInput(
  fields: Fields,
  raw: RawInput,
  options: { coerce?: boolean } = {},
): Parsed {
  const coerce = options.coerce ?? false;
  const problems: Problem[] = [];
  const out: Parsed = {};
  for (const [name, field] of Object.entries(fields)) {
    // Absence is decided after trimming, so a text box containing three spaces is a
    // box nobody filled in. The alternative was live here briefly and was worse in a
    // way that only showed up on a defaulted field: `"  "` counted as present, failed
    // the emptiness check, and produced "cannot be empty" for a field that had a
    // perfectly good default waiting. One rule for blankness, applied once.
    const raw_value = raw[name];
    const blank =
      raw_value === undefined ||
      raw_value === null ||
      (typeof raw_value === "string" && raw_value.trim() === "");
    if (!Object.hasOwn(raw, name) || blank) {
      // A checkbox absent from a form body means false, which is the one case where
      // "not sent" carries a value rather than meaning "leave it alone".
      if (field.kind === "bool" && coerce && field.fallback === undefined && !field.optional) {
        out[name] = false;
        continue;
      }
      if (field.fallback !== undefined) out[name] = field.fallback;
      else if (!field.optional) problems.push({ field: name, message: "is required." });
      continue;
    }
    const result = parseField(field, raw[name], coerce);
    if ("problem" in result) problems.push({ field: name, message: result.problem });
    else out[name] = result.value;
  }
  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(fields, name)) {
      problems.push({ field: name, message: "is not a field this operation takes." });
    }
  }
  if (problems.length > 0) throw new InputError(problems);
  return out;
}

/**
 * The same declaration as JSON Schema, for the OpenAPI document.
 *
 * Deliberately plain: `type`, bounds, `enum`, `description`. A generated document that
 * reaches for every keyword in the specification is a document no client generator
 * handles the same way, and the point of publishing it is that a stranger's generated
 * client works on the first try.
 */
export function fieldSchema(field: Field): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  if (field.help) schema.description = field.help;
  switch (field.kind) {
    case "text":
      schema.type = "string";
      schema.minLength = field.min ?? 1;
      if (field.max !== undefined) schema.maxLength = field.max;
      break;
    case "enum":
      schema.type = "string";
      schema.enum = [...field.values];
      break;
    case "int":
      schema.type = "integer";
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
      break;
    case "bool":
      schema.type = "boolean";
      break;
    case "id":
      schema.type = "string";
      schema.pattern = ID.source;
      // The pattern already pins the length exactly, so the bounds are redundant — to a
      // reader. `pattern` is the keyword client generators most often skip, and one that
      // skips it would produce a client with no length check at all, which is precisely
      // the class of surprise this document exists to prevent.
      schema.minLength = ID_LENGTH;
      schema.maxLength = ID_LENGTH;
      break;
    case "email":
      schema.type = "string";
      schema.format = "email";
      schema.maxLength = EMAIL_MAX;
      break;
    case "url":
      schema.type = "string";
      schema.format = "uri";
      schema.maxLength = URL_MAX;
      break;
    case "instant":
      // Two accepted forms, so two branches rather than one lie about the type.
      schema.oneOf = [
        { type: "integer", description: "Epoch milliseconds." },
        { type: "string", format: "date-time" },
      ];
      break;
    case "scores":
      schema.type = "object";
      schema.additionalProperties = { type: "integer" };
      break;
  }
  if (field.fallback !== undefined) schema.default = field.fallback;
  return schema;
}

export function jsonSchema(fields: Fields): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    properties[name] = fieldSchema(field);
    if (!field.optional && field.fallback === undefined) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * The same declaration as an HTML control, for the form the browser sees.
 *
 * The attributes are the validation rules, which is why they are derived rather than
 * written: `required`, `maxlength` and `min`/`max` in the markup mean the browser
 * refuses the obvious mistakes without a round trip, and because they come from the
 * same object the server checks, they cannot promise something the server allows or
 * forbid something the server accepts.
 */
export type Control = {
  name: string;
  label: string;
  help?: string;
  /** The HTML element to render: an input type, or a textarea or select. */
  element: "input" | "textarea" | "select";
  type?: string;
  required: boolean;
  attributes: Record<string, string>;
  options?: readonly string[];
  /**
   * Which option a select starts on, when nothing has been submitted.
   *
   * A `<select>` has no `value` attribute. The initial choice is read off whichever
   * `<option>` carries `selected`, so a declared default cannot travel in the attribute
   * bag with the rest of them — written there it is invalid markup that silently does
   * nothing, and the control renders showing "Any" while the server would in fact apply
   * the default. The renderer needs the value separately to mark the right option, and
   * this is where it arrives.
   */
  chosen?: string;
  /**
   * The words on a select's empty first option.
   *
   * Every select gets one, and it is not decoration. A `<select required>` whose first
   * option is a real value is already satisfied the moment it renders: the browser
   * pre-selects it, `required` never fires, and somebody submits the alphabetically
   * first track without ever having chosen it. An empty option is what makes the
   * control able to be unset, which is what makes `required` mean anything.
   */
  blank?: string;
};

export function formControls(fields: Fields): Control[] {
  return Object.entries(fields).map(([name, field]) => {
    const required = !field.optional && field.fallback === undefined && field.kind !== "bool";
    const attributes: Record<string, string> = {};
    if (required) attributes.required = "required";
    if (field.fallback !== undefined && field.kind !== "bool") {
      attributes.value = String(field.fallback);
    }
    // A declared secret is a credential, and a credential in a plain text box is one
    // shoulder away from being read and one password manager away from being saved as
    // somebody's name. `redact` keeps it out of the ledger; this keeps it off screen.
    if (field.secret === true) attributes.autocomplete = "off";
    const base = { name, label: labelFor(name, field), ...(field.help ? { help: field.help } : {}) };
    switch (field.kind) {
      case "text":
        if (field.min !== undefined && field.min > 1) attributes.minlength = String(field.min);
        if (field.max !== undefined) attributes.maxlength = String(field.max);
        // The pattern is not copied into the markup. HTML uses a different regular
        // expression dialect and anchors the whole value, so a pattern that is right
        // here can be wrong there — and a browser that refuses a valid value is worse
        // than one that lets the server explain.
        return field.multiline
          ? { ...base, element: "textarea" as const, required, attributes }
          : {
              ...base,
              element: "input" as const,
              type: field.secret === true ? "password" : "text",
              required,
              attributes,
            };
      case "enum":
        // The default comes back out of the attributes and travels as `chosen`. See the
        // field's own comment: an attribute is the wrong carriage for a select's initial
        // value, and the mistake is invisible because a browser drops the attribute
        // rather than complaining about it.
        return {
          ...base,
          element: "select" as const,
          required,
          attributes: Object.fromEntries(
            Object.entries(attributes).filter(([key]) => key !== "value"),
          ),
          options: field.values,
          ...(attributes.value === undefined ? {} : { chosen: attributes.value }),
          blank: required ? "Choose one" : "Any",
        };
      case "int":
        if (field.min !== undefined) attributes.min = String(field.min);
        if (field.max !== undefined) attributes.max = String(field.max);
        attributes.step = "1";
        return { ...base, element: "input" as const, type: "number", required, attributes };
      case "bool":
        if (field.fallback === true) attributes.checked = "checked";
        return { ...base, element: "input" as const, type: "checkbox", required: false, attributes };
      case "email":
        attributes.maxlength = String(EMAIL_MAX);
        return { ...base, element: "input" as const, type: "email", required, attributes };
      case "url":
        attributes.maxlength = String(URL_MAX);
        return { ...base, element: "input" as const, type: "url", required, attributes };
      case "instant":
        return { ...base, element: "input" as const, type: "datetime-local", required, attributes };
      case "id":
        attributes.maxlength = String(ID_LENGTH);
        return { ...base, element: "input" as const, type: "text", required, attributes };
      case "scores":
        // Rendered by the ballot page as one control per criterion, because the
        // criteria are data. A generic form gets a JSON textarea and a warning.
        return { ...base, element: "textarea" as const, required, attributes };
    }
  });
}

/**
 * The same declaration as an English sentence, for the documentation.
 *
 * The fourth consumer, and the one most likely to be written by hand and then left
 * behind. A reference page that says "at most 200 characters" about a field whose
 * limit moved to 120 is worse than a reference page that says nothing, because a
 * client author believes it.
 */
export function describeField(name: string, field: Field): string {
  const phrase = ((): string => {
    switch (field.kind) {
      case "text": {
        const min = field.min ?? 1;
        const bounds =
          field.max !== undefined && min > 1
            ? `between ${min} and ${field.max} characters`
            : field.max !== undefined
              ? `at most ${field.max} characters`
              : min > 1
                ? `at least ${min} characters`
                : "";
        const shape = field.multiline ? "text, any number of lines" : "text on one line";
        return bounds === "" ? shape : `${shape}, ${bounds}`;
      }
      case "enum":
        return `one of ${field.values.join(", ")}`;
      case "int": {
        if (field.min !== undefined && field.max !== undefined) {
          return `a whole number between ${field.min} and ${field.max}`;
        }
        if (field.min !== undefined) return `a whole number, at least ${field.min}`;
        if (field.max !== undefined) return `a whole number, at most ${field.max}`;
        return "a whole number";
      }
      case "bool":
        return "yes or no";
      case "id":
        return `a ${ID_LENGTH}-character identifier`;
      case "email":
        return "an email address";
      case "url":
        return "an http or https link";
      case "instant":
        return "a date and time, as epoch milliseconds or an ISO timestamp";
      case "scores":
        return "one whole number per rubric criterion, keyed by criterion";
    }
  })();
  const requirement =
    field.fallback !== undefined
      ? `Defaults to ${JSON.stringify(field.fallback)}.`
      : field.optional
        ? "Optional."
        : "Required.";
  return [
    `${labelFor(name, field)} — ${phrase}.`,
    requirement,
    field.secret === true ? "Never echoed back or written to the ledger." : "",
    field.help ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * A parsed submission with its secrets removed, for ledger payloads and error echoes.
 *
 * Declared once as `secret: true` on the field rather than remembered at each of the
 * places a value could escape. A magic-link token that reached the audit trail would
 * make the audit trail a credential store, and the ledger is the one table an operator
 * is most likely to read, export and paste into a support thread.
 */
export function redact(fields: Fields, parsed: Parsed): Parsed {
  const out: Parsed = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (fields[name]?.secret === true) continue;
    out[name] = value;
  }
  return out;
}
