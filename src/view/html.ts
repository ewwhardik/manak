/**
 * HTML as strings, escaped at the one place text becomes markup.
 *
 * No template engine and no JSX, which is a decision rather than an omission. A
 * dependency-free build means any engine would be hand-written anyway, and the thing a
 * hand-written engine gets wrong is escaping - so instead of a general one, this module
 * offers exactly two ways to produce markup: `esc` for text and `attrs` for attributes,
 * with every page built from them. A missing `esc` is then visible as a missing call
 * rather than hidden in a template dialect nobody audits.
 *
 * There is no client-side JavaScript anywhere in this product, and the Content Security
 * Policy in `src/http/respond.ts` forbids it. Every page works with scripting switched
 * off, which is not asceticism: a judge's console that needs a bundle to render is a
 * console that fails on the venue's guest network, and a form that posts is a form the
 * API can accept unchanged.
 *
 * This layer sits above `src/api` and below `src/http`: it may read a command's field
 * declarations, and it may not know that a request exists. That is what keeps a page
 * from growing its own access check.
 */

import type { Control, Fields, Parsed, Problem, RawInput } from "../api/index.ts";
import { formControls, labelFor } from "../api/index.ts";
import { createHash } from "node:crypto";
import { STYLESHEET } from "./style.ts";

const STYLE_REVISION = createHash("sha256").update(STYLESHEET).digest("hex").slice(0, 16);

/**
 * Text, safe to place in markup.
 *
 * Five characters, including both quote marks. `'` matters because an attribute value
 * may be single-quoted somewhere in this codebase's future even though nothing does it
 * today, and `&#39;` costs nothing. The ampersand is replaced first, or every later
 * replacement would be escaped again.
 */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Attributes from a record, skipping anything absent. Values are escaped. */
export function attrs(values: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    // A boolean attribute is spelled by its own name: `required`, not `required="true"`.
    parts.push(value === true ? esc(name) : `${esc(name)}="${esc(value)}"`);
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

export type Breadcrumb = { readonly label: string; readonly href?: string };

export type PageOptions = {
  readonly title: string;
  /** Rendered in the header above the content, and used for the breadcrumb trail. */
  readonly trail?: readonly Breadcrumb[];
  /** The signed-in account's display name, or null for a visitor. */
  readonly whoami?: string | null;
  /** A one-line note across the top, such as "Submissions close in 40 minutes". */
  readonly notice?: string;
  /**
   * Seconds after which the browser should ask for this page again.
   *
   * A `<meta http-equiv="refresh">` rather than an EventSource, because there is no
   * client-side JavaScript in this product and the Content Security Policy forbids
   * adding any. A dashboard that reloads itself every ten seconds is live enough for an
   * organizer watching coverage fill in, works with scripting switched off, and cannot
   * leak a session into a long-lived connection through a proxy that buffers it.
   */
  readonly refresh?: number;
  readonly eyebrow?: string;
  readonly lead?: string;
  readonly layout?: "home" | "workspace";
  readonly headingArt?: string;
  readonly headingActions?: string;
  readonly body: string;
};

/**
 * One stylesheet, served from the same origin, and the only asset any page loads.
 *
 * Inline would save a request and cost the ability to cache it; a separate file costs
 * one conditional GET per visit and means a page's markup is small enough to read in
 * `view-source`. The Content Security Policy permits `self` styles and nothing else,
 * so an inline `style` attribute anywhere in this codebase would silently stop working
 * - which is the intended pressure.
 */
export const STYLESHEET_PATH = "/assets/manak.css";

/**
 * The frame every page shares: the bar, the breadcrumb, the heading, the footer.
 *
 * Three details are here rather than in each page because getting them wrong once is
 * getting them wrong forty-two times.
 *
 * The skip link is the first focusable element in the document and is off-screen until it
 * takes focus. Every page in this product puts a sticky header with a sign-out form above
 * the content, so without it a keyboard user tabs through the same three controls on every
 * navigation.
 *
 * The breadcrumb ends with the current page as a `span` carrying `aria-current="page"`,
 * repeating the `h1` - which is redundant to look at and is the reason a screen reader can
 * announce where the trail leads. It replaced a dangling `/` that pointed at nothing.
 *
 * And `main` carries the id the skip link targets plus `tabindex="-1"`, because several
 * browsers move the focus ring to a fragment target only if the target can hold focus, and
 * a skip link that scrolls without moving focus has done nothing for the person using it.
 */
export function page(options: PageOptions): string {
  const trail = options.trail ?? [];
  const heading = trail.length > 0 ? (trail[trail.length - 1] as Breadcrumb).label : options.title;
  const crumbs = trail.slice(0, -1);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${
    options.refresh === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(options.refresh))}">\n`
  }<title>${esc(options.title)}</title>
