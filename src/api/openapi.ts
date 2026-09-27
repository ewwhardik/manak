/**
 * The registry as an OpenAPI 3.1 document.
 *
 * Generated, and generated plainly. The reason for publishing this at all is that a
 * stranger can point a client generator at it and have working code on the first try,
 * which means the document's job is to be boring: `type`, bounds, `enum`, one shape per
 * response, no keyword that only half the generators implement.
 *
 * Two things here are worth more than the schemas. Every operation carries
 * `x-manak-capability`, so who may call it is machine-readable from the document alone
 * rather than described in a paragraph somebody has to trust. And every write declares
 * both a JSON and a form encoding, because both are literally the same handler — the
 * document says so because it is derived from the same declaration the server runs.
 *
 * Error responses are derived rather than listed. A public read cannot answer 401, a
 * command with no input cannot answer 422, and a document that claims otherwise
 * teaches a client author to write dead branches.
 */

import type { Capability } from "./capability.ts";
import { SESSION_COOKIE } from "./capability.ts";
import type { Command, Method, Registry } from "./registry.ts";
import { bodyFields, pathFields, pathParameters, requirementSentence } from "./registry.ts";
import { fieldSchema, jsonSchema } from "./schema.ts";

export type DocumentInfo = {
  title: string;
  version: string;
  description?: string;
  servers?: readonly { url: string; description?: string }[];
};

/** OpenAPI templates a path as `{event}`; a route names it `:event`. */
export function templatePath(path: string): string {
  return path.replace(/:([a-zA-Z0-9]+)/g, "{$1}");
}

/** Generators dislike dots in an operation id more than they dislike underscores. */
export function operationId(name: string): string {
  return name.replace(/\./g, "_");
}

const PROBLEM_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "A refusal, in the shape RFC 9457 describes. `code` is the stable machine-readable " +
    "name; `detail` is this occurrence and may be shown to a person.",
  properties: {
    type: { type: "string", description: "A URI reference for the problem type." },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    code: { type: "string", examples: ["project.missing"] },
    problems: {
      type: "array",
      description: "Present on a 422: every field that needs attention, not just one.",
      items: {
        type: "object",
        properties: { field: { type: "string" }, message: { type: "string" } },
        required: ["field", "message"],
        additionalProperties: false,
      },
    },
    meta: { type: "object", additionalProperties: true },
  },
  required: ["type", "title", "status", "detail", "code"],
  additionalProperties: false,
};

/** Every error response the document can reference, described once. */
const RESPONSES: Readonly<Record<number, string>> = {
  400: "The request itself could not be read: a bad escape in the URL, or a body that is not the JSON it claims to be.",
  401: "Nobody is signed in. Sign in and retry.",
  403: "Signed in, and a member of this event, but not with the role this needs.",
  404: "No such thing — or none that this caller is allowed to know exists.",
  409: "Well-formed, and refused: a deadline, a published rubric, a withdrawn project.",
  413: "The body is larger than this deployment accepts.",
  415: "Send `application/json` or `application/x-www-form-urlencoded`; nothing else is read.",
  422: "The submission is malformed. Every problem is listed, not just the first.",
  429: "Rate limited. `Retry-After` says how long, and the window is fixed.",
  500: "A bug. The operator's log has the details; this response does not.",
};

function problemResponse(status: number): Record<string, unknown> {
  return {
    description: RESPONSES[status] as string,
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
    ...(status === 429
      ? { headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds." } } }
      : {}),
  };
}

/**
 * Which refusals this operation can actually produce.
 *
 * 404 is offered whenever a path parameter exists — a wrong id is always possible — and
 * whenever the audience is a role, because that is what a caller outside the event is
 * told. The pairing is not accidental: it is what makes the two indistinguishable.
 *
 * 400, 429 and 500 are on everything: any request can be malformed, metered, or hit a bug.
 * 413 and 415 are on writes only, because a GET has no body to be too large or in the
 * wrong format. 405 is on nothing — it is an answer about a path rather than about an
 * operation, and an operation cannot be reached by a method it does not have.
 */
export function errorStatuses(command: Command): number[] {
  const statuses = new Set<number>([400, 429, 500]);
  const capability = command.capability;
  const roleScoped = capability.audience !== "public" && capability.audience !== "account";
  if (capability.audience !== "public") statuses.add(401);
  if (roleScoped) {
    statuses.add(403);
    statuses.add(404);
  }
  if (pathParameters(command.path).length > 0) statuses.add(404);
  if (Object.keys(command.input).length > 0) statuses.add(422);
  if (command.method === "POST") {
    statuses.add(409);
    statuses.add(413);
    statuses.add(415);
  } else if (capability.gate !== undefined) statuses.add(409);
  return [...statuses].sort((a, b) => a - b);
}

function security(capability: Capability): Record<string, unknown>[] {
  // An explicitly empty requirement is how OpenAPI says "no credential needed"; leaving
  // it out would inherit the document-wide default and make every public read look
  // authenticated to a generator.
  if (capability.audience === "public") return [{}];
  return [{ session: [] }, { bearer: [] }];
}

/**
 * Path and query parameters.
 *
 * `help` is spread in rather than assigned as `description: field.help ?? undefined`,
 * because a key whose value is `undefined` is not JSON: `JSON.stringify` drops it, so
 * the served document and this object would differ in a way nothing notices until
 * something compares them.
 */
function parameters(command: Command): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const paths = pathFields(command);
  for (const [name, field] of Object.entries(paths)) {
    out.push({
      name,
      in: "path",
      required: true,
      ...(field.help === undefined ? {} : { description: field.help }),
      schema: fieldSchema(field),
    });
  }
  if (command.method === "GET") {
    for (const [name, field] of Object.entries(bodyFields(command))) {
      out.push({
        name,
        in: "query",
        required: !field.optional && field.fallback === undefined,
        ...(field.help === undefined ? {} : { description: field.help }),
        schema: fieldSchema(field),
      });
    }
  }
  return out;
}

