/**
 * Scoring — ported from the app (plan.md §4), score model **v2**.
 *
 * The headline number is the app's score v2 (docs/design/score-v2.md in the
 * app repo, shipped 2026-08-10): the anti-blur redesign. v1 ranked temperature
 * and wind by RMSE, and RMSE is minimized by the conditional mean — a model
 * that hedges toward a smooth average is optimally playing the metric, which is
 * why MSE-trained AI models (AIFS, AIGFS) can top an error leaderboard while
 * looking like a blurry mess on a map. v2 replaces the two error metrics with a
 * blend of a tolerance hit rate and an event score:
 *
 *     S = 0.7 · Accuracy + 0.3 · Extremes    (when the window has events)
 *     S = Accuracy                           (otherwise)
 *
 *  - **Accuracy** is the share of hours the forecast landed inside a meaningful
 *    band: 2 °C for temperature, max(5 km/h, 20% of observed) for wind. Beyond
 *    the band a 3 °C miss and a 9 °C miss cost the same, so shaving error
 *    variance by hedging stops buying points; inside it, sharp and smooth are
 *    equals.
 *  - **Extremes** is SEDI (symmetric extremal dependence index, Ferro &
 *    Stephenson 2011) over a 2×2 table of locally-defined event hours. Scoring
 *    only the hours where something happened would hand the win to whoever
 *    over-forecasts drama (the forecaster's dilemma, Lerch et al. 2017), so the
 *    table counts false alarms too. Events are defined against this location's
 *    own climate (see `deriveEventThresholds`), and the component only counts
 *    when the window holds enough event and non-event hours — a calm month has
 *    no extremes to judge, and the weight folds back into Accuracy.
 *  - **Sharpness** (σ of the forecast series over σ of the observed series,
 *    Ben Bouallègue et al. 2024) is computed and displayed, but deliberately
 *    NOT in the score: it is a property, not an accuracy, and folding it in
 *    would invite variance inflation as a counter-game. ~1.0 moves like the
 *    weather; blurred model output reads ~0.7–0.9.
 *
 * Rain does not change: it was already a categorical event score, and it keeps
 * the v1 formula (F1 of rain/no-rain calls at a 0.1 mm/h threshold with a
 * 0.1 mm deadband, since drizzle right at the threshold is a coin flip). The
 * one v2 addition is a per-model minimum-sample gate (below), which the app
 * added on 2026-08-11 after a provider with three weeks of history printed a
 * real-looking rain score off two observed wet hours.
 *
 * The old error-based numbers are still computed and still shown, as
 * `errorScore` (the v1 0–100 score) and `rmse`/`mae`/`bias` diagnostics — the
 * expanded row labels the RMSE "typical error", and `history.html` charts the
 * error score deliberately (see scripts/history-backfill.mjs).
 *
 * Where this board differs from the app, all deliberate:
 *  - **Thresholds come from the scored window itself**, not from a trailing
 *    90-day climatology. The box freezes a 90-day per-cell climatology into
 *    each banked day; a browser has no such history, so this mirrors the app's
 *    documented on-device fallback: same definitions, same gate, thresholds
 *    derived from the same 30 days being scored. Preset cities read the
 *    server's numbers anyway (js/server-scoreboard.js), which do use the
 *    frozen climatology; the in-browser numbers are for searched locations.
 *  - The error caps below (6.5 °C, 14 km/h) were recalibrated for this board
 *    in 2026-07-07 and stay as they were. They now only shape `errorScore`.
 *  - No sun metric: this board scores temperature, rain and wind, matching the
 *    server's public scoreboard projection.
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
 * weighting. None of this changed in v2.
 */

import { LEAD_DAYS } from './config.js';

// ── v1 error caps (formula shapes from the app's src/utils/score.ts; the cap
//    magnitudes recalibrated for this board — see the header note) ────────────

const TEMP_RMSE_CAP_C = 6.5;
const WIND_RMSE_CAP_KMH = 14;
// Fraction of the mean observed wind speed at which the wind score reaches 0.
const WIND_NRMSE_CAP_FRACTION = 0.6;
const RAIN_THRESHOLD_MM = 0.1;
const RAIN_DEADBAND_MM = 0.1;
const RAIN_MIN_SCORE_EVENT_HOURS = 3;
const RAIN_MIN_SCORE_TOTAL_MM = 1;