<meta name="description" content="Manak: a self-hosted workspace for hackathon submissions, fair judging and auditable results.">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="${esc(STYLESHEET_PATH)}?v=${STYLE_REVISION}">
</head>
<body class="${options.layout === "home" ? "home" : "workspace"}">
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
<a class="mark" href="/" aria-label="Manak home"><span class="brand-symbol" aria-hidden="true">m</span>manak<span class="brand-period">.</span></a>
<nav class="primary-nav" aria-label="Main navigation"><a href="/events"${options.layout === "home" ? ' aria-current="page"' : ""}>Explore events</a>${options.whoami == null ? "" : '<a href="/mine">My workspace</a>'}<a href="/guide">Evaluation guide</a><a href="/about">The method</a></nav>
<nav class="who" aria-label="Account">${
    options.whoami == null
      ? '<a href="/signin">Sign in</a>'
      : `<span>${esc(options.whoami)}</span> <form method="post" action="/signout" class="inline">` +
        '<button class="quiet" type="submit">Sign out</button></form>'
  }<details class="fast-login">
<summary class="fast-login-btn">Fast login</summary>
<div class="fast-login-menu">
<div class="fast-login-header">
<span class="role-badge">Judge evaluation mode</span>
<p>Quick sign-in for testing Sample Hack 2026 &amp; Dogfood.</p>
<a href="/guide" class="fast-login-guide-link">Platform guide &amp; sitemap &rarr;</a>
</div>
<div class="fast-login-list">
<a href="/fast-login?as=organizer" class="fast-login-item"><strong>Sign in as Organizer</strong> <span>Rosa Iyer &middot; Admin on Sample Hack &amp; Dogfood</span></a>
<a href="/fast-login?as=judge_sample" class="fast-login-item"><strong>Sign in as Judge (Sample Hack)</strong> <span>Tomas Varga &middot; Judge on Sample Hack &amp; Dogfood</span></a>
<a href="/fast-login?as=judge_a" class="fast-login-item"><strong>Sign in as Judge (Dogfood)</strong> <span>Nils Berg &middot; Judge on Dogfood &amp; Sample Hack</span></a>
<a href="/fast-login?as=participant" class="fast-login-item"><strong>Sign in as Builder</strong> <span>Beatriz Lima &middot; Participant on both events</span></a>
</div>
</div>
</details></nav>
</header>
${
    options.notice === undefined ? "" : `<p class="notice">${esc(options.notice)}</p>\n`
  }<main id="main" tabindex="-1">
${
    crumbs.length === 0
      ? ""
      : `<nav class="trail" aria-label="Breadcrumb">${[
          ...crumbs.map((crumb) =>
            crumb.href === undefined
              ? esc(crumb.label)
              : `<a href="${esc(crumb.href)}">${esc(crumb.label)}</a>`,
          ),
          `<span aria-current="page">${esc(heading)}</span>`,
        ].join(" / ")}</nav>\n`
  }<div class="page-heading${options.headingArt ? " hero-grid" : ""}"><div><p class="eyebrow">${esc(options.eyebrow ?? (crumbs.length > 0 ? "Event workspace" : "The hackathon workspace"))}</p><h1>${esc(heading)}</h1>${options.lead ? `<p class="page-lead">${esc(options.lead)}</p>` : ""}${options.headingActions ?? ""}</div>${options.headingArt ?? ""}</div>
