/**
 * Static configuration for the VeriSky scoreboard (plan.md §1 + §1a).
 *
 * The public model catalog mirrors the app's non-commercial models
 * (constants/models.ts), translated to the ids the Open-Meteo previous-runs API
 * serves, with labels/providers/colors copied so the web scoreboard and the app
 * read as one product. Commercial models never enter the browser-side fetch /
 * align pipeline: preset cities receive only their server-computed aggregate
 * scores from api.verisky.app, with no forecast values in the response.
 *
 * We don't show all models for every city (§1a): `resolveRoster(city)` returns a
 * 5-model global spine plus that country's home models and very-near neighbours.
 * `maxLeadDays` caps scoring at the model's usable horizon (the app caps ICON at
 * 6 days; short-range regionals cap lower). Models tagged with `bounds` hard-error
 * on the previous-runs API outside their domain — and one erroring model blanks
 * the whole multi-model request — so they are dropped when the city is outside.
 * Models that merely return all-null outside their region (e.g. KMA far from
 * Korea) are safe to leave in; the align/score pipeline self-filters them.
 */

export const WINDOW_PAST_DAYS = 30;

/** Lead days scored. All seven: the decay chart and the headline skill need the full range. */
export const LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** Scored variables → the Open-Meteo hourly variable that carries them. */
export const VARIABLES = /** @type {const} */ ({
  temperature: 'temperature_2m',
  precipitation: 'precipitation',
  wind: 'wind_speed_10m',
});

/** Ground truth source. Every model is verified against this same observed
 *  series — never against its own day-0 analysis. */
export const TRUTH_MODEL = 'best_match';

// Domains where a model hard-errors on the previous-runs API outside the box
// (mirrors the app's isModelSupported bounds, verisky/src/utils/modelSupport.ts).
// Verified live 2026-07-07: outside these boxes the API returns
// "No data is available for this location", which blanks the whole request.
const CONUS_BOUNDS = { minLat: 21.0, maxLat: 53.0, minLon: -134.0, maxLon: -60.0 };
const HARM_BOUNDS = { minLat: 49.0, maxLat: 54.7, minLon: 2.0, maxLon: 8.5 };
const METEOCH_BOUNDS = { minLat: 46.0, maxLat: 47.5, minLon: 4.5, maxLon: 6.3 };

/**
 * @typedef {Object} ModelConfig
 * @property {string} id        Open-Meteo previous-runs model id.
 * @property {string} label     Short display name (from the app).
 * @property {string} provider  Producing service (short brand, from the app).
 * @property {string} color     Entity color (from the app's constants/models.ts).
 * @property {number} maxLeadDays  Usable horizon; scoring is capped here.
 * @property {{minLat:number,maxLat:number,minLon:number,maxLon:number}} [bounds]
 *   Present only for models that error outside their domain (see above).
 */

