/**
 * SVG chart builders for the locked page design (plan.md §8). Plain template
 * strings returning inline SVG — no chart library, no build step. All charts
 * use a viewBox and width:100% so they scale with their card.
 *
 * Verify grammar (never used for anything else): green #3ddc97 = observed,
 * amber #f4b740 = a past run (the ghost), blue #4c8dff = a live forecast.
 * Model identity always comes from the model's entity color + name.
 */

const C = {
  grid: '#334155',
  textMuted: '#7c8fa3',
  textSecondary: '#94a3b8',
  observed: '#3ddc97',
  observedSoft: 'rgba(61, 220, 151, 0.12)',
  pastRun: '#f4b740',
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);

const px = (v) => Number(v.toFixed(1));

/** Monotone cubic path (Fritsch–Carlson) — the app's curveMonotoneX. */
function monotonePath(pts) {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${px(pts[0].x)},${px(pts[0].y)}`;
  const n = pts.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    slope.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  }
  const t = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    t.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  }
  t.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i] / slope[i];
      const b = t[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        t[i] = tau * a * slope[i];
        t[i + 1] = tau * b * slope[i];
      }
    }
  }
  let d = `M${px(pts[0].x)},${px(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    d += `C${px(pts[i].x + h / 3)},${px(pts[i].y + (t[i] * h) / 3)} ` +
      `${px(pts[i + 1].x - h / 3)},${px(pts[i + 1].y - (t[i + 1] * h) / 3)} ` +
      `${px(pts[i + 1].x)},${px(pts[i + 1].y)}`;
  }
  return d;
}

const polyline = (pts) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x)},${px(p.y)}`).join('');

/** Nudge same-x labels apart vertically so they never overlap. */
function spreadLabels(labels, minGap, top, bottom) {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
  }
  const over = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
  if (over > 0) for (const l of sorted) l.y -= over;
  for (const l of sorted) l.y = Math.max(top, l.y);
  return labels;
}

// ── Skill by lead time (the Score tab's chart, ported faithfully) ────────────

/**
 * Zoom the y-axis to the data: [min, max] padded for breathing room, clamped to
 * 0–100 and snapped outward to a round step so the gridline labels stay clean.
 * @param {number[]} scores
 * @returns {{lo:number, hi:number, ticks:number[]}}
 */
function zoomAxis(scores, target = 4) {
  if (scores.length === 0) return { lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100] };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const pad = Math.max((max - min) * 0.12, 3);
  const rawLo = Math.max(0, min - pad);
  const rawHi = Math.min(100, max + pad);
  const span = rawHi - rawLo || 1;
  const rawStep = span / target;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.max(0, Math.floor(rawLo / step) * step);
  const hi = Math.min(100, Math.ceil(rawHi / step) * step);
  const ticks = [];
  for (let t = lo; t <= hi + step * 1e-6; t += step) ticks.push(Math.round(t * 100) / 100);
  return { lo, hi, ticks };
}

/**
 * @param {Array<{model:Object, points:Array<{day:number, score:number}>}>} series
 */
export function leadTimeChart(series, { width = 560, height = 250 } = {}) {
  const L = 34;
  const R = 74;
  const T = 12;
  const B = 26;
  const plotW = width - L - R;
  const plotH = height - T - B;
  const { lo, hi, ticks } = zoomAxis(series.flatMap((s) => s.points.map((p) => p.score)));
  const x = (day) => L + ((day - 1) / 6) * plotW;
  const y = (score) => T + (1 - (score - lo) / (hi - lo)) * plotH;

  const parts = [];
  for (const tick of ticks) {
    const dash = tick === lo || tick === hi ? '' : ` stroke-dasharray="2 4"`;
    parts.push(
      `<line x1="${L}" x2="${L + plotW}" y1="${px(y(tick))}" y2="${px(y(tick))}" stroke="${C.grid}" stroke-width="0.5"${dash}/>`,
      `<text x="${L - 6}" y="${px(y(tick) + 3)}" fill="${C.textMuted}" font-size="9" text-anchor="end">${tick}</text>`,
    );
  }
  for (let day = 1; day <= 7; day++) {
    parts.push(
      `<line x1="${px(x(day))}" x2="${px(x(day))}" y1="${T + plotH}" y2="${T + plotH + 4}" stroke="${C.grid}" stroke-width="0.5"/>`,
      `<text x="${px(x(day))}" y="${T + plotH + 16}" fill="${C.textMuted}" font-size="9" text-anchor="middle">${day}d</text>`,
    );
  }

  for (const s of series) {
    const pts = s.points.map((p) => ({ x: x(p.day), y: y(p.score) }));
    if (pts.length >= 2) {
      parts.push(`<path d="${monotonePath(pts)}" stroke="${s.model.color}" stroke-width="2" fill="none"/>`);
    }
    for (const p of pts) {
      parts.push(`<circle cx="${px(p.x)}" cy="${px(p.y)}" r="2" fill="${s.model.color}"/>`);
    }
  }

  // Direct labels on the top-3 (by final point) + the worst.
  const byEnd = series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return { s, endX: x(last.day), y: y(last.score), score: last.score };
    })
    .sort((a, b) => b.score - a.score);
  const labelled = byEnd.length <= 4 ? byEnd : [...byEnd.slice(0, 3), byEnd[byEnd.length - 1]];
  spreadLabels(labelled, 12, T + 6, T + plotH - 2);
  for (const l of labelled) {
    parts.push(
      `<text x="${px(l.endX + 6)}" y="${px(l.y + 3)}" fill="${l.s.model.color}" font-size="10" font-weight="600">${esc(l.s.model.label)} ${Math.round(l.score)}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Skill by lead time">${parts.join('')}</svg>`;
}