${options.body}
</main>
<footer class="bar">
<span class="footer-brand">manak. <span>A fairer finish.</span></span>
<a class="footer-credit" href="https://nastik.me" target="_blank" rel="noopener noreferrer">Dev: <strong>Sai Ram Dash</strong></a>
<div class="footer-links">
<a href="/guide">Guide &amp; sitemap</a>
<a href="/verify">Certificate verifier</a>
<a href="/docs">API reference</a>
<a href="/api/openapi.json">OpenAPI</a>
<a href="/about">About</a>
</div>
</footer>
</body>
</html>
`;
}

/**
 * A definition list, which is what most of this product's read pages actually are.
 *
 * Values are escaped by default, and a row whose value is markup has to say so by naming its
 * own term in `raw`. Named by term rather than by index - the way `table` names a column -
 * because these lists are built by array literals with conditional rows in them, and a
 * position that shifts when a row is dropped is a position that silently starts escaping the
 * wrong cell. A term is what the author wrote and it does not move.
 *
 * The default is the safe one for a reason worth stating: the first version of this function
 * escaped unconditionally and one caller passed it `<code>` anyway, which shipped a page
 * showing a person their own address wrapped in visible angle brackets. That is the harmless
 * end of the failure; the other end is a caller who switches the default to "trust the string"
 * and hands it a project title.
 */
export function definitions(
  rows: readonly (readonly [string, string])[],
  raw: readonly string[] = [],
): string {
  if (rows.length === 0) return "";
  const items = rows
    .map(([term, value]) => `<dt>${esc(term)}</dt><dd>${raw.includes(term) ? value : esc(value)}</dd>`)
    .join("\n");
  return `<dl>\n${items}\n</dl>`;
}

/**
 * A table. Cells are escaped unless the column is declared as markup.
 *
 * The `raw` set is named per column rather than per cell, because a table where some
 * cells in a column are escaped and others are not is a table nobody can review. A
 * column of links is a column of links.
 *
 * `num` right-aligns a column and sets `font-variant-numeric: tabular-nums` on it, which
 * is what makes a column of scores comparable by eye: proportional digits put the decimal
 * points of 0.71 and 0.9 in different places, and a reader scanning for the largest number
 * is reading the width of the glyphs. Declared per column for the same reason as `raw` - a
 * column is either a quantity or it is not.
 *
 * A header prefixed `vh:` is present for a screen reader and not drawn - for a column whose
 * cells already say what they are, like a button that names its own action or a pill that
 * carries one word. The label after the prefix is still a real label, and that is the whole
 * point of the prefix: this used to be spelled as the empty string, with the primitive
 * supplying the word "Action" on the caller's behalf, which was true of the one action column
 * that existed and false of the next column somebody left blank. A hidden header that
 * announces the wrong thing is worse than a visible one that is slightly redundant, so the
 * caller says the word and the primitive only decides whether to draw it.
 *
 * A blank header is therefore refused rather than filled in. It throws, which is a 500 on a
 * page, and that is the right trade here: every header in this product is a literal in a view
 * module, `docs/proof/isolation.md` renders every operation's page as every role and treats a
 * 500 as a bug rather than a policy, so a blank one cannot reach a deployment without a red
 * test - while a `<th>` with no accessible name reaches one silently and is invisible to
 * everybody except the readers who need it most. Two survived the change that introduced this
 * refusal, on the team list and the rubric's version history, and that proof is what found
 * them; the view suite renders those pages with no rows, where a header has no `<tr>` under it
 * to make anybody look. The refusal is on the header only. An empty body cell is a real value
 * and stays legal.
 */
export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  raw: readonly number[] = [],
  num: readonly number[] = [],
): string {
  const head = headers
    .map((cell, index) => {
      const numeric = num.includes(index) ? ' class="num"' : "";
      if (cell.trim() === "" || cell.trim() === "vh:") {
        throw new Error(
          `table() was given a nameless column at index ${index}. Every column needs a label; ` +
            `prefix it "vh:" to keep the label out of the drawing.`,
        );
      }
      return cell.startsWith("vh:")
        ? `<th scope="col"${numeric}><span class="vh">${esc(cell.slice(3))}</span></th>`
        : `<th scope="col"${numeric}>${esc(cell)}</th>`;
    })
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, index) =>
              `<td${num.includes(index) ? ' class="num"' : ""}>${
                raw.includes(index) ? cell : esc(cell)
              }</td>`,
          )
          .join("")}</tr>`,
    )
    .join("\n");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

/**
 * A box that scrolls sideways, reachable by a keyboard.
 *
 * `overflow-x: auto` makes a box scrollable by a mouse wheel, a trackpad and a touch drag,
 * and by nothing else. A keyboard user cannot reach the columns past the right edge unless
 * something inside the box takes focus, and the cells in these tables are text - so on a
 * narrow window the last three columns of the diagnostics table were simply unreachable.
 * The wrapper therefore takes focus itself, and carries a name, because a focusable element
 * that announces as nothing is the same defect as the blank `th` above.
 *
 * `role="group"` rather than `role="region"`. A region is a landmark, and the dashboard
 * would publish nine of them - which turns landmark navigation, the one shortcut a reader
 * has for skipping the tables, into a walk through every table.
 *
 * The cut line is that every table gets this, including the narrow ones that will never
 * overflow at any width. CSS cannot tell whether a box is currently scrolling, so the
 * alternative is deciding table by table and being wrong about the one somebody later adds
 * a column to - and an unreachable scroll region is a worse failure than a tab stop that
 * turns out to have nothing to scroll.
 */
