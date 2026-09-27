/**
 * The pages every deployment has regardless of what is in the database.
 *
 * A view is a function from one command's result to markup, looked up by command name.
 * The alternative - a `page` property on the command declaration - was rejected because
 * it puts HTML in the file that the OpenAPI document is generated from, and then the
 * claim that the JSON API is not a second-class rendering becomes a matter of discipline
 * rather than of structure. A missing view is not an error: the generic renderer below
 * shows the same data as a definition list, so every command has a browser spelling from
 * the moment it is declared.
 */

import type { Command, Parsed, Registry } from "../api/index.ts";
import { bodyFields, commandDoc, requirementSentence } from "../api/index.ts";
import { getClockOffset } from "../db/index.ts";
import type { EventGates, EventRow } from "../db/index.ts";
import { definitions, esc, form, page, scroller, table } from "./html.ts";
import type { Breadcrumb, Prefill } from "./html.ts";

/** Everything a view is given. Read-only; a view cannot reach the database. */
export type ViewContext = {
  readonly command: Command;
  readonly input: Parsed;
  readonly result: unknown;
  /** The signed-in account's display name, or null. */
  readonly whoami: string | null;
  readonly demoMode?: boolean;
  readonly accountId: string | null;
  readonly event: EventRow | null;
  readonly gates: EventGates | null;
  readonly now: number;
  /** For pages that describe the deployment rather than its data. */
  readonly registry: Registry;
  /**
   * Whether the operator named this caller as a founder.
   *
   * Here for exactly one purpose: the events list offers a founder the form that creates
   * one, and offers everybody else nothing. It is the only place in the product where what
   * is *drawn* depends on a capability rather than on what the route already refused, and
   * the alternative was a seventh route whose literal segment would have reserved a slug
   * for the life of the deployment. Nothing is protected by this flag - `events.create`
   * refuses a non-founder whether or not a form was ever rendered.
   */
  readonly founder: boolean;
};

export type View = (context: ViewContext) => string;
export type Views = Readonly<Record<string, View>>;

/**
 * The breadcrumb prefix a scoped page shares: the event it belongs to.
 *
 * By slug, not by id. Both resolve - the event routes accept either - but every other link on
 * every page is built from the slug, and the breadcrumb is the one a reader copies out of the
 * address bar to send to somebody. `/events/dogfood` is a URL a person can read back to a
 * co-organizer over a call; `/events/01M1RSG9TRQ662EZYD12QG9XMX` is one they will get wrong.
 */
export function eventTrail(context: ViewContext, ...rest: readonly Breadcrumb[]): Breadcrumb[] {
  const event = context.event;
  return event === null
    ? [...rest]
    : [{ label: event.name, href: `/events/${encodeURIComponent(event.slug)}` }, ...rest];
}

/** How long until something, in words an organizer would use out loud. */
export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const count = Math.round(abs / size);
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return "moments";
}

/** The one-line status strip a scoped page shows: what is open and what closes next. */
export function gatesNotice(gates: EventGates | null): string | undefined {
  if (gates === null) return undefined;
  const offset = getClockOffset();
  const offsetNotice =
    offset !== 0
      ? `[Virtual Clock: ${offset > 0 ? "+" : ""}${Math.round(offset / 60000)}m offset] `
      : "";
  if (gates.archived) return `${offsetNotice}This event is archived. Nothing can be changed.`;
  const open = [
    ...(gates.submissionsOpen ? ["submissions"] : []),
    ...(gates.judgingOpen ? ["judging"] : []),
  ];
  const state = open.length === 0 ? "Nothing is open" : `Open: ${open.join(" and ")}`;
  return gates.nextBoundaryIn === null
    ? `${offsetNotice}${state}. No further changes are scheduled.`
    : `${offsetNotice}${state}. Next change in ${humanDuration(gates.nextBoundaryIn)}.`;
}

/**
 * The command with this name, or a thrown error.
 *
 * Throwing rather than returning `undefined` is deliberate. A view that quietly rendered a
 * form with no fields because it misspelled a command name is a page that looks finished and
 * submits nothing, and it would survive review. A 500 on the page that names it does not.
 *
 * Every command a view names is looked up here rather than imported: a view lives in
 * `src/view` and the commands live in `src/api/commands`, so importing one would point an
 * arrow the layer test forbids, and looking it up by name means the form is built from the
 * same declaration the dispatcher will parse the submission with.
 */
