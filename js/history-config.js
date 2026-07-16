/**
 * Configuration for the long-term model-quality trends feature (history.html).
 *
 * The live scoreboard scores a rolling 30-day window; this measures how each
 * model's error has moved over its full previous-runs archive (2.5+ years for
 * some), one calendar month at a time. v1 covers NOAA's models at New York, but
 * everything here is a pure function of the city so more can be added later.
 *
 * Reuses the live config: the roster is `resolveRoster(city)` filtered to NOAA,
 * so bounds-gating (HRRR/NBM/NAM are CONUS-only) and per-model `maxLeadDays`
 * come for free and stay in sync with the main board.
 */

import { resolveRoster, CITIES } from './config.js';

/** Cities we bake long-term history for. v1: New York only. */
export const HISTORY_CITY_IDS = ['newyork'];

/** The city objects we bake, in order. */
export const HISTORY_CITIES = HISTORY_CITY_IDS
  .map((id) => CITIES.find((c) => c.id === id))
  .filter(Boolean);

/**
 * Models excluded from the history roster despite being NOAA, because they carry
 * no useful INDEPENDENT previous-runs signal (verified live at NYC 2026-07-16):
 *
 *  - gfs_hrrr: over CONUS the seamless GFS product already uses HRRR at short
 *    lead, so `gfs_seamless_previous_day1` is byte-identical to
 *    `gfs_hrrr_previous_day1`, and HRRR has no day-2+ previous-runs archive — it
 *    would only draw a duplicate line on top of GFS.
 *
 * (NAM — `ncep_nam_conus` — has no usable previous-runs archive at NYC either,
 * but that is location-specific, so the backfill drops zero-data models
 * automatically rather than hardcoding it here.)
 */
const HISTORY_EXCLUDE_IDS = new Set(['gfs_hrrr']);

/**
 * The models to chart history for, for a given city: the city's roster narrowed
 * to NOAA, minus models with no independent previous-runs signal. At New York
 * that yields GFS, AIGFS, NBM (and NAM, which the backfill then drops as empty).
 *
 * @param {{country?:string, lat:number, lon:number}} city
 * @returns {import('./config.js').ModelConfig[]}
 */
export function historyModelsFor(city) {
  return resolveRoster(city).filter((m) => m.provider === 'NOAA' && !HISTORY_EXCLUDE_IDS.has(m.id));
}

/**
 * First month (YYYY-MM) to attempt per model. These are optimizations only —
 * the backfill caches and trims leading all-null months anyway, so a hint that
 * is too early just wastes a handful of calls and one that is too late is
 * corrected on the next run once real data appears. Verified by live probes at
 * New York, 2026-07-16.
 */
export const HISTORY_START_HINTS = {
  gfs_seamless: '2021-03', // temperature reaches back to Mar 2021; precip/wind begin ~2024
  ncep_aigfs025: '2026-01', // very short archive, begins H1 2026
  default: '2024-01', // HRRR, NBM, NAM all begin somewhere in 2024
};

// ── Month helpers (YYYY-MM strings) ──────────────────────────────────────────

/** "2024-03" → { year: 2024, month: 3 }. */
function parseYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { year: y, month: m };
}

/** { year, month } → "YYYY-MM" (month 1–12, zero-padded). */
function formatYm(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The month after `ym`. "2024-12" → "2025-01". */
export function nextMonth(ym) {
  const { year, month } = parseYm(ym);
  return month === 12 ? formatYm(year + 1, 1) : formatYm(year, month + 1);
}

/** The current calendar month in the given timezone-naive "now" (UTC-based). */
export function currentMonthYm(now = new Date()) {
  return formatYm(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/** The last COMPLETE month — one before the current month. */
export function lastCompleteMonthYm(now = new Date()) {
  const cur = currentMonthYm(now);
  const { year, month } = parseYm(cur);
  return month === 1 ? formatYm(year - 1, 12) : formatYm(year, month - 1);
}

/** Inclusive list of months from `fromYm` to `toYm`. Empty if from > to. */
export function monthRange(fromYm, toYm) {
  const out = [];
  let ym = fromYm;
  while (ym <= toYm) {
    out.push(ym);
    ym = nextMonth(ym);
  }
  return out;
}

/** First day of a month as an ISO date. "2024-03" → "2024-03-01". */
export function monthStartDate(ym) {
  return `${ym}-01`;
}

/**
 * First day of the month AFTER `ym`, as an ISO date — used as the API
 * `end_date`. The extra day is deliberate: `alignCity` drops the last local
 * truth day, so requesting one day into the next month means the whole target
 * month is scored while the dropped "incomplete" day is the out-of-bucket one.
 */
export function monthEndDateExclusive(ym) {
  return monthStartDate(nextMonth(ym));
}
