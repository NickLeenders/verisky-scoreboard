/**
 * Sanitized preset-city scoreboard supplied by api.verisky.app.
 *
 * This endpoint exposes aggregate scores only. It accepts a fixed city slug,
 * not coordinates, models, providers, or run selectors. Commercial forecast
 * series therefore never enter the browser, localStorage, or the static bake.
 * The separate daily-summary response is consumed by server-compare.js.
 *
 * ── Score model v2 ──────────────────────────────────────────────────────────
 * The payload carries both score models side by side, exactly as the app's
 * /scores payload does: `skill`/`metricSkill`/`perLead` keep the v1
 * (error-based) numbers, and `skillV2`/`metricSkillV2`/`perLeadV2`/`components`
 * ride alongside once the server has banked enough days of v2 counters at the
 * cell. This page prefers v2 and falls back per field, so the response version
 * never has to change and a deploy of either end alone is safe in both
 * directions: an older server simply serves no v2 fields and the board renders
 * the old numbers, and an older page ignores the new ones.
 *
 * The v1 numbers are kept, not discarded: they are what the expanded row's
 * "was #N under the old error score" line is computed from.
 */

import { scoreboardModelById, siteSlug } from './config.js';

const SCOREBOARD_BASE = 'https://api.verisky.app/scoreboard/v1';
const RESPONSE_VERSION = 1;
const OMITTED_MODEL_IDS = new Set(['accuweather']);

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const intOrNull = (value) => (Number.isInteger(value) ? value : null);

function metricScore(value) {
  return { score: finiteOrNull(value) };
}

/** Prefer the v2 number, fall back to the v1 one where it is absent. */
const preferV2 = (v2, v1) => finiteOrNull(v2) ?? finiteOrNull(v1);

function metricSkillOf(row) {
  const v1 = row.metricSkill ?? {};
  const v2 = row.metricSkillV2 ?? {};
  return {
    temperature: preferV2(v2.temperature, v1.temperature),
    rain: preferV2(v2.rain, v1.rain),
    wind: preferV2(v2.wind, v1.wind),
  };
}

/**
 * The v2 breakdown behind one metric. Kept defensive field by field: the
 * server emits `eventHits`/`falseAlarms`/`sharpness` only where it has them
 * (grid cells bank no sharpness sums), and null there means "not measured",
 * which the UI must render as an em dash rather than as a zero.
 */
function metricComponents(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    accuracy: finiteOrNull(raw.accuracy),
    hitCount: intOrNull(raw.hitCount) ?? 0,
    count: intOrNull(raw.count) ?? 0,
    extremes: finiteOrNull(raw.extremes),
    eventHours: intOrNull(raw.eventHours) ?? 0,
    eventHits: intOrNull(raw.eventHits),
    falseAlarms: intOrNull(raw.falseAlarms),
    sharpness: finiteOrNull(raw.sharpness),
    typicalError: finiteOrNull(raw.typicalError),
  };
}

function eventComponents(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    eventHours: intOrNull(raw.eventHours) ?? 0,
    eventHits: intOrNull(raw.eventHits) ?? 0,
    falseAlarms: intOrNull(raw.falseAlarms) ?? 0,
    calledHits: intOrNull(raw.calledHits) ?? intOrNull(raw.eventHits) ?? 0,
  };
}

function componentsOf(row) {
  const raw = row.components;
  if (!raw || typeof raw !== 'object') return null;
  return {
    temperature: metricComponents(raw.temperature),
    wind: metricComponents(raw.wind),
    rain: eventComponents(raw.rain),
  };
}

