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

@keyframes rise {
  from { opacity: 0; transform: translate3d(0, 6px, 0); }
  to { opacity: 1; transform: none; }
}

@keyframes settle {
  from { opacity: 0; transform: translate3d(0, -4px, 0); }
  to { opacity: 1; transform: none; }
}

/*
 * A narrow band that crosses a button once, and stops. It ends where it started - off the
 * left edge - so the resting state is the same declaration as the last frame and nothing
 * needs \`forwards\` to hold it there.
 */
@keyframes sheen {
  from { transform: translate3d(-150%, 0, 0) skewX(-18deg); }
  to { transform: translate3d(260%, 0, 0) skewX(-18deg); }
}

/* --- frame ------------------------------------------------------------- */

/*
 * The skip link is the first focusable thing on every page and invisible until it is
 * focused, which is the one time it is useful.
 */
.skip {
  position: fixed;
  top: 0.5rem;
  left: 0.5rem;
  z-index: 200;
  padding: 0.5rem 0.9rem;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-ink);
  text-decoration: none;
  transform: translateY(-160%);
  transition: transform var(--slow) var(--spring);
}

.skip:focus { transform: none; }

.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: center;
  padding: 0.7rem var(--pad);
  background: var(--glass);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border-bottom: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--shine);
}

header.bar {
  position: sticky;
  top: 1rem;
  z-index: 100;
}

footer.bar {
  border-bottom: 0;
  border-top: 1px solid var(--line);
  margin-top: 3rem;
  font-size: 0.9rem;
  color: var(--muted);
}

.mark {
  font-weight: 650;
  letter-spacing: -0.01em;
  text-decoration: none;
  color: var(--ink);
  transition: transform var(--quick) var(--spring);
}

.mark:hover { transform: scale(1.03); }
.mark:active { transform: scale(0.98); }

.bar .who { margin-left: auto; display: flex; gap: 0.75rem; align-items: center; }
.bar .who span { color: var(--muted); }

main {
  max-width: 62rem;
  margin: 0 auto;
  padding: 1.5rem var(--pad) 0;
}

h1 {
  font-size: 1.6rem;
  line-height: 1.2;
  margin: 0 0 1rem;
  letter-spacing: -0.015em;
  animation: rise var(--slow) var(--ease) both;
}

h2 { font-size: 1.15rem; margin: 2rem 0 0.6rem; letter-spacing: -0.01em; }
h3 { font-size: 1rem; margin: 1.5rem 0 0.4rem; }

a { color: #5EC8D8; text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { color: #E8A548; text-decoration-thickness: 2px; }

.trail { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.35rem; }
.trail a { color: var(--muted); }
.trail [aria-current="page"] { color: var(--ink); }

.notice {
  margin: 0.85rem auto 1.25rem;
  padding: 0.75rem var(--pad);
  background: linear-gradient(135deg, rgba(232, 165, 72, 0.16), rgba(94, 200, 216, 0.10));
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line-strong);
  border-left: 3px solid #5EC8D8;
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 0.92rem;
  font-weight: 500;
  box-shadow: 0 4px 15px -3px rgba(232, 165, 72, 0.2);
  animation: settle var(--slow) var(--ease) both;
}

/* --- content ----------------------------------------------------------- */

dl {
  display: grid;
  grid-template-columns: minmax(8rem, 14rem) 1fr;
  gap: 0.6rem 1.25rem;
  margin: 1.25rem 0;
  padding: 1.25rem;
  background: var(--glass);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow), inset 0 1px 0 var(--shine);
}
dt { color: var(--muted); font-size: 0.9rem; font-weight: 500; }
dd { margin: 0; color: var(--ink); font-weight: 500; }

/*
 * The bubble.
 *
 * Translucent fill, hairline edge, a highlight along the top from the inset shadow, and a
 * specular gradient in the \`::before\` that fades up on hover. Lifting by 2px with the
 * spring is what makes it read as a physical thing rather than a rectangle that changed
 * colour.
 */
.panel {
  position: relative;
  isolation: isolate;
  background: var(--glass);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--pad);
  margin: 1rem 0;
  box-shadow: var(--shadow), inset 0 1px 0 var(--shine);
  animation: rise var(--slow) var(--ease) both;
  transition: transform var(--slow) var(--spring), box-shadow var(--slow) var(--ease);
}

.panel::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: linear-gradient(150deg, var(--shine), transparent 42%);
  opacity: 0;
  transition: opacity var(--slow) var(--ease);
}

.panel:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lift), inset 0 1px 0 var(--shine);
}

.panel:hover::before { opacity: 1; }

/*
 * Staggered entrance, seven rungs deep.
 *
 * Seven because that is the widest row this product renders - the dashboard's stat grid - and
 * the ladder has to reach the last cell or the one it misses arrives with no delay and lands
 * out of order. The delay is on the cells rather than on the panel: \`.grid\` sits on the same
 * element as \`.panel\`, which rises as one block, and what staggers is the figures inside it.
 * That is why \`.stat\` carries an \`animation\` of its own. It needs one - a bare
 * \`animation-delay\` on an element with nothing to delay is dead CSS, which is what these five
 * rungs were until a test went looking, and \`tests/view.test.ts\` now counts them against the
 * widest \`stats()\` call in the layer.
 *
 * The rung is 40ms against \`--quick\` rather than \`--slow\`, which puts the last cell's finish
 * at 240 + 140 = 380ms. The dashboard sets \`refresh: 30\`, so this replays twice a minute in
 * front of somebody who is working; it has to be over before it is noticed.
 */
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
.grid > :nth-child(2) { animation-delay: 40ms; }
.grid > :nth-child(3) { animation-delay: 80ms; }
.grid > :nth-child(4) { animation-delay: 120ms; }
.grid > :nth-child(5) { animation-delay: 160ms; }
.grid > :nth-child(6) { animation-delay: 200ms; }
.grid > :nth-child(7) { animation-delay: 240ms; }

.stat {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  animation: rise var(--quick) var(--ease) both;
}
.stat b { font-size: 1.5rem; font-weight: 620; letter-spacing: -0.02em; }
.stat span { color: var(--muted); font-size: 0.85rem; }

/* --- tables ------------------------------------------------------------ */

.scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--glass-low);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  box-shadow: inset 0 1px 0 var(--shine);
  animation: rise var(--slow) var(--ease) both;
}

table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.94rem; }
.scroll table { margin: 0; }
th, td { text-align: left; padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--line); }
tbody tr:last-child td { border-bottom: 0; }

th {
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  font-weight: 600;
  background: var(--glass-low);
}

tbody tr { transition: background var(--quick) var(--ease); }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

.muted { color: var(--muted); }
.advice { font-size: 1.05rem; }
.detail, .code { color: var(--muted); }

/*
 * Inline code, tinted just enough to read as a literal rather than as emphasis.
 *
 * There is no \`pre\` rule above this one and no \`:not(pre)\` guard on it, because nothing in
 * this layer emits a \`pre\`: \`markdownish\` renders four constructs and a fenced block is not
 * one of them. A styled block for markup no page produces is the same defect as a keyframe
 * nobody plays, and both are now checked rather than remembered.
 */
code {
  padding: 0.05rem 0.3rem;
  border-radius: 5px;
  background: var(--glass-low);
  border: 1px solid var(--line);
}

/*
 * A disclosure. The triangle is the browser's; the surface is this product's.
 *
 * Every one of these hides a write - "Write a new version", "Enter a project" - which is
 * why the summary gets the button's spring compression when pressed: a control that
 * responds to a press is a control a person believes registered.
 */
details {
  background: var(--glass-low);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0.6rem var(--pad);
  margin: 1rem 0;
  box-shadow: inset 0 1px 0 var(--shine);
  transition: border-color var(--slow) var(--ease), box-shadow var(--slow) var(--ease);
}

details[open] { box-shadow: var(--shadow), inset 0 1px 0 var(--shine); }
details:hover { border-color: var(--line-strong); }

summary {
  cursor: pointer;
  font-weight: 550;
  border-radius: var(--radius-sm);
  transition: transform var(--slow) var(--spring), color var(--quick) var(--ease);
}

summary:hover { color: var(--accent); }
summary:active { transform: scale(0.99); transition-duration: var(--quick); }
details[open] > summary { margin-bottom: 0.6rem; }

/* --- comparisons and meters -------------------------------------------- */

/*
 * A pairwise comparison: two projects side by side, one form each.
 *
 * Two columns that collapse to one under 40rem rather than a table, because the two sides
 * are alternatives rather than rows of a list, and a judge choosing between them on a
 * phone should not be reading across a scroll.
 */
.pair {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  margin: 1rem 0;
}

.pair > * {
  margin: 0;
  background: var(--glass);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--pad);
  box-shadow: var(--shadow), inset 0 1px 0 var(--shine);
  animation: rise var(--slow) var(--ease) both;
  transition: transform var(--slow) var(--spring), box-shadow var(--slow) var(--ease), border-color var(--slow) var(--ease);
}

.pair > :nth-child(2) { animation-delay: 60ms; }

.pair > :hover, .pair > :focus-within {
  transform: translateY(-2px);
  border-color: var(--line-strong);
  box-shadow: var(--shadow-lift), inset 0 1px 0 var(--shine);
}

/* One numeric input per criterion, laid out so the labels line up. */
.scores {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  margin: 0 0 1rem;
}

.scores .field { margin: 0; max-width: none; }

/*
 * A proportional bar. The \`i\` is the fill; the width comes from the ladder below.
 *
 * \`i\` rather than a \`span\` for no reason except that it is the shortest element name
 * that carries no semantics, and this is decoration with a number printed beside it.
 */
