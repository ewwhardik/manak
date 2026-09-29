/**
 * The operations that describe the deployment rather than act on it.
 *
 * Six commands, and five of them exist so that a stranger who has been handed a URL and
 * nothing else can find out what this thing is, what it will let them do, and whether it
 * is healthy — without reading the source, and without an account.
 *
 * `system.capabilities` is the one that earns its place twice. It publishes the access
 * matrix computed from the same declarations the dispatcher enforces, which makes the
 * isolation claim checkable by a reviewer with `curl` rather than only by the proof
 * harness; and because it is generated, a route that reaches this list without an access
 * decision cannot hide — there is no cell for it to be absent from.
 *
 * The cut line is deliberate: nothing here counts anything. `system.home` does read the
 * event list — a landing page that could not say what is running would be a strange thing
 * to publish — but there is no "total projects" or "ballots cast", because a public counter
 * that moves during judging tells an outsider how a private process is going, and a private
 * counter belongs on the organizer's dashboard where the rest of the diagnostics live.
 */

import { capabilityMatrix, WITNESSES } from "../capability.ts";
import { openapiDocument } from "../openapi.ts";
import { defineCommand, locationOf, requirementSentence } from "../registry.ts";
import type { Command } from "../registry.ts";
import { describeField } from "../schema.ts";
import { EVENT_SUMMARY, eventSummary } from "./events.ts";
import {
  gatesFor,
  headHash,
  ledgerLength,
  LIMITS,
  listEvents,
  migrationStatus,
} from "../../db/index.ts";

/**
 * What this deployment calls itself in the documents it publishes.
 *
 * A constant rather than a read of `package.json`: the published version has to be the
 * version of the code that is running, and a file read at request time can disagree with
 * the bundle it sits beside. It is one line to change at release.
 *
 * The attribution is here rather than in the About page's markup for the same reason the
 * version is: it appears in the landing page's JSON, in the OpenAPI document, in `--help`
 * and on `/about`, and four hand-written copies of a byline are three chances to ship one
 * that disagrees. Every surface reads this object.
 *
 * One `author`, not a publisher and a developer. The two-field version described an
 * organisation that stood behind the work and a person who did it, which is a distinction
 * worth publishing when the two differ and a way to look larger than you are when they do
 * not. This is one person's work, so it says so once, with somewhere to go and check.
 */
export const PRODUCT = {
  title: "Manak",
  version: "0.1.0",
  tagline: "A self-hostable hackathon submission and judging portal.",
  author: "Sai Ram (Hardik) Dash",
  source: "https://github.com/ewwhardik",
  license: "MIT",
} as const;

/**
 * The schema for the object above, shared by every command that publishes it.
 *
 * `PRODUCT` exists so the byline has one source; this exists so its *description* does
 * too. Two commands serve this object, and before this constant they described it
 * differently — `system.about` declared all six fields and `system.home` declared two, so
 * a client generated from the document received a landing page with four undocumented
 * keys on it. Nothing complained, because nothing in this system validates a response
 * against the schema that promised it; `tests/schema.test.ts` is the thing that now does.
 */
export const PRODUCT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    version: { type: "string" },
    tagline: { type: "string" },
    author: { type: "string" },
    source: { type: "string", format: "uri" },
    license: { type: "string" },
  },
  required: ["title", "version", "tagline", "author", "source", "license"],
};

/**
 * The landing page, and the only place an anonymous caller learns what events exist.
 *
 * Archived events are excluded, which is the one editorial decision in this file: a
 * portal that lists three years of finished hackathons buries the one happening today.
 * They remain reachable by slug, so a link in somebody's write-up does not rot.
 *
 * The event mapping is `eventSummary` from `events.ts` rather than a local one. Two
 * hand-written mappings of the same row are two mappings that agree until somebody adds a
 * field to one of them, and the field they would disagree about is the sort a client
 * decides what to draw from.
 */
