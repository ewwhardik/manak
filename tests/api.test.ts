/**
 * The command layer, checked where its claims are made.
 *
 * Three of this layer's headers make promises that are only worth the check behind
 * them, and those checks live here: that one field declaration cannot describe a form
 * the server disagrees with, that `decide` gives the same answer for every audience and
 * every witness as the published matrix, and that no refusal the product can throw
 * lands on the classifier's fallback.
 *
 * The last of those is a source scan rather than a list. A hand-written list of codes
 * is a list that stops being complete the first afternoon somebody adds a rule, and the
 * failure is silent: an unclassified code answers 409, which is plausible enough to
 * survive review and wrong enough to make a client retry something it should not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANONYMOUS,
  AUDIENCES,
  capabilityMatrix,
  cellsFor,
  decide,
  isRoleAudience,
  matrixMarkdown,
  principalFor,
  requiredRole,
  SESSION_COOKIE,
  WITNESSES,
} from "../src/api/capability.ts";
import type { Audience, Capability, Cell, Ownership, Witness } from "../src/api/capability.ts";
import {
  classify,
  describeForLog,
  FALLBACK,
  forbidden,
  httpStatus,
  notFound,
  PROBLEM_MEDIA_TYPE,
  retryAfterSeconds,
  statusForRefusal,
  STATUS_TEXT,
  titleFor,
  toProblem,
  unauthenticated,
} from "../src/api/errors.ts";
import {
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
} from "../src/api/registry.ts";
import type { Command } from "../src/api/registry.ts";
import { errorStatuses, openapiDocument, openapiJson, operationId, templatePath } from "../src/api/openapi.ts";
import {
  describeField,
  fieldSchema,
  formControls,
  InputError,
  jsonSchema,
  labelFor,
  parseInput,
  redact,
} from "../src/api/schema.ts";
import type { Field, Fields } from "../src/api/schema.ts";
// The catalogue itself, for the one claim in this layer that a synthetic command cannot make:
// that a declared ownership is enforced by the handler behind it. Everything else here is
// checked against fixtures, because a test that needs the real 41 to say something is usually
// a test about the wrong thing.
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { EMAIL_MAX, ID_LENGTH, LIMITS, RATE_RESET_KEY, RuleError } from "../src/db/index.ts";

/** A syntactically valid identifier, so a test can spend one without ceremony. */
const AN_ID = "0123456789ABCDEFGHJKMNPQRS";

function problems(fields: Fields, raw: Record<string, unknown>, coerce = false): Record<string, string> {
  try {
    parseInput(fields, raw, { coerce });
  } catch (error) {
    assert.ok(error instanceof InputError, `expected an InputError, got ${String(error)}`);
    return Object.fromEntries((error as InputError).problems.map((p) => [p.field, p.message]));
  }
  return assert.fail("expected the input to be refused");
}

test("a refused submission names every field at fault, not the first", () => {
  const fields: Fields = {
    title: { kind: "text", max: 10 },
    count: { kind: "int", min: 1 },
    who: { kind: "email" },
  };
  const found = problems(fields, { title: "far too long to fit", count: 0, who: "not-an-address" });
  assert.deepEqual(Object.keys(found).sort(), ["count", "title", "who"]);
  assert.match(found.title as string, /limited to 10 characters; got 19/);
  assert.equal(found.count, "cannot be below 1.");
});

test("an unknown field is refused rather than dropped", () => {
  // Ignoring it is friendlier until somebody sends `summry` and cannot work out why
  // their edit did nothing. On a write path a silently dropped field is a lost
  // intention, which is a worse thing to debug than a 422.
  const found = problems({ title: { kind: "text" } }, { title: "fine", summry: "oops" });
  assert.equal(found.summry, "is not a field this operation takes.");
});

test("a missing required field is a problem and a missing optional one is not", () => {
  const fields: Fields = {
    needed: { kind: "text" },
    spare: { kind: "text", optional: true },
    defaulted: { kind: "int", fallback: 3 },
  };
  assert.deepEqual(Object.keys(problems(fields, {})), ["needed"]);
  assert.deepEqual(parseInput(fields, { needed: "x" }), { needed: "x", defaulted: 3 });
  // An empty string is absence, not a value: a form always sends every control it
  // renders, so a blank text box arriving as `""` has to mean "not filled in".
  assert.deepEqual(parseInput(fields, { needed: "x", spare: "" }), { needed: "x", defaulted: 3 });
});

test("text is trimmed, bounded, and kept to one line unless it says otherwise", () => {
  const one: Fields = { note: { kind: "text", min: 3, max: 8 } };
  assert.deepEqual(parseInput(one, { note: "  hello  " }), { note: "hello" });
  assert.equal(problems(one, { note: "hi" }).note, "needs at least 3 characters.");
  assert.equal(problems(one, { note: "a\nb" }).note, "should be a single line.");
  // A box holding three spaces is a box nobody filled in, so it is absence rather than
  // an empty value — which matters most on a field with a default waiting.
  assert.equal(problems({ note: { kind: "text" } }, { note: "   " }).note, "is required.");
  assert.deepEqual(parseInput({ note: { kind: "text", fallback: "none" } }, { note: "  " }), {
    note: "none",
  });
  const many: Fields = { note: { kind: "text", multiline: true } };
  assert.deepEqual(parseInput(many, { note: "two\nlines" }), { note: "two\nlines" });
  const shaped: Fields = { key: { kind: "text", pattern: /^[a-z]+$/ } };
  assert.equal(problems(shaped, { key: "Nope" }).key, "is not in the expected form.");
});

test("coercion is per request, so a JSON client hears about its own bug", () => {
  // The asymmetry is the point. A URL-encoded body has no types at all, so `"3"` has
  // to become 3 or forms cannot work. A JSON client that sends `"3"` for an integer
  // has made a mistake worth being told about, and quietly accepting it leaves the
  // wrong type in somebody's database and the bug in somebody else's afternoon.
  const fields: Fields = { count: { kind: "int" } };
  assert.equal(problems(fields, { count: "3" }).count, "should be a whole number.");
  assert.deepEqual(parseInput(fields, { count: "3" }, { coerce: true }), { count: 3 });
  assert.equal(problems(fields, { count: 3.5 }).count, "should be a whole number.");
  assert.equal(problems(fields, { count: "3.5" }, true).count, "should be a whole number.");
});

test("a checkbox that was not ticked means false, and only from a form", () => {
  // The one case where absence carries a value rather than meaning "leave it alone",
  // because that is what a browser does: an unticked checkbox is simply not sent.
  const fields: Fields = { agreed: { kind: "bool" } };
  assert.deepEqual(parseInput(fields, {}, { coerce: true }), { agreed: false });
  assert.deepEqual(Object.keys(problems(fields, {})), ["agreed"]);
  for (const yes of ["on", "true", "yes", "1", "ON"]) {
    assert.deepEqual(parseInput(fields, { agreed: yes }, { coerce: true }), { agreed: true }, yes);
  }
  for (const no of ["off", "false", "no", "0"]) {
    assert.deepEqual(parseInput(fields, { agreed: no }, { coerce: true }), { agreed: false }, no);
  }
  assert.equal(problems(fields, { agreed: "on" }).agreed, "should be true or false.");
  const spare: Fields = { agreed: { kind: "bool", optional: true } };
  assert.deepEqual(parseInput(spare, {}, { coerce: true }), {});
});

test("an identifier is checked by the generator's own validator", () => {
  const fields: Fields = { event: { kind: "id" } };
  assert.deepEqual(parseInput(fields, { event: AN_ID }), { event: AN_ID });
  assert.equal(AN_ID.length, ID_LENGTH);
  // I, L, O and U are absent from the alphabet on purpose, so an id containing one is
  // not an id however much it looks like one.
  assert.equal(problems(fields, { event: `${AN_ID.slice(0, 25)}I` }).event, "is not an identifier.");
  assert.equal(problems(fields, { event: AN_ID.slice(0, 25) }).event, "is not an identifier.");
  assert.equal(problems(fields, { event: AN_ID.toLowerCase() }).event, "is not an identifier.");
});

