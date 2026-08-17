/**
 * Grid model behind the "Skill by lead time" card — a port of the app's
 * `src/utils/scoreLeadTimeGrid.ts`, on this page's day-granular leads.
 *
 * The curve view plots one line per model. A preset board carries thirteen of
 * them (ten public models plus the commercial providers) and no palette rescues
 * that: a 13-hue categorical set cannot clear the perceptual separation floor,
 * so the lines are identifiable only where they happen not to overlap. The grid
 * re-encodes the same numbers as a models × lead-days matrix — position
 * identifies the model, brightness carries the score — and a fourteenth model
 * costs one more row instead of one more tangled line.
 *
 * Pure module: no DOM, no fetch. Column labels and cell colours are the
 * renderer's job, so this file can be exercised in Node by `scripts/check.mjs`.
 */

import { LEAD_DAYS } from './config.js';

/** Number of brightness steps in the cell ramp (see `--ramp-N` in style.css). */
export const RAMP_STEPS = 5;

/**
 * Score thresholds that split the ramp, per metric — absolute, not derived from
 * the data on screen, so a cell's brightness means the same thing on every board
 * and two cities can be compared by eye.
 *
 * Temperature and wind share the app's bands. Rain is an F1 score and genuinely
 * lives lower (its median across the preset boards is ~30 against ~67 for
 * temperature), so it gets its own; putting rain on the 50–80 scale would flatten
 * every rain grid into one dark step and hide exactly the differences the card
 * exists to show. `all` is the mean of the three, so it lands between them —
 * its band is the quartiles of the combined per-lead scores actually served
 * (p25 44, p50 53, p75 62, p90 70).
 */
export const RAMP_BREAKS = {
  all: [45, 55, 65, 75],
  temperature: [50, 60, 70, 80],
  wind: [50, 60, 70, 80],
  rain: [30, 40, 50, 60],
};

/** Ramp step 0 (weakest) to `RAMP_STEPS - 1` (strongest) for a score. */
export function rampStep(score, metric) {
  const breaks = RAMP_BREAKS[metric] ?? RAMP_BREAKS.all;
  let step = 0;
  for (const threshold of breaks) {
    if (score >= threshold) step += 1;
  }
  return step;
}

/** The score at `day`, or null when the model doesn't reach that lead. */
function scoreAtLead(points, day) {
  const point = points.find((p) => p.day === day);
  return point && Number.isFinite(point.score) ? point.score : null;
}

/**
 * Build the grid from the same series the curve view draws.
 *
 * Columns no model scored are dropped, so a board whose models all stop at day 5
 * shows five columns rather than two empty stripes. Rows come back in input
 * order; call `sortLeadTimeGrid` to rank them.
 *
 * @param {Array<{model:Object, points:Array<{day:number, score:number}>}>} series
 * @returns {{columns:number[], rows:Array<{model:Object, cells:(number|null)[], average:number|null, fullCoverage:boolean}>}}
 */
export function buildLeadTimeGrid(series) {
  const columns = LEAD_DAYS.filter((day) =>
    series.some((entry) => scoreAtLead(entry.points, day) != null),
  );

  const rows = series.map((entry) => {
    const cells = columns.map((day) => scoreAtLead(entry.points, day));
    const scored = cells.filter((cell) => cell != null);
    return {
      model: entry.model,
      cells,
      average: scored.length > 0 ? scored.reduce((sum, v) => sum + v, 0) / scored.length : null,
      fullCoverage: scored.length === columns.length && columns.length > 0,
    };
  });

  return { columns, rows };
}

/**
 * Rank the rows, best first. `sort` is `'average'` or a column index.
 *
 * Sorting by average puts models that scored every column above ones that stop
 * early: a short-horizon model only ever scores the near leads, where every model
 * does well, so its mean is not comparable with a model carrying the full week.
 * Within a single lead-day column that caveat disappears and the comparison is
 * straight — which is why the column headers are the sort control. Rows without
 * a score sort last either way.
 */
export function sortLeadTimeGrid(grid, sort) {
  const rows = [...grid.rows];
  if (sort === 'average') {
    return rows.sort((a, b) => {
      if (a.fullCoverage !== b.fullCoverage) return a.fullCoverage ? -1 : 1;
      return (b.average ?? -1) - (a.average ?? -1);
    });
  }
  return rows.sort((a, b) => (b.cells[sort] ?? -1) - (a.cells[sort] ?? -1));
}

/** Formats a lead day for a column header. */
export function formatLeadLabel(day) {
  return `${day}d`;
}

/**
 * Model ids best-first by the same average the grid ranks on, so the curve
 * view's default colouring and the grid's default order never disagree about
 * who is leading.
 */
export function rankedModelIds(series) {
  return sortLeadTimeGrid(buildLeadTimeGrid(series), 'average')
    .filter((row) => row.average != null)
    .map((row) => row.model.id);
}