export function commandNamed(registry: Registry, name: string): Command {
  const found = registry.commands.find((command) => command.name === name);
  if (found === undefined) throw new Error(`no command named ${name}`);
  return found;
}

/**
 * The browser route for a canonical path: the same string without the `/api` prefix.
 *
 * Six lines duplicated from `src/http/wire.ts`, on purpose. Importing the one in the transport
 * layer is exactly the arrow `tests/source.test.ts` forbids, and moving it down into
 * `src/api` would put a fact about routing in the layer that is supposed to know nothing about
 * requests. Duplicating a pure string transform is the cheapest of the three, and it is safe
 * for a reason worth naming: the prefix is asserted in `tests/http.test.ts` and any
 * disagreement between the two copies shows up as a browser link that 404s on the first page
 * a person opens.
 */
export function browserPath(path: string): string {
  return path === "/api" ? "/" : path.slice("/api".length);
}

/**
 * The browser route for a command, with its path parameters filled in.
 *
 * Built from the declaration rather than typed out, because a link is the one thing in this
 * product that can be wrong without any test noticing: a hand-written
 * `/events/${slug}/projects/${id}/ballot` keeps compiling and keeps rendering after somebody
 * moves the route, and the first person to find out is a judge who clicked it. Deriving it
 * means a moved path moves every link to it, and a missing parameter throws here - at render
 * time, on the page that got it wrong - rather than 404ing on submission.
 *
 * Values are percent-encoded. A slug cannot contain a slash today, but the encoding is the
 * difference between a defence and a coincidence.
 */
export function routeFor(command: Command, params: Readonly<Record<string, string>> = {}): string {
  return fill(browserPath(command.path), params, command.path);
}

/**
 * The same route with the `/api` prefix kept: where a page sends somebody who wants the JSON.
 *
 * Every read page in this product links to its own API route, which is the cheapest possible
 * demonstration of the claim that the JSON surface is not an afterthought - the reference page
 * says every operation is both, and this is the place a person checks it without reading docs.
 */
export function apiRoute(command: Command, params: Readonly<Record<string, string>> = {}): string {
  return fill(command.path, params, command.path);
}

/** Path parameters, percent-encoded, or a thrown error naming the one that was missing. */
function fill(
  path: string,
  params: Readonly<Record<string, string>>,
  declared: string,
): string {
  return path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (value === undefined) throw new Error(`route ${declared} needs a value for :${name}`);
      return encodeURIComponent(value);
    })
    .join("/");
}

/**
 * One command's form, addressed to its own browser route.
 *
 * The three-line ceremony this replaces - look the command up, turn its path into a route,
 * take its fields - appears nineteen times across this layer, and every copy is a chance to
 * post a form at the wrong operation. Collapsing it also means the submit label defaults to
 * the one on the declaration, so the word on the button is the word the API reference prints.
 */
export function actionForm(
  context: ViewContext,
  name: string,
  params: Readonly<Record<string, string>> = {},
  extra: {
    readonly hidden?: Readonly<Record<string, string>>;
    readonly prefill?: Prefill;
    readonly legend?: string;
    readonly submit?: string;
    readonly submitAccessKey?: string;
    readonly submitHtml?: string;
    readonly idPrefix?: string;
    readonly submitName?: string;
    readonly submitValue?: string;
    readonly secondarySubmit?: { name: string; value: string; label: string; skipValidation?: boolean };
    readonly inline?: boolean;
    readonly before?: string;
    /** `get` for a read with knobs on. See `FormOptions.method`. */
    readonly method?: "post" | "get";
    /** Body fields to leave out of the generated controls, because the caller drew them. */
    readonly without?: readonly string[];
  } = {},
): string {
  const command = commandNamed(context.registry, name);
  const declared = bodyFields(command);
  const fields =
    extra.without === undefined
      ? declared
      : Object.fromEntries(
          Object.entries(declared).filter(([field]) => !(extra.without as readonly string[]).includes(field)),
        );
  return form({
    formAction: routeFor(command, params),
    submit: extra.submit ?? command.form?.submit ?? command.summary,
    fields,
    ...(extra.idPrefix === undefined ? {} : { idPrefix: extra.idPrefix }),
    ...(extra.submitAccessKey === undefined ? {} : { submitAccessKey: extra.submitAccessKey }),
    ...(extra.submitHtml === undefined ? {} : { submitHtml: extra.submitHtml }),
    ...(extra.submitName === undefined ? {} : { submitName: extra.submitName }),
    ...(extra.submitValue === undefined ? {} : { submitValue: extra.submitValue }),
    ...(extra.secondarySubmit === undefined ? {} : { secondarySubmit: extra.secondarySubmit }),
    ...(extra.method === undefined ? {} : { method: extra.method }),
    ...(extra.hidden === undefined ? {} : { hidden: extra.hidden }),
    ...(extra.prefill === undefined ? {} : { prefill: extra.prefill }),
    ...(extra.legend === undefined ? {} : { legend: extra.legend }),
    ...(extra.inline === undefined ? {} : { inline: extra.inline }),
    ...(extra.before === undefined ? {} : { before: extra.before }),
  });
}

