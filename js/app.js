/**
 * Page assembly + render flow (plan.md §6, design locked in §8).
 *
 * Flow: skeleton is in the HTML → cached data (if any) renders instantly →
 * a network refresh (skipped entirely while the cache is fresh, §5) re-renders
 * in place. Sections fill in page order: standings table first, then the
 * receipt + lead-time two-up, then the other-calls strip.
 *
 * City search hits the Open-Meteo geocoding endpoint lazily — only when the
 * user types — and fetches forecast data only on selection.
 */

import { CITIES, DEFAULT_CITY_ID } from './config.js';
import { fetchCityData } from './fetch.js';
import { scorePayload } from './pipeline.js';
import { readCache, writeCache } from './cache.js';
import { readBaked } from './prebaked.js';
import { fetchPresetScoreboard } from './server-scoreboard.js';
import {
  scoreTone,
  buildStandings,
  buildReceipt,
  buildLeadSeries,
  buildGhost,
  buildMedianComparison,
  buildHabits,
  buildOtherCalls,
  LAB_LEADS,
} from './derive.js';
import { leadTimeChart, receiptRainChart, receiptLineChart, ghostChart, medianChart } from './charts.js';
import {
  unitSystem,
  setUnitSystem,
  asTemp,
  asTempDelta,
  asWind,
  asRain,
  windUnit,
  rainUnit,
  rainDecimals,
} from './units.js';

const GEOCODING_BASE = 'https://geocoding-api.open-meteo.com/v1/search';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);

const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
const fmtSigned = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);
// Rain amounts (mm/in) — converts to the active unit with unit-aware precision.
const fmtRain = (mm) => fmt(asRain(mm), rainDecimals());
const fmtRainSigned = (mm) => fmtSigned(asRain(mm), rainDecimals());

const $ = (sel) => document.querySelector(sel);

// ── City state ───────────────────────────────────────────────────────────────

function cityFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('city');
  if (id) {
    const preset = CITIES.find((c) => c.id === id);
    if (preset) return preset;
  }
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  const name = params.get('name');
  if (Number.isFinite(lat) && Number.isFinite(lon) && name) {
    // country (if present) keeps the country-aware roster (§1a) on a shared link.
    return { id: null, name, lat, lon, country: params.get('country') || undefined };
  }
  return CITIES.find((c) => c.id === DEFAULT_CITY_ID) ?? CITIES[0];
}

function urlForCity(city) {
  if (city.id) return `?city=${encodeURIComponent(city.id)}`;
  const country = city.country ? `&country=${encodeURIComponent(city.country)}` : '';
  return `?name=${encodeURIComponent(city.name)}&lat=${city.lat.toFixed(2)}&lon=${city.lon.toFixed(2)}${country}`;
}

let currentCity = null;
let loadToken = 0;
let lastRender = null; // { aligned, scores } for the lab panels
// ?lab=<modelId> deep link — captured at boot (loadCity rewrites the URL),
// consumed by the first render only.
let pendingLab = new URLSearchParams(location.search).get('lab');

// ── Load + render orchestration ──────────────────────────────────────────────

async function loadCity(city) {
  const token = ++loadToken;
  currentCity = city;
  history.replaceState(null, '', urlForCity(city));
  syncSelector(city);
  setStatus('loading');

  // Preset commercial scores come from a fixed-slug, aggregate-only endpoint.
  // Fetch them alongside the public data: this is a stored-snapshot DB read,
  // never a commercial-provider request or a scoring refresh.
  let presetBoard = null;
  let paintedResult = null;
  const paint = (result) => {
    paintedResult = result;
    render(city, { ...result, presetBoard });
  };
  const presetBoardPromise = fetchPresetScoreboard(city)
    .then((board) => {
      if (token !== loadToken || !board) return;
      presetBoard = board;
      if (paintedResult) paint(paintedResult);
    })
    .catch((error) => {
      // Public-model scoring remains useful if the optional server projection
      // is unavailable. Keep the failure visible to operators, not visitors.
      console.warn('Preset scoreboard unavailable:', error.message);
    });

  let seeded = false; // did cache or a baked snapshot already paint real numbers?
  const cached = readCache(city);
  if (cached) {
    paint(scorePayload(city, cached.payload));
    seeded = true;
    if (cached.fresh) {
      setStatus('fresh-cache');
      await presetBoardPromise;
      return;
    }
    setStatus('refreshing');
  } else {
    // No local cache. Prefer the server-baked snapshot (§7) as the first paint
    // so the page shows real numbers instantly — and leave the HTML's baked
    // standings block untouched until it (or the live fetch) resolves, rather
    // than flashing skeletons over it. Custom cities have no snapshot → skeletons.
    const baked = await readBaked(city);
    if (token !== loadToken) return;
    if (baked) {
      paint(scorePayload(city, baked));
      seeded = true;
      setStatus('baked');
    } else {
      showSkeletons();
    }
  }

  try {
    const { truth, predictions } = await fetchCityData(city);
    if (token !== loadToken) return; // user switched city mid-flight
    writeCache(city, { truth, predictions });
    paint(scorePayload(city, { truth, predictions }));
    setStatus('live');
  } catch (error) {
    if (token !== loadToken) return;
    if (seeded) {
      setStatus('stale', error.message); // keep the cache/baked render on screen
    } else {
      renderError(error);
      setStatus('error');
    }
  }
}

