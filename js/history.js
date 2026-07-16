/**
 * Long-term model-quality trends page (history.html).
 *
 * Loads the baked data/history/<city>.json (produced by
 * scripts/history-backfill.mjs) and renders one line per model over a calendar-
 * month axis, reusing charts.js's trendChart. Scoring stays metric in the baked
 * data; only the displayed RMSE for temperature/wind converts here via units.js.
 */

import { trendChart } from './charts.js';
import { HISTORY_CITIES } from './history-config.js';
import {
  asTempDelta, asWind, tempUnit, windUnit,
  unitSystem, setUnitSystem,
} from './units.js';

const DEFAULT_CITY = 'newyork';

const $ = (id) => document.getElementById(id);

// ── View metadata ─────────────────────────────────────────────────────────────
// kind 'score' → 0–100, higher better; kind 'error' → RMSE in display units, lower better.
const VARS = {
  combined: { label: 'Combined', kind: 'score', caption: 'Combined skill (0–100)' },
  temperature: { label: 'Temp', kind: 'error', conv: asTempDelta, unit: tempUnit, name: 'temperature RMSE' },
  rain: { label: 'Rain', kind: 'score', caption: 'Rain F1 (0–100)' },
  wind: { label: 'Wind', kind: 'error', conv: asWind, unit: windUnit, name: 'wind RMSE' },
};

const LEADS = ['all', 1, 2, 3, 4, 5, 6, 7];

const state = { variable: 'temperature', lead: 'all', smooth: 'trend' };
let DATA = null;

// ── Value extraction from the baked series ────────────────────────────────────
function combinedAtLead(s, k, i) {
  const L = s.leads[k];
  if (!L) return null;
  const vals = [L.t.score[i], L.r.f1[i], L.w.score[i]].filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function leadWeightedRmse(s, key, i) {
  let num = 0;
  let den = 0;
  for (const k of Object.keys(s.leads)) {
    const v = s.leads[k][key].rmse[i];
    if (v == null) continue;
    const w = 1 / Number(k);
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Value for one model series at month index i, in display space. */
function seriesValue(s, i) {
  const lead = state.lead;
  if (state.variable === 'combined') {
    // Combined mixes temp/rain/wind, but the rain & wind archives start ~2 years
    // after temperature — so a raw combined line would appear to "drop" the month
    // those harder variables join the average, which is not a real degradation.
    // Show combined only where the wind archive exists, keeping it comparable.
    if (s.metricSkill.wind[i] == null) return null;
    return lead === 'all' ? s.skill[i] : combinedAtLead(s, lead, i);
  }
  if (state.variable === 'rain') {
    return lead === 'all' ? s.metricSkill.rain[i] : (s.leads[lead]?.r.f1[i] ?? null);
  }
  const key = state.variable === 'temperature' ? 't' : 'w';
  const conv = VARS[state.variable].conv;
  const raw = lead === 'all' ? leadWeightedRmse(s, key, i) : (s.leads[lead]?.[key].rmse[i] ?? null);
  return conv(raw);
}

/** Trailing 12-month mean; needs ≥ 9 of 12 present, else a gap. */
function rolling12(arr) {
  return arr.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 11); j <= i; j++) {
      if (arr[j] != null) { sum += arr[j]; n += 1; }
    }
    return n >= 9 ? sum / n : null;
  });
}