function requestBody(command: Command): Record<string, unknown> | undefined {
  if (command.method !== "POST") return undefined;
  const fields = bodyFields(command);
  if (Object.keys(fields).length === 0) return undefined;
  const schema = jsonSchema(fields);
  return {
    required: true,
    description:
      "The form encoding is the same operation and the same fields. It differs in one " +
      "way: a URL-encoded body carries no types, so `3` and `true` arrive as text and " +
      "are converted, while a JSON body of `\"3\"` for an integer is refused.",
    content: {
      "application/json": { schema },
      "application/x-www-form-urlencoded": { schema },
    },
  };
}

function successResponse(command: Command): Record<string, unknown> {
  const returns = command.returns;
  if (returns.kind === "csv") return { 200: { description: "Organizer-only CSV download.", content: { "text/csv": { schema: { type: "string" } } } } };
  if (returns.kind === "empty") return { 204: { description: "Done. Nothing to say about it." } };
  if (returns.kind === "stream") {
    return {
      200: {
        description: "An event stream that stays open until the client closes it.",
        content: { [returns.mediaType]: { schema: { type: "string" } } },
      },
    };
  }
  return {
    200: {
      description: command.summary,
      content: {
        "application/json": {
          schema: returns.schema,
          ...(returns.example === undefined ? {} : { examples: { default: { value: returns.example } } }),
        },
      },
    },
  };
}

function operation(command: Command): Record<string, unknown> {
  const errors: Record<string, unknown> = {};
  for (const status of errorStatuses(command)) errors[String(status)] = problemResponse(status);
  const capability = command.capability;
  return {
    operationId: operationId(command.name),
    summary: command.summary,
    description: [`Callable by ${requirementSentence(command)}.`, command.notes ?? ""]
      .filter((part) => part !== "")
      .join("\n\n"),
    tags: [command.name.split(".")[0] as string],
    security: security(capability),
    parameters: parameters(command),
    ...(requestBody(command) ? { requestBody: requestBody(command) } : {}),
    responses: { ...successResponse(command), ...errors },
    "x-manak-command": command.name,
    "x-manak-capability": {
      audience: capability.audience,
      ...(capability.scope ? { scope: capability.scope } : {}),
      ...(capability.owner ? { owner: capability.owner } : {}),
      ...(capability.gate ? { gate: capability.gate } : {}),
    },
    ...(command.records ? { "x-manak-records": [...command.records] } : {}),
    ...(command.limit ? { "x-manak-limit": command.limit } : {}),
  };
}

/** Tags in the order their first command appears, so the rendered page is not random. */
function tags(commands: readonly Command[]): { name: string }[] {
  const seen: string[] = [];
  for (const command of commands) {
    const area = command.name.split(".")[0] as string;
    if (!seen.includes(area)) seen.push(area);
  }
  return seen.map((name) => ({ name }));
}

export function openapiDocument(
  registry: Registry | { readonly commands: readonly Command[] },
  info: DocumentInfo,
): Record<string, unknown> {
  const commands = registry.commands;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const command of commands) {
    const template = templatePath(command.path);
    const item = paths[template] ?? {};
    item[command.method.toLowerCase() as Lowercase<Method>] = operation(command);
    paths[template] = item;
  }
  return {
    openapi: "3.1.1",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: info.title,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
    },
    ...(info.servers ? { servers: info.servers.map((server) => ({ ...server })) } : {}),
    tags: tags(commands),
    paths,
    components: {
      schemas: { Problem: PROBLEM_SCHEMA },
      securitySchemes: {
        session: {
          type: "apiKey",
          in: "cookie",
          name: SESSION_COOKIE,
          description:
            "The cookie a browser gets from a sign-in link. Set `HttpOnly`, `SameSite=Lax` " +
            "and — where the deployment is served over TLS — `Secure`.",
        },
        bearer: {
          type: "http",
          scheme: "bearer",
          description:
            "The same session token as the cookie, for clients that are not browsers. " +
            "One credential kind, so revoking a session revokes both.",
        },
      },
    },
  };
}

/** The document as it is served and as it is committed, with a trailing newline. */
export function openapiJson(
  registry: Registry | { readonly commands: readonly Command[] },
  info: DocumentInfo,
): string {
  return `${JSON.stringify(openapiDocument(registry, info), null, 2)}\n`;
}
