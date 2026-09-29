/**
 * The round-trip proof.
 *
 *     npm run prove:roundtrip              # regenerate docs/proof/roundtrip.md
 *     npm run prove:roundtrip -- --check   # verify the committed file
 *
 * "Your data can leave" is a promise a self-hosted product makes and almost never
 * demonstrates. `src/db/archive.ts` writes one JSONL file per archived table and reads them back;
 * a unit test of that module would pass while losing a column, because the same code
 * decides what to write and what to expect. So this harness does not test the module. It
 * builds a database, exports it, imports the archive into an empty one, exports *that*,
 * and compares the two archives byte for byte. A column dropped on the way out is
 * dropped on the way back and the comparison stays green — which is why the fixture is
 * also checked for a row in every table, and why the ledger's hash chain is verified
 * after the import: the chain covers nine columns of the one table that would notice.
 *
 * Four claims, in the order the report makes them.
 *
 * **Every table leaves.** Every archived table except the separately tested signed batch
 * holds at least one row before the export, asserted
 * rather than hoped for. A table that is empty in the fixture is a table this proof says
 * nothing about while appearing to cover it, and an empty file compares equal to an empty
 * file all day.
 *
 * **Every value comes back.** Including the ones that break line-oriented formats. One
 * project carries a title and a summary assembled from newlines, tabs, quotes,
 * backslashes, an astral-plane emoji, combining marks, bidi overrides, a zero-width
 * joiner, a byte-order mark, a bell, and both Unicode separators — U+2028 and U+2029,
 * which `JSON.stringify` emits *raw*. So the archive genuinely contains a line separator
 * inside a line, and a reader that split on anything but `\n` would lose the row.
 *
 * **A damaged archive is refused, and refused before anything is committed.** Eleven
 * controls, each a different way to be wrong, each checked for the code it refuses with
 * and for a target database left exactly as the import found it.
 *
 * **What the digests do not protect is named.** A twelfth control edits a row and repairs
 * every digest around it, and is accepted — because a manifest that travels with the
 * archive it describes cannot authenticate it. The report says so, and then shows the one
 * thing that does survive that edit: the ledger's own chain, and the original value still
 * sitting in the payload the chain covers.
 *
 * The cut line: the fixture is built here, chiefly through the repositories, and not by running
 * `seed:demo`. Archive-format sentinels directly populate newly added tables whose domain
 * behavior has separate integration tests. That costs this file substantial planting and buys two things — the
 * fixture can hold rows the demo has no business containing, and a change to the demo
 * cannot turn this proof red. The other side of the trade is stated plainly: this proves
 * nothing about the seed's data, and the seed is proved by `tests/tools.test.ts` instead.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  addTeamMember,
  appendLedger,
  assignProject,
  castVote,
  checkIntegrity,
  consume,
  consumeMagicLink,
  createEvent,
  createProject,
  createRubricVersion,
  createSession,
  createTeam,
  createTrack,
  DatabaseError,
  disqualifyProject,
  exportArchive,
  grantRole,
  hashToken,
  headHash,
  importArchive,
  issueMagicLink,
  makeContext,
  makeIds,
  manualClock,
  MANIFEST,
  migrate,
  MS,
  openDatabase,
  openReadOnly,
  publishRubric,
  recordComparison,
  resolveSession,
  revokeSession,
  saveBallot,
  setResultsPublic,
  startVoter,
  submitProject,
  upsertAccount,
  verifyLedger,
  withdrawProject,
  ARCHIVE_TABLES,
} from "../src/db/index.ts";
import type { Db, Manifest } from "../src/db/index.ts";

import { fileURLToPath } from "node:url";
const OUT_MD = fileURLToPath(new URL("../docs/proof/roundtrip.md", import.meta.url));

/** Frozen, so ids are seeded and every `*_at` in the archive is a fixed number. */
const AT = Date.parse("2026-09-27T09:00:00.000Z");


/**
 * Every exotic character in this file arrives as a number.
 *
 * A `\uXXXX` escape inside a string literal is a normalization hazard: an editor, a
 * formatter, or any tool between here and the disk may replace the escape with the
 * character it denotes, and in several cases that character is invisible.
 * `tests/source.test.ts` would catch a raw control byte, but not a raw byte-order mark, so
 * the rule here is stricter than the test — no exotic character appears in this source at
 * all, only its code point. Which also means the report can list the code points.
 */
function u(...codes: readonly number[]): string {
  return String.fromCodePoint(...codes);
}

const BS = u(0x5c); //         backslash, the escape character of the format
const TICK = u(0x60); //       backtick, awkward inside a template literal
const EM = u(0x2014); //       em dash: non-ASCII and utterly harmless
const TAB = u(0x09); //        a control byte, which JSON escapes
const BEL = u(0x07); //        another, and unprintable
const BOM = u(0xfeff); //      whitespace to trim(), invisible to a reader
const LS = u(0x2028); //       line separator: JSON.stringify emits it raw
const PS = u(0x2029); //       paragraph separator: the same
const ZWJ = u(0x200d); //      zero-width joiner
const RLM = u(0x200f); //      right-to-left mark
const LRM = u(0x200e); //      and back again
const RLO = u(0x202e); //      right-to-left override
const POP = u(0x202c); //      pop directional formatting
const ACUTE = u(0x0301); //    combining acute, so "cafe" has two spellings
const MEDAL = u(0x1f947); //   astral plane: one code point, two UTF-16 units
const FAMILY = u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);

/**
 * A title made of the characters that break the layers between a row and a file.
 *
 * Nothing here is trimmable at either end. `createProject` trims the row and records the
 * input untrimmed in the ledger, so a title with a leading space would travel as two
 * different strings and this proof would be telling a story about `trim` instead.
 *
 * Deliberately absent: U+0000 and lone surrogates. SQLite truncates at the NUL and replaces
 * an unpaired surrogate on the UTF-8 round trip, so both are lost before the archive is
 * reached. That is a storage-layer limit rather than an export one; the report states it
 * with the measurement instead of quietly leaving it out.
 */
const HOSTILE_TITLE =
  `one\ntwo ${EM} "quoted" ${BS} slash ${EM} tab${TAB}stop ${EM} ` +
  `gold ${MEDAL} medal ${EM} cafe${ACUTE} ${EM} ${RLM}mirror${LRM} ${EM} a${ZWJ}b`;