/** Every non-commercial model, keyed by its previous-runs id. */
export const MODEL_CATALOG = /** @type {ModelConfig[]} */ ([
  // ── Global spine (always shown, §1a) ──────────────────────────────────────
  { id: 'ecmwf_ifs025', label: 'IFS', provider: 'ECMWF', color: '#2563EB', maxLeadDays: 7 },
  // plan.md named ecmwf_aifs025, but that id returns all-null on previous-runs —
  // only the _single variant carries data (verified; it's also the app's id).
  { id: 'ecmwf_aifs025_single', label: 'AIFS', provider: 'ECMWF', color: '#0EA5E9', maxLeadDays: 7 },
  { id: 'gfs_seamless', label: 'GFS', provider: 'NOAA', color: '#DC2626', maxLeadDays: 7 },
  { id: 'ncep_aigfs025', label: 'AIGFS', provider: 'NOAA', color: '#F97316', maxLeadDays: 7 },
  { id: 'icon_seamless', label: 'ICON', provider: 'DWD', color: '#059669', maxLeadDays: 6 },

  // ── US regional (NOAA, continental-US only — bounds-gated) ────────────────
  { id: 'gfs_hrrr', label: 'HRRR', provider: 'NOAA', color: '#E11D48', maxLeadDays: 2, bounds: CONUS_BOUNDS },
  { id: 'ncep_nbm_conus', label: 'NBM', provider: 'NOAA', color: '#EAB308', maxLeadDays: 7, bounds: CONUS_BOUNDS },
  { id: 'ncep_nam_conus', label: 'NAM', provider: 'NOAA', color: '#FB923C', maxLeadDays: 3, bounds: CONUS_BOUNDS },

  // ── European regional ─────────────────────────────────────────────────────
  { id: 'knmi_seamless', label: 'HARM', provider: 'KNMI', color: '#D97706', maxLeadDays: 7, bounds: HARM_BOUNDS },
  { id: 'meteofrance_seamless', label: 'MeteoFR', provider: 'Météo-France', color: '#8B5CF6', maxLeadDays: 4 },
  { id: 'ukmo_seamless', label: 'UKMO', provider: 'Met Office', color: '#EC4899', maxLeadDays: 7 },
  { id: 'meteoswiss_icon_seamless', label: 'MeteoCH', provider: 'MeteoSwiss', color: '#14B8A6', maxLeadDays: 5, bounds: METEOCH_BOUNDS },
  { id: 'metno_seamless', label: 'METNO', provider: 'MET Norway', color: '#84CC16', maxLeadDays: 2 },
  { id: 'dmi_seamless', label: 'DMI', provider: 'DMI', color: '#6366F1', maxLeadDays: 2 },

  // ── Other global (Canada / East Asia) ─────────────────────────────────────
  { id: 'gem_seamless', label: 'GEM', provider: 'ECCC', color: '#F43F5E', maxLeadDays: 7 },
  { id: 'kma_seamless', label: 'KMA', provider: 'KMA', color: '#0891B2', maxLeadDays: 7 },
  { id: 'jma_seamless', label: 'JMA', provider: 'JMA', color: '#7C3AED', maxLeadDays: 7 },
  { id: 'cma_grapes_global', label: 'CMA', provider: 'CMA', color: '#BE123C', maxLeadDays: 7 },
]);

const MODEL_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

/**
 * Commercial models available only in the preset-city server scoreboard.
 * AccuWeather is deliberately absent. These entries are presentation metadata;
 * their predictions and provider credentials never enter this repository's
 * browser-side scoring pipeline or baked raw payloads.
 */
export const COMMERCIAL_MODEL_CATALOG = /** @type {ModelConfig[]} */ ([
  { id: 'apple_weatherkit', label: 'Apple Weather', provider: 'Apple Weather', color: '#9CA3AF', maxLeadDays: 7 },
  { id: 'openweathermap', label: 'OpenWeather', provider: 'OpenWeatherMap', color: '#F59E0B', maxLeadDays: 7 },
  { id: 'weatherapi', label: 'WeatherAPI', provider: 'WeatherAPI.com', color: '#06B6D4', maxLeadDays: 3 },
  { id: 'visualcrossing', label: 'VisualCross', provider: 'Visual Crossing', color: '#10B981', maxLeadDays: 7 },
  { id: 'foreca', label: 'Foreca', provider: 'Foreca', color: '#8B5CF6', maxLeadDays: 7 },
]);

const SCOREBOARD_MODEL_BY_ID = new Map(
  [...MODEL_CATALOG, ...COMMERCIAL_MODEL_CATALOG].map((m) => [m.id, m]),
);

/** Presentation metadata for a model returned by the sanitized server board. */
export function scoreboardModelById(id) {
  return SCOREBOARD_MODEL_BY_ID.get(id) ?? null;
}

/** The five global models shown for every city, in ranking-order priority. */
export const SPINE_IDS = [
  'ecmwf_ifs025',
  'ecmwf_aifs025_single',
  'gfs_seamless',
  'ncep_aigfs025',
  'icon_seamless',
];

/**
 * ISO country_code → the home model(s) plus very-near neighbours to add on top
 * of the spine (§1a). Generous by design: models are added by country, then
 * bounds-gated and (further downstream) self-filtered where they carry no data,
 * so listing a neighbour that turns out to have no coverage there is harmless.
 */