.meter {
  display: block;
  overflow: hidden;
  height: 0.5rem;
  margin: 0.3rem 0;
  border-radius: 999px;
  background: var(--glass-low);
  border: 1px solid var(--line);
}

.meter > i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #E8A548, #5EC8D8);
  transition: width var(--slow) var(--ease);
}

.meter.good > i { background: linear-gradient(90deg, color-mix(in srgb, #5EC8D8 70%, transparent), #5EC8D8); }
.meter.bad > i { background: linear-gradient(90deg, color-mix(in srgb, var(--bad) 70%, transparent), var(--bad)); }

${meterSteps()}

/* --- forms ------------------------------------------------------------- */

form { margin: 1rem 0; }
form.inline { display: inline; margin: 0; }

.field { display: flex; flex-direction: column; gap: 0.25rem; margin: 0 0 0.9rem; max-width: 34rem; }
.field label { font-size: 0.9rem; font-weight: 550; }
.field .note { margin: 0; font-size: 0.83rem; color: var(--muted); }
.field .note strong { color: var(--bad); font-weight: 600; }

input, textarea, select, button {
  font: inherit;
  color: inherit;
}

input, textarea, select {
  padding: 0.5rem 0.6rem;
  background: var(--glass-high);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  width: 100%;
  transition: border-color var(--quick) var(--ease), box-shadow var(--slow) var(--ease), background var(--quick) var(--ease);
}

input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }

input:focus, textarea:focus, select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}

input[type="checkbox"] { width: auto; }
textarea { min-height: 7rem; resize: vertical; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[aria-invalid="true"] { border-color: var(--bad); }

/*
 * The press.
 *
 * A button lifts 1px on hover and compresses to 0.97 when held. The compression uses the
 * plain ease and the release uses the spring, so it goes down flat and comes back with
 * the overshoot - which is the whole trick, and it is one line either way.
 */
button {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  padding: 0.5rem 1.05rem;
  background: var(--accent);
  color: var(--accent-ink);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-weight: 550;
  box-shadow: var(--shadow);
  transition: transform var(--slow) var(--spring), box-shadow var(--slow) var(--ease), filter var(--quick) var(--ease);
}

button::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: linear-gradient(180deg, var(--shine), transparent 55%);
  opacity: 0.5;
  transition: opacity var(--slow) var(--ease);
}

/*
 * The travelling highlight. Parked off the left edge, so it is invisible until a hover
 * plays it, and it plays once rather than looping - the shine a physical surface catches
 * as it passes under a light, not an animation asking to be looked at. \`overflow: hidden\`
 * on the button is what clips it to the rounded corners, and \`z-index: -1\` keeps it under
 * the label rather than washing over it.
 */
button::after {
  content: "";
  position: absolute;
  z-index: -1;
  top: 0;
  bottom: 0;
  left: 0;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--shine), transparent);
  transform: translate3d(-150%, 0, 0) skewX(-18deg);
}

button:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
  box-shadow: var(--shadow-lift);
}

button:hover::before { opacity: 0.85; }

button:hover::after { animation: sheen 640ms var(--ease); }

button:active {
  transform: scale(0.97);
  box-shadow: var(--shadow);
  transition-duration: var(--quick);
  transition-timing-function: var(--ease);
}

button.quiet {
  background: var(--glass-high);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  color: var(--accent);
  border-color: var(--line);
}

.actions { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }

.problems {
  border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
  border-left: 3px solid var(--bad);
  background: color-mix(in srgb, var(--bad) 9%, var(--glass));
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  padding: 0.6rem var(--pad);
  border-radius: var(--radius-sm);
  margin: 1rem 0;
  box-shadow: var(--shadow);
  animation: rise var(--slow) var(--spring) both;
}

.problems p { margin: 0 0 0.3rem; font-weight: 550; }
.problems ul { margin: 0; padding-left: 1.1rem; }

/* --- badges and utilities ---------------------------------------------- */

.tag {
  display: inline-block;
  padding: 0.08rem 0.5rem;
  background: var(--glass-high);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.78rem;
  color: var(--muted);
  box-shadow: inset 0 1px 0 var(--shine);
  transition: transform var(--quick) var(--spring);
}

.tag:hover { transform: scale(1.06); }

.tag.open { border-color: color-mix(in srgb, var(--good) 55%, transparent); color: var(--good); }
.tag.shut { border-color: color-mix(in srgb, var(--bad) 55%, transparent); color: var(--bad); }

/*
 * Available to a screen reader and to nobody else.
 *
 * Used for the header of an action column, where the visible cell is a button whose own
 * words say what it does and a repeated word above it is noise in every reading but the
 * one that announces the column before the cell.
 */
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* --- environment ------------------------------------------------------- */

@media (max-width: 40rem) {
  dl { grid-template-columns: 1fr; gap: 0.1rem 0; }
  dt { margin-top: 0.5rem; }
  h1 { font-size: 1.35rem; }
  header.bar { position: static; }
}