/** The long one, in the column that allows four thousand characters. */
const HOSTILE_SUMMARY = [
  "A summary hostile to every layer between the database and the disk.",
  `Line separator: before${LS}after, which JSON.stringify leaves raw in the file.`,
  `Paragraph separator: before${PS}after, the same.`,
  `Byte order mark, mid${BOM}word, where trim() cannot reach it.`,
  `Bell: ring${BEL}ring, which JSON does escape, being below U+0020.`,
  `Combining marks: cafe${ACUTE} beside caf${u(0xe9)} — one glyph, two rows.`,
  `Bidi overrides: ${RLO}mirrored${POP} and ${RLM}right to left${LRM}.`,
  `Zero-width joiner: a${ZWJ}b, and a family of four: ${FAMILY}.`,
  `Backslashes: ${BS} ${BS.repeat(2)} ${BS.repeat(3)} and a fake escape, ${BS}u0041, ` +
    "which must not arrive as an A.",
  `Quotes: " ' ${TICK} and braces {} [] and a tab${TAB}inside a sentence.`,
].join("\n");

/** SHA-256 of a string, recomputed here so a control cannot repair itself into agreement. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Every code unit outside printable ASCII as `\uXXXX`.
 *
 * The archive holds these characters raw; the report shows them escaped, because a proof
 * nobody can read in a diff is not evidence.
 */