export const COUNTRY_ADDONS = {
  // North America
  US: ['gfs_hrrr', 'ncep_nbm_conus', 'ncep_nam_conus', 'gem_seamless'],
  CA: ['gem_seamless', 'gfs_hrrr', 'ncep_nbm_conus', 'ncep_nam_conus'],
  MX: ['gem_seamless', 'gfs_hrrr', 'ncep_nam_conus'],
  // East Asia (each gets all three home models — they're mutually very near)
  JP: ['jma_seamless', 'kma_seamless', 'cma_grapes_global'],
  KR: ['kma_seamless', 'jma_seamless', 'cma_grapes_global'],
  CN: ['cma_grapes_global', 'jma_seamless', 'kma_seamless'],
  TW: ['cma_grapes_global', 'jma_seamless', 'kma_seamless'],
  // Western Europe
  GB: ['ukmo_seamless', 'meteofrance_seamless', 'knmi_seamless'],
  IE: ['ukmo_seamless', 'meteofrance_seamless', 'knmi_seamless'],
  FR: ['meteofrance_seamless', 'ukmo_seamless', 'meteoswiss_icon_seamless', 'knmi_seamless'],
  NL: ['knmi_seamless', 'ukmo_seamless', 'meteofrance_seamless'],
  BE: ['knmi_seamless', 'ukmo_seamless', 'meteofrance_seamless'],
  LU: ['knmi_seamless', 'ukmo_seamless', 'meteofrance_seamless'],
  DE: ['knmi_seamless', 'meteofrance_seamless', 'meteoswiss_icon_seamless', 'dmi_seamless'],
  AT: ['knmi_seamless', 'meteofrance_seamless', 'meteoswiss_icon_seamless', 'dmi_seamless'],
  CH: ['meteoswiss_icon_seamless', 'meteofrance_seamless', 'knmi_seamless'],
  LI: ['meteoswiss_icon_seamless', 'meteofrance_seamless', 'knmi_seamless'],
  IT: ['meteofrance_seamless', 'meteoswiss_icon_seamless'],
  ES: ['meteofrance_seamless', 'ukmo_seamless'],
  PT: ['meteofrance_seamless', 'ukmo_seamless'],
  // Nordics
  NO: ['metno_seamless', 'dmi_seamless', 'ukmo_seamless'],
  IS: ['metno_seamless', 'dmi_seamless', 'ukmo_seamless'],
  DK: ['dmi_seamless', 'metno_seamless', 'knmi_seamless'],
  SE: ['metno_seamless', 'dmi_seamless'],
  FI: ['metno_seamless', 'dmi_seamless'],
};

function inBounds(lat, lon, b) {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

/**
 * The models to score for a city: the spine plus its country's add-ons
 * (deduped, spine first), with bounds-gated models dropped when the city is
 * outside their domain. A pure function of the city, so every stage (fetch,
 * cache key, align, score) can recompute the same roster from `city` alone.
 *
 * @param {{country?:string, lat:number, lon:number}} city
 * @returns {ModelConfig[]}
 */
export function resolveRoster(city) {
  const ids = [...SPINE_IDS];
  const cc = city && city.country ? String(city.country).toUpperCase() : null;
  const addons = (cc && COUNTRY_ADDONS[cc]) || [];
  for (const id of addons) if (!ids.includes(id)) ids.push(id);

  const hasCoords = city && Number.isFinite(city.lat) && Number.isFinite(city.lon);
  const out = [];
  for (const id of ids) {
    const model = MODEL_BY_ID.get(id);
    if (!model) continue;
    if (model.bounds && !(hasCoords && inBounds(city.lat, city.lon, model.bounds))) continue;
    out.push(model);
  }
  return out;
}

export const CITIES = [
  { id: 'amsterdam', name: 'Amsterdam', lat: 52.37, lon: 4.89, country: 'NL' },
  { id: 'london', name: 'London', lat: 51.51, lon: -0.13, country: 'GB' },
  { id: 'berlin', name: 'Berlin', lat: 52.52, lon: 13.41, country: 'DE' },
  { id: 'paris', name: 'Paris', lat: 48.86, lon: 2.35, country: 'FR' },
  { id: 'newyork', name: 'New York', lat: 40.71, lon: -74.01, country: 'US' },
  { id: 'tokyo', name: 'Tokyo', lat: 35.68, lon: 139.69, country: 'JP' },
];

export const DEFAULT_CITY_ID = 'amsterdam';
