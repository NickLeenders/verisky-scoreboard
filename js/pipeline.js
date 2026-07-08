/**
 * End-to-end pipeline: fetch → align → score, fanned out per city with
 * Promise.allSettled so one failed city (or model) doesn't blank the page.
 * Isomorphic — runs in the browser and in Node (the smoke test and, later,
 * the SEO-bake cron reuse it unchanged).
 */

import { CITIES, resolveRoster } from './config.js';
import { fetchCityData } from './fetch.js';
import { alignCity } from './align.js';
import { scoreCity } from './score.js';

/**
 * Align and score already-fetched payloads — the localStorage cache (§5)
 * stores raw fetch payloads and replays them through this, so cached and live
 * renders share one code path. The city's model roster (§1a) is recomputed from
 * `city` here and carried through align/score, so every stage scores the same
 * set the fetch requested.
 */
export function scorePayload(city, { truth, predictions }) {
  const roster = resolveRoster(city);
  const aligned = alignCity(truth, predictions, roster);
  const scores = scoreCity(aligned);
  return { city, timezone: truth.timezone, aligned, scores };
}

/**
 * Fetch, align and score one city.
 * @param {{id:string, name:string, lat:number, lon:number}} city
 */
export async function runCity(city) {
  const { truth, predictions } = await fetchCityData(city);
  return scorePayload(city, { truth, predictions });
}

/** Cities fetched at once (2 requests each). Open-Meteo's free tier 429s
 *  bursts, so the fan-out is a small pool rather than everything at once. */
const CITY_CONCURRENCY = 2;

/**
 * Run the pipeline for every configured city. Failures are captured per city
 * so one failed city doesn't blank the page.
 * @returns {Promise<Array<{city:Object} & ({ok:true, result:Awaited<ReturnType<typeof runCity>>} | {ok:false, error:Error})>>}
 */
export async function runAllCities(cities = CITIES) {
  const results = new Array(cities.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < cities.length) {
      const i = cursor++;
      try {
        results[i] = { city: cities[i], ok: true, result: await runCity(cities[i]) };
      } catch (error) {
        results[i] = { city: cities[i], ok: false, error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CITY_CONCURRENCY, cities.length) }, () => worker()),
  );
  return results;
}
