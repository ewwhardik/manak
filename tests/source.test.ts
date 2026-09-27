/**
 * Source hygiene, enforced rather than hoped for.
 *
 * Manak runs TypeScript through Node's type stripping, which is not a compiler:
 * there is no build step to catch a missing import extension or a construct that
 * cannot be erased. Those mistakes surface as a crash at run time, in whichever
 * request happens to touch the file first. Two of them have already been made in
 * this repository, so they are checked here instead:
 *
 *   - **Explicit `.ts` extensions on relative imports.** Type stripping does no
 *     module resolution, so `from "./stats"` is a runtime `ERR_MODULE_NOT_FOUND`.
 *   - **Erasable syntax only.** `enum`, `namespace` and constructor parameter
 *     properties all emit code, which stripping cannot do.
 *
 * The rest are house rules with teeth. A literal control byte in a source file
 * turns it binary to `grep`, `file` and diff tools — this repository had five of
 * them, used as map-key separators, until a search for something else happened to
 * reveal them. `Math.random()` anywhere in the engine would silently void the
 * determinism guarantee the whole judging story rests on. And byte-level rules
 * about newlines exist because two proofs this project ships compare file
 * contents byte for byte.
 *
 * Migration files are scanned too, and for a specific reason: their SHA-256 is
 * pinned once applied, so a stray trailing space added by an editor is a change
 * that makes `migrate` refuse to run on every existing database. Better to fail
 * here than at somebody else's boot.
 *
 * This file exempts itself from the scan: it necessarily contains the patterns it
 * forbids.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { STYLESHEET } from "../src/view/style.ts";
import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { VIEWS } from "../src/view/views.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SELF = join("tests", "source.test.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".sql")) out.push(full);
  }
  return out;
}

type SourceFile = { path: string; text: string; bytes: Buffer; lines: string[] };

const files: SourceFile[] = walk(root)
  .map((full) => {
    const bytes = readFileSync(full);
    const text = bytes.toString("utf8");
    return { path: relative(root, full).split(sep).join("/"), text, bytes, lines: text.split("\n") };
  })
  .filter((f) => f.path !== SELF.split(sep).join("/"));

/** Every file the byte-level rules apply to. */
const scanned = files;
/** TypeScript only, for the rules that are about the language rather than the bytes. */
const code = scanned.filter((f) => f.path.endsWith(".ts"));

