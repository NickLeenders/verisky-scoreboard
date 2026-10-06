import { CITIES } from './config.js';
import { MAP_API, METRICS, modelInfo, escapeHtml as esc, wrapLongitude, mapSelection, decodeGrid, cellAt, visibleShares, scoreLink } from './map-data.js';
import { createScoreGrid } from './map-grid.js';
import { installScoreBasemap } from './map-basemap.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = mapSelection(params);
const L = window.L;
const map = L.map('map', { zoomControl: false, worldCopyJump: true, minZoom: 1, maxZoom: 9,
  closePopupOnClick: true }).setView([state.lat, state.lon], state.zoom);
L.control.zoom({ position: 'topright' }).addTo(map);
for (const [name, z] of [['modelGrid', 420], ['mapReference', 450], ['stationsPane', 460]]) {
  map.createPane(name);
  map.getPane(name).style.zIndex = z;
  map.getPane(name).style.pointerEvents = 'none';
}
installScoreBasemap(map);
const gridLayer = createScoreGrid(map);
const airports = L.layerGroup().addTo(map);
const gridCache = new Map(), stationCache = new Map(), pointCache = new Map();
let grid = null, stations = null, generation = 0, pointSequence = 0;
let requestController = null, stationWarning = false;
let legendTimer;
const resizeObserver = new ResizeObserver(() => map.invalidateSize());
resizeObserver.observe($('map'));

function syncUrl() {
  const center = map.getCenter();
  const next = new URLSearchParams(location.search);
  next.set('lat', center.lat.toFixed(3));
  next.set('lon', wrapLongitude(center.lng).toFixed(3));
  next.set('zoom', String(map.getZoom()));
  next.set('window', String(state.window));
  next.set('metric', state.metric);
  history.replaceState(null, '', `${location.pathname}?${next}`);
}
function syncFilters() {
  for (const button of $('map-metrics').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.metric === state.metric));
  $('map-window').value = String(state.window);
}
function status() {
  if (!grid) return;
  const date = grid.prelude.asOf ? String(grid.prelude.asOf).slice(0, 10) : '';
  const days = grid.prelude.days;
  $('map-status').textContent = `${date ? `Scored through ${date}` : 'Scores ready'}${days && days < state.window ? ` · ${days} days available` : ''}${stationWarning ? ' · airports unavailable' : ''}`;
}
async function request(path, signal, binary = false) {
  const response = await fetch(`${MAP_API}/${path}`, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20000)]) });
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many requests. Please try again shortly.' : 'Scores could not load. Please try again.');
  return binary ? decodeGrid(await response.arrayBuffer()) : response.json();
}
async function loadScores(force = false) {
  const seq = ++generation;
  ++pointSequence;
  requestController?.abort();
  requestController = new AbortController();
  const { signal } = requestController;
  const { window: days, metric } = state;
  const key = `${days}/${metric}`;
  map.closePopup();
  // Clear the previous selection immediately: its colours must never acquire a new label.
  grid = null;
  gridLayer.clear();
  airports.clearLayers();
  stations = null;
  stationWarning = false;
  $('map-legend').hidden = true;
  $('map-error').hidden = true;
  $('map-status').textContent = 'Loading scores…';
  $('map').setAttribute('aria-busy', 'true');
  if (force) { gridCache.delete(key); stationCache.delete(days); }
  const loadAirports = (async () => {
    try {
      const body = stationCache.get(days) ?? await request(`stations?window=${days}`, signal);
      if (!Array.isArray(body.stations)) throw new Error('Invalid airport data');
      stationCache.set(days, body);
      if (seq !== generation) return;
      stations = body;
      renderStations();
      status();
    } catch (error) {
      if (seq !== generation) return;
      stationWarning = true;
      status();
    }
  })();
  try {
    let loaded = gridCache.get(key);
    if (!loaded) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { loaded = await request(`grid?window=${days}&metric=${metric}`, signal, true); break; }
        catch (error) {
          if (signal.aborted || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, attempt ? 1500 : 500));
        }
      }
      if (loaded.prelude.window !== days || loaded.prelude.metric !== metric) throw new Error('The map returned a different selection. Please retry.');
      gridCache.set(key, loaded);
      // Keep sessions that explore all windows bounded (about 8 MB of planes).
      while (gridCache.size > 8) gridCache.delete(gridCache.keys().next().value);
    }
    if (seq !== generation) return;
    grid = loaded;
    gridLayer.set(grid);
    renderLegend();
    status();
  } catch (error) {
    if (seq !== generation) return;
    $('map-status').textContent = 'Scores unavailable';
    $('map-error-text').textContent = error.message;
    $('map-error').hidden = false;
  } finally {
    if (seq === generation) $('map').setAttribute('aria-busy', 'false');
  }
  await loadAirports;
}