function hydrateRow(row, rank) {
  if (!row || typeof row.modelId !== 'string' || OMITTED_MODEL_IDS.has(row.modelId)) return null;
  const model = scoreboardModelById(row.modelId);
  if (!model) return null;

  const perLeadV2 = row.perLeadV2 ?? {};
  const perLead = {};
  for (const [dayKey, lead] of Object.entries(row.perLead ?? {})) {
    const day = Number(dayKey);
    if (!Number.isInteger(day) || day < 1 || day > 7 || !lead) continue;
    const v2 = perLeadV2[dayKey] ?? {};
    perLead[day] = {
      temperature: metricScore(preferV2(v2.temperature, lead.temperature)),
      rain: metricScore(preferV2(v2.rain, lead.rain)),
      wind: metricScore(preferV2(v2.wind, lead.wind)),
    };
  }

  const formDots = Array.isArray(row.formDotsV2) ? row.formDotsV2 : row.formDots;

  return {
    model,
    rank,
    skill: preferV2(row.skillV2, row.skill),
    metricSkill: metricSkillOf(row),
    components: componentsOf(row),
    // The retired error-based headline, kept for the "was #N" comparison. Null
    // once the server stops serving v2 alongside it (then there is nothing to
    // compare against and the row simply omits the line).
    errorSkill: finiteOrNull(row.skillV2) != null ? finiteOrNull(row.skill) : null,
    errorRank: null, // filled in below, once every row's error skill is known
    /** Days of the window whose banked stats carry the v2 counters. */
    v2CoveredDays: intOrNull(row.v2CoveredDays),
    rainRecord: {
      wins: Number.isInteger(row.rainRecord?.wins) ? row.rainRecord.wins : 0,
      losses: Number.isInteger(row.rainRecord?.losses) ? row.rainRecord.losses : 0,
    },
    movement: intOrNull(Number.isInteger(row.movementV2) ? row.movementV2 : row.movement),
    formDots: Array.isArray(formDots)
      ? formDots.filter((dot) => dot === 'hit' || dot === 'miss' || dot === 'na')
      : [],
    perLead,
  };
}

export function hydratePresetScoreboard(payload, expectedCityId) {
  if (
    !payload ||
    payload.version !== RESPONSE_VERSION ||
    payload.city?.id !== expectedCityId ||
    !Array.isArray(payload.standings)
  ) {
    throw new Error('Invalid preset scoreboard response');
  }

  const rows = payload.standings
    .map((row, index) => hydrateRow(row, index + 1))
    .filter((row) => row && row.skill != null);
  if (rows.length === 0) throw new Error('Preset scoreboard has no scored models');

  // Re-rank after defensive filtering (notably the explicit AccuWeather guard).
  // The server sorts by its own headline; sort here too so the displayed order
  // always matches the score this page decided to show.
  rows.sort((a, b) => b.skill - a.skill);
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });

  // Ranking under the retired error score, from the v1 numbers in the same
  // payload — the standings this board would have shown before v2.
  const errorRanked = rows
    .filter((row) => row.errorSkill != null)
    .sort((a, b) => b.errorSkill - a.errorSkill);
  errorRanked.forEach((row, index) => {
    row.errorRank = index + 1;
  });

  const roster = rows.map((row) => row.model);
  const models = Object.fromEntries(
    rows.map((row) => [
      row.model.id,
      {
        skill: row.skill,
        metricSkill: row.metricSkill,
        components: row.components,
        rainRecord: row.rainRecord,
        perLead: row.perLead,
      },
    ]),
  );

  return {
    city: payload.city,
    // Airport boards only: the METAR weather station behind the board's cell.
    station: payload.station && typeof payload.station.icao === 'string'
      ? { icao: payload.station.icao, name: String(payload.station.name ?? payload.station.icao) }
      : null,
    asOf: payload.asOf,
    computedAt: payload.computedAt,
    lookbackDays: payload.lookbackDays,
    scoredDays: payload.scoredDays,
    dateRange: payload.dateRange,
    timezone: payload.timezone,
    /**
     * Days of the window that carry v2 counters, over all rows. The server
     * banks them forward from the day score v2 went live, so a 30-day window
     * can score temperature and wind over fewer days than rain until it fills.
     * Null when the server served no v2 at all.
     */
    v2CoveredDays: rows.reduce(
      (max, row) => (row.v2CoveredDays == null ? max : Math.max(max ?? 0, row.v2CoveredDays)),
      null,
    ),
    rows,
    scores: {
      roster,
      models,
      rainEligibility: {
        rainEventHours: Number(payload.rainEligibility?.rainEventHours) || 0,
        rainEventTotalMm: Number(payload.rainEligibility?.rainEventTotalMm) || 0,
        rainScoreEligible: payload.rainEligibility?.rainScoreEligible === true,
      },
    },
  };
}

/** Fetch aggregate scores for a preset (city or its `<id>-airport` variant).
 *  Custom locations deliberately return null. */
export async function fetchPresetScoreboard(city) {
  const slug = siteSlug(city);
  if (!slug) return null;
  const url = `${SCOREBOARD_BASE}/${encodeURIComponent(slug)}.json`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Preset scoreboard request failed (HTTP ${response.status})`);
  }
  return hydratePresetScoreboard(await response.json(), slug);
}
