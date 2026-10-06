/** Contracts shared with VeriSky's model-map renderer and the stored winner planes. */
import { MODEL_CATALOG, COMMERCIAL_MODEL_CATALOG, CITIES, airportSite } from './config.js';
export const MAP_API = 'https://api.verisky.app/scoreboard/map';
export const METRICS = ['combined', 'temperature', 'rain', 'wind', 'sun'];
export const WINDOWS = [7, 14, 30, 60, 90];
export const NX = 1440, NY = 721, RES = 0.25;
const models = [...MODEL_CATALOG, ...COMMERCIAL_MODEL_CATALOG];
export const MAP_MODELS = Object.fromEntries(models.map(m => [m.id, m]));
// The grid uses the app's IFS id; the scoreboard archive uses its 0.25° alias.
MAP_MODELS.ecmwf_ifs = MAP_MODELS.ecmwf_ifs025;
MAP_MODELS.verisky_blend = { label: 'Blend', color: '#4c8dff' };

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const modelInfo = id => MAP_MODELS[id] ?? { label: id, color: '#94a3b8' };
export const wrapLongitude = lon => ((lon + 180) % 360 + 360) % 360 - 180;

export function mapSelection(params) {
  const preset = CITIES.find(c => c.id === params.get('city'));
  const city = preset && params.get('site') === 'airport' ? airportSite(preset) ?? preset : preset;
  const coord = (key, fallback, lo, hi) => {
    const raw = params.get(key);
    const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= lo && value <= hi ? value : fallback;
  };
  return {
    lat: coord('lat', city?.lat ?? 35, -85, 85),
    lon: coord('lon', city?.lon ?? 8, -180, 180),
    zoom: coord('zoom', city ? 4 : 3, 1, 9),
    window: WINDOWS.includes(Number(params.get('window'))) ? Number(params.get('window')) : 30,
    metric: METRICS.includes(params.get('metric')) ? params.get('metric') : 'combined',
    city,
  };
}

export function decodeGrid(buffer) {
  if (buffer.byteLength < 4) throw new Error('Incomplete map data');
  const headLen = new DataView(buffer).getUint32(0, true);
  if (headLen < 2 || headLen > 65536 || buffer.byteLength !== 4 + headLen + NX * NY) {
    throw new Error('Incomplete map data');
  }
  const prelude = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headLen)));
  if (prelude.version !== 1 || prelude.cells !== NX * NY || !Array.isArray(prelude.roster)
    || prelude.roster.length > 254 || !prelude.roster.every(id => typeof id === 'string')
    || prelude.contested !== 254 || prelude.noData !== 255) throw new Error('Unsupported map data');
  return { prelude, plane: new Uint8Array(buffer, 4 + headLen) };
}

export function cellAt(lat, lon) {
  const row = Math.max(0, Math.min(NY - 1, Math.round((lat + 90) / RES)));
  const col = ((Math.round((lon + 180) / RES) % NX) + NX) % NX;
  return { lat: row * RES - 90, lon: col * RES - 180 };
}

export function visibleShares(grid, bounds) {
  const rowStart = Math.max(0, Math.min(NY - 1, Math.floor((bounds.south + 90) / RES)));
  const rowEnd = Math.max(0, Math.min(NY - 1, Math.ceil((bounds.north + 90) / RES)));
  const colStart = Math.floor((bounds.west + 180) / RES);
  const cols = Math.min(NX, Math.ceil((bounds.east + 180) / RES) - colStart + 1);
  const weights = new Float64Array(grid.prelude.roster.length);
  let total = 0, tied = 0;
  for (let row = rowStart; row <= rowEnd; row++) {
    const weight = Math.cos((-90 + row * RES) * Math.PI / 180);
    for (let c = 0; c < cols; c++) {
      const value = grid.plane[row * NX + ((colStart + c) % NX + NX) % NX];
      if (value === 255 || (value !== 254 && value >= weights.length)) continue;
      total += weight;
      if (value === 254) tied += weight;
      else weights[value] += weight;
    }
  }
  return { total, tieShare: total > 0 ? tied / total * 100 : 0,
    shares: grid.prelude.roster.map((id, i) => ({ id, share: total > 0 ? weights[i] / total * 100 : 0 }))
      .filter(row => row.share > 0).sort((a, b) => b.share - a.share) };
}

export function scoreLink(target) {
  if (target.icao) {
    const preset = CITIES.find(c => c.airport?.icao === target.icao);
    // Only preset airport boards can preserve the station's METAR truth.
    return preset ? `./?city=${encodeURIComponent(preset.id)}&site=airport` : null;
  }
  const params = new URLSearchParams({ name: target.name, lat: String(target.lat), lon: String(target.lon) });
  return `./?${params}`;
}
