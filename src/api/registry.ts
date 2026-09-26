/**
 * Every operation this deployment performs, declared once and dispatched twice.
 *
 * A command is the whole operation: its name, its route, who may invoke it, what it
 * takes, what it records in the audit trail, how often it may be called, and the
 * function that does the work. The JSON API and the HTML forms are two renderings of
 * this same list rather than two code paths that happen to agree, which is what makes
 * "the API is the product" a structural claim instead of a slogan. A feature that
 * exists in the browser and not in the API is not possible here: there is nowhere to
 * put it.
 *
 * **Only GET and POST.** An HTML form can send exactly those two, and the moment a
 * command needs PUT or DELETE the browser needs a hidden `_method` field and a second
 * dispatch path — at which point the two renderings have diverged and the invariant
 * above is gone. The cost is honest and worth naming: the API is not REST-shaped, and
 * a reviewer expecting `DELETE /projects/:id` will find `POST /projects/:id/withdraw`
 * instead. In exchange, every route in the OpenAPI document is a route the browser
 * actually uses, and the isolation proof covers both interfaces at once because there
 * is only one.
 *
 * **Boot fails on an incomplete declaration.** `makeRegistry` refuses a command with
 * no capability, no rate limit on a write, a path parameter that is not a declared
 * field, or a name outside the ledger's vocabulary — and it reports every such problem
 * at once rather than the first. A route that reaches production without an access
 * decision is the failure this prevents, and the only reliable moment to prevent it is
 * before the server listens.
 *
 * Handlers take a parsed record rather than a statically typed input object. A mapped
 * type over the field declarations would give editors the exact shape, but it would
 * also make every command generic and every registry `Command<Fields>`; the parser is
 * the thing that actually enforces the shape at run time, and it is tested directly.
 */

import type { Ctx, EventGates, EventRow, LimitName, Role } from "../db/index.ts";
import { LIMITS } from "../db/index.ts";
import type { Capability } from "./capability.ts";
import { AUDIENCES, isRoleAudience, OWNERSHIPS } from "./capability.ts";
import type { Fields, Parsed } from "./schema.ts";
import type { FieldKind } from "./schema.ts";
import { describeField } from "./schema.ts";

/** See the header: two methods, because a form can send two. */
export const METHODS = ["GET", "POST"] as const;
export type Method = (typeof METHODS)[number];

/** The same vocabulary the ledger's `action` column accepts, and for the same reason. */
export const NAME_PATTERN = /^[a-z][a-z0-9._]{2,63}$/;

/** Field kinds whose value is already text when it arrives in a URL. */
const PATH_KINDS: readonly FieldKind["kind"][] = ["id", "text", "enum"];

/**
 * What a handler is given.
 *
 * The event is resolved before the handler runs, because the capability check needed it
 * anyway and a second lookup inside the handler is a second chance to look it up
 * wrong. The gates come with it for the same reason: a handler that re-derives whether
 * submissions are open is a handler that can disagree with the check that let it run.
 */
/**
 * A message this deployment needs to get to a person, and cannot deliver itself.
 *
 * There is no mail client in this product and there is not going to be one: SMTP
 * configuration is the single most common reason a self-hosted install never comes up, and
 * a portal that cannot start until a relay is reachable is a portal nobody evaluates. So a
 * handler describes the message and the operator decides what happens to it — the default
 * writes it to the container's log, which is where an organizer running this on a laptop
 * will actually look.
 *
 * `link` is separate from `body` because it is the part a delivery mechanism may need to
 * treat specially: a log line wants it verbatim, an SMTP sender wants it inside the body,
 * and a test wants to read it without parsing prose.
 */
export type Delivery = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** The absolute or root-relative URL the recipient has to open, when there is one. */
  readonly link?: string;
  /** Why this was sent, for a log line that does not have to guess. */
  readonly reason: "signin" | "invite";
};

