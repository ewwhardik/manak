import { esc, page } from "./html.ts";
import { at, eventTrail } from "./pages.ts";
import type { ViewContext } from "./pages.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

function projectCard(value: unknown, label: string): string {
  const row = record(value);
  const title = String(at(row, "title") ?? "Untitled");
  const url = at(row, "repoUrl");
  return `<div class="panel"><p class="eyebrow">${label}</p><h3>${esc(title)}</h3>
<p class="muted">${esc(String(at(row, "id") ?? ""))} · ${esc(String(at(row, "status") ?? ""))}</p>
${typeof url === "string" && url.startsWith("https://") ? `<p><a href="${esc(url)}" rel="noopener noreferrer">Repository ↗</a></p>` : ""}
<p class="muted">Submitted ${at(row, "submittedAt") ? esc(new Date(Number(at(row, "submittedAt"))).toISOString()) : "—"}</p></div>`;
}

export function duplicatesPage(context: ViewContext): string {
  const slug = context.event?.slug ?? String(context.input.event ?? "");
  const cases = at(context.result, "cases");
  const rows = Array.isArray(cases) ? cases : [];
  const content = rows.length === 0 ? `<p>No project collisions need review.</p>` : rows.map((item) => {
    const row = record(item);
    const project = record(at(row, "project"));
    const id = String(at(project, "id") ?? "");
    const decision = String(at(row, "decision") ?? "pending");
    const reason = String(at(row, "reason") ?? "title");
    const action = `/events/${encodeURIComponent(slug)}/manage/duplicates/triage`;
    const button = (choice: "cleared" | "confirmed", title: string, explanation: string) =>
      `<form method="post" action="${action}"><input type="hidden" name="project" value="${esc(id)}">
<input type="hidden" name="decision" value="${choice}"><input type="hidden" name="reason" value="${esc(explanation)}">
<button type="submit">${title}</button></form>`;
    return `<section class="panel"><h2>${esc(String(at(project, "title") ?? "Untitled"))}</h2>
<p>Matched by ${esc(reason)} · Decision: <strong>${esc(decision)}</strong></p>
<div class="explainer-grid">${projectCard(at(row, "prior"), "Earlier submission")}${projectCard(project, "Flagged submission")}</div>
<div class="actions">${button("confirmed", "Confirm duplicate", "Organizer confirmed this project duplicates the earlier submission.")}
${button("cleared", "Approve distinct", "Organizer reviewed the collision and confirmed this is distinct work.")}</div></section>`;
  }).join("\n");
  return page({ title: `Duplicate review — ${context.event?.name ?? slug}`,
    whoami: context.whoami, demoMode: context.demoMode,
    trail: eventTrail(context, { label: "Duplicate review" }),
    body: `<header><p class="eyebrow">Organizer triage</p><h1>Duplicate submissions</h1>
<p>New title or repository collisions stay out of the public gallery, voting and judge queue until approved. Each decision is written to the audit ledger.</p></header>${content}` });
}
