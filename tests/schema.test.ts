/**
 * Do the responses match the schemas that promised them?
 *
 * Nothing else in this system asks. `src/http/app.ts` serialises whatever a handler
 * returned; the `returns.schema` beside it is read only when `src/api/openapi.ts` builds
 * the published document. There is no type checker here either, so the two halves drift
 * in silence and in both directions: a field added to a handler ships undocumented, and a
 * property renamed in a handler leaves a schema describing a key nobody sends. The client
 * author who generated a type from the document is the one who finds out.
 *
 * This suite is that ask. It walks every GET command in the registry, reads it as each of
 * the four audiences, and validates every 200 against its own declared schema — strictly,
 * so an undeclared key is a failure rather than a shrug. It found one on its first run:
 * `system.home` published `PRODUCT`'s six fields under a schema that declared two, four
 * lines below a comment warning about exactly that class of mistake.
 *
 * Only GETs, and that is the cut line. A write's response could be checked the same way,
 * but every write needs its own body, its own gate and its own preconditions, and a table
 * of twenty hand-built request bodies is a table that goes stale — `tests/http.test.ts`
 * already exercises the writes against their real rules. The reads are where a schema is
 * load-bearing anyway: they are what a client generates types from.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { judged, readableCommands, route } from "./support/judged.ts";
import { schemaProblems } from "./support/schema.ts";

test("every GET response matches the schema its command publishes", async () => {
  const rig = judged({ certificates: true });
  try {
    const failures: string[] = [];
    const covered = new Set<string>();
    let responses = 0;
    for (const command of readableCommands()) {
      assert.equal(command.returns.kind, "json");
      if (command.returns.kind !== "json") throw new Error("Expected JSON command");
      const path = route(command, rig.fill);
      assert.ok(path !== null, `${command.name}: the fixture has no value for a path parameter`);
      for (const principal of rig.principals) {
        const response = await rig.get(path, principal);
        if (response.status !== 200) continue;
        responses += 1;
        covered.add(command.name);
        const problems = schemaProblems(
          command.returns.schema as Record<string, unknown>,
          await response.json(),
        );
        for (const problem of problems) {
          failures.push(`${command.name} as ${principal.label} — ${problem}`);
        }
      }
    }
    assert.deepEqual(failures, []);

    // A sweep that silently stopped reaching anything would pass. These two numbers are
    // the sweep's own coverage, asserted so a fixture that stops satisfying a gate — a
    // clock that drifts past the judging window, a role that stops being granted — fails
    // here rather than quietly checking nothing.
    const missed = readableCommands()
      .filter((command) => !covered.has(command.name))
      .map((command) => command.name);
    assert.deepEqual(missed, [], "no audience got a 200 out of these, so nothing was checked");
    assert.ok(responses >= 40, `only ${responses} responses were validated`);
  } finally {
    rig.close();
  }
});

test("the validator complains about the things it exists to catch", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      tier: { type: ["integer", "null"] },
      kind: { type: "string", enum: ["a", "b"] },
      rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
    },
    required: ["name", "count"],
  };
  assert.deepEqual(
    schemaProblems(schema, { name: "x", count: 2, tier: null, kind: "a", rows: [{ id: "r" }] }),
    [],
    "a conforming payload has nothing to say",
  );
  assert.deepEqual(schemaProblems(schema, { name: "x" }), ["$.count: required, and absent"]);
  assert.deepEqual(schemaProblems(schema, { name: "x", count: 1, extra: 1 }), [
    "$.extra: present in the response, absent from the schema",
  ]);
  assert.deepEqual(schemaProblems(schema, { name: 7, count: 1 }), [
    "$.name: expected string, got integer",
  ]);
  assert.deepEqual(schemaProblems(schema, { name: "x", count: 1.5 }), [
    "$.count: expected integer, got number",
  ]);
  assert.deepEqual(schemaProblems(schema, { name: "x", count: 1, kind: "c" }), [
    '$.kind: "c" is not one of ["a","b"]',
  ]);
  assert.deepEqual(schemaProblems(schema, { name: "x", count: 1, rows: [{ id: "r", oops: 1 }] }), [
    "$.rows[0].oops: present in the response, absent from the schema",
  ]);
  // A whole-numbered value under `number` is fine; the widening only goes that way.
  assert.deepEqual(schemaProblems({ type: "number" }, 3), []);
  // An object with no declared properties is deliberately open — a payload echo.
  assert.deepEqual(schemaProblems({ type: "object" }, { anything: true }), []);
});