// ── Yesterday's receipt: rain timing lanes ───────────────────────────────────

/**
 * When each model said it would rain vs when it actually rained. One lane per
 * model (winner-first), wet hours as segments — multiple showers a day render
 * as multiple segments — with the observed wet spells as a green band behind
 * every lane so timing lines up by eye. The winning model gets full emphasis;
 * the rest are faded.
 *
 * @param {NonNullable<ReturnType<import('./derive.js').buildReceipt>>['views']['rain']} view
 *   Totals (observedTotal, models[].total) are pre-converted to the display unit.
 * @param {string[]} hours  "HH:MM" labels for the observed hour axis.
 */
export function receiptRainChart(view, hours, { width = 560, rainUnit = 'mm', decimals = 1 } = {}) {
  const L = 44;
  const R = 60;
  const T = 6;
  const B = 22;
  const laneH = 24;
  const barH = 9;
  const lanes = 1 + view.models.length;
  const height = T + lanes * laneH + B;
  const plotW = width - L - R;
  const n = hours.length;
  const slot = plotW / Math.max(1, n);
  const x = (i) => L + i * slot;
  const laneMid = (k) => T + k * laneH + laneH / 2;

  const parts = [];

  // Observed wet spells as a band behind every lane.
  for (const seg of view.obsSegments) {
    parts.push(
      `<rect x="${px(x(seg.start))}" y="${T}" width="${px(Math.max(2, (seg.end - seg.start + 1) * slot))}" height="${lanes * laneH}" fill="${C.observedSoft}"/>`,
    );
  }

  // Hour ticks every 6 hours.
  for (let i = 0; i < n; i += 6) {
    parts.push(
      `<line x1="${px(x(i))}" x2="${px(x(i))}" y1="${T}" y2="${T + lanes * laneH + 3}" stroke="${C.grid}" stroke-width="0.5" opacity="0.55"/>`,
      `<text x="${px(x(i))}" y="${T + lanes * laneH + 14}" fill="${C.textMuted}" font-size="9" text-anchor="middle">${esc(hours[i])}</text>`,
    );
  }

  const spellTitle = (segs, who) =>
    segs
      .map((s) => `${hours[s.start]}–${hours[s.end]}`)
      .join(', ') + ` — ${who}`;

  const lane = (k, color, label, segs, total, { emphasis, bold, verdict, unit } = {}) => {
    const mid = laneMid(k);
    const opacity = emphasis ? 1 : 0.4;
    parts.push(
      `<text x="${L - 8}" y="${px(mid + 3)}" fill="${color}" font-size="10"${bold ? ' font-weight="700"' : ''} opacity="${emphasis ? 1 : 0.6}" text-anchor="end">${esc(label)}</text>`,
    );
    if (segs.length === 0) {
      parts.push(
        `<line x1="${L}" x2="${L + plotW}" y1="${px(mid)}" y2="${px(mid)}" stroke="${color}" stroke-width="1" stroke-dasharray="2 6" opacity="0.25"/>`,
      );
    }
    for (const seg of segs) {
      parts.push(
        `<rect x="${px(x(seg.start))}" y="${px(mid - barH / 2)}" width="${px(Math.max(2, (seg.end - seg.start + 1) * slot))}" height="${barH}" rx="2" fill="${color}" opacity="${opacity}">` +
        `<title>${esc(spellTitle(segs, label))}</title></rect>`,
      );
    }
    parts.push(
      `<text x="${L + plotW + 8}" y="${px(mid + 3)}" fill="${color}" font-size="10" font-family="ui-monospace,monospace" opacity="${emphasis ? 1 : 0.6}">${total.toFixed(decimals)}${unit ? ` ${unit}` : ''}</text>`,
    );
    if (verdict != null) {
      parts.push(
        `<text x="${width - 6}" y="${px(mid + 3)}" fill="${verdict ? '#3ddc97' : '#f4647d'}" font-size="10" text-anchor="end" opacity="${emphasis ? 1 : 0.7}">${verdict ? '✓' : '✕'}</text>`,
      );
    }
  };

  lane(0, C.observed, 'obs', view.obsSegments, view.observedTotal, { emphasis: true, bold: true, unit: rainUnit });
  parts.push(
    `<line x1="${L}" x2="${L + plotW}" y1="${px(T + laneH)}" y2="${px(T + laneH)}" stroke="${C.grid}" stroke-width="0.5" opacity="0.6"/>`,
  );
  view.models.forEach((m, i) => {
    lane(i + 1, m.model.color, m.model.label, m.segments, m.total, {
      emphasis: i === 0,
      verdict: m.correct,
    });
  });

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="When each model predicted rain vs when it rained">${parts.join('')}</svg>`;
}

// ── Yesterday's receipt: temperature/wind hourly lines ───────────────────────

/** Split a nullable series into runs of chart points (gaps stay gaps). */
function nonNullRuns(series, x, y) {
  const runs = [];
  let run = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i] == null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push({ x: x(i), y: y(series[i]) });
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Every model's D-1 hourly series vs observed for one day. The winning model
 * (lowest MAE, first in view.models) is drawn full-strength on top; the rest
 * are faded.
 *
 * @param {{observed:Array<number|null>, models:Array<{model:Object, series:Array<number|null>}>}} view
 * @param {string[]} hours
 * @param {string} unit  Axis-tick suffix ("°" or "").
 */
export function receiptLineChart(view, hours, unit, { width = 560, height = 220 } = {}) {
  const L = 38;
  const R = 64;
  const T = 12;
  const B = 24;
  const plotW = width - L - R;
  const plotH = height - T - B;
  const n = hours.length;
  const all = [view.observed, ...view.models.map((m) => m.series)]
    .flat()
    .filter((v) => v != null);
  let lo = Math.floor(Math.min(...all) - 1);
  const hi = Math.ceil(Math.max(...all) + 1);
  if (Math.min(...all) >= 0) lo = Math.max(0, lo);
  const x = (i) => L + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * plotH;

  const parts = [];
  const span = hi - lo;
  const step = [1, 2, 5, 10, 20, 50].find((s) => span / s <= 6) ?? 100;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    parts.push(
      `<line x1="${L}" x2="${L + plotW}" y1="${px(y(v))}" y2="${px(y(v))}" stroke="${C.grid}" stroke-width="0.5" stroke-dasharray="2 4"/>`,
      `<text x="${L - 5}" y="${px(y(v) + 3)}" fill="${C.textMuted}" font-size="9" text-anchor="end">${v}${esc(unit)}</text>`,
    );
  }
  for (let i = 0; i < n; i += 6) {
    parts.push(
      `<text x="${px(x(i))}" y="${T + plotH + 15}" fill="${C.textMuted}" font-size="9" text-anchor="middle">${esc(hours[i])}</text>`,
    );
  }

  // Faded field first, winner on top, observed green above everything.
  const drawSeries = (series, color, w, opacity) => {
    for (const run of nonNullRuns(series, x, y)) {
      parts.push(
        `<path d="${run.length > 1 ? monotonePath(run) : polyline(run)}" stroke="${color}" stroke-width="${w}" fill="none" opacity="${opacity}"/>`,
      );
    }
  };
  for (let i = view.models.length - 1; i >= 1; i--) {
    drawSeries(view.models[i].series, view.models[i].model.color, 1.4, 0.35);
  }
  if (view.models.length > 0) {
    drawSeries(view.models[0].series, view.models[0].model.color, 2, 1);
  }
  drawSeries(view.observed, C.observed, 2, 1);

  // Right-edge labels at each line's last value.
  const lastAt = (series) => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i];
    return null;
  };
  const labels = [];
  const obsEnd = lastAt(view.observed);
  if (obsEnd != null) labels.push({ text: 'obs', color: C.observed, y: y(obsEnd), bold: true, opacity: 1 });
  view.models.forEach((m, i) => {
    const end = lastAt(m.series);
    if (end == null) return;
    labels.push({
      text: m.model.label,
      color: m.model.color,
      y: y(end),
      bold: i === 0,
      opacity: i === 0 ? 1 : 0.55,
    });
  });
  spreadLabels(labels, 11, T + 4, T + plotH);
  for (const l of labels) {
    parts.push(
      `<text x="${L + plotW + 6}" y="${px(l.y + 3)}" fill="${l.color}" font-size="10"${l.bold ? ' font-weight="700"' : ''} opacity="${l.opacity}">${esc(l.text)}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly D-1 forecasts vs observed">${parts.join('')}</svg>`;
}