/**
 * A row of counted things.
 *
 * The same panel on the judge's console, the organizer's dashboard and the results page,
 * because they are answering the same shape of question and a person who moves between them
 * mid-event should not have to find the numbers again.
 *
 * Counts are printed as counts and never drawn. `meter()` exists for the places a bar belongs,
 * and it is deliberately not used here: a bar says "this much of that", and a ballot count is
 * not a share of anything a reader could name. Drawing one would invent a denominator. The
 * widest row this renders is seven cells, on the dashboard, which is the number the entrance
 * stagger in `src/view/style.ts` is cut to - add an eighth and the test that counts them fails
 * rather than the eighth cell quietly arriving first.
 */
export function stats(cells: readonly (readonly [string, string | number])[]): string {
  const items = cells
    .map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join("\n");
  return `<div class="panel grid">\n${items}\n</div>`;
}

/** A pill. `open` and `shut` are the only two tones, and they mean yes and no. */
export function tag(label: string, tone: "open" | "shut" | "plain" = "plain"): string {
  return `<span class="tag${tone === "plain" ? "" : ` ${tone}`}">${esc(label)}</span>`;
}

/** A link, or the text on its own when there is nothing to link to. */
export function link(href: unknown, label?: string): string {
  const url = typeof href === "string" ? href.trim() : "";
  if (url === "" || !(url.startsWith("https://") || url.startsWith("http://"))) {
    // Anything that is not plainly an absolute web address is printed as text. A view cannot
    // know what a team pasted into a URL field, and `javascript:` in an `href` is the one
    // escaping mistake `esc` does not catch.
    return url === "" ? "-" : `<code>${esc(url)}</code>`;
  }
  return `<a href="${esc(url)}" rel="noreferrer noopener">${esc(label ?? url)}</a>`;
}

/**
 * A result field, as an unknown, without pretending to know the shape.
 *
 * Every page in this layer reads its result through this and `rows` rather than through a
 * declared type. That looks like a loss and is a deliberate trade: a view typed against the
 * command's return shape would either import from `src/api/commands` - the forbidden arrow -
 * or duplicate nine result types that then drift. The compensating control is that a missing
 * field renders as "-" instead of throwing, and the smoke run fetches every route as HTML.
 */
export function at(result: unknown, key: string): unknown {
  return result !== null && typeof result === "object"
    ? (result as Record<string, unknown>)[key]
    : undefined;
}