export const home = defineCommand({
  name: "system.home",
  summary: "List the events this deployment is running.",
  method: "GET",
  path: "/api",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        product: PRODUCT_SCHEMA,
        events: { type: "array", items: EVENT_SUMMARY },
      },
      required: ["product", "events"],
    },
  },
  handler: ({ ctx, now }) => ({
    product: PRODUCT,
    events: listEvents(ctx.db).map((event) => eventSummary(event, gatesFor(event, now))),
  }),
});

/**
 * Whether this container should be taken out of rotation, and why if so.
 *
 * It answers 200 even when it is unhappy, and reports the unhappiness in the body. That
 * looks like the wrong way round and is not: the two things that make a deployment
 * degraded here are a pending migration and a corrupt page, and both are conditions an
 * operator fixes by reading a message and running a command. A probe that 500s on a
 * pending migration puts the container in a restart loop, and a restart loop is precisely
 * the state in which nobody sees the message. The Docker health check reads `status` out
 * of the body for that reason.
 *
 * It does not verify the ledger. Walking the chain is linear in its length and a probe
 * runs every few seconds; publishing the head hash lets anybody who cares pin the chain
 * and compare it later, which is the cheap half of the same assurance. The expensive half
 * is an organizer-only command in the dashboard.
 */
export const health = defineCommand({
  name: "system.healthz",
  summary: "Report whether this deployment is serving correctly.",
  method: "GET",
  path: "/api/healthz",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok", "degraded"] },
        at: { type: "integer", description: "Server time, epoch milliseconds." },
        version: { type: "string" },
        migrations: {
          type: "object",
          properties: {
            current: { type: "boolean" },
            applied: { type: "integer" },
            pending: { type: "array", items: { type: "string" } },
          },
        },
        ledger: {
          type: "object",
          description: "The audit chain's length and head hash. The hash is safe to publish.",
          properties: { length: { type: "integer" }, headHash: { type: "string" } },
        },
        problems: { type: "array", items: { type: "string" } },
      },
      required: ["status", "at", "version", "ledger"],
    },
  },
  handler: ({ ctx, now }) => {
    const migrations = migrationStatus(ctx.db);
    const problems = [
      ...migrations.problems,
      ...migrations.pending.map((id) => `migration ${id} has not been applied`),
    ];
    return {
      status: problems.length === 0 ? "ok" : "degraded",
      at: now,
      version: PRODUCT.version,
      migrations: {
        current: migrations.current,
        applied: migrations.applied,
        pending: migrations.pending,
      },
      ledger: { length: ledgerLength(ctx.db), headHash: headHash(ctx.db) },
      problems,
    };
  },
});

/**
 * The reference, as data for a client and as a page for a person.
 *
 * The JSON rendering is not a courtesy. A CLI that wants to offer tab completion over
 * this deployment's operations needs the list, the fields and the locations, and the
 * alternative — parsing the OpenAPI document for it — asks a shell script to implement
 * JSON Schema. Both come from the same declarations, so they cannot disagree.
 */
export const docs = defineCommand({
  name: "system.docs",
  summary: "Describe every operation this deployment performs.",
  method: "GET",
  path: "/api/docs",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              method: { type: "string", enum: ["GET", "POST"] },
              path: { type: "string" },
              summary: { type: "string" },
              callableBy: { type: "string" },
              records: { type: "array", items: { type: "string" } },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    where: { type: "string", enum: ["path", "query", "body"] },
                    meaning: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      required: ["operations"],
    },
  },
  handler: ({ registry }) => ({
    operations: [...registry.commands]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((command) => ({
        name: command.name,
        method: command.method,
        path: command.path,
        summary: command.summary,
        callableBy: requirementSentence(command),
        records: [...(command.records ?? [])],
        fields: Object.entries(command.input).map(([name, field]) => ({
          name,
          where: locationOf(command, name),
          meaning: describeField(name, field),
        })),
      })),
  }),
});

/**
 * The OpenAPI document, generated from the registry on every request.
 *
 * Generated rather than committed, and served rather than shipped as a file, because a
 * committed document is a document that describes the server somebody last remembered to
 * regenerate against. The bonus this pays for asks whether the API is first-class; a
 * document that can be stale is an admission that it is not.
 */