// ── Ghost chart (lab row: one model vs observed, hourly temperature) ─────────

export function ghostChart(ghost, { width = 620, height = 190 } = {}) {
  const L = 34;
  const R = 10;
  const T = 12;
  const B = 22;
  const plotW = width - L - R;
  const plotH = height - T - B;
  const n = ghost.times.length;
  const all = [...ghost.truth, ...ghost.pred];
  const lo = Math.floor(Math.min(...all) - 1);
  const hi = Math.ceil(Math.max(...all) + 1);
  const x = (i) => L + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (t) => T + (1 - (t - lo) / (hi - lo)) * plotH;

  const parts = [];
  const span = hi - lo;
  const step = span > 20 ? 10 : span > 8 ? 5 : 2;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    parts.push(
      `<line x1="${L}" x2="${L + plotW}" y1="${px(y(t))}" y2="${px(y(t))}" stroke="${C.grid}" stroke-width="0.5" stroke-dasharray="2 4"/>`,
      `<text x="${L - 5}" y="${px(y(t) + 3)}" fill="${C.textMuted}" font-size="9" text-anchor="end">${t}°</text>`,
    );
  }
  // Date ticks at local midnights, labelled every other day.
  let dayCount = 0;
  for (let i = 1; i < n; i++) {
    if (ghost.times[i].slice(11, 13) === '00') {
      dayCount += 1;
      parts.push(
        `<line x1="${px(x(i))}" x2="${px(x(i))}" y1="${T}" y2="${T + plotH}" stroke="${C.grid}" stroke-width="0.5" opacity="0.5"/>`,
      );
      if (dayCount % 2 === 1) {
        parts.push(
          `<text x="${px(x(i) + 3)}" y="${T + plotH + 14}" fill="${C.textMuted}" font-size="9">${esc(ghost.times[i].slice(5, 10))}</text>`,
        );
      }
    }
  }

  const truthPts = ghost.truth.map((t, i) => ({ x: x(i), y: y(t) }));
  const predPts = ghost.pred.map((t, i) => ({ x: x(i), y: y(t) }));
  parts.push(
    `<path d="${polyline(predPts)}" stroke="${C.pastRun}" stroke-width="1.4" fill="none" opacity="0.9"/>`,
    `<path d="${polyline(truthPts)}" stroke="${C.observed}" stroke-width="1.6" fill="none"/>`,
  );

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Forecast vs observed temperature">${parts.join('')}</svg>`;
}