function renderLegend() {
  const box = $('map-legend');
  if (!grid) { box.hidden = true; return; }
  const b = map.getBounds();
  const view = visibleShares(grid, { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
  if (!(view.total > 0)) { box.hidden = true; return; }
  const chip = (label, color, share) => `<span class="chip">${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)} <span class="pct">${Math.round(share)}%</span></span>`;
  let named = 0;
  const chips = view.shares.slice(0, 4).filter(r => r.share >= .5).map(r => {
    named += r.share;
    const model = modelInfo(r.id);
    return chip(model.label, model.color, r.share);
  });
  if (view.tieShare >= .5) { named += view.tieShare; chips.push(chip('Too close to call', '#7d8694', view.tieShare)); }
  if (100 - named >= .5) chips.push(chip('Other', null, 100 - named));
  box.innerHTML = '<div class="caption">Share of the visible map · tap a place to explore</div><div class="chips">' + chips.join('') + '</div>';
  box.hidden = false;
}
function stationRows(station) {
  return (station.metrics?.[state.metric]?.top ?? []).filter(r => r.modelId !== 'accuweather' && !r.modelId.startsWith('verisky_') && Number.isFinite(r.skill));
}
function renderStations() {
  airports.clearLayers();
  if (!stations || !$('map-airports').checked) return;
  const center = map.getCenter().lng;
  for (const station of stations.stations) {
    const rows = stationRows(station);
    if (!rows.length || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;
    const lon = station.lon + 360 * Math.round((center - station.lon) / 360);
    L.circleMarker([station.lat, lon], { pane: 'stationsPane', radius: 5, color: '#fff', weight: 1.5,
      fillColor: modelInfo(rows[0].modelId).color, fillOpacity: 1, interactive: false }).addTo(airports);
  }
}
function popupBody(title, rows, blend, foot, target, contested = false) {
  let html = `<div class="mm-title">${esc(title)}</div>`;
  if (contested) html += '<div class="mm-foot">Too close to call · less than 1 point apart</div>';
  rows.slice(0, 4).forEach((r, i) => {
    const model = modelInfo(r.modelId);
    html += `<div class="mm-row ${!contested && i === 0 ? 'win' : ''}"><span class="dot" style="background:${model.color}"></span>${esc(model.label)}<span class="skill">${r.skill.toFixed(1)}</span></div>`;
  });
  if (!rows.length) html += '<div class="mm-foot">No scores for this spot yet.</div>';
  if (Number.isFinite(blend) && rows.length) html += `<div class="mm-blend"><span class="dot" style="background:#4c8dff"></span>Blend ${blend.toFixed(1)} · ${blend >= rows[0].skill ? '+' : ''}${(blend - rows[0].skill).toFixed(1)} vs best</div>`;
  html += `<div class="mm-foot">${esc(foot)}</div>`;
  const link = scoreLink(target);
  if (link) html += `<a class="mm-open" href="${esc(link)}">${target.icao ? 'Open airport standings' : 'Explore this location on the scoreboard'} →</a>`;
  return html;
}
function popup(latlng, html) {
  const top = $('map-toolbar').offsetHeight + 30;
  return L.popup({ className: 'mm-readout', maxWidth: 290, autoPanPaddingTopLeft: [20, top], autoPanPaddingBottomRight: [20, 130] })
    .setLatLng(latlng).setContent(html).openOn(map);
}
function nearestStation(latlng) {
  if (!stations || !$('map-airports').checked) return null;
  const tap = map.project(latlng), world = map.options.crs.scale(map.getZoom());
  let best = null, distance = 22;
  for (const st of stations.stations) {
    if (!stationRows(st).length) continue;
    const p = map.project([st.lat, st.lon]);
    const dx = ((p.x - tap.x + world / 2) % world + world) % world - world / 2;
    const dist = Math.hypot(dx, p.y - tap.y);
    if (dist < distance) { best = st; distance = dist; }
  }
  return best;
}
const coordinate = (v, plus, minus) => `${Math.abs(v).toFixed(2)}°${v < 0 ? minus : plus}`;
map.on('click', async event => {
  const seq = ++pointSequence;
  const station = nearestStation(event.latlng);
  if (station) {
    const analysisOnly = CITIES.find(c => c.airport?.icao === station.icao)?.airport.truthSource === 'analysis';
    const truth = analysisOnly ? 'Verified against model analysis'
      : state.metric === 'combined' ? 'Temperature & wind vs station observations · rain & sun vs analysis'
      : stations.truth?.[state.metric] === 'metar' ? 'Verified against station observations' : 'Verified against model analysis';
    popup(event.latlng, popupBody(`${station.icao} · ${station.name}`, stationRows(station), station.metrics?.[state.metric]?.blend,
      `${truth} · ${String(station.asOf).slice(0, 10)}`, station));
    return;
  }
  if (!grid) return;
  const cell = cellAt(event.latlng.lat, event.latlng.lng);
  const title = `${coordinate(cell.lat, 'N', 'S')} · ${coordinate(cell.lon, 'E', 'W')}`;
  const pop = popup(event.latlng, `<div class="mm-title">${esc(title)}</div><div class="mm-foot" role="status">Loading scores…</div>`);
  const key = `${state.window}/${state.metric}/${cell.lat}/${cell.lon}`;
  try {
    const body = pointCache.get(key) ?? await request(`point?window=${state.window}&metric=${state.metric}&lat=${cell.lat}&lon=${cell.lon}`, requestController.signal);
    if (!Array.isArray(body.rows)) throw new Error('Invalid point data');
    pointCache.set(key, body);
    while (pointCache.size > 100) pointCache.delete(pointCache.keys().next().value);
    if (seq !== pointSequence || !pop.isOpen()) return;
    pop.setContent(popupBody(title, body.rows, body.blend, `Top two · model analysis · ${String(body.asOf).slice(0, 10)} · approximate scores`,
      { ...cell, name: title }, body.contested));
  } catch (error) {
    if (seq !== pointSequence || !pop.isOpen()) return;
    pop.setContent(`<div class="mm-title">${esc(title)}</div><div class="mm-foot">Scores are temporarily unavailable. Tap this spot to try again.</div>`);
  }
});
map.getContainer().addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target === map.getContainer()) {
    event.preventDefault();
    map.fire('click', { latlng: map.getCenter() });
  }
});
map.on('moveend resize', () => {
  clearTimeout(legendTimer);
  legendTimer = setTimeout(renderLegend, 120);
  renderStations();
  syncUrl();
});
$('map-metrics').addEventListener('click', event => {
  const metric = event.target.closest('button')?.dataset.metric;
  if (!METRICS.includes(metric) || metric === state.metric) return;
  state.metric = metric;
  syncFilters(); syncUrl(); loadScores();
});
$('map-window').addEventListener('change', () => {
  state.window = Number($('map-window').value);
  syncUrl(); loadScores();
});
$('map-airports').addEventListener('change', () => { ++pointSequence; map.closePopup(); renderStations(); });
$('map-retry').addEventListener('click', () => loadScores(true));
for (const city of CITIES) {
  const option = document.createElement('option'); option.value = city.id; option.textContent = city.name;
  $('map-city').append(option);
}
$('map-city').value = state.city?.id ?? '';
$('map-city').addEventListener('change', () => {
  const city = CITIES.find(c => c.id === $('map-city').value);
  map.closePopup();
  const next = new URLSearchParams(location.search);
  for (const key of ['city', 'site', 'name', 'country']) next.delete(key);
  if (city) next.set('city', city.id);
  history.replaceState(null, '', `${location.pathname}?${next}`);
  if (city) { map.setView([city.lat, city.lon], 5); $('board-link').href = `./?city=${encodeURIComponent(city.id)}`; }
  else { map.setView([25, 5], 2); $('board-link').href = './'; }
});
const boardParams = new URLSearchParams();
for (const key of ['city', 'site', 'name', 'lat', 'lon', 'country']) if (params.has(key)) boardParams.set(key, params.get(key));
if (boardParams.has('city') || boardParams.has('name')) $('board-link').href = `./?${boardParams}`;
syncFilters();
loadScores();