export function scroller(content: string, label: string): string {
  return `<div class="scroll" role="group" tabindex="0" aria-label="${esc(label)}">${content}</div>`;
}

/**
 * A proportional bar, beside the number it draws.
 *
 * The width cannot be an inline style - the Content Security Policy allows `self`
 * stylesheets and nothing else - so the stylesheet carries a ladder of `.p0` … `.p100`
 * classes in 2% steps and this snaps a fraction to the nearest rung. The snapping is
 * therefore coarser in the graphic than in the figure: `label` is printed verbatim next to
 * the bar and both callers write it to one decimal, so the text resolves twenty times finer
 * than the track and no comparison has to be made off the pixels. It is not the unrounded
 * quantity - a share of a fit's own sum has no exact decimal form worth printing - but the
 * rounding a reader sees is the caller's, stated in the caller, and not this ladder's.
 *
 * `fraction` is clamped to 0…1. A share that arrives above one is a caller bug, but a bar
 * 340% wide is a layout bug on a page an organizer is reading during an appeal, so it is
 * clamped here rather than asserted. The clamp is applied before the finiteness check
 * rather than after, so an infinite share lands at the end of the track it is past and
 * only a value that is not a number at all falls back to empty.
 */
export function meter(fraction: number, label: string, tone: "" | "good" | "bad" = ""): string {
  const clamped = Math.min(1, Math.max(0, Number(fraction)));
  const safe = Number.isFinite(clamped) ? clamped : 0;
  const step = Math.round((safe * 100) / 2) * 2;
  const classes = ["meter", tone, `p${step}`].filter((part) => part !== "").join(" ");
  return `<span class="${classes}" role="img" aria-label="${esc(label)}"><i></i></span>`;
}

/** What a control should show when a submission is being redisplayed. */
export type Prefill = Readonly<Record<string, string>>;

function controlHtml(control: Control, prefill: Prefill, problem: string | undefined, idPrefix = "f-"): string {
  // A `div` rather than a `p`, because the help text below the input is a `p` and a paragraph
  // inside a paragraph is not a thing HTML has: a browser closes the outer one at the `<p>` it
  // meets, which quietly drops the note out of the flex column it was meant to sit in. Nothing
  // looked broken enough to notice, which is why it survived until a page needed the layout.
  const id = `${idPrefix}${control.name}`;
  const described = control.help !== undefined || problem !== undefined ? `${id}-note` : undefined;
  const given = prefill[control.name];
  const shared = {
    id,
    name: control.name,
    "aria-describedby": described,
    "aria-invalid": problem === undefined ? undefined : "true",
  };
  const field = ((): string => {
    switch (control.element) {
      case "textarea":
        return `<textarea${attrs({ ...shared, ...control.attributes })}>${esc(given ?? "")}</textarea>`;
      case "select": {
        // What was submitted, else what the command would apply anyway, else nothing. The
        // middle rung matters: a select whose field declares a fallback but shows "Any"
        // tells the reader the filter is off when the server is about to switch it on, and
        // the page they are looking at was produced with it on.
        const chosen = given ?? control.chosen ?? "";
        const options = [
          `<option value=""${chosen === "" ? " selected" : ""}>${esc(control.blank ?? "")}</option>`,
          ...(control.options ?? []).map(
            (value) =>
              `<option value="${esc(value)}"${value === chosen ? " selected" : ""}>${esc(value)}</option>`,
          ),
        ].join("");
        return `<select${attrs({ ...shared, ...control.attributes })}>${options}</select>`;
      }
      default: {
        const attributes = { ...control.attributes };
        // A checkbox carries its state in `checked`; everything else in `value`. Writing
        // a submitted value into a checkbox's `value` would post the string "on" as the
        // literal text somebody typed, which is not a thing that can happen but is the
        // kind of thing that happens.
        if (control.type === "checkbox") {
          if (given !== undefined && given !== "" && given !== "false" && given !== "0") attributes.checked = "checked";
          else if (Object.hasOwn(prefill, control.name)) delete attributes.checked;
        } else if (given !== undefined) attributes.value = given;
        return `<input${attrs({ ...shared, type: control.type ?? "text", ...attributes })}>`;
      }
    }
  })();
  const note =
    described === undefined
      ? ""
      : `\n<p class="note" id="${esc(described)}">${
          problem === undefined ? esc(control.help) : `<strong>${esc(problem)}</strong>`
        }</p>`;
  return `<div class="field">\n<label for="${esc(id)}">${esc(control.label)}</label>\n${field}${note}\n</div>`;
}

