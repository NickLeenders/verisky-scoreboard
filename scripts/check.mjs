/**
 * Offline checks for the parts of the board that have no browser to catch them:
 * the score-v2 math, the breakdown block's honesty guards, the lead-time grid's
 * ranking rules, and the server payload's dual-score hydration. No network, so
 * CI can run it before the bake.
 *
 * Usage:  node scripts/check.mjs
 */

import assert from 'node:assert/strict';

import { LEAD_DAYS } from '../js/config.js';
import {
  SCORE_CONFIG,
  scoreHourRows,
  scoreModel,
  scoreSedi,
  sediFromTable,
  combineAccuracyExtremes,
  deriveEventThresholds,
  componentsFromAcc,
  newAcc,
} from '../js/score.js';
import { breakdownHtml, hasBreakdown } from '../js/breakdown.js';
import {
  buildLeadTimeGrid,
  sortLeadTimeGrid,
  rankedModelIds,
  rampStep,
  RAMP_STEPS,
} from '../js/leadTimeGrid.js';
import { hydratePresetScoreboard } from '../js/server-scoreboard.js';
import { buildComparison, rainTiming, valueStrip } from '../js/compare.js';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ✓ ${label}\n`);
};

// ── SEDI edge cases ─────────────────────────────────────────────────────────

ok('SEDI is null without both an event and a non-event class', () => {
  assert.equal(sediFromTable(0, 0, 0, 0), null);
  assert.equal(sediFromTable(0, 5, 0, 5), null); // no observed events
  assert.equal(sediFromTable(5, 0, 5, 0), null); // no observed quiet hours
});

ok('SEDI sits at its zero point (50/100) for a model that never calls one', () => {
  // No hits and no false alarms: both rates clamp to the same floor.
  assert.equal(Math.round(scoreSedi(0, 0, 24, 264)), 50);
});

ok('SEDI rewards catching events without crying wolf', () => {
  // Same 24 catches; the second model called 200 extremes that never happened.
  const clean = scoreSedi(24, 0, 0, 264);
  const noisy = scoreSedi(24, 200, 0, 64);
  assert(clean > 99, `a perfect table should max out (got ${clean})`);
  assert(noisy < clean - 10, `false alarms should cost real points (${noisy} vs ${clean})`);
  assert(noisy > scoreSedi(0, 0, 24, 264), 'but over-calling still beats never calling');
});

// ── Component blending + gates ──────────────────────────────────────────────

ok('the extremes weight folds back into accuracy on a calm window', () => {
  // 7 event hours is under MIN_EVENT_HOURS, so the blend must not apply.
  assert.equal(combineAccuracyExtremes(80, 10, 7, 500), 80);
  assert.equal(combineAccuracyExtremes(80, 10, 8, 500), 0.7 * 80 + 0.3 * 10);
  assert.equal(combineAccuracyExtremes(null, 10, 80, 500), null);
});

ok('event thresholds need a real sample and respect their floors', () => {
  const hours = (n, temp, wind) => Array.from({ length: n }, (_, i) => ({
    time: `2026-07-${String(1 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`,
    temperature: temp(i),
    wind: wind(i),
  }));
  assert.equal(deriveEventThresholds(hours(48, () => 15, () => 10)), null, 'too thin');
  // A flat, calm month: both thresholds sit on their floors rather than at ~0.
  const flat = deriveEventThresholds(hours(240, () => 15, () => 5));
  assert.equal(flat.tempAnomalyC, SCORE_CONFIG.tempEventFloorC);
  assert.equal(flat.windEventKmh, SCORE_CONFIG.windEventFloorKmh);
  // The temperature baseline is diurnal, so a pure day/night cycle is not an anomaly.
  const diurnal = deriveEventThresholds(hours(240, (i) => 15 + 8 * Math.sin((i % 24) / 24 * 2 * Math.PI), () => 5));
  assert.equal(diurnal.tempAnomalyC, SCORE_CONFIG.tempEventFloorC);
});

// ── The anti-blur property, on synthetic pairs ──────────────────────────────

ok('a blurred forecast wins RMSE and loses the v2 score (the whole point)', () => {
  // The double penalty, staged: a 4-hour heat burst every fourth day.
  //   sharp — calls the burst, two hours late, so it is wrong twice per burst.
  //   blur  — never calls a burst at all, just lifts a 12-hour band by a third
  //           of it. One mild error instead of two big ones: optimal RMSE play.
  const BURST_HOURS = [13, 14, 15, 16];
  const SMEAR_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  const SHIFT_HOURS = 2;
  const AMPLITUDE_C = 10;
  const rows = [];
  for (let day = 0; day < 30; day++) {
    const burstDay = day % 4 === 1;
    const dateKey = `2026-07-${String(day + 1).padStart(2, '0')}`;
    for (let hour = 0; hour < 24; hour++) {
      const climate = 15 + 6 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      const point = (t) => ({ temperature: t, precipitation: 0, wind: 10 });
      rows.push({
        time: `${dateKey}T${String(hour).padStart(2, '0')}:00`,
        dateKey,
        truth: point(climate + (burstDay && BURST_HOURS.includes(hour) ? AMPLITUDE_C : 0)),
        sharp: point(climate + (burstDay && BURST_HOURS.includes(hour - SHIFT_HOURS) ? AMPLITUDE_C : 0)),
        blur: point(climate + (burstDay && SMEAR_HOURS.includes(hour)
          ? (AMPLITUDE_C * BURST_HOURS.length) / SMEAR_HOURS.length
          : 0)),
      });
    }
  }
  const thresholds = deriveEventThresholds(rows.map((r) => ({ ...r.truth, time: r.time })));
  assert(thresholds, 'the fixture window must be able to define events');
  const run = (key) => scoreModel(
    { 1: rows.map((r) => ({ time: r.time, dateKey: r.dateKey, truth: r.truth, pred: r[key] })) },
    { thresholds },
  );
  const sharp = run('sharp');
  const blur = run('blur');
  const lead = (m) => m.perLead[1].temperature;

  assert(lead(blur).rmse < lead(sharp).rmse,
    `blur should win RMSE (${lead(blur).rmse} vs ${lead(sharp).rmse})`);
  assert(lead(blur).errorScore > lead(sharp).errorScore, 'and with it the old error score');
  assert(lead(sharp).score > lead(blur).score,
    `sharp should win v2 (${lead(sharp).score} vs ${lead(blur).score})`);
  assert(lead(sharp).extremes > lead(blur).extremes, 'extremes is what turns it around');
  assert(lead(sharp).accuracy > lead(blur).accuracy, 'a smear outside the band costs accuracy too');
  assert(
    blur.components.temperature.sharpness < 0.8 && sharp.components.temperature.sharpness > 0.9,
    'and the sharpness diagnostic reads the blur for what it is',
  );
});

ok('the rain sample gate nulls the v2 slot for a model and leaves v1 alone', () => {
  // Four observed wet hours: under the 8-hour floor.
  const rows = Array.from({ length: 48 }, (_, i) => ({
    time: `2026-07-01T${String(i % 24).padStart(2, '0')}:00`,
    dateKey: i < 24 ? '2026-07-01' : '2026-07-02',
    truth: { temperature: 15, precipitation: i % 12 === 0 ? 1.2 : 0, wind: 10 },
    pred: { temperature: 15, precipitation: i % 6 === 0 ? 1.2 : 0, wind: 10 },
  }));
  const model = scoreModel({ 1: rows }, { rainEligible: true });
  assert.equal(model.rainSampleOk, false);
  assert.equal(model.perLead[1].rain.score, null, 'v2 rain reads unscored');
  assert(model.perLead[1].rain.errorScore > 0, 'v1 rain keeps its ungated value');
  assert.equal(model.metricSkill.rain, null);
});

ok('the pooled breakdown carries the event table the UI states', () => {
  const acc = newAcc();
  Object.assign(acc, {
    tempHit: 540, tempHitN: 720, tempCount: 720, tempSumSq: 720 * 4,
    tempEvtTp: 60, tempEvtFp: 30, tempEvtFn: 40, tempEvtTn: 600,
  });
  const c = componentsFromAcc(acc);
  assert.equal(c.temperature.accuracy, 75);
  assert.equal(c.temperature.eventHours, 100);
  assert.equal(c.temperature.eventHits, 60);
  assert.equal(c.temperature.falseAlarms, 30);
  assert.equal(c.temperature.typicalError, 2);
  assert.equal(c.temperature.sharpness, null, 'no anomaly sums banked → not measured');
  assert.equal(c.wind, null, 'a metric with no hours at all has no block');
});

// ── Breakdown block guards ─────────────────────────────────────────────────

const sampleRow = {
  rank: 1,
  errorRank: 4,
  metricSkill: { temperature: 82, wind: 70, rain: 30 },
  components: {
    temperature: {
      accuracy: 75, hitCount: 540, count: 720, extremes: 91.6, eventHours: 192,
      eventHits: 117, falseAlarms: 42, sharpness: 0.71, typicalError: 1.6,
    },
    wind: {
      accuracy: 70.8, hitCount: 510, count: 720, extremes: null, eventHours: 3,
      eventHits: 1, falseAlarms: 0, sharpness: null, typicalError: 4.2,
    },
    rain: { eventHours: 49, eventHits: 12, falseAlarms: 60, calledHits: 12 },
  },
};

ok('the breakdown states percentages, the old rank, and the folded-back gate', () => {
  const html = breakdownHtml(sampleRow);
  assert(html.includes('caught 61%'));
  assert(html.includes('26% false alarms'), 'the ratio fp/(tp+fp), not SEDI\'s rate');
  assert(html.includes('192 event hrs'));
  assert(html.includes('smoother than the weather'));
  assert(html.includes('typical error ±1.6&nbsp;°C'));
  assert(html.includes('too few extreme hours to judge (3 in the window)'));
  assert(html.includes('83% of its rain calls stayed dry'));
  assert(html.includes('was #4 under the old error score'));
  assert(breakdownHtml({ ...sampleRow, errorRank: 1 }).includes('also #1'));
  assert(!html.includes('undefined') && !html.includes('NaN'));
});

ok('extremes lead with recall and give false alarms a separate meter', () => {
  const html = breakdownHtml(sampleRow);
  assert(html.includes('bd-value">caught 61%</span>'));
  assert(html.includes('bd-fine">SEDI 92 · 192 event hrs'));
  assert.equal((html.match(/bd-fill-caught/g) ?? []).length, 2, 'temperature and rain; calm wind has no meter');
  assert.equal((html.match(/bd-fill-false-alarm/g) ?? []).length, 2);
  assert(!html.includes('width:91.6%'), 'SEDI must never be drawn as a percentage bar');

  const legacy = structuredClone(sampleRow);
  delete legacy.components.temperature.eventHits;
  delete legacy.components.temperature.falseAlarms;
  const legacyHtml = breakdownHtml(legacy);
  assert(legacyHtml.includes('bd-value">92</span>'), 'older payloads retain the index');
  assert.equal((legacyHtml.match(/bd-fill-caught/g) ?? []).length, 1, 'only rain has measured recall');
  assert(!legacyHtml.includes('NaN'));
});

ok('null draws no track, zero draws an empty one', () => {
  const zero = structuredClone(sampleRow);
  zero.components.temperature.accuracy = 0;
  assert(breakdownHtml(zero).includes('width:0%'));
  const nulled = structuredClone(sampleRow);
  nulled.components.temperature.accuracy = null;
  const html = breakdownHtml(nulled);
  assert(html.includes('<span class="num bd-value">—</span>'));
  assert(!html.includes('tone-bg-none'), 'an unmeasured component draws nothing');
});

ok('"never called one" is a state, and an unscored metric hides its split', () => {
  const quiet = structuredClone(sampleRow);
  quiet.components.temperature = {
    ...quiet.components.temperature, eventHits: 0, falseAlarms: 0, extremes: 50,
  };
  assert(breakdownHtml(quiet).includes('never called one'));
  const quietHtml = breakdownHtml(quiet);
  assert(quietHtml.includes('bd-value">caught 0%</span>'));
  assert.equal((quietHtml.match(/bd-fill-false-alarm/g) ?? []).length, 1, 'no false-alarm ratio without calls; rain still has one');

  const dry = structuredClone(sampleRow);
  dry.metricSkill.rain = null;
  assert(!breakdownHtml(dry).includes('observed wet hours'));
  assert(hasBreakdown(dry), 'the other metrics still have one');
  assert(!hasBreakdown({ metricSkill: {}, components: null }));
});

// ── Server payload: both score models, either one missing ───────────────────

const metrics = (t, r, w) => ({ temperature: t, rain: r, wind: w });
const serverRow = (modelId, v1, v2) => ({
  modelId,
  skill: v1,
  metricSkill: metrics(v1, v1 - 20, v1 - 5),
  rainRecord: { wins: 20, losses: 10 },
  movement: 1,
  formDots: ['hit', 'miss', 'na', 'hit', 'hit', 'hit', 'hit'],
  perLead: { 1: metrics(v1 + 5, v1 - 20, v1 - 5), 2: metrics(v1, v1 - 25, v1 - 8) },
  v2CoveredDays: v2 == null ? 3 : 9,
  ...(v2 == null ? {} : {
    skillV2: v2,
    metricSkillV2: metrics(v2, null, v2 - 3),
    perLeadV2: { 1: metrics(v2 + 4, null, v2 - 3), 2: metrics(v2, null, v2 - 6) },
    movementV2: -2,
    formDotsV2: ['miss', 'miss', 'na', 'hit', 'hit', 'hit', 'miss'],
    components: sampleRow.components,
  }),
});
const payload = (standings) => ({
  version: 1,
  city: { id: 'amsterdam', name: 'Amsterdam' },
  asOf: '2026-08-17',
  computedAt: '2026-08-17T04:00:00.000Z',
  timezone: 'Europe/Amsterdam',
  lookbackDays: 30,
  scoredDays: 30,
  dateRange: ['2026-07-19', '2026-08-17'],
  rainEligibility: { rainEventHours: 9, rainEventTotalMm: 12.2, rainScoreEligible: true },
  standings,
});

ok('a dual payload renders v2, re-ranks by it, and keeps v1 for the comparison', () => {
  const board = hydratePresetScoreboard(
    payload([serverRow('ecmwf_aifs025_single', 80, 60), serverRow('knmi_seamless', 70, 75)]),
    'amsterdam',
  );
  assert.deepEqual(board.rows.map((r) => r.model.id), ['knmi_seamless', 'ecmwf_aifs025_single']);
  assert.equal(board.rows[0].skill, 75);
  assert.equal(board.rows[0].errorSkill, 70);
  assert.deepEqual(board.rows.map((r) => r.errorRank), [2, 1]);
  assert.equal(board.rows[0].metricSkill.temperature, 75);
  assert.equal(board.rows[0].metricSkill.rain, 50, 'a null v2 metric falls back per field');
  assert.equal(board.rows[0].perLead[1].temperature.score, 79);
  assert.equal(board.rows[0].movement, -2);
  assert.equal(board.rows[0].formDots[0], 'miss');
  assert.equal(board.v2CoveredDays, 9);
});

ok('a v1-only payload still renders and claims no comparison', () => {
  const board = hydratePresetScoreboard(
    payload([serverRow('ecmwf_aifs025_single', 80, null), serverRow('knmi_seamless', 70, null)]),
    'amsterdam',
  );
  assert.deepEqual(board.rows.map((r) => r.model.id), ['ecmwf_aifs025_single', 'knmi_seamless']);
  assert.equal(board.rows[0].skill, 80);
  assert.equal(board.rows[0].errorSkill, null);
  assert.equal(board.rows[0].errorRank, null);
  assert.equal(board.rows[0].components, null);
  assert.equal(board.rows[0].movement, 1);
});

ok('a mixed payload sorts on the number each row actually shows', () => {
  const board = hydratePresetScoreboard(
    payload([serverRow('ecmwf_aifs025_single', 80, 60), serverRow('knmi_seamless', 70, null)]),
    'amsterdam',
  );
  assert.deepEqual(board.rows.map((r) => [r.model.id, r.skill]), [
    ['knmi_seamless', 70],
    ['ecmwf_aifs025_single', 60],
  ]);
});

ok('AccuWeather stays structurally absent whatever the payload says', () => {
  const board = hydratePresetScoreboard(
    payload([serverRow('accuweather', 99, 99), serverRow('knmi_seamless', 70, 75)]),
    'amsterdam',
  );
  assert.deepEqual(board.rows.map((r) => r.model.id), ['knmi_seamless']);
});

// ── Lead-time grid (the card's default view) ───────────────────────────────

const gridSeries = (spec) =>
  Object.entries(spec).map(([id, byDay]) => ({
    model: { id, label: id, color: '#fff' },
    points: Object.entries(byDay).map(([day, score]) => ({ day: Number(day), score })),
  }));

ok('the grid drops columns no model reaches and keeps rows aligned to them', () => {
  const grid = buildLeadTimeGrid(gridSeries({
    ifs: { 1: 80, 2: 70, 3: 60 },
    harm: { 1: 90, 2: 88 },
  }));
  assert.deepEqual(grid.columns, [1, 2, 3], 'days 4-7 are scored by nobody');
  assert.deepEqual(grid.rows[1].cells, [90, 88, null]);
  assert.equal(grid.rows[1].fullCoverage, false);
  assert.equal(grid.rows[0].fullCoverage, true);
  assert.equal(Math.round(grid.rows[1].average), 89);
});

ok('a short-horizon model cannot win the average, but can win a column', () => {
  const grid = buildLeadTimeGrid(gridSeries({
    ifs: { 1: 80, 2: 70, 3: 60 },
    harm: { 1: 90, 2: 88 },
  }));
  // HARM's 89 beats IFS's 70, but it is averaging only the easy near leads.
  assert.deepEqual(sortLeadTimeGrid(grid, 'average').map((r) => r.model.id), ['ifs', 'harm']);
  assert.deepEqual(sortLeadTimeGrid(grid, 0).map((r) => r.model.id), ['harm', 'ifs']);
  assert.deepEqual(sortLeadTimeGrid(grid, 2).map((r) => r.model.id), ['ifs', 'harm'], 'no score sorts last');
});

ok('an unscored model has no average and never leads the default order', () => {
  const grid = buildLeadTimeGrid(gridSeries({ dead: {}, ifs: { 1: 40 } }));
  assert.deepEqual(grid.columns, [1]);
  assert.equal(grid.rows[0].average, null);
  assert.deepEqual(sortLeadTimeGrid(grid, 'average').map((r) => r.model.id), ['ifs', 'dead']);
  assert.deepEqual(rankedModelIds(gridSeries({ dead: {}, ifs: { 1: 40 } })), ['ifs']);
});

ok('the ramp is absolute, bounded, and gives rain its own band', () => {
  for (const metric of ['all', 'temperature', 'wind', 'rain']) {
    assert.equal(rampStep(-5, metric), 0);
    assert.equal(rampStep(100, metric), RAMP_STEPS - 1);
  }
  // A rain F1 of 45 is a good rain forecast; the same number is a poor
  // temperature score. Sharing one band would flatten every rain grid.
  assert.equal(rampStep(45, 'rain'), 2);
  assert.equal(rampStep(45, 'temperature'), 0);
});

// ── Aggregation invariants that v2 must not have moved ─────────────────────

ok('the horizon factor and lead weighting are unchanged', () => {
  assert.equal(SCORE_CONFIG.eventWeight, 0.3);
  assert.equal(SCORE_CONFIG.minEventHours, 8);
  assert.deepEqual([...LEAD_DAYS], [1, 2, 3, 4, 5, 6, 7]);
});

// ── Historical Compare ─────────────────────────────────────────────────────

const compareFixture = () => {
  const dates = ['2026-10-01', '2026-10-03']; // navigation must allow gaps
  const model = { id: 'test', label: 'Test', color: '#123456' };
  const truthHours = dates.flatMap((dateKey, d) => Array.from({ length: 24 }, (_, h) => ({
    time: `${dateKey}T${String(h).padStart(2, '0')}:00`, dateKey,
    temperature: 10 + d + h / 2, wind: h, precipitation: h === 12 ? 1 : 0,
  })));
  const rows = (lead) => truthHours.map((truth) => ({ time: truth.time, dateKey: truth.dateKey, truth,
    pred: { temperature: truth.temperature + lead, wind: truth.wind + lead, precipitation: truth.precipitation } }));
  return { scoredDates: dates, roster: [model], truthHours, pairs: { test: { 1: rows(1), 3: rows(3) } } };
};

ok('Compare selects the requested historical day and forecast lead independently', () => {
  const a = compareFixture();
  const first = buildComparison(a, '2026-10-01', 3, ['test']);
  const last = buildComparison(a, '2026-10-03', 1, ['test']);
  assert.equal(first.observed.temperature, 21.5);
  assert.equal(first.models[0].temperature, 24.5);
  assert.equal(last.observed.temperature, 22.5);
  assert.equal(last.models[0].temperature, 23.5);
  assert.equal(buildComparison(a, '2026-10-02', 1, ['test']), null);
  assert.equal(buildComparison(a, '2026-10-01', 8, ['test']), null);
  assert.equal(buildComparison(a, '2026-10-01', 1, []).models.length, 0);
});

ok('Compare keeps gaps at the right hour and never counts missing rain as dry', () => {
  const a = compareFixture();
  a.pairs.test[1] = a.pairs.test[1].filter((r) => !r.time.endsWith('T06:00'));
  const view = buildComparison(a, '2026-10-01', 1, ['test']);
  assert.equal(view.hours.length, 24);
  assert.deepEqual(view.rain.obsSegments, [{ start: 12, end: 12 }]);
  assert.equal(view.rain.models.length, 0);
  const missingLead = buildComparison(a, '2026-10-01', 7, ['test']);
  assert.equal(missingLead.models[0].temperature, null);
  a.truthHours[12].precipitation = null;
  assert.equal(buildComparison(a, '2026-10-01', 1, ['test']).rain, null);
});

ok('Compare rejects thin daily highs and follows Verify rain timing tolerance', () => {
  const a = compareFixture();
  a.pairs.test[1] = a.pairs.test[1].slice(0, 19);
  assert.equal(buildComparison(a, '2026-10-01', 1, ['test']).models[0].temperature, null);
  assert.equal(rainTiming([], []), 1);
  assert.equal(rainTiming([13], [12]), 1);
  assert.equal(rainTiming([15], [12]), 0);
  assert.equal(rainTiming([], [12]), 0);
  assert.equal(rainTiming([12], []), 0);
  const strip = valueStrip([{ model: a.roster[0], value: 0 }], 0, { unit: '°C', minSpan: 6 });
  assert(strip.includes('Observed: 0 °C'));
  assert(!strip.includes('NaN'));
});

console.log(`\n${checks} checks passed`);