// ── v2 (anti-blur) constants — identical to the app's SCORE_CONFIG ───────────

/** Accuracy band: |forecast − observed| within this counts as a hit. */
const TEMP_HIT_TOLERANCE_C = 2.0;
const WIND_HIT_TOLERANCE_KMH = 5;
const WIND_HIT_TOLERANCE_FRACTION = 0.2;
/** Weight of the Extremes component when the window has enough event hours. */
const EVENT_WEIGHT = 0.3;
/** Event hours (and non-event hours) required before Extremes counts at all. */
const MIN_EVENT_HOURS = 8;
/**
 * Event thresholds are Gaussian-quantile approximations (mean + k·σ) rather
 * than exact q90, because the box has to derive the same definition from
 * summable banked statistics. 1.645σ is q90 of a centred |anomaly|; 1.282σ is
 * q90 of a one-sided distribution. The floors dominate at mild locations.
 */
const TEMP_EVENT_SIGMA = 1.645;
const TEMP_EVENT_FLOOR_C = 3;
const WIND_EVENT_SIGMA = 1.282;
const WIND_EVENT_FLOOR_KMH = 20;
/** Minimum observed hours before a window may define its own event thresholds. */
const MIN_THRESHOLD_HOURS = 72;
/** Minimum matched pairs before a sharpness ratio is worth showing. */
const MIN_SHARPNESS_HOURS = 24;

