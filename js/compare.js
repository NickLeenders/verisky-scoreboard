/** Verify's daily Compare readouts, adapted to the scoreboard's day-bucket archive. */
import { LEAD_DAYS } from './config.js';
import { receiptRainChart } from './charts.js';
import { asTemp, asWind, asRain, tempUnit, windUnit, rainUnit, rainDecimals } from './units.js';

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const finite = Number.isFinite;
const MAX_MODELS = 5;
const max = (values) => {
  const valid = values.filter(finite);
  return valid.length >= 20 ? Math.max(...valid) : null;
};
const wet = (values) => values.flatMap((v, i) => finite(v) && v >= 0.2 ? [i] : []);
const segments = (indices) => {
  const result = [];
  for (const i of indices) {
    const last = result.at(-1);
    if (last && last.end === i - 1) last.end = i;
    else result.push({ start: i, end: i });
  }
  return result;
};

// Same wet-hour union and ±1 hour matching as VeriSky's rainDisagreement.
export function rainTiming(predicted, observed) {
  const union = new Set([...predicted, ...observed]);
  if (!union.size) return 1;
  const near = (hour, others) => others.some((other) => Math.abs(hour - other) <= 1);
  let misses = 0;
  for (const hour of union) {
    if (!near(hour, predicted) || !near(hour, observed)) misses++;
  }
  return 1 - misses / union.size;
}

export function buildComparison(aligned, dateKey, leadDay, modelIds) {
  if (!aligned.scoredDates.includes(dateKey) || !LEAD_DAYS.includes(leadDay)) return null;
  // Keep missing hours in their actual clock positions, never compress a gap.
  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const truth = new Map(aligned.truthHours.filter((r) => r.dateKey === dateKey).map((r) => [r.time, r]));
  const observed = hours.map((h) => truth.get(`${dateKey}T${h}`));
  const obsRain = observed.map((r) => r?.precipitation);
  const observedWet = wet(obsRain);
  const rain = obsRain.every(finite) ? {
    observedTotal: obsRain.reduce((a, b) => a + b, 0),
    obsSegments: segments(observedWet), models: [],
  } : null;
  const models = aligned.roster.filter((m) => modelIds.includes(m.id)).map((model) => {
    const pairs = new Map((aligned.pairs[model.id]?.[leadDay] ?? [])
      .filter((r) => r.dateKey === dateKey).map((r) => [r.time, r.pred]));
    const pred = hours.map((h) => pairs.get(`${dateKey}T${h}`));
    const precipitation = pred.map((r) => r?.precipitation);
    if (rain && precipitation.every(finite)) {
      const predictedWet = wet(precipitation);
      const timing = rainTiming(predictedWet, observedWet);
      rain.models.push({ model, segments: segments(predictedWet),
        total: precipitation.reduce((a, b) => a + b, 0), timing, correct: timing >= 0.5 });
    }
    return { model, temperature: max(pred.map((r) => r?.temperature)), wind: max(pred.map((r) => r?.wind)) };
  });
  rain?.models.sort((a, b) => b.timing - a.timing);
  return { dateKey, leadDay, hours, models, rain,
    observed: { temperature: max(observed.map((r) => r?.temperature)), wind: max(observed.map((r) => r?.wind)) } };
}

