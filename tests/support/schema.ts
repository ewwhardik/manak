/**
 * A response, checked against the schema that promised it.
 *
 * The command layer publishes a JSON Schema for every response and nothing validates
 * against it: `src/http/app.ts` serialises whatever the handler returned, and the schema
 * is read only when the OpenAPI document is assembled. There is no type checker in this
 * repository either, so the two halves can disagree in both directions and neither will
 * say so — a field added to a handler ships undocumented, and a property renamed in a
 * handler leaves a schema describing a key nobody sends. Both failures are invisible in
 * a passing suite, and both mislead the client author who trusted the document.
 *
 * So the check lives here, and it is strict in both directions. A key the payload carries
 * and the schema does not declare is a complaint, not a shrug: a schema that is merely
 * *not wrong* is worth less than one that is complete, and undeclared keys are exactly how
 * a private field reaches a public response unnoticed.
 *
 * This is test scaffolding rather than product code, deliberately. The alternative — a
 * validator in `src/api` behind a flag — makes every deployment carry a JSON Schema
 * interpreter to catch a mistake that can only be introduced by editing the source, and
 * the place to catch those is the suite that runs before the edit lands.
 */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** Does `value` satisfy one of a schema's declared types? `integer` widens to `number`. */
function matchesType(declared: readonly string[], value: unknown): boolean {
  const actual = typeOf(value);
  if (declared.includes(actual)) return true;
  if (actual === "integer" && declared.includes("number")) return true;
  // A whole-numbered float is still a number where an integer was promised; the reverse,
  // a fractional value under `integer`, is a real complaint and falls through.
  return false;
}

function declaredTypes(schema: Schema): string[] {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === "string");
  return [];
}

/**
 * Every way `value` disagrees with `schema`, as sentences naming their own path.
 *
 * An empty array is the pass. Collecting all of them rather than throwing on the first
 * means one run tells you the whole story, which matters when the answer is "this schema
 * was written against an older handler" and there are eleven properties to fix.
 */
export function schemaProblems(schema: Schema, value: unknown, path = "$"): string[] {
  const problems: string[] = [];
  const types = declaredTypes(schema);
  if (types.length > 0 && !matchesType(types, value)) {
    problems.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
    // No point descending into a value of the wrong shape; the type complaint is the story.
    return problems;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (value === null || value === undefined) return problems;

  if (Array.isArray(value)) {
    const items = schema.items;
    if (items !== undefined && items !== null && typeof items === "object") {
      for (const [index, entry] of value.entries()) {
        problems.push(...schemaProblems(items as Schema, entry, `${path}[${index}]`));
      }
    }
    return problems;
  }

  if (typeof value !== "object") return problems;
  const properties = schema.properties;
  if (properties === undefined || properties === null || typeof properties !== "object") {
    // A deliberately open object — a payload echo, a free-form record. Nothing to check.
    return problems;
  }
  const declared = properties as Record<string, Schema>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const carried = value as Record<string, unknown>;
  for (const name of required) {
    if (!(name in carried)) problems.push(`${path}.${name}: required, and absent`);
  }
  for (const [name, entry] of Object.entries(carried)) {
    const rule = declared[name];
    if (rule === undefined) {
      problems.push(`${path}.${name}: present in the response, absent from the schema`);
      continue;
    }
    if (entry === undefined) continue;
    problems.push(...schemaProblems(rule, entry, `${path}.${name}`));
  }
  return problems;
}
