import { esc, page, scroller, table } from "./html.ts";
import { eventTrail, rows } from "./pages.ts";
import type { ViewContext } from "./pages.ts";

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x.toFixed(4) : "Unavailable";

function renderWaterfallChart(project: Record<string, unknown>): string {
  const grandMean = typeof project.grandMean === "number" ? project.grandMean : null;
  const adjusted = typeof project.adjusted === "number" ? project.adjusted : null;
  const reviews = Array.isArray(project.reviews) ? (project.reviews as Record<string, unknown>[]) : [];
  if (grandMean === null || adjusted === null || reviews.length === 0) return "";

  const totalWeight = reviews.reduce((sum, r) => sum + (typeof r.weight === "number" ? r.weight : 1), 0) || 1;

  type Step = {
    label: string;
    sublabel: string;
    start: number;
    end: number;
    delta: number;
    type: "total" | "delta" | "final";
    detail: string;
  };

  const steps: Step[] = [];
  steps.push({
    label: "Grand Mean (μ)",
    sublabel: "Panel Base",
    start: 0,
    end: grandMean,
    delta: grandMean,
    type: "total",
    detail: `Panel average: ${grandMean.toFixed(2)}`,
  });

  let currentLevel = grandMean;
  for (let i = 0; i < reviews.length; i++) {
    const r = reviews[i]!;
    const weight = typeof r.weight === "number" ? r.weight : 1;
    const calibrated = typeof r.calibrated === "number" ? r.calibrated : grandMean;
    const raw = typeof r.raw === "number" ? r.raw : 0;
    const baseline = typeof r.baseline === "number" ? r.baseline : grandMean;
    const scale = typeof r.scale === "number" ? r.scale : 1;
    const shrinkage = typeof r.shrinkage === "number" ? r.shrinkage : 1;
    const delta = (weight / totalWeight) * (calibrated - grandMean);
    const nextLevel = currentLevel + delta;

    steps.push({
      label: String(r.label || `Review ${i + 1}`),
      sublabel: delta > 0 ? "Above panel baseline" : delta < 0 ? "Below panel baseline" : "At panel baseline",
      start: currentLevel,
      end: nextLevel,
      delta,
      type: "delta",
      detail: `Raw: ${raw.toFixed(2)} · Reviewer baseline: ${baseline.toFixed(2)} · Scale: ${scale.toFixed(2)} · Shrinkage trust: ${shrinkage.toFixed(2)} · Weighted contribution above/below panel baseline: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
    });
    currentLevel = nextLevel;
  }

  const low = typeof project.low === "number" ? project.low : null;
  const high = typeof project.high === "number" ? project.high : null;

  steps.push({
    label: "Published score",
    sublabel: low !== null && high !== null ? `Rubric interval: [${low.toFixed(1)}, ${high.toFixed(1)}]` : "Final score",
    start: 0,
    end: adjusted,
    delta: adjusted,
    type: "final",
    detail: `Published score: ${adjusted.toFixed(2)}${low !== null && high !== null ? ` (reported rubric interval: [${low.toFixed(2)}, ${high.toFixed(2)}])` : ""}`,
  });

  const svgWidth = 760;
  const svgHeight = 280;
  const padLeft = 60;
  const padRight = 40;
  const padTop = 40;
  const padBottom = 60;
  const chartWidth = svgWidth - padLeft - padRight;
  const chartHeight = svgHeight - padTop - padBottom;

  let minVal = 0;
  let maxVal = Math.max(0, grandMean, adjusted);
  if (low !== null) minVal = Math.min(minVal, low);
  if (high !== null) maxVal = Math.max(maxVal, high);
  for (const s of steps) {
    minVal = Math.min(minVal, s.start, s.end);
    maxVal = Math.max(maxVal, s.start, s.end);
  }
  // Fit the actual score units, including cumulative contributions and intervals.
  // Nice adaptive ticks keep a 1–5 rubric readable without assuming a 0–100 scale.
  const span = maxVal - minVal || 1;
  const roughStep = span * 1.08 / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const tickStep = [1, 2, 2.5, 5, 10].find(step => step * magnitude >= roughStep)! * magnitude;
  minVal = Math.floor(minVal / tickStep) * tickStep;
  maxVal = Math.ceil((maxVal + span * 0.08) / tickStep) * tickStep;

  const yScale = (v: number) => padTop + chartHeight - ((v - minVal) / (maxVal - minVal)) * chartHeight;
  const colWidth = chartWidth / steps.length;
  const barWidth = Math.min(68, colWidth * 0.72);

  let elements = "";
  const gridTicks = Array.from({ length: Math.round((maxVal - minVal) / tickStep) + 1 },
    (_, i) => Number((minVal + i * tickStep).toPrecision(6)));
  for (const tick of gridTicks) {
    const y = yScale(tick);
    elements += `<line x1="${padLeft}" y1="${y}" x2="${svgWidth - padRight}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="3,3" />`;
    elements += `<text x="${padLeft - 8}" y="${y + 4}" fill="rgba(255,255,255,0.4)" font-size="11" text-anchor="end" font-family="system-ui,sans-serif">${tick}</text>`;
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const cx = padLeft + i * colWidth + colWidth / 2;
    const x = cx - barWidth / 2;

    const yStart = yScale(s.start);
    const yEnd = yScale(s.end);
    const yTop = Math.min(yStart, yEnd);
    const barH = Math.max(2, Math.abs(yStart - yEnd));

    let fill = "#5EC8D8";
    let stroke = "rgba(94, 200, 216, 0.6)";
    if (s.type === "delta") {
      if (s.delta >= 0) {
        fill = "#10B981";
        stroke = "rgba(16, 185, 129, 0.7)";
      } else {
        fill = "#F59E0B";
        stroke = "rgba(245, 158, 11, 0.7)";
      }
    } else if (s.type === "final") {
      fill = "#6366F1";
      stroke = "rgba(99, 102, 241, 0.8)";
    }

    if (i > 0) {
      const prevX = padLeft + (i - 1) * colWidth + colWidth / 2 + barWidth / 2;
      const connectionY = yScale(steps[i - 1]!.end);
      elements += `<line x1="${prevX}" y1="${connectionY}" x2="${x}" y2="${connectionY}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="2,2" />`;
    }

    elements += `<rect x="${x}" y="${yTop}" width="${barWidth}" height="${barH}" rx="4" fill="${fill}" stroke="${stroke}" fill-opacity="${s.type === 'total' || s.type === 'final' ? '0.85' : '0.75'}">`;
    elements += `<title>${esc(s.detail)}</title></rect>`;

    const labelY = yTop - 6;
    const valText = s.type === "delta" ? `${s.delta >= 0 ? "+" : ""}${s.delta.toFixed(2)}` : s.end.toFixed(2);
    elements += `<text x="${cx}" y="${labelY}" fill="#F3F4F6" font-size="11" font-weight="600" text-anchor="middle" font-family="system-ui,sans-serif">${valText}</text>`;

    elements += `<text x="${cx}" y="${svgHeight - padBottom + 18}" fill="#E2E8F0" font-size="11" font-weight="500" text-anchor="middle" font-family="system-ui,sans-serif">${esc(s.label)}</text>`;
    elements += `<text x="${cx}" y="${svgHeight - padBottom + 32}" fill="rgba(255,255,255,0.5)" font-size="9.5" text-anchor="middle" font-family="system-ui,sans-serif">${esc(s.sublabel)}</text>`;

    if (s.type === "final" && low !== null && high !== null) {
      const yLow = yScale(low);
      const yHigh = yScale(high);
      const capWidth = 14;
      elements += `<line x1="${cx}" y1="${yHigh}" x2="${cx}" y2="${yLow}" stroke="#A5B4FC" stroke-width="2" />`;
      elements += `<line x1="${cx - capWidth / 2}" y1="${yHigh}" x2="${cx + capWidth / 2}" y2="${yHigh}" stroke="#A5B4FC" stroke-width="2" />`;
      elements += `<line x1="${cx - capWidth / 2}" y1="${yLow}" x2="${cx + capWidth / 2}" y2="${yLow}" stroke="#A5B4FC" stroke-width="2" />`;
      elements += `<text x="${cx + capWidth / 2 + 4}" y="${yHigh + 4}" fill="#A5B4FC" font-size="9" font-family="system-ui,sans-serif">High: ${high.toFixed(1)}</text>`;
      elements += `<text x="${cx + capWidth / 2 + 4}" y="${yLow + 4}" fill="#A5B4FC" font-size="9" font-family="system-ui,sans-serif">Low: ${low.toFixed(1)}</text>`;
    }
  }

  return `<figure class="panel">
<figcaption>
<strong>Calibration Waterfall: Panel Grand Mean &rarr; Weighted Review Contributions &rarr; Published Score</strong>
${low !== null && high !== null ? `<span> · Reported rubric interval: [${low.toFixed(2)}, ${high.toFixed(2)}]</span>` : ""}
</figcaption>
<div class="scroll">
<svg width="100%" height="auto" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Waterfall breakdown of score calibration">
${elements}
</svg>
</div>
<p class="detail">
Panel grand mean in cyan · Contribution above panel baseline in green · Contribution below panel baseline in amber · Published score in indigo${low !== null && high !== null ? " with the reported analytic rubric interval" : ""}. Colors describe calibrated review contributions, not reviewer severity.
</p>
</figure>`;
}

export function explainPage(context: ViewContext): string {
  const result = context.result as Record<string, unknown>;
  return page({ title: "Explain my rank", whoami: context.whoami, demoMode: context.demoMode,
    trail: eventTrail(context, { label: "Explain my rank" }),
    lead: `Published revision ${String(result.revision)}. Your team's result and the evidence behind it.`,
    body: `<p>${esc(result.notice)}</p>${rows(result, "projects").map(project => `<section>
<h2>${esc(project.title)}</h2><p>Raw rank: ${esc(project.rankRaw ?? "Unavailable")} · Calibrated rank: ${esc(project.rank)} · Rank movement: ${esc(project.rankMove ?? "Unavailable")}</p>
<p>Raw mean: ${num(project.rawMean)} · Published score: ${num(project.adjusted)} · Panel grand mean: ${num(project.grandMean)}</p>
${renderWaterfallChart(project)}
${rows(project, "reviews").length ? scroller(table(["Review", "Raw total", "Baseline", "Scale", "Information weight", "Shrinkage trust", "Calibrated contribution"],
rows(project, "reviews").map(r => [String(r.label), num(r.raw), num(r.baseline), num(r.scale), num(r.weight), r.slopeFitted ? num(r.shrinkage) : "Scale held at 1", num(r.calibrated)])), "Anonymous review contributions") : '<p>No frozen rubric breakdown is available for this revision.</p>'}
</section>`).join("") || '<p>Your team has no project in this published ranking.</p>'}
<h2>How the calculation works</h2><p>Each raw total is the rubric's weighted criterion score. Baseline is the panel grand mean plus the fitted reviewer leniency and the final fit's pending leniency correction. Each calibrated contribution is grand mean + (raw total − baseline) / scale.</p>
<p>The published calibrated score is the information-weighted average of these contributions, with information weight = scale². Values are rounded for display. A positive rank movement means the project rose relative to raw ranking.</p>
<p>Shrinkage trust is n / (n + κ): it blends the fitted scale toward 1 before scale bounds apply. When there are too few observations to estimate a slope, the scale stays at 1. This is uncertainty about reviewer scale, not a penalty to your project. Review labels restart within your project; they do not match judge identities or review labels elsewhere.</p>` });
}

export function sandboxPage(context: ViewContext): string {
  const result = context.result as Record<string, unknown>;
  return page({ title: "Normalization sandbox", whoami: context.whoami, demoMode: context.demoMode,
    trail: eventTrail(context, { label: "Normalization sandbox" }),
    lead: "Compare methods against current evidence.", body: `<p>${esc(result.notice)}</p>${rows(result, "methods").map(method => `<section><h2>${esc(method.name)}</h2><p>${esc(method.caveat)}</p>${method.available ? scroller(table(["Rank", "Project", "Score"], rows(method, "scores").map(s => [String(s.rank), String(s.title), num(s.score)])), String(method.name)) : '<p>Unavailable with current evidence.</p>'}</section>`).join("")}` });
}
