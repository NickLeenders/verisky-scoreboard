/**
 * Page assembly + render flow (plan.md §6, design locked in §8).
 *
 * Flow: skeleton is in the HTML → cached data (if any) renders instantly →
 * a network refresh (skipped entirely while the cache is fresh, §5) re-renders
 * in place. Sections fill in page order: standings table first, then the
 * comparison + lead-time two-up, then the other-calls strip.
 *
 * City search hits the Open-Meteo geocoding endpoint lazily — only when the
 * user types — and fetches forecast data only on selection.
 */

import { renderComparison, resetComparison } from './compare.js';
import { CITIES, DEFAULT_CITY_ID, airportSite } from './config.js';
import { populateCityOptions } from './city-select.js';
import { fetchCityData } from './fetch.js';
import { scorePayload } from './pipeline.js';
import { readCache, writeCache } from './cache.js';
import { readBaked } from './prebaked.js';
import { fetchPresetScoreboard } from './server-scoreboard.js';
import {
  scoreTone,
  buildStandings,
  buildLeadSeries,
  buildGhost,
  buildMedianComparison,
  buildHabits,
  buildOtherCalls,
  LAB_LEADS,
} from './derive.js';
import {
  leadTimeChart,
  leadDayAtClientX,
  LEAD_FOCUS_LIMIT,
  ghostChart,
  medianChart,
} from './charts.js';
import {
  buildLeadTimeGrid,
  sortLeadTimeGrid,
  rankedModelIds,
  rampStep,
  formatLeadLabel,
  RAMP_STEPS,
} from './leadTimeGrid.js';
import { breakdownHtml, hasBreakdown } from './breakdown.js';
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

const $ = (sel) => document.querySelector(sel);

// ── City state ───────────────────────────────────────────────────────────────

function cityFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('city');
  if (id) {
    const preset = CITIES.find((c) => c.id === id);
    if (preset) {
      // ?site=airport switches the preset to its airport weather station.
      if (params.get('site') === 'airport') return airportSite(preset) ?? preset;
      return preset;
    }
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
  if (city.id) {
    return `?city=${encodeURIComponent(city.id)}${city.site === 'airport' ? '&site=airport' : ''}`;
  }
  const country = city.country ? `&country=${encodeURIComponent(city.country)}` : '';
  return `?name=${encodeURIComponent(city.name)}&lat=${city.lat.toFixed(2)}&lon=${city.lon.toFixed(2)}${country}`;
}

let currentCity = null;
let loadToken = 0;
let lastRender = null; // { aligned, scores } for the lab panels
let lastRows = []; // the standings rows on screen — the lab reads its breakdown from these
// ?lab=<modelId> deep link — captured at boot (loadCity rewrites the URL),
// consumed by the first render only.
let pendingLab = new URLSearchParams(location.search).get('lab');

// ── Load + render orchestration ──────────────────────────────────────────────

async function loadCity(city) {
  const token = ++loadToken;
  currentCity = city;
  resetComparison();
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
  for (const id of ['standings-body', 'compare-body', 'lead-body', 'calls-body']) {
    const el = document.getElementById(id);
    el.innerHTML = '<div class="skeleton"></div>'.repeat(id === 'standings-body' ? 4 : 3);
  }
}

function renderError(error) {
  $('#standings-body').innerHTML =
    `<p class="error">Couldn't load data: ${esc(error.message)} ` +
    `<button class="retry" type="button">Retry</button></p>`;
  $('#standings-body .retry').addEventListener('click', () => loadCity(currentCity));
  $('#compare-body').innerHTML = '';
  $('#lead-body').innerHTML = '';
  $('#calls-body').innerHTML = '';
}