function setStatus(state, detail) {
  const el = $('#status');
  const text = {
    loading: 'fetching…',
    refreshing: 'updating in background…',
    'fresh-cache': 'cached · <6h old',
    baked: 'baked · refreshing…',
    live: 'live',
    stale: `refresh failed, showing saved data (${detail ?? ''})`,
    error: '',
  }[state] ?? '';
  el.textContent = text;
  el.className = `status status-${state}`;
}

function showSkeletons() {
  for (const id of ['standings-body', 'receipt-body', 'lead-body', 'calls-body']) {
    const el = document.getElementById(id);
    el.innerHTML = '<div class="skeleton"></div>'.repeat(id === 'standings-body' ? 4 : 3);
  }
}

function renderError(error) {
  $('#standings-body').innerHTML =
    `<p class="error">Couldn't load data: ${esc(error.message)} ` +
    `<button class="retry" type="button">Retry</button></p>`;
  $('#standings-body .retry').addEventListener('click', () => loadCity(currentCity));
  $('#receipt-body').innerHTML = '';
  $('#lead-body').innerHTML = '';
  $('#calls-body').innerHTML = '';
}

function render(city, { aligned, scores, timezone, presetBoard = null }) {
  lastRender = { city, aligned, scores, timezone, presetBoard };
  const dates = aligned.scoredDates;
  const shownDays = presetBoard?.scoredDays ?? dates.length;
  const shownTimezone = presetBoard?.timezone ?? timezone;
  $('#window-label').textContent =
    `last ${shownDays} days · all lead days · ${shownTimezone}`;

  // Page order per §6/§8: standings first…
  renderStandings(aligned, scores, presetBoard);
  if (pendingLab) {
    const tr = document.querySelector(`tr.standing[data-model="${CSS.escape(pendingLab)}"]`);
    pendingLab = null;
    if (tr) toggleLab(tr);
  }
  // …then charts on the next frame so the table paints immediately.
  requestAnimationFrame(() => {
    renderReceipt(aligned, presetBoard != null);
    renderLead(presetBoard?.scores ?? scores);
    renderCalls(aligned, scores, presetBoard != null);
  });
}

// Re-paint the current data in place — used when the unit system changes. The
// scores never move (they're unit-independent); only the displayed physical
// quantities do, so we just rebuild from the last render's data.
function rerender() {
  if (lastRender) render(lastRender.city, lastRender);
}

// ── Standings table ──────────────────────────────────────────────────────────

