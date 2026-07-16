/**
 * Long-term model-quality backfill (history.html data).
 *
 * Measures how each model's forecast error has moved over its full previous-runs
 * archive — one calendar MONTH at a time, bucketed by VALID time — so the trends
 * page can answer "have the models degraded?". v1: NOAA models at New York.
 *
 * The scoring is never re-implemented: it imports the same align.js + score.js
 * the live board uses, so a monthly bucket is scored exactly like the rolling
 * 30-day window, just over a fixed month instead of the last 30 days.
 *
 * Design (see js/history-config.js and the plan):
 *   - One request per model per month (all vars × leads ≤ maxLeadDays). Small
 *     enough never to time out on the free tier.
 *   - Truth from the historical-forecast API (best_match) — same truth series
 *     methodology as the live board.
 *   - Only COMPLETE months (never the current month), so every cached chunk is
 *     immutable → reruns are fully offline and incremental.
 *   - Raw API responses cached under data/history-cache/ (gitignored); the
 *     compact scored output committed to data/history/<city>.json.
 *
 * Usage:
 *   node scripts/history-backfill.mjs                     # full backfill, all NOAA @ NYC
 *   node scripts/history-backfill.mjs --city=newyork
 *   node scripts/history-backfill.mjs --months=2024-05:2024-06   # smoke a short range
 *   node scripts/history-backfill.mjs --dry-run           # print planned fetches, write nothing
 *   node scripts/history-backfill.mjs --offline           # cache only, never hit the network
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LEAD_DAYS, VARIABLES } from '../js/config.js';
import { fetchJson, normalizePredictions } from '../js/fetch.js';
import { alignCity } from '../js/align.js';
import {
  scoreHourRows,
  computeRainEligibility,
  combinedLeadScore,
  leadWeightedMean,
} from '../js/score.js';
import {
  HISTORY_CITIES,
  historyModelsFor,
  HISTORY_START_HINTS,
  monthRange,
  lastCompleteMonthYm,
  monthStartDate,
  monthEndDateExclusive,
} from '../js/history-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_DIR = join(ROOT, 'data', 'history');
const CACHE_DIR = join(ROOT, 'data', 'history-cache');

const TRUTH_BASE = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const PREVIOUS_RUNS_BASE = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const TRUTH_MODEL = 'best_match';

const FETCH_SPACING_MS = 400; // polite gap between live requests (free tier 429s bursts)
const MIN_LEAD_HOURS = 200; // a lead needs ~8+ days of pairs before its monthly score is trusted

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { city: null, months: null, dryRun: false, offline: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--offline') args.offline = true;
    else if (a.startsWith('--city=')) args.city = a.slice(7);
    else if (a.startsWith('--months=')) {
      const [from, to] = a.slice(9).split(':');
      args.months = { from, to: to || from };
    }
  }
  return args;
}
const ARGS = parseArgs(process.argv.slice(2));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let liveFetches = 0; // count of actual network calls (cache misses)

// ── Cache helpers (raw API bodies; immutable once written) ────────────────────
async function readCache(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null; // corrupt/partial cache — refetch
  }
}

async function writeCache(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj));
}

/**
 * Fetch a URL through the shared retry/backoff, honoring --offline and the
 * polite spacing. Returns the parsed body, or null in offline mode.
 */
async function fetchLive(url) {
  if (ARGS.offline) return null;
  if (liveFetches > 0) await sleep(FETCH_SPACING_MS);
  liveFetches += 1;
  return fetchJson(url);
}

const truthCachePath = (cityId, ym) => join(CACHE_DIR, cityId, 'truth', `${ym}.json`);
const predCachePath = (cityId, modelId, ym) => join(CACHE_DIR, cityId, modelId, `${ym}.json`);

// ── Truth (observed) chunk → the shape align.js expects ───────────────────────
function truthShapeFromBody(body) {
  const series = {};
  for (const [variable, apiName] of Object.entries(VARIABLES)) {
    series[variable] = body.hourly[apiName] ?? [];
  }
  return { times: body.hourly.time, timezone: body.timezone, series };
}

