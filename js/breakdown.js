/**
 * Score breakdown — the v2 components behind one standings row's headline.
 *
 * Pure string builders (no DOM), so the expanded row, the commercial-model row
 * that has no in-browser data, and any future surface all render the same
 * block, and so this file can be exercised in Node.
 *
 * Two rules from the app's version of this panel are load-bearing here:
 *
 *  1. **Null draws nothing, zero draws an empty track.** No minimum bar width:
 *     a sliver under "caught 0%" would be a measurement claim, and a track
 *     under a cell that prints an em dash would read as a measured zero the
 *     scorer actually refused to reach.
 *  2. **State the event table, demote the index.** SEDI's zero point is 50, so
 *     "75" beside an accuracy of "92%" reads as the worse number unless the
 *     table is spelled out. The false-alarm figure is the *ratio*
 *     `falseAlarms / (calls the model made)`, never SEDI's false-alarm rate,
 *     which divides by every quiet hour and reads ~2% for everyone everywhere.
 *     Neither percentage rederives the index, and none of them rederive the
 *     headline: these pool every lead into one table, while the score is a
 *     lead-weighted mean of per-lead scores.
 */

import { scoreTone } from './derive.js';
import { SCORE_CONFIG } from './score.js';
import { asTempDelta, asWind, tempUnit, windUnit } from './units.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);

const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : null);

/** Sharpness reads as "moves like the weather" inside this band. */
const SHARPNESS_ZONE = [0.8, 1.15];

/**
 * A metric's split is shown only where the metric itself scored. That guard is
 * doing real work on rain: a window the eligibility gate rejected still has a
 * table, and publishing "94% false alarms" off a sample already judged too thin
 * would state as a finding exactly what the gate exists to suppress.
 */
export function hasBreakdown(row) {
  const c = row.components;
  if (!c) return false;
  return Boolean(
    (c.temperature && row.metricSkill.temperature != null)
    || (c.wind && row.metricSkill.wind != null)
    || (c.rain && row.metricSkill.rain != null),
  );
}

/** A 0–100 component as a track. Absent for null; empty for a measured zero. */
function bar(value) {
  if (value == null) return '';
  return `<span class="bd-track"><span class="bd-track-fill tone-bg-${scoreTone(value)}"
    style="width:${Math.max(0, Math.min(100, value))}%"></span></span>`;
}

function cell(label, value, track, sub) {
  return `<div class="bd-cell">
      <span class="bd-label">${esc(label)}</span>
      <span class="num bd-value">${value}</span>
      ${track}
      <span class="bd-sub">${sub}</span>
    </div>`;
}

/** Accuracy · Extremes · Sharpness · typical error, for temperature or wind. */
function metricBlock(name, comp, score, { unit, conv, tolerance, relative }) {
  if (!comp || score == null) return '';

  const called = comp.eventHits == null || comp.falseAlarms == null
    ? null
    : comp.eventHits + comp.falseAlarms;
  const extremesSub = comp.extremes == null
    ? `too few extreme hours to judge (${comp.eventHours} in the window)`
    : `caught ${pct(comp.eventHits, comp.eventHours) ?? '—'} · ${
      called === 0 ? 'never called one' : `${pct(comp.falseAlarms, called) ?? '—'} false alarms`
    } · ${comp.eventHours} event hrs`;

  const sharp = comp.sharpness;
  const sharpSub = sharp == null
    ? 'not measured at this cell'
    : sharp < SHARPNESS_ZONE[0] ? 'smoother than the weather'
      : sharp > SHARPNESS_ZONE[1] ? 'livelier than the weather'
        : 'moves like the weather';
  const sharpTone = sharp == null || (sharp >= SHARPNESS_ZONE[0] && sharp <= SHARPNESS_ZONE[1])
    ? 'good'
    : 'ok';

  return `<div class="bd-metric">
    <div class="bd-metric-head">
      <span class="bd-metric-name">${esc(name)}</span>
      <span class="num bd-metric-score tone-${scoreTone(score)}">${fmt(score)}</span>
    </div>
    ${cell(
    'Accuracy',
    comp.accuracy == null ? '—' : `${fmt(comp.accuracy)}%`,
    bar(comp.accuracy),
    `within ${fmt(conv(tolerance), 1)}&nbsp;${esc(unit)}${relative ? ' or 20%' : ''} · ${
      comp.count.toLocaleString('en')} hours`,
  )}
    ${cell('Extremes', comp.extremes == null ? '—' : fmt(comp.extremes), bar(comp.extremes), extremesSub)}
    ${cell(
    'Sharpness',
    `<span class="tone-${sharpTone}">${sharp == null ? '—' : `${sharp.toFixed(2)}×`}</span>`,
    '',
    `${sharpSub}${comp.typicalError == null
      ? ''
      : ` · typical error ±${fmt(conv(comp.typicalError), 1)}&nbsp;${esc(unit)}`}`,
  )}
  </div>`;
}

/** Rain was already an event score, so its breakdown is that table itself. */
function rainBlock(comp, score) {
  if (!comp || score == null) return '';
  const called = comp.calledHits + comp.falseAlarms;
  return `<div class="bd-metric">
    <div class="bd-metric-head">
      <span class="bd-metric-name">Rain</span>
      <span class="num bd-metric-score tone-${scoreTone(score)}">${fmt(score)}</span>
    </div>
    ${cell(
    'Wet hours',
    pct(comp.eventHits, comp.eventHours) ?? '—',
    bar(comp.eventHours > 0 ? (comp.eventHits / comp.eventHours) * 100 : null),
    `caught ${comp.eventHits} of ${comp.eventHours} observed wet hours · ${
      called === 0 ? 'never called rain' : `${pct(comp.falseAlarms, called)} of its rain calls stayed dry`}`,
  )}
  </div>`;
}

/**
 * The whole block for one standings row, or '' when the row carries nothing
 * worth showing.
 *
 * @param {{components:Object, metricSkill:Object, rank:number, errorRank:number|null}} row
 */
export function breakdownHtml(row) {
  if (!hasBreakdown(row)) return '';
  const c = row.components;
  const was = row.errorRank == null
    ? null
    : row.errorRank === row.rank
      ? `also #${row.errorRank} under the old error score`
      : `was #${row.errorRank} under the old error score`;

  return `<div class="breakdown">
    <div class="bd-head">Score breakdown
      <span class="bd-head-sub">0.7 · Accuracy + 0.3 · Extremes, pooled over every lead day</span>
    </div>
    <div class="bd-grid">
      ${metricBlock('Temperature', c.temperature, row.metricSkill.temperature, {
    unit: tempUnit(),
    conv: asTempDelta,
    tolerance: SCORE_CONFIG.tempHitToleranceC,
    relative: false,
  })}
      ${metricBlock('Wind', c.wind, row.metricSkill.wind, {
    unit: windUnit(),
    conv: asWind,
    tolerance: SCORE_CONFIG.windHitToleranceKmh,
    relative: true,
  })}
      ${rainBlock(c.rain, row.metricSkill.rain)}
    </div>
    ${was ? `<p class="bd-note">${esc(was)}</p>` : ''}
  </div>`;
}
