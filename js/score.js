/**
 * Scoring — ported from the app (plan.md §4).
 *
 * The 0–100 per-lead scores use the app's score-page formulas
 * (src/utils/score.ts + the lead-bucket accumulator in useScoreLeadTimeData.ts),
 * with the error caps recalibrated for this scoreboard (2026-07-07) so the
 * 0–100 range isn't crushed by the rain-F1 floor (which sits ~20–40 for the
 * whole roster). The formula *shapes* match the app; the cap *magnitudes* below
 * are a touch more forgiving, so web and app per-lead numbers no longer match
 * exactly — the ranking order is unchanged (the caps are monotonic):
 *
 *  - Temperature: RMSE over hourly pairs, mapped to 0–100 with a 6.5 °C cap
 *    (score = clamp01(1 − rmse/6.5) · 100).
 *  - Wind: normalized RMSE — the cap scales with the mean observed wind speed
 *    (max(14 km/h, 60% of mean observed)) so windy locations are judged on
 *    relative error rather than raw km/h.
 *  - Rain: F1 of rain/no-rain calls at a 0.1 mm/h threshold with a 0.1 mm
 *    deadband (hours where either side sits within the deadband are ignored —
 *    drizzle right at the threshold is a coin flip, not skill). Rain is only
 *    scored at all when the window had a real rain signal: ≥ 3 rain-event
 *    hours totalling ≥ 1 mm; otherwise every model would trivially ace a dry
 *    month.
 *
 * On top of the app scores, each model × variable × lead day also gets plain
 * diagnostics: MAE and mean bias (forecast − observed) for temperature and
 * wind; rain/no-rain hit rate and amount MAE for precipitation.
 *
 * Headline skill (decided 2026-07-06, revised 2026-07-07, no lead selector):
 * one number per model spanning ALL lead days. First compute the 1/d-weighted
 * score over the lead days the model actually serves, then multiply it by a
 * soft horizon factor: 0.75 + 0.25 × coverage, where coverage is the share of
 * the total 1/d weight covered by that model. Tomorrow counts 7× next week,
 * matching how forecasts are actually relied on, while accurate long-range
 * forecasts still add value. This keeps D-1 specialists recognizable (a perfect
 * D-1-only model can max out around 85) without letting short-horizon models
 * ignore the harder days entirely. Per-metric column scores use the same
 * weighting.
 */

import { LEAD_DAYS } from './config.js';

// ── Score caps (formula shapes from the app's src/utils/score.ts; the cap
//    magnitudes recalibrated for this board — see the header note) ────────────

const TEMP_RMSE_CAP_C = 6.5;
const WIND_RMSE_CAP_KMH = 14;
// Fraction of the mean observed wind speed at which the wind score reaches 0.
const WIND_NRMSE_CAP_FRACTION = 0.6;
const RAIN_THRESHOLD_MM = 0.1;
const RAIN_DEADBAND_MM = 0.1;
const RAIN_MIN_SCORE_EVENT_HOURS = 3;
const RAIN_MIN_SCORE_TOTAL_MM = 1;

export const SCORE_CONFIG = {
  tempRmseCapC: TEMP_RMSE_CAP_C,
  windRmseCapKmh: WIND_RMSE_CAP_KMH,
  windNrmseCapFraction: WIND_NRMSE_CAP_FRACTION,
  rainThresholdMm: RAIN_THRESHOLD_MM,
  rainDeadbandMm: RAIN_DEADBAND_MM,
  rainMinScoreEventHours: RAIN_MIN_SCORE_EVENT_HOURS,
  rainMinScoreTotalMm: RAIN_MIN_SCORE_TOTAL_MM,
};

// ── Score primitives ported verbatim from the app ───────────────────────────

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function rmseScore(sumSq, count, cap) {
  if (count === 0) return null;
  const rmse = Math.sqrt(sumSq / count);
  return clamp01(1 - rmse / cap) * 100;
}

function windRmseScore(sumSq, count, actualSum) {
  if (count === 0) return null;
  const rmse = Math.sqrt(sumSq / count);
  const meanActual = actualSum / count;
  const cap = Math.max(WIND_RMSE_CAP_KMH, meanActual * WIND_NRMSE_CAP_FRACTION);
  return clamp01(1 - rmse / cap) * 100;
}

function f1Score(tp, fp, fn, used) {
  if (used === 0 || tp + fn === 0) return null;
  if (tp === 0) return 0;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  return ((2 * precision * recall) / (precision + recall)) * 100;
}

function isRainEventForScoring(precipitation) {
  return (
    precipitation > RAIN_THRESHOLD_MM &&
    Math.abs(precipitation - RAIN_THRESHOLD_MM) >= RAIN_DEADBAND_MM
  );
}