export type Invocation = {
  readonly input: Parsed;
  /** A write context with the caller already set as the actor. */
  readonly ctx: Ctx;
  readonly accountId: string | null;
  readonly roles: readonly Role[];
  /** The scoped event, or null for an unscoped command. */
  readonly event: EventRow | null;
  readonly gates: EventGates | null;
  /**
   * The whole command list, for the handful of operations whose subject is the
   * deployment rather than the domain.
   *
   * Handed in rather than imported, because a registry is assembled *from* commands and a
   * command that imported the assembled registry would be a cycle. The three callers are
   * the reference page, the OpenAPI document and the capability matrix — all three of
   * which exist so that what is published cannot drift from what is dispatched, and all
   * three of which would have to be maintained by hand without this.
   */
  readonly registry: Registry;
  /**
   * Whether the operator named this caller as a founder.
   *
   * The access decision has already been made by the time a handler runs, so nothing needs
   * to branch on this to be safe. It is here so a handler can *report* it — `auth.whoami`
   * does, which is how an operator finds out whether the address they put in the
   * environment is the address they are signed in as.
   */
  readonly founder: boolean;
  /** The instant the request was accepted. Every timestamp in one request agrees. */
  readonly now: number;
  /** Where the call came from, for a rate-limit bucket and the session record. */
  readonly address: string;
  readonly userAgent: string;
  /** Event-scoped HttpOnly voting credential; JSON clients may also send their token explicitly. */
  readonly voterToken?: string | null;
  /**
   * Say that this caller now holds a session, or no longer does.
   *
   * Two verbs rather than a cookie API, because a handler that could set a header would
   * be a handler with an opinion about HTTP, and the whole point of this layer is that
   * it has none. The transport decides what a granted session looks like: a browser
   * gets `Set-Cookie`, a script reads the token out of the response body, and both come
   * from the one call.
   */
  readonly signIn: (token: string, expiresAt: number) => void;
  /**
   * Give up this caller's session, or every session they hold.
   *
   * Revokes it where it lives as well as clearing it in the browser, which is why it is a
   * verb here rather than a cookie the handler deletes: a sign-out that only dropped the
   * cookie would leave a live credential in whatever copied it.
   *
   * `everywhere` is the remedy for a credential believed to be loose, and it belongs on
   * this port rather than in a handler because the transport layer is the only part of the
   * request that knows which session made it — a handler that revoked by token hash would
   * need to be handed one, and could be handed somebody else's.
   */
  readonly signOut: (scope?: { everywhere?: boolean }) => void;
  /** Hand a message to whatever this deployment uses for delivery. See `Delivery`. */
  readonly deliver: (message: Delivery) => void;
  /**
   * The origin a link in a delivered message has to start with.
   *
   * A sign-in link is the one string this layer produces that has to be absolute — it is
   * opened from outside the site — and the only honest source for it is the request that
   * asked for it. Supplied rather than derived, because deriving it would mean this layer
   * read a `Host` header.
   */
  readonly origin: string;
};

export type Handler = (call: Invocation) => unknown;

/** What a rate limit may be keyed on. The address is present even when nobody is signed in. */
export type LimitContext = {
  readonly input: Parsed;
  readonly accountId: string | null;
  readonly address: string;
};

/**
 * What a successful response looks like, for the published document.
 *
 * A schema object rather than a field declaration, because real responses nest — a
 * results page is projects containing per-criterion breakdowns — and a flat field list
 * would have forced either a lie or a new field kind. Flat responses still come from
 * the one declaration: `jsonSchema(SOME_VIEW)` is a schema object.
 */
export type Returns =
  | { readonly kind: "json"; readonly schema: Record<string, unknown>; readonly example?: unknown }
  | { readonly kind: "empty" }
  | { readonly kind: "csv" }
  | { readonly kind: "stream"; readonly mediaType: "text/event-stream" };

/** The browser's half of a write: a titled form, and where to go afterwards. */
export type FormSpec = {
  readonly title: string;
  /** The submit button's words. "Submit project", not "OK". */
  readonly submit: string;
  readonly redirect?: (outcome: { input: Parsed; result: unknown }) => string;
};

export type Command = {
  readonly name: string;
  /** One sentence, sentence-cased and ending in a full stop. It is published. */
  readonly summary: string;
  readonly method: Method;
  readonly path: string;
  readonly capability: Capability;
  readonly input: Fields;
  readonly returns: Returns;
  /**
   * The bucket this call spends from. Mandatory on a write: an unmetered write
   * endpoint is a spam vector and a denial-of-service surface, and the threat model
   * claims there are none.
   */
  readonly limit?: LimitName;
  /**
   * What the limit counts against, when the caller is the wrong answer.
   *
   * The default bucket is the caller — the account if there is one, the client address if
   * there is not. Sign-in is the case that breaks it: the limit that matters there is per
   * email address, because ten links to one inbox is the abuse and ten links to ten
   * inboxes from one browser is a workshop. A command that names something from its own
   * input says so here.
   */
  readonly limitKey?: (context: LimitContext) => string;
  /** The ledger actions this command may append. Mandatory on a write. */
  readonly records?: readonly string[];
  readonly form?: FormSpec;
  readonly handler: Handler;
  /** Longer prose for the reference page, when one sentence is not enough. */
  readonly notes?: string;
};