// ── Long-term trend (history.html: skill / error over calendar months) ───────

/**
 * A y-axis snapped to a round step, like zoomAxis but without the 0–100 clamp,
 * so it also frames un-bounded error metrics (RMSE). Floors at 0 (scores and
 * errors are both non-negative); an optional ceiling caps scores at 100.
 * @param {number[]} values
 */
function trendAxis(values, { ceil = null, target = 4 } = {}) {
  if (values.length === 0) return { lo: 0, hi: 1, ticks: [0, 1] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, (max || 1) * 0.05);
  const rawLo = Math.max(0, min - pad);
  const rawHi = ceil != null ? Math.min(ceil, max + pad) : max + pad;
  const span = rawHi - rawLo || 1;
  const rawStep = span / target;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.max(0, Math.floor(rawLo / step) * step);
  const hi = (ceil != null ? Math.min(ceil, Math.ceil(rawHi / step) * step) : Math.ceil(rawHi / step) * step);
  const ticks = [];
  for (let t = lo; t <= hi + step * 1e-6; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { lo, hi, ticks };
}

const lastNonNull = (series) => {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return { i, v: series[i] };
  return null;
};

/**
 * One line per model over a shared calendar-month axis. Each series carries a
 * `monthly` array (noisy, drawn faint) and a `rolling` array (the trailing
 * 12-month mean, drawn bold) aligned to `months`. Models with too little
 * history to smooth (rolling all null) fall back to prominent monthly dots.
 *
 * @param {Array<{model:Object, monthly:Array<number|null>, rolling:Array<number|null>}>} seriesList
 * @param {string[]} months  "YYYY-MM", ascending — the shared x axis.
 * @param {{unit?:string, ceil?:number|null, lowerBetter?:boolean, caption?:string, width?:number, height?:number}} opts
 */
export function trendChart(seriesList, months, opts = {}) {
  const { unit = '', ceil = null, lowerBetter = false, caption = '', width = 720, height = 340 } = opts;
  const L = 40;
  const R = 78;
  const T = 22;
  const B = 26;
  const plotW = width - L - R;
  const plotH = height - T - B;
  const n = months.length;

  const allValues = seriesList.flatMap((s) => [...s.monthly, ...s.rolling]).filter((v) => v != null);
  const { lo, hi, ticks } = trendAxis(allValues, { ceil });
  const x = (i) => L + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * plotH;
  const fmt = (v) => (unit === '' ? Math.round(v) : v.toFixed(1));

  const parts = [];

  // Horizontal gridlines + value labels.
  for (const tick of ticks) {
    parts.push(
      `<line x1="${L}" x2="${L + plotW}" y1="${px(y(tick))}" y2="${px(y(tick))}" stroke="${C.grid}" stroke-width="0.5" stroke-dasharray="2 4"/>`,
      `<text x="${L - 6}" y="${px(y(tick) + 3)}" fill="${C.textMuted}" font-size="9" text-anchor="end">${fmt(tick)}</text>`,
    );
  }

  // Vertical year gridlines at each January (and the first month).
  for (let i = 0; i < n; i++) {
    const isJan = months[i].slice(5) === '01';
    if (!isJan && i !== 0) continue;
    parts.push(
      `<line x1="${px(x(i))}" x2="${px(x(i))}" y1="${T}" y2="${T + plotH}" stroke="${C.grid}" stroke-width="0.5" opacity="0.4"/>`,
      `<text x="${px(x(i))}" y="${T + plotH + 16}" fill="${C.textMuted}" font-size="9" text-anchor="middle">${months[i].slice(0, 4)}</text>`,
    );
  }

  // Axis caption (unit + direction) top-left.
  if (caption) {
    parts.push(
      `<text x="${L}" y="${T - 9}" fill="${C.textSecondary}" font-size="10">${esc(caption)}${lowerBetter ? ' · lower is better' : ' · higher is better'}</text>`,
    );
  }

  // Faint monthly lines + dots behind, bold rolling lines on top.
  for (const s of seriesList) {
    for (const run of nonNullRuns(s.monthly, x, y)) {
      parts.push(
        `<path d="${run.length > 1 ? monotonePath(run) : polyline(run)}" stroke="${s.model.color}" stroke-width="1" fill="none" opacity="0.28"/>`,
      );
    }
    const hasRolling = s.rolling.some((v) => v != null);
    for (let i = 0; i < n; i++) {
      if (s.monthly[i] == null) continue;
      parts.push(
        `<circle cx="${px(x(i))}" cy="${px(y(s.monthly[i]))}" r="${hasRolling ? 1.4 : 2}" fill="${s.model.color}" opacity="${hasRolling ? 0.32 : 0.85}"/>`,
      );
    }
  }
  for (const s of seriesList) {
    for (const run of nonNullRuns(s.rolling, x, y)) {
      parts.push(
        `<path d="${run.length > 1 ? monotonePath(run) : polyline(run)}" stroke="${s.model.color}" stroke-width="2.2" fill="none"/>`,
      );
    }
  }

  // Right-edge direct labels at each model's last rolling value (or last monthly).
  const labels = [];
  for (const s of seriesList) {
    const end = lastNonNull(s.rolling) ?? lastNonNull(s.monthly);
    if (!end) continue;
    labels.push({ text: s.model.label, color: s.model.color, y: y(end.v), value: end.v });
  }
  spreadLabels(labels, 12, T + 4, T + plotH);
  for (const l of labels) {
    parts.push(
      `<text x="${L + plotW + 6}" y="${px(l.y + 3)}" fill="${l.color}" font-size="10" font-weight="600">${esc(l.text)} ${fmt(l.value)}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Model ${lowerBetter ? 'error' : 'skill'} over time">${parts.join('')}</svg>`;
}

// ── Year-over-year overlay (history.html: one line per calendar year) ────────

/**
 * Ordinal single-hue ramp for year lines, dim → bright = oldest → newest.
 * Validated against the card surface #0b101c (monotone lightness, ΔL ≥ 0.06
 * per step, dim end ≥ 2:1 contrast, single hue ~262°). The newest year always
 * takes the brightest step, so short archives use the bright end of the ramp.
 */
const YEAR_RAMP = ['#2c56a8', '#3f6bbf', '#5381d6', '#6796ee', '#85aef9', '#a7c5fa', '#c9dcfc'];

export function yearColor(i, n) {
  return YEAR_RAMP[Math.max(0, YEAR_RAMP.length - n + i)];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One line per calendar year on a fixed Jan–Dec axis, for a single model.
 * Stacking the years vertically aligns the seasonal cycle, so a recent year
 * drifting worse reads as a bright line riding above (errors) or below
 * (skill) the dim older stack — no smoothing needed to cancel seasonality.
 * The newest year is drawn bold; every point carries a native tooltip.
 *
 * @param {Array<{year:number, values:Array<number|null>}>} yearsList
 *   Ascending years; `values` has 12 slots (Jan..Dec), null = no data.
 * @param {{unit?:string, ceil?:number|null, lowerBetter?:boolean, caption?:string, width?:number, height?:number}} opts
 */
export function yearOverlayChart(yearsList, opts = {}) {
  const { unit = '', ceil = null, lowerBetter = false, caption = '', width = 720, height = 340 } = opts;
  const L = 40;
  const R = 78;
  const T = 22;
  const B = 26;
  const plotW = width - L - R;
  const plotH = height - T - B;

  const allValues = yearsList.flatMap((s) => s.values).filter((v) => v != null);
  const { lo, hi, ticks } = trendAxis(allValues, { ceil });
  const x = (m) => L + (m / 11) * plotW;
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * plotH;
  const fmt = (v) => (unit === '' ? Math.round(v) : v.toFixed(1));

  const parts = [];

  for (const tick of ticks) {
    parts.push(
      `<line x1="${L}" x2="${L + plotW}" y1="${px(y(tick))}" y2="${px(y(tick))}" stroke="${C.grid}" stroke-width="0.5" stroke-dasharray="2 4"/>`,
      `<text x="${L - 6}" y="${px(y(tick) + 3)}" fill="${C.textMuted}" font-size="9" text-anchor="end">${fmt(tick)}</text>`,
    );
  }
  for (let m = 0; m < 12; m++) {
    parts.push(
      `<line x1="${px(x(m))}" x2="${px(x(m))}" y1="${T}" y2="${T + plotH}" stroke="${C.grid}" stroke-width="0.5" opacity="0.3"/>`,
      `<text x="${px(x(m))}" y="${T + plotH + 16}" fill="${C.textMuted}" font-size="9" text-anchor="middle">${MONTH_NAMES[m]}</text>`,
    );
  }
  if (caption) {
    parts.push(
      `<text x="${L}" y="${T - 9}" fill="${C.textSecondary}" font-size="10">${esc(caption)}${lowerBetter ? ' · lower is better' : ' · higher is better'}</text>`,
    );
  }

  // Dim older years first, the newest bold on top.
  const n = yearsList.length;
  yearsList.forEach((s, k) => {
    const newest = k === n - 1;
    const color = yearColor(k, n);
    for (const run of nonNullRuns(s.values, x, y)) {
      parts.push(
        `<path d="${run.length > 1 ? monotonePath(run) : polyline(run)}" stroke="${color}" stroke-width="${newest ? 2.4 : 1.5}" fill="none" opacity="${newest ? 1 : 0.85}"/>`,
      );
    }
    for (let m = 0; m < 12; m++) {
      if (s.values[m] == null) continue;
      parts.push(
        `<circle cx="${px(x(m))}" cy="${px(y(s.values[m]))}" r="${newest ? 2.4 : 1.8}" fill="${color}">` +
        `<title>${MONTH_NAMES[m]} ${s.year} · ${fmt(s.values[m])}${unit ? ` ${esc(unit)}` : ''}</title></circle>`,
      );
    }
  });

  // Right-edge direct labels at each year's last value.
  const labels = [];
  yearsList.forEach((s, k) => {
    const end = lastNonNull(s.values);
    if (!end) return;
    labels.push({ text: String(s.year), color: yearColor(k, n), y: y(end.v), value: end.v, bold: k === n - 1 });
  });
  spreadLabels(labels, 12, T + 4, T + plotH);
  for (const l of labels) {
    parts.push(
      `<text x="${L + plotW + 6}" y="${px(l.y + 3)}" fill="${l.color}" font-size="10"${l.bold ? ' font-weight="700"' : ' font-weight="600"'}>${l.text} ${fmt(l.value)}</text>`,
    );
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Model ${lowerBetter ? 'error' : 'skill'} by calendar year">${parts.join('')}</svg>`;
}

// ── Skill vs field median by lead (lab row mini chart) ───────────────────────

export function medianChart(points, color, { width = 280, height = 150 } = {}) {
  const L = 28;
  const R = 10;
  const T = 10;
  const B = 22;
  const plotW = width - L - R;
  const plotH = height - T - B;
  const x = (day) => L + ((day - 1) / 6) * plotW;
  const y = (score) => T + (1 - score / 100) * plotH;

  const parts = [];
  for (const tick of [0, 50, 100]) {
    parts.push(
      `<line x1="${L}" x2="${L + plotW}" y1="${px(y(tick))}" y2="${px(y(tick))}" stroke="${C.grid}" stroke-width="0.5"${tick === 50 ? ' stroke-dasharray="2 4"' : ''}/>`,
      `<text x="${L - 5}" y="${px(y(tick) + 3)}" fill="${C.textMuted}" font-size="8" text-anchor="end">${tick}</text>`,
    );
  }
  for (const day of [1, 3, 5, 7]) {
    parts.push(
      `<text x="${px(x(day))}" y="${T + plotH + 13}" fill="${C.textMuted}" font-size="8" text-anchor="middle">${day}d</text>`,
    );
  }
  const med = points.filter((p) => p.median != null).map((p) => ({ x: x(p.day), y: y(p.median) }));
  const own = points.map((p) => ({ x: x(p.day), y: y(p.score) }));
  if (med.length >= 2) {
    parts.push(`<path d="${monotonePath(med)}" stroke="${C.textMuted}" stroke-width="1.4" stroke-dasharray="3 3" fill="none"/>`);
  }
  if (own.length >= 2) {
    parts.push(`<path d="${monotonePath(own)}" stroke="${color}" stroke-width="2" fill="none"/>`);
  }
  for (const p of own) parts.push(`<circle cx="${px(p.x)}" cy="${px(p.y)}" r="2" fill="${color}"/>`);

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Skill vs field median by lead time">${parts.join('')}</svg>`;
}
