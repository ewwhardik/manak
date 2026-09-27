/**
 * The three proof harnesses, run as tests.
 *
 * `docs/proof/normalization.md` is the file that makes the judging claim checkable
 * by someone who does not trust it, `docs/proof/isolation.md` does the same for
 * the access claim, and `docs/proof/roundtrip.md` for the claim that the data can
 * leave. A committed generated file rots the moment nobody re-runs the
 * generator, and this suite exists because one of them did: the isolation report sat
 * at seventeen operations for as long as it took to write twenty-four more, and every
 * other test in the tree passed the whole time. So all three generators are tests now.
 * `--check` re-derives all 59 normalization configurations from their seeds, re-sends
 * every isolation probe over a socket, and rebuilds, exports and re-imports a whole
 * database, comparing each against what was committed. A change that quietly moves a
 * published number fails here rather than in front of whoever is reading the proof to
 * decide whether to trust the product.
 *
 * Each harness is invoked as a subprocess rather than imported. That is deliberate:
 * the thing worth testing is the command an evaluator will actually type, exit code
 * and all, not a function the command happens to call.
 *
 * The cut line: byte-for-byte reproduction is asked of the isolation and round-trip
 * reports, because neither contains a measurement. The normalization proof compares its
 * numbers within a tolerance, since a float sum is allowed to move in the last place
 * between platforms and a proof that failed on that would be a proof nobody re-ran.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { ALL_COMMANDS } from "../src/api/commands/index.ts";
import { ARCHIVE_TABLES, NOT_EXPORTED } from "../src/db/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tool = fileURLToPath(new URL("../tools/prove-normalization.ts", import.meta.url));
const csv = fileURLToPath(new URL("../docs/proof/normalization.csv", import.meta.url));
const md = fileURLToPath(new URL("../docs/proof/normalization.md", import.meta.url));
const isolationTool = fileURLToPath(new URL("../tools/prove-isolation.ts", import.meta.url));
const isolationMd = fileURLToPath(new URL("../docs/proof/isolation.md", import.meta.url));
const roundtripTool = fileURLToPath(new URL("../tools/prove-roundtrip.ts", import.meta.url));
const roundtripMd = fileURLToPath(new URL("../docs/proof/roundtrip.md", import.meta.url));

test("the bundled fixture proof reproduces without dropped scores or timestamp drift", () => {
  const fixture = readFileSync(new URL("../tools/fixtures.json", import.meta.url), "utf8");
  const rootFixture = new URL("../fixtures.json", import.meta.url);
  assert.ok(existsSync(rootFixture), "the standalone repository includes the checker fixture");
  assert.equal(readFileSync(rootFixture, "utf8"), fixture);
  const run = check(fileURLToPath(new URL("../tools/prove-fixtures.ts", import.meta.url)));
  assert.equal(run.status, 0, run.output);
});

/** A generator, run the way the README tells a reviewer to run it. */
function check(harness: string): { status: number | null; output: string } {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", harness, "--check"],
    { cwd: root, encoding: "utf8" },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test("the committed proof reproduces from its seeds and its claims still hold", () => {
  const run = check(tool);
  assert.equal(
    run.status,
    0,
    `prove:normalization --check failed. Run \`npm run prove:normalization\` and commit ` +
      `the new docs/proof/ files if the engine changed on purpose.\n${run.output}`,
  );
  assert.match(run.output, /every committed number reproduced/);
});

test("the committed report and CSV agree on which configurations were measured", () => {
  const rows = readFileSync(csv, "utf8").trim().split("\n");
  const header = (rows[0] as string).split(",");
  assert.equal(header[0], "sweep");
  assert.equal(header[1], "label");
  assert.ok(rows.length > 1, "the committed CSV has no rows");

  const report = readFileSync(md, "utf8");
  // Every label the CSV measured has to appear in the prose or a table, or the
  // report is quietly narrower than the evidence behind it.
  const missing: string[] = [];
  for (const row of rows.slice(1)) {
    const label = (row.split(",")[1] as string).replace(/^"|"$/g, "");
    const shown = label.split(" · ")[0] as string;
    if (!report.includes(shown)) missing.push(label);
  }
  assert.deepEqual(missing, [], `measured but never reported: ${missing.join("; ")}`);
});

test("the report states the regime where the simpler method wins", () => {
  const report = readFileSync(md, "utf8");
  // The boundary section is the reason a sceptic should believe the rest of it. A
  // proof that only lists its wins is marketing.
  assert.match(report, /## The boundary of the claim/);
  assert.match(report, /z-scoring is competitive/);
  assert.match(report, /attenuat/i);
  assert.match(report, /Kendall's tau is the wrong metric for prize-giving/);
});

test("the committed isolation proof reproduces byte for byte over a real socket", () => {
  const run = check(isolationTool);
  assert.equal(
    run.status,
    0,
    `prove:isolation --check failed. Run \`npm run prove:isolation\` and commit the new ` +
      `docs/proof/isolation.md if the access rules changed on purpose.\n${run.output}`,
  );
  assert.match(run.output, /reproduced byte for byte/);
});

test("the committed isolation proof covers every declared operation", () => {
  const report = readFileSync(isolationMd, "utf8");
  // The failure this exists for: an operation is added, the matrix in the code grows a
  // row, and the committed report does not — leaving a document that is green about a
  // smaller product than the one being shipped. Checked here rather than only inside the
  // harness so that it fails without waiting for five hundred requests.
  const missing = ALL_COMMANDS.filter((command) => !report.includes(command.name));
  assert.deepEqual(
    missing.map((command) => command.name),
    [],
    `declared but absent from docs/proof/isolation.md: re-run \`npm run prove:isolation\``,
  );
});

test("the committed round-trip proof reproduces byte for byte, archive and all", () => {
  const run = check(roundtripTool);
  assert.equal(
    run.status,
    0,
    `prove:roundtrip --check failed. Run \`npm run prove:roundtrip\` and commit the new ` +
      `docs/proof/roundtrip.md if the schema or the archive format changed on purpose.\n` +
      `${run.output}`,
  );
  assert.match(run.output, /reproduced byte for byte/);
});

test("the committed round-trip proof accounts for every table in the schema", () => {
  const report = readFileSync(roundtripMd, "utf8");
  // The failure this exists for: a table is added, the archive learns to carry it, and the
  // committed report keeps its old row count — a document that is green about a smaller
  // database than the one being shipped. Backticked, so `team` cannot be found inside
  // `team_member`.
  const named = [...ARCHIVE_TABLES, ...NOT_EXPORTED.map((table) => table.name)];
  const missing = named.filter((name) => !report.includes(`\`${name}\``));
  assert.deepEqual(
    missing,
    [],
    `in the schema but absent from docs/proof/roundtrip.md: re-run \`npm run prove:roundtrip\``,
  );
});

test("the round-trip proof publishes what it does not protect", () => {
  const report = readFileSync(roundtripMd, "utf8");
  // Three admissions, each of which a reader would otherwise have to take on trust: the
  // manifest cannot authenticate the archive it travels in, the archive is not encrypted,
  // and there is no per-event export. A report that dropped them would read as a stronger
  // claim than the code makes.
  assert.match(report, /## What this does not prove/);
  assert.match(report, /cannot authenticate it/);
  assert.match(report, /every email address in the deployment/);
  assert.match(report, /no per-event export/);
});