test("an email is lower-cased on the way in and capped where the domain caps it", () => {
  // The cap is the interesting half. The pattern and the 254-character limit used to
  // live in two files, and only the storage layer had the limit — so the API accepted
  // addresses the domain then refused, which is a 500 wearing a 201's clothes.
  const fields: Fields = { who: { kind: "email" } };
  assert.deepEqual(parseInput(fields, { who: " Judge@Example.COM " }), { who: "judge@example.com" });
  assert.equal(problems(fields, { who: "judge@example" }).who, "is not an email address.");
  assert.equal(problems(fields, { who: "two words@example.com" }).who, "is not an email address.");
  const long = `${"a".repeat(EMAIL_MAX)}@example.com`;
  assert.match(problems(fields, { who: long }).who as string, new RegExp(`longer than ${EMAIL_MAX}`));
});

test("a link has to be one a page can safely render", () => {
  // `javascript:` in an organizer's dashboard is the whole attack, and it is a link
  // shaped exactly like a link. Parsing rather than pattern-matching is what makes the
  // scheme a fact rather than a guess.
  const fields: Fields = { repo: { kind: "url" } };
  assert.deepEqual(parseInput(fields, { repo: "https://example.com/a" }), { repo: "https://example.com/a" });
  assert.deepEqual(parseInput(fields, { repo: "http://nas:8080/x" }), { repo: "http://nas:8080/x" });
  for (const hostile of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
    assert.match(problems(fields, { repo: hostile }).repo as string, /http or https/, hostile);
  }
  assert.match(problems(fields, { repo: "example.com" }).repo as string, /including https:\/\//);
  assert.equal(problems(fields, { repo: `https://e.com/${"a".repeat(2000)}` }).repo, "is too long to store.");
});

test("an instant arrives as a form string or as milliseconds, and a bare one is UTC", () => {
  // A form sends `2026-09-25T18:00` with no zone. Reading that in the server's local
  // time would make a deadline mean a different instant on a laptop in Calcutta than
  // in a container in Frankfurt, which for a submission cut-off is the whole ballgame.
  const fields: Fields = { at: { kind: "instant" } };
  const noon = Date.UTC(2026, 8, 25, 18, 0, 0);
  assert.deepEqual(parseInput(fields, { at: "2026-09-25T18:00" }), { at: noon });
  assert.deepEqual(parseInput(fields, { at: "2026-09-25T18:00:00Z" }), { at: noon });
  assert.deepEqual(parseInput(fields, { at: "2026-09-25T23:30:00+05:30" }), { at: noon });
  assert.deepEqual(parseInput(fields, { at: noon }), { at: noon });
  assert.match(problems(fields, { at: "not a date" }).at as string, /not a date and time/);
  assert.match(problems(fields, { at: 1.5 }).at as string, /whole number of milliseconds/);
});

test("a ballot's scores are checked for shape here and for vocabulary by the rubric", () => {
  // This layer knows a ballot is criterion keys to whole numbers. Only the event's own
  // published rubric knows which keys exist, so an unknown criterion is a 422 raised by
  // the domain rather than a guess made here.
  const fields: Fields = { scores: { kind: "scores" } };
  assert.deepEqual(parseInput(fields, { scores: { impact: 4, craft: 5 } }), {
    scores: { impact: 4, craft: 5 },
  });
  assert.deepEqual(parseInput(fields, { scores: '{"impact":4}' }, { coerce: true }), {
    scores: { impact: 4 },
  });
  assert.deepEqual(parseInput(fields, { scores: { impact: "4" } }, { coerce: true }), {
    scores: { impact: 4 },
  });
  assert.match(problems(fields, { scores: { impact: 4.5 } }).scores as string, /impact that is not a whole/);
  assert.match(problems(fields, { scores: [] }).scores as string, /object of criterion keys/);
  assert.match(problems(fields, { scores: {} }).scores as string, /no scores in it/);
  assert.match(problems(fields, { scores: "not json" }, true).scores as string, /object of criterion keys/);
});

test("a secret is dropped from the record the ledger and the error echo see", () => {
  const fields: Fields = { email: { kind: "email" }, token: { kind: "text", secret: true } };
  const parsed = parseInput(fields, { email: "a@b.co", token: "magic-link-token" });
  assert.deepEqual(parsed, { email: "a@b.co", token: "magic-link-token" });
  assert.deepEqual(redact(fields, parsed), { email: "a@b.co" });
  // The declaration is what protects it, so the protection travels with the field
  // rather than being remembered at each place a value could escape.
  assert.match(describeField("token", fields.token as Field), /Never echoed back/);
  const control = formControls(fields).find((c) => c.name === "token");
  assert.equal(control?.type, "password");
  assert.equal(control?.attributes.autocomplete, "off");
});

test("a label is derived from the field name until the declaration overrules it", () => {
  assert.equal(labelFor("title"), "Title");
  // The two spellings agree, which they did not before: one path title-cased the second
  // word and the other left it alone, so a form's labels depended on how a field
  // happened to be spelled in a source file.
  assert.equal(labelFor("teamName"), "Team name");
  assert.equal(labelFor("team_name"), "Team name");
  assert.equal(labelFor("repo_url"), "Repo url");
  assert.equal(labelFor("repo", { kind: "url", label: "Repository" }), "Repository");
});

/**
 * One declaration per kind, with bounds where a kind can carry them.
 *
 * Used by the agreement tests below rather than by any one of them, because the claim
 * being checked is about the four consumers as a set: whatever this table says, the
 * parser, the schema, the form and the sentence must all say the same thing about it.
 */
const EVERY_KIND: Fields = {
  title: { kind: "text", max: 120, help: "Shown on the project page." },
  summary: { kind: "text", multiline: true, min: 20, max: 2000 },
  track: { kind: "enum", values: ["ai", "tools"] },
  reviews: { kind: "int", min: 1, max: 9 },
  agreed: { kind: "bool" },
  event: { kind: "id" },
  who: { kind: "email" },
  repo: { kind: "url" },
  at: { kind: "instant" },
  scores: { kind: "scores" },
  spare: { kind: "text", optional: true },
  defaulted: { kind: "int", fallback: 3, min: 1, max: 9 },
};

test("required-ness means the same thing to the parser, the schema and the form", () => {
  const schema = jsonSchema(EVERY_KIND);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[]) ?? []);
  const controls = new Map(formControls(EVERY_KIND).map((c) => [c.name, c]));
  const demandedByParser = problems(EVERY_KIND, {});
  for (const [name, field] of Object.entries(EVERY_KIND)) {
    const demanded = Object.hasOwn(demandedByParser, name);
    assert.equal(required.has(name), demanded, `${name}: schema and parser disagree`);
    // A checkbox is the documented exception in one direction only: the schema calls it
    // required because a JSON body must state it, while the form leaves it unmarked
    // because an unticked box is not sent and absence already means false.
    const control = controls.get(name);
    assert.ok(control, `${name} has no control`);
    const expected = demanded && field.kind !== "bool";
    assert.equal(control.required, expected, `${name}: form and parser disagree`);
    assert.equal("required" in control.attributes, expected, `${name}: attribute disagrees`);
    assert.ok(Object.hasOwn(properties, name), `${name} is missing from the schema`);
  }
  assert.equal(required.has("agreed"), true);
  assert.equal(controls.get("agreed")?.required, false);
});

