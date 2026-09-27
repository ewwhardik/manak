/**
 * The whole stylesheet, as one string.
 *
 * Served from `/assets/manak.css` rather than inlined so a browser caches it, and kept
 * in a TypeScript module rather than a `.css` file so the server has no file system
 * dependency at run time - the container ships one process and no asset directory to get
 * out of sync with the binary.
 *
 * ## The look, and why it is only CSS
 *
 * Translucent panels over a soft ambient ground, hairline borders that catch light, and
 * springy compression on anything you press. Every part of it is declarative CSS:
 * `backdrop-filter`, layered gradients, `@keyframes`, and transitions on `:hover`,
 * `:focus-within` and `:active`. There is no script, because "no client-side JavaScript"
 * is a claim this product makes about itself in five places and enforces with a
 * `default-src 'none'` Content Security Policy. A stylesheet that needed a bundle to
 * animate would quietly turn four of those sentences into marketing.
 *
 * That constraint costs less than it sounds like. What script is usually spent on here is
 * entrance staggering, which `nth-child` delays do; press feedback, which `:active` does;
 * and reveal-on-scroll, which is a pattern worth losing.
 *
 * Two limits are load-bearing and easy to forget:
 *
 * The dashboard sets `refresh: 30`, so every entrance animation on it replays twice a
 * minute for as long as an organizer leaves it open. Entrances are therefore short and
 * low-amplitude - 6px and under 400ms - because a flourish that is charming once is a
 * flicker at that cadence.
 *
 * And proportional bars cannot be inline styles, since the Content Security Policy has no
 * `style-src 'unsafe-inline'`. Widths come from a generated ladder of selectors in 2%
 * steps instead, which is finer than the eye reads off a 12rem bar and is always printed
 * beside its exact number.
 *
 * ## The rest
 *
 * A single accent colour, because a portal that colour-codes six things has six things
 * nobody can tell apart at a glance. Sizes in `rem` from one root, so a judge who has set
 * a larger default font gets a larger portal rather than a broken one. Tables that scroll
 * horizontally rather than shrink, because a diagnostics table with eight columns is
 * unreadable at phone width in every design that tries. Two palettes under
 * `prefers-color-scheme` rather than an inverted filter, because judging happens in dim
 * rooms. Everything animated is switched off under `prefers-reduced-motion`, while the
 * translucency stays - glass is not motion.
 *
 * No CSS reset. The rules below set what they need on the elements this product actually
 * uses, which is a short list, and a reset would be a hundred lines undoing behaviour
 * that is then reinstated by hand.
 */

const STEPS = 2;

/**
 * Widths for `.meter`, as a ladder of selectors rather than inline styles.
 *
 * `p0` through `p100` in 2% steps. The view layer snaps a fraction to the nearest rung
 * and prints the unsnapped number next to the bar, so the approximation lives in the
 * graphic and never in the figure.
 */
const meterSteps = (): string => {
  const rules: string[] = [];
  for (let p = 0; p <= 100; p += STEPS) rules.push(`.meter.p${p} > i { width: ${p}%; }`);
  return rules.join("\n");
};

export const STYLESHEET = `:root {
  color-scheme: light dark;
  /* Shared motion tokens; palette and surface tokens live in Arena and Frosted below. */
  --spring: cubic-bezier(0.16, 1, 0.3, 1);
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --quick: 120ms;
  --slow: 240ms;
  font-size: 100%;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--bg);
  background-image:
    radial-gradient(ellipse 80% 50% at 50% -15%, var(--ground-a), transparent),
    radial-gradient(ellipse 60% 40% at 85% 85%, var(--ground-b), transparent);
  background-attachment: fixed;
  background-repeat: no-repeat;
  color: var(--ink);
  font: 1rem/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}

code, td.num, th.num {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

kbd {
  display: inline-block;
  padding: 0.1em 0.35em;
  font-size: 0.8em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-weight: 700;
  line-height: 1;
  color: var(--ink);
  background: var(--glass-high);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--line-strong);
  margin-right: 0.25rem;
}

/* --- motion ------------------------------------------------------------ */