export const openapi = defineCommand({
  name: "system.openapi",
  summary: "Publish the OpenAPI description of this deployment.",
  method: "GET",
  path: "/api/openapi.json",
  capability: { audience: "public" },
  input: {},
  returns: { kind: "json", schema: { type: "object", description: "An OpenAPI 3.1 document." } },
  notes:
    "The document is derived from the same command declarations the server dispatches, so " +
    "a generated client is generated against what is actually running.",
  handler: ({ registry }) =>
    openapiDocument(registry, {
      title: `${PRODUCT.title} — submission and judging`,
      version: PRODUCT.version,
      description:
        "Every operation is dispatched at two paths: JSON under /api, and the same path " +
        "without the prefix for a browser. A read renders a page there; a write accepts a " +
        "form there and answers with a redirect to the page that shows its result. There is " +
        "no operation on one surface that is missing from the other.",
    }),
});

/**
 * Who may do what, computed rather than described.
 *
 * This is the artefact the isolation proof compares a live server against, and publishing
 * it is a deliberate piece of exposure: a reviewer can read every refusal this deployment
 * intends to make before sending a single request, and then check that it makes them. A
 * matrix that is generated from the declarations cannot omit a route, which is the failure
 * a hand-written access-control document always eventually has.
 */
export const capabilities = defineCommand({
  name: "system.capabilities",
  summary: "Publish the access matrix for every operation.",
  method: "GET",
  path: "/api/capabilities",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        witnesses: { type: "array", items: { type: "string" } },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              route: { type: "string" },
              audience: { type: "string" },
              owner: { type: "string" },
              gate: { type: "string" },
              cells: {
                type: "object",
                description: "Per witness: allow, unauthenticated, forbidden or notFound.",
                additionalProperties: { type: "string" },
              },
            },
          },
        },
      },
      required: ["witnesses", "rows"],
    },
  },
  notes:
    "`stranger` is a signed-in account with no role in the event, which is also how an " +
    "organizer of a different event presents itself. A `notFound` cell is the isolation " +
    "rule: not yours means not found, never forbidden.",
  handler: ({ registry }) => ({
    witnesses: [...WITNESSES],
    rows: capabilityMatrix(registry.commands),
  }),
});

/**
 * What this is, who wrote it, and where each claim it makes can be checked.
 *
 * An About page is usually a byline, and a byline does not need a command. This one earns
 * one because of what it carries besides the byline: every architectural claim this project
 * makes in prose, paired with the route or the file a reader uses to check it. A claim with
 * nowhere to check it is marketing, and a portal that asks an organizer to trust it with a
 * judging result should not be making any.
 *
 * The counts are read from the registry rather than written down. "Forty-two operations" in
 * a hand-maintained sentence is a number that is wrong by the end of the week, and it is
 * wrong in the direction that flatters — nobody ever forgets to increment a count after
 * deleting a route.
 *
 * The cut line: no runtime version, no host name, no build date, no repository URL. The
 * first two are a fingerprint handed to whoever asks; the third would have to come from the
 * clock or the file system, and every other fact on this page is derived from code that is
 * running. The fourth is the one an About page is expected to have, and this deployment
 * cannot know it — the same source is served from anybody's fork — so `license` names the
 * terms and the reader is left to know where they got it.
 */