test("a bound the browser enforces is a bound the server enforces", () => {
  // The named failure mode, in the header of the module under test: the form gains a
  // `maxlength` the API does not check. So for every attribute the markup would use to
  // refuse a value, a value that violates it is sent past the browser and the parser is
  // required to refuse it too. Anything the browser would let through is somebody
  // else's test; this one is about the promises the markup makes.
  const cases: { field: Field; attribute: string; value: unknown }[] = [
    { field: { kind: "text", max: 4 }, attribute: "maxlength", value: "toolong" },
    { field: { kind: "text", min: 4 }, attribute: "minlength", value: "ab" },
    { field: { kind: "int", min: 2, max: 5 }, attribute: "min", value: 1 },
    { field: { kind: "int", min: 2, max: 5 }, attribute: "max", value: 9 },
    { field: { kind: "email" }, attribute: "maxlength", value: `${"a".repeat(EMAIL_MAX)}@b.co` },
    { field: { kind: "url" }, attribute: "maxlength", value: `https://e.com/${"a".repeat(2000)}` },
    { field: { kind: "id" }, attribute: "maxlength", value: `${AN_ID}TOOLONG` },
  ];
  for (const { field, attribute, value } of cases) {
    const control = formControls({ x: field })[0];
    assert.ok(control, "no control");
    assert.ok(
      Object.hasOwn(control.attributes, attribute),
      `${field.kind} does not carry ${attribute} into the markup`,
    );
    assert.ok(
      Object.hasOwn(problems({ x: field }, { x: value }), "x"),
      `${field.kind} promises ${attribute} in the form and does not enforce it`,
    );
  }
});

test("a bound the form enforces is a bound the published schema states", () => {
  // The same claim against the third consumer, and the one a stranger's generated
  // client believes. A `maxlength` in the markup with no `maxLength` in the document
  // means the client that was generated from the document sends a value the browser
  // would have stopped, and finds out from a 422.
  const pairs: [string, string][] = [
    ["maxlength", "maxLength"],
    ["minlength", "minLength"],
    ["min", "minimum"],
    ["max", "maximum"],
  ];
  const missing: string[] = [];
  for (const [name, field] of Object.entries(EVERY_KIND)) {
    const control = formControls({ [name]: field })[0];
    const schema = fieldSchema(field);
    for (const [attribute, keyword] of pairs) {
      if (!Object.hasOwn(control?.attributes ?? {}, attribute)) continue;
      if (!Object.hasOwn(schema, keyword)) missing.push(`${name}: ${attribute} but no ${keyword}`);
    }
  }
  assert.deepEqual(missing, []);
  // And the one place they deliberately differ, stated so it cannot drift silently: a
  // required text field's implicit minimum of one character is `required` in the markup
  // and `minLength: 1` in the schema, because `minlength="1"` would be noise.
  assert.equal(fieldSchema({ kind: "text" }).minLength, 1);
  assert.equal(formControls({ x: { kind: "text" } })[0]?.attributes.minlength, undefined);
});

test("the documentation sentence says the bound rather than approximating it", () => {
  // The fourth consumer, and the one most likely to be written by hand and left behind.
  // A reference page that says "at most 200 characters" about a field whose limit moved
  // to 120 is worse than one that says nothing, because a client author believes it.
  assert.equal(
    describeField("title", EVERY_KIND.title as Field),
    "Title — text on one line, at most 120 characters. Required. Shown on the project page.",
  );
  assert.equal(
    describeField("summary", EVERY_KIND.summary as Field),
    "Summary — text, any number of lines, between 20 and 2000 characters. Required.",
  );
  assert.equal(describeField("track", EVERY_KIND.track as Field), "Track — one of ai, tools. Required.");
  assert.equal(
    describeField("defaulted", EVERY_KIND.defaulted as Field),
    "Defaulted — a whole number between 1 and 9. Defaults to 3.",
  );
  assert.equal(describeField("spare", EVERY_KIND.spare as Field), "Spare — text on one line. Optional.");
  const numbers = describeField("n", { kind: "int", min: 2 });
  assert.equal(numbers, "N — a whole number, at least 2. Required.");
  // Every kind produces a sentence, so a new kind cannot reach the reference page as
  // "undefined" — which is what an unhandled branch of that switch would print.
  for (const [name, field] of Object.entries(EVERY_KIND)) {
    const sentence = describeField(name, field);
    assert.doesNotMatch(sentence, /undefined/, name);
    assert.match(sentence, /\.$/, `${name}: ${sentence}`);
    assert.ok(sentence.startsWith(labelFor(name, field)), name);
  }
});

/**
 * The whole access decision, enumerated.
 *
 * Six audiences by six witnesses is thirty-six answers, which is few enough to write
 * down and important enough to be worth writing down. `decide` is pure precisely so
 * this table can exist, and the table is what `npm run prove:isolation` will hold a
 * running server to in Part F. A change to the rule that nobody meant to make shows up
 * here as a diff rather than in production as a leak.
 */
const EXPECTED: Readonly<Record<Audience, Readonly<Record<Witness, Cell>>>> = {
  public: {
    anonymous: "allow",
    stranger: "allow",
    founder: "allow",
    participant: "allow",
    judge: "allow",
    organizer: "allow",
  },
  account: {
    anonymous: "unauthenticated",
    stranger: "allow",
    founder: "allow",
    participant: "allow",
    judge: "allow",
    organizer: "allow",
  },
  // The row worth reading twice. Being an organizer of an event does not let you create
  // another one, because the three role witnesses are not founders — founding is a fact
  // about the operator's configuration and roles cannot reach it.
  founder: {
    anonymous: "unauthenticated",
    stranger: "forbidden",
    founder: "allow",
    participant: "forbidden",
    judge: "forbidden",
    organizer: "forbidden",
  },
  participant: {
    anonymous: "unauthenticated",
    stranger: "notFound",
    founder: "notFound",
    participant: "allow",
    judge: "forbidden",
    organizer: "forbidden",
  },
  judge: {
    anonymous: "unauthenticated",
    stranger: "notFound",
    founder: "notFound",
    participant: "forbidden",
    judge: "allow",
    organizer: "forbidden",
  },
  organizer: {
    anonymous: "unauthenticated",
    stranger: "notFound",
    founder: "notFound",
    participant: "forbidden",
    judge: "forbidden",
    organizer: "allow",
  },
};

test("every audience answers every witness the way the matrix says", () => {
  for (const audience of AUDIENCES) {
    const capability: Capability = isRoleAudience(audience)
      ? { audience, scope: "event" }
      : { audience };
    assert.deepEqual(cellsFor(capability), EXPECTED[audience], audience);
  }
  // And the enumeration is exhaustive rather than merely long: a new audience or a new
  // witness makes this fail until the table above says what it means.
  assert.deepEqual(
    [...AUDIENCES],
    ["public", "account", "founder", "participant", "judge", "organizer"],
  );
  assert.deepEqual(
    [...WITNESSES],
    ["anonymous", "stranger", "founder", "participant", "judge", "organizer"],
  );
});

test("founding an event is a configuration fact, not a role and not an achievement", () => {
  // The audience exists because anybody can obtain an account here — a magic link to an
  // arbitrary address is the whole sign-up — so `account` would let the first passer-by
  // fill somebody's self-hosted portal with their own hackathons.
  const create: Capability = { audience: "founder" };
  assert.equal(decide(create, principalFor("founder")).allowed, true);
  // Not reachable by collecting roles, which is the property that makes the audience
  // worth having: an organizer is the most privileged thing an event can contain and it
  // still cannot create a second event.
  for (const witness of ["organizer", "judge", "participant", "stranger"] as const) {
    const decision = decide(create, principalFor(witness));
    assert.equal(decision.allowed, false, witness);
    assert.equal(decision.allowed === false && decision.refusal, "forbidden", witness);
  }
  // 403 rather than 404, unlike every other refusal in this file. There is no second
  // tenant whose existence a 404 would be hiding, the route is in the published document
  // either way, and an operator who left themselves out of the list needs to be told that
  // rather than sent hunting for a typo in the URL.
  const anonymousDecision = decide(create, ANONYMOUS);
  assert.equal(anonymousDecision.allowed, false);
  assert.equal(
    anonymousDecision.allowed === false && anonymousDecision.refusal,
    "unauthenticated",
  );
  // And it is not a role, so it demands no scope and `requiredRole` does not claim one.
  assert.equal(requiredRole(create), null);
  assert.equal(isRoleAudience("founder"), false);
});