// ── Headline (answers "did it degrade?") ──────────────────────────────────────
function meanOf(vals) {
  const v = vals.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function buildHeadline(seriesList) {
  const meta = VARS[state.variable];
  const isError = meta.kind === 'error';
  // Pick the model with the longest present history for the current view.
  let best = null;
  for (const s of seriesList) {
    const idx = s.monthly.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 12) continue;
    if (!best || idx.length > best.idx.length) best = { s, idx };
  }
  if (!best) return 'Not enough history yet in this view to call a trend.';

  const present = best.idx.map((i) => best.s.monthly[i]);
  const first = meanOf(present.slice(0, 12));
  const last = meanOf(present.slice(-12));
  const firstYear = DATA.months[best.idx[0]].slice(0, 4);
  const lastYear = DATA.months[best.idx[best.idx.length - 1]].slice(0, 4);
  const unit = isError ? ` ${meta.unit()}` : '';
  const fmt = (v) => (isError ? v.toFixed(1) : Math.round(v));
  const worse = isError ? last > first : last < first;
  const delta = Math.abs(last - first);
  const changed = isError ? delta >= 0.1 : delta >= 1;
  const dirWord = !changed ? 'held steady' : worse ? 'degraded' : 'improved';
  const dirClass = !changed ? '' : worse ? 'up' : 'down';
  const label = best.s.model.label;
  const what = isError ? `${state.variable} error` : `${meta.label.toLowerCase()} skill`;
  const leadWord = state.lead === 'all' ? 'all leads' : `${state.lead}-day lead`;
  return `<b>${label}</b>'s ${what} (${leadWord}) <span class="${dirClass}">${dirWord}</span> — `
    + `${fmt(first)} → ${fmt(last)}${unit} from ${firstYear} to ${lastYear}.`;
}

/**
 * Restrict the full-length month axis to the range [first, last] index that has
 * any value (raw monthly or smoothed rolling) across the given series, and slice
 * each series to match. Returns the trimmed months + series ready for trendChart.
 * If nothing has data, returns empty arrays. Indices stay aligned because both
 * `monthly` and `rolling` are built against DATA.months.
 */
function clipToData(seriesList) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of seriesList) {
    for (let i = 0; i < DATA.months.length; i++) {
      if (s.monthly[i] != null || s.rolling[i] != null) {
        if (i < lo) lo = i;
        if (i > hi) hi = i;
      }
    }
  }
  if (lo > hi) return { months: [], view: [] };
  return {
    months: DATA.months.slice(lo, hi + 1),
    view: seriesList.map((s) => ({
      model: s.model,
      monthly: s.monthly.slice(lo, hi + 1),
      rolling: s.rolling.slice(lo, hi + 1),
    })),
  };
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  const meta = VARS[state.variable];
  const isError = meta.kind === 'error';

  const seriesList = DATA.models.map((m) => {
    const s = DATA.series[m.id];
    const monthly = DATA.months.map((_, i) => seriesValue(s, i));
    const rolling = state.smooth === 'trend' ? rolling12(monthly) : monthly;
    return { model: m, monthly, rolling };
  });

  // Trim the month axis to the span that actually holds data in THIS view, so the
  // chart fills its plot instead of leaving empty years. Temperature reaches back
  // to 2021, but Combined/Rain/Wind have no archive before ~2024 — without this the
  // chart would draw a blank 2021–2023 gap on the left for those views.
  const { months, view } = clipToData(seriesList);

  const unit = isError ? meta.unit() : '';
  const caption = isError ? `${meta.name} (${unit})` : meta.caption;
  $('chart').innerHTML = trendChart(view, months, {
    unit,
    ceil: isError ? null : 100,
    lowerBetter: isError,
    caption,
  });

  // The header "window" label follows the visible span so it matches the chart.
  $('window-label').textContent = months.length
    ? `${DATA.city.name} · ${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}`
    : `${DATA.city.name} · no data`;

  $('headline').innerHTML = buildHeadline(seriesList);

  $('legend').innerHTML = DATA.models
    .map((m) => `<span><span class="dot" style="background:${m.color}"></span>${m.label} <span style="color:var(--text-3)">${m.provider}</span></span>`)
    .join('');

  const smoothNote = state.smooth === 'trend'
    ? 'Bold line: trailing 12-month average (cancels the seasonal cycle). Faint dots: raw monthly values.'
    : 'Each point is one calendar month (raw, unsmoothed).';
  const archiveNote = state.variable === 'temperature'
    ? 'Temperature reaches furthest back — the full previous-runs archive.'
    : 'Rain and wind archives begin ~2024, so these lines are shorter than temperature.';
  $('caption').textContent = `${caption}. ${smoothNote} ${archiveNote}`;
}

