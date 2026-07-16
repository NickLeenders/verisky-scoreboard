/**
 * Configuration for the long-term model-quality trends feature (history.html).
 *
 * The live scoreboard scores a rolling 30-day window; this measures how each
 * model's error has moved over its full previous-runs archive (up to ~5 years
 * for GFS/JMA), one calendar month at a time. Covers every default city with its
 * full roster, and is a pure function of the city so more can be added later.
 *
 * Reuses the live config: the roster is `resolveRoster(city)`, so bounds-gating
 * (regional models only appear in-region) and per-model `maxLeadDays` come for
 * free and stay in sync with the main board.
 */

import { resolveRoster, CITIES } from './config.js';

/** Cities we bake long-term history for: every default scoreboard city. */
export const HISTORY_CITY_IDS = CITIES.map((c) => c.id);

/** The city objects we bake, in order. */
export const HISTORY_CITIES = HISTORY_CITY_IDS
  .map((id) => CITIES.find((c) => c.id === id))
  .filter(Boolean);

/**
 * Models excluded from history because they carry no INDEPENDENT previous-runs
 * signal (verified live 2026-07-16):
 *
 *  - gfs_hrrr: over CONUS the seamless GFS product already uses HRRR at short
 *    lead, so `gfs_seamless_previous_day1` is byte-identical to
 *    `gfs_hrrr_previous_day1`, and HRRR has no day-2+ previous-runs archive — it
 *    would only draw a duplicate line on top of GFS.
 *
 * Models that merely lack an archive at some location (rather than duplicating
 * another) are NOT listed here — the backfill drops zero-data model×city pairs
 * automatically, so a regional model with no coverage just disappears there.
 */
const HISTORY_EXCLUDE_IDS = new Set(['gfs_hrrr']);

/**
 * The models to chart history for, for a given city: its full live roster minus
 * the structural-duplicate exclusions above. Bounds-gating already keeps
 * regional models to their region (via resolveRoster).
 *
 * @param {{country?:string, lat:number, lon:number}} city
 * @returns {import('./config.js').ModelConfig[]}
 */
export function historyModelsFor(city) {
  return resolveRoster(city).filter((m) => !HISTORY_EXCLUDE_IDS.has(m.id));
}

/**
 * First month (YYYY-MM) to attempt per model — the model's previous-runs archive
 * start, from live probes (2026-07-16). These are optimizations: the backfill
 * caches and trims leading all-null months anyway, so a hint that is slightly
 * too early only wastes a few cached calls. A hint must be at or before the true
 * start (too-late would silently skip real data), so they err early.
 *
 * `HISTORY_FLOOR_MONTH` caps how far back we go even when an archive is deeper
 * (JMA reaches ~2018, GFS temp ~2021) — 2021 is already well beyond the ~2.5-year
 * question and keeps every city's truth range bounded.
 */
export const HISTORY_FLOOR_MONTH = '2021-01';

export const HISTORY_START_HINTS = {
  // Deep archives (clamped to the floor).
  gfs_seamless: '2021-03', // temperature to Mar 2021; precip/wind begin ~2024
  jma_seamless: '2021-01', // reaches ~2018, but floored at 2021
  // Begin somewhere in H1 2024.
  ecmwf_ifs025: '2024-01',
  icon_seamless: '2024-01',
  knmi_seamless: '2024-01',
  meteofrance_seamless: '2024-01',
  dmi_seamless: '2024-01',
  gem_seamless: '2024-01',
  cma_grapes_global: '2024-01',
  ncep_nbm_conus: '2024-01',
  // Later starters.
  ukmo_seamless: '2024-06',
  ecmwf_aifs025_single: '2025-01',
  kma_seamless: '2025-01',
  ncep_nam_conus: '2025-01',
  ncep_aigfs025: '2026-01', // very short archive, begins H1 2026
  default: '2024-01',
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