function render(city, { aligned, scores, timezone, presetBoard = null }) {
  lastRender = { city, aligned, scores, timezone, presetBoard };
  const dates = aligned.scoredDates;
  const shownDays = presetBoard?.scoredDays ?? dates.length;
  const shownTimezone = presetBoard?.timezone ?? timezone;
  const siteTag = city.site === 'airport' && city.airport ? ` · ✈ ${city.airport.icao}` : '';
  $('#window-label').textContent =
    `last ${shownDays} days · all lead days · ${shownTimezone}${siteTag}`;

  // Page order per §6/§8: standings first…
  renderStandings(aligned, scores, presetBoard);
  if (pendingLab) {
    const tr = document.querySelector(`tr.standing[data-model="${CSS.escape(pendingLab)}"]`);
    pendingLab = null;
    if (tr) toggleLab(tr);
  }
  // …then charts on the next frame so the table paints immediately.
  requestAnimationFrame(() => {
    renderComparison(aligned, presetBoard != null);
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
  lastRows = rows;

  const html = [`<table class="standings"><thead><tr>
    <th class="c-rank">#</th><th class="c-move" title="movement vs the standings a week ago (same window minus its last 7 days)"></th>
    <th>Model</th><th class="c-skill">Skill</th>
    <th class="c-metric">Temp</th><th class="c-metric">${rainOff ? 'Rain*' : 'Rain'}</th><th class="c-metric">Wind</th>
    <th class="c-record" title="correct next-day rain/no-rain calls over the window">Rain W–L</th>
    <th class="c-form" title="last 7 days · filled dot: next-day skill ≥ 70">Form</th>
  </tr></thead><tbody>`];

  for (const r of rows) {
    // Commercial models have no in-browser pairs, so their row used to be
    // inert. It still opens: the score breakdown comes from the server's
    // aggregate components, and the charts below it are simply omitted.
    const hasPairs = Object.values(aligned.pairs[r.model.id] ?? {})
      .some((pairs) => Array.isArray(pairs) && pairs.length > 0);
    const canOpenLab = hasPairs || hasBreakdown(r);
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
          ? ` tabindex="0" role="button" aria-expanded="false" title="click for the score breakdown${
            hasPairs ? ' and the lab' : ''}"`
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
  // The server banks the v2 counters forward from the day the new score model
  // went live, so a 30-day window can judge temperature and wind over fewer
  // days than rain until it fills. Say so rather than let the window label lie.
  const covered = presetBoard?.v2CoveredDays;
  if (covered != null && presetBoard.scoredDays && covered < presetBoard.scoredDays) {
    html.push(
      `<p class="foot-note">Accuracy and Extremes cover the last ${covered} of ` +
      `${presetBoard.scoredDays} days — the new score model started banking on ` +
      `2026-08-10 and fills forward a day at a time. Rain uses the full window.</p>`,
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
  const row = lastRows.find((r) => r.model.id === modelId);
  const model = aligned.roster.find((m) => m.id === modelId) ?? row?.model;
  const served = LAB_LEADS.filter((d) => aligned.pairs[modelId]?.[d]);
  const lab = labRow.querySelector('.lab');

  // The breakdown always renders when the row carries components; the charts
  // below it need in-browser pairs, which commercial models never have.
  const breakdown = row ? breakdownHtml(row) : '';
  if (served.length === 0) {
    lab.innerHTML = `
      <div class="lab-head">
        <span class="lab-title"><span class="mdot" style="background:${esc(model.color)}"></span>
          ${esc(model.label)} · score breakdown</span>
      </div>
      ${breakdown}
      <p class="chart-caption">forecast-vs-observed charts are public models only — this
        provider's forecast values never reach the browser, only its aggregate scores.</p>`;
    lab.addEventListener('click', (e) => e.stopPropagation());
    return;
  }

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
    ${breakdown}
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

// ── Skill by lead time ───────────────────────────────────────────────────────

/**
 * Two views over the same numbers, ported from the app's ScoreLeadTimeCard.
 *
 * The grid is the default. A preset board carries thirteen models, and one line
 * each is thirteen lines through the same few points of vertical space — no
 * palette can separate them, so the chart could show the shape of the decay but
 * never answer "who do I trust three days out". The grid answers exactly that by
 * reading down a column, and a fourteenth provider costs one more row.
 *
 * The curves stay for reading the decay *shape*, with the app's honest ceiling:
 * at most four models coloured at a time, everything else in one context gray.
 */
const LEAD_TABS = [
  ['all', 'Skill'],
  ['temperature', 'Temp'],
  ['rain', 'Rain'],
  ['wind', 'Wind'],
];

const LEAD_VIEW_KEY = 'verisky.leadView';
/** Models coloured in the curve view before the reader picks any. */
const LEAD_DEFAULT_FOCUS = 3;
/** Lead day the curve readout opens on: tomorrow, the horizon most people plan for. */
const LEAD_DEFAULT_CURSOR = 1;

const VIEW_ICONS = {
  grid: '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path fill="currentColor" '
    + 'd="M0 0h5v5H0zM7 0h5v5H7zM0 7h5v5H0zM7 7h5v5H7z"/></svg>',
  curves: '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path fill="none" '
    + 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
    + 'd="M0.8 9.6 4 5.4l2.6 2.2L11.2 1.8"/></svg>',
};

// Card state lives outside the render so a refresh (or a unit switch) never
// forgets which view the reader chose, which models they coloured, or how they
// sorted the grid.
let leadView = 'grid';
let leadMetric = 'all';
let leadFocus = null; // null = follow the data (the leaders)
let leadSort = 'average'; // 'average' or a column index
let leadNumbers = false;
let leadCursorDay = null;
let leadSelectedCell = null; // { modelId, day } — the cell the reader tapped

try {
  const saved = localStorage.getItem(LEAD_VIEW_KEY);
  if (saved === 'grid' || saved === 'curves') leadView = saved;
} catch { /* private mode: the default view is fine */ }

function renderLead(scores) {
  const container = $('#lead-body');
  const allSeries = buildLeadSeries(scores);

  container.innerHTML = `
    <div class="lead-head">
      <span class="metric-tabs" role="tablist">
        ${LEAD_TABS.map(([key, label]) => `<button type="button" role="tab" data-metric="${key}"
          class="${key === leadMetric ? 'active' : ''}">${label}</button>`).join('')}
      </span>
      <span class="lead-views" role="tablist">
        ${Object.entries(VIEW_ICONS).map(([view, icon]) => `<button type="button" role="tab"
          data-view="${view}" class="${view === leadView ? 'active' : ''}"
          aria-selected="${view === leadView}">${icon}${view === 'grid' ? 'Grid' : 'Curves'}</button>`).join('')}
      </span>
    </div>
    <div class="lead-view"></div>
    <p class="chart-caption"></p>`;

  const body = container.querySelector('.lead-view');
  const caption = container.querySelector('.chart-caption');

  const draw = () => {
    const series = allSeries[leadMetric] ?? [];
    if (series.length === 0) {
      body.innerHTML = '<p class="empty">not scored this window</p>';
      caption.textContent = '';
      return;
    }
    if (leadView === 'grid') {
      drawLeadGrid(body, series);
      caption.innerHTML = 'Brightness is the score at that lead day, on fixed bands — a cell means '
        + 'the same thing on every board. A blank cell is a lead day the model doesn\'t serve, and '
        + 'a muted average is a row that only covers the near days. The Skill column is the '
        + '1/d-weighted mean of a row, with a soft horizon adjustment.';
    } else {
      drawLeadCurves(body, series);
      caption.innerHTML = 'The same numbers as the grid, as decay shapes. Only the models you pick '
        + 'are coloured: thirteen hues cannot be told apart, so the rest stay one context gray '
        + 'rather than pretend to be readable.';
    }
  };
  draw();

  for (const btn of container.querySelectorAll('.metric-tabs button')) {
    btn.addEventListener('click', () => {
      for (const b of container.querySelectorAll('.metric-tabs button')) b.classList.remove('active');
      btn.classList.add('active');
      leadMetric = btn.dataset.metric;
      leadSelectedCell = null;
      draw();
    });
  }
  for (const btn of container.querySelectorAll('.lead-views button')) {
    btn.addEventListener('click', () => {
      for (const b of container.querySelectorAll('.lead-views button')) {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      }
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      leadView = btn.dataset.view;
      try {
        localStorage.setItem(LEAD_VIEW_KEY, leadView);
      } catch { /* private mode: the choice just doesn't persist */ }
      draw();
    });
  }
}

/** models × lead-days matrix — the default view. */
function drawLeadGrid(body, series) {
  const grid = buildLeadTimeGrid(series);
  if (grid.columns.length === 0) {
    body.innerHTML = '<p class="empty">not scored this window</p>';
    return;
  }
  const rows = sortLeadTimeGrid(grid, leadSort);
  const ramp = Array.from({ length: RAMP_STEPS }, (_, i) => `<i class="ramp-step ramp-${i}"></i>`).join('');

  const head = `<div class="lg-row lg-head">
    <span class="lg-label"></span>
    ${grid.columns.map((day, index) => `<button type="button" class="lg-col${leadSort === index ? ' lg-col-on' : ''}"
      data-col="${index}" title="rank the models at ${formatLeadLabel(day)}">${formatLeadLabel(day)}</button>`).join('')}
    <button type="button" class="lg-col lg-avg-head${leadSort === 'average' ? ' lg-col-on' : ''}"
      data-col="average" title="rank the models by their average">avg</button>
  </div>`;

  const cells = rows.map((row) => {
    const inner = row.cells.map((score, index) => {
      const day = grid.columns[index];
      if (score == null) {
        return `<span class="lg-cell lg-empty" role="img"
          aria-label="${esc(row.model.label)}: no score at ${formatLeadLabel(day)}"></span>`;
      }
      const on = leadSelectedCell?.modelId === row.model.id && leadSelectedCell?.day === day;
      return `<button type="button" class="lg-cell ramp-${rampStep(score, leadMetric)}${on ? ' lg-cell-on' : ''}"
        data-model="${esc(row.model.id)}" data-day="${day}" data-score="${Math.round(score)}"
        aria-label="${esc(row.model.label)} at ${formatLeadLabel(day)}: score ${Math.round(score)}"
        >${leadNumbers ? `<span class="num lg-num">${Math.round(score)}</span>` : ''}</button>`;
    }).join('');
    // A model that stops early is averaging only its easy near leads, so its
    // number is muted: it explains the row's rank without pretending to be
    // comparable with a model carrying the full week.
    return `<div class="lg-row">
      <span class="lg-label" title="${esc(row.model.label)} · ${esc(row.model.provider)}">
        <span class="mdot" style="background:${esc(row.model.color)}"></span>
        <span class="lg-name">${esc(row.model.label)}</span></span>
      ${inner}
      <span class="num lg-avg${row.fullCoverage ? '' : ' lg-avg-partial'}">${
      row.average == null ? '' : Math.round(row.average)}</span>
    </div>`;
  }).join('');

  const hint = leadSelectedCell
    ? describeLeadCell(rows, grid.columns, leadSelectedCell)
    : 'Click a cell for the exact score · click a lead day to rank the models there';

  body.innerHTML = `
    <div class="lead-tools">
      <span class="ramp-legend">weak ${ramp} strong</span>
      <button type="button" class="numbers-toggle${leadNumbers ? ' on' : ''}"
        aria-pressed="${leadNumbers}" title="show the scores as numbers">123</button>
    </div>
    <div class="lead-grid" style="--lg-cols:${grid.columns.length}">${head}${cells}</div>
    <p class="lead-hint" aria-live="polite">${esc(hint)}</p>`;

  const redraw = () => drawLeadGrid(body, series);
  body.querySelector('.numbers-toggle').addEventListener('click', () => {
    leadNumbers = !leadNumbers;
    redraw();
  });
  for (const btn of body.querySelectorAll('.lg-col')) {
    btn.addEventListener('click', () => {
      const col = btn.dataset.col;
      const next = col === 'average' ? 'average' : Number(col);
      leadSort = leadSort === next ? 'average' : next;
      redraw();
    });
  }
  for (const btn of body.querySelectorAll('.lg-cell[data-model]')) {
    btn.addEventListener('click', () => {
      leadSelectedCell = { modelId: btn.dataset.model, day: Number(btn.dataset.day) };
      redraw();
    });
  }
}

function describeLeadCell(rows, columns, selected) {
  const row = rows.find((r) => r.model.id === selected.modelId);
  const index = columns.indexOf(selected.day);
  const score = index >= 0 ? row?.cells[index] : null;
  if (score == null) return 'Click a cell for the exact score · click a lead day to rank the models there';
  const metric = LEAD_TABS.find(([key]) => key === leadMetric)?.[1] ?? 'Skill';
  return `${row.model.label} at ${formatLeadLabel(selected.day)} · ${metric.toLowerCase()} ${Math.round(score)}`;
}

/** The decay curves — every model drawn, at most four coloured. */
function drawLeadCurves(body, series) {
  const ranked = rankedModelIds(series);
  // Picks are kept across city switches, but a pick this board has no row for
  // cannot be coloured. Everything the reader chose being absent (a different
  // country's roster) falls back to the leaders rather than an all-gray chart;
  // an empty list they emptied themselves is left alone.
  const present = new Set(series.map((s) => s.model.id));
  const picked = leadFocus?.filter((id) => present.has(id)) ?? null;
  const focus = picked == null || (leadFocus.length > 0 && picked.length === 0)
    ? ranked.slice(0, LEAD_DEFAULT_FOCUS)
    : picked;
  const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.day)))].sort((a, b) => a - b);
  if (days.length === 0) {
    body.innerHTML = '<p class="empty">not scored this window</p>';
    return;
  }
  const snap = (day) => days.reduce((best, d) => (Math.abs(d - day) < Math.abs(best - day) ? d : best));
  const cursor = snap(leadCursorDay ?? LEAD_DEFAULT_CURSOR);

  const chips = series.map((s) => {
    const on = focus.includes(s.model.id);
    return `<button type="button" class="lead-chip${on ? ' on' : ''}" data-model="${esc(s.model.id)}"
      aria-pressed="${on}"><span class="mdot" style="background:${on ? esc(s.model.color) : 'var(--text-3)'}"></span>${
      esc(s.model.label)}</button>`;
  }).join('');

  body.innerHTML = `
    <div class="lead-chips">${chips}</div>
    <div class="lead-readout"></div>
    <div class="lead-chart"></div>
    <p class="lead-hint">Hover the chart to read one lead day · click models to colour them
      (up to ${LEAD_FOCUS_LIMIT})</p>`;

  const chartEl = body.querySelector('.lead-chart');
  const readoutEl = body.querySelector('.lead-readout');

  const paint = (day) => {
    chartEl.innerHTML = leadTimeChart(series, { focusIds: focus, cursorDay: day });
    // The ranking at the crosshair — the exact answer tangled lines cannot give.
    const top = series
      .map((s) => ({ model: s.model, score: s.points.find((p) => p.day === day)?.score ?? null }))
      .filter((entry) => entry.score != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    readoutEl.innerHTML = top.length === 0 ? '' : `<span class="ro-lead">${formatLeadLabel(day)}</span>${
      top.map((entry) => `<span class="ro-item"><span class="mdot" style="background:${esc(entry.model.color)}"></span>${
        esc(entry.model.label)} <b class="num">${Math.round(entry.score)}</b></span>`).join('')}`;
  };
  paint(cursor);

  const moveCursor = (clientX) => {
    const svg = chartEl.querySelector('svg');
    if (!svg) return;
    const day = leadDayAtClientX(svg, clientX);
    if (day == null) return;
    const snapped = snap(day);
    if (snapped === leadCursorDay) return;
    leadCursorDay = snapped;
    paint(snapped);
  };
  // A pointer that hovers reads the chart by hovering it. A finger has to tap:
  // following pointermove on touch would hijack the page scroll that starts on
  // the chart, so touch only moves the crosshair on a deliberate press.
  chartEl.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    moveCursor(event.clientX);
  });
  chartEl.addEventListener('pointerdown', (event) => moveCursor(event.clientX));

  for (const chip of body.querySelectorAll('.lead-chip')) {
    chip.addEventListener('click', () => {
      const id = chip.dataset.model;
      // The oldest pick makes way, so a click never silently does nothing.
      leadFocus = focus.includes(id)
        ? focus.filter((f) => f !== id)
        : [...focus, id].slice(-LEAD_FOCUS_LIMIT);
      drawLeadCurves(body, series);
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
  syncSiteUi(city);
}

// ── City ⇄ Airport site toggle + station banner ─────────────────────────────

function syncSiteUi(city) {
  const toggle = $('#site-toggle');
  const banner = $('#site-banner');
  if (!toggle || !banner) return;

  const hasAirport = Boolean(city.id && city.airport);
  const onAirport = city.site === 'airport';
  toggle.hidden = false;
  for (const btn of toggle.querySelectorAll('button')) {
    const isAirport = btn.dataset.site === 'airport';
    const active = isAirport === onAirport;
    btn.disabled = isAirport ? !hasAirport : city.cityAvailable === false;
    btn.title = btn.disabled
      ? (isAirport ? 'No airport board available for this location' : 'No city board available for this location')
      : '';
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  if (hasAirport && onAirport) {
    const a = city.airport;
    banner.hidden = false;
    banner.innerHTML =
      `<span class="site-banner-icon" aria-hidden="true">✈</span>
      <span class="site-banner-text"><b>${esc(a.name)} (${esc(a.icao)})</b> — ${esc(city.name)}'s
        airport weather station. ${a.truthSource === 'analysis'
          ? 'Scores at this airport are verified against the observation-fed model analysis.'
          : "Temperature and wind on this board are verified against the station's own METAR observations; rain is verified against the model analysis."}</span>` +
      (a.sameCell
        ? `<span class="site-banner-note">${esc(city.name)}'s city board reads the same grid
          cell — the airport is the city's measurement point.</span>`
        : '');
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }
}

function initSiteToggle() {
  const toggle = $('#site-toggle');
  if (!toggle) return;
  for (const btn of toggle.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      if (btn.disabled || !currentCity?.id) return;
      const base = CITIES.find((c) => c.id === currentCity.id);
      if (!base) return;
      const wantAirport = btn.dataset.site === 'airport';
      if (wantAirport === (currentCity.site === 'airport')) return;
      loadCity(wantAirport ? airportSite(base) ?? base : base);
    });
  }
}

function initTopBar() {
  const select = $('#city-select');
  populateCityOptions(select, CITIES);
  select.addEventListener('change', () => {
    const preset = CITIES.find((c) => c.id === select.value);
    if (!preset) return;
    // Keep the airport view across city switches (comparing airports is a
    // legitimate browse mode); fall back to the city when there is no airport.
    const stayAirport = currentCity?.site === 'airport';
    loadCity(stayAirport ? airportSite(preset) ?? preset : preset);
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
initSiteToggle();
initUnitToggle();
loadCity(cityFromUrl());