export type FormOptions = {
  /**
   * How the form submits. `post` unless said otherwise, because twenty of the twenty-two
   * commands with a form are writes.
   *
   * The one caller that sets `get` is the confidence page, whose two controls choose how hard
   * to resample a ranking. That is a read with knobs on, and a read belongs in the query string
   * for reasons that are not stylistic: the resulting URL is the thing an organizer pastes into
   * a message to a co-organizer, a browser may cache it, and a reload does not warn about
   * resubmission. A `post` that rendered a page would give up all three and gain nothing.
   *
   * A `get` form ignores `hidden` values it cannot express - it cannot, in fact, since a hidden
   * input in a `get` form does end up in the query string. What it genuinely cannot carry is a
   * path parameter, and that is why `formAction` is a filled route rather than a template: the
   * event is in the path before the browser ever sees the form.
   */
  readonly method?: "post" | "get";
  /**
   * Where the form posts.
   *
   * Named `formAction` rather than `action` because `action:` is the ledger's word in this
   * codebase, and a source test scans every `action:` literal in `src/` against the dialect
   * the `audit_entry` CHECK accepts. That scan is worth keeping total - a ledger write from
   * a layer nobody thought to scan is exactly the one that fails at the insert - so the
   * word is reserved and the view layer spells the HTML attribute differently. The rendered
   * markup still says `action=`, which is what a browser reads.
   */
  readonly formAction: string;
  readonly submit: string;
  readonly fields: Fields;
  /** Values to redisplay, as text. Derived from what the caller actually sent. */
  readonly prefill?: Prefill;
  readonly problems?: readonly Problem[];
  /** Fields to render as hidden inputs rather than controls. */
  readonly hidden?: Readonly<Record<string, string>>;
  readonly legend?: string;
  readonly submitAccessKey?: string;
  readonly submitHtml?: string;
  readonly idPrefix?: string;
  readonly submitName?: string;
  readonly submitValue?: string;
  readonly secondarySubmit?: { name: string; value: string; label: string; skipValidation?: boolean };
  /**
   * One button, on the line it sits on, for a command whose whole body is hidden.
   *
   * A table row that offers "Join" and a results page that offers "Publish" are forms - the
   * only way to reach a POST without scripting - and a block-level form with a paragraph
   * around its button puts a blank line through the row it belongs to. Rendered as
   * `class="inline"` with a bare button, which is what `page` already does by hand for
   * sign-out; this is that markup, available to the pages that need it several times.
   */
  readonly inline?: boolean;
  /**
   * Markup to place inside the form, above the generated controls.
   *
   * One caller: the ballot page, which renders the rubric's criteria as one numeric input per
   * criterion and lets this function produce the comment box and the draft checkbox from the
   * declaration. The alternative was a second form - two buttons for one act - or building the
   * whole thing by hand and losing the two fields that the parser and the OpenAPI document
   * agree about. A slot is the smaller compromise, and it is deliberately not a general
   * templating hook: whatever goes in here is markup the caller has already escaped.
   */
  readonly before?: string;
};

/**
 * A form, from the same field declarations the parser and the OpenAPI document read.
 *
 * There is no CSRF token, and that needs saying out loud rather than being noticed
 * later. The session cookie is `SameSite=Lax`, which means a browser will not send it
 * on a cross-site POST at all - so a form on another origin cannot act as the signed-in
 * caller, which is the attack a token defends against. A token would add a second
 * defence and a second failure mode: it must be minted per session, stored, expired,
 * and rotated, and a portal whose forms intermittently fail with "invalid token" is a
 * portal an organizer stops trusting mid-event. `SameSite` is enforced by the browser
 * rather than by this code, which is the stronger place for it to live.
 *
 * `SameSite=Lax` does send the cookie on a cross-site `GET`, which is the exact case the
 * `method: "get"` option opens up - so it is worth being clear that this is not a hole being
 * left: every `get` command in this registry is a read, no read changes state, and the one
 * that costs real work spends from a rate-limit bucket keyed on the event rather than on the
 * caller. A stranger's page that links to somebody's confidence report achieves a page load.
 */