/** True for a line that is only a comment, so a rule can quote what it forbids. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

test("there is something to scan", () => {
  assert.ok(scanned.length >= 15, `only found ${scanned.length} source files, the walk is wrong`);
  assert.ok(code.some((f) => f.path.startsWith("src/")));
  assert.ok(code.some((f) => f.path.startsWith("tests/")));
  assert.ok(
    scanned.some((f) => f.path.endsWith(".sql")),
    "the walk is not picking up migrations",
  );
});

test("every relative import carries its .ts extension", () => {
  // Type stripping does no resolution, so an extensionless specifier is a crash
  // the first time that module is loaded and nothing catches it earlier.
  const pattern = /\bfrom\s+"(\.[^"]*)"/g;
  const bad: string[] = [];
  for (const f of code) {
    for (const m of f.text.matchAll(pattern)) {
      const spec = m[1] as string;
      if (!spec.endsWith(".ts")) bad.push(`${f.path}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("no source file contains a raw control byte", () => {
  // Tab and newline only. A literal NUL used as a map-key separator is the way
  // this rule got broken before: correct at run time, and it turns the file
  // binary to every tool that reads it.
  const bad: string[] = [];
  for (const f of scanned) {
    for (const [index, byte] of f.bytes.entries()) {
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) {
        const line = f.bytes.subarray(0, index).toString("utf8").split("\n").length;
        bad.push(`${f.path}:${line} has byte 0x${byte.toString(16).padStart(2, "0")}`);
      }
      if (byte === 0x7f) bad.push(`${f.path} has a DEL byte`);
    }
  }
  assert.deepEqual(bad, [], "write \\u0000 rather than the byte itself");
});

test("only erasable TypeScript is used", () => {
  // Anything that would emit code cannot survive type stripping.
  //
  // The parameter-property pattern is anchored to a parameter boundary on purpose. A
  // parameter property is a modifier that *begins* a parameter — `constructor(readonly
  // x: T)` — while `constructor(problems: readonly Problem[])` is an ordinary parameter
  // whose type happens to be a readonly array. An earlier version of this rule matched
  // the modifier anywhere inside the parentheses and failed two honest files, which is
  // the worse failure of the two: a check that cries wolf gets loosened by whoever is
  // in a hurry. A function-typed parameter ahead of a real violation would hide it;
  // that residue is left standing, because stripping itself then fails at import.
  const banned: [RegExp, string][] = [
    [/^\s*(export\s+)?(const\s+)?enum\s/m, "enum declarations emit an object"],
    [/^\s*(export\s+)?namespace\s/m, "namespaces emit an object"],
    [/^\s*(export\s+)?module\s+\w+\s*\{/m, "module blocks emit code"],
    [
      /constructor\s*\(\s*(?:[^)]*,\s*)?(private|public|protected|readonly)\s+\w+\s*[?:,)]/s,
      "parameter properties emit assignments",
    ],
  ];
  const bad: string[] = [];
  for (const f of code) {
    for (const [pattern, why] of banned) {
      if (pattern.test(f.text)) bad.push(`${f.path}: ${why}`);
    }
    // Decorators, looked for only in files that declare a class.
    //
    // A decorator can attach to nothing but a class, a class expression, or a member of
    // one, so a file with no `class` keyword in it cannot carry a decorator — while the
    // naive pattern accuses every CSS at-rule in `src/view/style.ts`, where `@media`
    // begins a line inside a template literal. Narrowing by the keyword rather than by a
    // list of at-rules keeps the rule total: there is no decorator it can miss, and no
    // stylesheet it can cry wolf about. A `class="bar"` in some page's markup would switch
    // the check back on for that file, which is the harmless direction to be wrong in.
    if (/\bclass\s+[\w$]/.test(f.text) && /^\s*@\w/m.test(f.text)) {
      bad.push(`${f.path}: decorators emit code`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the engine never reaches for a random number it cannot reproduce", () => {
  const bad = code
    .filter((f) => f.path.startsWith("src/"))
    .flatMap((f) =>
      f.lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /Math\s*\.\s*random/.test(line) && !line.trimStart().startsWith("*"))
        .map(({ index }) => `${f.path}:${index + 1}`),
    );
  assert.deepEqual(bad, [], "seed a Rng from makeRng instead");
});

test("time enters the product through the clock and nowhere else", () => {
  // Every timestamp this system stores is a domain fact somebody may later dispute,
  // and a `Date.now()` in a function body is a value no test can pin and no
  // organizer can reproduce. `src/db/clock.ts` is the one place allowed to read it;
  // everything else takes a `Clock`. Tools are exempt: measuring how long a proof
  // took is wall-clock time, not a fact about an event.
  const bad = code
    .filter((f) => f.path.startsWith("src/") && f.path !== "src/db/clock.ts")
    .flatMap((f) =>
      f.lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\bDate\s*\.\s*now\s*\(/.test(line) && !isComment(line))
        .map(({ index }) => `${f.path}:${index + 1}`),
    );
  assert.deepEqual(bad, [], "take a Clock instead, so a test can set the instant");
});

test("repositories cannot write without the audit gate", () => {
  // `ctx.write` throws outside a `recorded()` or `unaudited()` scope, which is what
  // makes "no write without a ledger entry" true at run time. Reaching `db.run` or
  // `db.exec` directly would step around that gate, so the reach is checked here as
  // well — the runtime error only fires on a path somebody executes.
  const bad = code
    .filter((f) => f.path.startsWith("src/db/repo/"))
    .flatMap((f) =>
      f.lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\b(?:db|database)\s*\.\s*(?:run|exec)\s*\(/.test(line))
        .map(({ index }) => `${f.path}:${index + 1}`),
    );
  assert.deepEqual(bad, [], "call ctx.write inside ctx.recorded instead");
});

test("every ledger action is spelled in the one dialect the schema accepts", () => {
  // The `action` column has a CHECK on it: lower case, digits, dots and underscores.
  // A repository that writes `ballot.enteredOnBehalf` therefore does not fail review,
  // it fails at the insert, in whichever request happens to enter a ballot on someone
  // else's behalf first. That exact string was in this repository until the check was
  // tightened, so the vocabulary is scanned here as well.
  //
  // Underscores rather than camel case is not arbitrary: `event.results_published` and
  // `project.submitted` were already the house style, and an audit trail read by an
  // operator is easier to filter when one convention holds across all of it.
  //
  // The scan covers all of `src/` and that is the point, so `action:` is a reserved word
  // here rather than a word two layers may share. The view layer originally spelled a
  // form's target `action`, which put `/signin` and `/session` in front of this assertion;
  // the fix was to rename the field to `formAction` rather than to exempt a directory,
  // because the exemption is what a ledger write from an unscanned layer would hide behind.
  // A future collision fails here the same way, and the same fix applies.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/"))) {
    for (const m of f.text.matchAll(/\baction:\s*(?:[^,\n]*\?\s*)?("(?:[^"]*)"(?:\s*:\s*"[^"]*")?)/g)) {
      for (const literal of (m[1] as string).matchAll(/"([^"]*)"/g)) {
        const action = literal[1] as string;
        if (!/^[a-z][a-z0-9._]{2,63}$/.test(action)) bad.push(`${f.path}: ${action}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("no file has trailing whitespace, a tab, or a stray blank line at the end", () => {
  const bad: string[] = [];
  for (const f of scanned) {
    f.lines.forEach((line, index) => {
      if (/[ \t]$/.test(line)) bad.push(`${f.path}:${index + 1} trailing whitespace`);
      if (line.includes("\t")) bad.push(`${f.path}:${index + 1} tab`);
    });
    if (!f.text.endsWith("\n")) bad.push(`${f.path} does not end with a newline`);
    if (f.text.endsWith("\n\n")) bad.push(`${f.path} ends with a blank line`);
    if (f.text.includes("\r")) bad.push(`${f.path} has a carriage return`);
  }
  assert.deepEqual(bad, []);
});

test("every judging module is re-exported from the package index", () => {
  // A module that exists but is unreachable from the index is a module the API
  // layer will end up importing by deep path, and then the public surface is
  // wherever anyone happened to point.
  const index = code.find((f) => f.path === "src/judging/index.ts");
  assert.ok(index, "src/judging/index.ts is missing");
  const modules = code
    .filter((f) => f.path.startsWith("src/judging/") && f.path !== "src/judging/index.ts")
    .map((f) => f.path.slice("src/judging/".length));
  assert.ok(modules.length > 5);
  const missing = modules.filter((m) => !(index as SourceFile).text.includes(`"./${m}"`));
  assert.deepEqual(missing, []);
});

test("every storage module is re-exported from the package index", () => {
  // Same rule, and here it carries more weight. `ctx.write` is what makes the audit
  // trail structural, and a handler that imported `open.ts` by deep path would hold
  // a raw `Db` that can write without one. Keeping the surface in a single file is
  // what makes that reach show up in a diff.
  const index = code.find((f) => f.path === "src/db/index.ts");
  assert.ok(index, "src/db/index.ts is missing");
  const modules = code
    .filter((f) => f.path.startsWith("src/db/") && f.path !== "src/db/index.ts")
    .map((f) => f.path.slice("src/db/".length));
  assert.ok(modules.length > 5);
  const missing = modules.filter((m) => !(index as SourceFile).text.includes(`"./${m}"`));
  assert.deepEqual(missing, []);
});

test("the judging engine imports nothing outside itself", () => {
  // The engine is pure by design: no dependency, no database, no I/O. That claim
  // is worth exactly as much as the check that keeps it true.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/judging/"))) {
    for (const m of f.text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith("./")) continue;
      bad.push(`${f.path} imports ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the storage layer depends only on Node and the engine", () => {
  // One direction, checked. `src/db` may read the engine's types; the reverse would
  // put a database import behind `npm run prove:normalization`, and the proof's
  // whole claim is that it re-derives the numbers from a seed and nothing else.
  // Resolved rather than pattern-matched, so `../../judging/types.ts` from a
  // subdirectory and `./types.ts` from the top are judged by where they land.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/db/"))) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    for (const m of f.text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith("node:")) continue;
      const target = posix.normalize(posix.join(dir, spec));
      if (target.startsWith("src/db/") || target.startsWith("src/judging/")) continue;
      bad.push(`${f.path} imports ${spec} (${target})`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every command-layer module is re-exported from the package index", () => {
  // The third instance of the same rule, and the one a stranger meets first: the
  // OpenAPI document, the form controls and the capability matrix are all generated
  // from this layer, and a module reachable only by deep path is a module whose
  // consumers cannot be found by reading one file.
  const index = code.find((f) => f.path === "src/api/index.ts");
  assert.ok(index, "src/api/index.ts is missing");
  const modules = code
    .filter((f) => f.path.startsWith("src/api/") && f.path !== "src/api/index.ts")
    .map((f) => f.path.slice("src/api/".length))
    .filter((m) => !m.includes("/"));
  assert.ok(modules.length >= 5, `only found ${modules.length} command-layer modules`);
  const missing = modules.filter((m) => !(index as SourceFile).text.includes(`"./${m}"`));
  assert.deepEqual(missing, []);
});

test("every view module is re-exported from the package index", () => {
  // The fourth instance, and the one that guards a rule with no runtime teeth: every
  // string of markup this product emits is built in `src/view`, and the way that stops
  // being true is a page composed somewhere else out of `esc` imported by deep path.
  const index = code.find((f) => f.path === "src/view/index.ts");
  assert.ok(index, "src/view/index.ts is missing");
  const modules = code
    .filter((f) => f.path.startsWith("src/view/") && f.path !== "src/view/index.ts")
    .map((f) => f.path.slice("src/view/".length));
  assert.ok(modules.length >= 3, `only found ${modules.length} view modules`);
  const missing = modules.filter((m) => !(index as SourceFile).text.includes(`"./${m}"`));
  assert.deepEqual(missing, []);
});

test("every transport module is re-exported from the package index", () => {
  const index = code.find((f) => f.path === "src/http/index.ts");
  assert.ok(index, "src/http/index.ts is missing");
  const modules = code
    .filter((f) => f.path.startsWith("src/http/") && f.path !== "src/http/index.ts")
    .map((f) => f.path.slice("src/http/".length));
  assert.ok(modules.length >= 3, `only found ${modules.length} transport modules`);
  const missing = modules.filter((m) => !(index as SourceFile).text.includes(`"./${m}"`));
  assert.deepEqual(missing, []);
});

test("every mail module is re-exported from the package index", () => {
  const index = code.find((f) => f.path === "src/mail/index.ts");
  assert.ok(index, "src/mail/index.ts is missing");
  const modules = code
    .filter((f) => f.path.startsWith("src/mail/") && f.path !== "src/mail/index.ts")
    .map((f) => f.path.slice("src/mail/".length));
  assert.ok(modules.length >= 3, `only found ${modules.length} mail modules`);
  const missing = modules.filter((m) => !(index as SourceFile).text.includes(`"./${m}"`));
  assert.deepEqual(missing, []);
});

test("the mailer is a leaf: it imports Node, one erased type, and nothing else", () => {
  // `src/mail` is the one package outside `db → api → view → http`, and this is the rule that
  // keeps it that way. It may know what a `Delivery` is, because that is the shape it is asked
  // to send, and the import is `import type` so nothing survives to run. Anything more — a
  // repository, a view helper, the dispatcher — and the mailer would be a layer rather than a
  // leaf, and the question "can this deployment be run without a relay" would stop having the
  // obvious answer it has now.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/mail/"))) {
    for (const m of f.text.matchAll(/\bimport(\s+type)?\s[^;]*?from\s+"([^"]+)"/g)) {
      const spec = m[2] as string;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./")) continue;
      // The one exception, and only as a type.
      if (spec === "../api/index.ts" && m[1] !== undefined) continue;
      bad.push(`${f.path} imports ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("nothing but the composition root imports the mailer", () => {
  // The other half of the same claim. `src/mail` is imported by `bin/manak.ts` and by its own
  // test, and if a command handler ever imported it directly then a deployment with no relay
  // would depend on `openSession` being unreachable rather than on it being unconstructed.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/") && !x.path.startsWith("src/mail/"))) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    for (const m of f.text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith("node:")) continue;
      if (posix.normalize(posix.join(dir, spec)).startsWith("src/mail/")) bad.push(`${f.path} imports ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("nothing but the transport layer imports the transport layer", () => {
  // `src/view` may read a command's field declarations and may not know that a request
  // exists. That is the whole reason the view layer is a separate directory rather than a
  // folder inside `src/http`: a page that could read a cookie would eventually contain an
  // access check, and then there would be two implementations of the access rule — one in
  // `decide` and one in whichever template somebody was editing at the time.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/") && !x.path.startsWith("src/http/"))) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    for (const m of f.text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith("node:")) continue;
      if (posix.normalize(posix.join(dir, spec)).startsWith("src/http/")) {
        bad.push(`${f.path} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("everything above storage reaches it only through src/db/index.ts", () => {
  // This is the rule `ctx.write` depends on. A handler that imported `src/db/open.ts`
  // by deep path would hold a raw `Db`, and a raw `Db` can run an UPDATE without a
  // ledger entry — quietly, correctly, and invisibly to every audit test in this
  // repository. The barrel exports no such handle, so keeping the reach to the barrel
  // is what makes "no write without a ledger entry" hold for code not yet written.
  //
  // The dispatcher is held to it as well as the command layer, and it is the more likely
  // offender of the two: it is the file with a `Db` already in hand, and reaching past the
  // barrel for one repository function would look entirely reasonable in review.
  //
  // Resolved rather than matched on the string, so `../db/repo/scores.ts` from
  // `src/api/` and `../../db/open.ts` from a subdirectory are both judged by where
  // they land.
  const bad: string[] = [];
  const above = (path: string): boolean =>
    path.startsWith("src/api/") || path.startsWith("src/view/") || path.startsWith("src/http/");
  for (const f of code.filter((x) => above(x.path))) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    for (const m of f.text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith("node:")) continue;
      const target = posix.normalize(posix.join(dir, spec));
      if (!target.startsWith("src/db/")) continue;
      if (target === "src/db/index.ts") continue;
      bad.push(`${f.path} imports ${spec} (${target})`);
    }
  }
  assert.deepEqual(bad, [], "import from ../db/index.ts instead");
});

test("nothing below the command layer imports from it", () => {
  // The other direction, and it matters for a different reason. `src/judging` is pure
  // and `src/db` is storage; either one importing an HTTP concern would make the
  // engine's determinism proof and the storage layer's tests depend on a request
  // shape. There is no reason for it and one import is all it takes.
  const bad: string[] = [];
  for (const f of code.filter((x) => x.path.startsWith("src/db/") || x.path.startsWith("src/judging/"))) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    for (const m of f.text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith("node:")) continue;
      if (posix.normalize(posix.join(dir, spec)).startsWith("src/api/")) {
        bad.push(`${f.path} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("every migration is named so it sorts, and every table it makes is STRICT", () => {
  // The runner refuses a new file that sorts before an applied one, so the zero
  // padding is load-bearing rather than cosmetic: `10_x.sql` would sort before
  // `2_x.sql` and make the whole repository unmigratable.
  //
  // STRICT is the point of the schema. Without it SQLite stores the string "abc" in
  // an integer column without complaint, and the first place that shows up is a
  // ranking computed from a score that is not a number.
  const migrations = scanned.filter((f) => f.path.startsWith("src/db/migrations/"));
  assert.ok(migrations.length >= 1, "no migrations found");
  const bad: string[] = [];
  for (const f of migrations) {
    const name = f.path.slice("src/db/migrations/".length);
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) {
      bad.push(`${name} is not NNN_lower_snake.sql`);
    }
    // Statement by statement, with `--` comments removed first: a comment in this
    // schema explains what a constraint deliberately does not do, and one of those
    // sentences contains a semicolon.
    const statements = f.text
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .split(";");
    for (const statement of statements) {
      const match = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/i.exec(statement);
      if (!match) continue;
      if (!/\)\s*strict/i.test(statement)) bad.push(`${name}: table ${match[1]} is not strict`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every document that counts the tests counts the ones that exist", () => {
  // Three documents print a test total, and one of them printed 307 for long enough that
  // the suite had grown by fifty before anybody noticed. A number in prose is the least
  // durable claim in a repository, so these three are derived from the source instead.
  //
  // Counted by scanning for top-level `test(` rather than by asking the runner, because a
  // test cannot know its own suite's size without running it again. The two agree exactly
  // here — nothing in `tests/` declares a case inside a loop or a `describe` — and if that
  // ever changes this scan becomes the wrong instrument and should be deleted rather than
  // loosened.
  // Read from the directory rather than from `scanned`, which deliberately omits this file:
  // the exemption exists because this file contains the patterns it forbids, and it would
  // silently subtract its own cases from the total.
  const declared = readdirSync(join(root, "tests"))
    .filter((entry) => entry.endsWith(".test.ts"))
    .reduce(
      (total, entry) =>
        total +
        readFileSync(join(root, "tests", entry), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("test(")).length,
      0,
    );
  assert.ok(declared > 300, `expected the suite, counted ${declared}`);
  const cited: [string, RegExp][] = [
    ["README.md", /^npm test +# ([\d,]+) tests$/m],
    ["docs/ARCHITECTURE.md", /^The ([\d,]+) tests are Node's own runner/m],
    ["docs/THREAT-MODEL.md", /`npm test`, all ([\d,]+) of them/],
  ];
  const wrong: string[] = [];
  for (const [path, pattern] of cited) {
    const found = pattern.exec(readFileSync(join(root, path), "utf8"));
    assert.ok(found, `${path} no longer states a test count where this test looks for one`);
    const claimed = Number((found[1] as string).replace(/,/g, ""));
    if (claimed !== declared) wrong.push(`${path}: says ${claimed}, the suite declares ${declared}`);
  }
  assert.deepEqual(wrong, []);
});

test("every document that counts the operations counts the ones that exist", () => {
  // The sibling of the test above, for the other number these documents repeat. It rotted
  // the same way and worse: the registry went from 41 operations to 42 and eleven sentences
  // across three files went on saying 41, including two that multiplied it out into a probe
  // total of 492 for a proof that had just sent 504.
  //
  // Every figure here is derived from the declarations, and the patterns are deliberately
  // narrow — a number attached to the word it is counting, never a bare number in prose —
  // so that a sentence rewritten around one still fails rather than slips past. A document
  // that stops stating any of them fails too: a claim quietly deleted is the other way a
  // count stops being checked.
  const ops = ALL_COMMANDS.length;
  const gets = ALL_COMMANDS.filter((c) => c.method === "GET").length;
  const pages = Object.keys(VIEWS).length;
  // Six witnesses, two renderings. Stated as arithmetic in the prose, so it is checked as
  // arithmetic here rather than as a number somebody would have to look up.
  const probes = ops * 6 * 2;
  const wrong: string[] = [];
  for (const path of ["README.md", "docs/ARCHITECTURE.md", "docs/THREAT-MODEL.md"]) {
    const text = readFileSync(join(root, path), "utf8");
    let stated = 0;
    const check = (pattern: RegExp, what: string, actual: number): void => {
      for (const found of text.matchAll(pattern)) {
        stated++;
        const claimed = Number((found[1] as string).replace(/,/g, ""));
        if (claimed !== actual) {
          wrong.push(`${path}: ${what} says ${claimed}, the registry holds ${actual}`);
        }
      }
    };
    check(/(\d+) operations\b/g, "the operation count", ops);
    check(/(\d+) handlers\b/g, "the handler count", ops);
    check(/(\d+) × 6 × 2/g, "the isolation grid", ops);
    check(/× 6 × 2 = \*{0,2}(\d+)/g, "the isolation total", probes);
    check(/all (\d+) requests\b/g, "the probe total", probes);
    check(/across all (\d+)\b/g, "the probe total", probes);
    check(/(\d+) are `GET`/g, "the GET count", gets);
    check(/(\d+) are `POST`/g, "the POST count", ops - gets);
    check(/(\d+) have a hand-written page/g, "the hand-written page count", pages);
    assert.ok(stated >= 2, `${path} states no operation count where this test looks for one`);
  }
  assert.deepEqual(wrong, []);
});

test("the layer table in the architecture document counts the layers that exist", () => {
  // `docs/ARCHITECTURE.md` opens with a table of line counts per layer, and a table like
  // that is a lie the moment somebody edits a file. Two of its rows had already drifted.
  //
  // Exact rather than approximate, and that is a deliberate cost: a one-line change to
  // `src/api` fails this test until the number is corrected. It is the same bargain the
  // migration hashes make — a document whose figures are enforced is worth reading, and
  // the failure message below carries the replacement, so paying it takes one edit.
  const doc = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8");
  // `wc -l` counts newlines; every file here ends with exactly one, asserted above.
  const linesUnder = (prefix: string): number =>
    scanned
      .filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`))
      .reduce((total, f) => total + f.lines.length - 1, 0);
  const rows = [...doc.matchAll(/^\| `([^`]+)` \| ([\d,]+) \|/gm)];
  assert.ok(rows.length >= 6, `expected the layer table, found ${rows.length} rows`);
  const wrong: string[] = [];
  for (const [, path, printed] of rows) {
    const actual = linesUnder(path as string);
    assert.ok(actual > 0, `the table names ${path}, which holds nothing this scan can see`);
    const claimed = Number((printed as string).replace(/,/g, ""));
    if (claimed !== actual) {
      wrong.push(`${path}: the table says ${printed}, the tree holds ${actual.toLocaleString("en-US")}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("the stylesheet styles no class the view layer never puts on an element", () => {
  // The same check as the one below, in the direction that keeps rotting: `.mono` was
  // removed once as dead and came back inside a font-stack selector list, where it read
  // as company for `code` rather than as a class nobody writes. It was dead both times.
  //
  // The `.meter.pNN` ladder is exempt because `meter()` composes those names from a
  // number, so no source file contains the string `p34`. That direction is covered by
  // `tests/view.test.ts`, which snaps a fraction and then looks for the rung in the sheet.
  const css = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string))]
    .filter((name) => !/^p\d+$/.test(name));
  assert.ok(classes.length >= 15, `expected class rules, found ${classes.length}`);
  const layer = code.filter((f) => f.path.startsWith("src/")).map((f) => f.text).join("\n");
  // A class reaches an element either through a `class="..."` attribute or as a variant
  // handed to a primitive as its own string, which is how `good` and `bad` arrive.
  const written = (name: string): boolean =>
    new RegExp(`class="[^"]*\\b${name}\\b|["' ]${name}["' ]`).test(layer);
  assert.deepEqual(
    classes.filter((name) => !written(name)).sort(),
    [],
    "these classes are styled and never written onto anything",
  );
});

test("the stylesheet styles no element the view layer never emits", () => {
  // Dead CSS is silent in both directions and this repository has now shipped it three
  // times: `.mono` and `.quiet` were styled for markup nobody wrote, `@keyframes sheen`
  // was defined and never played, and `pre` — with a `:not(pre)` guard on the `code`
  // rule to match — was a whole glass panel for an element no page produces. Nothing in
  // CSS can complain, so the check has to live out here.
  //
  // A text scan, and it says so: it looks for `<tag` in the layer's source rather than
  // rendering pages, so it would miss a tag assembled from a variable. It is exact for
  // the way this layer is actually written, where every tag is a literal in a template.
  let css = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, "");
  // Keyframe selectors are `from`, `to` and percentages, which read as element names.
  for (;;) {
    const at = css.indexOf("@keyframes");
    if (at < 0) break;
    let i = css.indexOf("{", at);
    for (let depth = 0; i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && (depth -= 1) === 0) break;
    }
    css = css.slice(0, at) + css.slice(i + 1);
  }
  const styled = new Set<string>();
  for (const block of css.matchAll(/(?:^|[{}])([^{}]+)\{/g)) {
    for (const selector of (block[1] as string).split(",")) {
      const name = /^([a-z][a-z0-9]*)/.exec(selector.trim());
      if (name) styled.add(name[1] as string);
    }
  }
  assert.ok(styled.size >= 10, `expected element rules, found ${styled.size}`);
  const layer = code.filter((f) => f.path.startsWith("src/view/")).map((f) => f.text).join("\n");
  // `<input${attrs(...)}` is how half of these are written, so `$` closes a tag name too.
  const emitted = (tag: string): boolean => new RegExp(`<${tag}[\\s>/$]`).test(layer);
  assert.deepEqual(
    [...styled].filter((tag) => !emitted(tag)).sort(),
    [],
    "these elements are styled and never rendered",
  );
});