function renderStandings(aligned, scores, presetBoard) {
  const rows = presetBoard?.rows ?? buildStandings(aligned, scores);
  const shownScores = presetBoard?.scores ?? scores;
  const rainOff = !shownScores.rainEligibility.rainScoreEligible;

  const html = [`<table class="standings"><thead><tr>
    <th class="c-rank">#</th><th class="c-move" title="movement vs the standings a week ago (same window minus its last 7 days)"></th>
    <th>Model</th><th class="c-skill">Skill</th>
    <th class="c-metric">Temp</th><th class="c-metric">${rainOff ? 'Rain*' : 'Rain'}</th><th class="c-metric">Wind</th>
    <th class="c-record" title="correct next-day rain/no-rain calls over the window">Rain W–L</th>
    <th class="c-form" title="last 7 days · filled dot: next-day skill ≥ 70">Form</th>
  </tr></thead><tbody>`];

  for (const r of rows) {
    const canOpenLab = Object.values(aligned.pairs[r.model.id] ?? {})
      .some((pairs) => Array.isArray(pairs) && pairs.length > 0);
    const move =
      r.movement == null ? '<span class="move move-flat">—</span>'
        : r.movement > 0 ? `<span class="move move-up">▲${r.movement > 1 ? r.movement : ''}</span>`
          : r.movement < 0 ? `<span class="move move-down">▼${r.movement < -1 ? -r.movement : ''}</span>`
            : '<span class="move move-flat">—</span>';
    const dots = r.formDots
      .map((d) => `<span class="fdot fdot-${d}"></span>`)
      .join('');
    const metric = (v) =>
      `<td class="num c-metric tone-${scoreTone(v)}">${fmt(v)}</td>`;
    html.push(`<tr class="standing${canOpenLab ? '' : ' standing-static'}" data-model="${esc(r.model.id)}"
        data-lab="${canOpenLab ? '1' : '0'}"${canOpenLab
          ? ' tabindex="0" role="button" aria-expanded="false" title="click to open the lab"'
          : ''}>
      <td class="c-rank num">${r.rank}</td>
      <td class="c-move">${move}</td>
      <td class="c-model"><span class="mdot" style="background:${esc(r.model.color)}"></span>
        <span class="mlabel">${esc(r.model.label)}</span> <span class="mprov">${esc(r.model.provider)}</span></td>
      <td class="c-skill"><span class="num skill-num tone-${scoreTone(r.skill)}">${fmt(r.skill)}</span>
        <span class="bar"><span class="bar-fill tone-bg-${scoreTone(r.skill)}" style="width:${Math.max(2, r.skill ?? 0)}%"></span></span></td>
      ${metric(r.metricSkill.temperature)}${metric(r.metricSkill.rain)}${metric(r.metricSkill.wind)}
      <td class="num c-record">${r.rainRecord.wins}–${r.rainRecord.losses}</td>
      <td class="c-form">${dots}</td>
    </tr>${canOpenLab
      ? `\n    <tr class="lab-row" data-model="${esc(r.model.id)}" hidden><td colspan="9"><div class="lab"></div></td></tr>`
      : ''}`);
  }
  html.push('</tbody></table>');
  if (rainOff) {
    html.push(
      `<p class="foot-note">* rain not scored: the window was too dry for rain calls to mean anything ` +
      `(${shownScores.rainEligibility.rainEventHours} rain-event hours, ${fmtRain(shownScores.rainEligibility.rainEventTotalMm)} ${rainUnit()}).</p>`,
    );
  }
  const container = $('#standings-body');
  container.innerHTML = html.join('');

  for (const tr of container.querySelectorAll('tr.standing[data-lab="1"]')) {
    const toggle = () => toggleLab(tr);
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
}

// ── Lab panel (expands in place from a standings row) ────────────────────────

function toggleLab(tr) {
  const labRow = tr.nextElementSibling;
  const open = labRow.hidden;
  // Close any other open lab first — one lab at a time keeps the table readable.
  for (const other of tr.parentElement.querySelectorAll('tr.lab-row:not([hidden])')) {
    if (other !== labRow) {
      other.hidden = true;
      other.previousElementSibling.setAttribute('aria-expanded', 'false');
    }
  }
  labRow.hidden = !open;
  tr.setAttribute('aria-expanded', String(open));
  if (open && !labRow.dataset.built) {
    buildLabPanel(labRow, tr.dataset.model);
    labRow.dataset.built = '1';
  }
  // Keep the lab deep-link (?lab=<modelId>) in the URL shareable.
  const params = new URLSearchParams(location.search);
  if (open) params.set('lab', tr.dataset.model);
  else params.delete('lab');
  history.replaceState(null, '', `?${params}`);
}

function buildLabPanel(labRow, modelId) {
  const { aligned, scores } = lastRender;
  const model = aligned.roster.find((m) => m.id === modelId);
  const served = LAB_LEADS.filter((d) => aligned.pairs[modelId]?.[d]);
  const lab = labRow.querySelector('.lab');

  const habits = buildHabits(aligned, scores, modelId);
  const medianPts = buildMedianComparison(scores, modelId);

  lab.innerHTML = `
    <div class="lab-head">
      <span class="lab-title"><span class="mdot" style="background:${esc(model.color)}"></span>
        ${esc(model.label)} lab · forecast vs observed, last 14 days</span>
      <span class="lead-toggle" role="tablist">
        ${served.map((d) => `<button type="button" role="tab" data-lead="${d}"
          class="${d === served[0] ? 'active' : ''}">D-${d}</button>`).join('')}
      </span>
    </div>
    <div class="lab-grid">
      <div class="lab-ghost">
        <div class="ghost-chart"></div>
        <p class="chart-caption"><span class="key key-obs"></span> observed
          <span class="key key-ghost"></span> ${esc(model.label)}'s call (temperature)</p>
      </div>
      <div class="lab-side">
        <div class="median-chart">${medianChart(medianPts, model.color)}</div>
        <p class="chart-caption"><span class="key" style="background:${esc(model.color)}"></span> ${esc(model.label)}
          <span class="key key-median"></span> field median · skill by lead</p>
        ${habits.length > 0
          ? `<ul class="habits">${habits.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
          : '<p class="habits-none">no strong habits this window</p>'}
      </div>
    </div>`;

  const drawGhost = (lead) => {
    const ghost = buildGhost(aligned, modelId, lead);
    lab.querySelector('.ghost-chart').innerHTML = ghost
      ? ghostChart({ ...ghost, truth: ghost.truth.map(asTemp), pred: ghost.pred.map(asTemp) })
      : '<p class="empty">no data at this lead</p>';
  };
  drawGhost(served[0]);

  for (const btn of lab.querySelectorAll('.lead-toggle button')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't re-toggle the row
      for (const b of lab.querySelectorAll('.lead-toggle button')) b.classList.remove('active');
      btn.classList.add('active');
      drawGhost(Number(btn.dataset.lead));
    });
  }
  // Clicks inside the open lab shouldn't collapse it via the row handler.
  lab.addEventListener('click', (e) => e.stopPropagation());
}

// ── Yesterday's receipt ──────────────────────────────────────────────────────

const RECEIPT_TABS = [
  ['rain', 'Rain'],
  ['temperature', 'Temp'],
  ['wind', 'Wind'],
];

function renderReceipt(aligned, hasCommercialStandings = false) {
  const container = $('#receipt-body');
  const receipt = buildReceipt(aligned);
  if (!receipt) {
    container.innerHTML = '<p class="empty">No data for yesterday.</p>';
    $('#receipt-sub').textContent = '';
    return;
  }

  const tabs = RECEIPT_TABS.filter(([key]) => receipt.views[key]);
  container.innerHTML = `
    <div class="receipt-head">
      <span class="metric-tabs" role="tablist">
        ${tabs.map(([key, label]) => `<button type="button" role="tab" data-metric="${key}"
          class="${key === receipt.defaultMetric ? 'active' : ''}">${label}</button>`).join('')}
      </span>
    </div>
    <div class="receipt-chart"></div>
    <p class="chart-caption"></p>
    <div class="calls-grid"></div>`;

  const draw = (metric) => {
    const view = receipt.views[metric];
    const chartEl = container.querySelector('.receipt-chart');
    const capEl = container.querySelector('.chart-caption');
    const gridEl = container.querySelector('.calls-grid');

    if (metric === 'rain') {
      $('#receipt-sub').textContent =
        `${receipt.dateKey} · D-1 rain calls vs observed · ` +
        (view.rained
          ? `${fmtRain(view.observedTotal)} ${rainUnit()} fell${view.onset ? ` from ${view.onset}` : ''}`
          : 'stayed dry');
      const rview = {
        ...view,
        observedTotal: asRain(view.observedTotal),
        models: view.models.map((m) => ({ ...m, total: asRain(m.total) })),
      };
      chartEl.innerHTML = receiptRainChart(rview, receipt.hours, {
        rainUnit: rainUnit(),
        decimals: rainDecimals(),
      });
      capEl.innerHTML =
        `bars = hours each model called rain · <span class="key key-obs"></span> band = when it actually rained · ` +
        `brightest = best timing · ${rainUnit()} totals at right` +
        (hasCommercialStandings ? ' · raw-call view intentionally excludes commercial providers' : '');
      gridEl.innerHTML = view.models
        .map(
          (c, i) => `<div class="call ${c.correct ? 'call-win' : 'call-loss'}${i === 0 ? '' : ' call-dim'}">
            <span class="mdot" style="background:${esc(c.model.color)}"></span>
            <span class="call-label">${esc(c.model.label)}</span>
            <span class="num">${fmtRain(c.total)} ${rainUnit()}</span>
            <span class="num call-delta">${fmtRainSigned(c.delta)} ${rainUnit()}</span>
            <span class="call-verdict">${c.correct ? '✓' : '✕'}</span>
          </div>`,
        )
        .join('');
    } else {
      const isTemp = metric === 'temperature';
      // Absolute values (obsMax, hourly series) vs differences (mae, bias) use
      // different converters: temperature deltas scale without the +32 offset.
      const conv = isTemp ? asTemp : asWind;
      const dconv = isTemp ? asTempDelta : asWind;
      const unit = isTemp ? '°' : ` ${windUnit()}`;
      $('#receipt-sub').textContent =
        `${receipt.dateKey} · D-1 ${isTemp ? 'temperature' : 'wind'} vs observed · ` +
        (isTemp ? `high ${fmt(conv(view.obsMax), 1)}°` : `max ${fmt(conv(view.obsMax), 0)} ${windUnit()}`);
      const cview = {
        ...view,
        observed: view.observed.map(conv),
        models: view.models.map((m) => ({ ...m, series: m.series.map(conv) })),
      };
      chartEl.innerHTML = receiptLineChart(cview, receipt.hours, isTemp ? '°' : '');
      capEl.innerHTML =
        `hourly D-1 forecasts vs observed · brightest line = closest model · ` +
        `<span class="key key-obs"></span> observed · ± = mean hourly error, signed = bias` +
        (hasCommercialStandings ? ' · raw-call view intentionally excludes commercial providers' : '');
      gridEl.innerHTML = view.models
        .map(
          (c, i) => `<div class="call${i === 0 ? '' : ' call-dim'}">
            <span class="mdot" style="background:${esc(c.model.color)}"></span>
            <span class="call-label">${esc(c.model.label)}</span>
            <span class="num">±${fmt(dconv(c.mae), 1)}${esc(unit)}</span>
            <span class="num call-delta">${fmtSigned(dconv(c.bias), 1)}${esc(unit)}</span>
            <span class="call-verdict">${i === 0 ? '<span class="call-star">★</span>' : ''}</span>
          </div>`,
        )
        .join('');
    }
  };
  draw(receipt.defaultMetric);

  for (const btn of container.querySelectorAll('.metric-tabs button')) {
    btn.addEventListener('click', () => {
      for (const b of container.querySelectorAll('.metric-tabs button')) b.classList.remove('active');
      btn.classList.add('active');
      draw(btn.dataset.metric);
    });
  }
}

// ── Skill by lead time ───────────────────────────────────────────────────────

const LEAD_TABS = [
  ['all', 'Skill'],
  ['temperature', 'Temp'],
  ['rain', 'Rain'],
  ['wind', 'Wind'],
];

function renderLead(scores) {
  const container = $('#lead-body');
  const series = buildLeadSeries(scores);

  const legend = scores.roster.map(
    (m) => `<span class="legend-item"><span class="mdot" style="background:${esc(m.color)}"></span>${esc(m.label)}</span>`,
  ).join('');

  container.innerHTML = `
    <div class="lead-head">
      <span class="metric-tabs" role="tablist">
        ${LEAD_TABS.map(([key, label], i) => `<button type="button" role="tab" data-metric="${key}"
          class="${i === 0 ? 'active' : ''}">${label}</button>`).join('')}
      </span>
      <span class="legend">${legend}</span>
    </div>
    <div class="lead-chart"></div>
    <p class="chart-caption">the Skill column is the 1/d-weighted score from this curve,
      with a soft horizon adjustment. This chart is the receipt for the ranking.
      ICON's line stops at day 6 (its usable horizon).</p>`;

  const draw = (metric) => {
    const s = series[metric] ?? [];
    container.querySelector('.lead-chart').innerHTML =
      s.length > 0 ? leadTimeChart(s) : '<p class="empty">not scored this window</p>';
  };
  draw('all');

  for (const btn of container.querySelectorAll('.metric-tabs button')) {
    btn.addEventListener('click', () => {
      for (const b of container.querySelectorAll('.metric-tabs button')) b.classList.remove('active');
      btn.classList.add('active');
      draw(btn.dataset.metric);
    });
  }
}

// ── Other-calls strip ────────────────────────────────────────────────────────

function renderCalls(aligned, scores, hasCommercialStandings = false) {
  const container = $('#calls-body');
  const calls = buildOtherCalls(aligned, scores);
  if (!calls) {
    container.innerHTML = '';
    return;
  }
  const bits = [];
  if (calls.highTemp) {
    const { truthValue, best, worst } = calls.highTemp;
    bits.push(
      `<span class="call-bit"><span class="call-kind">high temp</span> ${fmt(asTemp(truthValue), 1)}° ·
        closest <b style="color:${esc(best.model.color)}">${esc(best.model.label)}</b> (${fmtSigned(asTempDelta(best.delta), 1)}°),
        worst ${esc(worst.model.label)} (${fmtSigned(asTempDelta(worst.delta), 1)}°)</span>`,
    );
  }
  if (calls.gust) {
    const { truthValue, best, worst } = calls.gust;
    bits.push(
      `<span class="call-bit"><span class="call-kind">wind max</span> ${fmt(asWind(truthValue), 0)} ${windUnit()} ·
        closest <b style="color:${esc(best.model.color)}">${esc(best.model.label)}</b> (${fmtSigned(asWind(best.delta), 0)}),
        worst ${esc(worst.model.label)} (${fmtSigned(asWind(worst.delta), 0)})</span>`,
    );
  }
  if (calls.streak) {
    bits.push(
      `<span class="call-bit"><span class="call-kind">streak</span>
        <b style="color:${esc(calls.streak.model.color)}">${esc(calls.streak.model.label)}</b>:
        ${calls.streak.run} straight correct rain calls</span>`,
    );
  }
  container.innerHTML = bits.length
    ? `<span class="call-date">yesterday's ${hasCommercialStandings ? 'public-model ' : ''}other calls</span> ${bits.join('<span class="call-sep">·</span>')}`
    : '';
}

// ── Top bar: city selector + geocoding search ────────────────────────────────

function syncSelector(city) {
  const select = $('#city-select');
  const custom = select.querySelector('option[value="__custom"]');
  if (city.id) {
    if (custom) custom.remove();
    select.value = city.id;
  } else {
    const opt = custom ?? document.createElement('option');
    opt.value = '__custom';
    opt.textContent = city.name;
    if (!custom) select.prepend(opt);
    select.value = '__custom';
  }
}

function initTopBar() {
  const select = $('#city-select');
  for (const c of CITIES) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const preset = CITIES.find((c) => c.id === select.value);
    if (preset) loadCity(preset);
  });

  const input = $('#city-search');
  const results = $('#search-results');
  let debounce = 0;
  let lastQuery = '';

  const closeResults = () => {
    results.hidden = true;
    results.innerHTML = '';
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(debounce);
    if (q.length < 2) {
      closeResults();
      return;
    }
    debounce = setTimeout(async () => {
      lastQuery = q;
      try {
        const res = await fetch(
          `${GEOCODING_BASE}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`,
        );
        const data = await res.json();
        if (q !== lastQuery) return;
        const hits = data.results ?? [];
        results.innerHTML = hits.length
          ? hits
              .map(
                (h, i) => `<li role="option" data-i="${i}">${esc(h.name)}<span class="geo-admin">
                  ${esc([h.admin1, h.country_code].filter(Boolean).join(', '))}</span></li>`,
              )
              .join('')
          : '<li class="geo-none">no matches</li>';
        results.hidden = false;
        for (const li of results.querySelectorAll('li[data-i]')) {
          li.addEventListener('click', () => {
            const h = hits[Number(li.dataset.i)];
            input.value = '';
            closeResults();
            // country_code drives the country-aware roster (§1a).
            loadCity({ id: null, name: h.name, lat: h.latitude, lon: h.longitude, country: h.country_code });
          });
        }
      } catch {
        results.innerHTML = '<li class="geo-none">search unavailable</li>';
        results.hidden = false;
      }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector('li[data-i]');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      closeResults();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closeResults();
  });
}

// ── Units toggle (metric ⇄ imperial) ─────────────────────────────────────────

function initUnitToggle() {
  const group = $('#unit-toggle');
  if (!group) return;
  const buttons = [...group.querySelectorAll('button')];
  const sync = () => {
    for (const b of buttons) {
      const active = b.dataset.units === unitSystem();
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
  };
  sync();
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      if (btn.dataset.units === unitSystem()) return;
      setUnitSystem(btn.dataset.units);
      sync();
      rerender();
    });
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

initTopBar();
initUnitToggle();
loadCity(cityFromUrl());
