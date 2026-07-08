/**
 * Fetch layer — two requests per city (plan.md §2).
 *
 * 1. Truth series: the standard forecast API with `models=best_match` and
 *    `past_days=30`. One consistent observed series that EVERY model is
 *    verified against.
 * 2. Predictions: one call to the previous-runs API with all models in the
 *    `models=` param and `{var}_previous_day{1..7}` variables. The response
 *    comes back with model-suffixed keys; `normalizePredictions` reshapes it
 *    into `pred[modelId][variable][leadDay] = (number|null)[]` aligned to the
 *    shared hourly time axis.
 *
 * Both calls use `timezone=auto` so daily aggregation aligns, and both request
 * `forecast_days=1` so their hourly time axes cover the identical range (the
 * partial current day is dropped later in the cleaning step).
 */

import { WINDOW_PAST_DAYS, LEAD_DAYS, VARIABLES, TRUTH_MODEL, resolveRoster } from './config.js';

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const PREVIOUS_RUNS_BASE = 'https://previous-runs-api.open-meteo.com/v1/forecast';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const backoff = (attempt) => sleep(800 * (attempt + 1) + Math.random() * 400);

/**
 * Open-Meteo's free tier throttles bursts — sometimes with an HTTP 429, and
 * sometimes by dropping the connection outright (a thrown "fetch failed", seen
 * especially from CI runners' shared IPs). Both are transient, so retry both
 * with backoff; only surface an error once the retries are exhausted.
 */
async function fetchJson(url, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt < retries) {
        await backoff(attempt);
        continue;
      }
      throw new Error(`Open-Meteo request failed (${err.message || 'fetch failed'})`);
    }
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < retries) {
      await backoff(attempt);
      continue;
    }
    let reason = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.reason) reason += `: ${body.reason}`;
    } catch {
      // non-JSON error body — the status alone will have to do
    }
    throw new Error(`Open-Meteo request failed (${reason})`);
  }
}

/**
 * @typedef {Object} TruthData
 * @property {string[]} times  Hourly local ISO timestamps (the shared join axis).
 * @property {string} timezone IANA timezone resolved by `timezone=auto`.
 * @property {Record<string, (number|null)[]>} series  Keyed by variable name
 *   (temperature/precipitation/wind), aligned to `times`.
 */

/** Fetch the observed (truth) series for a city. */
export async function fetchTruth(city) {
  const hourly = Object.values(VARIABLES).join(',');
  const url =
    `${FORECAST_BASE}?latitude=${city.lat}&longitude=${city.lon}` +
    `&hourly=${hourly}&models=${TRUTH_MODEL}` +
    `&past_days=${WINDOW_PAST_DAYS}&forecast_days=1&timezone=auto`;
  const data = await fetchJson(url);
  const series = {};
  for (const [variable, apiName] of Object.entries(VARIABLES)) {
    series[variable] = data.hourly[apiName] ?? [];
  }
  return {
    times: data.hourly.time,
    timezone: data.timezone,
    series,
  };
}

/**
 * @typedef {Object} PredictionData
 * @property {string[]} times  Hourly local ISO timestamps.
 * @property {Record<string, Record<string, Record<number, (number|null)[]>>>} pred
 *   `pred[modelId][variable][leadDay]` → values aligned to `times`. A model ×
 *   variable × lead the API didn't return is simply absent.
 */

/** Fetch all models' previous-run forecasts for a city in one request. */
export async function fetchPredictions(city) {
  const hourlyVars = [];
  for (const apiName of Object.values(VARIABLES)) {
    for (const day of LEAD_DAYS) {
      hourlyVars.push(`${apiName}_previous_day${day}`);
    }
  }
  const modelIds = resolveRoster(city).map((m) => m.id);
  const url =
    `${PREVIOUS_RUNS_BASE}?latitude=${city.lat}&longitude=${city.lon}` +
    `&hourly=${hourlyVars.join(',')}&models=${modelIds.join(',')}` +
    `&past_days=${WINDOW_PAST_DAYS}&forecast_days=1&timezone=auto`;
  const data = await fetchJson(url);
  return {
    times: data.hourly.time,
    pred: normalizePredictions(data.hourly, modelIds),
  };
}

/**
 * Reshape the previous-runs response (flat, model-suffixed keys like
 * `temperature_2m_previous_day3_gfs_seamless`) into
 * `pred[modelId][variable][leadDay] = values[]`.
 */
export function normalizePredictions(hourly, modelIds) {
  const pred = {};
  for (const modelId of modelIds) {
    pred[modelId] = {};
    for (const [variable, apiName] of Object.entries(VARIABLES)) {
      const perLead = {};
      for (const day of LEAD_DAYS) {
        const key = `${apiName}_previous_day${day}_${modelId}`;
        const values = hourly[key];
        if (values) perLead[day] = values;
      }
      pred[modelId][variable] = perLead;
    }
  }
  return pred;
}

/**
 * Fetch truth + predictions for one city. The two requests run concurrently;
 * both must succeed for the city to be scorable, so this rejects if either
 * fails. Callers fan out over cities with `Promise.allSettled` so one failed
 * city doesn't blank the page (plan.md §2).
 */
export async function fetchCityData(city) {
  const [truth, predictions] = await Promise.all([fetchTruth(city), fetchPredictions(city)]);
  return { city, truth, predictions };
}
