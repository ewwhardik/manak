/**
 * A refusal, as a page.
 *
 * This lives in the view layer rather than beside the `Response` builders because it is
 * HTML, and the rule this codebase holds is that every string of markup is produced in
 * one directory. The status and the machine-readable body are decided in `src/api`; this
 * file only decides what a person reads.
 *
 * Two paragraphs, in this order: advice, then detail. The advice says what to do next and
 * is written for whoever is looking at the screen. The detail is the problem document's
 * own `detail`, which is written for a client author and is often the more precise
 * sentence - "Submissions closed at 2026-09-28T18:00:00.000Z, 4123 ms ago". Showing both
 * means the organizer standing behind the judge can read the second one aloud to support
 * without translating the first.
 */

import type { ProblemDocument } from "../api/index.ts";
import { esc, page } from "./html.ts";

/**
 * What each status means to whoever is reading it, in their words.
 *
 * Keyed by status rather than by error code deliberately. There are a hundred codes and
 * they change as commands are added; there are nine statuses and they do not. A code-level
 * table would rot, and the sentence a person needs - "ask an organizer" - is the same for
 * every 403 regardless of which rule produced it.
 */
export const ADVICE: Readonly<Record<number, string>> = {
  400: "Something about the request itself could not be read. If you typed the address, check it.",
  401: "Sign in and try again.",
  403: "You are in this event, but not with the role this page needs. Ask an organizer.",
  404: "There is nothing here. If you followed a link from outside the event, it may not be yours to see.",
  405: "That address exists, but not for this kind of request.",
  409: "The request was understood and refused: a deadline, a published rubric, or a withdrawn project.",
  413: "That was larger than this deployment accepts.",
  415: "This form was submitted in a format the server does not read.",
  422: "Some of what was sent needs correcting.",
  429: "Too many requests in a short window. Wait, then try again.",
  500: "Something went wrong on the server. The operator's log has the details.",
};

export function problemPage(problem: ProblemDocument, whoami: string | null = null): string {
  const list =
    problem.problems === undefined || problem.problems.length === 0
      ? ""
      : `<div class="problems"><ul>${problem.problems
          .map((entry) => `<li><strong>${esc(entry.field)}</strong> ${esc(entry.message)}</li>`)
          .join("")}</ul></div>\n`;
  return page({
    title: `${problem.status} - ${problem.title}`,
    trail: [{ label: problem.title }],
    whoami,
    body: `<p class="advice">${esc(ADVICE[problem.status] ?? "This request was refused.")}</p>
<p class="detail">${esc(problem.detail)}</p>
${list}<p class="code">Code <code>${esc(problem.code)}</code>, status ${problem.status}.</p>
<p><a href="/">Back to the portal</a></p>`,
  });
}
