/**
 * View-model derivations for the page (plan.md §8). Everything here is derived
 * from the aligned data + scores; the scoring math itself stays in score.js
 * (the verbatim app port) and is reused via its exported helpers, so no number
 * on the page comes from a second implementation.
 */

import { LEAD_DAYS } from './config.js';
import {
  SCORE_CONFIG,
  scoreHourRows,
  combinedLeadScore,
  leadWeightedMean,
} from './score.js';
import { asTempDelta, tempUnit } from './units.js';

const RAIN_MM = SCORE_CONFIG.rainThresholdMm;

/** Confidence tone for a 0–100 score — same thresholds as the app's scoreTone. */
export function scoreTone(score) {
  if (score == null) return 'none';
  if (score >= 80) return 'good';
  if (score >= 55) return 'ok';
  return 'bad';
}

const median = (values) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// ── Standings (rank, movement vs last week, form dots) ──────────────────────

const FORM_DAYS = 7;
const FORM_SKILL_THRESHOLD = 70;

/**
 * Headline skill per model over only the pairs up to `cutoffDate` — i.e. the
 * standings as they stood a week ago, computed from the same window minus its
 * last 7 days. Used for the ▲▼— movement column.
 */
function skillAsOf(aligned, rainEligible, cutoffDate) {
  const byModel = {};
  for (const model of aligned.roster) {
    const scoreByLead = [];
    for (const day of LEAD_DAYS) {
      const rows = aligned.pairs[model.id]?.[day];
      if (!rows) continue;
      const upTo = rows.filter((r) => r.dateKey <= cutoffDate);
      if (upTo.length === 0) continue;
      scoreByLead.push([day, combinedLeadScore(scoreHourRows(upTo, rainEligible))]);
    }
    byModel[model.id] = leadWeightedMean(scoreByLead);
  }
  return byModel;
}

const rankOf = (entries) =>
  Object.fromEntries(
    entries
      .filter(([, skill]) => skill != null)
      .sort((a, b) => b[1] - a[1])
      .map(([id], i) => [id, i + 1]),
  );

/**
 * The standings table's row data, ranked by headline skill.
 * @returns {Array<{model:Object, skill:number, metricSkill:Object,
 *   rainRecord:Object, movement:number|null, formDots:Array<'hit'|'miss'|'na'>}>}
 */
export function buildStandings(aligned, scores) {
  const rainEligible = scores.rainEligibility.rainScoreEligible;
  const dates = aligned.scoredDates;

  // Ranks a week ago (needs at least a few days of history left after the cut).
  let prevRank = null;
  if (dates.length >= FORM_DAYS + 3) {
    const cutoffDate = dates[dates.length - 1 - FORM_DAYS];
    prevRank = rankOf(Object.entries(skillAsOf(aligned, rainEligible, cutoffDate)));
  }

  const formDates = dates.slice(-FORM_DAYS);
  const ranked = aligned.roster
    .map((model) => ({ model, s: scores.models[model.id] }))
    .filter(({ s }) => s && s.skill != null)
    .sort((a, b) => b.s.skill - a.s.skill);

  return ranked.map(({ model, s }, i) => {
    const rank = i + 1;
    const movement =
      prevRank && prevRank[model.id] != null ? prevRank[model.id] - rank : null;

    // Form dots: per-day next-day (D-1) combined skill over the last 7 days.
    const d1Rows = aligned.pairs[model.id]?.[1] ?? [];
    const formDots = formDates.map((dateKey) => {
      const rows = d1Rows.filter((r) => r.dateKey === dateKey);
      if (rows.length === 0) return 'na';
      const daySkill = combinedLeadScore(scoreHourRows(rows, rainEligible));
      if (daySkill == null) return 'na';
      return daySkill >= FORM_SKILL_THRESHOLD ? 'hit' : 'miss';
    });

    return {
      model,
      rank,
      skill: s.skill,
      metricSkill: s.metricSkill,
      rainRecord: s.rainRecord,
      perLead: s.perLead,
      movement,
      formDots,
    };
  });
}

// ── Yesterday's receipt (all models' D-1 calls, Rain/Temp/Wind views) ────────

