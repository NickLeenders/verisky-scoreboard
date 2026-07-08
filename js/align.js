/**
 * Alignment & cleaning (plan.md §3).
 *
 * Joins prediction and truth series on their hourly timestamp, then drops:
 *  - the most recent local day (truth for it is still incomplete),
 *  - hours where truth is missing (models differ in variable coverage; a pair
 *    without an observation can't be scored),
 *  - nulls pairwise per variable (handled in scoring's per-variable guards).
 *
 * Also aggregates hourly → daily the way the app does for daily displays
 * (daily max/min temperature, precipitation sum, wind max), so web and app
 * numbers agree when people cross-check. Hourly pairs are kept for scoring —
 * the app's score page works on hourly pairs, and the receipt chart later
 * needs yesterday's D-1 hourly precipitation, so nothing is discarded.
 */

import { LEAD_DAYS } from './config.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Local calendar date of an Open-Meteo local ISO timestamp ("2026-07-05T14:00"). */
export function dateKeyOf(isoLocal) {
  return isoLocal.slice(0, 10);
}

/** Minimum truth hours for a day's daily aggregate to be trusted (DST days have 23). */
const MIN_DAILY_HOURS = 20;

/**
 * @typedef {Object} HourPair
 * @property {string} time     Local ISO timestamp.
 * @property {string} dateKey  Local calendar date.
 * @property {{temperature:number, precipitation:number|null, wind:number|null}} truth
 * @property {{temperature:number, precipitation:number|null, wind:number|null}} pred
 */

/**
 * @typedef {Object} AlignedCity
 * @property {import('./config.js').ModelConfig[]} roster  The city's model set (§1a),
 *   carried through so score/derive iterate the same models the fetch requested.
 * @property {string[]} scoredDates  Local dates that survived cleaning, ascending.
 * @property {Array<{time:string, dateKey:string, temperature:number, precipitation:number|null, wind:number|null}>} truthHours
 *   Cleaned truth hours (the window the rain-eligibility gate is computed over).
 * @property {Record<string, Record<number, HourPair[]>>} pairs
 *   `pairs[modelId][leadDay]` → matched hourly forecast/observation pairs.
 * @property {Record<string, {tMax:number, tMin:number, precipSum:number, windMax:number|null}>} dailyTruth
 * @property {Record<string, Record<number, Record<string, {tMax:number, tMin:number, precipSum:number, windMax:number|null}>>>} dailyPred
 *   `dailyPred[modelId][leadDay][dateKey]`.
 */

/**
 * Join one city's truth and prediction responses into scoring-ready pairs.
 *
 * @param {import('./fetch.js').TruthData} truth
 * @param {import('./fetch.js').PredictionData} predictions
 * @param {import('./config.js').ModelConfig[]} roster  The city's model set (§1a).
 * @returns {AlignedCity}
 */
export function alignCity(truth, predictions, roster) {
  // The most recent local day in the truth series is today — incomplete, drop it.
  const lastDate = truth.times.length > 0 ? dateKeyOf(truth.times[truth.times.length - 1]) : null;

  // Index truth hours by timestamp, keeping only complete-window hours.
  const truthByTime = new Map();
  const truthHours = [];
  for (let i = 0; i < truth.times.length; i++) {
    const time = truth.times[i];
    const dk = dateKeyOf(time);
    if (dk === lastDate) continue; // incomplete current day
    const temperature = truth.series.temperature[i];
    if (!isNum(temperature)) continue; // no observation, nothing to verify against
    const row = {
      time,
      dateKey: dk,
      temperature,
      precipitation: isNum(truth.series.precipitation[i]) ? truth.series.precipitation[i] : null,
      wind: isNum(truth.series.wind[i]) ? truth.series.wind[i] : null,
    };
    truthByTime.set(time, row);
    truthHours.push(row);
  }

  // Matched hourly pairs per model × lead day. Temperature anchors the join
  // (it is the always-present variable, same as the app's GhostPoint);
  // precipitation and wind stay nullable and are guarded in scoring.
  const pairs = {};
  for (const model of roster) {
    const perLead = {};
    const modelPred = predictions.pred[model.id];
    if (modelPred) {
      for (const day of LEAD_DAYS) {
        if (day > model.maxLeadDays) continue; // cap to the model's usable horizon
        const temp = modelPred.temperature[day];
        if (!temp) continue;
        const precip = modelPred.precipitation[day];
        const wind = modelPred.wind[day];
        const rows = [];
        for (let i = 0; i < predictions.times.length; i++) {
          const time = predictions.times[i];
          const truthRow = truthByTime.get(time);
          if (!truthRow) continue;
          const t = temp[i];
          if (!isNum(t)) continue;
          rows.push({
            time,
            dateKey: truthRow.dateKey,
            truth: truthRow,
            pred: {
              temperature: t,
              precipitation: precip && isNum(precip[i]) ? precip[i] : null,
              wind: wind && isNum(wind[i]) ? wind[i] : null,
            },
          });
        }
        if (rows.length > 0) perLead[day] = rows;
      }
    }
    pairs[model.id] = perLead;
  }

  // Hourly → daily aggregation, app-style: daily max/min temp, precip sum, wind max.
  const dailyTruth = aggregateDaily(truthHours.map((r) => ({
    dateKey: r.dateKey,
    temperature: r.temperature,
    precipitation: r.precipitation,
    wind: r.wind,
  })));

  const dailyPred = {};
  for (const model of roster) {
    dailyPred[model.id] = {};
    for (const [day, rows] of Object.entries(pairs[model.id])) {
      dailyPred[model.id][day] = aggregateDaily(rows.map((r) => ({
        dateKey: r.dateKey,
        temperature: r.pred.temperature,
        precipitation: r.pred.precipitation,
        wind: r.pred.wind,
      })));
    }
  }

  return {
    roster,
    scoredDates: Object.keys(dailyTruth).sort(),
    truthHours,
    pairs,
    dailyTruth,
    dailyPred,
  };
}

/**
 * Collapse hourly rows into per-day aggregates (daily max/min temperature,
 * precipitation sum, wind max). Days with too few hours are dropped — a daily
 * max computed from half a day would disagree with the app.
 */
export function aggregateDaily(rows) {
  const byDay = new Map();
  for (const row of rows) {
    let acc = byDay.get(row.dateKey);
    if (!acc) {
      acc = { hours: 0, tMax: -Infinity, tMin: Infinity, precipSum: 0, windMax: null };
      byDay.set(row.dateKey, acc);
    }
    acc.hours += 1;
    if (row.temperature > acc.tMax) acc.tMax = row.temperature;
    if (row.temperature < acc.tMin) acc.tMin = row.temperature;
    if (row.precipitation != null) acc.precipSum += row.precipitation;
    if (row.wind != null && (acc.windMax == null || row.wind > acc.windMax)) acc.windMax = row.wind;
  }
  const out = {};
  for (const [dateKey, acc] of byDay) {
    if (acc.hours < MIN_DAILY_HOURS) continue;
    out[dateKey] = { tMax: acc.tMax, tMin: acc.tMin, precipSum: acc.precipSum, windMax: acc.windMax };
  }
  return out;
}