test("an organizer is not implicitly a judge", () => {
  // Not a stylistic choice about role hierarchies. An organizer who can enter a ballot
  // as themselves becomes an extra judge that the leniency normalization cannot tell
  // from an invited one, and a correction computed over a phantom judge is wrong for
  // every project on the leaderboard. The route that exists instead records
  // `ballot.entered_on_behalf`, so the ledger shows a human did it and for whom.
  const ballot: Capability = { audience: "judge", scope: "event" };
  assert.deepEqual(decide(ballot, principalFor("organizer")), {
    allowed: false,
    refusal: "forbidden",
    because: "the caller is in this event but not as judge.",
  });
  // Nor the other way round: a judge cannot publish results.
  assert.equal(decide({ audience: "organizer", scope: "event" }, principalFor("judge")).allowed, false);
  // Holding both roles is how somebody legitimately does both, and that is a membership
  // fact rather than an inference.
  assert.equal(decide(ballot, { accountId: "a", roles: ["organizer", "judge"], founder: false }).allowed, true);
});

test("a caller with no membership is told the event does not exist", () => {
  // The refusal is deliberately indistinguishable from a wrong id. A 403 admits the
  // resource is real, and across events that admission is the leak: an organizer of one
  // hackathon could otherwise enumerate another's projects by watching which ids answer
  // 403 and which answer 404.
  const capability: Capability = { audience: "organizer", scope: "event" };
  const stranger = decide(capability, principalFor("stranger"));
  assert.equal(stranger.allowed, false);
  assert.equal(stranger.allowed === false && stranger.refusal, "notFound");
  // A stranger is exactly how an organizer of a different event presents: same account,
  // no membership here. That collapse is the isolation claim, not a simplification.
  assert.deepEqual(principalFor("stranger", "organizer-of-elsewhere"), {
    accountId: "organizer-of-elsewhere",
    roles: [],
    founder: false,
  });
  assert.deepEqual(
    decide(capability, principalFor("stranger", "organizer-of-elsewhere")),
    decide(capability, principalFor("stranger", "somebody-else-entirely")),
  );
  // Being a founder buys nothing inside an event either. The `founder` witness holds no
  // membership, so a scoped operation answers it exactly as it answers a stranger — which
  // is what stops the operator's configuration becoming a back door into judging.
  assert.deepEqual(
    decide(capability, principalFor("founder")),
    decide(capability, principalFor("stranger")),
  );
  assert.deepEqual(ANONYMOUS, { accountId: null, roles: [], founder: false });
  assert.equal(requiredRole(capability), "organizer");
  assert.equal(requiredRole({ audience: "account" }), null);
  assert.equal(requiredRole({ audience: "public" }), null);
});

test("a declared ownership is enforced somewhere, and the somewhere is named here", () => {
  // `decide` ignores `capability.owner`. It is a declaration, so that the obligation appears in
  // the published matrix and the OpenAPI document rather than in a reviewer's memory — which
  // means something else has to hold the row-level line, and this is the check that something
  // does. Without it `owner` would be a comment: three commands would publish "own team" while
  // one of them quietly let any participant of the event edit any project in it.
  //
  // The handler's own source text is what gets read. `Function.prototype.toString` is the only
  // thing in the process that can answer whether the call is there; a scan of the file would
  // have to work out which `defineCommand` block a line falls inside, which is a parser. The
  // cost is that a handler delegating to a helper that calls `ownProject` would fail this — and
  // if that day comes the fix is to name the helper here, not to drop the check.
  const RULES: Record<Ownership, { readonly pattern: RegExp; readonly how: string }> = {
    team: { pattern: /\bownProject\s*\(/, how: "call ownProject, which 404s a project of another team" },
    judge: { pattern: /\baccountId\b/, how: "take the judge from the session" },
    account: { pattern: /\baccountId\b/, how: "compare the row's own account against the session" },
  };
  const owned = ALL_COMMANDS.filter((command) => command.capability.owner !== undefined);
  assert.ok(owned.length >= 4, `only ${owned.length} commands declare an owner; the filter is wrong`);

  const bad: string[] = [];
  for (const command of owned) {
    const owner = command.capability.owner as Ownership;
    const rule = RULES[owner] as { pattern: RegExp; how: string } | undefined;
    // Not redundant with the `Record` above, because nothing compiles this file: stripping
    // erases the annotation, so a fourth ownership kind would arrive here as `undefined` and
    // satisfy every assertion below by having none.
    assert.ok(rule, `${command.name} declares owner: "${owner}" and this test has no rule for it`);
    if (!rule.pattern.test(String(command.handler))) bad.push(`${command.name} should ${rule.how}`);
  }
  assert.deepEqual(bad, []);

  // For a judge the input declaration is the load-bearing half, not the handler: `saveBallot`
  // will attribute a ballot to somebody else when asked, and it appends
  // `ballot.entered_on_behalf` when it does. A judge id accepted as a field is the only way a
  // request could ask, so `docs/THREAT-MODEL.md` claims no route can — asserted here.
  for (const command of owned.filter((command) => command.capability.owner === "judge")) {
    assert.deepEqual(
      Object.keys(command.input).filter((field) => /judge/i.test(field)),
      [],
      `${command.name} takes a judge id as input`,
    );
  }
});

test("the matrix is a table anyone can read, and it lines up", () => {
  const rows = capabilityMatrix([
    { name: "event.read", method: "GET", path: "/api/events/:event", capability: { audience: "public" } },
    {
      name: "ballot.save",
      method: "POST",
      path: "/api/events/:event/ballots",
      capability: { audience: "judge", scope: "event", owner: "judge", gate: "judging" },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]?.cells, EXPECTED.public);
  assert.equal(rows[1]?.route, "POST /api/events/:event/ballots");
  assert.equal(rows[1]?.owner, "judge");
  assert.equal(rows[1]?.gate, "judging");
  // `owner` and `gate` are absent rather than undefined when a capability has neither,
  // so the rendered table has nothing to print and the JSON has nothing to explain.
  assert.deepEqual(Object.keys(rows[0] as object).sort(), ["audience", "cells", "name", "route"]);

  const table = matrixMarkdown(rows);
  const lines = table.split("\n");
  assert.equal(lines.length, 4, "a header, a rule, and one line per row");
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1, `the columns do not line up:\n${table}`);
  assert.equal(lines[0]?.includes("Operation"), true);
  for (const witness of WITNESSES) assert.ok(lines[0]?.includes(witness), witness);
  assert.doesNotMatch(lines[2] as string, /40\d/, "a public read refuses nobody");
  assert.match(lines[3] as string, /judge, own judge, judging open/);
  assert.match(lines[3] as string, /401.*404.*403.*yes.*403/, "the refusals are what should stand out");
});

test("a refusal code is classified by an ordered table, and the order is the tie-break", () => {
  assert.deepEqual(classify("rate.ballot"), { status: 429, rule: "rate" });
  assert.deepEqual(classify("project.missing"), { status: 404, rule: "missing" });
  assert.deepEqual(classify("access.unauthenticated"), { status: 401, rule: "credential" });
  assert.deepEqual(classify("link.invalid"), { status: 401, rule: "credential" });
  assert.deepEqual(classify("access.forbidden"), { status: 403, rule: "role" });
  assert.deepEqual(classify("score.range"), { status: 422, rule: "payload" });
  assert.deepEqual(classify("submissions.closed"), { status: 409, rule: "world" });
  // Order decides where a code matching two rules lands: `rate.missing` would be a rate
  // limit before it were a missing thing, which is the answer a client can act on.
  assert.equal(classify("rate.missing").rule, "rate");
  // Two codes that a cleverer suffix rule would have collapsed, and must not. One is a
  // feature the event turned off, which is a 409; the other is an account somebody
  // switched off, which is a 403. A `.disabled` rule would have made them one answer.
  assert.equal(classify("pairwise.disabled").status, 409);
  assert.equal(classify("account.disabled").status, 403);
});

test("a refusal from decide and a refusal from the classifier agree on the number", () => {
  assert.equal(statusForRefusal("unauthenticated"), 401);
  assert.equal(statusForRefusal("forbidden"), 403);
  assert.equal(statusForRefusal("notFound"), 404);
  // The same three answers reached the other way, because the dispatcher will use both
  // paths — `decide` before a handler runs, `classify` for what a handler throws — and
  // a caller should not be able to tell which one refused them.
  assert.equal(classify(notFound("project").code).status, statusForRefusal("notFound"));
  assert.equal(classify(unauthenticated().code).status, statusForRefusal("unauthenticated"));
  assert.equal(classify(forbidden("not as judge").code).status, statusForRefusal("forbidden"));
  assert.equal(notFound("project").code, "project.missing");
  // The id goes in the detail rather than the sentence: "No such project." is what a
  // caller is told, and the id is what an operator's log needs to find the request.
  assert.deepEqual(notFound("project", AN_ID).detail, { project: AN_ID });
  assert.equal(notFound("project", AN_ID).message, "No such project.");
});

test("a problem document says what happened without saying too much", () => {
  const invalid = (() => {
    try {
      parseInput({ n: { kind: "int", max: 5 } }, { n: 9 });
    } catch (error) {
      return error;
    }
    return assert.fail("expected a refusal");
  })();
  const document = toProblem(invalid);
  assert.equal(document.status, 422);
  assert.equal(document.code, "input.invalid");
  assert.deepEqual(document.problems, [{ field: "n", message: "cannot be above 5." }]);
  assert.equal(httpStatus(invalid), 422);
  assert.match(PROBLEM_MEDIA_TYPE, /^application\/problem\+json$/);

  const refused = toProblem(new RuleError("submissions.closed", "The deadline passed at 18:00 UTC."));
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "submissions.closed");
  assert.equal(refused.detail, "The deadline passed at 18:00 UTC.");
  assert.equal(refused.title, "Submissions: closed");
  assert.equal(titleFor("ballot.staleRubric"), "Ballot: stale rubric");

  // An error nobody classified is a bug, and a bug's message is for the operator's log.
  // A stack trace or a SQL fragment in a 500 body is how an attacker learns the schema.
  const bug = new TypeError("cannot read properties of undefined (reading 'secretColumn')");
  const opaque = toProblem(bug);
  assert.equal(opaque.status, 500);
  assert.equal(opaque.code, "internal");
  assert.doesNotMatch(JSON.stringify(opaque), /secretColumn/);
  assert.match(describeForLog(bug), /secretColumn/);
});

