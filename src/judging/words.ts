/**
 * The English the engine writes.
 *
 * Every diagnostic this engine produces is read by a person — an organizer deciding whether a
 * ranking is publishable, or a participant reading the caveat attached to their place. Those
 * sentences went out for a while reading "3 project(s) have a single ballot", which is the
 * shape of a message written by somebody who did not want to think about the count. It is also
 * the shape a reader recognises: it says the sentence was assembled, and a caveat that looks
 * assembled is a caveat that gets skimmed.
 *
 * So the plural rule lives in one place. Not because pluralising is hard, but because there
 * were eighteen sites doing it badly and a nineteenth would have copied the neighbour.
 *
 * This module deliberately knows nothing about judging. It is the only file in the engine that
 * exists for the prose rather than for the arithmetic, and it holds no state, so a diagnostic
 * is still a pure function of its inputs.
 */

/**
 * A count and its noun, agreeing.
 *
 * `plural(1, "project")` is "1 project"; `plural(3, "project")` is "3 projects". An irregular
 * noun passes its own plural — `plural(2, "analysis", "analyses")` — and the caller is the only
 * place that knows the noun, so the alternative (a table of irregulars in here) would be a
 * dictionary maintained for the three words this product uses.
 *
 * Zero takes the plural, which is what English does: "0 projects have a single ballot". Most
 * callers guard on a non-empty list before they say anything, so zero rarely reaches here, but
 * a diagnostic that reads "0 projects" is at least grammatical, where one reading "0 project"
 * looks like a bug in the count.
 */
export function plural(count: number, singular: string, many?: string): string {
  return `${count} ${count === 1 ? singular : (many ?? `${singular}s`)}`;
}

/**
 * The word that agrees with a count printed somewhere else in the sentence.
 *
 * `agree(n, "has", "have")`, `agree(n, "it is", "they are")`, `agree(n, "place", "places")`. It is
 * the same choice `plural` makes, exposed for the clauses `plural` cannot reach: the verb, the
 * pronoun, and the noun whose number was printed two clauses earlier.
 *
 * Both arms are written out rather than derived, because the arms are usually irregular — the
 * ones that matter here are verbs, and English verbs do not take an `s` on the plural.
 */
export function agree(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * A list of names, cut to a length a sentence can carry, saying how many it cut.
 *
 * Two failures this replaces, both of which were in the engine. One is the sentence that names
 * every member of a list, which on a field of two hundred projects produces a warning several
 * screens long that no interface has anywhere to put. The other is worse: the sentence that
 * silently prints the first eight, so a reader who counts the names and compares them against
 * the number at the front of the sentence finds the sentence lying to them.
 *
 * Six is the cut. It fits a line at a readable width, it is enough to see a pattern in which
 * projects are involved, and where the list is longer the count at the front of the sentence is
 * the actual finding anyway — "9 projects appear in no comparison" is the thing to act on, and
 * which nine is a question for the table.
 *
 * The overflow is spelled, never elided. "and 3 more" is a promise that the names shown are a
 * sample; nothing after this returns a list a reader can mistake for the whole of it.
 */
export function names(items: readonly string[], most = 6): string {
  if (items.length <= most) return items.join(", ");
  return `${items.slice(0, most).join(", ")} and ${plural(items.length - most, "more", "more")}`;
}

/**
 * A share of one as a percentage, to one decimal.
 *
 * Here rather than in each caller because the engine quotes shares in a dozen sentences and
 * they were drifting between one and two decimals — and a threshold quoted to two decimals
 * beside a measurement quoted to one reads as though the threshold were the more precise of
 * the two, when both are the same estimate off the same resample.
 */
export function share(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