export const about = defineCommand({
  name: "system.about",
  summary: "Describe what this deployment is and who wrote it.",
  method: "GET",
  path: "/api/about",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        product: PRODUCT_SCHEMA,
        built: {
          type: "object",
          description: "How this deployment is assembled, counted from what is running.",
          properties: {
            dependencies: { type: "integer" },
            operations: { type: "integer" },
            runtime: { type: "string" },
            storage: { type: "string" },
            clientScript: { type: "boolean" },
          },
        },
        claims: {
          type: "array",
          description: "Each claim this project makes, with where to check it.",
          items: {
            type: "object",
            properties: { claim: { type: "string" }, check: { type: "string" } },
            required: ["claim", "check"],
          },
        },
      },
      required: ["product", "built", "claims"],
    },
  },
  notes:
    "Every claim below names the route or the file that settles it. Nothing on this page is " +
    "measured at request time, so two deployments of the same version answer identically.",
  handler: ({ registry }) => ({
    product: PRODUCT,
    built: {
      dependencies: 0,
      operations: registry.commands.length,
      runtime: "Node's standard library. TypeScript is stripped at load; there is no build step.",
      storage: "One SQLite file through node:sqlite, in write-ahead mode, with strict tables.",
      clientScript: false,
    },
    claims: [
      {
        claim: "There are no dependencies. Not few — none.",
        check: "package.json declares no dependencies of any kind, and there is no lock file.",
      },
      {
        claim: "Every operation is both a JSON route and a page, from one declaration.",
        check: "/api/docs lists them; the same path without /api renders the page.",
      },
      {
        claim: "No operation can reach production without an access decision.",
        check: "/api/capabilities publishes the matrix; boot refuses a command without one.",
      },
      {
        claim: "An event's data is invisible to anybody outside it — not found, not forbidden.",
        check: "docs/proof/isolation.md is generated by sending every operation over a socket.",
      },
      {
        claim: "Nothing is written without an entry in a hash-chained ledger.",
        check: "/api/healthz publishes the chain's length and head hash on every request.",
      },
      {
        claim: "Judge leniency and severity are corrected for, and the correction is shown.",
        check: "docs/proof/normalization.md re-derives the numbers from a seed and nothing else.",
      },
      {
        claim: "A published ranking states how much of itself the evidence supports.",
        check: "A rubric fit puts a 95% range on every score and cuts the field into the tiers " +
          "those ranges separate rather than into a list of places. A pairwise-only event has " +
          "no interval to give, so the page drops the column and says why.",
      },
      {
        claim: "A public results page names no judge, in any field, in either rendering.",
        check: "tests/publish.test.ts searches the whole body for every roster id and address; " +
          "the per-judge and per-criterion analysis is on the organizer's dashboard only.",
      },
      {
        claim: "No page needs client-side JavaScript, because there is none to need.",
        check: "The Content Security Policy on every response forbids script outright.",
      },
      {
        claim: "Everything on every page can be reached with a keyboard alone.",
        check: "Each table sits in a named, focusable scroll region, so a column past the " +
          "edge of a narrow window is reachable without a mouse; tests/view.test.ts holds it.",
      },
      {
        claim: "Your data can leave: the whole database exports as text and imports back intact.",
        check: "docs/proof/roundtrip.md exports, imports and re-exports, then compares the bytes.",
      },
    ],
  }),
});

export const limits = defineCommand({
  name: "system.limits",
  summary: "List fixed-window rate limiting policies and status 429 contract.",
  method: "GET",
  path: "/api/system/limits",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        limits: { type: "object" },
        status429Contract: { type: "string" },
      },
      required: ["limits", "status429Contract"],
    },
  },
  notes: "Public policy specification. Explains fixed-window rate meters and Retry-After header semantics.",
  handler: () => ({
    limits: LIMITS,
    status429Contract: "RFC 6585 with Retry-After header",
  }),
});

export const rateProbe = defineCommand({
  name: "system.rate_probe",
  summary: "Safe rate limit probe endpoint to exercise 429 flood refusal.",
  method: "POST",
  path: "/api/system/rate-probe",
  capability: { audience: "public" },
  input: {},
  returns: {
    kind: "json",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        status: { type: "string" },
        window: { type: "string" },
        max: { type: "integer" },
      },
      required: ["ok", "status", "window", "max"],
    },
  },
  limit: "probe",
  records: ["system.probed"],
  notes: "Enforces 2 requests per minute. Exceeding triggers HTTP 429 Too Many Requests with Retry-After header.",
  handler: () => ({
    ok: true,
    status: "allowed",
    window: "1m",
    max: 2,
  }),
});

/** Every command in this file, in the order the reference page should introduce them. */
export const SYSTEM_COMMANDS: readonly Command[] = [
  home,
  about,
  docs,
  openapi,
  capabilities,
  health,
  limits,
  rateProbe,
];
