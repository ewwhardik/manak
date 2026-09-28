/**
 * What this deployment is, who wrote it, and where a reader checks each claim.
 *
 * The footer of every page links here, which makes this the one page written for somebody who
 * has been handed a URL with no explanation - a judge opening a link from a submission form,
 * or an organizer deciding whether to run this at their own event. So it answers the three
 * questions in that order: what the thing does, what it is made of, and how to verify the
 * second answer without taking anybody's word for it.
 *
 * The claims table is the reason this is a page rather than a paragraph in the README. Each
 * row is a sentence this project says about itself paired with the route or file that settles
 * it, and both halves come from `system.about` rather than from here - a claim written into
 * markup is a claim the JSON caller does not get, and the one that quietly stops being true.
 * This module chooses the wording around them and nothing else.
 *
 * The attribution is read from `PRODUCT` by way of the result, so the byline on this page, the
 * one in the OpenAPI document and the one `--help` prints cannot disagree.
 */

import { definitions, esc, page, scroller, table } from "./html.ts";
import { at, link, rows } from "./pages.ts";
import type { ViewContext } from "./pages.ts";

/** A count, in words that read as a sentence rather than as a field name. */
function countOf(built: unknown, key: string, one: string, many: string): string {
  const value = at(built, key);
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * The four surfaces that answer a question on this page, linked rather than described.
 *
 * Hand-written here and not published by the command, because a link is a fact about how this
 * deployment is routed and the command layer is the one part of this codebase that is not
 * allowed to know about routing. The routes themselves are asserted in `tests/http.test.ts`.
 */
const CHECKS: readonly (readonly [string, string])[] = [
  ["/docs", "Every operation, its fields, and who may call it."],
  ["/api/capabilities", "The access matrix, computed from the same declarations that enforce it."],
  ["/api/healthz", "Migrations, and the audit chain's length and head hash."],
  ["/api/openapi.json", "The same list again, for a generated client."],
];

export function aboutPage(context: ViewContext): string {
  const product = at(context.result, "product");
  const built = at(context.result, "built");
  const title = String(at(product, "title") ?? "Manak");
  const claims = rows(context.result, "claims");
  return page({
    title: `About ${title}`,
    trail: [{ label: "About" }],
    whoami: context.whoami, demoMode: context.demoMode,
    body: `<div class="about-hero"><img src="/assets/mascot-5.png" alt="Zen engineering mascot" class="guide-mascot"></div>
<p>${esc(title)} runs a hackathon end to end: teams register, submit a project against
a deadline, judges score what they are assigned against a published rubric, and the organizer
gets a ranking that has been corrected for the fact that judges are not calibrated to each
other. One container, one port, one file on disk.</p>
<p>It is built to be self-hosted by somebody who does not want to become its administrator.
There is nothing to configure before it starts, no relay to reach, no second service to keep
alive, and no asset pipeline - a page works with scripting switched off because there is no
script anywhere in the product to switch on.</p>
${definitions(
      [
        ["Version", String(at(product, "version") ?? "-")],
        ["Written by", String(at(product, "author") ?? "-")],
        ["Source", link(at(product, "source"))],
        ["Licence", String(at(product, "license") ?? "-")],
      ],
      ["Source"],
    )}
<h2>What it is made of</h2>
${definitions([
      ["Dependencies", countOf(built, "dependencies", "package", "packages")],
      ["Operations", countOf(built, "operations", "operation", "operations")],
      ["Runtime", String(at(built, "runtime") ?? "-")],
      ["Storage", String(at(built, "storage") ?? "-")],
      [
        "Client-side script",
        at(built, "clientScript") === true ? "yes" : "none, and the policy header forbids it",
      ],
    ])}
<h2>Claims, and how to check them</h2>
<p>Each row is something this project says about itself. The right-hand column is where you
settle it without reading the source.</p>
${
      claims.length === 0
        ? '<p class="muted">This deployment published no claims.</p>'
        : scroller(table(
            ["Claim", "Where it is settled"],
            claims.map((row) => [String(row.claim ?? ""), String(row.check ?? "")]),
          ), "Claims, and where each is settled")
    }
<h2>See for yourself</h2>
<ul>${CHECKS.map(
      ([href, why]) => `<li><a href="${esc(href)}"><code>${esc(href)}</code></a> - ${esc(why)}</li>`,
    ).join("\n")}</ul>
<p class="muted">The three proof documents named in the table above are generated by scripts in
the source tree and committed alongside it, so a reviewer can re-run any one of them and compare
the output with what was shipped. Two of the three take no measurement at all, which is what lets
them be compared byte for byte rather than read for vibes.</p>`,
  });
}