// ── Segmented-control builders ─────────────────────────────────────────────────
function buildTabs(host, items, getActive, onPick) {
  host.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    const on = getActive() === it.value;
    b.className = on ? 'active' : '';
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => { onPick(it.value); });
    host.appendChild(b);
  }
}

function onControlChange() {
  renderControls();
  if (DATA) render();
  syncUrl();
}

function renderControls() {
  buildTabs($('var-tabs'), Object.entries(VARS).map(([value, v]) => ({ value, label: v.label })),
    () => state.variable, (v) => { state.variable = v; onControlChange(); });
  buildTabs($('lead-tabs'), LEADS.map((v) => ({ value: v, label: v === 'all' ? 'All' : `D-${v}` })),
    () => state.lead, (v) => { state.lead = v; onControlChange(); });
  buildTabs($('smooth-tabs'), [{ value: 'trend', label: 'Trend' }, { value: 'monthly', label: 'Monthly' }],
    () => state.smooth, (v) => { state.smooth = v; onControlChange(); });
}

// ── Units ──────────────────────────────────────────────────────────────────────
function wireUnitToggle() {
  const toggle = $('unit-toggle');
  const sync = () => {
    for (const b of toggle.querySelectorAll('button')) {
      const on = b.dataset.units === unitSystem();
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setUnitSystem(b.dataset.units);
    sync();
    if (DATA) render(); // only temp/wind RMSE display changes; scores are unit-independent
  });
  sync();
}

// ── Boot ───────────────────────────────────────────────────────────────────────
function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
}

function applyStateFromUrl(params) {
  const v = params.get('v');
  if (v && VARS[v]) state.variable = v;
  const lead = params.get('lead');
  if (lead === 'all') state.lead = 'all';
  else if (lead != null && LEADS.includes(Number(lead))) state.lead = Number(lead);
  const smooth = params.get('smooth');
  if (smooth === 'trend' || smooth === 'monthly') state.smooth = smooth;
}

let currentCity = DEFAULT_CITY;

function populateCitySelect() {
  const sel = $('city-select');
  sel.innerHTML = '';
  for (const c of HISTORY_CITIES) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.value = currentCity;
  sel.addEventListener('change', () => { loadCity(sel.value); });
}

/** Reflect the current city + view state in the URL (shareable, no reload). */
function syncUrl() {
  const p = new URLSearchParams();
  if (currentCity !== DEFAULT_CITY) p.set('city', currentCity);
  if (state.variable !== 'temperature') p.set('v', state.variable);
  if (state.lead !== 'all') p.set('lead', String(state.lead));
  if (state.smooth !== 'trend') p.set('smooth', state.smooth);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

async function loadCity(cityId) {
  currentCity = cityId;
  $('city-select').value = cityId;
  syncUrl();
  try {
    const res = await fetch(`data/history/${cityId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    DATA = null;
    $('chart').innerHTML = `<p class="empty">Long-term history isn't baked yet for this city. Run <code>node scripts/history-backfill.mjs</code> to generate <code>data/history/${cityId}.json</code>.</p>`;
    $('headline').textContent = '';
    $('legend').innerHTML = '';
    $('caption').textContent = '';
    $('city-name').textContent = DATA?.city?.name ?? '';
    $('window-label').textContent = 'no data';
    return;
  }

  $('city-name').textContent = DATA.city.name;
  $('generated').textContent = DATA.generatedAt ? `baked ${DATA.generatedAt.slice(0, 10)} · ` : '';
  render(); // sets #window-label to match the visible (clipped) span
}

function boot() {
  wireUnitToggle();
  const params = new URLSearchParams(location.search);
  applyStateFromUrl(params);
  currentCity = params.get('city') || DEFAULT_CITY;
  populateCitySelect();
  renderControls();
  loadCity(currentCity);
}

boot();