test("retry-after is whole seconds, rounded up, and never zero", () => {
  // Rounded up because a client told to wait 0 seconds retries immediately and gets
  // refused again, which turns one rate limit into a hot loop against the same window.
  //
  // The detail key comes from the limiter rather than being spelled again here. It was
  // spelled twice — once where the refusal is thrown and once where the header is read —
  // and two literals that must agree for a header to be sent at all is a bug that would
  // have looked like a limiter which simply declined to say when to come back.
  const at = 1_000_000;
  const limited = (resetAt: number): RuleError =>
    new RuleError("rate.ballot", "Too many ballots.", { [RATE_RESET_KEY]: resetAt });
  assert.equal(retryAfterSeconds(limited(at + 2400), at), 3);
  assert.equal(retryAfterSeconds(limited(at + 1), at), 1);
  assert.equal(retryAfterSeconds(limited(at - 5000), at), 1);
  assert.equal(retryAfterSeconds(new RuleError("rate.ballot", "No detail."), at), null);
  assert.equal(retryAfterSeconds(new RuleError("submissions.closed", "Closed."), at), null);
  assert.equal(retryAfterSeconds(new TypeError("bug"), at), null);
});

/**
 * Every code the product can throw, read out of the source rather than listed.
 *
 * A hand-kept list stops being complete on the first afternoon somebody adds a rule, and
 * the consequence is quiet: an unclassified code answers 409, which is plausible enough
 * to pass review and wrong enough to make a client retry something it must not.
 *
 * Template codes are expanded from vocabularies declared here, and a template this test
 * does not recognize fails it. That is the point — an unexpandable code is a code nobody
 * is checking, and discovering it as a test failure is cheaper than discovering it as a
 * 409 that should have been a 429.
 */
const VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  // The two gates `assertGate` accepts, not the three the command layer can declare.
  // A wider list here invented `results.closed`, a code for a state that cannot happen —
  // which is the failure this whole test exists to prevent, pointed the other way.
  gate: ["submissions", "judging"],
  name: Object.keys(LIMITS),
  // `notFound(kind)` spells `${kind}.missing` for whatever a caller looks up, and the
  // rule that classifies it is the only one in the table that generalizes by suffix. So
  // one probe value stands for every kind here, and the claim that it stands for them is
  // checked below rather than assumed.
  kind: ["probe"],
};

function ruleErrorCodes(): { code: string; where: string }[] {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
  };
  const found: { code: string; where: string }[] = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    const where = file.slice(root.length + 1);
    // Multi-line calls included: most of the interesting ones wrap, and a line-based
    // scan silently missed every single one of them the first time this was attempted.
    for (const match of text.matchAll(/new RuleError\(\s*(?:"([^"]*)"|`([^`]*)`)/gs)) {
      const raw = (match[1] ?? match[2]) as string;
      const placeholders = [...raw.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1] as string);
      if (placeholders.length === 0) {
        found.push({ code: raw, where });
        continue;
      }
      let expansions = [raw];
      for (const placeholder of placeholders) {
        const values = VOCABULARY[placeholder];
        assert.ok(values, `${where}: this test does not know what \${${placeholder}} can be`);
        expansions = expansions.flatMap((form) =>
          values.map((value) => form.replace(`\${${placeholder}}`, value)),
        );
      }
      for (const code of expansions) found.push({ code, where });
    }
  }
  return found;
}

test("no refusal the product can throw lands on the classifier's fallback", () => {
  const codes = ruleErrorCodes();
  assert.ok(codes.length >= 25, `only found ${codes.length} refusal codes, the scan is wrong`);
  const unclassified = codes
    .filter(({ code }) => classify(code).rule === FALLBACK.rule)
    .map(({ code, where }) => `${where}: ${code}`);
  assert.deepEqual([...new Set(unclassified)], [], "add these to PAYLOAD_FIXABLE or WORLD_FIXABLE");
  // And every code is spelled in the one dialect the ledger and the registry share, so a
  // code cannot be a 409 for the honest reason and unreadable for a careless one.
  const misspelled = codes.filter(({ code }) => !/^[a-z][a-zA-Z0-9._]{2,63}$/.test(code));
  assert.deepEqual(misspelled, []);
  // The suffix rule really is general, which is what lets one probe kind stand for all of
  // them above. Every noun the product can fail to find gets the same 404.
  for (const kind of ["event", "project", "team", "ballot", "account", "rubric", "session"]) {
    assert.equal(classify(`${kind}.missing`).status, 404, kind);
  }
  // Every gate a command can declare has a refusal waiting, including the one no window
  // closes. Part F's dispatcher checks gates before a handler runs, and a gate it cannot
  // spell a refusal for would answer 409 from the fallback — the right number arrived at
  // by accident, which is indistinguishable from the right number until it is not.
  for (const code of ["submissions.notOpen", "judging.notOpen", "results.notPublic"]) {
    assert.equal(classify(code).status, 409, code);
    assert.notEqual(classify(code).rule, FALLBACK.rule, code);
  }
});