export class RegistryError extends Error {
  readonly code = "registry.incomplete";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the command registry is not deployable:\n  ${problems.join("\n  ")}`);
    this.name = "RegistryError";
    this.problems = problems;
  }
}

/** The `:name` segments of a route, in order. */
export function pathParameters(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/** The fields that travel in the body or query string rather than in the path. */
export function bodyFields(command: Command): Fields {
  const inPath = new Set(pathParameters(command.path));
  return Object.fromEntries(
    Object.entries(command.input).filter(([name]) => !inPath.has(name)),
  );
}

/** The fields that travel in the path, in the order the route names them. */
export function pathFields(command: Command): Fields {
  const out: Fields = {};
  const writable = out as Record<string, Fields[string]>;
  for (const name of pathParameters(command.path)) {
    const field = command.input[name];
    if (field) writable[name] = field;
  }
  return out;
}

/**
 * Everything wrong with one declaration, in the words of whoever has to fix it.
 *
 * Returned rather than thrown, so `makeRegistry` can report a whole broken registry in
 * one pass. Nothing here is a runtime condition: every one of these is a mistake in a
 * source file, and every one of them is worth catching before the port opens.
 */
export function checkCommand(command: Command): string[] {
  const problems: string[] = [];
  const at = command.name || `${command.method} ${command.path}`;
  const say = (text: string): number => problems.push(`${at}: ${text}`);

  if (!NAME_PATTERN.test(command.name)) {
    say(`the name must match ${NAME_PATTERN.source} — lower case, dots, no camel case.`);
  }
  if (command.summary.trim() === "") say("needs a one-sentence summary; it is published.");
  else if (!/^[A-Z]/.test(command.summary) || !command.summary.endsWith(".")) {
    say("the summary must be sentence-cased and end with a full stop.");
  } else if (command.summary.length > 120) say("the summary is longer than one sentence.");

  if (!METHODS.includes(command.method)) say(`${command.method} is not GET or POST.`);
  if (!command.path.startsWith("/")) say("the path must start with a slash.");
  if (command.path !== "/" && command.path.endsWith("/")) say("the path must not end in a slash.");
  for (const segment of command.path.split("/").slice(1)) {
    if (segment === "") say("the path has an empty segment.");
    else if (segment.startsWith(":") && !/^:[a-z][a-zA-Z0-9]*$/.test(segment)) {
      say(`${segment} is not a usable parameter name.`);
    }
  }
  for (const name of pathParameters(command.path)) {
    const field = command.input[name];
    if (!field) say(`the path names :${name} but the input does not declare it.`);
    else if (field.optional || field.fallback !== undefined) {
      say(`:${name} is in the path, so it cannot be optional or have a default.`);
    } else if (!PATH_KINDS.includes(field.kind)) {
      // A path segment is text, always. Allowing an `int` there would mean the parser had
      // to coerce path parameters even on a JSON request, and then the one rule a client
      // author has to remember — JSON is taken at its word — would have an exception in it.
      say(`:${name} is a ${field.kind}, and a path segment is text.`);
    }
  }

  problems.push(...checkCapability(command).map((text) => `${at}: ${text}`));
  problems.push(...checkEffect(command).map((text) => `${at}: ${text}`));

  if (typeof command.handler !== "function") say("has no handler.");
  if (command.form && command.method !== "POST") say("only a POST command can have a form.");
  return problems;
}

/** The access declaration has to be answerable, not merely present. */
function checkCapability(command: Command): string[] {
  const problems: string[] = [];
  const capability = command.capability;
  if (!AUDIENCES.includes(capability.audience)) {
    problems.push(`${capability.audience} is not an audience.`);
  }
  if (capability.owner !== undefined && !OWNERSHIPS.includes(capability.owner)) {
    problems.push(`${capability.owner} is not a kind of ownership.`);
  }
  if (isRoleAudience(capability.audience) && capability.scope === undefined) {
    problems.push(
      `audience ${capability.audience} is a role, so the capability must name the field ` +
        `carrying the event it is a role in.`,
    );
  }
  if (capability.gate !== undefined && capability.scope === undefined) {
    problems.push(`gate ${capability.gate} belongs to an event, so scope must name one.`);
  }
  if (capability.scope !== undefined && command.input[capability.scope] === undefined) {
    problems.push(`scope names ${capability.scope}, which the input does not declare.`);
  }
  return problems;
}

/**
 * What the method implies, checked against what the declaration claims.
 *
 * The method is the single source of truth for whether a command is a read or a write.
 * A GET that records something would be a write a crawler can perform, and a POST that
 * records nothing is either a read on the wrong verb or a write missing its audit
 * entry; both are worth a boot failure rather than a comment.
 */
function checkEffect(command: Command): string[] {
  const problems: string[] = [];
  if (command.limit !== undefined && !(command.limit in LIMITS)) {
    problems.push(`${command.limit} is not one of the declared limits.`);
  }
  if (command.method === "POST") {
    if (command.limit === undefined) problems.push("a write must declare a rate limit.");
    if (!command.records || command.records.length === 0) {
      problems.push("a write must declare the ledger actions it appends.");
    }
    for (const action of command.records ?? []) {
      if (!NAME_PATTERN.test(action)) problems.push(`${action} is not a ledger action.`);
    }
  } else {
    if (command.records && command.records.length > 0) {
      problems.push("a GET records nothing; move it to POST or drop the claim.");
    }
    if (command.returns.kind === "empty") {
      problems.push("a GET that returns nothing has no reason to exist.");
    }
  }
  return problems;
}

/**
 * One declaration, checked where it is written.
 *
 * An identity function with an opinion: it exists so a broken command fails at the
 * import of its own module, naming that file, rather than in a list of problems from a
 * registry assembled somewhere else.
 */
export function defineCommand(command: Command): Command {
  const problems = checkCommand(command);
  if (problems.length > 0) throw new RegistryError(problems);
  return command;
}

type Segment = { readonly literal: string } | { readonly param: string };
type Route = { readonly command: Command; readonly segments: readonly Segment[] };

function compile(path: string): Segment[] {
  return path
    .split("/")
    .slice(1)
    .map((segment) => (segment.startsWith(":") ? { param: segment.slice(1) } : { literal: segment }));
}

/** Two routes are the same route when they differ only in what they call a parameter. */
function shape(path: string): string {
  return path.replace(/:[a-zA-Z0-9]+/g, ":");
}

/** A trailing slash is the same resource; a query string is somebody else's problem. */
function normalize(pathname: string): string {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed === "" ? "/" : trimmed;
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not a route. Answering "no such thing" is both true and
    // the least informative thing to tell whoever sent it.
    return undefined;
  }
}

export type Match = { readonly command: Command; readonly params: Readonly<Record<string, string>> };

export type Registry = {
  readonly commands: readonly Command[];
  byName: (name: string) => Command | undefined;
  match: (method: string, pathname: string) => Match | undefined;
  /** Which methods a path does accept, so a 405 can carry a truthful `Allow`. */
  methodsFor: (pathname: string) => Method[];
};

/**
 * Assemble the registry, or refuse to.
 *
 * Literal segments beat parameters at the same position, which is what lets
 * `/api/events/mine` and `/api/events/:event` coexist and resolve the way anyone
 * reading them would expect. Identical shapes are a boot failure instead, because
 * there is no reading of two identical routes under which one of them is reachable.
 */
export function makeRegistry(commands: readonly Command[]): Registry {
  assertRegistryComplete(commands);
  const byName = new Map(commands.map((command) => [command.name, command]));
  const routes: Route[] = commands
    .map((command, order) => ({ command, order, segments: compile(command.path) }))
    .sort((a, b) => {
      const params = (route: typeof a): number =>
        route.segments.filter((segment) => "param" in segment).length;
      return params(a) - params(b) || a.order - b.order;
    })
    .map(({ command, segments }) => ({ command, segments }));

  const attempt = (route: Route, parts: readonly string[]): Match | undefined => {
    if (route.segments.length !== parts.length) return undefined;
    const params: Record<string, string> = {};
    for (const [index, segment] of route.segments.entries()) {
      const part = parts[index] as string;
      if ("literal" in segment) {
        if (segment.literal !== part) return undefined;
        continue;
      }
      const value = decode(part);
      if (value === undefined || value === "") return undefined;
      params[segment.param] = value;
    }
    return { command: route.command, params };
  };

  return {
    commands,
    byName: (name) => byName.get(name),
    match: (method, pathname) => {
      const parts = normalize(pathname).split("/").slice(1);
      for (const route of routes) {
        if (route.command.method !== method) continue;
        const match = attempt(route, parts);
        if (match) return match;
      }
      return undefined;
    },
    methodsFor: (pathname) => {
      const parts = normalize(pathname).split("/").slice(1);
      const methods: Method[] = [];
      for (const route of routes) {
        if (attempt(route, parts) && !methods.includes(route.command.method)) {
          methods.push(route.command.method);
        }
      }
      return methods;
    },
  };
}

/** Every problem with a whole registry, at once. Throws; boot is meant to stop here. */
export function assertRegistryComplete(commands: readonly Command[]): void {
  const problems: string[] = [];
  if (commands.length === 0) problems.push("the registry is empty.");
  const names = new Set<string>();
  const shapes = new Set<string>();
  for (const command of commands) {
    problems.push(...checkCommand(command));
    if (names.has(command.name)) problems.push(`${command.name}: declared twice.`);
    names.add(command.name);
    const route = `${command.method} ${shape(command.path)}`;
    if (shapes.has(route)) problems.push(`${command.name}: ${route} is already taken.`);
    shapes.add(route);
  }
  if (problems.length > 0) throw new RegistryError(problems);
}

/** Where a field travels, which a client author has to know and cannot guess. */
export function locationOf(command: Command, name: string): "path" | "query" | "body" {
  if (pathParameters(command.path).includes(name)) return "path";
  return command.method === "GET" ? "query" : "body";
}

/** One sentence naming everything a caller must be for this to succeed. */
export function requirementSentence(command: Command): string {
  const capability = command.capability;
  const parts: string[] = [];
  if (capability.audience === "public") parts.push("anyone, signed in or not");
  else if (capability.audience === "account") parts.push("any signed-in account");
  else if (capability.audience === "founder") {
    // Named as configuration rather than as a rank, because that is what a reader of the
    // reference page needs to know: no amount of standing inside an event reaches it.
    parts.push("an account this deployment's operator listed as a founder");
  } else parts.push(`a ${capability.audience} of the event`);
  if (capability.owner === "team") parts.push("on the project's own team");
  if (capability.owner === "judge") parts.push("the judge the ballot belongs to");
  if (capability.owner === "account") parts.push("acting on their own account");
  if (capability.gate === "submissions") parts.push("while submissions are open");
  if (capability.gate === "judging") parts.push("while judging is open");
  if (capability.gate === "results") parts.push("once results are public");
  return parts.join(", ");
}

/**
 * One command as a section of the reference page.
 *
 * Generated rather than written because the alternative has been tried by everybody:
 * a reference page maintained by hand describes the API as it was understood on the
 * afternoon somebody last edited it. Here the only way to change the documentation is
 * to change the declaration the server runs.
 */
export function commandDoc(command: Command): string {
  const lines: string[] = [
    `### ${command.name}`,
    "",
    `\`${command.method} ${command.path}\``,
    "",
    command.summary,
  ];
  if (command.notes) lines.push("", command.notes);
  lines.push("", `Callable by ${requirementSentence(command)}.`);
  const fields = Object.entries(command.input);
  if (fields.length > 0) {
    lines.push(
      "",
      "| Field | Where | Meaning |",
      "| --- | --- | --- |",
      ...fields.map(
        ([name, field]) =>
          `| \`${name}\` | ${locationOf(command, name)} | ${describeField(name, field)} |`,
      ),
    );
  }
  if (command.records && command.records.length > 0) {
    lines.push("", `Records ${command.records.map((action) => `\`${action}\``).join(", ")}.`);
  }
  if (command.limit) {
    const limit = LIMITS[command.limit];
    lines.push("", `Limited to ${limit.max} ${limit.label} per window.`);
  }
  return lines.join("\n");
}