async function getTruthChunk(city, ym) {
  const path = truthCachePath(city.id, ym);
  let body = await readCache(path);
  if (!body) {
    const hourly = Object.values(VARIABLES).join(',');
    const url =
      `${TRUTH_BASE}?latitude=${city.lat}&longitude=${city.lon}` +
      `&hourly=${hourly}&models=${TRUTH_MODEL}` +
      `&start_date=${monthStartDate(ym)}&end_date=${monthEndDateExclusive(ym)}&timezone=auto`;
    body = await fetchLive(url);
    if (!body) return null; // offline miss
    await writeCache(path, body);
  }
  return truthShapeFromBody(body);
}

// ── Prediction chunk (one model) → { times, pred } for align.js ───────────────
function predVarsFor(model) {
  const vars = [];
  for (const apiName of Object.values(VARIABLES)) {
    for (const day of LEAD_DAYS) {
      if (day > model.maxLeadDays) continue;
      vars.push(`${apiName}_previous_day${day}`);
    }
  }
  return vars;
}

/** True when every non-time hourly array in the body is entirely null (before archive start). */
function isAllNull(body) {
  for (const [key, values] of Object.entries(body.hourly || {})) {
    if (key === 'time') continue;
    if (Array.isArray(values) && values.some((v) => v != null)) return false;
  }
  return true;
}

async function getPredChunk(city, model, ym) {
  const path = predCachePath(city.id, model.id, ym);
  let body = await readCache(path);
  if (!body) {
    const url =
      `${PREVIOUS_RUNS_BASE}?latitude=${city.lat}&longitude=${city.lon}` +
      `&hourly=${predVarsFor(model).join(',')}&models=${model.id}` +
      `&start_date=${monthStartDate(ym)}&end_date=${monthEndDateExclusive(ym)}&timezone=auto`;
    body = await fetchLive(url);
    if (!body) return null; // offline miss
    await writeCache(path, body);
  }
  return {
    times: body.hourly.time,
    pred: normalizePredictions(body.hourly, [model.id]),
    empty: isAllNull(body),
  };
}

// ── Score one model over one month (reusing the live align + score) ───────────
/**
 * @returns null if the month has no usable data for the model, else
 * { skill, metricSkill:{temperature,rain,wind}, leads: { <day>: {t,w,r} } }
 * where t/w = {score,rmse,bias,n}, r = {f1,n}.
 */
function scoreModelMonth(model, truth, predChunk, rainEligible) {
  if (!predChunk || predChunk.empty) return null;
  const aligned = alignCity(truth, { times: predChunk.times, pred: predChunk.pred }, [model]);
  const perLead = {};
  const leads = {};
  for (const day of LEAD_DAYS) {
    if (day > model.maxLeadDays) continue;
    const rows = aligned.pairs[model.id]?.[day];
    if (!rows || rows.length < MIN_LEAD_HOURS) continue;
    const s = scoreHourRows(rows, rainEligible);
    perLead[day] = s;
    leads[day] = {
      t: { score: s.temperature.score, rmse: s.temperature.rmse, bias: s.temperature.bias, n: s.temperature.count },
      w: { score: s.wind.score, rmse: s.wind.rmse, bias: s.wind.bias, n: s.wind.count },
      r: { f1: s.rain.score, n: s.rain.count },
    };
  }
  const days = Object.keys(perLead).map(Number);
  if (days.length === 0) return null;

  const skill = leadWeightedMean(days.map((d) => [d, combinedLeadScore(perLead[d])]));
  const metricSkill = {
    temperature: leadWeightedMean(days.map((d) => [d, perLead[d].temperature.score])),
    rain: leadWeightedMean(days.map((d) => [d, perLead[d].rain.score])),
    wind: leadWeightedMean(days.map((d) => [d, perLead[d].wind.score])),
  };
  return { skill, metricSkill, leads };
}