/** A complete declaration, so each test below can break exactly one thing about it. */
function aCommand(overrides: Partial<Command> = {}): Command {
  return {
    name: "project.submit",
    summary: "Submit a project for judging.",
    method: "POST",
    path: "/api/events/:event/projects",
    capability: { audience: "participant", scope: "event" },
    input: { event: { kind: "id" }, title: { kind: "text", max: 120 } },
    returns: { kind: "json", schema: { type: "object" } },
    limit: "submission",
    records: ["project.submitted"],
    handler: () => null,
    ...overrides,
  };
}

test("a complete declaration passes, so the rejections below mean something", () => {
  assert.deepEqual(checkCommand(aCommand()), []);
  assert.equal(defineCommand(aCommand()).name, "project.submit");
});

test("boot refuses an incomplete declaration, and says everything wrong with it", () => {
  // The failure this prevents is a route reaching production with no access decision,
  // and the only reliable moment to prevent it is before the port opens. Reported all at
  // once rather than one per run: fixing a registry through six consecutive boot
  // failures is how somebody ends up commenting out the check.
  const cases: [Partial<Command>, RegExp][] = [
    [{ name: "projectSubmit" }, /lower case, dots, no camel case/],
    [{ name: "ab" }, /must match/],
    [{ summary: "" }, /needs a one-sentence summary/],
    [{ summary: "no capital and no stop" }, /sentence-cased and end with a full stop/],
    [{ summary: `A ${"very ".repeat(30)}long one.` }, /longer than one sentence/],
    [{ method: "DELETE" as Command["method"] }, /is not GET or POST/],
    [{ path: "api/events" }, /must start with a slash/],
    [{ path: "/api/events/" }, /must not end in a slash/],
    [{ path: "/api//events" }, /empty segment/],
    [{ path: "/api/:Event", input: { Event: { kind: "id" } } }, /not a usable parameter name/],
    [{ path: "/api/events/:missing" }, /names :missing but the input does not declare it/],
    [
      { input: { event: { kind: "id", optional: true }, title: { kind: "text" } } },
      /:event is in the path, so it cannot be optional/,
    ],
    [{ capability: { audience: "judge" } }, /must name the field carrying the event/],
    [{ capability: { audience: "public", gate: "judging" } }, /gate judging belongs to an event/],
    [{ capability: { audience: "judge", scope: "elsewhere" } }, /scope names elsewhere/],
    [{ capability: { audience: "sponsor" as "judge", scope: "event" } }, /is not an audience/],
    [{ capability: { audience: "judge", scope: "event", owner: "sponsor" as "team" } }, /kind of ownership/],
    [{ limit: undefined }, /a write must declare a rate limit/],
    [{ limit: "nonesuch" as Command["limit"] }, /not one of the declared limits/],
    [{ records: [] }, /must declare the ledger actions it appends/],
    [{ records: ["projectSubmitted"] }, /is not a ledger action/],
    [{ handler: undefined as unknown as Command["handler"] }, /has no handler/],
  ];
  for (const [mutation, expected] of cases) {
    const found = checkCommand(aCommand(mutation));
    const description = JSON.stringify(Object.keys(mutation));
    assert.ok(found.length > 0, `${description} was accepted`);
    assert.ok(
      found.some((problem) => expected.test(problem)),
      `${description} produced ${JSON.stringify(found)}`,
    );
  }
});

/**
 * A registry small enough to reason about and shaped like the real one: a public list, an
 * account-scoped read with no input, a role-scoped read, and one path carrying both a GET
 * and a POST.
 */
const FIXTURE: readonly Command[] = [
  aCommand({
    name: "event.list",
    summary: "List every event this deployment hosts.",
    method: "GET",
    path: "/api/events",
    capability: { audience: "public" },
    input: { limit: { kind: "int", fallback: 20, min: 1, max: 100 } },
    returns: { kind: "json", schema: { type: "array" } },
    limit: undefined,
    records: undefined,
  }),
  aCommand({
    name: "event.mine",
    summary: "List the events this account belongs to.",
    method: "GET",
    path: "/api/events/mine",
    capability: { audience: "account" },
    input: {},
    limit: undefined,
    records: undefined,
  }),
  aCommand({
    name: "event.read",
    summary: "Read one event.",
    method: "GET",
    path: "/api/events/:event",
    capability: { audience: "participant", scope: "event" },
    input: { event: { kind: "id" } },
    limit: undefined,
    records: undefined,
  }),
  aCommand({
    name: "project.list",
    summary: "List the projects entered in an event.",
    method: "GET",
    path: "/api/events/:event/projects",
    capability: { audience: "organizer", scope: "event" },
    input: { event: { kind: "id" }, status: { kind: "text", optional: true, max: 20 } },
    limit: undefined,
    records: undefined,
  }),
  aCommand({ capability: { audience: "participant", scope: "event", gate: "submissions" } }),
];

test("a registry that cannot be dispatched unambiguously does not assemble", () => {
  assert.doesNotThrow(() => assertRegistryComplete(FIXTURE));
  assert.throws(() => makeRegistry([]), /the registry is empty/);
  assert.throws(
    () => makeRegistry([aCommand(), aCommand()]),
    /project\.submit: declared twice/,
  );
  // The same route under two spellings of its parameter. Nothing about the second is
  // reachable, so it is a boot failure rather than a precedence question.
  assert.throws(
    () =>
      makeRegistry([
        aCommand(),
        aCommand({
          name: "project.enter",
          path: "/api/events/:id/projects",
          input: { id: { kind: "id" }, title: { kind: "text", max: 120 } },
          capability: { audience: "participant", scope: "id" },
        }),
      ]),
    /POST \/api\/events\/:\/projects is already taken/,
  );
  // A whole broken registry in one report, because fixing one problem per boot is how
  // somebody ends up deleting the check.
  let raised: unknown;
  try {
    makeRegistry([
      aCommand({ name: "x" }),
      aCommand({
        name: "project.enter",
        summary: "no capital and no stop",
        path: "/api/projects",
        input: { title: { kind: "text", max: 120 } },
        capability: { audience: "account" },
      }),
    ]);
  } catch (error) {
    raised = error;
  }
  assert.ok(raised instanceof RegistryError, `expected a RegistryError, got ${String(raised)}`);
  assert.equal(raised.code, "registry.incomplete");
  assert.deepEqual(raised.problems, [
    `x: the name must match ${NAME_PATTERN.source} — lower case, dots, no camel case.`,
    "project.enter: the summary must be sentence-cased and end with a full stop.",
  ]);
});


test("a literal segment beats a parameter at the same position", () => {
  const registry = makeRegistry(FIXTURE);
  // Declared after `/api/events/:event` would still resolve first: precedence is the
  // number of parameters, not the order somebody happened to list them in.
  assert.equal(registry.match("GET", "/api/events/mine")?.command.name, "event.mine");
  const read = registry.match("GET", `/api/events/${AN_ID}`);
  assert.equal(read?.command.name, "event.read");
  assert.deepEqual(read?.params, { event: AN_ID });
});

