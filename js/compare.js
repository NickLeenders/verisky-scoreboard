/** Verify's daily Compare readouts, adapted to the scoreboard's day-bucket archive. */
import { LEAD_DAYS, COMMERCIAL_MODEL_CATALOG, siteSlug } from './config.js';
import { fetchPresetCompare } from './server-compare.js';
import { receiptRainChart } from './charts.js';
import { asTemp, asWind, asRain, tempUnit, windUnit, rainUnit, rainDecimals } from './units.js';

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const finite = Number.isFinite;
const MAX_MODELS = 5;
const max = (values, minimum = 20) => {
  const valid = values.filter(finite);
  return valid.length >= minimum && valid.length > 0 ? Math.max(...valid) : null;
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

export function buildComparison(aligned, dateKey, leadDay, modelIds, commercial = []) {
  const today = aligned.today?.dateKey === dateKey ? aligned.today : null;
  if ((!today && !aligned.scoredDates.includes(dateKey)) || !LEAD_DAYS.includes(leadDay)) return null;
  const source = today || aligned;
  const hourCount = today ? today.hourCount : 24;
  const high = (values) => max(values, today ? hourCount : 20);
  // Keep missing hours in their actual clock positions, never compress a gap.
  const hours = Array.from({ length: hourCount }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const truth = new Map(source.truthHours.filter((r) => r.dateKey === dateKey).map((r) => [r.time, r]));
  const observed = hours.map((h) => truth.get(`${dateKey}T${h}`));
  const obsRain = observed.map((r) => r?.precipitation);
  const observedWet = wet(obsRain);
  const rain = hourCount > 0 && obsRain.every(finite) ? {
    observedTotal: obsRain.reduce((a, b) => a + b, 0),
    obsSegments: segments(observedWet), models: [],
  } : null;
  const models = aligned.roster.filter((m) => modelIds.includes(m.id)).map((model) => {
    const pairs = new Map((source.pairs[model.id]?.[leadDay] ?? [])
      .filter((r) => r.dateKey === dateKey).map((r) => [r.time, r.pred]));
    const pred = hours.map((h) => pairs.get(`${dateKey}T${h}`));
    const precipitation = pred.map((r) => r?.precipitation);
    if (rain && precipitation.every(finite)) {
      const predictedWet = wet(precipitation);
      const timing = rainTiming(predictedWet, observedWet);
      rain.models.push({ model, segments: segments(predictedWet),
        total: precipitation.reduce((a, b) => a + b, 0), timing, correct: timing >= 0.5 });
    }
    return { model, temperature: high(pred.map((r) => r?.temperature)), wind: high(pred.map((r) => r?.wind)) };
  });
  for (const summary of commercial.filter((row) => modelIds.includes(row.model.id))) {
    const row = today ? { model: summary.model, temperature: null, wind: null, rain: null } : summary;
    models.push({ model: row.model, temperature: row.temperature, wind: row.wind });
    if (rain && row.rain) {
      const predictedWet = row.rain.segments.flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => start + i));
      const timing = rainTiming(predictedWet, observedWet);
      rain.models.push({ model: row.model, ...row.rain, timing, correct: timing >= 0.5 });
    }
  }
  rain?.models.sort((a, b) => b.timing - a.timing);
  return { dateKey, leadDay, hours, models, rain,
    observed: { temperature: high(observed.map((r) => r?.temperature)), wind: high(observed.map((r) => r?.wind)) } };
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

let state = { date: null, lead: 1, models: null, expanded: false };
let lastRender = null;
let observer = null;
let commercialRequest = 0;
let commercialState = { key: null, status: 'idle', models: [] };
export function resetComparison() {
  state = { date: null, lead: 1, models: null, expanded: false };
  lastRender = null;
  commercialRequest++;
  commercialState = { key: null, status: 'idle', models: [] };
}

/** Standings arrive in displayed rank order; only models with daily data qualify. */
export function selectComparisonModels(available, standings, selected = null) {
  const ids = new Set(available.map((m) => m.id));
  if (selected !== null) return selected.filter((id) => ids.has(id));
  return standings.filter((row) => finite(row.skill) && ids.has(row.model.id))
    .slice(0, 3).map((row) => row.model.id);
}

export function renderComparison(aligned, standings, city) {
  const container = document.querySelector('#compare-body');
  lastRender = [aligned, standings, city];
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
  const dates = [...aligned.scoredDates];
  if (aligned.today && !dates.includes(aligned.today.dateKey)) dates.push(aligned.today.dateKey);
  if (!dates.length) {
    container.innerHTML = '<p class="empty">No days available to compare.</p>';
    return;
  }
  if (!dates.includes(state.date)) state.date = dates.at(-1);
  const isToday = state.date === aligned.today?.dateKey;
  const slug = siteSlug(city);
  const commercialEnabled = slug && !isToday;
  const key = commercialEnabled ? `${slug}:${state.date}:${state.lead}` : null;
  if (key !== commercialState.key) {
    const request = ++commercialRequest;
    commercialState = { key, status: commercialEnabled ? 'loading' : 'idle', models: [] };
    if (commercialEnabled) fetchPresetCompare(city, state.date, state.lead).then((models) => {
      if (request !== commercialRequest) return;
      commercialState = { key, status: 'ready', models };
      if (lastRender) renderComparison(...lastRender);
    }).catch(() => {
      if (request !== commercialRequest) return;
      commercialState = { key, status: 'error', models: [] };
      if (lastRender) renderComparison(...lastRender);
    });
  }
  // Keep scored commercial models selectable when a date/lead has a run gap.
  // This also preserves manual picks while the next summary is loading.
  const commercial = slug ? COMMERCIAL_MODEL_CATALOG
    .filter((model) => standings.some((row) => row.model.id === model.id)
      || commercialState.models.some((row) => row.model.id === model.id))
    .map((model) => commercialState.models.find((row) => row.model.id === model.id)
      ?? { model, temperature: null, wind: null, rain: null }) : [];
  const available = [
    ...aligned.roster.filter((m) => [aligned.pairs, aligned.today?.pairs].some((pairs) => Object.values(pairs?.[m.id] ?? {}).some((rows) => rows.length))),
    ...commercial.map((row) => row.model),
  ];
  const modelScores = new Map(standings.map((row) => [row.model.id, finite(row.skill) ? row.skill : -1]));
  available.sort((a, b) => (modelScores.get(b.id) ?? -1) - (modelScores.get(a.id) ?? -1));
  const readings = buildComparison(aligned, state.date, state.lead, available.map((m) => m.id), commercial);
  const withDailyData = available.filter((model) => readings.models.some((row) => row.model.id === model.id
    && (row.temperature != null || row.wind != null)) || readings.rain?.models.some((row) => row.model.id === model.id));
  // Keep null until the user makes a pick, so fresh rankings update automatic picks.
  const selectedModels = selectComparisonModels(state.models === null ? withDailyData : available, standings, state.models);
  const index = dates.indexOf(state.date);
  container.innerHTML = `<div class="compare-controls">
    <div class="compare-dates">
      <button type="button" data-step="-1" aria-label="Previous available day" ${index === 0 ? 'disabled' : ''}>‹</button>
      <label>Day <select class="compare-date">${[...dates].reverse().map((d) => `<option value="${esc(d)}" ${d === state.date ? 'selected' : ''}>${d === aligned.today?.dateKey ? 'Today so far' : esc(d)}</option>`).join('')}</select></label>
      <button type="button" data-step="1" aria-label="Next available day" ${index === dates.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <label>Forecast <select class="compare-lead">${LEAD_DAYS.map((lead) => `<option value="${lead}" ${state.lead === lead ? 'selected' : ''}>${lead} day${lead === 1 ? '' : 's'} ahead</option>`).join('')}</select></label>
  </div>
  <div id="compare-models" class="compare-models" role="group" aria-label="Models to compare, highest score first">${available.map((m, i) => {
    const selected = selectedModels.includes(m.id);
    return `<button type="button" data-model="${esc(m.id)}" aria-pressed="${selected}" ${!state.expanded && i >= MAX_MODELS ? 'hidden' : ''} ${!selected && selectedModels.length >= MAX_MODELS ? 'disabled' : ''}><span class="mdot" style="background:${esc(m.color)}"></span>${esc(m.label)}</button>`;
  }).join('')}</div>
  ${available.length > MAX_MODELS ? `<button type="button" class="compare-models-toggle" aria-expanded="${state.expanded}" aria-controls="compare-models">View ${state.expanded ? 'less' : 'more'}</button>` : ''}
  ${isToday ? `<p class="compare-hint">Today so far · ${aligned.today.hourCount ? `00:00–${String(aligned.today.hourCount).padStart(2, '0')}:00 local, using completed hours available at the last update.` : 'No completed hours available yet.'} Forecasts and analysis cover the same hours.${slug ? ' Commercial summaries are available for completed days only.' : ''}</p>` : ''}
  <div class="compare-readouts" aria-live="polite"></div>
  <p class="chart-caption">Public models: previous-runs archive. ${commercialEnabled ? 'Commercial models: daily summaries from the archived run nearest 06:00 local on the issue day. ' : ''}Green = observed analysis · local hours. Available days: ${esc(dates[0])} to ${esc(dates.at(-1))}.</p>
  ${commercialState.status === 'loading' ? '<p class="compare-hint" role="status">Loading commercial models…</p>' : ''}
  ${commercialState.status === 'error' ? '<p class="compare-hint" role="status">Commercial comparison unavailable. <button type="button" class="compare-retry">Retry</button></p>' : ''}
  ${slug && commercialState.status === 'ready' && !commercialState.models.length ? '<p class="compare-hint">No commercial archive data for this day and lead.</p>' : ''}`;
  const comparison = { ...readings, models: readings.models.filter((row) => selectedModels.includes(row.model.id)),
    rain: readings.rain ? { ...readings.rain, models: readings.rain.models.filter((row) => selectedModels.includes(row.model.id)) } : null };
  const readouts = container.querySelector('.compare-readouts');
  if (!selectedModels.length) readouts.innerHTML = `<p class="empty">${isToday ? 'No readings available yet for the selected models.' : 'Pick a model above to compare its forecast.'}</p>`;
  else {
    const rain = comparison.rain;
    readouts.innerHTML = `<section class="compare-reading"><h3>Rain timing <span>${rain ? `${asRain(rain.observedTotal).toFixed(rainDecimals())} ${rainUnit()} observed` : 'Observed unavailable'}</span></h3>${rain?.models.length ? receiptRainChart({ ...rain, observedTotal: asRain(rain.observedTotal), models: rain.models.map((m) => ({ ...m, total: asRain(m.total) })) }, comparison.hours, { rainUnit: rainUnit(), decimals: rainDecimals(), width: chartWidth }) : '<p class="empty">No complete rain data for this selection.</p>'}<p class="chart-caption">Bars = predicted rain · green bands = observed rain · ✓ = timing mostly matches within 1 hour.</p></section>`;
    readouts.innerHTML += ['temperature', 'wind'].map((metric) => {
      const conv = metric === 'temperature' ? asTemp : asWind;
      const unit = metric === 'temperature' ? tempUnit() : windUnit();
      const obs = comparison.observed[metric] == null ? null : Math.round(conv(comparison.observed[metric]));
      return `<section class="compare-reading"><h3>Max ${metric}${isToday ? ' so far' : ''} <span>${obs == null ? 'Observed unavailable' : `Observed ${obs} ${unit}`}</span></h3>${valueStrip(comparison.models.map((row) => ({ model: row.model, value: row[metric] == null ? null : Math.round(conv(row[metric])) })), obs, { unit, minSpan: metric === 'temperature' ? 6 : 10, width: chartWidth })}</section>`;
    }).join('');
    const missing = comparison.models.filter((row) => row.temperature == null || row.wind == null || !rain?.models.some((m) => m.model.id === row.model.id));
    if (missing.length) readouts.innerHTML += `<p class="compare-hint">Some readings unavailable at this date and lead: ${missing.map((r) => esc(r.model.label)).join(', ')}.</p>`;
  }
  const redraw = (focusSelector) => {
    renderComparison(aligned, standings, city);
    container.querySelector(focusSelector)?.focus();
  };
  container.querySelector('.compare-models-toggle')?.addEventListener('click', () => {
    state.expanded = !state.expanded;
    redraw('.compare-models-toggle');
  });
  container.querySelector('.compare-date').addEventListener('change', (e) => { state.date = e.target.value; redraw('.compare-date'); });
  container.querySelector('.compare-lead').addEventListener('change', (e) => { state.lead = Number(e.target.value); redraw('.compare-lead'); });
  container.querySelector('.compare-retry')?.addEventListener('click', () => {
    commercialState.key = null;
    redraw('.compare-date');
  });
  for (const button of container.querySelectorAll('[data-step]')) button.addEventListener('click', () => {
    state.date = dates[index + Number(button.dataset.step)];
    redraw('.compare-date');
  });
  for (const button of container.querySelectorAll('[data-model]')) button.addEventListener('click', () => {
    const id = button.dataset.model;
    state.models = selectedModels.includes(id) ? selectedModels.filter((m) => m !== id) : [...selectedModels, id].slice(0, MAX_MODELS);
    redraw(`[data-model="${id}"]`);
  });
}