/** An array field of a result, as an array. Empty when it is absent or not one. */
export function rows(result: unknown, key: string): readonly Record<string, unknown>[] {
  const value = at(result, key);
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** An instant, in the zone the event is displayed in. Absolute, never "in 3 hours". */
export function when(instant: unknown, timezone: string): string {
  if (typeof instant !== "number" || !Number.isFinite(instant)) return "-";
  // `en-CA` for the date because it is the one common locale that spells it 2026-09-28, and
  // a deadline that reads 09/28 to one person and 28/09 to another is a deadline nobody can
  // act on. The zone is the event's, named in the output, so nothing has to be inferred.
  const text = new Date(instant).toLocaleString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // That locale separates the date from the time with a comma, which reads as punctuation in
  // the middle of a single quantity - and it is dropped rather than tolerated because
  // `docs/ARCHITECTURE.md` quotes this format, and a documented example nothing produces is a
  // lie that survives every test.
  return `${text.replace(", ", " ")} ${timezone}`;
}

/** The zone an event is displayed in, defaulting to UTC when the result omits it. */
export function zoneOf(event: unknown): string {
  const timezone = at(event, "timezone");
  return typeof timezone === "string" && timezone !== "" ? timezone : "UTC";
}

/**
 * Any result, as a page.
 *
 * Not a fallback to be ashamed of: an array of records becomes a real table with the
 * union of its keys as columns, and an object becomes a definition list, so a command
 * declared this morning is usable in a browser this afternoon. Nested values are shown
 * as JSON, which is the honest rendering of a shape this function knows nothing about.
 *
 * It is handed each field's *name* as well as its value, which is the only reason it can
 * print an instant as an instant. The health page reaches this function - it is one of the
 * three GETs with no hand-written view - and it used to render `at` as `1790359200000`, in
 * flat contradiction of the rule that no page ever shows an operator an epoch. A renderer
 * that knows nothing about the shape can still know the layer's own naming: a field called
 * `at`, or ending in `At`, is a time in this product everywhere without exception.
 */
export function genericPage(context: ViewContext): string {
  const result = context.result;
  const body = ((): string => {
    if (result === null || result === undefined) return "<p>Done.</p>";
    if (Array.isArray(result)) return rowsTable(result);
    if (typeof result === "object") {
      const entries = Object.entries(result as Record<string, unknown>);
      const nested = entries.filter(([, value]) => value !== null && typeof value === "object");
      const flat = entries.filter(([, value]) => value === null || typeof value !== "object");
      return [
        definitions(flat.map(([key, value]) => [key, cell(value, key)] as const)),
        ...nested.map(([key, value]) =>
          Array.isArray(value)
            ? `<h2>${esc(key)}</h2>\n${rowsTable(value)}`
            : `<h2>${esc(key)}</h2>\n${definitions(
                Object.entries(value as Record<string, unknown>).map(
                  ([k, v]) => [k, cell(v, k)] as const,
                ),
              )}`,
        ),
      ].join("\n");
    }
    return `<p>${esc(String(result))}</p>`;
  })();
  return page({
    title: context.command.summary,
    trail: eventTrail(context, { label: context.command.summary }),
    whoami: context.whoami, demoMode: context.demoMode,
    notice: gatesNotice(context.gates),
    body,
  });
}

/**
 * Whether a field is an instant, from its name and its magnitude together.
 *
 * The name alone would catch `flat` and `format`, so the test is on the camel-case boundary:
 * exactly `at`, or an `At` with a capital. The magnitude alone would catch any large count, so
 * both have to agree, and the window is 2001 to 2096 in milliseconds - wide enough for every
 * date this product can hold and narrow enough that a tally of anything never lands in it.
 */
function isInstant(key: string, value: unknown): boolean {
  if (!/^at$|At$/.test(key)) return false;
  return Number.isInteger(value) && (value as number) >= 1e12 && (value as number) < 4e12;
}

function cell(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "-";
  if (isInstant(key, value)) return when(value, "UTC");
  if (typeof value === "object") {
    // An empty container is nothing, and `[]` printed literally is the generic renderer
    // showing its workings to somebody who did not ask. A list of scalars is joined, because
    // `["001_initial"]` reads worse than the name it contains. Anything deeper keeps its JSON:
    // this function does not know the shape, and inventing a layout for it would be a guess.
    if (Array.isArray(value)) {
      if (value.length === 0) return "-";
      if (value.every((item) => item === null || typeof item !== "object")) {
        return value.map((item) => cell(item)).join(", ");
      }
    } else if (Object.keys(value as Record<string, unknown>).length === 0) return "-";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function rowsTable(rows: readonly unknown[]): string {
  if (rows.length === 0) return '<p class="muted">Nothing here yet.</p>';
  if (rows.some((row) => row === null || typeof row !== "object")) {
    return `<ul>${rows.map((row) => `<li>${esc(cell(row))}</li>`).join("")}</ul>`;
  }
  const columns: string[] = [];
  for (const row of rows as readonly Record<string, unknown>[]) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return scroller(table(
    columns,
    (rows as readonly Record<string, unknown>[]).map((row) =>
      columns.map((key) => cell(row[key], key)),
    ),
  ), "The rows this operation returned");
}

/**
 * A form for one command, as a page.
 *
 * Used by the views of GET commands whose whole job is to present a write - sign-in is
 * the first - and by the 422 path, which redisplays the same form with every problem
 * marked. One function, so a corrected submission is shown in exactly the layout the
 * first attempt was.
 */
export function formPage(options: {
  readonly command: Command;
  /** Where the form posts. `formAction`, not `action` - see `FormOptions` for why. */
  readonly formAction: string;
  readonly title: string;
  readonly trail?: readonly Breadcrumb[];
  readonly whoami: string | null;
  readonly demoMode?: boolean;
  readonly notice?: string;
  readonly intro?: string;
  readonly prefill?: Readonly<Record<string, string>>;
  readonly problems?: readonly { field: string; message: string }[];
  readonly hidden?: Readonly<Record<string, string>>;
}): string {
  const spec = options.command.form;
  return page({
    title: options.title,
    trail: options.trail ?? [{ label: options.title }],
    whoami: options.whoami,
    demoMode: options.demoMode,
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    body: `${options.intro === undefined ? "" : `<p>${esc(options.intro)}</p>\n`}${form({
      formAction: options.formAction,
      submit: spec?.submit ?? "Submit",
      fields: bodyFields(options.command),
      ...(options.prefill === undefined ? {} : { prefill: options.prefill }),
      ...(options.problems === undefined ? {} : { problems: options.problems }),
      ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    })}`,
  });
}

/**
 * The API reference, generated from the registry at request time.
 *
 * Generated rather than committed because a reference page is only worth reading if it
 * cannot be stale, and the only way to guarantee that is to derive it from the same
 * declarations the server dispatches. The capability column is the part a stranger reads
 * first, so it is a column rather than a paragraph.
 */
export function docsPage(context: ViewContext): string {
  const commands = [...context.registry.commands].sort((a, b) => a.name.localeCompare(b.name));
  // Wrapped where it is built rather than where it is used, so that every `table(` in this
  // layer is textually an argument to `scroller(` - which is a rule a test can read. Held
  // apart, the two halves passed review for months with one table unreachable by keyboard.
  const index = scroller(table(
    ["Operation", "Route", "Callable by"],
    commands.map((command) => [
      `<a href="#${esc(command.name)}">${esc(command.name)}</a>`,
      `<code>${esc(`${command.method} ${command.path}`)}</code>`,
      esc(requirementSentence(command)),
    ]),
    [0, 1, 2],
  ), "Every operation this deployment performs");
  const sections = commands
    .map(
      (command) =>
        `<section id="${esc(command.name)}">\n${
          markdownish(commandDoc(command), `The fields ${command.name} accepts`)
        }\n</section>`,
    )
    .join("\n");
  return page({
    title: "API reference",
    trail: [{ label: "API reference" }],
    whoami: context.whoami, demoMode: context.demoMode,
    body: `<p>Every operation this deployment performs. The same list drives the HTML forms, the
JSON API and <a href="/api/openapi.json">the OpenAPI document</a>; there is no operation
in one that is missing from the others.</p>
<p class="muted">A JSON response comes from the route as written below. The same route
without the <code>/api</code> prefix is the browser's: a <code>GET</code> renders a page there,
and a <code>POST</code> takes the form and answers with a redirect to the page that shows what
it did.</p>
${index}
${sections}`,
  });
}

/**
 * Just enough Markdown to render `commandDoc`, and no more.
 *
 * A general Markdown implementation is a weekend and a security review; this handles the
 * four constructs that function actually emits - headings, tables, paragraphs and inline
 * code - and escapes everything else. If `commandDoc` grows a construct this does not
 * know, the text appears verbatim rather than as broken markup, which is the failure
 * worth choosing.
 *
 * `tableLabel` is required rather than defaulted because a table here is wrapped in the
 * same scrollable region as every other table on the site, and a scrollable region needs
 * a name to be worth reaching. A default would let a caller add a table and get an
 * unnamed tab stop without noticing; a required argument makes them say what it holds.
 * Rows are buffered rather than streamed straight into the output for the same reason -
 * `scroller` takes finished content, so the wrapper is written in one place and cannot
 * drift from the one the rest of the layer emits.
 */
export function markdownish(markdown: string, tableLabel: string): string {
  const out: string[] = [];
  const rows: string[] = [];
  const lines = markdown.split("\n");
  let row = 0;
  const closeTable = (): void => {
    if (row === 0) return;
    out.push(scroller(["<table>", ...rows, "</tbody></table>"].join("\n"), tableLabel));
    rows.length = 0;
    row = 0;
  };
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeTable();
      const depth = (heading[1] as string).length;
      out.push(`<h${depth}>${inline(heading[2] as string)}</h${depth}>`);
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      row += 1;
      if (row === 1) {
        rows.push("<thead><tr>");
        rows.push(...cells.map((c) => `<th scope="col">${inline(c)}</th>`), "</tr></thead><tbody>");
      } else {
        rows.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      }
      continue;
    }
    closeTable();
    if (line.trim() !== "") out.push(`<p>${inline(line)}</p>`);
  }
  closeTable();
  return out.join("\n");
}

/** Backticks become `code`; everything else is escaped first, so nothing can inject. */
function inline(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}