export function form(options: FormOptions): string {
  const problems = new Map((options.problems ?? []).map((problem) => [problem.field, problem.message]));
  const prefill = options.prefill ?? {};
  const hidden = Object.entries(options.hidden ?? {}).map(
    ([name, value]) => `<input${attrs({ type: "hidden", name, value })}>`,
  );
  const controls = formControls(options.fields)
    .filter((control) => !Object.hasOwn(options.hidden ?? {}, control.name))
    .map((control) => controlHtml(control, prefill, problems.get(control.name), options.idPrefix));
  // A problem about a field the form does not render - an unknown field, a hidden one, or
  // the scope parameter from the path - has nowhere to appear next to a control, and
  // dropping it would leave a 422 page insisting something is wrong without saying what.
  const rendered = new Set(
    formControls(options.fields)
      .map((control) => control.name)
      .filter((name) => !Object.hasOwn(options.hidden ?? {}, name)),
  );
  const summary =
    (options.problems ?? []).length === 0
      ? ""
      : `<div class="problems" role="alert" tabindex="-1" autofocus aria-label="Please correct the form">\n<p>${
          (options.problems as readonly Problem[]).length === 1
            ? "One field needs attention."
            : `${(options.problems as readonly Problem[]).length} fields need attention.`
        }</p>\n${
          `<ul>${(options.problems ?? []).map((problem) => {
            const label = `${esc(labelFor(problem.field))}: ${esc(problem.message)}`;
            return `<li>${rendered.has(problem.field) ? `<a href="#${esc(options.idPrefix ?? "f-")}${esc(problem.field)}">${label}</a>` : label}</li>`;
          }).join("")}</ul>\n`
        }</div>\n`;
  const primary = `<button${attrs({ type: "submit", name: options.submitName, value: options.submitValue, accesskey: options.submitAccessKey })}>${options.submitHtml ?? esc(options.submit)}</button>`;
  const secondary = options.secondarySubmit;
  const buttons = primary + (secondary ? ` <button${attrs({ type: "submit", class: "quiet", name: secondary.name, value: secondary.value, formnovalidate: secondary.skipValidation })}>${esc(secondary.label)}</button>` : "");
  return `${summary}<form method="${options.method ?? "post"}" action="${esc(options.formAction)}"${
    options.inline === true ? ' class="inline"' : ""
  }>
${options.legend === undefined ? "" : `<h2>${esc(options.legend)}</h2>\n`}${hidden.join("\n")}${
    hidden.length === 0 ? "" : "\n"
  }${options.before === undefined ? "" : `${options.before}\n`}${controls.join("\n")}
${
    options.inline === true
      ? buttons
      : `<p class="actions">${buttons}</p>`
  }
</form>`;
}

/**
 * The submitted values, as text a form can redisplay.
 *
 * Taken from the parsed record rather than the raw body, so what comes back is what the
 * server understood - a trimmed title, a coerced number - and a person correcting one
 * field is not silently correcting another. Secrets are already absent: the caller
 * passes them through `redact` first.
 */
export function prefillFrom(parsed: Parsed): Prefill {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (value === null) continue;
    if (typeof value === "object") out[name] = JSON.stringify(value);
    else if (typeof value === "boolean") out[name] = value ? "on" : "";
    else out[name] = String(value);
  }
  return out;
}

/**
 * The same, for the 422 path, where parsing never finished.
 *
 * An `InputError` is thrown by `parseInput` itself, so there is no parsed record to
 * redisplay - only what arrived. Taking the raw values back is the difference between a
 * judge correcting one score and a judge retyping nine, so it is worth the second
 * function rather than showing an empty form with red labels on it.
 *
 * Secret fields are dropped by name here rather than by `redact`, which works on a parsed
 * record. A password that failed a length check must not come back in the HTML.
 */
export function prefillFromRaw(fields: Fields, raw: RawInput): Prefill {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (fields[name]?.secret === true) continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      out[name] = value.map((item) => String(item)).join(", ");
      continue;
    }
    if (typeof value === "object") {
      // `scores.design=4` arrived as a nested object and the control is named for the
      // dotted key, so it goes back the way it came.
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (inner !== null && inner !== undefined) out[`${name}.${key}`] = String(inner);
      }
      continue;
    }
    out[name] = String(value);
  }
  return out;
}