/* Arena design system. Local artwork; no font or animation network dependency. */
:root {
  --bg: #f5f5ef; --ink: #20231e; --muted: #60655a;
  --accent: #405a12; --accent-ink: #fff; --good: #405a12; --bad: #a13731;
  --glass: #fffefa; --glass-high: #fffefa; --glass-low: #eeefe8;
  --line: #d9ded3; --line-strong: #839782; --shine: transparent;
  --ground-a: transparent; --ground-b: transparent;
  --shadow: 0 2px 4px #253b2510; --shadow-lift: 0 12px 28px #253b2512;
  --blur: none; --radius: 12px; --radius-sm: 6px; --pad: 1.5rem;
}
body { min-height: 100dvh; font-family: "Segoe UI Variable Text", "Segoe UI", sans-serif; background-image: none; }
body, input, button { font-variant-numeric: tabular-nums; }
html { scroll-behavior: smooth; scroll-padding-top: 6rem; }
main { max-width: 82rem; padding: 3.5rem 3rem 1rem; }
header.bar { padding: 1.1rem max(2rem, calc((100vw - 76rem) / 2)); gap: 3.5rem; background: var(--bg); box-shadow: none; }
.mark { display: inline-flex; align-items: center; font-size: 1.65rem; font-weight: 750; letter-spacing: -.07em; }
.brand-period { color: var(--accent); }
.brand-symbol { display: grid; place-items: center; width: 2rem; height: 2rem; margin-right: .65rem; border-radius: 7px; color: var(--accent-ink); background: var(--accent); font: italic 1.8rem/.8 Georgia, serif; letter-spacing: -.15em; padding-right: .2em; }
.primary-nav { display: flex; align-items: center; gap: 1.8rem; font-size: .85rem; }
.primary-nav a { text-decoration: none; color: var(--muted); padding: .6rem 0; }
.primary-nav a:hover, .primary-nav a[aria-current] { color: var(--ink); }
.primary-nav a[aria-current] { box-shadow: 0 2px var(--accent); }
.who { font-size: .85rem; }
.who > a { padding: .55rem 1.2rem; border: 1px solid var(--line-strong); border-radius: 6px; text-decoration: none; }
.page-heading { margin: 1.3rem 0 2rem; }
.eyebrow { color: var(--accent); text-transform: uppercase; font-size: .68rem; letter-spacing: .16em; font-weight: 700; margin: 0 0 1rem; }
h1 { font-size: clamp(2rem, 4vw, 3.4rem); line-height: 1.12; letter-spacing: -.045em; font-weight: 600; text-wrap: balance; }
h2 { font-size: 1.55rem; font-weight: 600; letter-spacing: -.04em; margin-top: 2.5rem; }
h3 { font-weight: 600; font-size: 1.1rem; }
p { max-width: 72ch; text-wrap: pretty; }
.page-lead { font-size: 1.05rem; color: var(--muted); line-height: 1.8; max-width: 43rem; }
.home .page-heading { padding: .5rem 0 0; margin-bottom: 1.5rem; max-width: none; }
.home h1 { font-family: "Segoe UI Variable Display", "Arial", sans-serif; font-size: clamp(3.4rem, 5.8vw, 5.6rem); line-height: 1.02; letter-spacing: -.065em; font-weight: 750; max-width: 10ch; }
.home .page-lead { max-width: 36rem; }
.hero-actions { display: flex; gap: 2rem; align-items: center; flex-wrap: wrap; margin-bottom: 3.8rem; }
a.button, button { border-radius: 6px; box-shadow: none; min-height: 44px; font-size: .88rem; font-weight: 600; background: var(--accent); }
a.button { display: inline-flex; align-items: center; gap: 2.2rem; padding: .85rem 1.3rem; color: var(--accent-ink); text-decoration: none; }
a.button:hover, button:hover { box-shadow: var(--shadow-lift); filter: brightness(1.08); }
button::before { display: none; }
.text-link { font-size: .88rem; font-weight: 600; text-decoration: none; }
.text-link span { margin-left: 1rem; }
.principles { display: flex; flex-wrap: wrap; gap: 1.25rem 3rem; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 1.25rem 0; font-size: .79rem; color: var(--muted); }
.principles b { color: var(--accent); margin-right: .65rem; font-family: ui-monospace, monospace; font-size: .7rem; }
.section-heading { display: flex; gap: 1rem; justify-content: space-between; align-items: end; margin: 3rem 0 1.35rem; }
.section-heading h2 { margin: 0; }
.section-heading .eyebrow { margin-bottom: .6rem; }
.section-heading > a { font-size: .85rem; text-decoration: none; white-space: nowrap; }
.count-label { margin-left: .65rem; font: .8rem ui-monospace, monospace; vertical-align: middle; color: var(--muted); }
.event-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%, 23rem),1fr)); gap: 1.4rem; }
.event-card { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); background: var(--glass); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; min-height: 19rem; }
.event-art { min-height: 18rem; background: #dce3ce; color: #325b43; position: relative; display: grid; place-items: center; overflow: hidden; }
.art-glyph { font: italic clamp(7rem, 15vw, 13rem)/1 Georgia, serif; z-index: 1; transform: rotate(-8deg); }
.art-orbit { position: absolute; width: 80%; aspect-ratio: 1; border: 1px solid #64826655; border-radius: 50%; transform: rotate(-25deg) scaleX(.66); }
.art-orbit::before, .art-orbit::after { content: ""; position: absolute; inset: -20%; border: 1px solid #64826644; border-radius: 50%; }
.art-orbit::after { inset: -45%; }
.art-caption { position: absolute; left: 1.5rem; bottom: 1.4rem; font: .55rem ui-monospace, monospace; letter-spacing: .14em; }
.art-1 { background: #e8d9c8; color: #77563a; }
.art-2 { background: #d9e0e7; color: #465c70; }
.event-card-body { padding: 2rem; display: flex; flex-direction: column; }
.card-meta { display: flex; justify-content: space-between; align-items: center; gap: .5rem; font-size: .68rem; color: var(--muted); }
.event-card h3 { font-size: 1.65rem; line-height: 1.25; letter-spacing: -.04em; margin: 1.6rem 0 .6rem; }
.event-card h3 a { color: var(--ink); text-decoration: none; }
.event-card h3 a::after { content: ""; }
.event-card p { color: var(--muted); font-size: .85rem; line-height: 1.7; margin-top: 0; }
.card-bottom { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: auto; padding-top: 1.7rem; font-size: .8rem; }
.card-bottom a { font-weight: 600; text-decoration: none; }
.method-strip { display: grid; grid-template-columns: 1fr 1fr; gap: 3rem; border-top: 1px solid var(--line); padding: 3rem 0; margin-top: 3rem; }
.method-strip h2 { font-family: Georgia, serif; font-weight: 400; font-size: 2.4rem; line-height: 1.2; margin: 0; }
.method-strip p:not(.eyebrow) { color: var(--muted); font-size: .95rem; line-height: 1.8; }
.workspace-nav { display: flex; gap: .5rem; flex-wrap: wrap; padding-bottom: 1.2rem; margin: 1rem 0; border-bottom: 1px solid var(--line); }
.workspace-nav a { padding: .65rem 1rem; background: var(--glass); border: 1px solid var(--line); border-radius: 6px; text-decoration: none; font-size: .8rem; }
.workspace-nav a:hover { background: var(--glass-low); border-color: var(--line-strong); }
.notice { max-width: 76rem; background: var(--glass-low); border: 0; border-left: 3px solid var(--accent); border-radius: 0; box-shadow: none; font-size: .8rem; margin: 1rem auto 0; padding: .75rem 1rem; }
.trail { margin-bottom: 1.5rem; font-size: .78rem; }
.panel, dl, .pair > * { box-shadow: none; }
.panel::before { display: none; }
.panel:hover, .pair > :hover, .pair > :focus-within { transform: none; box-shadow: none; }
.grid.panel { padding: 0; overflow: hidden; gap: 0; grid-template-columns: repeat(auto-fit, minmax(9rem,1fr)); }
.stat { padding: 1.45rem; border-right: 1px solid var(--line); gap: .6rem; }
.stat b { font-size: 2.1rem; font-weight: 500; }
.stat span { font-size: .73rem; }
th, td { padding: .95rem 1rem; }
th { font-size: .68rem; letter-spacing: .07em; }
td { font-size: .83rem; }
.scroll { background: var(--glass); }
details { background: var(--glass); padding: 1.15rem 1.4rem; }
summary { font-size: .95rem; }
details[open] > summary { padding-bottom: 1rem; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
dl { padding: 1.5rem; grid-template-columns: minmax(8rem, 13rem) minmax(0,1fr); }
dd { overflow-wrap: anywhere; font-size: .9rem; }
.scores { grid-template-columns: 1fr; gap: 0; }
.score-field { border: 0; border-bottom: 1px solid var(--line); padding: 1.2rem 0; margin: 0; min-width: 0; }
.score-field legend { font-weight: 600; font-size: .9rem; padding-top: 1rem; }
.score-options { display: flex; flex-wrap: wrap; gap: .5rem; }
.score-choice { position: relative; cursor: pointer; }
.score-choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.score-choice span { display: grid; place-items: center; min-width: 2.75rem; min-height: 2.75rem; border: 1px solid var(--line-strong); border-radius: 6px; color: var(--muted); }
.score-choice input:checked + span { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.score-choice input:focus-visible + span { outline: 3px solid var(--accent); outline-offset: 3px; }
.score-choice:hover span { border-color: var(--accent); }
.score-anchors { display: flex; justify-content: space-between; max-width: 22rem; font-size: .72rem; color: var(--muted); margin-top: .5rem; }
.filter-bar { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; padding: 1.3rem; border: 1px solid var(--line); background: var(--glass); border-radius: var(--radius); }
.filter-bar .field { margin: 0; flex: 1; min-width: 9rem; }
.filter-bar .field:first-child { flex: 2; }
.track-pills { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: 1rem 0; }
.track-pill-label { font-size: .8rem; color: var(--muted); font-weight: 600; margin-right: .25rem; }
.track-pill { font-size: .78rem; padding: .35rem .85rem; border-radius: 999px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; background: var(--glass); transition: border-color var(--quick) var(--ease), background var(--quick) var(--ease); }
.track-pill:hover { border-color: var(--accent); color: var(--accent); }
.track-pill-active { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.track-pill-active:hover { background: var(--accent); color: var(--accent-ink); }
.project-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,20rem),1fr)); gap: 1.25rem; }
.project-card { background: var(--glass); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; }
.project-cover { padding: 2rem; min-height: 9rem; display: flex; align-items: center; justify-content: space-between; background: var(--glass-low); color: var(--accent); }
.project-monogram { font: italic 3.5rem/1 Georgia,serif; letter-spacing: -.07em; }
.project-cover .detail { font: .65rem ui-monospace,monospace; }
.project-card-body { padding: 1.5rem; display: flex; flex-direction: column; flex: 1; }
.project-card h3 { margin: .6rem 0; font-size: 1.25rem; }
.project-card h3 a { color: var(--ink); text-decoration: none; }
.project-card p { color: var(--muted); font-size: .85rem; line-height: 1.7; }
.empty-state { padding: 3rem; border: 1px dashed var(--line-strong); border-radius: var(--radius); text-align: center; }
.empty-state p { margin-inline: auto; }
.briefing { background: var(--glass-low); border: 1px solid var(--line); padding: 1.8rem; border-radius: var(--radius); margin: 1.5rem 0; }
.briefing h2 { margin-top: 0; }
.briefing ul { padding-left: 1.25rem; }
.briefing li { margin: .7rem 0; font-size: .9rem; }
.coverage-alert { display: flex; align-items: center; gap: 1rem; padding: 1.1rem 1.4rem; margin-bottom: 1.5rem; background: radial-gradient(ellipse at right top, #ffad6620, transparent 65%), var(--glass-high); border: 1px solid #e8a548; border-radius: var(--radius); color: var(--ink); }
.alert-icon { font-size: 1.4rem; color: #e8a548; line-height: 1; flex-shrink: 0; }
.section-index { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: .8rem; padding: 1rem 0; }
.section-index a { text-decoration: none; }
.export-links { display: flex; gap: .6rem; flex-wrap: wrap; }
.export-links a { font-size: .78rem; padding: .6rem .8rem; border: 1px solid var(--line); border-radius: 5px; text-decoration: none; }
footer.bar { max-width: 76rem; margin: 3rem auto 0; padding: 1.6rem 0; background: transparent; font-size: .72rem; display: flex; align-items: center; justify-content: space-between; }
.footer-brand { font-weight: 700; font-size: .95rem; flex: 1; }
.footer-brand span { font-size: .72rem; color: var(--muted); font-weight: 400; margin-left: 1rem; }
.footer-credit { display: inline-flex; align-items: center; gap: .4rem; padding: .3rem .85rem; font-size: .72rem; color: var(--ink); background: var(--glass); border: 1px solid var(--line-strong); border-radius: 999px; text-decoration: none; box-shadow: var(--shadow); transition: transform var(--quick) var(--spring), border-color var(--quick) var(--ease), color var(--quick) var(--ease), box-shadow var(--quick) var(--ease); }
.footer-credit:hover { transform: translateY(-1px); border-color: var(--accent); color: var(--accent); box-shadow: var(--shadow-lift); }
.footer-links { display: flex; align-items: center; gap: 1.25rem; flex: 1; justify-content: flex-end; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #141714; --ink: #f0f2e8; --muted: #b0b6a8; --accent: #c4e886; --accent-ink: #202813; --good: #c4e886; --bad: #ffada3; --glass: #1d221d; --glass-high: #252c23; --glass-low: #252c23; --line: #374032; --line-strong: #78856a; }
}

@media (max-width: 65rem) { header.bar { gap: 1.5rem; padding-inline: 1.5rem; } main { padding-inline: 1.5rem; } .notice, footer.bar { margin-inline: 1.5rem; } .event-card { grid-template-columns: 1fr; } .event-art { min-height: 12rem; } .art-glyph { font-size: 9rem; } }
@media (max-width: 42rem) { header.bar { position: relative; gap: 1rem; } .primary-nav { order: 3; width: 100%; gap: 1.5rem; font-size: .78rem; } .bar .who { margin-left: auto; } .bar .who span { max-width: 8rem; overflow-wrap: anywhere; } main { padding: 2rem 1.1rem 1rem; } .home .page-heading { padding-top: .25rem; } .home h1 { font-size: 3.6rem; } .hero-actions { gap: 1.3rem; margin-bottom: 2.5rem; } .principles { gap: .8rem; flex-direction: column; } .method-strip { grid-template-columns: 1fr; gap: 1rem; } .section-heading { align-items: start; } .section-heading h2 { font-size: 1.4rem; } .event-card-body { padding: 1.5rem; } .grid.panel { grid-template-columns: repeat(2,minmax(0,1fr)); } .stat { padding: 1rem; } .workspace-nav a { flex: 1 0 auto; text-align: center; } .pair { grid-template-columns: minmax(0,1fr); } .filter-bar button { width: 100%; } .notice, footer.bar { margin-inline: 1.1rem; } footer.bar { gap: 1rem; } .footer-brand { width: 100%; } }
.evidence-lab { margin: 3rem 0; padding: 1.8rem; border: 1px solid var(--line-strong); border-radius: 16px; background: radial-gradient(ellipse at right top, #a4cf5b12, transparent 60%), var(--glass); }
.evidence-lab .section-heading { margin-top: 0; }
.lab-preview { display: flex; flex-wrap: wrap; gap: 1rem 2rem; font: .7rem ui-monospace,monospace; color: var(--accent); padding: 1.5rem 0 .5rem; }
.lab-energy { display: grid; grid-template-columns: repeat(auto-fit,minmax(10rem,1fr)); gap: 1.5rem; }
.comment { padding: 1.4rem 0; border-bottom: 1px solid var(--line); }
.comment header { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.comment p { white-space: pre-wrap; }
.cover-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 2; }
.project-media { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,22rem),1fr)); gap: 1rem; }
.project-image { width: 100%; max-height: 28rem; object-fit: contain; border-radius: 12px; background: var(--glass-low); }
.video-showcase { margin: 1.5rem 0; padding: 1.4rem; background: var(--glass-low); border: 1px solid var(--line); border-radius: var(--radius); }
.video-showcase-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: .6rem; }
.video-showcase-header h3 { margin: 0; font-size: 1.15rem; }
.video-link-card { display: flex; align-items: center; gap: .75rem; padding: .85rem 1.1rem; background: var(--glass); border: 1px solid var(--line-strong); border-radius: 8px; text-decoration: none; color: var(--ink); transition: border-color var(--quick) var(--ease), transform var(--quick) var(--spring); }
.video-link-card:hover { border-color: var(--accent); transform: translateY(-1px); }
.video-play-symbol { display: inline-grid; place-items: center; width: 2rem; height: 2rem; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: .8rem; flex-shrink: 0; }
.video-url-label { font-family: ui-monospace, monospace; font-size: .85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.video-external-arrow { font-size: 1.1rem; color: var(--muted); flex-shrink: 0; }
.project-story p { white-space: pre-wrap; line-height: 1.8; }
.technology-tags { display: flex; gap: .5rem; flex-wrap: wrap; }
.technology-tags span { border: 1px solid var(--line); padding: .35rem .7rem; border-radius: 5px; font: .7rem ui-monospace,monospace; }
/* Visual depth belongs to the event, while controls remain clear and compact. */
.hero-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 3rem; align-items: center; }
.hero-grid .hero-actions { margin: 2rem 0 0; gap: 1.3rem; }
.collection-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: .5rem 1.2rem; color: var(--muted); font-size: .8rem; margin: 0 0 1.2rem; }
.collection-meta strong { color: var(--ink); }
.home .hero-grid { margin-bottom: 3rem; }
.event-art { background: #c5e68d; color: #30491c; background-image: repeating-linear-gradient(45deg, transparent 0 23px, #435c1d12 24px 25px); }
.art-1 { background-color: #e6d69d; } .art-2 { background-color: #bed4c0; }
.event-card, .project-card { transition: transform 220ms var(--ease), border-color 220ms var(--ease), box-shadow 220ms var(--ease); }
.event-card:hover, .project-card:hover { transform: translateY(-4px); border-color: var(--line-strong); box-shadow: var(--shadow-lift); }
.event-card:focus-within, .project-card:focus-within { border-color: var(--accent); }
.project-cover { position: relative; min-height: 10.5rem; background: radial-gradient(circle at 75% 30%, #9eb95e36, transparent 45%), repeating-linear-gradient(135deg, transparent 0 18px, #718d4810 19px 20px), var(--glass-low); overflow: hidden; }
.project-cover::after { content: ""; position: absolute; width: 9rem; height: 9rem; right: 1.5rem; top: .6rem; border: 1px solid var(--line-strong); border-radius: 28% 72% 44% 56%; transform: rotate(25deg); opacity: .5; }
.project-card:nth-child(2n) .project-cover::after { border-radius: 50%; transform: scaleX(.6) rotate(35deg); }
.project-card:nth-child(3n) .project-cover::after { border-radius: 12px; transform: rotate(45deg); }
.project-monogram { font-family: "Arial", sans-serif; font-style: normal; font-weight: 750; z-index: 1; }
.project-cover .detail { z-index: 1; align-self: end; }
.event-journey { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; margin: 1rem 0 2rem; }
.event-journey li { min-width: 0; background: var(--glass); border-right: 1px solid var(--line); }
.event-journey li > a, .event-journey li > .journey-static { min-height: 6rem; display: flex; gap: .8rem; padding: 1.15rem .8rem; align-items: center; color: var(--ink); text-decoration: none; }
.event-journey li > a { transition: background var(--slow) var(--ease), transform var(--slow) var(--spring); }
.event-journey li > a:hover { background: var(--glass-high); transform: translateY(-2px); }
.event-journey li > a:active { transform: translateY(0); }
.event-journey li:last-child { border: 0; }
.journey-number { font: .85rem ui-monospace, monospace; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 50%; padding: .65rem; }
.event-journey .is-active { background: var(--glass-low); box-shadow: inset 0 -3px var(--accent); }
.is-active .journey-number { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.event-journey b { display: block; font-size: .85rem; margin-bottom: .3rem; }
.journey-copy { min-width: 0; }
.journey-copy > span { display: block; font-size: .7rem; color: var(--muted); }
.judge-mission { display: flex; justify-content: space-between; align-items: center; gap: 2rem; padding: 2rem; background: radial-gradient(ellipse at right, #a4cf5b20, transparent 65%), var(--glass); border: 1px solid var(--line); border-radius: 16px; }
.judge-mission h2 { margin: 0; font-size: 1.8rem; max-width: 24ch; }
.judge-mission p:not(.eyebrow) { color: var(--muted); font-size: .85rem; }
.mission-progress { min-width: 10rem; display: grid; gap: .65rem; color: var(--muted); font-size: .75rem; }
.mission-progress > b { font-size: 3rem; letter-spacing: -.06em; color: var(--accent); }
.mission-progress b > span { font-size: 1.2rem; color: var(--muted); }
.review-project[open] { border-color: var(--accent); box-shadow: inset 3px 0 var(--accent); }
.score-choice span { transition: background 160ms, transform 160ms; min-width: 3.1rem; min-height: 3.1rem; font-weight: 600; }
.score-choice input:checked + span { transform: translateY(-3px); box-shadow: 0 4px 0 var(--line); }
.readiness { margin: 2rem 0; }
.readiness .section-heading { align-items: center; }
.readiness-count { font: .75rem ui-monospace,monospace; color: var(--accent); }
.readiness-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--glass); }
.readiness-check { display: flex; gap: .9rem; padding: 1.3rem; border-bottom: 1px solid var(--line); }
.readiness-check:nth-child(odd) { border-right: 1px solid var(--line); }
.readiness-check h3 { margin: 0 0 .4rem; font-size: .88rem; }
.readiness-check p { margin: 0 0 .5rem; font-size: .78rem; color: var(--muted); line-height: 1.65; }
.readiness-projects { margin: .7rem 0; padding-left: 1.2rem; font-size: .78rem; line-height: 1.7; }
.readiness-projects a { overflow-wrap: anywhere; text-underline-offset: .2em; }
.check-icon { display: grid; place-items: center; flex: 0 0 1.5rem; height: 1.5rem; border-radius: 50%; border: 1px solid var(--line-strong); color: var(--muted); font-size: .75rem; }
.pass .check-icon { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.missing .check-icon { color: var(--bad); border-color: var(--bad); }
.readiness-check .detail { text-transform: uppercase; letter-spacing: .1em; font-size: .6rem; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
@media (max-width: 60rem) { .hero-grid { gap: 1.5rem; } .event-journey li > a, .event-journey li > .journey-static { padding: 1rem .7rem; gap: .6rem; } }
@media (max-width: 44rem) { .hero-grid { grid-template-columns: minmax(0,1fr); } .home h1 { font-size: clamp(3.4rem, 14vw, 4.5rem); }  .home .page-heading { margin-top: 0; } .hero-actions { margin-top: 1.8rem; } .event-journey { grid-template-columns: 1fr; } .event-journey li { border-right: 0; border-bottom: 1px solid var(--line); } .event-journey li > a, .event-journey li > .journey-static { min-height: 3.9rem; } .judge-mission { align-items: start; flex-direction: column; padding: 1.5rem; } .mission-progress { width: 100%; } .readiness-grid { grid-template-columns: 1fr; } .readiness-check:nth-child(odd) { border-right: 0; } .readiness .section-heading { align-items: start; flex-direction: column; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }

  .panel:hover, .pair > :hover, .pair > :focus-within, button:hover, button:active,
  .mark:hover, .mark:active, .tag:hover, summary:active { transform: none; }

  .skip { transform: none; top: -3rem; }
  .skip:focus { top: 0.5rem; }
}

/* Editorial workspace: hierarchy first, motion where it explains the identity. */
body.home {
  --bg: #121714; --ink: #f1f3e9; --muted: #b3bdb3;
  --accent: #c4e886; --accent-ink: #202813; --good: #c4e886; --bad: #ffada3;
  --glass: #1a221c; --glass-high: #222c24; --glass-low: #1d271f;
  --line: #354036; --line-strong: #819779;
  background: radial-gradient(ellipse at 15% 5%, #354a2625, transparent 45%), var(--bg);
}
.home main { padding-top: 2rem; }
.home .hero-grid { grid-template-columns: 1fr 1.05fr; gap: 1.5rem; min-height: 33rem; margin-bottom: 1.8rem; }
.home h1 { font-size: clamp(3.6rem, 6.8vw, 6.4rem); max-width: 10ch; font-weight: 650; letter-spacing: -.07em; line-height: .98; }
.home .page-lead { max-width: 41ch; font-size: 1.05rem; margin-top: 1.8rem; line-height: 1.7; }
.home .eyebrow { letter-spacing: .19em; font-size: .66rem; }
.home .principles { margin-top: 0; padding-block: 1.4rem; }
.home .event-card { border-radius: 16px; box-shadow: none; }
.home .event-art { background-color: #c1df93; min-height: 15rem; }
.home .art-glyph { font-weight: 500; text-shadow: 6px 6px 0 #30491c25; }
.home .section-heading h2, .start-here h2 { font-size: clamp(1.8rem, 3vw, 2.7rem); line-height: 1.12; }
.home #events { padding-top: 1.5rem; }
.motion-study { margin: 0; position: relative; min-width: 0; isolation: isolate; align-self: stretch; display: flex; flex-direction: column; justify-content: center; }
.study-meta { display: flex; justify-content: space-between; gap: 1rem; color: #a9b6a4; font: .55rem ui-monospace, monospace; letter-spacing: .13em; padding: 1.2rem .5rem; border-bottom: 1px solid #354036; z-index: 1; }
.study-stage { position: relative; aspect-ratio: 800 / 560; width: 100%; overflow: hidden; }
.globe-stage { display: grid; place-items: center; perspective: 1000px; background: radial-gradient(circle at 49% 47%, #334a3628 0 18%, transparent 58%); }
.globe-scene { position: relative; width: min(78%, 27rem); aspect-ratio: 1; transform-style: preserve-3d; filter: drop-shadow(0 2.5rem 2rem #0009); }
.globe-halo { position: absolute; inset: -5%; border-radius: 50%; background: radial-gradient(circle, #c4e88622 0%, #5ec8d814 45%, transparent 70%); box-shadow: 0 0 6rem #c4e88622; pointer-events: none; }
.globe-axis { position: absolute; inset: 5%; transform: rotate(-22deg) rotateX(14deg); transform-style: preserve-3d; }
.globe-core { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 30% 26%, #1a3a2c 0%, #0d231b 42%, #05130f 82%, #020907 100%); border: 1px solid #c4e88655; box-shadow: inset -1.8rem -1.4rem 3.5rem #010705f5, inset 1rem 1rem 2rem #d8f7b533, 0 0 3rem #c4e88626; overflow: hidden; }
.globe-land-track { position: absolute; inset: 0; width: 200%; height: 100%; display: flex; animation: land-drift 24s linear infinite; }
.globe-land { width: 50%; height: 100%; flex-shrink: 0; fill: #c4e886cc; filter: drop-shadow(0 0 .4rem #c4e88666); }
.globe-shading { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 32% 26%, rgba(216, 247, 181, .12) 0%, transparent 48%, rgba(1, 8, 5, .72) 78%, rgba(1, 8, 5, .96) 100%); pointer-events: none; box-shadow: inset -1.6rem -1.2rem 3rem #010705ee, inset .8rem .8rem 1.6rem #c4e88630; }
.globe-sphere { position: absolute; inset: 0; border-radius: 50%; transform-style: preserve-3d; animation: globe-turn 24s linear infinite; pointer-events: none; }
.globe-meridian, .globe-equator, .globe-latitude { position: absolute; inset: 0; border: 1px solid #b7e6ba38; border-radius: 50%; backface-visibility: visible; }
.globe-meridian-a { transform: rotateY(0deg); }
.globe-meridian-b { transform: rotateY(45deg); }
.globe-meridian-c { transform: rotateY(90deg); }
.globe-meridian-d { transform: rotateY(135deg); }
.globe-equator { transform: rotateX(90deg); border-color: #c4e88677; border-width: 1.5px; box-shadow: 0 0 1rem #c4e88622; }
.globe-latitude-north { transform: translateY(-28.5%) rotateX(90deg) scale(0.82); border-color: #b7e6ba2d; }
.globe-latitude-south { transform: translateY(28.5%) rotateX(90deg) scale(0.82); border-color: #b7e6ba2d; }
.globe-orbit { position: absolute; inset: -10%; border-radius: 50%; transform-style: preserve-3d; pointer-events: none; }
.globe-orbit-a { border: 1.5px dashed #5ec8d866; transform: rotateX(68deg) rotateY(-25deg); box-shadow: 0 0 1.5rem #5ec8d821; }
.globe-orbit-b { border: 1px solid #e8a54855; transform: rotateX(72deg) rotateY(40deg); }
.globe-point { position: absolute; width: .6rem; aspect-ratio: 1; border-radius: 50%; background: #e8a548; box-shadow: 0 0 0 .3rem #e8a54822, 0 0 1.5rem #e8a548ee; }
.globe-point-a { left: 16%; top: 22%; background: #5ec8d8; box-shadow: 0 0 0 .3rem #5ec8d822, 0 0 1.5rem #5ec8d8ee; }
.globe-point-b { right: 12%; bottom: 26%; }
.globe-point-c { left: 48%; bottom: -4%; width: .45rem; background: #c4e886; box-shadow: 0 0 0 .3rem #c4e88622, 0 0 1.5rem #c4e886ee; }
@keyframes land-drift { to { transform: translateX(-50%); } }
@keyframes globe-turn { to { transform: rotateY(360deg); } }
@keyframes globe-scroll { from { transform: translate3d(0, 9%, 0) rotateZ(-9deg) rotateX(8deg) scale(.88); opacity: .56; } to { transform: translate3d(0, -9%, 0) rotateZ(8deg) rotateX(-5deg) scale(1.08); opacity: 1; } }
@supports (animation-timeline: view()) {
  .globe-scene { animation: globe-scroll linear both; animation-timeline: view(block); animation-range: entry 0% exit 100%; }
}
.motion-switch { position: absolute; width: 1px; height: 1px; min-height: 0; clip-path: inset(50%); overflow: hidden; }
.motion-control { position: absolute; right: .5rem; top: 3.25rem; z-index: 2; font-size: .7rem; padding: .8rem 1rem; color: #c4e886; cursor: pointer; border: 1px solid #354036; border-radius: 6px; }
.motion-control:hover { border-color: #819779; }
.motion-switch:focus-visible + label { outline: 2px solid #c4e886; outline-offset: 3px; }
.play-label { display: none; }
.motion-switch:checked ~ .study-stage .globe-sphere { animation-play-state: paused; }
.motion-switch:checked ~ .study-stage .globe-land-track { animation-play-state: paused; }
.motion-switch:checked ~ .study-stage .globe-scene { animation-play-state: paused; }
.motion-switch:checked + label .pause-label { display: none; }
.motion-switch:checked + label .play-label { display: inline; }
.study-coordinate { position: absolute; bottom: 7rem; right: .5rem; font: .65rem/1.7 ui-monospace,monospace; color: #a9b6a4; padding-left: 1rem; border-left: 1px solid #819779; }
.study-coordinate b { color: #eef2e8; font-weight: 400; }
.motion-study figcaption { display: flex; align-items: center; gap: 1rem; padding: 1rem .5rem; color: #b3bdb3; font-size: .7rem; line-height: 1.5; border-top: 1px solid #354036; }
.study-cross { color: #c4e886; font-size: 2rem; }
.study-number { margin-left: auto; font: .65rem ui-monospace, monospace; }
.start-here { display: grid; grid-template-columns: .8fr 1.2fr; gap: 5rem; padding: 5rem 0 2rem; }
.start-here h2 { margin: 0 0 1.5rem; }
.start-here > div > p:not(.eyebrow) { color: var(--muted); font-size: .9rem; max-width: 31ch; line-height: 1.7; }
.role-routes > a { display: block; color: var(--ink); text-decoration: none; border-top: 1px solid var(--line); padding: 1.5rem 0; transition: padding 180ms ease, color 180ms ease; }
.role-routes > a:hover { color: var(--accent); padding-left: .7rem; }
.role-routes h3 { display: flex; justify-content: space-between; gap: 1rem; margin: .8rem 0; font-size: 1.2rem; letter-spacing: -.02em; }
.role-routes p { margin: 0; color: var(--muted); font-size: .83rem; line-height: 1.7; max-width: 50ch; }
.route-number { font: .62rem ui-monospace, monospace; color: var(--muted); letter-spacing: .1em; }
.motion-film { margin-top: 2rem; background: transparent; box-shadow: none; }
.motion-film video { width: 100%; max-height: 32rem; border-radius: 10px; }
.next-action { display: flex; align-items: center; justify-content: space-between; gap: 2rem; padding: 1.8rem 2rem; border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 12px; background: var(--glass); margin-bottom: 2rem; }
.next-action h2 { margin: 0 0 .6rem; font-size: 1.5rem; }
.next-action p:not(.eyebrow) { margin: 0; font-size: .87rem; color: var(--muted); max-width: 62ch; line-height: 1.7; }
.next-action .button { flex-shrink: 0; }
.evidence-guide, .advanced-analysis { margin: 2rem 0; padding: 1.25rem 1.5rem; border-radius: 12px; background: var(--glass); }
.evidence-guide > summary, .advanced-analysis > summary { min-height: 2rem; font-weight: 600; line-height: 1.7; }
.glossary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem 2rem; }
.glossary-grid h3 { font-size: 1rem; }
.glossary-grid p { font-size: .85rem; color: var(--muted); line-height: 1.8; }
.information-panel { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 1.5rem 0; margin: 2rem 0; }
.information-panel .section-heading { margin: 0; }
.information-panel h3 { font-size: 1.5rem; margin: .5rem 0; }
.information-panel > p { color: var(--muted); font-size: .9rem; line-height: 1.8; }
.workspace .briefing { background: radial-gradient(ellipse at 100% 0, #a4cf5b12, transparent 65%),var(--glass); padding: 2rem; border-left: 3px solid var(--accent); }
.workspace .briefing h2 { font-size: clamp(1.5rem, 3vw, 2.25rem); max-width: 35ch; }
.workspace .section-index { padding-top: 1.2rem; border-top: 1px solid var(--line); margin-top: 1.5rem; }
.workspace .stats { gap: .5rem; }
.workspace .scroll thead th { background: var(--glass-low); }
.workspace .scroll tbody tr:hover { background: var(--glass-low); }
.workspace .review-project > summary { padding-block: 1rem; }
button, a.button { transition: background 160ms ease, transform 160ms ease, box-shadow 160ms ease; }
a.button:hover { box-shadow: 0 6px 20px #71904a20; transform: translateY(-2px); }
a.button:active { transform: translateY(1px); }
@supports (view-transition-name: root) { @view-transition { navigation: auto; } ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 180ms; } }
@media (max-width: 65rem) { .start-here { gap: 2rem; } .next-action { align-items: start; flex-direction: column; } .home .hero-grid { min-height: 0; } }
@media (max-width: 44rem) {
  .home .hero-grid { grid-template-columns: minmax(0,1fr); gap: 2.5rem; }
  .home h1 { font-size: clamp(3.6rem, 13vw, 5rem); }
  .motion-study { width: 100%; max-width: 36rem; }
  .start-here { grid-template-columns: minmax(0,1fr); padding-top: 3.5rem; gap: 1.5rem; }
  .study-coordinate { bottom: 6.2rem; font-size: .55rem; }
  .glossary-grid { grid-template-columns: minmax(0,1fr); }
  .next-action, .workspace .briefing { padding: 1.4rem; }
  .information-panel .section-heading { align-items: start; flex-direction: column; }
  .primary-nav { gap: 1.2rem; }
  .who > span { max-width: 10rem; overflow-wrap: anywhere; }
  .home .hero-actions { gap: 1.2rem; }
}
@media (prefers-reduced-motion: reduce) {
  .motion-control, .motion-switch { display: none; }
  .globe-scene, .globe-sphere { animation: none !important; transform: none; }
  .globe-land-track { animation: none !important; }
  .role-routes > a:hover { padding-left: 0; }
  .event-card:hover, .project-card:hover, a.button:hover, a.button:active { transform: none; }
  ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 0ms !important; }
}

/* Frosted workspace, using the original lime and charcoal palette. */
:root {
  --glass: rgba(255, 254, 250, .82);
  --glass-high: rgba(255, 254, 250, .93);
  --glass-low: rgba(238, 239, 232, .79);
  --shine: rgba(255, 255, 255, .9);
  --shadow: 0 12px 35px rgba(37, 59, 37, .09), inset 0 1px 0 var(--shine);
  --shadow-lift: 0 22px 48px rgba(37, 59, 37, .15), inset 0 1px 0 var(--shine);
  --blur: blur(18px) saturate(145%);
  --radius: 24px;
  --radius-sm: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --glass: rgba(29, 34, 29, .86);
    --glass-high: rgba(37, 44, 35, .94);
    --glass-low: rgba(37, 44, 35, .78);
    --shine: rgba(255, 255, 255, .08);
    --shadow: 0 16px 42px rgba(0, 0, 0, .25), inset 0 1px 0 var(--shine);
    --shadow-lift: 0 24px 52px rgba(0, 0, 0, .36), inset 0 1px 0 var(--shine);
  }
}
body.home {
  --glass: rgba(13, 17, 26, .84);
  --glass-high: rgba(20, 26, 38, .92);
  --glass-low: rgba(9, 12, 18, .78);
  --shine: rgba(94, 200, 216, .16);
  --shadow: 0 16px 40px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(232, 165, 72, .16);
  --shadow-lift: 0 24px 52px rgba(0, 0, 0, .6), 0 0 32px rgba(94, 200, 216, .14), inset 0 1px 0 rgba(232, 165, 72, .28);
}
header.bar {
  position: sticky;
  top: 1rem;
  z-index: 100;
  width: min(calc(100% - 2.5rem), 76rem);
  margin: 1rem auto 0;
  padding: .55rem 1rem .55rem .85rem;
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 0;
  border: 1px solid rgba(232, 165, 72, .35);
  border-radius: 999px;
  background: rgba(9, 12, 18, .88);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .6), 0 0 20px rgba(94, 200, 216, .12), inset 0 1px 0 rgba(232, 165, 72, .18);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  transition: background 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}
header.bar:hover {
  border-color: rgba(94, 200, 216, .45);
  box-shadow: 0 12px 36px rgba(0, 0, 0, .65), 0 0 26px rgba(232, 165, 72, .18), inset 0 1px 0 rgba(94, 200, 216, .25);
}
.mark { display: inline-flex; align-items: center; font-size: 1.35rem; font-weight: 750; letter-spacing: -.03em; color: #ffffff; text-decoration: none; flex-shrink: 0; }
.mark:hover { color: #ffffff; transform: none; }
.brand-period { color: #5EC8D8; text-shadow: 0 0 8px rgba(94, 200, 216, .6); }
.brand-symbol { display: grid; place-items: center; width: 2.15rem; height: 2.15rem; margin-right: .65rem; border-radius: 50%; color: #07090e; background: linear-gradient(135deg, #E8A548 0%, #5EC8D8 100%); font: italic 1.4rem/1 Georgia, serif; font-weight: 700; padding-right: .12em; box-shadow: 0 0 14px rgba(232, 165, 72, .5), 0 0 20px rgba(94, 200, 216, .35); flex-shrink: 0; }
.primary-nav { display: flex; align-items: center; gap: 0; margin-left: 1.8rem; }
.primary-nav a { display: inline-flex; align-items: center; padding: .5rem 1rem; color: rgba(255, 255, 255, .7); text-decoration: none; font-size: .88rem; font-weight: 500; position: relative; transition: color 150ms ease; white-space: nowrap; border-radius: 0; background: transparent; }
.primary-nav a:hover { color: #5EC8D8; background: transparent; text-shadow: 0 0 8px rgba(94, 200, 216, .4); }
.primary-nav a + a::before { content: ""; display: inline-block; height: 13px; width: 1px; background: rgba(255, 255, 255, .18); margin-right: 1rem; margin-left: -.1rem; }
.primary-nav a[aria-current] { color: #ffffff; font-weight: 600; background: transparent; box-shadow: none; }
.primary-nav a[aria-current]::after { content: ""; position: absolute; bottom: -0.65rem; left: 1rem; right: 1rem; height: 2.5px; background: linear-gradient(90deg, #E8A548, #5EC8D8); border-radius: 999px; box-shadow: 0 0 8px #5EC8D8, 0 0 16px rgba(232, 165, 72, .75); }
.bar .who { margin-left: auto; display: flex; align-items: center; gap: .75rem; flex-shrink: 0; }
.who > a { display: inline-flex; align-items: center; justify-content: center; padding: .42rem 1.45rem; border: 1px solid rgba(94, 200, 216, .55); border-radius: 999px; color: #5EC8D8; background: transparent; font-size: .88rem; font-weight: 500; text-decoration: none; transition: all 180ms ease; white-space: nowrap; }
.who > a:hover { border-color: #E8A548; background: rgba(232, 165, 72, .12); box-shadow: 0 0 16px rgba(232, 165, 72, .35); color: #E8A548; }
.who span { color: rgba(255, 255, 255, .75); font-size: .84rem; }
.who button.quiet, button.quiet { display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(94, 200, 216, .55); border-radius: 999px; color: #5EC8D8; background: transparent; padding: .4rem 1.2rem; font-size: .84rem; font-weight: 500; cursor: pointer; transition: all 180ms ease; white-space: nowrap; }
.who button.quiet:hover, button.quiet:hover { border-color: #E8A548; background: rgba(232, 165, 72, .12); box-shadow: 0 0 16px rgba(232, 165, 72, .35); color: #E8A548; }
header .who details.fast-login,
details.fast-login {
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  background: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  padding: 0 !important;
  margin: 0 !important;
}
summary.fast-login-btn { display: inline-flex; align-items: center; justify-content: center; padding: .42rem 1.45rem; border: 1px solid rgba(94, 200, 216, .55); border-radius: 999px; color: #5EC8D8; background: transparent; font-size: .88rem; font-weight: 500; cursor: pointer; list-style: none; transition: all 180ms ease; white-space: nowrap; }
summary.fast-login-btn::-webkit-details-marker { display: none; }
summary.fast-login-btn:hover, details.fast-login[open] > summary.fast-login-btn { border-color: #E8A548; background: rgba(232, 165, 72, .12); box-shadow: 0 0 16px rgba(232, 165, 72, .35); color: #E8A548; }
details.fast-login .fast-login-menu { position: absolute; top: calc(100% + .65rem); right: 0; width: 19.5rem; background: rgba(14, 18, 22, .96); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(94, 200, 216, .3); border-radius: 12px; padding: .85rem; box-shadow: 0 16px 40px rgba(0, 0, 0, .6), 0 0 24px rgba(94, 200, 216, .12); z-index: 1000; display: none; }
details.fast-login:hover > .fast-login-menu, details.fast-login[open] > .fast-login-menu { display: block; }
.fast-login-header { padding-bottom: .6rem; margin-bottom: .6rem; border-bottom: 1px solid rgba(255, 255, 255, .08); }
.fast-login-header .role-badge { display: inline-block; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: #5EC8D8; background: rgba(94, 200, 216, .12); border: 1px solid rgba(94, 200, 216, .25); padding: .15rem .5rem; border-radius: 4px; margin-bottom: .35rem; }
.fast-login-header p { font-size: .76rem; line-height: 1.35; color: rgba(255, 255, 255, .65); margin: 0; }
.fast-login-list { display: flex; flex-direction: column; gap: .35rem; }
.fast-login-item { display: flex; width: 100%; text-align: left; flex-direction: column; gap: .15rem; padding: .55rem .75rem; border-radius: 8px; background: rgba(255, 255, 255, .02); border: 1px solid rgba(255, 255, 255, .05); cursor: pointer; transition: all 150ms ease; }
.fast-login-item:hover { background: rgba(94, 200, 216, .1); border-color: rgba(94, 200, 216, .35); transform: translateX(2px); }
.fast-login-item strong { font-size: .84rem; color: #f3f4f6; font-weight: 600; }
.fast-login-item span { font-size: .74rem; color: rgba(255, 255, 255, .55); line-height: 1.3; }
.fast-login-guide-link { display: inline-block; margin-top: .4rem; font-size: .74rem; color: #5EC8D8; text-decoration: none; transition: color 150ms ease; }
.fast-login-guide-link:hover { color: #E8A548; text-decoration: underline; }
.guide-hub { margin: 2.5rem 0; padding: 2rem; background: var(--glass); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.guide-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 1.4rem; margin-top: 1.5rem; }
.guide-card { display: flex; flex-direction: column; padding: 1.5rem; background: var(--glass-low); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.guide-card h3 { margin: .6rem 0 .4rem; font-size: 1.15rem; }
.guide-card p { color: var(--muted); font-size: .84rem; line-height: 1.6; margin-bottom: 1rem; }
.guide-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: auto; }
.guide-actions a { display: inline-flex; align-items: center; padding: .45rem .85rem; font-size: .8rem; font-weight: 500; color: #5EC8D8; background: var(--glass-high); border: 1px solid rgba(94, 200, 216, .25); border-radius: 999px; text-decoration: none; transition: all var(--quick) var(--ease); }
.guide-actions a:hover { border-color: #E8A548; color: #E8A548; background: rgba(232, 165, 72, .12); }
.guide-mascot { width: 5.5rem; height: 5.5rem; object-fit: contain; margin-bottom: .8rem; filter: drop-shadow(0 4px 12px rgba(0, 0, 0, .35)); }
.sitemap-table { margin-top: 1.5rem; }
main { padding-top: 2.4rem; }
.home main { padding-top: 2.6rem; }
.page-heading { margin-top: 1.8rem; }
.home .page-heading { padding: 1.5rem 0 .5rem; }
.home h1 { font-weight: 690; }
.panel, dl, .pair > *, .scroll, details:not(.fast-login), .filter-bar, .briefing,
.evidence-lab, .next-action, .evidence-guide, .advanced-analysis,
.event-card, .project-card, .empty-state {
  background: var(--glass);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
}
.event-card, .project-card, .scroll { overflow: hidden; }
.home .event-card { box-shadow: var(--shadow); }
.workspace-nav { border-bottom: 0; gap: .65rem; }
.workspace-nav a, .export-links a, .technology-tags span, .tag { border-radius: 999px; background: var(--glass-high); border: 1px solid rgba(94, 200, 216, .2); box-shadow: inset 0 1px 0 var(--shine); }
.tag { color: #5EC8D8; }
.notice { border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow); background: var(--glass-high); }
input, textarea, select { border-radius: var(--radius-sm); background: var(--glass-high); min-height: 44px; }
button, a.button { border-radius: 999px; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25), 0 5px 15px rgba(232, 165, 72, .2); }
button:hover, a.button:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.score-choice span { border-radius: 999px; }
.motion-control { border-radius: 999px; background: rgba(13, 17, 26, .78); border: 1px solid rgba(94, 200, 216, .25); backdrop-filter: blur(12px); }
.home .principles { border-color: var(--line); }
@media (max-width: 48rem) {
  header.bar { border-radius: 24px; flex-wrap: wrap; padding: .75rem 1rem; gap: .75rem 1rem; }
  .primary-nav { order: 3; width: 100%; margin-left: 0; overflow-x: auto; padding-bottom: .2rem; }
  .primary-nav a { padding: .4rem .6rem; }
  .primary-nav a + a::before { margin-right: .6rem; }
  .primary-nav a[aria-current]::after { bottom: -.2rem; }
  .bar .who { margin-left: auto; }
  main { padding: 1.7rem 1rem 0; }
  .event-card { grid-template-columns: minmax(0, 1fr); }
  .event-art { min-height: 12rem; }
  .event-card-body { padding: 1.5rem; }
}
@supports not (backdrop-filter: blur(1px)) {
  .panel, dl, .pair > *, .scroll, details, .filter-bar, .briefing, .evidence-lab,
  .next-action, .event-card, .project-card, header.bar { background: var(--glass-high); }
}
@media print {
  .bar, .notice, .actions, .skip { display: none; }
  main { max-width: none; }
  body { background: #ffffff; }
  .panel, .pair > *, .scroll { box-shadow: none; border-color: #cccccc; }
  details { box-shadow: none; border-color: #cccccc; }
  details > summary { display: none; }
}
.action-plan { margin: 2.5rem 0; padding: 1.75rem 0; border-block: 1px solid var(--line, #68716b); }
.action-queue { list-style: none; margin: 1.25rem 0 0; padding: 0; }
.action-queue li { display: grid; grid-template-columns: 2.5rem minmax(0, 1fr) auto; gap: 1.25rem; align-items: start; padding: 1.5rem 0; border-top: 1px solid var(--line, #68716b); }
.action-queue h3 { margin: .25rem 0 .5rem; }
.action-queue p { margin: 0; max-width: 68ch; }
.action-step { font: 600 1.2rem ui-monospace, monospace; padding-top: .3rem; }
.action-link { display: inline-flex; min-height: 44px; align-items: center; font-weight: 650; text-underline-offset: .3em; }
.problems:focus { outline: 2px solid currentColor; outline-offset: 5px; }
[id] { scroll-margin-top: 6rem; }
@media (max-width: 640px) {
  header.bar { position: static; }
  .action-queue li { grid-template-columns: 2rem minmax(0, 1fr); gap: .8rem; }
  .action-queue .action-link { grid-column: 2; }
  .action-plan .section-heading { align-items: start; flex-direction: column; gap: .75rem; }
}
/* Feedback stays local to existing controls and respects reduced motion. */
.project-card:focus-within, details:focus-within { border-color: currentColor; }
input[type="radio"], input[type="checkbox"] { accent-color: var(--accent); }
@media (prefers-reduced-motion: no-preference) {
  .action-link { transition: transform 160ms ease, text-decoration-color 160ms ease; }
  .action-link:hover { transform: translateX(3px); }
  button:active, .button:active { transform: translateY(1px) scale(.985); }
  details[open] > :not(summary) { animation: disclosure-enter 180ms ease-out; }
  @keyframes disclosure-enter { from { opacity: .4; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
}
/* Real-time live ceremony leaderboard */
.live-masthead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.25rem; background: var(--glass-high); border: 1px solid rgba(94, 200, 216, .3); border-radius: var(--radius); margin-bottom: 2rem; box-shadow: 0 4px 20px rgba(0, 0, 0, .15); }
.live-badge { display: inline-flex; align-items: center; gap: .5rem; font-weight: 700; font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; padding: .35rem .75rem; border-radius: 999px; background: rgba(46, 204, 113, .15); border: 1px solid rgba(46, 204, 113, .4); color: #2ecc71; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: #2ecc71; box-shadow: 0 0 8px #2ecc71; display: inline-block; }
.live-ticker { font-size: .9rem; color: var(--muted); display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.live-controls { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.live-podium { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.25rem; margin: 2rem 0; }
.podium-card { position: relative; display: flex; flex-direction: column; padding: 1.5rem; border-radius: var(--radius); background: var(--glass); border: 1px solid var(--line); box-shadow: var(--shadow); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); }
.podium-gold { border-color: rgba(241, 196, 15, .5); background: linear-gradient(180deg, rgba(241, 196, 15, .12) 0%, var(--glass) 60%); box-shadow: 0 8px 30px rgba(241, 196, 15, .15); }
.podium-silver { border-color: rgba(189, 195, 199, .5); background: linear-gradient(180deg, rgba(189, 195, 199, .12) 0%, var(--glass) 60%); box-shadow: 0 8px 30px rgba(189, 195, 199, .15); }
.podium-bronze { border-color: rgba(230, 126, 34, .5); background: linear-gradient(180deg, rgba(230, 126, 34, .12) 0%, var(--glass) 60%); box-shadow: 0 8px 30px rgba(230, 126, 34, .15); }
.podium-rank { font-size: 1.1rem; font-weight: 800; letter-spacing: .05em; margin-bottom: .5rem; display: flex; align-items: center; justify-content: space-between; }
.podium-title { font-size: 1.25rem; font-weight: 700; margin: .25rem 0 .5rem; line-height: 1.3; }
.podium-score { font-size: 1.8rem; font-weight: 900; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: .5rem 0; color: var(--ink); }
.podium-meta { font-size: .85rem; color: var(--muted); display: flex; flex-direction: column; gap: .25rem; margin-top: auto; padding-top: .75rem; border-top: 1px solid var(--line); }
.live-explainer { margin: 3rem 0; padding: 1.75rem; background: var(--glass); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.explainer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.25rem; margin-top: 1.25rem; }
.explainer-card { padding: 1.25rem; border-radius: var(--radius-sm); background: var(--glass-high); border: 1px solid var(--line); }
.live-standby { color: #e67e22; border-color: rgba(230, 126, 34, .4); background: rgba(230, 126, 34, .12); }
.live-preview { color: #f39c12; border-color: rgba(243, 156, 18, .4); background: rgba(243, 156, 18, .15); }
.podium-unit { font-size: .5em; color: var(--muted); font-weight: 400; }
/* Role Switcher & Fast Login Cards */
.role-switcher-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; margin: 1.5rem 0 1.25rem; padding: .6rem 1rem; background: var(--glass-high); border: 1px solid var(--line); border-radius: 999px; }
.role-switcher-label { font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-right: .25rem; }
.role-switch-btn { display: inline-flex; align-items: center; gap: .35rem; padding: .35rem .85rem; border-radius: 999px; background: var(--glass); border: 1px solid var(--line); color: var(--ink); text-decoration: none; font-size: .84rem; font-weight: 500; transition: all var(--quick) var(--ease); }
.role-switch-btn:hover { border-color: rgba(94, 200, 216, .5); background: rgba(94, 200, 216, .08); transform: translateY(-1px); }
.role-switcher-bar form { margin: 0; }
.role-switcher-bar button.role-switch-btn { cursor: pointer; }
.fast-login-box { margin-top: 2.5rem; padding: 1.75rem; background: var(--glass); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.fast-login-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: .85rem; margin-top: 1rem; }
.role-card { display: flex; flex-direction: column; gap: .25rem; padding: 1rem 1.15rem; border-radius: var(--radius-sm); background: var(--glass-high); border: 1px solid var(--line); text-decoration: none; transition: all var(--quick) var(--ease); }
.fast-login-grid form { margin: 0; }
.fast-login-grid button.role-card { width: 100%; height: 100%; text-align: left; cursor: pointer; font: inherit; }
.role-card:hover { border-color: rgba(94, 200, 216, .5); background: rgba(94, 200, 216, .08); transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0, 0, 0, .2); }
.role-card strong { font-size: .92rem; color: var(--ink); font-weight: 600; }
.role-card span { font-size: .76rem; color: var(--muted); line-height: 1.35; }
/* Tie-Breaker Assistant */
.tie-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.25rem; background: var(--glass-high); border: 1px solid rgba(243, 156, 18, .4); border-radius: var(--radius); margin-bottom: 2rem; box-shadow: 0 4px 20px rgba(243, 156, 18, .1); }
.tie-grid { display: grid; grid-template-columns: minmax(260px, 1fr) auto minmax(260px, 1fr); align-items: center; gap: 1.5rem; margin: 2rem 0; }
.tie-card { padding: 1.75rem; border-radius: var(--radius); background: var(--glass); border: 1px solid var(--line); box-shadow: var(--shadow); backdrop-filter: var(--blur); }
.tie-vs { text-align: center; font-size: 1.6rem; font-weight: 900; color: var(--muted); padding: 1rem; }
.tie-prob-bar { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-radius: var(--radius-sm); background: var(--glass-high); border: 1px solid var(--line); margin: 1rem 0; }
.tie-prob-label { font-weight: 700; }
.tie-action-box { margin: 2rem 0; }
.tie-btn-box { margin-top: 1rem; }
/* Certificate presentation uses paper tones only inside the artifact preview. */
.certificate-studio { display: grid; grid-template-columns: minmax(16rem, .82fr) minmax(0, 1.18fr); gap: clamp(1rem, 3vw, 2.5rem); align-items: start; margin: 2rem 0; }
.certificate-studio > * { min-width: 0; }
.certificate-studio .certificate-sheet { position: sticky; top: 7rem; }
.certificate-sheet { position: relative; isolation: isolate; display: block; width: 100%; min-height: 24rem; padding: clamp(1.75rem, 5vw, 3.5rem); overflow: hidden; border: .55rem solid #ebe3ce; outline: 1px solid #b18348; outline-offset: -.95rem; background: radial-gradient(circle at 80% 10%, #e4d8b883, transparent 48%), #faf7ec; color: #273328; box-shadow: 0 1.5rem 3rem #18271b30; }
.certificate-sheet::before { content: ""; position: absolute; inset: 1.25rem; border: 1px solid #b1834880; pointer-events: none; }
.certificate-watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; opacity: .075; overflow: hidden; }
.certificate-watermark img { width: 70%; max-width: 36rem; height: auto; object-fit: contain; filter: grayscale(100%) contrast(125%); }
.certificate-sheet-inner { position: relative; z-index: 1; display: grid; gap: .85rem; width: 100%; }
.certificate-sheet-top { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .55rem; text-align: center; margin-bottom: .25rem; }
.certificate-logo { max-height: 4.8rem; max-width: 14rem; object-fit: contain; filter: drop-shadow(0 2px 4px rgba(0,0,0,.06)); }
.certificate-monogram { font-size: 1.8rem; color: #a78040; }
.certificate-overline { font-size: .82rem; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: #876d43; }
.certificate-kicker { font-size: .75rem; letter-spacing: .15em; text-transform: uppercase; color: #876d43; margin: 0; }
.certificate-sheet h1, .certificate-sheet h2 { color: #273328; margin: .25rem 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(1.8rem, 3vw, 3.2rem); line-height: 1.15; letter-spacing: -.03em; text-wrap: balance; }
.certificate-presented { font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: #746e63; margin: .2rem 0; }
.certificate-recipient { font-family: Georgia, "Times New Roman", serif; font-size: clamp(1.6rem, 2.8vw, 2.6rem); font-weight: 700; color: #192a2c; margin: .2rem 0; line-height: 1.2; }
.certificate-detail { font-size: 1.05rem; font-weight: 600; color: #314347; }
.certificate-body { font-family: Georgia, "Times New Roman", serif; font-size: .98rem; line-height: 1.6; color: #596163; max-width: 60ch; }
.certificate-signature { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-top: 1rem; padding-top: .75rem; }
.certificate-signature-name { display: block; font-family: Georgia, "Times New Roman", serif; font-size: 1.15rem; font-weight: 700; color: #192a2c; }
.certificate-signature-label { display: block; font-size: .82rem; color: #746e63; }
.certificate-seal { font-size: 1.8rem; color: #a78040; }
.certificate-proof { display: flex; flex-direction: column; gap: .4rem; margin-top: .6rem; padding-top: .8rem; border-top: 1px dashed rgba(177,131,72,.4); font-size: .8rem; }
.cert-proof-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem; }
.cert-proof-label { font-weight: 700; font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: #876d43; min-width: 3.8rem; flex-shrink: 0; }
.cert-proof-value { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .76rem; color: #273328; word-break: break-all; }
.cert-proof-link { color: #2d637a; text-decoration: underline; text-underline-offset: 2px; }
.cert-proof-link:hover { color: #b18348; }
.certificate-sheet p { max-width: 60ch; line-height: 1.55; margin: .4rem 0; }
.certificate-sheet .eyebrow, .certificate-sheet .detail { color: #725b3e; }
.certificate-sheet code { overflow-wrap: anywhere; }
.certificate-roster { max-width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--glass); }
.certificate-roster table { min-width: 36rem; }
.certificate-roster tbody tr:hover { background: var(--glass-low); }
.certificate-status { display: inline-flex; align-items: center; min-height: 1.8rem; padding: .15rem .55rem; border: 1px solid var(--line-strong); border-radius: .35rem; font-size: .75rem; font-weight: 650; letter-spacing: .02em; }
.certificate-status.active { border-color: var(--good); color: var(--ink); }
.certificate-status.revoked, .certificate-status.superseded { border-color: var(--bad); color: var(--bad); }
.certificate-public { max-width: 64rem; margin: 2rem auto; }
.certificate-public .certificate-sheet { margin: 1.5rem auto 2rem; }
.certificate-entry { margin-top: 2rem; }
@media (max-width: 50rem) { .certificate-studio { grid-template-columns: minmax(0,1fr); } .certificate-studio .certificate-sheet { position: static; } }
@media (max-width: 35rem) { .certificate-sheet { min-height: 19rem; padding: 1.7rem; } .certificate-sheet::before { inset: .8rem; } }
@media print { .certificate-studio { display: block; } .certificate-sheet { box-shadow: none; break-inside: avoid; } .certificate-roster, .certificate-studio form { display: none; } }
`;