/** One shared scale, grouped equal values, and staggered labels like Verify. */
export function valueStrip(items, observed, { unit, minSpan, width = 560 }) {
  const valid = items.filter((item) => finite(item.value));
  if (!valid.length) return '<p class="empty">No forecast data at this lead.</p>';
  const values = valid.map((item) => item.value).concat(finite(observed) ? [observed] : []);
  const low = Math.min(...values), high = Math.max(...values);
  const span = Math.max(minSpan, high - low) * 1.3;
  const lo = (low + high - span) / 2;
  const hi = lo + span;
  const x = (v) => 50 + (v - lo) / span * (width - 100);
  const groups = [];
  for (const item of [...valid].sort((a, b) => a.value - b.value)) {
    const last = groups.at(-1);
    if (last?.value === item.value) last.members.push(item);
    else groups.push({ value: item.value, members: [item], tier: 0 });
  }
  for (const [i, group] of groups.entries()) {
    const near = groups.slice(0, i).filter((other) => x(group.value) - x(other.value) < 115);
    while (near.some((other) => other.tier === group.tier)) group.tier++;
  }
  const rowHeight = 35 + Math.max(...groups.map((g) => g.members.length)) * 12;
  const axisY = 20 + (1 + Math.max(...groups.map((g) => g.tier))) * rowHeight;
  const parts = [`<line x1="30" x2="${width - 30}" y1="${axisY}" y2="${axisY}" stroke="#334155" stroke-width="2"/>`];
  for (let i = 0; i < 5; i++) {
    const v = lo + (hi - lo) * i / 4;
    parts.push(`<text x="${x(v)}" y="${axisY + 23}" text-anchor="middle" fill="#94a3b8" font-size="11">${Math.round(v)}</text>`);
  }
  if (finite(observed)) parts.push(`<line x1="${x(observed)}" x2="${x(observed)}" y1="${axisY - 13}" y2="${axisY + 9}" stroke="#3ddc97" stroke-width="3"><title>Observed: ${observed} ${esc(unit)}</title></line>`);
  for (const group of groups) {
    const y = axisY - rowHeight - group.tier * rowHeight;
    const delta = finite(observed) ? group.value - observed : null;
    const miss = delta == null ? '' : delta === 0 ? ' · ±0' : ` · ${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
    parts.push(`<line x1="${x(group.value)}" x2="${x(group.value)}" y1="${y + 20 + group.members.length * 12}" y2="${axisY}" stroke="#64748b" opacity="0.5"/>`,
      `<text x="${x(group.value)}" y="${y}" text-anchor="middle" fill="#e2e8f0" font-size="19" font-weight="700">${group.value}<tspan font-size="11" fill="#94a3b8">${miss}</tspan></text>`);
    group.members.forEach((item, i) => {
      parts.push(`<text x="${x(group.value)}" y="${y + 15 + i * 12}" text-anchor="middle" fill="${esc(item.model.color)}" font-size="10">${esc(item.model.label)}</text>`,
        `<circle cx="${x(group.value) + (i - (group.members.length - 1) / 2) * 10}" cy="${axisY}" r="5" fill="${esc(item.model.color)}"/>`);
    });
  }
  return `<svg viewBox="0 0 ${width} ${axisY + 32}" role="img" aria-label="Forecast daily highs in ${esc(unit)} compared with observed">${parts.join('')}</svg>`;
}

let state = { date: null, lead: 1, models: null };
let lastRender = null;
let observer = null;
export function resetComparison() { state = { date: null, lead: 1, models: null }; lastRender = null; }

export function renderComparison(aligned, hasCommercialStandings = false) {
  const container = document.querySelector('#compare-body');
  lastRender = [aligned, hasCommercialStandings];
  if (!observer && typeof ResizeObserver !== 'undefined') {
    let previousWidth = container.clientWidth;
    observer = new ResizeObserver(() => {
      if (container.clientWidth === previousWidth) return;
      previousWidth = container.clientWidth;
      if (lastRender) renderComparison(...lastRender);
    });
    observer.observe(container);
  }
  const chartWidth = Math.max(280, container.clientWidth - 24);
  const dates = aligned.scoredDates;
  if (!dates.length) {
    container.innerHTML = '<p class="empty">No completed days available to compare.</p>';
    return;
  }
  if (!dates.includes(state.date)) state.date = dates.at(-1);
  const available = aligned.roster.filter((m) => Object.keys(aligned.pairs[m.id] ?? {}).length);
  state.models = (state.models ?? available.slice(0, 3).map((m) => m.id))
    .filter((id) => available.some((m) => m.id === id));
  const index = dates.indexOf(state.date);
  container.innerHTML = `<div class="compare-controls">
    <div class="compare-dates">
      <button type="button" data-step="-1" aria-label="Previous available day" ${index === 0 ? 'disabled' : ''}>‹</button>
      <label>Day <select class="compare-date">${[...dates].reverse().map((d) => `<option ${d === state.date ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
      <button type="button" data-step="1" aria-label="Next available day" ${index === dates.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <label>Forecast <select class="compare-lead">${LEAD_DAYS.map((lead) => `<option value="${lead}" ${state.lead === lead ? 'selected' : ''}>${lead} day${lead === 1 ? '' : 's'} ahead</option>`).join('')}</select></label>
  </div>
  <p class="compare-hint">Pick up to five models to compare.</p>
  <div class="compare-models" role="group" aria-label="Models to compare">${available.map((m) => {
    const selected = state.models.includes(m.id);
    return `<button type="button" data-model="${esc(m.id)}" aria-pressed="${selected}" ${!selected && state.models.length >= MAX_MODELS ? 'disabled' : ''}><span class="mdot" style="background:${esc(m.color)}"></span>${esc(m.label)}</button>`;
  }).join('')}</div>
  <div class="compare-readouts" aria-live="polite"></div>
  <p class="chart-caption">Previous-runs archive · green = observed analysis · local hours. ${hasCommercialStandings ? 'Commercial providers appear in aggregate scores only. ' : ''}Available days: ${esc(dates[0])} to ${esc(dates.at(-1))}.</p>`;
  const comparison = buildComparison(aligned, state.date, state.lead, state.models);
  const readouts = container.querySelector('.compare-readouts');
  if (!state.models.length) readouts.innerHTML = '<p class="empty">Pick a model above to compare its forecast.</p>';
  else {
    readouts.innerHTML = ['temperature', 'wind'].map((metric) => {
      const conv = metric === 'temperature' ? asTemp : asWind;
      const unit = metric === 'temperature' ? tempUnit() : windUnit();
      const obs = comparison.observed[metric] == null ? null : Math.round(conv(comparison.observed[metric]));
      return `<section class="compare-reading"><h3>Max ${metric} <span>${obs == null ? 'Observed unavailable' : `Observed ${obs} ${unit}`}</span></h3>${valueStrip(comparison.models.map((row) => ({ model: row.model, value: row[metric] == null ? null : Math.round(conv(row[metric])) })), obs, { unit, minSpan: metric === 'temperature' ? 6 : 10, width: chartWidth })}</section>`;
    }).join('');
    const rain = comparison.rain;
    readouts.innerHTML += `<section class="compare-reading"><h3>Rain timing <span>${rain ? `${asRain(rain.observedTotal).toFixed(rainDecimals())} ${rainUnit()} observed` : 'Observed unavailable'}</span></h3>${rain?.models.length ? receiptRainChart({ ...rain, observedTotal: asRain(rain.observedTotal), models: rain.models.map((m) => ({ ...m, total: asRain(m.total) })) }, comparison.hours, { rainUnit: rainUnit(), decimals: rainDecimals(), width: chartWidth }) : '<p class="empty">No complete rain data for this selection.</p>'}<p class="chart-caption">Bars = predicted rain · green bands = observed rain · ✓ = timing mostly matches within 1 hour.</p></section>`;
    const missing = comparison.models.filter((row) => row.temperature == null || row.wind == null || !rain?.models.some((m) => m.model.id === row.model.id));
    if (missing.length) readouts.innerHTML += `<p class="compare-hint">Some readings unavailable at this date and lead: ${missing.map((r) => esc(r.model.label)).join(', ')}.</p>`;
  }
  const redraw = (focusSelector) => {
    renderComparison(aligned, hasCommercialStandings);
    container.querySelector(focusSelector)?.focus();
  };
  container.querySelector('.compare-date').addEventListener('change', (e) => { state.date = e.target.value; redraw('.compare-date'); });
  container.querySelector('.compare-lead').addEventListener('change', (e) => { state.lead = Number(e.target.value); redraw('.compare-lead'); });
  for (const button of container.querySelectorAll('[data-step]')) button.addEventListener('click', () => {
    state.date = dates[index + Number(button.dataset.step)];
    redraw('.compare-date');
  });
  for (const button of container.querySelectorAll('[data-model]')) button.addEventListener('click', () => {
    const id = button.dataset.model;
    state.models = state.models.includes(id) ? state.models.filter((m) => m !== id) : [...state.models, id].slice(0, MAX_MODELS);
    redraw(`[data-model="${id}"]`);
  });
}