test("what is not a route is not a route, including the near misses", () => {
  const registry = makeRegistry(FIXTURE);
  // A trailing slash is the same resource. Anything else here is a 404 the dispatcher
  // never has to think about.
  assert.equal(registry.match("GET", `/api/events/${AN_ID}/`)?.command.name, "event.read");
  assert.equal(registry.match("GET", "/api/events/")?.command.name, "event.list");
  // A parameter with nothing in it. `//` is not an id, and matching it would hand a
  // handler an empty string to look up.
  assert.equal(registry.match("POST", "/api/events//projects"), undefined);
  // A malformed percent-escape. `decodeURIComponent` throws on this, and the answer is
  // "no such route" rather than a 500 from inside the router.
  assert.equal(registry.match("GET", "/api/events/%zz"), undefined);
  // A well-formed one is decoded once, before any handler sees it.
  assert.equal(registry.match("GET", "/api/events/ab%20cd")?.params.event, "ab cd");
  assert.equal(registry.match("GET", "/api/events/one/two/three"), undefined);
  assert.equal(registry.match("PUT", "/api/events"), undefined, "only the two methods dispatch");
  assert.equal(registry.byName("event.read")?.path, "/api/events/:event");
  assert.equal(registry.byName("event.nonesuch"), undefined);
});

test("a 405 can name the methods the path does accept", () => {
  const registry = makeRegistry(FIXTURE);
  assert.deepEqual(registry.methodsFor(`/api/events/${AN_ID}/projects`).sort(), ["GET", "POST"]);
  assert.deepEqual(registry.methodsFor("/api/events"), ["GET"]);
  assert.deepEqual(registry.methodsFor("/api/nothing/here"), []);
  for (const method of registry.methodsFor("/api/events")) {
    assert.ok(METHODS.includes(method), `${method} is not a method this layer dispatches`);
  }
});

test("a field's location is derived from the route and the method, never declared", () => {
  const [list, , read, projects, submit] = FIXTURE as readonly Command[];
  // The same field name is a path parameter here and a body field nowhere: what decides
  // is whether the route names it, so a client author never has to be told twice.
  assert.equal(locationOf(read as Command, "event"), "path");
  assert.equal(locationOf(projects as Command, "status"), "query", "a GET's rest is the query");
  assert.equal(locationOf(submit as Command, "title"), "body", "a POST's rest is the body");
  assert.deepEqual(pathParameters("/api/events/:event/projects/:project"), ["event", "project"]);
  assert.deepEqual(pathParameters("/api/events"), []);
  assert.deepEqual(Object.keys(pathFields(submit as Command)), ["event"]);
  assert.deepEqual(Object.keys(bodyFields(submit as Command)), ["title"]);
  assert.deepEqual(Object.keys(bodyFields(list as Command)), ["limit"]);
  assert.deepEqual(Object.keys(pathFields(list as Command)), []);
});

test("the requirement sentence names everything a caller must be, in one breath", () => {
  assert.equal(requirementSentence(aCommand({ capability: { audience: "public" } })), "anyone, signed in or not");
  assert.equal(requirementSentence(aCommand({ capability: { audience: "account" } })), "any signed-in account");
  assert.equal(
    requirementSentence(
      aCommand({
        capability: { audience: "participant", scope: "event", owner: "team", gate: "submissions" },
      }),
    ),
    "a participant of the event, on the project's own team, while submissions are open",
  );
  assert.equal(
    requirementSentence(aCommand({ capability: { audience: "judge", scope: "event", owner: "judge" } })),
    "a judge of the event, the judge the ballot belongs to",
  );
  // Every audience and every ownership has words. A missing case would read as a
  // sentence with a hole in it on the published reference page.
  for (const audience of AUDIENCES) {
    const sentence = requirementSentence(
      aCommand({ capability: { audience, ...(isRoleAudience(audience) ? { scope: "event" } : {}) } }),
    );
    assert.doesNotMatch(sentence, /undefined|^$/, `${audience} has no words`);
  }
});