export const SCORE_CONFIG = {
  tempRmseCapC: TEMP_RMSE_CAP_C,
  windRmseCapKmh: WIND_RMSE_CAP_KMH,
  windNrmseCapFraction: WIND_NRMSE_CAP_FRACTION,
  rainThresholdMm: RAIN_THRESHOLD_MM,
  rainDeadbandMm: RAIN_DEADBAND_MM,
  rainMinScoreEventHours: RAIN_MIN_SCORE_EVENT_HOURS,
  rainMinScoreTotalMm: RAIN_MIN_SCORE_TOTAL_MM,
  tempHitToleranceC: TEMP_HIT_TOLERANCE_C,
  windHitToleranceKmh: WIND_HIT_TOLERANCE_KMH,
  windHitToleranceFraction: WIND_HIT_TOLERANCE_FRACTION,
  eventWeight: EVENT_WEIGHT,
  minEventHours: MIN_EVENT_HOURS,
  tempEventSigma: TEMP_EVENT_SIGMA,
  tempEventFloorC: TEMP_EVENT_FLOOR_C,
  windEventSigma: WIND_EVENT_SIGMA,
  windEventFloorKmh: WIND_EVENT_FLOOR_KMH,
  minThresholdHours: MIN_THRESHOLD_HOURS,
  minSharpnessHours: MIN_SHARPNESS_HOURS,
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

/** Accuracy component: share of matched hours inside the tolerance band. */
export function scoreHitRate(hits, count) {
  if (count === 0) return null;
  return clamp01(hits / count) * 100;
}

/** Tolerance band for a wind hit: absolute for light winds, relative when windy. */
export function windHitToleranceKmh(observedWindKmh) {
  return Math.max(WIND_HIT_TOLERANCE_KMH, observedWindKmh * WIND_HIT_TOLERANCE_FRACTION);
}

/**
 * SEDI (symmetric extremal dependence index, Ferro & Stephenson 2011) from a
 * 2×2 event table, in [-1, 1]. Base-rate independent and non-degenerate as
 * events get rare, which is why the rare-event literature prefers it over the
 * hit rate or a threat score. The hit and false-alarm rates are clamped to
 * [0.5/n, 1 − 0.5/n], which keeps every log argument inside (0, 1) and the
 * denominator strictly negative, so the expression is always defined.
 */
export function sediFromTable(tp, fp, fn, tn) {
  const n = tp + fp + fn + tn;
  if (n === 0 || tp + fn === 0 || fp + tn === 0) return null;
  const lo = 0.5 / n;
  const hi = 1 - lo;
  const clamp = (v) => Math.min(hi, Math.max(lo, v));
  const h = clamp(tp / (tp + fn));
  const f = clamp(fp / (fp + tn));
  return (
    (Math.log(f) - Math.log(h) - Math.log(1 - f) + Math.log(1 - h)) /
    (Math.log(f) + Math.log(h) + Math.log(1 - f) + Math.log(1 - h))
  );
}

/** Extremes component: SEDI mapped to 0–100 (its zero point is 50, not 0). */
export function scoreSedi(tp, fp, fn, tn) {
  const sedi = sediFromTable(tp, fp, fn, tn);
  return sedi == null ? null : ((sedi + 1) / 2) * 100;
}

/** Enough event and non-event hours for the Extremes component to count. */
export function extremesGatePasses(eventHours, nonEventHours) {
  return eventHours >= MIN_EVENT_HOURS && nonEventHours >= MIN_EVENT_HOURS;
}

/**
 * Enough observed wet hours in a model's own pooled sample for its rain F1 to
 * mean anything. The window-level eligibility gate (≥ 3 rain-event hours over
 * the shared truth series) keeps a dry month from being aced by everyone, but
 * a model that only covers part of the window — a provider enrolled late, or a
 * short-horizon model at long leads — can still land a real-looking score off a
 * couple of wet hours while its false alarms at every other lead stay invisible.
 * Below this floor the rain slot reads unscored, so the chip and the headline
 * agree. The `errorScore` (v1) slot stays ungated.
 */
export function rainSampleGatePasses(observedWetHours) {
  return observedWetHours >= MIN_EVENT_HOURS;
}

/**
 * The v2 metric score: 0.7·Accuracy + 0.3·Extremes when the window holds enough
 * event *and* non-event hours to judge extremes; plain Accuracy otherwise (a
 * calm window has no extremes to score, so the weight folds back rather than
 * punishing the location for quiet weather).
 */
export function combineAccuracyExtremes(accuracy, extremes, eventHours, nonEventHours) {
  if (accuracy == null) return null;
  if (extremes == null || !extremesGatePasses(eventHours, nonEventHours)) return accuracy;
  return (1 - EVENT_WEIGHT) * accuracy + EVENT_WEIGHT * extremes;
}

/**
 * Sharpness (forecast activity, Ben Bouallègue et al. 2024): σ of the forecast
 * series over σ of the observed series, from running sums. Diagnostic only.
 */
export function sharpnessFromSums(predSum, predSumSq, obsSum, obsSumSq, count) {
  if (count < MIN_SHARPNESS_HOURS) return null;
  const predVar = Math.max(0, predSumSq / count - (predSum / count) ** 2);
  const obsVar = Math.max(0, obsSumSq / count - (obsSum / count) ** 2);
  if (obsVar <= 0) return null;
  return Math.sqrt(predVar / obsVar);
}

// ── Event thresholds: what counts as "something happened" here ───────────────

/** Hour of day from an Open-Meteo local ISO timestamp ("2026-07-05T14:00"). */
export function hourOfDay(isoLocal) {
  return Number(isoLocal.slice(11, 13));
}

/**
 * Derive this location's event definitions from its observed series.
 *
 * Temperature events are two one-sided anomalies against a diurnal baseline
 * (the per-hour-of-day mean), because a 25 °C afternoon and a 25 °C night are
 * not the same event; wind events are a single upper threshold. Both are
 * mean + k·σ approximations of a q90, floored so that a mild month cannot
 * declare a 1 °C wobble an extreme.
 *
 * The app derives these from a trailing 90-day climatology on the server and
 * from the scored window on device; this board is the on-device case. Returns
 * null when the sample is too thin to define "unusual for this spot" — v2 then
 * reduces to Accuracy alone.
 *
 * @param {Array<{time:string, temperature:number, wind:number|null}>} truthHours
 */
export function deriveEventThresholds(truthHours) {
  const hourSum = new Array(24).fill(0);
  const hourCount = new Array(24).fill(0);
  let tempCount = 0;
  let windSum = 0;
  let windSumSq = 0;
  let windCount = 0;
  const points = [];
  for (const row of truthHours) {
    if (Number.isFinite(row.temperature)) {
      const h = hourOfDay(row.time);
      hourSum[h] += row.temperature;
      hourCount[h] += 1;
      tempCount += 1;
      points.push(row);
    }
    if (row.wind != null && Number.isFinite(row.wind)) {
      windSum += row.wind;
      windSumSq += row.wind * row.wind;
      windCount += 1;
    }
  }
  if (tempCount < MIN_THRESHOLD_HOURS || windCount < MIN_THRESHOLD_HOURS) return null;

  const overallMean = hourSum.reduce((a, b) => a + b, 0) / tempCount;
  const tempBaselineByHour = hourSum.map((sum, h) =>
    hourCount[h] >= 3 ? sum / hourCount[h] : overallMean,
  );

  let anomSumSq = 0;
  for (const row of points) {
    const anom = row.temperature - tempBaselineByHour[hourOfDay(row.time)];
    anomSumSq += anom * anom;
  }
  const anomSigma = Math.sqrt(anomSumSq / tempCount);
  const windMean = windSum / windCount;
  const windVar = Math.max(0, windSumSq / windCount - windMean * windMean);
  return {
    tempBaselineByHour,
    tempAnomalyC: Math.max(TEMP_EVENT_SIGMA * anomSigma, TEMP_EVENT_FLOOR_C),
    windEventKmh: Math.max(windMean + WIND_EVENT_SIGMA * Math.sqrt(windVar), WIND_EVENT_FLOOR_KMH),
  };
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

export function newAcc() {
  return {
    tempSumSq: 0, tempAbsSum: 0, tempBiasSum: 0, tempCount: 0,
    windSumSq: 0, windAbsSum: 0, windBiasSum: 0, windActualSum: 0, windCount: 0,
    rainTp: 0, rainFp: 0, rainFn: 0, rainTn: 0, rainUsed: 0,
    rainAmountAbsSum: 0, rainAmountCount: 0,
    // v2: Accuracy hits carry their own denominators, mirroring the app's
    // banked counters (a pooled window there can mix days scored before v2).
    tempHit: 0, tempHitN: 0, windHit: 0, windHitN: 0,
    // v2: event 2×2 tables. Temperature pools its warm and cold one-sided
    // tables, so a cold call on a warm day is a false alarm plus a miss and
    // never a hit. All-zero when no thresholds were available.
    tempEvtTp: 0, tempEvtFp: 0, tempEvtFn: 0, tempEvtTn: 0,
    windEvtTp: 0, windEvtFp: 0, windEvtFn: 0, windEvtTn: 0,
    // Sharpness sums. Temperature uses anomalies against the diurnal baseline
    // (raw temperatures would be dominated by the day/night cycle every model
    // gets right); wind uses raw values over the same hours as windHitN.
    tempAnomPredSum: 0, tempAnomPredSumSq: 0,
    tempAnomObsSum: 0, tempAnomObsSumSq: 0, tempAnomCount: 0,
    windPredSum: 0, windPredSumSq: 0, windObsSum: 0, windObsSumSq: 0,
  };
}

function accumulate(acc, row, rainEligible, thresholds) {
  const { pred, truth } = row;
  const tempDiff = pred.temperature - truth.temperature;
  acc.tempSumSq += tempDiff * tempDiff;
  acc.tempAbsSum += Math.abs(tempDiff);
  acc.tempBiasSum += tempDiff;
  acc.tempCount += 1;
  acc.tempHitN += 1;
  if (Math.abs(tempDiff) <= TEMP_HIT_TOLERANCE_C) acc.tempHit += 1;

  if (thresholds) {
    const baseline = thresholds.tempBaselineByHour[hourOfDay(row.time)];
    const anomObs = truth.temperature - baseline;
    const anomPred = pred.temperature - baseline;
    const t = thresholds.tempAnomalyC;
    for (const sign of [1, -1]) {
      const obsEvt = sign * anomObs >= t;
      const predEvt = sign * anomPred >= t;
      if (obsEvt && predEvt) acc.tempEvtTp += 1;
      else if (!obsEvt && predEvt) acc.tempEvtFp += 1;
      else if (obsEvt && !predEvt) acc.tempEvtFn += 1;
      else acc.tempEvtTn += 1;
    }
    acc.tempAnomPredSum += anomPred;
    acc.tempAnomPredSumSq += anomPred * anomPred;
    acc.tempAnomObsSum += anomObs;
    acc.tempAnomObsSumSq += anomObs * anomObs;
    acc.tempAnomCount += 1;
  }

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
    acc.windHitN += 1;
    if (Math.abs(windDiff) <= windHitToleranceKmh(truth.wind)) acc.windHit += 1;
    acc.windPredSum += pred.wind;
    acc.windPredSumSq += pred.wind * pred.wind;
    acc.windObsSum += truth.wind;
    acc.windObsSumSq += truth.wind * truth.wind;
    if (thresholds) {
      const obsEvt = truth.wind >= thresholds.windEventKmh;
      const predEvt = pred.wind >= thresholds.windEventKmh;
      if (obsEvt && predEvt) acc.windEvtTp += 1;
      else if (!obsEvt && predEvt) acc.windEvtFp += 1;
      else if (obsEvt && !predEvt) acc.windEvtFn += 1;
      else acc.windEvtTn += 1;
    }
  }
}

/** Fold `from` into `into` — pooling leads for the window-level breakdown. */
export function addAcc(into, from) {
  for (const key of Object.keys(into)) into[key] += from[key];
  return into;
}

function accumulateRows(rows, { rainEligible = false, thresholds = null } = {}) {
  const acc = newAcc();
  for (const row of rows) accumulate(acc, row, rainEligible, thresholds);
  return acc;
}

/**
 * Turn one lead day's accumulator into scores. `score` is the v2 headline
 * number; `errorScore` keeps the v1 (RMSE-derived) number beside it, so the
 * expanded row can say what the ranking used to be and the long-term trend
 * page can keep charting one consistent yardstick over five years.
 */
function finalizeLead(acc, { rainEligible = false, rainSampleOk = true } = {}) {
  const tempAccuracy = scoreHitRate(acc.tempHit, acc.tempHitN);
  const tempExtremes = scoreSedi(acc.tempEvtTp, acc.tempEvtFp, acc.tempEvtFn, acc.tempEvtTn);
  const windAccuracy = scoreHitRate(acc.windHit, acc.windHitN);
  const windExtremes = scoreSedi(acc.windEvtTp, acc.windEvtFp, acc.windEvtFn, acc.windEvtTn);
  const rainF1 = rainEligible ? f1Score(acc.rainTp, acc.rainFp, acc.rainFn, acc.rainUsed) : null;

  return {
    temperature: {
      score: combineAccuracyExtremes(
        tempAccuracy,
        tempExtremes,
        acc.tempEvtTp + acc.tempEvtFn,
        acc.tempEvtFp + acc.tempEvtTn,
      ),
      errorScore: rmseScore(acc.tempSumSq, acc.tempCount, TEMP_RMSE_CAP_C),
      accuracy: tempAccuracy,
      extremes: tempExtremes,
      rmse: acc.tempCount > 0 ? Math.sqrt(acc.tempSumSq / acc.tempCount) : null,
      mae: acc.tempCount > 0 ? acc.tempAbsSum / acc.tempCount : null,
      bias: acc.tempCount > 0 ? acc.tempBiasSum / acc.tempCount : null,
      count: acc.tempCount,
    },
    wind: {
      score: combineAccuracyExtremes(
        windAccuracy,
        windExtremes,
        acc.windEvtTp + acc.windEvtFn,
        acc.windEvtFp + acc.windEvtTn,
      ),
      errorScore: windRmseScore(acc.windSumSq, acc.windCount, acc.windActualSum),
      accuracy: windAccuracy,
      extremes: windExtremes,
      rmse: acc.windCount > 0 ? Math.sqrt(acc.windSumSq / acc.windCount) : null,
      mae: acc.windCount > 0 ? acc.windAbsSum / acc.windCount : null,
      bias: acc.windCount > 0 ? acc.windBiasSum / acc.windCount : null,
      count: acc.windCount,
    },
    rain: {
      // The v2 slot is the same F1 behind the model's own minimum-sample gate;
      // the v1 slot stays ungated so the two are comparable across the flip.
      score: rainSampleOk ? rainF1 : null,
      errorScore: rainF1,
      hitRate: acc.rainUsed > 0 ? ((acc.rainTp + acc.rainTn) / acc.rainUsed) * 100 : null,
      amountMae: acc.rainAmountCount > 0 ? acc.rainAmountAbsSum / acc.rainAmountCount : null,
      tp: acc.rainTp, fp: acc.rainFp, fn: acc.rainFn, tn: acc.rainTn,
      count: acc.rainUsed,
    },
  };
}

/**
 * Score one set of hourly pairs — the per-lead unit of scoring, exported so
 * derived views (per-day form dots, week-ago snapshots) reuse the exact same
 * math instead of reimplementing it.
 *
 * `thresholds` and `rainSampleOk` are window-level facts the caller resolves
 * once per model (a single day never holds enough hours to decide either), so
 * a form dot is judged by the same definitions as the headline it sits beside.
 *
 * @param {import('./align.js').HourPair[]} rows
 * @param {{rainEligible?:boolean, thresholds?:Object|null, rainSampleOk?:boolean}} opts
 */
export function scoreHourRows(rows, opts = {}) {
  return finalizeLead(accumulateRows(rows, opts), opts);
}

/**
 * The window-level breakdown behind one model's headline: what the expanded
 * row shows. Mirrors the app's `componentsFromAcc`, including its rule that
 * the percentages state the event table rather than rederiving the index.
 *
 * The false-alarm number is the *ratio* `falseAlarms / (eventHits +
 * falseAlarms)`, not SEDI's false-alarm rate `fp / (fp + tn)`: the rate divides
 * by every quiet hour in the window, and on temperature by twice as many again
 * (the warm and cold tables each bank a true negative for an ordinary hour), so
 * it reads ~2% for everyone everywhere and discriminates nothing.
 */
export function componentsFromAcc(acc) {
  const metric = (hit, hitN, tp, fp, fn, tn, sharpness, sumSq, count) => {
    if (hitN === 0 && count === 0) return null;
    const eventHours = tp + fn;
    return {
      accuracy: scoreHitRate(hit, hitN),
      hitCount: hit,
      count: hitN,
      extremes: extremesGatePasses(eventHours, fp + tn) ? scoreSedi(tp, fp, fn, tn) : null,
      eventHours,
      eventHits: tp,
      falseAlarms: fp,
      sharpness,
      typicalError: count > 0 ? Math.sqrt(sumSq / count) : null,
    };
  };
  return {
    temperature: metric(
      acc.tempHit, acc.tempHitN,
      acc.tempEvtTp, acc.tempEvtFp, acc.tempEvtFn, acc.tempEvtTn,
      sharpnessFromSums(
        acc.tempAnomPredSum, acc.tempAnomPredSumSq,
        acc.tempAnomObsSum, acc.tempAnomObsSumSq, acc.tempAnomCount,
      ),
      acc.tempSumSq, acc.tempCount,
    ),
    wind: metric(
      acc.windHit, acc.windHitN,
      acc.windEvtTp, acc.windEvtFp, acc.windEvtFn, acc.windEvtTn,
      sharpnessFromSums(
        acc.windPredSum, acc.windPredSumSq,
        acc.windObsSum, acc.windObsSumSq, acc.windCount,
      ),
      acc.windSumSq, acc.windCount,
    ),
    // Rain was already an event score, so its breakdown is the table itself.
    // This board scores rain hour-for-hour (no timing tolerance), so the
    // precision-side and recall-side hit counts are the same number; the app
    // and the server keep them apart because a ±1 h tolerance splits them.
    rain: acc.rainUsed === 0
      ? null
      : {
        eventHours: acc.rainTp + acc.rainFn,
        eventHits: acc.rainTp,
        falseAlarms: acc.rainFp,
        calledHits: acc.rainTp,
      },
  };
}

// ── Lead-weighted aggregation (headline skill) ───────────────────────────────

const leadWeight = (day) => 1 / day;
const TOTAL_LEAD_WEIGHT = LEAD_DAYS.reduce((sum, day) => sum + leadWeight(day), 0);
const HORIZON_FACTOR_FLOOR = 0.75;

const METRICS = ['temperature', 'rain', 'wind'];

/**
 * Equal-weight mean of the metric scores available at one lead day.
 * `field` selects the score model: 'score' is v2 (the headline), 'errorScore'
 * the v1 error-based number the trend page keeps charting.
 */
export function combinedLeadScore(lead, field = 'score') {
  let sum = 0;
  let n = 0;
  for (const metric of METRICS) {
    const s = lead[metric][field];
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

// ── Model + city scoring entry points ────────────────────────────────────────

/**
 * Score one model over the leads it serves.
 *
 * Two passes: accumulate every served lead, pool them to settle the
 * window-level facts (the rain sample gate, the breakdown), then finalize each
 * lead. The gate has to be a whole-window verdict — deciding it lead by lead
 * would let rain drift in and out of the combined score for the same model.
 *
 * @param {Record<number, import('./align.js').HourPair[]>} rowsByLead
 * @param {{rainEligible?:boolean, thresholds?:Object|null}} opts
 */
export function scoreModel(rowsByLead, opts = {}) {
  const { rainEligible = false, thresholds = null } = opts;
  const accByLead = new Map();
  const pooled = newAcc();
  for (const day of LEAD_DAYS) {
    const rows = rowsByLead?.[day];
    if (!rows || rows.length === 0) continue;
    const acc = accumulateRows(rows, { rainEligible, thresholds });
    accByLead.set(day, acc);
    addAcc(pooled, acc);
  }

  const rainSampleOk = rainSampleGatePasses(pooled.rainTp + pooled.rainFn);
  const perLead = {};
  for (const [day, acc] of accByLead) {
    perLead[day] = finalizeLead(acc, { rainEligible, rainSampleOk });
  }

  const entries = Object.entries(perLead);
  const skill = leadWeightedMean(
    entries.map(([day, lead]) => [Number(day), combinedLeadScore(lead)]),
  );
  const metricSkill = {};
  for (const metric of METRICS) {
    metricSkill[metric] = leadWeightedMean(
      entries.map(([day, lead]) => [Number(day), lead[metric].score]),
    );
  }

  return { perLead, skill, metricSkill, components: componentsFromAcc(pooled), rainSampleOk };
}

/**
 * Score every model for one aligned city.
 *
 * @param {import('./align.js').AlignedCity} aligned
 * @returns {{
 *   roster: import('./config.js').ModelConfig[],
 *   rainEligibility: {rainEventHours:number, rainEventTotalMm:number, rainScoreEligible:boolean},
 *   eventThresholds: Object|null,
 *   models: Record<string, {
 *     perLead: Record<number, ReturnType<typeof finalizeLead>>,
 *     skill: number|null,
 *     metricSkill: {temperature:number|null, rain:number|null, wind:number|null},
 *     components: ReturnType<typeof componentsFromAcc>,
 *     rainSampleOk: boolean,
 *     rainRecord: {wins:number, losses:number, days:Array},
 *   }>,
 * }}
 */
export function scoreCity(aligned) {
  const rainEligibility = computeRainEligibility(aligned.truthHours);
  const { rainScoreEligible } = rainEligibility;
  const thresholds = deriveEventThresholds(aligned.truthHours);

  const models = {};
  for (const model of aligned.roster) {
    models[model.id] = {
      ...scoreModel(aligned.pairs[model.id], { rainEligible: rainScoreEligible, thresholds }),
      rainRecord: computeRainRecord(aligned.dailyTruth, aligned.dailyPred[model.id]?.[1]),
    };
  }

  return { roster: aligned.roster, rainEligibility, eventThresholds: thresholds, models };
}