/**
 * Rain-eligibility gate over the cleaned truth window, same as the app's
 * createModelScoreContext: rain is scored only when the window contains
 * ≥ 3 rain-event hours totalling ≥ 1 mm.
 */
export function computeRainEligibility(truthHours) {
  let rainEventHours = 0;
  let rainEventTotalMm = 0;
  for (const row of truthHours) {
    if (row.precipitation != null && isRainEventForScoring(row.precipitation)) {
      rainEventHours += 1;
      rainEventTotalMm += row.precipitation;
    }
  }
  return {
    rainEventHours,
    rainEventTotalMm,
    rainScoreEligible:
      rainEventHours >= RAIN_MIN_SCORE_EVENT_HOURS && rainEventTotalMm >= RAIN_MIN_SCORE_TOTAL_MM,
  };
}

// ── Per-lead accumulation (the app's accumulate(), plus MAE/bias tallies) ────

function newAcc() {
  return {
    tempSumSq: 0, tempAbsSum: 0, tempBiasSum: 0, tempCount: 0,
    windSumSq: 0, windAbsSum: 0, windBiasSum: 0, windActualSum: 0, windCount: 0,
    rainTp: 0, rainFp: 0, rainFn: 0, rainTn: 0, rainUsed: 0,
    rainAmountAbsSum: 0, rainAmountCount: 0,
  };
}

function accumulate(acc, pred, truth, rainEligible) {
  const tempDiff = pred.temperature - truth.temperature;
  acc.tempSumSq += tempDiff * tempDiff;
  acc.tempAbsSum += Math.abs(tempDiff);
  acc.tempBiasSum += tempDiff;
  acc.tempCount += 1;

  if (pred.precipitation != null && truth.precipitation != null) {
    const amountDiff = pred.precipitation - truth.precipitation;
    acc.rainAmountAbsSum += Math.abs(amountDiff);
    acc.rainAmountCount += 1;

    if (rainEligible) {
      const actualDiff = Math.abs(truth.precipitation - RAIN_THRESHOLD_MM);
      const predictedDiff = Math.abs(pred.precipitation - RAIN_THRESHOLD_MM);
      if (actualDiff >= RAIN_DEADBAND_MM && predictedDiff >= RAIN_DEADBAND_MM) {
        const actualPos = truth.precipitation > RAIN_THRESHOLD_MM;
        const predictedPos = pred.precipitation > RAIN_THRESHOLD_MM;
        if (actualPos && predictedPos) acc.rainTp += 1;
        else if (!actualPos && predictedPos) acc.rainFp += 1;
        else if (actualPos && !predictedPos) acc.rainFn += 1;
        else acc.rainTn += 1;
        acc.rainUsed += 1;
      }
    }
  }

  if (pred.wind != null && truth.wind != null) {
    const windDiff = pred.wind - truth.wind;
    acc.windSumSq += windDiff * windDiff;
    acc.windAbsSum += Math.abs(windDiff);
    acc.windBiasSum += windDiff;
    acc.windActualSum += truth.wind;
    acc.windCount += 1;
  }
}

function finalizeLead(acc, rainEligible) {
  return {
    temperature: {
      score: rmseScore(acc.tempSumSq, acc.tempCount, TEMP_RMSE_CAP_C),
      mae: acc.tempCount > 0 ? acc.tempAbsSum / acc.tempCount : null,
      bias: acc.tempCount > 0 ? acc.tempBiasSum / acc.tempCount : null,
      count: acc.tempCount,
    },
    wind: {
      score: windRmseScore(acc.windSumSq, acc.windCount, acc.windActualSum),
      mae: acc.windCount > 0 ? acc.windAbsSum / acc.windCount : null,
      bias: acc.windCount > 0 ? acc.windBiasSum / acc.windCount : null,
      count: acc.windCount,
    },
    rain: {
      score: rainEligible ? f1Score(acc.rainTp, acc.rainFp, acc.rainFn, acc.rainUsed) : null,
      hitRate: acc.rainUsed > 0 ? ((acc.rainTp + acc.rainTn) / acc.rainUsed) * 100 : null,
      amountMae: acc.rainAmountCount > 0 ? acc.rainAmountAbsSum / acc.rainAmountCount : null,
      tp: acc.rainTp, fp: acc.rainFp, fn: acc.rainFn, tn: acc.rainTn,
      count: acc.rainUsed,
    },
  };
}

/**
 * Score one set of hourly pairs with the app's formulas — the per-lead unit of
 * scoring, exported so derived views (per-day form dots, week-ago snapshots)
 * reuse the exact same math instead of reimplementing it.
 * @param {import('./align.js').HourPair[]} rows
 * @param {boolean} rainEligible
 */
