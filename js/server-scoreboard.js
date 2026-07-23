/**
 * Sanitized preset-city scoreboard supplied by api.verisky.app.
 *
 * This endpoint exposes aggregate scores only. It accepts a fixed city slug,
 * not coordinates, models, providers, or run selectors. Commercial forecast
 * values therefore never enter the browser, localStorage, or the static bake.
 */

import { scoreboardModelById } from './config.js';

const SCOREBOARD_BASE = 'https://api.verisky.app/scoreboard/v1';
const RESPONSE_VERSION = 1;
const OMITTED_MODEL_IDS = new Set(['accuweather']);

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

function metricScore(value) {
  return { score: finiteOrNull(value) };
}

function hydrateRow(row, rank) {
  if (!row || typeof row.modelId !== 'string' || OMITTED_MODEL_IDS.has(row.modelId)) return null;
  const model = scoreboardModelById(row.modelId);
  if (!model) return null;

  const perLead = {};
  for (const [dayKey, lead] of Object.entries(row.perLead ?? {})) {
    const day = Number(dayKey);
    if (!Number.isInteger(day) || day < 1 || day > 7 || !lead) continue;
    perLead[day] = {
      temperature: metricScore(lead.temperature),
      rain: metricScore(lead.rain),
      wind: metricScore(lead.wind),
    };
  }

  return {
    model,
    rank,
    skill: finiteOrNull(row.skill),
    metricSkill: {
      temperature: finiteOrNull(row.metricSkill?.temperature),
      rain: finiteOrNull(row.metricSkill?.rain),
      wind: finiteOrNull(row.metricSkill?.wind),
    },
    rainRecord: {
      wins: Number.isInteger(row.rainRecord?.wins) ? row.rainRecord.wins : 0,
      losses: Number.isInteger(row.rainRecord?.losses) ? row.rainRecord.losses : 0,
    },
    movement: Number.isInteger(row.movement) ? row.movement : null,
    formDots: Array.isArray(row.formDots)
      ? row.formDots.filter((dot) => dot === 'hit' || dot === 'miss' || dot === 'na')
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
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });

  const roster = rows.map((row) => row.model);
  const models = Object.fromEntries(
    rows.map((row) => [
      row.model.id,
      {
        skill: row.skill,
        metricSkill: row.metricSkill,
        rainRecord: row.rainRecord,
        perLead: row.perLead,
      },
    ]),
  );

  return {
    city: payload.city,
    asOf: payload.asOf,
    computedAt: payload.computedAt,
    lookbackDays: payload.lookbackDays,
    scoredDays: payload.scoredDays,
    dateRange: payload.dateRange,
    timezone: payload.timezone,
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

/** Fetch aggregate scores for a preset. Custom locations deliberately return null. */
export async function fetchPresetScoreboard(city) {
  if (!city?.id) return null;
  const url = `${SCOREBOARD_BASE}/${encodeURIComponent(city.id)}.json`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Preset scoreboard request failed (HTTP ${response.status})`);
  }
  return hydratePresetScoreboard(await response.json(), city.id);
}
