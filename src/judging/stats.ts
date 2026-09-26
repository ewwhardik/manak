/** Small statistics helpers. Population (not sample) variance throughout. */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function variance(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / xs.length;
}

export function sd(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** The middle value, averaging the two middles on an even count. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Two-sided 95% critical value of Student's t on `df` degrees of freedom.
 *
 * A confidence interval on a project's score needs one of these, and reaching for
 * 1.96 regardless would understate the interval exactly when it matters most — a
 * small event with five projects and three judges has single-digit degrees of
 * freedom, where the true multiplier is nearer 2.3. This is the standard
 * Cornish-Fisher expansion of the t quantile in the normal one, which is within
 * 0.001 of the tabulated value for df >= 8 and errs wide below that. Erring wide
 * is the right direction: an interval that is slightly too generous does not claim
 * a separation that is not there.
 *
 * A table lookup would be more accurate for tiny df and would also be forty lines
 * of numbers nobody can check. The expansion is checkable arithmetic.
 */
export function tCritical95(df: number): number {
  const z = 1.959963984540054;
  if (!(df >= 1)) return z;
  if (df === 1) return 12.7062;
  if (df === 2) return 4.3027;
  if (df === 3) return 3.1824;
  if (df === 4) return 2.7764;
  const z3 = z * z * z;
  const z5 = z3 * z * z;
  const z7 = z5 * z * z;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df * df * df)
  );
}

/**
 * Dense ranking, 1-based, highest score first. Ties break on the string key so
 * that two runs over the same data always produce the same table — a ranking an
 * organizer cannot reproduce is a ranking they cannot defend.
 */
export function rankDescending(entries: readonly { key: string; score: number }[]): Map<string, number> {
  const sorted = entries.slice().sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key));
  const ranks = new Map<string, number>();
  sorted.forEach((e, i) => ranks.set(e.key, i + 1));
  return ranks;
}

/**
 * Kendall's tau-b between two parallel score vectors. Handles ties, which
 * matters because raw ballot means tie constantly on a 1-5 scale.
 */
export function kendallTau(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let concordant = 0;
  let discordant = 0;
  let tiedA = 0;
  let tiedB = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const da = (a[i] as number) - (a[j] as number);
      const db = (b[i] as number) - (b[j] as number);
      if (da === 0 && db === 0) continue;
      if (da === 0) { tiedA++; continue; }
      if (db === 0) { tiedB++; continue; }
      if (da * db > 0) concordant++;
      else discordant++;
    }
  }
  const denom = Math.sqrt((concordant + discordant + tiedA) * (concordant + discordant + tiedB));
  if (denom === 0) return 0;
  return (concordant - discordant) / denom;
}

/** Pearson correlation. Used by the proof harness to report recovery quality. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Root mean squared error, for judge-effect recovery in the proof. */
export function rmse(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/**
 * Sample variance: the unbiased estimator with Bessel's correction (`/ (n - 1)`).
 *
 * Population variance is the right denominator when the values *are* the population — a
 * judge's filed scores, or a project's received ballots. Sample variance is the right one
 * when the values are a *sample* from something larger and the goal is to estimate the
 * spread of that larger thing: the residual spread of the fit, for instance, is a sample
 * from the errors this panel would produce on a much longer run, and dividing by `n`
 * understates it by a factor of `(n - 1) / n`. On three ballots that factor is 2/3, which
 * shrinks the standard error by about 18% and makes every confidence interval in the
 * product that much too narrow.
 *
 * Returns zero on fewer than two values, where no unbiased estimate exists.
 */
export function sampleVariance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - 1);
}

export function sampleSd(xs: readonly number[]): number {
  return Math.sqrt(sampleVariance(xs));
}

/**
 * A Map.get that throws on a missing key rather than returning undefined.
 *
 * Every `as` cast on a Map lookup in this engine is correct — the key was put
 * there three lines above — but the cast hides the assumption, and a refactor
 * that breaks the assumption gets a NaN where a thrown error would have pointed
 * at the line. This is the version that says what it means.
 *
 * Not used to replace every existing cast: the engine works, and a mass rename
 * would produce a diff that touches every function for no behavioural change.
 * New code and code being touched for other reasons should prefer this.
 */
export function get<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const v = map.get(key);
  if (v === undefined) throw new Error(`Map missing expected key: ${String(key)}`);
  return v;
}

/**
 * Connected components over an undirected graph given as an adjacency map.
 * Used twice: to check the judge-project design is comparable, and to check the
 * pairwise comparison graph before trusting a Bradley-Terry fit.
 */
export function components(nodes: readonly string[], edges: readonly [string, string][]): string[][] {
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n, n);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (parent.get(c) !== c) {
      const nxt = parent.get(c) as string;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  for (const [u, v] of edges) {
    if (!parent.has(u) || !parent.has(v)) continue;
    const ru = find(u);
    const rv = find(v);
    if (ru !== rv) parent.set(ru, rv);
  }
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const r = find(n);
    const g = groups.get(r);
    if (g) g.push(n);
    else groups.set(r, [n]);
  }
  return [...groups.values()].map((g) => g.slice().sort());
}