export function scoreHourRows(rows, rainEligible) {
  const acc = newAcc();
  for (const row of rows) accumulate(acc, row.pred, row.truth, rainEligible);
  return finalizeLead(acc, rainEligible);
}

// ── Lead-weighted aggregation (headline skill) ───────────────────────────────

const leadWeight = (day) => 1 / day;
const TOTAL_LEAD_WEIGHT = LEAD_DAYS.reduce((sum, day) => sum + leadWeight(day), 0);
const HORIZON_FACTOR_FLOOR = 0.75;

const METRICS = ['temperature', 'rain', 'wind'];

/** Equal-weight mean of the metric scores available at one lead day. */
export function combinedLeadScore(lead) {
  let sum = 0;
  let n = 0;
  for (const metric of METRICS) {
    const s = lead[metric].score;
    if (s != null) {
      sum += s;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * Soft horizon-adjusted score. First average over served leads with w_d = 1/d,
 * then apply a coverage factor with a 0.75 floor so short-range specialists are
 * not crushed, but longer accurate horizons still lift the headline score.
 */
export function leadWeightedMean(scoreByLead) {
  const byDay = new Map(scoreByLead);
  let weighted = 0;
  let servedWeight = 0;
  for (const day of LEAD_DAYS) {
    const score = byDay.get(day);
    if (score == null) continue;
    const w = leadWeight(day);
    weighted += w * score;
    servedWeight += w;
  }
  if (servedWeight === 0) return null;
  const servedSkill = weighted / servedWeight;
  const coverage = servedWeight / TOTAL_LEAD_WEIGHT;
  const horizonFactor = HORIZON_FACTOR_FLOOR + (1 - HORIZON_FACTOR_FLOOR) * coverage;
  return servedSkill * horizonFactor;
}

// ── Rain record (next-day only — "did it rain the next day" is the claim
//    people actually check) ──────────────────────────────────────────────────

/**
 * W–L record of correct D-1 daily rain/no-rain calls over the window, at the
 * 0.1 mm daily-total threshold.
 */
export function computeRainRecord(dailyTruth, dailyPredD1) {
  let wins = 0;
  let losses = 0;
  const days = [];
  if (!dailyPredD1) return { wins, losses, days };
  for (const dateKey of Object.keys(dailyTruth).sort()) {
    const pred = dailyPredD1[dateKey];
    if (!pred) continue;
    const actualRain = dailyTruth[dateKey].precipSum > RAIN_THRESHOLD_MM;
    const predictedRain = pred.precipSum > RAIN_THRESHOLD_MM;
    const correct = actualRain === predictedRain;
    if (correct) wins += 1;
    else losses += 1;
    days.push({ dateKey, actualRain, predictedRain, correct });
  }
  return { wins, losses, days };
}

// ── City scoring entry point ─────────────────────────────────────────────────

/**
 * Score every model for one aligned city.
 *
 * @param {import('./align.js').AlignedCity} aligned
 * @returns {{
 *   roster: import('./config.js').ModelConfig[],
 *   rainEligibility: {rainEventHours:number, rainEventTotalMm:number, rainScoreEligible:boolean},
 *   models: Record<string, {
 *     perLead: Record<number, ReturnType<typeof finalizeLead>>,
 *     skill: number|null,
 *     metricSkill: {temperature:number|null, rain:number|null, wind:number|null},
 *     rainRecord: {wins:number, losses:number, days:Array},
 *   }>,
 * }}
 */
export function scoreCity(aligned) {
  const rainEligibility = computeRainEligibility(aligned.truthHours);
  const { rainScoreEligible } = rainEligibility;

  const models = {};
  for (const model of aligned.roster) {
    const perLead = {};
    for (const day of LEAD_DAYS) {
      const rows = aligned.pairs[model.id]?.[day];
      if (!rows || rows.length === 0) continue;
      perLead[day] = scoreHourRows(rows, rainScoreEligible);
    }

    const skill = leadWeightedMean(
      Object.entries(perLead).map(([day, lead]) => [Number(day), combinedLeadScore(lead)]),
    );
    const metricSkill = {};
    for (const metric of METRICS) {
      metricSkill[metric] = leadWeightedMean(
        Object.entries(perLead).map(([day, lead]) => [Number(day), lead[metric].score]),
      );
    }

    models[model.id] = {
      perLead,
      skill,
      metricSkill,
      rainRecord: computeRainRecord(aligned.dailyTruth, aligned.dailyPred[model.id]?.[1]),
    };
  }

  return { roster: aligned.roster, rainEligibility, models };
}