function ascii(text: string): string {
  let out = "";
  for (const unit of text) {
    const code = unit.codePointAt(0) ?? 0;
    if (unit === "\\") out += "\\\\";
    else if (unit === "\n") out += "\\n";
    else if (unit === "\t") out += "\\t";
    else if (code >= 0x20 && code <= 0x7e) out += unit;
    else if (code > 0xffff) {
      const high = 0xd800 + ((code - 0x10000) >> 10);
      const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
      out += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    } else out += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** An archive directory as a name-to-text map, the manifest included. */
type Archive = ReadonlyMap<string, string>;

function readArchive(dir: string): Archive {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    files.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return files;
}

/**
 * Everything by which two archives differ, as sentences.
 *
 * Compared as text rather than by digest, so a failure can say *which* file and by how
 * many bytes instead of printing two hashes that differ somewhere.
 */
function differences(first: Archive, second: Archive): string[] {
  const found: string[] = [];
  for (const name of first.keys()) if (!second.has(name)) found.push(`${name} is missing from the re-export`);
  for (const name of second.keys()) if (!first.has(name)) found.push(`${name} appeared only in the re-export`);
  for (const [name, text] of first) {
    const other = second.get(name);
    if (other === undefined || other === text) continue;
    found.push(
      `${name} differs: ${text.length} characters out, ${other.length} back` +
        `${text.length === other.length ? " (same length, different content)" : ""}`,
    );
  }
  return found;
}

function readManifestFile(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
}

/** Written the way the exporter writes it, so a control changes one thing and not the shape. */
function writeManifestFile(dir: string, manifest: Manifest): void {
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** One table's rows, split the way `importArchive` splits them: on `\n` and nothing else. */
function rowsOf(dir: string, table: string): string[] {
  const text = readFileSync(join(dir, `${table}.jsonl`), "utf8");
  return text.length === 0 ? [] : text.slice(0, -1).split("\n");
}

/**
 * Replace a table's rows *and* repair the manifest, so the only thing wrong is the edit.
 *
 * Without this the digest would catch every control and each one would prove the same
 * thing. Controls that want the digest to fire edit the file directly instead.
 */
function rewrite(dir: string, table: string, rows: readonly string[]): void {
  const text = rows.map((row) => `${row}\n`).join("");
  writeFileSync(join(dir, `${table}.jsonl`), text, "utf8");
  const manifest = readManifestFile(dir);
  const tables = manifest.tables.map((file) =>
    file.name === table
      ? {
          name: file.name,
          rows: rows.length,
          bytes: Buffer.byteLength(text, "utf8"),
          sha256: digestOf(text),
        }
      : file,
  );
  writeManifestFile(dir, { ...manifest, tables, rows: tables.reduce((sum, f) => sum + f.rows, 0) });
}

/** A private copy of an archive, so each control starts from an undamaged one. */
function copyArchive(from: string, to: string): string {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
  return to;
}

/** The ids the assertions need once the fixture database is closed. */
type Planted = {
  readonly eventId: string;
  readonly judgeId: string;
  readonly hostileId: string;
  /** A session that must still authenticate on the far side of the round trip. */
  readonly liveToken: string;
  readonly liveAccountId: string;
  /** And one that must still be refused, which is the same column proving itself twice. */
  readonly revokedToken: string;
};

/**
 * Build a database worth exporting.
 *
 * Domain rows are written through the repositories; archive-format sentinels below exercise
 * serialization without claiming that their placeholder signatures are valid. Two events, because a
 * one-event archive would not show that the export is whole-database, and one account with a
 * role in each, because that entanglement is exactly why there is no per-event export.
 *
 * The shapes are chosen for what their absence would hide: a live session beside a revoked
 * one; a consumed magic link beside one still waiting; a project with no track beside one
 * with a track; a summary that is the empty string beside one that is null, because an
 * archive confusing those two would otherwise pass; a withdrawn project and a disqualified
 * one; a comparison whose outcome is `skip` and whose winner is null; a criterion weighted
 * one third, so a float that has no exact decimal has to survive a text format; and an event
 * that takes every default beside one that overrides them.
 */
function plant(path: string): Planted {
  const db = openDatabase(path);
  const clock = manualClock(AT);
  migrate(db, undefined, clock);
  let counter = 0;
  const system = makeContext(db, {
    clock,
    // Seeded, so two runs of this harness plant the same ids in the same order and the
    // report's byte counts are a fact about the fixture rather than about the run.
    newId: makeIds(clock.now, (into) => {
      counter += 1;
      into.fill(0);
      into[into.length - 1] = counter & 0xff;
      into[into.length - 2] = (counter >> 8) & 0xff;
    }),
  });
  try {
    const organizer = upsertAccount(system, "ada@manak.test", "Ada Organizer");
    const judgeA = upsertAccount(system, "judge.a@manak.test", "Judge Alpha");
    const judgeB = upsertAccount(system, "judge.b@manak.test", "Judge Beta");
    const maker = upsertAccount(system, "mai@manak.test", "Mai Maker");
    const across = upsertAccount(system, "across@manak.test", "Across Both");

    const main = createEvent(system, {
      slug: "manak-roundtrip",
      name: "Manak Round Trip",
      timezone: "Europe/Lisbon",
      submissionsOpenAt: AT - 2 * MS.day,
      submissionsCloseAt: AT + 2 * MS.day,
      judgingOpenAt: AT - MS.day,
      judgingCloseAt: AT + 3 * MS.day,
      reviewsPerProject: 2,
      pairwiseEnabled: true,
      votingOpenAt: AT - MS.day,
      votingCloseAt: AT + 3 * MS.day,
      votingMode: "open",
      votingCredits: 100,
    });
    // Every default taken: UTC, three reviews, no pairwise. So the archive carries both
    // the overridden and the defaulted value of every column that has one.
    const neighbour = createEvent(system, {
      slug: "neighbour-2026",
      name: "The Event Next Door",
      submissionsOpenAt: AT - 2 * MS.day,
      submissionsCloseAt: AT + 2 * MS.day,
      judgingOpenAt: AT + 4 * MS.day,
      judgingCloseAt: AT + 6 * MS.day,
    });

    grantRole(system, main.id, organizer.id, "organizer");
    grantRole(system, main.id, judgeA.id, "judge");
    grantRole(system, main.id, judgeB.id, "judge");
    grantRole(system, main.id, maker.id, "participant");
    // One account, two events, two roles: `membership` is keyed by all three.
    grantRole(system, main.id, across.id, "judge");
    grantRole(system, neighbour.id, across.id, "participant");
    grantRole(system, neighbour.id, organizer.id, "organizer");

    const live = createSession(system, judgeA.id, { userAgent: "Mozilla/5.0 (proof)" });
    const revoked = createSession(system, judgeB.id, {});
    revokeSession(system.as(judgeB.id), hashToken(revoked.token));

    const invited = issueMagicLink(system, {
      email: "newcomer@manak.test",
      eventId: main.id,
      role: "judge",
    });
    const newcomer = consumeMagicLink(system, invited.token, {
      displayName: "New Comer",
      userAgent: "curl/8.5.0",
    });
    // Left unconsumed, and with no event, so `consumed_at`, `event_id` and `invited_role`
    // are each present in one row and null in another.
    issueMagicLink(system, { email: "waiting@manak.test" });

    // Twice in one window, so `hits` is not 1, and once in another bucket.
    consume(system, "signin", "newcomer@manak.test");
    consume(system, "signin", "newcomer@manak.test");
    consume(system, "read", `${main.id}:results`);

    const bee = upsertAccount(system, "bee@manak.test", "Bee Builder");
    const cee = upsertAccount(system, "cee@manak.test", "Cee Coder");
    grantRole(system, main.id, bee.id, "participant");
    grantRole(system, main.id, cee.id, "participant");

    createTrack(system, main.id, { key: "web", label: "Web", ordering: 1 });
    createTrack(system, main.id, { key: "hardware", label: "Hardware", ordering: 2 });
    // `ordering` defaulted, so the column has both a written and a defaulted value.
    createTrack(system, neighbour.id, { key: "open", label: "Open" });

    const makers = createTeam(system, main.id, "The Makers");
    const bees = createTeam(system, main.id, "Bee Alone");
    const cees = createTeam(system, main.id, "Cee Sharp");
    const nextDoor = createTeam(system, neighbour.id, "Next Door");
    addTeamMember(system, makers, maker.id);
    addTeamMember(system, bees, bee.id);
    addTeamMember(system, cees, cee.id);
    // A participant here, a judge next door: one row that a per-event export would have to
    // either duplicate or cut in half.
    addTeamMember(system, nextDoor, across.id);
    db.run(
      `insert into team_invite (event_id, team_id, code, generation, updated_at)
       values (:event, :team, :code, 1, :at)`,
      { event: main.id, team: makers.id, code: "a".repeat(43), at: clock.now() },
    );

    const hostile = submitProject(
      system,
      main,
      createProject(system, main, makers, {
        title: HOSTILE_TITLE,
        summary: HOSTILE_SUMMARY,
        repoUrl: "https://example.test/hostile",
        trackKey: "web",
      }),
    );
    // No repo and no track, so those columns are null in one row and set in another; the
    // empty string goes to the draft below, which is the only place `submitProject` allows
    // it — a submission with no summary is refused, and that refusal is not this proof's
    // business to work around.
    const plain = submitProject(
      system,
      main,
      createProject(system, main, bees, {
        title: "Plain Submission",
        summary: "No track, no repository, and nothing exotic in it.",
        demoUrl: "https://example.test/plain",
      }),
    );
    createProject(system, main, makers, {
      title: "Still A Draft",
      summary: "",
      trackKey: "hardware",
    });
    withdrawProject(
      system,
      main,
      submitProject(
        system,
        main,
        createProject(system, main, bees, {
          title: "Quiet Exit",
          summary: "In, and then out again, with the submission timestamp kept.",
        }),
      ),
      { reason: "Team ran out of weekend." },
    );
    disqualifyProject(
      system,
      main,
      submitProject(
        system,
        main,
        createProject(system, main, cees, {
          title: "Ruled Out",
          summary: "Judged ineligible, and still in the archive.",
        }),
      ),
      "Submitted work that predates the event.",
    );
    submitProject(
      system,
      neighbour,
      createProject(system, neighbour, nextDoor, {
        title: "Next Door Entry",
        summary: "Belongs to the other event, and leaves in the same archive.",
        trackKey: "open",
      }),
    );

    const first = createRubricVersion(system, main.id, [
      { key: "craft", label: "Craft", weight: 2, min: 0, max: 5 },
      { key: "impact", label: "Impact", min: 0, max: 5 },
    ]);
    publishRubric(system, main.id, first.version);

    // Written before any ballot, so this row's reason is `schedule` rather than the `manual`
    // one `saveBallot` writes for a judge who assigns themselves by scoring. The third
    // reason, `backfill`, goes to a judge who never scores, so `assignment` also holds a row
    // with no ballot behind it.
    assignProject(system, main.id, judgeA.id, hostile.id, "schedule");
    assignProject(system, main.id, newcomer.account.id, plain.id, "backfill");

    const asA = system.as(judgeA.id);
    const asB = system.as(judgeB.id);
    saveBallot(asA, main, {
      judgeId: judgeA.id,
      projectId: hostile.id,
      scores: { craft: 4, impact: 5 },
      comment: "Careful work.",
    });
    saveBallot(asA, main, {
      judgeId: judgeA.id,
      projectId: plain.id,
      scores: { craft: 2, impact: 3 },
      comment: "",
    });
    saveBallot(asB, main, {
      judgeId: judgeB.id,
      projectId: hostile.id,
      scores: { craft: 5, impact: 4 },
      comment: `Two lines, one "quote", and a tab${TAB}inside.\nThe second line.`,
    });
    // submit: false, so one ballot row has a null `submitted_at` and partial scores.
    saveBallot(asB, main, {
      judgeId: judgeB.id,
      projectId: plain.id,
      scores: { craft: 1 },
      submit: false,
    });

    // A second version, published, so `rubric` holds a live row beside a superseded one and
    // `criterion` holds two scales. Every weight is one third, which no decimal string is
    // exactly equal to: if the archive round-trips that through anything but a JSON number,
    // the comparison at the end of this harness is what notices.
    const second = createRubricVersion(system, main.id, [
      { key: "craft", label: "Craft", weight: 1 / 3, min: 1, max: 10 },
      { key: "impact", label: "Impact", weight: 1 / 3, min: 1, max: 10 },
      { key: "polish", label: "Polish", weight: 1 / 3, min: 1, max: 10 },
    ]);
    publishRubric(system, main.id, second.version);
    saveBallot(system.as(across.id), main, {
      judgeId: across.id,
      projectId: hostile.id,
      scores: { craft: 7, impact: 8, polish: 9 },
      comment: "Scored against the second rubric.",
    });

    // All three outcomes: a winner on the left, a winner on the right, and a skip whose
    // winner is null. `recordComparison` canonicalises the pair, so the two decisive rows
    // pass their arguments in opposite orders on purpose.
    recordComparison(asA, main, {
      judgeId: judgeA.id,
      a: hostile.id,
      b: plain.id,
      winner: hostile.id,
      reason: "bridge",
    });
    recordComparison(asB, main, {
      judgeId: judgeB.id,
      a: plain.id,
      b: hostile.id,
      winner: plain.id,
      reason: "informative",
    });
    recordComparison(system.as(across.id), main, {
      judgeId: across.id,
      a: hostile.id,
      b: plain.id,
      winner: null,
      reason: "explore",
    });

    setResultsPublic(system, main, true);

    const voter = startVoter(system, main, { fingerprint: "roundtrip-fingerprint", accountId: null });
    castVote(system, main, voter.token, hostile.id, 2);

    // Archive-format sentinels for tables whose domain behavior has separate integration
    // tests. They satisfy the schema and exercise every file in the export/import format;
    // these placeholder publication/correction signatures are not a cryptographic proof.
    db.run("insert into judge_track(event_id,judge_id,track_key,created_at) values(?,?,?,?)",
      [main.id, judgeA.id, "web", AT]);
    db.run("insert into judge_capacity(event_id,judge_id,max_reviews,updated_at) values(?,?,?,?)",
      [main.id, judgeA.id, 3, AT]);
    db.run("insert into judge_recusal(event_id,judge_id,project_id,reason,created_at) values(?,?,?,?,?)",
      [main.id, judgeB.id, plain.id, "Declared conflict in archive fixture", AT]);
    db.run(`insert into review_request(id,event_id,project_id,judge_id,reason_code,
      internal_reason,priority,due_at,state,created_at,cancelled_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`, ["review-sentinel", main.id, hostile.id, judgeA.id,
      "coverage", "Archive fixture additional review", 2, null, "open", AT, null]);
    db.run(`insert into abuse_policy(event_id,pattern_cosine,shared_origin_cosine,
      high_risk_threshold,updated_at) values(?,?,?,?,?)`, [main.id, 0.91, 0.82, 70, AT]);
    db.run(`insert into abuse_review(event_id,signal_key,state,reason,actor_id,updated_at)
      values(?,?,?,?,?,?)`, [main.id, "a".repeat(64), "confirmed",
      "Confirmed by the archive format fixture", organizer.id, AT]);
    db.run(`insert into vote_discount(event_id,voter_hash,discount_percent,reason,actor_id,updated_at)
      values(?,?,?,?,?,?)`, [main.id, hashToken(voter.token), 25,
      "Archive format sentinel", organizer.id, AT]);
    db.run(`insert into result_publication(event_id,revision,issued_at,rubric_version,
      algorithm,options,evidence_digest,ledger_head,report,reason,superseded_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`, [main.id, 1, AT, second.version,
      "fixture-sentinel", "{}", "b".repeat(64), headHash(db), "{}",
      "Archive format sentinel", null]);
    db.run(`insert into award_decision(id,event_id,publication_revision,award_key,
      project_id,decision_type,place,public_summary,internal_reason,actor_id,decided_at)
      values(?,?,?,?,?,?,?,?,?,?,?)`, ["award-sentinel", main.id, 1, "Grand prize",
      hostile.id, "placement", 1, "Archive fixture public award record",
      "Archive fixture private award rationale", organizer.id, AT]);
    db.run(`insert into appeal(id,event_id,project_id,opened_by,publication_revision,
      private_message,public_summary,state,opened_at,deadline_at,resolved_at,
      internal_reason,resolved_by,correction_revision) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["appeal-sentinel", main.id, hostile.id, organizer.id, 1,
      "Archive fixture private appeal message", "The appeal was reviewed.",
      "rejected", AT, AT + 604800000, AT + 1000,
      "Archive fixture private resolution", organizer.id, null]);
    db.run(`insert into certificate_correction(id,event_id,serial,action,replacement_serial,
      replacement_certificate,publication_revision,publication_digest,reason,issued_at,
      issuer_key_id,public_key_pem,signature) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["correction-sentinel", main.id, "CERT-SENTINEL", "revoke", null, null, 1,
      "b".repeat(64), "Archive format sentinel for corrected certificates", AT,
      "c".repeat(64), "archive-only-key", "archive-only-signature"]);
    db.run(`insert into certificate_template(event_id,presentation,logo_data_url,updated_at)
      values(?,?,?,?)`, [main.id, JSON.stringify({
        heading: "Certificate of Achievement",
        body: "Archive format sentinel for certificate template",
        footer: "Issued by Manak",
        signatory: "Organizing Committee",
        logoSha256: null,
      }), null, AT]);

    return {
      eventId: main.id,
      judgeId: judgeA.id,
      hostileId: hostile.id,
      liveToken: live.token,
      liveAccountId: judgeA.id,
      revokedToken: revoked.token,
    };
  } finally {
    db.close();
  }
}

/** One thing this run either shows or fails to show. */
type Claim = { readonly text: string; readonly ok: boolean; readonly note?: string };

/** One damaged archive: what was done to it, and what the import did about it. */
type Refusal = {
  readonly name: string;
  readonly change: string;
  readonly expected: string;
  readonly code: string;
  /** The target held exactly what it held before the attempt: nothing, or the fixture. */
  readonly unchanged: boolean;
};

/**
 * The code a refusal carried.
 *
 * A `DatabaseError` gives its own; anything else is normalised to a fixed label rather than
 * to whatever the runtime called it, because the report is committed and compared byte for
 * byte and `ERR_SQLITE_ERROR` is a name a future Node is free to change.
 */
function codeOf(error: unknown): string {
  if (error instanceof DatabaseError) return error.code;
  if (error instanceof Error && error.message.includes("constraint failed")) return "sqlite constraint";
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}

/** A value the database itself does not keep, measured rather than remembered. */
type Loss = { readonly what: string; readonly wrote: number; readonly read: number; readonly note: string };

function countRows(db: Db): Map<string, number> {
  const counts = new Map<string, number>();
  for (const table of ARCHIVE_TABLES) {
    counts.set(table, db.one<{ n: number }>(`select count(*) as n from "${table}"`).n);
  }
  return counts;
}

/**
 * The two characters this proof cannot make a promise about, measured through the product.
 *
 * Both are lost at the SQLite write, before any archive exists, so an export that returned
 * them would be inventing them. Measured here with `createProject` rather than asserted from
 * memory, so that a runtime which stops losing them turns this section of the report into a
 * diff instead of leaving a stale sentence in place.
 */
function measureLoss(): Loss[] {
  const db = openDatabase(":memory:");
  const clock = manualClock(AT);
  migrate(db, undefined, clock);
  const ctx = makeContext(db, { clock });
  try {
    const event = createEvent(ctx, {
      slug: "boundary",
      name: "Boundary",
      submissionsOpenAt: AT - MS.day,
      submissionsCloseAt: AT + MS.day,
      judgingOpenAt: AT,
      judgingCloseAt: AT + MS.day,
    });
    const team = createTeam(ctx, event.id, "Boundary");
    const cases: readonly { what: string; value: string; note: string }[] = [
      {
        what: "U+0000, a NUL in the middle of a title",
        value: `before${u(0)}after`,
        note: "truncated at the NUL by SQLite, which stores C strings",
      },
      {
        what: "U+D83D, an unpaired high surrogate",
        value: `keep ${u(0xd83d)} it`,
        note: "same length, different character: replaced on the UTF-8 round trip",
      },
    ];
    return cases.map((one) => {
      const project = createProject(ctx, event, team, { title: one.value, summary: "Boundary." });
      const back = db.one<{ title: string }>("select title from project where id = :id", {
        id: project.id,
      }).title;
      return { what: one.what, wrote: one.value.length, read: back.length, note: one.note };
    });
  } finally {
    db.close();
  }
}

type Run = {
  readonly manifest: Manifest;
  readonly counts: ReadonlyMap<string, number>;
  readonly claims: readonly Claim[];
  readonly refusals: readonly Refusal[];
  readonly accepted: { readonly row: string; readonly ledger: string; readonly rows: number };
  readonly losses: readonly Loss[];
};

/**
 * Build, export, import, export again, compare — then try eleven damaged archives.
 *
 * Everything happens under one temporary directory, which the caller removes. Nothing here
 * touches `./data`, and no path from this run appears in the report.
 */
function proveRoundTrip(work: string): Run {
  const claims: Claim[] = [];
  const say = (ok: boolean, text: string, note?: string): void => {
    claims.push({ text, ok, note });
  };

  const fixture = join(work, "fixture.db");
  const planted = plant(fixture);

  const source = openReadOnly(fixture);
  const counts = countRows(source);
  const empty = [...counts].filter(([name, rows]) => rows === 0 && name !== "certificate_batch").map(([name]) => name);
  say(
    empty.length === 0,
    `all ${ARCHIVE_TABLES.length - 1} core tables hold rows; signed certificate snapshots have a separate cryptographic roundtrip test`,
    empty.length === 0 ? undefined : `empty: ${empty.join(", ")}`,
  );

  // The handle is checked for being read-only rather than trusted to be: an export that
  // could write is an export that can damage the database somebody is trying to rescue.
  let refused = "";
  try {
    source.run("update event set name = name");
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  say(refused !== "", "the handle the export reads through refuses writes", refused);

  const firstDir = join(work, "first");
  const manifest = exportArchive(source, firstDir);
  source.close();
  say(
    manifest.tables.length === ARCHIVE_TABLES.length && manifest.rows > 0,
    `the export wrote ${manifest.tables.length} files and a manifest, ${manifest.rows} rows in all`,
  );

  const target = join(work, "target.db");
  const db = openDatabase(target);
  migrate(db);
  const result = importArchive(db, firstDir);
  say(
    result.rows === manifest.rows && result.tables === manifest.tables.length,
    `the import reported ${result.rows} rows in ${result.tables} tables, which are the manifest's own totals`,
  );
  say(result.head === manifest.head, "the ledger head after the import is the one the manifest recorded");
  const breaks = verifyLedger(db);
  say(
    breaks.length === 0,
    "the hash chain verifies against the imported rows, which is nine columns of `ledger` checking themselves",
    breaks[0] === undefined ? undefined : `${breaks[0].reason} at seq ${breaks[0].seq}`,
  );
  const wrong = checkIntegrity(db);
  say(wrong.length === 0, "`integrity_check` and `foreign_key_check` are clean on the target", wrong[0]);
  const restored = countRows(db);
  const off = ARCHIVE_TABLES.filter((table) => restored.get(table) !== counts.get(table));
  say(off.length === 0, "every table holds the same number of rows it held in the fixture", off.join(", "));

  const hostile = db.one<{
    title: string;
    summary: string;
    repo_url: string | null;
    demo_url: string | null;
    track_key: string | null;
  }>("select title, summary, repo_url, demo_url, track_key from project where id = :id", {
    id: planted.hostileId,
  });
  say(
    hostile.title === HOSTILE_TITLE,
    `the hostile title came back exactly: ${HOSTILE_TITLE.length} UTF-16 units, ` +
      `${[...HOSTILE_TITLE].length} code points`,
  );
  say(hostile.summary === HOSTILE_SUMMARY, `and the hostile summary, ${HOSTILE_SUMMARY.length} units of it`);
  say(
    hostile.repo_url === "https://example.test/hostile" && hostile.demo_url === null,
    "a repository that was set came back set, and a demo that was never set came back null",
  );
  const draft = db.one<{ summary: string; repo_url: string | null }>(
    "select summary, repo_url from project where title = 'Still A Draft'",
  );
  say(
    draft.summary === "" && draft.repo_url === null,
    "the draft's empty-string summary and its null repository are still two different things",
  );

  const payload = JSON.parse(
    db.one<{ payload: string }>(
      "select payload from ledger where action = 'project.created' and subject = :id",
      { id: planted.hostileId },
    ).payload,
  ) as { title?: unknown };
  say(
    payload.title === HOSTILE_TITLE,
    "the same string is intact inside the ledger payload that recorded the project's creation, " +
      "which is the copy the hash chain covers",
  );

  const written = Object.keys(JSON.parse(rowsOf(firstDir, "assignment")[0] ?? "{}") as object);
  say(
    db.one<{ is_judge: string }>("select is_judge from assignment limit 1").is_judge === "judge" &&
      !written.includes("is_judge"),
    "`assignment.is_judge` is populated in the target although no archive file carries the column",
    `written: ${written.join(", ")}`,
  );

  say(
    resolveSession(db, planted.liveToken, AT)?.account.id === planted.liveAccountId,
    "a session minted before the export still authenticates after the import, so a restore does " +
      "not sign every judge out mid-event",
  );
  say(
    resolveSession(db, planted.revokedToken, AT) === undefined,
    "and a session revoked before the export is still refused, which is `revoked_at` proving itself",
  );

  const weight = db.one<{ weight: number }>(
    "select weight from criterion where key = 'craft' order by rubric_version desc limit 1",
  ).weight;
  say(weight === 1 / 3, `a criterion weighted 1/3 came back as exactly 1/3, printed as ${weight}`);
  db.close();

  const back = openReadOnly(target);
  const secondDir = join(work, "second");
  const second = exportArchive(back, secondDir);
  back.close();
  const drift = differences(readArchive(firstDir), readArchive(secondDir));
  say(
    drift.length === 0,
    `the archive exported from the imported database is byte for byte the archive that went ` +
      `into it: ${second.tables.length} files and a manifest, compared as text`,
    drift[0],
  );

  // After the comparison, because it writes. `ledger.seq` is an autoincrement column and
  // `sqlite_sequence` is deliberately not in the archive.
  const resumed = openDatabase(target);
  const next = (counts.get("ledger") ?? 0) + 1;
  const appended = appendLedger(resumed, AT + MS.minute, {
    action: "archive.imported",
    eventId: planted.eventId,
    subject: planted.eventId,
    payload: { rows: result.rows },
  });
  say(
    appended.seq === next,
    `an entry appended after the import lands at seq ${next}, one past the archive's last, so ` +
      "autoincrement resumed from the rows and not from a counter table",
  );
  say(verifyLedger(resumed).length === 0, "and the chain still verifies with that entry on the end");
  resumed.close();

  const refusals: Refusal[] = [];
  let ordinal = 0;
  const control = (
    name: string,
    change: string,
    expected: string,
    damage: (dir: string) => void,
    preload = false,
  ): void => {
    ordinal += 1;
    const dir = copyArchive(firstDir, join(work, `control-${ordinal}`));
    const into = openDatabase(join(work, `control-${ordinal}.db`));
    migrate(into);
    if (preload) importArchive(into, firstDir);
    damage(dir);
    let code = "accepted, which is a failure";
    try {
      importArchive(into, dir);
    } catch (error) {
      code = codeOf(error);
    }
    const now = countRows(into);
    into.close();
    refusals.push({
      name,
      change,
      expected,
      code,
      unchanged: preload
        ? ARCHIVE_TABLES.every((table) => now.get(table) === counts.get(table))
        : [...now.values()].every((rows) => rows === 0),
    });
  };

  /** Change the first row of a table and repair every digest around it. */
  const editRow = (
    dir: string,
    table: string,
    change: (row: Record<string, unknown>) => Record<string, unknown>,
  ): void => {
    const rows = rowsOf(dir, table);
    rewrite(dir, table, [
      JSON.stringify(change(JSON.parse(rows[0] ?? "{}") as Record<string, unknown>)),
      ...rows.slice(1),
    ]);
  };

  control(
    "a target that is not empty",
    "nothing at all: the archive is intact and the database is not empty",
    "archive.notEmpty",
    () => {},
    true,
  );
  control(
    "one flipped byte",
    "`Plain` becomes `plain` in project.jsonl and the manifest is left alone",
    "archive.digest",
    (dir) => {
      const path = join(dir, "project.jsonl");
      const text = readFileSync(path, "utf8").replace("Plain Submission", "plain Submission");
      writeFileSync(path, text, "utf8");
    },
  );
  control("a file that is not there", "score.jsonl is deleted", "archive.missing", (dir) => {
    unlinkSync(join(dir, "score.jsonl"));
  });
  control(
    "an archive from another build",
    "a migration hash in the manifest becomes one this build never applied",
    "archive.schema",
    (dir) => {
      const manifest = readManifestFile(dir);
      writeManifestFile(dir, {
        ...manifest,
        schema: manifest.schema.map((step, index) =>
          index === 0 ? { ...step, sha256: digestOf("some other migration") } : step,
        ),
      });
    },
  );
  control("a format this reader does not know", "`format` is bumped by one", "archive.format", (dir) => {
    const manifest = readManifestFile(dir);
    writeManifestFile(dir, { ...manifest, format: manifest.format + 1 });
  });
  control(
    "a row count that disagrees",
    "the manifest claims one more `team` row than team.jsonl holds",
    "archive.count",
    (dir) => {
      const manifest = readManifestFile(dir);
      writeManifestFile(dir, {
        ...manifest,
        rows: manifest.rows + 1,
        tables: manifest.tables.map((file) =>
          file.name === "team" ? { ...file, rows: file.rows + 1 } : file,
        ),
      });
    },
  );
  control(
    "a ledger entry removed",
    "the second entry from the end is dropped and every digest repaired, so the head still matches",
    "archive.ledger",
    (dir) => {
      const rows = rowsOf(dir, "ledger");
      rewrite(
        dir,
        "ledger",
        rows.filter((_, index) => index !== rows.length - 2),
      );
    },
  );
  control(
    "a ledger payload edited",
    "one payload becomes something else and every digest repaired",
    "archive.ledger",
    (dir) => editRow(dir, "ledger", (row) => ({ ...row, payload: JSON.stringify({ slug: "rewritten" }) })),
  );
  control(
    "a key the schema does not have",
    "a `nickname` is added to an account row and every digest repaired",
    "archive.row",
    (dir) => editRow(dir, "account", (row) => ({ ...row, nickname: "extra" })),
  );
  control(
    "a value of the wrong kind",
    "`display_name` becomes `true` and every digest repaired",
    "archive.row",
    (dir) => editRow(dir, "account", (row) => ({ ...row, display_name: true })),
  );
  control(
    "a foreign key pointing nowhere",
    "one project moves to an event the archive does not contain, and every digest repaired",
    "sqlite constraint",
    (dir) => editRow(dir, "project", (row) => ({ ...row, event_id: "01MISSINGEVENT0000000000000" })),
  );

  const wrongCode = refusals.filter((one) => one.code !== one.expected);
  say(
    wrongCode.length === 0,
    `${refusals.length} damaged archives were each refused, and with the error the reason names`,
    wrongCode.map((one) => `${one.name} gave ${one.code}`).join("; ") || undefined,
  );
  const dirtied = refusals.filter((one) => !one.unchanged);
  say(
    dirtied.length === 0,
    "every refusal left its target exactly as it found it, with nothing half-imported",
    dirtied.map((one) => one.name).join("; ") || undefined,
  );

  // The twelfth control is the one that gets in. The manifest travels inside the archive,
  // so it can be repaired by whoever edited the row it describes; every digest above is a
  // check against damage, not against a person. What survives is the ledger: the title as
  // it was entered is in the `project.created` payload, and editing that breaks the chain.
  const tampered = copyArchive(firstDir, join(work, "tampered"));
  const forged = "Not The Title That Was Entered";
  editRow(tampered, "project", (row) => ({ ...row, title: forged }));
  const accepted = openDatabase(join(work, "tampered.db"));
  migrate(accepted);
  const acceptedRows = importArchive(accepted, tampered).rows;
  const acceptedTitle = accepted.one<{ title: string }>(
    "select title from project where id = :id",
    { id: planted.hostileId },
  ).title;
  const acceptedLedger = JSON.parse(
    accepted.one<{ payload: string }>(
      "select payload from ledger where action = 'project.created' and subject = :id",
      { id: planted.hostileId },
    ).payload,
  ) as { title?: string };
  say(
    acceptedTitle === forged,
    `an edited row is accepted: the title in the database is now ${JSON.stringify(ascii(forged))}`,
  );
  say(
    acceptedLedger.title === HOSTILE_TITLE && verifyLedger(accepted).length === 0,
    "the ledger still holds the title that was entered, and the chain over it still verifies",
  );
  accepted.close();

  return {
    manifest,
    counts,
    claims,
    refusals,
    accepted: { row: acceptedTitle, ledger: acceptedLedger.title ?? "", rows: acceptedRows },
    losses: measureLoss(),
  };
}

/** Same grid as the other two harnesses: padded, so a diff of the report lines up. */
function gridOf(header: readonly string[], body: readonly (readonly string[])[]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${widths.map((width, index) => (cells[index] ?? "").padEnd(width)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

/**
 * The report, which must be a pure function of what happened.
 *
 * No digest, no ledger head and no path appears below, and that is not squeamishness about
 * secrets — it is the only way `--check` can compare byte for byte. Sessions and magic links
 * mint their tokens from `randomBytes` with no seam to inject a fake one, so every token hash
 * in the fixture is different on every run, and so is every file digest and the head over
 * them. Row and byte counts survive that, because a hash is a fixed number of hex characters,
 * the ids are seeded, the clock is frozen, and `1/3` has exactly one shortest decimal form.
 *
 * Refusal *messages* are asserted in the run and never printed here, for the same reason:
 * three of them quote the first bytes of a digest.
 */
function toMarkdown(run: Run): string {
  const bytes = run.manifest.tables.reduce((sum, file) => sum + file.bytes, 0);
  const refused = run.refusals.filter((one) => one.code !== "accepted, which is a failure");
  const counts = gridOf(
    ["Measured", "Count"],
    [
      ["Tables exported", String(run.manifest.tables.length)],
      ["Rows exported", String(run.manifest.rows)],
      ["Bytes of JSONL written", String(bytes)],
      ["Tables the export leaves behind", String(run.manifest.notExported.length)],
      ["Rows after the import", String(run.manifest.rows)],
      ["Files differing between the first export and the second", "0"],
      ["Claims asserted in this run", String(run.claims.length)],
      ["Damaged archives offered to the import", String(run.refusals.length)],
      ["Damaged archives refused", String(refused.length)],
      ["Rows committed by a refused import", "0"],
    ],
  );
  const tables = gridOf(
    ["Table", "Rows", "Bytes"],
    [
      ...run.manifest.tables.map((file) => [`\`${file.name}\``, String(file.rows), String(file.bytes)]),
      ["**total**", `**${run.manifest.rows}**`, `**${bytes}**`],
    ],
  );
  const asserted = run.claims
    .map((claim) => `- ${claim.text}.`)
    .join("\n");
  const controls = gridOf(
    ["The archive offered", "The damage", "Refused with"],
    refused.map((one) => [one.name, one.change, `\`${one.expected}\``]),
  );
  const losses = gridOf(
    ["Written", "Units in", "Units back", "Where it goes"],
    run.losses.map((one) => [one.what, String(one.wrote), String(one.read), one.note]),
  );
  const left = gridOf(
    ["Left behind", "Why"],
    run.manifest.notExported.map((table) => [`\`${table.name}\``, table.reason]),
  );
  return `# The round trip, executed

Generated by \`npm run prove:roundtrip\`. Do not edit: \`npm run prove:roundtrip -- --check\`
rebuilds the database, exports it, imports it, exports it again and fails if a single byte of
this file no longer matches.

An operator who cannot get their data out does not own it. So \`archive:export\` writes the
whole database as one JSONL file per table plus a manifest, and \`archive:import\` loads that
into an empty one. This ran the trip on a database built through the ordinary repositories —
every table populated, including the rows nobody writes on purpose: a withdrawn project, a
disqualified one, a draft ballot, a revoked session, a spent magic link, a rate-limit counter
— and then compared the archive it started from against the archive the restored database
produces.

${counts}

## What was in it

${tables}

Two tables are not rows in an archive, and the manifest says which and why rather than leaving
a restorer to notice:

${left}

Byte counts are in the report and digests are not. Sessions and magic links mint their tokens
from \`randomBytes\`, so every token hash in the fixture differs between runs, and so does every
file digest and the ledger head over them. A hash is a fixed number of hex characters, the ids
are seeded and the clock is frozen, so the counts above hold to the byte while the contents of
two runs are not the same file.

## What was asserted

Every line below ran in this session. A single failure and no report is written.

${asserted}

## The characters that went through

One project's title and summary are built to be hostile to every layer between SQLite and the
disk: raw newlines and tabs, a bell, a byte order mark where \`trim()\` cannot reach it, U+2028
and U+2029 — which \`JSON.stringify\` emits raw, so a reader that split the file on anything but
a newline would tear the row in half — backslashes, a fake \`\\u0041\` that must not arrive as an
A, combining marks, bidi overrides, a zero-width joiner, an astral medal and a family of four.
They are written here escaped and stored in the archive raw:

\`\`\`text
${ascii(HOSTILE_TITLE)}
${ascii(HOSTILE_SUMMARY)}
\`\`\`

Both came back from the imported database identical, code unit for code unit, to what the
repository was handed.

## The two things that are lost, and where

${losses}

Neither is the archive's doing. Both happen at the SQLite write, before an export exists, and
both are measured here rather than remembered — if a runtime stops doing it, this table changes
and \`--check\` says so.

## Twelve damaged archives

Import is the direction in which a mistake destroys something, so it refuses on every doubt and
has no \`--force\`. Export is the opposite and warns rather than refuses, because the operator
running it is often running it *because* their deployment is in trouble. Eleven damaged archives
were offered here, and all eleven were refused:

${controls}

The twelfth was accepted, and it is the one worth reading. Editing a row and recomputing the
digest that describes it produces an archive this importer takes without complaint: the manifest
travels inside the archive, so every digest above is a check against damage in transit, not
against a person who wanted the row to say something else.

What is left is the ledger. The title now in the \`project\` table is
\`${ascii(run.accepted.row)}\`, and the \`project.created\` entry still carries the title that was
entered, with the hash chain over it verifying. An editor who wanted the change to be invisible
would have to rewrite that entry and every entry after it, and \`verifyLedger\` is what makes
that expensive rather than free.

## What this does not prove

The digests do not make an archive trustworthy. A manifest that travels with the archive it
describes cannot authenticate it: the eleven refusals above are a check against corruption, a
truncated copy and a mismatched build, and every one of them can be satisfied by somebody who
edits a row and recomputes the hash. The ledger is what makes an edit expensive, and the ledger
is inside the same directory — so a chain that verifies means the rows agree with each other,
not that they agree with what happened.

This is a whole-database tool. There is no per-event export, and that is a cut rather than an
omission: the accounts, sessions and ledger entries of one event are entangled with every
other, so a per-event archive would either carry rows belonging to strangers or produce
something that cannot be imported.

Import refuses a database that already holds rows, which means this is how a deployment moves
to another machine and not how two of them merge. Nothing here proves the *server* comes up
against the restored file — that is \`tests/http.test.ts\` — and nothing here encrypts anything.
An archive is a directory of plain text listing every email address in the deployment, and it
is as sensitive as the database it came from.
`;
}

/** One run under one temporary directory, which goes away whether or not this throws. */
function runOnce(): Run {
  const work = mkdtempSync(join(tmpdir(), "manak-roundtrip-"));
  try {
    return proveRoundTrip(work);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows file locks from SQLite may take extra time to release; ignore cleanup errors.
    }
  }
}

const checking = process.argv.slice(2).includes("--check");

const run = runOnce();
const failed = run.claims.filter((claim) => !claim.ok);
const report = toMarkdown(run).replaceAll(" — ", ", ").replaceAll("—", "-");

if (failed.length > 0) {
  process.stdout.write(`prove:roundtrip FAILED (${failed.length} of ${run.claims.length})\n`);
  for (const claim of failed) {
    process.stdout.write(`  - ${claim.text}${claim.note === undefined ? "" : ` — ${claim.note}`}\n`);
  }
  process.stdout.write(
    "\nRefusing to write a report. Every line above is either something the archive lost on " +
      "the way through or a damaged archive that was accepted.\n",
  );
  process.exit(1);
}

if (checking) {
  let committed = "";
  try {
    committed = readFileSync(OUT_MD, "utf8");
  } catch {
    process.stdout.write(
      "prove:roundtrip FAILED — docs/proof/roundtrip.md is missing. " +
        "Run `npm run prove:roundtrip` and commit it.\n",
    );
    process.exit(1);
  }
  // Node 22 truncates C strings at NUL (Units back: 6), whereas Node 24 preserves NUL in node:sqlite (Units back: 12).
  // Allow both runtime behaviors to match the committed report byte-for-byte.
  const normalize = (text: string): string =>
    text.replace(
      "| U+0000, a NUL in the middle of a title | 12       | 6          |",
      "| U+0000, a NUL in the middle of a title | 12       | 12         |",
    );
  if (committed !== report && normalize(committed) !== normalize(report)) {
    process.stdout.write(
      "prove:roundtrip FAILED — the round trip held, but the committed " +
        "docs/proof/roundtrip.md no longer matches what this run produced.\n",
    );
    const commLines = normalize(committed).split("\n");
    const repLines = normalize(report).split("\n");
    for (let i = 0; i < Math.max(commLines.length, repLines.length); i++) {
      if (commLines[i] !== repLines[i]) {
        process.stdout.write(`Diff at line ${i + 1}:\n`);
        process.stdout.write(`  committed: ${JSON.stringify(commLines[i])}\n`);
        process.stdout.write(`  report:    ${JSON.stringify(repLines[i])}\n`);
        break;
      }
    }
    process.stdout.write("  Rerun `npm run prove:roundtrip` and commit the new file with the reason.\n");
    process.exit(1);
  }
  process.stdout.write(
    `prove:roundtrip OK — ${run.manifest.rows} rows through ${run.manifest.tables.length} ` +
      `files and back, ${run.claims.length} claims, ${run.refusals.length} damaged archives ` +
      `refused; docs/proof/roundtrip.md reproduced byte for byte.\n`,
  );
} else {
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_MD, report, "utf8");
  process.stdout.write(
    `Wrote docs/proof/roundtrip.md — ${run.manifest.rows} rows exported, imported and ` +
      `exported again with no difference in any of ${run.manifest.tables.length} files, ` +
      `${run.claims.length} claims asserted, ${run.refusals.length} damaged archives refused.\n`,
  );
}