/** Contiguous runs of wet hours (> the rain threshold), inclusive indices. */
function wetSegments(hourlyMm) {
  const segs = [];
  let start = -1;
  for (let i = 0; i < hourlyMm.length; i++) {
    const wet = hourlyMm[i] != null && hourlyMm[i] > RAIN_MM;
    if (wet && start === -1) start = i;
    if (!wet && start !== -1) {
      segs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start !== -1) segs.push({ start, end: hourlyMm.length - 1 });
  return segs;
}

/**
 * Rain view: when each model said it would rain vs when it actually rained.
 * Wet hours become lane segments, so multiple showers a day stay distinct.
 * Models come back winner-first — the winner is the model whose hourly
 * rain/no-rain calls agree with the observed hours most often (timing, not
 * amount), with day-total closeness as the tie-break.
 */
function buildRainView(obsHours, modelRows) {
  const observed = obsHours.map((r) => r.precipitation);
  if (observed.every((v) => v == null)) return null;
  const observedTotal = observed.reduce((a, v) => a + (v ?? 0), 0);
  const rained = observedTotal > RAIN_MM;
  const obsSegments = wetSegments(observed);
  const isWet = (v) => v != null && v > RAIN_MM;

  const models = [];
  for (const { model, pred } of modelRows) {
    const hourly = pred.map((p) => p?.precipitation ?? null);
    if (hourly.every((v) => v == null)) continue;
    const total = hourly.reduce((a, v) => a + (v ?? 0), 0);
    const predictedRain = total > RAIN_MM;
    let agree = 0;
    let n = 0;
    for (let i = 0; i < observed.length; i++) {
      if (observed[i] == null) continue;
      n += 1;
      if (isWet(hourly[i]) === isWet(observed[i])) agree += 1;
    }
    models.push({
      model,
      segments: wetSegments(hourly),
      total,
      predictedRain,
      correct: predictedRain === rained,
      timing: n > 0 ? agree / n : 0,
      delta: total - observedTotal,
    });
  }
  if (models.length === 0) return null;
  models.sort(
    (a, b) => b.timing - a.timing || Math.abs(a.delta) - Math.abs(b.delta),
  );

  return {
    observed,
    observedTotal,
    rained,
    obsSegments,
    onset: obsSegments.length > 0 ? obsHours[obsSegments[0].start].time.slice(11, 16) : null,
    models,
  };
}

/**
 * Temperature/wind view: each model's D-1 hourly series vs observed.
 * Models come back winner-first (lowest hourly MAE).
 */
function buildLineView(obsHours, modelRows, key) {
  const observed = obsHours.map((r) => r[key]);
  const obsValues = observed.filter((v) => v != null);
  if (obsValues.length < 6) return null;

  const models = [];
  for (const { model, pred } of modelRows) {
    const series = pred.map((p) => p?.[key] ?? null);
    let err = 0;
    let bias = 0;
    let n = 0;
    for (let i = 0; i < observed.length; i++) {
      if (observed[i] == null || series[i] == null) continue;
      err += Math.abs(series[i] - observed[i]);
      bias += series[i] - observed[i];
      n += 1;
    }
    if (n < 6) continue;
    models.push({ model, series, mae: err / n, bias: bias / n });
  }
  if (models.length === 0) return null;
  models.sort((a, b) => a.mae - b.mae);

  return { observed, obsMax: Math.max(...obsValues), models };
}

/**
 * The receipt for the most recent scored day: every model's D-1 call vs
 * observed, one view per metric. Defaults to the rain view when it rained,
 * temperature when the day stayed dry.
 */
export function buildReceipt(aligned) {
  const dates = aligned.scoredDates;
  if (dates.length === 0) return null;
  const dateKey = dates[dates.length - 1];

  const obsHours = aligned.truthHours.filter((r) => r.dateKey === dateKey);
  if (obsHours.length === 0) return null;

  // Model rows share the truth-hour axis (temperature anchors the join), so
  // index predictions by timestamp onto the observed axis.
  const modelRows = [];
  for (const model of aligned.roster) {
    const rows = (aligned.pairs[model.id]?.[1] ?? []).filter((r) => r.dateKey === dateKey);
    if (rows.length === 0) continue;
    const byTime = new Map(rows.map((r) => [r.time, r.pred]));
    modelRows.push({ model, pred: obsHours.map((r) => byTime.get(r.time) ?? null) });
  }

  const views = {
    rain: buildRainView(obsHours, modelRows),
    temperature: buildLineView(obsHours, modelRows, 'temperature'),
    wind: buildLineView(obsHours, modelRows, 'wind'),
  };
  if (!views.rain && !views.temperature && !views.wind) return null;

  const rained = views.rain?.rained ?? false;
  const defaultMetric = rained && views.rain
    ? 'rain'
    : ['temperature', 'rain', 'wind'].find((k) => views[k]);

  return {
    dateKey,
    hours: obsHours.map((r) => r.time.slice(11, 16)),
    rained,
    defaultMetric,
    views,
  };
}

// ── Skill by lead time (the decay chart) ─────────────────────────────────────

/**
 * Per-metric line series for the lead-time chart. 'all' is the combined
 * per-lead score — the skill column is the soft horizon-adjusted 1/d score
 * from this curve.
 */
export function buildLeadSeries(scores) {
  const metrics = ['all', 'temperature', 'rain', 'wind'];
  const out = {};
  for (const metric of metrics) {
    out[metric] = scores.roster
      .map((model) => {
        const s = scores.models[model.id];
        if (!s) return null;
        const points = [];
        for (const day of LEAD_DAYS) {
          const lead = s.perLead[day];
          if (!lead) continue;
          const score = metric === 'all' ? combinedLeadScore(lead) : lead[metric].score;
          if (score != null) points.push({ day, score });
        }
        return points.length > 0 ? { model, points } : null;
      })
      .filter(Boolean);
  }
  return out;
}

// ── Lab panel (row expand: ghost chart, skill vs field median, habits) ───────

export const LAB_LEADS = [1, 3, 5, 7];
const GHOST_DAYS = 14;

/** Hourly observed-vs-forecast temperature series for the ghost chart. */
export function buildGhost(aligned, modelId, lead) {
  const rows = aligned.pairs[modelId]?.[lead];
  if (!rows || rows.length === 0) return null;
  const fromDate = aligned.scoredDates[Math.max(0, aligned.scoredDates.length - GHOST_DAYS)];
  const windowRows = rows.filter((r) => r.dateKey >= fromDate);
  if (windowRows.length === 0) return null;
  return {
    times: windowRows.map((r) => r.time),
    truth: windowRows.map((r) => r.truth.temperature),
    pred: windowRows.map((r) => r.pred.temperature),
  };
}

/** Model's combined per-lead score vs the field median at each lead. */
export function buildMedianComparison(scores, modelId) {
  const points = [];
  for (const day of LEAD_DAYS) {
    const field = [];
    for (const m of scores.roster) {
      const lead = scores.models[m.id]?.perLead[day];
      if (!lead) continue;
      const c = combinedLeadScore(lead);
      if (c != null) field.push({ id: m.id, score: c });
    }
    const own = field.find((f) => f.id === modelId);
    if (!own) continue;
    points.push({ day, score: own.score, median: median(field.map((f) => f.score)) });
  }
  return points;
}

/**
 * 2–3 rule-based habit insights from the window's diagnostics ("under-calls
 * gusts −12%"). Thresholds are deliberately conservative — no habit beats a
 * made-up one.
 */
export function buildHabits(aligned, scores, modelId) {
  const s = scores.models[modelId];
  if (!s) return [];
  const habits = [];
  const w = (day) => 1 / day;

  // Lead-weighted mean of a per-lead diagnostic.
  const weighted = (pick) => {
    let sum = 0;
    let wsum = 0;
    for (const [day, lead] of Object.entries(s.perLead)) {
      const v = pick(lead);
      if (v == null) continue;
      sum += w(Number(day)) * v;
      wsum += w(Number(day));
    }
    return wsum > 0 ? sum / wsum : null;
  };

  const tempBias = weighted((l) => l.temperature.bias);
  // The 0.4 threshold stays in metric so the habit fires on the same days
  // regardless of the display unit; only the shown number converts.
  if (tempBias != null && Math.abs(tempBias) >= 0.4) {
    const shown = asTempDelta(tempBias);
    habits.push(
      `runs ${tempBias > 0 ? 'warm' : 'cold'} — ${shown > 0 ? '+' : ''}${shown.toFixed(1)} ${tempUnit()} vs observed`,
    );
  }

  const windBias = weighted((l) => l.wind.bias);
  const obsWinds = aligned.truthHours.map((r) => r.wind).filter((v) => v != null);
  const meanWind = obsWinds.length ? obsWinds.reduce((a, b) => a + b, 0) / obsWinds.length : null;
  if (windBias != null && meanWind > 0) {
    const pct = (windBias / meanWind) * 100;
    if (Math.abs(pct) >= 8) {
      habits.push(
        `${pct < 0 ? 'under-calls' : 'over-calls'} wind ${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%`,
      );
    }
  }

  // Rain temperament is judged against the field, not in absolute counts: at
  // a 0.1 mm/h threshold every model smears drizzle across hours, so false
  // alarms outnumber misses for the whole roster and an absolute rule tags
  // everyone "overpredicts rain". Only models leaning notably wetter or drier
  // than the field median earn the habit.
  const rainMistakes = (model) => {
    let fp = 0;
    let fn = 0;
    for (const lead of Object.values(model.perLead)) {
      fp += lead.rain.fp;
      fn += lead.rain.fn;
    }
    return { fp, fn, total: fp + fn };
  };
  const own = rainMistakes(s);
  if (own.total >= 10) {
    const fieldShares = scores.roster
      .map((m) => (m.id === modelId ? null : scores.models[m.id]))
      .filter((m) => m != null)
      .map(rainMistakes)
      .filter((t) => t.total >= 10)
      .map((t) => t.fp / t.total);
    const ownShare = own.fp / own.total;
    const fieldShare = fieldShares.length >= 3 ? median(fieldShares) : null;
    const pct = (v) => `${Math.round(v * 100)}%`;
    if (fieldShare != null) {
      if (ownShare >= fieldShare + 0.15 && own.fp >= own.fn * 1.5) {
        habits.push(`overpredicts rain even for this field — false alarms are ${pct(ownShare)} of its wrong rain calls vs ${pct(fieldShare)} for the field`);
      } else if (ownShare <= fieldShare - 0.15) {
        habits.push(own.fn >= own.fp * 1.5
          ? `sleeps through rain — misses are ${pct(1 - ownShare)} of its wrong rain calls vs ${pct(1 - fieldShare)} for the field`
          : `slower to call rain than the field — false alarms are ${pct(ownShare)} of its wrong rain calls vs ${pct(fieldShare)} for the field`);
      }
    }
  }

  // Skill decay shape: D-1 vs the model's last served lead.
  const days = Object.keys(s.perLead).map(Number).sort((a, b) => a - b);
  if (days.length >= 2) {
    const first = combinedLeadScore(s.perLead[days[0]]);
    const last = combinedLeadScore(s.perLead[days[days.length - 1]]);
    if (first != null && last != null) {
      const drop = first - last;
      if (drop <= 6) habits.push(`holds skill at range — D-${days[days.length - 1]} within ${Math.max(0, drop).toFixed(0)} pts of D-${days[0]}`);
      else if (drop >= 25) habits.push(`fades fast — loses ${drop.toFixed(0)} pts by D-${days[days.length - 1]}`);
    }
  }

  return habits.slice(0, 3);
}

// ── Other-calls strip (yesterday's high temp, gust, current streak) ──────────

export function buildOtherCalls(aligned, scores) {
  const dates = aligned.scoredDates;
  if (dates.length === 0) return null;
  const dateKey = dates[dates.length - 1];
  const truth = aligned.dailyTruth[dateKey];
  if (!truth) return null;

  const closestCall = (pick, truthValue) => {
    if (truthValue == null) return null;
    const entries = [];
    for (const model of aligned.roster) {
      const day = aligned.dailyPred[model.id]?.[1]?.[dateKey];
      if (!day) continue;
      const v = pick(day);
      if (v == null) continue;
      entries.push({ model, value: v, delta: v - truthValue });
    }
    if (entries.length < 2) return null;
    entries.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    return { truthValue, best: entries[0], worst: entries[entries.length - 1] };
  };

  const highTemp = closestCall((d) => d.tMax, truth.tMax);
  const gust = closestCall((d) => d.windMax, truth.windMax);

  // Longest current run of correct D-1 rain calls across models.
  let streak = null;
  for (const model of aligned.roster) {
    const days = scores.models[model.id]?.rainRecord.days ?? [];
    let run = 0;
    for (let i = days.length - 1; i >= 0 && days[i].correct; i--) run += 1;
    if (run >= 3 && (!streak || run > streak.run)) streak = { model, run };
  }

  return { dateKey, highTemp, gust, streak };
}