test("the reference section for a command is generated from the declaration", () => {
  const doc = commandDoc(
    aCommand({
      notes: "The deadline is the event's clock, not the caller's.",
      capability: { audience: "participant", scope: "event", owner: "team", gate: "submissions" },
    }),
  );
  assert.match(doc, /^### project\.submit\n/);
  assert.match(doc, /`POST \/api\/events\/:event\/projects`/);
  assert.match(doc, /Submit a project for judging\./);
  assert.match(doc, /The deadline is the event's clock, not the caller's\./);
  assert.match(doc, /Callable by a participant of the event, on the project's own team, while submissions are open\./);
  // The field table says where each field travels, which is the one thing a client
  // author cannot guess from the name.
  assert.match(doc, /\| `event` \| path \|/);
  assert.match(doc, /\| `title` \| body \|/);
  assert.match(doc, /Records `project\.submitted`\./);
  assert.match(doc, new RegExp(`Limited to ${LIMITS.submission.max} ${LIMITS.submission.label} per window`));
  // The meaning column is the same sentence the form's help text and the schema use.
  assert.ok(doc.includes(describeField("title", { kind: "text", max: 120 })));
  // A read with no notes and no ledger effect claims neither.
  const read = commandDoc(FIXTURE[2] as Command);
  assert.doesNotMatch(read, /Records/);
  assert.doesNotMatch(read, /Limited to/);
});

test("the published document spells a route the way OpenAPI does", () => {
  assert.equal(templatePath("/api/events/:event/projects/:project"), "/api/events/{event}/projects/{project}");
  assert.equal(templatePath("/api/events"), "/api/events");
  assert.equal(operationId("project.submit"), "project_submit");
  assert.equal(operationId("ballot.save"), "ballot_save");
});

test("an operation offers only the refusals it can actually produce", () => {
  // A document that lists every status teaches a client author to write branches that
  // can never run, and the dead branch that matters is the one handling 401 on a page
  // anybody can read.
  const [list, mine, read, , submit] = FIXTURE as readonly Command[];
  assert.deepEqual(errorStatuses(list as Command), [400, 422, 429, 500], "a public read cannot answer 401");
  assert.deepEqual(errorStatuses(mine as Command), [400, 401, 429, 500], "no input, so nothing to reject");
  assert.deepEqual(errorStatuses(read as Command), [400, 401, 403, 404, 422, 429, 500]);
  assert.deepEqual(errorStatuses(submit as Command), [400, 401, 403, 404, 409, 413, 415, 422, 429, 500]);
  // A GET has no body, so it has nothing to answer 413 or 415 about.
  for (const command of FIXTURE) {
    const statuses = errorStatuses(command);
    const bodyRefusals = statuses.filter((status) => status === 413 || status === 415);
    assert.equal(bodyRefusals.length, command.method === "POST" ? 2 : 0, command.name);
  }
  // 403 and 404 always arrive together on a role-scoped operation. That pairing is the
  // isolation claim: a caller who can tell them apart can tell events apart.
  for (const command of FIXTURE) {
    const statuses = errorStatuses(command);
    if (isRoleAudience(command.capability.audience)) {
      assert.ok(statuses.includes(403) && statuses.includes(404), `${command.name} splits the pair`);
    }
    for (const status of statuses) {
      assert.ok(status in STATUS_TEXT, `${command.name} offers ${status}, which has no reason phrase`);
    }
  }
});

const INFO = { title: "Manak", version: "0.1.0", servers: [{ url: "http://localhost:8080" }] };

test("the document is the registry, not a description of it", () => {
  const registry = makeRegistry(FIXTURE);
  const doc = openapiDocument(registry, INFO) as Record<string, any>;
  assert.equal(doc.openapi, "3.1.1");
  assert.equal(doc.info.title, "Manak");
  assert.deepEqual(doc.servers, [{ url: "http://localhost:8080" }]);
  // Every command reaches the document, under the templated spelling of its own route,
  // and one path item carries both methods rather than appearing twice.
  const paths = doc.paths as Record<string, Record<string, any>>;
  assert.deepEqual(Object.keys(paths).sort(), [
    "/api/events",
    "/api/events/mine",
    "/api/events/{event}",
    "/api/events/{event}/projects",
  ]);
  assert.deepEqual(Object.keys(paths["/api/events/{event}/projects"] as object).sort(), ["get", "post"]);
  const operations = Object.values(paths).flatMap((item) => Object.values(item));
  assert.equal(operations.length, FIXTURE.length);
  assert.deepEqual(
    operations.map((op) => op["x-manak-command"]).sort(),
    FIXTURE.map((command) => command.name).sort(),
  );
  // Tags in the order their area first appears, so the rendered page is not random.
  assert.deepEqual(doc.tags, [{ name: "event" }, { name: "project" }]);
  assert.equal(doc.components.securitySchemes.session.name, SESSION_COOKIE);
  assert.equal(doc.components.schemas.Problem.type, "object");
});

test("who may call an operation is machine-readable from the document alone", () => {
  const doc = openapiDocument(makeRegistry(FIXTURE), INFO) as Record<string, any>;
  const submit = doc.paths["/api/events/{event}/projects"].post;
  assert.deepEqual(submit["x-manak-capability"], {
    audience: "participant",
    scope: "event",
    gate: "submissions",
  });
  assert.deepEqual(submit["x-manak-records"], ["project.submitted"]);
  assert.equal(submit["x-manak-limit"], "submission");
  assert.equal(submit.operationId, "project_submit");
  assert.deepEqual(submit.tags, ["project"]);
  assert.match(submit.description, /Callable by a participant of the event, while submissions are open\./);
  // A public read says so in the way OpenAPI says it: an explicitly empty requirement,
  // not a missing one, which would inherit a document-wide default it does not have.
  assert.deepEqual(doc.paths["/api/events"].get.security, [{}]);
  assert.deepEqual(submit.security, [{ session: [] }, { bearer: [] }]);
  const capabilities = Object.values(doc.paths as Record<string, Record<string, any>>)
    .flatMap((item) => Object.values(item))
    .map((op) => op["x-manak-capability"]);
  for (const capability of capabilities) {
    assert.ok(AUDIENCES.includes(capability.audience), `${capability.audience} is not an audience`);
  }
});

test("a write documents both encodings, because both are the same handler", () => {
  const doc = openapiDocument(makeRegistry(FIXTURE), INFO) as Record<string, any>;
  const submit = doc.paths["/api/events/{event}/projects"].post;
  assert.equal(submit.requestBody.required, true);
  assert.deepEqual(Object.keys(submit.requestBody.content).sort(), [
    "application/json",
    "application/x-www-form-urlencoded",
  ]);
  const [json, form] = Object.values(submit.requestBody.content) as { schema: Record<string, any> }[];
  assert.deepEqual(json?.schema, form?.schema, "two encodings, one shape");
  // The path parameter is in the URL, so it is not in the body as well.
  assert.deepEqual(Object.keys(json?.schema.properties as object), ["title"]);
  assert.deepEqual(json?.schema, jsonSchema({ title: { kind: "text", max: 120 } }));
  // The one way the encodings differ is stated rather than left for a client author to
  // discover: a form body carries no types, a JSON body is taken at its word.
  assert.match(submit.requestBody.description, /URL-encoded body carries no types/);

  const paths = doc.paths["/api/events/{event}/projects"].get.parameters as Record<string, any>[];
  assert.deepEqual(
    paths.map((p) => [p.name, p.in, p.required]),
    [
      ["event", "path", true],
      ["status", "query", false],
    ],
    "a path parameter is always required; an optional query field is not",
  );
  assert.deepEqual(paths[0]?.schema, fieldSchema({ kind: "id" }));
});

test("what a call returns is documented from the declaration, including nothing", () => {
  const doc = openapiDocument(
    {
      commands: [
        aCommand({
          name: "project.withdraw",
          summary: "Withdraw a project from judging.",
          path: "/api/projects/:project/withdraw",
          capability: { audience: "participant", scope: "project", owner: "team" },
          input: { project: { kind: "id" } },
          returns: { kind: "empty" },
          records: ["project.withdrawn"],
        }),
        aCommand({
          name: "event.watch",
          summary: "Watch an event's progress as it changes.",
          method: "GET",
          path: "/api/events/:event/watch",
          capability: { audience: "organizer", scope: "event" },
          input: { event: { kind: "id" } },
          returns: { kind: "stream", mediaType: "text/event-stream" },
          limit: undefined,
          records: undefined,
        }),
      ],
    },
    INFO,
  ) as Record<string, any>;
  const withdraw = doc.paths["/api/projects/{project}/withdraw"].post;
  assert.equal(Object.hasOwn(withdraw, "requestBody"), false, "nothing to send is not an empty body");
  assert.equal(withdraw.responses["204"].description, "Done. Nothing to say about it.");
  assert.equal(Object.hasOwn(withdraw.responses, "200"), false);
  const watch = doc.paths["/api/events/{event}/watch"].get;
  assert.deepEqual(Object.keys(watch.responses["200"].content), ["text/event-stream"]);
});

test("every refusal the document publishes is one this layer can actually send", () => {
  // The fixture is chosen so the union of its error responses exercises every branch of
  // `errorStatuses`: a public read, a signed-in read, a role-scoped read with an id in
  // the path, and a write. If the two tables ever drift — a status the document offers
  // that nothing produces, or a status the classifier produces that no operation admits
  // to — one of them is lying to a client author.
  const doc = openapiDocument(makeRegistry(FIXTURE), INFO) as Record<string, any>;
  const operations = Object.values(doc.paths as Record<string, Record<string, any>>).flatMap((item) =>
    Object.values(item),
  );
  const offered = new Set<number>();
  for (const operation of operations) {
    for (const [status, response] of Object.entries(operation.responses as Record<string, any>)) {
      const code = Number(status);
      assert.ok(code in STATUS_TEXT, `${operation.operationId} offers ${status}, an unknown status`);
      assert.ok(String(response.description ?? "").length > 0, `${status} is undescribed`);
      if (code < 400) continue;
      offered.add(code);
      assert.deepEqual(Object.keys(response.content), [PROBLEM_MEDIA_TYPE]);
      assert.equal(response.content[PROBLEM_MEDIA_TYPE].schema.$ref, "#/components/schemas/Problem");
    }
    const rateLimited = (operation.responses as Record<string, any>)["429"];
    assert.ok(rateLimited?.headers["Retry-After"], "a 429 that does not say how long is a guess");
  }
  const producible = new Set<number>([422, 500]);
  for (const { code } of ruleErrorCodes()) producible.add(classify(code).status);
  // 405 is the one status nothing offers: it is an answer about a path rather than about
  // an operation, and no operation can be reached by a method it does not declare.
  producible.delete(405);
  const order = (a: number, b: number): number => a - b;
  assert.deepEqual([...offered].sort(order), [...producible].sort(order));
});

test("the served document and the committed one are the same bytes", () => {
  const registry = makeRegistry(FIXTURE);
  const text = openapiJson(registry, INFO);
  assert.ok(text.endsWith("}\n"), "a committed file ends in exactly one newline");
  assert.doesNotMatch(text, /\n\n$/);
  assert.deepEqual(JSON.parse(text), openapiDocument(registry, INFO));
  assert.equal(text, openapiJson(registry, INFO), "generation is deterministic");
  // Two spaces and stable key order, so a regenerated document produces a diff a human
  // can read rather than one line of every key moving.
  assert.match(text, /^\{\n  "openapi": "3\.1\.1",\n  "jsonSchemaDialect"/);
});