// ── Output assembly (columnar, aligned to a shared months axis) ───────────────
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function buildSeries(model, months, scoredByMonth) {
  const leadDays = LEAD_DAYS.filter((d) => d <= model.maxLeadDays);
  const leads = {};
  for (const day of leadDays) {
    leads[day] = {
      t: { score: [], rmse: [], bias: [], n: [] },
      w: { score: [], rmse: [], bias: [], n: [] },
      r: { f1: [], n: [] },
    };
  }
  const series = {
    skill: [],
    metricSkill: { temperature: [], rain: [], wind: [] },
    leads,
  };
  for (const ym of months) {
    const m = scoredByMonth.get(ym) || null;
    series.skill.push(r1(m?.skill ?? null));
    series.metricSkill.temperature.push(r1(m?.metricSkill.temperature ?? null));
    series.metricSkill.rain.push(r1(m?.metricSkill.rain ?? null));
    series.metricSkill.wind.push(r1(m?.metricSkill.wind ?? null));
    for (const day of leadDays) {
      const L = m?.leads[day];
      leads[day].t.score.push(r1(L?.t.score ?? null));
      leads[day].t.rmse.push(r1(L?.t.rmse ?? null));
      leads[day].t.bias.push(r2(L?.t.bias ?? null));
      leads[day].t.n.push(L?.t.n ?? null);
      leads[day].w.score.push(r1(L?.w.score ?? null));
      leads[day].w.rmse.push(r1(L?.w.rmse ?? null));
      leads[day].w.bias.push(r2(L?.w.bias ?? null));
      leads[day].w.n.push(L?.w.n ?? null);
      leads[day].r.f1.push(r1(L?.r.f1 ?? null));
      leads[day].r.n.push(L?.r.n ?? null);
    }
  }
  return series;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const cities = ARGS.city ? HISTORY_CITIES.filter((c) => c.id === ARGS.city) : HISTORY_CITIES;
if (cities.length === 0) {
  console.error(`No history city matches --city=${ARGS.city}. Known: ${HISTORY_CITIES.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

const lastComplete = lastCompleteMonthYm();
console.log(
  `History backfill → last complete month ${lastComplete}` +
  `${ARGS.dryRun ? ' [dry-run]' : ''}${ARGS.offline ? ' [offline]' : ''}`,
);

for (const city of cities) {
  const models = historyModelsFor(city);
  console.log(`\n${city.name}: ${models.map((m) => m.label).join(', ')}`);

  // Per-model month lists (hint → last complete, or the --months override).
  const monthsFor = (model) => {
    if (ARGS.months) return monthRange(ARGS.months.from, ARGS.months.to);
    const start = HISTORY_START_HINTS[model.id] ?? HISTORY_START_HINTS.default;
    return monthRange(start, lastComplete);
  };

  // Union of all months (drives the truth fetch + rain-eligibility axis).
  const allMonths = new Set();
  for (const model of models) for (const ym of monthsFor(model)) allMonths.add(ym);
  const unionMonths = [...allMonths].sort();

  if (ARGS.dryRun) {
    let planned = 0;
    for (const ym of unionMonths) if (!existsSync(truthCachePath(city.id, ym))) planned += 1;
    for (const model of models) {
      for (const ym of monthsFor(model)) if (!existsSync(predCachePath(city.id, model.id, ym))) planned += 1;
    }
    console.log(`  ${unionMonths.length} months, ${models.length} models → ${planned} fetches needed (cached ones skipped).`);
    continue;
  }

  // 1. Truth + rain eligibility per month (city-wide, reused across models).
  const rainEligByMonth = new Map();
  const truthByMonth = new Map();
  for (const ym of unionMonths) {
    const truth = await getTruthChunk(city, ym);
    if (!truth) continue; // offline miss
    const aligned = alignCity(truth, { times: [], pred: {} }, []);
    rainEligByMonth.set(ym, computeRainEligibility(aligned.truthHours).rainScoreEligible);
    truthByMonth.set(ym, truth);
  }

  // 2. Score each model over its months.
  const scoredByModel = new Map(); // modelId → Map(ym → scored)
  const firstMonthByModel = new Map();
  for (const model of models) {
    const scored = new Map();
    for (const ym of monthsFor(model)) {
      const truth = truthByMonth.get(ym);
      if (!truth) continue;
      const predChunk = await getPredChunk(city, model, ym);
      const result = scoreModelMonth(model, truth, predChunk, rainEligByMonth.get(ym) === true);
      if (result) {
        scored.set(ym, result);
        if (!firstMonthByModel.has(model.id)) firstMonthByModel.set(model.id, ym);
      }
    }
    scoredByModel.set(model.id, scored);
    const first = firstMonthByModel.get(model.id) ?? '—';
    console.log(`  ${model.label.padEnd(5)} ${scored.size} months scored (from ${first})`);
  }

  // Drop models with no scored month at all (e.g. NAM has no previous-runs
  // archive at NYC) — keeping them would only add all-null lines.
  const presentModels = models.filter((m) => (scoredByModel.get(m.id)?.size ?? 0) > 0);
  const dropped = models.filter((m) => !presentModels.includes(m));
  if (dropped.length) console.log(`  (dropped, no data: ${dropped.map((m) => m.label).join(', ')})`);

  // 3. Shared months axis: from the earliest present month to last complete.
  let axisStart = lastComplete;
  for (const ym of firstMonthByModel.values()) if (ym < axisStart) axisStart = ym;
  const months = ARGS.months ? unionMonths : monthRange(axisStart, lastComplete);

  // 4. Assemble output.
  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    city: { id: city.id, name: city.name, lat: city.lat, lon: city.lon, country: city.country ?? null,
      timezone: truthByMonth.get(months[months.length - 1])?.timezone ?? null },
    truthSource: TRUTH_MODEL,
    months,
    rainEligibleMonths: months.map((ym) => rainEligByMonth.get(ym) === true),
    models: presentModels.map((m) => ({ id: m.id, label: m.label, provider: m.provider, color: m.color, maxLeadDays: m.maxLeadDays })),
    series: {},
  };
  for (const model of presentModels) {
    out.series[model.id] = buildSeries(model, months, scoredByModel.get(model.id));
  }

  await mkdir(HISTORY_DIR, { recursive: true });
  const outPath = join(HISTORY_DIR, `${city.id}.json`);
  await writeFile(outPath, `${JSON.stringify(out)}\n`);

  // 5. Console summary: D-1 temperature RMSE, first year vs last year (the headline signal).
  console.log(`  → ${outPath.replace(ROOT + '/', '')} (${months.length} months, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
  console.log('  D-1 temp RMSE (°C)   first-yr   last-yr   Δ');
  for (const model of models) {
    const scored = scoredByModel.get(model.id);
    const present = months.filter((ym) => scored.has(ym));
    const d1 = (ym) => scored.get(ym)?.leads[1]?.t.rmse ?? null;
    const mean = (arr) => {
      const vals = arr.map(d1).filter((v) => v != null);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    const firstYr = mean(present.slice(0, 12));
    const lastYr = mean(present.slice(-12));
    const delta = firstYr != null && lastYr != null ? lastYr - firstYr : null;
    const f = (v) => (v == null ? '   —  ' : v.toFixed(2).padStart(6));
    const sign = delta == null ? '' : delta > 0 ? ' (worse)' : ' (better)';
    console.log(`  ${model.label.padEnd(18)} ${f(firstYr)}    ${f(lastYr)}   ${f(delta)}${sign}`);
  }
}

if (!ARGS.dryRun) {
  console.log(`\nDone. ${liveFetches} live fetch${liveFetches === 1 ? '' : 'es'}.`);
}
